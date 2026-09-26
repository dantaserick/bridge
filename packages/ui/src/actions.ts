import { diffCommand, isSafeRef, parseEnvironmentId } from '@bridge/shared';
import type {
  AgentId,
  KeyAction,
  Language,
  Notification,
  Pane,
  QueuedLaunch,
  Session,
  Tab,
  Workspace,
} from '@bridge/shared';
import { ApiError } from './api.js';
import { tUi } from './i18n.js';
import type { KeyHandlers } from './keys.js';
import { recapFailureMessage, recapInput, recapSentMessage } from './recap.js';
import { runsAgent, sessionLabel } from './sidebarModel.js';
import {
  activeTabId,
  diffPaneTarget,
  firstPaneOfTab,
  neighborWorkspaceId,
  paneById,
  panesOfTab,
  sessionForPane,
} from './state.js';
import type { UiAction, UiState } from './state.js';

interface ApiOptions {
  method?: string;
  body?: unknown;
}
export type ApiFn = <T = unknown>(path: string, options?: ApiOptions) => Promise<T>;

/**
 * Chave da trava de "já está em voo". As ações de teclado usam o próprio
 * `KeyAction`; o que vem do mouse usa uma chave própria (a de abrir shell é
 * por painel, porque dois painéis podem abrir ao mesmo tempo sem conflito).
 */
export type ActionLock =
  | KeyAction
  | `pane.openShell:${string}`
  /** Botão "Abrir Claude Code" do painel vazio: uma trava por painel. */
  | `pane.openClaude:${string}`
  /** ✕ do cabeçalho do painel (e o botão "Fechar painel"): trava por painel. */
  | `pane.close:${string}`
  /** Menu "Dividir" do cabeçalho: split vazio ou adoção de aba, uma trava por painel. */
  | `pane.split:${string}`
  | `session.kill:${string}`
  /** ✕ da barra de abas: uma trava por aba, não uma global. */
  | `tab.close:${string}`
  | 'session.reveal'
  /** Dor verificada #3 — "Reabrir com contexto": uma trava por SESSÃO. */
  | `session.recap:${string}`
  /** Ações do menu do workspace: uma trava por workspace, não uma global. */
  | `workspace.menu:${string}`;

/**
 * Tudo que um handler de atalho precisa. `state` é o snapshot do render — os
 * handlers leem dele e escrevem pelo `dispatch`/`api`, nunca guardam estado.
 * O que é da janela (confirmação, foco) entra por aqui: este módulo
 * não toca em DOM nem em React, e por isso roda inteiro em teste de nó.
 */
