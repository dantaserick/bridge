import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageKey } from '@bridge/shared';

/**
 * O core NÃO roda dentro do Electron (ruling da Task 5): `node-pty` e
 * `better-sqlite3` precisariam de rebuild pro ABI do Electron, e isso quebra a
 * suíte do core, que roda no Node do sistema. O shell sobe o core como um
 * processo Node filho e conversa com ele pela mesma API HTTP/WS que a UI usa.
 * Este arquivo é a única coisa que sabe disso — e não importa `electron`, pra
 * poder ser testado no vitest.
 */

export interface Instance {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export interface CoreExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true = o sidecar está subindo o core de novo; o main não deve fazer nada. */
  restarting: boolean;
  /**
   * A CHAVE de catálogo do `dialog.showErrorBox` quando o sidecar desistiu.
   *
   * É chave, e não frase (Task 4): este módulo não tem idioma — ele não fala
   * com o core (é ele que sobe o core) e não importa `electron` (pra caber no
   * vitest). Quem traduz é o `main.ts`, com o idioma que ele já resolveu no
   * boot pela locale do Electron.
   */
  fatal?: MessageKey;
}

export interface StartCoreOptions {
  /** Perfil do Bridge (`%APPDATA%\bridge` ou `BRIDGE_PROFILE_DIR`). */
  profileDir: string;
  /** Pasta do build da UI; o core serve ela como estático em `/`. */
  uiDir?: string;
  /** Comando do Node; default `nodeCommand(env)`. */
  node?: string;
  /** Argumentos depois do comando; default `defaultCoreArgs(repoRoot)`. */
  coreEntry?: string[];
  /** cwd do core; default a raiz do monorepo. */
  cwd?: string;
  /** Arquivo de log do shell; default `<profileDir>\logs\shell.log`. */
  logPath?: string;
  /** Base do ambiente do filho; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Prazo pra `instance.json` aparecer; default 10 s (o boot leva ~1 s). */
  timeoutMs?: number;
  /**
   * Intervalo da vigilância do core ADOTADO (`watchAdopted`); default 5 s.
   * Existe pro teste não precisar levar 15 s pra provar as 3 falhas.
   */
  adoptedPollMs?: number;
  /**
   * Exige que o core adotado sirva a UI (`GET /` → 200). Default:
   * `Boolean(uiDir)`. O `dev:app` (página no Vite) passa `false` — ali o core
   * não precisa servir nada, e um `dev:core` do desenvolvedor é adotável.
   */
  requireUi?: boolean;
  onExit?: (info: CoreExit) => void;
  /** Chamado quando o restart automático deu certo: porta e token são NOVOS. */
  onRestarted?: (inst: Instance) => void;
}

export const FATAL_START: MessageKey = 'shell.fatal.coreNaoSubiu';
export const FATAL_CRASH: MessageKey = 'shell.fatal.coreEncerrou';
export const FATAL_NO_NODE: MessageKey = 'shell.fatal.semNode';

const POLL_MS = 50;
/**
 * Instalação fresca em disco frio (Defender escaneando os módulos nativos)
 * levou 55 s pra escrever o `instance.json` — com 10 s o shell declarava
 * "não subiu" com o core ainda carregando. Enquanto o filho está vivo, espera.
 */
const DEFAULT_INSTANCE_TIMEOUT_MS = 90_000;
/** Linha de progresso no `shell.log` enquanto a espera acima corre. */
const WAIT_PROGRESS_MS = 10_000;
/** Queda dentro dessa janela conta como "não subiu" e ganha uma segunda chance. */
const RESTART_WINDOW_MS = 30_000;
const KILL_GRACE_MS = 5_000;
/** R2: prazo pro core órfão provar que está vivo (`GET /api/state`). */
export const ADOPT_PROBE_MS = 2_000;
/** Intervalo da vigilância do core adotado (não é filho: não há `exit` pra observar). */
export const ADOPTED_POLL_MS = 5_000;
/** Sondagens seguidas sem resposta antes de tratar o core adotado como morto. */
export const ADOPTED_MAX_FAILURES = 3;
/** R4: prazo total do encerramento gracioso antes do `taskkill`. */
export const SHUTDOWN_DEADLINE_MS = 1_500;
/** `taskkill` travado (disco, antivírus) não pode segurar o fechamento do app. */
const TASKKILL_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------- funções puras

