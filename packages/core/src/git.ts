/**
 * Serviço git do core (spec §7): tudo por cima do BINÁRIO `git`, com
 * `execFile` — nunca `shell: true`, nunca string de comando montada à mão.
 *
 * Por que não uma lib (isomorphic-git, nodegit): o Bridge precisa de
 * `worktree add/remove`, que é justamente o que essas bibliotecas não cobrem
 * bem; e o `git` da máquina já é o que o usuário usa no terminal — mesma
 * config, mesmo credential helper, mesmo resultado.
 *
 * Regras que valem pra TODA chamada daqui:
 * - `windowsHide: true` (senão cada `git` pisca uma janela de console);
 * - `GIT_TERMINAL_PROMPT=0` — um `git` que decide pedir usuário/senha travaria
 *   o core pra sempre num prompt que ninguém vê;
 * - `LC_ALL=C` — a saída é PARSEADA aqui; git localizado quebraria o parse;
 * - `timeout` — repo em disco de rede/antivírus pode pendurar o processo.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { diffCommand, normalizeTaskName } from '@bridge/shared';
import type { I18nMessage, Translatable } from './errors.js';
import { ptBRMessage } from './errors.js';
import type { GitStatus } from './model.js';

// A normalização do nome e a linha do "Ver diff" moram no `@bridge/shared`: os
// dois lados (core e UI) precisam do MESMO resultado, e duas cópias
// divergiriam no primeiro caractere exótico. Aqui só o reexport.
export { diffCommand, normalizeTaskName };

/** Pasta (relativa ao repo) onde todo worktree de tarefa nasce. */
export const WORKTREES_DIR = '.worktrees';
/** Entrada que vai pro `.git/info/exclude` — o worktree não é alteração do repo. */
export const WORKTREES_EXCLUDE = `${WORKTREES_DIR}/`;
/** Prazo de cada chamada de git. */
export const GIT_TIMEOUT_MS = 20_000;
/** Saída de `git diff` de um repo grande passa fácil do 1 MB default do execFile. */
const MAX_BUFFER = 32 * 1024 * 1024;

export type GitErrorCode =
  | 'not-a-repo'
  | 'dirty-base'
  | 'dirty-worktree'
  | 'not-merged'
  | 'exists'
  /** `--ff-only` recusado: a base andou desde que a tarefa nasceu (409). */
  | 'not-ff'
  /** Merge com conflito, já desfeito (`merge --abort`) — resolver no terminal (409). */
  | 'conflict'
  /** O worktree principal está em outro branch; o Bridge NÃO troca o checkout (409). */
  | 'base-not-checked-out'
  /** O base está em uso por OUTRO worktree — o git nem deixaria dar checkout (409). */
  | 'base-in-use'
  /** Repo sem nenhum commit: não há de onde tirar um worktree (422). */
  | 'no-commits'
  /** `PATCH .../worktree { base }` com um ref que não existe no repo (422). */
  | 'unknown-ref'
  /**
   * O repositório declara driver de `filter.*` e o dono ainda não disse que
   * confia nele (409). Ver `listFilterDrivers`.
   */
  | 'filters-untrusted'
  | 'git-failed';

/**
 * Erro tipado do serviço git.
 *
 * - `code` — o CONTRATO com a UI e com a CLI: é ele (nunca o texto, nunca o
 *   `detail`) que decide o status HTTP e o próximo passo do cliente.
 * - `detail` — texto humano de apoio, quando existe algo a listar (o
 *   `--porcelain` do worktree sujo, o nome do base). Nunca um marcador.
 * - `stderr` — a saída CRUA do git, sempre que houve uma. Existe porque a
 *   mensagem pt-BR dos casos tratados é uma explicação e não a evidência: sem
 *   isto, um `--ff-only` que falhou por um motivo que não é "não é
 *   fast-forward" sumiria sem deixar rastro.
 * - `i18n` — a CHAVE do catálogo e os parâmetros dela. A rota monta o texto
 *   com o `core.language()` do instante da resposta (spec §13); o `message`
 *   herdado do `Error` fica em pt-BR, que é o idioma do `core.log`.
 */
export class GitError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(
    readonly code: GitErrorCode,
    i18n: I18nMessage,
    readonly detail?: string,
    readonly stderr?: string,
  ) {
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'GitError';
  }
}

/** Saída crua do git de um erro que já passou por `runGit`. */
function stderrOf(err: unknown): string {
  if (!(err instanceof GitError)) return '';
  return (err.stderr ?? err.detail ?? '').trim();
}

export interface RepoInfo {
  /** Toplevel do `cwd` consultado — num worktree, o próprio worktree. */
  root: string;
  /** Branch corrente; `HEAD` literal quando o checkout está destacado. */
  branch: string;
  isWorktree: boolean;
  /** Branch do worktree PRINCIPAL (o base da tarefa). Só quando `isWorktree`. */
  base?: string;
  /** Igual a `root`, presente só quando `isWorktree` — deixa o chamador explícito. */
  worktreePath?: string;
  /**
   * Caminho do worktree principal (primeira entrada de `git worktree list`).
   * Fora do brief, mas é o único jeito de, a partir de um workspace de
   * worktree, achar o repo onde `mergeIntoBase`/`removeWorktree` têm que
   * rodar sem consultar o git de novo.
   */
  mainPath: string;
  /**
   * O repo tem pelo menos um commit (`rev-parse --verify HEAD`).
   *
   * Um `git init` sem commit nenhum é repo pra todos os efeitos do git, mas
   * não serve de origem de tarefa (o `worktree add` não tem de onde partir) e
   * não merece entrar na lista de repositórios do diálogo. É o caso da pasta
   * `%USERPROFILE%` desta máquina, que adotava todo workspace criado dentro
   * de `%TEMP%`.
   */
  hasCommits: boolean;
}

/** O `+N ~M` da sidebar. A forma canônica mora no `@bridge/shared`. */
export type { GitStatus };

