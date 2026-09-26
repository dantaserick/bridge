import type { BridgeConfig } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { emptyUiState, reduce } from '../src/state.js';
import type { HelloState, Notification, Session, UiState } from '../src/state.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    kind: 'agent',
    agent: 'claude',
    state: 'idle',
    startedAt: 1000,
    stateSince: 1000,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\bridge',
    ...overrides,
  };
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    kind: 'done',
    text: 'Terminou',
    at: 1000,
    ...overrides,
  };
}

function emptyLayout(): HelloState['layout'] {
  return { repos: [], workspaces: [], tabs: [], panes: [], layouts: {} };
}

function initialState(): UiState {
  return emptyUiState();
}

describe('reduce — hello', () => {
  it('popula sessions, layout e unread a partir do hello', () => {
    const hello: HelloState = {
      layout: emptyLayout(),
      sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })],
      unread: [makeNotification({ id: 'notif-1' })],
    };
    const next = reduce(initialState(), { type: 'hello', state: hello });
    expect(Object.keys(next.sessions).sort()).toEqual(['sess-1', 'sess-2']);
    expect(next.sessions['sess-1']?.id).toBe('sess-1');
    expect(next.unread).toEqual(hello.unread);
    expect(next.layout).toBe(hello.layout);
  });

  it('mantém focusedSessionId se a sessão ainda existir', () => {
    const s = initialState();
    s.focusedSessionId = 'sess-2';
    const hello: HelloState = {
      layout: emptyLayout(),
      sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })],
      unread: [],
    };
    const next = reduce(s, { type: 'hello', state: hello });
    expect(next.focusedSessionId).toBe('sess-2');
  });

  it('escolhe a primeira sessão se a focada não existir mais', () => {
    const s = initialState();
    s.focusedSessionId = 'sess-gone';
    const hello: HelloState = {
      layout: emptyLayout(),
      sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })],
      unread: [],
    };
    const next = reduce(s, { type: 'hello', state: hello });
    expect(next.focusedSessionId).toBe('sess-1');
  });

  it('deixa focusedSessionId undefined se não há sessões', () => {
    const s = initialState();
    s.focusedSessionId = 'sess-gone';
    const hello: HelloState = { layout: emptyLayout(), sessions: [], unread: [] };
    const next = reduce(s, { type: 'hello', state: hello });
    expect(next.focusedSessionId).toBeUndefined();
  });
});

describe('reduce — event session.state', () => {
  it('atualiza só aquela sessão', () => {
    let s = initialState();
    s = reduce(s, {
      type: 'hello',
      state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })], unread: [] },
    });
    s = reduce(s, {
      type: 'event',
      event: { type: 'session.state', id: 'sess-1', state: 'running', detail: 'editando arquivo', tool: 'Edit', stateSince: 2000 },
    });
    expect(s.sessions['sess-1']).toMatchObject({ state: 'running', detail: 'editando arquivo', tool: 'Edit', stateSince: 2000 });
    expect(s.sessions['sess-2']?.state).toBe('idle');
  });

  it('ignora evento para sessão inexistente', () => {
    const s = reduce(initialState(), {
      type: 'event',
      event: { type: 'session.state', id: 'sess-x', state: 'running', stateSince: 2000 },
    });
    expect(s.sessions['sess-x']).toBeUndefined();
  });

  /**
   * Dor verificada #1 — a prova do limite do servidor viaja no `session.state`
   * e é SUBSTITUÍDA, nunca mesclada: o evento seguinte, sem `serverLimit`, é a
   * notícia de que a sessão saiu do estado.
   */
  it('carrega e depois APAGA o `serverLimit` junto com o estado', () => {
    let s = reduce(initialState(), {
      type: 'hello',
      state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] },
    });
    s = reduce(s, {
      type: 'event',
      event: {
        type: 'session.state',
        id: 'sess-1',
        state: 'server-limited',
        detail: 'limite do servidor',
        stateSince: 2000,
        serverLimit: { since: 2000, pattern: 'overloaded', phrase: 'overloaded_error' },
      },
    });
    expect(s.sessions['sess-1']?.state).toBe('server-limited');
    expect(s.sessions['sess-1']?.serverLimit?.pattern).toBe('overloaded');

    s = reduce(s, { type: 'event', event: { type: 'session.state', id: 'sess-1', state: 'running', stateSince: 3000 } });
    expect(s.sessions['sess-1']?.serverLimit).toBeUndefined();
  });
});

