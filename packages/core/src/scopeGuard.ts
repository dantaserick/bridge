/**
 * Dor verificada #4 — a guarda de escopo entre worktrees irmãs.
 *
 * Duas tarefas do mesmo repositório rodam em `.worktrees/a` e `.worktrees/b`.
 * O Claude Code da tarefa A não tem NADA que o impeça de abrir (e reescrever)
 * um arquivo de B: o `cwd` do processo é uma sugestão, não uma cerca, e um
 * `Read` com caminho absoluto atravessa a "isolação" que a pessoa achava que
 * o worktree dava. É a dor: o isolamento existe pro git e não existe pro
 * agente.
 *
 * O Bridge já recebe TODO hook do agente (`POST /hooks/<sid>/<Event>`), e o
 * `PreToolUse` do Claude Code aceita uma decisão de permissão na resposta.
 * Este módulo é a parte PURA dessa decisão: dado o nome da ferramenta, o
 * `tool_input`, o `cwd` da sessão e a raiz permitida, ele responde "isto cai
 * fora" — sem tocar em sessão, banco ou evento. Quem amarra isso ao estado é
 * o `core.ts` (`checkScope`) e a rota (`api/hooks.ts`).
 *
 * **O que a guarda NÃO é** (ver `SECURITY.md`): ela não é uma barreira contra
 * o dono da máquina nem contra um processo hostil (A3). Quem controla o
 * terminal desliga a guarda, edita o `config.json` ou roda `git` na mão. Ela
 * é contra ERRO do agente e contra repositório hostil (A4) — o caso em que
 * ninguém queria que aquele arquivo fosse tocado e ninguém ficou sabendo.
 */
import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { sanitizeDisplay, t, type Language, type MessageKey } from '@bridge/shared';
import type { Workspace } from '@bridge/shared';
import { asRecord, asString } from './adapters/payload.js';

/**
 * As ferramentas do Claude Code que declaram um CAMINHO no `tool_input` e,
 * portanto, dá pra julgar antes de rodarem.
 *
 * `Bash` está DE FORA de propósito. Um comando de shell não declara caminho
 * nenhum: ele declara texto (`npm test`, `git log -- ../outro`, um pipeline
 * com `cd`), e o alvo real depende do `cwd` do processo, do `PATH`, de
 * variáveis e do próprio shell. Julgar caminho dentro de string de comando dá
 * duas coisas ruins ao mesmo tempo — falso positivo (todo `..` de um
 * `--exclude=../x` viraria recusa, e `npm test` legítimo pararia de rodar) e
 * falso negativo (um `powershell -EncodedCommand` passaria batido). Uma
 * guarda que erra nos dois sentidos ensina o dono a desligá-la. O `Bash`
 * continua sujo, e o `SECURITY.md` diz isso com todas as letras.
 */
export const SCOPE_GUARDED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
]);

/**
 * Os campos de `tool_input` que carregam caminho. `file_path` é dos editores e
 * do `Read`; `notebook_path` é do `NotebookEdit`; `path` é a pasta onde
 * `Glob`/`Grep`/`LS` procuram.
 *
 * O `pattern` do `Glob`/`Grep` NÃO entra: ele é padrão de busca, não caminho,
 * e o resultado dele é filtrado pelo próprio `path`. Ver a limitação anotada
 * no `SECURITY.md`.
 */
export const SCOPE_PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/** Windows compara caminho sem diferenciar caixa; POSIX diferencia. */
const CASE_INSENSITIVE = process.platform === 'win32';

/**
 * UNC (`\\servidor\share`) e o namespace de dispositivo (`\\?\C:\…`,
 * `\\.\PIPE\…`) são REPROVADOS sem comparação nenhuma.
 *
 * Não é preciosismo: `\\?\` desliga a normalização do próprio Windows (o
 * `\\?\C:\a\..\b` chega no driver do jeito que foi escrito), então comparar
 * prefixo depois de `resolve` daria uma resposta que o sistema de arquivos não
 * honra. E um caminho de rede nunca está dentro de um worktree local. Os dois
 * casos são "fora", que é o lado seguro.
 */
