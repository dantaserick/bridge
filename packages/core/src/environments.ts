/**
 * Detecção dos ambientes de sessão (dor verificada #2) e tradução de caminhos
 * pro WSL.
 *
 * Três perguntas, e só três:
 * 1. quais ambientes esta máquina TEM (`pwsh.exe`, `powershell.exe`, o Git
 *    Bash instalado, e cada distro que o `wsl.exe -l -q` lista);
 * 2. dentro de cada um, existe `claude`? existe `node`? — é a diferença entre
 *    uma sessão que funciona e uma que abre e nunca reporta hook nenhum;
 * 3. qual é o caminho POSIX de uma pasta do Windows dentro da distro
 *    (`wslpath -a`), que é o que o `--cd` e o `--settings` do agente precisam.
 *
 * Tudo passa por `Runner` — uma função que roda um executável e devolve
 * `{ code, stdout }` — porque a máquina do dono pode não ter distro nenhuma
 * (é o caso em 06/09/2026) e o teste precisa de um `wsl.exe` de mentira. Fora
 * do teste o `Runner` é `execFile` com `windowsHide` e teto de tempo, nunca
 * `shell: true`: o nome da distro vem do banco/da API e vai como argv.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { EnvironmentInfo, EnvironmentKind, Language, MessageKey, SessionEnvironment } from '@bridge/shared';
import { environmentLabel, isValidDistro, t } from '@bridge/shared';
import type { I18nMessage, Translatable } from './errors.js';
import { ptBRMessage } from './errors.js';

/** Teto por consulta. `wsl.exe` local responde em ms; passar disso é distro travada. */
export const ENV_PROBE_TIMEOUT_MS = 8000;

/** Validade do cache de `GET /api/environments`. */
export const ENV_CACHE_TTL_MS = 60_000;

/** Onde o Git for Windows instala o bash. É o mesmo caminho do `shellLaunch`. */
export const GIT_BASH_BIN = 'C:\\Program Files\\Git\\bin\\bash.exe';

export interface RunResult {
  code: number;
  stdout: Buffer;
}

/** Roda um executável com argumentos e devolve saída CRUA (o `wsl -l -q` é UTF-16LE). */
export type Runner = (bin: string, args: string[]) => Promise<RunResult>;

export const execRunner: Runner = (bin, args) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: ENV_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
          resolve({ code, stdout: out });
          return;
        }
        resolve({ code: 0, stdout: out });
      },
    );
  });

/**
 * `wsl.exe -l -q` escreve UTF-16LE **sem BOM garantido** e termina cada nome
 * com `\r`. Decodificar como UTF-8 devolve `U\0b\0u\0n\0t\0u\0` — nomes com
 * NUL no meio, que viravam `-d "U\0buntu"` e um `wsl.exe` recusando tudo.
 *
 * O BOM (se vier) sai; o `\0` residual de uma saída já em UTF-8 (WSL de
 * versão diferente, stub de teste) também — assim a função aceita as duas
 * codificações sem adivinhar.
 */
export function parseWslList(raw: Buffer): string[] {
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.subarray(2).toString('utf16le');
  else if (raw.includes(0) && raw.length % 2 === 0) text = raw.toString('utf16le');
  else text = raw.toString('utf8');
  return text
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0)
    .filter(isValidDistro);
}

/** Marca de "o script chegou ao fim" — é ela que responde "a distro subiu?". */
export const WSL_OK_MARKER = '__bridge_ok__';
/** Marca de "o interop do Windows está ligado nesta distro". */
export const WSL_INTEROP_MARKER = '__bridge_interop__';

/**
 * O que o Bridge pergunta DENTRO da distro, num login shell.
 *
 * As três respostas, nesta ordem:
 * 1. `claude` está no PATH de login? É o que decide se uma sessão de AGENTE
 *    sobe aqui (o core recusa com 422 antes de gastar um painel);
 * 2. `node` está? Informativo apenas — os hooks NÃO usam o node da distro
 *    (ver `EnvContext.nodeCommand`);
 * 3. o **interop** está ligado? Sem `binfmt_misc/WSLInterop` a distro não
 *    executa `.exe` do Windows, e é exatamente assim que o shim de hooks roda.
 *    As duas grafias existem porque distro moderna registra `WSLInterop-late`.
 *
 * O `echo` final é a SENTINELA, e é ela (não "achou algum binário") que diz se
 * a distro respondeu: `command -v` sai com 1 quando não acha, então nem o
 * código de saída nem a presença de linhas serviam — uma distro VIVA sem
 * `claude` e sem `node` era lida como "não respondeu" e sumia da lista.
 */
