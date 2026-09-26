import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { BridgeEvent, HelloState, Language } from '@bridge/shared';
import { CoreEventsClient } from './coreEvents.js';
import { IPC } from './ipc.js';
import type { FocusSessionPayload } from './ipc.js';
import { bootLanguage, languageFromConfig, readCoreLanguage, setShellLanguage, shellLanguage, tShell } from './language.js';
import { loginItemArgs, loginItemSupport, parseLoginItemInput, readLoginItem, shouldStartHidden } from './loginItem.js';
import type { LoginItemState } from './loginItem.js';
import { isFromUi, resolveUiUrl } from './resolveUi.js';
import {
  appendShellLog,
  currentInstance,
  defaultLogPath,
  resolveCoreLaunch,
  resolveRepoRoot,
  startCore,
  stopCore,
} from './sidecar.js';
import type { CoreExit, Instance } from './sidecar.js';
import { BEFORE_QUIT_LOG, createShutdownGate, SESSION_END_LOG } from './shutdown.js';
import { CoreStartError } from './sidecar.js';
import { coalesce, emptyToastQueue, shouldToast, trackToast, truncateToastText, unreadAfter } from './toast.js';
import type { ToastPayload, ToastQueue } from './toast.js';
import { createTray } from './tray.js';
import type { TrayHandles } from './tray.js';
import { isOpenablePath, menuPolicy } from './windowPolicy.js';

const APP_ID = 'com.erickdantas.bridge';
const dev = process.env.BRIDGE_DEV === '1';
/** `BRIDGE_DEBUG=1` liga o log de diagnóstico por evento (`debug()`). */
const debugLog = process.env.BRIDGE_DEBUG === '1';
const repoRoot = resolveRepoRoot(dirname(fileURLToPath(import.meta.url)));
/**
 * Onde estão o core e a UI. Empacotado (Task 10) os dois vêm de
 * `process.resourcesPath`, fora do asar; em dev, do checkout. Ver
 * `resolveCoreLaunch`.
 */
const launch = resolveCoreLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot,
});
/**
 * Ícone da janela em dev: o Electron do `node_modules` não tem o `BridgeMark`
 * embutido, então sem isto a janela sai com o ícone padrão do Electron. No
 * app empacotado o `.exe` já sai com esse ícone (`electron-builder.yml`
 * `win.icon`, gerado por `scripts/make-icon.mjs`), então o Windows usa o
 * ícone do próprio binário — não precisa repetir aqui.
 */
const windowIcon = app.isPackaged ? undefined : join(repoRoot, 'packages', 'shell', 'build', 'icon.ico');
const profileDir = process.env.BRIDGE_PROFILE_DIR ?? join(process.env.APPDATA ?? '', 'bridge');
const uiDir = process.env.BRIDGE_UI_DIR ?? launch.uiDir;
const logPath = defaultLogPath(profileDir);
/** Task 10 (e2e): grava cada toast em JSONL em vez de mostrar `Notification` de verdade. */
const toastLogPath = process.env.BRIDGE_TOAST_LOG;
/** Task 10 (e2e): sem diálogo modal — só uma linha de log, pra rodar sem display interativo. */
const headlessErrors = process.env.BRIDGE_HEADLESS_ERRORS === '1';
/**
 * Task 10 (e2e): pasta que `bridge:pickFolder` devolve SEM abrir o diálogo
 * nativo. O `showOpenDialog` é uma janela do sistema operacional — o Playwright
 * dirige o renderer, não o shell do Windows, então sem isto o e2e travaria no
 * modal pra sempre. Só vale com a env definida; em uso normal (`undefined`) o
 * caminho é o diálogo de verdade, intocado.
 *
 * No app EMPACOTADO a env é ignorada de propósito: é atalho de teste, e num
 * app instalado ela viraria uma variável de ambiente qualquer capaz de mudar
 * o que o "Escolher pasta…" devolve pro usuário.
 */
const testFolder = app.isPackaged ? undefined : process.env.BRIDGE_TEST_FOLDER;
/**
 * Fase 5: o Windows abriu o Bridge pela entrada de início automático com
 * `--hidden`. A janela nasce com `show: false` e só aparece pelo clique na
 * bandeja, no toast, ou por uma segunda instância — os três caminhos que já
 * chamavam `win.show()`.
 */
