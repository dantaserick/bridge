import { describe, expect, it } from 'vitest';

/**
 * O idioma destes testes. É EXPLÍCITO em cada chamada desde a Task 4 do lote
 * de idioma: as asserções abaixo descrevem o pt-BR, e um default escondido
 * faria a suíte depender da máquina de quem a roda.
 */
const PT = 'pt-BR' as const;
import type { BridgeEvent, Notification } from '@bridge/shared';
import { TOAST_WINDOW_MS, coalesce, emptyToastQueue, shouldToast, trackToast, unreadAfter } from '../src/toast.js';
import type { ToastQueue } from '../src/toast.js';

function notification(over: Partial<Notification> = {}): Notification {
  return { id: 'ntf-1', sessionId: 'ses-1', workspaceId: 'ws-1', kind: 'custom', text: 'oi', at: 0, ...over };
}

function notifyEvent(over: Partial<Notification> = {}, toast = true): BridgeEvent {
  return { type: 'notification.new', notification: notification(over), toast };
}

describe('shouldToast', () => {
  it('true pra notification.new com toast:true', () => {
    expect(shouldToast(notifyEvent())).toBe(true);
  });

  it('false pra notification.new com toast:false (sessão focada, ou toast desligado)', () => {
    expect(shouldToast(notifyEvent({}, false))).toBe(false);
  });

  it('false pra qualquer outro tipo de evento', () => {
    expect(shouldToast({ type: 'session.state', id: 'ses-1', state: 'running', stateSince: 0 })).toBe(false);
    expect(shouldToast({ type: 'notification.read', ids: ['ntf-1'] })).toBe(false);
    expect(shouldToast({ type: 'layout.changed' })).toBe(false);
  });
});

function notify(queue: ToastQueue, over: Partial<{ sessionId: string; workspaceId: string; text: string }>, now: number) {
  return coalesce(
    queue,
    {
      type: 'notify',
      sessionId: 'ses-1',
      workspaceId: 'ws-1',
      kind: 'custom',
      title: 'Bridge · workspace',
      text: 'aviso',
      ...over,
    },
    now,
    PT,
  );
}

describe('coalesce', () => {
  it('a primeira notificação da sessão sai NA HORA e abre a janela de 2 s', () => {
    const result = notify(emptyToastQueue(), { text: 'primeiro aviso' }, 1000);

    expect(result.show).toEqual({
      sessionId: 'ses-1',
      workspaceId: 'ws-1',
      kind: 'custom',
      title: 'Bridge · workspace',
      body: 'primeiro aviso',
    });
    const pending = result.queue.get('ses-1');
    expect(pending).toBeDefined();
    expect(pending?.texts).toEqual([]); // nada represado ainda — só a líder, que já saiu.
    expect(pending?.dueAt).toBe(1000 + TOAST_WINDOW_MS);
  });

  it('flush sem nada represado (só a líder na janela) não mostra nada — ela já foi o toast', () => {
    const led = notify(emptyToastQueue(), { text: 'terminei' }, 0);
    expect(led.show).toBeDefined(); // a líder já saiu na hora

    const flushed = coalesce(led.queue, { type: 'flush', sessionId: 'ses-1' }, TOAST_WINDOW_MS, PT);
    expect(flushed.show).toBeUndefined();
    expect(flushed.queue.has('ses-1')).toBe(false);
  });

  it('3 notificações em 2 s: a primeira sai na hora, o flush junta as outras 2 num resumo (n=2)', () => {
    let queue: ToastQueue = emptyToastQueue();

    const first = notify(queue, { text: 'primeiro' }, 0);
    expect(first.show).toEqual({
      sessionId: 'ses-1',
      workspaceId: 'ws-1',
      kind: 'custom',
      title: 'Bridge · workspace',
      body: 'primeiro',
    });
    queue = first.queue;

    const second = notify(queue, { text: 'segundo' }, 500);
    expect(second.show).toBeUndefined(); // dentro da janela — só acumula
    queue = second.queue;

    const third = notify(queue, { text: 'terceiro' }, 1200);
    expect(third.show).toBeUndefined();
    queue = third.queue;

    // A janela não estica: continua vencendo em 2000, e só as DUAS represadas
    // (a líder não entra aqui, já saiu em t=0).
    expect(queue.get('ses-1')?.dueAt).toBe(TOAST_WINDOW_MS);
    expect(queue.get('ses-1')?.texts).toEqual(['segundo', 'terceiro']);

    const flushed = coalesce(queue, { type: 'flush', sessionId: 'ses-1' }, TOAST_WINDOW_MS, PT);
    expect(flushed.show).toEqual({
      sessionId: 'ses-1',
      workspaceId: 'ws-1',
      kind: 'custom',
      title: 'Bridge · workspace',
      body: '2 avisos · último: terceiro',
    });
    expect(flushed.queue.has('ses-1')).toBe(false);
  });

  it('uma em t0 e outra em t0+2.5s (fora da janela): as DUAS saem na hora', () => {
    let queue: ToastQueue = emptyToastQueue();

    const first = notify(queue, { text: 'primeiro' }, 0);
    expect(first.show?.body).toBe('primeiro');
    queue = first.queue;

    // Chega depois do dueAt (2000) — mesmo sem o `flush` ter rodado ainda no
    // teste, a janela já está vencida: conta como ciclo novo.
    const second = notify(queue, { text: 'segundo' }, 2500);
    expect(second.show).toEqual({
      sessionId: 'ses-1',
      workspaceId: 'ws-1',
      kind: 'custom',
      title: 'Bridge · workspace',
      body: 'segundo',
    });
    expect(second.queue.get('ses-1')?.dueAt).toBe(2500 + TOAST_WINDOW_MS);
    expect(second.queue.get('ses-1')?.texts).toEqual([]);
  });

  it('sessões diferentes nunca se misturam', () => {
    let queue: ToastQueue = emptyToastQueue();

    const a1 = notify(queue, { sessionId: 'ses-a', workspaceId: 'ws-1', text: 'a1' }, 0);
    expect(a1.show?.body).toBe('a1'); // líder de A sai na hora
    queue = a1.queue;

    const b1 = notify(queue, { sessionId: 'ses-b', workspaceId: 'ws-2', text: 'b1' }, 100);
    expect(b1.show?.body).toBe('b1'); // líder de B TAMBÉM sai na hora — sessão diferente
    queue = b1.queue;

    const a2 = notify(queue, { sessionId: 'ses-a', workspaceId: 'ws-1', text: 'a2' }, 200);
    expect(a2.show).toBeUndefined(); // dentro da janela de A — acumula
    queue = a2.queue;

    expect(queue.get('ses-a')?.texts).toEqual(['a2']);
    expect(queue.get('ses-b')?.texts).toEqual([]);

    const flushedA = coalesce(queue, { type: 'flush', sessionId: 'ses-a' }, TOAST_WINDOW_MS, PT);
    expect(flushedA.show?.body).toBe('1 avisos · último: a2');
    // ses-b continua com a janela dela aberta — o flush de A não mexe nela.
    expect(flushedA.queue.get('ses-b')?.texts).toEqual([]);
  });

  it('flush sem nenhuma janela aberta é no-op', () => {
    const result = coalesce(emptyToastQueue(), { type: 'flush', sessionId: 'ses-1' }, 1000, PT);
    expect(result.show).toBeUndefined();
    expect(result.queue.size).toBe(0);
  });

  it('flush repetido na mesma sessão só mostra uma vez', () => {
    let queue: ToastQueue = emptyToastQueue();
    queue = notify(queue, { text: 'primeiro' }, 0).queue;
    queue = notify(queue, { text: 'segundo' }, 500).queue; // represada, pra ter algo no flush

    const first = coalesce(queue, { type: 'flush', sessionId: 'ses-1' }, TOAST_WINDOW_MS, PT);
    expect(first.show).toBeDefined();
    const second = coalesce(first.queue, { type: 'flush', sessionId: 'ses-1' }, TOAST_WINDOW_MS, PT);
    expect(second.show).toBeUndefined();
  });

  it('nunca muta a fila recebida', () => {
    const before = emptyToastQueue();
    notify(before, {}, 0);
    expect(before.size).toBe(0);
  });
});

