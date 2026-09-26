import { execFile, execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { type Language, sanitizeDisplay, t } from '@bridge/shared';
import type { Session } from '../model.js';
import { DEFAULT_CONFIG } from '../profile.js';
import { quotaFromPayload, statusLine } from '../quota.js';
import type { EnvContext } from '../environments.js';
import type { StateChange } from '../sessions.js';
import { shQuote } from '../environments.js';
import { asBoolean, asRecord, asString } from './payload.js';
import { baseEnv, wslArgs } from './shell.js';
import type { AgentAdapter, HookOutcome, LaunchCtx, LaunchSpec, StatusLineResult } from './types.js';

export const CLAUDE_PLAIN_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const;

export const CLAUDE_TOOL_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

// .cmd files (like the npm-installed claude.cmd) cannot be exec'd directly via
// CreateProcess on Windows — they need cmd.exe to interpret them. The PTY layer
// checks this flag and spawns claude through `cmd.exe /c` when resolveClaudeBin()
// returns a .cmd path.
export const CLAUDE_NEEDS_SHELL = true;

/**
 * A linha que o Claude Code executa a cada hook/statusline.
 *
 * No Windows é `"<node.exe>" "<shim>" <sessão> <evento>`.
 *
 * Dentro de uma distro WSL quem executa o shim é **o mesmo `node.exe` do
 * Windows**, alcançado por interop (`/mnt/c/.../node.exe`), e não o `node` da
 * distro — mesmo quando ela tem um. O motivo é o único que importa aqui: o
 * shim precisa POSTar em `127.0.0.1:<porta>` do core, e o loopback do WSL2
 * **não** é compartilhado com o Windows no modo de rede padrão (NAT); de
 * dentro da distro, `127.0.0.1` é a própria distro. Rodando pelo `node.exe`, o
 * processo do shim é um processo do Windows e enxerga o loopback do host.
 *
 * Por isso o CAMINHO DO SHIM vai em forma de **Windows** (`C:\\...`): o interop
 * repassa o argv sem tradução nenhuma, e um `/mnt/c/...` chegaria ao `node.exe`
 * como arquivo inexistente. Só o `node.exe` em si é referido por `/mnt/c`,
 * porque quem o localiza é o kernel da distro.
 *
 * As aspas mudam junto: a linha do hook é interpretada por `cmd.exe` no
 * Windows e por um shell POSIX na distro. Tudo é citado — inclusive `sessionId`
 * e `event`, que hoje são seguros por construção (ids do Bridge e nomes de
 * evento do adaptador), mas não custam nada.
 */
export function hookCommand(shimPath: string, sessionId: string, event: string, env?: EnvContext): string {
  if (env?.kind === 'wsl' && env.nodeCommand) {
    return `${shQuote(env.nodeCommand)} ${shQuote(shimPath)} ${shQuote(sessionId)} ${shQuote(event)}`;
  }
  return `"${process.execPath}" "${shimPath}" ${sessionId} ${event}`;
}

export function buildClaudeSettings(ctx: LaunchCtx): object {
  const hooks: Record<string, unknown> = {};
  const command = (event: string): string => hookCommand(ctx.shimPath, ctx.sessionId, event, ctx.environment);
  for (const event of CLAUDE_PLAIN_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: command(event) }] }];
  }
  for (const event of CLAUDE_TOOL_EVENTS) {
    hooks[event] = [{ matcher: '*', hooks: [{ type: 'command', command: command(event) }] }];
  }
  return {
    hooks,
    statusLine: { type: 'command', command: command('StatusLine') },
  };
}

/**
 * Como o agente sobe dentro da distro. `sh -lc` (login shell) e não `claude`
 * direto porque é o login shell que monta o `PATH` de verdade da distro —
 * `~/.local/bin`, nvm, asdf. É o MESMO caminho que a detecção
 * (`command -v claude`) percorre; subir por outro faria a sidebar dizer "tem
 * claude aqui" e o lançamento falhar assim mesmo.
 *
 * `"$@"` recebe os argumentos como argv de verdade (o `claude` depois do
 * script é o `$0`), então nada do `--settings` passa por interpretação de
 * shell.
 */
export const WSL_AGENT_COMMAND = 'exec claude "$@"';

// `where.exe` é síncrono e trava o event loop do core (que hospeda sessões
// vivas) por dezenas de ms. O binário do Claude não muda de lugar enquanto o
// core roda, então resolve uma vez e guarda: as chamadas seguintes são de graça.
let cachedClaudeBin: string | undefined;

