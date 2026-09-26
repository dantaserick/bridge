import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { currentSystemLocale, resolveLanguage, sanitizeDisplay } from '@bridge/shared';
import type { Language } from '@bridge/shared';
import type { FastifyInstance } from 'fastify';
import { registerApp } from './api/app.js';
import { adapters } from './adapters/index.js';
import { configureClaudeAdapter } from './adapters/claude.js';
import { resolveHostedTarget } from './adapters/hosted.js';
import { shellLaunch } from './adapters/shell.js';
import type { AgentAdapter, LaunchCtx } from './adapters/types.js';
import type { Db } from './db.js';
import { openDb } from './db.js';
import type { I18nMessage } from './errors.js';
import {
  InvalidTaskNameError,
  KillFailedError,
  NotWorktreeError,
  PaneBusyError,
  PaneNotFoundError,
  SessionLaunchError,
  WorkspaceNotFoundError,
} from './errors.js';
import type { EnvContext, Runner } from './environments.js';
import { EnvironmentError, Environments, resolveEnvContext, withSessionDir } from './environments.js';
import { EventBus } from './events.js';
import * as git from './git.js';
import { GitError } from './git.js';
import type { GitPoller } from './gitPoller.js';
import { startGitPoller } from './gitPoller.js';
import { newId } from './ids.js';
import { Launcher } from './launcher.js';
import type { LaunchTicket } from './launcher.js';
import { Layout } from './layout.js';
import type { Logger } from './log.js';
import { createLogger } from './log.js';
import type { AgentId, GitStatus, Pane, Repo, ResumeOutcome, Session, Tab, Workspace } from './model.js';
import type { EnvironmentInfo, SessionEnvironment } from '@bridge/shared';
import { Notifications } from './notifications.js';
import type { BridgeConfig, BridgeConfigPatch, Profile } from './profile.js';
import { clearInstance, loadProfile, mergeConfig, newToken, writeConfig, writeInstance } from './profile.js';
import { PtyHost } from './pty.js';
import type { RecapResult } from './recap.js';
import { readRecap } from './recap.js';
import {
  detailServerLimited,
  SERVER_LIMIT_TTL_MS,
  ServerLimitScanner,
  serverLimitOf,
} from './serverLimit.js';
import { asRecord, asString } from './adapters/payload.js';
import { checkScope as checkScopeOf, scopeDenyReply, scopeRootOf, violationPath } from './scopeGuard.js';
import { Sessions } from './sessions.js';
import type { Usage } from './usage/index.js';
import { createUsage } from './usage/index.js';
import type { UsagePoller } from './usagePoller.js';
import { startUsagePoller } from './usagePoller.js';

/**
 * Teto do ECO de um id/valor vindo do pedido em mensagem de erro (BU-16). A
 * CLI imprime `error` do servidor CRU no terminal — ver `api/routes.ts`.
 */
const ECHO_MAX = 120;

export interface CoreDeps {
  profile: Profile;
  db: Db;
  bus: EventBus;
  layout: Layout;
  sessions: Sessions;
  pty: PtyHost;
  notifications: Notifications;
  adapters: Record<AgentId, AgentAdapter>;
  log: Logger;
  token: string;
  shimPath: string;
  /**
   * Último `GitStatus` por workspace de worktree (Fase 3). Cache em memória de
   * propósito: é um número que expira em segundos — persistir no SQLite só
   * criaria a chance de a sidebar abrir mostrando um `+N` de ontem.
   */
  gitStatus: Map<string, GitStatus>;
  /**
   * A porta REAL em que o core está escutando. É função porque com `port: 0`
   * (todo teste, e o app quando a porta pedida está ocupada) ela só existe
   * depois do `listen()` — e quem a lê são as rotas, que rodam bem depois.
   */
  boundPort: () => number;
  /**
   * Clientes WS conectados agora. `count` é o total; `gitClients` conta só os
   * que RECEBEM `workspace.git` (o processo main do Electron conecta com
   * `?events=notification,session,layout,config` e fica de fora — os badges
   * `+N ~M` não chegam nele, então nenhum `git` precisa rodar por causa dele).
   * O poller lê os dois pra não lançar `git` sem ninguém olhando (R5).
   *
   * `usageClients` é o mesmo raciocínio do lado do monitor de uso: quem não
   * recebe `usage.changed` não justifica varrer transcripts a cada minuto.
   */
  wsClients: { count: number; gitClients: number; usageClients: number };
  /**
   * O poller de git desta instância. Preenchido no fim de `createCore` (ele
   * precisa do `core` pronto), então é `undefined` só durante a montagem.
   * Está aqui pra `PATCH /api/config` poder reagendar o intervalo e pro teste
   * conferir que reagendou.
   */
  gitPoller?: GitPoller;
  /**
   * O monitor de uso (ADR-012): transcripts → tokens/custo por dia, e as
   * janelas de limite vivas. Quem o alimenta é o hook `StatusLine` (janelas) e
   * o `usagePoller` (transcripts); quem o lê são as rotas `/api/usage*`.
   */
  usage: Usage;
  /** O poller de transcripts desta instância. `undefined` só durante a montagem. */
  usagePoller?: UsagePoller;
  /**
   * O escalonador de lançamentos de agente (dor verificada #1): teto de
   * concorrência, jitter da rajada, backoff enquanto o servidor estrangula, e
   * a fila que o `POST /api/sessions` responde com 202. Em MEMÓRIA — uma fila
   * persistida ressuscitaria, na próxima subida, agentes que ninguém mais
   * está esperando.
   */
  launcher: Launcher<CreateSessionInput, Session>;
  /** Pasta do build da UI servida como estático em `/`; undefined = sem UI. */
  uiDir?: string;
  /**
   * BR-07: a ACL restritiva do `instance.json` foi aplicada? Só vira `false`
   * quando o `icacls` FALHOU no Windows — aí o arquivo com o token ficou com a
   * permissão herdada da pasta, e a UI precisa avisar. Preenchido no `start()`.
   */
  instanceAclApplied: boolean;
  /**
   * Fix round 4 — "este repo declara driver de `filter.*`?", por repoId. Em
   * MEMÓRIA de propósito: é uma leitura do disco que expira, e persistir criaria
   * a chance de a UI abrir oferecendo "confiar" num repo que já não tem filtro.
   * Preenchido na adoção do repo e a cada passada do poller.
   */
  repoFilters: Map<string, boolean>;
  /**
   * R4 — o que fazer depois que `POST /api/shutdown` terminou o `stop()`. O
   * padrão é `process.exit(0)`; o teste injeta um observável pra não derrubar
   * o próprio runner.
   */
  onShutdown: () => void;
}

export interface CoreOptions {
  profileDir?: string;
  dbPath?: string;
  port?: number;
  token?: string;
  /** Espelha o log no console além do arquivo (dev / terminal interativo). */
  consoleLog?: boolean;
  /**
   * Build da UI a servir em `/`. Definido, o core vira também o servidor do
   * renderer — é assim que o shell Electron carrega a UI de
   * `http://127.0.0.1:<porta>` em vez de `file://` (que o `/ws` recusaria).
   */
  uiDir?: string;
  /** R4 — substitui o `process.exit(0)` do fim de `POST /api/shutdown` (teste). */
  onShutdown?: () => void;
  /**
   * Raiz dos transcripts do Claude Code pro monitor de uso. Omitido, vale a
   * cadeia `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. Existe
   * como opção pra que um teste jamais precise mexer no ambiente do processo
   * pra apontar o core pra uma pasta temporária.
   */
  claudeHome?: string;
  /**
   * Dor #2 — como falar com o `wsl.exe` na detecção de ambientes. Existe pra
   * TESTE: a máquina do dono não tem distro nenhuma, e sem este ponto de
   * injeção o caminho de "distro existe mas não tem `claude`" seria
   * inalcançável. Em produção fica no default (`execFile` de verdade).
   */
  environmentRunner?: Runner;
}

export interface CreateSessionInput {
  paneId: string;
  kind: 'shell' | 'agent';
  agent?: AgentId;
  cwd?: string;
  model?: string;
  cols?: number;
  rows?: number;
  /**
   * Comando escrito no PTY logo depois do spawn (o "Ver diff" da spec §7 abre
   * um painel já rodando `git diff`). Vai como TEXTO no terminal, não como
   * argumento do shell: o usuário vê a linha, pode editar e repetir.
   */
  initialCommand?: string;
  /**
   * Retomar a conversa `<id>` do agente (`claude --resume <id>`). Só vale com
   * `kind: 'agent'`; num shell é ignorado. Quem manda é a restauração da UI,
   * com o `lastAgentSessionId` que o painel guardou.
   */
  resume?: string;
  /**
   * O painel pode estar com um SHELL vivo: em vez de `PaneBusyError`, esse
   * shell é encerrado e a sessão nova ocupa o painel. É o `bridge resume`
   * (`POST /api/panes/:id/resume`) — o painel que a restauração devolveu como
   * shell é exatamente o que o comando existe pra atender, e derrubar o shell
   * é o ponto.
   *
   * Agente vivo continua sendo `PaneBusyError` com ou sem esta flag: dois
   * agentes não cabem no painel, e o que está trabalhando ali não pode ser
   * derrubado por um pedido de fora.
   *
   * A substituição acontece só DEPOIS de todas as validações (agente
   * conhecido, `available()`, cwd): um pedido que vai virar 422 não pode
   * deixar o usuário sem o terminal que ele tinha na mão.
   */
  replaceLiveShell?: boolean;
}

export interface CreateWorkspaceInput {
  cwd: string;
  name?: string;
  /**
   * Onde as sessões deste workspace sobem (dor verificada #2). Ausente = o
   * `shell` da configuração global.
   */
  environment?: SessionEnvironment;
}

export interface CreatedWorkspace {
  workspace: Workspace;
  tab: Tab;
  pane: Pane;
}

export interface CreateTaskInput {
  /** Repo já conhecido (tabela `repos`). Um dos dois é obrigatório. */
  repoId?: string;
  /** Pasta qualquer dentro do repo — o main worktree dela vira o repo da tarefa. */
  repoPath?: string;
  name: string;
  /** Default: o branch corrente do repo principal. */
  base?: string;
  /** Sobe o agente no primeiro painel ("subir Claude Code ao criar"). */
  agent?: AgentId;
  /**
   * Dor #2 — o ambiente da tarefa. Omitido, a tarefa HERDA o ambiente dos
   * workspaces do mesmo repositório: quem já disse "este repo é Ubuntu" não
   * deve ter que repetir isso em cada worktree — e uma tarefa que sobe em
   * `pwsh` num projeto que só compila na distro é a dor #2 de volta, agora
   * pela porta do worktree.
   */
  environment?: SessionEnvironment;
}

export interface CreatedTask extends CreatedWorkspace {
  session?: Session;
}

