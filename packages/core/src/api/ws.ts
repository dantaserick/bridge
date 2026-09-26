import { t } from '@bridge/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { Core } from '../core.js';
import type { BridgeEvent } from '../events.js';
import { PTY_DIM_MAX } from './schemas.js';
import { snapshotState } from './state.js';

/**
 * O JSON cru que chega do socket, antes de virar `ClientMessage` (o tipo do
 * `@bridge/shared`): tudo `unknown` porque o cliente pode mandar qualquer
 * coisa — os `typeof` no handler é que fazem o estreitamento.
 */
interface RawClientMessage {
  type?: unknown;
  sessionId?: unknown;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/** Máximo de conexões simultâneas no `/ws` (BR-11): a UI usa 1, o main do Electron 1. */
export const WS_MAX_CLIENTS = 32;

/** Dimensão de PTY aceitável vinda do socket — a mesma faixa do `resizeSchema` (BR-15). */
function isPtyDim(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PTY_DIM_MAX;
}

/** Acima disso no `bufferedAmount` do socket, `pty.data` para de sair e fica em fila. */
export const WS_COALESCE_BYTES = 1024 * 1024;

/** Teto por sessão na fila: o que passar disso é descartado (o mais antigo primeiro) e contado. */
export const WS_DROP_BYTES = 8 * 1024 * 1024;

/** R2: no máximo um aviso por sessão por minuto (não por chunk). */
export const WS_WARN_EVERY_MS = 60_000;

/** Enquanto o socket estiver entupido, reavalia a fila nesse intervalo. */
export const WS_RETRY_MS = 50;

export interface PendingChunk {
  sessionId: string;
  data: string;
}

export interface SessionCoalesce {
  sessionId: string;
  /** Os chunks sobreviventes da sessão, já fundidos num só. */
  data: string;
  /** Quantos chunks foram fundidos entre os SOBREVIVENTES (descartado não conta). */
  coalesced: number;
  droppedChunks: number;
  droppedBytes: number;
}

export interface CoalesceResult {
  sessions: SessionCoalesce[];
  coalesced: number;
  droppedBytes: number;
}

/**
 * Agrupa os `pty.data` pendentes num chunk por sessão, preservando a ordem em
 * que cada sessão apareceu na fila e a ordem interna dos chunks dela. Se uma
 * sessão passa de `dropBytes`, os chunks MAIS ANTIGOS dela são descartados até
 * caber — o último chunk nunca é descartado (senão a sessão sumiria da tela).
 *
 * O teto é por sessão e o resultado volta já fundido, então dá pra realimentar
 * a saída daqui como a nova fila: segurar a fila por vários ticks não faz ela
 * crescer sem limite.
 *
 * Pura de propósito: dá pra testar backpressure sem simular socket lento.
 */
export function coalescePending(pending: PendingChunk[], dropBytes: number): CoalesceResult {
  const order: string[] = [];
  const bySession = new Map<string, string[]>();

  for (const chunk of pending) {
    let chunks = bySession.get(chunk.sessionId);
    if (!chunks) {
      chunks = [];
      bySession.set(chunk.sessionId, chunks);
      order.push(chunk.sessionId);
    }
    chunks.push(chunk.data);
  }

  const sessions: SessionCoalesce[] = [];
  let totalCoalesced = 0;
  let totalDropped = 0;

  for (const sessionId of order) {
    const chunks = bySession.get(sessionId)!;
    let bytes = chunks.reduce((sum, c) => sum + Buffer.byteLength(c, 'utf8'), 0);
    let droppedChunks = 0;
    let droppedBytes = 0;
    while (bytes > dropBytes && chunks.length > 1) {
      const removed = chunks.shift()!;
      const removedBytes = Buffer.byteLength(removed, 'utf8');
      bytes -= removedBytes;
      droppedBytes += removedBytes;
      droppedChunks += 1;
    }
    // Fusão conta só o que sobreviveu: chunk descartado não foi "agrupado".
    const coalesced = chunks.length - 1;
    sessions.push({ sessionId, data: chunks.join(''), coalesced, droppedChunks, droppedBytes });
    totalCoalesced += coalesced;
    totalDropped += droppedBytes;
  }

  return { sessions, coalesced: totalCoalesced, droppedBytes: totalDropped };
}

/**
 * Rate limit do aviso: devolve `true` (e anota o instante) só quando a última
 * reclamação daquela sessão foi há mais de `everyMs`.
 */
export function shouldWarn(last: Map<string, number>, sessionId: string, now: number, everyMs: number): boolean {
  const previous = last.get(sessionId);
  if (previous !== undefined && now - previous < everyMs) return false;
  last.set(sessionId, now);
  return true;
}

export interface PumpDeps {
  /** O socket vivo — só o `bufferedAmount` é lido, sempre no momento do flush. */
  socket: { readonly bufferedAmount: number };
  send: (chunk: PendingChunk) => void;
  /** `delayMs === 0` → próximo tick; senão, timer. Injetável pra teste dirigir a mão. */
  schedule: (fn: () => void, delayMs: number) => void;
  warn?: (message: string) => void;
  now?: () => number;
}

/**
 * Fila de `pty.data` de UM socket (spec §10, backpressure).
 *
 * Regra: enquanto `bufferedAmount` estiver acima de `WS_COALESCE_BYTES`, nada
 * de `pty.data` sai — os chunks se acumulam, são fundidos por sessão a cada
 * tentativa e a fila é reavaliada em `WS_RETRY_MS`. Como o resultado da fusão
 * vira a nova fila e o teto de `WS_DROP_BYTES` é aplicado a cada passada, um
 * cliente travado não faz a memória crescer sem limite: o pior caso é 8 MB por
 * sessão. Só quando o socket desafoga é que a saída sai, um chunk por sessão,
 * na ordem em que as sessões entraram na fila.
 */
export class PtyDataPump {
  private pending: PendingChunk[] = [];
  private armed = false;
  private lastWarnAt = new Map<string, number>();

