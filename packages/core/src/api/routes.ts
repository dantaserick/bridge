import { statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentAdapter } from '../adapters/types.js';
import type { Core, KillSessionsResult } from '../core.js';
import {
  InvalidTaskNameError,
  KillFailedError,
  NotWorktreeError,
  PaneBusyError,
  PaneNotFoundError,
  SessionLaunchError,
  TabAdoptError,
  WorkspaceNotFoundError,
  errorMessage,
} from '../errors.js';
import { FILTER_ENUM_FAILED, GitError, SUBMODULE_PATH_INVALID, detectRepo } from '../git.js';
import { LauncherPaneQueuedError, LauncherQueueFullError } from '../launcher.js';
import type { Session, Workspace } from '../model.js';
import { loadKeybindingsWithProblems } from '../keybindings.js';
import type { RecapFailure } from '../recap.js';
import { isValidTimeZone } from '../usage/aggregate.js';
import { RESCAN_COOLDOWN_MS } from '../usage/index.js';
import { sanitizeDisplay, t } from '@bridge/shared';
import type { MessageKey } from '@bridge/shared';
import {
  READ_ONLY_CONFIG_FIELDS,
  USAGE_RANGES,
  configPatchSchema,
  focusSchema,
  inputSchema,
  issueMessage,
  launchNowSchema,
  mergeSchema,
  notifySchema,
  notificationsReadSchema,
  parseBody,
  ratioSchema,
  repoTrustSchema,
  resizeSchema,
  worktreeBaseSchema,
  workspacePatchSchema,
  sessionSchema,
  splitSchema,
  tabSchema,
  taskSchema,
  workspaceSchema,
} from './schemas.js';
import { snapshotState } from './state.js';

/**
 * Teto do ECO de um valor que veio do pedido numa mensagem de erro (BU-16).
 *
 * As mensagens de erro da API são impressas CRUAS pela CLI
 * (`console.error(cliErr.message)`), então um `?tz=` de 5 000 caracteres com
 * ANSI dentro é saída de terminal escolhida por quem chamou. 120 caracteres
 * bastam pra a pessoa reconhecer o que digitou.
 */
const ECHO_MAX = 120;

const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
type Direction = (typeof DIRECTIONS)[number];

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

function cwdExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Falha PARCIAL do kill em lote (fechar aba/workspace).
 *
 * Existe em uma função só porque as duas rotas de DELETE (aba e workspace) têm
 * que dar exatamente a mesma resposta: remover o layout com PTY vivo deixaria
 * processo órfão sem dono nenhum na árvore.
 *
 * O lote inteiro já foi tentado antes de chegar aqui — o `killSessionsOfPanes`
 * usa `Promise.allSettled`, então uma sessão travada nunca impediu a tentativa
 * nas outras. O que faltava era o corpo dizer isso: em vez de só "não consegui
 * encerrar N sessão(ões)", vai o desfecho de cada lado (`killed`/`failed`/
 * `failedIds`) e o `code`, no formato de erro que a CLI e a UI já leem.
 *
 * Continua 500 (e não 207): o layout NÃO foi removido, então o pedido não se
 * cumpriu nem em parte do ponto de vista de quem chamou — repetir a chamada é
 * seguro e é o caminho certo, e agora ela diz em qual painel olhar.
 */
function sendKillFailure(core: Core, reply: FastifyReply, result: KillSessionsResult): boolean {
  if (result.failed === 0) return false;
  reply.code(500).send({
    error: t(core.language(), 'core.erro.killFalhou', { n: result.failed }),
    code: 'kill-failed',
    killed: result.killed,
    failed: result.failed,
    failedIds: result.failedIds,
  });
  return true;
}

/**
 * Recusas do git que o usuário resolve (spec §10): o pedido está BEM formado,
 * mas o repo está num estado que impede — 409, e a UI mostra o que falta.
 *
 * R2 — `not-ff` e `conflict` entram aqui: os dois são estado do repositório
 * (a base andou; os dois lados mexeram no mesmo arquivo), não pedido malfeito.
 */
const CONFLICT_CODES = new Set([
  'exists',
  // BR-03: repo com filtro declarado e sem confiança do dono. É estado do
  // repositório + uma decisão que só ele pode tomar — 409, com o código pra UI
  // oferecer o "Confiar nos filtros".
  'filters-untrusted',
  'dirty-base',
  'dirty-worktree',
  'not-merged',
  'not-ff',
  'conflict',
  'base-not-checked-out',
  'base-in-use',
]);

/**
 * Traduz os erros da Fase 3 em resposta HTTP e devolve `true` quando tratou.
 *
 * O `code` é o CONTRATO com a UI e com a CLI (é ele que faz o diálogo oferecer
 * o merge com commit num `code: 'not-ff'`), por isso vai no corpo junto da
 * mensagem pt-BR — nunca só o texto, que muda com qualquer revisão de copy.
 */
function sendDomainError(core: Core, reply: FastifyReply, err: unknown): boolean {
  // A mensagem nasce AQUI, na borda, com o idioma do instante da resposta
  // (spec §13). O `code` — que é o contrato com a UI e com a CLI — não muda.
  const lang = core.language();
  const message = errorMessage(err, lang);
  if (err instanceof GitError) {
    const status = CONFLICT_CODES.has(err.code) ? 409 : 422;
    // BU-16: `detail` costuma ser o valor que veio do pedido (um `repoId`, um
    // ref). A CLI imprime a resposta; limpa e corta aqui, num ponto só.
    reply
      .code(status)
      .send({ error: message, code: err.code, detail: sanitizeDisplay(err.detail, ECHO_MAX) || undefined });
    return true;
  }
  if (err instanceof NotWorktreeError) {
    reply.code(409).send({ error: message, code: err.code });
    return true;
  }
  if (err instanceof InvalidTaskNameError) {
    reply.code(422).send({ error: message, code: 'invalid-name' });
    return true;
  }
  if (err instanceof WorkspaceNotFoundError) {
    reply.code(404).send({ error: message });
    return true;
  }
  if (err instanceof KillFailedError) {
    // Mesmo corpo do `sendKillFailure`: quem falhou vem nomeado, e o que
    // morreu no lote vem contado (a remoção da tarefa parou aqui, mas as
    // outras sessões do workspace já foram encerradas de verdade).
    reply
      .code(500)
      .send({ error: message, code: 'kill-failed', killed: err.killed, failed: err.failed, failedIds: err.failedIds });
    return true;
  }
  return false;
}

