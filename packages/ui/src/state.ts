import { DEFAULT_KEYBINDINGS } from '@bridge/shared';
import type {
  BridgeConfig,
  BridgeEvent,
  GitStatus,
  HelloState,
  KeybindingProblem,
  Keybindings,
  KeybindingsResponse,
  LauncherStatus,
  LayoutNode,
  LayoutSnapshot,
  Notification,
  Pane,
  Session,
  Tab,
  UsageLimitWindow,
  UsageScanProgress,
  UsageReport,
} from '@bridge/shared';

export type { HelloState, Notification, Session };

export interface UiState {
  layout: LayoutSnapshot;
  sessions: Record<string, Session>;
  unread: Notification[];
  focusedSessionId?: string;
  /** Painel focado. Anda junto com `focusedSessionId`: um implica o outro. */
  focusedPaneId?: string;
  activeWorkspaceId?: string;
  /** Aba ativa POR workspace — trocar de workspace volta pra aba onde você estava. */
  activeTabByWorkspace: Record<string, string>;
  /**
   * `+N ~M` por workspace de worktree. Vem inteiro no `hello` e é atualizado
   * de um em um pelo evento `workspace.git` do poller do core — a UI nunca
   * calcula git, só mostra o que o core mandou (spec §7).
   */
  gitByWorkspace: Record<string, GitStatus>;
  sidebarOpen: boolean;
  notificationsOpen: boolean;
  keybindings: Keybindings;
  /**
   * O que o core achou de errado ao LER o `keybindings.json` (campo irmão
   * `problems` do `GET /api/keybindings`). Fica separado da tabela porque a
   * tabela é sempre válida — o core já caiu nos defaults do que não deu pra
   * usar —, e sem esta lista o diálogo não teria como avisar que o arquivo do
   * dono foi descartado. Vazio = arquivo impecável, ausente, ou core velho sem
   * o campo.
   */
  keybindingProblems: readonly KeybindingProblem[];
  /**
   * A configuração do core (`GET /api/config`), atualizada pelo evento
   * `config.changed`. É `undefined` até a primeira resposta chegar — e
   * continua `undefined` contra um core velho, sem a rota. Quem lê trata a
   * ausência com o default (`resolveTerminalPrefs`, `fieldValue`), nunca com
   * um valor inventado aqui: um default gravado no estado viraria "a config
   * diz 12" e piscaria o terminal quando a real chegasse.
   */
  config?: BridgeConfig;
  /**
   * As janelas de limite VIVAS da conta (ADR-012). Buscadas uma vez por
   * conexão em `GET /api/usage/limits` e atualizadas pelo evento
   * `usage.changed`, que manda a lista INTEIRA — nunca um delta.
   *
   * Lista vazia é resposta legítima (conta de API key não recebe
   * `rate_limits`), e é por isso que o campo não é opcional: `[]` já quer
   * dizer "sem limites a exibir", e a sidebar não desenha nada.
   */
  usageLimits: UsageLimitWindow[];
  /**
   * Progresso da varredura de transcrições (`usage.changed { scanning }` e o
   * `scanning` do próprio relatório). Fica FORA de `usage` porque vale mesmo
   * com o painel fechado: é o que o botão "Reler transcrições" das
   * Configurações mostra, e o painel só o consome.
   */
  usageScanning: UsageScanProgress | null;
  /**
   * O escalonador de lançamentos (dor verificada #1): fila, teto e quantas
   * sessões o servidor está estrangulando. Buscado uma vez por conexão em
   * `GET /api/launcher` e atualizado pelo evento `launcher.changed`, que manda
   * o status INTEIRO.
   *
   * `undefined` até a primeira resposta — e contra um core velho, sem a rota.
   * A sidebar não desenha nada nesse caso, que é o mesmo efeito de uma fila
   * vazia; inventar um status aqui faria a linha "0 aguardando" existir.
   */
  launcher?: LauncherStatus;
  /**
   * O último `GET /api/usage` do painel. Só existe enquanto o painel esteve
   * aberto: ele é um relatório de um RECORTE, e guardá-lo com o painel fechado
   * faria o app segurar um mês de agregados que ninguém está olhando.
   */
  usage?: UsageReport;
  connected: boolean;
  /**
   * BR-07: o core conseguiu restringir a ACL do `instance.json`? `false` = o
   * arquivo com o TOKEN ficou com a permissao herdada da pasta do perfil, e a
   * UI mostra um banner PERSISTENTE (nao a linha de status, que some em 4 s).
   * `undefined` antes do primeiro `hello`, ou em core que nao manda o campo.
   */
  instanceAclApplied?: boolean;
}

