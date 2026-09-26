/**
 * Escalonador de lançamentos de agente (dor verificada #1).
 *
 * ## O problema
 *
 * O limite que mais dói em quem roda várias sessões do Claude Code lado a lado
 * não é o de USO (5 h / semana, que escala com o plano): é o do SERVIDOR —
 * "Server is temporarily limiting requests (not your usage limit)", ou um 529
 * `overloaded_error`. Ele não escala com plano nenhum, e a forma mais rápida
 * de provocá-lo é subir quatro, cinco, seis agentes no mesmo segundo — que é
 * exatamente o que a restauração do Bridge fazia ao reabrir um workspace com
 * vários painéis.
 *
 * ## O que este módulo faz
 *
 * Três coisas, todas sobre o RITMO dos lançamentos — nenhuma sobre a conta:
 *
 * 1. **teto de concorrência** (`maxConcurrentAgents`, padrão 4): pedido além
 *    dele entra na fila em vez de subir. É o único item que segura por tempo
 *    indeterminado, e é por isso que existe o "Lançar agora";
 * 2. **jitter de 300–900 ms** entre lançamentos pedidos em rajada: quatro
 *    `POST /api/sessions` no mesmo milissegundo viram quatro handshakes no
 *    mesmo milissegundo. O sorteio é por lançamento, não fixo, pra não criar
 *    um trem de pedidos igualmente espaçados;
 * 3. **backoff exponencial de 5 s a 60 s** enquanto ALGUMA sessão estiver
 *    `server-limited`: se o servidor já está estrangulando, subir mais um
 *    agente na mesma cadência é jogar lenha.
 *
 * ## O que ele NÃO faz
 *
 * Não mata, não pausa e não fila sessão que já existe: uma vez de pé, o agente
 * é do usuário. Não gateia `POST /api/panes/:id/resume` nem o agente que nasce
 * junto com uma tarefa (`POST /api/tasks`) — os dois são um clique deliberado
 * numa sessão só, e transformá-los em 202 tiraria da pessoa a resposta que ela
 * está esperando na tela. E some do caminho inteiro com
 * `sessions.scheduleLaunches: false`.
 */
import type { I18nMessage, Translatable } from './errors.js';
import { ptBRMessage } from './errors.js';
import { newId } from './ids.js';
import type { AgentId, LaunchHold, LauncherStatus, PendingLaunch } from './model.js';

/** Padrão de `sessions.maxConcurrentAgents` — ver `DEFAULT_STORED_CONFIG`. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

/** Faixa do jitter entre dois lançamentos de uma rajada. */
export const JITTER_MIN_MS = 300;
export const JITTER_MAX_MS = 900;

/** Primeiro e último degrau do backoff enquanto há sessão estrangulada. */
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

/** Teto da fila. Passou disso, o pedido é recusado em vez de acumular (BU). */
export const PENDING_MAX = 64;

/**
 * O que a fila guarda de um lançamento: a identidade (o que a UI mostra) mais
 * o pedido CRU que ela vai repetir quando chegar a vez. O pedido é opaco pro
 * escalonador (`I`) de propósito — ele agenda ritmo, não sabe o que é uma
 * sessão.
 */
export interface LaunchTicket<I> {
  id: string;
  paneId: string;
  workspaceId: string;
  agent: AgentId;
  requestedAt: number;
  input: I;
}

