import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';

function tmp(): string {
  return tmpDir('bridge-panes-');
}

const AUTH = { authorization: 'Bearer T' };

interface StateBody {
  layout: { panes: Array<{ id: string }>; tabs: Array<{ id: string }> };
  sessions: Array<{ id: string; paneId: string; state: string }>;
}

async function newWorkspacePane(core: Core): Promise<{ paneId: string }> {
  const cwd = tmp();
  const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
  const { pane } = ws.json() as { pane: { id: string } };
  return { paneId: pane.id };
}

async function createShell(core: Core, paneId: string): Promise<{ statusCode: number; body: { id?: string; error?: string } }> {
  const res = await core.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: AUTH,
    payload: { paneId, kind: 'shell' },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

function waitFor(check: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout esperando condição'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('cardinalidade painel ↔ sessão (R1) e limpeza de sessão fantasma', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('POST /api/sessions com cwd inexistente → 422 e nenhuma sessão nova em GET /api/state', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell', cwd: 'C:\\projetos\\bridge-pasta-que-nao-existe-xyz' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('pasta inexistente');

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect((state.json() as StateBody).sessions).toEqual([]);
  });

  it('POST /api/sessions em painel que já tem sessão viva → 409 "painel já tem uma sessão ativa"', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const first = await createShell(core, paneId);
    expect(first.statusCode).toBe(201);

    const second = await createShell(core, paneId);
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('painel já tem uma sessão ativa');

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect((state.json() as StateBody).sessions).toHaveLength(1);
  }, 20000);

  it('POST /api/sessions em painel cuja sessão está exited → 201, substituindo a antiga', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId } = await newWorkspacePane(c);

    const first = await createShell(c, paneId);
    expect(first.statusCode).toBe(201);
    const oldId = first.body.id!;

    // Mata só o PTY: a sessão fica no core em `exited` (o user ainda lê a saída).
    await c.deps.pty.kill(oldId);
    await waitFor(() => c.deps.sessions.get(oldId)?.state === 'exited');

    const second = await createShell(c, paneId);
    expect(second.statusCode).toBe(201);
    expect(second.body.id).not.toBe(oldId);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const sessions = (state.json() as StateBody).sessions;
    expect(sessions.map((s) => s.id)).toEqual([second.body.id]);
  }, 25000);

  it('pedido recusado (agente indisponível → 422) NÃO destrói a sessão exited do painel', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId } = await newWorkspacePane(c);

    const first = await createShell(c, paneId);
    const oldId = first.body.id!;
    await c.deps.pty.kill(oldId);
    await waitFor(() => c.deps.sessions.get(oldId)?.state === 'exited');
    const scrollbackBefore = c.deps.pty.scrollback(oldId);

    const rejected = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'codex' },
    });
    expect(rejected.statusCode).toBe(422);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const sessions = (state.json() as StateBody).sessions;
    expect(sessions.map((s) => s.id)).toEqual([oldId]);
    expect(sessions[0]!.state).toBe('exited');
    // A saída que o user ainda não leu continua servível.
    expect(c.deps.pty.scrollback(oldId)).toBe(scrollbackBefore);
  }, 25000);

  it('pedido com cwd inválido também não destrói a sessão exited do painel', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId } = await newWorkspacePane(c);

    const first = await createShell(c, paneId);
    const oldId = first.body.id!;
    await c.deps.pty.kill(oldId);
    await waitFor(() => c.deps.sessions.get(oldId)?.state === 'exited');

    const rejected = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell', cwd: 'C:\\projetos\\bridge-pasta-que-nao-existe-xyz' },
    });
    expect(rejected.statusCode).toBe(422);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect((state.json() as StateBody).sessions.map((s) => s.id)).toEqual([oldId]);
  }, 25000);

  it('DELETE /api/sessions/:id remove o painel quando a aba tem mais de um leaf', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const split = await core.app.inject({
      method: 'POST',
      url: `/api/panes/${paneId}/split`,
      headers: AUTH,
      payload: { dir: 'v' },
    });
    expect(split.statusCode).toBe(201);
    const newPaneId = (split.json() as { id: string }).id;

    const created = await createShell(core, newPaneId);
    expect(created.statusCode).toBe(201);

    const del = await core.app.inject({ method: 'DELETE', url: `/api/sessions/${created.body.id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const panes = (state.json() as StateBody).layout.panes.map((p) => p.id);
    expect(panes).toContain(paneId);
    expect(panes).not.toContain(newPaneId);
  }, 20000);

  it('DELETE /api/sessions/:id mantém o painel quando ele é o único leaf da aba', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const created = await createShell(core, paneId);
    expect(created.statusCode).toBe(201);

    const del = await core.app.inject({ method: 'DELETE', url: `/api/sessions/${created.body.id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as StateBody;
    expect(body.layout.panes.map((p) => p.id)).toContain(paneId);
    expect(body.sessions).toEqual([]);
  }, 20000);

  it('PTY que morre sozinho NÃO remove o painel (o user lê a saída)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId } = await newWorkspacePane(c);

    const split = await c.app.inject({
      method: 'POST',
      url: `/api/panes/${paneId}/split`,
      headers: AUTH,
      payload: { dir: 'v' },
    });
    const newPaneId = (split.json() as { id: string }).id;
    const created = await createShell(c, newPaneId);
    const sessionId = created.body.id!;

    await c.deps.pty.kill(sessionId);
    await waitFor(() => c.deps.sessions.get(sessionId)?.state === 'exited');

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect((state.json() as StateBody).layout.panes.map((p) => p.id)).toContain(newPaneId);
  }, 20000);

  it('POST /api/panes/:id/split com painel inexistente → 404 (PaneNotFoundError tipado)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/panes/pane_nao_existe/split',
      headers: AUTH,
      payload: { dir: 'v' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('painel não encontrado');
  });
});

