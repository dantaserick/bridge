/**
 * Fix round 4 — os dois caminhos de BR-03 que sobraram do re-review.
 *
 * 1. `POST /api/tasks` → `git worktree add` faz CHECKOUT, e checkout roda o
 *    `smudge` do driver do repositório. Pior: o dono não tinha como confiar
 *    antes, porque o item de menu só aparecia quando o `GitStatus` denunciava —
 *    e o poller só calcula status de WORKTREE, que é exatamente o que a tarefa
 *    ia criar.
 * 2. Submódulo: a config dele mora em `.git/modules/<sub>/config`, invisível
 *    para a enumeração do superprojeto.
 *
 * Todo repo é temporário e some no `afterEach`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { invalidateFilterCache, listFilterDrivers, parseSubmodulePaths, status } from '../src/git.js';
import type { Repo } from '../src/model.js';

const AUTH = { authorization: 'Bearer T' };
const trees: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

function cleanup(): void {
  invalidateFilterCache();
  for (const dir of trees.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // pasta travada por antivírus: é temp, o SO limpa depois.
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
}

/** Caminho no formato que o `sh` do git entende. */
function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Repo cujo `smudge` escreve um marcador. O `smudge` roda no CHECKOUT — que é
 * o que o `git worktree add` faz.
 */
function repoComSmudge(): { root: string; marker: string } {
  const root = join(tmp('bridge r4 git '), 'meu repo');
  initRepo(root);
  writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  const marker = join(root, 'marker-smudge.txt');
  git(root, ['config', 'filter.evil.smudge', `sh -c "echo SMUDGE > '${shPath(marker)}'; cat"`]);
  return { root, marker };
}