export type UiAction =
  | { type: 'hello'; state: HelloState }
  | { type: 'event'; event: BridgeEvent }
  | { type: 'focus'; sessionId: string }
  | { type: 'focusPane'; paneId?: string }
  | { type: 'activateWorkspace'; id: string }
  | { type: 'activateTab'; workspaceId: string; tabId: string }
  | { type: 'toggleSidebar' }
  | { type: 'toggleNotifications' }
  /** Corpo cru do `GET /api/keybindings`: a tabela MAIS o `problems` opcional. */
  | { type: 'setKeybindings'; value: KeybindingsResponse }
  /** Resposta do `GET /api/config` e do `PATCH` do diálogo de configurações. */
  | { type: 'setConfig'; value: BridgeConfig }
  /** Resposta de `GET /api/usage/limits` (o hello) — a lista inteira. */
  | { type: 'setUsageLimits'; value: UsageLimitWindow[] }
  /** Resposta de `GET /api/usage`; `undefined` limpa ao fechar o painel. */
  | { type: 'setUsage'; value: UsageReport | undefined }
  /** Resposta de `GET /api/launcher` (uma vez por conexão). */
  | { type: 'setLauncher'; value: LauncherStatus }
  | { type: 'connected'; value: boolean };

export function emptyLayout(): LayoutSnapshot {
  return { repos: [], workspaces: [], tabs: [], panes: [], layouts: {} };
}

export function emptyUiState(): UiState {
  return {
    layout: emptyLayout(),
    sessions: {},
    unread: [],
    focusedSessionId: undefined,
    focusedPaneId: undefined,
    activeWorkspaceId: undefined,
    activeTabByWorkspace: {},
    gitByWorkspace: {},
    sidebarOpen: true,
    notificationsOpen: false,
    keybindings: DEFAULT_KEYBINDINGS,
    keybindingProblems: [],
    config: undefined,
    usageLimits: [],
    usageScanning: null,
    usage: undefined,
    launcher: undefined,
    connected: false,
    instanceAclApplied: undefined,
  };
}

// ---------------------------------------------------------------- seletores

/** Abas de terminal de um workspace, na ordem que o core gravou. */
export function terminalTabs(layout: LayoutSnapshot, workspaceId: string): Tab[] {
  return layout.tabs.filter((t) => t.workspaceId === workspaceId && t.kind === 'terminal').sort((a, b) => a.order - b.order);
}

/**
 * TODAS as abas de um workspace, na ordem do core — o que a barra de abas
 * desenha.
 */
export function workspaceTabs(layout: LayoutSnapshot, workspaceId: string): Tab[] {
  return layout.tabs.filter((t) => t.workspaceId === workspaceId).sort((a, b) => a.order - b.order);
}

export function activeTabId(state: UiState, workspaceId: string | undefined): string | undefined {
  if (!workspaceId) return undefined;
  return state.activeTabByWorkspace[workspaceId];
}

/**
 * A sessão de um painel. R1 garante no máximo uma viva por painel; quando o
 * core ainda não removeu a encerrada, a viva é a que interessa.
 */
export function sessionForPane(sessions: Record<string, Session>, paneId: string | undefined): Session | undefined {
  if (!paneId) return undefined;
  let exited: Session | undefined;
  for (const session of Object.values(sessions)) {
    if (session.paneId !== paneId) continue;
    if (session.state !== 'exited') return session;
    exited ??= session;
  }
  return exited;
}

/** Todos os painéis de uma árvore de layout, da esquerda pra direita. */
export function leavesOf(node: LayoutNode | undefined): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.paneId];
  return [...leavesOf(node.a), ...leavesOf(node.b)];
}

export function firstLeafOf(node: LayoutNode | undefined): string | undefined {
  return leavesOf(node)[0];
}

/**
 * R1 — os dois painéis que identificam o divisor de um split: o primeiro leaf
 * de cada lado. É o que o `POST /api/panes/:id/ratio` precisa pra achar o
 * menor ancestral comum; com um leaf só o core subiria pro pai imediato dele,
 * que em árvore aninhada é outro divisor (o bug F2).
 */
