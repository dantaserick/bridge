import { describe, expect, it } from 'vitest';
import type { BridgeEvent } from '../src/events.js';
import { EventBus } from '../src/events.js';
import { Sessions } from '../src/sessions.js';
import { MAX_CONSECUTIVE_BLOCKED_STOPS } from '../src/model.js';

function setup() {
  const bus = new EventBus();
  const events: BridgeEvent[] = [];
  bus.on((e) => events.push(e));
  const sessions = new Sessions(bus);
  return { bus, events, sessions };
}

describe('apply — subagentes', () => {
  it('grava a contagem e a espera, e emite session.state; sem mudança não emite', () => {
    const { events, sessions } = setup();
    const s = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const before = events.filter((e) => e.type === 'session.state').length;
    const a = sessions.apply(s.id, { state: 'running', subagents: 1 });
    expect(a?.subagents).toBe(1);
    const b = sessions.apply(s.id, { subagents: 1 });
    expect(b).toBe(a);
    const c = sessions.apply(s.id, { awaitingSubagents: true });
    expect(c?.awaitingSubagents).toBe(true);
    // `??`, não `||`: zero e false APLICAM.
    const d = sessions.apply(s.id, { subagents: 0, awaitingSubagents: false });
    expect(d?.subagents).toBe(0);
    expect(d?.awaitingSubagents).toBe(false);
    expect(events.filter((e) => e.type === 'session.state').length - before).toBe(3);
  });
});