const startHidden = shouldStartHidden(process.argv);
/**
 * Dá pra escrever no `Run` do registro? Só no app empacotado (ver
 * `loginItem.ts`). É FUNÇÃO, e não constante de módulo, porque o `app.isPackaged`
 * só é confiável depois do `ready` — e porque ela devolve uma CHAVE de status
 * que a UI traduz, então não há nada a ganhar avaliando isto na importação.
 */
function loginItemSupportNow(): { supported: boolean; status: ReturnType<typeof loginItemSupport>['status'] } {
  return loginItemSupport({ platform: process.platform, packaged: app.isPackaged });
}

// Sem GPU nesta máquina: com aceleração ligada o Chromium cai no SwiftShader e
// gasta CPU à toa. Tem que ser antes do `ready`.
app.disableHardwareAcceleration();
// BR-17: sandbox GLOBAL, não só o `sandbox: true` por janela/view. Os dois
// pontos que criam renderer já declaram o flag; isto torna a regra à prova de
// esquecimento na próxima janela que alguém adicionar. Tem que vir antes do
// `whenReady`.
app.enableSandbox();
app.setAppUserModelId(APP_ID);
// Sem isso o Electron tira o nome de `@bridge/shell` e cria
// `%APPDATA%\@bridge\shell` pro userData — pasta de lixo com nome de pacote.
app.setName('Bridge');

let win: BrowserWindow | null = null;
let instance: Instance | null = null;
/** Origem canônica da UI (`new URL(...).origin`); vazia até o core subir. */
let uiOrigin = '';
/**
 * O app está saindo de propósito. Serve pro `onCoreExit` não gritar "o core
 * caiu" quando quem o derrubou fomos nós. Desde a 0.12.1 ele também é ligado
 * pelo `before-quit`/`session-end`, não só pelo `will-quit`.
 */
let quitting = false;
/** Trava de reentrada do `will-quit` (o `app.quit()` do fim dispara ele de novo). */
let willQuitHandled = false;
let fatalShown = false;
let tray: TrayHandles | null = null;

/** Fila de toasts pendentes (Task 8) — janela de 2 s por sessão, ver `toast.ts`. */
let toastQueue: ToastQueue = emptyToastQueue();
/**
 * Um timer por sessão com toast pendente, com o `dueAt` que ele serve (ver
 * `scheduleToastFlush`); cancelado/disparado cedo no `hello`.
 */
const flushTimers = new Map<string, { timer: NodeJS.Timeout; dueAt: number }>();
/**
 * Contagem de não lidas — fonte ÚNICA que `presentUnread` aplica e atualiza.
 * Duas coisas escrevem nela: o `hello`/eventos da conexão direta do main com
 * o core (`coreEvents`, autoritativa — é o mesmo `state.unread` do banco) e o
 * IPC `setBadge` que a UI manda (calculado pelo reducer dela a partir da
 * PRÓPRIA conexão WS). As duas deveriam sempre concordar, mas se uma escrever
 * sem passar pela outra, a aritmética incremental (`unreadAfter`) da próxima
 * vez tem que partir do valor mais recente — não de uma cópia desatualizada —
 * senão o número oscila entre as duas fontes. Por isso as duas SEMPRE passam
 * por `presentUnread`, que é quem grava aqui.
 */
let unreadCount = 0;


function log(line: string): void {
  appendShellLog(logPath, line);
}

/** Log de diagnóstico — só com `BRIDGE_DEBUG=1`. Nada por evento em uso normal. */
function debug(line: string): void {
  if (debugLog) appendShellLog(logPath, line);
}

/** `dialog.showErrorBox` normal, exceto em `BRIDGE_HEADLESS_ERRORS=1` (Task 10, e2e sem display). */
function showErrorBox(title: string, message: string): void {
  if (headlessErrors) {
    log(`[shell] erro (headless): ${title}: ${message}`);
    return;
  }
  dialog.showErrorBox(title, message);
}

/**
 * Único lugar que aplica a contagem de não lidas visualmente — E que grava
 * `unreadCount` (ver comentário na declaração dela). Chame esta função em vez
 * de mexer no título/tooltip direto, dos dois lados (coreEvents e IPC).
 */
