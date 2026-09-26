import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FOCUS_FRESH_MS, createCore, shouldPollGit } from '../src/core.js';
import type { Core } from '../src/core.js';
import { startGitPoller } from '../src/gitPoller.js';
import type { BridgeEvent } from '../src/events.js';

/**
 * O poller é o que mantém `+N ~M` vivo na sidebar. As duas regras que ele
 * NÃO pode quebrar: só emite quando o número mudou (senão a UI redesenha a
 * cada 15 s à toa) e não roda nenhum `git` quando não há cliente olhando.
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

function tmpTree(prefix = 'bridge poller '): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

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

function waitFor(check: () => boolean, timeoutMs = 15000, intervalMs = 25): Promise<void> {
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

interface GitEvent {
  workspaceId: string;
  git: { branch: string; ahead: number; dirty: number };
}

function gitEvents(seen: BridgeEvent[]): GitEvent[] {
  return seen.filter((e): e is BridgeEvent & GitEvent & { type: 'workspace.git' } => e.type === 'workspace.git');
}

afterAll(() => {
  for (const dir of trees) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // temp travado por antivírus: o SO limpa depois.
    }
  }
});

describe('startGitPoller', () => {
  let core: Core | undefined;
  let stopPoller: (() => void) | undefined;

  afterEach(async () => {
    stopPoller?.();
    stopPoller = undefined;
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /** Core + tarefa (worktree) pronta, com o poller EMBUTIDO do core desligado. */
  async function coreComTarefa(): Promise<{ c: Core; workspaceId: string; worktreePath: string; repo: string }> {
    const c = createCore({ profileDir: tmpTree('bridge-poller-profile-'), dbPath: ':memory:', port: 0, token: 'T' });
    core = c;
    const repo = makeRepo();
    const task = await c.createTask({ repoPath: repo, name: 'poll' });
    // `createTask` já deixa o `+0 ~0` no cache (é o que a sidebar mostra na
    // hora). Estes testes exercitam o poller do ZERO, então o cache volta a
    // ficar vazio antes de cada um.
    c.deps.gitStatus.clear();
    return { c, workspaceId: task.workspace.id, worktreePath: task.workspace.worktree!.path, repo };
  }

  /**
   * `PATCH /api/config` com `gitPollSeconds` (Task 5): o intervalo troca com o
   * poller já rodando. Sem reagendar, o timer em voo ainda carrega o valor
   * antigo — num intervalo de 120 s a mudança só apareceria dois minutos
   * depois. Aqui: com 60 s nada roda; ao cair pra 20 ms, roda quase na hora.
   */
  it('setIntervalMs troca o intervalo e reagenda o timer em voo', async () => {
    const c = createCore({ profileDir: tmpTree('bridge-poller-profile-'), dbPath: ':memory:', port: 0, token: 'T' });
    core = c;
    let ticks = 0;
    const poller = startGitPoller({
      core: c,
      intervalMs: 60_000,
      hasClients: () => {
        ticks += 1;
        return false;
      },
    });
    stopPoller = poller.stop;

    expect(poller.intervalMs).toBe(60_000);
    await new Promise((res) => setTimeout(res, 120));
    expect(ticks).toBe(0);

    poller.setIntervalMs(20);
    expect(poller.intervalMs).toBe(20);
    await waitFor(() => ticks > 0);
  }, 30_000);

  it('emite workspace.git só quando ahead/dirty/branch mudam', async () => {
    const { c, workspaceId, worktreePath } = await coreComTarefa();
    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => true });
    stopPoller = poller.stop;

    // Primeira leitura desta instância: emite (a UI ainda não sabe de nada).
    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(1);
    expect(gitEvents(seen)[0]).toMatchObject({ workspaceId, git: { ahead: 0, dirty: 0 } });

    // Nada mudou no disco: silêncio, mesmo com o `at` novo.
    await poller.tick();
    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(1);

    commitFile(worktreePath, 'novo.txt', 'x\n');
    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(2);
    expect(gitEvents(seen)[1]!.git).toMatchObject({ ahead: 1, dirty: 0 });

    writeFileSync(join(worktreePath, 'sujo.txt'), 'y\n', 'utf8');
    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(3);
    expect(gitEvents(seen)[2]!.git).toMatchObject({ ahead: 1, dirty: 1 });

    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(3);
  }, 60_000);

  it('não roda nada enquanto hasClients() é false; volta a rodar quando há cliente', async () => {
    const { c, workspaceId, worktreePath } = await coreComTarefa();
    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    let clientes = false;
    const poller = startGitPoller({ core: c, intervalMs: 20, hasClients: () => clientes });
    stopPoller = poller.stop;

    commitFile(worktreePath, 'novo.txt', 'x\n');
    await new Promise((res) => setTimeout(res, 300));
    expect(gitEvents(seen)).toHaveLength(0);
    expect(c.deps.gitStatus.get(workspaceId)).toBeUndefined();

    clientes = true;
    await waitFor(() => gitEvents(seen).length === 1);
    expect(gitEvents(seen)[0]!.git).toMatchObject({ ahead: 1 });
    expect(c.deps.gitStatus.get(workspaceId)).toMatchObject({ ahead: 1 });

    // Sem mudança no disco, o timer continua girando sem emitir nada.
    await new Promise((res) => setTimeout(res, 200));
    expect(gitEvents(seen)).toHaveLength(1);
  }, 60_000);

  it('refresh(id) é imediato e vale mesmo sem cliente conectado (hook Stop)', async () => {
    const { c, workspaceId, worktreePath } = await coreComTarefa();
    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => false });
    stopPoller = poller.stop;

    commitFile(worktreePath, 'novo.txt', 'x\n');
    const st = await poller.refresh(workspaceId);
    expect(st).toMatchObject({ ahead: 1, dirty: 0 });
    expect(gitEvents(seen)).toHaveLength(1);
  }, 60_000);

  /**
   * Fix round 1: `refresh` (hook `Stop`, rota) e o `tick` do timer chegam do
   * nada um em cima do outro. Sem dedupe, os dois leem o mesmo worktree com o
   * cache ainda vazio e a MESMA mudança vira dois `workspace.git`.
   */
  it('refresh e tick simultâneos leem uma vez só (dedupe por workspace)', async () => {
    const { c, workspaceId, worktreePath } = await coreComTarefa();
    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => true });
    stopPoller = poller.stop;

    commitFile(worktreePath, 'novo.txt', 'x\n');
    const [doRefresh] = await Promise.all([poller.refresh(workspaceId), poller.tick()]);

    expect(doRefresh).toMatchObject({ ahead: 1 });
    expect(gitEvents(seen)).toHaveLength(1);
    expect(c.deps.gitStatus.get(workspaceId)).toMatchObject({ ahead: 1 });
  }, 60_000);

  it('stop() para o timer; workspace sem worktree é ignorado', async () => {
    const { c } = await coreComTarefa();
    const semRepo = tmpTree('bridge-sem-repo-');
    writeFileSync(join(semRepo, '.git'), 'isto nao e um repositorio\n', 'utf8');
    const comum = await c.createWorkspace({ cwd: semRepo });

    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 20, hasClients: () => true });
    stopPoller = poller.stop;
    await waitFor(() => gitEvents(seen).length === 1);
    expect(gitEvents(seen).every((e) => e.workspaceId !== comum.workspace.id)).toBe(true);
    expect(await poller.refresh(comum.workspace.id)).toBeUndefined();

    poller.stop();
    const depois = gitEvents(seen).length;
    await new Promise((res) => setTimeout(res, 200));
    expect(gitEvents(seen)).toHaveLength(depois);
  }, 60_000);
});

