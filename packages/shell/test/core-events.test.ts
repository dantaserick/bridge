import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import type { BridgeEvent, HelloState } from '@bridge/shared';
import { CoreEventsClient } from '../src/coreEvents.js';
import { defaultCoreArgs, startCore, stopCore } from '../src/sidecar.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function tmp(prefix: string): string {
  return tmpDir(prefix);
}

function helloState(over: Partial<HelloState> = {}): HelloState {
  return {
    layout: { repos: [], workspaces: [], tabs: [], panes: [], layouts: {} },
    sessions: [],
    unread: [],
    ...over,
  };
}

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = (): void => {
      if (check()) {
        res();
        return;
      }
      if (Date.now() > deadline) {
        rej(new Error('waitFor: prazo esgotado'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('CoreEventsClient contra um servidor ws local', () => {
  let servers: WebSocketServer[] = [];
  let httpServers: ReturnType<typeof createServer>[] = [];
  let clients: CoreEventsClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients = [];
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((res) => {
            s.close(() => res());
            for (const ws of s.clients) ws.terminate();
          }),
      ),
    );
    servers = [];
    await Promise.all(httpServers.map((s) => new Promise<void>((res) => s.close(() => res()))));
    httpServers = [];
  });

  it('conecta, recebe o hello e o mapa de nomes de workspace', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', state: helloState({ layout: { repos: [], workspaces: [{ id: 'ws-1', name: 'meu-projeto', cwd: 'C:\\x', createdAt: 0 }], tabs: [], panes: [], layouts: {} } }) }));
    });
    await new Promise((res) => server.once('listening', res));
    const port = (server.address() as AddressInfo).port;

    const hellos: HelloState[] = [];
    const client = new CoreEventsClient({ onHello: (s) => hellos.push(s) });
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => hellos.length === 1);
    expect(client.getWorkspaceName('ws-1')).toBe('meu-projeto');
    expect(client.getWorkspaceName('ws-desconhecido')).toBeUndefined();
  });

  it('repassa BridgeEvent pro onEvent', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', state: helloState() }));
      ws.send(
        JSON.stringify({
          type: 'notification.new',
          notification: { id: 'ntf-1', sessionId: 'ses-1', workspaceId: 'ws-1', kind: 'custom', text: 'oi', at: 0 },
          toast: true,
        }),
      );
    });
    await new Promise((res) => server.once('listening', res));
    const port = (server.address() as AddressInfo).port;

    const events: BridgeEvent[] = [];
    const client = new CoreEventsClient({ onEvent: (e) => events.push(e) });
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({
      type: 'notification.new',
      notification: { id: 'ntf-1', sessionId: 'ses-1', workspaceId: 'ws-1', kind: 'custom', text: 'oi', at: 0 },
      toast: true,
    });
  });

  /**
   * F1 — o main não desenha terminal nenhum: pedir `pty.*` seria trabalho
   * síncrono por chunk de PTY num processo que só decide toast e badge.
   */
  it('assina só notification/session/layout (R7) e ignora pty.* que chegue mesmo assim', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    let query: URLSearchParams | undefined;
    server.on('connection', (ws, req) => {
      query = new URL(req.url ?? '', 'http://x').searchParams;
      ws.send(JSON.stringify({ type: 'hello', state: helloState() }));
      // Servidor velho, sem o filtro do R7: manda pty.data assim mesmo.
      ws.send(JSON.stringify({ type: 'pty.data', sessionId: 'ses-1', data: 'saída gigante' }));
      ws.send(JSON.stringify({ type: 'pty.exit', sessionId: 'ses-1', exitCode: 0 }));
      ws.send(JSON.stringify({ type: 'layout.changed' }));
    });
    await new Promise((res) => server.once('listening', res));
    const port = (server.address() as AddressInfo).port;

    const events: BridgeEvent[] = [];
    const client = new CoreEventsClient({ onEvent: (e) => events.push(e) });
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => events.length > 0);
    // `config` entrou na Task 4 do lote de idioma (o menu da bandeja é
    // remontado no `config.changed`).
    expect(query?.get('events')).toBe('notification,session,layout,config');
    expect(query?.get('token')).toBe('tok');
    expect(events.map((e) => e.type)).toEqual(['layout.changed']);
  });

  /**
   * Um workspace pode nascer ou mudar de nome depois do `hello`: o
   * `layout.changed` refaz o mapa de nomes com UM `GET /api/state`.
   */
  it('refaz o mapa de nomes com o /api/state depois do layout.changed', async () => {
    const snapshot = helloState({
      layout: {
        repos: [],
        workspaces: [{ id: 'ws-1', name: 'renomeado', cwd: 'C:\\x', createdAt: 0 }],
        tabs: [
          { id: 't-2', workspaceId: 'ws-1', title: 'Terminal', kind: 'terminal', order: 1 },
        ],
        panes: [],
        layouts: {},
      },
    });
    let stateHits = 0;
    const http = createServer((req, res) => {
      if (req.url?.startsWith('/api/state')) {
        stateHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(snapshot));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((res) => http.listen(0, '127.0.0.1', () => res()));
    httpServers.push(http);
    const port = (http.address() as AddressInfo).port;

    const server = new WebSocketServer({ server: http });
    servers.push(server);
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', state: helloState() }));
      ws.send(JSON.stringify({ type: 'layout.changed' }));
    });

    const client = new CoreEventsClient({});
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => client.getWorkspaceName('ws-1') === 'renomeado');
    expect(stateHits).toBe(1);
  });

  /**
   * Higiene da Fase 3: `msg.type.startsWith(...)` num JSON sem `type` string
   * (ou com `type` numérico) lançava dentro do `onmessage` — só alcançável por
   * peer autenticado, mas o main do Electron não pode cair por isso.
   */
  it('mensagem sem `type` string é descartada sem lançar', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 42 }));
      ws.send(JSON.stringify({ semTipo: true }));
      ws.send(JSON.stringify(['array', 'solto']));
      ws.send(JSON.stringify(null));
      ws.send(JSON.stringify({ type: 'layout.changed' }));
    });
    await new Promise((res) => server.once('listening', res));
    const port = (server.address() as AddressInfo).port;

    const events: BridgeEvent[] = [];
    const client = new CoreEventsClient({ onEvent: (e) => events.push(e) });
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => events.length > 0);
    expect(events.map((e) => e.type)).toEqual(['layout.changed']);
  });

  it('reconnect() troca pra porta/token novos — é o gancho do restart do sidecar', async () => {
    const serverA = new WebSocketServer({ port: 0 });
    servers.push(serverA);
    let tokenSeenByA: string | undefined;
    serverA.on('connection', (ws, req) => {
      tokenSeenByA = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? undefined;
      ws.send(JSON.stringify({ type: 'hello', state: helloState() }));
    });
    await new Promise((res) => serverA.once('listening', res));
    const portA = (serverA.address() as AddressInfo).port;

    const serverB = new WebSocketServer({ port: 0 });
    servers.push(serverB);
    let tokenSeenByB: string | undefined;
    serverB.on('connection', (ws, req) => {
      tokenSeenByB = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? undefined;
      ws.send(JSON.stringify({ type: 'hello', state: helloState() }));
    });
    await new Promise((res) => serverB.once('listening', res));
    const portB = (serverB.address() as AddressInfo).port;

    const hellos: number[] = [];
    const client = new CoreEventsClient({ onHello: () => hellos.push(Date.now()) });
    clients.push(client);

    client.connect(portA, 'token-a');
    await waitFor(() => hellos.length === 1);
    expect(tokenSeenByA).toBe('token-a');

    client.reconnect(portB, 'token-b');
    await waitFor(() => hellos.length === 2);
    expect(tokenSeenByB).toBe('token-b');
    // Não fica falando com o servidor A depois do reconnect.
    await waitFor(() => serverA.clients.size === 0);
  });

  it('reconecta com backoff quando o servidor cai e sobe de novo na mesma porta', async () => {
    const server1 = new WebSocketServer({ port: 0 });
    servers.push(server1);
    server1.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', state: helloState() })));
    await new Promise((res) => server1.once('listening', res));
    const port = (server1.address() as AddressInfo).port;

    const hellos: number[] = [];
    const logs: string[] = [];
    const client = new CoreEventsClient({ onHello: () => hellos.push(Date.now()), log: (l) => logs.push(l) });
    clients.push(client);
    client.connect(port, 'tok');

    await waitFor(() => hellos.length === 1);

    // Derruba o servidor — o cliente tem que perceber e agendar reconexão.
    // `server.close()` só para de ACEITAR conexão nova; as já abertas ficam de
    // pé até serem fechadas de propósito.
    for (const ws of server1.clients) ws.terminate();
    await new Promise<void>((res) => server1.close(() => res()));
    servers = servers.filter((s) => s !== server1);

    await waitFor(() => logs.some((l) => l.includes('tentando de novo')));

    // Sobe um servidor novo NA MESMA porta antes do backoff (1 s) vencer.
    const server2 = new WebSocketServer({ port });
    servers.push(server2);
    server2.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', state: helloState() })));
    await new Promise((res) => server2.once('listening', res));

    await waitFor(() => hellos.length === 2, 8000);
  }, 15000);
});