export interface Core {
  deps: CoreDeps;
  app: FastifyInstance;
  start(): Promise<{ port: number; token: string }>;
  stop(): Promise<void>;
  createSession(input: CreateSessionInput): Promise<Session>;
  killSession(id: string): Promise<void>;
  killSessionsOfTab(tabId: string): Promise<KillSessionsResult>;
  killSessionsOfWorkspace(workspaceId: string): Promise<KillSessionsResult>;
  /** Cria o workspace JÁ detectando repo/branch/worktree do `cwd` (spec §7). */
  createWorkspace(input: CreateWorkspaceInput): Promise<CreatedWorkspace>;
  /**
   * Troca o ambiente do workspace (spec §3). Vale da próxima sessão em diante;
   * PTY vivo continua no ambiente em que subiu.
   */
  setWorkspaceEnvironment(workspaceId: string, environment: SessionEnvironment | undefined): Promise<Workspace>;
  /**
   * Dor verificada #4 — "Permitir acesso fora do worktree" / "Restringir".
   * Vale NA HORA (a guarda é consultada a cada `PreToolUse`), diferente do
   * ambiente.
   */
  setWorkspaceCrossAccess(workspaceId: string, crossAccess: boolean): Promise<Workspace>;
  /**
   * Dor verificada #4 — o veredito da guarda de escopo pra UM `PreToolUse`.
   *
   * `undefined` = a chamada segue (guarda desligada, workspace liberado,
   * ferramenta sem caminho, ou caminho dentro da raiz). Um objeto = é o corpo
   * `deny` que a rota devolve pro shim, e o contador da sessão já foi somado.
   */
  checkScope(sessionId: string, payload: unknown): object | undefined;
  /** Ambientes detectados nesta máquina (`GET /api/environments`), com cache de 60 s. */
  environments(): Promise<EnvironmentInfo[]>;
  createTask(input: CreateTaskInput): Promise<CreatedTask>;
  /** `+N ~M` do workspace; calcula na hora se ainda não está em cache. */
  gitStatusOf(workspaceId: string): Promise<GitStatus>;
  /** Recalcula e (se mudou) emite `workspace.git`. `undefined` se não é worktree. */
  refreshGit(workspaceId: string): Promise<GitStatus | undefined>;
  mergeWorkspace(workspaceId: string, mode: 'ff-only' | 'no-ff'): Promise<{ mode: 'ff-only' | 'no-ff'; message?: string }>;
  removeWorktree(workspaceId: string): Promise<void>;
  /** R3 — "Definir base…": troca o base do worktree por um ref que existe. */
  setWorktreeBase(workspaceId: string, base: string): Promise<Workspace>;
  /**
   * BR-03 — "Confiar nos filtros git deste repositório". Grava a decisão,
   * invalida o cache de detecção (a resposta tem que valer na hora) e refaz o
   * status dos workspaces do repo, pra sidebar sair do aviso sem esperar o
   * poller. Devolve o repo atualizado.
   */
  setRepoTrustFilters(repoId: string, trust: boolean): Promise<Repo>;
  /** Drivers de `filter.*` que o repo declara (vazio = nenhum). */
  repoFilterDrivers(repoId: string): Promise<string[]>;
  /**
   * Remede se o repo declara driver de filtro e, se a resposta VIROU, emite
   * `layout.changed` — é o que acende (ou apaga) o item de menu e o selo da
   * sidebar sem o dono ter que reabrir nada. Nunca lança.
   */
  refreshRepoFilters(repoId: string): Promise<void>;
  /**
   * Remede o `hasFilterDrivers` de todo repo referenciado por algum workspace,
   * com concorrência limitada. Roda na subida do core; exposto porque o teste
   * precisa esperar a medição terminar.
   */
  refreshAllRepoFilters(concurrency?: number): Promise<void>;
  /** A configuração em vigor (cópia — mexer no resultado não muda o core). */
  config(): BridgeConfig;
  /**
   * O idioma em vigor (spec §13): `ui.language` cruzado com a locale desta
   * máquina quando ele é `'system'`. Resolvido AO VIVO — a próxima notificação
   * depois de um `PATCH /api/config` já sai no idioma novo, sem restart.
   *
   * É a fonte única do core: erros de API, notificações, statusline, textos do
   * escalonador e a razão do `deny` da guarda de escopo perguntam aqui.
   */
  language(): Language;
  /**
   * Aplica um subconjunto da configuração: grava o `config.json`, aplica em
   * memória, reagenda o poller de git e emite `config.changed`. Devolve a
   * configuração resultante. Lança se a gravação falhar (nada é aplicado).
   */
  updateConfig(patch: BridgeConfigPatch): BridgeConfig;
  /**
   * Registra o `session_id` que o agente mandou no hook — na sessão (memória)
   * e no painel (SQLite), pro `--resume` da próxima subida. No-op quando a
   * sessão não é de agente ou o id já é esse.
   */
  noteAgentSessionId(sessionId: string, agentSessionId: string): void;
  /**
   * Dor verificada #3 — julga o `--resume` desta sessão e emite
   * `session.updated` quando saiu veredito. Chamada em TODO `SessionStart`,
   * inclusive com `outcome` `undefined`: é a primeira chamada que fecha a
   * janela do julgamento. No-op quando não há veredito novo (sessão sem
   * resume, `SessionStart` repetido, sessão que não é de agente).
   */
  noteResumeOutcome(sessionId: string, outcome: ResumeOutcome | undefined): void;
  /**
   * Spec §5 — promove a sessão de SHELL a hospedeira do agente e emite UM
   * `session.updated`. Chamada a cada hook de shell (com `sessions.hostedAgents`
   * ligada); no-op quando a sessão já está hospedada, some ou não existe.
   */
  noteHosted(sessionId: string, agent: AgentId): void;
  /**
   * Spec §5 — desfaz a hospedagem (`SessionEnd` com motivo de saída): a marca
   * some, a sessão volta a `idle` sem `detail`/`tool` e um `session.updated`
   * sai. O PTY do shell continua vivo — a sessão NUNCA fica `exited` por aqui.
   * No-op numa sessão que não hospeda nada.
   */
  noteHostedEnd(sessionId: string): void;
  /**
   * 13/09/2026 — o dono fechou a conversa de dentro do agente (`SessionEnd`
   * com motivo de saída declarado): o painel passa a `lastEndedBy: 'user'` e
   * não é retomado na próxima subida. No-op em sessão que não é de agente e
   * durante o `stop()`.
   */
  noteAgentEndedByUser(sessionId: string): void;
  /**
   * Dor verificada #3 — o resumo determinístico da conversa que o `--resume`
   * não trouxe de volta (`POST /api/sessions/:id/recap`). Nunca lança: a falha
   * vem como `reason`.
   */
  sessionRecap(sessionId: string): Promise<RecapResult>;
  /**
   * Tira a sessão do estado `server-limited` (dor verificada #1). Chamado pelo
   * primeiro hook de turno normal (`Stop`, `UserPromptSubmit`) e pelo prazo de
   * `SERVER_LIMIT_TTL_MS`. No-op quando a sessão não está estrangulada.
   */
  clearServerLimit(sessionId: string): void;
  /**
   * Há uma criação de sessão EM VOO neste painel? (fix round 1.)
   *
   * A reserva (`creatingPanes`) é síncrona e vive dentro do `createSession`;
   * quem enfileira um lançamento decide ANTES dele, e sem esta pergunta um
   * pedido que chegasse no meio de outro (dois cliques, duas janelas) entrava
   * na fila pra morrer de `pane-busy` minutos depois.
   */
  isPaneCreating(paneId: string): boolean;
}

/** Workspace que comprovadamente tem `worktree` (saída de `worktreeWorkspace`). */
type WorktreeWorkspace = Workspace & { worktree: NonNullable<Workspace['worktree']> };

/**
 * Desfecho de um kill em LOTE (fechar aba, fechar workspace, remover tarefa).
 *
 * É um resultado parcial de propósito — "207-like", no vocabulário de HTTP: a
 * tentativa acontece em TODAS as sessões (`Promise.allSettled`) e o que não
 * morreu vem contado e identificado, em vez de a primeira falha abortar o
 * lote e deixar metade das sessões vivas sem ninguém saber quais.
 */