export function resolveClaudeBin(): string {
  if (cachedClaudeBin !== undefined) return cachedClaudeBin;
  cachedClaudeBin = resolveClaudeBinUncached();
  return cachedClaudeBin;
}

/** Só pra teste: força a próxima chamada a consultar o `where.exe` de novo. */
export function resetClaudeBinCache(): void {
  cachedClaudeBin = undefined;
}

function resolveClaudeBinUncached(): string {
  try {
    const out = execFileSync('where.exe', ['claude'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const cmd = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
    if (cmd) return cmd;
  } catch {
    // where.exe não achou nada ou falhou — cai no fallback abaixo.
  }
  return 'claude.cmd';
}

const FILE_ARG_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Teto do `detail` que sai daqui. O argumento já vem cortado em 40; o resto da
 * folga é do nome da ferramenta, que também vem do payload.
 */
const TOOL_DETAIL_MAX = 120;

/**
 * O `detail` de uma linha de sessão a partir de um evento de ferramenta.
 *
 * Sai por `sanitizeDisplay` porque este texto é ATACÁVEL e vai parar em
 * terminal: o `tool_input` é escolhido pelo modelo (e, por tabela, por qualquer
 * conteúdo que ele esteja lendo), e o `bridge list` imprime o `detail` cru no
 * console do dono. O `collapseWhitespace` daqui só junta espaço — um `ESC]0;…`
 * ou um BEL atravessava inteiro e viraria sequência de controle na tela.
 */
export function summarizeTool(tool: string, input: unknown): string {
  const obj = asRecord(input);
  let arg: string | undefined;
  if (tool === 'Bash') {
    arg = asString(obj.command);
  } else if (FILE_ARG_TOOLS.has(tool)) {
    const filePath = asString(obj.file_path);
    arg = filePath ? basename(filePath) : undefined;
  }
  const cleaned = arg ? collapseWhitespace(arg) : '';
  const detail = cleaned ? `${tool} · ${truncate(cleaned, 40)}` : tool;
  return sanitizeDisplay(detail, TOOL_DETAIL_MAX);
}

export function isHumanWait(payload: { message?: unknown; notification_type?: unknown }): boolean {
  const type = payload.notification_type;
  if (type === 'idle_prompt') return false;
  if (type === 'permission_prompt') return true;
  const message = asString(payload.message)?.toLowerCase() ?? '';
  if (message.includes('waiting') || message.includes('idle')) return false;
  return true;
}

/** Motivos de `SessionEnd` que significam "o processo do agente acabou". */
export const SESSION_END_EXIT_REASONS = new Set(['exit', 'prompt_input_exit', 'logout']);

/**
 * Este `SessionEnd` é uma SAÍDA de verdade?
 *
 * `SessionEnd` também chega em `/clear` (e afins), onde o processo do agente
 * continua vivo. Sem motivo declarado a resposta é "sim": é o comportamento que
 * o adaptador sempre teve, e um payload mudo num evento de fim é fim.
 *
 * Mora aqui, exportado, porque a regra vale em DOIS lugares desde a 0.12.0: no
 * `onHook` (sessão de agente → `exited`) e na rota de hooks (sessão de shell
 * hospedeira → fim da hospedagem, com o PTY vivo). Duplicá-la deixaria os dois
 * lados divergirem no dia em que a lista de motivos crescer.
 */
export function isSessionEndExit(payload: unknown): boolean {
  const reason = asString(asRecord(payload).reason);
  return reason === undefined || SESSION_END_EXIT_REASONS.has(reason);
}

/**
 * Este `SessionEnd` prova que o DONO fechou a conversa? (13/09/2026)
 *
 * Mais estrito que `isSessionEndExit`, e de propósito: aqui a pergunta não é
 * "o processo acabou?" e sim "posso deixar de retomar este painel?". Errar
 * pro lado do "sim" custa a conversa do dono (foi o que aconteceu na madrugada
 * de 13/09, com um Claude que saiu sozinho). Por isso só vale motivo DECLARADO
 * de saída: payload sem `reason`, `other` (sinal, encerramento que o agente não
 * atribui a ninguém) e `/clear` deixam o painel retomável.
 */
export function isDeliberateSessionEnd(payload: unknown): boolean {
  const reason = asString(asRecord(payload).reason);
  return reason !== undefined && SESSION_END_EXIT_REASONS.has(reason);
}

/**
 * Os `detail` da linha da sessão (spec §13). São FUNÇÕES, e não constantes:
 * uma constante de módulo é avaliada uma vez, na importação, e o idioma troca
 * ao vivo — a linha da sidebar tem que sair no idioma do evento que a mudou.
 */
export const detailThinking = (lang: Language): string => t(lang, 'core.sessao.detalhe.pensando');
export const detailDone = (lang: Language): string => t(lang, 'core.sessao.detalhe.terminei');
export const detailWaiting = (lang: Language): string => t(lang, 'core.sessao.detalhe.aguardandoPermissao');
export const detailStuck = (lang: Language): string => t(lang, 'core.sessao.detalhe.travado');

/**
 * `usage.showCost` e `usage.terminalStatusLine` do `config.json`, espelhados
 * aqui. O adaptador é um módulo, não um objeto do core — quem o configura na
 * subida (e a cada `PATCH /api/config`) é o `configureClaudeAdapter`.
 */
let showCost = DEFAULT_CONFIG.usage.showCost;
let terminalStatusLine = DEFAULT_CONFIG.usage.terminalStatusLine;

export function configureClaudeAdapter(opts: { showCost: boolean; terminalStatusLine: boolean }): void {
  showCost = opts.showCost;
  terminalStatusLine = opts.terminalStatusLine;
}

/** "1 subagente rodando" / "{n} subagentes rodando" — chave explícita por plural (regra do catálogo). */
const detailSubagents = (n: number, lang: Language): string =>
  n === 1 ? t(lang, 'core.sessao.detalhe.subagentes.um') : t(lang, 'core.sessao.detalhe.subagentes.varios', { n });
const detailAwaitingSubagents = (n: number, lang: Language): string =>
  n === 1
    ? t(lang, 'core.sessao.detalhe.aguardandoSubagentes.um')
    : t(lang, 'core.sessao.detalhe.aguardandoSubagentes.varios', { n });

/** Só entra no `change` quando há o que zerar — os testes das rotas comparam o `change` inteiro. */
function subagentReset(session: Session): Pick<StateChange, 'subagents' | 'awaitingSubagents'> {
  const out: Pick<StateChange, 'subagents' | 'awaitingSubagents'> = {};
  if (session.subagents) out.subagents = 0;
  if (session.awaitingSubagents) out.awaitingSubagents = false;
  return out;
}

function onHookImpl(event: string, payload: unknown, session: Session, lang: Language): HookOutcome {
  const p = asRecord(payload);
  const liveSubagents = session.subagents ?? 0;
  switch (event) {
    // Um `SubagentStop` perdido (subagente morto, hook que não chegou, core
    // reiniciado no meio) deixaria a contagem presa e todo `Stop` seguinte em
    // "esperando" pra sempre. Os dois começos de turno inequívocos zeram tudo:
    // custa perder a contagem de um subagente legítimo naquele turno (o pior
    // caso volta a ser o `done` prematuro de antes), nunca uma sessão presa.
    case 'SessionStart':
      return { change: { state: 'idle', detail: null, tool: null, ...subagentReset(session) }, reply: {} };
    case 'UserPromptSubmit':
      return { change: { state: 'running', detail: detailThinking(lang), tool: null, ...subagentReset(session) }, reply: {} };
    /*
     * Subagentes (12/09/2026). A conversa principal dispara um `Stop` quando o
     * turno DELA acaba — mesmo com um subagente em segundo plano ainda
     * trabalhando. Sem contar os subagentes, a sidebar dizia "terminou" e
     * mandava o toast enquanto o trabalho continuava. Com a contagem: o
     * `Stop` com subagente vivo vira `running` ("esperando N subagentes") sem
     * notificação, e o `done` de verdade fica pro turno que o Claude abre
     * sozinho quando o último subagente entrega (esse turno termina com o seu
     * próprio `Stop`). Se o último `SubagentStop` chega e a principal já tinha
     * parado, a sessão vai pra `idle` (não `done`): é o Claude que vai retomar,
     * e um `done` aqui viraria dois toasts.
     */
    case 'SubagentStart': {
      const n = liveSubagents + 1;
      // `needs-input`/`stuck` guardam a razão deles no `detail`; um subagente
      // não apaga "aguardando permissão" da linha.
      if (session.state !== 'running' && session.state !== 'idle' && session.state !== 'done') {
        return { change: { subagents: n }, reply: {} };
      }
      return { change: { state: 'running', subagents: n, detail: detailSubagents(n, lang) }, reply: {} };
    }
    case 'PreToolUse': {
      const toolName = asString(p.tool_name);
      if (!toolName) {
        return { change: { state: 'running', tool: null, detail: detailThinking(lang) }, reply: {} };
      }
      return {
        change: { state: 'running', tool: toolName, detail: summarizeTool(toolName, p.tool_input) },
        reply: {},
      };
    }
    case 'PostToolUse':
      return { change: { state: 'running', tool: null, detail: detailThinking(lang) }, reply: {} };
    case 'PermissionRequest': {
      const toolName = asString(p.tool_name);
      // O `summarizeTool` já passou pelo `sanitizeDisplay` — ele é que vira o
      // `{detalhe}` do catálogo, e o nome da ferramenta (`Bash`) não se traduz.
      const text = toolName
        ? t(lang, 'core.notificacao.permissao', { detalhe: summarizeTool(toolName, p.tool_input) })
        : t(lang, 'core.notificacao.permissaoSolicitada');
      return {
        change: { state: 'needs-input', detail: detailWaiting(lang) },
        notification: { kind: 'needs-input', text },
        reply: {},
      };
    }
    case 'Notification': {
      const message = asString(p.message);
      if (message === undefined) {
        return {
          change: { state: 'needs-input', detail: detailWaiting(lang) },
          notification: { kind: 'needs-input', text: t(lang, 'core.notificacao.aguardando') },
          reply: {},
        };
      }
      if (isHumanWait(p)) {
        // O texto é do AGENTE (payload do hook), não do Bridge: sai como veio.
        return {
          change: { state: 'needs-input', detail: detailWaiting(lang) },
          notification: { kind: 'needs-input', text: message },
          reply: {},
        };
      }
      return { change: { state: 'idle' }, reply: {} };
    }
    case 'Stop': {
      const blocked = asBoolean(p.stop_hook_active) ?? false;
      if (blocked) {
        return { blockedStop: true, change: { state: 'running' }, reply: {} };
      }
      if (liveSubagents > 0) {
        return {
          change: { state: 'running', detail: detailAwaitingSubagents(liveSubagents, lang), tool: null, awaitingSubagents: true },
          reply: {},
        };
      }
      return {
        change: { state: 'done', detail: detailDone(lang), tool: null, ...(session.awaitingSubagents ? { awaitingSubagents: false } : {}) },
        notification: { kind: 'done', text: t(lang, 'core.notificacao.terminou') },
        reply: {},
      };
    }
    case 'SubagentStop': {
      const n = Math.max(0, liveSubagents - 1);
      const keepsReason = session.state === 'needs-input' || session.state === 'stuck';
      if (n > 0) return { change: keepsReason ? { subagents: n } : { subagents: n, detail: detailSubagents(n, lang) }, reply: {} };
      if (session.awaitingSubagents) {
        // O último terminou e a principal estava só esperando: ela é acordada
        // sozinha pelo Claude e o turno novo termina com o próprio `Stop`
        // (aí sim `done` + toast). Fica `running`, que é a verdade — um
        // `idle` aqui liberaria um passo de roteiro com `waitFor: 'idle'` cedo.
        return {
          change: { state: 'running', subagents: 0, awaitingSubagents: false, tool: null, detail: t(lang, 'core.sessao.detalhe.subagente') },
          reply: {},
        };
      }
      return { change: keepsReason ? { subagents: 0 } : { subagents: 0, detail: t(lang, 'core.sessao.detalhe.subagente') }, reply: {} };
    }
    case 'SessionEnd':
      // Marcar `exited` num `/clear` riscaria uma sessão que ainda está
      // rodando. Só os motivos de saída de verdade transicionam.
      return isSessionEndExit(p) ? { change: { state: 'exited' }, reply: {} } : { reply: {} };
    default:
      return {};
  }
}

// Node refuses (throws EINVAL synchronously, or fails via callback depending on
// version) to execFile a .cmd/.bat directly without `shell: true` on Windows
// since the CVE-2024-27980 fix. We avoid `shell: true` (it triggers Node's
// DEP0190 warning and un-escaped argument concatenation) by trying a plain
// execFile first and falling back to `cmd.exe /c <bin> <args>` — which passes
// args as a real argv array, not a shell string — when that fails.
function execFileVersion(bin: string, timeoutMs: number): Promise<{ ok: boolean; version?: string; reason?: string }> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: err.message });
          return;
        }
        resolve({ ok: true, version: stdout.trim() });
      });
    } catch (err) {
      resolve({ ok: false, reason: (err as Error).message });
    }
  });
}