export const WSL_PROBE_SCRIPT =
  'command -v claude; command -v node; ' +
  `[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] && echo ${WSL_INTEROP_MARKER}; ` +
  `echo ${WSL_OK_MARKER}`;

export interface WslProbe {
  claude: boolean;
  node: boolean;
  /**
   * O interop do Windows está ligado nesta distro? Sem ele os hooks do Bridge
   * NÃO rodam: o shim é executado pelo Node do **Windows** (ver
   * `EnvContext.nodeCommand`), e um `.exe` só roda dentro do WSL por interop.
   */
  interop: boolean;
  /**
   * A distro respondeu? `false` = não subiu (não instalada, parada,
   * corrompida). Medido pela sentinela — distro viva sem `claude` continua
   * sendo uma distro viva, e tem que aparecer na lista.
   */
  ok: boolean;
}

export async function probeWslDistro(distro: string, run: Runner = execRunner): Promise<WslProbe> {
  const res = await run('wsl.exe', ['-d', distro, '--', 'sh', '-lc', WSL_PROBE_SCRIPT]);
  const lines = decodeWslText(res.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    ok: lines.includes(WSL_OK_MARKER),
    interop: lines.includes(WSL_INTEROP_MARKER),
    claude: lines.some((l) => /(^|[\\/])claude(\.exe)?$/.test(l)),
    node: lines.some((l) => /(^|[\\/])node(\.exe)?$/.test(l)),
  };
}