function presentUnread(n: number, opts: { force?: boolean } = {}): void {
  // Nada mudou (o caso comum: TODO evento do core passa por aqui) — nem
  // `setTitle`, nem bandeja, nem log. Era o trabalho por evento do F1.
  //
  // `force` fura essa guarda porque existe um caso em que o valor é o mesmo
  // mas o que está na tela NÃO é: depois de um reload do renderer o `<title>`
  // da página sobrescreve o título da janela, e o "(n)" some sem o contador
  // ter mudado. Ver o `did-finish-load` em `createWindow`.
  if (n === unreadCount && opts.force !== true) return;
  unreadCount = n;
  const title = n > 0 ? `Bridge (${n})` : 'Bridge';
  win?.setTitle(title);
  tray?.setUnread(n);
  // Sem inspetor de janela no smoke/e2e headless (Task 10): a única forma de
  // confirmar o título de fora é ler esta linha do shell.log — por isso ela
  // fica atrás do `BRIDGE_DEBUG=1`, não no caminho normal.
  debug(`[shell] título → "${title}" (${n} não lidas)`);
}

/**
 * `new Notification(...)` sem dono nenhum além da variável local de
 * `deliverToast` é candidato a GC ANTES do clique chegar (o `Notification` do
 * Electron não segura referência própria) — por isso toda notificação viva
 * fica aqui até `'close'`/`'click'`/`'failed'` (o que vier primeiro).
 */
const liveToasts = new Set<Notification>();

/** Grava um toast em JSONL (`BRIDGE_TOAST_LOG`) sem lançar — disco cheio não pode derrubar o app. */
function appendToastLog(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (err) {
    log(`[shell] falha ao gravar BRIDGE_TOAST_LOG: ${(err as Error).message}`);
  }
}

/**
 * Mostra (ou loga, em `BRIDGE_TOAST_LOG`) um toast já resolvido pela política
 * de coalescência. Clique → foca a janela e manda a sessão pro renderer.
 */
function deliverToast(payload: ToastPayload): void {
  if (toastLogPath) {
    appendToastLog(
      toastLogPath,
      JSON.stringify({
        at: Date.now(),
        sessionId: payload.sessionId,
        workspaceId: payload.workspaceId,
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
      }),
    );
    return;
  }
  if (!Notification.isSupported()) {
    log('[shell] Notification não suportada nesta máquina; toast descartado');
    return;
  }
  // O texto vem de uma sequência OSC impressa no terminal (A2): quem controla
  // a saída de um processo do painel controla estas duas strings. O Electron
  // monta o XML do toast do Windows e escapa os campos, mas o TAMANHO é nosso
  // — 200/1000 chars é o que cabe num toast, e o resto só serviria pra
  // esticar o XML.
  const notification = new Notification({
    title: truncateToastText(payload.title, 200),
    body: truncateToastText(payload.body, 1000),
    silent: false,
  });
  const untrack = trackToast(liveToasts, notification);
  notification.on('click', () => {
    untrack();
    if (win) {
      win.show();
      win.focus();
    }
    const focusPayload: FocusSessionPayload = { sessionId: payload.sessionId, workspaceId: payload.workspaceId };
    win?.webContents.send(IPC.focusSession, focusPayload);
  });
  notification.on('close', untrack);
  notification.on('failed', untrack);
  notification.show();
}

/**
 * Agenda o `flush` da janela de 2 s de UMA sessão.
 *
 * O timer guarda o `dueAt` que ele serve. Se chega um pedido pra um `dueAt`
 * MAIOR (a `coalesce` abriu uma janela nova porque a anterior já tinha
 * vencido, mas o timer velho ainda não rodou — corrida real quando o event
 * loop atrasa), o timer velho é substituído: mantê-lo faria ele disparar
 * quase na hora e fechar a janela recém-aberta, e a partir daí toda
 * notificação da sessão viraria líder — coalescência nenhuma.
 */
function scheduleToastFlush(sessionId: string, dueAt: number): void {
  const existing = flushTimers.get(sessionId);
  if (existing) {
    if (existing.dueAt >= dueAt) return;
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(
    () => {
      flushTimers.delete(sessionId);
      const result = coalesce(toastQueue, { type: 'flush', sessionId }, Date.now(), shellLanguage());
      toastQueue = result.queue;
      if (result.show) deliverToast(result.show);
    },
    Math.max(0, dueAt - Date.now()),
  );
  timer.unref?.();
  flushTimers.set(sessionId, { timer, dueAt });
}

/** Cancela todo timer de flush pendente sem disparar nada — só no encerramento do app. */
function clearToastTimers(): void {
  for (const pending of flushTimers.values()) clearTimeout(pending.timer);
  flushTimers.clear();
}

/**
 * Força o `flush` de toda sessão com janela aberta, na hora — usado no
 * `hello` (conexão nova ou reconexão): a janela de qualquer sessão pendente
 * NÃO pode ser descartada em silêncio, porque a líder dela já apareceu pro
 * usuário e um resumo represado (`"n avisos"`) contém informação real. Cada
 * `flush` aqui já cancela o timer real que estava agendado pra aquela sessão.
 */
function flushAllPendingToasts(): void {
  for (const sessionId of [...toastQueue.keys()]) {
    const pending = flushTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      flushTimers.delete(sessionId);
    }
    const result = coalesce(toastQueue, { type: 'flush', sessionId }, Date.now(), shellLanguage());
    toastQueue = result.queue;
    if (result.show) deliverToast(result.show);
  }
}