/** Node a usar pro core: `BRIDGE_NODE` manda; senão o `node` do PATH. */
export function nodeCommand(env: NodeJS.ProcessEnv): string {
  const override = env.BRIDGE_NODE;
  return typeof override === 'string' && override.trim() !== '' ? override : 'node';
}

/** `<repo>/packages/shell/dist` → `<repo>`. */
export function resolveRepoRoot(distDir: string): string {
  return resolve(distDir, '../../..');
}

/**
 * Em desenvolvimento o core roda direto do TypeScript, pelo `tsx` da raiz.
 * Empacotado, isso vira `resolveCoreLaunch` — ver ali.
 */
export function defaultCoreArgs(repoRoot: string): string[] {
  return [
    join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(repoRoot, 'packages', 'core', 'src', 'index.ts'),
  ];
}

export interface CoreLaunchTarget {
  /** `app.isPackaged` do Electron. */
  isPackaged: boolean;
  /** `process.resourcesPath` (a pasta `resources` ao lado do `Bridge.exe`). */
  resourcesPath: string;
  /** Raiz do monorepo — só usada fora do app empacotado. */
  repoRoot: string;
}

export interface CoreLaunch {
  /** Argumentos depois do comando do Node (ver `nodeCommand`). */
  args: string[];
  cwd: string;
  /** Pasta que o core serve como estático em `/` (`BRIDGE_UI_DIR`). */
  uiDir: string;
}

/**
 * Onde está o core, dos dois lados da fronteira do empacotamento.
 *
 * Empacotado o app NÃO pode depender do `tsx` nem do checkout: o core vai como
 * `resources/core/dist/index.mjs` (bundle ESM do esbuild) com as dependências
 * de runtime em `resources/core/node_modules` e o shim em `resources/core/bin`
 * — a mesma relação `dist/ ↔ ../bin/` que existe no repo, que é o que faz o
 * `new URL('../bin/bridge-hook.cjs', import.meta.url)` do core continuar
 * valendo sem gambiarra. O Node continua sendo o do sistema (ruling da Task 5).
 *
 * Função pura de propósito: é o único ponto onde "dev" e "instalado" divergem,
 * e dá pra testar sem Electron.
 */
export function resolveCoreLaunch({ isPackaged, resourcesPath, repoRoot }: CoreLaunchTarget): CoreLaunch {
  if (!isPackaged) {
    return {
      args: defaultCoreArgs(repoRoot),
      cwd: repoRoot,
      uiDir: join(repoRoot, 'packages', 'ui', 'dist'),
    };
  }
  const coreDir = join(resourcesPath, 'core');
  return {
    args: [join(coreDir, 'dist', 'index.mjs')],
    // cwd na própria pasta do core: o app instalado não tem repo pra apontar,
    // e todo caminho que o core usa de verdade (perfil, cwd de sessão) é
    // absoluto e vem por env ou pela API.
    cwd: coreDir,
    uiDir: join(resourcesPath, 'ui'),
  };
}

/**
 * Valida o `instance.json` do core. Devolve null pra json quebrado, formato
 * errado ou pid morto — um core que caiu duro deixa o arquivo pra trás, e
 * confiar nele daria porta/token de um processo que não existe mais.
 */
export function parseInstance(raw: string): Instance | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const { port, token, pid, startedAt } = obj;
  if (typeof port !== 'number' || typeof token !== 'string') return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'number') return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return { port, token, pid, startedAt };
}

export function instancePath(profileDir: string): string {
  return join(profileDir, 'instance.json');
}

