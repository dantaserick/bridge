import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Task 10 — e2e do app DE VERDADE: Electron real, core real (processo Node
 * filho), UI buildada servida pelo core, PTY real de shell.
 *
 * O que este arquivo NÃO faz: subir um agente de verdade (o `Ctrl+Shift+C` /
 * o checkbox do diálogo levantariam o Claude Code da conta do usuário). A
 * notificação que exercita o caminho do toast entra pela API do core
 * (`POST /api/sessions/:id/notify`), que é o mesmo `Notifications.push` que o
 * adaptador usa — só que sem gastar sessão de Claude.
 *
 * Pré-requisitos (o script `npm run e2e` da raiz roda os dois antes):
 * `npm run build:ui` e `npm run build -w @bridge/shell`.
 */

// `@bridge/shell` é `"type": "module"`: o Playwright roda este spec como ESM
// de verdade, então `__dirname` não existe aqui (ao contrário do vitest).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UI_DIR = join(REPO_ROOT, 'packages', 'ui', 'dist');
const SHELL_MAIN = join(REPO_ROOT, 'packages', 'shell', 'dist', 'main.mjs');
/** Bundle da CLI (`npm run build:cli`) — o cenário de idioma roda ele como processo filho. */
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'bin', 'bridge.cjs');
/** Onde os screenshots do smoke visual desta task caem. */
const SHOTS_DIR = join(REPO_ROOT, 'design', 'screenshots');
/** Nomes de processo que o app pode deixar pra trás se o encerramento falhar. */
const WATCHED_PROCESSES = ['node.exe', 'electron.exe', 'pwsh.exe', 'powershell.exe', 'Bridge.exe'];

interface ProcInfo {
  pid: number;
  name: string;
  cmd: string;
}

/**
 * Toda pasta temporária do e2e nasce aqui e entra na lista que o `afterAll`
 * apaga — antes a lista era escrita à mão, e uma variável nova esquecida lá
 * virava lixo permanente em `%TEMP%` (higiene da Task 3).
 */
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Processos vivos entre os `WATCHED_PROCESSES`, com a linha de comando. */
function listProcesses(): ProcInfo[] {
  const script =
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -in ${WATCHED_PROCESSES.map((n) => `'${n}'`).join(',')} } ` +
    '| Select-Object ProcessId,Name,CommandLine; ConvertTo-Json -Compress -Depth 3 -InputObject @($p)';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const raw = JSON.parse(out || '[]') as { ProcessId: number; Name: string; CommandLine: string | null }[];
  return raw.map((p) => ({ pid: p.ProcessId, name: p.Name, cmd: p.CommandLine ?? '' }));
}

/**
 * Processos vivos cuja linha de comando aponta pra ESTA rodada. O filtro por
 * caminho é o que impede um `npm run dev:core` do usuário — ou o próprio
 * processo do Playwright — de virar falso positivo.
 *
 * As duas grafias de barra são de propósito: o core sobe com caminhos do
 * Windows (`...\packages\core\src\index.ts`) e o Electron recebe o app como
 * `packages/shell`, do jeito que foi escrito em `args`.
 */
function bridgeProcesses(needles: string[]): ProcInfo[] {
  const wanted = needles.map((n) => n.toLowerCase());
  return listProcesses().filter((p) => {
    const cmd = p.cmd.toLowerCase();
    // `-EncodedCommand` é sempre de ferramenta de terminal (o Bridge nunca
    // lança nada assim) e o base64 pode conter qualquer coisa por acaso.
    if (cmd.includes('-encodedcommand')) return false;
    return wanted.some((n) => cmd.includes(n));
  });
}

/** Argumentos de uma linha de comando (tudo depois do executável, com ou sem aspas). */
function argsOf(cmd: string): string {
  const match = /^\s*(?:"([^"]*)"|(\S+))\s*([\s\S]*)$/.exec(cmd);
  return (match?.[3] ?? '').trim();
}

/**
 * Os PTYs de shell do core (`shellLaunch`: `pwsh.exe -NoLogo`, e nada mais).
 * Eles não carregam nenhum caminho do Bridge na linha de comando, então não
 * aparecem em `bridgeProcesses` — e são justamente o que sobra quando o
 * `stopCore()` mata só o processo do core em vez da árvore.
 *
 * A comparação é com a lista de argumentos INTEIRA, não `includes('-NoLogo')`:
 * ferramentas de terminal (inclusive o harness que roda este teste) sobem
 * `pwsh -NoProfile -NonInteractive -NoLogo -EncodedCommand …`, que casaria com
 * um `includes` e viraria "PTY órfão" sem nada a ver com o Bridge.
 */
function ptyProcesses(): ProcInfo[] {
  return listProcesses().filter(
    (p) => (p.name === 'pwsh.exe' || p.name === 'powershell.exe') && argsOf(p.cmd).toLowerCase() === '-nologo',
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Instance {
  port: number;
  token: string;
  pid: number;
}

/** Espera o `instance.json` do core do perfil temporário (porta e token da rodada). */
async function waitForInstance(profileDir: string, timeoutMs: number): Promise<Instance> {
  const path = join(profileDir, 'instance.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Instance;
        if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return parsed;
      } catch {
        // arquivo pego no meio da escrita: tenta de novo.
      }
    }
    if (Date.now() >= deadline) throw new Error(`o core não escreveu ${path} em ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface ToastLine {
  at: number;
  sessionId: string;
  workspaceId: string;
  kind: string;
  title: string;
  body: string;
}

/**
 * Linhas já completas do `BRIDGE_TOAST_LOG`. Linha inacabada (leitura no meio
 * de um append) é descartada em vez de derrubar o `expect.poll` — na próxima
 * volta ela já está inteira.
 */
function readToastLog(path: string): ToastLine[] {
  if (!existsSync(path)) return [];
  const out: ToastLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as ToastLine);
    } catch {
      // linha ainda sendo escrita.
    }
  }
  return out;
}

/**
 * Foto da janela pro `design/screenshots/` (Task 5, smoke visual).
 *
 * Vai pelo `webContents.capturePage()` do processo MAIN — e não pelo
 * `page.screenshot()` do Playwright — porque o segundo desenha só o DOM do
 * renderer, sem a moldura da janela.
 */
async function captureWindow(application: ElectronApplication, file: string): Promise<void> {
  const png = await capturePng(application);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
}

/** O PNG cru da janela principal, pelo `capturePage()` do MAIN. */
async function capturePng(application: ElectronApplication): Promise<Buffer> {
  const base64 = await application.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) return '';
    const image = await target.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  if (base64 === '') throw new Error('capturePage não achou a janela principal');
  return Buffer.from(base64, 'base64');
}

/**
 * `git` do TESTE (o do app é o `git.ts` do core). Síncrono de propósito: o
 * teste precisa que o commit esteja no disco ANTES de pedir o `git/refresh`.
 */
