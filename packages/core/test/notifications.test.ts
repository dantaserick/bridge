import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '../src/events.js';
import { EventBus } from '../src/events.js';
import { openDb } from '../src/db.js';
import type { Db } from '../src/db.js';
import { Sessions } from '../src/sessions.js';
import { NOTIFICATION_RATE_PER_SECOND, NOTIFICATION_TEXT_MAX, Notifications } from '../src/notifications.js';
import { DEFAULT_CONFIG } from '../src/profile.js';
import type { StoredConfig } from '../src/profile.js';

function setup(configOverrides: Partial<StoredConfig['toast']> = {}) {
  const bus = new EventBus();
  const events: BridgeEvent[] = [];
  bus.on((e) => events.push(e));
  const db: Db = openDb(':memory:');
  const sessions = new Sessions(bus);
  const config: StoredConfig = { ...DEFAULT_CONFIG, toast: { ...DEFAULT_CONFIG.toast, ...configOverrides } };
  const notifications = new Notifications(db, bus, sessions, config);
  const session = sessions.create({ paneId: 'p1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
  return { bus, events, db, sessions, notifications, session };
}

describe('Notifications', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push em sessão existente grava no db, atualiza sessions e emite notification.new com toast:true (janela sem foco)', () => {
    const { events, db, sessions, notifications, session } = setup();
    const n = notifications.push(session.id, 'done', 'terminou');
    expect(n).toBeDefined();
    expect(n?.sessionId).toBe(session.id);
    expect(n?.workspaceId).toBe(session.workspaceId);
    expect(n?.kind).toBe('done');
    expect(n?.text).toBe('terminou');

    expect(db.notifications.listUnread()).toEqual([n]);
    expect(sessions.get(session.id)?.lastNotification).toEqual({ kind: 'done', text: 'terminou', at: n?.at });
    expect(events.at(-1)).toEqual({ type: 'notification.new', notification: n, toast: true });
  });

  it('janela focada na mesma sessão → toast:false', () => {
    const { events, notifications, session } = setup();
    notifications.focused = { sessionId: session.id, windowFocused: true };
    notifications.push(session.id, 'done', 'terminou');
    expect((events.at(-1) as Extract<BridgeEvent, { type: 'notification.new' }>).toast).toBe(false);
  });

  it('janela focada em outra sessão → toast:true', () => {
    const { events, notifications, session } = setup();
    notifications.focused = { sessionId: 'sess_outra', windowFocused: true };
    notifications.push(session.id, 'done', 'terminou');
    expect((events.at(-1) as Extract<BridgeEvent, { type: 'notification.new' }>).toast).toBe(true);
  });

  it('janela focada mas em nenhuma sessão específica → toast:true', () => {
    const { events, notifications, session } = setup();
    notifications.focused = { windowFocused: true };
    notifications.push(session.id, 'done', 'terminou');
    expect((events.at(-1) as Extract<BridgeEvent, { type: 'notification.new' }>).toast).toBe(true);
  });

  it('config.toast.enabled=false → toast:false mesmo sem foco', () => {
    const { events, notifications, session } = setup({ enabled: false });
    notifications.push(session.id, 'done', 'terminou');
    expect((events.at(-1) as Extract<BridgeEvent, { type: 'notification.new' }>).toast).toBe(false);
  });

  it('config.toast.quietWhenFocused=false: mesmo com foco na sessão, toast:true', () => {
    const { events, notifications, session } = setup({ quietWhenFocused: false });
    notifications.focused = { sessionId: session.id, windowFocused: true };
    notifications.push(session.id, 'done', 'terminou');
    expect((events.at(-1) as Extract<BridgeEvent, { type: 'notification.new' }>).toast).toBe(true);
  });

  it('sessão desconhecida → undefined e nada emitido', () => {
    const { events, notifications } = setup();
    events.length = 0;
    const n = notifications.push('nao-existe', 'done', 'x');
    expect(n).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('markRead marca no db e emite notification.read; some de unread()', () => {
    const { events, notifications, session } = setup();
    const n1 = notifications.push(session.id, 'done', 'um')!;
    const n2 = notifications.push(session.id, 'stuck', 'dois')!;
    events.length = 0;

    notifications.markRead([n1.id]);
    expect(notifications.unread().map((n) => n.id)).toEqual([n2.id]);
    expect(events).toEqual([{ type: 'notification.read', ids: [n1.id] }]);
  });

  it('markRead com lista vazia não emite nada', () => {
    const { events, notifications } = setup();
    events.length = 0;
    notifications.markRead([]);
    expect(events).toEqual([]);
  });

  it('markReadForSession marca todas as não lidas daquela sessão, um único evento', () => {
    const { events, sessions, notifications, session } = setup();
    const otherSession = sessions.create({ paneId: 'p2', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\projetos\\x' });
    const n1 = notifications.push(session.id, 'done', 'um')!;
    const n2 = notifications.push(session.id, 'stuck', 'dois')!;
    const n3 = notifications.push(otherSession.id, 'done', 'tres')!;
    events.length = 0;

    notifications.markReadForSession(session.id);
    const unreadIds = notifications.unread().map((n) => n.id);
    expect(unreadIds).toEqual([n3.id]);
    expect(events.length).toBe(1);
    const ev = events[0] as Extract<BridgeEvent, { type: 'notification.read' }>;
    expect(ev.type).toBe('notification.read');
    expect(new Set(ev.ids)).toEqual(new Set([n1.id, n2.id]));
  });

  it('markReadForSession sem pendências não emite nada', () => {
    const { events, notifications, session } = setup();
    events.length = 0;
    notifications.markReadForSession(session.id);
    expect(events).toEqual([]);
  });

  it('latestUnread devolve a de maior `at`', () => {
    const { notifications, session } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const n1 = notifications.push(session.id, 'done', 'um')!;
    vi.setSystemTime(2000);
    const n2 = notifications.push(session.id, 'stuck', 'dois')!;
    vi.setSystemTime(1500);
    const n3 = notifications.push(session.id, 'custom', 'tres')!;
    expect(notifications.latestUnread()?.id).toBe(n2.id);
    expect([n1.at, n2.at, n3.at]).toEqual([1000, 2000, 1500]);
  });

  it('latestUnread com empate em `at` devolve a inserida por último', () => {
    const { notifications, session } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    notifications.push(session.id, 'done', 'um');
    const n2 = notifications.push(session.id, 'stuck', 'dois')!;
    expect(notifications.latestUnread()?.id).toBe(n2.id);
  });

  it('latestUnread sem nada não lido devolve undefined', () => {
    const { notifications } = setup();
    expect(notifications.latestUnread()).toBeUndefined();
  });
});

/**
 * BR-12 (onda de segurança): a tabela `notifications` nunca era podada e o
 * texto não tinha teto. Uma saída hostil no terminal (A2 — o único atacante
 * desta auditoria que NÃO precisa do token) imprimindo `\033]9;<4 KB>\007` em
 * laço fazia o `bridge.db` do perfil crescer sem limite, com um evento no bus
 * por iteração pra TODOS os clientes WS.
 */
describe('BR-12 — notificação em rajada não faz o banco crescer sem limite', () => {
  it('a taxa por sessão é limitada: 1 000 OSC em rajada geram no máximo o teto da janela', () => {
    const { db, notifications, session } = setup();

    for (let i = 0; i < 1000; i += 1) notifications.push(session.id, 'custom', `aviso ${i}`);

    const gravadas = db.notifications.listUnread().length;
    expect(gravadas).toBeLessThanOrEqual(NOTIFICATION_RATE_PER_SECOND);
    expect(gravadas).toBeGreaterThan(0);
  });

  it('texto acima do teto é truncado antes de ir pro banco', () => {
    const { db, notifications, session } = setup();

    const n = notifications.push(session.id, 'custom', 'x'.repeat(50_000));

    expect(n?.text.length).toBe(NOTIFICATION_TEXT_MAX);
    expect(n?.text.endsWith('…')).toBe(true);
    expect(db.notifications.listUnread()[0]?.text.length).toBe(NOTIFICATION_TEXT_MAX);
  });

  it('prune apaga as LIDAS fora das N mais recentes e nunca toca nas não lidas', () => {
    const db: Db = openDb(':memory:');
    for (let i = 0; i < 300; i += 1) {
      db.notifications.insert({
        id: `n_${i}`,
        sessionId: 's1',
        workspaceId: 'ws_1',
        kind: 'custom',
        text: `a ${i}`,
        at: 1000 + i,
      });
    }
    // As 250 mais antigas viram lidas; as 50 mais novas ficam não lidas.
    db.notifications.markRead(
      Array.from({ length: 250 }, (_, i) => `n_${i}`),
      2000,
    );

    const apagadas = db.notifications.prune(100);

    expect(apagadas).toBe(200);
    expect(db.notifications.list(1000)).toHaveLength(100);
    // Nenhuma não lida foi perdida.
    expect(db.notifications.listUnread()).toHaveLength(50);
  });
});