const UNC_OR_DEVICE = /^(\\\\|\/\/)/;

/** Teto de exibição de um caminho (selo, tooltip e mensagem pro agente). */
export const SCOPE_PATH_MAX = 200;

/** Teto de subida do `realpath` — uma trava, não uma regra de negócio. */
const REALPATH_MAX_DEPTH = 64;

/** Por que um caminho não pôde ser julgado como "dentro". */
export type ScopeReject = 'empty' | 'unc' | 'unresolvable';

export interface ResolvedTarget {
  /** O caminho absoluto, com symlink/junction já resolvido. */
  path?: string;
  /** Preenchido quando não deu — e nesse caso o veredito é FORA (fail-closed). */
  rejected?: ScopeReject;
}

/**
 * `realpathSync.native` do trecho que EXISTE, com o resto pendurado de volta.
 *
 * Um `Write` legítimo aponta pra arquivo que ainda não existe, então resolver
 * o caminho inteiro devolveria `ENOENT` e a guarda barraria toda criação de
 * arquivo. A subida para no primeiro ancestral que o sistema de arquivos
 * conhece — que é o suficiente pra desmascarar a junction: em
 * `.worktrees\a\atalho\arquivo-novo.txt`, o `atalho` existe e resolve pro
 * lugar de verdade.
 *
 * Só "esse trecho não existe" (`ENOENT`, e o `ENOTDIR` de quando um pedaço do
 * meio é arquivo) justifica subir. QUALQUER outro erro devolve `undefined` —
 * fail-closed, e o módulo já trata `undefined` como FORA.
 *
 * Isso não é zelo: uma junction ILEGÍVEL (reparse point com ACL negando
 * leitura, `EPERM`/`EACCES`) fazia a subida antiga pendurar o nome do link de
 * volta como texto, e o alvo de verdade — que pode estar em qualquer lugar do
 * disco — nunca era desmascarado. O caminho literal ainda começava com a raiz,
 * então a comparação de prefixo dizia "dentro": exatamente o desvio que o
 * `realpath` existe pra fechar.
 *
 * `undefined` = nem a raiz resolveu (unidade que não existe, permissão negada
 * no caminho inteiro). Vira "fora", nunca "dentro".
 */
export function realPathOfExisting(abs: string): string | undefined {
  let current = abs;
  const tail: string[] = [];
  for (let depth = 0; depth < REALPATH_MAX_DEPTH; depth += 1) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      const parent = dirname(current);
      // A raiz é ponto fixo de `dirname`: chegou aqui sem resolver nada.
      if (parent === current) return undefined;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return undefined;
}

/**
 * O caminho DECLARADO pelo agente, virado num absoluto comparável.
 *
 * Relativo resolve contra o `cwd` da SESSÃO (que é o cwd real do processo do
 * agente, não o do core); `..`, `.` e a mistura de `/` com `\` somem no
 * `resolve` do Node; symlink e junction somem no `realPathOfExisting`.
 *
 * `resolve(cwd, value)` sozinho — sem o galho `isAbsolute(value) ?
 * resolve(value) : …` que existia até a 0.11.0 — porque ele já faz as duas
 * coisas: um caminho ENRAIZADO (`C:\x`) volta inalterado, e um caminho sem
 * unidade (`/x/y`, que o Windows chama de "relativo à raiz da unidade
 * corrente") passa a herdar a unidade do `cwd` DA SESSÃO em vez da unidade do
 * processo do core. A diferença importa: o core pode estar rodando em `C:` com
 * a sessão em `D:`, e `resolve('/x/y')` ali devolveria `C:\x\y` — um caminho
 * que o agente nunca pediu.
 */
export function resolveTarget(raw: string, cwd: string): ResolvedTarget {
  const value = raw.trim();
  if (value === '') return { rejected: 'empty' };
  if (UNC_OR_DEVICE.test(value)) return { rejected: 'unc' };
  let abs: string;
  try {
    abs = resolve(cwd, value);
  } catch {
    return { rejected: 'unresolvable' };
  }
  // `resolve` pode PRODUZIR um UNC (cwd numa unidade de rede mapeada por
  // caminho UNC): a checagem vale nos dois lados.
  if (UNC_OR_DEVICE.test(abs)) return { rejected: 'unc' };
  const real = realPathOfExisting(abs);
  if (real === undefined) return { rejected: 'unresolvable' };
  return { path: real };
}