export interface ActionDeps {
  state: UiState;
  /**
   * O idioma em vigor — o `languageResolved` do `GET /api/config`, resolvido
   * pelo CORE. Vem por aqui (e não de uma leitura própria) porque as `deps` são
   * refeitas a cada render: um `config.changed` que troca o idioma reescreve o
   * `state`, o App recria as `deps`, e a próxima frase de status sai no idioma
   * novo, sem restart e sem cache a invalidar.
   */
  lang: Language;
  /**
   * O estado de AGORA, não o do render que disparou a ação. `state` é um
   * snapshot congelado: entre dois `await` de uma ação assíncrona o core pode
   * ter mandado `session.started` e o painel que era vazio já não é. Só quem
   * decide destruir coisa (o `closePane`) precisa reler; o resto trabalha com
   * o snapshot de propósito, pra não mudar de alvo no meio do caminho. No App
   * é o `stateRef` (atualizado a cada render).
   */
  latestState: () => UiState;
  dispatch: (action: UiAction) => void;
  api: ApiFn;
  /** Linha de status do rodapé: erro do core ou aviso de fase futura. */
  setStatus: (message: string | undefined) => void;
  openWorkspaceDialog: () => void;
  /** Diálogo "Nova tarefa" (`Ctrl+Shift+Alt+N` e o botão do rodapé). */
  openTaskDialog: () => void;
  /** Diálogo "Configurações" (`Ctrl+,`, a engrenagem e o item do menu "⋯"). */
  openSettingsDialog: () => void;
  /** Painel "Uso" (`Ctrl+Shift+Y`, a dica da barra e o item "Uso…" do menu). */
  openUsagePanel: () => void;
  /** Ações em voo. Vive fora do render (um `ref` no App), não neste módulo. */
  inflight: Set<string>;
  /** No app é `window.confirm`. */
  confirm: (message: string) => boolean;
  /** No app é `document.hasFocus()`. */
  windowFocused: () => boolean;
  /** No app é `getBridge().focusWindow()`. */
  focusWindow: () => void;
  /** No app é `getBridge().openPath()` — o Explorer do Windows. */
  openPath: (path: string) => void;
  /**
   * No app é `window.prompt`. Só o "Definir base…" usa: é a pergunta de uma
   * linha que o R3 pediu, sem um diálogo próprio pra um campo só.
   */
  prompt: (message: string, initial?: string) => string | null;
  /**
   * 0.12.2 — garante que a LINHA do workspace esteja aberta na sidebar. Só o
   * `revealSession` usa: quando o app te leva até uma sessão, a linha dela não
   * pode estar escondida atrás de um chevron que você fechou antes.
   *
   * É preferência local (`sidebarPrefs`), não estado do core — no App é o
   * `setGroupPrefs` com o `expandWorkspace`, que não grava nada quando o
   * workspace já estava aberto.
   */
  expandWorkspaceRow: (workspaceId: string) => void;
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispara uma ação assíncrona a partir de um evento. Erro de rota vira linha
 * de status (nunca exceção solta no `keydown`) e `lock` impede a mesma ação de
 * empilhar: enquanto a primeira não termina, as repetições são descartadas —
 * é o que evita dois splits (ou dois Claudes) por um atalho pressionado duas
 * vezes rápido, já que o `state` das seguintes ainda é o de antes da primeira.
 */
export function run(deps: ActionDeps, lock: ActionLock | undefined, fn: () => Promise<void>): void {
  if (lock !== undefined) {
    if (deps.inflight.has(lock)) return;
    deps.inflight.add(lock);
  }
  void fn()
    .catch((err: unknown) => deps.setStatus(message(err)))
    .finally(() => {
      if (lock !== undefined) deps.inflight.delete(lock);
    });
}

// ------------------------------------------------------------------ alvos

/** Aba ativa do workspace ativo. */
export function currentTab(state: UiState): Tab | undefined {
  const tabId = activeTabId(state, state.activeWorkspaceId);
  return state.layout.tabs.find((t) => t.id === tabId);
}

/**
 * Painel alvo dos atalhos: o focado quando ele está na aba visível, senão o
 * primeiro painel da aba ativa (foco parado numa aba escondida não deve fazer
 * o split aparecer fora da tela).
 */
export function targetPaneId(state: UiState): string | undefined {
  const tab = currentTab(state);
  if (!tab) return undefined;
  const focused = paneById(state, state.focusedPaneId);
  if (focused && focused.tabId === tab.id) return focused.id;
  return firstPaneOfTab(state, tab.id);
}

export function liveSessionOfPane(state: UiState, paneId: string | undefined): Session | undefined {
  const session = sessionForPane(state.sessions, paneId);
  return session && session.state !== 'exited' ? session : undefined;
}

// ------------------------------------------------------------------ ações

/** Foco de painel = foco de sessão: o core precisa saber pra política de toast. */
export async function focusPane(deps: ActionDeps, paneId: string): Promise<void> {
  deps.dispatch({ type: 'focusPane', paneId });
  const sessionId = sessionForPane(deps.state.sessions, paneId)?.id;
  await deps.api('/api/focus', { method: 'POST', body: { sessionId, windowFocused: deps.windowFocused() } });
}

export async function focusSession(deps: ActionDeps, sessionId: string): Promise<void> {
  deps.dispatch({ type: 'focus', sessionId });
  await deps.api('/api/focus', { method: 'POST', body: { sessionId, windowFocused: deps.windowFocused() } });
}

/**
 * A frase da fila do escalonador (dor verificada #1). Diz a posição porque a
 * pergunta seguinte de quem pediu um agente e não viu terminal nenhum é
 * exatamente "e agora, quando?".
 */
export function queuedMessage(position: number, lang: Language): string {
  return tUi(lang, 'actions.fila.mensagem', { posicao: position });
}

export async function createSessionInPane(
  deps: ActionDeps,
  paneId: string,
  kind: 'shell' | 'agent',
  agent?: AgentId,
): Promise<void> {
  const body = kind === 'agent' ? { paneId, kind, agent: agent ?? 'claude' } : { paneId, kind };
  const created = await deps.api<Session | QueuedLaunch>('/api/sessions', { method: 'POST', body });
  // 202: o escalonador segurou o lançamento. Não há sessão pra focar ainda —
  // ela nasce quando a fila andar, e o `session.created` do WS a traz.
  if ('queued' in created) {
    deps.setStatus(queuedMessage(created.position, deps.lang));
    return;
  }
  deps.dispatch({ type: 'focus', sessionId: created.id });
  await deps.api('/api/focus', { method: 'POST', body: { sessionId: created.id, windowFocused: deps.windowFocused() } });
}

/**
 * Dor verificada #3 — "Reabrir com contexto".
 *
 * Dois pedidos, nesta ordem: o core monta o resumo determinístico da conversa
 * que o `--resume` não trouxe (`POST /api/sessions/:id/recap`) e a UI escreve
 * o resultado no prompt do agente (`POST /api/sessions/:id/input`), com UM
 * Enter no fim.
 *
 * O `input` só sai se o `recap` deu certo: escrever "Contexto da sessão
 * anterior:" seguido de nada seria pior que não fazer nada.
 *
 * A falha do `recap` (404 do transcript apagado, 422 de transcript sem texto)
 * é re-lançada com a frase do `recapFailureMessage` em volta. Os três motivos
 * que o core devolve são FRAGMENTOS em minúscula ("o transcript da conversa
 * anterior não está mais no disco"); soltos na linha de status eles não dizem
 * de que pedido estão falando. O `run` continua sendo quem mostra — o erro
 * sobe, como em toda ação deste módulo.
 */
export async function reopenWithRecap(deps: ActionDeps, sessionId: string): Promise<void> {
  let text: string;
  try {
    ({ text } = await deps.api<{ text: string }>(`/api/sessions/${sessionId}/recap`, { method: 'POST' }));
  } catch (err) {
    const detail = recapFailureMessage(err, deps.lang);
    throw err instanceof ApiError ? new ApiError(detail, err.status, err.code, err.detail) : new Error(detail);
  }
  await deps.api(`/api/sessions/${sessionId}/input`, {
    method: 'POST',
    body: { data: recapInput(text, deps.lang) },
  });
  deps.setStatus(recapSentMessage(text.length, deps.lang));
}

export async function splitFocusedPane(deps: ActionDeps, dir: 'v' | 'h'): Promise<void> {
  const paneId = targetPaneId(deps.state);
  if (!paneId) {
    deps.setStatus(tUi(deps.lang, 'actions.semPainel.dividir'));
    return;
  }
  const pane = await deps.api<Pane>(`/api/panes/${paneId}/split`, { method: 'POST', body: { dir } });
  await focusPane(deps, pane.id);
}

/** Menu "Dividir" do cabeçalho: o mesmo split do atalho, mas num painel NOMEADO. */
export async function splitPaneById(deps: ActionDeps, paneId: string, dir: 'v' | 'h'): Promise<void> {
  const pane = await deps.api<Pane>(`/api/panes/${paneId}/split`, { method: 'POST', body: { dir } });
  await focusPane(deps, pane.id);
}

/**
 * "Trazer <aba> pro lado / pra baixo": a aba inteira entra no split deste
 * painel e some da barra; as sessões dela seguem vivas (só o `tabId` dos
 * painéis muda). O foco fica em quem chamou — a árvore nova chega pelo
 * `layout.changed`.
 */
export async function adoptTabIntoPane(deps: ActionDeps, paneId: string, dir: 'v' | 'h', tabId: string): Promise<void> {
  await deps.api(`/api/panes/${paneId}/split`, { method: 'POST', body: { dir, adoptTabId: tabId } });
  await focusPane(deps, paneId);
}

export async function navigatePane(deps: ActionDeps, dir: 'left' | 'right' | 'up' | 'down'): Promise<void> {
  const paneId = targetPaneId(deps.state);
  if (!paneId) return;
  const res = await deps.api<{ paneId: string | null }>(`/api/panes/${paneId}/neighbor?dir=${dir}`);
  if (res.paneId) await focusPane(deps, res.paneId);
}

/** Ativa um workspace e leva o foco pro primeiro painel da aba ativa dele. */
export async function activateWorkspace(deps: ActionDeps, id: string): Promise<void> {
  deps.dispatch({ type: 'activateWorkspace', id });
  const paneId = firstPaneOfTab(deps.state, activeTabId(deps.state, id));
  if (paneId) await focusPane(deps, paneId);
}

export async function stepWorkspace(deps: ActionDeps, delta: number): Promise<void> {
  const id = neighborWorkspaceId(deps.state, delta);
  if (!id || id === deps.state.activeWorkspaceId) return;
  await activateWorkspace(deps, id);
}

export async function newTab(deps: ActionDeps): Promise<void> {
  const workspaceId = deps.state.activeWorkspaceId;
  if (!workspaceId) {
    deps.setStatus(tUi(deps.lang, 'actions.semWorkspace.aba'));
    return;
  }
  const created = await deps.api<{ tab: Tab; pane?: Pane }>(`/api/workspaces/${workspaceId}/tabs`, {
    method: 'POST',
    body: { kind: 'terminal' },
  });
  deps.dispatch({ type: 'activateTab', workspaceId, tabId: created.tab.id });
  if (created.pane) await focusPane(deps, created.pane.id);
}

/**
 * "Novo Claude Code" / "Novo terminal" do menu "⋯" do workspace. Antes, o
 * único jeito de subir um Claude era o atalho (que mira o painel FOCADO) ou o
 * botão do painel vazio; o menu abre uma aba nova no workspace da linha, que
 * pode nem ser o ativo — daí a ativação antes de criar a sessão.
 */
export async function newTabWithSession(deps: ActionDeps, workspaceId: string, kind: 'shell' | 'agent'): Promise<void> {
  const created = await deps.api<{ tab: Tab; pane?: Pane }>(`/api/workspaces/${workspaceId}/tabs`, {
    method: 'POST',
    body: { kind: 'terminal' },
  });
  if (deps.state.activeWorkspaceId !== workspaceId) deps.dispatch({ type: 'activateWorkspace', id: workspaceId });
  deps.dispatch({ type: 'activateTab', workspaceId, tabId: created.tab.id });
  if (!created.pane) return;
  await createSessionInPane(deps, created.pane.id, kind, kind === 'agent' ? 'claude' : undefined);
}

/**
 * Fecha a aba ativa. O core mata as sessões dos painéis dela por conta própria
 * antes de remover o layout (`DELETE /api/tabs/:id`) — a UI só confirma
 * quando há algo vivo pra perder e chama a rota; erro vira linha de status
 * pelo `run()` do handler, como qualquer outra ação.
 */
export async function closeTab(deps: ActionDeps): Promise<void> {
  const tab = currentTab(deps.state);
  if (!tab) return;
  await closeTabById(deps, tab.id);
}

/**
 * Fecha uma aba pelo id — o `✕`/botão do meio da barra de abas, que pode
 * apontar pra uma aba que não é a ativa.
 */
export async function closeTabById(deps: ActionDeps, tabId: string): Promise<void> {
  const tab = deps.state.layout.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const live = deps.state.layout.panes
    .filter((p) => p.tabId === tab.id)
    .map((p) => liveSessionOfPane(deps.state, p.id))
    .filter((s): s is Session => s !== undefined);

  if (live.length > 0) {
    const pergunta =
      live.length === 1
        ? tUi(deps.lang, 'actions.fecharAba.uma', { titulo: tab.title })
        : tUi(deps.lang, 'actions.fecharAba.varias', { titulo: tab.title, n: live.length });
    if (!deps.confirm(pergunta)) return;
  }

  await deps.api(`/api/tabs/${tab.id}`, { method: 'DELETE' });
}

/**
 * R1: painel com sessão viva não aceita uma segunda (409). O atalho do Claude
 * então divide primeiro e sobe o agente no painel novo.
 */
export async function openClaude(deps: ActionDeps): Promise<void> {
  const paneId = targetPaneId(deps.state);
  if (!paneId) {
    deps.setStatus(tUi(deps.lang, 'actions.semWorkspace.agente'));
    return;
  }
  let target = paneId;
  if (liveSessionOfPane(deps.state, paneId)) {
    const pane = await deps.api<Pane>(`/api/panes/${paneId}/split`, { method: 'POST', body: { dir: 'v' } });
    target = pane.id;
    deps.dispatch({ type: 'focusPane', paneId: target });
  }
  await createSessionInPane(deps, target, 'agent', 'claude');
}

/** Enter num painel vazio ou encerrado. O core substitui a sessão morta. */
export async function openShell(deps: ActionDeps, paneId: string): Promise<void> {
  await createSessionInPane(deps, paneId, 'shell');
}

/**
 * As direções em que o vizinho é procurado antes de fechar, na ordem. O core
 * responde por direção (`GET /api/panes/:id/neighbor?dir=`), então a busca
 * para na primeira que devolve alguém: um split vertical resolve no `right`,
 * um horizontal no `down`, e a última coluna/linha cai no `left`/`up`.
 */
const CLOSE_FOCUS_DIRS = ['right', 'left', 'down', 'up'] as const;

/**
 * Pra onde o foco vai depois de fechar `pane`. Perguntado ANTES do `DELETE`:
 * com o painel já removido o core não tem de quem ser vizinho. `undefined`
 * quando o painel é o último da aba — aí a aba inteira some e não há o que
 * focar.
 */
async function focusAfterClose(deps: ActionDeps, pane: Pane): Promise<string | undefined> {
  const others = panesOfTab(deps.state, pane.tabId).filter((id) => id !== pane.id);
  if (others.length === 0) return undefined;

  for (const dir of CLOSE_FOCUS_DIRS) {
    const res = await deps.api<{ paneId: string | null }>(`/api/panes/${pane.id}/neighbor?dir=${dir}`);
    if (res.paneId && res.paneId !== pane.id) return res.paneId;
  }
  // Sem vizinho em direção nenhuma (árvore em estado que a UI não previu):
  // o primeiro painel da aba é melhor do que largar o foco no vazio.
  const first = firstPaneOfTab(deps.state, pane.tabId);
  return first && first !== pane.id ? first : others[0];
}

/** A pergunta do fechamento, uma só — os dois pontos de checagem usam esta. */
function closeAgentConfirm(deps: ActionDeps, session: Session): boolean {
  return deps.confirm(tUi(deps.lang, 'actions.fecharPainel.confirma', { rotulo: sessionLabel(session, deps.lang) }));
}

/**
 * Tem sessão NASCENDO neste painel? A trava de "em voo" é a única testemunha:
 * enquanto o `POST /api/sessions` não volta, o painel ainda é `empty` em todo
 * estado que a UI conhece — inclusive no mais fresco — e o `closePane` acharia
 * que não há nada pra perder. Fechar aí mataria em silêncio um agente que o
 * usuário acabou de mandar subir.
 */
function creatingSessionIn(deps: ActionDeps, paneId: string): boolean {
  return deps.inflight.has(`pane.openClaude:${paneId}`) || deps.inflight.has(`pane.openShell:${paneId}`);
}

/**
 * `Ctrl+Shift+X`, o ✕ do cabeçalho e o botão do painel vazio. Quem apaga é o
 * core (`DELETE /api/panes/:id`): ele encerra a sessão do painel se houver e,
 * se era o último painel da aba, fecha a aba junto — a UI não precisa (nem
 * deve) decidir isso.
 *
 * A pergunta é só pra sessão de AGENTE viva: um shell é barato de reabrir, um
 * agente no meio de uma tarefa não. Mesmo padrão do merge — `deps.confirm`
 * síncrono, "não" desiste sem chamar rota nenhuma.
 *
 * Fechar é destrutivo e assíncrono, então a checagem acontece DUAS vezes:
 *
 * - antes de tudo, contra `deps.state` (o snapshot do render) e contra a trava
 *   de criação em voo;
 * - de novo contra `deps.latestState()` logo antes do `DELETE`, porque entre
 *   a primeira e o `DELETE` correm as consultas de vizinho — tempo de sobra
 *   pro `session.started` de um agente chegar num painel que era vazio.
 */
export async function closePane(deps: ActionDeps, paneId: string): Promise<void> {
  const pane = paneById(deps.state, paneId);
  if (!pane) return;

  if (creatingSessionIn(deps, paneId)) {
    deps.setStatus(tUi(deps.lang, 'actions.aguardeSessao'));
    return;
  }

  const session = liveSessionOfPane(deps.state, paneId);
  let asked = false;
  // `runsAgent` e não `kind === 'agent'`: o shell que hospeda um Claude Code
  // (0.12.0) tem exatamente o que a pergunta protege — um agente no meio de
  // uma tarefa —, e o `kind` dele nunca deixa de ser `'shell'`.
  if (session && runsAgent(session)) {
    if (!closeAgentConfirm(deps, session)) return;
    asked = true;
  }

  const next = await focusAfterClose(deps, pane);

  // Releitura: quem já respondeu "sim" não é perguntado de novo pelo mesmo
  // painel, mas quem fechou um painel vazio e ganhou um agente no meio do
  // caminho tem que ser.
  if (!asked) {
    if (creatingSessionIn(deps, paneId)) {
      deps.setStatus(tUi(deps.lang, 'actions.aguardeSessao'));
      return;
    }
    const fresh = liveSessionOfPane(deps.latestState(), paneId);
    if (fresh && runsAgent(fresh) && !closeAgentConfirm(deps, fresh)) return;
  }

  await deps.api(`/api/panes/${paneId}`, { method: 'DELETE' });
  if (next) await focusPane(deps, next);
}

/** `Ctrl+Shift+X`: fecha o painel alvo (o focado, ou o primeiro da aba ativa). */
export async function closeFocusedPane(deps: ActionDeps): Promise<void> {
  const paneId = targetPaneId(deps.state);
  if (!paneId) {
    deps.setStatus(tUi(deps.lang, 'actions.semPainel.fechar'));
    return;
  }
  await closePane(deps, paneId);
}

/**
 * Leva o usuário até uma sessão: workspace, aba, painel e janela. É o que o
 * clique num toast, no painel de notificações e o `Ctrl+Shift+U` fazem.
 */
export async function revealSession(deps: ActionDeps, sessionId: string): Promise<void> {
  const session = deps.state.sessions[sessionId];
  const pane = paneById(deps.state, session?.paneId);
  const tab = pane ? deps.state.layout.tabs.find((t) => t.id === pane.tabId) : undefined;
  /**
   * 0.12.2 — a linha do workspace ANTES da aba e do painel. Recolher é
   * preferência de leitura ("não quero ver estas sessões agora"), e o
   * `revealSession` é o app dizendo "olha esta aqui": deixar a linha fechada
   * faria o Bridge focar um painel que a sidebar não está mostrando.
   *
   * O `workspaceId` sai da ABA quando ela existe (é ele que a ativação usa) e
   * cai no da sessão quando o painel não é conhecido — o caso em que só o foco
   * simples acontece.
   */
  const workspaceId = tab?.workspaceId ?? session?.workspaceId;
  if (workspaceId) deps.expandWorkspaceRow(workspaceId);
  if (tab) deps.dispatch({ type: 'activateTab', workspaceId: tab.workspaceId, tabId: tab.id });
  if (pane) deps.dispatch({ type: 'focusPane', paneId: pane.id });
  else deps.dispatch({ type: 'focus', sessionId });
  await deps.api('/api/focus', { method: 'POST', body: { sessionId, windowFocused: deps.windowFocused() } });
  deps.focusWindow();
}

export async function jumpToUnread(deps: ActionDeps): Promise<void> {
  // O core é a fonte da verdade da fila (inclusive do que chegou com o WS fora).
  const target = await deps.api<Notification | null>('/api/notifications/latest-unread');
  if (!target) {
    deps.setStatus(tUi(deps.lang, 'actions.semNaoLida'));
    return;
  }
  await revealSession(deps, target.sessionId);
}

// ------------------------------------------------- menu do workspace (git)

export function workspaceById(state: UiState, workspaceId: string): Workspace | undefined {
  return state.layout.workspaces.find((w) => w.id === workspaceId);
}

/**
 * Workspace de tarefa + o que as ações de git precisam dele. `undefined` (com
 * a linha de status já escrita) quando o workspace não é worktree: o menu não
 * mostra essas entradas, mas um atalho ou uma corrida com a remoção podem
 * chegar aqui mesmo assim.
 */
interface Task {
  workspace: Workspace;
  /** R4 — o branch do último `GitStatus`, que é o do DISCO; o do banco é reserva. */
  branch: string;
  base: string;
  /** O base é palpite (worktree adotado sem upstream) — entra no confirm. */
  baseGuessed: boolean;
}

function taskOf(deps: ActionDeps, workspaceId: string): Task | undefined {
  const workspace = workspaceById(deps.state, workspaceId);
  const worktree = workspace?.worktree;
  if (!workspace || !worktree) {
    deps.setStatus(tUi(deps.lang, 'actions.naoEWorktree'));
    return undefined;
  }
  return {
    workspace,
    branch: branchOf(deps.state, workspace),
    base: worktree.base,
    baseGuessed: worktree.baseGuessed === true,
  };
}

/**
 * R4 — o branch que a UI mostra e usa é o do `GitStatus` do core (lido do
 * disco a cada poll): o `workspace.branch` do banco envelhece no instante em
 * que o usuário dá `git checkout` dentro do worktree pelo terminal.
 */
export function branchOf(state: UiState, workspace: Workspace): string {
  const fromGit = state.gitByWorkspace[workspace.id]?.branch;
  if (fromGit && fromGit !== 'HEAD') return fromGit;
  return workspace.branch ?? workspace.worktree?.path ?? workspace.cwd;
}

/** Sufixo do confirm quando o base não foi escolhido por ninguém (R3). */
function baseLabel(task: Task, lang: Language): string {
  return task.baseGuessed ? tUi(lang, 'actions.merge.baseDeduzida', { base: task.base }) : task.base;
}

/**
 * "Ver diff": abre `git diff <base>...HEAD` num painel do próprio workspace —
 * o livre, ou um novo por split. É um shell comum com `initialCommand`, então
 * o usuário continua no prompt depois de ler o diff.
 */
/**
 * BR-03 — "Confiar nos filtros git deste repositório" (e o inverso).
 *
 * Um repositório pode declarar `filter.<x>.clean`, que o git EXECUTA a cada
 * `status` que precise comparar conteúdo — inclusive o que o poller do Bridge
 * faz sozinho a cada 15 s. Enquanto o dono não confirma que confia, o core não
 * roda esses comandos e a linha mostra "⚠ filtros" em vez de `+N ~M`.
 *
 * Confiar é uma decisão consciente: o `confirm` explica o que passa a rodar.
 * Retirar a confiança não pergunta nada — voltar a ser cauteloso é sempre seguro.
 */
export async function toggleTrustFilters(deps: ActionDeps, workspaceId: string): Promise<void> {
  const workspace = deps.state.layout.workspaces.find((w) => w.id === workspaceId);
  const repoId = workspace?.repoId;
  if (!repoId) {
    deps.setStatus(tUi(deps.lang, 'actions.semRepo'));
    return;
  }
  const repo = deps.state.layout.repos.find((r) => r.id === repoId);
  const next = !(repo?.trustFilters ?? false);

  if (next && !deps.confirm(tUi(deps.lang, 'actions.filtros.confirma'))) return;

  await deps.api(`/api/repos/${repoId}`, { method: 'PATCH', body: { trustFilters: next } });
  deps.setStatus(tUi(deps.lang, next ? 'actions.filtros.confiado' : 'actions.filtros.retirado'));
  await deps.api('/api/state').then((s) => deps.dispatch({ type: 'hello', state: s as never }));
}

export async function openDiff(deps: ActionDeps, workspaceId: string): Promise<void> {
  const task = taskOf(deps, workspaceId);
  if (!task) return;
  // BR-04: um `base` que não tem forma de ref (nome de branch com `;`, `|`,
  // `` ` ``) NÃO vira linha de comando. Melhor não abrir o diff do que digitar
  // o nome do branch de um repositório hostil no shell do dono.
  if (!isSafeRef(task.base)) {
    deps.setStatus(tUi(deps.lang, 'actions.diff.baseInvalida', { base: task.base }));
    return;
  }
  const target = diffPaneTarget(deps.state, workspaceId);
  if (!target) {
    deps.setStatus(tUi(deps.lang, 'actions.semPainel.diff'));
    return;
  }

  // A aba tem que estar visível, senão o diff abre fora da tela.
  deps.dispatch({ type: 'activateTab', workspaceId, tabId: target.tabId });

  let paneId = target.paneId;
  if (target.split) {
    const pane = await deps.api<Pane>(`/api/panes/${paneId}/split`, { method: 'POST', body: { dir: 'v' } });
    paneId = pane.id;
    deps.dispatch({ type: 'focusPane', paneId });
  }

  const session = await deps.api<Session>('/api/sessions', {
    method: 'POST',
    body: { paneId, kind: 'shell', initialCommand: diffCommand(task.base) },
  });
  deps.dispatch({ type: 'focus', sessionId: session.id });
  await deps.api('/api/focus', { method: 'POST', body: { sessionId: session.id, windowFocused: deps.windowFocused() } });
}

interface MergeResult {
  mode: 'ff-only' | 'no-ff';
  message?: string;
}

/**
 * "Mesclar no base": tenta fast-forward e, só se o core recusar com
 * `code: 'not-ff'`, pergunta se pode criar um commit de merge. Conflito, base
 * sujo e "o principal está em outro branch" sobem como erro — quem chamou
 * (`run`) põe na linha de status; a decisão é sempre do core, a UI só repete a
 * pergunta da spec §7.
 *
 * R2 — a decisão é pelo `code`, nunca pelo `detail` (que agora é só texto
 * humano) nem pela mensagem em pt-BR.
 */
export async function mergeWorkspace(deps: ActionDeps, workspaceId: string): Promise<void> {
  const task = taskOf(deps, workspaceId);
  if (!task) return;
  if (!deps.confirm(tUi(deps.lang, 'actions.merge.confirma', { branch: task.branch, base: baseLabel(task, deps.lang) })))
    return;

  const merge = (mode: 'ff-only' | 'no-ff'): Promise<MergeResult> =>
    deps.api<MergeResult>(`/api/workspaces/${workspaceId}/merge`, { method: 'POST', body: { mode } });

  let result: MergeResult;
  try {
    result = await merge('ff-only');
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'not-ff') throw err;
    if (!deps.confirm(tUi(deps.lang, 'actions.merge.naoFf'))) return;
    result = await merge('no-ff');
  }

