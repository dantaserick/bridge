/**
 * Dor verificada #4 — a parte PURA da guarda de escopo (`src/scopeGuard.ts`).
 *
 * Tudo aqui roda com pastas de verdade em `%TEMP%`: a guarda chama
 * `realpathSync.native`, e um teste com caminho inventado provaria só que a
 * string bate — não que a junction pra fora do worktree é desmascarada, que é
 * justamente a variante que a contenção sintática não pega.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/model.js';
import {
  SCOPE_GUARDED_TOOLS,
  checkScope,
  declaredPaths,
  isWithinRoot,
  realPathOfExisting,
  resolveTarget,
  scopeDenyReply,
  scopeRootOf,
  violationPath,
} from '../src/scopeGuard.js';
import { tmpDir } from './tmp.js';

/** Um repo de mentira com dois worktrees irmãos — o cenário da dor. */
function twoWorktrees(): { repo: string; a: string; b: string } {
  const repo = realPathOfExisting(tmpDir('bridge-scope-'))!;
  const a = join(repo, '.worktrees', 'tarefa-a');
  const b = join(repo, '.worktrees', 'tarefa-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'meu.ts'), 'a', 'utf8');
  writeFileSync(join(b, 'alheio.ts'), 'b', 'utf8');
  return { repo, a, b };
}

/**
 * Uma letra de unidade que NÃO existe nesta máquina, ou `undefined` quando
 * todas estão montadas. É o único jeito honesto de produzir um caminho
 * irresolvível: um nome inválido (`Ø:`) não é lido como unidade pelo
 * `path.resolve` — vira pasta relativa, e o teste provaria o contrário do que
 * pretendia.
 */
function unusedDrive(): string | undefined {
  for (const letter of 'QRSTUVWXYZJKLMNOP') {
    if (!existsSync(`${letter}:\\`)) return `${letter}:`;
  }
  return undefined;
}

function workspaceOf(overrides: Partial<Workspace>): Workspace {
  return { id: 'ws_1', name: 'tarefa', cwd: 'C:\\nada', createdAt: 1, ...overrides };
}

describe('resolveTarget — normalização do caminho declarado', () => {
  it('relativo resolve contra o cwd da SESSÃO, não o do processo', () => {
    const { a } = twoWorktrees();
    expect(resolveTarget('meu.ts', a).path).toBe(join(a, 'meu.ts'));
    expect(resolveTarget('.\\meu.ts', a).path).toBe(join(a, 'meu.ts'));
  });

  /*
   * `/x/y` no Windows é "relativo à raiz da unidade CORRENTE" — `isAbsolute`
   * diz `true`, mas não há unidade nenhuma escrita ali. Até a 0.11.0 o galho
   * `isAbsolute(value) ? resolve(value)` mandava esse caso pro `resolve` sem
   * base, que usa o `cwd` do PROCESSO DO CORE: um caminho declarado por uma
   * sessão em `D:` era julgado como se estivesse na unidade do core.
   */
  it('caminho sem unidade (`/x/y`) herda a unidade do cwd DA SESSÃO', () => {
    const { a } = twoWorktrees();
    const raizDaSessao = parse(a).root;
    expect(resolveTarget('/x/y', a).path?.startsWith(raizDaSessao)).toBe(true);
    expect(resolveTarget('/x/y', a).path).toBe(resolve(a, '/x/y'));
    // E um caminho ENRAIZADO continua intocado — `resolve(cwd, …)` o devolve
    // como está, que era o outro lado do galho removido.
    expect(resolveTarget(join(a, 'meu.ts'), a).path).toBe(join(a, 'meu.ts'));
  });

  it('`..` é colapsado antes de qualquer comparação', () => {
    const { a, b } = twoWorktrees();
    expect(resolveTarget('..\\tarefa-b\\alheio.ts', a).path).toBe(join(b, 'alheio.ts'));
  });

  it('as duas convenções de barra dão o mesmo caminho', () => {
    const { a } = twoWorktrees();
    expect(resolveTarget('sub/dir/x.ts', a).path).toBe(resolveTarget('sub\\dir\\x.ts', a).path);
  });

  it('arquivo que ainda NÃO existe resolve (senão todo Write novo seria barrado)', () => {
    const { a } = twoWorktrees();
    const alvo = resolveTarget('pasta-nova\\arquivo-novo.ts', a);
    expect(alvo.rejected).toBeUndefined();
    expect(alvo.path).toBe(join(a, 'pasta-nova', 'arquivo-novo.ts'));
  });

  it('UNC e `\\\\?\\` são recusados sem comparação', () => {
    const { a } = twoWorktrees();
    expect(resolveTarget('\\\\servidor\\share\\x.ts', a).rejected).toBe('unc');
    expect(resolveTarget('\\\\?\\C:\\Windows\\system.ini', a).rejected).toBe('unc');
    expect(resolveTarget('//servidor/share/x.ts', a).rejected).toBe('unc');
    expect(resolveTarget('\\\\.\\PIPE\\qualquer', a).rejected).toBe('unc');
  });

  it('caminho vazio ou só espaço não vira "a raiz"', () => {
    const { a } = twoWorktrees();
    expect(resolveTarget('', a).rejected).toBe('empty');
    expect(resolveTarget('   ', a).rejected).toBe('empty');
  });

  it('erro que NÃO é "não existe" (junction ilegível, EPERM) é irresolvível — não vira nome literal', () => {
    const { a } = twoWorktrees();
    // A subida do `realPathOfExisting` só pode acontecer por "esse trecho não
    // existe". Um reparse point com ACL negando leitura (`EPERM`) devolvia,
    // antes da fix round 1, o nome do link pendurado de volta como TEXTO: o
    // caminho literal ainda começava com a raiz, a comparação de prefixo dizia
    // "dentro", e o alvo de verdade da junction — em qualquer lugar do disco —
    // nunca era olhado. É o desvio que o `realpath` existe pra fechar.
    //
    // `EPERM` não dá pra produzir com pasta de teste sem mexer em ACL da
    // máquina, então o erro é injetado no ponto exato em que o módulo lê o
    // disco: `realpathSync.native`.
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const ilegivel = join(a, 'junction-ilegivel');
    const alvo = join(ilegivel, 'arquivo.ts');
    const nativo = realpathSync.native;
    const espiao = vi.spyOn(realpathSync, 'native').mockImplementation(((caminho: string) => {
      if (caminho === ilegivel) {
        const err: NodeJS.ErrnoException = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return nativo(caminho);
    }) as typeof realpathSync.native);
    try {
      const resolvido = resolveTarget(alvo, a);
      expect(resolvido.path).toBeUndefined();
      expect(resolvido.rejected).toBe('unresolvable');
      // E o veredito de ponta a ponta é FORA, mesmo com o caminho começando
      // pela raiz permitida.
      expect(checkScope({ toolName: 'Read', toolInput: { file_path: alvo }, cwd: a, root })?.rejected).toBe(
        'unresolvable',
      );
      // Controle: o vizinho que resolve normalmente continua passando — o
      // fail-closed é do trecho ilegível, não de tudo.
      expect(
        checkScope({ toolName: 'Read', toolInput: { file_path: join(a, 'meu.ts') }, cwd: a, root }),
      ).toBeUndefined();
    } finally {
      espiao.mockRestore();
    }
  });

  it('unidade que não existe é irresolvível — e irresolvível é FORA', () => {
    const { a } = twoWorktrees();
    const livre = unusedDrive();
    if (!livre) return; // m\u00e1quina com todas as letras montadas: nada a provar.
    expect(resolveTarget(`${livre}\\segredo.txt`, a).rejected).toBe('unresolvable');
  });
});

describe('isWithinRoot — contenção', () => {
  it('a própria raiz conta como dentro (o LS do worktree é legítimo)', () => {
    expect(isWithinRoot('D:\\repo\\.worktrees\\a', 'D:\\repo\\.worktrees\\a')).toBe(true);
  });

  it('irmão com prefixo comum NÃO conta como dentro', () => {
    expect(isWithinRoot('D:\\repo\\.worktrees\\a', 'D:\\repo\\.worktrees\\ab\\x.ts')).toBe(false);
  });

  it('caixa diferente conta como dentro no Windows', () => {
    expect(isWithinRoot('D:\\Repo\\.Worktrees\\A', 'd:\\repo\\.worktrees\\a\\x.ts')).toBe(true);
  });

  it('raiz de unidade não perde o separador', () => {
    expect(isWithinRoot('D:\\', 'D:\\repo\\x.ts')).toBe(true);
  });
});

describe('declaredPaths — quais ferramentas e quais campos', () => {
  it('só as ferramentas de caminho entram', () => {
    for (const tool of SCOPE_GUARDED_TOOLS) {
      expect(declaredPaths(tool, { file_path: 'x.ts', path: 'p', notebook_path: 'n.ipynb' }).length).toBeGreaterThan(0);
    }
  });

  it('Bash NÃO é julgado — nem com um caminho dentro do comando', () => {
    expect(declaredPaths('Bash', { command: 'type ..\\tarefa-b\\alheio.ts' })).toEqual([]);
    // E nem quando alguém enfia um `file_path` num Bash.
    expect(declaredPaths('Bash', { file_path: 'C:\\qualquer\\x.ts' })).toEqual([]);
  });

  it('ferramenta desconhecida (WebFetch, Task) passa sem opinião', () => {
    expect(declaredPaths('WebFetch', { url: 'https://exemplo' })).toEqual([]);
    expect(declaredPaths('Task', { prompt: 'C:\\x' })).toEqual([]);
  });

  it('campo ausente, vazio ou de outro tipo não vira caminho', () => {
    expect(declaredPaths('Read', {})).toEqual([]);
    expect(declaredPaths('Read', { file_path: '   ' })).toEqual([]);
    expect(declaredPaths('Read', { file_path: 42 })).toEqual([]);
    expect(declaredPaths('Read', null)).toEqual([]);
  });

  it('Glob/Grep são julgados pelo `path`, não pelo `pattern`', () => {
    expect(declaredPaths('Glob', { pattern: '**/*.ts', path: 'D:\\outro' })).toEqual(['D:\\outro']);
    expect(declaredPaths('Grep', { pattern: 'segredo' })).toEqual([]);
  });
});

describe('scopeRootOf — a raiz permitida da sessão', () => {
  it('workspace de TAREFA → o worktree', () => {
    const { repo, a } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }), repo);
    expect(root).toEqual({ path: a, kind: 'worktree' });
  });

  it('workspace de repositório (sem worktree) → o repo INTEIRO', () => {
    const { repo } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: join(repo, 'src'), repoId: 'repo_1' }), repo);
    expect(root).toEqual({ path: repo, kind: 'repo' });
  });

  it('workspace fora de repositório → o cwd dele', () => {
    const { repo } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: repo }), undefined);
    expect(root).toEqual({ path: repo, kind: 'folder' });
  });

  it('raiz que sumiu do disco desliga a guarda em vez de barrar tudo', () => {
    const some = join(tmpDir('bridge-scope-'), 'nao-existe', 'nem-um-pouco');
    // A pasta-pai existe, então o `realpath` sobe e RESOLVE — o caso de raiz
    // irresolvível de verdade é a unidade inteira sumir.
    expect(scopeRootOf(workspaceOf({ cwd: some }))?.kind).toBe('folder');
    const livre = unusedDrive();
    if (livre) expect(scopeRootOf(workspaceOf({ cwd: `${livre}\\sumiu` }))).toBeUndefined();
  });

  /*
   * Limite declarado da 0.11.0 (`SECURITY.md` risco 18): workspace de WSL não
   * tem raiz. O agente roda dentro da distro e declara `/mnt/d/…`; o que está
   * gravado no workspace é caminho do Windows. Sem raiz o core não nega nada —
   * o oposto do que acontecia antes, que era negar TUDO.
   */
  it('workspace de WSL não tem raiz — a guarda não vale lá nesta versão', () => {
    const { repo, a } = twoWorktrees();
    const wsl = workspaceOf({
      cwd: a,
      worktree: { base: 'main', path: a },
      environment: { kind: 'wsl', distro: 'Ubuntu' },
    });
    expect(scopeRootOf(wsl, repo)).toBeUndefined();
    // …e o mesmo workspace em qualquer outro ambiente continua cercado.
    expect(scopeRootOf({ ...wsl, environment: { kind: 'gitbash' } }, repo)).toEqual({ path: a, kind: 'worktree' });
    expect(scopeRootOf({ ...wsl, environment: undefined }, repo)).toEqual({ path: a, kind: 'worktree' });
  });
});

