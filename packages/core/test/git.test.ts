import { ptBRMessage } from '../src/errors.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GitError,
  canRemoveWorktree,
  createWorktree,
  detectRepo,
  diffCommand,
  ensureExclude,
  invalidateFilterCache,
  listFilterDrivers,
  mergeIntoBase,
  normalizeTaskName,
  parseStatusV2,
  refExists,
  removeWorktree,
  removeWorktreeForce,
  runGit,
  shouldReadIndexGitlinks,
  status,
  upstreamOf,
  worktreeHolding,
} from '../src/git.js';

/**
 * Todo repo destes testes nasce num caminho COM ESPAÇO (`bridge git XXXXXX/meu
 * repo`): é a regra da Fase 3 e o jeito de garantir que nenhuma chamada de git
 * passou por shell em algum lugar. Nenhum teste toca no repo do Bridge — o
 * user proibiu commits aqui, e estes commitam à vontade.
 */
const trees: string[] = [];

/** Pausa sincrona (o helper de git e sincrono de proposito). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `git` do TESTE (o do core e o `git.ts`). Com a suite inteira rodando em
 * paralelo, o antivirus/indexador do Windows as vezes ainda segura o `.git`
 * recem-criado quando o comando seguinte chega e o `git config` falha por
 * lock. Tres tentativas curtas resolvem isso sem mascarar erro de verdade — o
 * ultimo erro e relancado. (A mesma protecao que `gitPoller.test.ts` e
 * `api-tasks.test.ts` ja tinham.)
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

/** Pasta temporária com espaço no nome, registrada pra limpeza. */
function tmpTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge git '));
  trees.push(dir);
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
  // Nada aqui pode depender do git global de quem roda a suíte: com
  // `core.autocrlf=true` (comum no Windows) o git reescreve as pontas de linha
  // e um `safecrlf` estrito chega a RECUSAR o commit — a suíte passaria ou
  // falharia conforme a máquina.
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'leiame.md'), 'ola\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

/** Commita um arquivo novo em `cwd` (worktree ou repo). */
function commitFile(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), body, 'utf8');
  git(cwd, ['add', name]);
  git(cwd, ['commit', '-m', `add ${name}`]);
}

/** Caminhos do Windows: git devolve `/`, o Node devolve `\`, e o disco não liga pra caixa. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

afterAll(() => {
  for (const dir of trees) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // pasta travada por antivírus: é temp, o SO limpa depois.
    }
  }
});

describe('normalizeTaskName', () => {
  it('normaliza o nome digitado pelo usuário em nome de branch', () => {
    expect(normalizeTaskName('Feat Mailbox!')).toBe('feat-mailbox');
    expect(normalizeTaskName('  Corrige   o  Login  ')).toBe('corrige-o-login');
    expect(normalizeTaskName('fix/API#42')).toBe('fixapi42');
    expect(normalizeTaskName('v1.2.3_beta')).toBe('v1.2.3_beta');
    expect(normalizeTaskName('MAIÚSCULAS')).toBe('maisculas');
    expect(normalizeTaskName('--traço--duplo--')).toBe('trao-duplo');
    expect(normalizeTaskName('.ponto.')).toBe('ponto');
  });

  it('corta em 60 caracteres sem deixar sobra de `-`/`.` na ponta', () => {
    const longo = normalizeTaskName('a'.repeat(80));
    expect(longo).toHaveLength(60);
    const cortado = normalizeTaskName(`${'a'.repeat(59)}-bbb`);
    expect(cortado).toBe('a'.repeat(59));
  });

  it('lança quando não sobra nada depois de normalizar', () => {
    expect(() => normalizeTaskName('')).toThrow(/inválido/);
    expect(() => normalizeTaskName('   ')).toThrow(/inválido/);
    expect(() => normalizeTaskName('###')).toThrow(/inválido/);
    expect(() => normalizeTaskName('...---...')).toThrow(/inválido/);
  });
});

describe('runGit', () => {
  it('roda o binário direto (sem shell) num caminho com espaço', async () => {
    const root = makeRepo();
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    expect(stdout.trim()).toBe('main');
  });

  it('erro do git vira GitError `git-failed` com o stderr no detail', async () => {
    const root = makeRepo();
    await expect(runGit(['rev-parse', '--verify', 'branch-que-nao-existe'], root)).rejects.toMatchObject({
      code: 'git-failed',
    });
    const err = await runGit(['checkout', 'nada-aqui'], root).catch((e: GitError) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('git-failed');
    expect((err as GitError).detail ?? '').not.toBe('');
  });
});

describe('detectRepo', () => {
  it('no root do repo: branch main e isWorktree false', async () => {
    const root = makeRepo();
    const info = await detectRepo(root);
    expect(info).not.toBeNull();
    expect(samePath(info!.root, root)).toBe(true);
    expect(info!.branch).toBe('main');
    expect(info!.isWorktree).toBe(false);
    expect(info!.worktreePath).toBeUndefined();
    expect(samePath(info!.mainPath, root)).toBe(true);
    expect(info!.hasCommits).toBe(true);
  });

  /**
   * Nada de "pasta temporária qualquer": nesta máquina o `%TEMP%` fica DENTRO
   * de um repo (o `%USERPROFILE%` do dono é um `git init`), e o
   * `--show-toplevel` sobe até ele. Um `.git` inválido é a forma determinística
   * de o git dizer "aqui não é repositório" onde quer que o teste rode.
   */
  it('fora de repo devolve null', async () => {
    const dir = tmpTree();
    writeFileSync(join(dir, '.git'), 'isto nao e um gitfile\n', 'utf8');
    expect(await detectRepo(dir)).toBeNull();
  });

  it('pasta inexistente devolve null em vez de lançar', async () => {
    expect(await detectRepo(join(tmpTree(), 'pasta', 'que', 'sumiu'))).toBeNull();
  });

  it('repo recém-criado sem nenhum commit não derruba a detecção', async () => {
    const root = join(tmpTree(), 'repo vazio');
    mkdirSync(root);
    git(root, ['init', '-b', 'main']);
    const info = await detectRepo(root);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('main');
    expect(info!.isWorktree).toBe(false);
    // R7: repo sem commit nenhum nao vira origem de tarefa nem entra na lista.
    expect(info!.hasCommits).toBe(false);
  });
});