/**
 * 0.12.0 — o Claude Code aberto DENTRO de um shell. A marca `hosted` chega só
 * no `session.updated` (o objeto inteiro da sessão); o `session.state` que vem
 * logo atrás NÃO a carrega. Se este reducer trocasse a sessão em vez de
 * mesclar, o primeiro hook depois da promoção apagaria a marca e a linha
 * voltaria a dizer "shell" com o anel de agente aceso.
 */
describe('reduce — sessão de shell hospedando um Claude', () => {
  const shell = () => makeSession({ id: 'sess-1', kind: 'shell', agent: undefined });
  const hosted = { agent: 'claude' as const, since: 5000 };

  function withShell(): UiState {
    return reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [shell()], unread: [] } });
  }

  it('`session.updated` traz a marca da hospedagem', () => {
    const s = reduce(withShell(), {
      type: 'event',
      event: { type: 'session.updated', session: { ...shell(), hosted } },
    });
    expect(s.sessions['sess-1']?.hosted).toEqual(hosted);
    expect(s.sessions['sess-1']?.kind).toBe('shell');
  });

  it('o `session.state` seguinte MESCLA: a marca sobrevive ao primeiro hook', () => {
    let s = reduce(withShell(), { type: 'event', event: { type: 'session.updated', session: { ...shell(), hosted } } });
    s = reduce(s, {
      type: 'event',
      event: { type: 'session.state', id: 'sess-1', state: 'running', detail: 'pensando…', stateSince: 6000 },
    });
    expect(s.sessions['sess-1']?.hosted).toEqual(hosted);
    expect(s.sessions['sess-1']?.state).toBe('running');
    expect(s.sessions['sess-1']?.detail).toBe('pensando…');
  });

  it('`session.quota` e `session.exited` também preservam a marca', () => {
    let s = reduce(withShell(), { type: 'event', event: { type: 'session.updated', session: { ...shell(), hosted } } });
    s = reduce(s, {
      type: 'event',
      event: {
        type: 'session.quota',
        id: 'sess-1',
        quota: { model: 'claude', contextTokens: 10, rateLimits: [], line: 'ctx 10', at: 1 },
      },
    });
    s = reduce(s, { type: 'event', event: { type: 'session.exited', id: 'sess-1', exitCode: 0 } });
    expect(s.sessions['sess-1']?.hosted).toEqual(hosted);
  });

  it('o `session.updated` do fim tira a marca (o shell continua vivo)', () => {
    let s = reduce(withShell(), { type: 'event', event: { type: 'session.updated', session: { ...shell(), hosted } } });
    s = reduce(s, {
      type: 'event',
      event: { type: 'session.updated', session: { ...shell(), state: 'idle' } },
    });
    expect(s.sessions['sess-1']?.hosted).toBeUndefined();
    expect(s.sessions['sess-1']?.state).toBe('idle');
  });
});

describe('reduce — escalonador de lançamentos (dor #1)', () => {
  const status = {
    enabled: true,
    maxConcurrent: 4,
    active: 4,
    serverLimited: 1,
    spacingMs: 5000,
    pending: [
      { id: 'lnch_1', paneId: 'pane_1', workspaceId: 'ws', agent: 'claude' as const, requestedAt: 1, position: 1 },
    ],
  };

  it('nasce sem status: core velho (ou resposta em voo) não desenha fila nenhuma', () => {
    expect(initialState().launcher).toBeUndefined();
  });

  it('`setLauncher` guarda a resposta do GET /api/launcher', () => {
    expect(reduce(initialState(), { type: 'setLauncher', value: status }).launcher).toEqual(status);
  });

  it('`launcher.changed` SUBSTITUI o status inteiro', () => {
    let s = reduce(initialState(), { type: 'setLauncher', value: status });
    s = reduce(s, { type: 'event', event: { type: 'launcher.changed', status: { ...status, pending: [] } } });
    expect(s.launcher?.pending).toEqual([]);
  });
});