/**
 * Contenção do `.git/config` do repositório ABERTO (BR-03, R3).
 *
 * O git executa comandos declarados na config do próprio repo, e `core.fsmonitor`
 * é acionado pelo `git status` — a chamada que o poller do Bridge faz sozinho a
 * cada 15 s, sem clique nenhum. Um repo hostil (zip/backup/pendrive, que ao
 * contrário do `clone` preserva o `.git/config`) vira execução de comando
 * repetida só por ter um workspace aberto. `-c` na linha de comando ganha do
 * arquivo, então a neutralização é central e vale pra TODA chamada daqui.
 *
 * `core.pager=cat` fecha a mesma família pelo lado da leitura. `core.hooksPath`
 * só é desligado nos comandos PASSIVOS (`noHooks`): `worktree add`/`merge` são
 * ações explícitas do dono e os hooks dele ali são legítimos (BR-18, aceito).
 *
 * `diff.external` NÃO entra: `-c diff.external=` (vazio) faz o git tentar
 * spawnar `""` e abortar com `external diff died` — quebraria qualquer `git
 * diff` futuro. Nenhum comando deste módulo roda `diff`/`log`/`show`, que são
 * os únicos que consultam esse config; quando algum rodar, o certo é
 * `--no-ext-diff` NA CHAMADA.
 *
 * **Os drivers de `filter.*` NÃO são neutralizados** — ver
 * `listFilterDrivers` logo abaixo. Eles SÃO executados pelo `git status`
 * (correção de uma afirmação errada das ondas 1 e 2 desta fase), mas
 * desligá-los quebra repositório legítimo: com `git-crypt`, `nbstripout` ou
 * `git-lfs`, um `clean` vazio faz todo arquivo filtrado parecer modificado
 * para sempre — `dirty` cravado, e o "Mesclar"/"Remover worktree" recusando
 * por `dirty-worktree` sem que o usuário tenha mexido em nada. A saída é
 * confiança explícita, não neutralização.
 */
let noHooksDir = join(tmpdir(), 'bridge-git-no-hooks');

/**
 * Onde fica a pasta VAZIA que serve de `core.hooksPath` nas chamadas passivas.
 * O core aponta pra dentro do perfil na subida (`<profileDir>/no-hooks`); o
 * default em `tmpdir()` só vale pra quem usa o módulo solto (testes).
 */
export function setNoHooksDir(dir: string): void {
  noHooksDir = dir;
  try {
    mkdirSync(noHooksDir, { recursive: true });
  } catch {
    // o git aceita `hooksPath` inexistente também; a pasta é só higiene.
  }
}

export function containmentArgs(noHooks: boolean): string[] {
  const args = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.useBuiltinFSMonitor=false',
    '-c',
    'core.pager=cat',
  ];
  if (noHooks) {
    try {
      mkdirSync(noHooksDir, { recursive: true });
    } catch {
      // pasta vazia é um detalhe: o git aceita `hooksPath` inexistente também.
    }
    args.push('-c', `core.hooksPath=${noHooksDir}`);
  }
  return args;
}

// ------------------------------------------------- filtros: modelo de confiança

/** Chave de config que declara um driver de filtro: `filter.<nome>.<campo>`. */
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/;

/**
 * Nome sintético usado quando a ENUMERAÇÃO falha. Fail-closed: não saber quais
 * drivers existem é tratado como "existem", nunca como "não existem".
 */
export const FILTER_ENUM_FAILED = ptBRMessage({ key: 'core.erro.git.enumeracaoFalhou' });

/** Cache dos drivers por `cwd` — o poller bate no mesmo repo a cada 15 s. */
const filterCache = new Map<string, { at: number; drivers: string[] }>();
/** Validade do cache. Abaixo do intervalo do poller, então cada ciclo relê no máximo uma vez. */
export const FILTER_CACHE_MS = 10_000;
/** Teto do cache: um workspace por repo; 200 é folga de sobra. */
const FILTER_CACHE_MAX = 200;
/** Enumerações em curso, por `cwd` — quem chega no meio espera a mesma promessa. */
const filterInFlight = new Map<string, Promise<string[]>>();
/**
 * Geração do cache: `invalidateFilterCache` a incrementa, e a enumeração que
 * começou antes disso não grava o resultado dela por cima.
 */
let filterGeneration = 0;

/**
 * Esvazia o cache. Sem argumento limpa tudo (teste); com `cwd`, só aquele repo
 * — é o que a mudança de confiança tem que fazer pra valer na hora.
 */
export function invalidateFilterCache(cwd?: string): void {
  filterGeneration += 1;
  if (cwd === undefined) {
    filterCache.clear();
    gitlinkFreeIndex.clear();
  } else {
    filterCache.delete(cwd);
    gitlinkFreeIndex.delete(cwd);
  }
}

/**
 * Memória de "este índice não tinha gitlink nenhum", por `cwd`.
 *
 * O valor é a ASSINATURA do arquivo de índice (`tamanho:mtimeMs:ctimeMs`) na
 * leitura que não achou gitlink. Enquanto ela não muda, o índice é bit a bit o mesmo e
 * `git ls-files --stage` só pode devolver o mesmo conteúdo — então a chamada é
 * pulada. Qualquer `git add`, checkout, merge ou `git submodule add` reescreve
 * o índice, a assinatura muda e a leitura volta a acontecer.
 *
 * Por que existe (BACKLOG): a enumeração de filtros roda por repositório a
 * cada ciclo do poller, e `ls-files --stage -z` lê o índice INTEIRO só pra
 * achar as linhas de modo `160000`. Medido num repo sintético de 20 000
 * arquivos: 60–75 ms por chamada contra ~44 ms de piso de processo, ou seja a
 * enumeração completa cai de ~208 ms para ~133 ms quando ela é pulada (~36%).
 * Em 2 000 arquivos a chamada custa ~36 ms; o excedente sobre o piso cresce
 * junto com o índice (~1,2 ms por 1 000 arquivos), então quanto maior o
 * monorepo, mais a economia importa.
 */
const gitlinkFreeIndex = new Map<string, string>();
/** Mesmo teto do `filterCache`: um repositório por workspace. */
const GITLINK_MEMO_MAX = 200;

/**
 * `tamanho:mtimeMs:ctimeMs` do arquivo de índice de `cwd`, ou `undefined`
 * quando não dá pra saber.
 *
 * Os três campos, e não só o `mtime`: o `ctime` do Windows muda em reescrita
 * que preserve o mtime, e o tamanho pega a reescrita que caia no mesmo tique
 * dos dois relógios. É defesa em profundidade barata — são três números do
 * mesmo `stat`.
 *
 * O gitdir é resolvido SEM chamar o git (seria trocar um processo por outro):
 * `.git` é a pasta em si num repositório comum, ou um arquivo
 * `gitdir: <caminho>` num worktree/submódulo. Qualquer coisa fora desses dois
 * formatos — `.git` ausente, ilegível, apontando pra um índice que não existe
 * — devolve `undefined`, e `undefined` NUNCA autoriza pular a chamada.
 */