describe('ensureExclude', () => {
  it('acrescenta a entrada uma vez só (idempotente)', async () => {
    const root = makeRepo();
    const excludePath = join(root, '.git', 'info', 'exclude');
    await ensureExclude(root, '.worktrees/');
    await ensureExclude(root, '.worktrees/');
    const linhas = readFileSync(excludePath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() === '.worktrees/');
    expect(linhas).toHaveLength(1);
  });
});

describe('createWorktree', () => {
  it('cria .worktrees/<nome> no branch novo, exclui a pasta e recusa a segunda vez', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'Feat Mailbox!', 'main');

    expect(wt.branch).toBe('feat-mailbox');
    expect(samePath(wt.path, join(root, '.worktrees', 'feat-mailbox'))).toBe(true);
    expect(existsSync(join(wt.path, 'leiame.md'))).toBe(true);
    expect(git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat-mailbox');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.worktrees/');
    // O worktree não pode aparecer como alteração no repo base.
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');

    const err = await createWorktree(root, 'feat-mailbox', 'main').catch((e: GitError) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('exists');
  });

  it('recusa quando o branch já existe mesmo sem a pasta', async () => {
    const root = makeRepo();
    git(root, ['branch', 'ja-existe']);
    await expect(createWorktree(root, 'ja existe', 'main')).rejects.toMatchObject({ code: 'exists' });
  });
});

describe('detectRepo dentro do worktree', () => {
  it('reconhece o worktree e a branch do worktree principal como base', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'tarefa um', 'main');
    const info = await detectRepo(wt.path);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('tarefa-um');
    expect(info!.isWorktree).toBe(true);
    expect(info!.base).toBe('main');
    expect(samePath(info!.worktreePath!, wt.path)).toBe(true);
    expect(samePath(info!.mainPath, root)).toBe(true);
  });

  it('em worktree, o info/exclude do gitdir comum é o que vale', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'exclude-de-dentro', 'main');
    await ensureExclude(wt.path, 'lixo-do-teste/');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('lixo-do-teste/');
  });
});