/**
 * `hello` do core: snapshot novo (conexão nova ou reconexão). A contagem de
 * não lidas do `hello` é AUTORITATIVA (vem direto do banco via
 * `Notifications.unread()`) — sobrepõe o que quer que `presentUnread` tivesse
 * antes, inclusive um valor que o `setBadge` da UI tenha escrito.
 */
function onCoreHello(state: HelloState): void {
  flushAllPendingToasts();
  presentUnread(state.unread.length);
}

/**
 * O idioma que o CORE resolveu passou a valer aqui também.
 *
 * A bandeja é o único texto do main que fica NA TELA entre um evento e outro —
 * o menu do Electron é imutável depois de montado, então ela é remontada. O
 * resto (toast, diálogo de erro) é escrito na hora de aparecer, com o
 * `tShell` do instante, e não tem o que atualizar.
 */
function applyLanguage(next: Language | undefined): void {
  if (next === undefined) return;
  if (!setShellLanguage(next)) return;
  tray?.setLanguage(next);
  log(`[shell] idioma da interface: ${next}`);
}

/** Cada `BridgeEvent` do core: badge sempre; toast e flash só quando a política manda. */
function onCoreBridgeEvent(event: BridgeEvent): void {
  presentUnread(unreadAfter(unreadCount, event));

  // Troca de idioma em Configurações → Aparência: o `config.changed` chega
  // aqui pelo MESMO socket que já traz notificação e layout (o main assina o
  // prefixo `config` desde a Task 4).
  if (event.type === 'config.changed') {
    applyLanguage(languageFromConfig(event.config));
    return;
  }

  // `layout.changed` não carrega o layout: quem reconcilia é o `onState` do
  // `coreEvents`, com o snapshot que ele já busca por causa do mapa de nomes.
  if (event.type !== 'notification.new') return;

  if (event.notification.kind === 'needs-input' && event.toast && win && !win.isFocused()) {
    win.flashFrame(true);
  }

  if (!shouldToast(event)) return;

  const { sessionId, workspaceId, kind, text } = event.notification;
  const workspaceName = coreEvents.getWorkspaceName(workspaceId) ?? workspaceId;
  const result = coalesce(
    toastQueue,
    // `Bridge · <workspace>` é marca + nome de workspace: nenhum dos dois é
    // copy, e nenhum dos dois se traduz.
    { type: 'notify', sessionId, workspaceId, kind, title: `Bridge · ${workspaceName}`, text },
    Date.now(),
    shellLanguage(),
  );
  toastQueue = result.queue;
  // A líder da janela (a primeira notificação da sessão, ou a primeira depois
  // que a janela anterior venceu) vem com `show` já preenchido — sai na hora.
  if (result.show) deliverToast(result.show);
  const pending = toastQueue.get(sessionId);
  if (pending) scheduleToastFlush(sessionId, pending.dueAt);
}

const coreEvents = new CoreEventsClient({
  onHello: onCoreHello,
  onEvent: onCoreBridgeEvent,
  log: (line) => log(line),
});

/**
 * O `stopCore()` compartilhado pelos três caminhos de saída (`will-quit`,
 * `before-quit` e o `session-end` da janela). Ver `shutdown.ts`.
 */
const shutdown = createShutdownGate(async () => {
  await stopCore();
}, (line) => log(line));

/**
 * O Windows está encerrando a sessão do usuário (desligar, reiniciar, sair da
 * conta), ou o app começou a sair por qualquer outro caminho.
 *
 * Melhor esforço e **sem bloquear o sistema operacional**: pede o encerramento
 * gracioso do core e devolve o controle na hora. Se o Windows nos matar antes
 * de o `POST /api/shutdown` voltar, não se perde nada que já não se perdesse —
 * e o painel do agente ainda volta na próxima subida, porque a marca de
 * restauração passou a ser escrita quando o agente SOBE (0.12.1), não no
 * encerramento.
 */
