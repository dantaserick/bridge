import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { eventAllowed, parseEventFilter } from '../src/api/ws.js';

function tmp(): string {
  return tmpDir('bridge-ws-filter-');
}

describe('parseEventFilter (R7)', () => {
  it('sem query nenhuma → undefined (tudo passa)', () => {
    expect(parseEventFilter('/ws')).toBeUndefined();
    expect(parseEventFilter('/ws?token=abc')).toBeUndefined();
  });

  it('lista separada por vírgula vira prefixos, sem espaço e sem vazio', () => {
    expect(parseEventFilter('/ws?token=t&events=notification,session , layout,,')).toEqual([
      'notification',
      'session',
      'layout',
    ]);
  });

  it('events vazio → undefined (não é "filtra tudo fora")', () => {
    expect(parseEventFilter('/ws?events=')).toBeUndefined();
    expect(parseEventFilter('/ws?events=,,')).toBeUndefined();
  });

  it('url quebrada não derruba: vira undefined', () => {
    expect(parseEventFilter('')).toBeUndefined();
  });
});

describe('eventAllowed (R7)', () => {
  it('sem filtro tudo passa', () => {
    expect(eventAllowed('pty.data', undefined)).toBe(true);
    expect(eventAllowed('notification.new', undefined)).toBe(true);
  });

  it('casa por prefixo do `type`', () => {
    const filter = ['notification', 'session', 'layout'];
    expect(eventAllowed('notification.new', filter)).toBe(true);
    expect(eventAllowed('session.state', filter)).toBe(true);
    expect(eventAllowed('layout.changed', filter)).toBe(true);
    expect(eventAllowed('pty.data', filter)).toBe(false);
    expect(eventAllowed('pty.exit', filter)).toBe(false);
  });

  it('prefixo exato também casa (sem ponto)', () => {
    expect(eventAllowed('layout.changed', ['layout.changed'])).toBe(true);
    expect(eventAllowed('layout', ['layout'])).toBe(true);
  });
});

describe('/ws?events= contra o core de verdade', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /** Conecta, coleta as mensagens por `timeoutMs` e devolve os `type` na ordem. */
  async function collect(url: string, act: () => void, timeoutMs = 700): Promise<string[]> {
    const socket = new WebSocket(url);
    const types: string[] = [];
    // O listener entra ANTES do await: o `hello` sai no `connection` do
    // servidor e chegaria antes de um handler registrado depois do `open`.
    socket.on('message', (raw: Buffer) => {
      types.push((JSON.parse(raw.toString('utf8')) as { type: string }).type);
    });
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    act();
    await new Promise((res) => setTimeout(res, timeoutMs));
    socket.close();
    return types;
  }

  /**
   * R5 — quem paga o `git` do poller e o cliente que RECEBE `workspace.git`.
   * O processo main do Electron conecta com `events=notification,session,...`,
   * que corta esse prefixo: ele nao pode autorizar leitura de git nenhuma.
   */
  it('gitClients conta so quem recebe workspace.git (o filtro do main fica de fora)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { port, token } = await c.start();
    const base = `ws://127.0.0.1:${port}/ws?token=${token}`;

    const open = async (url: string): Promise<WebSocket> => {
      const socket = new WebSocket(url);
      await new Promise<void>((res, rej) => {
        socket.once('open', () => res());
        socket.once('error', rej);
      });
      return socket;
    };
    const espera = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !check(); i += 1) await new Promise((res) => setTimeout(res, 20));
    };

    const main = await open(`${base}&events=notification,session,layout`);
    await espera(() => c.deps.wsClients.count === 1);
    expect(c.deps.wsClients.count).toBe(1);
    expect(c.deps.wsClients.gitClients).toBe(0);

    const ui = await open(base);
    await espera(() => c.deps.wsClients.gitClients === 1);
    expect(c.deps.wsClients.count).toBe(2);
    expect(c.deps.wsClients.gitClients).toBe(1);

    ui.close();
    await espera(() => c.deps.wsClients.gitClients === 0);
    expect(c.deps.wsClients.gitClients).toBe(0);
    expect(c.deps.wsClients.count).toBe(1);

    main.close();
    await espera(() => c.deps.wsClients.count === 0);
    expect(c.deps.wsClients.count).toBe(0);
  }, 30_000);

  it('com filtro, `hello` sempre chega e `pty.*` é cortado; sem filtro, tudo chega', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { port, token } = await core.start();
    const base = `ws://127.0.0.1:${port}/ws?token=${token}`;
    const bus = core.deps.bus;

    const emit = (): void => {
      bus.emit({ type: 'pty.data', sessionId: 'ses-1', data: 'oi' });
      bus.emit({ type: 'layout.changed' });
    };

    const filtered = await collect(`${base}&events=notification,session,layout`, emit);
    expect(filtered[0]).toBe('hello');
    expect(filtered).toContain('layout.changed');
    expect(filtered).not.toContain('pty.data');

    const unfiltered = await collect(base, emit);
    expect(unfiltered[0]).toBe('hello');
    expect(unfiltered).toContain('layout.changed');
    expect(unfiltered).toContain('pty.data');
  }, 30_000);
});