export interface KillSessionsResult {
  /** Quantas sessões foram encerradas de fato. */
  killed: number;
  /** Quantas resistiram. `0` é o único desfecho que autoriza mexer no layout. */
  failed: number;
  /** Os ids que resistiram — é o que o log e o corpo do erro mostram pro dono. */
  failedIds: string[];
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Piso de espera do `initialCommand` (R10): mesmo depois do primeiro byte do
 * PTY, o prompt do pwsh ainda está sendo desenhado — escrever no mesmo
 * instante faz o shell engolir o começo da linha.
 */
const INITIAL_COMMAND_MIN_MS = 200;
/** Teto: PTY que nunca imprime nada não pode segurar o comando pra sempre. */
const INITIAL_COMMAND_MAX_MS = 3000;

/** Prazo de validade do último `POST /api/focus` pro gate do poller (R5). */
export const FOCUS_FRESH_MS = 60_000;

/**
 * R5 — o poller de git pode rodar agora? Duas condições, as duas necessárias:
 *
 * - existe cliente WS que RECEBE `workspace.git`. O processo main do Electron
 *   conecta com um filtro que corta esse prefixo: contá-lo faria o core rodar
 *   `git` a cada 15 s por tarefa por causa de um cliente que nem veria o
 *   resultado (era o custo achado na revisão);
 * - a janela disse "estou em foco" há menos de `FOCUS_FRESH_MS`. O `focused`
 *   vem do `POST /api/focus`, que a UI manda no foco, no blur e a cada troca
 *   de painel; o prazo existe porque um blur perdido (janela morta à força, UI
 *   travada) não pode deixar o core lançando `git` para sempre em background.
 *
 * Pura pra ser testável sem subir socket nem janela.
 */
export function shouldPollGit(
  wsClients: { gitClients: number },
  focused: { windowFocused: boolean; at?: number },
  now: number = Date.now(),
): boolean {
  if (wsClients.gitClients <= 0) return false;
  if (!focused.windowFocused) return false;
  return now - (focused.at ?? 0) < FOCUS_FRESH_MS;
}

/**
 * O gêmeo do `shouldPollGit` pro monitor de uso (ADR-012). Mesmas duas
 * condições, contra `usageClients`: varrer transcripts com o app fechado
 * gastaria disco por nada — e o consumo que passou enquanto ninguém olhava
 * continua no arquivo, então a primeira passada com a janela aberta recupera
 * tudo.
 */
export function shouldPollUsage(
  wsClients: { usageClients: number },
  focused: { windowFocused: boolean; at?: number },
  now: number = Date.now(),
): boolean {
  if (wsClients.usageClients <= 0) return false;
  if (!focused.windowFocused) return false;
  return now - (focused.at ?? 0) < FOCUS_FRESH_MS;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Na subida não existe sessão viva nenhuma (PTY não sobrevive ao processo),
 * então toda subpasta de `%profile%\sessions` é lixo de uma execução anterior
 * que morreu sem limpar — settings.json com token velho, inclusive. Apaga.
 */
function collectGarbageSessionDirs(sessionsDir: string, liveIds: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (liveIds.has(entry)) continue;
    try {
      rmSync(join(sessionsDir, entry), { recursive: true, force: true });
    } catch {
      // pasta travada por outro processo — não vale derrubar a subida do core.
    }
  }
}

export function createCore(opts: CoreOptions = {}): Core {
  const profile = loadProfile(opts.profileDir);
  const db = openDb(opts.dbPath ?? profile.dbPath);
  const token = opts.token ?? newToken();
  const port = opts.port ?? profile.config.port;
  const shimPath = fileURLToPath(new URL('../bin/bridge-hook.cjs', import.meta.url));
  const log = createLogger({ path: profile.logPath, alsoConsole: !!opts.consoleLog });

  // `config.json` ilegível vira AVISO, não silêncio: o `loadProfile` roda
  // antes do logger existir e só marca o motivo em `profile.configError`.
  // Sem esta linha, um arquivo mal editado apagava a configuração do dono sem
  // deixar rastro nenhum de onde procurar.
  if (profile.configError) log.child('profile').warn(profile.configError, { dir: profile.dir });

  // Pasta inexistente derrubaria o @fastify/static na subida; o core sem UI
  // ainda serve a API (é o caso do `dev:core`), então só avisa e segue.
  let uiDir: string | undefined;
  if (opts.uiDir) {
    if (isDirectory(opts.uiDir)) uiDir = resolve(opts.uiDir);
    else log.child('api').warn('BRIDGE_UI_DIR não é uma pasta; a UI não será servida', { uiDir: opts.uiDir });
  }

  /**
   * O idioma resolvido, guardado (spec §13). Recalculado no `updateConfig` — e
   * só lá: a locale da máquina não muda com o app aberto, e resolver a cada
   * chamada faria toda notificação pagar um `Intl.DateTimeFormat()`.
   *
   * Nasce AQUI, no alto, porque quem o consome nasce depois dele: o monitor de
   * uso (rótulo de janela, aviso de preço), o adaptador (notificação,
   * statusline) e as rotas (mensagem de erro) leem `language()` — sempre a
   * função, nunca uma cópia, pra que a troca ao vivo chegue a todos.
   */
  let language: Language = resolveLanguage(profile.config.ui.language, currentSystemLocale());

  // A statusline devolvida ao Claude Code é montada pelo próprio Bridge
  // (ADR-012). Ela lê duas configurações: "mostrar custo?" e, desde a 0.12.2,
  // "desenhar a linha no terminal?" — desligada, o hook continua rodando e só
  // o texto devolvido fica vazio.
  configureClaudeAdapter({
    showCost: profile.config.usage.showCost,
    terminalStatusLine: profile.config.usage.terminalStatusLine,
  });

  // O `bus` nasce ANTES do monitor de uso porque o progresso da varredura sai
  // por ele (`usage.changed { scanning }`) — o monitor precisa de um emissor
  // pronto na hora em que a primeira passada começa.
  const bus = new EventBus((err) => log.child('bus').error('listener falhou', { err }));

  const usage = createUsage({
    db,
    log,
    config: () => profile.config.usage,
    language: () => language,
    // `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. O teste aponta
    // a variável pra uma pasta temporária: NENHUM teste lê o `~/.claude` real.
    claudeHome: opts.claudeHome,
    // A primeira varredura de um histórico grande leva minutos; sem este
    // evento o painel ficava mostrando "nenhuma transcrição encontrada" o
    // tempo todo em que estava, na verdade, lendo. O estrangulamento de 1/s
    // mora no `usage/progress.ts`.
    onProgress: (scanning) => bus.emit({ type: 'usage.changed', scanning }),
    // BU-14: o evento de LIMITES ganhou o mesmo teto de 1/s do progresso. A
    // chamada por aqui é a foto ATRASADA — a que o estrangulador segurou e
    // entrega no fim da janela; a imediata volta pelo retorno de `noteLimits`,
    // que o hook da statusline emite.
    onLimits: (limits) => bus.emit({ type: 'usage.changed', limits }),
  });
  const layout = new Layout(db, bus);
  const sessions = new Sessions(bus);
  const pty = new PtyHost(bus, sessions);
  const notifications = new Notifications(db, bus, sessions, profile.config);
  const allAdapters = adapters();

  collectGarbageSessionDirs(profile.sessionsDir, new Set(sessions.list().map((s) => s.id)));

  // BR-03/R3: a pasta VAZIA que vira `core.hooksPath` nas chamadas passivas de
  // git mora no PERFIL, não em `tmpdir()` — em `%TEMP%` qualquer processo do
  // usuário podia plantar um `post-index-change` ali dentro e o poller o
  // executaria, invertendo a proteção.
  git.setNoHooksDir(join(profile.dir, 'no-hooks'));

  pty.onOsc = (sessionId, n) => {
    notifications.push(sessionId, 'custom', n.title ? `${n.title}: ${n.body}` : n.body);
  };

  /**
   * O escalonador. `maxConcurrent`/`enabled` são LIDOS a cada decisão (e não
   * capturados): `PATCH /api/config` muda os dois com o core de pé.
   */
  const launcher = new Launcher<CreateSessionInput, Session>({
    maxConcurrent: () => profile.config.sessions.maxConcurrentAgents,
    enabled: () => profile.config.sessions.scheduleLaunches,
    activeAgents: () => sessions.liveAgentCount(),
    serverLimited: () => sessions.serverLimitedCount(),
    launch: (ticket: LaunchTicket<CreateSessionInput>) => createSession(ticket.input),
    onChanged: (status) => bus.emit({ type: 'launcher.changed', status }),
  });

  /**
   * Dor verificada #1 — o detector do limite do SERVIDOR.
   *
   * Ele escuta o `pty.data` do bus em vez de se pendurar no `onData` do
   * `PtyHost`: o evento já existe, carrega o `sessionId`, e o `PtyHost` não
   * precisa aprender uma segunda coisa que ele não sabe fazer (o `onOsc` acima
   * é do tempo em que só havia um consumidor).
   *
   * Vale pra sessão de SHELL também, e não só pra agente. Duas razões: o
   * Claude Code pode estar rodando dentro de um shell que o Bridge subiu (é o
   * caso de quem chama `claude` na mão num painel), e o texto é o mesmo. O
   * preço é um falso positivo possível — alguém que faça `cat` de um log com a
   * frase inteira —, e ele custa um anel laranja que sai sozinho em 5 min.
   */
  const serverLimitScanner = new ServerLimitScanner();
  /** Prazos de saída do estado, por sessão (`SERVER_LIMIT_TTL_MS`). */
  const serverLimitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearServerLimit(sessionId: string): void {
    const timer = serverLimitTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      serverLimitTimers.delete(sessionId);
    }
    // A janela também é esquecida: a frase que disparou continua no scrollback,
    // e sem isto o primeiro byte novo do terminal a faria casar de novo.
    serverLimitScanner.forget(sessionId);
    if (!sessions.clearServerLimited(sessionId)) return;
    if (sessions.serverLimitedCount() === 0) launcher.noteServerLimitCleared();
    else launcher.poke();
  }

  function noteServerLimit(sessionId: string, phrase: string, pattern: string): void {
    const limit = serverLimitOf({ phrase, pattern }, Date.now());
    if (!sessions.markServerLimited(sessionId, limit, detailServerLimited(language))) return;
    log.child('core').warn('limite do servidor detectado', { sessionId, pattern });
    const timer = setTimeout(() => clearServerLimit(sessionId), SERVER_LIMIT_TTL_MS);
    timer.unref?.();
    serverLimitTimers.set(sessionId, timer);
    // O escalonador passa a espaçar por BACKOFF a partir de agora.
    launcher.poke();
  }

  bus.on((event) => {
    if (event.type === 'pty.data') {
      // Dor verificada #3 — o primeiro byte do PTY é a prova de que o processo
      // já está falando. Só a PRIMEIRA vez devolve sessão (e vira evento): daí
      // em diante `noteOutput` é um `Set.has` e sai. É o que segura a injeção
      // automática do resumo até a TUI do agente estar aceitando texto.
      const started = sessions.noteOutput(event.sessionId);
      if (started) bus.emit({ type: 'session.updated', session: started });
      const match = serverLimitScanner.push(event.sessionId, event.data);
      if (match) noteServerLimit(event.sessionId, match.phrase, match.pattern);
      return;
    }
    // Sessão que morreu ou sumiu: o slot vagou (a fila pode andar) e a janela
    // do detector não tem mais dono.
    if (event.type === 'session.exited') {
      clearServerLimit(event.id);
      // Fix round 1 — a sessão estrangulada pode ter MORRIDO em vez de sair do
      // estado (o `exited` já apagou o `serverLimit`, então o `clearServerLimit`
      // acima é no-op). Sem este cheque o degrau do backoff ficava lá em cima
      // até o próximo estrangulamento, espaçando os lançamentos por até 60 s
      // sem ninguém estrangulado na tela.
      if (sessions.serverLimitedCount() === 0) launcher.noteServerLimitCleared();
      else launcher.poke();
      return;
    }
    if (event.type === 'session.removed') {
      const timer = serverLimitTimers.get(event.id);
      if (timer) clearTimeout(timer);
      serverLimitTimers.delete(event.id);
      serverLimitScanner.forget(event.id);
      launcher.poke();
    }
  });


  /**
   * Dor verificada #2 — quais ambientes esta máquina tem. Uma instância por
   * core: o cache de 60 s vive nela, e o diálogo de novo workspace mais o menu
   * de cada linha da sidebar perguntam a mesma coisa em rajada.
   */
  const environments = new Environments(opts.environmentRunner);

  const deps: CoreDeps = {
    profile,
    db,
    bus,
    layout,
    sessions,
    pty,
    notifications,
    adapters: allAdapters,
    log,
    token,
    shimPath,
    gitStatus: new Map<string, GitStatus>(),
    boundPort: () => boundPort,
    wsClients: { count: 0, gitClients: 0, usageClients: 0 },
    usage,
    // Otimista até o `start()` medir: fora do Windows a pergunta não se aplica
    // e a resposta certa é "sem problema a mostrar".
    instanceAclApplied: true,
    repoFilters: new Map<string, boolean>(),
    launcher,
    uiDir,
    onShutdown: opts.onShutdown ?? (() => process.exit(0)),
  };

  const app = Fastify({ logger: false });

  // Atualizado por start() com a porta REAL vinculada (relevante quando port:0).
  // As sessões criadas antes de start() usam a porta pedida como melhor palpite.
  let boundPort = port;

  // Nascem no fim de `createCore` (precisam do `core` pronto); todo uso daqui
  // acontece depois disso, mas o `?.` mantém a ordem explícita.
  let poller: GitPoller | undefined;
  let usagePoller: UsagePoller | undefined;

  /**
   * O core está ENCERRANDO. É o que separa os dois `lastEndedBy` do painel: o
   * `stop()` passa pelo `disposeSession` de cada sessão, e sem esta trava o
   * carimbo `'user'` de lá cairia por cima do `'app'` que o `stop()` acabou de
   * gravar — nenhum painel jamais seria retomado.
   */
  let stopping = false;

  /**
   * Quem encerrou (13/09/2026). Até aqui um ouvinte de `session.exited`
   * carimbava `'user'` em QUALQUER morte do PTY com o core vivo — e crash e
   * saída de auto-update do Claude Code viravam "o dono fechou a conversa".
   * Na madrugada de 13/09 isso custou ao dono a conversa do painel: o Claude
   * saiu sozinho, o painel virou `'user'` e o reboot do Windows Update devolveu
   * um shell.
   *
   * Agora a morte do processo não carimba nada: o painel continua com o
   * `'app'` antecipado do lançamento. `'user'` só nasce de uma prova de
   * intenção — o `SessionEnd` com motivo de saída declarado (`/exit`, logout;
   * ver `isDeliberateSessionEnd`) ou o encerramento pelo próprio Bridge (✕,
   * `DELETE /api/sessions/:id`, fechar aba/workspace, em `disposeSession`).
   */
  function noteAgentEndedByUser(id: string): void {
    if (stopping) return;
    const session = sessions.get(id);
    if (!session || session.kind !== 'agent') return;
    layout.setPaneEnded(session.paneId, 'user');
  }