describe('status', () => {
  it('conta commits à frente do base e arquivos alterados', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'contagem', 'main');

    const zero = await status(wt.path, 'main');
    expect(zero.branch).toBe('contagem');
    expect(zero.base).toBe('main');
    expect(zero.ahead).toBe(0);
    expect(zero.dirty).toBe(0);
    expect(zero.at).toBeGreaterThan(0);

    commitFile(wt.path, 'novo.txt', 'um\n');
    expect(await status(wt.path, 'main')).toMatchObject({ ahead: 1, dirty: 0 });

    writeFileSync(join(wt.path, 'leiame.md'), 'editado\n', 'utf8');
    expect(await status(wt.path, 'main')).toMatchObject({ ahead: 1, dirty: 1 });

    // Arquivo NOVO não rastreado também conta (`--untracked-files=all`).
    writeFileSync(join(wt.path, 'solto.txt'), 'x\n', 'utf8');
    expect((await status(wt.path, 'main')).dirty).toBe(2);
  });

  it('base inexistente não explode: ahead vira 0', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'sem-base', 'main');
    expect(await status(wt.path, 'branch-que-nao-existe')).toMatchObject({ ahead: 0, dirty: 0 });
  });
});

describe('mergeIntoBase', () => {
  it('ff-only mescla o worktree no base', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'ff', 'main');
    commitFile(wt.path, 'ff.txt', 'ff\n');

    const res = await mergeIntoBase(root, 'ff', 'main', 'ff-only');
    expect(res.mode).toBe('ff-only');
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(existsSync(join(root, 'ff.txt'))).toBe(true);
  });

  it('recusa com dirty-base quando o repo base tem alteração não commitada', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'sujo', 'main');
    commitFile(wt.path, 'sujo.txt', 'a\n');
    writeFileSync(join(root, 'leiame.md'), 'mexido sem commit\n', 'utf8');

    const err = await mergeIntoBase(root, 'sujo', 'main', 'ff-only').catch((e: GitError) => e);
    expect((err as GitError).code).toBe('dirty-base');
    // Não mexeu em nada: o merge nem começou.
    expect(existsSync(join(root, 'sujo.txt'))).toBe(false);
  });

  it('divergente: ff-only falha com not-ff e no-ff passa com a mensagem `Merge task/<branch>`', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'diverge', 'main');
    commitFile(wt.path, 'do-worktree.txt', 'w\n');
    commitFile(root, 'do-base.txt', 'b\n');

    const err = await mergeIntoBase(root, 'diverge', 'main', 'ff-only').catch((e: GitError) => e);
    // R2: `not-ff` e um `code` de verdade, nao um marcador no `detail` — e por
    // ele que a UI e a CLI decidem o proximo passo.
    expect((err as GitError).code).toBe('not-ff');
    expect((err as GitError).detail).toBeUndefined();
    // O stderr cru do git vai no campo E na mensagem: sem ele, uma falha de
    // `--ff-only` que NÃO é "não é fast-forward" some sem deixar rastro.
    const stderr = (err as GitError).stderr ?? '';
    expect(stderr).not.toBe('');
    expect(stderr).toMatch(/fast-forward/i);
    expect((err as GitError).message).toContain(stderr);
    // Merge recusado não pode deixar o repo no meio de um conflito.
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);

    const res = await mergeIntoBase(root, 'diverge', 'main', 'no-ff');
    expect(res).toEqual({ mode: 'no-ff', message: 'Merge task/diverge' });
    expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('Merge task/diverge');
    expect(existsSync(join(root, 'do-worktree.txt'))).toBe(true);
  });

  /**
   * O caso que trancava o usuário: merge com conflito deixa o worktree
   * principal no meio do merge, e como TODA operação daqui começa recusando
   * `dirty-base`, mesclar e remover worktree passariam a falhar para sempre.
   */
  it('conflito no no-ff desfaz o merge e devolve code `conflict`', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'conflito', 'main');
    // MESMO arquivo, conteúdo diferente dos dois lados: conflito de verdade.
    commitFile(wt.path, 'leiame.md', 'versao do worktree\n');
    commitFile(root, 'leiame.md', 'versao do base\n');

    const err = await mergeIntoBase(root, 'conflito', 'main', 'no-ff').catch((e: GitError) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('conflict');
    expect((err as GitError).detail).toBeUndefined();
    expect((err as GitError).message).toContain('desfeito');
    expect((err as GitError).stderr ?? '').not.toBe('');

    // O repo voltou ao estado anterior: nada pendente, nada no meio do merge.
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(root, 'leiame.md'), 'utf8')).toBe('versao do base\n');

    // E a próxima chamada volta a chegar no merge — não trava em `dirty-base`.
    const denovo = await mergeIntoBase(root, 'conflito', 'main', 'no-ff').catch((e: GitError) => e);
    expect((denovo as GitError).code).toBe('conflict');
  });

  /**
   * R1: o Bridge NAO troca o checkout do repo do usuario pra conseguir
   * mesclar. Recusa com `base-not-checked-out`, diz em que branch o principal
   * esta, e deixa o repo exatamente como estava.
   */
  it('recusa base-not-checked-out quando o repo principal esta em outro branch', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'outra', 'main');
    commitFile(wt.path, 'outra.txt', 'o\n');
    git(root, ['checkout', '-b', 'desvio']);

    const err = await mergeIntoBase(root, 'outra', 'main', 'ff-only').catch((e: GitError) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('base-not-checked-out');
    expect((err as GitError).message).toContain('desvio');
    expect((err as GitError).message).toContain('main');
    // Nada mudou: o checkout continua onde o usuario deixou.
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('desvio');
    expect(existsSync(join(root, 'outra.txt'))).toBe(false);

    // Com o base de volta no checkout, o mesmo merge passa.
    git(root, ['checkout', 'main']);
    await mergeIntoBase(root, 'outra', 'main', 'ff-only');
    expect(existsSync(join(root, 'outra.txt'))).toBe(true);
  });

  /**
   * Item 13: o base pode estar checked out em OUTRO worktree — o git so
   * permite um worktree por branch, entao nem adiantaria o usuario tentar o
   * checkout. A mensagem tem que dizer ONDE ele esta.
   */
  it('recusa base-in-use quando o base esta checked out em outro worktree', async () => {
    const root = makeRepo();
    // O principal sai de `main` (vai pra `desvio`) e um worktree adota `main`.
    git(root, ['checkout', '-b', 'desvio']);
    git(root, ['worktree', 'add', '.worktrees/main-aqui', 'main']);
    const wt = await createWorktree(root, 'usa-base', 'desvio');
    commitFile(wt.path, 'x.txt', 'x\n');

    const err = await mergeIntoBase(root, 'usa-base', 'main', 'ff-only').catch((e: GitError) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('base-in-use');
    expect((err as GitError).message).toContain('main-aqui');
  });
});

