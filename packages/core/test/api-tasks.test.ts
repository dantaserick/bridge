import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';

/**
 * Fase 3 pela API: repo detectado no workspace, tarefa (worktree) criada pela
 * rota, indicadores, merge, remoção e `initialCommand`.
 *
 * Todo repo daqui nasce em pasta temporária COM ESPAÇO no nome — nenhum teste
 * toca no repo do Bridge (o user proibiu commits nele) e o espaço é o que
 * prova que nenhuma chamada de git passou por shell.
 */
const trees: string[] = [];

/** Pausa síncrona (o helper de git é síncrono de propósito). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `git` do TESTE (o do core é o `git.ts`). Com a suíte inteira rodando em
 * paralelo, o antivírus/indexador do Windows às vezes ainda segura o `.git`
 * recém-criado quando o comando seguinte chega e o `git config` falha por
 * lock. Três tentativas curtas resolvem isso sem mascarar erro de verdade —
 * o último erro é relançado.
 */
function git(cwd: string, args: string[]): string {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
    } catch (err) {
      last = err;
      sleepSync(150);
    }
  }
  throw last;
}

function tmpTree(prefix = 'bridge tasks '): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

/** Perfil temporário do core (registrado pra limpeza no fim). */
function tmpProfile(): string {
  return tmpTree('bridge-tasks-profile-');
}

/**
 * Pasta que git GARANTE não pertencer a repo nenhum.
 *
 * Não dá pra confiar no `%TEMP%` pra isso: nesta máquina ele fica dentro de
 * `%USERPROFILE%`, que é um repositório git — sem esta marca, o teste de
 * "pasta fora de repo" passaria a detectar o repo do HOME do usuário (e, pior,
 * `POST /api/tasks` criaria um worktree dentro dele). O `.git` inválido faz o
 * git parar a busca com `invalid gitfile format`, que é exatamente o que
 * `detectRepo` traduz em `null`.
 */
function notRepoTree(): string {
  const dir = tmpTree('bridge-sem-repo-');
  writeFileSync(join(dir, '.git'), 'isto nao e um repositorio\n', 'utf8');
  return dir;
}

/** Repo temporário com um commit inicial, em `<tmp com espaço>/meu repo`. */
function makeRepo(): string {
  const root = join(tmpTree(), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'leiame.md'), 'ola\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

function commitFile(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), body, 'utf8');
  git(cwd, ['add', name]);
  git(cwd, ['commit', '-m', `add ${name}`]);
}