describe('reduce — session.created / exited / removed', () => {
  it('session.created adiciona a sessão', () => {
    const s = reduce(initialState(), { type: 'event', event: { type: 'session.created', session: makeSession({ id: 'sess-3' }) } });
    expect(s.sessions['sess-3']).toBeDefined();
  });

  it('session.created foca a sessão quando nada estava focado', () => {
    const s = reduce(initialState(), { type: 'event', event: { type: 'session.created', session: makeSession({ id: 'sess-3' }) } });
    expect(s.focusedSessionId).toBe('sess-3');
  });

  it('session.created não rouba o foco de uma sessão já focada', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    s = reduce(s, { type: 'focus', sessionId: 'sess-1' });
    s = reduce(s, { type: 'event', event: { type: 'session.created', session: makeSession({ id: 'sess-2' }) } });
    expect(s.focusedSessionId).toBe('sess-1');
  });

  it('session.exited marca state exited e exitCode', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    s = reduce(s, { type: 'event', event: { type: 'session.exited', id: 'sess-1', exitCode: 1 } });
    expect(s.sessions['sess-1']).toMatchObject({ state: 'exited', exitCode: 1 });
  });

  it('session.removed remove e limpa foco se era a sessão focada', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    s = reduce(s, { type: 'focus', sessionId: 'sess-1' });
    s = reduce(s, { type: 'event', event: { type: 'session.removed', id: 'sess-1' } });
    expect(s.sessions['sess-1']).toBeUndefined();
    expect(s.focusedSessionId).toBeUndefined();
  });

  it('session.removed não mexe no foco se era outra sessão', () => {
    let s = reduce(initialState(), {
      type: 'hello',
      state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })], unread: [] },
    });
    s = reduce(s, { type: 'focus', sessionId: 'sess-2' });
    s = reduce(s, { type: 'event', event: { type: 'session.removed', id: 'sess-1' } });
    expect(s.focusedSessionId).toBe('sess-2');
  });
});

describe('reduce — session.quota', () => {
  it('seta quota da sessão', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    const quota = { model: 'claude-opus', contextTokens: 1000, rateLimits: [], line: '5h: 40%', at: 3000 };
    s = reduce(s, { type: 'event', event: { type: 'session.quota', id: 'sess-1', quota } });
    expect(s.sessions['sess-1']?.quota).toEqual(quota);
  });
});

describe('reduce — notifications', () => {
  it('notification.new espelha lastNotification na sessão (o core não emite evento por isso)', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    s = reduce(s, {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', kind: 'stuck', text: 'Travou', at: 4000 }), toast: false },
    });
    expect(s.sessions['sess-1']?.lastNotification).toEqual({ kind: 'stuck', text: 'Travou', at: 4000 });
  });

  it('notification.new já lida ainda atualiza lastNotification, mas não entra em unread', () => {
    let s = reduce(initialState(), { type: 'hello', state: { layout: emptyLayout(), sessions: [makeSession({ id: 'sess-1' })], unread: [] } });
    s = reduce(s, {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', readAt: 5000, text: 'lida' }), toast: false },
    });
    expect(s.sessions['sess-1']?.lastNotification?.text).toBe('lida');
    expect(s.unread).toHaveLength(0);
  });

  it('notification.new de sessão desconhecida não quebra', () => {
    const s = reduce(initialState(), {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', sessionId: 'fantasma' }), toast: false },
    });
    expect(s.unread.map((n) => n.id)).toEqual(['notif-2']);
  });

  it('notification.new entra em unread (mais recente primeiro não é exigido aqui, só entra)', () => {
    const s = reduce(initialState(), {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2' }), toast: false },
    });
    expect(s.unread.map((n) => n.id)).toContain('notif-2');
  });

  it('notification.new pula se já tiver readAt', () => {
    const s = reduce(initialState(), {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', readAt: 5000 }), toast: false },
    });
    expect(s.unread.map((n) => n.id)).not.toContain('notif-2');
  });

  it('notification.new é idempotente por id — não duplica se o mesmo id já está em unread', () => {
    let s = reduce(initialState(), {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', at: 100 }), toast: false },
    });
    s = reduce(s, {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2', at: 200 }), toast: false },
    });
    expect(s.unread.filter((n) => n.id === 'notif-2')).toHaveLength(1);
  });

  it('notification.read tira da lista', () => {
    let s = reduce(initialState(), {
      type: 'event',
      event: { type: 'notification.new', notification: makeNotification({ id: 'notif-2' }), toast: false },
    });
    s = reduce(s, { type: 'event', event: { type: 'notification.read', ids: ['notif-2'] } });
    expect(s.unread.map((n) => n.id)).not.toContain('notif-2');
  });
});