  function removeSessionDir(id: string): void {
    const sessionDir = join(profile.sessionsDir, id);
    if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
  }

  /**
   * Painéis com criação de sessão EM VOO. O `PaneBusyError` abaixo só vê
   * sessões já registradas, e entre ele e o `sessions.create` há um `await`
   * (`adapter.available()` roda `claude --version`, segundos): dois POSTs no
   * mesmo painel nessa janela criavam duas sessões vivas lado a lado — foi o
   * que derrubou o cenário 7 do e2e. A reserva é síncrona e cai no `finally`.
   */
  const creatingPanes = new Set<string>();

  async function createSession(input: CreateSessionInput): Promise<Session> {
    const pane = db.panes.get(input.paneId);
    const tab = pane ? db.tabs.get(pane.tabId) : undefined;
    if (!pane || !tab) throw new PaneNotFoundError(input.paneId);

    // R1: painel ↔ sessão é 1:1. Sessão viva no painel bloqueia (409); sessão
    // já `exited` é substituída — é o "Enter reabre um shell" do spec §10,
    // feito pela API em vez de pelo terminal.
    //
    // A exceção é o `replaceLiveShell` (o `bridge resume`): shell VIVO cede o
    // painel. O descarte dele fica lá embaixo, depois das validações, junto
    // com o da sessão `exited` — aqui só o direito de seguir em frente.
    //
    // Shell HOSPEDEIRO (spec §5) não cede: matar o PTY mataria junto o Claude
    // Code que está trabalhando dentro dele. É o mesmo critério que a UI usa no
    // `runsAgent` (Task 3) e que o `closePane` já aplicava — `hosted` conta
    // como agente vivo em todo lugar que decide ocupação de painel.
    const existing = sessions.byPane(input.paneId);
    const replaceableShell =
      input.replaceLiveShell === true &&
      existing?.kind === 'shell' &&
      existing.state !== 'exited' &&
      existing.hosted === undefined;
    if (existing && existing.state !== 'exited' && !replaceableShell) throw new PaneBusyError(input.paneId);
    if (creatingPanes.has(input.paneId)) throw new PaneBusyError(input.paneId);
    creatingPanes.add(input.paneId);
    try {
      return await createSessionReserved(input, pane, tab, existing);
    } finally {
      creatingPanes.delete(input.paneId);
    }
  }

  /**
   * "O agente sobe NESTE ambiente?" (fix round 1 da dor #2).
   *
   * `adapter.available()` responde pelo PATH do Windows — a pergunta certa
   * quando a sessão vai subir aqui. Num workspace de WSL a sessão sobe DENTRO
   * da distro, e o `claude.cmd` do Windows não diz nada sobre isso: quem
   * responde é o `command -v claude` que a detecção já rodou lá dentro (com
   * cache de 60 s, então não custa um `wsl.exe` por lançamento).
   *
   * Só o adaptador `claude` tem essa leitura: `codex`/`gemini` são stubs que
   * nem sequer sabem subir no Windows, e inventar uma resposta de WSL pra eles
   * só esconderia o "não implementado" atrás de uma mensagem errada.
   */
  async function agentAvailable(
    adapter: AgentAdapter,
    env: SessionEnvironment | undefined,
  ): Promise<{ ok: boolean; reason?: string; i18n?: I18nMessage }> {
    if (env?.kind !== 'wsl' || adapter.id !== 'claude') return adapter.available(language);
    const id = `wsl:${env.distro ?? ''}`;
    const found = (await environments.list(language)).find((item) => item.id === id);
    if (!found || !found.available) {
      return { ok: false, i18n: { key: 'core.erro.ambiente.naoRespondeu', params: { id } } };
    }
    if (!found.claude) {
      return { ok: false, i18n: { key: 'core.erro.ambiente.semClaude', params: { id } } };
    }
    return { ok: true };
  }

  async function createSessionReserved(
    input: CreateSessionInput,
    pane: Pane,
    tab: Tab,
    existing: Session | undefined,
  ): Promise<Session> {
    const workspaceEnv = db.workspaces.get(tab.workspaceId)?.environment;

    let adapter: AgentAdapter | undefined;
    if (input.kind === 'agent') {
      if (!input.agent) throw new SessionLaunchError('no-agent', { key: 'core.erro.semAgente' });
      adapter = allAdapters[input.agent];
      if (!adapter) {
        throw new SessionLaunchError('unknown-agent', { key: 'core.erro.agenteDesconhecido', params: { agente: input.agent } });
      }
      const avail = await agentAvailable(adapter, workspaceEnv);
      if (!avail.ok) {
        throw new SessionLaunchError(
          'agent-unavailable',
          avail.i18n ?? avail.reason ?? { key: 'core.erro.agenteIndisponivel' },
        );
      }
    }

    const cwd = input.cwd ?? pane.cwd;
    // Antes de registrar a sessão: PTY com cwd inválido falha DEPOIS do
    // `sessions.create`, e sem isso sobrava uma sessão fantasma no estado.
    if (!isDirectory(cwd)) throw new SessionLaunchError('cwd-missing', { key: 'core.erro.cwdInexistente', params: { cwd } });

    /*
     * Dor verificada #2 — o AMBIENTE é do workspace (lido lá em cima, junto do
     * portão do agente). Sem ele, o shell é o da configuração global e o
     * agente é o `claude` do PATH do Windows: o comportamento de sempre.
     *
     * A resolução (traduzir `cwd`/shim por `wslpath`, achar o `node` da
     * distro) roda AQUI, junto das outras validações, e não lá embaixo: uma
     * distro que não responde tem que virar 422 ANTES de o painel perder a
     * sessão que o dono ainda não leu. Ela também é assíncrona, e
     * `shellLaunch`/`adapter.launch` são síncronos — não daria pra esperar um
     * `wsl.exe` de dentro deles.
     */
    let resolvedEnv: EnvContext | undefined;
    if (workspaceEnv) {
      try {
        resolvedEnv = await resolveEnvContext(workspaceEnv, {
          cwd,
          sessionsDir: profile.sessionsDir,
          shimPath,
          windowsNode: process.execPath,
        });
      } catch (err) {
        if (err instanceof EnvironmentError) {
          throw new SessionLaunchError('environment-unavailable', err.i18n);
        }
        throw err;
      }
    }

    // Só agora, com TODAS as validações passadas, a sessão anterior do painel
    // é descartada: um pedido que vai virar 422 (agente indisponível, cwd
    // errado) não pode destruir a saída que o user ainda não leu — nem, com
    // `replaceLiveShell`, o terminal VIVO que ele tem na mão.
    // `removePane: false` — o painel é justamente o que a sessão nova ocupa. O
    // kill do PTY é redundante quando o processo já morreu, mas cobre o
    // `exited` vindo de hook (`SessionEnd`) com o PTY ainda de pé.
    if (existing) await disposeSession(existing.id, { removePane: false });

    const session = sessions.create({
      paneId: input.paneId,
      workspaceId: tab.workspaceId,
      kind: input.kind,
      agent: input.agent,
      cwd,
      // Dor verificada #3: o id PEDIDO fica na sessão pro primeiro
      // `SessionStart` poder contradizê-lo.
      resumeRequested: input.kind === 'agent' ? input.resume : undefined,
    });

    // Daqui pra frente qualquer falha (mkdir, launch do adaptador, spawn do
    // PTY) tem que desfazer a sessão: quem chamou vê o erro, não um fantasma.
    try {
      const sessionDir = join(profile.sessionsDir, session.id);
      mkdirSync(sessionDir, { recursive: true });
      const cols = input.cols ?? DEFAULT_COLS;
      const rows = input.rows ?? DEFAULT_ROWS;
      // Spec §5: só sessão de SHELL leva o wrapper (a de agente já sobe com o
      // `--settings`), só com `sessions.hostedAgents` ligado, e só quando
      // existe um claude real pra apontar. `resolveHostedTarget()` roda AQUI,
      // no PATH do CORE — o wrapper que vai pro PATH da sessão ainda nem
      // existe, então ele nunca aponta pra si mesmo.
      const hostedTarget =
        input.kind === 'shell' && profile.config.sessions.hostedAgents ? resolveHostedTarget() : undefined;
      const ctx: LaunchCtx = {
        sessionId: session.id,
        cwd,
        sessionDir,
        port: boundPort,
        token,
        shimPath,
        model: input.model,
        // Só sessão de agente retoma; num shell o campo não quer dizer nada.
        resume: input.kind === 'agent' ? input.resume : undefined,
        cols,
        rows,
        // A pasta DESTA sessão só existe agora, com o id na mão; o resto do
        // ambiente já foi resolvido lá em cima, antes de qualquer destruição.
        environment: resolvedEnv ? withSessionDir(resolvedEnv, session.id) : undefined,
        hosted: hostedTarget ? { target: hostedTarget } : undefined,
        mouseClicks: profile.config.sessions.mouseClicks,
      };
      const spec =
        input.kind === 'shell' ? shellLaunch(ctx.environment?.kind ?? profile.config.shell, ctx) : adapter!.launch(ctx);
      const { pid } = pty.spawn(session.id, spec, { cwd, cols, rows });
      sessions.setPid(session.id, pid);
      // Spec §10: o painel volta como shell no restore, mas lembrando o que
      // rodava aqui — só depois do spawn dar certo, senão marcaria fantasma.
      layout.setPaneLast(input.paneId, input.kind, input.agent, input.kind === 'agent' ? input.resume : undefined);
      /*
       * 0.12.1 — a marca de "retome este painel" nasce COM o agente.
       *
       * Até a 0.12.0 ela só era escrita no `stop()`, ou seja só num
       * encerramento GRACIOSO. Mas o core morre sem `stop()` mais vezes do que
       * parece: o instalador NSIS mata o app sem `WM_CLOSE`, e o desligamento
       * do Windows também. Nesses casos o painel ficava com `lastEndedBy`
       * nulo e a subida seguinte devolvia um shell no lugar do Claude Code —
       * foi exatamente o que aconteceu com o dono.
       *
       * Invertendo o momento, a marca passa a significar "SE o app morrer
       * agora, retome": é escrita aqui, logo depois do PTY nascer (o ponto
       * mais cedo em que a sessão é inequivocamente uma sessão de agente VIVA
       * — antes do spawn ela ainda podia falhar e virar fantasma), e só uma
       * saída DELIBERADA carimba `'user'` por cima (`noteAgentEndedByUser`,
       * 13/09/2026). O `stop()` continua marcando, como cinto.
       *
       * Vem DEPOIS do `setPaneLast` porque ele zera o `lastEndedBy` (sessão
       * nova no painel). Só sessão de AGENTE: um shell hospedeiro (spec §5)
       * segue com `lastKind: 'shell'` e restaura como shell puro, por ruling.
       *
       * O custo de errar é pequeno e reversível: um painel cujo core morreu no
       * instante exato entre o `/exit` do dono e o `session.exited` volta com
       * uma conversa encerrada aberta — que o dono fecha.
       */
      if (input.kind === 'agent') layout.setPaneEnded(input.paneId, 'app');
      if (input.initialCommand) writeInitialCommand(session.id, input.initialCommand);
      return sessions.get(session.id)!;
    } catch (err) {
      sessions.remove(session.id);
      removeSessionDir(session.id);
      throw err;
    }
  }

