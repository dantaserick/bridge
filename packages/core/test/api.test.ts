import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import WebSocket from 'ws';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';

function tmp(): string {
  return tmpDir('bridge-api-');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFixture(name: string): any {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hooks', `${name}.json`), 'utf8'));
}

function waitFor(check: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout esperando condição'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const AUTH = { authorization: 'Bearer T' };

describe('API', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('GET /api/keybindings devolve as 19 ações, com o keybindings.json do perfil mesclado', async () => {
    const profileDir = tmp();
    writeFileSync(join(profileDir, 'keybindings.json'), JSON.stringify({ 'tab.new': 'F2', 'pane.fly': 'F5' }), 'utf8');
    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });

    const res = await core.app.inject({ method: 'GET', url: '/api/keybindings', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['tab.new']).toBe('F2');
    expect(body['pane.splitV']).toBe('Ctrl+Shift+D');
    expect(body).not.toHaveProperty('pane.fly');
    // As 19 ações + o campo irmão `problems`, que só aparece porque o arquivo
    // deste caso traz uma ação inventada.
    expect(Object.keys(body).filter((k) => k !== 'problems')).toHaveLength(19);
    expect(body.problems).toEqual([{ kind: 'acao-desconhecida', action: 'pane.fly' }]);
  });

  it('GET /api/keybindings de um perfil sem keybindings.json não traz `problems`', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'GET', url: '/api/keybindings', headers: AUTH });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(19);
    expect(body).not.toHaveProperty('problems');
  });

  it('GET /api/keybindings sem bearer → 401', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'GET', url: '/api/keybindings' });
    expect(res.statusCode).toBe(401);
  });

  it('sem bearer → 401', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'GET', url: '/api/state' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/workspaces: cwd inexistente → 400; cwd real → 201 e aparece em GET /api/state', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const bad = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: 'C:\\projetos\\bridge-nao-existe-xyz' },
    });
    expect(bad.statusCode).toBe(400);

    const cwd = tmp();
    const created = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    expect(created.statusCode).toBe(201);

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect(state.statusCode).toBe(200);
    const body = state.json();
    expect(body.layout.workspaces.some((w: { cwd: string }) => w.cwd === cwd)).toBe(true);
    expect(body.layout.tabs.length).toBeGreaterThan(0);
    expect(body.layout.panes.length).toBeGreaterThan(0);
  });

  it('POST /api/sessions kind shell: 201 com pid (spawn real de pwsh); DELETE mata', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { pane } = ws.json() as { pane: { id: string } };

    const created = await core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'shell' },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    expect(session.pid).toBeGreaterThan(0);

    const del = await core.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
  }, 15000);

  it('POST /api/sessions kind agent codex → 422 (adaptador indisponível)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { pane } = ws.json() as { pane: { id: string } };

    const created = await core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'agent', agent: 'codex' },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().error).toBeTruthy();
  }, 10000);

  it('POST /api/sessions paneId inexistente → 404 (via PaneNotFoundError, não 422)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const created = await core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: 'pane_nao_existe', kind: 'shell' },
    });
    expect(created.statusCode).toBe(404);
    expect(created.json().error).toContain('painel não encontrado');
  });

  it('validação de corpo: kind inválido, cols não numérico e focus sem windowFocused → 400', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const badKind = await core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: 'pane_x', kind: 'x' },
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error).toBeTruthy();

    const badResize = await core.app.inject({
      method: 'POST',
      url: '/api/sessions/sess_x/resize',
      headers: AUTH,
      payload: { cols: 'a', rows: 24 },
    });
    expect(badResize.statusCode).toBe(400);
    expect(badResize.json().error).toBeTruthy();

    const badFocus = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: 'sess_x' },
    });
    expect(badFocus.statusCode).toBe(400);
    expect(badFocus.json().error).toBeTruthy();
  });

  it('hooks: UserPromptSubmit → running; Origin → 403; token errado → 401; sessão desconhecida → 200 {}', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const payload = readFixture('user-prompt');

    const ok = await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/UserPromptSubmit?token=T`, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({});
    expect(core.deps.sessions.get(session.id)?.state).toBe('running');

    const origin = await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=T`,
      headers: { origin: 'http://evil.example' },
      payload,
    });
    expect(origin.statusCode).toBe(403);

    const badToken = await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=errado`,
      payload,
    });
    expect(badToken.statusCode).toBe(401);

    const unknown = await core.app.inject({ method: 'POST', url: '/hooks/sess_nope/UserPromptSubmit?token=T', payload });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({});
  });

  /**
   * `POST /api/sessions { kind: 'agent', resume }` — o caminho que a
   * restauração da UI usa pra pedir `claude --resume <id>`. O adaptador aqui é
   * falso (o Claude de verdade não sobe em teste), mas ele é o MESMO ponto por
   * onde o `claudeAdapter.launch` recebe o campo.
   */
  it('dois POST /api/sessions concorrentes no mesmo painel: um 201, um 409, UMA sessão', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const cwd = tmp();
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { pane } = ws.json() as { pane: { id: string } };

    const fakeAgentPath = join(__dirname, 'fake-agent.cjs');
    c.deps.adapters.claude = {
      id: 'claude',
      label: 'Claude lento',
      // `claude --version` de verdade leva segundos: é a janela da corrida.
      available: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 150)),
      launch: () => ({ bin: process.execPath, args: [fakeAgentPath], env: { ...process.env } as Record<string, string>, files: [] }),
      onHook: () => ({}),
    };

    const [agent, shell] = await Promise.all([
      c.app.inject({ method: 'POST', url: '/api/sessions', headers: AUTH, payload: { paneId: pane.id, kind: 'agent', agent: 'claude' } }),
      c.app.inject({ method: 'POST', url: '/api/sessions', headers: AUTH, payload: { paneId: pane.id, kind: 'shell' } }),
    ]);
    expect([agent.statusCode, shell.statusCode].sort()).toEqual([201, 409]);

    const state = (await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json() as {
      sessions: Array<{ paneId: string }>;
    };
    expect(state.sessions.filter((s) => s.paneId === pane.id)).toHaveLength(1);
  });

  it('POST /api/sessions repassa o resume pro adaptador (e ignora num shell)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const cwd = tmp();
    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { pane } = ws.json() as { pane: { id: string } };

    const seen: Array<string | undefined> = [];
    const fakeAgentPath = join(__dirname, 'fake-agent.cjs');
    c.deps.adapters.claude = {
      id: 'claude',
      label: 'Claude falso',
      available: async () => ({ ok: true }),
      launch: (ctx) => {
        seen.push(ctx.resume);
        return { bin: process.execPath, args: [fakeAgentPath], env: { ...process.env } as Record<string, string>, files: [] };
      },
      onHook: () => ({}),
    };

    const created = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'agent', agent: 'claude', resume: 'uuid-retomado' },
    });
    expect(created.statusCode).toBe(201);
    expect(seen).toEqual(['uuid-retomado']);

    await c.app.inject({ method: 'DELETE', url: `/api/sessions/${(created.json() as { id: string }).id}`, headers: AUTH });

    // Corpo inválido: `resume` vazio é 400, não um `--resume ""` no comando.
    const vazio = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'agent', agent: 'claude', resume: '' },
    });
    expect(vazio.statusCode).toBe(400);

    // Shell com `resume` sobe normalmente — o campo só quer dizer algo pro agente.
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'shell', resume: 'uuid-retomado' },
    });
    expect(shell.statusCode).toBe(201);
    await c.app.inject({ method: 'DELETE', url: `/api/sessions/${(shell.json() as { id: string }).id}`, headers: AUTH });
  }, 20000);

  /**
   * O `session_id` do payload é o id que o AGENTE usa pra si. É ele que vira
   * `claude --resume <id>` na próxima subida, então tem que chegar aos dois
   * lugares que o `GET /api/state` devolve: a sessão (memória, some no
   * fechamento) e o painel (SQLite, sobrevive).
   */
  it('hooks: session_id do payload vai pra sessão e pro painel, e aparece em GET /api/state', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const events: string[] = [];
    core.deps.bus.on((e) => events.push(e.type));

    const res = await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/SessionStart?token=T`,
      payload: readFixture('session-start'),
    });
    expect(res.statusCode).toBe(200);

    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as {
      layout: { panes: Array<{ id: string; lastAgentSessionId?: string }> };
      sessions: Array<{ id: string; agentSessionId?: string }>;
    };
    expect(body.sessions.find((s) => s.id === session.id)?.agentSessionId).toBe('abc');
    expect(body.layout.panes.find((p) => p.id === pane.id)?.lastAgentSessionId).toBe('abc');
    // O evento que a UI já usa pra reler o estado inteiro — nada de evento novo.
    expect(events).toContain('layout.changed');

    // Os hooks seguintes trazem o MESMO id: nada regravado, nenhum evento a mais.
    const before = events.filter((e) => e === 'layout.changed').length;
    await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=T`,
      payload: readFixture('user-prompt'),
    });
    expect(events.filter((e) => e === 'layout.changed')).toHaveLength(before);
  });

  /**
   * 0.12.0: com `sessions.hostedAgents` LIGADA (o default) este mesmo hook
   * promove a sessão a hospedeira — é a spec §5, provada em
   * `hosted-hooks.test.ts`. O que este teste segura é o outro lado do
   * interruptor: desligado, a rota volta a ser a de antes.
   */
  it('hooks: sessão kind shell com hostedAgents desligada → {} sem mudar nada', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    core.updateConfig({ sessions: { hostedAgents: false } });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'shell', cwd });

    const res = await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=T`,
      payload: readFixture('user-prompt'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(core.deps.sessions.get(session.id)?.state).toBe('idle');
    expect(core.deps.sessions.get(session.id)?.hosted).toBeUndefined();
  });

  it('Stop com stop_hook_active:true cinco vezes → stuck + notificação stuck', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });
    const payload = readFixture('stop-blocked');

    for (let i = 0; i < 5; i++) {
      await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/Stop?token=T`, payload });
    }

    expect(core.deps.sessions.get(session.id)?.state).toBe('stuck');
    const unread = core.deps.notifications.unread();
    expect(unread.some((n) => n.sessionId === session.id && n.kind === 'stuck')).toBe(true);
  });

  it('StatusLine: responde text/plain e grava quota (sessions + db); a linha do terminal é opcional', async () => {
    const profileDir = tmp();
    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });

    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });
    const payload = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'statusline.json'), 'utf8'));

    const res = await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/StatusLine?token=T`, payload });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // 0.12.2 — `usage.terminalStatusLine` nasce DESLIGADA: o terminal recebe
    // linha vazia. O parse do payload é o que não pode ter mudado, e é ele que
    // as três asserções abaixo cobram.
    expect(res.body).toBe('');

    const quota = core.deps.sessions.get(session.id)?.quota;
    expect(quota).toMatchObject({ model: 'Fable 5.1', contextTokens: 87_000, costUsd: 3.42 });
    expect(quota?.rateLimits).toEqual([
      { window: 'five_hour', usedPct: 23, resetsAt: 1_900_000_000 },
      { window: 'seven_day', usedPct: 68, resetsAt: 1_900_400_000 },
    ]);
    expect(core.deps.db.quota.get(session.id)?.model).toBe('Fable 5.1');
    // O retrato guardado continua com a linha CHEIA — o interruptor é sobre o
    // que vai pro terminal, não sobre o que o Bridge leu.
    expect(quota?.line).toMatch(/^87k ctx · Fable 5\.1 · US\$ 3,42 · 5h 23% \(reseta .+\) · semana 68% \(reseta .+\)$/);

    // Ligada no PATCH (a mesma porta da tela de Configurações → Uso), a linha
    // volta pro terminal na chamada seguinte.
    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { authorization: 'Bearer T' },
      payload: { usage: { terminalStatusLine: true } },
    });
    const ligada = await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/StatusLine?token=T`, payload });
    // ADR-012: a linha é do BRIDGE, montada do payload que o Claude Code
    // acabou de mandar. O trecho do reset depende do relógio, então o que se
    // cobra é o formato e os valores que vieram do payload.
    expect(ligada.body).toMatch(/^87k ctx · Fable 5\.1 · US\$ 3,42 · 5h 23% \(reseta .+\) · semana 68% \(reseta .+\)$/);
  });

  /**
   * As janelas de `rate_limits` são do USUÁRIO, não da sessão: a mesma
   * assinatura vale pros cinco painéis abertos. O hook as tira do snapshot por
   * sessão e as grava no monitor de uso — é de lá que a faixa da sidebar e o
   * `GET /api/usage/limits` leem.
   */
  it('StatusLine alimenta as janelas do monitor de uso e emite usage.changed uma vez', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });
    const payload = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'statusline.json'), 'utf8'));

    const eventos: unknown[] = [];
    core.deps.bus.on((e) => {
      // So os eventos de JANELA: o mesmo `usage.changed` tambem carrega o
      // progresso da varredura de transcricoes, que roda em paralelo aqui.
      if (e.type === 'usage.changed' && e.limits !== undefined) eventos.push(e);
    });

    await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/StatusLine?token=T`, payload });
    // O MESMO payload de novo: a statusline é redesenhada várias vezes por
    // segundo, e um evento por redesenho faria a UI repintar à toa.
    await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/StatusLine?token=T`, payload });

    expect(eventos).toHaveLength(1);
    const res = await core.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH });
    expect(res.json().limits).toEqual([
      { window: 'five_hour', label: '5h', usedPct: 23, resetsAt: 1_900_000_000, seenAt: expect.any(Number) },
      { window: 'seven_day', label: 'semana', usedPct: 68, resetsAt: 1_900_400_000, seenAt: expect.any(Number) },
    ]);
  });

  it('POST /api/focus: depois de Stop, foco na sessão marca idle e lê as notificações dela', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/Stop?token=T`, payload: readFixture('stop') });
    expect(core.deps.sessions.get(session.id)?.state).toBe('done');

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: session.id, windowFocused: true },
    });
    expect(res.statusCode).toBe(200);
    expect(core.deps.sessions.get(session.id)?.state).toBe('idle');

    const unread = core.deps.notifications.unread();
    expect(unread.some((n) => n.sessionId === session.id)).toBe(false);
  });

  it('POST /api/focus com reveal:true emite session.reveal (o que leva a UI até a sessão do `bridge focus`)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });
    const reveals: string[] = [];
    core.deps.bus.on((e) => {
      if (e.type === 'session.reveal') reveals.push(e.id);
    });

    // O foco da própria UI (sem `reveal`) NÃO vira evento — senão o clique
    // dela voltaria pra ela.
    let res = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: session.id, windowFocused: true },
    });
    expect(res.statusCode).toBe(200);
    expect(reveals).toEqual([]);

    res = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: session.id, windowFocused: true, reveal: true },
    });
    expect(res.statusCode).toBe(200);
    expect(reveals).toEqual([session.id]);

    // Sessão que não existe: 404 e nenhum evento — o `bridge focus` de um id
    // morto não pode dizer "em foco".
    res = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: 'sess-inexistente', windowFocused: true, reveal: true },
    });
    expect(res.statusCode).toBe(404);
    expect(reveals).toEqual([session.id]);
  });

  it('POST /api/focus com windowFocused:false: não tira do done nem marca as notificações como lidas', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/Stop?token=T`, payload: readFixture('stop') });
    expect(core.deps.sessions.get(session.id)?.state).toBe('done');

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/focus',
      headers: AUTH,
      payload: { sessionId: session.id, windowFocused: false },
    });
    expect(res.statusCode).toBe(200);

    expect(core.deps.sessions.get(session.id)?.state).toBe('done');
    expect(core.deps.notifications.unread().some((n) => n.sessionId === session.id)).toBe(true);
    // `focused` acompanha o blur mesmo assim — é o que decide o toast.
    expect(core.deps.notifications.focused).toMatchObject({ sessionId: session.id, windowFocused: false });
  });

  it('GET /api/notifications/latest-unread: devolve a não lida mais recente, ou null quando não há', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const empty = await core.app.inject({ method: 'GET', url: '/api/notifications/latest-unread', headers: AUTH });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();

    core.deps.notifications.push(session.id, 'custom', 'primeira');
    core.deps.notifications.push(session.id, 'done', 'última');

    const res = await core.app.inject({ method: 'GET', url: '/api/notifications/latest-unread', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('última');
  });

  it('UserPromptSubmit zera o contador de Stops bloqueados (turno novo não herda o loop anterior)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });
    const blocked = readFixture('stop-blocked');

    for (let i = 0; i < 4; i++) {
      await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/Stop?token=T`, payload: blocked });
    }
    expect(core.deps.sessions.get(session.id)?.consecutiveBlockedStops).toBe(4);

    await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=T`,
      payload: readFixture('user-prompt'),
    });
    expect(core.deps.sessions.get(session.id)?.consecutiveBlockedStops).toBe(0);

    await core.app.inject({ method: 'POST', url: `/hooks/${session.id}/Stop?token=T`, payload: blocked });
    expect(core.deps.sessions.get(session.id)?.state).not.toBe('stuck');
  });

  it('/ws recusa Origin que não seja loopback (403) e aceita 127.0.0.1/localhost', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const evil = await core.app.inject({
      method: 'GET',
      url: '/ws?token=T',
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.statusCode).toBe(403);

    const httpsLoopback = await core.app.inject({
      method: 'GET',
      url: '/ws?token=T',
      headers: { origin: 'https://127.0.0.1:5173' },
    });
    expect(httpsLoopback.statusCode).toBe(403);

    // Origin aceito passa da auth: o 400 vem do upgrade ausente, não do 403.
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
      const ok = await core.app.inject({ method: 'GET', url: '/ws?token=T', headers: { origin } });
      expect(ok.statusCode).not.toBe(403);
      expect(ok.statusCode).not.toBe(401);
    }
  });

  /**
   * R12 da Fase 3 (Fase 4 T5): a MESMA regra do `/ws` vale pro `/api`. Uma
   * página de terceiro que tenha o token não pode dirigir a API — e o CORS
   * não segura o efeito colateral de um POST simples, só a leitura da
   * resposta. Pedido SEM `Origin` (CLI, shim, main do Electron) passa.
   */
  it('/api recusa Origin fora do loopback (403), aceita loopback e passa sem Origin', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    for (const origin of ['http://evil.example', 'https://127.0.0.1:5173', 'file://']) {
      const res = await core.app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { authorization: 'Bearer T', origin },
      });
      expect(res.statusCode, `origin ${origin} devia dar 403`).toBe(403);
    }

    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1']) {
      const res = await core.app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { authorization: 'Bearer T', origin },
      });
      expect(res.statusCode, `origin ${origin} devia passar`).toBe(200);
    }

    const semOrigin = await core.app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer T' } });
    expect(semOrigin.statusCode).toBe(200);

    // Origin ruim vence o token: 403 mesmo com bearer errado (e sem vazar
    // qual dos dois estava errado).
    const semToken = await core.app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: 'Bearer X', origin: 'http://evil.example' },
    });
    expect(semToken.statusCode).toBe(403);
  });

  it('WS: manda hello ao conectar e repassa session.state quando um hook chega', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
    const messages: Array<Record<string, unknown>> = [];
    // Assina 'message' ANTES de esperar 'open': o servidor manda o `hello`
    // assim que aceita a conexão, e isso pode chegar antes do handler de
    // 'open' do cliente rodar — perder a corrida aqui perde o hello.
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    await waitFor(() => messages.some((m) => m.type === 'hello'), 3000);

    await core.app.inject({
      method: 'POST',
      url: `/hooks/${session.id}/UserPromptSubmit?token=T`,
      payload: readFixture('user-prompt'),
    });

    await waitFor(
      () => messages.some((m) => m.type === 'session.state' && m.id === session.id && m.state === 'running'),
      3000,
    );

    socket.close();
  }, 10000);
  /**
   * R6 da onda final: `notify` e `input` de sessão que não existe respondiam
   * `200 {}` — a notificação sumia no vazio e o `bridge send` dizia "enviado"
   * pra ninguém. Os hooks continuam lenientes (o agente não pode quebrar por
   * causa de uma sessão já encerrada); a API do usuário, não.
   */
  it('POST /api/sessions/:id/notify de sessão inexistente devolve 404 session-not-found', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/sessions/sess_fantasma/notify',
      headers: AUTH,
      payload: { text: 'oi' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sessão não encontrada', code: 'session-not-found' });
    // E nada foi gravado: a notificação não existe pra ninguém ler depois.
    const list = await core.app.inject({ method: 'GET', url: '/api/notifications', headers: AUTH });
    expect(list.json()).toEqual([]);
  });

  it('POST /api/sessions/:id/input de sessão inexistente devolve 404 session-not-found', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/sessions/sess_fantasma/input',
      headers: AUTH,
      payload: { data: 'echo oi\r' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sessão não encontrada', code: 'session-not-found' });
  });

  it('corpo inválido ainda é 400 (a validação vem antes da checagem de sessão)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });

    const res = await core.app.inject({
      method: 'POST',
      url: '/api/sessions/sess_fantasma/notify',
      headers: AUTH,
      payload: { text: '' },
    });

    expect(res.statusCode).toBe(400);
  });

});