describe('reduce — focus / connected / layout.changed', () => {
  it('focus troca focusedSessionId', () => {
    const s = reduce(initialState(), { type: 'focus', sessionId: 'sess-9' });
    expect(s.focusedSessionId).toBe('sess-9');
  });

  it('connected troca a flag connected', () => {
    const s = reduce(initialState(), { type: 'connected', value: true });
    expect(s.connected).toBe(true);
  });

  it('layout.changed não altera o estado (é só sinal pro App re-buscar /api/state)', () => {
    const s0 = initialState();
    const s = reduce(s0, { type: 'event', event: { type: 'layout.changed' } });
    expect(s).toBe(s0);
  });
});

// -------------------------------------------------- Task 5: config do core

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 4560,
    shell: 'pwsh',
    claudeHome: 'C:\perfil\.claude',
    usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false },
    sessions: { maxConcurrentAgents: 4, scheduleLaunches: true, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
    profileDir: 'C:\\perfil\\bridge',
    gitPollSeconds: 15,
    toast: { enabled: true, quietWhenFocused: true },
    terminal: { fontFamily: 'Consolas', fontSize: 12 },
    restore: { resumeAgents: true },
    // Idioma (spec §13): o helper fixa `pt-BR` pra que as asserções de texto
    // deste arquivo continuem valendo palavra por palavra.
    ui: { language: 'system' },
    languageResolved: 'pt-BR',
    ...overrides,
  };
}

describe('reduce — config', () => {
  /**
   * `undefined`, não um default gravado: quem lê (`resolveTerminalPrefs`,
   * `fieldValue`) já sabe cobrir a ausência, e um default no estado viraria
   * "a config diz 12" — piscando o terminal quando a config real chegasse
   * dizendo 16.
   */
  it('nasce sem config', () => {
    expect(initialState().config).toBeUndefined();
  });

  it('setConfig guarda a resposta do GET /api/config', () => {
    const s = reduce(initialState(), { type: 'setConfig', value: makeConfig() });
    expect(s.config?.terminal.fontSize).toBe(12);
    expect(s.config?.shell).toBe('pwsh');
  });

  it('config.changed substitui a config inteira', () => {
    let s = reduce(initialState(), { type: 'setConfig', value: makeConfig() });
    s = reduce(s, {
      type: 'event',
      event: { type: 'config.changed', config: makeConfig({ terminal: { fontFamily: 'Cascadia Mono', fontSize: 18 } }) },
    });
    expect(s.config?.terminal).toEqual({ fontFamily: 'Cascadia Mono', fontSize: 18 });
    // O evento traz o objeto inteiro (contrato da Task 5a): nada de mesclar
    // aqui — o que não veio no evento simplesmente não existe mais.
    expect(s.config?.gitPollSeconds).toBe(15);
  });

  it('config.changed não mexe em sessão, layout nem foco', () => {
    const before = reduce(initialState(), {
      type: 'hello',
      state: { layout: emptyLayout(), sessions: [makeSession()], unread: [] },
    });
    const after = reduce(before, { type: 'event', event: { type: 'config.changed', config: makeConfig() } });
    expect(after.sessions).toBe(before.sessions);
    expect(after.layout).toBe(before.layout);
    expect(after.focusedSessionId).toBe(before.focusedSessionId);
  });

  /** Um `hello` (snapshot de layout/sessões) não fala de config — e não pode zerá-la. */
  it('hello preserva a config já carregada', () => {
    const s0 = reduce(initialState(), { type: 'setConfig', value: makeConfig({ gitPollSeconds: 90 }) });
    const s = reduce(s0, { type: 'hello', state: { layout: emptyLayout(), sessions: [], unread: [] } });
    expect(s.config?.gitPollSeconds).toBe(90);
  });
});

// -------------------------------------------------------- uso (ADR-012)