export function readInstance(profileDir: string): Instance | null {
  const path = instancePath(profileDir);
  if (!existsSync(path)) return null;
  try {
    return parseInstance(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ espera/log

export interface WaitOptions {
  /**
   * Só aceita instância escrita a partir desse instante. É por aqui que se
   * ignora o `instance.json` de outro core: casar por pid não serve, porque o
   * `tsx` refaz fork e o core acaba num neto do processo que o shell lançou.
   */
  minStartedAt?: number;
  /** Interrompe a espera antes do prazo (ex.: o filho já morreu). */
  giveUp?: () => boolean;
}

export async function waitForInstance(
  profileDir: string,
  timeoutMs: number,
  opts: WaitOptions = {},
): Promise<Instance | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inst = readInstance(profileDir);
    if (inst && (opts.minStartedAt === undefined || inst.startedAt >= opts.minStartedAt)) return inst;
    if (opts.giveUp?.()) return null;
    if (Date.now() >= deadline) return null;
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

export function defaultLogPath(profileDir: string): string {
  return join(profileDir, 'logs', 'shell.log');
}

/** Teto do `shell.log` antes de virar `shell.log.1`. */
export const SHELL_LOG_MAX_BYTES = 5 * 1024 * 1024;

interface ShellLogEntry {
  path: string;
  line: string;
  maxBytes: number;
}

const shellLogQueue: ShellLogEntry[] = [];
let shellLogDraining: Promise<void> | null = null;
/** Tamanho corrente de cada arquivo de log; sem entrada = ainda não medido. */
const shellLogSizes = new Map<string, number>();

async function writeShellLogEntry(entry: ShellLogEntry): Promise<void> {
  const text = `${new Date().toISOString()} ${entry.line}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  let size = shellLogSizes.get(entry.path);
  if (size === undefined) {
    await mkdir(dirname(entry.path), { recursive: true });
    try {
      size = (await stat(entry.path)).size;
    } catch {
      size = 0;
    }
  }
  // Rotaciona ANTES de gravar a linha que estouraria o teto: um `.1` só, que
  // basta pro shell (o log volumoso é o do core, com 5 arquivos).
  if (size > 0 && size + bytes > entry.maxBytes) {
    await rename(entry.path, `${entry.path}.1`);
    size = 0;
  }
  await appendFile(entry.path, text, 'utf8');
  shellLogSizes.set(entry.path, size + bytes);
}

function drainShellLog(): void {
  if (shellLogDraining) return;
  shellLogDraining = (async () => {
    try {
      while (shellLogQueue.length > 0) {
        const entry = shellLogQueue.shift() as ShellLogEntry;
        try {
          await writeShellLogEntry(entry);
        } catch {
          // Disco cheio, permissão, pasta apagada: perde a linha e segue. Sem
          // `console.error` de propósito — o main do Electron empacotado não
          // tem console e isso só viraria ruído no stderr.
          shellLogSizes.delete(entry.path);
        }
      }
    } finally {
      shellLogDraining = null;
    }
  })();
}

/**
 * Log do shell: enfileira a linha e volta na HORA. A escrita sai numa fila
 * assíncrona (mesmo desenho do logger do core), com teto de 5 MB e rotação
 * pra `shell.log.1`.
 *
 * Era `appendFileSync` — e o main do Electron chamava isso por evento vindo do
 * core (F1): escrita síncrona em disco no processo que desenha a janela. Nunca
 * lança: perder uma linha de log não pode derrubar o app.
 */
export function appendShellLog(logPath: string, line: string, maxBytes = SHELL_LOG_MAX_BYTES): void {
  shellLogQueue.push({ path: logPath, line, maxBytes });
  drainShellLog();
}

/** Resolve quando tudo que já foi enfileirado chegou no disco. */
export async function flushShellLog(): Promise<void> {
  while (shellLogDraining) await shellLogDraining;
}

function pipeLines(stream: NodeJS.ReadableStream, logPath: string, prefix: string): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      if (line !== '') appendShellLog(logPath, `${prefix} ${line}`);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
    // Uma linha gigante sem \n não pode virar vazamento de memória.
    if (buffer.length > 64 * 1024) {
      appendShellLog(logPath, `${prefix} ${buffer}`);
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer.trim() !== '') appendShellLog(logPath, `${prefix} ${buffer.trim()}`);
    buffer = '';
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Espera `p`, desistindo em `ms` — sem deixar o timer pendurado no loop. */
function waitAtMost(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((res) => {
    const timer = setTimeout(res, ms);
    void p.then(() => {
      clearTimeout(timer);
      res();
    });
  });
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// ------------------------------------------------------------------- ciclo de vida

interface Running {
  /** `null` quando o core foi ADOTADO (R2): ele não é filho deste processo. */
  child: ChildProcess | null;
  instance: Instance;
  opts: StartCoreOptions;
  logPath: string;
  startedAt: number;
}

let running: Running | null = null;
let stopping = false;
let restartUsed = false;

/**
 * Falha de subida com uma frase PRA MOSTRAR. O `key` é o que o `main.ts`
 * traduz; o `message` do `Error` fica com a própria chave, que é o que aparece
 * no `shell.log` — e ler `shell.fatal.semNode` no log diz mais, pra quem dá
 * suporte, do que a frase traduzida no idioma de quem reportou.
 */
export class CoreStartError extends Error {
  constructor(readonly key: MessageKey) {
    super(key);
    this.name = 'CoreStartError';
  }
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function spawnCore(opts: StartCoreOptions, logPath: string): Promise<{ child: ChildProcess; instance: Instance }> {
  // `instance.json` de um core morto faria a espera abaixo devolver porta e
  // token velhos antes mesmo do filho novo escrever o dele.
  const stale = readInstance(opts.profileDir);
  if (stale === null && existsSync(instancePath(opts.profileDir))) {
    appendShellLog(logPath, '[shell] instance.json órfão descartado');
    try {
      rmSync(instancePath(opts.profileDir));
    } catch {
      // outro processo segurando o arquivo: o `minStartedAt` ainda protege.
    }
  }

  const spawnedAt = Date.now();
  const command = opts.node ?? nodeCommand(opts.env ?? process.env);
  const repoRoot = resolveRepoRoot(moduleDir());
  const args = opts.coreEntry ?? defaultCoreArgs(repoRoot);
  appendShellLog(logPath, `[shell] subindo o core: ${command} ${args.join(' ')}`);

  const child = spawn(command, args, {
    cwd: opts.cwd ?? repoRoot,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...(opts.env ?? process.env),
      BRIDGE_PROFILE_DIR: opts.profileDir,
      ...(opts.uiDir ? { BRIDGE_UI_DIR: opts.uiDir } : {}),
      // O core loga em arquivo; espelhar no console de um filho sem terminal
      // só encheria o pipe pra nada.
      BRIDGE_LOG_CONSOLE: '0',
    },
  });

  if (child.stdout) pipeLines(child.stdout, logPath, '[core:out]');
  if (child.stderr) pipeLines(child.stderr, logPath, '[core:err]');

  let spawnError: Error | null = null;
  let dead = false;
  child.once('error', (err) => {
    spawnError = err;
    dead = true;
    appendShellLog(logPath, `[shell] falha ao lançar o core: ${err.message}`);
  });
  child.once('exit', (code, signal) => {
    dead = true;
    appendShellLog(logPath, `[shell] core saiu (code=${code} signal=${signal})`);
  });

  const progress = setInterval(() => {
    if (!dead) appendShellLog(logPath, `[shell] ainda esperando o core (${Math.round((Date.now() - spawnedAt) / 1000)} s)`);
  }, WAIT_PROGRESS_MS);
  let instance: Instance | null;
  try {
    instance = await waitForInstance(opts.profileDir, opts.timeoutMs ?? DEFAULT_INSTANCE_TIMEOUT_MS, {
      minStartedAt: spawnedAt,
      giveUp: () => dead,
    });
  } finally {
    clearInterval(progress);
  }

  if (!instance) {
    // Diagnóstico: sem isso, "o core não subiu" não diz se faltou o arquivo,
    // se ele veio quebrado ou se é de outra instância.
    const path = instancePath(opts.profileDir);
    let raw = '<inexistente>';
    try {
      if (existsSync(path)) raw = readFileSync(path, 'utf8');
    } catch (e) {
      raw = `<erro de leitura: ${(e as Error).message}>`;
    }
    appendShellLog(logPath, `[shell] sem instance.json válido depois do prazo (spawnedAt=${spawnedAt}) — ${raw}`);
    // `child.kill()` só derruba o processo direto; um core que ainda está
    // carregando sobreviveu a ele numa instalação real e escreveu o
    // `instance.json` depois do app já ter desistido. A árvore inteira cai.
    if (isAlive(child) && child.pid !== undefined) await taskkillTree(child.pid);
    else if (isAlive(child)) child.kill();
    const err = spawnError as NodeJS.ErrnoException | null;
    throw new CoreStartError(err?.code === 'ENOENT' ? FATAL_NO_NODE : FATAL_START);
  }

  appendShellLog(logPath, `[shell] core no ar em http://127.0.0.1:${instance.port} (pid ${instance.pid})`);
  return { child, instance };
}

/**
 * Caminho único de "o core sumiu sem ninguém pedir": restart UMA vez dentro da
 * janela, depois fatal. Chamado pelo `exit` do filho (`watchExit`) e pela
 * vigilância do core adotado (`watchAdopted`) — os dois têm que se comportar
 * igual, senão o app instalado que adota um core tem um regime de recuperação
 * diferente do que sobe o próprio.
 */
function handleUnexpectedExit(state: Running, code: number | null, signal: NodeJS.Signals | null): void {
  if (stopping || running !== state) return;
  stopAdoptedWatch();
  const withinWindow = Date.now() - state.startedAt < RESTART_WINDOW_MS;
  if (code !== 0 && withinWindow && !restartUsed) {
    restartUsed = true;
    state.opts.onExit?.({ code, signal, restarting: true });
    appendShellLog(state.logPath, '[shell] core caiu na largada; tentando de novo (última chance)');
    void restart(state);
    return;
  }
  running = null;
  state.opts.onExit?.({ code, signal, restarting: false, fatal: withinWindow ? FATAL_START : FATAL_CRASH });
}

function watchExit(state: Running): void {
  // Core adotado (R2) não é filho deste processo: não há `exit` pra observar —
  // quem cuida dele é o `watchAdopted`.
  if (!state.child) {
    watchAdopted(state);
    return;
  }
  state.child.once('exit', (code, signal) => handleUnexpectedExit(state, code, signal));
}

/** Timer da vigilância do core adotado; só um por vez (só há um core por shell). */
let adoptedTimer: NodeJS.Timeout | null = null;

function stopAdoptedWatch(): void {
  if (adoptedTimer) {
    clearTimeout(adoptedTimer);
    adoptedTimer = null;
  }
}

/**
 * Vigia o core ADOTADO: `GET /api/state` a cada `adoptedPollMs` (5 s), e
 * `ADOPTED_MAX_FAILURES` falhas SEGUIDAS contam como saída inesperada. Sem
 * isto, um core adotado que morre deixava a janela apontando pra uma porta
 * morta, sem restart e sem aviso nenhum — o app só "parava de funcionar".
 *
 * Falha isolada (uma sondagem que estourou os 2 s porque o core estava
 * ocupado) NÃO derruba nada: o contador zera na primeira resposta boa.
 */
function watchAdopted(state: Running): void {
  stopAdoptedWatch();
  const intervalMs = state.opts.adoptedPollMs ?? ADOPTED_POLL_MS;
  let failures = 0;

  const schedule = (): void => {
    adoptedTimer = setTimeout(() => {
      adoptedTimer = null;
      void tick();
    }, intervalMs);
    adoptedTimer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopping || running !== state) return;
    const ok = await coreResponds(state.instance, Math.min(ADOPT_PROBE_MS, intervalMs));
    // O `await` acima é uma janela: o app pode ter pedido `stopCore()` no meio.
    if (stopping || running !== state) return;
    if (ok) {
      failures = 0;
      schedule();
      return;
    }
    failures += 1;
    appendShellLog(
      state.logPath,
      // i18n-ignore: linha de `shell.log` (o `appendShellLog` está na linha de
      // cima, e o guard só olha a linha do literal).
      `[shell] core adotado não respondeu (${failures}/${ADOPTED_MAX_FAILURES})`, // i18n-ignore
    );
    if (failures < ADOPTED_MAX_FAILURES) {
      schedule();
      return;
    }
    appendShellLog(state.logPath, `[shell] core adotado parou de responder (pid ${state.instance.pid})`);
    // `code: null` — não houve `exit` pra ler; o efeito é o mesmo de uma saída
    // com código diferente de 0 (é o que `handleUnexpectedExit` compara).
    handleUnexpectedExit(state, null, null);
  };

  schedule();
}

async function restart(previous: Running): Promise<void> {
  try {
    const { child, instance } = await spawnCore(previous.opts, previous.logPath);
    if (stopping) {
      // O app pediu pra encerrar enquanto o core novo subia: `stopCore()` viu
      // `running` nulo e não teria ninguém pra matar.
      appendShellLog(previous.logPath, '[shell] restart terminou durante o encerramento; matando o core novo');
      if (child.pid !== undefined) await taskkillTree(child.pid);
      return;
    }
    const state: Running = { child, instance, opts: previous.opts, logPath: previous.logPath, startedAt: Date.now() };
    running = state;
    watchExit(state);
    previous.opts.onRestarted?.(instance);
  } catch (err) {
    running = null;
    appendShellLog(previous.logPath, `[shell] restart falhou: ${(err as Error).message}`);
    // O motivo cru fica no log; o diálogo mostra a MESMA frase de "o core não
    // subiu", que é o que aconteceu do ponto de vista de quem está olhando.
    previous.opts.onExit?.({ code: null, signal: null, restarting: false, fatal: FATAL_START });
  }
}

/** `process.kill(pid, 0)`: existe? (não manda sinal nenhum). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, deadline: number): Promise<boolean> {
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/** O core daquele `instance.json` responde a própria API com o próprio token? */
async function coreResponds(instance: Instance, timeoutMs = ADOPT_PROBE_MS): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${instance.port}/api/state`, {
      headers: { authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** O core daquele `instance.json` serve a UI estática em `/`? */
async function coreServesUi(instance: Instance, timeoutMs = ADOPT_PROBE_MS): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${instance.port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * R2 — o que fazer com o `instance.json` que já está no perfil.
 *
 * - pid morto / json quebrado: lixo, apaga e devolve `null` (sobe um core novo).
 * - pid VIVO e a API respondendo em 2 s: **adota**. É o caso de "fechei a
 *   janela à força e os agentes continuaram rodando" — matar o core aqui
 *   mataria as sessões do usuário sem ele pedir, e subir um segundo core no
 *   mesmo perfil brica os dois (mesmo SQLite, mesma porta).
 * - pid vivo, API respondendo, mas `GET /` não é 200 e o shell veio com
 *   `uiDir` (`requireUi`): é o `npm run dev:core` do desenvolvedor, que sobe
 *   sem `BRIDGE_UI_DIR`. Adotar ele abriria a janela do app instalado num core
 *   que devolve 404 na página — tela branca. Mata e respawna.
 * - pid vivo mas a API muda (core travado, ou pid reciclado por outro
 *   programa): `taskkill /t /f` na árvore e devolve `null` pra respawnar.
 */
export async function adoptOrKillStale(
  profileDir: string,
  logPath: string,
  opts: { requireUi?: boolean } = {},
): Promise<Instance | null> {
  const path = instancePath(profileDir);
  const stale = readInstance(profileDir);

  if (!stale) {
    if (existsSync(path)) {
      appendShellLog(logPath, '[shell] instance.json órfão descartado');
      try {
        rmSync(path);
      } catch {
        // outro processo segurando o arquivo: o `minStartedAt` ainda protege.
      }
    }
    return null;
  }

  if (await coreResponds(stale)) {
    if (opts.requireUi === true && !(await coreServesUi(stale))) {
      appendShellLog(
        logPath,
        // i18n-ignore: linha de `shell.log` (ver acima).
        `[shell] core de pé não serve a UI (GET / ≠ 200, pid ${stale.pid}); matando a árvore e subindo outro`, // i18n-ignore
      );
      await taskkillTree(stale.pid);
      try {
        rmSync(path);
      } catch {
        // arquivo travado: o `minStartedAt` do `waitForInstance` cobre.
      }
      return null;
    }
    appendShellLog(logPath, `[shell] core já de pé adotado: http://127.0.0.1:${stale.port} (pid ${stale.pid})`);
    return stale;
  }

  appendShellLog(logPath, `[shell] core órfão não responde (pid ${stale.pid}); matando a árvore e subindo outro`);
  await taskkillTree(stale.pid);
  try {
    rmSync(path);
  } catch {
    // arquivo travado: o `minStartedAt` do `waitForInstance` cobre.
  }
  return null;
}