function requestCoreShutdown(reason: string): void {
  quitting = true;
  void shutdown.request(reason);
}

/**
 * Caminho sem volta: avisa e encerra. A `message` já chega TRADUZIDA (o
 * chamador a tira do catálogo com o idioma do shell) — até a Task 4 ela era
 * pt-BR literal, e este comentário dizia isso. Não marca `quitting` nem chama
 * o `stopCore()` aqui — quem faz as duas coisas é o caminho de saída que o
 * `app.quit()` abaixo dispara (`before-quit` → `will-quit`). Sem isso, um core
 * meio de pé (ou os PTYs dele) sobreviveria ao app.
 */
function fatal(message: string): void {
  log(`[shell] fatal: ${message}`);
  if (!fatalShown) {
    fatalShown = true;
    showErrorBox('Bridge', message);
  }
  app.quit();
}

/** Aponta o shell pra UI dessa porta e devolve a URL a carregar. */
function setUiTarget(port: number): string {
  const url = resolveUiUrl({ dev, port });
  uiOrigin = new URL(url).origin;
  return url;
}

function createWindow(port: number): BrowserWindow {
  /**
   * R3: sem menu de aplicação. O menu padrão do Electron traz aceleradores de
   * verdade — `Ctrl+W` fecha a janela (e o app), `Ctrl+R` recarrega o renderer
   * no meio das sessões, `Ctrl+Shift+I` abre o devtools, `Ctrl+-`/`Ctrl++` dá
   * zoom na UI inteira — e os dois primeiros ganhavam dos atalhos do Bridge
   * com o mesmo nome (fechar aba, painel de notificações).
   */
  const policy = menuPolicy(dev);
  Menu.setApplicationMenu(policy.menu);

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#18181B',
    title: 'Bridge',
    // Início automático com "começar minimizado": a janela existe (o core já
    // subiu, as sessões já estão vivas) mas não aparece — o usuário a chama
    // pela bandeja. Sem `--hidden` o comportamento é o de sempre.
    ...(startHidden ? { show: false } : {}),
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // R3: zoom travado. Sem isto o `Ctrl+±`/pinch muda o `zoomFactor` do
  // renderer e a UI inteira muda de escala no meio das sessões.
  void window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
    // Não é fatal: o pior caso é o pinch dar zoom.
  });
  window.webContents.setZoomFactor(1);
  window.webContents.on('zoom-changed', () => window.webContents.setZoomFactor(1));
  /**
   * Devtools só em dev, e só por um atalho REGISTRADO aqui (`F12`) — nunca
   * pelo `Ctrl+Shift+I` do menu padrão, que é o painel de notificações do
   * Bridge (spec §6).
   */
  if (policy.devtoolsShortcut) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12') return;
      event.preventDefault();
      window.webContents.toggleDevTools();
    });
  }
  const url = setUiTarget(port);
  // Em dev a página vem do Vite, que TEM que estar de pé (`npm run dev:ui`);
  // o shell não sobe o Vite. Sem essas duas linhas, "a janela ficou branca"
  // não deixa rastro nenhum no log.
  window.webContents.on('did-finish-load', () => {
    log(`[shell] renderer carregou ${window.webContents.getURL()}`);
    // O `<title>` da página acabou de sobrescrever o título da janela: sem
    // reaplicar, o "Bridge (n)" some depois de todo reload do renderer (e
    // `presentUnread` sozinho não faria nada — o contador não mudou).
    presentUnread(unreadCount, { force: true });
  });
  window.webContents.on('did-fail-load', (_event, code, desc, failedUrl) =>
    log(`[shell] renderer falhou (${code} ${desc}) em ${failedUrl}`),
  );
  // A janela é do Bridge e de mais ninguém: navegar pra fora (link, redirect,
  // `window.open`) tiraria a UI de cena mantendo o preload — com o token junto.
  window.webContents.on('will-navigate', (event, target) => {
    if (isFromUi(target, uiOrigin)) return;
    event.preventDefault();
    log(`[shell] navegação bloqueada pra ${target}`);
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // Link externo vai pro navegador do sistema; só http(s), nada de protocolo
    // exótico virando execução de programa.
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    else log(`[shell] window.open recusado pra ${target}`);
    return { action: 'deny' };
  });
  void window.loadURL(url);
  /**
   * 0.12.1 — desligamento, reinício ou logoff do Windows. É o evento que chega
   * quando o sistema encerra a sessão do usuário à força, e nele o `will-quit`
   * pode nunca acontecer: sem este pedido o core (e os PTYs dele) morriam de
   * `TerminateProcess`, sem `stop()` nenhum. **Não bloqueia o Windows**: só
   * dispara o pedido e devolve o controle.
   */
  window.on('session-end', () => requestCoreShutdown(SESSION_END_LOG));
  window.on('closed', () => {
    win = null;
  });
  // O flash da barra de tarefas (needs-input com a janela sem foco) para assim
  // que o usuário volta pro app — senão ficaria piscando pra sempre.
  window.on('focus', () => window.flashFrame(false));
  return window;
}