function foldCase(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/**
 * `target` está DENTRO de `root` — ou é o próprio `root`?
 *
 * Diferente do `isUnder` do `git.ts`, que é estrito: aqui a própria raiz é um
 * alvo legítimo (`LS` do worktree, `Glob` com `path` = a pasta da tarefa), e
 * recusá-la barraria a primeira coisa que todo agente faz.
 *
 * O `+ sep` só é acrescentado quando falta, pela mesma razão do `git.ts`: um
 * repositório na raiz de uma unidade (`D:\`) já vem com o separador no fim, e
 * `'D:\\x'.startsWith('D:\\\\')` é falso.
 */
export function isWithinRoot(root: string, target: string): boolean {
  const a = foldCase(root);
  const b = foldCase(target);
  if (a === b) return true;
  const prefix = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(prefix);
}

/** Os caminhos crus que uma chamada de ferramenta declara (na ordem dos campos). */
export function declaredPaths(toolName: string, toolInput: unknown): string[] {
  if (!SCOPE_GUARDED_TOOLS.has(toolName)) return [];
  const input = asRecord(toolInput);
  const out: string[] = [];
  for (const field of SCOPE_PATH_FIELDS) {
    const value = asString(input[field]);
    if (value !== undefined && value.trim() !== '') out.push(value);
  }
  return out;
}

/** O que a raiz permitida É — muda só a redação da recusa. */
export type ScopeRootKind = 'worktree' | 'repo' | 'folder';

export interface ScopeRoot {
  path: string;
  kind: ScopeRootKind;
}

/**
 * A raiz permitida de um workspace.
 *
 * - workspace de TAREFA → a pasta do worktree. É o isolamento que a pessoa
 *   pediu quando criou a tarefa, e é a dor deste lote;
 * - workspace de repositório (a raiz, sem worktree) → o repositório INTEIRO.
 *   Quem abre o repo na raiz está trabalhando no repo, e cercá-lo no `cwd` de
 *   um painel seria uma cerca que ninguém pediu;
 * - workspace fora de repositório → o `cwd` dele.
 *
 * `repoPath` é injetado (e não lido do banco aqui) pra este módulo continuar
 * puro: quem tem o `Db` é o core.
 *
 * **WSL não tem raiz nesta versão** (limite declarado da 0.11.0, `SECURITY.md`
 * risco 18). Num workspace com `environment.kind === 'wsl'` o agente roda
 * DENTRO da distro e declara caminho POSIX (`/mnt/d/repo/.worktrees/a/x.ts`),
 * enquanto o que está gravado aqui — `worktree.path`, `repoPath`, `cwd` — é
 * caminho do Windows. Comparar os dois é comparar espaços diferentes: no
 * `win32`, `resolve` gruda `/mnt/d/…` na unidade do `cwd` e o `realpath` sobe
 * até a raiz dela, então TODA ferramenta com caminho seria recusada — uma
 * guarda que reprova o trabalho legítimo é uma guarda que a pessoa desliga.
 *
 * Traduzir a raiz pro espaço POSIX resolveria a comparação, mas sem
 * `realpath` DENTRO da distro reabriria o desvio por symlink que a guarda
 * existe pra fechar — proteção falsa é pior que limite declarado. A tradução
 * de verdade (raiz e `cwd` em espaço POSIX no lançamento) está no BACKLOG.
 * Sem raiz, o core não nega nada e não conta nada: a sessão WSL fica no mesmo
 * estado da 0.10.x.
 */
export function scopeRootOf(workspace: Workspace, repoPath?: string): ScopeRoot | undefined {
  if (workspace.environment?.kind === 'wsl') return undefined;
  const raw = workspace.worktree?.path ?? repoPath ?? workspace.cwd;
  if (!raw) return undefined;
  const kind: ScopeRootKind = workspace.worktree ? 'worktree' : repoPath ? 'repo' : 'folder';
  const real = realPathOfExisting(resolve(raw));
  // Raiz que não resolve (a pasta do worktree sumiu do disco) desliga a
  // guarda em vez de barrar tudo: sem raiz não há veredito, e transformar
  // "não sei" em "nega tudo" travaria a sessão inteira por causa de uma
  // unidade desconectada.
  if (real === undefined) return undefined;
  return { path: real, kind };
}

/** Um caminho que a guarda reprovou. */
export interface ScopeViolation {
  /** Como o agente escreveu (sanitizado) — é o que o tooltip mostra quando não deu pra resolver. */
  raw: string;
  /** O absoluto de verdade, quando deu pra resolver. */
  resolved?: string;
  rejected?: ScopeReject;
}

/** O caminho que vai na mensagem e no selo: o resolvido, ou o cru. */
export function violationPath(v: ScopeViolation): string {
  return v.resolved ?? v.raw;
}

export interface ScopeCheckInput {
  toolName: string;
  toolInput: unknown;
  /** `cwd` da SESSÃO — contra o que um caminho relativo é resolvido. */
  cwd: string;
  root: ScopeRoot;
}

/**
 * O veredito. `undefined` = a chamada pode seguir (nenhum caminho declarado,
 * ferramenta fora da lista, ou todos os caminhos dentro da raiz).
 *
 * Devolve o PRIMEIRO caminho reprovado, não a lista: a recusa é uma só, e a
 * mensagem que vai pro agente precisa apontar um lugar.
 */
export function checkScope(input: ScopeCheckInput): ScopeViolation | undefined {
  for (const raw of declaredPaths(input.toolName, input.toolInput)) {
    const target = resolveTarget(raw, input.cwd);
    if (target.path === undefined) {
      return { raw: sanitizeDisplay(raw, SCOPE_PATH_MAX), rejected: target.rejected };
    }
    if (isWithinRoot(input.root.path, target.path)) continue;
    return { raw: sanitizeDisplay(raw, SCOPE_PATH_MAX), resolved: sanitizeDisplay(target.path, SCOPE_PATH_MAX) };
  }
  return undefined;
}

/** Onde o caminho caiu, na voz de quem lê a recusa. */
const ROOT_KEY: Record<ScopeRootKind, MessageKey> = {
  worktree: 'core.escopo.raiz.worktree',
  repo: 'core.escopo.raiz.repo',
  folder: 'core.escopo.raiz.pasta',
};

/**
 * O nome EXATO do item de menu que libera este workspace — o que o
 * `WorkspaceMenu` desenha (`Permitir acesso fora do ${worktree ?
 * 'worktree' : 'repositório'}`).
 *
 * Ele mora aqui porque a razão do `deny` é lida pelo AGENTE, que a repete pro
 * dono: mandar procurar um item que não existe no menu ("Acesso cruzado", como
 * era até a fix round 1) é pior que não dizer nada — a pessoa abre o "⋯",
 * não acha, e conclui que a guarda não tem como ser desligada.
 *
 * `folder` cai em "repositório" de propósito: o menu não tem um terceiro
 * rótulo, e o que vale é combinar com a tela. Quando a Task 3 traduzir o menu,
 * é a MESMA chave dos dois lados que garante que continuem combinando.
 */
const MENU_KEY: Record<ScopeRootKind, MessageKey> = {
  worktree: 'core.escopo.menu.worktree',
  repo: 'core.escopo.menu.repo',
  folder: 'core.escopo.menu.repo',
};

export function scopeDenyReply(violation: ScopeViolation, root: ScopeRoot, lang: Language): object {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: scopeDenyReason(violation, root, lang),
    },
  };
}

export function scopeDenyReason(violation: ScopeViolation, root: ScopeRoot, lang: Language): string {
  const where = violationPath(violation);
  const extra = violation.rejected === 'unc' ? t(lang, 'core.escopo.unc') : '';
  return t(lang, 'core.escopo.razao', {
    onde: t(lang, ROOT_KEY[root.kind]),
    alvo: where,
    raiz: sanitizeDisplay(root.path, SCOPE_PATH_MAX),
    extra,
    menu: t(lang, MENU_KEY[root.kind]),
  });
}