describe('checkScope — o veredito por chamada de ferramenta', () => {
  it('arquivo do próprio worktree passa', () => {
    const { a } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    expect(checkScope({ toolName: 'Read', toolInput: { file_path: join(a, 'meu.ts') }, cwd: a, root })).toBeUndefined();
    expect(checkScope({ toolName: 'Read', toolInput: { file_path: 'meu.ts' }, cwd: a, root })).toBeUndefined();
  });

  it('arquivo do worktree IRMÃO é barrado — a dor', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const v = checkScope({ toolName: 'Edit', toolInput: { file_path: join(b, 'alheio.ts') }, cwd: a, root });
    expect(v).toBeDefined();
    expect(violationPath(v!)).toBe(join(b, 'alheio.ts'));
  });

  it('`..` que sai do worktree é barrado', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const v = checkScope({ toolName: 'Read', toolInput: { file_path: '..\\tarefa-b\\alheio.ts' }, cwd: a, root });
    expect(violationPath(v!)).toBe(join(b, 'alheio.ts'));
  });

  it('symlink DENTRO do worktree apontando pra fora é desmascarado', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const atalho = join(a, 'atalho');
    try {
      symlinkSync(b, atalho, 'junction');
    } catch {
      // Sem permissão pra criar link nesta máquina: o caso fica sem cobertura
      // aqui e é conferido pelo teste de `..` acima.
      return;
    }
    const v = checkScope({ toolName: 'Read', toolInput: { file_path: join(atalho, 'alheio.ts') }, cwd: a, root });
    expect(v).toBeDefined();
    // O caminho relatado é o REAL, não o disfarçado.
    expect(violationPath(v!)).toBe(join(b, 'alheio.ts'));
  });

  it('symlink DENTRO do worktree apontando pra dentro dele mesmo passa', () => {
    const { a } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const sub = join(a, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'x.ts'), 'x', 'utf8');
    const atalho = join(a, 'atalho-interno');
    try {
      symlinkSync(sub, atalho, 'junction');
    } catch {
      return;
    }
    expect(checkScope({ toolName: 'Read', toolInput: { file_path: join(atalho, 'x.ts') }, cwd: a, root })).toBeUndefined();
  });

  it('UNC é barrado mesmo que a comparação de prefixo não fosse decidir nada', () => {
    const { a } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const v = checkScope({ toolName: 'Write', toolInput: { file_path: '\\\\servidor\\share\\x.ts' }, cwd: a, root });
    expect(v?.rejected).toBe('unc');
  });

  it('workspace de REPO deixa passar o irmão (a raiz é o repositório inteiro)', () => {
    const { repo, a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: repo, repoId: 'repo_1' }), repo)!;
    expect(checkScope({ toolName: 'Read', toolInput: { file_path: join(b, 'alheio.ts') }, cwd: a, root })).toBeUndefined();
    // Mas o que está fora do repo continua barrado.
    const fora = resolve(repo, '..');
    expect(checkScope({ toolName: 'Read', toolInput: { file_path: join(fora, 'x.ts') }, cwd: repo, root })).toBeDefined();
  });

  it('Bash com caminho de fora no comando NÃO é barrado (decisão documentada)', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const input = { command: `type ${join(b, 'alheio.ts')}` };
    expect(checkScope({ toolName: 'Bash', toolInput: input, cwd: a, root })).toBeUndefined();
  });

  it('o primeiro campo reprovado é o que sai (Grep com path de fora)', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const v = checkScope({ toolName: 'Grep', toolInput: { pattern: 'x', path: b }, cwd: a, root });
    expect(violationPath(v!)).toBe(b);
  });
});