/**
 * IPC só responde a frame carregado da própria UI. Sem isso, um iframe de
 * terceiro dentro da janela pediria o token do core — que é o controle total
 * das sessões.
 */
function assertFromUi(event: IpcMainInvokeEvent | IpcMainEvent): void {
  // i18n-ignore: recusa de canal IPC. O renderer é o único chamador legítimo,
  // e ele não desenha esta mensagem em lugar nenhum — quem a lê é o log.
  if (!isFromUi(senderUrl(event), uiOrigin)) throw new Error('remetente IPC não autorizado'); // i18n-ignore
}

/** A URL do frame que mandou o IPC, ou `undefined` se ele já morreu. */
function senderUrl(event: IpcMainInvokeEvent | IpcMainEvent): string | undefined {
  try {
    // `senderFrame` lança se o frame já foi destruído.
    return event.senderFrame?.url;
  } catch {
    return undefined;
  }
}

/**
 * O IPC veio da JANELA PRINCIPAL? Segunda trava, além do `assertFromUi`, em
 * todo canal que MEXE na janela ou no estado do app (`focusWindow`,
 * `pickFolder`, `openPath`, `setLoginItem`, `setBadge`): só o `webContents` da
 * principal fala por eles. Os canais de LEITURA (`token`, `port`,
 * `getLoginItem`) ficam com o `assertFromUi` sozinho.
 */
function assertMainWindow(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (win && !win.isDestroyed() && event.sender.id === win.webContents.id) return;
  // i18n-ignore: recusa de canal IPC, lida só no log (ver `assertFromUi`).
  throw new Error('IPC fora da janela principal'); // i18n-ignore
}

