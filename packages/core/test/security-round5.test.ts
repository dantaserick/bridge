/**
 * Fix round 5 — o fechamento do BR-03.
 *
 * Quatro furos que o re-review achou no modelo de confiança já em pé:
 * nome de submódulo com espaço escondia o submódulo; o `.gitmodules` era a
 * única fonte de caminho (gitlink sem entrada lá passava); repo aberto só na
 * RAIZ nunca era remedido depois de um restart; e um `path` hostil no
 * `.gitmodules` levava o `git` pra fora do repositório.
 *
 * Todo repo e perfil é temporário e some no `afterEach`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import {
  SUBMODULE_PATH_INVALID,
  invalidateFilterCache,
  isSafeSubmodulePath,
  listFilterDrivers,
  parseGitlinkPaths,
  parseSubmoduleEntries,
} from '../src/git.js';
import type { Repo } from '../src/model.js';

const AUTH = { authorization: 'Bearer T' };
const trees: string[] = [];
const NUL = '\u0000';

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

function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Superprojeto com um submódulo de NOME arbitrário, já com driver armado. */
function superComSubmodulo(nome: string, caminho: string): { superRoot: string } {
  const base = tmp('bridge r5 ');
  const sub = join(base, 'sub');
  const superRoot = join(base, 'super');

  initRepo(sub);
  writeFileSync(join(sub, 's.txt'), 'ssss\n', 'utf8');
  git(sub, ['add', '.']);
  git(sub, ['commit', '-m', 'sub']);

  initRepo(superRoot);
  writeFileSync(join(superRoot, 'a.txt'), 'aaaa\n', 'utf8');
  git(superRoot, ['add', '.']);
  git(superRoot, ['commit', '-m', 'super']);
  git(superRoot, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    '--name',
    nome,
    shPath(sub),
    caminho,
  ]);
  git(superRoot, ['commit', '-m', 'add sub']);
  git(join(superRoot, caminho), ['config', 'filter.escondido.clean', 'cat']);
  return { superRoot };
}

describe('fix round 5 — parse do .gitmodules com -z', () => {
  afterEach(cleanup);

  it('nome com ESPAÇO não engole o caminho', () => {
    // O formato antigo (`<chave> <valor>` numa linha) partia no primeiro espaço
    // e devolvia `sub.path libs/um` como valor — o submódulo sumia da conta.
    const saida = ['submodule.meu sub.path\nlibs/um', 'submodule.a.b.path\nlibs/dois', ''].join(NUL);

    expect(parseSubmoduleEntries(saida)).toEqual([
      { name: 'meu sub', path: 'libs/um' },
      { name: 'a.b', path: 'libs/dois' },
    ]);
  });

  it('nome com PONTO sobrevive (o sufixo `.path` é tirado gulosamente)', () => {
    const saida = `submodule.a.b.c.path\nlibs/x${NUL}`;
    expect(parseSubmoduleEntries(saida)).toEqual([{ name: 'a.b.c', path: 'libs/x' }]);
  });

  it('registro sem valor, sem `\\n` ou com chave estranha é ignorado', () => {
    const saida = ['submodule.x.path\n', 'submodule.y.path', 'outra.coisa\nvalor', ''].join(NUL);
    expect(parseSubmoduleEntries(saida)).toEqual([]);
  });

  /** O caso de ponta a ponta: nome com espaço, driver no gitdir do submódulo. */
  it('submódulo com nome contendo espaço é detectado de verdade', async () => {
    const { superRoot } = superComSubmodulo('meu sub', 'libs/um');
    expect(await listFilterDrivers(superRoot)).toContain('escondido');
  }, 60000);

  it('submódulo com nome contendo ponto também', async () => {
    const { superRoot } = superComSubmodulo('a.b', 'libs/dois');
    expect(await listFilterDrivers(superRoot)).toContain('escondido');
  }, 60000);
});

describe('fix round 5 — gitlink do índice como segunda fonte', () => {
  afterEach(cleanup);

  it('parseGitlinkPaths pega só o modo 160000', () => {
    const saida = [
      '100644 aaaa 0\t.gitmodules',
      '100644 bbbb 0\ta.txt',
      '160000 cccc 0\tlibs/um',
      '160000 dddd 0\tpasta com espaco',
      '',
    ].join(NUL);

    expect(parseGitlinkPaths(saida)).toEqual(['libs/um', 'pasta com espaco']);
  });

  /**
   * O `.gitmodules` é conveniência VERSIONADA — um repositório hostil pode
   * apagá-lo e deixar o gitlink no índice com o gitdir armado. O git continua
   * tratando aquilo como submódulo; a busca guiada só pelo arquivo não olharia.
   */
  it('gitlink SEM entrada no .gitmodules continua sendo inspecionado', async () => {
    const { superRoot } = superComSubmodulo('sub', 'libs/um');

    // Tira o `.gitmodules` do disco E do índice, mantendo o gitlink.
    git(superRoot, ['rm', '--cached', '-q', '.gitmodules']);
    rmSync(join(superRoot, '.gitmodules'));
    git(superRoot, ['commit', '-m', 'sem gitmodules']);
    // O gitlink continua lá e o gitdir continua armado.
    expect(git(superRoot, ['ls-files', '--stage'])).toContain('160000');
    expect(existsSync(join(superRoot, 'libs', 'um', '.git'))).toBe(true);
    invalidateFilterCache();

    expect(await listFilterDrivers(superRoot)).toContain('escondido');
  }, 60000);
});