describe('estado de uso', () => {
  const limits = [
    { window: 'five_hour', label: '5h', usedPct: 68, resetsAt: 1_900_000_000, seenAt: 1_757_100_000_000 },
    { window: 'seven_day', label: 'semana', usedPct: 41, seenAt: 1_757_100_000_000 },
  ];

  it('nasce sem limites e sem relatório', () => {
    const s = initialState();
    expect(s.usageLimits).toEqual([]);
    expect(s.usage).toBeUndefined();
  });

  it('a resposta de GET /api/usage/limits entra inteira', () => {
    const s = reduce(initialState(), { type: 'setUsageLimits', value: limits });
    expect(s.usageLimits).toEqual(limits);
  });

  /**
   * O evento manda a lista INTEIRA (não um delta) quando alguma janela mudou de
   * `usedPct` ou `resetsAt` — o core não emite por causa do `seenAt`, que muda
   * várias vezes por segundo enquanto o turno roda.
   */
  it('usage.changed com limites substitui a lista', () => {
    const s0 = reduce(initialState(), { type: 'setUsageLimits', value: limits });
    const s = reduce(s0, {
      type: 'event',
      event: { type: 'usage.changed', limits: [{ ...limits[0]!, usedPct: 91 }] },
    });
    expect(s.usageLimits).toHaveLength(1);
    expect(s.usageLimits[0]?.usedPct).toBe(91);
  });

  /**
   * Uma varredura que só tocou dias (`dailyTouched`) não fala das janelas: zerar
   * a lista aqui apagaria as barras da sidebar a cada passada do poller.
   */
  it('usage.changed só com dias tocados preserva os limites', () => {
    const s0 = reduce(initialState(), { type: 'setUsageLimits', value: limits });
    const s = reduce(s0, { type: 'event', event: { type: 'usage.changed', dailyTouched: ['2026-09-05'] } });
    expect(s.usageLimits).toEqual(limits);
  });

  it('lista vazia é resposta legítima (conta de chave de API)', () => {
    const s0 = reduce(initialState(), { type: 'setUsageLimits', value: limits });
    const s = reduce(s0, { type: 'setUsageLimits', value: [] });
    expect(s.usageLimits).toEqual([]);
  });

  /** Um `hello` é snapshot de layout e sessão: ele não fala de uso. */
  it('hello preserva os limites já carregados', () => {
    const s0 = reduce(initialState(), { type: 'setUsageLimits', value: limits });
    const s = reduce(s0, { type: 'hello', state: { layout: emptyLayout(), sessions: [], unread: [] } });
    expect(s.usageLimits).toEqual(limits);
  });

  it('fechar o painel limpa o relatório', () => {
    const s0 = reduce(initialState(), {
      type: 'setUsage',
      value: {
        range: 'month',
        from: '2026-09-01',
        to: '2026-09-30',
        chartFrom: '2026-08-07',
        chartTo: '2026-09-05',
        tz: 'America/Sao_Paulo',
        totals: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 0, messages: 0, cost: null, costPartial: false },
        bySource: {
          main: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 0, messages: 0, cost: null, costPartial: false },
          subagents: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 0, messages: 0, cost: null, costPartial: false },
        },
        byDay: [],
        byModel: [],
        byProject: [],
        limits: [],
        pricingWarnings: [],
        pricingAsOf: '2026-08-01',
        claudeHome: 'D:\fixture\claude',
        scannedFiles: 3,
        scanning: null,
      },
    });
    expect(s0.usage?.range).toBe('month');
    expect(reduce(s0, { type: 'setUsage', value: undefined }).usage).toBeUndefined();
  });

  /**
   * O progresso da varredura vive FORA de `usage`: ele vale mesmo com o painel
   * fechado (é o que o botão das Configurações mostra), e o painel fechado
   * limpa `usage`.
   */
  it('usage.changed guarda o scanning, e um evento sem ele não apaga o que havia', () => {
    const lendo = { active: true, filesDone: 3, filesTotal: 10, bytesDone: 30, bytesTotal: 100, skippedLines: 0 };
    const s1 = reduce(initialState(), { type: 'event', event: { type: 'usage.changed', scanning: lendo } });
    expect(s1.usageScanning).toEqual(lendo);

    // Evento só de limites: `scanning` ausente NÃO é "não há varredura".
    const s2 = reduce(s1, { type: 'event', event: { type: 'usage.changed', limits: [] } });
    expect(s2.usageScanning).toEqual(lendo);

    // O core dizendo explicitamente que acabou.
    const fim = { ...lendo, active: false, filesDone: 10, bytesDone: 100 };
    expect(reduce(s2, { type: 'event', event: { type: 'usage.changed', scanning: fim } }).usageScanning).toEqual(fim);
  });
});