  constructor(private deps: PumpDeps) {}

  /** Só pra teste/inspeção: quantos chunks estão represados. */
  get queued(): number {
    return this.pending.length;
  }

  push(sessionId: string, data: string): void {
    // Uma vez com fila, TODO `pty.data` passa por ela até esvaziar — mandar
    // direto no meio bagunçaria a ordem da saída do terminal.
    if (this.pending.length === 0 && this.deps.socket.bufferedAmount <= WS_COALESCE_BYTES) {
      this.deps.send({ sessionId, data });
      return;
    }
    this.pending.push({ sessionId, data });
    this.arm(0);
  }

  flush(): void {
    this.armed = false;
    if (this.pending.length === 0) return;

    const result = coalescePending(this.pending, WS_DROP_BYTES);
    const now = this.deps.now?.() ?? Date.now();
    for (const session of result.sessions) {
      if (session.coalesced === 0 && session.droppedBytes === 0) continue;
      if (!shouldWarn(this.lastWarnAt, session.sessionId, now, WS_WARN_EVERY_MS)) continue;
      this.warn(
        // i18n-ignore: linha de log (spec §13 — `core.log` fica em pt-BR).
        `[ws] socket lento na sessão ${session.sessionId}: ${session.coalesced} chunks agrupados, ` + // i18n-ignore
          `${session.droppedChunks} chunks (${session.droppedBytes} bytes) descartados`,
      );
    }

    if (this.deps.socket.bufferedAmount > WS_COALESCE_BYTES) {
      // Continua entupido: segura a fila já fundida e capada, e tenta de novo.
      this.pending = result.sessions.map((s) => ({ sessionId: s.sessionId, data: s.data }));
      this.arm(WS_RETRY_MS);
      return;
    }

    this.pending = [];
    for (const session of result.sessions) {
      this.deps.send({ sessionId: session.sessionId, data: session.data });
    }
  }

  clear(): void {
    this.pending = [];
  }

  private arm(delayMs: number): void {
    if (this.armed) return;
    this.armed = true;
    this.deps.schedule(() => this.flush(), delayMs);
  }

