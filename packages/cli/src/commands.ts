/**
 * Um comando, uma função: recebe o cliente já autenticado + os argumentos já
 * separados por `index.ts`, devolve `{ human, json }` — quem decide qual dos
 * dois imprimir é a borda (`--json`), não o comando.
 */
import type { HelloState, Pane, QueuedLaunch, Repo, Session, Workspace } from '@bridge/shared';
import { parseEnvironmentId, t, type Language } from '@bridge/shared';
import type { Client } from './client.js';
import { CliError } from './client.js';
import { findWorkspace, firstTerminalPane, resolveFocusSessionId } from './resolve.js';

/**
 * Substituído em tempo de build pelo `define` do `esbuild.config.mjs` — o
 * `version` do `package.json` deste pacote é a fonte única (fix round 1:
 * antes vivia hardcoded aqui, podendo divergir do `package.json`). O `declare`
 * não gera código nenhum; só a referência abaixo é que o esbuild substitui.
 */
declare const __CLI_VERSION__: string;
/**
 * O `typeof` protege o caminho SEM build: `tsx src/index.ts` (ou um import
 * direto deste módulo num teste) não passa pelo `define` do esbuild, e a
 * referência crua a `__CLI_VERSION__` viraria `ReferenceError` antes de
 * qualquer comando rodar. No bundle o esbuild substitui os dois lados e o
 * `typeof "0.4.0" !== 'undefined'` dobra pra constante.
 */
export const CLI_VERSION = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : 'dev';

export interface Flags {
  [name: string]: string | boolean | undefined;
}

export interface Ctx {
  client: Client;
  env: NodeJS.ProcessEnv;
  /**
   * O idioma de TODA saída humana deste comando (spec §13), resolvido uma vez
   * na borda (`resolveCliLanguage`). O `--json` não o consulta: aquele caminho
   * é máquina lendo máquina.
   */
  lang: Language;
  /**
   * `usage.showCost` do core — do MESMO `GET /api/config` que trouxe o idioma.
   * Está aqui, e não dentro do `bridge usage`, porque o processo já pagou a
   * chamada: pedir a mesma rota duas vezes pra ler um booleano era o defeito
   * apontado no fix round 1. `true` quando o core não respondeu — o default do
   * produto é MOSTRAR.
   */
  showCost: boolean;
}

export interface CommandResult {
  human: string;
  json: unknown;
}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true || typeof flags[name] === 'string';
}

/**
 * Fix round 1 (minor): flag que nenhum comando declara vira erro em vez de
 * ser ignorada em silêncio — `bridge task new . x --forca` sem isto criaria a
 * tarefa mesmo assim, escondendo o typo de quem digitou. `--json` nunca passa
 * por aqui: o parser já tira ele de `flags` antes de chegar num comando.
 */
function assertKnownFlags(flags: Flags, allowed: string[]): void {
  const known = new Set(allowed);
  for (const name of Object.keys(flags)) {
    if (!known.has(name)) throw new CliError({ key: 'cli.erro.flagDesconhecida', params: { flag: name } });
  }
}

/** `"3s" | "4min" | "2h"` — o "há quanto tempo" da tabela de `bridge list`. */
function humanElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  return `${h}h`;
}

/** Tabela simples alinhada por coluna — sem dependência de terminal nenhuma. */
function table(headers: string[], rows: string[][], lang: Language): string {
  if (rows.length === 0) return t(lang, 'cli.tabela.vazio');
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}

function workspaceName(state: HelloState, workspaceId: string): string {
  return state.layout.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
}

/** Teto do texto de notificação — o mesmo do `notifySchema` do core (BR-12). */
export const NOTIFY_TEXT_MAX = 2000;

export function truncateNotifyText(text: string): string {
  if (text.length <= NOTIFY_TEXT_MAX) return text;
  let cut = text.slice(0, NOTIFY_TEXT_MAX - 1);
  // O corte por UNIDADE DE CODIGO pode partir um par substituto ao meio (emoji,
  // ideograma fora do BMP): o high surrogate solto vira U+FFFD na tela. Se a
  // ultima unidade for um high surrogate sem par, ela sai.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export async function cmdNotify(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, ['session']);
  // Fix round 1: junta os positionals restantes em vez de só `positionals[0]`
  // — sem isso, `bridge notify sem aspas` perdia tudo depois da primeira
  // palavra. Texto que começa com `--` precisa do terminador do parser
  // (`bridge notify -- "--urgente: build quebrou"`), documentado no README.
  const raw = positionals.join(' ');
  if (!raw) throw new CliError({ key: 'cli.uso.notify' });
  // Re-review do BR-12: o core recusa texto acima do teto com 400 (a API crua
  // tem que dizer "não"), mas quem digitou `bridge notify "$(cat log.txt)"`
  // merece a notificação truncada, não um erro. O corte é AQUI, no cliente.
  const text = truncateNotifyText(raw);
  const sessionId = flagString(flags, 'session') ?? ctx.env.BRIDGE_SESSION;
  if (!sessionId) throw new CliError({ key: 'cli.notify.semSessao' });
  await ctx.client.post(`/api/sessions/${encodeURIComponent(sessionId)}/notify`, { text });
  const human =
    text === raw
      ? t(ctx.lang, 'cli.notify.enviada')
      : t(ctx.lang, 'cli.notify.enviadaCortada', { max: NOTIFY_TEXT_MAX });
  return { human, json: { ok: true, sessionId, text, truncated: text !== raw } };
}

