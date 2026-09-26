import { DEFAULT_STORED_CONFIG } from '@bridge/shared';
import type { AgentId, Language, LayoutSnapshot, Pane, Session } from '@bridge/shared';
import { ApiError } from './api.js';
import { tUi } from './i18n.js';

/** O agente que o painel tinha e como retomá-lo (0.6.0). */
export interface RestoreResume {
  agent: AgentId;
  /**
   * `session_id` do Claude Code que o core gravou no painel. Pode faltar —
   * agente que morreu antes do primeiro hook, ou banco vindo de uma 0.5.0 —
   * e aí o painel sobe um Claude LIMPO (nunca um shell, nunca `--continue`).
   */
  sessionId?: string;
}

export interface RestoreEntry {
  paneId: string;
  hint: boolean;
  /** Presente = este painel volta como agente, não como shell. */
  resume?: RestoreResume;
}

/**
 * O texto da faixa de um painel restaurado que era Claude Code.
 *
 * 13/09/2026 — a faixa saiu de DENTRO do xterm e virou uma linha do `Pane`,
 * acima do terminal, por isso o texto agora é puro (sem SGR 90 nem `\r\n`).
 * Escrita no xterm ela durava milissegundos: o ConPTY abre toda sessão com
 * `ESC[2J ESC[H` (medido: `\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H`
 * antes do prompt do `pwsh -NoLogo`), e o prompt era desenhado por cima da
 * dica. O ConPTY é dono da grade inteira do terminal — não há linha dela que
 * a UI possa reservar —, então a faixa só sobrevive fora dela.
 *
 * É FUNÇÃO, e não constante: constante é avaliada uma vez, na importação, e a
 * troca de idioma é ao vivo (a mesma razão que matou as `ENVIRONMENT_*` na
 * Task 1).
 */
export function restoreHintBanner(lang: Language): string {
  return tUi(lang, 'restore.faixa.dica');
}

/**
 * O banner do painel que está VOLTANDO como Claude Code (0.6.0), no lugar da
 * dica acima. Os 8 primeiros caracteres do id são o mesmo prefixo que o
 * `claude --resume` mostra na lista dele — o suficiente pra conferir que a
 * conversa retomada é a que estava ali, sem despejar um UUID inteiro em cima
 * do primeiro desenho do agente. Sem id (Claude que morreu antes do primeiro
 * hook), a frase vai sozinha: o painel volta como Claude limpo.
 */
export function restoreResumeBanner(lang: Language, id?: string): string {
  return id ? tUi(lang, 'restore.faixa.retomandoId', { id: id.slice(0, 8) }) : tUi(lang, 'restore.faixa.retomando');
}

/**
 * Painéis de aba de terminal que reabrem sem sessão nenhuma — o que sobra do
 * layout persistido (spec §10) depois que o core limpa `sessions/` na subida.
 * Um painel com sessão em QUALQUER estado (viva ou `exited`) já está ocupado
 * e não entra na lista. `hint` diz se
 * o painel hospedou um agente por último, pra UI escrever a dica antes do
 * shell que a Task 9b sobe ali.
 *
 * R3 — com `workspaceId`, só os painéis DAQUELE workspace. A UI monta terminal
 * só do workspace ativo, e restaurar os outros na subida subiria um `pwsh` por
 * painel de cada workspace do usuário sem ninguém pra ver: cada um restaura na
 * primeira vez que é ativado. Sem o argumento, todos — é o que os chamadores
 * antigos (e os testes de fixture) esperam.
 *
 * 0.6.0 — `resume` sai preenchido quando as TRÊS valem: o painel hospedava um
 * agente (`lastKind === 'agent'`), quem encerrou foi o app (`lastEndedBy ===
 * 'app'`: o core marcou os painéis de agente vivos antes de matá-los no
 * `stop()`) e o dono não desligou a opção (`restore.resumeAgents`). Agente que
 * o USUÁRIO encerrou (`/exit`, ✕, fechar painel → `'user'`) ou painel de banco
 * antigo (`undefined`) continuam voltando como shell com a dica: retomar o que
 * alguém fechou de propósito é ressuscitar conversa morta.
 *
 * `resumeAgents` é a projeção de `config.restore.resumeAgents`; ausente (o
 * `GET /api/config` que ainda não voltou, core velho sem a rota) cai no
 * default de `@bridge/shared`, que é ligado.
 */
