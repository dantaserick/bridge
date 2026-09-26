import type { LauncherStatus, LayoutSnapshot, Notification, Session, SessionState, Workspace } from '@bridge/shared';
import { formatRelativeTime, isDisplaySafe } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import {
  filtersUntrustedLabel,
  filtersUntrustedTitle,
  LAUNCH_ERROR_MAX_AGE_MS,
  LOOSE_GROUP_ID,
  looseGroupName,
  aggregateState,
  applyGroupPrefs,
  collapsedGroupState,
  filtersUntrusted,
  formatGitBadges,
  groupHeaderLabel,
  groupWorkspaces,
  launchErrorText,
  launcherErrorLine,
  launcherQueueLine,
  mergeNotifications,
  nextRowIndex,
  notificationKindLabel,
  unreadBellLabel,
  serverLimitNote,
  sessionStateLabels,
  serverLimitBadge,
  sessionRowLabel,
  truncate,
  workspaceRowLabel,
  worktreeMissing,
} from '../src/sidebarModel.js';
import { workspaceChevronLabel } from '../src/components/sidebar/WorkspaceRow.js';
import { EMPTY_GROUP_PREFS, toggleCollapsedWorkspace, workspaceCollapsed } from '../src/sidebarPrefs.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function workspace(id: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, cwd: `C:\\projetos\\${id}`, createdAt: 0, ...extra };
}

function layout(partial: Partial<LayoutSnapshot>): LayoutSnapshot {
  return { repos: [], workspaces: [], tabs: [], panes: [], layouts: {}, ...partial };
}

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    paneId: `pane_${id}`,
    workspaceId: 'ws',
    kind: 'agent',
    agent: 'claude',
    state: 'idle',
    startedAt: 0,
    stateSince: 0,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\x',
    ...extra,
  };
}

function notification(id: string, extra: Partial<Notification> = {}): Notification {
  return { id, sessionId: 'sess', workspaceId: 'ws', kind: 'done', text: id, at: 0, ...extra };
}

// ------------------------------------------------------------ groupWorkspaces