describe('Sessions', () => {
  it('create emite session.created com state idle', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    expect(session.state).toBe('idle');
    expect(session.startedAt).toBe(session.stateSince);
    expect(session.consecutiveBlockedStops).toBe(0);
    expect(events).toEqual([{ type: 'session.created', session }]);
  });

  it('get/list/byPane acham a sessão', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'shell', cwd: 'C:\\projetos\\x' });
    expect(sessions.get(session.id)).toEqual(session);
    expect(sessions.list()).toEqual([session]);
    expect(sessions.byPane('pane_1')).toEqual(session);
    expect(sessions.byPane('nope')).toBeUndefined();
  });

  it('apply com state muda stateSince e emite session.state', async () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const before = session.stateSince;
    await new Promise((r) => setTimeout(r, 5));
    const updated = sessions.apply(session.id, { state: 'running', detail: 'pensando…' });
    expect(updated?.state).toBe('running');
    expect(updated?.detail).toBe('pensando…');
    expect(updated?.stateSince).toBeGreaterThan(before);
    expect(events.at(-1)).toEqual({
      type: 'session.state',
      id: session.id,
      state: 'running',
      detail: 'pensando…',
      tool: undefined,
      stateSince: updated?.stateSince,
    });
  });

  it('apply sem state não muda stateSince', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const before = session.stateSince;
    const updated = sessions.apply(session.id, { detail: 'x' });
    expect(updated?.stateSince).toBe(before);
    expect(updated?.detail).toBe('x');
  });

  it('apply sem mudança real não emite', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    events.length = 0;
    const updated = sessions.apply(session.id, { state: 'idle' });
    expect(updated).toEqual(session);
    expect(events).toEqual([]);
  });

  it('apply com null limpa detail/tool', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    sessions.apply(session.id, { detail: 'algo', tool: 'Bash' });
    const cleared = sessions.apply(session.id, { detail: null, tool: null });
    expect(cleared?.detail).toBeUndefined();
    expect(cleared?.tool).toBeUndefined();
  });

  it('apply em sessão inexistente devolve undefined e não emite', () => {
    const { events, sessions } = setup();
    const result = sessions.apply('nope', { state: 'running' });
    expect(result).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('setQuota emite session.quota', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const quota = { model: 'claude', contextTokens: 100, rateLimits: [], line: 'ok', at: 1 };
    sessions.setQuota(session.id, quota);
    expect(sessions.get(session.id)?.quota).toEqual(quota);
    expect(events.at(-1)).toEqual({ type: 'session.quota', id: session.id, quota });
  });

  it('noteNotification só grava lastNotification, sem evento próprio', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    events.length = 0;
    const notif = { kind: 'done' as const, text: 'terminou', at: 123 };
    sessions.noteNotification(session.id, notif);
    expect(sessions.get(session.id)?.lastNotification).toEqual(notif);
    expect(events).toEqual([]);
  });

  it('focus: done vira idle; outros estados não mudam', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    sessions.apply(session.id, { state: 'done' });
    sessions.focus(session.id);
    expect(sessions.get(session.id)?.state).toBe('idle');

    sessions.apply(session.id, { state: 'needs-input' });
    sessions.focus(session.id);
    expect(sessions.get(session.id)?.state).toBe('needs-input');
  });

  it('exited emite session.exited e state exited', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'shell', cwd: 'C:\\projetos\\x' });
    sessions.exited(session.id, 0);
    expect(sessions.get(session.id)?.state).toBe('exited');
    expect(sessions.get(session.id)?.exitCode).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'session.exited', id: session.id, exitCode: 0 });
  });

  it('remove emite session.removed', () => {
    const { events, sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'shell', cwd: 'C:\\projetos\\x' });
    sessions.remove(session.id);
    expect(sessions.get(session.id)).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'session.removed', id: session.id });
  });

  it('blockedStop devolve false 4 vezes e true na 5ª, depois zera', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    expect(MAX_CONSECUTIVE_BLOCKED_STOPS).toBe(5);
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(sessions.blockedStop(session.id));
    expect(results).toEqual([false, false, false, false, true]);
    expect(sessions.get(session.id)?.consecutiveBlockedStops).toBe(0);
  });

  it('setAgentSessionId grava só em sessão de agente e só quando o id muda', () => {
    const { sessions, events } = setup();
    const agent = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const shell = sessions.create({ paneId: 'pane_2', workspaceId: 'ws_1', kind: 'shell', cwd: 'C:\\projetos\\x' });
    const antes = events.length;

    expect(sessions.setAgentSessionId(agent.id, 'uuid-1')).toBe(true);
    expect(sessions.get(agent.id)?.agentSessionId).toBe('uuid-1');
    // Todo hook do Claude traz o mesmo id: o segundo não é novidade nenhuma.
    expect(sessions.setAgentSessionId(agent.id, 'uuid-1')).toBe(false);
    expect(sessions.setAgentSessionId(agent.id, 'uuid-2')).toBe(true);
    expect(sessions.get(agent.id)?.agentSessionId).toBe('uuid-2');

    expect(sessions.setAgentSessionId(shell.id, 'uuid-1')).toBe(false);
    expect(sessions.get(shell.id)?.agentSessionId).toBeUndefined();
    expect(sessions.setAgentSessionId('sess_inexistente', 'uuid-1')).toBe(false);

    // Quem emite o evento é o core (um `layout.changed`), não o Sessions.
    expect(events.length).toBe(antes);
  });

  it('resetBlockedStops zera', () => {
    const { sessions } = setup();
    const session = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    sessions.blockedStop(session.id);
    sessions.blockedStop(session.id);
    sessions.resetBlockedStops(session.id);
    expect(sessions.get(session.id)?.consecutiveBlockedStops).toBe(0);
  });
});

/**
 * Spec §5 — a sessão de shell que HOSPEDA um Claude Code aberto na mão. A marca
 * é do domínio (a UI desenha o anel a partir dela), mas o `kind` continua
 * `shell`: quem hospeda não vira sessão de agente, nem na restauração.
 */
