/**
 * Task 3 (fechamento) — o carry da rodada 3: `mergeIntoBase` só checava a
 * confiança nos filtros da RAIZ do repositório.
 *
 * O escopo `--worktree` do git é POR worktree: o driver declarado no
 * `config.worktree` do worktree da tarefa mora em `.git/worktrees/<nome>/
 * config.worktree` e é invisível para a enumeração feita na raiz. Como o
 * `merge` traz o conteúdo daquele branch (e o checkout do merge roda o
 * `smudge`), um driver declarado só lá dentro tinha que barrar a mesclagem —
 * `canRemoveWorktree` já barrava, `mergeIntoBase` não.
 *
 * Todo repo é temporário e apagado no `afterEach`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitError,
  SUBMODULE_PATH_INVALID,
  createWorktree,
  invalidateFilterCache,
  isSafeSubmodulePath,
  listFilterDrivers,
  mergeIntoBase,
} from '../src/git.js';

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

/** Repo com um commit, num caminho com espaço (a regra da Fase 3). */
function makeRepo(prefix: string): string {
  const root = join(tmp(prefix), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

/** Caminho no formato que o git escreve num arquivo `.git` (ele não fala `\`). */
function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Worktree da tarefa com um commit por cima do base (merge ff-only possível). */
async function tarefaComCommit(root: string): Promise<{ path: string; branch: string }> {
  const wt = await createWorktree(root, 'tarefa', 'main');
  writeFileSync(join(wt.path, 'novo.txt'), 'mais texto\n', 'utf8');
  git(wt.path, ['add', 'novo.txt']);
  git(wt.path, ['commit', '-m', 'novo']);
  return wt;
}

describe('Task 3 — BR-03: `mergeIntoBase` checa os filtros do worktree também', () => {
  afterEach(cleanup);

  it('driver declarado só no `config.worktree` da tarefa barra o merge', async () => {
    const root = makeRepo('bridge t3 wt ');
    git(root, ['config', 'extensions.worktreeConfig', 'true']);
    const wt = await tarefaComCommit(root);
    git(wt.path, ['config', '--worktree', 'filter.soNoWorktree.clean', 'cat']);

    // CONTROLE da cegueira: a raiz não enxerga o driver do worktree da tarefa.
    expect(await listFilterDrivers(root)).not.toContain('soNoWorktree');
    expect(await listFilterDrivers(wt.path)).toContain('soNoWorktree');

    const err = await mergeIntoBase(root, wt.branch, 'main', 'ff-only', {
      trustFilters: false,
      worktreePath: wt.path,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('filters-untrusted');
  }, 30000);

  /**
   * CONTROLE do buraco: sem o `worktreePath` — que é como a rodada 3 chamava —
   * o mesmo merge PASSA. É a prova de que o gate novo é quem recusa.
   */
  it('CONTROLE: sem `worktreePath` o mesmo merge passava', async () => {
    const root = makeRepo('bridge t3 ctl ');
    git(root, ['config', 'extensions.worktreeConfig', 'true']);
    const wt = await tarefaComCommit(root);
    git(wt.path, ['config', '--worktree', 'filter.soNoWorktree.clean', 'cat']);

    const merged = await mergeIntoBase(root, wt.branch, 'main', 'ff-only', { trustFilters: false });

    expect(merged.mode).toBe('ff-only');
  }, 30000);

  /** E o fluxo do dono — repo sem filtro nenhum — continua passando. */
  it('CONTROLE: repo sem driver mescla normalmente com o `worktreePath`', async () => {
    const root = makeRepo('bridge t3 ok ');
    const wt = await tarefaComCommit(root);

    const merged = await mergeIntoBase(root, wt.branch, 'main', 'ff-only', {
      trustFilters: false,
      worktreePath: wt.path,
    });

    expect(merged.mode).toBe('ff-only');
  }, 30000);
});

describe('Task 3 — resíduos LOW do re-review final', () => {
  afterEach(cleanup);

  /**
   * `resolve('C:\')` já termina em `\`, e o `base + sep` cru virava `C:\`:
   * um repositório aberto na RAIZ de uma unidade reprovava todo submódulo dele.
   */
  it('isSafeSubmodulePath funciona na raiz de uma unidade', () => {
    const raiz = parse(resolve(process.cwd())).root;

    expect(isSafeSubmodulePath(raiz, 'libs/um')).toBe(true);
    expect(isSafeSubmodulePath(raiz, '../fora')).toBe(false);
    expect(isSafeSubmodulePath(raiz, '')).toBe(false);
    // E o caso normal continua igual.
    expect(isSafeSubmodulePath(join(raiz, 'repo'), 'libs/um')).toBe(true);
    expect(isSafeSubmodulePath(join(raiz, 'repo'), '.')).toBe(false);
  });

  /**
   * O caminho DECLARADO é relativo e sem `..` — passa na contenção sintática.
   * Mas o `.git` da pasta é um ARQUIVO `gitdir: <fora>`, e o git resolve a
   * config lá fora. Sem a checagem por realpath, o driver de fora entrava na
   * conta (e o `git config` rodava numa pasta escolhida pelo repositório).
   */
  it('submódulo com `.git` apontando pra fora não é seguido', async () => {
    const fora = makeRepo('bridge t3 fora ');
    git(fora, ['config', 'filter.laFora.clean', 'cat']);

    const root = makeRepo('bridge t3 gitfile ');
    mkdirSync(join(root, 'libs', 'um'), { recursive: true });
    writeFileSync(join(root, 'libs', 'um', '.git'), `gitdir: ${shPath(join(fora, '.git'))}\n`, 'utf8');
    writeFileSync(join(root, '.gitmodules'), '[submodule "um"]\n\tpath = libs/um\n\turl = ./fora\n', 'utf8');

    const drivers = await listFilterDrivers(root);

    expect(drivers).toContain(SUBMODULE_PATH_INVALID);
    expect(drivers).not.toContain('laFora');
  }, 30000);

  /**
   * O cache só é preenchido no FIM da enumeração (que desce em submódulo). Duas
   * chamadas concorrentes rodavam a varredura inteira em paralelo; agora a
   * segunda espera a MESMA promessa — e é isso que o `toBe` prova (sem dedupe
   * seriam dois arrays distintos).
   */
  it('duas chamadas concorrentes compartilham a mesma enumeração', async () => {
    const root = makeRepo('bridge t3 voo ');
    git(root, ['config', 'filter.umSo.clean', 'cat']);
    invalidateFilterCache();

    const [a, b] = await Promise.all([listFilterDrivers(root), listFilterDrivers(root)]);

    expect(a).toBe(b);
    expect(a).toContain('umSo');
  }, 30000);
});