function cmdExeVersion(bin: string, timeoutMs: number): Promise<{ ok: boolean; version?: string; reason?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('cmd.exe', ['/c', bin, '--version'], { windowsHide: true, timeout: timeoutMs });
    } catch (err) {
      resolve({ ok: false, reason: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, version: stdout.trim() });
      // `cmd.exe exit N` é diagnóstico de processo, vizinho do `err.message`
      // do Node (que o sistema escreve em inglês): não é copy, não traduz.
      else resolve({ ok: false, reason: stderr.trim() || `cmd.exe exit ${code}` });
    });
  });
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',

  async available(_lang: Language): Promise<{ ok: boolean; version?: string; reason?: string }> {
    const bin = resolveClaudeBin();
    const direct = await execFileVersion(bin, 5000);
    if (direct.ok) return direct;
    return cmdExeVersion(bin, 5000);
  },

  launch(ctx: LaunchCtx): LaunchSpec {
    const settingsPath = join(ctx.sessionDir, 'settings.json');
    const wsl = ctx.environment?.kind === 'wsl' ? ctx.environment : undefined;
    // O arquivo é escrito pelo core, que roda no Windows: o caminho de ESCRITA
    // é sempre o do Windows. O que muda é o caminho que o agente recebe — de
    // dentro da distro, a mesma pasta é `/mnt/c/...`.
    const settingsArg = wsl?.sessionDirUnix ? `${wsl.sessionDirUnix}/settings.json` : settingsPath;
    // `--resume <id>` vem logo depois do `--settings` e só com id na mão. Sem
    // id NÃO existe fallback pra `--continue`: numa pasta com dois Claudes o
    // "continuar a última conversa" é ambíguo e retomaria a do painel errado —
    // melhor subir um Claude limpo do que abrir a conversa de outro painel.
    const args = [
      '--settings',
      settingsArg,
      ...(ctx.resume ? ['--resume', ctx.resume] : []),
      ...(ctx.model ? ['--model', ctx.model] : []),
    ];
    const env = baseEnv(ctx);
    const files = [{ path: settingsPath, content: JSON.stringify(buildClaudeSettings(ctx), null, 2) }];
    if (wsl) {
      // Invariante do core: o `resolveEnvContext` já validou o ambiente antes
      // do lançamento. Vira 500 e log, nunca texto de tela.
      if (!wsl.distro || !wsl.cwdUnix) throw new Error('ambiente WSL sem distro ou sem caminho traduzido'); // i18n-ignore
      return {
        bin: 'wsl.exe',
        args: wslArgs(wsl.distro, wsl.cwdUnix, ['sh', '-lc', WSL_AGENT_COMMAND, 'claude', ...args]),
        env,
        files,
      };
    }
    return { bin: resolveClaudeBin(), args, env, files };
  },

  onHook(event: string, payload: unknown, session: Session, lang: Language): HookOutcome {
    return onHookImpl(event, payload, session, lang);
  },

  /**
   * A statusline é do BRIDGE (ADR-012): ele monta a linha a partir do payload
   * que o próprio Claude Code acabou de mandar — contexto, modelo, custo e as
   * janelas de `rate_limits` — em vez de terceirizar isso pra um processo
   * externo. Nenhum spawn aqui, e portanto nenhum cache a manter: a statusline
   * é redesenhada várias vezes por segundo, e a única coisa cara que existia
   * neste caminho era o `spawn` que saiu.
   *
   * `async` continua na assinatura porque `AgentAdapter.statusLine` é comum
   * aos adaptadores e outro pode precisar esperar por algo.
   *
   * 0.12.2 — `usage.terminalStatusLine` desligada (o padrão) devolve linha
   * VAZIA pro terminal, e o payload continua sendo lido do mesmo jeito: o
   * `quota` que sai daqui é o que abastece a linha da sessão, o selo de
   * contexto e as janelas de 5 h/semana da sidebar, além do `noteLimits` do
   * monitor de uso. O hook não pode sair — só o texto sai. Medido no Claude
   * Code 2.1.266: com o comando devolvendo string vazia, a TUI não desenha
   * rodapé nenhum (nem uma barra em branco), e o comando SEGUE sendo chamado.
   */
  async statusLine(payload: unknown, _session: Session, lang: Language): Promise<StatusLineResult> {
    const quota = quotaFromPayload(payload);
    const line = statusLine(quota, { showCost, lang });
    // O `quota.line` guarda a linha CHEIA de propósito: ela é o retrato do que
    // o Bridge leu, e quem a consome (banco, painel) não deveria depender de
    // uma preferência de exibição do terminal.
    return { line: terminalStatusLine ? line : '', quota: { ...quota, line } };
  },
};