function gitCli(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

/** Caminho do shim de hook do core — o oitavo cenário o roda como o Claude Code faria. */
const HOOK_SHIM = join(REPO_ROOT, 'packages', 'core', 'bin', 'bridge-hook.cjs');

/**
 * Uma linha de assistente como o Claude Code escreve num transcript, reduzida
 * ao que o monitor de uso lê: modelo, contagens, `cwd` e carimbo.
 */
function usageLine(o: {
  id: string;
  model: string;
  cwd: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${o.id}`,
    // AGORA: o painel abre no recorte de mês, e uma data fixa faria o teste
    // passar só no mês em que foi escrita.
    timestamp: new Date().toISOString(),
    cwd: o.cwd,
    message: {
      id: o.id,
      model: o.model,
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
      },
    },
  });
}

/**
 * A árvore de transcrições que o `BRIDGE_CLAUDE_HOME` do oitavo cenário
 * aponta: uma conversa PRINCIPAL e uma de SUBAGENTE, que é justamente o que a
 * primeira versão do monitor não contava.
 */
function makeUsageHome(home: string): void {
  const main = join(home, 'projects', 'proj-uso');
  mkdirSync(main, { recursive: true });
  writeFileSync(
    join(main, 'sessao.jsonl'),
    `${usageLine({
      id: 'msg_main',
      model: 'claude-sonnet-4-5',
      cwd: 'C:\\projetos\\uso',
      input: 100_000,
      output: 20_000,
      cacheWrite: 40_000,
      cacheRead: 300_000,
    })}\n`,
    'utf8',
  );
  const sub = join(main, 'sessao', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'sub.jsonl'),
    `${usageLine({ id: 'msg_sub', model: 'claude-haiku-4-5', cwd: 'C:\\projetos\\uso', input: 50_000, output: 10_000 })}\n`,
    'utf8',
  );
}

/**
 * Um `claude.cmd` falso no começo do `PATH`.
 *
 * O hook `StatusLine` só é aceito numa sessão de AGENTE, e subir o Claude Code
 * de verdade (como faz o sétimo cenário) gastaria uma sessão da conta do dono
 * pra provar uma coisa que não depende dele: o caminho
 * shim → core → monitor de uso → faixa da sidebar.
 *
 * Ele precisa de DUAS coisas. Responder `--version` com código 0 — é o que o
 * `adapter.available()` do core pergunta antes de criar a sessão, e sem isso
 * o `POST /api/sessions` volta 422 `agent-unavailable` (foi assim que a
 * primeira versão deste cenário falhou). E ficar vivo depois disso, pra a
 * sessão não morrer no mesmo instante em que nasce.
 */
function makeFakeClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const cmd = [
    '@echo off',
    'if "%~1"=="--version" (',
    '  echo 0.0.0-bridge-e2e',
    '  exit /b 0',
    ')',
    'echo bridge-e2e-claude-falso',
    'pause > nul',
    '',
  ].join('\r\n');
  writeFileSync(join(dir, 'claude.cmd'), cmd, 'utf8');
}

/** A marca que o `claude` falso do 12º cenário imprime antes do argv. */
const ARGV_MARK = 'bridge-e2e-argv';

/**
 * O `claude.cmd` falso do 13º cenário: os dois papéis dos dois acima somados.
 *
 * Ele responde `--version` (o `adapter.available()` do core pergunta isso antes
 * de criar QUALQUER sessão de agente, e sem resposta o `POST /api/sessions`
 * volta 422), imprime o argv que recebeu (é onde o teste lê o `--resume <id>`
 * da restauração) e fica vivo depois disso (senão a sessão morreria no mesmo
 * instante em que nasce — e o painel seria marcado como encerrado pelo
 * USUÁRIO, que é o contrário do que este cenário prova).
 */
function makeResumeClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const cmd = [
    '@echo off',
    'if "%~1"=="--version" (',
    '  echo 0.0.0-bridge-e2e',
    '  exit /b 0',
    ')',
    `echo ${ARGV_MARK} %*`,
    'pause > nul',
    '',
  ].join('\r\n');
  writeFileSync(join(dir, 'claude.cmd'), cmd, 'utf8');
}

/**
 * Um `claude.cmd` falso que só IMPRIME o argv que recebeu — o do 12º cenário.
 *
 * Ele não precisa responder `--version` como o `makeFakeClaude` acima: ali o
 * core pergunta antes de criar uma sessão de AGENTE; aqui a sessão é de SHELL,
 * e o único papel do falso é ser o ALVO do wrapper da sessão. O que o teste lê
 * nas linhas do xterm é justamente esta linha: se ela vier com
 * `--settings <pasta da sessão>\settings.json`, quem atendeu o `claude`
 * digitado foi o wrapper, e não o binário direto.
 */
function makeArgvClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude.cmd'), ['@echo off', `echo ${ARGV_MARK} %*`, ''].join('\r\n'), 'utf8');
}

/**
 * A env do processo com uma pasta no COMEÇO do `PATH` (o `claude` falso).
 *
 * `Path` (e não `PATH`): no Windows as duas são a MESMA variável, e passar as
 * duas pro filho é comportamento indefinido — então a original sai e uma só
 * volta.
 */
function envWithBin(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.Path = `${dir};${process.env.Path ?? process.env.PATH ?? ''}`;
  return env;
}

/**
 * Repo temporário com um commit em `main`, dentro de uma pasta COM ESPAÇO no
 * nome (é o que prova que nenhuma chamada de git do core passou por shell).
 *
 * O repo do Bridge nunca é usado: o user proibiu commits nele, e o fluxo desta
 * rodada commita, mescla e apaga branch.
 */
function makeTaskRepo(parent: string): string {
  const root = join(parent, 'repo tarefa');
  mkdirSync(root);
  gitCli(root, ['init', '-b', 'main']);
  gitCli(root, ['config', 'user.name', 'Bridge E2E']);
  gitCli(root, ['config', 'user.email', 'e2e@bridge.local']);
  gitCli(root, ['config', 'commit.gpgsign', 'false']);
  gitCli(root, ['config', 'core.autocrlf', 'false']);
  gitCli(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'leiame.md'), 'ola\n', 'utf8');
  gitCli(root, ['add', '.']);
  gitCli(root, ['commit', '-m', 'inicial']);
  return root;
}

test.describe('Bridge — e2e do app empacotável', () => {
  let app: ElectronApplication;
  let win: Page;
  let profileDir = '';
  let workspaceDir = '';
  let toastLog = '';
  let userDataDir = '';
  let instance: Instance;
  // Terceiro teste (fluxo de tarefa): perfil e user-data próprios — o repo
  // temporário nasce no `beforeAll` porque `BRIDGE_TEST_FOLDER` (a pasta que
  // o `pickFolder` devolve) tem que existir antes do primeiro launch.
  let taskProfileDir = '';
  let taskUserDataDir = '';
  let repoParentDir = '';
  let taskRepo = '';
  // Quinto teste (fechar painel) e sexto (configurações): idem, cada um no seu.
  let paneProfileDir = '';
  let paneUserDataDir = '';
  let paneWorkspaceDir = '';
  let settingsProfileDir = '';
  let settingsUserDataDir = '';
  let settingsWorkspaceDir = '';
  // Sétimo teste (resume do Claude Code, 0.6.0): perfil, user-data e pasta
  // próprios — este é o ÚNICO cenário que sobe um Claude Code de verdade.
  let resumeProfileDir = '';
  let resumeUserDataDir = '';
  let resumeWorkspaceDir = '';
  // Oitavo teste (monitor de uso, 0.10.0): perfil, user-data, pasta de
  // workspace, a raiz de transcrições sintéticas e a pasta do `claude` falso.
  let usageProfileDir = '';
  let usageUserDataDir = '';
  let usageWorkspaceDir = '';
  let usageHomeDir = '';
  let usageBinDir = '';
  // Nono teste (guarda de escopo, 0.11.0): perfil, user-data, o `claude` falso
  // e um repositório PRÓPRIO — o do terceiro cenário é mesclado e removido lá,
  // e este precisa de duas tarefas vivas ao mesmo tempo.
  let scopeProfileDir = '';
  let scopeUserDataDir = '';
  let scopeBinDir = '';
  let scopeRepoParent = '';
  // Décimo teste (fila do escalonador, 0.11.0): perfil, user-data, pasta de
  // workspace e o `claude` falso.
  let queueProfileDir = '';
  let queueUserDataDir = '';
  let queueWorkspaceDir = '';
  let queueBinDir = '';
  // Décimo quarto teste (idioma, 0.13.0): perfil, user-data e pasta de
  // workspace próprios — o perfil precisa nascer SEM `ui.language`, e reusar o
  // de outro cenário traria a configuração dele junto.
  let langProfileDir = '';
  let langUserDataDir = '';
  let langWorkspaceDir = '';

  test.beforeAll(() => {
    if (!existsSync(join(UI_DIR, 'index.html'))) {
      throw new Error(`UI não buildada (${UI_DIR}\\index.html). Rode: npm run build:ui`);
    }
    if (!existsSync(SHELL_MAIN)) {
      throw new Error(`shell não buildado (${SHELL_MAIN}). Rode: npm run build -w @bridge/shell`);
    }
    // O cenário de idioma roda a CLI de verdade como processo filho.
    if (!existsSync(CLI_BIN)) {
      throw new Error(`CLI não buildada (${CLI_BIN}). Rode: npm run build:cli`);
    }
    repoParentDir = tmp('bridge-e2e-repo-');
    taskRepo = makeTaskRepo(repoParentDir);
  });

  test.afterAll(async () => {
    // Rede de segurança: se uma asserção estourou no meio, o app não pode
    // ficar de pé (com o core e os PTYs junto) segurando a máquina.
    try {
      await app?.close();
    } catch {
      // já estava fechado.
    }
    for (const dir of tmpDirs) {
      if (!dir) continue;
      try {
        // `maxRetries`: no Windows o handle do sqlite/log solta um instante
        // DEPOIS do processo sair, e a primeira tentativa pegava `EBUSY` —
        // era o que deixava um `bridge-e2e-*-ws` por execução em `%TEMP%`.
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // sqlite/log ainda segurando um arquivo: lixo em %TEMP%, não falha de teste.
      }
    }
  });

  test('abre sem token, cria workspace + shell, divide, notifica e encerra limpo', async () => {
    profileDir = tmp('bridge-e2e-profile-');
    workspaceDir = tmp('bridge-e2e-ws-');
    userDataDir = tmp('bridge-e2e-userdata-');
    toastLog = join(profileDir, 'toasts.jsonl');
    // Porta 0 = o SO escolhe. Sem isso o e2e brigaria com um Bridge de verdade
    // já ocupando a 4560.
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = ['packages\\core', 'packages/core', 'packages\\shell', 'packages/shell', profileDir, userDataDir];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      // O app é a pasta `packages/shell` (o `main` do package.json dela).
      // `--user-data-dir` isola o `requestSingleInstanceLock`: sem ele, um
      // Bridge aberto na máquina faria esta instância sair calada.
      args: ['packages/shell', `--user-data-dir=${userDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: profileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_TOAST_LOG: toastLog,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: workspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');

    // ---------------------------------------------------- 1. sem tela de token
    // No Electron o token vem do preload (`window.bridge`), não de formulário.
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.token-screen')).toHaveCount(0);
    expect(await win.evaluate(() => typeof (window as unknown as { bridge?: unknown }).bridge)).toBe('object');
    await expect(win.locator('.empty-state')).toContainText('Nenhum workspace ainda');

    instance = await waitForInstance(profileDir, 20_000);
    expect(instance.port).toBeGreaterThan(0);
    expect(instance.token).toHaveLength(64);

    // Contraprova da varredura de processos do fim: com o app DE PÉ ela tem que
    // enxergar o Electron e o core. Sem isto, uma consulta quebrada faria a
    // asserção final ("nada sobrou") passar sempre, sem olhar nada.
    const during = bridgeProcesses(needles);
    expect(during.some((p) => p.name === 'electron.exe'), `sem electron.exe em ${JSON.stringify(during)}`).toBe(true);
    expect(during.some((p) => p.pid === instance.pid), `sem o core (pid ${instance.pid}) em ${JSON.stringify(during)}`).toBe(true);

    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    };

    // ------------------------------------- 2. Ctrl+Shift+N e a pasta mockada
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();

    // "Escolher…" chama `window.bridge.pickFolder()` → o main devolve
    // `BRIDGE_TEST_FOLDER` sem abrir o diálogo nativo (que o Playwright não
    // consegue operar: é janela do sistema, não do renderer).
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    const workspaceName = workspaceDir.split(/[\\/]/).filter(Boolean).pop()!;
    await expect(dialog.locator('#ws-cwd')).toHaveValue(workspaceDir);
    await expect(dialog.locator('#ws-name')).toHaveValue(workspaceName);

    // Sem isto o diálogo subiria um Claude Code de verdade na conta do usuário.
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();

    // ------------------------------------------- 3. Enter cria o workspace
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    await expect(win.locator('.workspace-name')).toHaveText(workspaceName);
    await expect(win.locator('.tabs-bar .tab')).toHaveCount(1);
    await expect(win.locator('.tab-surface .pane')).toHaveCount(1);
    // Painel novo, sem sessão: a dica de atalho é o corpo dele.
    await expect(win.locator('.pane-hint')).toBeVisible();

    // -------------------------------- 4. Enter no painel vazio abre um shell
    await win.locator('.tab-surface .pane').first().click();
    await win.keyboard.press('Enter');

    const rows = win.locator('.session-row');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.first().locator('.session-label')).toHaveText('shell');
    await expect(rows.first().locator('.ring.idle')).toHaveCount(1);
    await expect(win.locator('.tab-surface .pane .pane-label').first()).toHaveText('shell');
    // Contraprova do outro lado da varredura: o PTY (pwsh) existe agora.
    const ptyDuring = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyDuring.length, `nenhum pwsh novo depois de abrir o shell`).toBeGreaterThan(0);

    // ------------------------------------------------ 5. Ctrl+Shift+D divide
    await win.keyboard.press('Control+Shift+D');
    await expect(win.locator('.tab-surface .pane')).toHaveCount(2);
    // O split leva o foco pro painel NOVO (vazio), então nenhuma sessão fica
    // focada — é o que dá sentido à asserção do `Ctrl+Shift+U` mais abaixo.
    await expect(win.locator('.session-row.focused')).toHaveCount(0);

    // ---------------------------------- 6. notificação → linha no toast log
    const state = await api<{ sessions: { id: string; kind: string; workspaceId: string }[] }>('/api/state');
    const shellSession = state.sessions.find((s) => s.kind === 'shell');
    expect(shellSession, 'o core devia ter uma sessão de shell').toBeTruthy();

    // A janela do Playwright costuma estar sem foco, mas a UI pode ter postado
    // `windowFocused: true` no último `POST /api/focus`. Com foco na PRÓPRIA
    // sessão o core marca o toast como "quieto" (spec §4) e não haveria linha
    // nenhuma no log — então o teste declara o blur antes de notificar.
    await api('/api/focus', { method: 'POST', body: { sessionId: shellSession!.id, windowFocused: false } });
    await api(`/api/sessions/${shellSession!.id}/notify`, { method: 'POST', body: { text: 'e2e: terminou' } });

    await expect
      .poll(() => readToastLog(toastLog).length, { timeout: 20_000, message: 'nenhuma linha em BRIDGE_TOAST_LOG' })
      .toBeGreaterThan(0);
    const toasts = readToastLog(toastLog);
    const toast = toasts.find((t) => t.body === 'e2e: terminou');
    expect(toast, `toast não encontrado em ${JSON.stringify(toasts)}`).toBeTruthy();
    expect(toast!.kind).toBe('custom');
    expect(toast!.sessionId).toBe(shellSession!.id);
    expect(toast!.title).toBe(`Bridge · ${workspaceName}`);

    // -------------------------------- 7. Ctrl+Shift+U foca a sessão da fila
    await win.keyboard.press('Control+Shift+U');
    const focused = win.locator('.session-row.focused');
    await expect(focused).toHaveCount(1, { timeout: 20_000 });
    await expect(focused.locator('.session-label')).toHaveText('shell');

    // --------------------------------- 8. fechar → nada sobrevive ao app
    const corePid = instance.pid;
    expect(alive(corePid)).toBe(true);

    await app.close();

    // O `will-quit` do main chama `stopCore()` (taskkill /t /f), então a
    // árvore inteira — core, pwsh do PTY — tem que ir junto.
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);

    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    // O `taskkill /t` desce a árvore: o pwsh do PTY tem que ter ido junto.
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);

    // R4 — o encerramento gracioso (`POST /api/shutdown`) roda o `stop()` do
    // core, e é ele que apaga o `instance.json`. Um `taskkill` seco deixaria
    // o arquivo pra trás (e o próximo launch teria que limpar a sujeira).
    expect(existsSync(join(profileDir, 'instance.json'))).toBe(false);
  });

  /**
   * Segunda subida NO MESMO PERFIL: o layout persistido (spec §10) volta do
   * SQLite e os painéis do workspace ativo reabrem como shell (R3 — a
   * restauração acontece só no workspace que a UI monta).
   *
   * Depende do teste anterior: reusa `profileDir`/`workspaceDir` (o
   * `playwright.config.ts` roda com um worker só, sem paralelismo).
   */
  test('relança no mesmo perfil: layout volta e os painéis do workspace ativo ganham shell', async () => {
    expect(profileDir, 'o primeiro teste precisa ter rodado').not.toBe('');
    const needles = ['packages\\core', 'packages/core', 'packages\\shell', 'packages/shell', profileDir, userDataDir];
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${userDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: profileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_TOAST_LOG: toastLog,
        BRIDGE_HEADLESS_ERRORS: '1',
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');

    /**
     * Respostas de erro do `POST /api/sessions` do restore. O `restorePanes`
     * da UI engole a falha numa linha de status que some em 4 s, então sem
     * este registro um restore que reabre só um painel vira um
     * "esperava 2, veio 1" sem nenhuma pista do porquê.
     */
    const sessionFailures: string[] = [];
    win.on('response', (res) => {
      if (res.url().includes('/api/sessions') && !res.ok()) sessionFailures.push(`${res.status()} ${res.url()}`);
    });

    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });

    // O workspace, a aba e os DOIS painéis do split voltaram.
    const workspaceName = workspaceDir.split(/[\\/]/).filter(Boolean).pop()!;
    await expect(win.locator('.workspace-name')).toHaveText(workspaceName);
    await expect(win.locator('.tabs-bar .tab')).toHaveCount(1);
    await expect(win.locator('.tab-surface .pane')).toHaveCount(2);

    const restored = await waitForInstance(profileDir, 20_000);
    const coreState = async (): Promise<{ sessions: { kind: string }[]; layout: { panes: unknown[] } }> =>
      fetch(`http://127.0.0.1:${restored.port}/api/state`, {
        headers: { authorization: `Bearer ${restored.token}` },
      }).then((r) => r.json() as Promise<{ sessions: { kind: string }[]; layout: { panes: unknown[] } }>);

    // Restauração: os dois painéis reabrem como shell (nenhum fica com a dica
    // de painel vazio), e o core tem duas sessões de novo.
    const rows = win.locator('.session-row');
    await expect
      .poll(
        async () => {
          const count = await rows.count();
          if (count === 2) return 'ok';
          // Falhou: o que o CORE tem e que erro de rota houve separam
          // "a UI não pediu a 2ª sessão" de "o core não conseguiu criá-la".
          const sessions = (await coreState().catch(() => ({ sessions: [] }))).sessions.length;
          return `linhas=${count} · sessões no core=${sessions} · POST /api/sessions com erro=${JSON.stringify(sessionFailures)}`;
        },
        { timeout: 30_000 },
      )
      .toBe('ok');
    await expect(win.locator('.tab-surface .pane .pane-label')).toHaveText(['shell', 'shell']);
    await expect(win.locator('.pane-hint')).toHaveCount(0);

    const state = await coreState();
    expect(state.sessions.map((s) => s.kind)).toEqual(['shell', 'shell']);
    expect(state.layout.panes).toHaveLength(2);

    await app.close();
    await expect.poll(() => alive(restored.pid), { timeout: 30_000 }).toBe(false);
    expect(existsSync(join(profileDir, 'instance.json'))).toBe(false);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
    const leftovers = bridgeProcesses(needles).filter((p) => p.pid === restored.pid);
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
  });

  /**
   * Fase 3 ponta a ponta: "Nova tarefa" num repo de VERDADE (temporário),
   * indicadores `+N ~M` vindos do core, as duas recusas da remoção (spec §10),
   * o merge ff-only e a remoção que finalmente passa.
   *
   * Perfil próprio (não o dos dois primeiros testes): o repo aqui é o dono da
   * história e um `instance.json`/layout herdado só embaralharia o que se está
   * medindo. `BRIDGE_TEST_FOLDER` aponta pro repo — é ele que o `pickFolder`
   * devolve quando o diálogo pede "Escolher…".
   *
   * O que este teste NÃO faz, de novo: subir Claude Code (o checkbox é
   * desmarcado). O que se está provando é o git, não o agente.
   */
  test('nova tarefa: worktree, badges +N ~M, recusas da remoção, merge ff-only e remoção', async () => {
    taskProfileDir = tmp('bridge-e2e-task-profile-');
    taskUserDataDir = tmp('bridge-e2e-task-userdata-');
    writeFileSync(join(taskProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      taskProfileDir,
      taskUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${taskUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: taskProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_TOAST_LOG: join(taskProfileDir, 'toasts.jsonl'),
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: taskRepo,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    // Toda ação destrutiva do menu passa por `window.confirm`. Sem um handler
    // o Playwright DISPENSA o diálogo (equivale a "Cancelar") e nada
    // aconteceria — o teste ficaria verde sem exercitar nada.
    win.on('dialog', (d) => void d.accept());

    const taskInstance = await waitForInstance(taskProfileDir, 20_000);
    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      // `content-type: application/json` SÓ quando há corpo: o Fastify recusa
      // com 400 um POST que se declara JSON e chega vazio (`git/refresh`).
      const res = await fetch(`http://127.0.0.1:${taskInstance.port}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${taskInstance.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    };

    // ------------------------------------- 1. Ctrl+Shift+Alt+N abre o diálogo
    await win.keyboard.press('Control+Shift+Alt+N');
    const dialog = win.getByTestId('task-dialog');
    await expect(dialog).toBeVisible();

    // ------------------------------------- 2. "Escolher…" → detecção do repo
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    // `GET /api/git/detect` respondeu com o worktree PRINCIPAL e a branch dele.
    await expect(dialog.getByTestId('task-detect')).toHaveText(`${taskRepo} · main`);
    // Base default = a branch detectada (o usuário não digitou nada).
    await expect(dialog.locator('#task-base')).toHaveValue('main');

    // --------------------------------------- 3. nome + preview do branch
    await dialog.locator('#task-name').fill('e2e-task');
    await expect(dialog.getByTestId('task-branch')).toHaveText('branch: e2e-task');

    // Sem isto o diálogo subiria um Claude Code de verdade na conta do usuário.
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();

    // ------------------------------------------------ 4. Enter cria a tarefa
    await dialog.locator('#task-name').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    const row = win.locator('.workspace').filter({ has: win.locator('.workspace-name', { hasText: 'e2e-task' }) });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.locator('.workspace-branch')).toHaveText('e2e-task');

    const worktreePath = join(taskRepo, '.worktrees', 'e2e-task');
    expect(existsSync(worktreePath), `worktree não nasceu em ${worktreePath}`).toBe(true);
    // `.worktrees/` não pode virar alteração no repo do usuário (spec §7).
    const exclude = readFileSync(join(taskRepo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.worktrees/');

    const state = await api<{ layout: { workspaces: { id: string; name: string }[] } }>('/api/state');
    const workspaceId = state.layout.workspaces.find((w) => w.name === 'e2e-task')?.id;
    expect(
      workspaceId,
      `workspace e2e-task não veio no snapshot: ${JSON.stringify(state.layout.workspaces)}`,
    ).toBeTruthy();

    const ahead = row.locator('.git-ahead');
    const dirty = row.locator('.git-dirty');
    const refresh = (): Promise<void> => api(`/api/workspaces/${workspaceId!}/git/refresh`, { method: 'POST' });

    // ----------------------------------------------- 5. badges `+0 ~0`
    await refresh();
    await expect(ahead).toHaveText('+0');
    await expect(dirty).toHaveText('~0');

    // -------------------------- 6. arquivo novo no worktree → `~1` no refresh
    writeFileSync(join(worktreePath, 'novo.txt'), 'alteracao do e2e\n', 'utf8');
    await refresh();
    await expect(dirty).toHaveText('~1');
    await expect(dirty).toHaveClass(/warn/);

    /** "⋯" → item do menu, pelo papel (o popover é `role="menu"`). */
    const pickMenu = async (label: string): Promise<void> => {
      await row.locator('.workspace-menu-button').click();
      await row.getByRole('menuitem', { name: label }).click();
    };

    // ------------------- 7. remoção com worktree sujo → 409 na faixa de status
    await pickMenu('Remover worktree');
    // A mensagem do core (`dirty-worktree`) inteira, com o `detail` junto: é a
    // única coisa que diz ao usuário o que fazer antes de tentar de novo.
    await expect(win.locator('.status-message')).toContainText('não commitada', { timeout: 15_000 });
    await expect(win.locator('.status-message')).toContainText('novo.txt');
    // Recusa é recusa: nada foi removido.
    await expect(row).toHaveCount(1);
    expect(existsSync(worktreePath)).toBe(true);

    // ------------------------------- 8. commit no worktree → `+1 ~0`
    gitCli(worktreePath, ['add', '-A']);
    gitCli(worktreePath, ['commit', '-m', 'x']);
    await refresh();
    await expect(ahead).toHaveText('+1');
    await expect(dirty).toHaveText('~0');

    // --------------------- 9. remoção com branch não mesclado → 409 `not-merged`
    await pickMenu('Remover worktree');
    await expect(win.locator('.status-message')).toContainText('ainda não foi mesclado em main', { timeout: 15_000 });
    await expect(row).toHaveCount(1);
    expect(existsSync(worktreePath)).toBe(true);

    // ------------------------------------- 10. "Mesclar no base" (fast-forward)
    await pickMenu('Mesclar no base');
    await expect(win.locator('.status-message')).toContainText('Mesclado em main', { timeout: 20_000 });
    // O merge derruba o `+N` — e a UI não espera o próximo ciclo do poller.
    await expect(ahead).toHaveText('+0', { timeout: 20_000 });
    expect(gitCli(taskRepo, ['log', '--oneline', '-1', 'main'])).toContain('x');

    // ------------------------------- 11. remoção agora passa: linha e pasta somem
    await pickMenu('Remover worktree');
    // A espera devolve a FAIXA DE STATUS enquanto a linha não some: se a rota
    // recusar (409) ou o git falhar, a mensagem do core aparece na falha em vez
    // de um "esperava 0, veio 1" que não diz nada.
    await expect
      .poll(
        async () => ((await row.count()) === 0 ? 'removido' : (await win.locator('.status-strip').innerText()).trim()),
        { timeout: 30_000 },
      )
      .toBe('removido');
    await expect.poll(() => existsSync(worktreePath), { timeout: 20_000 }).toBe(false);
    // O branch da tarefa foi junto (`git branch -d`).
    expect(gitCli(taskRepo, ['branch', '--list'])).not.toContain('e2e-task');

    // --------------------------------- 12. fechar → nada sobrevive ao app
    const corePid = taskInstance.pid;
    expect(alive(corePid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);

    const leftoverProcs = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftoverProcs, `processos órfãos: ${JSON.stringify(leftoverProcs, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
    expect(existsSync(join(taskProfileDir, 'instance.json'))).toBe(false);
  });
  /**
   * Quinto cenário (lote do dono, 0.5.0) — `pane.close`.
   *
   * `Ctrl+Shift+T` abre uma aba nova, que nasce com UM painel vazio; o
   * `Ctrl+Shift+X` fecha esse painel e, como era o último da aba, a aba tem
   * que sumir junto (`removeLeaf` → `undefined` → `removeTabInternal` no
   * core). É o caminho que o dono pediu em "fechar painel vazio": antes disso,
   * um painel vazio só sumia fechando a aba inteira.
   *
   * Perfil próprio: os quatro anteriores encadeiam estado entre si, e este
   * conta abas — herdar layout de outro teste tornaria a contagem frágil.
   */
  test('fechar painel: Ctrl+Shift+T abre aba nova e Ctrl+Shift+X fecha o painel vazio junto com a aba', async () => {
    paneProfileDir = tmp('bridge-e2e-pane-profile-');
    paneUserDataDir = tmp('bridge-e2e-pane-userdata-');
    paneWorkspaceDir = tmp('bridge-e2e-pane-ws-');
    writeFileSync(join(paneProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = ['packages\\core', 'packages/core', 'packages\\shell', 'packages/shell', paneProfileDir, paneUserDataDir];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${paneUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: paneProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: paneWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(paneProfileDir, 20_000);

    // ------------------------------------------ 1. workspace (sem Claude)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(paneWorkspaceDir);
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    const tabs = win.locator('.tabs-bar .tab');
    // Toda aba do workspace ativo fica MONTADA (R3 da Fase 4, pra não perder
    // scrollback); a inativa some por `display: none`. Contar painel sem o
    // `:visible` contaria os da outra aba.
    const panes = win.locator('.tab-surface:visible .pane');
    await expect(tabs).toHaveCount(1);
    await expect(panes).toHaveCount(1);

    // ------------------------------------- 2. Ctrl+Shift+T → aba nova vazia
    await win.keyboard.press('Control+Shift+T');
    await expect(tabs).toHaveCount(2, { timeout: 20_000 });
    await expect(panes).toHaveCount(1);
    // A aba nova nasce ativa e com um painel VAZIO: é a dica de atalho, e são
    // os três botões que a Task 3 pôs abaixo dela.
    await expect(win.locator('.tab-surface:visible .pane-hint')).toBeVisible();
    const emptyActions = win.locator('.tab-surface:visible .pane-hint-actions button');
    await expect(emptyActions).toHaveCount(3);
    await expect(emptyActions.nth(2)).toHaveText('Fechar painel');

    // --------------------- 3. Ctrl+Shift+X fecha o painel E a aba com ele
    await win.keyboard.press('Control+Shift+X');
    await expect(tabs).toHaveCount(1, { timeout: 20_000 });
    await expect(panes).toHaveCount(1);

    // O core é a autoridade: a aba tem que ter sumido de lá também, não só da
    // tela (é ele quem apaga, pelo `DELETE /api/panes/:id`).
    const state = (await (
      await fetch(`http://127.0.0.1:${inst.port}/api/state`, { headers: { authorization: `Bearer ${inst.token}` } })
    ).json()) as { layout: { tabs: unknown[]; panes: unknown[] } };
    expect(state.layout.tabs).toHaveLength(1);
    expect(state.layout.panes).toHaveLength(1);

    // -------------------------------------- 4. fechar → nada sobrevive
    const corePid = inst.pid;
    expect(alive(corePid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Sexto cenário (lote do dono, 0.5.0) — o diálogo de configurações.
   *
   * `Ctrl+,` abre o diálogo, o campo "Tamanho" vai a 16, e o teste cobra as
   * duas pontas do contrato: o xterm **já aberto** tem que re-renderizar (a
   * folha de estilo do renderer DOM passa a dizer `font-size: 16px` e, com a
   * célula mais alta na mesma área, sobram menos linhas) e o
   * `GET /api/config` tem que devolver 16 — ou seja, o PATCH chegou, foi
   * validado, gravado e aplicado. No fim volta pra 12, que é o default.
   */
  test('configurações: Ctrl+, muda o corpo da fonte no xterm aberto e no GET /api/config', async () => {
    settingsProfileDir = tmp('bridge-e2e-settings-profile-');
    settingsUserDataDir = tmp('bridge-e2e-settings-userdata-');
    settingsWorkspaceDir = tmp('bridge-e2e-settings-ws-');
    writeFileSync(join(settingsProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      settingsProfileDir,
      settingsUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${settingsUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: settingsProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: settingsWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(settingsProfileDir, 20_000);

    const config = async (): Promise<{ terminal: { fontFamily: string; fontSize: number }; profileDir: string }> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/config`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/config → ${res.status}`);
      return (await res.json()) as { terminal: { fontFamily: string; fontSize: number }; profileDir: string };
    };

    // --------------------------- 1. workspace + shell (é o xterm da medida)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(settingsWorkspaceDir);
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    await win.locator('.tab-surface .pane').first().click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row')).toHaveCount(1, { timeout: 30_000 });
    const rows = win.locator('.xterm-rows');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });

    /** Corpo da fonte que o renderer DOM do xterm está de fato aplicando. */
    const xtermFontSize = (): Promise<string> =>
      win.evaluate(() => {
        const el = document.querySelector('.xterm-rows');
        return el === null ? '' : getComputedStyle(el).fontSize;
      });
    /** Quantas linhas cabem na área — muda quando a altura da célula muda. */
    const xtermRowCount = (): Promise<number> =>
      win.evaluate(() => document.querySelectorAll('.xterm-rows > div').length);

    expect(await xtermFontSize()).toBe('12px');
    const rowsBefore = await xtermRowCount();
    expect(rowsBefore).toBeGreaterThan(0);
    expect((await config()).terminal.fontSize).toBe(12);

    // ------------------------------------------ 2. Ctrl+, abre o diálogo
    await win.keyboard.press('Control+,');
    const settings = win.locator('.settings-dialog');
    await expect(settings).toBeVisible({ timeout: 20_000 });
    // Oito seções na coluna da esquerda (a "Sessões" entrou na 0.6.0, a
    // "Sistema" do auto-start com o Windows na 0.7.0 e a "Uso" do monitor
    // nativo na 0.10.0), Terminal aberta por padrão.
    await expect(settings.locator('.settings-nav-item')).toHaveCount(8);
    await expect(settings.locator('.settings-nav-item.active')).toHaveText('Terminal');
    await expect(settings.locator('#set-size')).toHaveValue('12');

    // ------------------------- 3. corpo 16: o xterm ABERTO tem que reagir
    await settings.locator('#set-size').fill('16');
    await expect.poll(xtermFontSize, { timeout: 20_000 }).toBe('16px');
    // Célula mais alta na mesma área = menos linhas. É a prova de que o xterm
    // remediu a grade, não só trocou o CSS.
    await expect.poll(xtermRowCount, { timeout: 20_000 }).toBeLessThan(rowsBefore);
    await expect(settings.locator('.error-line')).toHaveCount(0);

    // O PATCH foi ao core, foi validado, gravado e aplicado.
    await expect.poll(async () => (await config()).terminal.fontSize, { timeout: 20_000 }).toBe(16);

    // O `profileDir` do GET é absoluto (é ele que o botão "Abrir pasta do
    // perfil" manda pro `openPath`, que recusa caminho relativo/inexistente).
    expect(existsSync((await config()).profileDir)).toBe(true);

    // -------------------------------------------- 4. de volta pro default
    await settings.locator('#set-size').fill('12');
    await expect.poll(xtermFontSize, { timeout: 20_000 }).toBe('12px');
    await expect.poll(async () => (await config()).terminal.fontSize, { timeout: 20_000 }).toBe(12);

    await win.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);

    // -------------------------------------- 5. fechar → nada sobrevive
    const corePid = inst.pid;
    expect(alive(corePid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Sétimo cenário (0.6.0) — **retomar o Claude Code ao reabrir**.
   *
   * O único teste do arquivo que sobe um Claude Code DE VERDADE, porque é a
   * única forma de provar a corrente inteira: o `session_id` só existe porque
   * um hook do binário real chegou no core; o `--resume` só vale se o binário
   * aceitar o id que o Bridge guardou.
   *
   * Roteiro: perfil limpo → workspace com "Abrir um Claude Code" MARCADO →
   * aceitar o diálogo de confiança (ele começa em "No, exit": `ArrowDown` +
   * `Enter`) → esperar o `agentSessionId` aparecer no `GET /api/state` (é o
   * `SessionStart` do Claude) → `app.close()` gracioso (o shell manda
   * `POST /api/shutdown`, e é o `stop()` do core que carimba
   * `lastEndedBy: 'app'`) → relançar no mesmo perfil → o painel volta como
   * AGENTE, com a faixa "retomando a sessão anterior do Claude Code · <8
   * primeiros do id>" na linha do painel (`.pane-restore-strip`).
   */
  test('resume: o painel que era Claude Code volta como Claude Code, não como shell', async () => {
    // Duas subidas do Electron mais dois boots do Claude real não cabem no
    // teto padrão de 180 s com folga.
    test.setTimeout(300_000);

    resumeProfileDir = tmp('bridge-e2e-resume-profile-');
    resumeUserDataDir = tmp('bridge-e2e-resume-userdata-');
    resumeWorkspaceDir = tmp('bridge-e2e-resume-ws-');
    writeFileSync(join(resumeProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      resumeProfileDir,
      resumeUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    const launch = async (): Promise<void> => {
      app = await electron.launch({
        args: ['packages/shell', `--user-data-dir=${resumeUserDataDir}`],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BRIDGE_DEV: '0',
          BRIDGE_PROFILE_DIR: resumeProfileDir,
          BRIDGE_UI_DIR: UI_DIR,
          BRIDGE_HEADLESS_ERRORS: '1',
          BRIDGE_TEST_FOLDER: resumeWorkspaceDir,
        },
        timeout: 60_000,
      });
      win = await app.firstWindow({ timeout: 60_000 });
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    };

    interface StateSession {
      id: string;
      paneId: string;
      kind: string;
      agent?: string;
      agentSessionId?: string;
    }
    interface StatePane {
      id: string;
      lastKind?: string;
      lastAgent?: string;
      lastAgentSessionId?: string;
      lastEndedBy?: string;
    }
    const stateOf = async (inst: Instance): Promise<{ sessions: StateSession[]; layout: { panes: StatePane[] } }> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/state`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
      return (await res.json()) as { sessions: StateSession[]; layout: { panes: StatePane[] } };
    };
    /** O que o PTY já cuspiu — é nele que o diálogo de confiança aparece. */
    const scrollbackOf = async (inst: Instance, sessionId: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/sessions/${sessionId}/scrollback`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) return '';
      return ((await res.json()) as { data: string }).data;
    };
    const squash = (text: string): string => text.replace(/\s/g, '');
    /**
     * Vigia do banner, instalado DENTRO da página assim que a janela abre —
     * antes de o terminal existir.
     *
     * Por que não basta um `expect.poll` lendo a faixa: desde 13/09/2026 ela
     * mora no `.pane-restore-strip` e SAI sozinha assim que o core julga o
     * resume (`resumeOutcome`), o que acontece no `SessionStart` do Claude —
     * poucos segundos depois. Quem olha de fora, a cada tique, pode chegar
     * tarde. Um `MutationObserver` no corpo da página (mais um tique de 30 ms
     * como rede) vê a faixa no instante em que ela aparece e guarda o texto —
     * o teste depois só pergunta o que foi visto.
     */
    const watchBannerInPage = async (): Promise<void> => {
      await win.evaluate(() => {
        const w = window as unknown as { __bannerSeen?: string };
        w.__bannerSeen = '';
        const check = (): void => {
          if (w.__bannerSeen) return;
          const el = document.querySelector('.pane-restore-strip') as HTMLElement | null;
          if (!el) return;
          const text = el.innerText.replace(/\s/g, '');
          if (text.includes('retomandoasess')) w.__bannerSeen = text;
        };
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
        setInterval(check, 30);
      });
    };
    const bannerSeenInPage = (): Promise<string> =>
      win.evaluate(() => (window as unknown as { __bannerSeen?: string }).__bannerSeen ?? '');

    // ======================================================= 1ª subida
    await launch();
    const first = await waitForInstance(resumeProfileDir, 20_000);

    // ------------------- workspace COM o Claude Code (o checkbox fica marcado)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(resumeWorkspaceDir);
    // Ao contrário dos seis cenários acima, aqui o checkbox PERMANECE marcado.
    await expect(dialog.locator('.dialog-check input[type="checkbox"]')).toBeChecked();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    // A sessão de agente nasceu (o PTY subiu o `claude`).
    await expect
      .poll(async () => (await stateOf(first)).sessions.map((x) => x.kind), { timeout: 60_000 })
      .toEqual(['agent']);
    const firstSession = (await stateOf(first)).sessions[0]!;
    expect(firstSession.agent).toBe('claude');

    // ---------------------------------- diálogo de confiança do Claude Code
    // Pasta temporária = pasta nunca vista, então o binário pergunta "Do you
    // trust the files in this folder?" com o cursor em "No, exit". A tecla vai
    // pelo xterm (é ele que manda `input` pelo WS), então o painel tem que
    // estar em foco.
    await win.locator('.tab-surface .pane').first().click();
    await expect
      .poll(
        async () => {
          const sessions = (await stateOf(first)).sessions;
          if (sessions[0]?.agentSessionId) return true;
          return /trust the files|Do you trust/i.test(await scrollbackOf(first, firstSession.id));
        },
        { timeout: 60_000, intervals: [250] },
      )
      .toBe(true);
    if (!(await stateOf(first)).sessions[0]?.agentSessionId) {
      await win.keyboard.press('ArrowDown');
      await win.keyboard.press('Enter');
    }

    // O `session_id` do Claude chegou pelo hook `SessionStart` e o core gravou
    // nos dois lugares: na sessão (memória) e no painel (SQLite).
    await expect
      .poll(async () => (await stateOf(first)).sessions[0]?.agentSessionId ?? '', {
        timeout: 120_000,
        intervals: [500],
        message: 'o hook SessionStart do Claude Code não trouxe o session_id',
      })
      .not.toBe('');
    const state1 = await stateOf(first);
    const agentSessionId = state1.sessions[0]!.agentSessionId!;
    expect(agentSessionId.length).toBeGreaterThan(8);
    expect(state1.layout.panes[0]?.lastAgentSessionId).toBe(agentSessionId);

    // ------------------------- fechar com o Claude VIVO (é o que marca 'app')
    const firstPid = first.pid;
    await app.close();
    await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false);
    expect(existsSync(join(resumeProfileDir, 'instance.json'))).toBe(false);

    // ======================================================= 2ª subida
    await launch();

    // O vigia entra antes de o painel voltar: a faixa dura o tempo que o
    // Claude leva pra subir e mandar o `SessionStart`.
    await watchBannerInPage();

    const second = await waitForInstance(resumeProfileDir, 20_000);
    await expect
      .poll(async () => (await stateOf(second)).sessions.map((x) => `${x.kind}:${x.agent ?? '-'}`), {
        timeout: 90_000,
        intervals: [250],
      })
      .toEqual(['agent:claude']);

    // O defeito da 0.5.0 que abriu este lote: o painel voltava como SHELL.
    await expect(win.locator('.tab-surface .pane .pane-label').first()).toHaveText('claude');
    await expect(win.locator('.pane-hint')).toHaveCount(0);

    // E o banner do resume — com os 8 primeiros caracteres do id da conversa
    // que estava ali — apareceu na linha do painel.
    await expect.poll(bannerSeenInPage, { timeout: 30_000, intervals: [250] }).not.toBe('');
    const bannerSeen = await bannerSeenInPage();
    expect(bannerSeen, `banner sem o texto: ${bannerSeen}`).toContain(squash('retomando a sessão anterior do Claude Code'));
    expect(bannerSeen, `banner sem o id: ${bannerSeen}`).toContain(squash(`· ${agentSessionId.slice(0, 8)}`));

    // -------------------------------------- fechar → nada sobrevive
    const secondPid = second.pid;
    await app.close();
    await expect.poll(() => alive(secondPid), { timeout: 30_000 }).toBe(false);
    // O `claude` é um processo `node` lançado com `--settings <perfil>\...`, ou
    // seja ele CASA com os `needles` deste teste: um Claude órfão apareceria
    // aqui.
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Oitavo cenário (0.10.0) — **o monitor de uso**.
   *
   * Duas metades, e as duas com dado que ATRAVESSA o app inteiro:
   *
   * 1. `BRIDGE_CLAUDE_HOME` aponta pra uma árvore de transcrições sintéticas
   *    (uma conversa principal e uma de subagente). O core varre, agrega e
   *    `Ctrl+Shift+Y` abre o painel com os totais — tokens formatados em pt-BR
   *    e o custo calculado pela tabela embutida, conferido aqui na mão.
   * 2. O hook `StatusLine` entra pelo SHIM de verdade
   *    (`packages/core/bin/bridge-hook.cjs`, o mesmo binário que o Claude Code
   *    chama), com `rate_limits` sintético, e a faixa de limites da sidebar
   *    acende as duas barras.
   *
   * O `claude` que roda no painel é um `.cmd` falso no começo do `PATH`: o que
   * está sendo provado é o caminho do dado, não o binário do agente — e o
   * sétimo cenário já sobe um Claude de verdade.
   */
  test('uso: o painel soma a fixture de transcrições e o rate_limits do shim acende a faixa da sidebar', async () => {
    test.setTimeout(240_000);

    usageProfileDir = tmp('bridge-e2e-uso-profile-');
    usageUserDataDir = tmp('bridge-e2e-uso-userdata-');
    usageWorkspaceDir = tmp('bridge-e2e-uso-ws-');
    usageHomeDir = tmp('bridge-e2e-uso-home-');
    usageBinDir = tmp('bridge-e2e-uso-bin-');
    writeFileSync(join(usageProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    makeUsageHome(usageHomeDir);
    makeFakeClaude(usageBinDir);

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      usageProfileDir,
      usageUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    const env = envWithBin(usageBinDir);

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${usageUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: usageProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: usageWorkspaceDir,
        // A raiz das transcrições. NENHUM teste lê o `~/.claude` real.
        BRIDGE_CLAUDE_HOME: usageHomeDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(usageProfileDir, 20_000);

    // ------------------------------ workspace com um "Claude Code" (o falso)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(usageWorkspaceDir);
    await expect(dialog.locator('.dialog-check input[type="checkbox"]')).toBeChecked();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    interface StateSession {
      id: string;
      kind: string;
      agent?: string;
    }
    const sessionsOf = async (): Promise<StateSession[]> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/state`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
      return ((await res.json()) as { sessions: StateSession[] }).sessions;
    };
    await expect.poll(async () => (await sessionsOf()).map((x) => `${x.kind}:${x.agent ?? '-'}`), { timeout: 60_000 }).toEqual([
      'agent:claude',
    ]);
    const sessionId = (await sessionsOf())[0]!.id;

    // ======================================= 1. o painel soma a fixture
    // A varredura da subida é assíncrona; o painel relê sozinho no
    // `usage.changed`, mas o `expect.poll` é quem espera sem `sleep` fixo.
    await win.keyboard.press('Control+Shift+Y');
    const painel = win.locator('.usage-panel');
    await expect(painel).toBeVisible({ timeout: 30_000 });

    /** O valor de um cartão pelo rótulo, sem depender da ordem da grade. */
    const valorDoCartao = (label: string): Promise<string> =>
      win.evaluate((wanted) => {
        const cards = [...document.querySelectorAll('.usage-panel .usage-card')];
        const found = cards.find((c) => c.querySelector('.usage-card-label')?.textContent?.trim() === wanted);
        return found?.querySelector('.usage-card-value')?.textContent?.trim() ?? '';
      }, label);

    // 100k (principal) + 50k (subagente)
    await expect.poll(() => valorDoCartao('Entrada'), { timeout: 60_000, intervals: [500] }).toBe('150k');
    // 20k + 10k
    expect(await valorDoCartao('Saída')).toBe('30k');
    // 40k de escrita + 300k de leitura
    expect(await valorDoCartao('Cache')).toBe('340k');
    expect(await valorDoCartao('Mensagens')).toBe('2');

    /*
      O custo é conferido AQUI na mão, contra a tabela embutida
      (`packages/core/src/usage/pricing.json`), porque um painel que mostra um
      número de dinheiro errado com a mesma confiança de um certo é o pior
      defeito que este lote pode ter:

        sonnet-4-5  3/15/3,75/0,3  →  (100k×3 + 20k×15 + 40k×3,75 + 300k×0,3)/1e6 = 0,84
        haiku-4-5   1/5/1,25/0,1   →  (50k×1  + 10k×5)/1e6                        = 0,10
                                                                          total = US$ 0,94
    */
    expect(await valorDoCartao('Custo estimado')).toBe('US$ 0,94');

    // O subagente entra no total e é NOMEADO — não fica escondido atrás de um
    // filtro. E os dois modelos aparecem com o nome amigável.
    await expect(painel).toContainText('subagentes');
    await expect(painel.locator('.usage-tables')).toContainText('Sonnet 4.5');
    await expect(painel.locator('.usage-tables')).toContainText('Haiku 4.5');

    await win.keyboard.press('Escape');
    await expect(painel).toHaveCount(0);

    // ============================ 2. o rate_limits do shim acende a faixa
    // Sem `rate_limits` ainda, a faixa não existe: duas barras zeradas leriam
    // como cota intacta.
    await expect(win.locator('.sidebar-limits')).toHaveCount(0);

    const payload = JSON.stringify({
      session_id: sessionId,
      model: { display_name: 'Fable 5.1', id: 'claude-fable-5-1' },
      context_window: { total_input_tokens: 70_400 },
      cost: { total_cost_usd: 0.74 },
      rate_limits: {
        five_hour: { used_percentage: 68, resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60 },
        seven_day: { used_percentage: 41, resets_at: Math.floor(Date.now() / 1000) + 3 * 86_400 },
      },
    });
    const shim = spawnSync(process.execPath, [HOOK_SHIM, sessionId, 'StatusLine'], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, BRIDGE_PORT: String(inst.port), BRIDGE_TOKEN: inst.token },
    });
    expect(shim.status).toBe(0);
    // 0.12.2 — `usage.terminalStatusLine` nasce DESLIGADA, e o que o shim
    // devolve é o que o Claude Code imprime: nada. A prova de que isso NÃO
    // desliga a medição vem logo abaixo — o mesmo payload acende as barras da
    // sidebar e o painel.
    expect(shim.stdout, `statusline: ${shim.stdout}`).toBe('');

    // E o mesmo payload acendeu as barras da sidebar, pelo `usage.changed`.
    const faixa = win.locator('.sidebar-limits');
    await expect(faixa).toBeVisible({ timeout: 30_000 });
    await expect(faixa.locator('.limit-row')).toHaveCount(2);
    // `role="meter"` com o valor: é um medidor, não uma figura com legenda.
    const medidores = faixa.locator('[role="meter"]');
    await expect(medidores).toHaveCount(2);
    await expect(medidores.first()).toHaveAttribute('aria-valuenow', '68');
    await expect(medidores.nth(1)).toHaveAttribute('aria-valuenow', '41');
    await expect(faixa).toContainText('68%');
    await expect(faixa).toContainText('41%');

    // O painel também mostra os limites, e no mesmo papel.
    await win.keyboard.press('Control+Shift+Y');
    await expect(painel).toBeVisible({ timeout: 30_000 });
    await expect(painel.locator('.limit-card [role="meter"]')).toHaveCount(2);
    await win.keyboard.press('Escape');

    // 0.12.2 — ligando o interruptor de Configurações → Uso (pela MESMA rota
    // que o checkbox usa), a linha volta pro terminal na chamada seguinte, com
    // exatamente os números que a sidebar acabou de mostrar.
    const patchRes = await fetch(`http://127.0.0.1:${inst.port}/api/config`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ usage: { terminalStatusLine: true } }),
    });
    expect(patchRes.status).toBe(200);
    const comLinha = spawnSync(process.execPath, [HOOK_SHIM, sessionId, 'StatusLine'], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, BRIDGE_PORT: String(inst.port), BRIDGE_TOKEN: inst.token },
    });
    expect(comLinha.status).toBe(0);
    // O que o shim devolve é a linha que o Claude Code IMPRIME na statusline
    // — montada pelo Bridge desde a ADR-012.
    expect(comLinha.stdout, `statusline: ${comLinha.stdout}`).toContain('5h 68%');
    expect(comLinha.stdout).toContain('semana 41%');
    expect(comLinha.stdout).toContain('US$ 0,74');

    await captureWindow(app, join(SHOTS_DIR, '08-uso.png'));

    // -------------------------------------- fechar → nada sobrevive
    const pid = inst.pid;
    await app.close();
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft2 = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft2, `PTYs órfãos: ${JSON.stringify(ptyLeft2, null, 2)}`).toEqual([]);
  });

  /**
   * Nono cenário (0.11.0) — **a guarda de escopo entre worktrees** (dor
   * verificada #4).
   *
   * A dor é exatamente esta: duas tarefas do mesmo repositório rodam em
   * `.worktrees/alfa` e `.worktrees/beta`, e nada impede o Claude Code de alfa
   * de abrir um arquivo de beta por caminho absoluto — o `git worktree` isola
   * o git, não o agente.
   *
   * O `PreToolUse` entra pelo SHIM de verdade (`packages/core/bin/bridge-hook.cjs`,
   * o mesmo binário que o Claude Code chama), como no oitavo cenário: o que
   * está sob prova é o corpo que o AGENTE recebe de volta — o shim ecoa a
   * resposta do core verbatim —, e não uma chamada de rota feita de dentro do
   * teste.
   *
   * O `claude` do painel é o `.cmd` falso: quem decide aqui é o core, não o
   * binário do agente.
   */
  test('escopo: PreToolUse pelo shim com caminho da tarefa VIZINHA volta deny e acende o selo 🛡 na sidebar', async () => {
    test.setTimeout(240_000);

    scopeProfileDir = tmp('bridge-e2e-escopo-profile-');
    scopeUserDataDir = tmp('bridge-e2e-escopo-userdata-');
    scopeBinDir = tmp('bridge-e2e-escopo-bin-');
    scopeRepoParent = tmp('bridge-e2e-escopo-repo-');
    writeFileSync(join(scopeProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    makeFakeClaude(scopeBinDir);
    // Repo PRÓPRIO: o do terceiro cenário é mesclado e removido lá, e este
    // precisa de duas tarefas vivas ao mesmo tempo.
    const repo = makeTaskRepo(scopeRepoParent);

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      scopeProfileDir,
      scopeUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${scopeUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...envWithBin(scopeBinDir),
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: scopeProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: repo,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(scopeProfileDir, 20_000);

    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${inst.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    };

    // ------------------------- 1. a tarefa `escopo-alfa`, com o agente dentro
    // Pelo DIÁLOGO, e não por `POST /api/tasks`: uma tarefa criada por fora da
    // UI não entra no registro de "criação em voo" do `restore.ts`, e a
    // restauração abre um shell no painel novo antes de o agente da tarefa
    // subir (o `createTask` morre com `pane-busy`). Foi o que aconteceu na
    // primeira versão deste cenário.
    await win.keyboard.press('Control+Shift+Alt+N');
    const dialog = win.getByTestId('task-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.getByTestId('task-detect')).toHaveText(`${repo} · main`);
    await dialog.locator('#task-name').fill('escopo-alfa');
    // O checkbox FICA marcado: é o `claude` falso que sobe, e é a sessão de
    // agente dele que a guarda julga (sessão de shell não é julgada).
    await expect(dialog.locator('.dialog-check input[type="checkbox"]')).toBeChecked();
    await dialog.locator('#task-name').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    interface StateView {
      sessions: {
        id: string;
        workspaceId: string;
        kind: string;
        agent?: string;
        /** O contador do selo 🛡 — a FONTE do que a linha desenha. */
        scopeBlocks?: { count: number; paths: string[] };
      }[];
      layout: { workspaces: { id: string; name: string; worktree?: { base: string; path: string } }[] };
    }
    const stateOf = (): Promise<StateView> => api<StateView>('/api/state');
    await expect
      .poll(async () => (await stateOf()).sessions.map((s) => `${s.kind}:${s.agent ?? '-'}`), {
        timeout: 90_000,
        intervals: [250],
      })
      .toEqual(['agent:claude']);
    const state = await stateOf();
    const alfa = state.layout.workspaces.find((w) => w.name === 'escopo-alfa');
    expect(alfa?.worktree?.path, `tarefa alfa sem worktree: ${JSON.stringify(state.layout.workspaces)}`).toBeTruthy();
    const alfaRoot = alfa!.worktree!.path;
    const sessionId = state.sessions[0]!.id;

    // A tarefa VIZINHA é um worktree irmão do MESMO repo — a dor descrita.
    // Ele nasce pelo `git` do teste: o que está sob prova é a cerca, e um
    // segundo workspace no Bridge não acrescentaria nada a ela.
    gitCli(repo, ['worktree', 'add', join('.worktrees', 'escopo-beta'), '-b', 'escopo-beta']);
    const alheio = join(repo, '.worktrees', 'escopo-beta', 'alheio.ts');
    writeFileSync(alheio, 'export const alheio = 1;\n', 'utf8');
    const proprio = join(alfaRoot, 'meu.ts');
    writeFileSync(proprio, 'export const meu = 2;\n', 'utf8');

    /** Um `PreToolUse` do jeito que o Claude Code o entrega: pelo shim, no stdin. */
    const preToolUse = (filePath: string): { status: number | null; stdout: string; stderr: string } => {
      const run = spawnSync(process.execPath, [HOOK_SHIM, sessionId!, 'PreToolUse'], {
        input: JSON.stringify({
          session_id: 'e2e-escopo',
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: filePath },
        }),
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, BRIDGE_PORT: String(inst.port), BRIDGE_TOKEN: inst.token },
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    };

    // Uma sessão de agente só, e ela está à vista. Desde a 0.12.2 TODO
    // workspace nasce expandido (o `.expanded`) e o ATIVO é o que leva o realce
    // (o `.active`) — aqui os dois coincidem, porque criar a tarefa a ativou.
    const alfaRow = win.locator('.workspace').filter({ has: win.locator('.workspace-name', { hasText: 'escopo-alfa' }) });
    await expect(alfaRow).toHaveClass(/expanded/, { timeout: 30_000 });
    await expect(alfaRow).toHaveClass(/active/, { timeout: 30_000 });
    // E o chevron da linha se anuncia como "aberto" pra quem não vê a tela.
    await expect(alfaRow.locator('.workspace-chevron')).toHaveAttribute('aria-expanded', 'true');
    // O rótulo NOMEIA o workspace: com vários na sidebar, "Recolher workspace"
    // repetido seria um controle indistinguível do vizinho no leitor de tela.
    await expect(alfaRow.locator('.workspace-chevron')).toHaveAttribute('aria-label', 'Recolher escopo-alfa');
    const sessionRow = alfaRow.locator('.session-row');
    await expect(sessionRow).toHaveCount(1, { timeout: 30_000 });
    await expect(sessionRow.locator('.session-label')).toHaveText('claude');

    // ------------------ 2. contraprova: DENTRO do worktree a guarda não opina
    // O corpo `{}` é a prova aqui. A ausência do selo NÃO é checada neste
    // ponto: nenhuma recusa aconteceu ainda, então `toHaveCount(0)` passaria
    // instantaneamente mesmo com a guarda quebrada. A contraprova do selo vem
    // no passo 4, depois de o selo existir.
    const dentro = preToolUse(proprio);
    expect(dentro.status, `shim falhou: ${dentro.stderr}`).toBe(0);
    expect(JSON.parse(dentro.stdout)).toEqual({});

    // ------------------------- 3. o arquivo da tarefa vizinha volta RECUSADO
    const fora = preToolUse(alheio);
    expect(fora.status, `shim falhou: ${fora.stderr}`).toBe(0);
    const reply = JSON.parse(fora.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    // A resposta é EXATAMENTE o deny: uma chave só. O shim ecoa o corpo
    // verbatim, e um `{ decision: 'block' }` legado junto seria uma segunda
    // decisão na mesma resposta (spec §7).
    expect(Object.keys(reply)).toEqual(['hookSpecificOutput']);
    expect(reply).not.toHaveProperty('decision');
    expect(Object.keys(reply.hookSpecificOutput).sort()).toEqual([
      'hookEventName',
      'permissionDecision',
      'permissionDecisionReason',
    ]);
    expect(reply.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = reply.hookSpecificOutput.permissionDecisionReason;
    expect(reason, `razão: ${reason}`).toContain('Bridge: fora do worktree desta tarefa');
    expect(reason).toContain('alheio.ts');
    expect(reason).toContain('escopo-alfa');
    // A frase nomeia o item de menu EXATO — quem a lê é o agente, e é ele quem
    // vai repeti-la pro dono.
    expect(reason).toContain('Libere em ⋯ → "Permitir acesso fora do worktree".');

    // ------------------------------------- 4. o selo 🛡 na linha da sessão
    const badge = sessionRow.locator('.session-badge.scope-blocked');
    await expect(badge).toHaveText('🛡 1', { timeout: 20_000 });
    const tooltip = await badge.getAttribute('title');
    expect(tooltip, `tooltip do selo: ${tooltip}`).toContain('A guarda de escopo barrou estes caminhos');
    expect(tooltip).toContain('alheio.ts');
    // A linha continua se anunciando pra quem não vê a tela (o selo é extra,
    // não substitui o rótulo).
    expect(await sessionRow.locator('.session-row-main').getAttribute('aria-label')).toContain('claude');

    // Contraprova DE VERDADE do selo: com `🛡 1` na tela, uma leitura de DENTRO
    // do worktree não pode virar `🛡 2`.
    //
    // Sem espera fixa: uma pausa de 1 s só afirma "não chegou em 1 s", e num
    // dia ruim isso vira um teste verde por lentidão. Quem responde é o próprio
    // core, e a pergunta é síncrona. O shim já voltou com `{}`, e o core trata
    // os hooks EM ORDEM — então, se aquela leitura tivesse contado, o
    // `GET /api/state` de agora já traria 2. É a mesma contagem que a linha
    // desenha (a UI a recebe pelo `/ws`), e o `toHaveText` abaixo confere o
    // desenho.
    const dentroDeNovo = preToolUse(proprio);
    expect(JSON.parse(dentroDeNovo.stdout)).toEqual({});
    const depoisDeDentro = (await stateOf()).sessions.find((s) => s.id === sessionId);
    expect(depoisDeDentro?.scopeBlocks?.count, `contador depois da leitura de dentro`).toBe(1);
    await expect(badge).toHaveText('🛡 1');

    // A raiz é o WORKTREE, não o repositório: um arquivo na raiz do repo
    // também está fora, e o contador soma. Este passo é o segundo sincronizador
    // da contraprova acima: ele entra na MESMA fila (core e `/ws`), então o
    // `🛡 2` na tela só pode ser o desta recusa — um incremento perdido da
    // leitura de dentro teria deixado o número em 3.
    const naRaiz = preToolUse(join(repo, 'leiame.md'));
    expect(JSON.parse(naRaiz.stdout)).toHaveProperty('hookSpecificOutput');
    expect((await stateOf()).sessions.find((s) => s.id === sessionId)?.scopeBlocks?.count).toBe(2);
    await expect(badge).toHaveText('🛡 2', { timeout: 20_000 });

    // ------------------- 5. "Permitir acesso fora do worktree" vale NA HORA
    await api(`/api/workspaces/${alfa!.id}`, { method: 'PATCH', body: { crossAccess: true } });
    const liberado = preToolUse(alheio);
    // O corpo `{}` é a prova de que a liberação valeu: o MESMO caminho que
    // acabou de ser recusado passa sem `hookSpecificOutput`.
    expect(JSON.parse(liberado.stdout)).toEqual({});
    // 0.12.2 — e o SELO SOME. Ele descreve uma cerca, e a cerca deixou de
    // existir neste workspace; o core zera o contador das sessões dele e a
    // linha volta ao normal, sem recarregar nada. A asserção tem como falhar:
    // ela vem depois de um `🛡 2` que estava na tela.
    //
    // O estado do core primeiro (`scopeBlocks` some da sessão), a tela depois:
    // a mesma disciplina da contraprova acima, e nenhuma espera fixa.
    expect((await stateOf()).sessions.find((s) => s.id === sessionId)?.scopeBlocks).toBeUndefined();
    await expect(badge).toHaveCount(0, { timeout: 20_000 });
    // A linha da sessão continua lá, inteira — o que sumiu foi o selo.
    await expect(sessionRow.locator('.session-label')).toHaveText('claude');

    // ------ 6. recolher o workspace no chevron esconde as sessões, não o anel
    const chevron = alfaRow.locator('.workspace-chevron');
    await chevron.click();
    await expect(alfaRow).not.toHaveClass(/expanded/, { timeout: 10_000 });
    await expect(alfaRow.locator('.session-row')).toHaveCount(0);
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(chevron).toHaveAttribute('aria-label', 'Expandir escopo-alfa');
    // Recolhido, a linha CONTINUA ativa (recolher não desativa) e o anel
    // agregado do workspace segue desenhado.
    await expect(alfaRow).toHaveClass(/active/);
    await expect(alfaRow.locator('.workspace-head-main > .ring')).toHaveCount(1);
    // E o chevron devolve as sessões.
    await chevron.click();
    await expect(alfaRow).toHaveClass(/expanded/, { timeout: 10_000 });
    await expect(alfaRow.locator('.session-row')).toHaveCount(1);

    // -------------------------------------- fechar → nada sobrevive ao app
    const pid = inst.pid;
    await app.close();
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Décimo cenário (0.11.0) — **a fila do escalonador de lançamentos** (dor
   * verificada #1).
   *
   * Subir vários agentes no mesmo segundo é a forma mais rápida de provocar o
   * limite do SERVIDOR ("Server is temporarily limiting requests"), que não
   * escala com o plano. O escalonador segura o excedente numa fila em vez de
   * lançar: `POST /api/sessions` responde **202** com a posição, a sidebar
   * mostra "1 sessão aguardando slot" e o botão **Lançar agora** é a válvula
   * de escape.
   *
   * O teto entra pelo `PATCH /api/config` — a mesma rota da tela de
   * Configurações → Sessões —, e não pelo `config.json` do perfil: assim o que
   * está sob prova inclui a configuração mudando com o core NO AR.
   */
  test('fila: com o teto em 1 agente, o segundo POST /api/sessions volta 202 e a sidebar mostra a fila com "Lançar agora"', async () => {
    test.setTimeout(240_000);

    queueProfileDir = tmp('bridge-e2e-fila-profile-');
    queueUserDataDir = tmp('bridge-e2e-fila-userdata-');
    queueWorkspaceDir = tmp('bridge-e2e-fila-ws-');
    queueBinDir = tmp('bridge-e2e-fila-bin-');
    writeFileSync(join(queueProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    makeFakeClaude(queueBinDir);

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      queueProfileDir,
      queueUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${queueUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...envWithBin(queueBinDir),
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: queueProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: queueWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(queueProfileDir, 20_000);

    /** Resposta CRUA: aqui o código HTTP é o que está sob prova (201 × 202). */
    const send = async (
      path: string,
      init: { method?: string; body?: unknown } = {},
    ): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${inst.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
    };
    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const res = await send(path, init);
      if (res.status >= 400) {
        throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body as T;
    };

    interface LauncherView {
      enabled: boolean;
      maxConcurrent: number;
      active: number;
      pending: { id: string; paneId: string; position: number }[];
    }
    interface StateView {
      sessions: { id: string; paneId: string; kind: string; agent?: string }[];
      layout: { panes: { id: string }[] };
    }
    /** O painel sem sessão nenhuma — o que o split acabou de abrir. */
    const emptyPane = async (): Promise<string> => {
      const state = await api<StateView>('/api/state');
      const busy = new Set(state.sessions.map((s) => s.paneId));
      const free = state.layout.panes.filter((p) => !busy.has(p.id));
      expect(free.length, `painéis livres: ${JSON.stringify(free)}`).toBe(1);
      return free[0]!.id;
    };

    // -------------------------------------------- 1. teto de 1 pelo PATCH
    const config = await api<{ sessions: { maxConcurrentAgents: number; scheduleLaunches: boolean } }>('/api/config', {
      method: 'PATCH',
      body: { sessions: { maxConcurrentAgents: 1 } },
    });
    expect(config.sessions.maxConcurrentAgents).toBe(1);
    expect(config.sessions.scheduleLaunches, 'o escalonador nasce ligado').toBe(true);

    // --------------- 2. o primeiro agente, pelo diálogo, passa direto (201)
    // Pelo diálogo e não por `POST /api/workspaces` + `POST /api/sessions`:
    // um workspace que aparece por fora da UI cai na RESTAURAÇÃO, que abre um
    // shell no painel vazio — e aí o teste disputaria o painel com ela.
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(queueWorkspaceDir);
    await expect(dialog.locator('.dialog-check input[type="checkbox"]')).toBeChecked();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(async () => (await api<StateView>('/api/state')).sessions.map((s) => `${s.kind}:${s.agent ?? '-'}`), {
        timeout: 90_000,
        intervals: [250],
      })
      .toEqual(['agent:claude']);

    // -------------------------- 3. o segundo, no painel de baixo, volta 202
    await win.keyboard.press('Control+Shift+D');
    await expect(win.locator('.tab-surface .pane')).toHaveCount(2);
    const pane2 = { id: await emptyPane() };
    const segundo = await send('/api/sessions', {
      method: 'POST',
      body: { paneId: pane2.id, kind: 'agent', agent: 'claude' },
    });
    expect(segundo.status, `segundo agente: ${JSON.stringify(segundo.body)}`).toBe(202);
    const fila = segundo.body as { queued: boolean; id: string; position: number; reason: string };
    expect(fila.queued).toBe(true);
    expect(fila.position).toBe(1);
    // `slots` é o único motivo que não passa sozinho com o tempo — é por isso
    // que existe o "Lançar agora".
    expect(fila.reason).toBe('slots');
    expect(fila.id, `id do lançamento: ${fila.id}`).toMatch(/^lnch_[0-9a-f]{12}$/);

    const status = await api<LauncherView>('/api/launcher');
    expect(status.maxConcurrent).toBe(1);
    expect(status.active).toBe(1);
    expect(status.pending.map((p) => p.paneId)).toEqual([pane2.id]);

    // ------------------------------------------- 4. a fila na sidebar
    await expect(win.locator('.sidebar-queue-text')).toHaveText('1 sessão aguardando slot', { timeout: 30_000 });
    const lancarAgora = win.locator('.sidebar-queue-action');
    await expect(lancarAgora).toHaveText('Lançar agora');
    const tooltip = await win.locator('.sidebar-queue').getAttribute('title');
    expect(tooltip, `tooltip da fila: ${tooltip}`).toContain('1 de 1 agentes de pé');

    // -------- 5. shell NUNCA é enfileirado, mesmo com o teto de agentes cheio
    // (o split é pela rota: o painel do 202 ainda não tem sessão, então o
    // `emptyPane` daqui em diante teria dois candidatos).
    const pane3 = await api<{ id: string }>(`/api/panes/${pane2.id}/split`, { method: 'POST', body: { dir: 'h' } });
    const shell = await send('/api/sessions', { method: 'POST', body: { paneId: pane3.id, kind: 'shell' } });
    expect(shell.status, `shell: ${JSON.stringify(shell.body)}`).toBe(201);

    // ------------ 6. "Lançar agora" esvazia a fila e a sessão nasce no painel
    await lancarAgora.click();
    await expect(win.locator('.sidebar-queue')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await api<LauncherView>('/api/launcher')).pending.length, { timeout: 30_000 }).toBe(0);
    await expect
      .poll(async () => (await api<StateView>('/api/state')).sessions.find((s) => s.paneId === pane2.id)?.kind ?? '', {
        timeout: 60_000,
        intervals: [250],
      })
      .toBe('agent');
    // Dois agentes e um shell: as três linhas na sidebar, e nenhuma pendência
    // deixada no perfil.
    await expect(win.locator('.session-row')).toHaveCount(3, { timeout: 30_000 });

    // -------------------------------------- fechar → nada sobrevive ao app
    const pid = inst.pid;
    await app.close();
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Décimo primeiro cenário (0.11.1) — **copiar e colar no terminal**.
   *
   * O bug que ele guarda: o xterm 5.5 transforma Ctrl+letra em byte de controle
   * e cancela o `keydown`, então Ctrl+V ia como `^V` pro PTY e a URL copiada
   * fora do Bridge nunca chegava. Nada disso aparece em teste de unidade — só
   * o Chromium de verdade diz se `preventDefault` + `navigator.clipboard` +
   * `term.paste` fecham a corrente.
   *
   * Este é o único teste do arquivo que mexe no clipboard DA MÁQUINA (é o que
   * está sendo testado): ao final o conteúdo do clipboard é o do teste, não o
   * que o usuário tinha antes.
   */
  test('clipboard: Ctrl+V cola no xterm, Ctrl+C com seleção copia e o botão direito faz os dois', async () => {
    const clipProfileDir = tmp('bridge-e2e-clip-profile-');
    const clipUserDataDir = tmp('bridge-e2e-clip-userdata-');
    const clipWorkspaceDir = tmp('bridge-e2e-clip-ws-');
    writeFileSync(join(clipProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      clipProfileDir,
      clipUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${clipUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: clipProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: clipWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(clipProfileDir, 20_000);

    /** O clipboard do SISTEMA, lido/escrito pelo processo main do Electron. */
    const writeClipboard = (text: string): Promise<void> =>
      app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
    const readClipboard = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText());

    // --------------------------------- 1. workspace + shell (o xterm da prova)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(clipWorkspaceDir);
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    await win.locator('.tab-surface .pane').first().click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row')).toHaveCount(1, { timeout: 30_000 });
    const screen = win.locator('.xterm-screen');
    await expect(screen).toHaveCount(1, { timeout: 30_000 });

    /** Todo o texto desenhado no terminal, com o nbsp do xterm virando espaço. */
    const screenText = (): Promise<string> =>
      win.evaluate(() => (document.querySelector('.xterm-rows')?.textContent ?? '').replace(/\u00a0/g, ' '));

    /** Quantos retângulos de seleção o renderer DOM está desenhando agora. */
    const selectionRects = (): Promise<number> =>
      win.evaluate(() => document.querySelectorAll('.xterm-selection div').length);
    /**
     * Clique triplo (= selecionar a linha) NA linha que contém `needle`. Clicar
     * no centro do `.xterm-screen` não serve: o prompt fica no alto e o meio da
     * área costuma ser linha vazia, que não geraria seleção nenhuma.
     */
    const selectLineWith = async (needle: string): Promise<void> => {
      const row = win.locator('.xterm-rows > div').filter({ hasText: needle }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click({ clickCount: 3 });
      await expect
        .poll(selectionRects, { timeout: 20_000, message: `clique triplo não selecionou a linha de ${needle}` })
        .toBeGreaterThan(0);
    };

    // ------------------------------------------ 2. Ctrl+V cola de verdade
    const COLADO = 'https://exemplo.test/colado?x=1';
    await writeClipboard(COLADO);
    await screen.click();
    // Contraprova: a URL não estava na tela ANTES da tecla.
    expect(await screenText()).not.toContain(COLADO);
    await win.keyboard.press('Control+V');
    await expect.poll(screenText, { timeout: 20_000, message: 'Ctrl+V não colou no xterm' }).toContain(COLADO);
    // E o byte de controle do xterm (`^V`, que era o bug) não foi ecoado.
    expect(await screenText()).not.toContain('^V');

    // ------------------- 3. Ctrl+C com seleção copia (e desmarca a seleção)
    await selectLineWith(COLADO);

    // Sentinela: sem isto, "o clipboard contém a URL" passaria só porque o
    // passo 2 deixou a URL lá.
    await writeClipboard('sentinela-sem-copia');
    await win.keyboard.press('Control+C');
    await expect
      .poll(readClipboard, { timeout: 20_000, message: 'Ctrl+C com seleção não copiou' })
      .toContain(COLADO);
    expect(await readClipboard()).not.toBe('sentinela-sem-copia');
    // A seleção some depois de copiar (convenção do Windows Terminal).
    await expect.poll(selectionRects, { timeout: 20_000, message: 'a seleção não foi limpa' }).toBe(0);

    // ------------------------------ 4. botão direito sem seleção = colar
    const SEGUNDO = 'https://exemplo.test/botao-direito?y=2';
    await writeClipboard(SEGUNDO);
    await screen.click({ button: 'right' });
    await expect
      .poll(screenText, { timeout: 20_000, message: 'botão direito não colou' })
      .toContain(SEGUNDO);

    // ---------------------- 5. botão direito COM seleção = copiar (e limpar)
    await selectLineWith(SEGUNDO);
    await writeClipboard('sentinela-sem-copia-2');
    await screen.click({ button: 'right' });
    await expect
      .poll(readClipboard, { timeout: 20_000, message: 'botão direito com seleção não copiou' })
      .toContain(SEGUNDO);
    await expect.poll(selectionRects, { timeout: 20_000, message: 'a seleção não foi limpa' }).toBe(0);

    // -------------------------------------- fechar → nada sobrevive ao app
    const corePid = inst.pid;
    expect(alive(corePid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Décimo segundo cenário (0.12.0) — **o Claude Code aberto DENTRO de um
   * shell**.
   *
   * A dor: a pessoa digita `claude` num painel de shell do Bridge e a sidebar
   * segue dizendo "shell" enquanto um agente inteiro trabalha ali dentro — sem
   * anel de estado, sem notificação, sem statusline, sem guarda de escopo.
   *
   * As duas metades, e as duas com o dado atravessando o app inteiro:
   *
   * 1. **O wrapper.** A sessão de shell nasce com um `claude.cmd` próprio em
   *    `<pasta da sessão>\bin`, na frente do `PATH` do PTY. O `claude
   *    --version` digitado no terminal (pelo WS, como qualquer tecla) tem que
   *    chegar ao alvo com o `--settings` da sessão acrescentado — e é o que o
   *    `claude` falso imprime de volta nas linhas do xterm.
   * 2. **A promoção.** Os hooks entram pela rota (`POST /hooks/<sid>/<Evento>`,
   *    autenticada por `?token=`, que é como o shim bate no core) e a linha da
   *    sidebar vira `claude`, com anel de estado de verdade; o `SessionEnd` de
   *    saída devolve o painel ao `shell` — **e o shell continua vivo**, que é a
   *    diferença entre hospedar e virar sessão de agente.
   *
   * O `claude` do PATH é um `.cmd` falso: o que está sob prova é o caminho do
   * dado (wrapper → argv → hooks → sidebar), não o binário do agente — e o
   * sétimo cenário já sobe um Claude Code de verdade.
   */
  test('claude no shell: o wrapper da sessão acrescenta o `--settings`, os hooks promovem a linha a `claude` e o SessionEnd devolve o shell vivo', async () => {
    test.setTimeout(240_000);

    const hostedProfileDir = tmp('bridge-e2e-hosp-profile-');
    const hostedUserDataDir = tmp('bridge-e2e-hosp-userdata-');
    const hostedWorkspaceDir = tmp('bridge-e2e-hosp-ws-');
    const fakeClaudeDir = tmp('bridge-e2e-hosp-bin-');
    writeFileSync(join(hostedProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    makeArgvClaude(fakeClaudeDir);

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      hostedProfileDir,
      hostedUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${hostedUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        // O `claude` falso no COMEÇO do PATH do core: é ele que o
        // `resolveHostedTarget()` acha (pelo `where.exe`) e que vira o alvo do
        // wrapper da sessão.
        ...envWithBin(fakeClaudeDir),
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: hostedProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: hostedWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(hostedProfileDir, 20_000);

    interface StateSession {
      id: string;
      kind: string;
      state: string;
      agent?: string;
      agentSessionId?: string;
      hosted?: { agent: string; since: number };
    }
    const sessionsOf = async (): Promise<StateSession[]> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/state`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
      return ((await res.json()) as { sessions: StateSession[] }).sessions;
    };
    /** Quantos agentes o core considera "de pé" — a hospedeira conta. */
    const launcherActive = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/launcher`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/launcher → ${res.status}`);
      return ((await res.json()) as { active: number }).active;
    };

    // ------------------------------- 1. workspace SEM agente + shell no painel
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(hostedWorkspaceDir);
    // Nada de sessão de agente: o painel desta prova é um SHELL do começo ao
    // fim (o `kind` nunca muda, nem depois da promoção).
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    await win.locator('.tab-surface .pane').first().click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => (await sessionsOf()).map((x) => x.kind), { timeout: 30_000 }).toEqual(['shell']);
    const sessionId = (await sessionsOf())[0]!.id;

    // Os arquivos da hospedagem existem no disco, na pasta DA SESSÃO.
    const sessionDir = join(hostedProfileDir, 'sessions', sessionId);
    expect(existsSync(join(sessionDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(sessionDir, 'bin', 'claude.cmd'))).toBe(true);

    // ============================ 2. o `claude` do shell passa pelo wrapper
    const screen = win.locator('.xterm-screen');
    await expect(screen).toHaveCount(1, { timeout: 30_000 });
    /**
     * Tudo o que está desenhado no terminal, sem espaço nenhum e em
     * minúsculas.
     *
     * Sem espaço porque o argv tem ~110 caracteres e QUEBRA em duas linhas do
     * xterm (cada linha é uma `div`, e o corte cai em qualquer coluna); em
     * minúsculas porque o `%~dp0` do wrapper devolve o caminho na
     * capitalização que o cmd.exe leu do disco, que não precisa bater com a do
     * `mkdtempSync`.
     */
    const squashed = async (): Promise<string> =>
      (await win.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? ''))
        .replace(/\s/g, '')
        .toLowerCase();

    // O `claude.cmd` da sessão cita o settings pelo `%~dp0` (o caminho do
    // PRÓPRIO wrapper), então o que chega ao alvo é `<sessão>\bin\..\settings.json`
    // — literal, sem o `..` resolvido. `join` normalizaria e a asserção
    // passaria a procurar outra string.
    const settingsArg = `${sessionDir}\\bin\\..\\settings.json`.replace(/\s/g, '').toLowerCase();

    await screen.click();
    // Contraprova: o caminho não estava na tela ANTES do comando.
    expect(await squashed()).not.toContain(settingsArg);

    await win.keyboard.type('claude --version');
    await win.keyboard.press('Enter');
    await expect
      .poll(squashed, {
        timeout: 60_000,
        intervals: [500],
        message: 'o `claude` digitado no shell não passou pelo wrapper da sessão',
      })
      .toContain(settingsArg);
    const argvSeen = await squashed();
    // O alvo recebeu o `--settings` do Bridge, e o argv original veio junto.
    expect(argvSeen, `linhas do xterm: ${argvSeen}`).toContain(ARGV_MARK);
    expect(argvSeen).toContain('--settings');
    expect(argvSeen).toContain('--version');

    // ================================= 3. o primeiro hook promove o painel
    const row = win.locator('[data-sidebar-row="session"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.session-label')).toHaveText('shell');
    await expect(row).not.toHaveAttribute('data-hosted', 'true');
    expect(await launcherActive()).toBe(0);

    /** Um hook como o shim manda: `?token=`, sem `Origin`, corpo JSON. */
    const hook = async (event: string, body: Record<string, unknown>): Promise<number> => {
      const res = await fetch(
        `http://127.0.0.1:${inst.port}/hooks/${sessionId}/${event}?token=${encodeURIComponent(inst.token)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      );
      return res.status;
    };
    const CONVERSA = 'conv-e2e-hospedada-0001';

    expect(await hook('SessionStart', { session_id: CONVERSA })).toBe(200);
    await expect(row.locator('.session-label')).toHaveText('claude', { timeout: 20_000 });
    await expect(row).toHaveAttribute('data-hosted', 'true');
    await expect(row).toHaveAttribute('title', 'Claude Code aberto dentro deste shell');
    // Parada e hospedando: o detalhe diz ONDE o Claude está, não o cwd.
    await expect(row.locator('.session-detail')).toHaveText('no shell');
    await expect(row.locator('.ring.idle')).toHaveCount(1);
    // O `kind` NUNCA muda — quem diz que há um agente ali é o `hosted`.
    const promovida = (await sessionsOf())[0]!;
    expect(promovida.kind).toBe('shell');
    expect(promovida.agent).toBeUndefined();
    expect(promovida.hosted?.agent).toBe('claude');
    expect(promovida.agentSessionId).toBe(CONVERSA);
    // A hospedeira OCUPA um slot do teto (mas nunca entra na fila).
    expect(await launcherActive()).toBe(1);

    expect(await hook('UserPromptSubmit', { session_id: CONVERSA })).toBe(200);
    await expect(row.locator('.ring.running')).toHaveCount(1, { timeout: 20_000 });
    await expect(row.locator('.session-detail')).toHaveText('pensando…');
    await expect(row.locator('.session-label')).toHaveText('claude');

    expect(await hook('Stop', { session_id: CONVERSA })).toBe(200);
    await expect(row.locator('.ring.done')).toHaveCount(1, { timeout: 20_000 });
    await expect(row.locator('.session-detail')).toHaveText('terminei');

    // ======================= 4. o SessionEnd devolve o shell — que não morreu
    expect(await hook('SessionEnd', { session_id: CONVERSA, reason: 'exit' })).toBe(200);
    await expect(row.locator('.session-label')).toHaveText('shell', { timeout: 20_000 });
    await expect(row).not.toHaveAttribute('data-hosted', 'true');
    await expect(row.locator('.ring.idle')).toHaveCount(1);
    await expect.poll(launcherActive, { timeout: 20_000 }).toBe(0);

    const depois = (await sessionsOf())[0]!;
    expect(depois.id).toBe(sessionId);
    expect(depois.kind).toBe('shell');
    expect(depois.hosted).toBeUndefined();
    expect(depois.state).not.toBe('exited');
    // A conversa fica guardada (o `POST /api/panes/:id/resume` a alcança).
    expect(depois.agentSessionId).toBe(CONVERSA);

    // E o PTY continua respondendo: o que acabou foi o Claude, não o shell.
    // O texto DIGITADO não contém o resultado (`vivo-$(21*2)` ≠ `vivo-42`),
    // então quem escreveu `vivo-42` na tela foi o pwsh.
    const VIVO = 'vivo-42';
    expect(await squashed()).not.toContain(VIVO);
    await screen.click();
    await win.keyboard.type('echo "vivo-$(21*2)"');
    await win.keyboard.press('Enter');
    await expect
      .poll(squashed, {
        timeout: 30_000,
        intervals: [500],
        message: 'o shell não respondeu ao echo depois do SessionEnd',
      })
      .toContain(VIVO);

    // -------------------------------------- fechar → nada sobrevive ao app
    const corePid = inst.pid;
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Décimo terceiro cenário (0.12.1) — **a restauração sobrevive a uma morte
   * NÃO limpa do app**.
   *
   * A dor, relatada pelo dono: ele reabriu o Bridge e o painel que tinha um
   * Claude Code voltou como shell. O motivo estava na marca de restauração: a
   * UI só retoma um painel com `lastEndedBy === 'app'`, e essa marca era
   * escrita SÓ no `stop()` do core, ou seja só num encerramento gracioso. O
   * instalador NSIS mata o app sem `WM_CLOSE`, e o desligamento do Windows
   * também: nesses casos o `stop()` nunca roda e o painel ficava sem marca
   * nenhuma.
   *
   * Este cenário reproduz a morte suja de propósito, com `taskkill /f` no
   * processo do Electron e depois na árvore do core — nada de `app.close()`,
   * nada de `POST /api/shutdown`. E prova as duas metades da correção:
   *
   * 1. **A marca é ANTECIPADA.** Antes de qualquer morte, a linha do painel no
   *    SQLite já tem `last_ended_by='app'` (lida aqui direto do banco, só
   *    leitura) — ela nasceu junto com o agente, não no encerramento.
   * 2. **A subida seguinte retoma.** O painel volta como sessão de AGENTE,
   *    com `--resume <id da conversa>` no argv do `claude` (o falso imprime o
   *    que recebeu) e a linha da sidebar dizendo `claude`.
   *
   * O `claude` é um `.cmd` falso: o que está sob prova é o caminho do dado
   * (marca → SQLite → restauração → argv), não o binário do agente — e o
   * sétimo cenário já sobe um Claude Code de verdade.
   */
  test('morte suja: core morto com taskkill /f e o painel de agente volta com --resume na subida seguinte', async () => {
    test.setTimeout(300_000);

    const mortoProfileDir = tmp('bridge-e2e-morte-profile-');
    const mortoUserDataDir = tmp('bridge-e2e-morte-userdata-');
    const mortoWorkspaceDir = tmp('bridge-e2e-morte-ws-');
    const mortoBinDir = tmp('bridge-e2e-morte-bin-');
    writeFileSync(join(mortoProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    makeResumeClaude(mortoBinDir);

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      mortoProfileDir,
      mortoUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    const launch = async (): Promise<void> => {
      app = await electron.launch({
        args: ['packages/shell', `--user-data-dir=${mortoUserDataDir}`],
        cwd: REPO_ROOT,
        env: {
          ...envWithBin(mortoBinDir),
          BRIDGE_DEV: '0',
          BRIDGE_PROFILE_DIR: mortoProfileDir,
          BRIDGE_UI_DIR: UI_DIR,
          BRIDGE_HEADLESS_ERRORS: '1',
          BRIDGE_TEST_FOLDER: mortoWorkspaceDir,
        },
        timeout: 60_000,
      });
      win = await app.firstWindow({ timeout: 60_000 });
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    };

    interface StateSession {
      id: string;
      paneId: string;
      kind: string;
      agent?: string;
      agentSessionId?: string;
    }
    interface StatePane {
      id: string;
      lastKind?: string;
      lastAgent?: string;
      lastAgentSessionId?: string;
      lastEndedBy?: string;
    }
    const stateOf = async (inst: Instance): Promise<{ sessions: StateSession[]; layout: { panes: StatePane[] } }> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/state`, {
        headers: { authorization: `Bearer ${inst.token}` },
      });
      if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
      return (await res.json()) as { sessions: StateSession[]; layout: { panes: StatePane[] } };
    };

    /**
     * A linha do painel COMO ELA ESTÁ NO DISCO. É de propósito que não seja o
     * `GET /api/state`: o que a restauração lê na subida seguinte é o SQLite,
     * e é justamente ele que a morte suja não deixava carimbado. Somente
     * leitura, com o core ainda de pé (o banco está em WAL).
     */
    interface PaneRow {
      last_kind: string | null;
      last_agent: string | null;
      last_agent_session_id: string | null;
      last_ended_by: string | null;
    }
    const paneRow = (paneId: string): PaneRow | undefined => {
      const db = new Database(join(mortoProfileDir, 'bridge.db'), { readonly: true });
      try {
        return db
          .prepare('SELECT last_kind, last_agent, last_agent_session_id, last_ended_by FROM panes WHERE id = ?')
          .get(paneId) as PaneRow | undefined;
      } finally {
        db.close();
      }
    };

    // ======================================================= 1ª subida
    await launch();
    const first = await waitForInstance(mortoProfileDir, 20_000);

    // Workspace COM o Claude Code: o checkbox do diálogo permanece marcado.
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(mortoWorkspaceDir);
    await expect(dialog.locator('.dialog-check input[type="checkbox"]')).toBeChecked();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    await expect
      .poll(async () => (await stateOf(first)).sessions.map((x) => `${x.kind}:${x.agent ?? '-'}`), {
        timeout: 90_000,
        intervals: [250],
      })
      .toEqual(['agent:claude']);
    const sessionId = (await stateOf(first)).sessions[0]!.id;
    const paneId = (await stateOf(first)).sessions[0]!.paneId;

    // O `session_id` da conversa entra pelo hook, como o shim faria (`?token=`,
    // sem `Origin`): o `.cmd` falso não roda o shim de verdade.
    const CONVERSA = 'conv-e2e-morte-suja-0001';
    const hook = await fetch(
      `http://127.0.0.1:${first.port}/hooks/${sessionId}/SessionStart?token=${encodeURIComponent(first.token)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: CONVERSA }) },
    );
    expect(hook.status).toBe(200);
    await expect
      .poll(async () => (await stateOf(first)).layout.panes.find((p) => p.id === paneId)?.lastAgentSessionId ?? '', {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(CONVERSA);

    // ---------------- a marca ANTECIPADA, no banco, ANTES de qualquer morte
    const antes = paneRow(paneId);
    expect(antes?.last_kind).toBe('agent');
    expect(antes?.last_agent).toBe('claude');
    expect(antes?.last_agent_session_id).toBe(CONVERSA);
    // O defeito da 0.12.0: aqui vinha NULL, e só o `stop()` de um encerramento
    // gracioso escreveria 'app'.
    expect(antes?.last_ended_by, 'o painel do agente não foi marcado no lançamento').toBe('app');

    // ================================ morte SUJA: nada de app.close()
    //
    // A ORDEM é a coisa importante aqui. O processo principal do Electron
    // morre PRIMEIRO, e sozinho: com o shell vivo, a queda do core dispararia
    // o restart de última chance do `sidecar.ts` (uma vez, dentro dos 30 s
    // iniciais) e um core NOVO subiria no lugar — apagando justamente a morte
    // que este cenário quer reproduzir.
    //
    // Depois vem todo o resto desta rodada, medido ANTES do primeiro golpe:
    // os processos filhos do Chromium e — o que o `/t` no pid do
    // `instance.json` não alcança — o invólucro do `tsx` que é PAI do core.
    // Matar só o de dentro deixaria o de fora vivo, que é o mesmo motivo pelo
    // qual o `stopCore()` prefere o pid do filho que ele lançou.
    const electronPid = app.process().pid!;
    const corePid = first.pid;
    const aMatar = [
      ...bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid)),
      ...ptyProcesses().filter((p) => !beforePty.has(p.pid)),
    ].map((p) => p.pid);
    spawnSync('taskkill', ['/pid', String(electronPid), '/f'], { windowsHide: true });
    await expect.poll(() => alive(electronPid), { timeout: 30_000 }).toBe(false);
    for (const pid of aMatar) {
      if (pid === electronPid) continue;
      // Já morto (filho que caiu junto) devolve código ≠ 0 e nada mais: é o
      // caso normal, não erro.
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    }
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    // A prova de que ninguém encerrou nada com jeito: o `instance.json` do
    // core morto ficou pra trás (num `app.close()` o `stop()` o apaga).
    expect(existsSync(join(mortoProfileDir, 'instance.json'))).toBe(true);
    // E o app inteiro sumiu — nenhum resto da primeira subida entra na segunda.
    await expect
      .poll(
        () => JSON.stringify(bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid)), null, 2),
        { timeout: 30_000, intervals: [250], message: 'sobrou processo da primeira subida' },
      )
      .toBe('[]');

    // ======================================================= 2ª subida
    await launch();
    /**
     * O core NOVO. O `instance.json` do morto continua no perfil (o shell o
     * descarta na subida), então esperar só "o arquivo existe" leria a porta
     * velha: a espera é por um pid diferente.
     */
    const second = await (async (): Promise<Instance> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const inst = await waitForInstance(mortoProfileDir, Math.max(1000, deadline - Date.now()));
        if (inst.pid !== corePid && alive(inst.pid)) return inst;
        if (Date.now() >= deadline) throw new Error('o core novo não reescreveu o instance.json');
        await new Promise((r) => setTimeout(r, 200));
      }
    })();

    // O painel voltou como AGENTE — não como shell, que era o defeito relatado.
    await expect
      .poll(async () => (await stateOf(second)).sessions.map((x) => `${x.kind}:${x.agent ?? '-'}`), {
        timeout: 90_000,
        intervals: [250],
      })
      .toEqual(['agent:claude']);
    const row = win.locator('[data-sidebar-row="session"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.session-label')).toHaveText('claude', { timeout: 30_000 });
    await expect(win.locator('.pane-hint')).toHaveCount(0);

    // E o `claude` restaurado recebeu a conversa: o falso imprime o argv, e o
    // texto do xterm vai sem espaço nenhum (o argv quebra em várias `div`).
    const squashed = async (): Promise<string> =>
      (await win.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? ''))
        .replace(/\s/g, '')
        .toLowerCase();
    await expect
      .poll(squashed, {
        timeout: 60_000,
        intervals: [500],
        message: 'o claude restaurado não subiu com --resume',
      })
      .toContain(`--resume${CONVERSA}`);
    const argvSeen = await squashed();
    expect(argvSeen, `linhas do xterm: ${argvSeen}`).toContain(ARGV_MARK);
    expect(argvSeen).toContain('--settings');

    // -------------------------------------- fechar → nada sobrevive ao app
    const secondPid = second.pid;
    await app.close();
    await expect.poll(() => alive(secondPid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });

  /**
   * Décimo quarto cenário (0.13.0) — **o idioma trocando ao vivo**.
   *
   * A spec §13 promete três coisas que só o app de verdade prova juntas: o
   * default `system` resolvido pela locale da MÁQUINA (esta é pt-BR), a troca
   * valendo **sem reabrir a janela**, e o idioma sendo UM só — a mesma escolha
   * valendo pro renderer, pro texto que o CORE escreve e pra CLI que fala com
   * esse core de fora.
   *
   * O roteiro anda em três tempos:
   *
   * 1. **pt-BR sem configurar nada.** `config.json` sem `ui.language` → o GET
   *    devolve `system` com `languageResolved: 'pt-BR'`; as superfícies em
   *    português e o `bridge list` com o cabeçalho `estado`/`há`.
   * 2. **`PATCH /api/config { ui: { language: 'en' } }`** — a MESMA rota que o
   *    seletor de Configurações → Aparência usa — e, **sem reabrir nada**, as
   *    cinco superfícies em inglês: rodapé e menu da sidebar, os botões do
   *    painel vazio, o menu "⋯" do workspace, Configurações → Aparência com
   *    `English` selecionado, e uma `Notification` injetada por hook que chega
   *    escrita pelo CORE como `Waiting for you`. Mais o `bridge list` com
   *    `state`/`age`.
   * 3. **De volta pro `pt-BR`**, com os textos restaurados.
   *
   * Duas armadilhas de sincronização, as duas do report da Task 4:
   *
   * - **A janela do idioma na subida.** Entre o primeiro frame e a resposta do
   *   `GET /api/config` o renderer usa o `navigator.language` (e o main, o
   *   `app.getLocale()`). Ler a tela no primeiro frame afirmaria o idioma da
   *   MÁQUINA, não o da configuração — por isso toda leitura aqui é
   *   `expect`/`expect.poll` com timeout, e não um `textContent` seco.
   * - **A resposta do `PATCH` não é o que muda a tela.** Quem troca o idioma do
   *   renderer é o `config.changed` do `/ws`, que chega DEPOIS do 200. Esperar
   *   pelo texto (e não pelo status) é o que faz este cenário não passar por
   *   sorte de escalonamento.
   *
   * O `claude` NÃO precisa existir: a promoção da sessão de shell a hospedeira
   * é feita pelo próprio hook (0.12.0), que é justamente o caminho mais curto
   * pra pôr um texto escrito pelo core na tela sem subir agente nenhum.
   */
  test('idioma: sobe em pt-BR pela locale da máquina e o PATCH pra `en` troca cinco superfícies, a notificação do core e a CLI sem reabrir', async () => {
    test.setTimeout(240_000);

    langProfileDir = tmp('bridge-e2e-idioma-profile-');
    langUserDataDir = tmp('bridge-e2e-idioma-userdata-');
    langWorkspaceDir = tmp('bridge-e2e-idioma-ws-');
    // `ui.language` AUSENTE de propósito: o default do produto é `system`, e é
    // o caminho de quem instala o Bridge e não configura nada.
    writeFileSync(join(langProfileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const needles = [
      'packages\\core',
      'packages/core',
      'packages\\shell',
      'packages/shell',
      langProfileDir,
      langUserDataDir,
    ];
    const before = bridgeProcesses(needles);
    const beforePty = new Set(ptyProcesses().map((p) => p.pid));

    app = await electron.launch({
      args: ['packages/shell', `--user-data-dir=${langUserDataDir}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DEV: '0',
        BRIDGE_PROFILE_DIR: langProfileDir,
        BRIDGE_UI_DIR: UI_DIR,
        BRIDGE_HEADLESS_ERRORS: '1',
        BRIDGE_TEST_FOLDER: langWorkspaceDir,
      },
      timeout: 60_000,
    });

    win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.status-strip')).toBeVisible({ timeout: 30_000 });
    const inst = await waitForInstance(langProfileDir, 20_000);

    const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${inst.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    };

    /**
     * A CLI como quem digita `bridge` num terminal: o BUNDLE de verdade, num
     * processo Node separado, sem `BRIDGE_PORT`/`BRIDGE_TOKEN` (a descoberta
     * sai do `instance.json` do perfil). O `extra` é o que este cenário usa
     * pra provar a PRECEDÊNCIA do idioma: o core ganha do `BRIDGE_LANG`.
     */
    const bridgeCli = (args: string[], extra: NodeJS.ProcessEnv = {}): { status: number; stdout: string } => {
      const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_PROFILE_DIR: langProfileDir, ...extra };
      delete env.BRIDGE_PORT;
      delete env.BRIDGE_TOKEN;
      delete env.BRIDGE_SESSION;
      if (extra.BRIDGE_LANG === undefined) delete env.BRIDGE_LANG;
      const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        env,
        timeout: 30_000,
      });
      return { status: res.status ?? -1, stdout: res.stdout ?? '' };
    };

    interface ConfigView {
      ui: { language: string };
      languageResolved: string;
    }

    // ================== 1. o default: `system` resolvido pela locale da máquina
    const inicial = await api<ConfigView>('/api/config');
    expect(inicial.ui.language).toBe('system');
    // Esta máquina é pt-BR (`Intl.DateTimeFormat().resolvedOptions().locale`).
    // Se um dia ela não for, o cenário falha AQUI, dizendo o motivo — e não
    // dez asserções adiante, com "esperava Nova tarefa".
    expect(inicial.languageResolved, 'a máquina que roda o e2e precisa estar em pt-BR').toBe('pt-BR');

    /**
     * Daqui pra baixo o idioma é FIXADO, e o cenário deixa de depender da
     * máquina. As duas asserções acima são as únicas presas à locale de quem
     * roda a suíte, e elas falham com mensagem própria; o corpo do cenário
     * afirma TEXTO EXATO ("Nova tarefa", "Abrir shell"), e texto exato não pode
     * depender de qual locale o Windows de quem clonou o repo está usando.
     */
    const fixado = await api<ConfigView>('/api/config', { method: 'PATCH', body: { ui: { language: 'pt-BR' } } });
    expect(fixado.ui.language).toBe('pt-BR');
    expect(fixado.languageResolved).toBe('pt-BR');

    // ------------------------------- workspace + shell (o dono do `bridge list`)
    await win.keyboard.press('Control+Shift+N');
    const dialog = win.locator('.dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Escolher…' }).click();
    await expect(dialog.locator('#ws-cwd')).toHaveValue(langWorkspaceDir);
    // Sem isto o diálogo subiria um Claude Code de verdade na conta do usuário.
    await dialog.locator('.dialog-check input[type="checkbox"]').uncheck();
    await dialog.locator('#ws-cwd').click();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    await win.locator('.tab-surface .pane').first().click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row')).toHaveCount(1, { timeout: 30_000 });
    // O split dá o painel VAZIO que a dica de atalho precisa: com sessão, o
    // corpo do painel é o xterm e a `.pane-hint` não existe.
    await win.keyboard.press('Control+Shift+D');
    await expect(win.locator('.tab-surface .pane')).toHaveCount(2);
    await expect(win.locator('.pane-hint')).toHaveCount(1);

    const footer = win.locator('.sidebar-footer button');
    const hint = win.locator('.pane-hint button');

    /** Os textos do menu "⋯" do workspace, com o menu aberto e fechado aqui. */
    const menuTexts = async (): Promise<string[]> => {
      const head = win.locator('.workspace-head').first();
      await head.hover();
      await head.locator('.workspace-menu-button').click();
      const list = win.locator('.workspace-menu-list');
      await expect(list).toBeVisible({ timeout: 10_000 });
      // `allTextContents` só depois do `toBeVisible`: o popover mede a si
      // mesmo antes de se posicionar, e ler no frame anterior pegaria a lista
      // ainda invisível.
      const texts = await list.locator('button').allTextContents();
      await win.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      return texts;
    };

    /**
     * Os itens do menu "☰" do cabeçalho da sidebar. Só os CINCO últimos: o
     * "Ativar avisos" existe só quando a permissão de notificação ainda não
     * foi dada, e afirmar sobre ele seria afirmar sobre o estado do Windows.
     * (Eram quatro até a 0.13.0; o "Gravar" da 0.14.0 entrou entre "Uso…" e
     * "Configurações…".)
     */
    const headerMenuTail = async (): Promise<string[]> => {
      const menu = win.locator('.header-menu');
      await menu.locator('.icon-button').click();
      const list = win.locator('.header-menu-list');
      await expect(list).toBeVisible({ timeout: 10_000 });
      const texts = await list.locator('button').allTextContents();
      await win.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      return texts.slice(-5);
    };

    /** O seletor de Configurações → Aparência, aberto e fechado aqui. */
    const appearance = async (
      section: string,
    ): Promise<{ options: string[]; selected: string; value: string; label: string }> => {
      await win.keyboard.press('Control+,');
      const settings = win.locator('.settings-dialog');
      await expect(settings).toBeVisible({ timeout: 20_000 });
      await settings.locator('.settings-nav-item', { hasText: section }).click();
      await expect(settings.locator('.settings-nav-item.active')).toHaveText(section);
      const select = settings.locator('#set-language');
      await expect(select).toBeVisible();
      // `textContent` e não `innerText`: um `<option>` de `select` fechado não
      // é renderizado, e `innerText` depende de layout — voltaria vazio.
      const out = {
        options: await select.locator('option').allTextContents(),
        selected: (await select.locator('option:checked').textContent()) ?? '',
        value: await select.inputValue(),
        label: (await settings.locator('label[for="set-language"]').textContent()) ?? '',
      };
      await win.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      return out;
    };

    // -------------------------------------------- as superfícies em português
    await expect(footer).toHaveText(['Nova tarefa', 'Workspace']);
    await expect(footer.nth(0)).toHaveAttribute('title', 'Nova tarefa (Ctrl+Shift+Alt+N)');
    await expect(footer.nth(1)).toHaveAttribute('title', 'Novo workspace (Ctrl+Shift+N)');
    await expect(hint).toHaveText(['Abrir shell', 'Abrir Claude Code', 'Fechar painel']);
    await expect(hint.nth(0)).toHaveAttribute('title', 'Abrir um shell neste painel (Enter)');
    expect(await headerMenuTail()).toEqual([
      'Marcar todas como lidas',
      'Alternar sidebar',
      'Uso…',
      'Gravar',
      'Configurações…',
    ]);

    const menuPt = await menuTexts();
    // O começo da lista é a lista de ambientes DETECTADOS nesta máquina (o
    // Git Bash pode estar ou não instalado): o que se afirma é o rótulo que o
    // catálogo escreve, não quantos ambientes existem.
    expect(menuPt.every((item) => !item.startsWith('Environment: '))).toBe(true);
    expect(menuPt.some((item) => item.startsWith('Ambiente: '))).toBe(true);
    // O fim da lista é fixo. O item da guarda de escopo é o que precisa casar
    // com a razão do `deny` que o core manda pro agente (`core.escopo.menu.*`)
    // — num workspace de pasta a cerca é o REPOSITÓRIO.
    expect(menuPt.slice(-3)).toEqual([
      'Permitir acesso fora do repositório',
      'Abrir no Explorer',
      'Fechar workspace',
    ]);

    const aparencia = await appearance('Aparência');
    expect(aparencia.label).toBe('Idioma');
    // `pt-BR`, e não `system`: o PATCH do começo fixou a escolha. Que o
    // `system` NASCE como default e resolve pra pt-BR nesta máquina já está
    // provado lá em cima, contra o `GET /api/config`.
    expect(aparencia.value).toBe('pt-BR');
    expect(aparencia.selected).toBe('Português (Brasil)');
    // Os dois NOMES de idioma ficam na própria língua nos dois catálogos: quem
    // procura inglês procura "English", inclusive numa tela em português.
    expect(aparencia.options).toEqual(['Português (Brasil)', 'English', 'Do sistema']);

    const listaPt = bridgeCli(['list']);
    expect(listaPt.status, `bridge list falhou: ${listaPt.stdout}`).toBe(0);
    /**
     * O cabeçalho é a PRIMEIRA linha, e é sobre ela que se afirma. Contra a
     * saída inteira, um `toContain('estado')` também passaria com o cabeçalho
     * em inglês e a palavra vindo do `detail` de alguma sessão.
     */
    const cabecalhoPt = listaPt.stdout.split('\n')[0] ?? '';
    expect(cabecalhoPt, listaPt.stdout).toContain('estado');
    expect(cabecalhoPt, listaPt.stdout).toContain('há');
    expect(cabecalhoPt, listaPt.stdout).not.toContain('state');

    // ======================= 2. o PATCH pra `en` — a rota do seletor da tela
    const patched = await api<ConfigView>('/api/config', { method: 'PATCH', body: { ui: { language: 'en' } } });
    expect(patched.ui.language).toBe('en');
    expect(patched.languageResolved).toBe('en');

    // --------- superfície 1: o rodapé e o menu "☰" da sidebar, sem reabrir nada
    // O `toHaveText` espera: quem troca o idioma da janela é o `config.changed`
    // do `/ws`, que chega depois do 200 acima.
    await expect(footer).toHaveText(['New task', 'Workspace'], { timeout: 20_000 });
    await expect(footer.nth(0)).toHaveAttribute('title', 'New task (Ctrl+Shift+Alt+N)');
    await expect(footer.nth(1)).toHaveAttribute('title', 'New workspace (Ctrl+Shift+N)');
    expect(await headerMenuTail()).toEqual([
      'Mark all as read',
      'Toggle sidebar',
      'Usage…',
      'Record',
      'Settings…',
    ]);

    // ------------------------- superfície 2: os botões do painel vazio
    await expect(hint).toHaveText(['Open shell', 'Open Claude Code', 'Close pane'], { timeout: 20_000 });
    await expect(hint.nth(0)).toHaveAttribute('title', 'Open a shell in this pane (Enter)');
    await expect(hint.nth(1)).toHaveAttribute('title', 'Start Claude Code in this pane (Ctrl+Shift+C)');
    await expect(hint.nth(2)).toHaveAttribute('title', 'Close this pane (Ctrl+Shift+X)');

    // ---------------------- superfície 3: o menu "⋯" do workspace
    const menuEn = await menuTexts();
    expect(menuEn).toHaveLength(menuPt.length);
    expect(menuEn.some((item) => item.startsWith('Environment: '))).toBe(true);
    expect(menuEn.slice(-3)).toEqual([
      'Allow access outside the repository',
      'Open in Explorer',
      'Close workspace',
    ]);

    // ------------- superfície 4: Configurações → Aparência com `English` marcado
    const appearanceEn = await appearance('Appearance');
    expect(appearanceEn.label).toBe('Language');
    expect(appearanceEn.value).toBe('en');
    expect(appearanceEn.selected).toBe('English');
    expect(appearanceEn.options).toEqual(['Português (Brasil)', 'English', 'System']);

    // ------- superfície 5: uma `Notification` de hook, escrita PELO CORE em inglês
    const state = await api<{ sessions: { id: string; kind: string }[] }>('/api/state');
    const shellSession = state.sessions.find((s) => s.kind === 'shell');
    expect(shellSession, 'o core devia ter uma sessão de shell').toBeTruthy();
    const sessionId = shellSession!.id;

    /** Um hook como o shim manda: `?token=`, sem `Origin`, corpo JSON. */
    const hookRes = await fetch(
      `http://127.0.0.1:${inst.port}/hooks/${sessionId}/Notification?token=${encodeURIComponent(inst.token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sem `message`: é a forma que faz o CORE escrever a frase (com
        // `message`, o texto é do agente e sai como veio, em qualquer idioma).
        body: JSON.stringify({ session_id: 'e2e-idioma', hook_event_name: 'Notification' }),
      },
    );
    expect(hookRes.status).toBe(200);

    // Na sidebar: o anel da sessão passou a "esperando você" — em inglês, e em
    // minúsculas (é rótulo de estado, não frase).
    await expect(win.locator('.session-row .ring.needs-input')).toHaveAttribute('title', 'waiting for you', {
      timeout: 20_000,
    });
    // E no painel de notificações (Ctrl+Shift+I), o texto que o core escreveu.
    await win.keyboard.press('Control+Shift+I');
    const panel = win.locator('.notifications-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator('.notifications-title')).toHaveText('Notifications');
    await expect(panel.locator('.notification-text').first()).toHaveText('Waiting for you', { timeout: 20_000 });
    await win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // --------------------------------- a CLI, contra o MESMO core, em inglês
    const listaEn = bridgeCli(['list']);
    expect(listaEn.status, `bridge list falhou: ${listaEn.stdout}`).toBe(0);
    const cabecalhoEn = listaEn.stdout.split('\n')[0] ?? '';
    expect(cabecalhoEn, listaEn.stdout).toContain('state');
    expect(cabecalhoEn, listaEn.stdout).toContain('age');
    expect(cabecalhoEn, listaEn.stdout).not.toContain('estado');
    // O `detail` da linha não é da CLI: é o texto que o CORE gravou na sessão
    // quando o hook chegou. Ele viaja traduzido e a CLI não o retraduz.
    expect(listaEn.stdout).toContain('waiting for permission');

    // Contraprova da PRECEDÊNCIA (spec §13): o `languageResolved` do core ganha
    // do `BRIDGE_LANG` do ambiente — senão dois terminais da mesma máquina
    // falariam idiomas diferentes com o mesmo Bridge.
    const listaForcada = bridgeCli(['list'], { BRIDGE_LANG: 'pt-BR' });
    const cabecalhoForcado = listaForcada.stdout.split('\n')[0] ?? '';
    expect(cabecalhoForcado, listaForcada.stdout).toContain('state');
    expect(cabecalhoForcado, listaForcada.stdout).not.toContain('estado');

    // ================================= 3. de volta pro pt-BR, sem reabrir nada
    const devolta = await api<ConfigView>('/api/config', { method: 'PATCH', body: { ui: { language: 'pt-BR' } } });
    expect(devolta.languageResolved).toBe('pt-BR');
    await expect(footer).toHaveText(['Nova tarefa', 'Workspace'], { timeout: 20_000 });
    await expect(hint).toHaveText(['Abrir shell', 'Abrir Claude Code', 'Fechar painel'], { timeout: 20_000 });
    // Com prazo, como a asserção gêmea em inglês: o título só muda quando o
    // `config.changed` do `/ws` chega, e ele vem DEPOIS do 200 do PATCH.
    await expect(win.locator('.session-row .ring.needs-input')).toHaveAttribute('title', 'esperando você', {
      timeout: 20_000,
    });
    expect((await menuTexts()).slice(-3)).toEqual([
      'Permitir acesso fora do repositório',
      'Abrir no Explorer',
      'Fechar workspace',
    ]);
    const listaVolta = bridgeCli(['list']);
    expect(listaVolta.stdout.split('\n')[0] ?? '', listaVolta.stdout).toContain('estado');
    // A NOTIFICAÇÃO não volta: ela é um registro do que aconteceu, escrito no
    // idioma daquele instante e guardado no banco. Retraduzi-la seria reescrever
    // o histórico — e o `n.text` pode ter vindo do agente, que não tem chave.
    await win.keyboard.press('Control+Shift+I');
    await expect(panel.locator('.notification-text').first()).toHaveText('Waiting for you', { timeout: 20_000 });
    await win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // -------------------------------------- fechar → nada sobrevive ao app
    const corePid = inst.pid;
    expect(alive(corePid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(corePid), { timeout: 30_000 }).toBe(false);
    const leftovers = bridgeProcesses(needles).filter((p) => !before.some((b) => b.pid === p.pid));
    expect(leftovers, `processos órfãos: ${JSON.stringify(leftovers, null, 2)}`).toEqual([]);
    const ptyLeft = ptyProcesses().filter((p) => !beforePty.has(p.pid));
    expect(ptyLeft, `PTYs órfãos: ${JSON.stringify(ptyLeft, null, 2)}`).toEqual([]);
  });
});