export async function cmdList(ctx: Ctx, flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const state = await ctx.client.get<HelloState>('/api/state');
  const now = Date.now();
  const rows = state.sessions.map((s) => [
    s.id,
    workspaceName(state, s.workspaceId),
    s.state,
    s.detail ?? '',
    humanElapsed(now - s.stateSince),
  ]);
  return {
    human: table(
      [
        t(ctx.lang, 'cli.list.cabecalho.id'),
        t(ctx.lang, 'cli.list.cabecalho.workspace'),
        t(ctx.lang, 'cli.list.cabecalho.estado'),
        t(ctx.lang, 'cli.list.cabecalho.detail'),
        t(ctx.lang, 'cli.list.cabecalho.idade'),
      ],
      rows,
      ctx.lang,
    ),
    json: state.sessions,
  };
}

export async function cmdFocus(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const target = positionals[0];
  if (!target) throw new CliError({ key: 'cli.uso.focus' });
  const state = await ctx.client.get<HelloState>('/api/state');
  const sessionId = resolveFocusSessionId(state, target);
  // `reveal`: o core avisa a UI (`session.reveal`) e a janela principal vai
  // até a sessão — workspace, aba e painel. Sem isso o comando só marcava o
  // foco no core e a tela continuava onde estava.
  await ctx.client.post('/api/focus', { sessionId, windowFocused: true, reveal: true });
  return { human: t(ctx.lang, 'cli.focus.emFoco', { sessionId }), json: { ok: true, sessionId } };
}

