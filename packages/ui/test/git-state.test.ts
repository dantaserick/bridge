import type { GitStatus, HelloState, LayoutNode, LayoutSnapshot, Pane, Session, Tab, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { menuItems, shouldRefocusTrigger } from '../src/components/sidebar/WorkspaceMenu.js';
import { missingWorktreeLabel, formatGitBadges, worktreeMissing } from '../src/sidebarModel.js';
import { diffPaneTarget, emptyUiState, reduce } from '../src/state.js';
import type { UiState } from '../src/state.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
// ------------------------------------------------------------- fixtures

function ws(id: string, worktree = true): Workspace {
  return {
    id,
    name: id,
    cwd: `C:\\projetos\\repo\\.worktrees\\${id}`,
    branch: id,
    createdAt: 1,
    worktree: worktree ? { base: 'main', path: `C:\\projetos\\repo\\.worktrees\\${id}` } : undefined,
  };
}

function git(overrides: Partial<GitStatus> = {}): GitStatus {
  return { branch: 'feat-x', base: 'main', ahead: 0, dirty: 0, at: 10, ...overrides };
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

/** Um workspace com uma aba e `paneIds` painéis num split vertical. */
function layoutWith(paneIds: string[]): LayoutSnapshot {
  const first = paneIds[0] ?? 'pane-1';
  let node: LayoutNode = { type: 'leaf', paneId: first };
  for (const id of paneIds.slice(1)) {
    node = { type: 'split', dir: 'v', ratio: 0.5, a: node, b: { type: 'leaf', paneId: id } };
  }
  return {
    repos: [],
    workspaces: [ws('ws-1')],
    tabs: [tab('tab-1', 'ws-1')],
    panes: paneIds.map((id) => pane(id, 'tab-1')),
    layouts: { 'tab-1': node },
  };
}

function hello(overrides: Partial<HelloState> = {}): HelloState {
  return { layout: layoutWith(['pane-1']), sessions: [], unread: [], git: {}, ...overrides };
}

function stateFrom(layout: LayoutSnapshot, sessions: Session[] = []): UiState {
  return reduce(emptyUiState(), { type: 'hello', state: { layout, sessions, unread: [], git: {} } });
}

// -------------------------------------------------------------- reducer

describe('gitByWorkspace', () => {
  it('começa vazio', () => {
    expect(emptyUiState().gitByWorkspace).toEqual({});
  });

  it('hello.state.git alimenta o mapa', () => {
    const state = reduce(emptyUiState(), { type: 'hello', state: hello({ git: { 'ws-1': git({ ahead: 2, dirty: 3 }) } }) });
    expect(state.gitByWorkspace['ws-1']).toEqual(git({ ahead: 2, dirty: 3 }));
  });

  it('o snapshot manda: hello sem git zera o mapa (worktree removido no core)', () => {
    const cheio = reduce(emptyUiState(), { type: 'hello', state: hello({ git: { 'ws-1': git() } }) });
    const vazio = reduce(cheio, { type: 'hello', state: hello({ git: {} }) });
    expect(vazio.gitByWorkspace).toEqual({});
  });

  it('core antigo (sem `git` no snapshot) não quebra o reducer', () => {
    const semGit = { layout: layoutWith(['pane-1']), sessions: [], unread: [] } as unknown as HelloState;
    expect(reduce(emptyUiState(), { type: 'hello', state: semGit }).gitByWorkspace).toEqual({});
  });

  it('workspace.git troca só o workspace do evento', () => {
    const inicial = reduce(emptyUiState(), {
      type: 'hello',
      state: hello({ git: { 'ws-1': git(), 'ws-2': git({ ahead: 9 }) } }),
    });
    const depois = reduce(inicial, {
      type: 'event',
      event: { type: 'workspace.git', workspaceId: 'ws-1', git: git({ ahead: 1, dirty: 4, at: 20 }) },
    });
    expect(depois.gitByWorkspace['ws-1']).toEqual(git({ ahead: 1, dirty: 4, at: 20 }));
    expect(depois.gitByWorkspace['ws-2']).toEqual(git({ ahead: 9 }));
  });

  it('workspace.git de um workspace que a UI ainda não viu entra do mesmo jeito', () => {
    const depois = reduce(emptyUiState(), {
      type: 'event',
      event: { type: 'workspace.git', workspaceId: 'ws-novo', git: git() },
    });
    expect(depois.gitByWorkspace['ws-novo']).toEqual(git());
  });
});

// --------------------------------------------------------------- badges

describe('formatGitBadges', () => {
  it('sem status ainda (o poller não rodou) não mostra badge', () => {
    expect(formatGitBadges(undefined, PT)).toBeUndefined();
  });

  it('worktree limpo: +0 ~0 sem alerta', () => {
    expect(formatGitBadges(git(), PT)).toEqual({ ahead: '+0', dirty: '~0', dirtyWarn: false, title: 'base: main' });
  });

  it('arquivo alterado acende o `~M`', () => {
    const badges = formatGitBadges(git({ ahead: 2, dirty: 1 }), PT);
    expect(badges).toMatchObject({ ahead: '+2', dirty: '~1', dirtyWarn: true });
  });

  it('sem base no status usa a base do workspace', () => {
    expect(formatGitBadges(git({ base: undefined }), PT, 'develop')?.title).toBe('base: develop');
  });

  it('sem base nenhuma diz que não há base', () => {
    expect(formatGitBadges(git({ base: undefined }), PT)?.title).toBe('sem base conhecida');
  });
});

// ----------------------------------------------------- menu do workspace

describe('menuItems', () => {
  it('tarefa: as ações de git antes do Explorer e do fechar', () => {
    // R3 acrescentou "Definir base…" à lista; a cobertura por caso (branch
    // destacado, pasta sumida, base deduzida) está em `menu.test.ts`.
    expect(menuItems(ws('ws-1'), PT).map((i) => i.action)).toEqual([
      'newClaude',
      'newShell',
      'diff',
      'merge',
      'removeWorktree',
      'setBase',
      'crossAccess',
      'explorer',
      'close',
    ]);
    expect(menuItems(ws('ws-1'), PT).map((i) => i.label)).toContain('Mesclar no base');
  });

  it('workspace comum não oferece diff, merge nem remoção de worktree', () => {
    expect(menuItems(ws('ws-1', false), PT).map((i) => i.action)).toEqual(['newClaude', 'newShell', 'crossAccess', 'explorer', 'close']);
  });

  it('Esc e escolher um item devolvem o foco pro "⋯"', () => {
    expect(shouldRefocusTrigger('escape', true)).toBe(true);
    expect(shouldRefocusTrigger('pick', true)).toBe(true);
    // Mesmo se o foco já tiver saído do menu: o botão é o lugar de voltar.
    expect(shouldRefocusTrigger('escape', false)).toBe(true);
  });

  it('clique fora não rouba o foco de onde o usuário clicou…', () => {
    expect(shouldRefocusTrigger('outside', false)).toBe(false);
  });

  it('…mas se o foco ficaria no menu que sumiu, volta pro botão', () => {
    expect(shouldRefocusTrigger('outside', true)).toBe(true);
  });
});

// ------------------------------------------------------- alvo do "Ver diff"

describe('diffPaneTarget', () => {
  it('painel focado vazio: usa ele mesmo, sem dividir', () => {
    const state = { ...stateFrom(layoutWith(['pane-1', 'pane-2'])), focusedPaneId: 'pane-2' };
    expect(diffPaneTarget(state, 'ws-1')).toEqual({ tabId: 'tab-1', paneId: 'pane-2', split: false });
  });

  it('focado ocupado, outro livre: usa o primeiro livre', () => {
    const state = {
      ...stateFrom(layoutWith(['pane-1', 'pane-2']), [session({ paneId: 'pane-1', state: 'running' })]),
      focusedPaneId: 'pane-1',
    };
    expect(diffPaneTarget(state, 'ws-1')).toEqual({ tabId: 'tab-1', paneId: 'pane-2', split: false });
  });

  it('todos ocupados: divide o focado', () => {
    const state = {
      ...stateFrom(layoutWith(['pane-1', 'pane-2']), [
        session({ id: 'sess-1', paneId: 'pane-1', state: 'running' }),
        session({ id: 'sess-2', paneId: 'pane-2', state: 'running' }),
      ]),
      focusedPaneId: 'pane-2',
    };
    expect(diffPaneTarget(state, 'ws-1')).toEqual({ tabId: 'tab-1', paneId: 'pane-2', split: true });
  });

  it('sessão encerrada não conta como ocupado', () => {
    const state = {
      ...stateFrom(layoutWith(['pane-1']), [session({ paneId: 'pane-1', state: 'exited' })]),
      focusedPaneId: 'pane-1',
    };
    expect(diffPaneTarget(state, 'ws-1')).toEqual({ tabId: 'tab-1', paneId: 'pane-1', split: false });
  });

  it('foco parado em outro workspace: cai no primeiro painel da aba', () => {
    const state = { ...stateFrom(layoutWith(['pane-1', 'pane-2'])), focusedPaneId: 'pane-de-outro' };
    expect(diffPaneTarget(state, 'ws-1')).toMatchObject({ paneId: 'pane-1', split: false });
  });

  it('workspace sem aba nenhuma não tem alvo', () => {
    expect(diffPaneTarget(emptyUiState(), 'ws-1')).toBeUndefined();
  });
});

describe('base deduzida e worktree sumido (R3 / item 13)', () => {
  it('base deduzido entra no tooltip do badge', () => {
    expect(formatGitBadges(git(), PT, 'main', true)?.title).toBe('base: main (base deduzida)');
    expect(formatGitBadges(git(), PT, 'main', false)?.title).toBe('base: main');
  });

  it('pasta sumida: sem badge nenhum e a linha diz "(pasta sumiu)"', () => {
    const sumido = git({ error: 'missing' });
    expect(formatGitBadges(sumido, PT, 'main')).toBeUndefined();
    expect(worktreeMissing(sumido)).toBe(true);
    expect(worktreeMissing(git())).toBe(false);
    expect(worktreeMissing(undefined)).toBe(false);
    expect(missingWorktreeLabel(PT)).toBe('(pasta sumiu)');
  });
});