export function ratioTargets(
  node: Extract<LayoutNode, { type: 'split' }>,
): { paneId: string; siblingPaneId: string } | undefined {
  const paneId = firstLeafOf(node.a);
  const siblingPaneId = firstLeafOf(node.b);
  if (!paneId || !siblingPaneId) return undefined;
  return { paneId, siblingPaneId };
}

/** Primeiro painel da aba ativa de um workspace — o alvo padrão de foco. */
export function firstPaneOfTab(state: UiState, tabId: string | undefined): string | undefined {
  if (!tabId) return undefined;
  const fromTree = firstLeafOf(state.layout.layouts[tabId]);
  if (fromTree) return fromTree;
  return state.layout.panes.find((p) => p.tabId === tabId)?.id;
}

export function paneById(state: UiState, paneId: string | undefined): Pane | undefined {
  if (!paneId) return undefined;
  return state.layout.panes.find((p) => p.id === paneId);
}

/** Todos os painéis de uma aba, pela árvore quando existe, senão pela tabela. */
export function panesOfTab(state: UiState, tabId: string): string[] {
  const fromTree = leavesOf(state.layout.layouts[tabId]);
  if (fromTree.length > 0) return fromTree;
  return state.layout.panes.filter((p) => p.tabId === tabId).map((p) => p.id);
}

/**
 * Onde o "Ver diff" de um workspace vai abrir. A ordem é a do menu do
 * workspace (spec §7): o painel focado quando está livre, senão o primeiro
 * painel livre da mesma aba, senão divide o focado — nunca joga um `git diff`
 * por cima de um agente vivo (R1: painel com sessão viva recusa uma segunda).
 */
export function diffPaneTarget(
  state: UiState,
  workspaceId: string,
): { tabId: string; paneId: string; split: boolean } | undefined {
  const tabId = activeTabId(state, workspaceId) ?? terminalTabs(state.layout, workspaceId)[0]?.id;
  if (!tabId) return undefined;
  const paneIds = panesOfTab(state, tabId);
  const first = paneIds[0];
  if (first === undefined) return undefined;

  const focused = state.focusedPaneId && paneIds.includes(state.focusedPaneId) ? state.focusedPaneId : first;
  const busy = (paneId: string): boolean => {
    const session = sessionForPane(state.sessions, paneId);
    return session !== undefined && session.state !== 'exited';
  };

  if (!busy(focused)) return { tabId, paneId: focused, split: false };
  const free = paneIds.find((id) => !busy(id));
  if (free !== undefined) return { tabId, paneId: free, split: false };
  return { tabId, paneId: focused, split: true };
}

/** Workspace anterior (`-1`) ou próximo (`+1`), circular. */
export function neighborWorkspaceId(state: UiState, delta: number): string | undefined {
  const ids = state.layout.workspaces.map((w) => w.id);
  if (ids.length === 0) return undefined;
  const current = state.activeWorkspaceId ? ids.indexOf(state.activeWorkspaceId) : -1;
  const base = current === -1 ? 0 : current;
  const next = (((base + delta) % ids.length) + ids.length) % ids.length;
  return ids[next];
}

// ----------------------------------------------------------------- reducer

function sessionsToRecord(sessions: Session[]): Record<string, Session> {
  const record: Record<string, Session> = {};
  for (const session of sessions) record[session.id] = session;
  return record;
}

function pickFocused(sessions: Record<string, Session>, current: string | undefined): string | undefined {
  if (current && sessions[current]) return current;
  return Object.keys(sessions)[0];
}

/** Mantém o workspace ativo se ainda existir; senão o primeiro (ou nenhum). */
function pickActiveWorkspace(layout: LayoutSnapshot, current: string | undefined): string | undefined {
  if (current && layout.workspaces.some((w) => w.id === current)) return current;
  return layout.workspaces[0]?.id;
}

/**
 * Aba ativa por workspace: a guardada continua valendo enquanto existir;
 * quando some (aba fechada, workspace novo) cai na primeira de terminal.
 * Workspace que sumiu sai do mapa.
 */
function pickActiveTabs(layout: LayoutSnapshot, current: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const workspace of layout.workspaces) {
    const tabs = workspaceTabs(layout, workspace.id);
    const stored = current[workspace.id];
    const fallback = tabs[0]?.id;
    const keep = stored && tabs.some((t) => t.id === stored) ? stored : fallback;
    if (keep) next[workspace.id] = keep;
  }
  return next;
}