function indexSignature(cwd: string): string | undefined {
  try {
    const dotGit = join(cwd, '.git');
    const stat = statSync(dotGit);
    let gitDir = dotGit;
    if (!stat.isDirectory()) {
      const pointer = readFileSync(dotGit, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return undefined;
      gitDir = resolve(cwd, pointer.slice('gitdir:'.length).trim());
    }
    const index = statSync(join(gitDir, 'index'));
    return `${index.size}:${index.mtimeMs}:${index.ctimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * A leitura de gitlinks do índice (`git ls-files --stage -z`) precisa rodar
 * nesta enumeração?
 *
 * Exportada pro teste conseguir afirmar o atalho sem espionar processo. A
 * resposta é **sim** em tudo que não for o caso comprovadamente seguro: há
 * `.gitmodules`, ou a assinatura do índice não é a mesma da última leitura sem
 * gitlink, ou nem deu pra ler a assinatura.
 */
export function shouldReadIndexGitlinks(cwd: string): boolean {
  if (existsSync(join(cwd, '.gitmodules'))) return true;
  const signature = indexSignature(cwd);
  return signature === undefined || gitlinkFreeIndex.get(cwd) !== signature;
}

export function parseFilterDrivers(configList: string): string[] {
  const names = new Set<string>();
  for (const raw of configList.split('\n')) {
    const match = FILTER_KEY.exec(raw.trim());
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * Drivers de filtro declarados PELO REPOSITÓRIO (BR-03, modelo de confiança).
 *
 * Por que DETECTAR e não desligar: um `clean`/`smudge` do repo roda a cada
 * `git status` que precise comparar CONTEÚDO — e isso acontece sempre que um
 * arquivo rastreado tem o mesmo tamanho e mtime novo, o caso comum de arquivo
 * editado. É execução de comando do repositório, sem clique nenhum, a cada
 * passada do poller. Mas os filtros legítimos (`git-crypt`, `nbstripout`,
 * `git-lfs`) são exatamente a mesma coisa, e desligá-los faz todo arquivo
 * filtrado parecer modificado para sempre. Então o Bridge não decide: ele
 * PERGUNTA (`Repo.trustFilters`), e enquanto a resposta não vem não roda
 * comando que toque conteúdo naquele repo.
 *
 * Os dois escopos importam:
 * - `--local` é o `.git/config`;
 * - `--worktree` é o `.git/worktrees/<x>/config.worktree`, que existe quando
 *   `extensions.worktreeConfig` está ligada — um worktree hostil pode declarar
 *   driver só ali.
 *
 * `--includes` é obrigatório: sem ele um `include.path = evil.cfg` esconde o
 * driver da listagem (medido). E como nada aqui vira argumento `-c`, um nome
 * de driver com `=` (`filter.a=b.clean`) é detectado sem problema — era a
 * outra falha do desenho da rodada 2.
 */
/** Até onde a busca por submódulo desce. Aninhamento além disso é patológico. */
const SUBMODULE_MAX_DEPTH = 3;

/** Um submódulo declarado no `.gitmodules`. */
export interface SubmoduleEntry {
  name: string;
  path: string;
}

/**
 * Lê a saída de `git config -f .gitmodules -z --get-regexp ^submodule[.].*[.]path$`.
 *
 * Fix round 5: a versão anterior partia cada linha no PRIMEIRO espaço, e o
 * NOME do submódulo entra na chave — `git submodule add --name "meu sub"`
 * produz `submodule.meu sub.path libs/um`, então o "valor" saía como
 * `sub.path libs/um` e o submódulo sumia da conta. Com `-z` o git separa os
 * REGISTROS por `\0` e, dentro de cada um, a chave do valor por `\n` — sem
 * ambiguidade nenhuma, com espaço ou ponto no nome.
 *
 * O nome sai da chave por prefixo/sufixo GULOSO (`submodule.` … `.path`),
 * que é o que preserva `a.b` inteiro.
 */
export function parseSubmoduleEntries(configOutput: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  for (const record of configOutput.split('\0')) {
    if (record === '') continue;
    const nl = record.indexOf('\n');
    if (nl === -1) continue;
    const key = record.slice(0, nl);
    const path = record.slice(nl + 1);
    if (path === '') continue;
    if (!key.startsWith('submodule.') || !key.endsWith('.path')) continue;
    const name = key.slice('submodule.'.length, key.length - '.path'.length);
    entries.push({ name, path });
  }
  return entries;
}

/** Só os caminhos — o que a busca por driver precisa. */
export function parseSubmodulePaths(configOutput: string): string[] {
  return parseSubmoduleEntries(configOutput).map((entry) => entry.path);
}

/**
 * Caminhos de GITLINK (`mode 160000`) da saída de `git ls-files --stage -z`.
 *
 * Fix round 5: o `.gitmodules` é conveniência versionada, não a verdade. Um
 * repositório hostil pode ter o gitlink no índice E o gitdir armado em
 * `.git/modules/<x>` SEM a entrada correspondente no `.gitmodules` — e aí a
 * busca guiada só pelo arquivo não olharia lá. O índice é a outra fonte, e as
 * duas são unidas.
 *
 * Formato de cada registro: `<mode> <sha> <stage>\t<caminho>`.
 */
export function parseGitlinkPaths(lsFilesOutput: string): string[] {
  const paths: string[] = [];
  for (const record of lsFilesOutput.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    if (!record.startsWith('160000 ')) continue;
    const path = record.slice(tab + 1);
    if (path !== '') paths.push(path);
  }
  return paths;
}

/** Marcador de submódulo cujo caminho declarado não é confiável (fix round 5). */
export const SUBMODULE_PATH_INVALID = ptBRMessage({ key: 'core.erro.git.submoduloInvalido' });

/**
 * O caminho relativo declarado aponta pra DENTRO do repo?
 *
 * Fix round 5: `path = ../fora` (ou um caminho absoluto) num `.gitmodules`
 * hostil faria o Bridge rodar `git` numa pasta escolhida pelo repositório,
 * fora dele — exatamente o tipo de coisa que a detecção existe pra evitar.
 * Entrada inválida NÃO é seguida: conta como suspeita e pronto.
 */
export function isSafeSubmodulePath(cwd: string, relative: string): boolean {
  if (relative === '') return false;
  if (isAbsolute(relative)) return false;
  // `..` em QUALQUER segmento, nas duas convenções de separador.
  if (relative.split(/[\\/]/).some((segment) => segment === '..')) return false;
  const base = resolve(cwd);
  return isUnder(base, resolve(base, relative));
}

/**
 * `target` está estritamente DENTRO de `base`?
 *
 * O `+ sep` cru não serve na raiz de uma unidade: `resolve('C:\\')` já termina
 * em `\`, e `'C:\\repo'.startsWith('C:\\\\')` é falso — um repositório aberto
 * na raiz de um disco reprovaria todo submódulo dele (Task 3).
 */
function isUnder(base: string, target: string): boolean {
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target !== base && target.startsWith(prefix);
}

/**
 * A pasta do submódulo E o gitdir que o git resolveu pra ela ficam, de fato,
 * dentro do repositório?
 *
 * `isSafeSubmodulePath` responde pelo caminho DECLARADO; esta responde pelo
 * caminho REAL. É o que fecha as duas variantes que a contenção sintática não
 * pega (Task 3): a pasta do submódulo ser uma junction/symlink pra fora, e o
 * `.git` dele ser um arquivo `gitdir: <caminho de fora>`. Qualquer erro de
 * `realpath` (pasta que sumiu no meio, permissão) responde **false** — o
 * caminho vira suspeito, não confiável.
 */
function isContainedRealPath(cwd: string, subPath: string, gitDir: string): boolean {
  try {
    const base = realpathSync.native(resolve(cwd));
    return isUnder(base, realpathSync.native(resolve(subPath))) && isUnder(base, realpathSync.native(resolve(gitDir)));
  } catch {
    return false;
  }
}

/** Enumera os drivers declarados NO gitdir de `cwd` (sem descer em submódulo). */
async function driversOfGitDir(cwd: string): Promise<{ names: string[]; enumerated: boolean }> {
  const names = new Set<string>();
  let enumerated = false;
  for (const scope of ['--local', '--worktree'] as const) {
    try {
      const { stdout } = await runGit(['config', scope, '--includes', '--name-only', '--list'], cwd, GIT_TIMEOUT_MS, {
        noHooks: true,
      });
      enumerated = true;
      for (const name of parseFilterDrivers(stdout)) names.add(name);
    } catch {
      // `--worktree` num repo sem a extensão costuma cair no local e sair 0; um
      // erro aqui é anormal. Se NENHUM escopo respondeu, o chamador trata como
      // fail-closed.
    }
  }
  return { names: [...names], enumerated };
}

/**
 * Drivers dos SUBMÓDULOS inicializados de `cwd`, recursivamente.
 *
 * Por que isto existe (fix round 4): a config de um submódulo não mora no
 * `.git/config` do superprojeto — ela fica em `.git/modules/<sub>/config` (ou
 * `.git/worktrees/<wt>/modules/<sub>/config`). A enumeração do pai não a
 * enxerga (medido), então um driver escondido ali passava pelo modelo de
 * confiança inteiro.
 *
 * DUAS fontes de caminho, unidas (fix round 5):
 * - o `.gitmodules` versionado, lido com `-z` (nome com espaço quebrava o
 *   parser anterior);
 * - os GITLINKS do índice (`ls-files --stage`, modo `160000`), porque um
 *   gitlink com o gitdir armado e SEM entrada no `.gitmodules` continua sendo
 *   um submódulo que o git visita.
 *
 * Cada gitdir é fail-closed por conta própria: se a leitura de um submódulo
 * falhar, ele conta como "tem driver" em vez de sumir da conta. Um
 * `.gitmodules` presente e ilegível também, e um caminho que aponta pra fora
 * do repo NÃO é seguido (vira `SUBMODULE_PATH_INVALID`).
 */
async function submoduleDrivers(cwd: string, depth: number): Promise<string[]> {
  if (depth > SUBMODULE_MAX_DEPTH) return [];

  const found = new Set<string>();
  const candidates = new Set<string>();

  // Fonte 1: o `.gitmodules` versionado.
  const hasGitmodules = existsSync(join(cwd, '.gitmodules'));
  try {
    const { stdout } = await runGit(
      ['config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule[.].*[.]path$'],
      cwd,
      GIT_TIMEOUT_MS,
      { noHooks: true },
    );
    for (const path of parseSubmodulePaths(stdout)) candidates.add(path);
  } catch {
    // Sem `.gitmodules` o git sai != 0 — o caso normal, custo zero. Só é
    // fail-closed quando o arquivo EXISTE e não deu pra ler.
    if (hasGitmodules) found.add(FILTER_ENUM_FAILED);
  }

  // Fonte 2: os gitlinks do índice. O `.gitmodules` é conveniência
  // versionada; o índice é o que o git realmente trata como submódulo.
  //
  // A chamada só é PULADA quando as três condições valem juntas: não há
  // `.gitmodules`, a última leitura deste `cwd` não achou gitlink nenhum, e o
  // arquivo de índice continua com a mesma assinatura de então (ou seja,
  // ninguém o reescreveu). Falta qualquer uma — inclusive não conseguir ler a
  // assinatura — e o `ls-files` roda, que é o lado fail-closed: pular por
  // engano esconderia um submódulo com driver de filtro, que é exatamente o
  // que o BR-03 existe pra pegar.
  if (shouldReadIndexGitlinks(cwd)) {
    // A assinatura é lida ANTES do `ls-files`: gravar a de depois marcaria
    // como "sem gitlink" um índice que pode ter sido reescrito no meio da
    // leitura, e a reescrita ficaria sem uma releitura pra cobri-la.
    const signature = indexSignature(cwd);
    try {
      const { stdout } = await runGit(['ls-files', '--stage', '-z'], cwd, GIT_TIMEOUT_MS, { noHooks: true });
      const gitlinks = parseGitlinkPaths(stdout);
      for (const path of gitlinks) candidates.add(path);
      // Só a leitura BEM-SUCEDIDA e sem gitlink nenhum autoriza o atalho da
      // próxima vez; qualquer outro desfecho apaga a memória.
      if (gitlinks.length === 0 && signature !== undefined && !hasGitmodules) {
        if (gitlinkFreeIndex.size >= GITLINK_MEMO_MAX) gitlinkFreeIndex.clear();
        gitlinkFreeIndex.set(cwd, signature);
      } else {
        gitlinkFreeIndex.delete(cwd);
      }
    } catch {
      // Índice ilegível: o repo já é suspeito.
      found.add(FILTER_ENUM_FAILED);
      gitlinkFreeIndex.delete(cwd);
    }
  }

  for (const relative of candidates) {
    // Contenção ANTES de qualquer `git`: um caminho que sai do repo não é
    // seguido de jeito nenhum — nem pra medir.
    if (!isSafeSubmodulePath(cwd, relative)) {
      found.add(SUBMODULE_PATH_INVALID);
      continue;
    }
    const subPath = join(cwd, relative);
    // Submódulo não inicializado não tem `.git` e não executa nada.
    if (!existsSync(join(subPath, '.git'))) continue;
    let gitDir: string;
    try {
      // `--absolute-git-dir` (e não `--git-dir`) porque o resultado é
      // VERIFICADO logo abaixo: a pasta do submódulo pode ser uma junction, e
      // o `.git` pode ser um ARQUIVO `gitdir: <caminho de fora>` — nos dois
      // casos o caminho relativo passou pela contenção sintática e mesmo assim
      // levaria o `git config` pra fora do repositório (Task 3).
      // A enumeração roda com o `cwd` do submódulo, que é como o git acha a
      // config dele — `.git/modules/<sub>/config`, invisível pro pai.
      const { stdout } = await runGit(['rev-parse', '--absolute-git-dir'], subPath, GIT_TIMEOUT_MS, { noHooks: true });
      gitDir = stdout.trim();
    } catch {
      found.add(FILTER_ENUM_FAILED);
      continue;
    }
    if (!isContainedRealPath(cwd, subPath, gitDir)) {
      found.add(SUBMODULE_PATH_INVALID);
      continue;
    }
    const { names, enumerated } = await driversOfGitDir(subPath);
    if (!enumerated) found.add(FILTER_ENUM_FAILED);
    for (const name of names) found.add(name);
    for (const name of await submoduleDrivers(subPath, depth + 1)) found.add(name);
  }
  return [...found];
}

export async function listFilterDrivers(cwd: string): Promise<string[]> {
  const cached = filterCache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < FILTER_CACHE_MS) return cached.drivers;

  // Dedupe em voo (Task 3): o cache só é preenchido no FIM da enumeração, e ela
  // dispara `git config` em cada submódulo. Sem isto, o tick do poller e uma
  // ação do usuário no mesmo repo (ou dois workspaces do mesmo repo) rodavam a
  // varredura inteira em paralelo — quem chega no meio agora espera a mesma
  // promessa.
  const running = filterInFlight.get(cwd);
  if (running !== undefined) return running;

  const generation = filterGeneration;
  const promise = (async (): Promise<string[]> => {
    const { names, enumerated } = await driversOfGitDir(cwd);
    const all = new Set(enumerated ? names : [FILTER_ENUM_FAILED]);
    // Só desce nos submódulos quando o gitdir de cima respondeu: com a
    // enumeração do pai já falhando, o repo inteiro já conta como suspeito.
    if (enumerated) {
      for (const name of await submoduleDrivers(cwd, 1)) all.add(name);
    }
    const drivers = [...all];

    // Invalidação no meio do caminho (o dono acabou de confiar/desconfiar, ou
    // um teste zerou o cache) manda no resultado: gravar aqui reporia a leitura
    // VELHA por mais 10 s.
    if (generation === filterGeneration) {
      if (filterCache.size >= FILTER_CACHE_MAX) filterCache.clear();
      filterCache.set(cwd, { at: Date.now(), drivers });
    }
    return drivers;
  })();

  filterInFlight.set(cwd, promise);
  try {
    return await promise;
  } finally {
    filterInFlight.delete(cwd);
  }
}

export async function repoHasFilterDrivers(cwd: string): Promise<boolean> {
  return (await listFilterDrivers(cwd)).length > 0;
}

/** A chave da mensagem que a UI e a CLI mostram no 409. */
export const FILTERS_UNTRUSTED_KEY = 'core.erro.git.filtrosSemConfianca' as const;

/** A mesma frase em pt-BR — o que vai pro log e o que os testes citam. */
export const FILTERS_UNTRUSTED_MESSAGE = ptBRMessage({ key: FILTERS_UNTRUSTED_KEY });

/**
 * Porta das AÇÕES do usuário (merge, remoção): repo com driver de filtro e sem
 * confiança declarada não roda `git status` — que é o comando que executaria o
 * `clean` do repositório.
 */
export async function assertFiltersTrusted(cwd: string, trustFilters: boolean): Promise<void> {
  if (trustFilters) return;
  if (!(await repoHasFilterDrivers(cwd))) return;
  throw new GitError('filters-untrusted', { key: FILTERS_UNTRUSTED_KEY });
}

/**
 * Roda `git` e devolve a saída. Erro do git (status ≠ 0) vira `GitError`
 * `git-failed` com o stderr no `detail` — quem quiser tratar um caso
 * específico (branch inexistente, merge não-ff) captura e decide.
 */
export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
  opts: { noHooks?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const full = [...containmentArgs(opts.noHooks === true), ...args];
  return new Promise((res, rej) => {
    execFile(
      'git',
      full,
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).trim();
          rej(new GitError('git-failed', { key: 'core.erro.git.falhou', params: { comando: args[0] ?? '' } }, detail, detail));
          return;
        }
        res({ stdout, stderr });
      },
    );
  });
}

// ------------------------------------------------------------------ auxiliares

/** Caminho do git (sempre com `/`) → caminho nativo do Windows. */
function toNative(gitPath: string): string {
  return resolve(gitPath.trim());
}

/** Comparação de caminho no Windows: separador e caixa não distinguem nada. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/** Linhas não vazias de uma saída porcelain. */
function countLines(out: string): number {
  return out.split('\n').filter((line) => line.trim() !== '').length;
}

interface WorktreeEntry {
  path: string;
  /** `undefined` em checkout destacado (`detached`). */
  branch?: string;
}

/**
 * Parseia `git worktree list --porcelain`. A PRIMEIRA entrada é sempre o
 * worktree principal — é dela que sai a branch base de uma tarefa.
 */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: toNative(line.slice('worktree '.length)) };
      continue;
    }
    if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Branch corrente de `cwd`.
 *
 * `rev-parse --abbrev-ref HEAD` é o caminho normal, mas ele FALHA (status 128)
 * num repo recém-criado por `git init` sem nenhum commit — HEAD aponta pra um
 * branch que ainda não existe. Abrir um workspace numa pasta assim é comum, e
 * não pode derrubar a detecção; nesse caso o `symbolic-ref` ainda sabe o nome.
 * Último recurso: o literal `HEAD` (é o que `--abbrev-ref` devolve em checkout
 * destacado, então a sidebar já sabe mostrar isso).
 */
export async function currentBranch(cwd: string): Promise<string> {
  try {
    const out = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
    if (out !== '') return out;
  } catch {
    // repo sem commit: cai pro symbolic-ref.
  }
  try {
    const out = (await runGit(['symbolic-ref', '--short', 'HEAD'], cwd, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
    if (out !== '') return out;
  } catch {
    // HEAD destacado num repo sem commit — não deveria acontecer.
  }
  return 'HEAD';
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot, GIT_TIMEOUT_MS, { noHooks: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * O ref existe no repo? Vale pra `main`, `origin/main`, tag ou SHA — é o que
 * `PATCH /api/workspaces/:id/worktree` usa pra recusar um base digitado errado
 * ANTES de gravá-lo (um base inexistente faria o `+N` zerar em silêncio e o
 * "Mesclar no base" apontar pra lugar nenhum).
 */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot, GIT_TIMEOUT_MS, { noHooks: true });
    return true;
  } catch {
    return false;
  }
}

/** O repo tem pelo menos um commit? (`git init` sem commit ainda não tem HEAD.) */
async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd, GIT_TIMEOUT_MS, { noHooks: true });
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- serviço

/**
 * Repo do `cwd`, ou `null` se ele não está num repo git (workspace numa pasta
 * qualquer é o caso normal — não é erro).
 */
export async function detectRepo(cwd: string): Promise<RepoInfo | null> {
  let toplevel: string;
  try {
    toplevel = (await runGit(['rev-parse', '--show-toplevel'], cwd, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
  } catch {
    return null;
  }
  if (toplevel === '') return null;
  const root = toNative(toplevel);

  // Em checkout destacado sai o literal `HEAD` — é honesto: não existe branch
  // pra mostrar na sidebar.
  const branch = await currentBranch(cwd);
  const entries = parseWorktreeList((await runGit(['worktree', 'list', '--porcelain'], cwd, GIT_TIMEOUT_MS, { noHooks: true })).stdout);
  const main = entries[0];
  const mainPath = main?.path ?? root;
  const isWorktree = !samePath(mainPath, root);

  const info: RepoInfo = { root, branch, isWorktree, mainPath, hasCommits: await hasCommits(cwd) };
  if (isWorktree) {
    info.base = main?.branch;
    info.worktreePath = root;
  }
  return info;
}

/**
 * Caminhos de TODOS os worktrees do repo (o principal incluído).
 *
 * Fix round 4: o escopo `--worktree` da config é POR worktree, então a
 * enumeração de filtros feita só na raiz pode perder um driver declarado num
 * worktree secundário — e é dentro dele que o `status` do poller roda.
 */
export async function worktreePaths(repoRoot: string): Promise<string[]> {
  const out = (await runGit(['worktree', 'list', '--porcelain'], repoRoot, GIT_TIMEOUT_MS, { noHooks: true })).stdout;
  return parseWorktreeList(out).map((entry) => entry.path);
}

/**
 * Garante `entry` no `.git/info/exclude` (idempotente).
 *
 * Não é `.gitignore`: o `.worktrees/` é detalhe da máquina do usuário e não
 * pode virar alteração no repo dele — o Bridge não commita nada (regra do
 * user). Num worktree o `info/` mora no gitdir COMUM, por isso o
 * `--git-common-dir` em vez de `join(repoRoot, '.git')`.
 */
export async function ensureExclude(repoRoot: string, entry: string): Promise<void> {
  const common = (await runGit(['rev-parse', '--git-common-dir'], repoRoot, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
  const gitDir = isAbsolute(common) ? resolve(common) : resolve(repoRoot, common);
  const infoDir = join(gitDir, 'info');
  const excludePath = join(infoDir, 'exclude');

  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    // Repo recém-criado pode não ter o arquivo ainda.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;

  await mkdir(infoDir, { recursive: true });
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(excludePath, `${current}${separator}${entry}\n`, 'utf8');
}

/**
 * `git worktree add .worktrees/<nome> -b <nome> <base>`.
 *
 * Recusa com `exists` ANTES de chamar o git quando a pasta ou o branch já
 * existem: a mensagem do git pra isso é críptica, e a rota precisa do código
 * pra devolver 409 em vez de 422.
 */
export async function createWorktree(
  repoRoot: string,
  name: string,
  base: string,
): Promise<{ path: string; branch: string }> {
  const branch = normalizeTaskName(name);
  const path = join(repoRoot, WORKTREES_DIR, branch);

  if (existsSync(path)) {
    throw new GitError('exists', { key: 'core.erro.git.pastaExiste', params: { caminho: `${WORKTREES_DIR}/${branch}` } }, path);
  }
  if (await branchExists(repoRoot, branch)) {
    throw new GitError('exists', { key: 'core.erro.git.branchExiste', params: { branch } }, branch);
  }

  // Antes do `add`: se o worktree nascer primeiro e a escrita do exclude
  // falhar, o repo do usuário fica com uma pasta suja aparecendo no status.
  await ensureExclude(repoRoot, WORKTREES_EXCLUDE);
  await runGit(['worktree', 'add', `${WORKTREES_DIR}/${branch}`, '-b', branch, '--', base], repoRoot);
  return { path, branch };
}

/**
 * Uma passada de `git status --porcelain=v2 --branch` (R5).
 *
 * Pura: recebe a saída CRUA e devolve o que a sidebar precisa. A leitura é uma
 * chamada só porque o poller roda a cada 15 s por tarefa — antes eram duas
 * (`rev-list` + `status`), dois processos `git` por tarefa por ciclo.
 *
 * - `# branch.head <nome>` — branch corrente (`(detached)` quando destacado);
 * - `# branch.upstream <ref>` e `# branch.ab +N -M` — só existem quando o
 *   branch tem upstream configurado;
 * - linhas `1 `/`2 `/`u `/`? ` — arquivo alterado, renomeado, em conflito e
 *   não rastreado. Cada uma conta um no `~M`.
 */
export function parseStatusV2(out: string): { branch: string; upstream?: string; ahead?: number; dirty: number } {
  let branch = 'HEAD';
  let upstream: string | undefined;
  let ahead: number | undefined;
  let dirty = 0;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      // `(detached)` é o jeito do porcelain v2 dizer HEAD destacado; a sidebar
      // já sabe mostrar o literal `HEAD`.
      branch = value === '(detached)' ? 'HEAD' : value;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const parsed = Number.parseInt(line.slice('# branch.ab '.length).trim().split(' ')[0] ?? '', 10);
      if (Number.isFinite(parsed)) ahead = Math.abs(parsed);
      continue;
    }
    if (line.startsWith('#')) continue;
    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ') || line.startsWith('? ')) dirty += 1;
  }
  return { branch, upstream, ahead, dirty };
}

/**
 * `+N ~M` da sidebar (spec §6) pra um worktree.
 *
 * `--untracked-files=all` porque arquivo novo é o caso mais comum de "mexi em
 * algo" num worktree de tarefa, e o default (`normal`) resume uma pasta
 * inteira numa linha só.
 *
 * O `+N` sai do `# branch.ab` da MESMA leitura quando o upstream do branch é o
 * próprio base (o caso barato); em qualquer outro caso vem de um
 * `rev-list --count <base>..HEAD`, porque `branch.ab` conta contra o upstream
 * e um upstream que não é o base daria um número que não é o da spec.
 */
export async function status(
  worktreePath: string,
  base: string,
  opts: { trustFilters?: boolean } = {},
): Promise<GitStatus> {
  // BR-03: repo com driver de filtro e sem confiança do dono NÃO recebe comando
  // que toque conteúdo. `currentBranch` (`rev-parse --abbrev-ref HEAD`) lê só o
  // HEAD, então a sidebar continua mostrando o branch certo — o que some é o
  // `+N ~M`, com o motivo no `error` pra UI explicar em vez de mentir zero.
  if (opts.trustFilters !== true && (await repoHasFilterDrivers(worktreePath))) {
    return {
      branch: await currentBranch(worktreePath),
      base,
      ahead: 0,
      dirty: 0,
      at: Date.now(),
      error: 'filters-untrusted',
    };
  }
  const porcelain = (
    await runGit(
      // `--ignore-submodules=all`: o `status` do superprojeto desce no
      // submódulo pra dizer se ele está sujo, e essa descida passa pelo
      // `update-index --refresh` DELE — que roda o `clean` do driver declarado
      // no config do submódulo (medido: o refresh executa o filtro). O config do
      // submódulo mora em `.git/modules/<sub>/config`, fora do alcance da
      // confiança do repo pai. Preço: submódulo sujo deixa de contar no `~M`.
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=all'],
      worktreePath,
      GIT_TIMEOUT_MS,
      { noHooks: true },
    )
  ).stdout;
  const parsed = parseStatusV2(porcelain);

  let ahead: number;
  if (parsed.ahead !== undefined && parsed.upstream !== undefined && sameRef(parsed.upstream, base)) {
    ahead = parsed.ahead;
  } else {
    ahead = await countAhead(worktreePath, base);
  }

  return { branch: parsed.branch, base, ahead, dirty: parsed.dirty, at: Date.now() };
}

/** `origin/main` e `refs/remotes/origin/main` são o mesmo ref pro que importa aqui. */
function sameRef(a: string, b: string): boolean {
  const strip = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '');
  return strip(a) === strip(b);
}