  deps.setStatus(
    tUi(deps.lang, result.mode === 'no-ff' ? 'actions.merge.comCommit' : 'actions.merge.ff', { base: task.base }),
  );
  // Os badges `+N` vieram do último poll: sem isto a linha continua dizendo
  // que a tarefa está à frente do base até o próximo intervalo. Falhar aqui é
  // cosmético — o merge já aconteceu, e trocar a linha de status por um erro
  // faria o usuário achar que não.
  try {
    await deps.api(`/api/workspaces/${workspaceId}/git/refresh`, { method: 'POST' });
  } catch {
    // O poller corrige os badges no próximo ciclo.
  }
}

/**
 * "Remover worktree": o core recusa (409) árvore suja ou branch não mesclado e
 * explica o que falta — a explicação vai inteira pra linha de status, porque é
 * a única coisa que diz ao usuário o que fazer antes de tentar de novo.
 */
export async function removeWorktree(deps: ActionDeps, workspaceId: string): Promise<void> {
  const task = taskOf(deps, workspaceId);
  if (!task) return;
  const pergunta = task.baseGuessed
    ? tUi(deps.lang, 'actions.remover.confirmaDeduzida', { branch: task.branch, base: task.base })
    : tUi(deps.lang, 'actions.remover.confirma', { branch: task.branch });
  if (!deps.confirm(pergunta)) return;
  try {
    await deps.api(`/api/workspaces/${workspaceId}/worktree`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    deps.setStatus(err.detail ? `${err.message} · ${err.detail}` : err.message);
  }
}

/**
 * R3 — "Definir base…": o base de um worktree ADOTADO é um palpite, e é ele
 * que decide o `+N` da sidebar e o alvo do merge. Um `prompt` de uma linha
 * basta: quem valida se o ref existe é o core (`PATCH .../worktree`), que
 * conhece o repo.
 */
export async function setWorktreeBase(deps: ActionDeps, workspaceId: string): Promise<void> {
  const task = taskOf(deps, workspaceId);
  if (!task) return;
  const answer = deps.prompt(tUi(deps.lang, 'actions.base.pergunta', { branch: task.branch }), task.base);
  if (answer === null) return;
  const base = answer.trim();
  if (base === '' || base === task.base) return;
  try {
    await deps.api(`/api/workspaces/${workspaceId}/worktree`, { method: 'PATCH', body: { base } });
    deps.setStatus(tUi(deps.lang, 'actions.base.definida', { branch: task.branch, base }));
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'unknown-ref') throw err;
    deps.setStatus(err.message);
  }
}