describe('Sessions — hospedagem de agente numa sessão de shell', () => {
  function shell(sessions: Sessions, paneId = 'pane_1') {
    return sessions.create({ paneId, workspaceId: 'ws_1', kind: 'shell', cwd: 'C:\\projetos\\x' });
  }

  it('setHosted marca a sessão e devolve a versão atualizada', () => {
    const { sessions } = setup();
    const session = shell(sessions);
    const antes = Date.now();
    const updated = sessions.setHosted(session.id, 'claude');
    expect(updated?.hosted?.agent).toBe('claude');
    expect(updated?.hosted?.since).toBeGreaterThanOrEqual(antes);
    expect(updated?.kind).toBe('shell');
    expect(sessions.get(session.id)?.hosted).toEqual(updated?.hosted);
  });

  it('setHosted é idempotente: a segunda chamada não devolve nada e o `since` fica', async () => {
    const { sessions } = setup();
    const session = shell(sessions);
    const since = sessions.setHosted(session.id, 'claude')?.hosted?.since;
    await new Promise((r) => setTimeout(r, 5));
    expect(sessions.setHosted(session.id, 'claude')).toBeUndefined();
    expect(sessions.get(session.id)?.hosted?.since).toBe(since);
  });

  it('setHosted numa sessão que não existe devolve undefined', () => {
    const { sessions } = setup();
    expect(sessions.setHosted('sess_inexistente', 'claude')).toBeUndefined();
  });

  it('clearHosted tira a marca, volta pra idle e limpa detail/tool — sem tocar no agentSessionId', () => {
    const { sessions } = setup();
    const session = shell(sessions);
    sessions.setHosted(session.id, 'claude');
    sessions.setAgentSessionId(session.id, 'conv-1');
    sessions.apply(session.id, { state: 'running', detail: 'pensando…', tool: 'Read' });

    const updated = sessions.clearHosted(session.id);
    expect(updated?.hosted).toBeUndefined();
    expect(updated?.state).toBe('idle');
    expect(updated?.detail).toBeUndefined();
    expect(updated?.tool).toBeUndefined();
    expect(updated?.kind).toBe('shell');
    // A conversa continua guardada: o painel a mostra, e retomá-la é BACKLOG.
    expect(updated?.agentSessionId).toBe('conv-1');
    expect(sessions.get(session.id)?.hosted).toBeUndefined();
  });

  it('clearHosted em sessão sem hospedagem (ou inexistente) é no-op', () => {
    const { sessions } = setup();
    const session = shell(sessions);
    expect(sessions.clearHosted(session.id)).toBeUndefined();
    expect(sessions.clearHosted('sess_inexistente')).toBeUndefined();
    expect(sessions.get(session.id)?.state).toBe('idle');
  });

  it('setAgentSessionId passa a valer na sessão de shell HOSPEDADA', () => {
    const { sessions } = setup();
    const session = shell(sessions);
    expect(sessions.setAgentSessionId(session.id, 'conv-1')).toBe(false);
    sessions.setHosted(session.id, 'claude');
    expect(sessions.setAgentSessionId(session.id, 'conv-1')).toBe(true);
    expect(sessions.get(session.id)?.agentSessionId).toBe('conv-1');
  });

  it('liveAgentCount conta a hospedeira (é um Claude de verdade ocupando slot)', () => {
    const { sessions } = setup();
    const agente = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\x' });
    const hospedeira = shell(sessions, 'pane_2');
    const shellPuro = shell(sessions, 'pane_3');
    expect(sessions.liveAgentCount()).toBe(1);

    sessions.setHosted(hospedeira.id, 'claude');
    expect(sessions.liveAgentCount()).toBe(2);

    // Shell sem hospedagem nunca contou e continua não contando.
    expect(sessions.get(shellPuro.id)?.hosted).toBeUndefined();

    // Hospedeira encerrada não ocupa slot nenhum.
    sessions.exited(hospedeira.id, 0);
    expect(sessions.liveAgentCount()).toBe(1);

    sessions.clearHosted(agente.id);
    expect(sessions.liveAgentCount()).toBe(1);
  });
});