function reduceHello(state: UiState, hello: HelloState): UiState {
  const sessions = sessionsToRecord(hello.sessions);
  const paneStillThere = state.focusedPaneId && hello.layout.panes.some((p) => p.id === state.focusedPaneId);

  let focusedPaneId: string | undefined;
  let focusedSessionId: string | undefined;
  if (paneStillThere) {
    focusedPaneId = state.focusedPaneId;
    focusedSessionId = sessionForPane(sessions, focusedPaneId)?.id;
  } else {
    focusedSessionId = pickFocused(sessions, state.focusedSessionId);
    focusedPaneId = focusedSessionId ? sessions[focusedSessionId]?.paneId : undefined;
  }

  return {
    ...state,
    layout: hello.layout,
    sessions,
    unread: hello.unread,
    focusedSessionId,
    focusedPaneId,
    activeWorkspaceId: pickActiveWorkspace(hello.layout, state.activeWorkspaceId),
    activeTabByWorkspace: pickActiveTabs(hello.layout, state.activeTabByWorkspace),
    // O snapshot manda: worktree que sumiu (removido, mesclado) some do mapa.
    // Core sem a Fase 3 não manda `git` nenhum e o mapa fica vazio.
    // BR-07: vem do `hello`/`GET /api/state` a cada reconexao; o banner segue o
    // ESTADO, entao um core que voltou com a ACL aplicada apaga o aviso sozinho.
    instanceAclApplied: hello.instanceAclApplied,
    gitByWorkspace: hello.git ?? {},
  };
}