export function panesToRestore(
  snapshot: LayoutSnapshot,
  sessions: Session[],
  workspaceId?: string,
  resumeAgents: boolean = DEFAULT_STORED_CONFIG.restore.resumeAgents,
): RestoreEntry[] {
  const terminalTabIds = new Set(
    snapshot.tabs
      .filter((t) => t.kind === 'terminal' && (workspaceId === undefined || t.workspaceId === workspaceId))
      .map((t) => t.id),
  );
  const occupiedPaneIds = new Set(sessions.map((s) => s.paneId));
  const entries: RestoreEntry[] = [];
  for (const pane of snapshot.panes) {
    if (!terminalTabIds.has(pane.tabId)) continue;
    if (occupiedPaneIds.has(pane.id)) continue;
    const hint = pane.lastKind === 'agent';
    const resume = hint && resumeAgents && pane.lastEndedBy === 'app';
    entries.push({
      paneId: pane.id,
      hint,
      ...(resume
        ? {
            resume: {
              // `lastAgent` acompanha `lastKind` desde a Task 9; o fallback
              // existe pra um painel de banco antigo não virar `agent:
              // undefined` no corpo do POST (400 do core).
              agent: pane.lastAgent ?? 'claude',
              ...(pane.lastAgentSessionId ? { sessionId: pane.lastAgentSessionId } : {}),
            } satisfies RestoreResume,
          }
        : {}),
    });
  }
  return entries;
}

/**
 * A dica é da SESSÃO que o restore criou, não do painel: um `paneId` sobrevive
 * pra sempre, mas se a sessão restaurada morrer e outra nascer ali (o usuário
 * reabre um Claude Code de verdade num painel que tinha voltado como shell,
 * por exemplo) essa sessão nova não é a que a Task 9b restaurou e não herda a
 * dica — daí chavear por `session.id`, não por `pane.id`.
 *
 * 0.6.0 — o mapa guarda o TEXTO do banner, não só o id: o mesmo restore pode
 * escrever "retomando a sessão anterior…" num painel e a dica antiga no
 * vizinho (o que o usuário fechou à mão), e quem decide qual é qual é o
 * `restorePanes`, não este render.
 */
export function bannerFor(pane: Pane, session: Session | undefined, restoredBanners: ReadonlyMap<string, string>): string | undefined {
  if (!session || session.paneId !== pane.id) return undefined;
  /*
   * 13/09/2026 — fora do xterm a faixa não é mais apagada pelo próprio
   * terminal, então ela precisa saber quando SAIR:
   *
   * - `hosted`: o dono já abriu o Claude Code dentro do shell restaurado — a
   *   dica "a sessão anterior era Claude Code" cumpriu o papel;
   * - `resumeOutcome` julgado: "retomando…" é um estado em curso. Com `ok` a
   *   conversa voltou e o aviso sobra; com `fresh` quem fala é a faixa do
   *   recap (`showsRecapBanner`), e as duas juntas se contradiriam.
   */
  if (session.hosted || session.resumeOutcome !== undefined) return undefined;
  return restoredBanners.get(session.id);
}

/**
 * `session.created` pode chegar pelo WS ANTES da resposta HTTP do
 * `POST /api/sessions` que o disparou — o core emite o evento dentro de
 * `Sessions.create()`, síncrono, antes de responder a rota (fix round 2 do
 * review). Se a sessão que acabou de nascer é de um painel que o restore
 * está esperando (`pendingHintPanes`), ela É a sessão restaurada — devolve o
 * `session.id` (e o banner que aquele painel merece) pra entrar em
 * `restoredBanners` sem esperar a Promise do POST, senão o `Terminal` pode
 * montar antes da dica existir e nunca mais reescrevê-la (o efeito de
 * montagem só olha `sessionId`).
 */
export function claimPendingHint(
  pendingHintPanes: ReadonlyMap<string, string>,
  session: Session,
): { sessionId: string; banner: string } | undefined {
  const banner = pendingHintPanes.get(session.paneId);
  return banner === undefined ? undefined : { sessionId: session.id, banner };
}