describe('fix round 5 — contenção do caminho declarado', () => {
  afterEach(cleanup);

  it.each([
    ['../fora', 'sobe um nível'],
    ['libs/../../fora', '`..` no meio'],
    ['libs\\..\\..\\fora', '`..` com barra invertida'],
    ['C:\\Windows', 'absoluto'],
    ['/etc', 'absoluto POSIX'],
    ['', 'vazio'],
  ])('%s é recusado (%s)', (relative) => {
    expect(isSafeSubmodulePath('C:\\projetos\\repo', relative)).toBe(false);
  });

  it.each(['libs/um', 'libs\\um', 'a/b/c'])('%s é aceito', (relative) => {
    expect(isSafeSubmodulePath('C:\\projetos\\repo', relative)).toBe(true);
  });

  /**
   * O ataque: um `.gitmodules` cujo `path` aponta pra fora faria o Bridge rodar
   * `git config` numa pasta escolhida pelo REPOSITÓRIO. A entrada não é
   * seguida, e o repo passa a contar como suspeito.
   */
  it('.gitmodules apontando pra fora não é seguido e o repo vira suspeito', async () => {
    const base = tmp('bridge r5 fora ');
    const fora = join(base, 'fora');
    mkdirSync(fora, { recursive: true });
    // Um repo de verdade lá fora, pra provar que ele NÃO é visitado.
    initRepo(fora);
    git(fora, ['config', 'filter.laFora.clean', 'cat']);

    const root = join(base, 'meu repo');
    initRepo(root);
    writeFileSync(
      join(root, '.gitmodules'),
      ['[submodule "escapa"]', '\tpath = ../fora', '\turl = ./x', ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);

    const drivers = await listFilterDrivers(root);

    // Fail-closed: o repo conta como "tem driver"...
    expect(drivers).toContain(SUBMODULE_PATH_INVALID);
    // ...e o driver da pasta de fora NUNCA foi lido.
    expect(drivers).not.toContain('laFora');
  }, 40000);

  it('caminho absoluto no .gitmodules idem', async () => {
    const base = tmp('bridge r5 abs ');
    const root = join(base, 'meu repo');
    initRepo(root);
    writeFileSync(
      join(root, '.gitmodules'),
      ['[submodule "abs"]', `\tpath = ${shPath(resolve(base))}`, '\turl = ./x', ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);

    expect(await listFilterDrivers(root)).toContain(SUBMODULE_PATH_INVALID);
  }, 40000);
});

describe('fix round 5 — remedição na subida (repo aberto só na RAIZ)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    cleanup();
  });

  /**
   * O furo: `upsertRepo` sai cedo quando o repo já está no banco, e o poller só
   * passava por workspace de WORKTREE. Um perfil com um workspace de RAIZ num
   * repo com driver reabria com `hasFilterDrivers: false` — o item de menu
   * sumia e o dono voltava a não ter como confiar, que é o beco que a rodada 4
   * tinha fechado.
   */
  it('banco em arquivo: depois de reabrir, o repo de raiz volta com hasFilterDrivers', async () => {
    const root = join(tmp('bridge r5 restart '), 'meu repo');
    initRepo(root);
    writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'inicial']);
    git(root, ['config', 'filter.persistente.clean', 'cat']);

    const profileDir = tmp('bridge-r5-perfil-');
    const dbPath = join(profileDir, 'bridge.db');

    // 1ª execução: adota o workspace de RAIZ.
    const primeiro = createCore({ profileDir, dbPath, port: 0, token: 'T' });
    await primeiro.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: root } });
    await primeiro.refreshAllRepoFilters();
    await primeiro.stop();

    // 2ª execução: MESMO perfil, nenhum pedido tocando git.
    invalidateFilterCache();
    core = createCore({ profileDir, dbPath, port: 0, token: 'T' });
    const c = core;
    await c.start();

    // A medição roda em segundo plano no `start()`.
    const limite = Date.now() + 3000;
    let visto: Repo | undefined;
    for (;;) {
      const state = (await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json() as {
        layout: { repos: Repo[] };
      };
      visto = state.layout.repos[0];
      if (visto?.hasFilterDrivers === true || Date.now() > limite) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(visto?.hasFilterDrivers).toBe(true);
    expect(visto?.trustFilters).toBe(false);
  }, 60000);

  it('refreshAllRepoFilters respeita a concorrência pedida e não lança sem repo nenhum', async () => {
    core = createCore({ profileDir: tmp('bridge-r5-vazio-'), dbPath: ':memory:', port: 0, token: 'T' });
    await expect(core.refreshAllRepoFilters(4)).resolves.toBeUndefined();
  });
});