export interface LauncherOptions<I, R = unknown> {
  /** `sessions.maxConcurrentAgents` em vigor (lido a cada decisão). */
  maxConcurrent: () => number;
  /** `sessions.scheduleLaunches` em vigor. */
  enabled: () => boolean;
  /** Sessões de agente vivas agora (o core conta em `Sessions`). */
  activeAgents: () => number;
  /** Sessões `server-limited` agora. */
  serverLimited: () => number;
  /** Sobe o agente de fato. Rejeita = o lançamento falhou (vira `lastError`). */
  launch: (ticket: LaunchTicket<I>) => Promise<R>;
  /** Emite `launcher.changed` com o status novo. */
  onChanged: (status: LauncherStatus) => void;
  /** Injetáveis pro teste: relógio, sorteio e agendamento. */
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

export class Launcher<I = unknown, R = unknown> {
  private queue: LaunchTicket<I>[] = [];
  /**
   * Painéis com um lançamento DESPACHADO e ainda não concluído — a reserva de
   * slot (fix round 1, crítico).
   *
   * Sem ela o teto não segurava rajada nenhuma: `activeAgents()` conta sessão
   * VIVA, e entre o despacho e a sessão existir corre o `adapter.available()`
   * (`claude --version`, segundos). Oito pedidos com teto 4 passavam todos
   * pelo `hold()` antes de o primeiro virar sessão, e o Bridge subia oito
   * agentes de uma vez — exatamente a rajada que este módulo existe pra
   * desmanchar.
   *
   * É um `Set` de `paneId`, e não um contador, porque ele responde às DUAS
   * perguntas: "quantos slots estão reservados?" e "este painel já tem
   * lançamento em voo?" (a deduplicação do `request`).
   */
  private inFlight = new Set<string>();
  /** Quando o último lançamento SAIU (0 = nenhum nesta subida). */
  private lastLaunchAt = 0;
  /** Jitter sorteado pro PRÓXIMO lançamento — sorteado de novo a cada saída. */
  private jitterMs: number;
  /** Degrau atual do backoff. Só vale enquanto há sessão estrangulada. */
  private backoffMs = BACKOFF_MIN_MS;
  private timer: { cancel: () => void } | undefined;
  private lastError: LauncherStatus['lastError'];
  private stopped = false;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel: () => void };