describe('trackToast', () => {
  it('adiciona ao set e devolve uma função que remove', () => {
    const live = new Set<{ id: number }>();
    const item = { id: 1 };
    const untrack = trackToast(live, item);
    expect(live.has(item)).toBe(true);
    untrack();
    expect(live.has(item)).toBe(false);
  });

  it('destravar duas vezes não quebra (idempotente)', () => {
    const live = new Set<string>();
    const untrack = trackToast(live, 'x');
    untrack();
    expect(() => untrack()).not.toThrow();
    expect(live.has('x')).toBe(false);
  });

  it('itens diferentes não interferem entre si', () => {
    const live = new Set<string>();
    const untrackA = trackToast(live, 'a');
    trackToast(live, 'b');
    untrackA();
    expect(live.has('a')).toBe(false);
    expect(live.has('b')).toBe(true);
  });
});

describe('unreadAfter', () => {
  it('soma 1 por notification.new', () => {
    let count = 0;
    count = unreadAfter(count, notifyEvent());
    expect(count).toBe(1);
    count = unreadAfter(count, notifyEvent({ id: 'ntf-2' }));
    expect(count).toBe(2);
  });

  it('subtrai o tamanho de ids por notification.read', () => {
    const count = unreadAfter(5, { type: 'notification.read', ids: ['a', 'b'] });
    expect(count).toBe(3);
  });

  it('notification.read com ids desconhecidos/repetidos não deixa a contagem negativa', () => {
    const count = unreadAfter(1, { type: 'notification.read', ids: ['a', 'b', 'c'] });
    expect(count).toBe(0);
  });

  it('notification.read com lista vazia não muda nada', () => {
    expect(unreadAfter(3, { type: 'notification.read', ids: [] })).toBe(3);
  });

  it('eventos irrelevantes não mexem na contagem', () => {
    expect(unreadAfter(4, { type: 'layout.changed' })).toBe(4);
    expect(unreadAfter(4, { type: 'session.state', id: 'ses-1', state: 'idle', stateSince: 0 })).toBe(4);
    expect(unreadAfter(4, { type: 'pty.data', sessionId: 'ses-1', data: 'x' })).toBe(4);
  });

  it('notification.new soma mesmo quando toast é false (é contagem de não lidas, não de toast)', () => {
    expect(unreadAfter(0, notifyEvent({}, false))).toBe(1);
  });

  it('notification.new com readAt já marcado não soma (espelha o reducer da UI)', () => {
    expect(unreadAfter(0, notifyEvent({ readAt: 123 }))).toBe(0);
    expect(unreadAfter(3, notifyEvent({ readAt: 123 }))).toBe(3);
  });
});