describe('removeWorktree', () => {
  it('recusa worktree sujo, recusa branch não mesclado e limpa depois do merge', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'limpeza', 'main');
    commitFile(wt.path, 'limpeza.txt', 'l\n');
    writeFileSync(join(wt.path, 'rascunho.txt'), 'nao commitado\n', 'utf8');

    const sujo = await removeWorktree(root, wt.path, 'limpeza', 'main').catch((e: GitError) => e);
    expect((sujo as GitError).code).toBe('dirty-worktree');
    expect(existsSync(wt.path)).toBe(true);

    rmSync(join(wt.path, 'rascunho.txt'));
    const naoMesclado = await removeWorktree(root, wt.path, 'limpeza', 'main').catch((e: GitError) => e);
    expect((naoMesclado as GitError).code).toBe('not-merged');
    expect((naoMesclado as GitError).message).toContain('limpeza');
    expect(existsSync(wt.path)).toBe(true);

    await mergeIntoBase(root, 'limpeza', 'main', 'ff-only');
    await removeWorktree(root, wt.path, 'limpeza', 'main');

    expect(existsSync(wt.path)).toBe(false);
    expect(git(root, ['branch', '--list', 'limpeza']).trim()).toBe('');
    expect(git(root, ['worktree', 'list', '--porcelain'])).not.toContain('limpeza');
  });
});