describe('scopeDenyReply — o JSON exato que o Claude Code lê', () => {
  it('é o `hookSpecificOutput` documentado, com `deny` e a razão', () => {
    const { a, b } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const v = checkScope({ toolName: 'Read', toolInput: { file_path: join(b, 'alheio.ts') }, cwd: a, root })!;
    const reply = scopeDenyReply(v, root, 'pt-BR') as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(Object.keys(reply)).toEqual(['hookSpecificOutput']);
    expect(reply.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain('fora do worktree desta tarefa');
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain(join(b, 'alheio.ts'));
    // O item citado é o que o `WorkspaceMenu` desenha DE VERDADE — mandar o
    // agente procurar um nome inexistente no menu é pior que não dizer nada.
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain(
      'Libere em ⋯ → "Permitir acesso fora do worktree"',
    );
    // O formato legado (`decision: 'block'`) NÃO é emitido junto: o shim ecoa
    // o corpo verbatim e não escolhe campo, então duas decisões na mesma
    // resposta só criariam ambiguidade.
    expect(reply).not.toHaveProperty('decision');
  });

  it('num workspace de repositório a redação muda (não existe "worktree desta tarefa")', () => {
    const { repo } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: repo, repoId: 'repo_1' }), repo)!;
    const v = checkScope({ toolName: 'Read', toolInput: { file_path: 'C:\\Windows\\system.ini' }, cwd: repo, root })!;
    const reply = scopeDenyReply(v, root, 'pt-BR') as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain('fora do repositório deste workspace');
    // A cerca muda, e o RÓTULO do menu muda junto.
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain(
      'Libere em ⋯ → "Permitir acesso fora do repositório"',
    );
  });

  it('caminho com sequência de terminal é sanitizado antes de virar mensagem', () => {
    const { a } = twoWorktrees();
    const root = scopeRootOf(workspaceOf({ cwd: a, worktree: { base: 'main', path: a } }))!;
    const hostil = 'D:\\fora\\\u001b]0;titulo\u0007x.ts';
    const v = checkScope({ toolName: 'Read', toolInput: { file_path: hostil }, cwd: a, root })!;
    const reason = (scopeDenyReply(v, root, 'pt-BR') as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).not.toContain('\u001b');
    expect(reason).not.toContain('\u0007');
  });
});