  /**
   * Escreve o comando inicial no PTY (R10).
   *
   * O gatilho é o PRIMEIRO `pty.data` da sessão — a prova de que o shell já
   * está falando —, não um timer cego: numa máquina carregada o pwsh leva bem
   * mais que 200 ms pra desenhar o prompt, e a linha escrita antes disso é
   * engolida pela metade (o "Ver diff" abria um painel com `it diff …`).
   *
   * Em cima do gatilho, dois limites: um PISO de 200 ms (o primeiro byte sai
   * antes de o prompt terminar) e um TETO de 3 s (PTY que não imprime nada —
   * shell exótico, saída bufferizada — não pode segurar o comando pra sempre).
   *
   * Timers `unref`ados e `pty.write` numa sessão morta é no-op, por isso não
   * há cancelamento registrado: o pior caso é uma escrita que não vai a lugar
   * nenhum.
   */
  function writeInitialCommand(sessionId: string, command: string): void {
    const startedAt = Date.now();
    let done = false;

    const write = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      try {
        pty.write(sessionId, `${command}\r`);
      } catch (err) {
        log.child('core').warn('falhou ao escrever o comando inicial', { sessionId, err });
      }
    };

    const later = (delayMs: number): void => {
      const timer = setTimeout(write, Math.max(0, delayMs));
      timer.unref?.();
    };

    const unsubscribe = bus.on((event) => {
      if (done || event.type !== 'pty.data' || event.sessionId !== sessionId) return;
      // Primeiro byte: só falta o piso pro prompt acabar de aparecer.
      later(INITIAL_COMMAND_MIN_MS - (Date.now() - startedAt));
    });