describe('CoreEventsClient contra o core de verdade', () => {
  afterEach(async () => {
    await stopCore(2000);
  });

  it('recebe notification.new de uma sessão real via POST /sessions/:id/notify', async () => {
    const profileDir = tmp('bridge-core-events-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const { port, token } = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    const auth = { headers: { authorization: `Bearer ${token}` } };
    const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: REPO_ROOT, name: 'workspace-de-teste' }),
    });
    expect(wsRes.status).toBe(201);
    const { workspace, pane } = (await wsRes.json()) as { workspace: { id: string; name: string }; pane: { id: string } };

    const sesRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ paneId: pane.id, kind: 'shell' }),
    });
    expect(sesRes.status).toBe(201);
    const session = (await sesRes.json()) as { id: string };

    const hellos: HelloState[] = [];
    const events: BridgeEvent[] = [];
    const client = new CoreEventsClient({ onHello: (s) => hellos.push(s), onEvent: (e) => events.push(e) });
    client.connect(port, token);

    try {
      await waitFor(() => hellos.length === 1);
      expect(client.getWorkspaceName(workspace.id)).toBe('workspace-de-teste');

      const notifyRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/notify`, {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'oi' }),
      });
      expect(notifyRes.status).toBe(200);

      await waitFor(() => events.some((e) => e.type === 'notification.new'));
      const notif = events.find((e) => e.type === 'notification.new');
      expect(notif).toMatchObject({
        type: 'notification.new',
        notification: { sessionId: session.id, workspaceId: workspace.id, kind: 'custom', text: 'oi' },
      });
    } finally {
      client.close();
    }
  }, 30_000);
});