/**
 * Dor verificada #2 — troca o AMBIENTE do workspace pelo menu "⋯".
 *
 * `envId` vazio/`undefined` volta pro padrão do Bridge (o `shell` da
 * configuração global). A troca vale da PRÓXIMA sessão: o PTY vivo continua no
 * shell em que subiu, e a linha de status diz isso — sem essa frase o dono
 * trocaria o ambiente, olharia o terminal aberto e acharia que não funcionou.
 */
export async function setWorkspaceEnvironment(
  deps: ActionDeps,
  workspaceId: string,
  envId: string | undefined,
): Promise<void> {
  const workspace = workspaceById(deps.state, workspaceId);
  if (!workspace) return;
  const environment = envId ? parseEnvironmentId(envId) : undefined;
  if (envId && !environment) {
    deps.setStatus(tUi(deps.lang, 'actions.ambiente.desconhecido', { id: envId }));
    return;
  }
  await deps.api(`/api/workspaces/${workspaceId}`, { method: 'PATCH', body: { environment: environment ?? null } });
  deps.setStatus(
    environment
      ? tUi(deps.lang, 'actions.ambiente.definido', { nome: workspace.name, id: envId ?? '' })
      : tUi(deps.lang, 'actions.ambiente.padrao', { nome: workspace.name }),
  );
}