/** `git rev-list --count <base>..HEAD`; 0 quando o base não existe mais. */
async function countAhead(worktreePath: string, base: string): Promise<number> {
  try {
    const out = (await runGit(['rev-list', '--count', `${base}..HEAD`], worktreePath, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // Base apagado/renomeado por fora: `+0` é melhor que derrubar o poller.
    return 0;
  }
}

/**
 * Mescla o branch da tarefa no base, dentro do worktree PRINCIPAL.
 *
 * Três recusas ANTES de encostar no merge, todas 409:
 * - `dirty-base` — alteração não commitada no principal; um merge por cima
 *   dela tira do usuário o controle do que aconteceu;
 * - `base-in-use` — o base está com checkout em OUTRO worktree (o git nem
 *   deixaria dar checkout aqui, e a mensagem dele é críptica);
 * - `base-not-checked-out` — o principal está em outro branch. O Bridge **não**
 *   dá `git checkout` no repo do usuário: trocar o branch do checkout que ele
 *   deixou aberto é mexer no ambiente de trabalho dele por conta própria, e um
 *   `merge` que só funciona depois disso é melhor recusado com o motivo.
 */
export async function mergeIntoBase(
  repoRoot: string,
  branch: string,
  base: string,
  mode: 'ff-only' | 'no-ff',
  opts: { trustFilters?: boolean; worktreePath?: string } = {},
): Promise<{ mode: 'ff-only' | 'no-ff'; message?: string }> {
  // BR-03: o `git status` daqui embaixo é o que executaria o `clean` do repo.
  await assertFiltersTrusted(repoRoot, opts.trustFilters === true);
  // ...e a RAIZ não vê o `config.worktree` do worktree da tarefa (escopo
  // `--worktree`, por worktree). O merge traz o conteúdo daquele branch pra cá
  // e o `checkout` do merge roda o `smudge` — um driver declarado só lá dentro
  // tem que barrar a mesclagem do mesmo jeito. `canRemoveWorktree` já checava
  // o worktree; aqui faltava.
  if (opts.worktreePath !== undefined && !samePath(opts.worktreePath, repoRoot)) {
    await assertFiltersTrusted(opts.worktreePath, opts.trustFilters === true);
  }
  const porcelain = (await runGit(['status', '--porcelain'], repoRoot, GIT_TIMEOUT_MS, { noHooks: true })).stdout;
  if (countLines(porcelain) > 0) {
    throw new GitError('dirty-base', { key: 'core.erro.git.baseSuja', params: { base } });
  }

  const head = await currentBranch(repoRoot);
  if (head !== base) {
    const holder = await worktreeHolding(repoRoot, base);
    if (holder && !samePath(holder, repoRoot)) {
      throw new GitError('base-in-use', { key: 'core.erro.git.baseEmUso', params: { base, worktree: holder } }, holder);
    }
    throw new GitError('base-not-checked-out', { key: 'core.erro.git.baseNaoCheckout', params: { head, base } }, head);
  }

  if (mode === 'ff-only') {
    try {
      await runGit(['merge', '--ff-only', '--', branch], repoRoot);
    } catch (err) {
      // `code: 'not-ff'` é contrato com a UI e com a CLI: é ele que faz o
      // diálogo oferecer o merge com commit em vez de só mostrar um erro. O
      // stderr do git vai junto (campo e mensagem) porque nem toda falha de
      // `--ff-only` é "não é fast-forward" — sem ele, um erro de outro tipo
      // apareceria pro usuário como um convite a tentar o no-ff, que falharia
      // de novo.
      const stderr = stderrOf(err);
      throw new GitError(
        'not-ff',
        stderr === ''
          ? { key: 'core.erro.git.naoFf', params: { branch, base } }
          : { key: 'core.erro.git.naoFfComGit', params: { branch, base, stderr } },
        undefined,
        stderr,
      );
    }
    return { mode: 'ff-only' };
  }

  const message = `Merge task/${branch}`;
  try {
    await runGit(['merge', '--no-ff', '-m', message, '--', branch], repoRoot);
  } catch (err) {
    const stderr = stderrOf(err);
    // Merge com CONFLITO não é só um erro: ele deixa o worktree principal no
    // meio do merge (`MERGE_HEAD`, arquivos `UU`). Como toda operação daqui
    // começa recusando `dirty-base`, sair sem desfazer trancaria o usuário —
    // "mesclar" e "remover worktree" passariam a falhar para sempre, sem o
    // Bridge dizer o porquê. Desfaz e devolve `conflict`: resolver conflito é
    // trabalho de terminal, não de diálogo.
    if (await inMergeState(repoRoot)) {
      try {
        await runGit(['merge', '--abort'], repoRoot);
      } catch {
        // `--abort` falhou (índice travado, arquivo em uso): o estado fica
        // sujo mesmo, e o `dirty-base` da próxima chamada é a mensagem certa.
      }
      throw new GitError(
        'conflict',
        { key: 'core.erro.git.conflito', params: { branch, base } },
        undefined,
        stderr,
      );
    }
    throw err;
  }
  return { mode: 'no-ff', message };
}

/**
 * Caminho do worktree que está com `branch` em checkout, se algum. O git só
 * deixa um worktree por branch — é por isso que "mesclar" pode esbarrar num
 * base que está aberto em outra tarefa.
 */
export async function worktreeHolding(repoRoot: string, branch: string): Promise<string | undefined> {
  const entries = parseWorktreeList((await runGit(['worktree', 'list', '--porcelain'], repoRoot, GIT_TIMEOUT_MS, { noHooks: true })).stdout);
  return entries.find((entry) => entry.branch === branch)?.path;
}

/** O worktree está no meio de um merge (existe `MERGE_HEAD`)? */
async function inMergeState(repoRoot: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repoRoot, GIT_TIMEOUT_MS, { noHooks: true });
    return true;
  } catch {
    return false;
  }
}