export async function cmdNew(ctx: Ctx, flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, ['agent', 'cwd', 'workspace', 'split', 'env']);

  const splitArg = flagString(flags, 'split');
  if (splitArg !== undefined && splitArg !== 'v' && splitArg !== 'h') {
    throw new CliError({ key: 'cli.new.splitInvalido', params: { valor: splitArg } });
  }

  /**
   * Dor verificada #2 — `bridge new --env wsl:Ubuntu`.
   *
   * O ambiente é propriedade do WORKSPACE, então a flag grava nele
   * (`PATCH /api/workspaces/:id`) ANTES de criar a sessão: é o que faz o painel
   * novo já subir dentro da distro. `--env padrao` volta pro shell da
   * configuração global.
   *
   * A recusa acontece aqui, antes de qualquer chamada: um `--env ubunto` que
   * só falhasse no servidor já teria dividido o painel.
   */
  const envArg = flagString(flags, 'env');
  const envIsDefault = envArg !== undefined && ['padrao', 'padrão', 'default', ''].includes(envArg.trim().toLowerCase());
  const environment = envArg !== undefined && !envIsDefault ? parseEnvironmentId(envArg) : undefined;
  if (envArg !== undefined && !envIsDefault && !environment) {
    throw new CliError({ key: 'cli.new.envInvalido', params: { valor: envArg } });
  }

  const state = await ctx.client.get<HelloState>('/api/state');

  const workspaceArg = flagString(flags, 'workspace');
  const workspace = workspaceArg
    ? findWorkspace(state, workspaceArg)
    : (() => {
        const currentSessionId = ctx.env.BRIDGE_SESSION;
        const current = currentSessionId ? state.sessions.find((s) => s.id === currentSessionId) : undefined;
        const byCurrent = current
          ? state.layout.workspaces.find((w) => w.id === current.workspaceId)
          : undefined;
        const fallback = byCurrent ?? state.layout.workspaces[0];
        if (!fallback) throw new CliError({ key: 'cli.new.semWorkspace' });
        return fallback;
      })();

  /*
   * O ambiente vira propriedade do workspace ANTES do split — a sessão criada
   * logo abaixo tem que nascer nele —, mas o `bridge new` é um comando SÓ: se
   * o split ou a sessão falharem (`claude` fora do PATH da distro, painel
   * ocupado), o workspace não pode ficar com um ambiente novo que o dono nunca
   * viu funcionar. Falhou, volta ao que era.
   */
  const previousEnvironment = workspace.environment ?? null;
  if (envArg !== undefined) {
    await ctx.client.patch<Workspace>(`/api/workspaces/${workspace.id}`, { environment: environment ?? null });
  }

  const agent = flagString(flags, 'agent');
  const cwd = flagString(flags, 'cwd');
  let created: Session | QueuedLaunch;
  let newPane: Pane;
  try {
    const basePane = firstTerminalPane(state, workspace);
    const dir = splitArg === 'h' ? 'h' : 'v';
    newPane = await ctx.client.post<Pane>(`/api/panes/${basePane.id}/split`, { dir });
    created = await ctx.client.post<Session | QueuedLaunch>('/api/sessions', {
      paneId: newPane.id,
      kind: agent ? 'agent' : 'shell',
      agent,
      cwd,
    });
  } catch (err) {
    if (envArg !== undefined) {
      // Best effort: o erro que o usuário precisa ver é o de cima, não o de
      // uma reversão que também falhou.
      await ctx.client
        .patch<Workspace>(`/api/workspaces/${workspace.id}`, { environment: previousEnvironment })
        .catch(() => undefined);
    }
    throw err;
  }

  const where =
    envArg === undefined
      ? ''
      : t(ctx.lang, 'cli.new.ambiente', {
          ambiente: environment ? envArg : t(ctx.lang, 'cli.new.ambientePadrao'),
        });

  /**
   * Dor verificada #1 — o escalonador pode ter segurado o lançamento (202).
   *
   * O painel JÁ existe (o split aconteceu), então dizer "Sessão … criada"
   * aqui seria mentira: não há sessão nenhuma ainda. O `--json` devolve o
   * `QueuedLaunch` cru, que é o que um script precisa pra decidir se espera ou
   * se chama `POST /api/launcher/launch-now`.
   */
  if ('queued' in created) {
    return {
      human: t(ctx.lang, 'cli.new.enfileirada', {
        posicao: created.position,
        workspace: workspace.name,
        onde: where,
      }),
      json: created,
    };
  }

  return {
    human: t(ctx.lang, 'cli.new.criada', {
      id: created.id,
      tipo: created.kind,
      workspace: workspace.name,
      onde: where,
    }),
    json: created,
  };
}

export async function cmdTaskNew(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, ['base', 'no-agent']);
  const repoArg = positionals[0];
  const name = positionals[1];
  if (!repoArg || !name) throw new CliError({ key: 'cli.uso.taskNew' });

  const repos = await ctx.client.get<Repo[]>('/api/repos');
  const match = repos.find((r) => r.id === repoArg);
  const body: Record<string, unknown> = {
    name,
    base: flagString(flags, 'base'),
    agent: flagBool(flags, 'no-agent') ? undefined : 'claude',
  };
  if (match) body.repoId = match.id;
  else body.repoPath = repoArg;

  const created = await ctx.client.post<{ workspace: { id: string; name: string; worktree?: { path: string } } }>(
    '/api/tasks',
    body,
  );
  const path = created.workspace.worktree?.path;
  return {
    human: t(ctx.lang, 'cli.task.criada', {
      nome: created.workspace.name,
      onde: path ? t(ctx.lang, 'cli.task.criadaEm', { caminho: path }) : '',
    }),
    json: created,
  };
}

export async function cmdTaskMerge(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, ['no-ff']);
  const workspaceArg = positionals[0];
  if (!workspaceArg) throw new CliError({ key: 'cli.uso.taskMerge' });
  const state = await ctx.client.get<HelloState>('/api/state');
  const workspace = findWorkspace(state, workspaceArg);
  const mode = flagBool(flags, 'no-ff') ? 'no-ff' : 'ff-only';
  try {
    const result = await ctx.client.post<{ mode: string; message?: string }>(
      `/api/workspaces/${workspace.id}/merge`,
      { mode },
    );
    return {
      human: t(ctx.lang, 'cli.task.mergeConcluido', {
        modo: result.mode,
        workspace: workspace.name,
        detalhe: result.message ? t(ctx.lang, 'cli.task.mergeDetalhe', { mensagem: result.message }) : '',
      }),
      json: result,
    };
  } catch (err) {
    // `code: 'not-ff'` (409) é o único caso em que a CLI oferece o próximo
    // passo de propósito: é literalmente a flag que falta na linha de
    // comando, não uma decisão que o usuário tenha que ir descobrir em outro
    // lugar. Os outros códigos (`conflict`, `base-not-checked-out`,
    // `base-in-use`, `no-commits`, `invalid-name`, …) já chegam com `error`
    // pt-BR completo do core — repassa como está.
    if (err instanceof CliError && err.code === 'not-ff' && mode === 'ff-only') {
      // O `{erro}` é a frase do CORE, que já veio no idioma certo — quem
      // resolve o idioma da resposta é ele. Aqui só se acrescenta o próximo passo.
      throw new CliError(
        { key: 'cli.task.tenteNoFf', params: { erro: err.message, workspace: workspaceArg } },
        err.exitCode,
        err.code,
      );
    }
    throw err;
  }
}