describe('shouldPollGit (R5)', () => {
  const agora = 1_000_000;

  it('exige cliente que receba workspace.git E janela em foco recente', () => {
    const foco = { windowFocused: true, at: agora };
    expect(shouldPollGit({ gitClients: 1 }, foco, agora)).toBe(true);
    // O main do Electron conecta com filtro que corta `workspace.*`: ele nao
    // conta, e sozinho nao autoriza `git` nenhum.
    expect(shouldPollGit({ gitClients: 0 }, foco, agora)).toBe(false);
    expect(shouldPollGit({ gitClients: 1 }, { windowFocused: false, at: agora }, agora)).toBe(false);
  });

  it('foco velho nao vale: um blur perdido nao deixa o poller rodando pra sempre', () => {
    const foco = { windowFocused: true, at: agora };
    expect(shouldPollGit({ gitClients: 1 }, foco, agora + FOCUS_FRESH_MS - 1)).toBe(true);
    expect(shouldPollGit({ gitClients: 1 }, foco, agora + FOCUS_FRESH_MS)).toBe(false);
    // Nunca houve `POST /api/focus`: sem `at`, nao roda.
    expect(shouldPollGit({ gitClients: 1 }, { windowFocused: true }, agora)).toBe(false);
  });
});

describe('poller: encadeamento (R6), branch do disco (R4) e pasta sumida', () => {
  let core: Core | undefined;
  let stopPoller: (() => void) | undefined;

  afterEach(async () => {
    stopPoller?.();
    stopPoller = undefined;
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /**
   * R6 — o hook `Stop` chega DEPOIS do commit do agente, mas pode cair no meio
   * de uma leitura que comecou antes dele. Devolver o resultado daquela
   * leitura mostraria na sidebar o estado de ANTES do commit; o refresh
   * encadeia uma segunda leitura e devolve a dela.
   */
  it('refresh que chega no meio de uma leitura encadeia outra e devolve a segunda', async () => {
    const c = createCore({ profileDir: tmpTree('bridge-poller-profile-'), dbPath: ':memory:', port: 0, token: 'T' });
    core = c;
    const repo = makeRepo();
    const task = await c.createTask({ repoPath: repo, name: 'encadeia' });
    const workspaceId = task.workspace.id;
    c.deps.gitStatus.clear();

    const leituras: number[] = [];
    let liberaPrimeira: (() => void) | undefined;
    const readStatus = async (): Promise<{ branch: string; base: string; ahead: number; dirty: number; at: number }> => {
      const n = leituras.length;
      leituras.push(n);
      if (n === 0) await new Promise<void>((res) => (liberaPrimeira = res));
      return { branch: 'encadeia', base: 'main', ahead: n, dirty: 0, at: Date.now() };
    };

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => true, readStatus });
    stopPoller = poller.stop;

    const primeira = poller.tick();
    await waitFor(() => leituras.length === 1);
    const doRefresh = poller.refresh(workspaceId);
    // A segunda leitura so comeca quando a primeira termina.
    expect(leituras).toHaveLength(1);
    liberaPrimeira!();
    await primeira;

    expect(await doRefresh).toMatchObject({ ahead: 1 });
    expect(leituras).toHaveLength(2);
  }, 60_000);

  /**
   * R4 — o usuario troca de branch dentro do worktree pelo terminal. O poller
   * e quem percebe: ele grava o branch novo no workspace (a sidebar le dali) e
   * emite `workspace.git`.
   */
  it('branch trocado no worktree: o poller grava o branch novo no workspace', async () => {
    const c = createCore({ profileDir: tmpTree('bridge-poller-profile-'), dbPath: ':memory:', port: 0, token: 'T' });
    core = c;
    const repo = makeRepo();
    const task = await c.createTask({ repoPath: repo, name: 'troca' });
    const workspaceId = task.workspace.id;
    const worktreePath = task.workspace.worktree!.path;
    c.deps.gitStatus.clear();

    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => true });
    stopPoller = poller.stop;

    await poller.tick();
    expect(c.deps.db.workspaces.get(workspaceId)!.branch).toBe('troca');

    git(worktreePath, ['checkout', '-b', 'troca-2']);
    await poller.tick();

    expect(c.deps.db.workspaces.get(workspaceId)!.branch).toBe('troca-2');
    expect(gitEvents(seen).pop()!.git.branch).toBe('troca-2');
    // O worktree continua sendo o mesmo: so o branch mudou.
    expect(c.deps.db.workspaces.get(workspaceId)!.worktree!.path).toBe(worktreePath);
  }, 60_000);

  /**
   * Item 13 — a pasta do worktree pode sumir por fora. Os numeros nao existem
   * nesse estado: o poller marca `error: 'missing'` (a UI mostra "(pasta
   * sumiu)") em vez de tentar um `git` que vai falhar a cada 15 s.
   */
  it('pasta do worktree apagada por fora → git com error missing', async () => {
    const c = createCore({ profileDir: tmpTree('bridge-poller-profile-'), dbPath: ':memory:', port: 0, token: 'T' });
    core = c;
    const repo = makeRepo();
    const task = await c.createTask({ repoPath: repo, name: 'some' });
    const workspaceId = task.workspace.id;
    const worktreePath = task.workspace.worktree!.path;
    c.deps.gitStatus.clear();

    const seen: BridgeEvent[] = [];
    c.deps.bus.on((e) => seen.push(e));

    const poller = startGitPoller({ core: c, intervalMs: 60_000, hasClients: () => true });
    stopPoller = poller.stop;
    await poller.tick();
    expect(c.deps.gitStatus.get(workspaceId)!.error).toBeUndefined();

    rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
    await poller.tick();

    const st = c.deps.gitStatus.get(workspaceId)!;
    expect(st.error).toBe('missing');
    expect(st.ahead).toBe(0);
    expect(st.dirty).toBe(0);
    expect(gitEvents(seen).pop()).toMatchObject({ workspaceId });
    // Sem `git` nenhum rodando em cima da pasta que nao existe: o estado se
    // mantem estavel e nao emite de novo.
    const antes = gitEvents(seen).length;
    await poller.tick();
    expect(gitEvents(seen)).toHaveLength(antes);
  }, 60_000);
});