  private warn(message: string): void {
    this.deps.warn?.(message);
  }
}

/**
 * R7 — `GET /ws?events=notification,session,layout`: lista de PREFIXOS de
 * `type` que aquele cliente quer receber. Sem o parâmetro (ou com ele vazio)
 * devolve `undefined`, que significa "tudo", o comportamento histórico.
 *
 * Existe porque nem todo cliente do `/ws` é um terminal: o processo main do
 * Electron abre a própria conexão só pra decidir toast e badge, e sem isto
 * recebia cada `pty.data` de cada sessão — trabalho por chunk de PTY num
 * processo que nem desenha terminal.
 */
export function parseEventFilter(rawUrl: string): string[] | undefined {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return undefined;
  const raw = new URLSearchParams(rawUrl.slice(qIndex + 1)).get('events');
  if (raw === null) return undefined;
  const prefixes = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return prefixes.length > 0 ? prefixes : undefined;
}

/** `type` do evento contra os prefixos de `parseEventFilter`; sem filtro, tudo passa. */
export function eventAllowed(type: string, filter: string[] | undefined): boolean {
  if (filter === undefined) return true;
  return filter.some((prefix) => type === prefix || type.startsWith(`${prefix}.`));
}

/**
 * `/ws`: ao conectar manda o estado inteiro (`hello`), depois repassa cada
 * `BridgeEvent` do bus como JSON. Aceita de volta `input` (teclado) e
 * `resize`, os dois atalhos que evitam round-trip HTTP por tecla.
 *
 * Só `pty.data` passa pela fila de backpressure (`PtyDataPump`) — é o único
 * evento com volume. `session.state`, `pty.exit` e companhia saem na hora,
 * porque são pequenos e atrasá-los deixaria a sidebar mentindo.
 *
 * O `hello` ignora o filtro de propósito (R7): ele não é evento, é o snapshot
 * que abre a conexão — um cliente sem ele não teria estado nenhum pra começar.
 */
export function registerWs(app: FastifyInstance, core: Core): void {
  // Precisa estar dentro de um `register()` próprio: o hook `onRoute` que o
  // @fastify/websocket usa pra reconhecer `{ websocket: true }` só existe
  // depois que o plugin termina de bootar via avvio. Uma chamada direta a
  // `app.get(...)` aqui rodaria síncrona, antes desse boot, e a rota viraria
  // um GET normal (o handler recebendo `(request, reply)` em vez do socket).
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
      // BR-11: teto de conexões. Cada conexão registra um listener no bus e um
      // `PtyDataPump`; sem teto, um cliente com token abre N e leva o core a
      // OOM. 1013 = "try again later", o código certo pra sobrecarga.
      if (core.deps.wsClients.count >= WS_MAX_CLIENTS) {
        core.deps.log.child('ws').warn('conexão recusada: limite de clientes', { limit: WS_MAX_CLIENTS });
        socket.close(1013, t(core.language(), 'core.erro.limiteConexoes'));
        return;
      }
      const eventFilter = parseEventFilter(req.raw.url ?? '');
      const send = (msg: unknown): void => {
        try {
          socket.send(JSON.stringify(msg));
        } catch {
          // socket já fechado entre o evento e o send — ignora.
        }
      };

      const wsLog = core.deps.log.child('ws');
      const pump = new PtyDataPump({
        socket,
        warn: (message) => wsLog.warn(message),
        send: (chunk) => send({ type: 'pty.data', sessionId: chunk.sessionId, data: chunk.data }),
        schedule: (fn, delayMs) => {
          if (delayMs === 0) {
            setImmediate(fn);
            return;
          }
          setTimeout(fn, delayMs).unref?.();
        },
      });

      // Contador de clientes: é ele que autoriza o poller de git a rodar
      // (sem janela aberta, nenhum `git` é lançado — spec §7). `gitClients`
      // conta só quem RECEBE `workspace.git`: o processo main do Electron
      // conecta com um filtro que corta esse prefixo, e não faz sentido rodar
      // `git` a cada 15 s por causa de um cliente que nem veria o resultado.
      const wantsGit = eventAllowed('workspace.git', eventFilter);
      // ADR-012: mesma conta do lado do uso. Quem não recebe `usage.changed`
      // não faz o core varrer transcript nenhum a cada minuto.
      const wantsUsage = eventAllowed('usage.changed', eventFilter);
      core.deps.wsClients.count += 1;
      if (wantsGit) core.deps.wsClients.gitClients += 1;
      if (wantsUsage) core.deps.wsClients.usageClients += 1;

      send({ type: 'hello', state: snapshotState(core) });

      const unsubscribe = core.deps.bus.on((e: BridgeEvent) => {
        if (!eventAllowed(e.type, eventFilter)) return;
        if (e.type === 'pty.data') {
          pump.push(e.sessionId, e.data);
          return;
        }
        send(e);
      });

      socket.on('message', (raw: Buffer) => {
        let msg: RawClientMessage;
        try {
          msg = JSON.parse(raw.toString('utf8')) as RawClientMessage;
        } catch {
          return;
        }
        if (msg.type === 'input' && typeof msg.sessionId === 'string' && typeof msg.data === 'string') {
          core.deps.pty.write(msg.sessionId, msg.data);
        } else if (msg.type === 'resize' && typeof msg.sessionId === 'string') {
          // BR-15: a MESMA faixa do schema HTTP. Este caminho validava só
          // `typeof === 'number'` — aceitava `1e308` e negativo, que vão
          // direto pro ConPTY.
          if (!isPtyDim(msg.cols) || !isPtyDim(msg.rows)) return;
          core.deps.pty.resize(msg.sessionId, msg.cols, msg.rows);
        }
      });

      socket.on('close', () => {
        core.deps.wsClients.count = Math.max(0, core.deps.wsClients.count - 1);
        if (wantsGit) core.deps.wsClients.gitClients = Math.max(0, core.deps.wsClients.gitClients - 1);
        if (wantsUsage) core.deps.wsClients.usageClients = Math.max(0, core.deps.wsClients.usageClients - 1);
        unsubscribe();
        pump.clear();
      });
    });
  });
}