/**
 * A sessão, se ela existe; senão responde 404 e devolve `undefined` (R6 da
 * onda final). Quem só quer o guarda escreve `if (!sessionOr404(…)) return;`;
 * quem precisa do registro aproveita o mesmo retorno em vez de buscar de novo.
 *
 * `POST /api/sessions/:id/notify` e `/input` respondiam `200 {}` pra sessão
 * que não existe: o `bridge notify` de um agente cuja sessão já morreu dizia
 * "avisado" sem nenhuma notificação existir, e o `bridge send` dizia "enviado"
 * pra um PTY inexistente. Quem chama é a API do USUÁRIO (UI e CLI) — os hooks
 * (`/hooks/*`) seguem lenientes de propósito: um agente não pode quebrar
 * porque a sessão dele já foi encerrada do lado do Bridge.
 */
function sessionOr404(core: Core, sessionId: string, reply: FastifyReply): Session | undefined {
  const session = core.deps.sessions.get(sessionId);
  if (session) return session;
  reply.code(404).send({ error: t(core.language(), 'core.erro.sessaoNaoEncontrada'), code: 'session-not-found' });
  return undefined;
}

/**
 * Dor verificada #3 — a frase de cada falha do resumo. Elas dizem o FATO (o
 * arquivo não está lá, não sobrou texto) em vez de "erro ao gerar o resumo":
 * quem lê isso é o dono do painel, e as três têm remédios diferentes.
 */
const RECAP_ERROR_KEYS: Record<RecapFailure, MessageKey> = {
  'no-resume': 'core.erro.recap.semResume',
  'transcript-not-found': 'core.erro.recap.semTranscript',
  'recap-empty': 'core.erro.recap.vazio',
};

/** `available()` spawna um processo (`claude --version`, `where.exe`): ~1 s por adaptador. */
const ADAPTER_AVAILABILITY_TTL_MS = 30_000;

type Availability = Awaited<ReturnType<AgentAdapter['available']>>;

/**
 * Todas as rotas de `/api`. Handlers ficam finos de propósito — validação
 * mínima (via `parseBody` + os schemas de `schemas.ts`) e delegação pros
 * deps do core; a lógica de verdade vive em layout.ts/sessions.ts/pty.ts/core.ts.
 */