describe('canRemoveWorktree e removeWorktreeForce', () => {
  it('canRemoveWorktree diagnostica as duas recusas SEM remover nada, e libera depois do merge', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'checagem', 'main');
    commitFile(wt.path, 'feito.txt', 'f\n');
    writeFileSync(join(wt.path, 'rascunho.txt'), 'nao commitado\n', 'utf8');

    const sujo = await canRemoveWorktree(root, wt.path, 'checagem', 'main');
    expect(sujo.ok).toBe(false);
    if (!sujo.ok) {
      expect(sujo.code).toBe('dirty-worktree');
      expect(ptBRMessage(sujo.i18n)).toContain('não commitada');
    }
    // Leitura pura: nada foi tocado.
    expect(existsSync(wt.path)).toBe(true);
    expect(git(root, ['branch', '--list', 'checagem']).trim()).toContain('checagem');

    rmSync(join(wt.path, 'rascunho.txt'));
    const naoMesclado = await canRemoveWorktree(root, wt.path, 'checagem', 'main');
    expect(naoMesclado.ok).toBe(false);
    if (!naoMesclado.ok) expect(naoMesclado.code).toBe('not-merged');
    expect(existsSync(wt.path)).toBe(true);

    await mergeIntoBase(root, 'checagem', 'main', 'ff-only');
    expect(await canRemoveWorktree(root, wt.path, 'checagem', 'main')).toEqual({ ok: true });
    // Continua sem remover: quem remove é o `removeWorktree`.
    expect(existsSync(wt.path)).toBe(true);
  });

  it('removeWorktreeForce apaga pasta e branch mesmo sujo e não mesclado (rollback de criação)', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'rollback', 'main');
    commitFile(wt.path, 'trabalho.txt', 't\n');
    writeFileSync(join(wt.path, 'rascunho.txt'), 'nao commitado\n', 'utf8');

    await removeWorktreeForce(root, wt.path, 'rollback');

    expect(existsSync(wt.path)).toBe(false);
    expect(git(root, ['branch', '--list', 'rollback']).trim()).toBe('');
    expect(git(root, ['worktree', 'list', '--porcelain'])).not.toContain('rollback');
  });
});

describe('upstreamOf', () => {
  it('devolve undefined num repo local sem upstream', async () => {
    const root = makeRepo();
    expect(await upstreamOf(root)).toBeUndefined();
  });
});

describe('diffCommand (reexportado do @bridge/shared)', () => {
  it('monta a linha de comando que o painel vai rodar', () => {
    expect(diffCommand('main')).toBe("git --no-pager diff 'main...HEAD'");
  });
});

describe('parseStatusV2 (R5)', () => {
  it('le branch, upstream, ahead e conta as linhas de arquivo', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head tarefa-um',
      '# branch.upstream origin/main',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 aaa bbb leiame.md',
      '2 R. N... 100644 100644 100644 ccc ddd R100 novo.md\told.md',
      'u UU N... 100644 100644 100644 100644 eee fff ggg conflito.md',
      '? solto.txt',
      '! ignorado.txt',
      '',
    ].join('\n');
    expect(parseStatusV2(out)).toEqual({ branch: 'tarefa-um', upstream: 'origin/main', ahead: 3, dirty: 4 });
  });

  it('sem upstream nao tem branch.ab; HEAD destacado vira o literal HEAD', () => {
    const out = ['# branch.oid abc', '# branch.head (detached)', ''].join('\n');
    expect(parseStatusV2(out)).toEqual({ branch: 'HEAD', upstream: undefined, ahead: undefined, dirty: 0 });
  });

  it('arvore limpa com upstream: dirty 0 e ahead 0', () => {
    const out = ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', ''].join('\n');
    expect(parseStatusV2(out)).toMatchObject({ branch: 'main', ahead: 0, dirty: 0 });
  });
});

describe('refExists', () => {
  it('diz se o ref existe no repo (e a validacao do "Definir base…")', async () => {
    const root = makeRepo();
    git(root, ['branch', 'dev']);
    expect(await refExists(root, 'main')).toBe(true);
    expect(await refExists(root, 'dev')).toBe(true);
    expect(await refExists(root, 'nao-existe')).toBe(false);
  });
});

describe('worktreeHolding', () => {
  it('devolve o caminho do worktree que esta com o branch, ou undefined', async () => {
    const root = makeRepo();
    const wt = await createWorktree(root, 'segura', 'main');
    expect(samePath((await worktreeHolding(root, 'segura'))!, wt.path)).toBe(true);
    expect(samePath((await worktreeHolding(root, 'main'))!, root)).toBe(true);
    expect(await worktreeHolding(root, 'nunca-existiu')).toBeUndefined();
  });
});

/**
 * BR-03 (onda de segurança): o git executa comandos declarados no
 * `.git/config` do PRÓPRIO repositório. `core.fsmonitor` é acionado pelo
 * `git status` — a chamada que o poller do Bridge faz sozinho a cada 15 s,
 * sem clique nenhum, em todo workspace de worktree. Um repo hostil (zip,
 * backup, pendrive: qualquer coisa que preserve o `.git/`, ao contrário de um
 * `clone`) virava execução de comando repetida só por estar aberto.
 *
 * `filter.*.clean` (coberto em `security-round2.test.ts`), `diff.external` e
 * `core.pager` são a mesma família; os
 * hooks do git ficam de fora de propósito nas AÇÕES do dono (BR-18, aceito),
 * mas são desligados nos comandos passivos.
 */