describe('POST /api/panes/:id/split com adoptTabId ("dividir com uma aba já aberta")', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  async function twoTabs(c: Core): Promise<{ workspaceId: string; paneId: string; tabId: string; otherTabId: string; otherPaneId: string }> {
    const cwd = tmp();
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { workspace, tab, pane } = ws.json() as { workspace: { id: string }; tab: { id: string }; pane: { id: string } };
    const second = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/tabs`,
      headers: AUTH,
      payload: { kind: 'terminal' },
    });
    const other = second.json() as { tab: { id: string }; pane: { id: string } };
    return { workspaceId: workspace.id, paneId: pane.id, tabId: tab.id, otherTabId: other.tab.id, otherPaneId: other.pane.id };
  }

  it('200 com a aba alvo e a removida; a aba adotada some do estado e o painel dela vem junto', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const ids = await twoTabs(core);
    const res = await core.app.inject({
      method: 'POST',
      url: `/api/panes/${ids.paneId}/split`,
      headers: AUTH,
      payload: { dir: 'v', adoptTabId: ids.otherTabId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tabId: ids.tabId, removedTabId: ids.otherTabId });

    const state = (await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json() as {
      layout: { tabs: Array<{ id: string }>; panes: Array<{ id: string; tabId: string }> };
    };
    expect(state.layout.tabs.map((t) => t.id)).toEqual([ids.tabId]);
    expect(state.layout.panes.find((p) => p.id === ids.otherPaneId)?.tabId).toBe(ids.tabId);
  });

  it('a própria aba → 409 com code same-tab; aba inexistente → 404', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const ids = await twoTabs(core);
    const same = await core.app.inject({
      method: 'POST',
      url: `/api/panes/${ids.paneId}/split`,
      headers: AUTH,
      payload: { dir: 'v', adoptTabId: ids.tabId },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ code: 'same-tab' });
    expect(same.json().error).toContain('já é a deste painel');

    const missing = await core.app.inject({
      method: 'POST',
      url: `/api/panes/${ids.paneId}/split`,
      headers: AUTH,
      payload: { dir: 'h', adoptTabId: 'tab_nao_existe' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'tab-not-found' });
  });
});

describe('GET /api/panes/:id/neighbor e POST /api/panes/:id/ratio', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  async function split(c: Core, paneId: string, dir: 'v' | 'h'): Promise<string> {
    const res = await c.app.inject({ method: 'POST', url: `/api/panes/${paneId}/split`, headers: AUTH, payload: { dir } });
    return (res.json() as { id: string }).id;
  }

  async function neighbor(c: Core, paneId: string, dir: string): Promise<{ statusCode: number; body: { paneId?: string | null; error?: string } }> {
    const res = await c.app.inject({ method: 'GET', url: `/api/panes/${paneId}/neighbor?dir=${dir}`, headers: AUTH });
    return { statusCode: res.statusCode, body: res.json() };
  }

  it('split v: right de p1 é p2 e left de p2 é p1', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId: p1 } = await newWorkspacePane(core);
    const p2 = await split(core, p1, 'v');

    expect(await neighbor(core, p1, 'right')).toEqual({ statusCode: 200, body: { paneId: p2 } });
    expect(await neighbor(core, p2, 'left')).toEqual({ statusCode: 200, body: { paneId: p1 } });
  });

  it('split h aninhado: down de p2 é p3', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId: p1 } = await newWorkspacePane(core);
    // p1 vira split h(a: p1, b: p3); depois p1 vira split v(a: p1, b: p2).
    const p3 = await split(core, p1, 'h');
    const p2 = await split(core, p1, 'v');

    expect(await neighbor(core, p2, 'down')).toEqual({ statusCode: 200, body: { paneId: p3 } });
  });

  it('na borda devolve paneId null', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId: p1 } = await newWorkspacePane(core);
    await split(core, p1, 'v');

    expect(await neighbor(core, p1, 'left')).toEqual({ statusCode: 200, body: { paneId: null } });
    expect(await neighbor(core, p1, 'up')).toEqual({ statusCode: 200, body: { paneId: null } });
  });

  it('direção inválida → 400 e painel inexistente → 404', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const bad = await neighbor(core, paneId, 'diagonal');
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toContain('dir');

    const missingDir = await core.app.inject({ method: 'GET', url: `/api/panes/${paneId}/neighbor`, headers: AUTH });
    expect(missingDir.statusCode).toBe(400);

    const unknown = await neighbor(core, 'pane_nao_existe', 'right');
    expect(unknown.statusCode).toBe(404);
  });

  it('POST ratio devolve 204, grava o split pai e emite layout.changed', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId: p1 } = await newWorkspacePane(core);
    await split(core, p1, 'v');
    const seen: string[] = [];
    core.deps.bus.on((e) => seen.push(e.type));

    const res = await core.app.inject({ method: 'POST', url: `/api/panes/${p1}/ratio`, headers: AUTH, payload: { ratio: 0.3 } });

    expect(res.statusCode).toBe(204);
    expect(seen.filter((t) => t === 'layout.changed')).toHaveLength(1);
    const pane = core.deps.db.panes.get(p1)!;
    const root = core.deps.db.layouts.get(pane.tabId)!;
    expect(root.type === 'split' && root.ratio).toBe(0.3);
  });

  /**
   * R1 pela rota: `split_v { a: split_h{p1,p4}, b: p2 }`. Com `siblingPaneId`
   * o core resolve o divisor externo; sem ele, o pai imediato de p1 (interno).
   */
  it('POST ratio com siblingPaneId mexe no split EXTERNO; sem ele, no interno', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId: p1 } = await newWorkspacePane(c);
    const p2 = await split(c, p1, 'v');
    await split(c, p1, 'h');
    const tabId = c.deps.db.panes.get(p1)!.tabId;

    const comIrmao = await c.app.inject({
      method: 'POST',
      url: `/api/panes/${p1}/ratio`,
      headers: AUTH,
      payload: { ratio: 0.7, siblingPaneId: p2 },
    });
    expect(comIrmao.statusCode).toBe(204);
    const outer = c.deps.db.layouts.get(tabId)!;
    if (outer.type !== 'split' || outer.a.type !== 'split') throw new Error('esperava split aninhado');
    expect(outer.ratio).toBe(0.7);
    expect(outer.a.ratio).toBe(0.5);

    const semIrmao = await c.app.inject({
      method: 'POST',
      url: `/api/panes/${p1}/ratio`,
      headers: AUTH,
      payload: { ratio: 0.3 },
    });
    expect(semIrmao.statusCode).toBe(204);
    const after = c.deps.db.layouts.get(tabId)!;
    if (after.type !== 'split' || after.a.type !== 'split') throw new Error('esperava split aninhado');
    expect(after.ratio).toBe(0.7);
    expect(after.a.ratio).toBe(0.3);
  });

  it('ratio fora de 0.1–0.9 → 400; painel inexistente → 404', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const tooBig = await core.app.inject({ method: 'POST', url: `/api/panes/${paneId}/ratio`, headers: AUTH, payload: { ratio: 1.5 } });
    expect(tooBig.statusCode).toBe(400);

    const notNumber = await core.app.inject({ method: 'POST', url: `/api/panes/${paneId}/ratio`, headers: AUTH, payload: { ratio: 'meio' } });
    expect(notNumber.statusCode).toBe(400);

    const unknown = await core.app.inject({ method: 'POST', url: '/api/panes/pane_nao_existe/ratio', headers: AUTH, payload: { ratio: 0.5 } });
    expect(unknown.statusCode).toBe(404);
  });

  it('createSession marca o painel com o último tipo (shell) e o snapshot leva junto', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { paneId } = await newWorkspacePane(core);

    const created = await createShell(core, paneId);
    expect(created.statusCode).toBe(201);

    expect(core.deps.db.panes.get(paneId)).toMatchObject({ lastKind: 'shell' });
    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const pane = (state.json() as { layout: { panes: Array<{ id: string; lastKind?: string }> } }).layout.panes.find(
      (p) => p.id === paneId,
    );
    expect(pane?.lastKind).toBe('shell');
  }, 20000);
});

describe('DELETE /api/tabs/:id e /api/workspaces/:id matam as sessões vivas antes de remover o layout', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('aba com shell vivo → DELETE /api/tabs/:id → 204, sessão some do estado, PTY morre, aba some', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
    const { tab, pane } = ws.json() as { tab: { id: string }; pane: { id: string } };

    const created = await createShell(c, pane.id);
    expect(created.statusCode).toBe(201);
    const sessionId = created.body.id!;

    const seen: string[] = [];
    c.deps.bus.on((e) => seen.push(e.type));

    const del = await c.app.inject({ method: 'DELETE', url: `/api/tabs/${tab.id}`, headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect(c.deps.pty.alive(sessionId)).toBe(false);

    // Exatamente um layout.changed pra remoção inteira — sem side-effect extra
    // de remoção de sessão além do session.removed.
    expect(seen.filter((t) => t === 'layout.changed')).toHaveLength(1);
    expect(seen.filter((t) => t === 'session.removed')).toHaveLength(1);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as StateBody;
    expect(body.sessions).toEqual([]);
    expect(body.layout.tabs.map((t) => t.id)).not.toContain(tab.id);
  }, 20000);

  it('workspace com duas abas e sessões vivas em ambas → DELETE /api/workspaces/:id → 204, tudo morto', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
    const { workspace, tab: tab1, pane: pane1 } = ws.json() as {
      workspace: { id: string };
      tab: { id: string };
      pane: { id: string };
    };

    const tab2res = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/tabs`,
      headers: AUTH,
      payload: {},
    });
    const { tab: tab2, pane: pane2 } = tab2res.json() as { tab: { id: string }; pane: { id: string } };

    const s1 = await createShell(c, pane1.id);
    const s2 = await createShell(c, pane2.id);
    expect(s1.statusCode).toBe(201);
    expect(s2.statusCode).toBe(201);

    const seen: string[] = [];
    c.deps.bus.on((e) => seen.push(e.type));

    const del = await c.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspace.id}`, headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect(c.deps.pty.alive(s1.body.id!)).toBe(false);
    expect(c.deps.pty.alive(s2.body.id!)).toBe(false);

    expect(seen.filter((t) => t === 'layout.changed')).toHaveLength(1);
    expect(seen.filter((t) => t === 'session.removed')).toHaveLength(2);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as StateBody;
    expect(body.sessions).toEqual([]);
    expect(body.layout.tabs.map((t) => t.id)).not.toContain(tab1.id);
    expect(body.layout.tabs.map((t) => t.id)).not.toContain(tab2.id);
  }, 30000);

  it('DELETE /api/tabs/:id com aba inexistente → 404', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'DELETE', url: '/api/tabs/tab_nao_existe', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('aba com sessão exited → DELETE /api/tabs/:id continua funcionando (sessão exited é descartável)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
    const { tab, pane } = ws.json() as { tab: { id: string }; pane: { id: string } };

    const created = await createShell(c, pane.id);
    const sessionId = created.body.id!;
    await c.deps.pty.kill(sessionId);
    await waitFor(() => c.deps.sessions.get(sessionId)?.state === 'exited');

    const del = await c.app.inject({ method: 'DELETE', url: `/api/tabs/${tab.id}`, headers: AUTH });
    expect(del.statusCode).toBe(204);

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as StateBody;
    expect(body.sessions).toEqual([]);
    expect(body.layout.tabs.map((t) => t.id)).not.toContain(tab.id);
  }, 20000);

  it('DELETE /api/workspaces/:id com workspace inexistente → 404', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'DELETE', url: '/api/workspaces/ws_nao_existe', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  /**
   * Caminho 500 das duas rotas: uma sessão que não morre. O kill é
   * monkeypatch no `pty` do core (é o que `disposeSession` chama), então a
   * rota vê `failed > 0` e não pode remover o layout por baixo de um PTY vivo.
   */
  it('sessão que se recusa a morrer → 500 com a contagem, e o layout FICA', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
    const { workspace, tab, pane } = ws.json() as { workspace: { id: string }; tab: { id: string }; pane: { id: string } };
    expect((await createShell(c, pane.id)).statusCode).toBe(201);

    const realKill = c.deps.pty.kill.bind(c.deps.pty);
    c.deps.pty.kill = () => Promise.reject(new Error('PTY travado'));

    // O `finally` não é decoração: qualquer `expect` abaixo que falhe aborta o
    // teste, e sem devolver o kill de verdade o `stop()` do afterEach
    // rejeitaria — deixando um PTY (pwsh) vivo depois da suíte inteira.
    try {
      const delTab = await c.app.inject({ method: 'DELETE', url: `/api/tabs/${tab.id}`, headers: AUTH });
      expect(delTab.statusCode).toBe(500);
      expect(delTab.json().error).toBe('não consegui encerrar 1 sessão(ões)');
      // Task 2 do polimento: o corpo diz o desfecho dos DOIS lados, não só a
      // contagem do que falhou — sem os ids o dono não sabe em qual painel olhar.
      expect(delTab.json()).toMatchObject({ code: 'kill-failed', killed: 0, failed: 1 });
      expect(delTab.json().failedIds).toHaveLength(1);

      const delWs = await c.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspace.id}`, headers: AUTH });
      expect(delWs.statusCode).toBe(500);
      expect(delWs.json().error).toBe('não consegui encerrar 1 sessão(ões)');
      expect(delWs.json()).toMatchObject({ code: 'kill-failed', killed: 0, failed: 1 });

      const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
      expect((state.json() as StateBody).layout.tabs.map((t) => t.id)).toContain(tab.id);
    } finally {
      c.deps.pty.kill = realKill;
    }
  }, 20000);

  /**
   * Falha PARCIAL (Task 2 do polimento): duas sessões na mesma aba, uma que
   * morre e uma que não. O que se afirma aqui é que o lote NÃO para na
   * primeira falha — a outra sessão tem que ser encerrada de verdade — e que a
   * resposta conta os dois lados, nomeando quem resistiu.
   */
  it('kill em lote com uma sessão travada: as outras morrem e o 500 traz { killed, failed, failedIds }', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
    const { tab, pane } = ws.json() as { tab: { id: string }; pane: { id: string } };

    const teimosa = (await createShell(c, pane.id)).body.id!;
    const split = await c.app.inject({ method: 'POST', url: `/api/panes/${pane.id}/split`, headers: AUTH, payload: { dir: 'v' } });
    const outroPane = (split.json() as { id: string }).id;
    const obediente = (await createShell(c, outroPane)).body.id!;

    const realKill = c.deps.pty.kill.bind(c.deps.pty);
    c.deps.pty.kill = (id: string) => (id === teimosa ? Promise.reject(new Error('PTY travado')) : realKill(id));

    try {
      const del = await c.app.inject({ method: 'DELETE', url: `/api/tabs/${tab.id}`, headers: AUTH });
      expect(del.statusCode).toBe(500);
      expect(del.json()).toMatchObject({ code: 'kill-failed', killed: 1, failed: 1, failedIds: [teimosa] });

      // A obediente sumiu MESMO — a falha da irmã não a protegeu.
      const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
      const ids = (state.json() as StateBody).sessions.map((s) => s.id);
      expect(ids).not.toContain(obediente);
      expect(ids).toContain(teimosa);
    } finally {
      c.deps.pty.kill = realKill;
    }
  }, 20000);
});

describe('POST /api/shutdown (R4)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('responde 202 e chama stop() + onShutdown, sem derrubar o processo do teste', async () => {
    const shutdowns: number[] = [];
    core = createCore({
      profileDir: tmp(),
      dbPath: ':memory:',
      port: 0,
      token: 'T',
      onShutdown: () => shutdowns.push(Date.now()),
    });
    const c = core;
    let stopped = 0;
    const realStop = c.stop.bind(c);
    c.stop = async () => {
      stopped += 1;
      await realStop();
    };

    const res = await c.app.inject({ method: 'POST', url: '/api/shutdown', headers: AUTH });

    expect(res.statusCode).toBe(202);
    await waitFor(() => shutdowns.length === 1);
    expect(stopped).toBe(1);
    core = undefined; // já parado pela rota; um segundo stop() no afterEach seria redundante
  }, 20000);

  it('sem token → 401 (a rota não é atalho de encerramento aberto)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'POST', url: '/api/shutdown' });
    expect(res.statusCode).toBe(401);
  });
});