    later(INITIAL_COMMAND_MAX_MS);
  }

  /**
   * O agente disse o id dele (todo hook do Claude Code traz `session_id`).
   * Grava nos DOIS lugares: na sessão viva, pra `GET /api/state` mostrar, e no
   * painel, que é quem sobrevive ao fechamento do app e vira o `--resume`.
   *
   * Emite `layout.changed` — o evento que a UI já usa pra reler o estado
   * inteiro — e SÓ quando algo mudou de fato: o id é o mesmo em todos os hooks
   * da sessão, então na prática é um evento por sessão, no `SessionStart`.
   */
  function noteAgentSessionId(id: string, agentSessionId: string): void {
    const session = sessions.get(id);
    // A hospedeira (spec §5) também tem conversa, e o painel a guarda no
    // `lastAgentSessionId` como o de qualquer agente.
    if (!session || (session.kind !== 'agent' && !session.hosted)) return;
    const changedSession = sessions.setAgentSessionId(id, agentSessionId);
    const changedPane = layout.setPaneAgentSession(session.paneId, agentSessionId);
    if (changedSession || changedPane) bus.emit({ type: 'layout.changed' });
  }

  /**
   * Dor verificada #3 — o `--resume` voltou vazio (ou não voltou vazio).
   *
   * Chamada em TODO `SessionStart`, inclusive com `outcome` `undefined` (o
   * payload que não trouxe nem id nem `source`): é a chegada do primeiro
   * `SessionStart` que fecha a janela do julgamento, não a existência de um
   * veredito. Sem isso o `SessionStart` seguinte — o de um `/clear` que o
   * próprio dono digitou — virava `'fresh'`. Ver `Sessions.judgeResume`.
   *
   * Emite `session.updated` só quando saiu veredito novo.
   */
  function noteResumeOutcome(id: string, outcome: ResumeOutcome | undefined): void {
    const updated = sessions.judgeResume(id, outcome);
    if (!updated) return;
    bus.emit({ type: 'session.updated', session: updated });
    log.child('core').info('desfecho do resume', { sessionId: id, outcome });
  }

  /**
   * Spec §5 — a sessão de SHELL passa a hospedar um agente.
   *
   * Chamada pela rota a cada hook de shell (com `sessions.hostedAgents`
   * ligada); só a PRIMEIRA vez vira marca nova e evento, porque o
   * `sessions.setHosted` é idempotente. O `session.updated` é o mesmo evento
   * que a UI já escuta pra reler a sessão inteira.
   *
   * O escalonador não é cutucado aqui de propósito: a hospedagem OCUPA um slot
   * (`liveAgentCount`), nunca libera.
   */
  function noteHosted(id: string, agent: AgentId): void {
    const updated = sessions.setHosted(id, agent);
    if (!updated) return;
    bus.emit({ type: 'session.updated', session: updated });
    log.child('core').info('sessão de shell hospedando agente', { sessionId: id, agent });
  }

  /**
   * Fim da hospedagem: o Claude que rodava DENTRO do shell saiu, o shell não.
   *
   * O `clearServerLimit` vem antes por dois motivos: ele cancela o prazo de
   * saída do estado e devolve a sessão ao estado anterior — sem isso um
   * `serverLimit` ficaria pendurado numa sessão `idle`, contrariando o contrato
   * do campo. Depois dele o `clearHosted` é quem dá a palavra final do estado.
   *
   * O `poke` no fim é o slot vagando: a hospedeira contava no teto, e a fila
   * pode andar agora. É o mesmo que o core faz quando uma sessão morre.
   */
  function noteHostedEnd(id: string): void {
    if (!sessions.get(id)?.hosted) return;
    clearServerLimit(id);
    const updated = sessions.clearHosted(id);
    if (!updated) return;
    bus.emit({ type: 'session.updated', session: updated });
    log.child('core').info('hospedagem encerrada', { sessionId: id });
    launcher.poke();
  }

  /**
   * Dor verificada #3 — o resumo da conversa que ficou pra trás.
   *
   * O id lido é o `resumeRequested` da sessão (o que o `--resume` PEDIU), não
   * o `agentSessionId` (o que o agente devolveu): é justamente a conversa
   * ANTIGA que interessa, e num resume que voltou vazio os dois são
   * diferentes.
   */
  async function sessionRecap(id: string): Promise<RecapResult> {
    const session = sessions.get(id);
    if (!session || session.kind !== 'agent') return { reason: 'no-resume' };
    return readRecap({
      home: usage.home,
      cwd: session.cwd,
      agentSessionId: session.resumeRequested,
      lang: language,
    });
  }

  /**
   * Encerra o PTY e apaga o estado da sessão. `removePane` separa os dois
   * chamadores: pelo usuário (DELETE /api/sessions/:id) o painel some junto
   * (R1); no `stop()` do core ele fica, senão desligar o Bridge apagaria o
   * layout que o spec §10 manda recarregar do SQLite na próxima subida.
   */
  async function disposeSession(id: string, opts: { removePane: boolean }): Promise<void> {
    const session = sessions.get(id);
    // Encerrar pelo Bridge é intenção do dono — inclusive o ✕ numa sessão que
    // já tinha morrido sozinha: fechar o painel encerrado diz "não quero de
    // volta". No `stop()` a trava `stopping` mantém o `'app'`.
    noteAgentEndedByUser(id);
    await pty.kill(id);
    sessions.remove(id);
    removeSessionDir(id);
    // Painel único da aba não é removido: removê-lo fecharia a aba inteira.
    // O painel fica vazio e aceita uma sessão nova.
    if (opts.removePane && session && layout.leafCountForPane(session.paneId) > 1) {
      layout.removePane(session.paneId);
    }
  }

  async function killSession(id: string): Promise<void> {
    await disposeSession(id, { removePane: true });
  }

  /**
   * Usado por `DELETE /api/tabs/:id` e `DELETE /api/workspaces/:id`: mata TODAS
   * as sessões (inclusive `exited` — são descartáveis) dos painéis dados ANTES
   * do layout ser removido. `removePane: false` de propósito — a rota chama
   * `layout.removeTab`/`removeWorkspace` logo em seguida, que já apaga os
   * painéis; deixar o `disposeSession` mexer no painel geraria um
   * `layout.changed` por sessão morta em cima do `layout.changed` único da
   * remoção (ruling da revisão da Task 6). `Promise.allSettled` pra uma
   * sessão travada no kill não impedir a tentativa nas outras.
   *
   * O desfecho é PARCIAL e nomeado (Task 2 do polimento): quem falhou volta
   * por `failedIds`, e cada falha vai pro log com o erro. Antes, a rota
   * respondia só "não consegui encerrar N sessão(ões)" — o dono via o número e
   * não tinha como saber em qual painel olhar.
   */
  async function killSessionsOfPanes(paneIds: string[]): Promise<KillSessionsResult> {
    const paneSet = new Set(paneIds);
    const toKill = sessions.list().filter((s) => paneSet.has(s.paneId));
    const results = await Promise.allSettled(toKill.map((s) => disposeSession(s.id, { removePane: false })));
    const failedIds: string[] = [];
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const id = toKill[i]?.id ?? '(desconhecida)';
      failedIds.push(id);
      log.child('sessions').error('não consegui encerrar a sessão', { sessionId: id, err: result.reason });
    });
    return { killed: results.length - failedIds.length, failed: failedIds.length, failedIds };
  }

  async function killSessionsOfTab(tabId: string): Promise<KillSessionsResult> {
    const paneIds = db.panes.listByTab(tabId).map((p) => p.id);
    return killSessionsOfPanes(paneIds);
  }

  async function killSessionsOfWorkspace(workspaceId: string): Promise<KillSessionsResult> {
    const tabs = db.tabs.listByWorkspace(workspaceId);
    const paneIds = tabs.flatMap((tab) => db.panes.listByTab(tab.id).map((p) => p.id));
    return killSessionsOfPanes(paneIds);
  }

  // ------------------------------------------------------- repos e worktrees

  /**
   * Registra (ou reaproveita) o repo PRINCIPAL. A chave é o caminho: dois
   * workspaces no mesmo repo — e todo worktree de tarefa dele — apontam pro
   * mesmo registro, senão a lista do diálogo "Nova tarefa" encheria de
   * duplicatas do mesmo projeto.
   */
  /**
   * O repo do workspace foi marcado como confiavel pro `filter.*`? (BR-03.)
   * Workspace sem repo conhecido nao tem filtro de repositorio a confiar, e o
   * `false` aqui e inofensivo: `assertFiltersTrusted` so barra quando ha driver.
   */
  function trustsFilters(repoId: string | undefined): boolean {
    return repoId ? db.repos.get(repoId)?.trustFilters === true : false;
  }

  function upsertRepo(mainPath: string): Repo {
    const existing = db.repos.byPath(mainPath);
    if (existing) return existing;
    // `trustFilters: false` — repositorio recem-adotado nunca nasce confiado
    // (BR-03). Quem confia e o dono, pelo menu do workspace.
    // `upsert` devolve o registro que FICOU: se outro caminho registrou este
    // mesmo `path` entre o `byPath` acima e esta linha (dois workspaces do
    // mesmo repo abrindo junto), quem vale é o id que já estava lá — seguir
    // com o objeto local deixaria o workspace apontando pra um repo inexistente.
    const repo = db.repos.upsert({
      id: newId('repo'),
      path: mainPath,
      name: win32.basename(mainPath) || mainPath,
      trustFilters: false,
    });
    // Mede em segundo plano: `upsertRepo` é síncrono (o `createWorkspace`
    // depende disso) e a medição é um `git config` que não pode segurar a
    // abertura do workspace. O `layout.changed` do `refreshRepoFilters` faz a
    // UI reler quando o resultado chegar.
    void refreshRepoFilters(repo.id);
    return repo;
  }

  /**
   * O `worktree` do workspace, quando o cwd é um worktree ADOTADO (a pasta já
   * existia; tarefa criada pelo Bridge tem o base de verdade, gravado por
   * `createTask`).
   *
   * A ordem é a do R3, e ela é sobre CONFIANÇA no base:
   * 1. o upstream do próprio branch da tarefa (`origin/main`) — quem clonou
   *    escolheu isso, é informação de verdade;
   * 2. o branch corrente do worktree PRINCIPAL — palpite: o usuário pode ter
   *    o principal em qualquer branch por qualquer motivo, e o base sai errado
   *    sem ninguém perceber. Vai com `baseGuessed: true`, e a UI diz "(base
   *    deduzida)" no tooltip e no confirm de merge/remoção.
   *
   * Sem nenhum dos dois o campo NÃO é preenchido: `base` é o alvo do merge e o
   * ponto de contagem do `+N`; gravar o literal `HEAD` ali faria a sidebar
   * mostrar número errado e o "Mesclar no base" apontar pra lugar nenhum. O
   * workspace continua servindo como pasta normal, sem indicadores — e o log
   * diz por quê.
   */
  async function worktreeOf(info: git.RepoInfo): Promise<Workspace['worktree']> {
    if (!info.isWorktree || !info.worktreePath) return undefined;

    const upstream = await git.upstreamOf(info.worktreePath);
    if (upstream) return { base: upstream, path: info.worktreePath };
    if (info.base) return { base: info.base, path: info.worktreePath, baseGuessed: true };

    log.child('git').warn('worktree sem base identificável (repo principal em HEAD destacado e sem upstream)', {
      worktree: info.worktreePath,
      main: info.mainPath,
    });
    return undefined;
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<CreatedWorkspace> {
    // A detecção vem ANTES da criação: um `git` que trava não pode deixar meio
    // workspace no banco, e o layout continua puro (nenhum git dentro dele).
    const info = await git.detectRepo(input.cwd);
    const created = layout.createWorkspace({ cwd: input.cwd, name: input.name, environment: input.environment });
    if (!info) return created;

    // R7 — repo SEM commit nenhum não entra na tabela `repos`: ele não serve
    // de origem de tarefa (`worktree add` não tem de onde partir) e a lista do
    // diálogo é justamente "de onde dá pra abrir tarefa". É o que fazia
    // `%USERPROFILE%` (um `git init` sem commit, e o `%TEMP%` mora dentro
    // dele) aparecer como repositório a cada workspace criado num temp.
    const repo = info.hasCommits ? upsertRepo(info.mainPath) : undefined;
    const workspace = layout.setWorkspaceGit(created.workspace.id, {
      repoId: repo?.id,
      branch: info.branch,
      worktree: await worktreeOf(info),
    });
    return { ...created, workspace: workspace ?? created.workspace };
  }

  /**
   * Dor verificada #2 — troca o ambiente do workspace. `undefined` volta pro
   * `shell` da configuração global.
   *
   * Não mexe em sessão viva de propósito: o PTY já está de pé no shell de
   * antes, e derrubá-lo por causa de uma escolha de menu jogaria fora o
   * trabalho que está rodando ali. A troca vale da próxima sessão em diante —
   * é o que o menu da UI promete.
   */
  async function setWorkspaceEnvironment(
    workspaceId: string,
    environment: SessionEnvironment | undefined,
  ): Promise<Workspace> {
    const updated = layout.setWorkspaceEnvironment(workspaceId, environment);
    if (!updated) throw new WorkspaceNotFoundError(workspaceId);
    return updated;
  }

  async function setWorkspaceCrossAccess(workspaceId: string, crossAccess: boolean): Promise<Workspace> {
    const updated = layout.setWorkspaceCrossAccess(workspaceId, crossAccess);
    if (!updated) throw new WorkspaceNotFoundError(workspaceId);
    /**
     * 0.12.2 — LIBERAR zera o selo 🛡 das sessões deste workspace.
     *
     * O dono liberou justamente porque viu a recusa; deixar o contador na tela
     * depois disso é o app insistindo num aviso que ele já respondeu. Só na
     * subida do interruptor: restringir de novo não repõe o histórico, e o
     * contador recomeça do zero na primeira recusa nova — o que aconteceu está
     * no log do core, não neste número.
     */
    if (crossAccess) {
      for (const session of sessions.clearScopeBlocks(workspaceId)) {
        bus.emit({ type: 'session.updated', session });
      }
    }
    log.child('core').info('acesso cruzado do workspace', { workspaceId, crossAccess });
    return updated;
  }

  /**
   * Dor verificada #4 — a guarda de escopo entre worktrees irmãs.
   *
   * Aqui mora só a AMARRAÇÃO (sessão → workspace → raiz permitida, contador,
   * evento); a decisão sobre o caminho é pura e vive em `scopeGuard.ts`.
   *
   * A ordem das saídas é de propósito: o interruptor geral primeiro, depois a
   * liberação do workspace, e só então o trabalho de resolver caminho. Um
   * `PreToolUse` chega a cada ferramenta que o agente usa — este caminho é
   * quente, e ele não pode chamar `realpath` pra uma sessão que nem tem
   * guarda.
   */
  function checkScope(sessionId: string, payload: unknown): object | undefined {
    if (!profile.config.sessions.scopeGuard) return undefined;
    const session = sessions.get(sessionId);
    // Vale pra hospedeira também (spec §5): o Claude aberto dentro do shell
    // atravessa worktree igualzinho ao que o Bridge lançou.
    if (!session || (session.kind !== 'agent' && !session.hosted)) return undefined;
    const workspace = db.workspaces.get(session.workspaceId);
    if (!workspace || workspace.crossAccess) return undefined;
    const root = scopeRootOf(workspace, workspace.repoId ? db.repos.get(workspace.repoId)?.path : undefined);
    // Sem raiz não há veredito: raiz que sumiu do disco e workspace de WSL (o
    // agente declara caminho POSIX, a raiz aqui é do Windows — `SECURITY.md`
    // risco 18) saem por aqui, sem `deny` e sem contador.
    if (!root) return undefined;
    const p = asRecord(payload);
    const toolName = asString(p.tool_name);
    if (!toolName) return undefined;
    /**
     * Contra QUE diretório o caminho relativo do agente resolve.
     *
     * O `cwd` do payload é o diretório de verdade do processo do Claude, e
     * todo hook o carrega. Ele passou a mandar na 0.12.0 porque o `cwd` da
     * SESSÃO deixou de ser sempre verdade: numa hospedeira a pessoa dá `cd`
     * numa subpasta e só então digita `claude`. Num agente lançado pelo Bridge
     * os dois coincidem no começo — mas o agente também pode ter mudado de
     * pasta, e quem sabe onde ele está é ele.
     *
     * Só caminho ABSOLUTO é aceito: um `cwd` relativo (ou que nem é string)
     * resolveria contra o processo do CORE, que não tem nada a ver com a
     * sessão. Nesse caso vale o `cwd` da sessão, como antes. Isso não é uma
     * decisão de segurança do lado frouxo: a raiz permitida continua sendo a do
     * workspace, e um `cwd` mentiroso só muda pra ONDE o relativo aponta — se
     * apontar pra fora, é recusa.
     */
    const payloadCwd = asString(p.cwd);
    const cwd = payloadCwd && isAbsolute(payloadCwd) ? payloadCwd : session.cwd;
    const violation = checkScopeOf({ toolName, toolInput: p.tool_input, cwd, root });
    if (!violation) return undefined;
    const updated = sessions.noteScopeBlock(sessionId, violationPath(violation));
    if (updated) bus.emit({ type: 'session.updated', session: updated });
    log.child('core').warn('guarda de escopo barrou um caminho', {
      sessionId,
      tool: toolName,
      path: violationPath(violation),
      root: root.path,
    });
    return scopeDenyReply(violation, root, language);
  }

  /** Repo da tarefa: por id (já conhecido) ou detectado a partir de uma pasta. */
  async function resolveRepo(input: CreateTaskInput): Promise<Repo> {
    if (input.repoId) {
      const repo = db.repos.list().find((r) => r.id === input.repoId);
      if (!repo) {
        throw new GitError('not-a-repo', {
          key: 'core.erro.git.repoDesconhecido',
          params: { repo: sanitizeDisplay(input.repoId, ECHO_MAX) },
        });
      }
      // O `repoId` não é atalho pra pular a checagem do R7: uma linha de
      // `repos` gravada ANTES do `hasCommits` existir (perfil de uma versão
      // anterior) aponta pra um repo que pode nunca ter tido commit, e o
      // `git worktree add` ali falharia com uma mensagem que não ajuda
      // ninguém. O disco é a fonte da verdade, não a linha do banco.
      const info = await git.detectRepo(repo.path);
      if (!info) {
        throw new GitError('not-a-repo', { key: 'core.erro.git.repoSumiu', params: { caminho: repo.path } });
      }
      if (!info.hasCommits) {
        throw new GitError('no-commits', { key: 'core.erro.git.semCommits' }, repo.path);
      }
      return repo;
    }
    if (!input.repoPath) throw new GitError('not-a-repo', { key: 'core.erro.git.informeRepo' });
    const info = await git.detectRepo(input.repoPath);
    if (!info) {
      throw new GitError('not-a-repo', { key: 'core.erro.git.naoERepo', params: { caminho: input.repoPath } });
    }
    // R7: `git worktree add` num repo sem commit falha com uma mensagem que
    // não ajuda ninguém. A recusa aqui diz o que fazer.
    if (!info.hasCommits) {
      throw new GitError('no-commits', { key: 'core.erro.git.semCommits' }, info.mainPath);
    }
    return upsertRepo(info.mainPath);
  }

  /**
   * O ambiente que uma tarefa nova HERDA do repositório dela (dor #2, fix
   * round 1). A ordem é do mais explícito ao mais provável:
   *
   * 1. o workspace de RAIZ do repo (o que aponta pra própria pasta do
   *    repositório) — é onde o dono normalmente configurou o ambiente;
   * 2. o workspace mais ANTIGO do repo que tenha ambiente — determinístico, e
   *    na prática é a primeira tarefa que ele configurou.
   *
   * `undefined` (nenhum workspace do repo escolheu ambiente) mantém o
   * comportamento de antes: a tarefa usa o `shell` da configuração global.
   */
  function inheritedEnvironment(repoId: string, repoPath: string): SessionEnvironment | undefined {
    const ofRepo = db.workspaces
      .list()
      .filter((w) => w.repoId === repoId && w.environment !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    const root = ofRepo.find((w) => win32.resolve(w.cwd).toLowerCase() === win32.resolve(repoPath).toLowerCase());
    return (root ?? ofRepo[0])?.environment;
  }

  async function createTask(input: CreateTaskInput): Promise<CreatedTask> {
    const repo = await resolveRepo(input);
    // Normaliza aqui além do `createWorktree`: o NOME do workspace na sidebar
    // tem que ser o mesmo do branch e da pasta.
    let name: string;
    try {
      name = git.normalizeTaskName(input.name);
    } catch {
      throw new InvalidTaskNameError(input.name);
    }

    let base = input.base;
    if (!base) {
      const info = await git.detectRepo(repo.path);
      if (!info) {
        throw new GitError('not-a-repo', { key: 'core.erro.git.repoSumiu', params: { caminho: repo.path } });
      }
      if (!info.hasCommits) {
        throw new GitError('no-commits', { key: 'core.erro.git.semCommits' }, repo.path);
      }
      base = info.branch;
    }

    // Fix round 4: `git worktree add` faz CHECKOUT, e checkout roda o
    // `smudge` do driver declarado pelo repositório (medido). É o mesmo
    // BR-03 do poller, por outra porta — e esta é uma AÇÃO do dono, então a
    // resposta é 409 com o motivo, não uma leitura silenciosamente pulada.
    await git.assertFiltersTrusted(repo.path, repo.trustFilters === true);

    const worktree = await git.createWorktree(repo.path, name, base);

    let created: CreatedWorkspace;
    try {
      created = await createWorkspace({
        cwd: worktree.path,
        name,
        // Explícito vence; senão herda do repositório (ver `inheritedEnvironment`).
        environment: input.environment ?? inheritedEnvironment(repo.id, repo.path),
      });

      // O base de uma tarefa NÃO é dedução: quem acabou de criar o worktree
      // sabe de qual branch ele saiu. `createWorkspace` chega aqui com o
      // palpite do `worktreeOf` (upstream, ou o branch corrente do principal
      // com `baseGuessed`) — sempre sobrescrito, e sem a marca de deduzido.
      if (created.workspace.worktree) {
        const fixed = layout.setWorkspaceGit(created.workspace.id, {
          repoId: created.workspace.repoId,
          branch: created.workspace.branch,
          worktree: { base, path: created.workspace.worktree.path },
        });
        if (fixed) created.workspace = fixed;
      }
    } catch (err) {
      // O `worktree add` já aconteceu. Sem desfazer, a pasta e o branch ficam
      // no repo do usuário sem workspace nenhum apontando pra eles — e a
      // próxima tentativa com o mesmo nome bate em `exists`, culpando o
      // usuário por um erro do Bridge. O `--force` é seguro aqui: o worktree
      // nasceu neste mesmo fluxo e não tem trabalho dentro.
      await git.removeWorktreeForce(repo.path, worktree.path, worktree.branch).catch((cleanupErr: unknown) => {
        log.child('git').warn('não consegui desfazer o worktree da tarefa que falhou', {
          worktree: worktree.path,
          branch: worktree.branch,
          err: cleanupErr,
        });
      });
      throw err;
    }

    // O status nasce junto: a sidebar mostra `+0 ~0` sem esperar o poller.
    await refreshGit(created.workspace.id).catch(() => undefined);

    if (!input.agent) return created;
    try {
      const session = await createSession({ paneId: created.pane.id, kind: 'agent', agent: input.agent });
      // O agente da tarefa nova NÃO passa pela fila (é um clique deliberado,
      // numa sessão só), mas conta pro RITMO: sem isto, um `POST /api/tasks`
      // seguido de um `POST /api/sessions` sairia colado, que é justamente a
      // rajada que o jitter existe pra desmanchar.
      launcher.noteLaunched();
      return { ...created, session };
    } catch (err) {
      // O worktree JÁ existe. Derrubar a tarefa inteira porque o agente não
      // subiu (claude fora do PATH, quota estourada) deixaria o usuário sem
      // nada e com um `exists` na próxima tentativa — o painel vazio aceita um
      // shell e ele tenta de novo pelo menu.
      log.child('core').warn('tarefa criada, mas o agente não subiu', { workspaceId: created.workspace.id, err });
      return created;
    }
  }

  /** Workspace que EXISTE e é worktree — as duas checagens de merge/remoção. */
  function worktreeWorkspace(workspaceId: string): WorktreeWorkspace {
    const workspace = db.workspaces.get(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    if (!workspace.worktree) throw new NotWorktreeError(workspaceId);
    return workspace as WorktreeWorkspace;
  }

  /**
   * Caminho do repo PRINCIPAL do workspace — é lá que `merge` e
   * `worktree remove` rodam. O `repoId` é o caminho normal; a detecção é a
   * rede de segurança pra um banco vindo de uma versão anterior (workspace
   * sem `repoId` gravado).
   */
  async function mainRepoPath(workspace: Workspace): Promise<string> {
    const repo = workspace.repoId ? db.repos.list().find((r) => r.id === workspace.repoId) : undefined;
    if (repo) return repo.path;
    const info = await git.detectRepo(workspace.cwd);
    if (!info) {
      throw new GitError('not-a-repo', { key: 'core.erro.git.naoERepo', params: { caminho: workspace.cwd } });
    }
    return upsertRepo(info.mainPath).path;
  }

  async function refreshGit(workspaceId: string): Promise<GitStatus | undefined> {
    return poller?.refresh(workspaceId);
  }

  async function gitStatusOf(workspaceId: string): Promise<GitStatus> {
    const workspace = worktreeWorkspace(workspaceId);
    const cached = deps.gitStatus.get(workspaceId);
    if (cached) return cached;
    const computed = await refreshGit(workspaceId);
    // Sem poller (nunca acontece em produção): calcula direto.
    return (
      computed ??
      git.status(workspace.worktree.path, workspace.worktree.base, { trustFilters: trustsFilters(workspace.repoId) })
    );
  }

  /**
   * O branch que o worktree tem AGORA (R4). O cache do poller serve quando
   * está quente; senão pergunta ao git. O nome da pasta é o último recurso —
   * um worktree cujo `git` não responde não deveria chegar aqui.
   */
  async function currentTaskBranch(workspace: WorktreeWorkspace): Promise<string> {
    const cached = deps.gitStatus.get(workspace.id);
    if (cached?.branch && cached.branch !== 'HEAD' && cached.error === undefined) return cached.branch;
    try {
      const branch = await git.currentBranch(workspace.worktree.path);
      if (branch !== 'HEAD') return branch;
    } catch {
      // Worktree fora do ar: cai pro que o banco lembra.
    }
    return workspace.branch ?? win32.basename(workspace.worktree.path);
  }

  /**
   * R3 — "Definir base…". O ref é validado ANTES de gravar: um base
   * inexistente zeraria o `+N` em silêncio e faria o "Mesclar no base" apontar
   * pra lugar nenhum. Gravado, o base deixa de ser deduzido.
   */
  async function setWorktreeBase(workspaceId: string, base: string): Promise<Workspace> {
    const workspace = worktreeWorkspace(workspaceId);
    const repoPath = await mainRepoPath(workspace);
    if (!(await git.refExists(repoPath, base))) {
      throw new GitError('unknown-ref', { key: 'core.erro.git.refDesconhecida', params: { ref: base } }, base);
    }
    const updated = layout.setWorkspaceGit(workspaceId, {
      repoId: workspace.repoId,
      branch: workspace.branch,
      worktree: { base, path: workspace.worktree.path },
    });
    if (!updated) throw new WorkspaceNotFoundError(workspaceId);
    // O `+N` era contado contra o base antigo: refaz agora.
    await refreshGit(workspaceId).catch(() => undefined);
    return updated;
  }

  async function refreshRepoFilters(repoId: string): Promise<void> {
    const repo = db.repos.get(repoId);
    if (!repo) return;
    try {
      const has = await git.repoHasFilterDrivers(repo.path);
      if (deps.repoFilters.get(repoId) === has) return;
      deps.repoFilters.set(repoId, has);
      bus.emit({ type: 'layout.changed' });
    } catch {
      // Medição é diagnóstico: falhar aqui não pode derrubar o poller nem a
      // criação de workspace. O `repoHasFilterDrivers` já é fail-closed por
      // dentro; um erro além disso deixa o valor anterior valendo.
    }
  }

  /**
   * Remede TODOS os repos que algum workspace referencia (fix round 5).
   *
   * O buraco: `upsertRepo` sai cedo quando o repo já está no banco, e o poller
   * só passa por workspace de WORKTREE. Um perfil com um workspace de RAIZ num
   * repo com driver reabria com `hasFilterDrivers` em `false` — o item de menu
   * sumia e o dono voltava a não ter como confiar, que é o beco que a rodada 4
   * fechou. Aqui a medição roda na subida, em segundo plano.
   *
   * Concorrência limitada: são `git config` de verdade, e disparar N de uma vez
   * num perfil com muitos repos brigaria com o boot das sessões.
   */
  async function refreshAllRepoFilters(concurrency = 4): Promise<void> {
    const ids = [...new Set(db.workspaces.list().map((w) => w.repoId).filter((id): id is string => id !== undefined))];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const id = ids[index];
        if (id === undefined) return;
        await refreshRepoFilters(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, worker));
  }

  async function setRepoTrustFilters(repoId: string, trust: boolean): Promise<Repo> {
    const updated = db.repos.setTrustFilters(repoId, trust);
    if (!updated) {
      throw new GitError(
        'not-a-repo',
        { key: 'core.erro.git.repoDesconhecido', params: { repo: sanitizeDisplay(repoId, ECHO_MAX) } },
        repoId,
      );
    }
    // A detecção é cacheada por 10 s; sem invalidar, o dono clicaria em
    // "confiar" e a sidebar continuaria no aviso até o cache expirar.
    git.invalidateFilterCache();
    // A confiança mudou: remede pra decidir se o item de menu continua sendo
    // oferecido (repo confiado que perdeu o driver não deve mais aparecer).
    await refreshRepoFilters(repoId);
    // E o `+N ~M` volta (ou some) na hora, sem esperar o ciclo do poller.
    for (const workspace of db.workspaces.list()) {
      if (workspace.repoId !== repoId || !workspace.worktree) continue;
      await refreshGit(workspace.id).catch(() => undefined);
    }
    return updated;
  }

  async function repoFilterDrivers(repoId: string): Promise<string[]> {
    const repo = db.repos.get(repoId);
    if (!repo) {
      throw new GitError(
        'not-a-repo',
        { key: 'core.erro.git.repoDesconhecido', params: { repo: sanitizeDisplay(repoId, ECHO_MAX) } },
        repoId,
      );
    }
    // Fix round 4: a rota tem que CONCORDAR com o `status`, e o `status` roda
    // dentro de cada worktree — onde o escopo `--worktree` pode declarar um
    // driver que a raiz não vê. Enumera a raiz e todos os worktrees, e junta.
    const roots = new Set<string>([repo.path]);
    try {
      for (const path of await git.worktreePaths(repo.path)) roots.add(path);
    } catch {
      // Repo que sumiu do disco: sobra a raiz, e o `listFilterDrivers` dela já
      // é fail-closed.
    }
    const drivers = new Set<string>();
    for (const root of roots) {
      for (const name of await git.listFilterDrivers(root)) drivers.add(name);
    }
    return [...drivers];
  }

  async function mergeWorkspace(
    workspaceId: string,
    mode: 'ff-only' | 'no-ff',
  ): Promise<{ mode: 'ff-only' | 'no-ff'; message?: string }> {
    const workspace = worktreeWorkspace(workspaceId);
    const repoPath = await mainRepoPath(workspace);
    // R4 — o branch vem do DISCO, não do banco: o usuário troca de branch
    // dentro do worktree pelo terminal a qualquer momento, e mesclar o branch
    // que estava gravado mescla a coisa errada.
    const branch = await currentTaskBranch(workspace);
    const result = await git.mergeIntoBase(repoPath, branch, workspace.worktree.base, mode, {
      trustFilters: trustsFilters(workspace.repoId),
      // O driver pode estar declarado só no `config.worktree` do worktree da
      // tarefa, invisível pra raiz.
      worktreePath: workspace.worktree.path,
    });
    // Depois do merge o `+N` vira 0: atualiza a sidebar sem esperar o poller.
    await refreshGit(workspaceId).catch(() => undefined);
    return result;
  }

  async function removeWorktree(workspaceId: string): Promise<void> {
    const workspace = worktreeWorkspace(workspaceId);
    const { base, path } = workspace.worktree;
    const repoPath = await mainRepoPath(workspace);
    // R4: idem ao merge — apagar "o branch que estava gravado" apagaria o
    // errado se o usuário tiver trocado de branch dentro do worktree.
    const branch = await currentTaskBranch(workspace);

    // As DUAS recusas (spec §10) são decididas ANTES de qualquer coisa
    // irreversível: matar as sessões do workspace pra depois responder "o
    // branch não está mesclado" custaria ao usuário o agente do painel por
    // causa de uma checagem que era só leitura. As mensagens continuam vindo
    // do git.ts (`canRemoveWorktree`), não daqui.
    const trustFilters = trustsFilters(workspace.repoId);
    const check = await git.canRemoveWorktree(repoPath, path, branch, base, { trustFilters });
    if (!check.ok) throw new GitError(check.code, check.i18n, check.detail);

    // As sessões morrem ANTES do `git worktree remove`: um pwsh com cwd dentro
    // da pasta segura o handle no Windows e o remove falharia pela metade.
    const killed = await killSessionsOfWorkspace(workspaceId);
    if (killed.failed > 0) throw new KillFailedError(killed.failed, killed.killed, killed.failedIds);

    // Refaz as checagens (o estado pode ter mudado no meio) e remove de fato.
    await git.removeWorktree(repoPath, path, branch, base, { trustFilters });

    deps.gitStatus.delete(workspaceId);
    layout.removeWorkspace(workspaceId);
  }

  /**
   * `PATCH /api/config` (spec §5). Ordem de propósito: grava PRIMEIRO, aplica
   * depois — disco cheio ou perfil somente leitura deixa a configuração em
   * memória exatamente como estava, em vez de o app passar a se comportar de
   * um jeito que o `config.json` não descreve.
   *
   * A aplicação é uma mutação NO LUGAR (`Object.assign`): `Notifications`
   * guarda uma referência ao mesmo objeto desde a subida, e trocar o objeto
   * de `profile.config` deixaria ela decidindo toast pela configuração velha
   * pra sempre. Pelo mesmo motivo `shell` não precisa de nada: `createSession`
   * lê `profile.config.shell` na hora do spawn, então a troca vale pras
   * sessões NOVAS (as vivas continuam no shell com que nasceram).
   */
  function updateConfig(patch: BridgeConfigPatch): BridgeConfig {
    const next = mergeConfig(patch, profile.config);
    // `{}` ou um valor igual ao atual: nada a gravar nem a anunciar. A
    // comparação é contra `profile.config`, NÃO contra o snapshot: o snapshot
    // carrega o `profileDir` (que não é gravável e nunca aparece em `next`),
    // e comparar com ele daria "diferente" sempre — todo PATCH inócuo viraria
    // uma gravação em disco e um `config.changed` pra todas as janelas.
    if (JSON.stringify(next) === JSON.stringify(profile.config)) return configSnapshot();
    writeConfig(profile.dir, next);
    Object.assign(profile.config, next);
    // Spec §13: o idioma é resolvido AQUI, junto com o resto. Quem trocou o
    // idioma no diálogo espera a próxima notificação já em inglês — não a
    // próxima subida do app.
    language = resolveLanguage(profile.config.ui.language, currentSystemLocale());
    poller?.setIntervalMs(Math.max(1, profile.config.gitPollSeconds) * 1000);
    // ADR-012: `usage.showCost` e `usage.terminalStatusLine` mudam a statusline
    // devolvida ao terminal, e `usage.pricing`/`usage.pricingFile` mudam a
    // tabela de preços. As duas são relidas AQUI, não no próximo pedido: o dono
    // acabou de mexer nelas no diálogo e espera ver o efeito, não esperar a
    // próxima varredura.
    configureClaudeAdapter({
      showCost: profile.config.usage.showCost,
      terminalStatusLine: profile.config.usage.terminalStatusLine,
    });
    usage.reloadPricing();
    // O teto de agentes (ou o liga-desliga do escalonador) pode ter mudado: um
    // `maxConcurrentAgents` maior tem que soltar a fila NA HORA, não no
    // próximo evento de sessão. `poke` já emite `launcher.changed`.
    launcher.poke();
    const snapshot = configSnapshot();
    bus.emit({ type: 'config.changed', config: snapshot });
    return snapshot;
  }

  /**
   * Cópia rasa+aninhada: quem recebe não segura a referência viva de
   * `profile.config`. É aqui, e só aqui, que o `profileDir` entra na
   * configuração — ele é derivado de onde o perfil está, não algo que o
   * `config.json` guarde (ver `writeConfig`). A UI usa esse caminho absoluto
   * pra abrir a pasta do perfil no Explorer.
   */
  function configSnapshot(): BridgeConfig {
    return {
      ...profile.config,
      profileDir: profile.dir,
      languageResolved: language,
      // Derivado como o `profileDir`: é onde o monitor de uso lê os
      // transcripts, não algo que o `config.json` guarde.
      claudeHome: usage.home,
      toast: { ...profile.config.toast },
      terminal: { ...profile.config.terminal },
      restore: { ...profile.config.restore },
      ui: { ...profile.config.ui },
      usage: { ...profile.config.usage },
      sessions: { ...profile.config.sessions },
    };
  }

  async function start(): Promise<{ port: number; token: string }> {
    await app.listen({ host: '127.0.0.1', port });
    const address = app.server.address();
    boundPort = address && typeof address === 'object' ? address.port : port;
    // BR-07 (re-review): o `icacls` que falha NÃO pode passar em silêncio. O
    // core sobe do mesmo jeito — derrubar o app por causa de uma política de
    // grupo seria pior —, mas o desfecho vira `error` no log e chega na UI pelo
    // `GET /api/state`/`hello`, que mostra a faixa.
    const acl = writeInstance(profile, { port: boundPort, token, pid: process.pid, startedAt: Date.now() }, (msg, meta) =>
      log.child('profile').error(msg, meta),
    );
    deps.instanceAclApplied = acl !== 'falhou';
    // Fix round 5: sem `await` — a medição é diagnóstico e não pode segurar a
    // subida do core. O `layout.changed` de cada flip faz a UI reler.
    void refreshAllRepoFilters().catch(() => undefined);
    return { port: boundPort, token };
  }

  async function stop(): Promise<void> {
    // Última linha do log de cada execução — e a prova, no `core.log`, de que
    // o encerramento passou por aqui (R4) em vez de ter sido um `taskkill /f`,
    // que mata o processo sem `flush()` nenhum.
    log.info('encerrando', { sessions: sessions.list().length });
    // ANTES de matar qualquer coisa: quem morrer daqui pra frente morreu
    // porque o BRIDGE fechou, não porque o usuário encerrou. É essa marca que
    // a próxima subida lê pra decidir quais painéis voltam com `--resume`.
    // Só painel com agente VIVO: shell não retoma, e sessão já `exited`
    // encerrou antes, com a marca dela.
    stopping = true;
    for (const session of sessions.list()) {
      if (session.kind === 'agent' && session.state !== 'exited') layout.setPaneEnded(session.paneId, 'app');
    }
    poller?.stop();
    launcher.stop();
    for (const timer of serverLimitTimers.values()) clearTimeout(timer);
    serverLimitTimers.clear();
    // A varredura desiste na fronteira do próximo arquivo (`usage.stop()`) e
    // só então esperamos por ela: o que já foi lido está gravado, e o `await`
    // garante que nenhum `setFileState` chegue depois do `db.close()` abaixo.
    // Sem o `usage.stop()`, este `await` seguraria o encerramento pelo tempo
    // de varrer o histórico inteiro na primeira subida.
    usage.stop();
    usagePoller?.stop();
    await usagePoller?.initialScan.catch(() => undefined);
    await Promise.all(sessions.list().map((s) => disposeSession(s.id, { removePane: false })));
    clearInstance(profile);
    await app.close();
    db.close();
    // R11 — `close()`, não `flush()`: qualquer linha logada durante o
    // encerramento reabriria o `core.log`, e o Windows recusa apagar a pasta
    // do perfil com o arquivo aberto (era o vazamento de `%TEMP%\bridge-*`).
    await log.close();
  }

  const core: Core = {
    deps,
    app,
    start,
    stop,
    createSession,
    killSession,
    killSessionsOfTab,
    killSessionsOfWorkspace,
    createWorkspace,
    setWorkspaceEnvironment,
    setWorkspaceCrossAccess,
    checkScope,
    environments: () => environments.list(language),
    createTask,
    gitStatusOf,
    refreshGit,
    mergeWorkspace,
    removeWorktree,
    setWorktreeBase,
    setRepoTrustFilters,
    repoFilterDrivers,
    refreshRepoFilters,
    refreshAllRepoFilters,
    config: configSnapshot,
    language: () => language,
    updateConfig,
    noteAgentSessionId,
    noteAgentEndedByUser,
    noteResumeOutcome,
    noteHosted,
    noteHostedEnd,
    sessionRecap,
    clearServerLimit,
    isPaneCreating: (paneId: string) => creatingPanes.has(paneId),
  };

  // Depois do `core` existir (o poller lê `deps` por ele) e antes das rotas,
  // que já podem chamar `refreshGit` no primeiro pedido.
  poller = startGitPoller({
    core,
    intervalMs: Math.max(1, profile.config.gitPollSeconds) * 1000,
    // R5 — "enquanto a janela estiver visível com a UI conectada".
    hasClients: () => shouldPollGit(deps.wsClients, deps.notifications.focused),
  });
  deps.gitPoller = poller;

  usagePoller = startUsagePoller({
    core,
    usage,
    // Mesmo critério do git (R5): sem cliente que receba `usage.changed` e
    // sem janela em foco há pouco, nenhum transcript é varrido.
    hasClients: () => shouldPollUsage(deps.wsClients, deps.notifications.focused),
  });
  deps.usagePoller = usagePoller;

  registerApp(app, core);
  return core;
}