export async function cmdTaskRm(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const workspaceArg = positionals[0];
  if (!workspaceArg) throw new CliError({ key: 'cli.uso.taskRm' });
  const state = await ctx.client.get<HelloState>('/api/state');
  const workspace = findWorkspace(state, workspaceArg);
  await ctx.client.del(`/api/workspaces/${workspace.id}/worktree`);
  return {
    human: t(ctx.lang, 'cli.task.worktreeRemovido', { workspace: workspace.name }),
    json: { ok: true, workspaceId: workspace.id },
  };
}

/**
 * `bridge resume [paneId]` — sobe de novo, no painel, o agente que rodava ali
 * (`claude --resume <conversa>`). Quem escolhe agente, cwd e conversa é o
 * painel (`lastKind`/`lastAgent`/`lastAgentSessionId`), não a linha de
 * comando: a CLI só diz QUAL painel.
 *
 * Sem argumento vai o literal `current` — o core resolve pela sessão do
 * `X-Bridge-Session` (o comando saiu de dentro de um painel do Bridge) e,
 * fora de uma sessão, pela sessão em foco. Resolver do lado do core evita a
 * CLI ter que adivinhar o painel a partir de um snapshot que já pode estar
 * velho quando o POST chega.
 *
 * **A frase de sucesso pode não aparecer** quando o comando é digitado no
 * shell DO painel que está sendo retomado: o core encerra esse shell pra o
 * agente entrar, e o `bridge` morre junto com o PTY antes de a resposta
 * chegar. Escrever a frase ANTES do POST não resolveria: (a) o texto depende
 * da resposta (a conversa retomada e o painel resolvido), (b) o pedido ainda
 * pode virar 409/422 — a frase seria mentira —, e (c) o scrollback da sessão
 * morta é descartado quando o painel é reaproveitado, então nem o que já
 * tinha sido escrito sobraria na tela. O retorno visível é o painel virando o
 * agente; `bridge resume <outroPaneId>` (de outro painel) imprime normal.
 */
export async function cmdResume(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const paneId = positionals[0] ?? 'current';
  try {
    const session = await ctx.client.post<Session & { resumedFrom: string }>(
      `/api/panes/${encodeURIComponent(paneId)}/resume`,
    );
    const conversa = session.resumedFrom.slice(0, 8);
    return {
      human: t(ctx.lang, 'cli.resume.retomando', { conversa, paneId: session.paneId }),
      json: session,
    };
  } catch (err) {
    // `pane-busy` é o único código que ganha um próximo passo: o painel já
    // está com um AGENTE vivo (shell o core substitui sozinho), e a saída é
    // escolher outro painel. Mesma regra do `not-ff` no `task merge`: código
    // conhecido, dica concreta.
    if (err instanceof CliError && err.code === 'pane-busy') {
      throw new CliError(
        { key: 'cli.resume.outroPainel', params: { erro: err.message } },
        err.exitCode,
        err.code,
      );
    }
    throw err;
  }
}

export async function cmdSend(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const sessionId = positionals[0];
  // Fix round 1: junta o resto dos positionals (igual `notify`) — o texto do
  // painel pode ter espaço sem aspas, e `--` continua liberando texto que
  // começa com `--`.
  const text = positionals.slice(1).join(' ');
  if (!sessionId || positionals.length < 2) throw new CliError({ key: 'cli.uso.send' });
  await ctx.client.post(`/api/sessions/${encodeURIComponent(sessionId)}/input`, { data: `${text}\r` });
  return { human: t(ctx.lang, 'cli.send.enviado'), json: { ok: true } };
}

export async function cmdStatus(ctx: Ctx, flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, []);
  const state = await ctx.client.get<HelloState>('/api/state');
  const port = ctx.client.port;
  return {
    human: t(ctx.lang, 'cli.status.ativo', {
      porta: port,
      sessoes: state.sessions.length,
      versao: CLI_VERSION,
    }),
    json: { alive: true, port, sessions: state.sessions.length, version: CLI_VERSION },
  };
}