describe('BR-03 — contenção do .git/config de um repo hostil', () => {
  it('core.fsmonitor do repo NÃO executa no status do poller', async () => {
    const root = makeRepo();
    const marker = join(root, 'marker-fsmonitor.txt');
    git(root, ['config', 'core.fsmonitor', `cmd.exe /c echo x > "${marker}"`]);

    const result = await status(root, 'main');

    expect(existsSync(marker)).toBe(false);
    expect(result.branch).toBe('main');
  });

  it('hook do git NÃO roda nos comandos passivos (detectRepo/status)', async () => {
    const root = makeRepo();
    const marker = join(root, 'marker-hook.txt');
    const hooksDir = join(root, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'post-index-change'), `#!/bin/sh\necho x > "${marker}"\n`, 'utf8');

    await detectRepo(root);
    await status(root, 'main');

    expect(existsSync(marker)).toBe(false);
  });
});

/**
 * `git ls-files --stage -z` lê o índice INTEIRO só pra achar as linhas de modo
 * `160000`, e a enumeração de filtros roda por repositório a cada ciclo do
 * poller. Medido num repo sintético de 20 000 arquivos: 60–75 ms por chamada,
 * contra ~44 ms de piso de processo — a enumeração completa cai de ~208 ms
 * para ~133 ms quando ela é pulada.
 *
 * A trava é estreita de propósito (fail-closed): só pula com as TRÊS
 * condições juntas — sem `.gitmodules`, última leitura sem gitlink nenhum, e
 * o índice com a mesma assinatura de então.
 */
describe('atalho do `ls-files --stage` na enumeração de filtros', () => {
  it('só pula a leitura do índice num repo sem .gitmodules cujo índice não mudou desde a última varredura', async () => {
    const root = makeRepo();
    invalidateFilterCache();

    // Primeira varredura: nunca há memória, então a leitura acontece.
    expect(shouldReadIndexGitlinks(root)).toBe(true);
    await listFilterDrivers(root);
    // Agora sim: repo sem submódulo e índice intacto.
    expect(shouldReadIndexGitlinks(root)).toBe(false);

    // Índice reescrito (um `git add` qualquer) → a leitura volta.
    commitFile(root, 'novo.txt', 'oi\n');
    expect(shouldReadIndexGitlinks(root)).toBe(true);

    invalidateFilterCache();
    await listFilterDrivers(root);
    expect(shouldReadIndexGitlinks(root)).toBe(false);

    // `.gitmodules` presente NUNCA pula, mesmo com o índice parado.
    writeFileSync(join(root, '.gitmodules'), '[submodule "x"]\n\tpath = libs/x\n\turl = ./x\n', 'utf8');
    expect(shouldReadIndexGitlinks(root)).toBe(true);
  });

  it('gitlink no índice mantém a leitura ligada nas varreduras seguintes', async () => {
    const sub = makeRepo();
    const root = makeRepo();
    // `git submodule add` precisa da permissão do transporte `file://` local.
    git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', sub.replace(/\\/g, '/'), 'libs/sub']);

    invalidateFilterCache();
    await listFilterDrivers(root);
    // O índice tem gitlink: a memória do atalho não pode ter sido gravada.
    expect(shouldReadIndexGitlinks(root)).toBe(true);
  }, 30000);

  it('sem `.git` legível a assinatura não existe e a leitura nunca é pulada', () => {
    const semGit = tmpTree();
    expect(shouldReadIndexGitlinks(semGit)).toBe(true);
  });
});

/**
 * BR-09: o `--` antes do argumento que vem de dado. Um worktree cuja PASTA
 * comece com `-` era removido por um `git worktree remove -x`, ou seja, o git
 * lia o caminho como opção. A validação de forma do `base` fecha o caminho de
 * entrada; o `--` fecha o do git.
 */
describe('BR-09 — `--` antes de ref/caminho vindos de dado', () => {
  it('worktree cuja pasta começa com `-` continua removível', async () => {
    const root = makeRepo();
    const wt = join(root, '.worktrees', '-x');
    git(root, ['worktree', 'add', wt, '-b', 'ramo-x', 'main']);

    await removeWorktree(root, wt, 'ramo-x', 'main');

    expect(existsSync(wt)).toBe(false);
    expect(await refExists(root, 'ramo-x')).toBe(false);
  });
});