/**
 * Dor verificada #4 — liga/desliga o acesso fora da raiz DESTE workspace.
 *
 * Ao contrário do ambiente, a troca vale NA HORA: a guarda é consultada a cada
 * `PreToolUse`, então o Claude que está travado agora volta a andar no próximo
 * `Read` — e é isso que a linha de status diz, porque "vale nas próximas
 * sessões" mandaria a pessoa reiniciar um agente à toa.
 */
export async function toggleWorkspaceCrossAccess(deps: ActionDeps, workspaceId: string): Promise<void> {
  const workspace = workspaceById(deps.state, workspaceId);
  if (!workspace) return;
  const next = !workspace.crossAccess;
  await deps.api(`/api/workspaces/${workspaceId}`, { method: 'PATCH', body: { crossAccess: next } });
  // A MESMA chave que o menu e a razão do `deny` do core usam pra nomear a
  // cerca (`core.escopo.menu.*`): as três frases falam do mesmo item.
  const cerca = tUi(deps.lang, workspace.worktree ? 'core.escopo.menu.worktree' : 'core.escopo.menu.repo');
  deps.setStatus(
    tUi(deps.lang, next ? 'actions.escopo.liberado' : 'actions.escopo.restrito', {
      nome: workspace.name,
      menu: cerca,
    }),
  );
}