/** Mesma heurística de codificação do `parseWslList`, pra saída de texto comum. */
export function decodeWslText(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw.includes(0) && raw.length % 2 === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

/**
 * `wslpath -a <caminho do Windows>` — o caminho POSIX equivalente dentro da
 * distro. O argumento vai como argv (nada de shell), então pasta com espaço,
 * acento ou `&` no nome atravessa inteira.
 *
 * `undefined` quando a tradução falhou: quem chama decide se isso derruba o
 * lançamento (o `--cd` da sessão) ou se cai num plano B.
 */
export async function wslPath(distro: string, windowsPath: string, run: Runner = execRunner): Promise<string | undefined> {
  const res = await run('wsl.exe', ['-d', distro, '--', 'wslpath', '-a', windowsPath]);
  if (res.code !== 0) return undefined;
  const out = decodeWslText(res.stdout).split(/\r?\n/)[0]?.trim();
  return out && out.length > 0 ? out : undefined;
}

/**
 * A MEDIÇÃO de um ambiente, sem uma palavra de texto (spec §13).
 *
 * O cache de 60 s guarda ISTO, e não `EnvironmentInfo`: o rótulo e o motivo
 * são copy, e copy tem idioma. Guardar a lista já escrita faria uma troca de
 * idioma demorar até um minuto pra aparecer em `GET /api/environments` — ou
 * exigiria invalidar um cache de `wsl.exe` por causa de uma decisão de texto.
 */
export interface EnvMeasurement {
  id: string;
  kind: EnvironmentKind;
  distro?: string;
  available: boolean;
  claude: boolean;
  node: boolean;
  interop: boolean;
  /** A chave do motivo, quando existe um. Vira `reason` no idioma da chamada. */
  reasonKey?: MessageKey;
}

/** Ambientes do Windows, sem consultar nada de WSL. */
function windowsEnvironments(): EnvMeasurement[] {
  const base = (kind: EnvironmentKind, available: boolean, reasonKey?: MessageKey): EnvMeasurement => ({
    id: kind,
    kind,
    available,
    // No Windows o `claude` é o do PATH do próprio Bridge — o adaptador já
    // resolve isso no `available()`, e repetir um `where.exe` por ambiente
    // aqui só gastaria tempo pra dizer a mesma coisa.
    claude: true,
    node: true,
    // Fora do WSL não há fronteira a cruzar: o shim roda como qualquer outro
    // processo do Windows.
    interop: true,
    ...(reasonKey ? { reasonKey } : {}),
  });
  const gitBash = existsSync(GIT_BASH_BIN);
  return [
    base('pwsh', true),
    base('powershell', true),
    base('gitbash', gitBash, gitBash ? undefined : 'core.ambiente.motivo.gitBashAusente'),
  ];
}

/**
 * A medição virada em resposta de API, no idioma de AGORA (spec §13).
 *
 * É aqui que o texto nasce — uma vez por chamada de `list(lang)`, nunca no
 * cache —, e é por isso que um `PATCH /api/config { ui: { language } }` muda
 * a lista de ambientes já na próxima abertura do menu.
 */
function describe(m: EnvMeasurement, lang: Language): EnvironmentInfo {
  const env: SessionEnvironment = m.distro === undefined ? { kind: m.kind } : { kind: m.kind, distro: m.distro };
  return {
    id: m.id,
    kind: m.kind,
    ...(m.distro === undefined ? {} : { distro: m.distro }),
    // O rótulo vem do `@bridge/shared` — a mesma função que a UI usa. Sem ele
    // o `<select>` do diálogo e o menu "⋯" mostravam a distro sem nome nenhum.
    label: environmentLabel(env, lang),
    available: m.available,
    claude: m.claude,
    node: m.node,
    interop: m.interop,
    // `reason` é opcional: entra só quando existe. Escrever `reason: undefined`
    // é uma PROPRIEDADE presente valendo `undefined`, que
    // `exactOptionalPropertyTypes` recusa e o JSON da API carrega à toa.
    ...(m.reasonKey ? { reason: t(lang, m.reasonKey) } : {}),
  };
}

/**
 * A lista inteira de `GET /api/environments`, com cache de 60 s: o diálogo de
 * novo workspace e o menu de cada linha da sidebar perguntam isso junto, e
 * cada distro custa um `wsl.exe` de centenas de ms.
 */
export class Environments {
  private cache?: { at: number; value: EnvMeasurement[] };
  private inflight?: Promise<EnvMeasurement[]>;

  constructor(
    private run: Runner = execRunner,
    private now: () => number = Date.now,
    private ttlMs: number = ENV_CACHE_TTL_MS,
  ) {}

  /** Esquece o cache — usado pelo teste e por quem quer forçar releitura. */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * A lista já escrita, no idioma pedido. O `lang` NÃO entra no cache: o que
   * custa `wsl.exe` é a medição, e a medição não tem idioma.
   */
  async list(lang: Language): Promise<EnvironmentInfo[]> {
    return (await this.measured()).map((m) => describe(m, lang));
  }

  private async measured(): Promise<EnvMeasurement[]> {
    const cached = this.cache;
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;
    // Duas chamadas simultâneas (o diálogo abrindo enquanto a sidebar
    // pergunta) não podem virar dois `wsl.exe -l -q`.
    if (this.inflight) return this.inflight;
    this.inflight = this.measure()
      .then((value) => {
        this.cache = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async measure(): Promise<EnvMeasurement[]> {
    const list = windowsEnvironments();
    let distros: string[] = [];
    try {
      const res = await this.run('wsl.exe', ['-l', '-q']);
      // Máquina sem WSL: `wsl.exe` não existe (ENOENT) ou sai != 0. Nenhum dos
      // dois é erro do Bridge — é só "não há distro aqui".
      if (res.code === 0) distros = parseWslList(res.stdout);
    } catch {
      distros = [];
    }
    for (const distro of distros) {
      const probe = await probeWslDistro(distro, this.run).catch(
        (): WslProbe => ({ ok: false, interop: false, claude: false, node: false }),
      );
      const reasonKey = reasonFor(probe);
      list.push({
        id: `wsl:${distro}`,
        kind: 'wsl',
        distro,
        // `available` = a DISTRO subiu. Distro viva sem `claude` continua
        // disponível: dá pra querer só um shell ali. Quem barra a sessão de
        // agente é o `claude` abaixo, não este campo.
        available: probe.ok,
        claude: probe.claude,
        node: probe.node,
        interop: probe.interop,
        ...(reasonKey ? { reasonKey } : {}),
      });
    }
    return list;
  }
}

function reasonFor(probe: WslProbe): MessageKey | undefined {
  if (!probe.ok) return 'core.ambiente.motivo.distroSemResposta';
  // O interop vem PRIMEIRO: sem ele os hooks não chegam, e uma sessão de
  // agente aqui abriria e nunca sairia de "ociosa" na sidebar. É pior que não
  // ter `claude`, porque falha em silêncio.
  if (!probe.interop) return 'core.ambiente.motivo.semInterop';
  if (!probe.claude) return 'core.ambiente.motivo.semClaude';
  return undefined;
}

/**
 * O que o lançamento de uma sessão precisa saber sobre o ambiente, já
 * resolvido: os caminhos traduzidos e o comando de `node` que o shim de hooks
 * vai usar lá dentro.
 *
 * Fora do WSL isto é só `{ kind }` — nenhuma tradução é necessária e nenhum
 * `wsl.exe` roda.
 */
export interface EnvContext {
  kind: EnvironmentKind;
  distro?: string;
  /** `cwd` da sessão em forma POSIX (`--cd` do `wsl.exe`). */
  cwdUnix?: string;
  /**
   * Pasta da sessão (onde mora o `settings.json` do agente) em forma POSIX.
   *
   * O `resolveEnvContext` devolve aqui a RAIZ das sessões do perfil, porque
   * ele roda ANTES de a sessão existir (ver o comentário dele); quem desce
   * pro `<raiz>/<sessionId>` é o `withSessionDir`.
   */
  sessionDirUnix?: string;
  /**
   * O que executa o shim de hooks dentro da distro: **sempre** o Node do
   * WINDOWS, alcançado por interop (`/mnt/c/.../node.exe`, derivado do
   * `process.execPath` pelo próprio `wslpath`).
   *
   * Nunca o `node` da distro, mesmo quando ela tem um. O shim precisa falar
   * com o core em `127.0.0.1:<porta>`, e **o loopback do WSL2 não é
   * compartilhado com o Windows** no modo de rede padrão (NAT): de dentro da
   * distro, `127.0.0.1` é a própria distro, não o host. (O modo espelhado
   * — `networkingMode=mirrored`, opcional e não-padrão — compartilharia, mas o
   * Bridge não pode depender de uma configuração que o dono talvez não tenha.)
   * Rodando pelo Node do Windows, o processo do shim é um processo do WINDOWS
   * e o `127.0.0.1` dele é o do host, sempre.
   *
   * O preço é o interop: sem `binfmt_misc/WSLInterop` a distro não executa o
   * `.exe` — por isso `WslProbe.interop` existe e vira aviso na lista.
   */
  nodeCommand?: string;
}

export class EnvironmentError extends Error implements Translatable {
  readonly code = 'environment-unavailable';
  readonly i18n: I18nMessage;
  constructor(i18n: I18nMessage) {
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'EnvironmentError';
  }
}

/**
 * Traduz o que o lançamento precisa: três `wslpath` em paralelo (o `cwd`, a
 * raiz das sessões e o `node.exe` do Windows).
 *
 * Falha em traduzir o `cwd` é ERRO: subir a sessão sem `--cd` a jogaria no
 * `$HOME` da distro, e o dono acharia que o Bridge abriu a pasta errada.
 *
 * Recebe a RAIZ das sessões do perfil (`sessionsDir`), não a pasta de UMA
 * sessão, porque o core chama isto ANTES de criar a sessão: uma distro que não
 * responde tem que virar 422 sem antes descartar a sessão que ocupava o painel
 * (o dono ainda não leu a saída dela). Quem desce pro `<raiz>/<sessionId>` é o
 * `withSessionDir`, depois que o id existe.
 */
export async function resolveEnvContext(
  env: SessionEnvironment,
  paths: { cwd: string; sessionsDir: string; shimPath: string; windowsNode: string },
  run: Runner = execRunner,
): Promise<EnvContext> {
  if (env.kind !== 'wsl') return { kind: env.kind };
  const distro = env.distro;
  if (!distro || !isValidDistro(distro)) throw new EnvironmentError({ key: 'core.erro.ambiente.distroInvalida' });

  // O `shimPath` NÃO é traduzido: quem o recebe é o `node.exe` do Windows, e o
  // interop entrega o argv sem tradução nenhuma — um `/mnt/c/...` chegaria lá
  // como caminho inexistente. O que é traduzido é só o que um binário LINUX
  // vai ler: o `--cd` do shell e o `--settings` do agente.
  const [cwdUnix, sessionDirUnix, nodeCommand] = await Promise.all([
    wslPath(distro, paths.cwd, run),
    wslPath(distro, paths.sessionsDir, run),
    wslPath(distro, paths.windowsNode, run),
  ]);
  if (!cwdUnix) throw new EnvironmentError({ key: 'core.erro.ambiente.traduzPasta', params: { distro } });
  if (!sessionDirUnix) {
    throw new EnvironmentError({ key: 'core.erro.ambiente.traduzCaminhos', params: { distro } });
  }
  if (!nodeCommand) {
    throw new EnvironmentError({ key: 'core.erro.ambiente.interopNode', params: { distro } });
  }

  return { kind: 'wsl', distro, cwdUnix, sessionDirUnix, nodeCommand };
}

/**
 * Desce do `sessionDirUnix` (a raiz das sessões, o que o `resolveEnvContext`
 * devolve) pra pasta DESTA sessão. Separado porque o id da sessão só existe
 * depois de todas as validações — inclusive a do ambiente.
 */
export function withSessionDir(ctx: EnvContext, sessionId: string): EnvContext {
  if (ctx.kind !== 'wsl' || !ctx.sessionDirUnix) return ctx;
  return { ...ctx, sessionDirUnix: `${ctx.sessionDirUnix}/${sessionId}` };
}

/**
 * Aspas de shell POSIX pra montar o comando de hook que o Claude Code vai
 * executar DENTRO da distro. O `command` de um hook é uma linha de shell (não
 * um argv), e `/mnt/c/Program Files/nodejs/node.exe` tem espaço no meio.
 *
 * Aspas simples com o escape `'\''` é a única forma que não tem exceção: nada
 * dentro delas é interpretado.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