describe('groupWorkspaces', () => {
  it('agrupa por repositório, ordena os grupos por nome e deixa "Sem repositório" por último', () => {
    const snapshot = layout({
      repos: [
        { id: 'r1', path: 'C:\\projetos\\code\\forja', name: 'forja', trustFilters: false },
        { id: 'r2', path: 'C:\\projetos\\code\\bridge', name: 'bridge', trustFilters: false },
      ],
      workspaces: [
        workspace('solta'),
        workspace('f1', { repoId: 'r1' }),
        workspace('b1', { repoId: 'r2' }),
      ],
    });

    expect(groupWorkspaces(snapshot, PT).map((g) => g.name)).toEqual(['bridge', 'forja', 'Sem repositório']);
  });

  it('ordena os workspaces de cada grupo por createdAt crescente', () => {
    const snapshot = layout({
      repos: [{ id: 'r1', path: 'C:\\projetos\\forja', name: 'forja', trustFilters: false }],
      workspaces: [
        workspace('c', { repoId: 'r1', createdAt: 300 }),
        workspace('a', { repoId: 'r1', createdAt: 100 }),
        workspace('b', { repoId: 'r1', createdAt: 200 }),
      ],
    });

    expect(groupWorkspaces(snapshot, PT)[0]?.workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('joga workspace sem repoId em "Sem repositório"', () => {
    const groups = groupWorkspaces(layout({ workspaces: [workspace('x')] }), PT);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(LOOSE_GROUP_ID);
    expect(groups[0]?.name).toBe('Sem repositório');
  });

  it('joga workspace com repoId desconhecido em "Sem repositório" (Fase 2 não tem repos ainda)', () => {
    const groups = groupWorkspaces(layout({ workspaces: [workspace('x', { repoId: 'fantasma' })] }), PT);
    expect(groups.map((g) => g.id)).toEqual([LOOSE_GROUP_ID]);
    expect(groups[0]?.workspaces.map((w) => w.id)).toEqual(['x']);
  });

  it('omite grupo de repositório sem workspace', () => {
    const snapshot = layout({
      repos: [{ id: 'r1', path: 'C:\\projetos\\vazio', name: 'vazio', trustFilters: false }],
      workspaces: [workspace('x')],
    });
    expect(groupWorkspaces(snapshot, PT).map((g) => g.name)).toEqual(['Sem repositório']);
  });

  it('sem workspace nenhum, não devolve grupo', () => {
    expect(groupWorkspaces(layout({}), PT)).toEqual([]);
  });
});

// ----------------------------------------------------------- applyGroupPrefs

describe('applyGroupPrefs', () => {
  const groups = [
    { id: 'r1', name: 'bridge', workspaces: [workspace('b1')] },
    { id: 'r2', name: 'forja', workspaces: [workspace('f1')] },
    { id: LOOSE_GROUP_ID, name: looseGroupName(PT), workspaces: [workspace('x')] },
  ];

  it('sem preferência nenhuma, mantém a ordem do groupWorkspaces', () => {
    const out = applyGroupPrefs(groups, { pinned: [], collapsed: [], collapsedWorkspaces: [] });
    expect(out.map((g) => g.id)).toEqual(['r1', 'r2', LOOSE_GROUP_ID]);
    expect(out.every((g) => !g.pinned && !g.collapsed)).toBe(true);
  });

  it('sobe os fixados pro topo NA ORDEM EM QUE FORAM FIXADOS', () => {
    const out = applyGroupPrefs(groups, { pinned: [LOOSE_GROUP_ID, 'r2'], collapsed: [], collapsedWorkspaces: [] });
    expect(out.map((g) => g.id)).toEqual([LOOSE_GROUP_ID, 'r2', 'r1']);
    expect(out.map((g) => g.pinned)).toEqual([true, true, false]);
  });

  it('"Sem repositório" fixado deixa de ser o último', () => {
    const out = applyGroupPrefs(groups, { pinned: [LOOSE_GROUP_ID], collapsed: [], collapsedWorkspaces: [] });
    expect(out[0]?.name).toBe(looseGroupName(PT));
  });

  it('marca os recolhidos sem mexer na ordem', () => {
    const out = applyGroupPrefs(groups, { pinned: [], collapsed: ['r2', 'fantasma'], collapsedWorkspaces: [] });
    expect(out.map((g) => g.id)).toEqual(['r1', 'r2', LOOSE_GROUP_ID]);
    expect(out.map((g) => g.collapsed)).toEqual([false, true, false]);
  });

  it('ignora id fixado que não é grupo nenhum (repositório removido)', () => {
    const out = applyGroupPrefs(groups, { pinned: ['fantasma', 'r2'], collapsed: [], collapsedWorkspaces: [] });
    expect(out.map((g) => g.id)).toEqual(['r2', 'r1', LOOSE_GROUP_ID]);
  });

  it('não duplica nem perde grupo quando tudo está fixado', () => {
    const out = applyGroupPrefs(groups, { pinned: [LOOSE_GROUP_ID, 'r1', 'r2'], collapsed: [], collapsedWorkspaces: [] });
    expect(out.map((g) => g.id)).toEqual([LOOSE_GROUP_ID, 'r1', 'r2']);
  });
});

// -------------------------------------------------------- collapsedGroupState

describe('collapsedGroupState', () => {
  const group = { id: 'r1', name: 'bridge', workspaces: [workspace('a'), workspace('b')] };

  it('devolve o pior estado entre as sessões dos workspaces do grupo', () => {
    const sessions = [
      session('s1', { workspaceId: 'a', state: 'running' }),
      session('s2', { workspaceId: 'b', state: 'stuck' }),
    ];
    expect(collapsedGroupState(group, sessions)).toBe('stuck');
  });

  it('ignora sessão de workspace de fora do grupo', () => {
    const sessions = [
      session('s1', { workspaceId: 'a', state: 'idle' }),
      session('s2', { workspaceId: 'z', state: 'stuck' }),
    ];
    expect(collapsedGroupState(group, sessions)).toBe('idle');
  });

  it('grupo sem sessão nenhuma não tem anel', () => {
    expect(collapsedGroupState(group, [])).toBeUndefined();
  });
});

// --------------------------------- workspace recolhido/expandido (0.12.2)

/**
 * Até a 0.12.1 o expandido era, por definição, o workspace ATIVO: a `Sidebar`
 * passava `expanded={workspace.id === state.activeWorkspaceId}`, e ativar um
 * retraía o outro. Desde a 0.12.2 as duas coisas são independentes — o
 * expandido sai da preferência local, e o ativo só ganha o realce.
 */
describe('o que a Sidebar decide por workspace', () => {
  const ativo = 'a';
  const outro = 'b';

  it('com preferência vazia, TODOS estão expandidos — inclusive o que não é o ativo', () => {
    for (const id of [ativo, outro]) {
      expect(workspaceCollapsed(EMPTY_GROUP_PREFS, id)).toBe(false);
    }
  });

  it('recolher um workspace não mexe no outro, nem no que está ativo', () => {
    const prefs = toggleCollapsedWorkspace(EMPTY_GROUP_PREFS, outro);
    expect(workspaceCollapsed(prefs, outro)).toBe(true);
    expect(workspaceCollapsed(prefs, ativo)).toBe(false);
  });

  it('o ATIVO também pode ser recolhido — ele mantém o realce, não a abertura', () => {
    const prefs = toggleCollapsedWorkspace(EMPTY_GROUP_PREFS, ativo);
    expect(workspaceCollapsed(prefs, ativo)).toBe(true);
  });

  /**
   * O rótulo do chevron diz o que o clique VAI fazer E EM QUEM: numa sidebar
   * com dez workspaces, dez botões "Recolher workspace" são dez controles
   * indistinguíveis pra quem usa leitor de tela. O `title` (que é o mesmo
   * texto) resolve pro mouse, mas `title` não é anunciado.
   */
  it('o rótulo do chevron diz o que o clique VAI fazer e em QUAL workspace', () => {
    expect(workspaceChevronLabel('mailbox', true, PT)).toBe('Recolher mailbox');
    expect(workspaceChevronLabel('mailbox', false, PT)).toBe('Expandir mailbox');
  });

  it('dois workspaces dão dois rótulos DIFERENTES', () => {
    expect(workspaceChevronLabel('api', true, PT)).not.toBe(workspaceChevronLabel('painel', true, PT));
  });

  /**
   * O anel da linha é `aggregateState` das sessões DAQUELE workspace, e a
   * linha o desenha esteja ela recolhida ou aberta — a mesma ideia do
   * `collapsedGroupState`. Recolher esconde as sessões, nunca o "essa aqui
   * travou".
   */
  it('recolhido, o anel agregado da linha continua sendo o pior estado das sessões dele', () => {
    const sessions = [
      session('s1', { workspaceId: ativo, state: 'running' }),
      session('s2', { workspaceId: ativo, state: 'stuck' }),
      session('s3', { workspaceId: outro, state: 'idle' }),
    ];
    const doWorkspace = sessions.filter((s) => s.workspaceId === ativo);
    expect(aggregateState(doWorkspace)).toBe('stuck');
    expect(aggregateState(sessions.filter((s) => s.workspaceId === outro))).toBe('idle');
  });
});

// ------------------------------------------------------------- aggregateState

describe('aggregateState', () => {
  const worst: Array<[SessionState[], SessionState]> = [
    [['idle', 'running', 'stuck', 'done'], 'stuck'],
    [['idle', 'done', 'needs-input'], 'needs-input'],
    [['idle', 'running', 'done'], 'done'],
    [['idle', 'running'], 'running'],
    [['exited', 'idle'], 'idle'],
    [['exited'], 'exited'],
  ];

  for (const [states, expected] of worst) {
    it(`${states.join('+')} → ${expected}`, () => {
      expect(aggregateState(states.map((s, i) => session(`s${i}`, { state: s })))).toBe(expected);
    });
  }

  it('sem sessão, não há estado', () => {
    expect(aggregateState([])).toBeUndefined();
  });
});

// -------------------------------------------------------------------- truncate

describe('truncate', () => {
  it('não mexe no que já cabe', () => {
    expect(truncate('curto', 60)).toBe('curto');
    expect(truncate('a'.repeat(60), 60)).toBe('a'.repeat(60));
  });

  it('corta o excesso e nunca passa do limite', () => {
    const cut = truncate('a'.repeat(61), 60);
    expect(cut).toBe(`${'a'.repeat(59)}…`);
    expect(cut).toHaveLength(60);
  });

  it('não deixa espaço colado na reticência', () => {
    expect(truncate(`${'a'.repeat(58)} bbbb`, 60)).toBe(`${'a'.repeat(58)}…`);
  });

  it('usa 60 como limite padrão', () => {
    expect(truncate('a'.repeat(80))).toHaveLength(60);
  });
});

// ---------------------------------------------------------------- formatRelativeTime

describe('formatRelativeTime', () => {
  const now = 1_000 * DAY;

  const cases: Array<[number, string]> = [
    [0, 'agora'],
    [30_000, 'agora'],
    [59_999, 'agora'],
    [MIN, 'há 1 min'],
    [4 * MIN, 'há 4 min'],
    [59 * MIN, 'há 59 min'],
    [HOUR, 'há 1 h'],
    [2 * HOUR, 'há 2 h'],
    [23 * HOUR + 59 * MIN, 'há 23 h'],
    [DAY, 'ontem'],
    [47 * HOUR, 'ontem'],
    [2 * DAY, 'há 2 dias'],
    [9 * DAY, 'há 9 dias'],
  ];

  for (const [ago, expected] of cases) {
    it(`${ago} ms atrás → "${expected}"`, () => {
      expect(formatRelativeTime(now - ago, now, PT)).toBe(expected);
    });
  }

  it('relógio adiantado não vira tempo negativo', () => {
    expect(formatRelativeTime(now + 5 * MIN, now, PT)).toBe('agora');
  });
});

// ----------------------------------------------------------- notificationKindLabel

describe('notificationKindLabel', () => {
  it('dá um cabeçalho legível por tipo, em pt-BR', () => {
    expect(notificationKindLabel('needs-input', PT)).toBe('Precisa de você');
    expect(notificationKindLabel('done', PT)).toBe('Terminou');
    expect(notificationKindLabel('stuck', PT)).toBe('Travado');
    expect(notificationKindLabel('custom', PT)).toBe('Aviso');
  });

  it('segue o idioma', () => {
    expect(notificationKindLabel('needs-input', 'en')).toBe('Needs you');
  });
});

describe('unreadBellLabel', () => {
  it('sem não lidas, o sino continua na tela com rótulo neutro', () => {
    expect(unreadBellLabel(0, PT)).toBe('Nenhuma notificação não lida');
  });

  it('com não lidas, o rótulo traz a contagem', () => {
    expect(unreadBellLabel(3, PT)).toBe('3 notificações não lidas');
  });
});

// ----------------------------------------------------------- mergeNotifications

describe('mergeNotifications', () => {
  it('ordena por `at` decrescente', () => {
    const merged = mergeNotifications(
      [notification('a', { at: 100 }), notification('b', { at: 300 }), notification('c', { at: 200 })],
      [],
      1000,
    );
    expect(merged.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('acrescenta não lida que ainda não estava na lista', () => {
    const merged = mergeNotifications([notification('a', { at: 100 })], [notification('nova', { at: 500 })], 1000);
    expect(merged.map((n) => n.id)).toEqual(['nova', 'a']);
  });

  it('marca como lida quem saiu da fila de não lidas', () => {
    const merged = mergeNotifications([notification('a', { at: 100 })], [], 999);
    expect(merged[0]?.readAt).toBe(999);
  });

  it('não mexe no readAt de quem já estava lida', () => {
    const merged = mergeNotifications([notification('a', { at: 100, readAt: 42 })], [], 999);
    expect(merged[0]?.readAt).toBe(42);
  });

  it('mantém não lida quem continua na fila', () => {
    const merged = mergeNotifications([notification('a', { at: 100 })], [notification('a', { at: 100 })], 999);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.readAt).toBeUndefined();
  });

  it('descarta id repetido (histórico + WS na mesma lista)', () => {
    const merged = mergeNotifications(
      [notification('a', { at: 100 }), notification('a', { at: 100, readAt: 7 })],
      [],
      999,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.readAt).toBe(999);
  });

  it('não muta as listas recebidas', () => {
    const items = [notification('a', { at: 100 })];
    const unread = [notification('b', { at: 200 })];
    mergeNotifications(items, unread, 999);
    expect(items.map((n) => n.id)).toEqual(['a']);
    expect(items[0]?.readAt).toBeUndefined();
    expect(unread.map((n) => n.id)).toEqual(['b']);
  });
});

/**
 * BR-03 (fix round 3): repositório que declara `filter.*` e ainda não foi
 * confiado. O core NÃO mediu `dirty`/`ahead` (medir executaria o `clean` do
 * repo), então a linha não pode mostrar `+0 ~0` — mostraria uma mentira do
 * mesmo tipo do worktree que sumiu.
 */
describe('filtros git não confiados na linha do workspace', () => {
  const at = 1000;

  it('não há badges `+N ~M` quando o status vem com `filters-untrusted`', () => {
    const git = { branch: 'main', base: 'main', ahead: 0, dirty: 0, at, error: 'filters-untrusted' as const };
    expect(formatGitBadges(git, PT, 'main')).toBeUndefined();
    expect(filtersUntrusted(git)).toBe(true);
    // E não se confunde com o worktree apagado, que tem outro texto e outro menu.
    expect(worktreeMissing(git)).toBe(false);
  });

  it('status normal continua com badges e sem o aviso', () => {
    const git = { branch: 'main', base: 'main', ahead: 2, dirty: 1, at };
    expect(formatGitBadges(git, PT, 'main')?.ahead).toBe('+2');
    expect(filtersUntrusted(git)).toBe(false);
  });

  it('o selo e o tooltip explicam o motivo e apontam a saída', () => {
    expect(filtersUntrustedLabel(PT)).toContain('filtros');
    expect(filtersUntrustedTitle(PT)).toContain('clean/smudge');
    expect(filtersUntrustedTitle(PT)).toContain('menu');
  });
});

// ---------------------------------------------------------------- a11y

/**
 * A sidebar inteira é feita de cor e forma: o anel diz o estado, a faixa azul
 * diz o foco, o contador do grupo recolhido diz o tamanho. Nada disso existe
 * pra quem usa leitor de tela — estes rótulos são a versão em texto, e são
 * puros justamente pra ficarem sob teste.
 */
describe('rótulos acessíveis das linhas', () => {
  it('todo estado de sessão tem nome em pt-BR', () => {
    const states: SessionState[] = ['idle', 'running', 'needs-input', 'done', 'stuck', 'exited', 'server-limited'];
    for (const state of states) expect(sessionStateLabels(PT)[state]).toBeTruthy();
    expect(Object.keys(sessionStateLabels(PT)).sort()).toEqual([...states].sort());
  });

  it('a linha do workspace anuncia nome, quantas sessões e o pior estado', () => {
    expect(workspaceRowLabel({ name: 'exemplo', state: 'needs-input', sessions: 2 }, PT)).toBe(
      'Workspace exemplo, 2 sessões, esperando você',
    );
    expect(workspaceRowLabel({ name: 'exemplo', state: 'running', sessions: 1 }, PT)).toBe('Workspace exemplo, 1 sessão, trabalhando');
  });

  it('workspace sem sessão diz isso, e não um estado inventado', () => {
    expect(workspaceRowLabel({ name: 'vazio', state: 'empty', sessions: 0 }, PT)).toBe('Workspace vazio, sem sessões');
  });

  it('os avisos da linha (pasta sumida, filtros) entram no rótulo', () => {
    const label = workspaceRowLabel({ name: 'tarefa', state: 'idle', sessions: 1, missing: true, untrusted: true }, PT);
    expect(label).toContain('a pasta do worktree sumiu');
    expect(label).toContain('filtros git não confiados');
  });

  it('a linha da sessão anuncia o rótulo, o estado, o detalhe e o foco', () => {
    expect(sessionRowLabel({ label: 'claude', state: 'stuck', detail: 'esperando permissão', focused: true }, PT)).toBe(
      'Sessão claude, travada, esperando permissão, em foco',
    );
    expect(sessionRowLabel({ label: 'shell', state: 'idle', detail: '…\projetos\exemplo', focused: false }, PT)).not.toContain('em foco');
  });

  it('o cabeçalho de grupo recolhido carrega contador e estado; expandido, só o contador', () => {
    expect(groupHeaderLabel({ name: 'forja', count: 3, collapsed: true, ringState: 'stuck' }, PT)).toBe(
      'Grupo forja, 3 workspaces, travada, recolhido',
    );
    expect(groupHeaderLabel({ name: 'forja', count: 1, collapsed: false, ringState: 'stuck' }, PT)).toBe('Grupo forja, 1 workspace, expandido');
  });
});

/**
 * ↑/↓ andam pelas linhas da sidebar. A regra é pura; quem conta as linhas e
 * move o foco é a `Sidebar`, que lê o DOM (a lista muda a cada evento do core).
 */
describe('nextRowIndex (↑/↓ entre as linhas)', () => {
  it('desce e sobe uma linha por vez', () => {
    expect(nextRowIndex(5, 0, 1)).toBe(1);
    expect(nextRowIndex(5, 4, -1)).toBe(3);
  });

  it('não dá a volta nas pontas — a seta volta a ser da página (e rola a lista)', () => {
    expect(nextRowIndex(5, 4, 1)).toBeUndefined();
    expect(nextRowIndex(5, 0, -1)).toBeUndefined();
  });

  it('foco fora das linhas (o "⋯", um item de menu) não é sequestrado', () => {
    expect(nextRowIndex(5, -1, 1)).toBeUndefined();
    expect(nextRowIndex(5, -1, -1)).toBeUndefined();
  });

  it('sidebar vazia não move nada', () => {
    expect(nextRowIndex(0, -1, 1)).toBeUndefined();
    expect(nextRowIndex(0, 0, 1)).toBeUndefined();
  });

  it('índice fora da lista (linha que sumiu no meio da navegação) não move', () => {
    expect(nextRowIndex(3, 7, -1)).toBeUndefined();
  });
});

// ------------------------------- dor #1: limite do servidor e fila

/**
 * O selo do limite do SERVIDOR. Ele existe porque o anel laranja sozinho não
 * diz de qual limite se trata — e confundir o limite do servidor com o de uso
 * é exatamente a dor que este lote foi atender.
 */
describe('serverLimitBadge', () => {
  it('sessão fora do estado não tem selo', () => {
    expect(serverLimitBadge(session('s1', { state: 'running' }), PT)).toBeUndefined();
  });

  it('leva a frase lida do terminal no tooltip, junto do "não é o seu limite de uso"', () => {
    const badge = serverLimitBadge(
      session('s1', {
        state: 'server-limited',
        serverLimit: { since: 1, pattern: 'limiting-requests', phrase: 'server is temporarily limiting requests' },
      }),PT,
    );
    expect(badge?.text).toBe('⏳ servidor');
    expect(badge?.title).toContain(serverLimitNote(PT));
    expect(badge?.title).toContain('server is temporarily limiting requests');
  });

  it('sem a prova (core velho), o selo ainda diz que não é o limite de uso', () => {
    const badge = serverLimitBadge(session('s1', { state: 'server-limited' }), PT);
    expect(badge?.title).toBe(serverLimitNote(PT));
  });
});

describe('agregação com `server-limited`', () => {
  it('vence `done` e `running` — a sessão parou e a pessoa pode querer agir', () => {
    expect(aggregateState([session('a', { state: 'done' }), session('b', { state: 'server-limited' })])).toBe(
      'server-limited',
    );
  });

  it('NÃO encobre um `needs-input` de outra sessão do mesmo workspace', () => {
    expect(
      aggregateState([session('a', { state: 'server-limited' }), session('b', { state: 'needs-input' })]),
    ).toBe('needs-input');
  });
});

describe('launcherQueueLine', () => {
  function status(extra: Partial<LauncherStatus> = {}): LauncherStatus {
    return {
      enabled: true,
      maxConcurrent: 4,
      active: 4,
      serverLimited: 0,
      spacingMs: 600,
      pending: [],
      ...extra,
    };
  }
  const pending = (n: number): LauncherStatus['pending'] =>
    Array.from({ length: n }, (_, i) => ({
      id: `lnch_${i}`,
      paneId: `pane_${i}`,
      workspaceId: 'ws',
      agent: 'claude' as const,
      requestedAt: 0,
      position: i + 1,
    }));

  it('sem fila (ou sem core que responda a rota) não desenha nada', () => {
    expect(launcherQueueLine(undefined, PT)).toBeUndefined();
    expect(launcherQueueLine(status(), PT)).toBeUndefined();
  });

  it('conta no singular e no plural', () => {
    expect(launcherQueueLine(status({ pending: pending(1) }), PT)?.text).toBe('1 sessão aguardando slot');
    expect(launcherQueueLine(status({ pending: pending(2) }), PT)?.text).toBe('2 sessões aguardando slot');
  });

  it('o tooltip diz quantos agentes estão de pé e se o servidor está estrangulando', () => {
    const semLimite = launcherQueueLine(status({ pending: pending(2) }), PT)?.title;
    expect(semLimite).toContain('4 de 4 agentes de pé');
    expect(semLimite).not.toContain('limite do servidor');

    const comLimite = launcherQueueLine(status({ pending: pending(2), serverLimited: 1 }), PT)?.title;
    expect(comLimite).toContain('1 sessão no limite do servidor');
  });

  /**
   * O `lastError` da fila: um pendente que morreu no caminho (painel fechado,
   * `claude` fora do PATH). O 202 já foi respondido lá atrás, então não há
   * requisição pra onde devolver o erro — ou ele aparece na sidebar, ou some.
   *
   * Com gente na fila o recado vai no TOOLTIP da linha (ela já está lá); com a
   * fila vazia a linha some, e quem carrega o recado é a FAIXA.
   */
  const erro = { at: 1_000_000, paneId: 'pane_7', message: 'claude não encontrado no PATH' };

  it('com fila, o erro entra no tooltip — e some quando não há erro', () => {
    const comErro = launcherQueueLine(status({ pending: pending(2), lastError: erro }), PT)?.title;
    expect(comErro).toContain('o último lançamento falhou: claude não encontrado no PATH');
    // O tooltip continua dizendo o resto: o erro é acréscimo, não substituição.
    expect(comErro).toContain('4 de 4 agentes de pé');

    expect(launcherQueueLine(status({ pending: pending(2) }), PT)?.title).not.toContain('lançamento falhou');
  });

  it('com fila, a FAIXA não aparece — o tooltip já cobre', () => {
    expect(launcherErrorLine(status({ pending: pending(2), lastError: erro }), erro.at + 1000, PT)).toBeUndefined();
  });

  it('fila vazia e erro fresco: a faixa aparece com o motivo', () => {
    const linha = launcherErrorLine(status({ lastError: erro }), erro.at + 1000, PT);
    expect(linha).toBe(launchErrorText(erro, PT));
    expect(linha).toContain('claude não encontrado no PATH');
  });

  it('erro mais velho que o teto de idade não vira faixa nenhuma', () => {
    // Na borda ainda vale; um milissegundo depois, não — um recado de meia hora
    // atrás descreve um painel que a pessoa já resolveu.
    expect(launcherErrorLine(status({ lastError: erro }), erro.at + LAUNCH_ERROR_MAX_AGE_MS, PT)).toBe(
      launchErrorText(erro, PT),
    );
    expect(launcherErrorLine(status({ lastError: erro }), erro.at + LAUNCH_ERROR_MAX_AGE_MS + 1, PT)).toBeUndefined();
    expect(LAUNCH_ERROR_MAX_AGE_MS).toBe(5 * MIN);
  });

  it('sem erro nenhum (e sem status) não há faixa', () => {
    expect(launcherErrorLine(status(), Date.now(), PT)).toBeUndefined();
    expect(launcherErrorLine(undefined, Date.now(), PT)).toBeUndefined();
  });

  it('a mensagem do erro é truncada — ela vem do processo que falhou', () => {
    const longo = { ...erro, message: 'x'.repeat(400) };
    const texto = launchErrorText(longo, PT);
    // 120 é o teto do `launchErrorText`; o prefixo em pt-BR fica de fora dele.
    expect(texto.length).toBeLessThan(400);
    expect(texto).toContain('o último lançamento falhou:');
  });

  it('a mensagem é SANITIZADA, não só truncada — ela é eco de erro da API', () => {
    // Um lançamento que falha ecoa a mensagem do processo (o `spawn` que não
    // subiu, o `claude` que reclamou). Sequência de terminal e quebra de linha
    // saem antes de o texto virar tooltip ou faixa de uma linha só.
    const hostil = { ...erro, message: 'falhou\u001b]0;titulo\u0007\nsegunda linha' };
    const texto = launchErrorText(hostil, PT);
    expect(isDisplaySafe(texto)).toBe(true);
    expect(texto).not.toContain('\u001b');
    expect(texto).not.toContain('\n');
  });
});