export async function startCore(
  opts: StartCoreOptions,
): Promise<{ port: number; token: string; child: ChildProcess | null }> {
  // i18n-ignore: invariante interna (duas chamadas de `startCore` no mesmo
  // processo). Não é `CoreStartError` de propósito — o `main.ts` mostra a
  // frase genérica de "o core não subiu" pra qualquer erro que não traga
  // chave, e um texto de programador não tem o que fazer num diálogo.
  if (running) throw new Error('o core já está rodando neste shell'); // i18n-ignore
  stopping = false;
  restartUsed = false;
  const logPath = opts.logPath ?? defaultLogPath(opts.profileDir);

  const adopted = await adoptOrKillStale(opts.profileDir, logPath, {
    requireUi: opts.requireUi ?? Boolean(opts.uiDir),
  });
  if (adopted) {
    // Sem filho: não há `exit` pra observar. Quem cobre a queda de um core
    // adotado é o `watchAdopted` (dentro do `watchExit`).
    const state: Running = { child: null, instance: adopted, opts, logPath, startedAt: Date.now() };
    running = state;
    watchExit(state);
    return { port: adopted.port, token: adopted.token, child: null };
  }

  const { child, instance } = await spawnCore(opts, logPath);
  const state: Running = { child, instance, opts, logPath, startedAt: Date.now() };
  running = state;
  watchExit(state);
  return { port: instance.port, token: instance.token, child };
}

