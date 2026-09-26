import { DEFAULT_KEYBINDINGS } from '@bridge/shared';
import type { Keybindings, LayoutNode, LayoutSnapshot, Pane, Session, Tab, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { activeTabId, emptyUiState, neighborWorkspaceId, ratioTargets, reduce, sessionForPane } from '../src/state.js';
import type { UiState } from '../src/state.js';

function ws(id: string, name = id): Workspace {
  return { id, name, cwd: `C:\\projetos\\${name}`, createdAt: 1000 };
}

function tab(id: string, workspaceId: string, order: number): Tab {
  return { id, workspaceId, title: 'Terminal', kind: 'terminal', order };
}

function pane(id: string, tabId: string): Pane {
  return { id, tabId, cwd: 'C:\\projetos\\x' };
}

function leaf(paneId: string): LayoutNode {
  return { type: 'leaf', paneId };
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

/** Dois workspaces, um tab de terminal cada, um painel cada. */
function layoutTwo(): LayoutSnapshot {
  return {
    repos: [],
    workspaces: [ws('ws-1'), ws('ws-2')],
    tabs: [tab('tab-1', 'ws-1', 0), tab('tab-2', 'ws-2', 0)],
    panes: [pane('pane-1', 'tab-1'), pane('pane-2', 'tab-2')],
    layouts: { 'tab-1': leaf('pane-1'), 'tab-2': leaf('pane-2') },
  };
}

function hello(state: UiState, layout: LayoutSnapshot, sessions: Session[] = []): UiState {
  return reduce(state, { type: 'hello', state: { layout, sessions, unread: [] } });
}

describe('emptyUiState', () => {
  it('começa com a sidebar aberta, o painel de notificações fechado e os defaults de atalho', () => {
    const s = emptyUiState();
    expect(s.sidebarOpen).toBe(true);
    expect(s.notificationsOpen).toBe(false);
    expect(s.keybindings).toEqual(DEFAULT_KEYBINDINGS);
    expect(s.activeWorkspaceId).toBeUndefined();
    expect(s.activeTabByWorkspace).toEqual({});
    expect(s.focusedPaneId).toBeUndefined();
  });
});

describe('reduce — hello: workspace e aba ativos', () => {
  it('escolhe o primeiro workspace quando não há nenhum ativo', () => {
    const next = hello(emptyUiState(), layoutTwo());
    expect(next.activeWorkspaceId).toBe('ws-1');
  });

  it('mantém o workspace ativo quando ele ainda existe', () => {
    const first = hello(emptyUiState(), layoutTwo());
    const active = reduce(first, { type: 'activateWorkspace', id: 'ws-2' });
    const next = hello(active, layoutTwo());
    expect(next.activeWorkspaceId).toBe('ws-2');
  });

  it('cai no primeiro workspace quando o ativo sumiu', () => {
    const active = reduce(hello(emptyUiState(), layoutTwo()), { type: 'activateWorkspace', id: 'ws-2' });
    const layout = layoutTwo();
    layout.workspaces = [ws('ws-1')];
    layout.tabs = [tab('tab-1', 'ws-1', 0)];
    const next = hello(active, layout);
    expect(next.activeWorkspaceId).toBe('ws-1');
  });

  it('fica sem workspace ativo quando não há nenhum', () => {
    const next = hello(emptyUiState(), { repos: [], workspaces: [], tabs: [], panes: [], layouts: {} });
    expect(next.activeWorkspaceId).toBeUndefined();
  });

  it('escolhe a primeira aba de terminal por `order` em cada workspace', () => {
    const layout = layoutTwo();
    layout.tabs = [
      tab('tab-1b', 'ws-1', 1),
      tab('tab-1a', 'ws-1', 0),
      tab('tab-2', 'ws-2', 0),
    ];
    const next = hello(emptyUiState(), layout);
    expect(next.activeTabByWorkspace).toEqual({ 'ws-1': 'tab-1a', 'ws-2': 'tab-2' });
  });

  it('mantém a aba ativa depois de layout.changed + hello novo quando ela ainda existe', () => {
    const layout = layoutTwo();
    layout.tabs = [tab('tab-1', 'ws-1', 0), tab('tab-1b', 'ws-1', 1), tab('tab-2', 'ws-2', 0)];
    const first = hello(emptyUiState(), layout);
    const chosen = reduce(first, { type: 'activateTab', workspaceId: 'ws-1', tabId: 'tab-1b' });
    const signalled = reduce(chosen, { type: 'event', event: { type: 'layout.changed' } });
    const next = hello(signalled, layout);
    expect(next.activeTabByWorkspace['ws-1']).toBe('tab-1b');
  });

  it('troca pra primeira aba quando a ativa foi fechada', () => {
    const layout = layoutTwo();
    layout.tabs = [tab('tab-1', 'ws-1', 0), tab('tab-1b', 'ws-1', 1), tab('tab-2', 'ws-2', 0)];
    const chosen = reduce(hello(emptyUiState(), layout), { type: 'activateTab', workspaceId: 'ws-1', tabId: 'tab-1b' });
    const after = layoutTwo();
    const next = hello(chosen, after);
    expect(next.activeTabByWorkspace['ws-1']).toBe('tab-1');
  });

  it('esquece workspaces que sumiram do mapa de abas', () => {
    const first = hello(emptyUiState(), layoutTwo());
    expect(Object.keys(first.activeTabByWorkspace).sort()).toEqual(['ws-1', 'ws-2']);
    const layout = layoutTwo();
    layout.workspaces = [ws('ws-1')];
    layout.tabs = [tab('tab-1', 'ws-1', 0)];
    const next = hello(first, layout);
    expect(Object.keys(next.activeTabByWorkspace)).toEqual(['ws-1']);
  });
});

describe('reduce — hello: foco', () => {
  it('mantém o painel focado quando ele ainda existe e sincroniza a sessão', () => {
    const first = hello(emptyUiState(), layoutTwo(), [session({ id: 'sess-2', paneId: 'pane-2' })]);
    const focused = reduce(first, { type: 'focusPane', paneId: 'pane-1' });
    expect(focused.focusedSessionId).toBeUndefined();
    const next = hello(focused, layoutTwo(), [session({ id: 'sess-1', paneId: 'pane-1' })]);
    expect(next.focusedPaneId).toBe('pane-1');
    expect(next.focusedSessionId).toBe('sess-1');
  });

  it('cai na primeira sessão quando o painel focado sumiu', () => {
    const first = reduce(hello(emptyUiState(), layoutTwo()), { type: 'focusPane', paneId: 'pane-2' });
    const layout = layoutTwo();
    layout.panes = [pane('pane-1', 'tab-1')];
    const next = hello(first, layout, [session({ id: 'sess-1', paneId: 'pane-1' })]);
    expect(next.focusedSessionId).toBe('sess-1');
    expect(next.focusedPaneId).toBe('pane-1');
  });
});

describe('reduce — foco de painel e de sessão andam juntos', () => {
  it('focusPane num painel com sessão foca a sessão', () => {
    const s = hello(emptyUiState(), layoutTwo(), [session({ id: 'sess-2', paneId: 'pane-2' })]);
    const next = reduce(s, { type: 'focusPane', paneId: 'pane-2' });
    expect(next.focusedPaneId).toBe('pane-2');
    expect(next.focusedSessionId).toBe('sess-2');
  });

  it('focusPane num painel vazio zera a sessão focada', () => {
    const s = hello(emptyUiState(), layoutTwo(), [session({ id: 'sess-2', paneId: 'pane-2' })]);
    const next = reduce(reduce(s, { type: 'focusPane', paneId: 'pane-2' }), { type: 'focusPane', paneId: 'pane-1' });
    expect(next.focusedPaneId).toBe('pane-1');
    expect(next.focusedSessionId).toBeUndefined();
  });

  it('focar uma sessão foca o painel dela', () => {
    const s = hello(emptyUiState(), layoutTwo(), [session({ id: 'sess-2', paneId: 'pane-2' })]);
    const next = reduce(s, { type: 'focus', sessionId: 'sess-2' });
    expect(next.focusedPaneId).toBe('pane-2');
    expect(next.focusedSessionId).toBe('sess-2');
  });

  it('session.created no painel focado adota a sessão nova', () => {
    const s = reduce(hello(emptyUiState(), layoutTwo()), { type: 'focusPane', paneId: 'pane-1' });
    const created = session({ id: 'sess-new', paneId: 'pane-1' });
    const next = reduce(s, { type: 'event', event: { type: 'session.created', session: created } });
    expect(next.focusedSessionId).toBe('sess-new');
    expect(next.focusedPaneId).toBe('pane-1');
  });
});

describe('reduce — sidebar, notificações e keybindings', () => {
  it('alterna a sidebar', () => {
    const s = emptyUiState();
    expect(reduce(s, { type: 'toggleSidebar' }).sidebarOpen).toBe(false);
    expect(reduce(reduce(s, { type: 'toggleSidebar' }), { type: 'toggleSidebar' }).sidebarOpen).toBe(true);
  });

  it('alterna o painel de notificações', () => {
    const s = emptyUiState();
    expect(reduce(s, { type: 'toggleNotifications' }).notificationsOpen).toBe(true);
  });

  it('substitui os keybindings', () => {
    const custom: Keybindings = { ...DEFAULT_KEYBINDINGS, 'pane.splitV': 'Ctrl+Alt+D' };
    const next = reduce(emptyUiState(), { type: 'setKeybindings', value: custom });
    expect(next.keybindings['pane.splitV']).toBe('Ctrl+Alt+D');
    // Arquivo impecável (ou perfil sem arquivo): o core nem manda o campo.
    expect(next.keybindingProblems).toEqual([]);
  });

  /**
   * `problems` é um campo IRMÃO das ações no corpo da rota. Ele tem que SAIR
   * da tabela no reducer: `state.keybindings` é passado adiante como
   * `Keybindings`, e um array pendurado nele vazaria pra quem itera o objeto.
   */
  it('separa o `problems` da tabela de atalhos', () => {
    const next = reduce(emptyUiState(), {
      type: 'setKeybindings',
      value: { ...DEFAULT_KEYBINDINGS, problems: [{ kind: 'json-invalido' }] },
    });
    expect(next.keybindingProblems).toEqual([{ kind: 'json-invalido' }]);
    expect(Object.keys(next.keybindings)).not.toContain('problems');
    expect(next.keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });
});

describe('neighborWorkspaceId — circular', () => {
  it('anda pra frente e volta pro começo', () => {
    const layout = layoutTwo();
    layout.workspaces = [ws('ws-1'), ws('ws-2'), ws('ws-3')];
    const s = { ...hello(emptyUiState(), layout), activeWorkspaceId: 'ws-3' };
    expect(neighborWorkspaceId(s, 1)).toBe('ws-1');
    expect(neighborWorkspaceId({ ...s, activeWorkspaceId: 'ws-1' }, 1)).toBe('ws-2');
  });

  it('anda pra trás e dá a volta', () => {
    const s = hello(emptyUiState(), layoutTwo());
    expect(s.activeWorkspaceId).toBe('ws-1');
    expect(neighborWorkspaceId(s, -1)).toBe('ws-2');
  });

  it('com um workspace só devolve ele mesmo; sem nenhum devolve undefined', () => {
    const layout = layoutTwo();
    layout.workspaces = [ws('ws-1')];
    const one = hello(emptyUiState(), layout);
    expect(neighborWorkspaceId(one, 1)).toBe('ws-1');
    expect(neighborWorkspaceId(emptyUiState(), 1)).toBeUndefined();
  });
});

describe('seletores', () => {
  it('activeTabId devolve a aba ativa do workspace', () => {
    const s = hello(emptyUiState(), layoutTwo());
    expect(activeTabId(s, 'ws-2')).toBe('tab-2');
    expect(activeTabId(s, 'ws-inexistente')).toBeUndefined();
  });

  it('sessionForPane prefere a sessão viva à encerrada', () => {
    const sessions = {
      dead: session({ id: 'dead', paneId: 'pane-1', state: 'exited' }),
      live: session({ id: 'live', paneId: 'pane-1', state: 'running' }),
    };
    expect(sessionForPane(sessions, 'pane-1')?.id).toBe('live');
    expect(sessionForPane({ dead: sessions.dead }, 'pane-1')?.id).toBe('dead');
    expect(sessionForPane(sessions, 'pane-9')).toBeUndefined();
  });
});

/**
 * R1 — o divisor arrastado é o do split; a UI manda o primeiro leaf de CADA
 * lado dele, e o core resolve o menor ancestral comum. Mandar só um leaf (o
 * que a UI fazia) deixava o core subir pro pai imediato — que em árvore
 * aninhada é o divisor errado.
 */
describe('ratioTargets (R1)', () => {
  it('devolve o primeiro leaf de cada lado do split', () => {
    const inner: LayoutNode = { type: 'split', dir: 'h', ratio: 0.5, a: leaf('p1'), b: leaf('p4') };
    const node = { type: 'split', dir: 'v', ratio: 0.5, a: inner, b: leaf('p2') } as const;
    expect(ratioTargets(node)).toEqual({ paneId: 'p1', siblingPaneId: 'p2' });
  });

  it('no split interno os dois leaves são os próprios filhos', () => {
    const node = { type: 'split', dir: 'h', ratio: 0.5, a: leaf('p1'), b: leaf('p4') } as const;
    expect(ratioTargets(node)).toEqual({ paneId: 'p1', siblingPaneId: 'p4' });
  });

  it('lado sem leaf nenhum (árvore impossível) devolve undefined', () => {
    const vazio = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('p1'), b: undefined } as unknown as Extract<
      LayoutNode,
      { type: 'split' }
    >;
    expect(ratioTargets(vazio)).toBeUndefined();
  });
});