function registerIpc(): void {
  ipcMain.handle(IPC.token, (event) => {
    assertFromUi(event);
    return instance?.token ?? '';
  });

  ipcMain.handle(IPC.port, (event) => {
    assertFromUi(event);
    return instance?.port ?? 0;
  });

  ipcMain.handle(IPC.focusWindow, (event) => {
    assertFromUi(event);
    assertMainWindow(event);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  ipcMain.handle(IPC.pickFolder, async (event) => {
    assertFromUi(event);
    assertMainWindow(event);
    // Task 10 (e2e): ver `testFolder` lá em cima.
    if (testFolder !== undefined && testFolder !== '') {
      log(`[shell] pickFolder devolveu BRIDGE_TEST_FOLDER: ${testFolder}`);
      return testFolder;
    }
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.openPath, async (event, path: unknown) => {
    assertFromUi(event);
    assertMainWindow(event);
    // R12 da Fase 3: "Abrir no Explorer" é a ÚNICA razão deste canal existir,
    // e `shell.openPath` num arquivo qualquer é o Windows ABRINDO esse
    // arquivo com o programa associado — um `.cmd`/`.ps1` chegando aqui viraria
    // execução. Pasta REAL que existe, ou nada (BR-16: `lstat`, não `stat` —
    // uma junction dentro de um repo hostil apontaria pra qualquer lugar).
    if (!isOpenablePath(path, { lstat: (p) => lstatSync(p) })) {
      log(`[shell] openPath ignorado (não é uma pasta real existente): ${String(path)}`);
      return;
    }
    const err = await shell.openPath(path);
    if (err) log(`[shell] openPath falhou: ${err}`);
  });

  ipcMain.handle(IPC.getLoginItem, (event) => {
    assertFromUi(event);
    return currentLoginItem();
  });

  ipcMain.handle(IPC.setLoginItem, (event, next: unknown) => {
    assertFromUi(event);
    assertMainWindow(event);
    const input = parseLoginItemInput(next);
    if (!input) {
      log('[shell] loginItem: payload inválido, nada gravado');
      return currentLoginItem();
    }
    // Em dev (e fora do Windows) NÃO grava nada: `process.execPath` é o
    // `electron.exe` do `node_modules`, e essa entrada no `Run` abriria um
    // Electron cru no próximo login — ou apontaria pra uma pasta que some no
    // próximo `npm ci`. O estado volta com o motivo em `status`, e a UI mostra
    // a frase em vez de fingir que salvou.
    const support = loginItemSupportNow();
    if (!support.supported) {
      log(`[shell] loginItem: pedido ignorado (${support.status})`);
      return currentLoginItem();
    }
    try {
      // Sem `name`: o nome do valor no registro vira o `APP_ID` (o
      // AppUserModelId), e é justamente com esse nome padrão que o
      // `getLoginItemSettings` acima consegue casar a entrada. Passar um
      // `name` próprio grava bonito e deixa a LEITURA cega — medido.
      app.setLoginItemSettings({
        openAtLogin: input.enabled,
        path: process.execPath,
        args: loginItemArgs(input.startMinimized),
      });
      log(`[shell] loginItem: openAtLogin=${input.enabled} hidden=${input.startMinimized}`);
    } catch (err) {
      log(`[shell] loginItem: gravação falhou: ${(err as Error).message}`);
    }
    // Relê: o que vale é o que o Windows aceitou, não o que a UI pediu.
    return currentLoginItem();
  });

  ipcMain.handle(IPC.setBadge, (event, unread: unknown) => {
    assertFromUi(event);
    assertMainWindow(event);
    const n = typeof unread === 'number' && Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;
    // A UI computa a contagem do lado dela também (reducer próprio, mesma
    // conexão WS que a `coreEvents` do main, só que a dela). `presentUnread`
    // grava em `unreadCount` — ver o comentário na declaração dela — pra essa
    // escrita ficar visível pra próxima conta incremental do lado do main.
    presentUnread(n);
  });
}

/**
 * O estado do início automático, sempre RELIDO do Windows — nunca de uma cópia
 * em memória. O usuário pode tirar a entrada do `Run` pelo Gerenciador de
 * Tarefas sem passar por aqui, e um cache mostraria o checkbox ligado com o
 * registro limpo.
 */
function currentLoginItem(): LoginItemState {
  // Fora do Windows a API existe mas não tem `launchItems`; o `try` cobre
  // qualquer recusa da plataforma sem derrubar o diálogo de configurações.
  try {
    // DUAS consultas, e nenhuma delas sem `args`: o `openAtLogin` do Electron
    // só é `true` quando o exe E os argumentos batem com o que está no
    // registro. O porquê inteiro (medido no Electron 44) está no
    // `readLoginItem`.
    const read = readLoginItem({
      hidden: app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs(true) }),
      plain: app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs(false) }),
    });
    const support = loginItemSupportNow();
    return { ...read, supported: support.supported, status: support.status };
  } catch (err) {
    log(`[shell] loginItem: leitura falhou: ${(err as Error).message}`);
    return { enabled: false, startMinimized: false, supported: false, status: loginItemSupportNow().status };
  }
}

function onCoreExit(info: CoreExit): void {
  log(`[shell] core encerrou (code=${info.code} signal=${info.signal} restarting=${info.restarting})`);
  if (info.restarting || quitting) return;
  fatal(tShell(info.fatal ?? 'shell.fatal.coreNaoSubiu'));
}

function onCoreRestarted(next: Instance): void {
  // Porta e token são novos: a página tem que refazer o handshake — e a
  // conexão direta do main com o core (toast/badge) também.
  instance = next;
  log(`[shell] core reiniciado na porta ${next.port}; recarregando a janela`);
  const url = setUiTarget(next.port);
  if (win) void win.loadURL(url);
  coreEvents.reconnect(next.port, next.token);
  // Core novo, config relida do disco: alguém pode ter editado o
  // `config.json` com o app de pé (é como o dono conserta um core que não
  // sobe). O `config.changed` do socket cobre a troca AO VIVO; esta releitura
  // cobre a que aconteceu enquanto não havia socket.
  void readCoreLanguage(next.port, next.token).then(applyLanguage);
}

