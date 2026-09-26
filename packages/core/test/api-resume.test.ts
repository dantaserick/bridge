/**
 * `POST /api/panes/:id/resume` — a rota do `bridge resume` (Fase 5, Task 3).
 *
 * O adaptador `claude` é falso aqui (o Claude de verdade não sobe em teste),
 * mas ele é o MESMO ponto por onde o `claudeAdapter.launch` recebe o
 * `--resume`: o que os testes provam é que o id guardado no painel
 * (`lastAgentSessionId`) chega no `LaunchCtx`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmp(): string {
  return tmpDir('bridge-resume-');
}

const AUTH = { authorization: 'Bearer T' };
const fakeAgentPath = join(__dirname, 'fake-agent.cjs');

/** Registra o `claude` falso e devolve os `resume` que o launch recebeu. */
function fakeClaude(core: Core): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  core.deps.adapters.claude = {
    id: 'claude',
    label: 'Claude falso',
    available: async () => ({ ok: true }),
    launch: (ctx) => {
      seen.push(ctx.resume);
      return {
        bin: process.execPath,
        args: [fakeAgentPath],
        env: { ...process.env } as Record<string, string>,
        files: [],
      };
    },
    onHook: () => ({}),
  };
  return seen;
}

async function newWorkspacePane(core: Core): Promise<string> {
  const cwd = tmp();
  const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
  const { pane } = ws.json() as { pane: { id: string } };
  return pane.id;
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

function resume(core: Core, paneId: string, sessionHeader?: string): Promise<{ statusCode: number; json: () => unknown }> {
  return core.app.inject({
    method: 'POST',
    url: `/api/panes/${paneId}/resume`,
    headers: sessionHeader ? { ...AUTH, 'x-bridge-session': sessionHeader } : AUTH,
  });
}

describe('POST /api/panes/:id/resume', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('painel inexistente → 404 pane-not-found', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await resume(core, 'pane_nao_existe');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'pane-not-found' });
  });

  it('painel que nunca teve agente → 422 nothing-to-resume', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const paneId = await newWorkspacePane(core);

    const res = await resume(core, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'Este painel não tem conversa pra retomar', code: 'nothing-to-resume' });
  });

  it('painel que rodou agente mas sem id de conversa (nenhum hook chegou) → 422 nothing-to-resume', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const paneId = await newWorkspacePane(c);
    // Agente subiu e morreu antes do primeiro `SessionStart`: `lastKind` é
    // 'agent', mas não há conversa nenhuma pra retomar.
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', undefined);

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'nothing-to-resume' });
  });

  it('shell vivo num painel sem conversa → 422 e o shell CONTINUA vivo', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const paneId = await newWorkspacePane(c);
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    const shellId = (shell.json() as { id: string }).id;

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'nothing-to-resume' });
    // Pedido que vira 422 não pode destruir o terminal que a pessoa tem na mão.
    expect(c.deps.sessions.get(shellId)?.state).not.toBe('exited');
  }, 25000);

  it('shell vivo no painel → 201: o shell sai, o agente entra no mesmo painel', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const seen = fakeClaude(c);
    const paneId = await newWorkspacePane(c);

    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    expect(shell.statusCode).toBe(201);
    const shellId = (shell.json() as { id: string }).id;
    // O shell novo apaga a marca do agente (`setPaneLast`); regravar aqui é o
    // painel restaurado como shell VIVO por cima do que era Claude — o caso
    // normal do `bridge resume` (ver o report da fix round 1).
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'conversa-antiga');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; paneId: string; resumedFrom: string };
    expect(body.kind).toBe('agent');
    expect(body.paneId).toBe(paneId);
    expect(body.resumedFrom).toBe('conversa-antiga');
    expect(seen).toEqual(['conversa-antiga']);

    // O shell sumiu de vez (não ficou `exited` pendurado no painel) e o painel
    // continua com UMA sessão só: a do agente.
    expect(c.deps.sessions.get(shellId)).toBeUndefined();
    expect(c.deps.sessions.byPane(paneId)?.id).toBe(body.id);
    expect(c.deps.sessions.list().filter((s) => s.paneId === paneId)).toHaveLength(1);
    // E o painel continua existindo (o kill do shell não fecha o split).
    expect(c.deps.db.panes.get(paneId)).toBeDefined();
  }, 30000);

  it('agente vivo no painel → 409 pane-busy, sem tocar na sessão que está lá', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    fakeClaude(c);
    const paneId = await newWorkspacePane(c);

    const agente = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude', resume: 'conversa-viva' },
    });
    expect(agente.statusCode).toBe(201);
    const agenteId = (agente.json() as { id: string }).id;

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'este painel já está com um agente', code: 'pane-busy' });
    expect(c.deps.sessions.get(agenteId)?.state).not.toBe('exited');
  }, 30000);

  it('painel com conversa guardada → 201, agente com --resume e resumedFrom no corpo', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const seen = fakeClaude(c);
    const paneId = await newWorkspacePane(c);
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'uuid-da-conversa');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; agent?: string; paneId: string; resumedFrom: string };
    expect(body.kind).toBe('agent');
    expect(body.agent).toBe('claude');
    expect(body.paneId).toBe(paneId);
    expect(body.resumedFrom).toBe('uuid-da-conversa');
    expect(seen).toEqual(['uuid-da-conversa']);
    expect(c.deps.sessions.get(body.id)?.kind).toBe('agent');
    // O painel continua apontando pra mesma conversa depois do resume.
    expect(c.deps.db.panes.get(paneId)?.lastAgentSessionId).toBe('uuid-da-conversa');
  }, 25000);

  /**
   * Fix round 3: o shell só cai DEPOIS de todas as validações do
   * `createSession` (`available()`, cwd). Enquanto a rota matava o shell antes
   * de chamar o core, um 422 deixava o usuário sem o terminal que ele tinha na
   * mão — o contrário do princípio que a própria rota aplica no
   * `nothing-to-resume`.
   */
  it('shell vivo + agente indisponível → 422 e o shell CONTINUA vivo', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    c.deps.adapters.claude = {
      id: 'claude',
      label: 'Claude ausente',
      available: async () => ({ ok: false, reason: 'claude não encontrado no PATH' }),
      launch: () => ({ bin: process.execPath, args: [], env: {}, files: [] }),
      onHook: () => ({}),
    };
    const paneId = await newWorkspacePane(c);
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    const shellId = (shell.json() as { id: string }).id;
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'conversa-antiga');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'agent-unavailable' });
    expect(c.deps.sessions.get(shellId)?.state).not.toBe('exited');
    expect(c.deps.sessions.byPane(paneId)?.id).toBe(shellId);
  }, 25000);

  it('shell vivo + cwd do painel que sumiu → 422 cwd-missing e o shell CONTINUA vivo', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    fakeClaude(c);
    const paneId = await newWorkspacePane(c);
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    const shellId = (shell.json() as { id: string }).id;
    // A pasta do painel sumiu depois que o shell subiu (worktree removido,
    // pendrive tirado): o `createSession` recusa no cwd, DEPOIS do
    // `available()` — e nem por isso o shell pode morrer.
    const pane = c.deps.db.panes.get(paneId)!;
    c.deps.db.panes.update({ ...pane, cwd: join(tmpdir(), 'bridge-pasta-que-nao-existe-xyz') });
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'conversa-antiga');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'cwd-missing' });
    expect(c.deps.sessions.get(shellId)?.state).not.toBe('exited');
    expect(c.deps.sessions.byPane(paneId)?.id).toBe(shellId);
  }, 25000);

  it('agente indisponível → 422 com o code do adaptador, sem sessão nova', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    c.deps.adapters.claude = {
      id: 'claude',
      label: 'Claude ausente',
      available: async () => ({ ok: false, reason: 'claude não encontrado no PATH' }),
      launch: () => ({ bin: process.execPath, args: [], env: {}, files: [] }),
      onHook: () => ({}),
    };
    const paneId = await newWorkspacePane(c);
    c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'uuid-da-conversa');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'agent-unavailable' });
    expect(c.deps.sessions.list()).toEqual([]);
  });

  /**
   * O caminho de verdade, da ponta à ponta e sem `setPaneLast` na mão: agente
   * roda no painel → o hook do Claude grava o id da conversa → o app fecha
   * (PTY morto + `lastEndedBy: 'app'`) → a subida seguinte devolve o painel
   * como SHELL (é o que a UI faz com `restore.resumeAgents` desligado, ou
   * quando o resume automático falha) → `bridge resume` põe o Claude de volta
   * na mesma conversa. Era aqui que a memória do painel se perdia antes de
   * 0.7.0 (`setPaneLast` apagava o id quando o shell entrava).
   */
  it('fim-a-fim: agente → hook → app fecha → restaura como shell → resume traz a conversa de volta', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const seen = fakeClaude(c);
    const paneId = await newWorkspacePane(c);

    const agente = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude' },
    });
    expect(agente.statusCode).toBe(201);
    const agenteId = (agente.json() as { id: string }).id;
    // O `SessionStart` do Claude Code trazendo o `session_id` da conversa.
    c.deps.layout.setPaneAgentSession(paneId, 'uuid-do-hook');

    // App fechando: o core mata o PTY e marca o painel como encerrado por ele.
    await c.deps.pty.kill(agenteId);
    await waitFor(() => c.deps.sessions.get(agenteId)?.state === 'exited');
    c.deps.layout.setPaneEnded(paneId, 'app');

    // Subida seguinte, `resumeAgents` desligado: o painel volta como shell.
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    expect(shell.statusCode).toBe(201);
    const shellId = (shell.json() as { id: string }).id;
    // Regressão do bug da fix round 1: o shell não pode apagar a conversa.
    const restaurado = c.deps.db.panes.get(paneId);
    expect(restaurado?.lastKind).toBe('shell');
    expect(restaurado?.lastAgent).toBe('claude');
    expect(restaurado?.lastAgentSessionId).toBe('uuid-do-hook');

    const res = await resume(c, paneId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; paneId: string; resumedFrom: string };
    expect(body.kind).toBe('agent');
    expect(body.paneId).toBe(paneId);
    expect(body.resumedFrom).toBe('uuid-do-hook');
    // O `--resume` do primeiro launch é `undefined` (agente novo); o segundo é
    // o do hook — a conversa que o usuário pediu de volta.
    expect(seen).toEqual([undefined, 'uuid-do-hook']);
    expect(c.deps.sessions.get(shellId)).toBeUndefined();
    expect(c.deps.sessions.byPane(paneId)?.id).toBe(body.id);
  }, 40000);

  describe('`current` (o `bridge resume` sem paneId)', () => {
    it('resolve pelo X-Bridge-Session — a sessão de onde o comando saiu', async () => {
      core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
      const c = core;
      const seen = fakeClaude(c);
      const paneId = await newWorkspacePane(c);

      // Shell do painel restaurado: sobe, morre (o PTY), e a sessão fica
      // `exited` — é dela que o `X-Bridge-Session` do comando fala.
      const shell = await c.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: AUTH,
        payload: { paneId, kind: 'shell' },
      });
      const shellId = (shell.json() as { id: string }).id;
      await c.deps.pty.kill(shellId);
      await waitFor(() => c.deps.sessions.get(shellId)?.state === 'exited');
      c.deps.layout.setPaneLast(paneId, 'agent', 'claude', 'uuid-da-conversa');

      const res = await resume(c, 'current', shellId);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ paneId, resumedFrom: 'uuid-da-conversa' });
      expect(seen).toEqual(['uuid-da-conversa']);
    }, 25000);

    it('sem header, cai na sessão em foco (POST /api/focus)', async () => {
      core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
      const c = core;
      const paneId = await newWorkspacePane(c);
      const shell = await c.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: AUTH,
        payload: { paneId, kind: 'shell' },
      });
      const shellId = (shell.json() as { id: string }).id;
      await c.deps.pty.kill(shellId);
      await waitFor(() => c.deps.sessions.get(shellId)?.state === 'exited');
      await c.app.inject({
        method: 'POST',
        url: '/api/focus',
        headers: AUTH,
        payload: { sessionId: shellId, windowFocused: true },
      });

      // O painel em foco não tem conversa guardada: o 422 (em vez do 404 de
      // "nenhum painel atual") é a prova de que o foco resolveu o painel.
      const res = await resume(c, 'current');
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'nothing-to-resume' });
    }, 25000);

    it('sem sessão nenhuma (fora do Bridge, nada em foco) → 404 pane-not-found', async () => {
      core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
      await newWorkspacePane(core);

      const res = await resume(core, 'current');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'nenhum painel atual: passe o paneId', code: 'pane-not-found' });
    });
  });
});