/**
 * R9 — 409 do painel que ESTE restore está reabrindo é silêncio, não erro.
 *
 * O core recusa uma segunda sessão num painel que já tem uma viva
 * (`PaneBusyError`, 409). No restore isso quer dizer que alguém chegou antes —
 * o próprio Bridge numa corrida interna, ou o usuário apertando Enter no
 * painel enquanto a restauração corria. Nos dois casos o painel acabou COM
 * shell, que é exatamente o que o restore queria: mostrar um erro por isso
 * seria assustar o usuário com o sucesso.
 *
 * Qualquer outra falha (404 do painel que sumiu, 500 do core, rede caída) é
 * de verdade e vai pra faixa de status.
 */
export function isPaneAlreadyBusy(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * A linha de status de um restore em paralelo: `undefined` quando não houve
 * falha de verdade. Uma frase só — o usuário não precisa de uma por painel, e
 * a faixa mostra uma mensagem por vez.
 */
export function restoreFailureMessage(errors: readonly unknown[], lang: Language): string | undefined {
  const real = errors.filter((err) => !isPaneAlreadyBusy(err));
  if (real.length === 0) return undefined;
  const first = real[0];
  // O `message` do erro vem do core, já traduzido — a UI só o embrulha.
  const detail = first instanceof Error ? first.message : String(first);
  const prefix =
    real.length === 1 ? tUi(lang, 'restore.erro.umPainel') : tUi(lang, 'restore.erro.variosPaineis', { n: real.length });
  return `${prefix}: ${detail}`;
}

/**
 * A faixa de status de um resume que não deu certo (0.6.0). O painel não fica
 * órfão: quem chama cai pro shell com a dica antiga logo em seguida — esta
 * frase é só pra o dono saber POR QUE o Claude não voltou (binário sumiu do
 * PATH, 422 `agent-unavailable`, cwd que não existe mais).
 */
export function resumeFailureMessage(err: unknown, lang: Language): string {
  const detail = err instanceof Error ? err.message : String(err);
  return tUi(lang, 'restore.erro.resume', { detalhe: detail });
}

/**
 * O efeito de restauração por workspace (R3) roda quando um workspace vira o
 * ativo. Ele tem que ficar quieto em dois casos, e esta é a regra inteira:
 *
 * - `restored` — aquele workspace já passou por aqui nesta execução do app (a
 *   restauração é uma vez por workspace, não uma por ativação);
 * - `creating` — há uma criação de workspace/tarefa **em voo**. O workspace que
 *   aparece nessa janela é o que o diálogo está criando, e ele nasce como o
 *   usuário pediu (com ou sem Claude no primeiro painel).
 *
 * O `creating` não é "diálogo aberto na tela": o `Escape`/"Cancelar" fecham o
 * diálogo enquanto o `POST /api/workspaces` (e depois o `POST /api/sessions` do
 * Claude, que leva segundos no `available()`) ainda estão correndo. Quem manda
 * é o pedido, não a janela — daí o dono da marca ser o App, que a acende no
 * início do `submit()` e a apaga num `finally`.
 *
 * O que isso evitava até a 0.6.0: o core emite `layout.changed` ao criar o
 * workspace, ANTES de responder o POST; a UI re-buscava o estado, o workspace
 * novo virava o ativo e a restauração subia um `pwsh` no painel em que o Claude
 * ia nascer. Com o core reservando o painel (0.6.0) isso vira um 409 silencioso
 * em vez de duas sessões vivas — mas continua sendo um pedido inútil, e um
 * `pwsh` no painel se o Claude demorar mais que o shell.
 */
export function shouldSkipRestore(state: { creating: boolean; restored: boolean }): boolean {
  return restoreDecision(state) !== 'restore';
}

/**
 * O que o efeito faz com o workspace que acabou de virar ativo. São TRÊS
 * saídas, não duas, e a terceira é o conserto de um bug de 0.8.0:
 *
 * - `'restore'` — reabre os shells e marca o workspace como restaurado;
 * - `'done'` — já passou por aqui nesta execução; não faz nada;
 * - `'wait'` — há uma criação em voo que PODE ser este workspace: não restaura
 *   **e não marca**. Até a 0.8.0 o efeito marcava nos dois casos de pulo, então
 *   um workspace que virou ativo durante uma criação perdia a restauração
 *   *para sempre* naquela execução do app (recuperável só à mão, reabrindo
 *   cada painel). Sem a marca, a próxima ativação — depois que a criação
 *   termina — restaura normalmente.
 *
 * O workspace que a criação de fato criou não volta por aqui: o `onCreated` do
 * diálogo o marca como restaurado na hora, porque ele já nasce como o usuário
 * pediu.
 */
export type RestoreDecision = 'restore' | 'wait' | 'done';

export function restoreDecision(state: { creating: boolean; restored: boolean }): RestoreDecision {
  if (state.restored) return 'done';
  if (state.creating) return 'wait';
  return 'restore';
}

/**
 * A criação em voo é DESTE workspace? (o escopo que o `creatingWorkspaces` do
 * `App` guarda por criação.)
 *
 * O id do workspace que está nascendo só existe quando o `POST` responde — e o
 * `layout.changed` chega antes disso. O que dá pra saber antes é o contrário:
 * quais workspaces JÁ existiam quando o pedido começou. Cada criação em voo
 * guarda esse conjunto; um workspace que estava lá não pode ser o que está
 * nascendo, e a restauração dele segue normal.
 *
 * Sem esse escopo, qualquer criação em voo suprimia o restore de QUALQUER
 * workspace que virasse ativo na janela: trocar pra um workspace nunca
 * restaurado enquanto o diálogo esperava o `POST` perdia a restauração dele.
 *
 * `pending` é uma lista (não um conjunto só) porque duas criações podem correr
 * ao mesmo tempo, e basta UMA não conhecer o workspace pra ele ser suspeito.
 */
export function isWorkspaceBeingCreated(pending: ReadonlyArray<ReadonlySet<string>>, workspaceId: string): boolean {
  return pending.some((known) => !known.has(workspaceId));
}

/**
 * O registro das criações em voo. Cada `begin` devolve a função que encerra
 * AQUELA criação — e só ela.
 *
 * Por que identidade, e não uma pilha: duas criações podem se cruzar e terminar
 * FORA DE ORDEM (o diálogo de workspace leva um `Escape` no meio do `POST`, o
 * de tarefa é aberto e responde primeiro). Tirando "a mais antiga" a cada fim,
 * o conjunto que sobrava era o da criação errada — e o escopo do pulo passava a
 * valer pro workspace errado. Com um id por pedido, sai exatamente a que
 * acabou.
 *
 * A função de fim é IDEMPOTENTE: ela sai de um `finally`, e um `finally` que
 * roda duas vezes (ou um diálogo desmontado que ainda avisa) não pode derrubar
 * a marca de outra criação.
 *
 * `onEnd` é o gancho que o `App` usa pra reavaliar a restauração do workspace
 * ATIVO quando uma criação termina: sem ele, um workspace que ficou ativo a
 * criação inteira nunca seria reexaminado (o efeito só roda de novo quando o
 * workspace ativo MUDA, e quem muda no fim é o workspace recém-criado).
 */
export interface CreatingWorkspaces {
  /** Marca uma criação em voo, guardando os ids que já existiam agora. */
  begin(known: Iterable<string>): () => void;
  /** Alguma criação em voo pode estar criando ESTE workspace? */
  isCreating(workspaceId: string): boolean;
  /** Quantas criações estão em voo — diagnóstico e teste. */
  size(): number;
}

export function makeCreatingWorkspaces(onEnd?: () => void): CreatingWorkspaces {
  const pending = new Map<number, ReadonlySet<string>>();
  let nextId = 0;
  return {
    begin(known) {
      const id = nextId;
      nextId += 1;
      pending.set(id, new Set(known));
      return () => {
        if (!pending.delete(id)) return;
        onEnd?.();
      };
    },
    isCreating(workspaceId) {
      return isWorkspaceBeingCreated([...pending.values()], workspaceId);
    },
    size: () => pending.size,
  };
}

/**
 * Qual mensagem a faixa de status mostra depois de um restore — a faixa mostra
 * UMA por vez.
 *
 * O resume que falhou ganha do agregado de propósito: ele é a frase específica
 * ("Não deu pra retomar o Claude Code: <motivo>") e o agregado é a genérica
 * ("Não consegui reabrir o shell em um painel"). Quando o resume falha E o
 * shell de queda no MESMO painel falha, os dois existem — e a que explica o que
 * o usuário perdeu (a conversa) é a primeira.
 */
export function pickRestoreMessage(
  resumeMessage: string | undefined,
  errors: readonly unknown[],
  lang: Language,
): string | undefined {
  return resumeMessage ?? restoreFailureMessage(errors, lang);
}