function waitFor(check: () => boolean, timeoutMs = 15000, intervalMs = 50): Promise<void> {
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

const AUTH = { authorization: 'Bearer T' };

function newCore(): Core {
  return createCore({ profileDir: tmpProfile(), dbPath: ':memory:', port: 0, token: 'T' });
}

interface WorkspaceBody {
  id: string;
  name: string;
  cwd: string;
  repoId?: string;
  branch?: string;
  worktree?: { base: string; path: string; baseGuessed?: boolean };
}

interface TaskBody {
  workspace: WorkspaceBody;
  tab: { id: string };
  pane: { id: string };
  session?: { id: string };
}

interface GitStatusBody {
  branch: string;
  base?: string;
  ahead: number;
  dirty: number;
  at: number;
}

async function createTask(
  core: Core,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: TaskBody & { error?: string; code?: string; detail?: string } }> {
  const res = await core.app.inject({ method: 'POST', url: '/api/tasks', headers: AUTH, payload });
  return { statusCode: res.statusCode, body: res.json() };
}

async function gitOf(core: Core, workspaceId: string): Promise<{ statusCode: number; body: GitStatusBody & { code?: string } }> {
  const res = await core.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/git`, headers: AUTH });
  return { statusCode: res.statusCode, body: res.json() };
}

afterAll(() => {
  for (const dir of trees) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // pasta travada por antivírus/git: é temp, o SO limpa depois.
    }
  }
});

describe('POST /api/workspaces detecta o repo (spec §7)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('pasta de repo → workspace com repoId e branch; GET /api/repos lista o repo principal', async () => {
    core = newCore();
    const repo = makeRepo();

    const res = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: repo } });
    expect(res.statusCode).toBe(201);
    const { workspace } = res.json() as { workspace: WorkspaceBody };
    expect(workspace.branch).toBe('main');
    expect(workspace.repoId).toBeTruthy();
    expect(workspace.worktree).toBeUndefined();

    const repos = await core.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH });
    const list = repos.json() as Array<{ id: string; path: string; name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(workspace.repoId);
    expect(list[0]!.name).toBe('meu repo');

    // O snapshot leva os campos junto (é o que a sidebar lê).
    const state = await core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const snap = state.json() as { layout: { workspaces: WorkspaceBody[]; repos: unknown[] }; git: Record<string, unknown> };
    expect(snap.layout.workspaces[0]!.branch).toBe('main');
    expect(snap.layout.repos).toHaveLength(1);
    expect(snap.git).toEqual({});
  });

  it('pasta fora de repo → workspace sem repoId/branch e nenhum repo na tabela', async () => {
    core = newCore();
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const { workspace } = res.json() as { workspace: WorkspaceBody };
    expect(workspace.repoId).toBeUndefined();
    expect(workspace.branch).toBeUndefined();

    const repos = await core.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH });
    expect(repos.json()).toEqual([]);
  });

  it('dois workspaces no mesmo repo reaproveitam o MESMO registro de repo', async () => {
    core = newCore();
    const repo = makeRepo();
    const a = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: repo } });
    const b = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: repo } });
    const repoA = (a.json() as { workspace: WorkspaceBody }).workspace.repoId;
    const repoB = (b.json() as { workspace: WorkspaceBody }).workspace.repoId;
    expect(repoA).toBe(repoB);

    const repos = await core.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH });
    expect(repos.json()).toHaveLength(1);
  });

  it('GET /api/git/detect devolve o RepoInfo da pasta, null fora de repo e 400 sem cwd', async () => {
    core = newCore();
    const repo = makeRepo();

    const ok = await core.app.inject({ method: 'GET', url: `/api/git/detect?cwd=${encodeURIComponent(repo)}`, headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ branch: 'main', isWorktree: false });

    const fora = await core.app.inject({
      method: 'GET',
      url: `/api/git/detect?cwd=${encodeURIComponent(notRepoTree())}`,
      headers: AUTH,
    });
    expect(fora.statusCode).toBe(200);
    expect(fora.json()).toBeNull();

    const semCwd = await core.app.inject({ method: 'GET', url: '/api/git/detect', headers: AUTH });
    expect(semCwd.statusCode).toBe(400);
  });
});

describe('POST /api/tasks (worktree por tarefa)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('cria worktree + workspace com worktree.base e +0 ~0 em GET /api/workspaces/:id/git', async () => {
    core = newCore();
    const repo = makeRepo();

    const res = await createTask(core, { repoPath: repo, name: 'Feat Mailbox!' });
    expect(res.statusCode).toBe(201);
    const { workspace, tab, pane } = res.body;
    expect(workspace.name).toBe('feat-mailbox');
    expect(workspace.branch).toBe('feat-mailbox');
    expect(workspace.worktree?.base).toBe('main');
    expect(existsSync(join(repo, '.worktrees', 'feat-mailbox'))).toBe(true);
    expect(tab.id).toBeTruthy();
    expect(pane.id).toBeTruthy();
    expect(res.body.session).toBeUndefined();

    const st = await gitOf(core, workspace.id);
    expect(st.statusCode).toBe(200);
    expect(st.body).toMatchObject({ branch: 'feat-mailbox', base: 'main', ahead: 0, dirty: 0 });

    // O repo do worktree é o PRINCIPAL (é onde merge/remoção rodam).
    const repos = await core.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH });
    const list = repos.json() as Array<{ id: string; path: string }>;
    expect(list).toHaveLength(1);
    expect(workspace.repoId).toBe(list[0]!.id);
  }, 40_000);

  it('aceita repoId de um repo já conhecido e um base explícito', async () => {
    core = newCore();
    const repo = makeRepo();
    git(repo, ['branch', 'dev']);
    const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: repo } });
    const repoId = (ws.json() as { workspace: WorkspaceBody }).workspace.repoId!;

    const res = await createTask(core, { repoId, name: 'tarefa-dev', base: 'dev' });
    expect(res.statusCode).toBe(201);
    expect(res.body.workspace.worktree?.base).toBe('dev');
  }, 40_000);

  it('nome duplicado → 409 { code: "exists" }', async () => {
    core = newCore();
    const repo = makeRepo();

    expect((await createTask(core, { repoPath: repo, name: 'dup' })).statusCode).toBe(201);
    const segunda = await createTask(core, { repoPath: repo, name: 'dup' });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.body.code).toBe('exists');
    expect(segunda.body.error).toBeTruthy();
  }, 40_000);

  /**
   * Fix round 1, achado 2: o `worktree add` acontece ANTES do workspace
   * existir. Se a montagem do workspace falhar, a pasta e o branch não podem
   * ficar no repo do usuário — a próxima tentativa com o mesmo nome bateria em
   * `exists` por causa de um erro do Bridge.
   */
  it('falha ao montar o workspace desfaz o worktree órfão (pasta e branch somem)', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();

    const real = c.deps.layout.createWorkspace.bind(c.deps.layout);
    c.deps.layout.createWorkspace = () => {
      throw new Error('banco caiu no meio');
    };

    try {
      const res = await createTask(c, { repoPath: repo, name: 'orfa' });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(existsSync(join(repo, '.worktrees', 'orfa'))).toBe(false);
      expect(git(repo, ['branch', '--list', 'orfa']).trim()).toBe('');
      expect(git(repo, ['worktree', 'list'])).not.toContain('orfa');
    } finally {
      c.deps.layout.createWorkspace = real;
    }

    // E o nome volta a estar livre: o usuário tenta de novo e funciona.
    const retry = await createTask(c, { repoPath: repo, name: 'orfa' });
    expect(retry.statusCode).toBe(201);
  }, 60_000);

  it('pasta que não é repo → 422 { code: "not-a-repo" }', async () => {
    core = newCore();
    const res = await createTask(core, { repoPath: notRepoTree(), name: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('not-a-repo');
  });

  it('base inexistente → 422 { code: "git-failed" }', async () => {
    core = newCore();
    const repo = makeRepo();
    const res = await createTask(core, { repoPath: repo, name: 'sem-base', base: 'nao-existe' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('git-failed');
  }, 40_000);

  it('sem repoId nem repoPath → 400; nome que normaliza pra vazio → 422', async () => {
    core = newCore();
    const semRepo = await createTask(core, { name: 'x' });
    expect(semRepo.statusCode).toBe(400);

    const repo = makeRepo();
    const nomeVazio = await createTask(core, { repoPath: repo, name: '!!!' });
    expect(nomeVazio.statusCode).toBe(422);
  }, 40_000);
});

describe('indicadores git: refresh, evento no WS e snapshot', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('commit no worktree + POST git/refresh → ahead 1 e evento workspace.git no WS', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();
    const { port, token } = await c.start();

    const task = await createTask(c, { repoPath: repo, name: 'ahead' });
    const workspaceId = task.body.workspace.id;
    const worktreePath = task.body.workspace.worktree!.path;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages: Array<{ type: string; workspaceId?: string; git?: GitStatusBody; state?: { git?: Record<string, GitStatusBody> } }> = [];
    socket.on('message', (raw: Buffer) => messages.push(JSON.parse(raw.toString('utf8'))));
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });

    try {
      // O hello já traz o mapa de git (com o +0 ~0 calculado na criação).
      const hello = messages.find((m) => m.type === 'hello');
      expect(hello?.state?.git?.[workspaceId]).toMatchObject({ ahead: 0, dirty: 0 });

      commitFile(worktreePath, 'novo.txt', 'conteudo\n');

      const refresh = await c.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/git/refresh`,
        headers: AUTH,
      });
      expect(refresh.statusCode).toBe(204);

      await waitFor(() => messages.some((m) => m.type === 'workspace.git' && m.workspaceId === workspaceId));
      const evento = messages.filter((m) => m.type === 'workspace.git').pop()!;
      expect(evento.git).toMatchObject({ branch: 'ahead', base: 'main', ahead: 1, dirty: 0 });

      const st = await gitOf(c, workspaceId);
      expect(st.body.ahead).toBe(1);

      // Arquivo não commitado entra no `~M`.
      writeFileSync(join(worktreePath, 'sujo.txt'), 'x\n', 'utf8');
      await c.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/git/refresh`, headers: AUTH });
      await waitFor(() => (messages.filter((m) => m.type === 'workspace.git').pop()?.git?.dirty ?? 0) === 1);

      const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
      const snap = state.json() as { git: Record<string, GitStatusBody> };
      expect(snap.git[workspaceId]).toMatchObject({ ahead: 1, dirty: 1 });
    } finally {
      socket.close();
    }
  }, 60_000);

  /**
   * Item 13: aqui `not-worktree` e 404, nao 409 — o cliente pediu um RECURSO
   * que este workspace nao tem (pasta comum nao tem `+N ~M`); nao e uma acao
   * recusada por estado do repo, como em merge/remocao.
   */
  it('GET /api/workspaces/:id/git: 404 desconhecido e 404 not-worktree em workspace comum', async () => {
    core = newCore();
    const naoExiste = await gitOf(core, 'ws_nao_existe');
    expect(naoExiste.statusCode).toBe(404);

    const ws = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const id = (ws.json() as { workspace: WorkspaceBody }).workspace.id;
    const comum = await gitOf(core, id);
    expect(comum.statusCode).toBe(404);
    expect(comum.body.code).toBe('not-worktree');
  });

  /**
   * Item 7: rota SEM corpo tem que aceitar `content-type: application/json`
   * com body vazio — e o que todo `fetch` com `Content-Type` mandado por
   * habito faz, e o parser default do Fastify respondia 400.
   */
  it('POST git/refresh aceita content-type json com corpo vazio; JSON quebrado continua 400', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();
    const task = await createTask(c, { repoPath: repo, name: 'sem-corpo' });
    const workspaceId = task.body.workspace.id;

    const vazio = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/git/refresh`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '',
    });
    expect(vazio.statusCode).toBe(204);

    const quebrado = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/git/refresh`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{ isso nao e json',
    });
    expect(quebrado.statusCode).toBe(400);
  }, 60_000);
});

describe('merge e remoção do worktree (recusas da spec §10)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  async function merge(
    c: Core,
    workspaceId: string,
    mode: 'ff-only' | 'no-ff',
  ): Promise<{ statusCode: number; body: { mode?: string; message?: string; code?: string; detail?: string } }> {
    const res = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/merge`,
      headers: AUTH,
      payload: { mode },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  async function removeWorktree(
    c: Core,
    workspaceId: string,
  ): Promise<{ statusCode: number; body: { code?: string; detail?: string; error?: string } }> {
    const res = await c.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}/worktree`, headers: AUTH });
    return { statusCode: res.statusCode, body: res.statusCode === 204 ? {} : res.json() };
  }

  it('base sujo → 409 dirty-base; limpo → merge ff-only 200; depois DELETE worktree → 204 e o workspace some', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();

    const task = await createTask(c, { repoPath: repo, name: 'merge-ok' });
    const workspaceId = task.body.workspace.id;
    const worktreePath = task.body.workspace.worktree!.path;
    commitFile(worktreePath, 'novo.txt', 'conteudo\n');

    // Base sujo: o merge recusa antes de encostar no git.
    writeFileSync(join(repo, 'leiame.md'), 'mexido\n', 'utf8');
    const sujo = await merge(c, workspaceId, 'ff-only');
    expect(sujo.statusCode).toBe(409);
    expect(sujo.body.code).toBe('dirty-base');

    git(repo, ['checkout', '--', 'leiame.md']);
    const ok = await merge(c, workspaceId, 'ff-only');
    expect(ok.statusCode).toBe(200);
    expect(ok.body.mode).toBe('ff-only');
    expect(git(repo, ['log', '--oneline', '-1'])).toContain('add novo.txt');

    const removido = await removeWorktree(c, workspaceId);
    expect(removido.statusCode).toBe(204);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, ['branch', '--list', 'merge-ok']).trim()).toBe('');

    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const snap = state.json() as { layout: { workspaces: WorkspaceBody[] }; git: Record<string, unknown> };
    expect(snap.layout.workspaces.map((w) => w.id)).not.toContain(workspaceId);
    expect(snap.git[workspaceId]).toBeUndefined();
  }, 60_000);

  it('divergente: ff-only → 409 com code "not-ff"; no-ff → 200 com a mensagem Merge task/<branch>', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();

    const task = await createTask(c, { repoPath: repo, name: 'diverge' });
    const workspaceId = task.body.workspace.id;
    commitFile(task.body.workspace.worktree!.path, 'na-tarefa.txt', 'a\n');
    commitFile(repo, 'no-base.txt', 'b\n');

    // R2: `not-ff` e 409 com `code` proprio — estado do repo, nao pedido malfeito.
    const ff = await merge(c, workspaceId, 'ff-only');
    expect(ff.statusCode).toBe(409);
    expect(ff.body.code).toBe('not-ff');

    const noFf = await merge(c, workspaceId, 'no-ff');
    expect(noFf.statusCode).toBe(200);
    expect(noFf.body).toMatchObject({ mode: 'no-ff', message: 'Merge task/diverge' });
  }, 60_000);

  it('DELETE worktree com alteração não commitada → 409 dirty-worktree; sem merge → 409 not-merged', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();

    const task = await createTask(c, { repoPath: repo, name: 'suja' });
    const workspaceId = task.body.workspace.id;
    const worktreePath = task.body.workspace.worktree!.path;

    commitFile(worktreePath, 'trabalho.txt', 'feito\n');
    writeFileSync(join(worktreePath, 'rascunho.txt'), 'nao commitado\n', 'utf8');

    // A recusa não pode custar a sessão que estava rodando no painel.
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: task.body.pane.id, kind: 'shell' },
    });
    const sessionId = (shell.json() as { id: string }).id;

    const sujo = await removeWorktree(c, workspaceId);
    expect(sujo.statusCode).toBe(409);
    expect(sujo.body.code).toBe('dirty-worktree');
    expect(existsSync(worktreePath)).toBe(true);
    expect(c.deps.pty.alive(sessionId)).toBe(true);

    rmSync(join(worktreePath, 'rascunho.txt'));
    const naoMesclado = await removeWorktree(c, workspaceId);
    expect(naoMesclado.statusCode).toBe(409);
    expect(naoMesclado.body.code).toBe('not-merged');
    // A recusa é decidida ANTES de matar as sessões: o agente do painel
    // continua vivo (fix round 1, achado 1).
    expect(c.deps.pty.alive(sessionId)).toBe(true);

    // O workspace continua de pé nas duas recusas.
    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect((state.json() as { layout: { workspaces: WorkspaceBody[] } }).layout.workspaces.map((w) => w.id)).toContain(
      workspaceId,
    );

    // Depois do merge a remoção passa — e aí, sim, a sessão morre junto.
    const merged = await merge(c, workspaceId, 'ff-only');
    expect(merged.statusCode).toBe(200);
    const removido = await removeWorktree(c, workspaceId);
    expect(removido.statusCode).toBe(204);
    expect(c.deps.pty.alive(sessionId)).toBe(false);
    expect(c.deps.sessions.get(sessionId)).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
  }, 60_000);

  it('merge/DELETE worktree em workspace comum → 409 not-worktree; desconhecido → 404', async () => {
    core = newCore();
    const c = core;
    const ws = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const id = (ws.json() as { workspace: WorkspaceBody }).workspace.id;

    const m = await merge(c, id, 'ff-only');
    expect(m.statusCode).toBe(409);
    expect(m.body.code).toBe('not-worktree');

    const d = await removeWorktree(c, id);
    expect(d.statusCode).toBe(409);
    expect(d.body.code).toBe('not-worktree');

    expect((await merge(c, 'ws_nao_existe', 'ff-only')).statusCode).toBe(404);
    expect((await removeWorktree(c, 'ws_nao_existe')).statusCode).toBe(404);
  });

  it('DELETE worktree mata as sessões do workspace antes de remover', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();

    const task = await createTask(c, { repoPath: repo, name: 'com-sessao' });
    const workspaceId = task.body.workspace.id;
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: task.body.pane.id, kind: 'shell' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;

    const res = await removeWorktree(c, workspaceId);
    expect(res.statusCode).toBe(204);
    expect(c.deps.pty.alive(sessionId)).toBe(false);
    expect(c.deps.sessions.get(sessionId)).toBeUndefined();
  }, 60_000);
});

describe('POST /api/sessions com initialCommand ("Ver diff")', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('escreve o comando no PTY e a saída aparece no scrollback', async () => {
    core = newCore();
    const c = core;
    const ws = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const paneId = (ws.json() as { pane: { id: string } }).pane.id;

    const res = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell', initialCommand: 'echo bridge-init' },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = (res.json() as { id: string }).id;

    await waitFor(() => c.deps.pty.scrollback(sessionId).includes('bridge-init'), 25_000);
    expect(c.deps.pty.scrollback(sessionId)).toContain('bridge-init');
  }, 40_000);

  /**
   * R10 — o gatilho e o PRIMEIRO byte do PTY, nao um timer cego. Numa maquina
   * carregada o pwsh leva bem mais que 200 ms pra desenhar o prompt, e a linha
   * escrita antes disso e engolida pela metade (o "Ver diff" abria um painel
   * com `it diff …`). Em cima do gatilho fica o piso de 200 ms.
   */
  it('escreve o comando SO depois do primeiro onData do PTY, respeitando o piso de 200 ms', async () => {
    core = newCore();
    const c = core;
    const ws = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const paneId = (ws.json() as { pane: { id: string } }).pane.id;

    let primeiroDataAt: number | undefined;
    c.deps.bus.on((e) => {
      if (e.type === 'pty.data' && primeiroDataAt === undefined) primeiroDataAt = Date.now();
    });

    const escritas: Array<{ data: string; at: number }> = [];
    const write = c.deps.pty.write.bind(c.deps.pty);
    c.deps.pty.write = (sessionId: string, data: string): void => {
      escritas.push({ data, at: Date.now() });
      write(sessionId, data);
    };

    const spawnAt = Date.now();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell', initialCommand: 'echo bridge-r10' },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = (res.json() as { id: string }).id;

    await waitFor(() => escritas.length > 0, 25_000);
    const escrita = escritas[0]!;
    expect(escrita.data).toBe('echo bridge-r10\r');
    // Veio DEPOIS do primeiro byte do shell, e nao antes dos 200 ms de piso.
    expect(primeiroDataAt).toBeDefined();
    expect(escrita.at).toBeGreaterThanOrEqual(primeiroDataAt!);
    expect(escrita.at - spawnAt).toBeGreaterThanOrEqual(200);

    // E o comando roda de verdade, inteiro.
    await waitFor(() => c.deps.pty.scrollback(sessionId).includes('bridge-r10'), 25_000);
  }, 60_000);

  it('initialCommand acima de 2000 chars → 400', async () => {
    core = newCore();
    const c = core;
    const ws = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const paneId = (ws.json() as { pane: { id: string } }).pane.id;

    const res = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell', initialCommand: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('R1/R7/R3 pela API: recusas de merge, repo sem commit e "Definir base…"', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /**
   * R1 — o Bridge nao troca o checkout do repo do usuario. A recusa vem com
   * `code` proprio e diz em que branch o principal esta.
   */
  it('merge com o principal em outro branch → 409 base-not-checked-out', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();
    const task = await createTask(c, { repoPath: repo, name: 'r1' });
    commitFile(task.body.workspace.worktree!.path, 'x.txt', 'x\n');
    git(repo, ['checkout', '-b', 'desvio']);

    const res = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${task.body.workspace.id}/merge`,
      headers: AUTH,
      payload: { mode: 'ff-only' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code?: string; error?: string };
    expect(body.code).toBe('base-not-checked-out');
    expect(body.error).toContain('desvio');
    // O checkout do usuario continua onde estava.
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('desvio');
  }, 60_000);

  /**
   * R7 — repo sem commit nenhum: nem vira origem de tarefa, nem entra na lista
   * de repositorios (era assim que `%USERPROFILE%` aparecia em GET /api/repos,
   * porque o `%TEMP%` desta maquina mora dentro dele).
   */
  it('repo sem commit: POST /api/tasks → 422 no-commits e GET /api/repos continua vazio', async () => {
    core = newCore();
    const c = core;
    const vazio = join(tmpTree(), 'repo sem commit');
    mkdirSync(vazio);
    git(vazio, ['init', '-b', 'main']);

    const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: vazio } });
    expect(ws.statusCode).toBe(201);
    expect((ws.json() as { workspace: WorkspaceBody }).workspace.repoId).toBeUndefined();

    const repos = await c.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH });
    expect(repos.json()).toEqual([]);

    const res = await createTask(c, { repoPath: vazio, name: 'nao-vai' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('no-commits');
    expect(res.body.error).toContain('commit');
  }, 60_000);

  /**
   * Fase 4 T5 (higiene): o `repoId` não pode ser o caminho de fuga do R7. Uma
   * linha de `repos` gravada por uma versão anterior do Bridge — antes do
   * `hasCommits` existir — aponta pra um repo que pode nunca ter tido commit;
   * `resolveRepo` reconfere no DISCO em vez de confiar na linha.
   */
  it('repoId de linha legada apontando pra repo sem commit → 422 no-commits', async () => {
    core = newCore();
    const c = core;
    const vazio = join(tmpTree(), 'repo legado sem commit');
    mkdirSync(vazio);
    git(vazio, ['init', '-b', 'main']);

    // A linha é escrita DIRETO no banco: pela rota normal ela nem nasceria
    // (`createWorkspace` já recusa repo sem commit desde o R7) — é
    // exatamente o resíduo de perfil antigo que se está reproduzindo.
    c.deps.db.repos.upsert({ id: 'repo_legado', path: vazio, name: 'repo legado sem commit' , trustFilters: false });
    expect(c.deps.db.repos.list().map((r) => r.id)).toContain('repo_legado');

    const res = await createTask(c, { repoId: 'repo_legado', name: 'nao-vai' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('no-commits');
    // E nada foi criado no repo do usuário.
    expect(existsSync(join(vazio, '.worktrees'))).toBe(false);
  }, 60_000);

  /**
   * R3 — worktree ADOTADO (a pasta ja existia). Sem upstream, o base e o
   * branch corrente do principal e vem marcado como deduzido; o
   * `PATCH .../worktree` troca por um ref de verdade e tira a marca.
   */
  it('worktree adotado nasce com baseGuessed; PATCH /worktree troca o base e valida o ref', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();
    git(repo, ['branch', 'dev']);
    // Worktree criado FORA do Bridge: e o caso do "adotado".
    git(repo, ['worktree', 'add', '.worktrees/adotada', '-b', 'adotada', 'main']);
    const worktreePath = join(repo, '.worktrees', 'adotada');

    const ws = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: worktreePath },
    });
    const workspace = (ws.json() as { workspace: WorkspaceBody }).workspace;
    expect(workspace.worktree?.base).toBe('main');
    expect(workspace.worktree?.baseGuessed).toBe(true);

    const ruim = await c.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}/worktree`,
      headers: AUTH,
      payload: { base: 'nao-existe' },
    });
    expect(ruim.statusCode).toBe(422);
    expect((ruim.json() as { code?: string }).code).toBe('unknown-ref');

    const ok = await c.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}/worktree`,
      headers: AUTH,
      payload: { base: 'dev' },
    });
    expect(ok.statusCode).toBe(200);
    const atualizado = ok.json() as WorkspaceBody;
    expect(atualizado.worktree?.base).toBe('dev');
    expect(atualizado.worktree?.baseGuessed).toBeUndefined();

    // Workspace comum nao tem worktree pra redefinir.
    const comum = await c.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: notRepoTree() },
    });
    const comumId = (comum.json() as { workspace: WorkspaceBody }).workspace.id;
    const recusa = await c.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${comumId}/worktree`,
      headers: AUTH,
      payload: { base: 'main' },
    });
    expect(recusa.statusCode).toBe(409);
    expect((recusa.json() as { code?: string }).code).toBe('not-worktree');
  }, 60_000);

  /**
   * R4 — o branch vem do disco. Trocar de branch dentro do worktree pelo
   * terminal tem que refletir no workspace (o poller grava) e o merge tem que
   * mesclar o branch de AGORA, nao o gravado na criacao.
   */
  it('branch trocado dentro do worktree: o refresh grava o branch novo e o merge usa ele', async () => {
    core = newCore();
    const c = core;
    const repo = makeRepo();
    const task = await createTask(c, { repoPath: repo, name: 'r4' });
    const workspaceId = task.body.workspace.id;
    const worktreePath = task.body.workspace.worktree!.path;

    git(worktreePath, ['checkout', '-b', 'r4-outro']);
    commitFile(worktreePath, 'novo.txt', 'n\n');

    const refresh = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/git/refresh`,
      headers: AUTH,
    });
    expect(refresh.statusCode).toBe(204);
    expect(c.deps.db.workspaces.get(workspaceId)!.branch).toBe('r4-outro');
    expect((await gitOf(c, workspaceId)).body.branch).toBe('r4-outro');

    const merge = await c.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/merge`,
      headers: AUTH,
      payload: { mode: 'ff-only' },
    });
    expect(merge.statusCode).toBe(200);
    // Mesclou o branch de AGORA: o arquivo dele esta no base.
    expect(existsSync(join(repo, 'novo.txt'))).toBe(true);
  }, 60_000);
});