  constructor(private readonly opts: LauncherOptions<I, R>) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.jitterMs = this.drawJitter();
  }

  private drawJitter(): number {
    return Math.round(JITTER_MIN_MS + this.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
  }

  /** O espaçamento em vigor: backoff quando há sessão estrangulada, jitter fora disso. */
  spacingMs(): number {
    return this.opts.serverLimited() > 0 ? this.backoffMs : this.jitterMs;
  }

  /**
   * Por que um lançamento não pode sair AGORA? `undefined` = pode.
   *
   * A ordem importa: `slots` vem primeiro porque é o único motivo que não
   * passa sozinho com o tempo — com o teto estourado, esperar o jitter não
   * adianta, e é ele que a fila anuncia na sidebar.
   */
  hold(): LaunchHold | undefined {
    if (!this.opts.enabled()) return undefined;
    // Vivas MAIS despachadas: a reserva é o que impede a rajada de furar o
    // teto na janela entre o despacho e a sessão existir (ver `inFlight`).
    if (this.opts.activeAgents() + this.inFlight.size >= this.opts.maxConcurrent()) return 'slots';
    const spacing = this.spacingMs();
    if (this.lastLaunchAt > 0 && this.now() < this.lastLaunchAt + spacing) {
      return this.opts.serverLimited() > 0 ? 'backoff' : 'jitter';
    }
    return undefined;
  }

  /**
   * Um `POST /api/sessions { kind: 'agent' }` chegou.
   *
   * `{ queued: false }` = quem chamou sobe a sessão AGORA e responde 201.
   * `{ queued: true }` = o pedido entrou na fila; o 202 leva a posição, e o
   * lançamento sai depois, sozinho.
   *
   * A fila também é o que ordena a rajada: com alguém esperando, o pedido novo
   * vai pro fim mesmo que um slot esteja livre — senão o último a chegar
   * passaria na frente de quem já estava na fila.
   */
  request(input: { paneId: string; workspaceId: string; agent: AgentId; input: I }):
    | { queued: false; launched: Promise<R> }
    | { queued: true; ticket: PendingLaunch; reason: LaunchHold } {
    // Fix round 1 — um painel de cada vez. Sem isto, dois pedidos no mesmo
    // painel vazio (dois cliques, duas janelas do Bridge) viravam DOIS 202: o
    // primeiro subia o agente e o segundo morria de `pane-busy` lá na frente,
    // dentro do `lastError`, minutos depois. O 409 tem que sair agora, que é
    // o que a UI já sabe tratar.
    if (this.holdsPane(input.paneId)) throw new LauncherPaneQueuedError(input.paneId);

    const hold = this.queue.length > 0 ? (this.hold() ?? 'slots') : this.hold();
    const ticket: LaunchTicket<I> = {
      id: newId('lnch'),
      paneId: input.paneId,
      workspaceId: input.workspaceId,
      agent: input.agent,
      requestedAt: this.now(),
      input: input.input,
    };

    if (hold === undefined) {
      // O lançamento sai POR AQUI, e não pelo chamador, pra que a reserva de
      // slot e o relógio do espaçamento valham também no caminho imediato.
      // Quem chamou recebe a mesma promessa e responde 201 com a sessão (ou o
      // erro, que continua sendo dele).
      return { queued: false, launched: this.dispatch(ticket) };
    }
    if (this.queue.length >= PENDING_MAX) throw new LauncherQueueFullError();

    this.queue.push(ticket);
    this.arm();
    this.emit();
    return { queued: true, ticket: this.pendingOf(ticket, this.queue.length), reason: hold };
  }

  /** Este painel já tem lançamento na fila ou em voo? */
  holdsPane(paneId: string): boolean {
    return this.inFlight.has(paneId) || this.queue.some((t) => t.paneId === paneId);
  }

  /**
   * Um agente SUBIU (por esta fila ou por fora dela: `POST /api/tasks`,
   * `bridge resume`, a restauração). Marca o instante e sorteia o jitter do
   * próximo — é o que faz o espaçamento valer pra rajada inteira, e não só pro
   * que passou por `request`.
   *
   * Com sessão estrangulada em cena, o degrau do backoff DOBRA a cada
   * lançamento: 5, 10, 20, 40, 60 s. Ele só volta pro piso quando ninguém mais
   * está estrangulado (`noteServerLimitCleared`).
   */
  noteLaunched(): void {
    this.markDispatch();
    this.arm();
    this.emit();
  }

  /** O relógio do espaçamento — ver `noteLaunched` e `request`. */
  private markDispatch(): void {
    this.lastLaunchAt = this.now();
    this.jitterMs = this.drawJitter();
    if (this.opts.serverLimited() > 0) {
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    }
  }

  /** Nenhuma sessão estrangulada sobrou: o backoff volta ao primeiro degrau. */
  noteServerLimitCleared(): void {
    this.backoffMs = BACKOFF_MIN_MS;
    this.pump();
  }

  /**
   * Alguma coisa que o `hold()` lê mudou (sessão morreu e liberou slot, a
   * configuração mexeu no teto, uma sessão entrou em `server-limited`).
   */
  poke(): void {
    this.pump();
  }

  /**
   * "Lançar agora" — sai da fila e sobe IGNORANDO o escalonador uma vez.
   *
   * Sem `id`, o primeiro da fila. É a válvula de escape do teto: quem tem
   * quatro agentes de pé e quer o quinto agora não deveria precisar mexer na
   * configuração pra isso.
   */
  launchNow(id?: string): PendingLaunch | undefined {
    const index = id === undefined ? 0 : this.queue.findIndex((t) => t.id === id);
    if (index < 0 || index >= this.queue.length) return undefined;
    const ticket = this.queue[index]!;
    const pending = this.pendingOf(ticket, index + 1);
    this.queue.splice(index, 1);
    this.run(ticket);
    this.emit();
    return pending;
  }

  /** Tira um pedido da fila sem lançar (painel fechado antes da vez dele). */
  cancel(id: string): boolean {
    const index = this.queue.findIndex((t) => t.id === id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.emit();
    return true;
  }

  /** Tudo que está esperando, na ordem da fila. */
  pending(): PendingLaunch[] {
    return this.queue.map((ticket, index) => this.pendingOf(ticket, index + 1));
  }

  status(): LauncherStatus {
    const spacing = this.spacingMs();
    const nextAt = this.queue.length > 0 && this.lastLaunchAt > 0 ? this.lastLaunchAt + spacing : undefined;
    return {
      enabled: this.opts.enabled(),
      maxConcurrent: this.opts.maxConcurrent(),
      // Vivas + reservadas: é o número que o teto compara, então é o número
      // que a sidebar mostra — senão "4 de 4" apareceria com três sessões na
      // tela e a fila parada, sem explicação.
      active: this.opts.activeAgents() + this.inFlight.size,
      serverLimited: this.opts.serverLimited(),
      spacingMs: spacing,
      // `nextAt` só quando dá pra prever: com o teto estourado a fila espera um
      // slot vagar, e inventar um horário aí seria uma promessa sem lastro.
      ...(nextAt !== undefined && this.hold() !== 'slots' ? { nextAt } : {}),
      pending: this.pending(),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    };
  }

  /** Cancela o timer pendente. A fila em si morre com o processo. */
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.inFlight.clear();
  }

  // ------------------------------------------------------------ internos

  private pendingOf(ticket: LaunchTicket<I>, position: number): PendingLaunch {
    return {
      id: ticket.id,
      paneId: ticket.paneId,
      workspaceId: ticket.workspaceId,
      agent: ticket.agent,
      requestedAt: ticket.requestedAt,
      position,
    };
  }

  /**
   * Solta da fila tudo que já pode sair, um por vez.
   *
   * Um por chamada de propósito: quem sai marca o relógio, e o `arm` logo
   * abaixo reagenda o próximo com o espaçamento novo. Sem fila, não faz nada
   * além de anunciar o status.
   */
  private pump(): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = undefined;
    if (this.queue.length === 0) {
      this.emit();
      return;
    }
    const hold = this.hold();
    if (hold === undefined) {
      const ticket = this.queue.shift()!;
      this.run(ticket);
      // Rearma pro PRÓXIMO da fila com o espaçamento novo (o `run` acabou de
      // marcar o relógio). Sem isto, a fila andava um passo e parava até o
      // próximo evento de sessão — que numa rajada de restauração não vem.
      this.arm();
      this.emit();
      return;
    }
    this.arm();
    this.emit();
  }

  /**
   * Agenda a próxima tentativa quando o motivo da espera passa com o TEMPO
   * (jitter, backoff). Pra `slots` não há timer: quem acorda a fila é o evento
   * de sessão encerrada (`poke`), ou o "Lançar agora".
   */
  private arm(): void {
    if (this.stopped || this.queue.length === 0) return;
    this.timer?.cancel();
    this.timer = undefined;
    const hold = this.hold();
    if (hold === undefined) {
      this.timer = this.schedule(() => this.pump(), 0);
      return;
    }
    if (hold === 'slots') return;
    const wait = Math.max(0, this.lastLaunchAt + this.spacingMs() - this.now());
    this.timer = this.schedule(() => this.pump(), wait);
  }

  private run(ticket: LaunchTicket<I>): void {
    void this.dispatch(ticket).catch((err: unknown) => {
      this.lastError = {
        at: this.now(),
        paneId: ticket.paneId,
        message: err instanceof Error ? err.message : String(err),
      };
      // O lançamento que falhou não pode travar a fila: sem este `arm`, um
      // painel que sumiu antes da vez dele deixava todo mundo atrás dele
      // esperando um evento que não vinha mais.
      this.arm();
      this.emit();
    });
  }

  /**
   * Reserva o slot, marca o relógio e sobe. A reserva é solta quando o
   * lançamento TERMINA — dando certo ou não —, e não quando ele começa: é
   * justamente a espera do `available()` que o teto precisa cobrir.
   *
   * A promessa devolvida é a do `launch`, sem `catch`: o erro continua sendo
   * de quem chamou (o 422 do `POST /api/sessions`, ou o `lastError` da fila).
   */
  private dispatch(ticket: LaunchTicket<I>): Promise<R> {
    this.markDispatch();
    this.inFlight.add(ticket.paneId);
    const launched = this.opts.launch(ticket);
    const release = (): void => {
      this.inFlight.delete(ticket.paneId);
      // Slot liberado: a fila pode andar, e o status mudou.
      this.arm();
      this.emit();
    };
    launched.then(release, release);
    return launched;
  }

  private emit(): void {
    if (this.stopped) return;
    this.opts.onChanged(this.status());
  }
}

/**
 * O painel já tem um lançamento na fila ou em voo (fix round 1). Vira 409
 * `pane-busy` na rota — o mesmo código que a UI já trata quando alguém chega
 * primeiro num painel.
 */
export class LauncherPaneQueuedError extends Error implements Translatable {
  readonly code = 'pane-busy';
  readonly i18n: I18nMessage;
  constructor(paneId: string) {
    const i18n: I18nMessage = { key: 'core.erro.painelJaNaFila', params: { paneId } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'LauncherPaneQueuedError';
  }
}

/** A fila encheu (`PENDING_MAX`) — o pedido é recusado, não empilhado. */
const QUEUE_FULL: I18nMessage = { key: 'core.erro.filaCheia', params: { max: PENDING_MAX } };

export class LauncherQueueFullError extends Error implements Translatable {
  readonly code = 'queue-full';
  readonly i18n = QUEUE_FULL;
  constructor() {
    super(ptBRMessage(QUEUE_FULL));
    this.name = 'LauncherQueueFullError';
  }
}