export interface RemovalBlock {
  code: 'dirty-worktree' | 'not-merged';
  /** A chave do catálogo — a MESMA que o `GitError` de `removeWorktree` carrega. */
  i18n: I18nMessage;
  detail?: string;
}

export type RemovalCheck = { ok: true } | ({ ok: false } & RemovalBlock);

/**
 * As duas recusas da remoção (spec §10), SEM remover nada.
 *
 * Existe separada porque quem chama precisa saber que a remoção vai ser
 * recusada ANTES de fazer o que não tem volta: o core mata as sessões do
 * workspace antes do `worktree remove` (senão o pwsh com cwd lá dentro segura
 * a pasta no Windows), e matar o Claude Code do painel pra depois responder
 * "não dá, o branch não está mesclado" é destruir trabalho por causa de uma
 * checagem que dava pra fazer antes.
 *
 * `removeWorktree` usa esta função — a lógica (porcelain + `branch --merged`)
 * e as mensagens existem em um lugar só.
 */
export async function canRemoveWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  base: string,
  opts: { trustFilters?: boolean } = {},
): Promise<RemovalCheck> {
  // BR-03: idem ao merge — o `status` abaixo roda o `clean` do repositório.
  await assertFiltersTrusted(worktreePath, opts.trustFilters === true);
  const porcelain = (await runGit(['status', '--porcelain', '--untracked-files=all'], worktreePath, GIT_TIMEOUT_MS, { noHooks: true })).stdout;
  const dirty = countLines(porcelain);
  if (dirty > 0) {
    return {
      ok: false,
      code: 'dirty-worktree',
      i18n: { key: 'core.erro.git.worktreeSujo', params: { n: dirty } },
      detail: porcelain.trim(),
    };
  }

  const merged = (await runGit(['branch', '--merged', base], repoRoot, GIT_TIMEOUT_MS, { noHooks: true })).stdout;
  // `*` marca o branch corrente e `+` o que está em outro worktree.
  const names = merged
    .split('\n')
    .map((line) => line.replace(/^[*+]?\s*/, '').trim())
    .filter((line) => line !== '');
  if (!names.includes(branch)) {
    return {
      ok: false,
      code: 'not-merged',
      i18n: { key: 'core.erro.git.naoMesclado', params: { branch, base } },
      detail: base,
    };
  }

  return { ok: true };
}