/** "Abrir no Explorer": a pasta do workspace (o worktree, quando é tarefa). */
export function openWorkspaceFolder(deps: ActionDeps, workspaceId: string): void {
  const workspace = workspaceById(deps.state, workspaceId);
  if (!workspace) return;
  deps.openPath(workspace.cwd);
}

/** "Fechar workspace": o core mata as sessões vivas antes de tirar o layout. */
export async function closeWorkspace(deps: ActionDeps, workspaceId: string): Promise<void> {
  const workspace = workspaceById(deps.state, workspaceId);
  if (!workspace) return;
  if (!deps.confirm(tUi(deps.lang, 'actions.fecharWorkspace.confirma', { nome: workspace.name }))) return;
  await deps.api(`/api/workspaces/${workspaceId}`, { method: 'DELETE' });
}

/** Os 18 `KeyAction` da spec §6, na ordem de `KEY_ACTIONS`. */
export function makeKeyHandlers(deps: ActionDeps): KeyHandlers {
  return {
    'workspace.new': () => deps.openWorkspaceDialog(),
    'task.new': () => deps.openTaskDialog(),
    'tab.new': () => run(deps, 'tab.new', () => newTab(deps)),
    'tab.close': () => run(deps, 'tab.close', () => closeTab(deps)),
    'pane.splitV': () => run(deps, 'pane.splitV', () => splitFocusedPane(deps, 'v')),
    'pane.splitH': () => run(deps, 'pane.splitH', () => splitFocusedPane(deps, 'h')),
    // Trava pelo `KeyAction`, não por painel, de propósito: o atalho não diz
    // QUAL painel fecha (é sempre o alvo do momento), então duas batidas
    // rápidas de `Ctrl+Shift+X` são uma intenção só. O ✕ e o botão, que
    // apontam pra um painel nomeado, usam a trava por painel (`pane.close:id`)
    // e podem fechar dois painéis diferentes ao mesmo tempo.
    'pane.close': () => run(deps, 'pane.close', () => closeFocusedPane(deps)),
    'pane.left': () => run(deps, 'pane.left', () => navigatePane(deps, 'left')),
    'pane.right': () => run(deps, 'pane.right', () => navigatePane(deps, 'right')),
    'pane.up': () => run(deps, 'pane.up', () => navigatePane(deps, 'up')),
    'pane.down': () => run(deps, 'pane.down', () => navigatePane(deps, 'down')),
    'workspace.prev': () => run(deps, 'workspace.prev', () => stepWorkspace(deps, -1)),
    'workspace.next': () => run(deps, 'workspace.next', () => stepWorkspace(deps, 1)),
    'notifications.jump': () => run(deps, 'notifications.jump', () => jumpToUnread(deps)),
    'notifications.panel': () => deps.dispatch({ type: 'toggleNotifications' }),
    'agent.claude': () => run(deps, 'agent.claude', () => openClaude(deps)),
    'sidebar.toggle': () => deps.dispatch({ type: 'toggleSidebar' }),
    // Sem `run`/trava: abrir diálogo é estado local do App, não rota — a
    // segunda batida de `Ctrl+,` cai num `setState` idempotente.
    'settings.open': () => deps.openSettingsDialog(),
    // Mesma razão do `settings.open`: é estado local do App, não rota.
    'usage.open': () => deps.openUsagePanel(),
  };
}