/** Porta e token do core em pé (mudam depois de um restart). */
export function currentInstance(): Instance | null {
  return running?.instance ?? null;
}

function taskkillTree(pid: number): Promise<void> {
  const done = new Promise<void>((res) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => res());
    killer.once('close', () => res());
    killer.unref();
  });
  // Se ele não voltar em 3 s, seguimos pro `child.kill()` do `stopCore()` em
  // vez de esperar para sempre.
  return waitAtMost(done, TASKKILL_TIMEOUT_MS);
}

/**
 * Encerra a árvore inteira com `taskkill /t /f` e, se em 5 s ainda houver
 * processo, cai pro `child.kill()`.
 *
 * A ordem é essa de propósito, e não a inversa: no Windows `child.kill()` já é
 * um `TerminateProcess` (não existe SIGTERM gracioso), então ele não dá chance
 * de limpeza nenhuma — só mata o processo que o shell lançou. Com o core
 * rodando sob o `tsx`, esse processo é um invólucro: matar só ele deixaria o
 * core órfão, e com ele os PTYs (pwsh, claude). O `/t` do taskkill desce a
 * árvore toda, que é exatamente o que "fechar a janela encerra as sessões"
 * quer dizer.
 */
/**
 * R4 — pede o encerramento gracioso (`POST /api/shutdown`) e espera o processo
 * do core sumir, tudo dentro de `SHUTDOWN_DEADLINE_MS`. Devolve `true` só
 * quando o core realmente saiu sozinho.
 *
 * Vale a pena porque `taskkill /f` não dá chance de limpeza nenhuma: sem isto
 * o core nunca roda o `stop()` dele — sessões não são apagadas direito, o
 * `instance.json` fica pra trás e a última leva de log nunca chega no disco.
 */