export function registerRoutes(app: FastifyInstance, core: Core): void {
  // Cache por core (não global): a UI chama `GET /api/adapters` a cada abertura
  // do menu "novo agente" e cada chamada spawnava um processo por adaptador.
  const availabilityCache = new Map<string, { at: number; value: Availability }>();

  /**
   * Quando o último `POST /api/usage/rescan` foi ACEITO (BU-07). Por core, em
   * memória: a trava é contra o laço de quem tem o token, não um contador
   * durável.
   */
  let lastRescanAt = 0;

  async function availability(adapter: AgentAdapter): Promise<Availability> {
    // A chave leva o IDIOMA junto: o `reason` é texto de gente (spec §13), e
    // uma foto em pt-BR não pode sobreviver a um `PATCH` que pediu inglês.
    const lang = core.language();
    const key = `${adapter.id}:${lang}`;
    const cached = availabilityCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < ADAPTER_AVAILABILITY_TTL_MS) return cached.value;
    const value = await adapter.available(lang);
    availabilityCache.set(key, { at: now, value });
    return value;
  }

  app.register(
    async (api) => {
      api.get('/state', async () => snapshotState(core));

      api.post('/workspaces', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(workspaceSchema, req.body, reply, core.language());
        if (!parsed) return;
        if (!cwdExists(parsed.cwd)) {
          reply.code(400).send({ error: t(core.language(), 'core.erro.cwdInvalido') });
          return;
        }
        // Fase 3: o workspace nasce já sabendo repo/branch/worktree do cwd.
        // Dor #2: e já sabendo em QUE ambiente as sessões dele sobem.
        const result = await core.createWorkspace({
          cwd: parsed.cwd,
          name: parsed.name,
          environment: parsed.environment,
        });
        reply.code(201).send(result);
      });

      /**
       * Dor verificada #2 — os ambientes de sessão que ESTA máquina tem:
       * `pwsh`, `powershell`, o Git Bash (se instalado) e cada distro do
       * `wsl.exe -l -q`, cada uma com a resposta de "tem `claude`?" e "tem
       * `node`?". Cache de 60 s no core: o diálogo de novo workspace e o menu
       * de cada linha da sidebar perguntam isso em rajada, e cada distro custa
       * um `wsl.exe`.
       */
      api.get('/environments', async () => ({ environments: await core.environments() }));

      /**
       * Dor verificada #2 — "Ambiente" do menu "⋯" do workspace.
       * `{ environment: null }` volta pro `shell` da configuração global. Vale
       * da PRÓXIMA sessão em diante: PTY vivo não é derrubado por uma escolha
       * de menu.
       */
      api.patch('/workspaces/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const parsed = parseBody(workspacePatchSchema, req.body, reply, core.language());
        if (!parsed) return;
        try {
          // Os dois campos são independentes e podem vir juntos. `undefined` é
          // "não falei disso"; `environment: null` é "volta pro padrão" — e é
          // por isso que a comparação é com `undefined`, não com a verdade do
          // valor.
          //
          // O `zod` já garante que pelo menos um dos dois veio, então
          // `workspace` sempre é atribuído — e um id desconhecido sai como
          // `WorkspaceNotFoundError` do core, no `catch` abaixo.
          let workspace: Workspace | undefined;
          if (parsed.crossAccess !== undefined) {
            workspace = await core.setWorkspaceCrossAccess(req.params.id, parsed.crossAccess);
          }
          if (parsed.environment !== undefined) {
            workspace = await core.setWorkspaceEnvironment(req.params.id, parsed.environment ?? undefined);
          }
          reply.send(workspace);
        } catch (err) {
          if (sendDomainError(core, reply, err)) return;
          throw err;
        }
      });

      api.get('/repos', async () => core.deps.db.repos.list());

      /**
       * BR-03 — "Confiar nos filtros git deste repositório".
       *
       * Enquanto um repo com driver de `filter.*` não é confiado, o Bridge não
       * roda `git status` nele (o `clean` do repositório executaria a cada
       * passada do poller). Esta rota é o único jeito de mudar isso, e é uma
       * decisão do DONO — nenhum caminho automático liga a confiança.
       */
      api.patch('/repos/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const parsed = parseBody(repoTrustSchema, req.body, reply, core.language());
        if (!parsed) return;
        try {
          const repo = await core.setRepoTrustFilters(req.params.id, parsed.trustFilters);
          reply.send(repo);
        } catch (err) {
          if (!sendDomainError(core, reply, err)) throw err;
        }
      });

      /** Drivers de filtro declarados pelo repo — a UI usa pra decidir se mostra o item do menu. */
      api.get('/repos/:id/filters', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        try {
          // Os dois marcadores sintéticos do `git.ts` (`FILTER_ENUM_FAILED`,
          // `SUBMODULE_PATH_INVALID`) são os únicos itens desta lista que são
          // TEXTO e não nome de driver — traduzidos aqui, na borda, pelo mesmo
          // motivo das mensagens de erro.
          const drivers = (await core.repoFilterDrivers(req.params.id)).map((driver) => {
            if (driver === FILTER_ENUM_FAILED) return t(core.language(), 'core.erro.git.enumeracaoFalhou');
            if (driver === SUBMODULE_PATH_INVALID) return t(core.language(), 'core.erro.git.submoduloInvalido');
            return driver;
          });
          reply.send({ drivers });
        } catch (err) {
          if (!sendDomainError(core, reply, err)) throw err;
        }
      });

      /**
       * Usado pelo diálogo "Nova tarefa" pra dizer, na hora em que o usuário
       * escolhe a pasta, se ela é repo e qual é o branch — sem criar nada.
       */
      api.get('/git/detect', async (req: FastifyRequest<{ Querystring: { cwd?: string } }>, reply: FastifyReply) => {
        const cwd = req.query?.cwd;
        if (!cwd) {
          reply.code(400).send({ error: t(core.language(), 'core.erro.informeCwd') });
          return;
        }
        if (!cwdExists(cwd)) {
          reply.code(400).send({ error: t(core.language(), 'core.erro.cwdInvalido') });
          return;
        }
        reply.send(await detectRepo(cwd));
      });

      api.post('/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(taskSchema, req.body, reply, core.language());
        if (!parsed) return;
        try {
          reply.code(201).send(await core.createTask(parsed));
        } catch (err) {
          if (sendDomainError(core, reply, err)) return;
          // Exceção que não é do domínio é BUG do Bridge, não pedido inválido:
          // sai como 500 (o Fastify formata) em vez de virar um 422 que
          // culparia o usuário e esconderia o defeito.
          throw err;
        }
      });

      api.get('/workspaces/:id/git', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        try {
          reply.send(await core.gitStatusOf(req.params.id));
        } catch (err) {
          // Aqui `not-worktree` é 404, não 409: o cliente pediu um RECURSO que
          // este workspace não tem (não existe `+N ~M` de pasta comum) — não é
          // uma ação recusada por estado do repo, como em merge/remoção.
          if (err instanceof NotWorktreeError) {
            reply.code(404).send({ error: errorMessage(err, core.language()), code: err.code });
            return;
          }
          if (sendDomainError(core, reply, err)) return;
          throw err;
        }
      });

      /**
       * R3 — "Definir base…" do menu do workspace: troca o base de um worktree
       * cujo base foi DEDUZIDO (worktree adotado). O core valida que o ref
       * existe antes de gravar.
       */
      api.patch(
        '/workspaces/:id/worktree',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const parsed = parseBody(worktreeBaseSchema, req.body, reply, core.language());
          if (!parsed) return;
          try {
            reply.send(await core.setWorktreeBase(req.params.id, parsed.base));
          } catch (err) {
            if (sendDomainError(core, reply, err)) return;
            throw err;
          }
        },
      );

      api.post(
        '/workspaces/:id/git/refresh',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const workspace = core.deps.db.workspaces.get(req.params.id);
          if (!workspace) {
            reply.code(404).send({ error: t(core.language(), 'core.erro.workspaceNaoEncontrado') });
            return;
          }
          try {
            await core.refreshGit(req.params.id);
            reply.code(204).send();
          } catch (err) {
            if (sendDomainError(core, reply, err)) return;
            throw err;
          }
        },
      );

      api.post('/workspaces/:id/merge', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const parsed = parseBody(mergeSchema, req.body, reply, core.language());
        if (!parsed) return;
        try {
          reply.send(await core.mergeWorkspace(req.params.id, parsed.mode));
        } catch (err) {
          if (sendDomainError(core, reply, err)) return;
          throw err;
        }
      });

      api.delete(
        '/workspaces/:id/worktree',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          try {
            await core.removeWorktree(req.params.id);
            reply.code(204).send();
          } catch (err) {
            if (sendDomainError(core, reply, err)) return;
            throw err;
          }
        },
      );

      api.delete('/workspaces/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = req.params;
        if (!core.deps.db.workspaces.get(id)) {
          reply.code(404).send({ error: t(core.language(), 'core.erro.workspaceNaoEncontrado') });
          return;
        }
        if (sendKillFailure(core, reply, await core.killSessionsOfWorkspace(id))) return;
        core.deps.layout.removeWorkspace(id);
        // O `+N ~M` do workspace fechado não pode ficar no snapshot.
        core.deps.gitStatus.delete(id);
        reply.code(204).send();
      });

      api.post(
        '/workspaces/:id/tabs',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const { id } = req.params;
          const parsed = parseBody(tabSchema, req.body, reply, core.language());
          if (!parsed) return;

          const result = core.deps.layout.createTab(id);
          reply.code(201).send(result);
        },
      );

      api.delete('/tabs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = req.params;
        if (!core.deps.db.tabs.get(id)) {
          reply.code(404).send({ error: t(core.language(), 'core.erro.abaNaoEncontrada') });
          return;
        }
        if (sendKillFailure(core, reply, await core.killSessionsOfTab(id))) return;
        core.deps.layout.removeTab(id);
        reply.code(204).send();
      });

      api.post(
        '/panes/:id/split',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const parsed = parseBody(splitSchema, req.body, reply, core.language());
          if (!parsed) return;
          try {
            if (parsed.adoptTabId !== undefined) {
              // Adoção: não nasce painel, então a resposta é a aba que ficou e
              // a que sumiu — 200, não 201.
              reply.code(200).send(core.deps.layout.adoptTab(req.params.id, parsed.dir, parsed.adoptTabId));
              return;
            }
            const pane = core.deps.layout.splitPane(req.params.id, parsed.dir);
            reply.code(201).send(pane);
          } catch (err) {
            if (err instanceof PaneNotFoundError) {
              reply.code(404).send({ error: errorMessage(err, core.language()) });
              return;
            }
            if (err instanceof TabAdoptError) {
              reply.code(err.code === 'tab-not-found' ? 404 : 409).send({ error: errorMessage(err, core.language()), code: err.code });
              return;
            }
            throw err;
          }
        },
      );

      // Navegação por `Alt+←↑→↓`: a árvore de splits vive no core, então quem
      // sabe qual é o painel ao lado é ele — a UI só pergunta.
      api.get(
        '/panes/:id/neighbor',
        async (req: FastifyRequest<{ Params: { id: string }; Querystring: { dir?: string } }>, reply: FastifyReply) => {
          const dir = req.query?.dir;
          if (!isDirection(dir)) {
            reply.code(400).send({ error: t(core.language(), 'core.erro.dirInvalido', { opcoes: DIRECTIONS.join(' | ') }) });
            return;
          }
          if (!core.deps.db.panes.get(req.params.id)) {
            reply.code(404).send({ error: t(core.language(), 'core.erro.painelNaoEncontrado', { paneId: req.params.id }) });
            return;
          }
          reply.send({ paneId: core.deps.layout.neighbor(req.params.id, dir) ?? null });
        },
      );

      api.post('/panes/:id/ratio', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const parsed = parseBody(ratioSchema, req.body, reply, core.language());
        if (!parsed) return;
        try {
          if (parsed.siblingPaneId) core.deps.layout.setRatioBetween(req.params.id, parsed.siblingPaneId, parsed.ratio);
          else core.deps.layout.setRatio(req.params.id, parsed.ratio);
          reply.code(204).send();
        } catch (err) {
          if (err instanceof PaneNotFoundError) {
            reply.code(404).send({ error: errorMessage(err, core.language()) });
            return;
          }
          throw err;
        }
      });

      api.delete('/panes/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = req.params;
        const session = core.deps.sessions.byPane(id);
        if (session) await core.killSession(session.id);
        core.deps.layout.removePane(id);
        reply.send({});
      });

      /**
       * `bridge resume [paneId]` (Fase 5): sobe de novo, NESTE painel, o
       * agente que rodava aqui, com `claude --resume <lastAgentSessionId>` —
       * o mesmo caminho da restauração da UI (spec §10), só que pedido de
       * fora. Nada de argumento: quem escolhe agente, cwd e conversa é o que
       * o painel guardou, não o cliente.
       *
       * `:id` aceita o literal `current` porque a CLI nem sempre sabe qual é
       * o painel "atual": resolve pela sessão do `X-Bridge-Session` (o
       * comando saiu de dentro de um painel do Bridge) e, fora de uma sessão,
       * pela sessão em foco (`POST /api/focus`).
       *
       * `lastEndedBy` NÃO entra na decisão (ao contrário do restore): quem
       * digitou `bridge resume` está pedindo a conversa de volta na mão.
       *
       * O corpo é a sessão criada + `resumedFrom` (a conversa retomada): o
       * id não está na `Session`, e é ele que a CLI imprime.
       */
      api.post('/panes/:id/resume', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        let paneId = req.params.id;
        if (paneId === 'current') {
          const header = req.headers['x-bridge-session'];
          const fromHeader = typeof header === 'string' ? core.deps.sessions.get(header) : undefined;
          const focusedId = core.deps.notifications.focused.sessionId;
          const fromFocus = focusedId ? core.deps.sessions.get(focusedId) : undefined;
          const resolved = fromHeader?.paneId ?? fromFocus?.paneId;
          if (!resolved) {
            reply.code(404).send({ error: t(core.language(), 'core.erro.painelSemId'), code: 'pane-not-found' });
            return;
          }
          paneId = resolved;
        }

        const pane = core.deps.db.panes.get(paneId);
        if (!pane) {
          reply.code(404).send({
            error: t(core.language(), 'core.erro.painelNaoEncontrado', { paneId }),
            code: 'pane-not-found',
          });
          return;
        }
        // Agente vivo é o único ocupante que barra o resume: dois Claudes no
        // mesmo painel não cabem, e derrubar o que está trabalhando aí seria
        // exatamente o contrário do que o comando promete.
        //
        // Shell HOSPEDEIRO (spec §5) entra na mesma conta: `kind` continua
        // 'shell', mas tem um Claude Code aberto lá dentro — trocar o painel
        // mataria o PTY e o agente junto. Mesmo critério do `runsAgent` da UI e
        // do `replaceableShell` do core, que barra a mesma coisa vindo do
        // `POST /api/sessions`.
        const live = core.deps.sessions.byPane(paneId);
        const alive = live && live.state !== 'exited' ? live : undefined;
        if (alive && (alive.kind === 'agent' || alive.hosted)) {
          reply.code(409).send({ error: t(core.language(), 'core.erro.painelComAgente'), code: 'pane-busy' });
          return;
        }
        const resume = pane.lastAgentSessionId;
        const agent = pane.lastAgent;
        // `lastKind` NÃO entra na condição: o painel que a restauração
        // devolveu como shell tem `lastKind: 'shell'` e continua guardando a
        // conversa (0.7.0, `setPaneLast`) — é justamente esse painel que o
        // `bridge resume` existe pra atender. Quem manda aqui é ter agente e
        // conversa guardados — e o cheque vem antes da chamada ao core porque
        // é barato e não tem nada a ver com subir processo nenhum.
        if (!agent || !resume) {
          reply.code(422).send({ error: t(core.language(), 'core.erro.painelSemConversa'), code: 'nothing-to-resume' });
          return;
        }

        // Shell vivo no painel é o caso NORMAL do `bridge resume`: com o
        // `restore.resumeAgents` desligado (ou com o resume da subida
        // falhando) o painel volta como shell, e é de dentro dele que o
        // comando é digitado. Quem encerra esse shell é o CORE
        // (`replaceLiveShell`), não esta rota: lá o descarte acontece depois
        // de `available()` e da checagem de cwd, então um pedido que vira 422
        // deixa o terminal do usuário de pé — matar aqui, antes da chamada,
        // era exatamente o contrário disso.
        try {
          const session = await core.createSession({
            paneId,
            kind: 'agent',
            agent,
            resume,
            replaceLiveShell: true,
          });
          // O `bridge resume` não passa pela fila (é um clique deliberado num
          // painel só), mas conta pro ritmo do escalonador — ver `noteLaunched`.
          core.deps.launcher.noteLaunched();
          reply.code(201).send({ ...session, resumedFrom: resume });
        } catch (err) {
          const message = errorMessage(err, core.language());
          if (err instanceof PaneNotFoundError) {
            reply.code(404).send({ error: message, code: 'pane-not-found' });
            return;
          }
          // Corrida com um `POST /api/sessions` no mesmo painel (a reserva do
          // core é síncrona, este cheque não): 409, como na rota de sessão.
          if (err instanceof PaneBusyError) {
            reply.code(409).send({ error: message, code: 'pane-busy' });
            return;
          }
          if (err instanceof SessionLaunchError) {
            reply.code(422).send({ error: message, code: err.code });
            return;
          }
          throw err;
        }
      });

      api.post('/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(sessionSchema, req.body, reply, core.language());
        if (!parsed) return;
        const input = {
          paneId: parsed.paneId,
          kind: parsed.kind,
          agent: parsed.agent,
          cwd: parsed.cwd,
          model: parsed.model,
          cols: parsed.cols,
          rows: parsed.rows,
          initialCommand: parsed.initialCommand,
          resume: parsed.resume,
        };
        try {
          /**
           * Dor verificada #1 — o escalonador só olha AGENTE. Shell nunca é
           * enfileirado: ele não fala com servidor nenhum, e a restauração de
           * painel (spec §10) depende de ele subir na hora.
           *
           * O painel é validado ANTES de enfileirar: um 202 pra um `paneId`
           * que não existe seria uma promessa que a fila não tem como cumprir,
           * e o 404 só apareceria minutos depois, no `lastError`.
           */
          if (input.kind === 'agent' && input.agent) {
            const pane = core.deps.db.panes.get(input.paneId);
            const tab = pane ? core.deps.db.tabs.get(pane.tabId) : undefined;
            if (!pane || !tab) throw new PaneNotFoundError(input.paneId);
            // R1 continua valendo ANTES da fila: painel com sessão viva é 409
            // na hora, como sempre foi. Enfileirar aqui trocaria o 409 que a
            // restauração da UI já sabe engolir (`isPaneAlreadyBusy`) por um
            // 202 que só falharia minutos depois, dentro do `lastError`.
            const live = core.deps.sessions.byPane(input.paneId);
            if (live && live.state !== 'exited') throw new PaneBusyError(input.paneId);
            // …e nem com uma criação EM VOO: a reserva do core é síncrona, mas
            // fica dentro do `createSession`, que só roda depois da fila.
            if (core.isPaneCreating(input.paneId)) throw new PaneBusyError(input.paneId);
            const decision = core.deps.launcher.request({
              paneId: input.paneId,
              workspaceId: tab.workspaceId,
              agent: input.agent,
              input,
            });
            if (decision.queued) {
              reply.code(202).send({
                queued: true,
                id: decision.ticket.id,
                position: decision.ticket.position,
                reason: decision.reason,
              });
              return;
            }
            // Quem sobe é o escalonador (é ele que reserva o slot enquanto o
            // `available()` roda); o erro continua vindo por aqui, então os
            // 404/409/422 abaixo seguem valendo.
            reply.code(201).send(await decision.launched);
            return;
          }
          const session = await core.createSession(input);
          reply.code(201).send(session);
        } catch (err) {
          if (err instanceof LauncherQueueFullError) {
            reply.code(429).send({ error: errorMessage(err, core.language()), code: err.code });
            return;
          }
          // Painel que já tem lançamento na fila ou em voo: 409, o mesmo
          // código do painel ocupado — pra UI é a mesma notícia.
          if (err instanceof LauncherPaneQueuedError) {
            reply.code(409).send({ error: errorMessage(err, core.language()), code: err.code });
            return;
          }
          const message = errorMessage(err, core.language());
          if (err instanceof PaneNotFoundError) {
            reply.code(404).send({ error: message, code: 'pane-not-found' });
            return;
          }
          if (err instanceof PaneBusyError) {
            reply.code(409).send({ error: message, code: 'pane-busy' });
            return;
          }
          if (err instanceof SessionLaunchError) {
            reply.code(422).send({ error: message, code: err.code });
            return;
          }
          // Exceção desconhecida é BUG do Bridge (node-pty que não spawna, FS
          // fora do ar), não pedido inválido: 500. Devolver 422 aqui culpava o
          // usuário e escondia o defeito.
          throw err;
        }
      });

      api.post(
        '/sessions/:id/input',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const parsed = parseBody(inputSchema, req.body, reply, core.language());
          if (!parsed) return;
          if (!sessionOr404(core, req.params.id, reply)) return;
          core.deps.pty.write(req.params.id, parsed.data);
          reply.send({});
        },
      );

      api.post(
        '/sessions/:id/resize',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const parsed = parseBody(resizeSchema, req.body, reply, core.language());
          if (!parsed) return;
          core.deps.pty.resize(req.params.id, parsed.cols, parsed.rows);
          reply.send({});
        },
      );

      api.delete('/sessions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        await core.killSession(req.params.id);
        reply.send({});
      });

      api.get('/sessions/:id/scrollback', async (req: FastifyRequest<{ Params: { id: string } }>) => ({
        data: core.deps.pty.scrollback(req.params.id),
      }));

      /**
       * Dor verificada #3 — o resumo da conversa que o `--resume` não trouxe.
       *
       * `POST` e não `GET` porque a leitura não é de graça (abre o transcript
       * daquela conversa no disco) e porque quem a dispara é um BOTÃO —
       * "Reabrir com contexto" —, não um render. O corpo é `{ text }` já
       * sanitizado e em UMA linha: quem escreve no PTY é a UI, e uma quebra
       * de linha ali dentro seria um Enter no meio do resumo.
       *
       * Os três "não deu" são respostas legítimas, não bugs: a sessão não
       * pediu resume (`no-resume`, 422), o transcript daquela conversa não
       * está mais no disco (`transcript-not-found`, 404) ou não sobrou texto
       * aproveitável nele (`recap-empty`, 422).
       */
      api.post('/sessions/:id/recap', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        if (!sessionOr404(core, req.params.id, reply)) return;
        const result = await core.sessionRecap(req.params.id);
        if (result.text === undefined) {
          const code = result.reason ?? 'recap-empty';
          reply.code(code === 'transcript-not-found' ? 404 : 422).send({ error: t(core.language(), RECAP_ERROR_KEYS[code]), code });
          return;
        }
        reply.send({ text: result.text });
      });

      /**
       * Dor verificada #1 — o estado do escalonador: teto, ativos, quantos
       * estão estrangulados pelo servidor, o espaçamento em vigor e a fila.
       *
       * É a MESMA forma que o evento `launcher.changed` carrega: a UI busca
       * uma vez por conexão e depois só escuta, do jeito que já faz com as
       * janelas de limite.
       */
      api.get('/launcher', async () => core.deps.launcher.status());

      /**
       * "Lançar agora" — solta um lançamento da fila ignorando o escalonador
       * UMA vez. Sem `id`, o primeiro da fila.
       */
      api.post('/launcher/launch-now', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(launchNowSchema, req.body ?? {}, reply, core.language());
        if (!parsed) return;
        const launched = core.deps.launcher.launchNow(parsed.id);
        if (!launched) {
          reply.code(404).send({
            error: parsed.id
              ? t(core.language(), 'core.erro.lancamentoNaoEstaNaFilaComId', {
                  id: sanitizeDisplay(parsed.id, ECHO_MAX),
                })
              : t(core.language(), 'core.erro.filaVazia'),
            code: parsed.id ? 'launch-not-found' : 'queue-empty',
          });
          return;
        }
        reply.send(launched);
      });

      /** Tira um lançamento da fila sem subir nada (o painel mudou de ideia). */
      api.delete('/launcher/pending/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        if (!core.deps.launcher.cancel(req.params.id)) {
          reply.code(404).send({ error: t(core.language(), 'core.erro.lancamentoNaoEstaNaFila'), code: 'launch-not-found' });
          return;
        }
        reply.send({});
      });

      api.post(
        '/sessions/:id/notify',
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          const parsed = parseBody(notifySchema, req.body, reply, core.language());
          if (!parsed) return;
          if (!sessionOr404(core, req.params.id, reply)) return;
          core.deps.notifications.push(req.params.id, 'custom', parsed.text);
          reply.send({});
        },
      );

      api.post('/focus', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(focusSchema, req.body, reply, core.language());
        if (!parsed) return;
        // `reveal` só faz sentido com uma sessão; e ela precisa existir, senão
        // o `bridge focus <id morto>` diria "em foco" e a UI não teria pra
        // onde ir. Validado ANTES de mexer no `focused`: um 404 não pode
        // deixar meio pedido aplicado.
        const revealId = parsed.reveal ? parsed.sessionId : undefined;
        if (revealId !== undefined && !sessionOr404(core, revealId, reply)) return;
        // `focused` acompanha foco E blur (é o que decide se o toast dispara).
        // Já "olhar" a sessão — tirar do `done` e marcar as notificações dela
        // como lidas — só vale com a janela em foco: um blur não é leitura.
        core.deps.notifications.focused = {
          sessionId: parsed.sessionId,
          windowFocused: parsed.windowFocused,
          at: Date.now(),
        };
        if (parsed.sessionId && parsed.windowFocused) {
          core.deps.sessions.focus(parsed.sessionId);
          core.deps.notifications.markReadForSession(parsed.sessionId);
        }
        // O pedido veio de fora da janela (`bridge focus`): a UI principal
        // precisa ser LEVADA até a sessão — workspace, aba, painel —, porque
        // o foco marcado aqui em cima não muda o que está na tela.
        if (revealId !== undefined) core.deps.bus.emit({ type: 'session.reveal', id: revealId });
        reply.send({});
      });

      api.get('/notifications', async (req: FastifyRequest<{ Querystring: { limit?: string } }>) => {
        const raw = Number(req.query?.limit);
        const limit = Number.isFinite(raw) && raw > 0 ? raw : 50;
        return core.deps.db.notifications.list(limit);
      });

      api.get('/notifications/latest-unread', async () => core.deps.notifications.latestUnread() ?? null);

      api.post('/notifications/read', async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = parseBody(notificationsReadSchema, req.body, reply, core.language());
        if (!parsed) return;
        core.deps.notifications.markRead(parsed.ids);
        reply.send({});
      });

      // Lido a cada pedido: editar o keybindings.json não exige reiniciar.
      // `problems` só aparece quando há o que avisar — arquivo impecável (ou
      // ausente) responde exatamente a tabela de atalhos, como sempre.
      api.get('/keybindings', async () =>
        loadKeybindingsWithProblems(core.deps.profile, core.deps.log.child('keybindings')),
      );

      // ------------------------------------------------------ uso (ADR-012)

      /**
       * O relatório de consumo do período pedido.
       *
       * - `?range=day|week|month|year` — default `day`. `week` é segunda a
       *   domingo locais; `month`/`year` são os civis locais; a borda do dia é
       *   a meia-noite LOCAL (decisão do dono);
       * - `&anchor=AAAA-MM-DD` — o período é o que CONTÉM a âncora (default
       *   hoje). Sem ela a resposta é idêntica à de antes do parâmetro existir;
       * - `?range=custom&from=AAAA-MM-DD&to=AAAA-MM-DD` — intervalo livre,
       *   inclusive, até `MAX_USAGE_RANGE_DAYS` dias; `to` no futuro é preso em
       *   hoje;
       * - `?tz=America/Sao_Paulo` — **existe pros testes**, que precisam
       *   atravessar meia-noite e virada de mês sem depender da máquina de
       *   quem roda a suíte. O produto usa o fuso do processo; um `tz` que o
       *   `Intl` não conhece é 400 em vez de virar UTC calado.
       *
       * Período ruim é 400 com `invalid-anchor` ou `invalid-period` — data que
       * o calendário não tem, antes de `MIN_USAGE_DAY`, começando no futuro,
       * invertida, longa demais, ou parâmetro que não combina com o `range`.
       * Nada disso vira default calado: um relatório de outro período que a
       * pessoa não pediu é um número errado que parece certo.
       *
       * A resposta inclui `byDay` sempre (ver `chartBounds`: o próprio período
       * quando ele tem 30 dias ou mais até hoje, senão os 30 dias terminando
       * nele) porque é a série do gráfico, e `pricingWarnings` com os modelos
       * que ficaram de fora do custo — um total que ignora metade do consumo
       * sem dizer isso seria pior que um total ausente.
       */
      api.get(
        '/usage',
        async (
          req: FastifyRequest<{ Querystring: { range?: string; tz?: string; anchor?: string; from?: string; to?: string } }>,
          reply: FastifyReply,
        ) => {
          const rawRange = req.query?.range ?? 'day';
          if (!(USAGE_RANGES as readonly string[]).includes(rawRange)) {
            reply
              .code(400)
              .send({
                error: t(core.language(), 'core.erro.rangeInvalido', { opcoes: USAGE_RANGES.join(', ') }),
                code: 'invalid-range',
              });
            return;
          }
          const tz = req.query?.tz?.trim();
          if (tz && !isValidTimeZone(tz)) {
            // BU-16: o eco volta pela CLI, que imprime a mensagem CRUA no
            // terminal. Limpo e cortado — o dado que interessa é "qual fuso",
            // não 5 000 caracteres com ANSI dentro.
            reply
              .code(400)
              .send({
                error: t(core.language(), 'core.erro.fusoDesconhecido', { tz: sanitizeDisplay(tz, ECHO_MAX) }),
                code: 'invalid-tz',
              });
            return;
          }
          const resolved = core.deps.usage.period(req.query ?? {}, { tz: tz || undefined });
          if (!resolved.ok) {
            // BU-16 de novo: `anchor`/`from`/`to` voltam ECOADOS na frase, e a
            // CLI imprime a frase crua no terminal. Todo parâmetro de texto
            // passa pelo mesmo corte do `tz` antes de entrar na mensagem.
            const params: Record<string, string | number> = {};
            for (const [k, v] of Object.entries(resolved.params)) {
              params[k] = typeof v === 'string' ? sanitizeDisplay(v, ECHO_MAX) : v;
            }
            reply.code(400).send({ error: t(core.language(), resolved.key, params), code: resolved.code });
            return;
          }
          // A query vai de novo LIMPA: o período resolvido carrega `from`/`to`
          // também no recorte ancorado, e mandá-lo cru faria o `report` recusar
          // a combinação que a própria validação proíbe. Com a âncora fixada
          // aqui, uma virada de meia-noite entre as duas chamadas não troca o
          // período debaixo do pedido.
          const p = resolved.period;
          const query = p.range === 'custom' ? { range: p.range, from: p.from, to: p.to } : { range: p.range, anchor: p.anchor };
          reply.send(core.deps.usage.report(query, { tz: tz || undefined }));
        },
      );

      /**
       * Só as janelas vivas (5 h, semana, e o que mais vier). Separada do
       * `/usage` porque a faixa da sidebar precisa DELAS e de mais nada: pedir
       * o relatório inteiro pra desenhar duas barras faria o core agregar um
       * mês de consumo a cada abertura de janela.
       *
       * Lista VAZIA é resposta legítima: conta de API key não recebe
       * `rate_limits` no payload da statusline. A UI mostra "sem limites a
       * exibir", não duas barras zeradas.
       */
      api.get('/usage/limits', async () => ({ limits: core.deps.usage.limits() }));

      /**
       * Relê TODOS os transcripts do zero (botão "Reler transcripts").
       *
       * Zera as contagens e os marcadores antes de varrer: a varredura normal
       * SOMA deltas, então reler sem zerar dobraria o histórico. É a saída
       * para os dois casos em que o incremental pode ter errado — um
       * transcript reescrito por fora e uma tabela de preços corrigida depois
       * do fato.
       *
       * Responde só quando terminou (a UI mostra o botão ocupado): devolver
       * 202 deixaria o painel relendo um estado a meio caminho.
       */
      api.post('/usage/rescan', async (_req: FastifyRequest, reply: FastifyReply) => {
        // BU-07, duas travas. A UI já desabilita o botão enquanto ocupada; o
        // que está sendo defendido é o caminho de quem NÃO é a UI. O custo de
        // um rescan é proporcional ao histórico inteiro (12,8 GB na máquina do
        // autor), não ao pedido — um `POST` de 100 bytes vira a releitura da
        // árvore toda, e entre o `reset()` e o fim da varredura o painel
        // responde ZERO.
        if (core.deps.usage.rescanning()) {
          reply.code(409).send({ error: t(core.language(), 'core.erro.releituraEmAndamento'), code: 'rescan-in-flight' });
          return;
        }
        const agora = Date.now();
        const desde = agora - lastRescanAt;
        if (desde < RESCAN_COOLDOWN_MS) {
          const retryAfter = Math.ceil((RESCAN_COOLDOWN_MS - desde) / 1000);
          reply
            .code(429)
            .header('retry-after', String(retryAfter))
            .send({
              error: t(core.language(), 'core.erro.releituraCooldown', { s: RESCAN_COOLDOWN_MS / 1000 }),
              code: 'rescan-cooldown',
              retryAfter,
            });
          return;
        }
        lastRescanAt = agora;
        const result = await core.deps.usage.rescan();
        // O evento sai SEMPRE, mesmo sem dia tocado: uma reconstrução que só
        // remove dias (transcrição apagada por fora, preço corrigido pra
        // menos) não toca nenhum, e o painel ficaria com os números velhos na
        // tela depois de um botão que diz ter relido tudo.
        core.deps.bus.emit({
          type: 'usage.changed',
          rescanned: true,
          ...(result.dailyTouched.length > 0 ? { dailyTouched: result.dailyTouched } : {}),
        });
        reply.send({ files: result.filesScanned, entries: result.entries, days: result.dailyTouched.length });
      });

      /** A configuração em vigor (spec §5) — é o que o diálogo "Configurações" abre. */
      api.get('/config', async () => core.config());

      /**
       * Muda um subconjunto da configuração (spec §5). Três respostas:
       *
       * - `403 read-only` quando o corpo traz `port`, `profileDir`,
       *   `claudeHome` ou `languageResolved`. É 403 e não 400 porque o pedido
       *   é bem formado: o que falta é permissão pra mexer neles pela API
       *   (mudar a porta com o servidor no ar não reabre socket nenhum; os
       *   outros TRÊS são derivados, não guardados — o `languageResolved` é o
       *   `ui.language` cruzado com a locale da máquina, e quem quer trocar de
       *   idioma manda `ui.language`). Vem ANTES da validação, senão sairia um
       *   400 genérico de "campo desconhecido", que não explica nada;
       * - `400 invalid-config` pra valor fora de faixa, tipo errado ou campo
       *   que não existe;
       * - `200` com a configuração inteira já aplicada — a MESMA que vai no
       *   `config.changed`, pra quem fez o PATCH não depender do WS.
       */
      api.patch('/config', async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const readOnly = READ_ONLY_CONFIG_FIELDS.filter((field) => field in body);
        if (readOnly.length > 0) {
          reply
            .code(403)
            .send({
              error: t(core.language(), 'core.erro.somenteLeitura', { campos: readOnly.join(', ') }),
              code: 'read-only',
              fields: readOnly,
            });
          return;
        }

        const parsed = configPatchSchema.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const lang = core.language();
          const path = issue && issue.path.length > 0 ? issue.path.join('.') : t(lang, 'core.erro.corpoCaminho');
          reply.code(400).send({
            error: t(lang, 'core.erro.configInvalida', { caminho: path, motivo: issueMessage(issue, lang) }),
            code: 'invalid-config',
          });
          return;
        }

        reply.send(core.updateConfig(parsed.data));
      });

      /**
       * R4 — encerramento gracioso do core (o shell chama antes do taskkill).
       * Responde 202 ANTES de parar: o `core.stop()` fecha o próprio Fastify,
       * então uma resposta depois dele nunca sairia do socket. O trabalho de
       * verdade (matar sessões, `clearInstance`, `log.flush`) roda no tick
       * seguinte, e só então o processo sai.
       */
      api.post('/shutdown', async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.code(202).send({ stopping: true });
        setImmediate(() => {
          void core
            .stop()
            .catch(() => {
              // Encerramento é caminho sem volta: nada a fazer com o erro além
              // de sair mesmo assim (o shell ainda tem o taskkill de reserva).
            })
            .finally(() => core.deps.onShutdown());
        });
      });

      api.get('/adapters', async () => {
        const list = Object.values(core.deps.adapters);
        return Promise.all(list.map(async (a) => ({ id: a.id, label: a.label, available: await availability(a) })));
      });
    },
    { prefix: '/api' },
  );
}