/**
 * Remove o worktree e o branch da tarefa. As duas recusas (spec §10) existem
 * porque as duas apagam trabalho: `git worktree remove` leva junto o que não
 * foi commitado, e `git branch -d` num branch não mesclado perde os commits.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  base: string,
  opts: { trustFilters?: boolean } = {},
): Promise<void> {
  const check = await canRemoveWorktree(repoRoot, worktreePath, branch, base, opts);
  if (!check.ok) throw new GitError(check.code, check.i18n, check.detail);

  await runGit(['worktree', 'remove', '--', worktreePath], repoRoot);
  await runGit(['branch', '-d', '--', branch], repoRoot);
}

/**
 * Remoção SEM as recusas: `--force` na pasta e `-D` no branch.
 *
 * Só existe pro rollback de uma criação que falhou no meio (`createTask` que
 * não conseguiu montar o workspace depois do `worktree add`): ali o worktree
 * acabou de nascer, não tem trabalho nenhum dentro e o branch é órfão — deixá-lo
 * no disco faria a próxima tentativa com o mesmo nome bater em `exists`.
 * NUNCA é o caminho do botão "Remover worktree": lá as recusas são o ponto.
 */
export async function removeWorktreeForce(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  await runGit(['worktree', 'remove', '--force', '--', worktreePath], repoRoot);
  await runGit(['branch', '-D', '--', branch], repoRoot);
}

/**
 * Branch de upstream do HEAD de `cwd` (`origin/main`), ou `undefined` quando
 * não há. Usado como último recurso pra descobrir o base de um worktree cujo
 * repo principal está com HEAD destacado.
 */
export async function upstreamOf(cwd: string): Promise<string | undefined> {
  try {
    const out = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd, GIT_TIMEOUT_MS, { noHooks: true })).stdout.trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}