async function requestShutdown(instance: Instance, logPath: string): Promise<boolean> {
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  try {
    const res = await fetch(`http://127.0.0.1:${instance.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!res.ok) {
      appendShellLog(logPath, `[shell] POST /api/shutdown respondeu ${res.status}; caindo pro taskkill`);
      return false;
    }
  } catch (err) {
    appendShellLog(logPath, `[shell] POST /api/shutdown falhou (${(err as Error).message}); caindo pro taskkill`);
    return false;
  }
  return waitForPidGone(instance.pid, deadline);
}

/**
 * Encerra o core: primeiro gracioso (`POST /api/shutdown`, 1500 ms), e só se
 * ele não morrer sozinho é que vem `taskkill /t /f` na árvore, com
 * `child.kill()` de última instância depois de `graceMs`.
 *
 * A ordem taskkill → child.kill (e não a inversa) é de propósito: no Windows
 * `child.kill()` já é um `TerminateProcess` (não existe SIGTERM gracioso) e só
 * mata o processo que o shell lançou. Com o core rodando sob o `tsx`, esse
 * processo é um invólucro: matar só ele deixaria o core órfão, e com ele os
 * PTYs (pwsh, claude). O `/t` do taskkill desce a árvore toda, que é o que
 * "fechar a janela encerra as sessões" quer dizer.
 */
export async function stopCore(graceMs = KILL_GRACE_MS): Promise<void> {
  const state = running;
  running = null;
  // Antes de qualquer `await`: a sondagem do core adotado não pode acordar no
  // meio do encerramento e disparar um restart em cima dele.
  stopAdoptedWatch();
  // Sem core de pé ainda dá pra ter linha de log pendente na fila (o `fatal`
  // de um boot que falhou, por exemplo) — o app não pode sair sem gravá-la.
  if (!state) {
    await flushShellLog();
    return;
  }
  stopping = true;
  const { child, logPath, instance } = state;
  const pid = child?.pid ?? instance.pid;
  if (child && !isAlive(child)) {
    await flushShellLog();
    return;
  }

  const exited = child
    ? new Promise<void>((res) => child.once('exit', () => res()))
    : waitForPidGone(instance.pid, Date.now() + graceMs).then(() => undefined);

  appendShellLog(logPath, `[shell] encerrando o core (pid ${pid}): pedindo POST /api/shutdown`);
  if (await requestShutdown(instance, logPath)) {
    appendShellLog(logPath, '[shell] core encerrou sozinho (POST /api/shutdown)');
    // O processo do core já morreu; o invólucro do `tsx` sai logo atrás.
    await waitAtMost(exited, graceMs);
    if (!child || !isAlive(child)) {
      appendShellLog(logPath, '[shell] core encerrado');
      await flushShellLog();
      return;
    }
  }

  appendShellLog(logPath, `[shell] taskkill /t /f no pid ${pid}`);
  await taskkillTree(pid);
  await waitAtMost(exited, graceMs);

  if (child && isAlive(child)) {
    appendShellLog(logPath, `[shell] core não saiu em ${graceMs} ms; child.kill()`);
    child.kill();
    await waitAtMost(exited, 2000);
  }
  appendShellLog(logPath, '[shell] core encerrado');
  await flushShellLog();
}
