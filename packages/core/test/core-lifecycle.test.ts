import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { join } from 'node:path';

function tmp(): string {
  return tmpDir('bridge-life-');
}

const AUTH = { authorization: 'Bearer T' };
const fakeAgentPath = join(__dirname, 'fake-agent.cjs');

/**
 * O `claude` falso: `available()` sempre ok e um PTY que fica VIVO (o
 * `fake-agent.cjs` espera no stdin). É o mesmo registro que o
 * `api-resume.test.ts` usa — subir o Claude de verdade em teste está fora de
 * questão, e o que está sob prova aqui é o que o core grava no painel.
 */
function fakeClaude(core: Core): void {
  core.deps.adapters.claude = {
    id: 'claude',
    label: 'Claude falso',
    available: async () => ({ ok: true }),
    launch: () => ({
      bin: process.execPath,
      args: [fakeAgentPath],
      env: { ...process.env } as Record<string, string>,
      files: [],
    }),
    onHook: () => ({}),
  };
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

describe('ciclo de vida do core (GC de sessions/, stop, layout persistido)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('na subida apaga pastas órfãs de %profile%/sessions (nenhuma sessão viva existe ainda)', () => {
    const profileDir = tmp();
    const orphan = join(profileDir, 'sessions', 'sess_orfa');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'settings.json'), '{}');

    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });

    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(join(profileDir, 'sessions'))).toEqual([]);
  });

  it('stop() mata as sessões, apaga os sessionDirs e PRESERVA os painéis (spec §10: layout volta do SQLite)', async () => {
    const profileDir = tmp();
    const cwd = tmp();

    const first = createCore({ profileDir, port: 0, token: 'T' });
    const ws = await first.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
    const { pane } = ws.json() as { pane: { id: string } };
    const created = await first.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: pane.id, kind: 'shell' },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string };
    expect(existsSync(join(profileDir, 'sessions', session.id))).toBe(true);

    await first.stop();

    expect(readdirSync(join(profileDir, 'sessions'))).toEqual([]);

    core = createCore({ profileDir, port: 0, token: 'T' });
    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as { layout: { panes: Array<{ id: string }> }; sessions: unknown[] };
    expect(body.layout.panes.some((p) => p.id === pane.id)).toBe(true);
    expect(body.sessions).toEqual([]);
  }, 20000);

  // ----------------------------------- quem encerrou o painel (resume 0.6)

  /**
   * 13/09/2026 — a morte do processo, sozinha, NÃO diz quem encerrou.
   *
   * Até aqui o ouvinte de `session.exited` carimbava `'user'` em qualquer
   * saída com o core vivo. Na madrugada de 13/09 o Claude do painel do dono
   * saiu sem `/exit` nenhum (a 1 min de um auto-update do Claude Code), o
   * painel virou `'user'` e o reboot do Windows Update, 25 min depois,
   * devolveu um shell no lugar da conversa. Quem prova "fechei de propósito" é
   * o `SessionEnd` com motivo de saída, ou o ✕ do próprio Bridge.
   */
  it('processo do agente que morre sem SessionEnd (crash, auto-update) NÃO carimba user', () => {
    const profileDir = tmp();
    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({
      paneId: pane.id,
      workspaceId: workspace.id,
      kind: 'agent',
      agent: 'claude',
      cwd,
    });
    core.deps.layout.setPaneLast(pane.id, 'agent', 'claude');
    core.deps.layout.setPaneEnded(pane.id, 'app');
    core.noteAgentSessionId(session.id, 'uuid-crash');

    // O que o PTY faz quando o processo do agente morre.
    core.deps.sessions.exited(session.id, 1);

    const saved = core.deps.db.panes.get(pane.id);
    expect(saved?.lastEndedBy).toBe('app');
    expect(saved?.lastAgentSessionId).toBe('uuid-crash');
  });

  /**
   * O caso que abriu o lote: fechar o Bridge com um Claude vivo. O `stop()`
   * marca ANTES de matar, senão o `session.exited` de cada PTY morto voltaria
   * como "o usuário encerrou" e nada seria retomado. A marca tem que
   * SOBREVIVER ao processo — é lida do SQLite na subida seguinte.
   */
  it('stop() com agente vivo marca lastEndedBy app, e a marca volta na subida seguinte', async () => {
    const profileDir = tmp();
    const cwd = tmp();

    const first = createCore({ profileDir, port: 0, token: 'T' });
    const { workspace, pane } = first.deps.layout.createWorkspace({ cwd });
    const agent = first.deps.sessions.create({
      paneId: pane.id,
      workspaceId: workspace.id,
      kind: 'agent',
      agent: 'claude',
      cwd,
    });
    first.deps.layout.setPaneLast(pane.id, 'agent', 'claude');
    first.noteAgentSessionId(agent.id, 'uuid-app');

    // Um segundo painel, com shell: shell não retoma, então ele não pode ser
    // marcado como 'app' — voltaria como um Claude que nunca existiu ali.
    const shellPane = first.deps.layout.splitPane(pane.id, 'v');
    first.deps.sessions.create({ paneId: shellPane.id, workspaceId: workspace.id, kind: 'shell', cwd });
    first.deps.layout.setPaneLast(shellPane.id, 'shell');

    await first.stop();

    core = createCore({ profileDir, port: 0, token: 'T' });
    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const body = state.json() as {
      layout: { panes: Array<{ id: string; lastKind?: string; lastAgent?: string; lastEndedBy?: string; lastAgentSessionId?: string }> };
    };

    const restored = body.layout.panes.find((p) => p.id === pane.id);
    expect(restored?.lastKind).toBe('agent');
    expect(restored?.lastAgent).toBe('claude');
    expect(restored?.lastEndedBy).toBe('app');
    expect(restored?.lastAgentSessionId).toBe('uuid-app');

    const restoredShell = body.layout.panes.find((p) => p.id === shellPane.id);
    expect(restoredShell?.lastEndedBy).toBeUndefined();
  }, 20000);

  // ------------------------------- marca ANTECIPADA (0.12.1, morte não limpa)

  /**
   * O defeito que abriu a 0.12.1: a marca `'app'` só existia no `stop()`, ou
   * seja só num encerramento GRACIOSO. O instalador NSIS mata o app sem
   * `WM_CLOSE`, e o desligamento do Windows também: o core morre com o agente
   * vivo, o `stop()` nunca roda, o painel fica com `lastEndedBy` NULL e a
   * subida seguinte não retoma nada.
   *
   * A correção inverte o momento da marca: ela é escrita quando o agente SOBE
   * — "se o app morrer agora, retome este painel" —, e a saída normal do
   * processo continua carimbando `'user'` por cima.
   */
  it('agente que SOBE já nasce com o painel marcado lastEndedBy app (o core pode morrer sem stop())', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    fakeClaude(c);
    const paneId = await newWorkspacePane(c);

    const criada = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude' },
    });
    expect(criada.statusCode).toBe(201);

    // Nada de `stop()`, nada de fechar o app: a marca já está no SQLite.
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('app');
    expect(c.deps.db.panes.get(paneId)?.lastKind).toBe('agent');
  }, 30000);

  /** Shell não retoma: marcar `'app'` nele faria voltar um Claude que nunca esteve ali. */
  it('shell que sobe NÃO ganha a marca antecipada', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const paneId = await newWorkspacePane(c);

    const criada = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    expect(criada.statusCode).toBe(201);
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBeUndefined();
  }, 30000);

  /** Sobe o Claude falso num painel novo e devolve os ids. */
  async function agentePronto(c: Core): Promise<{ paneId: string; id: string }> {
    fakeClaude(c);
    const paneId = await newWorkspacePane(c);
    const criada = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude' },
    });
    expect(criada.statusCode).toBe(201);
    const id = (criada.json() as { id: string }).id;
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('app');
    return { paneId, id };
  }

  function sessionEnd(c: Core, id: string, payload: Record<string, unknown>): Promise<{ statusCode: number }> {
    return c.app.inject({ method: 'POST', url: `/hooks/${id}/SessionEnd?token=T`, payload });
  }

  /** O PTY morto sem aviso do agente: a marca antecipada `'app'` fica. */
  it('agente cujo PTY morre sem SessionEnd mantém a marca antecipada app', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId, id } = await agentePronto(c);

    await c.deps.pty.kill(id);
    await waitFor(() => c.deps.sessions.get(id)?.state === 'exited');
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('app');
  }, 30000);

  /**
   * A semântica antiga continua valendo pra saída DELIBERADA: `/exit`, Ctrl+D
   * no prompt e logout chegam como `SessionEnd` com motivo, e a próxima subida
   * não ressuscita uma conversa que o dono fechou.
   */
  it.each(['prompt_input_exit', 'exit', 'logout'])('SessionEnd com motivo %s carimba user', async (reason) => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId, id } = await agentePronto(c);

    expect((await sessionEnd(c, id, { session_id: 'conv-1', reason })).statusCode).toBe(200);
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('user');

    // E a morte do PTY que vem logo depois não desfaz nada.
    await c.deps.pty.kill(id);
    await waitFor(() => c.deps.sessions.get(id)?.state === 'exited');
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('user');
  }, 30000);

  /**
   * `other` (sinal, encerramento que o agente não atribui ao usuário), payload
   * sem motivo e `/clear` não provam intenção: o painel continua retomável.
   */
  it.each([{ reason: 'other' }, {}, { reason: 'clear' }])('SessionEnd %j NÃO carimba user', async (extra) => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId, id } = await agentePronto(c);

    await sessionEnd(c, id, { session_id: 'conv-1', ...extra });
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('app');
  }, 30000);

  /** O ✕ do painel (`DELETE /api/sessions/:id`) é o dono encerrando pelo Bridge. */
  it('encerrar a sessão de agente pelo Bridge carimba user', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { paneId, id } = await agentePronto(c);

    const res = await c.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: AUTH });
    expect(res.statusCode).toBeLessThan(300);
    // Painel único da aba: ele fica, vazio, com a marca.
    expect(c.deps.db.panes.get(paneId)?.lastEndedBy).toBe('user');
  }, 30000);
});