function reduceEvent(state: UiState, event: BridgeEvent): UiState {
  switch (event.type) {
    case 'session.created': {
      const sessions = { ...state.sessions, [event.session.id]: event.session };
      // Adota o foco quando não havia sessão focada, ou quando a focada era a
      // sessão encerrada que o core acabou de substituir neste mesmo painel
      // (R1). Fora isso, sessão nova não rouba foco de quem está trabalhando.
      const focused = state.focusedSessionId ? state.sessions[state.focusedSessionId] : undefined;
      const replaced = focused?.state === 'exited' && focused.paneId === event.session.paneId;
      const adopt = state.focusedSessionId === undefined || replaced;
      const focusedSessionId = adopt ? event.session.id : state.focusedSessionId;
      const focusedPaneId = adopt ? event.session.paneId : state.focusedPaneId;
      return { ...state, sessions, focusedSessionId, focusedPaneId };
    }
    case 'session.state': {
      const existing = state.sessions[event.id];
      if (!existing) return state;
      const updated: Session = {
        ...existing,
        state: event.state,
        detail: event.detail,
        tool: event.tool,
        stateSince: event.stateSince,
        // SUBSTITUI, nunca mescla: o evento sem `serverLimit` é a notícia de
        // que a sessão saiu do limite do servidor, e manter a prova antiga
        // deixaria o tooltip afirmando um estrangulamento que já passou.
        serverLimit: event.serverLimit,
      };
      return { ...state, sessions: { ...state.sessions, [event.id]: updated } };
    }
    /**
     * Dor verificada #3 — o desfecho do `--resume`. SUBSTITUI a sessão inteira
     * (o evento carrega o registro do core), mas só se ela já estiver aqui:
     * um `session.updated` de sessão desconhecida é um evento fora de ordem, e
     * adotá-lo criaria uma sessão que o `hello` nunca mencionou.
     *
     * Não mexe no foco: o resume que voltou vazio é uma notícia sobre o painel
     * onde ela aconteceu, não um convite pra sair de onde a pessoa está.
     */
    case 'session.updated': {
      if (!state.sessions[event.session.id]) return state;
      return { ...state, sessions: { ...state.sessions, [event.session.id]: event.session } };
    }
    case 'session.quota': {
      const existing = state.sessions[event.id];
      if (!existing) return state;
      const updated: Session = { ...existing, quota: event.quota };
      return { ...state, sessions: { ...state.sessions, [event.id]: updated } };
    }
    case 'session.exited': {
      const existing = state.sessions[event.id];
      if (!existing) return state;
      const updated: Session = { ...existing, state: 'exited', exitCode: event.exitCode };
      return { ...state, sessions: { ...state.sessions, [event.id]: updated } };
    }
    case 'session.removed': {
      if (!state.sessions[event.id]) return state;
      const sessions = { ...state.sessions };
      delete sessions[event.id];
      const focusedSessionId = state.focusedSessionId === event.id ? undefined : state.focusedSessionId;
      return { ...state, sessions, focusedSessionId };
    }
    case 'notification.new': {
      const { id, sessionId, kind, text, at, readAt } = event.notification;
      // O core já gravou isto na sessão (`noteNotification`), mas não emite
      // evento de sessão por causa disso: sem espelhar aqui, a linha da última
      // notificação na sidebar só apareceria no próximo `GET /api/state`.
      const session = state.sessions[sessionId];
      const sessions = session ? { ...state.sessions, [sessionId]: { ...session, lastNotification: { kind, text, at } } } : state.sessions;
      const alreadyUnread = state.unread.some((n) => n.id === id);
      const unread = readAt || alreadyUnread ? state.unread : [event.notification, ...state.unread];
      return { ...state, sessions, unread };
    }
    case 'notification.read': {
      const ids = new Set(event.ids);
      return { ...state, unread: state.unread.filter((n) => !ids.has(n.id)) };
    }
    case 'usage.changed':
      // O evento manda a lista INTEIRA quando alguma janela mudou, e nada
      // quando só os dias foram tocados (`dailyTouched`) — por isso o
      // `?? state.usageLimits` em vez de zerar. Quem decide se vale reler o
      // relatório é o painel (`touchesReport`): o reducer não faz rede.
      return {
        ...state,
        usageLimits: event.limits ?? state.usageLimits,
        // `undefined` = o evento não falou de varredura; `null` seria uma
        // afirmação ("não há varredura") que só o core faz explicitamente.
        usageScanning: event.scanning !== undefined ? event.scanning : state.usageScanning,
      };
    case 'config.changed':
      // Vem a config INTEIRA, não o campo alterado (contrato da Task 5a): dá
      // pra substituir sem remontar, e um cliente que perdeu um evento não
      // fica com uma versão pela metade. Chega em TODA janela aberta, então
      // mexer nas configurações num Bridge reflete no outro na hora.
      return { ...state, config: event.config };
    case 'workspace.git':
      return { ...state, gitByWorkspace: { ...state.gitByWorkspace, [event.workspaceId]: event.git } };
    case 'launcher.changed':
      // Status INTEIRO (contrato do evento): substitui sem remontar.
      return { ...state, launcher: event.status };
    case 'layout.changed':
      // Sinal: quem despacha a ação re-busca GET /api/state e manda um `hello`.
      return state;
    case 'pty.data':
    case 'pty.exit':
      // Consumidos diretamente pelo módulo ws.ts (assinatura por sessão), não pelo reducer.
      return state;
    default:
      return state;
  }
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'hello':
      return reduceHello(state, action.state);
    case 'event':
      return reduceEvent(state, action.event);
    case 'focus': {
      const paneId = state.sessions[action.sessionId]?.paneId;
      return { ...state, focusedSessionId: action.sessionId, focusedPaneId: paneId ?? state.focusedPaneId };
    }
    case 'focusPane':
      return {
        ...state,
        focusedPaneId: action.paneId,
        focusedSessionId: sessionForPane(state.sessions, action.paneId)?.id,
      };
    case 'activateWorkspace':
      return { ...state, activeWorkspaceId: action.id };
    case 'activateTab':
      return {
        ...state,
        activeWorkspaceId: action.workspaceId,
        activeTabByWorkspace: { ...state.activeTabByWorkspace, [action.workspaceId]: action.tabId },
      };
    case 'toggleSidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'toggleNotifications':
      return { ...state, notificationsOpen: !state.notificationsOpen };
    case 'setKeybindings': {
      // `problems` é um campo IRMÃO das ações no corpo da rota (não um
      // envelope). Ele sai da tabela aqui, e não fica lá dentro por descuido:
      // `state.keybindings` é passado adiante como `Keybindings` puro, e um
      // array pendurado nele vazaria pra quem itera o objeto em vez de
      // `KEY_ACTIONS`.
      const { problems, ...bindings } = action.value;
      return { ...state, keybindings: bindings, keybindingProblems: problems ?? [] };
    }
    case 'setConfig':
      return { ...state, config: action.value };
    case 'setUsageLimits':
      return { ...state, usageLimits: action.value };
    case 'setLauncher':
      return { ...state, launcher: action.value };
    case 'setUsage':
      // O relatório traz o progresso junto: quem abre o painel no meio da
      // primeira varredura vê o "ainda lendo" sem esperar o próximo evento.
      return {
        ...state,
        usage: action.value,
        usageScanning: action.value ? action.value.scanning : state.usageScanning,
      };
    case 'connected':
      return { ...state, connected: action.value };
    default:
      return state;
  }
}
