/**
 * O socket da UI (`ws.ts`) — a parte que dá pra provar em nó: o `send` diz se
 * a mensagem SAIU, e o `onConnected` avisa a cada socket aberto, o primeiro
 * inclusive.
 *
 * Por que isso ganhou teste (fix round 1 de 11/09/2026): o `send` descarta
 * em silêncio o que é mandado com o handshake em voo, e a UI abre o WS DEPOIS
 * do `GET /api/state` — então o primeiro `resize` de um terminal que monta
 * cedo pode se perder. Quem chama precisa saber disso pra não guardar como
 * "o core já sabe" uma grade que nunca chegou lá (`Terminal.syncGrid`).
 *
 * O `WebSocket` e o `location` são trocados por dublês: `packages/ui` roda
 * `vitest` em ambiente `node`, e o que está sob teste é a regra, não o
 * protocolo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Os estados do `WebSocket` do browser, com os mesmos números. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket {
  static OPEN = OPEN;
  static instances: FakeSocket[] = [];
  readyState = CONNECTING;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.fire('close');
  }

  /** O que o browser faria: vira OPEN e avisa. */
  open(): void {
    this.readyState = OPEN;
    this.fire('open');
  }

  fire(type: string, ev: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
let savedWebSocket: unknown;
let savedLocation: unknown;
/** Importado DEPOIS dos dublês? Não: o módulo só toca os globais em `open()`. */
let bridgeWs: (typeof import('../src/ws.js'))['bridgeWs'];

beforeEach(async () => {
  savedWebSocket = globals.WebSocket;
  savedLocation = globals.location;
  FakeSocket.instances = [];
  globals.WebSocket = FakeSocket;
  globals.location = { protocol: 'http:', host: '127.0.0.1:4560' };
  vi.useFakeTimers();
  ({ bridgeWs } = await import('../src/ws.js'));
});

afterEach(() => {
  // O `bridgeWs` é um singleton de módulo: sem isto, o timer de reconexão de
  // um caso vazaria pro seguinte.
  bridgeWs.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  globals.WebSocket = savedWebSocket;
  globals.location = savedLocation;
});

function lastSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) throw new Error('nenhum socket foi criado');
  return socket;
}

describe('bridgeWs.send — diz se a mensagem saiu', () => {
  it('sem socket nenhum: não sai, e não lança', () => {
    expect(bridgeWs.send({ type: 'resize', sessionId: 's1', cols: 80, rows: 24 })).toBe(false);
  });

  it('com o handshake em voo: DESCARTA e devolve false', () => {
    bridgeWs.connect('t', () => undefined);
    const socket = lastSocket();
    expect(socket.readyState).toBe(CONNECTING);
    expect(bridgeWs.send({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })).toBe(false);
    // Nada de fila: a mensagem some mesmo.
    expect(socket.sent).toEqual([]);
  });

  it('com o socket aberto: manda o JSON e devolve true', () => {
    bridgeWs.connect('t', () => undefined);
    const socket = lastSocket();
    socket.open();
    expect(bridgeWs.send({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })]);
  });

  it('depois de o socket cair: volta a devolver false', () => {
    bridgeWs.connect('t', () => undefined);
    const socket = lastSocket();
    socket.open();
    expect(bridgeWs.send({ type: 'input', sessionId: 's1', data: 'oi' })).toBe(true);
    socket.readyState = CLOSED;
    expect(bridgeWs.send({ type: 'input', sessionId: 's1', data: 'de novo' })).toBe(false);
    expect(socket.sent).toHaveLength(1);
  });
});

describe('bridgeWs.onConnected — cada socket aberto, o primeiro inclusive', () => {
  it('avisa no PRIMEIRO open (é o que o onReconnected não faz)', () => {
    const abertos: number[] = [];
    const reconectados: number[] = [];
    bridgeWs.onConnected(() => abertos.push(1));
    bridgeWs.onReconnected(() => reconectados.push(1));
    bridgeWs.connect('t', () => undefined);
    expect(abertos).toHaveLength(0);
    lastSocket().open();
    expect(abertos).toHaveLength(1);
    expect(reconectados).toHaveLength(0);
  });

  /**
   * O caso que o `Terminal` conserta: mandou cedo (descartado), o socket
   * abriu, e o aviso é a deixa pra mandar de novo — aí sai.
   */
  it('é a deixa pra remandar o que foi descartado no handshake', () => {
    const pendente = { type: 'resize', sessionId: 's1', cols: 200, rows: 50 } as const;
    let enviado = false;
    bridgeWs.onConnected(() => {
      if (!enviado) enviado = bridgeWs.send(pendente);
    });
    bridgeWs.connect('t', () => undefined);
    const socket = lastSocket();
    expect(bridgeWs.send(pendente)).toBe(false);
    socket.open();
    expect(enviado).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify(pendente)]);
  });

  it('avisa de novo na reconexão, e o cancelamento cala', () => {
    const abertos: number[] = [];
    const cancela = bridgeWs.onConnected(() => abertos.push(1));
    bridgeWs.connect('t', () => undefined);
    lastSocket().open();
    expect(abertos).toHaveLength(1);

    // Queda não pedida pelo usuário → reconexão agendada (1 s de backoff).
    lastSocket().close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    lastSocket().open();
    expect(abertos).toHaveLength(2);

    cancela();
    lastSocket().close();
    vi.advanceTimersByTime(1000);
    lastSocket().open();
    expect(abertos).toHaveLength(2);
  });
});