async function boot(): Promise<void> {
  // Fase 1 do idioma (ver `language.ts`): a locale do Electron, ANTES de
  // qualquer coisa. O diálogo "o core não subiu" é, por definição, o de quem
  // não conseguiu perguntar nada ao core — ele precisa de um idioma agora.
  setShellLanguage(bootLanguage(app.getLocale()));
  try {
    await startCore({
      profileDir,
      uiDir,
      // Em dev a página vem do Vite: o core não precisa servir UI nenhuma, e
      // exigir isso mataria o `npm run dev:core` que o desenvolvedor deixou de
      // pé de propósito. Fora de dev, adotar um core sem UI = janela branca.
      requireUi: !dev,
      logPath,
      coreEntry: launch.args,
      cwd: launch.cwd,
      onExit: onCoreExit,
      onRestarted: onCoreRestarted,
    });
  } catch (err) {
    // Só o `CoreStartError` traz uma chave PRA MOSTRAR; qualquer outra falha
    // (invariante interna, bug de I/O) vira a frase genérica — o texto cru vai
    // pro `shell.log`, que é onde ele serve pra alguma coisa.
    log(`[shell] boot falhou: ${(err as Error).message}`);
    fatal(tShell(err instanceof CoreStartError ? err.key : 'shell.fatal.coreNaoSubiu'));
    return;
  }
  instance = currentInstance();
  registerIpc();
  win = createWindow(instance?.port ?? 0);
  tray = createTray(() => win, shellLanguage());
  if (instance) {
    coreEvents.connect(instance.port, instance.token);
    // Fase 2 do idioma (ver `language.ts`): daqui pra frente quem manda é o
    // `languageResolved` do core, não a locale do Electron. Não se espera por
    // ela — a janela já está subindo, e a bandeja se remonta sozinha.
    void readCoreLanguage(instance.port, instance.token).then(applyLanguage);
  }
}

if (!app.requestSingleInstanceLock()) {
  // Já tem um Bridge de pé: a segunda instância só levanta a janela da primeira.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('window-all-closed', () => app.quit());

  /**
   * 0.12.1 — o `before-quit` chega ANTES do `will-quit` em toda saída, e é o
   * que ainda chega quando o Windows encerra a sessão do usuário sem passar
   * pelo caminho normal. Ele só PEDE o encerramento do core; o `will-quit`
   * abaixo continua sendo quem segura o `quit` até o pedido terminar (os dois
   * dividem a mesma promessa, ver `shutdown.ts`).
   */
  app.on('before-quit', () => requestCoreShutdown(BEFORE_QUIT_LOG));

  app.on('will-quit', (event) => {
    if (willQuitHandled) return;
    // O core é um processo separado: sem isso ele (e as sessões dele) ficariam
    // de pé depois que a janela fechou.
    willQuitHandled = true;
    quitting = true;
    event.preventDefault();
    clearToastTimers();
    liveToasts.clear();
    coreEvents.close();
    tray?.destroy();
    // E LARGA a alça: um `Tray` destruído do Electron lança `Object has been
    // destroyed` em qualquer método (`setToolTip`, `setImage`), e o
    // `tray?.` dos outros pontos — `presentUnread`, `applyLanguage` — só
    // protege contra `null`. Um evento do core que chegue entre o `destroy` e
    // o fim do `quit` derrubaria o caminho de saída.
    tray = null;
    // O `shutdown` é o mesmo `stopCore()` que o `before-quit` já pode ter
    // disparado: aqui a espera é pela promessa dele, não por um segundo
    // encerramento.
    void shutdown.request().finally(() => app.quit());
  });

  /**
   * LIMITE ACEITO (spec §13): uma exceção que estoure ANTES do
   * `app.whenReady()` sai em INGLÊS, e não no idioma da máquina.
   *
   * O `tShell` daqui usa o idioma que o `shellLanguage()` tem no momento, e a
   * primeira fase desse idioma é o `app.getLocale()` do Electron — que só é
   * confiável depois do `ready`: antes dele o Chromium ainda não leu a locale
   * do sistema e devolve `en-US` em qualquer máquina. Um `getLocale()`
   * antecipado não consertaria nada; consertaria apenas a aparência de estar
   * certo.
   *
   * Depois do `ready` (que é quando o app roda 99,9 % do tempo) esta caixa sai
   * na língua certa — e, uma vez que o core responda, na língua ESCOLHIDA.
   */
  process.on('uncaughtException', (err) => {
    log(`[shell] erro não tratado: ${err.stack ?? err.message}`);
    // Um segundo diálogo modal empilhado só impediria o app de encerrar.
    if (fatalShown) return;
    fatalShown = true;
    showErrorBox('Bridge', tShell('shell.fatal.inesperado', { detalhe: err.message }));
  });

  void app.whenReady().then(boot);
}