async function repoDoWorkspace(core: Core, cwd: string): Promise<Repo> {
  await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
  const repos = (await core.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH })).json() as Repo[];
  const repo = repos.find((r) => r.path.toLowerCase().replace(/\//g, '\\') === cwd.toLowerCase().replace(/\//g, '\\'));
  return repo ?? repos[0]!;
}

describe('fix round 4 — POST /api/tasks e o smudge do worktree add', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    cleanup();
  });

  it('repo NÃO confiado: a tarefa é 409 `filters-untrusted` e nada é feito checkout', async () => {
    const { root, marker } = repoComSmudge();
    core = createCore({ profileDir: tmp('bridge-r4-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    await repoDoWorkspace(c, root);

    const res = await c.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: root, name: 'tarefa' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('filters-untrusted');
    // O `smudge` não rodou...
    expect(existsSync(marker)).toBe(false);
    // ...e o worktree não nasceu.
    expect(existsSync(join(root, '.worktrees', 'tarefa'))).toBe(false);
  }, 30000);

  it('depois de confiar, a mesma tarefa é criada', async () => {
    const { root } = repoComSmudge();
    core = createCore({ profileDir: tmp('bridge-r4-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const repo = await repoDoWorkspace(c, root);

    const confiado = await c.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repo.id}`,
      headers: AUTH,
      payload: { trustFilters: true },
    });
    expect(confiado.statusCode).toBe(200);

    const res = await c.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: root, name: 'tarefa' },
    });

    expect(res.statusCode).toBe(201);
    expect(existsSync(join(root, '.worktrees', 'tarefa'))).toBe(true);
  }, 40000);

  /**
   * O buraco de usabilidade que fazia o bloqueio virar beco sem saída: num
   * workspace de RAIZ o poller não calcula `GitStatus`, então nada denunciava o
   * repo e o item "Confiar nos filtros…" nunca aparecia.
   */
  it('workspace de RAIZ de um repo com driver expõe hasFilterDrivers no /api/state', async () => {
    const { root } = repoComSmudge();
    core = createCore({ profileDir: tmp('bridge-r4-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const repo = await repoDoWorkspace(c, root);
    // A medição roda em segundo plano na adoção do repo.
    await c.refreshRepoFilters(repo.id);

    const state = (await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json() as {
      layout: { repos: Repo[] };
    };
    const visto = state.layout.repos.find((r) => r.id === repo.id);

    expect(visto?.hasFilterDrivers).toBe(true);
    expect(visto?.trustFilters).toBe(false);
  }, 30000);

  it('repo SEM driver não é marcado (nem menu, nem selo)', async () => {
    const root = join(tmp('bridge r4 limpo '), 'meu repo');
    initRepo(root);
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);
    core = createCore({ profileDir: tmp('bridge-r4-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const repo = await repoDoWorkspace(c, root);
    await c.refreshRepoFilters(repo.id);

    const state = (await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json() as {
      layout: { repos: Repo[] };
    };
    expect(state.layout.repos.find((r) => r.id === repo.id)?.hasFilterDrivers).toBe(false);

    // E a tarefa passa sem cerimônia — o modelo de confiança não pode atrapalhar
    // quem não tem filtro nenhum.
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: root, name: 'tarefa' },
    });
    expect(res.statusCode).toBe(201);
  }, 40000);
});

describe('fix round 4 — submódulos', () => {
  afterEach(cleanup);

  it('parseSubmodulePaths lê a saída `-z` (chave e valor separados por quebra de linha)', () => {
    // Fix round 5: o formato passou a ser `<chave>\n<valor>\0`, e é ele que
    // torna o parse imune a espaço no NOME do submódulo.
    const saida = ['submodule.a.path\nlibs/a', 'submodule.x.path\npasta com espaco', ''].join('\0');
    expect(parseSubmodulePaths(saida)).toEqual(['libs/a', 'pasta com espaco']);
  });

  /**
   * O repro do revisor: o driver mora no gitdir do SUBMÓDULO
   * (`.git/modules/<sub>/config`), que a enumeração do superprojeto não
   * enxerga. Antes desta rodada o repo pai passava por "sem filtro" e o
   * `status` do poller rodava — descendo no submódulo.
   */
  it('driver escondido no gitdir do submódulo é detectado pelo repo pai', async () => {
    const base = tmp('bridge r4 sub ');
    const sub = join(base, 'sub');
    const superRoot = join(base, 'super');
    initRepo(sub);
    writeFileSync(join(sub, 's.txt'), 'ssss\n', 'utf8');
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=evilsub\n', 'utf8');
    git(sub, ['add', '.']);
    git(sub, ['commit', '-m', 'sub']);

    initRepo(superRoot);
    writeFileSync(join(superRoot, 'a.txt'), 'aaaa\n', 'utf8');
    git(superRoot, ['add', '.']);
    git(superRoot, ['commit', '-m', 'super']);
    git(superRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', shPath(sub), 'sub']);
    git(superRoot, ['commit', '-m', 'add sub']);
    // O driver vai no gitdir do submódulo — `.git/modules/sub/config`.
    git(join(superRoot, 'sub'), ['config', 'filter.evilsub.clean', 'cat']);

    // CONTROLE: a enumeração só do gitdir do pai NÃO vê (é a cegueira que a
    // rodada 4 fecha).
    const soDoPai = git(superRoot, ['config', '--local', '--includes', '--name-only', '--list']);
    expect(soDoPai).not.toContain('filter.evilsub');

    // E o `listFilterDrivers` do Bridge VÊ, porque desce no submódulo.
    expect(await listFilterDrivers(superRoot)).toContain('evilsub');
  }, 60000);

  it('status do superprojeto sem confiança não roda nada e reporta `filters-untrusted`', async () => {
    const base = tmp('bridge r4 sub2 ');
    const sub = join(base, 'sub');
    const superRoot = join(base, 'super');
    const marker = join(base, 'marker-sub.txt');
    initRepo(sub);
    writeFileSync(join(sub, 's.txt'), 'ssss\n', 'utf8');
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=evilsub\n', 'utf8');
    git(sub, ['add', '.']);
    git(sub, ['commit', '-m', 'sub']);

    initRepo(superRoot);
    writeFileSync(join(superRoot, 'a.txt'), 'aaaa\n', 'utf8');
    git(superRoot, ['add', '.']);
    git(superRoot, ['commit', '-m', 'super']);
    git(superRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', shPath(sub), 'sub']);
    git(superRoot, ['commit', '-m', 'add sub']);
    git(join(superRoot, 'sub'), [
      'config',
      'filter.evilsub.clean',
      `sh -c "echo SUBCLEAN > '${shPath(marker)}'; cat"`,
    ]);
    // Mexe no arquivo do submódulo mantendo o TAMANHO (o caso em que o git
    // precisa comparar conteúdo).
    writeFileSync(join(superRoot, 'sub', 's.txt'), 'tttt\n', 'utf8');

    const result = await status(superRoot, 'main', { trustFilters: false });

    expect(result.error).toBe('filters-untrusted');
    expect(existsSync(marker)).toBe(false);
  }, 60000);

  it('repo sem `.gitmodules` não paga nada e continua sem driver', async () => {
    const root = join(tmp('bridge r4 semsub '), 'meu repo');
    initRepo(root);
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);

    expect(await listFilterDrivers(root)).toEqual([]);
  }, 30000);

  it('`.gitmodules` presente e ilegível é fail-closed', async () => {
    const root = join(tmp('bridge r4 gm '), 'meu repo');
    initRepo(root);
    // Arquivo que o `git config -f` recusa parsear: o git sai != 0 e o
    // `.gitmodules` EXISTE — o desfecho tem que ser "tem driver".
    writeFileSync(join(root, '.gitmodules'), '[submodule "x"\n  path = quebrado\n', 'utf8');
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', 'a.txt']);
    git(root, ['commit', '-m', 'inicial']);

    expect(await listFilterDrivers(root)).not.toEqual([]);
  }, 30000);
});

describe('fix round 4 — GET /api/repos/:id/filters concorda com o status', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    cleanup();
  });

  it('une a raiz com os worktrees (o escopo --worktree é por worktree)', async () => {
    const root = join(tmp('bridge r4 wt '), 'meu repo');
    initRepo(root);
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);
    git(root, ['config', 'filter.naRaiz.clean', 'cat']);
    git(root, ['worktree', 'add', join(root, '.worktrees', 't1'), '-b', 't1', '--', 'main']);
    const wt = join(root, '.worktrees', 't1');
    git(wt, ['config', 'extensions.worktreeConfig', 'true']);
    git(wt, ['config', '--worktree', 'filter.noWorktree.clean', 'cat']);

    core = createCore({ profileDir: tmp('bridge-r4-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const repo = await repoDoWorkspace(c, root);

    const res = await c.app.inject({ method: 'GET', url: `/api/repos/${repo.id}/filters`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    const drivers = (res.json() as { drivers: string[] }).drivers;
    expect(drivers).toContain('naRaiz');
    expect(drivers).toContain('noWorktree');
  }, 60000);
});
