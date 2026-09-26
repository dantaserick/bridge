/**
 * O AMBIENTE em que as sessões de um workspace sobem (dor verificada #2).
 *
 * No Windows o Claude Code cai no shell que o Bridge escolheu — e, com o Git
 * Bash no caminho, ele roda dentro de um MINGW64: `PATH` sem o toolchain
 * Linux, caminhos UNC (`\\wsl.localhost\...`) e um `node` que não é o da
 * distro. Quem trabalha numa distro WSL quer a sessão INTEIRA lá dentro — o
 * shell e o agente —, não um agente do Windows olhando pra uma pasta montada.
 *
 * Por isso o ambiente é propriedade do WORKSPACE (e não da configuração
 * global): a mesma máquina tem um repo que só compila no Ubuntu e outro que só
 * roda em `pwsh`.
 *
 * Este módulo é a FORMA compartilhada (core, ui, cli): o tipo, o id textual
 * (`wsl:Ubuntu`) que a CLI aceita e a sidebar mostra, e o rótulo — que desde a
 * 0.13.0 sai do catálogo de mensagens, no idioma que quem chama pedir.
 * Nada aqui executa nada — a detecção mora no core.
 */
import { t } from './i18n/index.js';
import type { Language } from './i18n/index.js';

/** Onde a sessão roda. `wsl` sempre vem com `distro`. */
export type EnvironmentKind = 'pwsh' | 'powershell' | 'gitbash' | 'wsl';

export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = ['pwsh', 'powershell', 'gitbash', 'wsl'];

export interface SessionEnvironment {
  kind: EnvironmentKind;
  /** Nome da distro (`wsl.exe -d <distro>`). Obrigatório em `wsl`, ausente no resto. */
  distro?: string;
}

/**
 * Nome de distro aceito. A distro entra como ARGUMENTO de `wsl.exe -d <nome>`
 * (argv separado, sem shell), mas um valor começando com `-` seria lido como
 * opção pelo parser do próprio `wsl.exe` — injeção de argumento, o mesmo
 * cuidado do `--resume` da sessão. Letras, dígitos, espaço e `. _ + -`, nunca
 * na primeira posição.
 */
const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;

export function isValidDistro(name: string): boolean {
  return DISTRO_RE.test(name);
}

/**
 * O id textual: `pwsh`, `gitbash`, `wsl:Ubuntu`. É o que a CLI recebe em
 * `bridge new --env wsl:Ubuntu`, o `value` do `<select>` do diálogo e o que a
 * linha do workspace mostra na sidebar.
 */
export function environmentId(env: SessionEnvironment): string {
  return env.kind === 'wsl' ? `wsl:${env.distro ?? ''}` : env.kind;
}

/** O inverso do `environmentId`. `undefined` quando o texto não é um ambiente. */
export function parseEnvironmentId(text: string): SessionEnvironment | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const sep = trimmed.indexOf(':');
  const kind = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
  const rest = sep === -1 ? undefined : trimmed.slice(sep + 1).trim();
  if (kind === 'wsl') {
    if (!rest || !isValidDistro(rest)) return undefined;
    return { kind: 'wsl', distro: rest };
  }
  if (rest !== undefined) return undefined;
  if (!(ENVIRONMENT_KINDS as readonly string[]).includes(kind)) return undefined;
  return { kind: kind as EnvironmentKind };
}

/**
 * Nome legível — cabeçalho do `<select>` e tooltip da sidebar. Os três
 * primeiros são nome de produto e saem iguais nos dois idiomas (spec §13);
 * passam pelo catálogo assim mesmo pra que exista UMA porta de rótulo de
 * ambiente, e não uma tradução e três literais.
 */
export function environmentLabel(env: SessionEnvironment, lang: Language): string {
  switch (env.kind) {
    case 'pwsh':
      return t(lang, 'ambiente.pwsh');
    case 'powershell':
      return t(lang, 'ambiente.powershell');
    case 'gitbash':
      return t(lang, 'ambiente.gitbash');
    case 'wsl':
      return t(lang, 'ambiente.wsl', { distro: env.distro ?? '' });
  }
}

/**
 * O que `GET /api/environments` devolve por ambiente disponível na máquina.
 *
 * `claude`/`node` são a resposta de "o agente sobe aqui?" e "o shim de hooks
 * tem com que rodar aqui?" — as duas perguntas que fazem a diferença entre uma
 * sessão que funciona e uma que abre e não reporta nada.
 */
export interface EnvironmentInfo {
  id: string;
  kind: EnvironmentKind;
  distro?: string;
  label: string;
  /** O shell/distro existe nesta máquina. */
  available: boolean;
  /** `claude` encontrado no PATH DESTE ambiente. */
  claude: boolean;
  /** `node` encontrado no PATH DESTE ambiente. Informativo: os hooks não o usam. */
  node: boolean;
  /**
   * WSL: o interop do Windows está ligado nesta distro? Os hooks do Bridge
   * rodam pelo Node do WINDOWS de dentro da distro (é a única forma de o shim
   * alcançar o `127.0.0.1` do host), e isso exige interop. Fora do WSL é
   * sempre `true` — a pergunta não se aplica.
   */
  interop: boolean;
  /** Por que não está disponível, ou o que falta. Já no idioma em vigor e sanitizado. */
  reason?: string;
}

/**
 * O aviso da linha do workspace quando a detecção não achou o `claude`.
 *
 * Eram CONSTANTES até a 0.12.2. Viraram função na 0.13.0 porque uma constante
 * de módulo é avaliada uma vez, na importação, e não tem como perguntar em que
 * idioma a janela está agora — e a troca de idioma é ao vivo (spec §13).
 */
export function environmentNoClaudeLabel(lang: Language): string {
  return t(lang, 'ambiente.semClaude.rotulo');
}

export function environmentNoClaudeTitle(lang: Language): string {
  return t(lang, 'ambiente.semClaude.titulo');
}

/**
 * O que a linha do workspace tem a dizer sobre o ambiente escolhido, cruzando
 * a escolha com o que `GET /api/environments` detectou.
 *
 * `unknown` = não há o que mostrar: ou o workspace não escolheu ambiente (usa
 * o `shell` global, que é o comportamento de sempre), ou a lista ainda não
 * chegou. Nunca inventar aviso com lista vazia: no primeiro segundo depois de
 * abrir o app TODO workspace de WSL apareceria quebrado.
 */
export type EnvironmentStatus = 'unknown' | 'ok' | 'no-claude' | 'missing';

export function environmentStatus(
  env: SessionEnvironment | undefined,
  list: readonly EnvironmentInfo[] | undefined,
): EnvironmentStatus {
  if (!env) return 'unknown';
  if (!list || list.length === 0) return 'unknown';
  const found = list.find((item) => item.id === environmentId(env));
  if (!found || !found.available) return 'missing';
  return found.claude ? 'ok' : 'no-claude';
}

/** O selo que a linha do workspace mostra: `wsl:Ubuntu`, `gitbash`. */
export function environmentBadge(env: SessionEnvironment | undefined): string | undefined {
  return env ? environmentId(env) : undefined;
}

/** O aviso de ambiente que não responde — ver `environmentNoClaudeLabel`. */
export function environmentMissingLabel(lang: Language): string {
  return t(lang, 'ambiente.sumiu.rotulo');
}

export function environmentMissingTitle(lang: Language): string {
  return t(lang, 'ambiente.sumiu.titulo');
}
