/**
 * O miolo PURO do painel "Uso" e do bloco de limites da sidebar (ADR-012).
 *
 * Mesma disciplina do `settingsModel.ts`: o `vitest` deste pacote roda em
 * ambiente `node`, então tudo que dá pra decidir sem tela — rótulo de janela,
 * frase de reset, degrau de cor, corte "8 maiores + outros", escala do
 * gráfico, o que cada cartão escreve — mora aqui e é testado direto. Os
 * componentes viram casca: recebem estes objetos e desenham as classes do
 * mock aprovado na Task 2a.
 *
 * O dinheiro e os tokens NÃO são formatados aqui: eles saem do
 * `@bridge/shared` (`formatUsd`, `formatTokens`), a mesma fonte que a
 * statusline devolvida ao Claude Code e a CLI usam. Um `toFixed` local aqui
 * seria a terceira convenção do mesmo número.
 *
 * Idioma (spec §13): TODA função daqui que escreve texto recebe `lang`
 * explícito — nada de default. Sem default, o compilador aponta toda ponta que
 * ainda não sabe em que idioma está, e não existe constante de módulo
 * guardando frase pronta (constante é avaliada uma vez, na importação, e a
 * troca de idioma é ao vivo).
 */
import {
  formatCount,
  formatTokens,
  formatUsd,
  MAX_USAGE_RANGE_DAYS,
  MIN_USAGE_DAY,
  sanitizeDisplay,
  settleLimits,
  USAGE_LIMIT_REACHED_PCT,
} from '@bridge/shared';
import type {
  Language,
  MessageKey,
  UsageAnchoredRange,
  UsageByModel,
  UsageByProject,
  UsageDay,
  UsageRange,
  UsageReport,
  UsageScanProgress,
  UsageTotals,
} from '@bridge/shared';
import { tUi } from './i18n.js';

export { formatCount, formatTokens, formatUsd };

// ------------------------------------------------------------- formatação

/**
 * O que a coluna de custo escreve quando o modelo não tem preço na tabela em
 * vigor. `null` não é `0`: um total baixo porque metade do consumo ficou de
 * fora não pode parecer boa notícia (contrato §4.1 da Task 1).
 */
export function noPriceLabel(lang: Language): string {
  return tUi(lang, 'uso.semPreco');
}

/** `US$ 1,23`, ou `sem preço` quando o core devolveu `cost: null`. */
export function formatCost(value: number | null, lang: Language): string {
  return value === null ? noPriceLabel(lang) : formatUsd(value, lang);
}

// --------------------------------------------------------- nome de modelo

/**
 * As famílias que o Bridge sabe escrever por extenso. Só estas — um id de
 * família nova sai CRU, que é sempre verdade, em vez de virar um nome bonito
 * inventado por regex.
 */
const MODEL_FAMILIES: Record<string, string> = {
  fable: 'Fable',
  mythos: 'Mythos',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * `claude-fable-5-1` → `Fable 5.1`; `claude-opus-5` → `Opus 5`;
 * `claude-sonnet-4-5-20260514` → `Sonnet 4.5`.
 *
 * Existe porque a tabela do painel é uma coluna estreita e o id cru gasta ela
 * inteira dizendo três vezes "claude". O id CONTINUA acessível: ele é a chave
 * da linha e vai no `title` da célula — o nome curto é a leitura, o id é a
 * fonte, e quem for procurar o modelo na documentação precisa do segundo.
 *
 * Id que não casa com o padrão (família desconhecida, snapshot com forma
 * própria, `<synthetic>`) volta INTEIRO. Encurtar na marra o que não se
 * reconhece é como se inventa um nome errado.
 */
/**
 * Teto de um rótulo de transcript/payload na tela (BU-13).
 *
 * O React escapa HTML, então um `cwd` com `<script>` nunca executou; o que
 * faltava era TAMANHO e CONTROLE. Um `cwd` de 10 kB num `title`/`aria-label`
 * vira um balão que cobre a janela e uma frase que o leitor de tela lê por
 * minutos; uma quebra de linha no meio dele estraga a leitura. O
 * `sanitizeDisplay` é a mesma função que a statusline e a CLI usam — um
 * dado, uma regra.
 */
export const LABEL_MAX = 120;

/** Texto de fora pronto pra `title`, `aria-label` ou célula da tabela. */
export function displayText(value: string, max: number = LABEL_MAX): string {
  return sanitizeDisplay(value, max);
}

export function modelDisplayName(id: string): string {
  // Versão e revisão são de 1 a 2 dígitos, e não `\d+`: com `\d+` o
  // `20260901` de `claude-opus-5-20260901` era engolido como revisão e saía
  // "Opus 5.20260901". A data tem 8 dígitos e só casa no grupo dela.
  const match = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id.trim());
  if (!match) return displayText(id);
  const family = MODEL_FAMILIES[match[1] ?? ''];
  if (!family) return displayText(id);
  const major = match[2];
  const minor = match[3];
  return minor === undefined ? `${family} ${major}` : `${family} ${major}.${minor}`;
}

// ----------------------------------------------------------- degrau/barra

export type QuotaLevel = 'ok' | 'warn' | 'bad';

/** `ok < 60 <= warn < 85 <= bad` — o mesmo degrau da faixa de cota antiga. */
export function limitLevel(usedPct: number): QuotaLevel {
  if (!Number.isFinite(usedPct) || usedPct < 60) return 'ok';
  if (usedPct < 85) return 'warn';
  return 'bad';
}

/**
 * Largura de barra em porcentagem, sempre entre 0 e 100. O payload da
 * statusline já mandou `used_percentage` acima de 100 em conta estourada, e
 * uma barra de 118% vaza do trilho em vez de dizer "acabou".
 */
export function barPercent(value: number, total = 100): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

// ------------------------------------------------------ rótulo de janela

export interface WindowLabel {
  /** O que o cartão escreve: rótulo humano, ou a chave crua do payload. */
  label: string;
  /**
   * `true` = janela que o Bridge não conhece e o rótulo é a CHAVE. O cartão
   * marca com `.raw` (mono, um degrau menor): traduzir por adivinhação daria
   * um nome bonito e possivelmente errado, enquanto a chave é sempre verdade.
   */
  raw: boolean;
}

const PANEL_KEYS: Record<string, MessageKey> = {
  five_hour: 'uso.janela.cincoHoras',
  seven_day: 'uso.janela.semana',
};

/** Rótulo do cartão do painel a partir da chave crua do payload. */
export function windowLabel(window: string, lang: Language): WindowLabel {
  const known = PANEL_KEYS[window];
  // A chave crua vem do payload da statusline (A5) e vira rótulo e
  // `aria-label`: limpa e cortada, como tudo que veio de fora (BU-13).
  return known ? { label: tUi(lang, known), raw: false } : { label: displayText(window, 64), raw: true };
}

const STRIP_KEYS: Record<string, MessageKey> = {
  five_hour: 'uso.janela.curta.cincoHoras',
  seven_day: 'uso.janela.curta.semana',
};

/**
 * Rótulo de 20 px da faixa da sidebar. Janela desconhecida entra com a chave
 * inteira — ela corta na coluna estreita, mas o `title` da linha carrega o
 * texto completo.
 */
export function stripWindowLabel(window: string, lang: Language): string {
  const known = STRIP_KEYS[window];
  return known ? tUi(lang, known) : displayText(window, 64);
}

// ---------------------------------------------------------------- reset

/** Abreviações e nomes por extenso, na ordem de `Date.getDay()`. */
const WEEKDAY_SHORT_KEYS: readonly MessageKey[] = [
  'uso.diaSemana.curto.dom',
  'uso.diaSemana.curto.seg',
  'uso.diaSemana.curto.ter',
  'uso.diaSemana.curto.qua',
  'uso.diaSemana.curto.qui',
  'uso.diaSemana.curto.sex',
  'uso.diaSemana.curto.sab',
];
const WEEKDAY_LONG_KEYS: readonly MessageKey[] = [
  'uso.diaSemana.longo.dom',
  'uso.diaSemana.longo.seg',
  'uso.diaSemana.longo.ter',
  'uso.diaSemana.longo.qua',
  'uso.diaSemana.longo.qui',
  'uso.diaSemana.longo.sex',
  'uso.diaSemana.longo.sab',
];

export interface ResetParts {
  /**
   * O prefixo que SOME quando a sidebar aperta (`.reset-word`): `reseta em `
   * abaixo de 24 h, `reseta ` a partir daí. Ele sai porque é a única parte da
   * frase que não carrega número.
   */
  word: string;
  /** Forma curta da sidebar: `43min`, `2h15`, `seg`. */
  short: string;
  /** Forma longa do painel: `43min`, `2h15`, `na segunda`. */
  long: string;
}

/**
 * Epoch em SEGUNDOS (como o payload manda) → as duas formas da frase de reset.
 *
 * Reset ausente ou VENCIDO devolve `undefined`: "reseta em -2h" seria pior que
 * não escrever nada, e um `resets_at` no passado só quer dizer que a janela
 * ainda não foi renovada no payload que temos em mãos. Mesma regra do
 * `formatReset` do core — as duas superfícies têm que dizer a mesma coisa.
 */
export function resetParts(resetsAt: number | undefined, lang: Language, now: number = Date.now()): ResetParts | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
  const at = resetsAt * 1000;
  const ms = at - now;
  if (ms <= 0) return undefined;

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    const text = `${Math.max(1, minutes)}min`;
    return { word: tUi(lang, 'uso.reseta.em'), short: text, long: text };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    const text = rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
    return { word: tUi(lang, 'uso.reseta.em'), short: text, long: text };
  }
  // Dia da semana no fuso do PROCESSO: é o relógio de parede de quem lê.
  const day = new Date(at).getDay();
  const short = WEEKDAY_SHORT_KEYS[day];
  const long = WEEKDAY_LONG_KEYS[day];
  return {
    word: tUi(lang, 'uso.reseta.no'),
    short: short ? tUi(lang, short) : '',
    long: long ? tUi(lang, long) : '',
  };
}

/** A frase inteira do painel: `reseta em 2h15`, `reseta na segunda`. */
export function resetText(resetsAt: number | undefined, lang: Language, now: number = Date.now()): string | undefined {
  const parts = resetParts(resetsAt, lang, now);
  return parts ? `${parts.word}${parts.long}` : undefined;
}

// ------------------------------------------------------ recorte e cabeçalho

const MONTH_KEYS: readonly MessageKey[] = [
  'uso.mes.1',
  'uso.mes.2',
  'uso.mes.3',
  'uso.mes.4',
  'uso.mes.5',
  'uso.mes.6',
  'uso.mes.7',
  'uso.mes.8',
  'uso.mes.9',
  'uso.mes.10',
  'uso.mes.11',
  'uso.mes.12',
];

/**
 * `AAAA-MM-DD` → partes numéricas. Sem `new Date(iso)`: a string sem fuso é
 * interpretada como UTC pelo motor, e no Brasil isso volta um dia atrás.
 */
function parseDay(day: string): { year: number; month: number; date: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), date: Number(match[3]) };
}

/** `2026-08-31` → `31/08`. Vazio quando a string não é um dia local. */
export function shortDay(day: string): string {
  const parsed = parseDay(day);
  if (!parsed) return '';
  return `${String(parsed.date).padStart(2, '0')}/${String(parsed.month).padStart(2, '0')}`;
}

/** `2026-09-10` → `10/09/2026`. Vazio quando a string não é um dia local. */
export function longDay(day: string): string {
  const parsed = parseDay(day);
  if (!parsed) return '';
  return `${shortDay(day)}/${parsed.year}`;
}

/**
 * `31/08` dentro do ano de hoje e `29/12/2025` fora dele. Sem `today` (core
 * anterior ao campo) fica o curto, que é o que o painel sempre escreveu.
 */
function dayInYear(day: string, today: string | undefined): string {
  return today !== undefined && day.slice(0, 4) !== today.slice(0, 4) ? longDay(day) : shortDay(day);
}

/**
 * Nome do recorte: `hoje`, `10/09/2026`, `semana de 31/08`, `setembro de
 * 2026`, `2026`, `01/08 – 15/09/2026`.
 *
 * `today` é o dia local de HOJE segundo o core (`report.today`). É ele que
 * separa o "hoje" de um dia passado; ausente, o dia continua sendo "hoje" —
 * o único dia que um core sem o campo sabia mostrar.
 */
export function rangeLabel(range: UsageRange, from: string, to: string, lang: Language, today?: string): string {
  if (range === 'day') return today === undefined || from === today ? tUi(lang, 'uso.recorte.hoje') : longDay(from);
  if (range === 'week') return tUi(lang, 'uso.recorte.semana', { dia: dayInYear(from, today) });
  if (range === 'year') return String((parseDay(from) ?? parseDay(to))?.year ?? '');
  if (range === 'custom') {
    if (from === to) return longDay(from);
    // O ano sai UMA vez quando as duas pontas estão no mesmo ano: repeti-lo
    // em "01/08/2026 – 15/09/2026" só alarga o cabeçalho.
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return tUi(lang, 'uso.recorte.intervalo', { de: sameYear ? shortDay(from) : longDay(from), ate: longDay(to) });
  }
  const parsed = parseDay(to) ?? parseDay(from);
  if (!parsed) return tUi(lang, 'uso.recorte.mes');
  const month = MONTH_KEYS[parsed.month - 1];
  return tUi(lang, 'uso.recorte.mesAno', { mes: month ? tUi(lang, month) : '', ano: parsed.year });
}

/**
 * A dica ao lado do título. "meia-noite local" aparece **só** no recorte de
 * dia: é ali que a borda decide se uma sessão da madrugada conta hoje ou
 * ontem; nos outros recortes a mesma frase seria ruído.
 */
export function headerNote(range: UsageRange, from: string, to: string, lang: Language, today?: string): string {
  const label = rangeLabel(range, from, to, lang, today);
  return range === 'day' ? tUi(lang, 'uso.cabecalho.dia', { recorte: label }) : label;
}

// ------------------------------------------------------------ estado vazio

export interface EmptyState {
  /** `Nenhuma transcrição encontrada em …` — com a pasta que o core informou. */
  title: string;
  home: string;
  hint: string;
}

export function emptyHeaderNote(lang: Language): string {
  return tUi(lang, 'uso.vazio.cabecalho');
}

export function emptyHint(lang: Language): string {
  return tUi(lang, 'uso.vazio.dica');
}

/**
 * Nenhum transcript VARRIDO — não "nenhum consumo no recorte". Um mês sem uso
 * numa máquina cheia de transcrições é um painel zerado legítimo, e trocá-lo
 * pelo "não encontrei nada" mandaria a pessoa procurar um defeito que não
 * existe.
 */
export function isEmpty(report: UsageReport): boolean {
  return report.scannedFiles === 0;
}

export function emptyState(report: UsageReport, lang: Language): EmptyState {
  const home = `${report.claudeHome.replace(/[\\/]+$/, '')}\\projects`;
  return { title: tUi(lang, 'uso.vazio.titulo'), home, hint: emptyHint(lang) };
}

// -------------------------------------------- progresso da varredura

/**
 * A frase do estado vazio ENQUANTO a varredura está em voo, ou `undefined`
 * quando não há varredura acontecendo.
 *
 * Existe porque a primeira leitura de um histórico grande leva minutos (a Task
 * 1 mediu 8.431 arquivos e 12,8 GB nesta máquina) e, até ela chegar na
 * primeira transcrição com consumo, `scannedFiles` é 0 — e o painel afirmava
 * "Nenhuma transcrição encontrada", que manda a pessoa procurar um defeito
 * inexistente. "Ainda lendo" é a única frase verdadeira nesse intervalo.
 */
export function scanningLine(scanning: UsageScanProgress | null | undefined, lang: Language): string | undefined {
  if (!scanning?.active) return undefined;
  return tUi(lang, 'uso.varredura.lendo', {
    feitos: formatCount(scanning.filesDone, lang),
    total: formatCount(scanning.filesTotal, lang),
  });
}

/**
 * O que a varredura NÃO leu, em uma frase — ou `undefined` quando leu tudo.
 *
 * Existe porque as duas travas que a fase de segurança acrescentou fazem a
 * contagem ficar MENOR que o consumo real, e um número menor que o real
 * apresentado como se fosse o total é exatamente o defeito que o BU-01 tinha
 * (ele só era pior por ser silencioso):
 *
 * - `skippedLines`: linha de transcrição acima do teto de 4 MiB, pulada pra
 *   que o offset daquele arquivo nunca trave;
 * - `capped`: a árvore tem mais arquivos que o teto da listagem, e o resto
 *   ficou de fora desta passada.
 *
 * As duas são raras a ponto de não merecerem espaço fixo na tela — mas quando
 * acontecem, quem olha o painel precisa saber ANTES de acreditar no número.
 */
export function scanCaveat(scanning: UsageScanProgress | null | undefined, lang: Language): string | undefined {
  if (!scanning) return undefined;
  const partes: string[] = [];
  if (scanning.skippedLines > 0) {
    partes.push(
      scanning.skippedLines === 1
        ? tUi(lang, 'uso.varredura.linhaIgnorada.uma')
        : tUi(lang, 'uso.varredura.linhaIgnorada.varias', { n: formatCount(scanning.skippedLines, lang) }),
    );
  }
  if (scanning.capped) partes.push(tUi(lang, 'uso.varredura.limitada', { n: formatCount(MAX_SCAN_FILES, lang) }));
  if (partes.length === 0) return undefined;
  return tUi(lang, 'uso.varredura.ressalva', { partes: partes.join(' · ') });
}

/**
 * O teto de arquivos por listagem do core (`MAX_TRANSCRIPT_FILES`). Repetido
 * aqui porque a UI não importa do core; o número aparece só na frase acima.
 */
export const MAX_SCAN_FILES = 50_000;

/** O que o `POST /api/usage/rescan` devolve — vira a linha de status do botão. */
export interface RescanResult {
  files: number;
  entries: number;
  days: number;
}

/**
 * A linha de status do botão "Reler transcrições": progresso enquanto a
 * varredura roda, resultado depois dela.
 *
 * A porcentagem é dos BYTES, não dos arquivos: numa árvore real convivem
 * transcrições de 4 KB e de 200 MB, e uma fração por contagem de arquivos anda
 * em saltos que não têm relação com o tempo que falta. Sem `bytesTotal`
 * (árvore vazia) ela some, em vez de virar uma divisão por zero.
 */
export function rescanStatus(
  scanning: UsageScanProgress | null | undefined,
  result: RescanResult | undefined,
  lang: Language,
): string | undefined {
  if (scanning?.active) {
    const fracao = tUi(lang, 'uso.rescan.fracao', {
      feitos: formatCount(scanning.filesDone, lang),
      total: formatCount(scanning.filesTotal, lang),
    });
    if (scanning.bytesTotal <= 0) return tUi(lang, 'uso.rescan.lendo', { fracao });
    const pct = Math.min(100, Math.floor((scanning.bytesDone / scanning.bytesTotal) * 100));
    return tUi(lang, 'uso.rescan.lendoPct', { fracao, pct });
  }
  if (!result) return undefined;
  const dias =
    result.days === 1 ? tUi(lang, 'uso.rescan.umDia') : tUi(lang, 'uso.rescan.dias', { n: formatCount(result.days, lang) });
  return tUi(lang, 'uso.rescan.pronto', {
    arquivos: formatCount(result.files, lang),
    mensagens: formatCount(result.entries, lang),
    dias,
  });
}

// -------------------------------------------------------------- limites

export interface LimitCardModel {
  window: string;
  label: string;
  /** Rótulo é a chave crua do payload (janela desconhecida). */
  raw: boolean;
  /** `68%` já escrito. */
  pct: string;
  level: QuotaLevel;
  /** Largura da barra, 0–100. */
  fill: number;
  /** `reseta em 2h15`; ausente quando o reset venceu ou não veio. */
  reset?: string;
}

export interface LimitRowModel {
  window: string;
  /** `5h`, `sem`, ou a chave crua. */
  label: string;
  pct: string;
  level: QuotaLevel;
  fill: number;
  reset?: ResetParts;
  /** Frase inteira pro `title` da linha — ela corta na sidebar estreita. */
  title: string;
}

/**
 * Os cartões do painel: um por janela do array, nunca dois fixos.
 *
 * As três funções abaixo passam a lista por `settleLimits` com o MESMO `now`
 * do reset (16/09/2026): a foto do core pode ter horas — as barras são fixas
 * e o Claude ocioso não manda `rate_limits` — e a janela cujo `resets_at` já
 * passou tem que virar 0 % aqui na tela, no tique do relógio da sidebar, sem
 * esperar o core reler nada.
 */
export function limitCards(
  limits: readonly { window: string; usedPct: number; resetsAt?: number }[],
  lang: Language,
  now = Date.now(),
): LimitCardModel[] {
  return settleLimits(limits, now).map((limit) => {
    const { label, raw } = windowLabel(limit.window, lang);
    const pct = Math.round(limit.usedPct);
    const reset = resetText(limit.resetsAt, lang, now);
    return {
      window: limit.window,
      label,
      raw,
      pct: `${pct}%`,
      level: limitLevel(limit.usedPct),
      fill: barPercent(limit.usedPct),
      ...(reset ? { reset } : {}),
    };
  });
}

/** As linhas do bloco `.sidebar-limits` (duas barras sob o cabeçalho). */
export function limitRows(
  limits: readonly { window: string; usedPct: number; resetsAt?: number }[],
  lang: Language,
  now = Date.now(),
): LimitRowModel[] {
  return settleLimits(limits, now).map((limit) => {
    const label = stripWindowLabel(limit.window, lang);
    const pct = `${Math.round(limit.usedPct)}%`;
    const reset = resetParts(limit.resetsAt, lang, now);
    const full = windowLabel(limit.window, lang);
    return {
      window: limit.window,
      label,
      pct,
      level: limitLevel(limit.usedPct),
      fill: barPercent(limit.usedPct),
      ...(reset ? { reset } : {}),
      title: [full.label, pct, reset ? `${reset.word}${reset.long}` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' · '),
    };
  });
}

// ------------------------------------------ limite de USO atingido (100 %)

/**
 * O selo vermelho do limite de USO — o gêmeo do laranja do servidor. Esta é a
 * ÚNICA implementação do texto (fix round 1); o limiar vem do
 * `@bridge/shared`, que é onde a política mora.
 */
export interface UsageLimitBadge {
  text: string;
  title: string;
}

/**
 * `limite de uso atingido · reseta em 43min`, ou `undefined` quando nenhuma
 * janela estourou.
 *
 * Ele existe separado do selo de `server-limited` porque os dois limites são
 * coisas diferentes e a UI é o único lugar onde a pessoa vai distingui-los: o
 * de uso é SEU, escala com o plano e reseta numa hora que dá pra ver; o do
 * servidor não é seu, não escala com plano nenhum e passa sozinho.
 */
export function usageLimitBadge(
  limits: readonly { window: string; usedPct: number; resetsAt?: number }[],
  lang: Language,
  now = Date.now(),
): UsageLimitBadge | undefined {
  // Janela renovada não está mais em 100 %: sem o `settle` o selo vermelho
  // ficaria aceso depois do reset até a próxima statusline.
  const reached = settleLimits(limits, now).find((limit) => limit.usedPct >= USAGE_LIMIT_REACHED_PCT);
  if (!reached) return undefined;
  const reset = resetText(reached.resetsAt, lang, now);
  // Curto no selo (`5h`, `sem`), por extenso no tooltip: a faixa da sidebar
  // tem uma linha, e "Limite de 5 horas" a estouraria.
  const short = stripWindowLabel(reached.window, lang);
  const { label } = windowLabel(reached.window, lang);
  const text = reset
    ? tUi(lang, 'uso.limite.atingido', { reset })
    : tUi(lang, 'uso.limite.atingidoSemReset', { janela: short });
  return {
    text,
    title: tUi(lang, 'uso.limite.titulo', { janela: label, pct: Math.round(reached.usedPct) }),
  };
}

/** Texto do cartão chato que substitui a grade em conta de API key. */
export function noLimitsLabel(lang: Language): string {
  return tUi(lang, 'uso.semLimites.rotulo');
}
export function noLimitsNote(lang: Language): string {
  return tUi(lang, 'uso.semLimites.nota');
}

// --------------------------------------------------------- cartões de total

export interface TotalCardModel {
  id: 'input' | 'output' | 'cache' | 'cost' | 'messages';
  label: string;
  value: string;
  /** Linha de apoio, cortada com reticências e repetida no `title`. */
  sub: string;
}

/**
 * Os cinco cartões. O de custo SOME com `usage.showCost` desligado — e nesse
 * caso a grade fica com quatro, que é justamente por que ela é `repeat(5, 1fr)`
 * e não uma coluna por cartão: quatro cartões em cinco colunas deixariam um
 * buraco à direita, então quem some some da lista, não da grade.
 */
/**
 * A sub-linha do cartão de cache.
 *
 * A escrita de 1 h só aparece quando existe: ela é rara em muitos usos, e uma
 * terceira parcela escrita `0` toda vez gastaria a linha inteira pra dizer
 * "não houve". Quando existe, ela precisa aparecer — custa o DOBRO do input
 * (a de 5 min custa 1,25 ×), então uma linha que a some com a outra esconde de
 * onde o custo veio.
 */
export function cacheSub(t: UsageTotals, lang: Language): string {
  const partes = [tUi(lang, 'uso.cache.escrita', { valor: formatTokens(t.cacheWrite, lang) })];
  if (t.cacheWrite1h > 0) partes.push(tUi(lang, 'uso.cache.escrita1h', { valor: formatTokens(t.cacheWrite1h, lang) }));
  partes.push(tUi(lang, 'uso.cache.leitura', { valor: formatTokens(t.cacheRead, lang) }));
  return partes.join(' · ');
}

export function totalCards(report: UsageReport, opts: { showCost: boolean }, lang: Language): TotalCardModel[] {
  const t = report.totals;
  const period = headerPeriod(report, lang);
  const tokens = tUi(lang, 'uso.cartao.tokens');
  const cards: TotalCardModel[] = [
    { id: 'input', label: tUi(lang, 'uso.cartao.entrada'), value: formatTokens(t.input, lang), sub: tokens },
    { id: 'output', label: tUi(lang, 'uso.cartao.saida'), value: formatTokens(t.output, lang), sub: tokens },
    {
      id: 'cache',
      label: tUi(lang, 'uso.cartao.cache'),
      value: formatTokens(t.cacheWrite + t.cacheWrite1h + t.cacheRead, lang),
      sub: cacheSub(t, lang),
    },
  ];
  if (opts.showCost) {
    cards.push({
      id: 'cost',
      label: tUi(lang, 'uso.cartao.custo'),
      // `costPartial` não vira asterisco no cartão: quem explica é o aviso
      // abaixo da tabela, que diz QUAL modelo ficou de fora.
      value: formatCost(t.cost, lang),
      sub: period,
    });
  }
  cards.push({
    id: 'messages',
    label: tUi(lang, 'uso.cartao.mensagens'),
    value: formatCount(t.messages, lang),
    sub: [
      countLabel(report.byModel.length, MODEL_NOUN, lang),
      countLabel(report.byProject.length, PROJECT_NOUN, lang),
      subagentNote(report, lang),
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · '),
  });
  return cards;
}

/** O período curto do sub do cartão de custo (`setembro de 2026`, `hoje`). */
function headerPeriod(report: UsageReport, lang: Language): string {
  return rangeLabel(report.range, report.from, report.to, lang, report.today);
}

/**
 * O substantivo contado, nas duas formas. Plural é chave explícita (spec §13):
 * a regra do português não é a do inglês, e nenhuma das duas é a do russo.
 */
export interface CountNoun {
  one: MessageKey;
  many: MessageKey;
}

export const MODEL_NOUN: CountNoun = { one: 'uso.substantivo.modelo.uma', many: 'uso.substantivo.modelo.varias' };
export const PROJECT_NOUN: CountNoun = { one: 'uso.substantivo.projeto.uma', many: 'uso.substantivo.projeto.varias' };

function countLabel(count: number, noun: CountNoun, lang: Language): string {
  return tUi(lang, 'uso.contagem', { n: count, itens: tUi(lang, count === 1 ? noun.one : noun.many) });
}

/**
 * `inclui 312 de subagentes` — a fatia do total que não veio da sessão
 * principal. Um mês que parece caro pode ser só um lote de subagentes, e o
 * número cheio sozinho não distingue as duas coisas.
 *
 * `undefined` quando o core não manda `bySource` (versão anterior) ou quando
 * não houve subagente: escrever "inclui 0 de subagentes" seria ruído.
 */
export function subagentNote(report: UsageReport, lang: Language): string | undefined {
  const subagents = report.bySource?.subagents;
  if (!subagents || subagents.messages <= 0) return undefined;
  return tUi(lang, 'uso.subagentes', { n: formatCount(subagents.messages, lang) });
}

// -------------------------------------------------------------- gráfico

export interface ChartColumnModel {
  day: string;
  /** `sáb, 22/08` — o que o tooltip e o `aria-label` escrevem. */
  when: string;
  /** `05/09` no eixo; vazio nas colunas sem marca (uma a cada 6 dias). */
  tick: string;
  /** Fora do recorte selecionado: a barra recua pro `--border-strong`. */
  out: boolean;
  /** Altura da barra em porcentagem do plot. */
  height: number;
  /** Dia sem NENHUMA mensagem: um traço na linha de base, não uma barra de 0. */
  zero: boolean;
  cost: string;
  sub: string;
  label: string;
  /**
   * Coluna perto de uma BORDA da série: o tooltip encosta nela em vez de
   * centralizar, senão vaza do cartão. Era um `:nth-child` fixo no CSS (3
   * primeiras, 3 últimas) — que numa série de 365 colunas jogava quase todas
   * pra "borda direita".
   */
  edge?: 'start' | 'end';
}

export interface ChartModel {
  columns: ChartColumnModel[];
  /** Os quatro rótulos do eixo, de cima (`y3`) pra baixo (`y0`). */
  ticks: [string, string, string, string];
  max: number;
  /**
   * Série longa demais pro desenho de 30 colunas (um ano, um intervalo livre
   * grande): barras sem vão, marca do eixo por MÊS e coluna fora da ordem do
   * Tab. Ver `CHART_DENSE_COLUMNS`.
   */
  dense: boolean;
}

/**
 * A partir de quantas colunas o gráfico fica DENSO. Até dois meses cada
 * coluna ainda tem largura pra vão, rótulo a cada N dias e parada de Tab; um
 * ano com 365 paradas de Tab e 5 px de vão entre barras de 2 px não tem.
 */
export const CHART_DENSE_COLUMNS = 62;

/** O tamanho da série "de sempre" — o mesmo `CHART_DAYS` do core. */
const CHART_BASE_DAYS = 30;

/** Dia da semana de um `AAAA-MM-DD` LOCAL, sem passar pelo parser de UTC. */
function weekdayOf(day: string, lang: Language): string {
  const parsed = parseDay(day);
  if (!parsed) return '';
  const key = WEEKDAY_SHORT_KEYS[new Date(parsed.year, parsed.month - 1, parsed.date).getDay()];
  return key ? tUi(lang, key) : '';
}

/**
 * Passos "redondos" da escala. O eixo tem QUATRO marcas (0 e três linhas de
 * grade), então o topo é sempre `passo × 3` — é o que faz `US$ 6 / 12 / 18`
 * sair em vez de `5,33 / 10,67 / 16`.
 */
const SCALE_STEPS = [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 500, 1000] as const;

function pickStep(max: number): number {
  const wanted = max / 3;
  for (const step of SCALE_STEPS) {
    if (step >= wanted) return step;
  }
  // Acima da tabela: sobe em potências de 10 até cobrir.
  let step = SCALE_STEPS[SCALE_STEPS.length - 1] ?? 1000;
  while (step < wanted) step *= 10;
  return step;
}

function tickText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

/**
 * A métrica do gráfico. `cost` é o padrão — é a pergunta que o painel responde.
 * Com `usage.showCost` desligado o painel não escreve dinheiro em lugar nenhum,
 * e a mesma estrutura passa a contar TOKENS por dia: muda a escala e o rótulo,
 * não o desenho.
 */
export type ChartMetric = 'cost' | 'tokens';

/**
 * Máximo arredondado pra cima e as quatro marcas do eixo. Recorte sem consumo
 * nenhum ainda desenha a escala: um eixo em branco pareceria gráfico quebrado,
 * e as barras zeradas já contam a história.
 */
export function chartScale(
  values: readonly number[],
  lang: Language,
  metric: ChartMetric = 'cost',
): { max: number; ticks: [string, string, string, string] } {
  const peak = values.reduce((acc, value) => (Number.isFinite(value) && value > acc ? value : acc), 0);
  if (metric === 'tokens') {
    const step = peak <= 0 ? 1000 : pickTokenStep(peak);
    const max = step * 3;
    return { max, ticks: [formatTokens(max, lang), formatTokens(step * 2, lang), formatTokens(step, lang), '0'] };
  }
  const step = peak <= 0 ? 1 : pickStep(peak);
  const max = step * 3;
  return {
    max,
    ticks: [`US$ ${tickText(max)}`, tickText(step * 2), tickText(step), '0'],
  };
}

/** Mesma ideia do `pickStep`, na escala dos tokens (mil a bilhão). */
function pickTokenStep(max: number): number {
  const wanted = max / 3;
  let step = 1000;
  while (step < wanted) {
    // 1k → 2k → 5k → 10k …: a mesma progressão 1/2/5 de qualquer eixo.
    const digits = Math.floor(Math.log10(step));
    const lead = step / 10 ** digits;
    step = lead === 1 ? 2 * 10 ** digits : lead === 2 ? 5 * 10 ** digits : 10 ** (digits + 1);
  }
  return step;
}

/**
 * Onde o eixo escreve a data. 30 dias com 30 rótulos viram uma tarja cinza
 * ilegível, então:
 *
 * - série densa (um ano) → o primeiro dia de cada MÊS, que é como se lê um
 *   ano; a última coluna não é forçada, porque cairia colada num "01/12";
 * - série curta → a cada 6 colunas até 31, a cada um sexto da série acima
 *   disso, e a última SEMPRE — salvo quando encosta na marca regular anterior
 *   e os dois rótulos se sobreporiam.
 */
function tickAt(days: readonly UsageDay[], index: number, dense: boolean): boolean {
  if (dense) return days[index]?.day.endsWith('-01') ?? false;
  const step = days.length <= 31 ? 6 : Math.ceil(days.length / 6);
  if (index % step === 0) return true;
  const lastIndex = days.length - 1;
  return index === lastIndex && lastIndex % step >= step / 2;
}

/**
 * A série do gráfico — 30 dias no caso comum, até um ano no período longo.
 * Custo por dia é a métrica: é a pergunta que o painel responde. Um dia sem
 * preço (`cost: null`) entra como 0 na altura, mas o tooltip diz `sem preço`
 * — a barra some, a informação não.
 */
export function chartModel(report: UsageReport, lang: Language, metric: ChartMetric = 'cost'): ChartModel {
  const days = report.byDay;
  const value = (day: (typeof days)[number]): number => (metric === 'tokens' ? day.tokens : (day.cost ?? 0));
  const { max, ticks } = chartScale(days.map(value), lang, metric);
  const dense = days.length > CHART_DENSE_COLUMNS;
  // Um décimo da série em cada ponta, nunca menos de 3 colunas (as 3 do
  // desenho de 30 dias aprovado na Task 2a).
  const edgeSpan = Math.max(3, Math.ceil(days.length * 0.1));
  const columns = days.map((day, index) => {
    const when = `${weekdayOf(day.day, lang)}, ${shortDay(day.day)}`;
    const zero = day.messages === 0;
    // Dia SEM mensagem nenhuma escreve `US$ 0,00`, não `sem preço`: o core
    // devolve `cost: null` num dia zerado porque não houve modelo a precificar,
    // e "sem preço" ali mandaria procurar uma tabela que não faltou.
    const costText =
      metric === 'tokens'
        ? tUi(lang, 'uso.grafico.tokens', { valor: formatTokens(day.tokens, lang) })
        : zero
          ? formatUsd(0, lang)
          : formatCost(day.cost, lang);
    const mensagens = tUi(lang, 'uso.grafico.mensagens', { n: formatCount(day.messages, lang) });
    const sub =
      metric === 'tokens'
        ? mensagens
        : `${mensagens} · ${tUi(lang, 'uso.grafico.tokens', { valor: formatTokens(day.tokens, lang) })}`;
    const edge: ChartColumnModel['edge'] = index < edgeSpan ? 'start' : index >= days.length - edgeSpan ? 'end' : undefined;
    return {
      day: day.day,
      when,
      tick: tickAt(days, index, dense) ? shortDay(day.day) : '',
      out: day.day < report.from || day.day > report.to,
      ...(edge !== undefined ? { edge } : {}),
      // Dia com consumo e custo perto de zero ainda desenha um fio: sem isso
      // ele viraria o traço de "dia sem consumo", que é outra coisa.
      height: zero ? 0 : Math.max(1.5, barPercent(value(day), max)),
      zero,
      cost: costText,
      sub,
      label: `${when} · ${costText} · ${mensagens}`,
    };
  });
  return { columns, ticks, max, dense };
}

// -------------------------------------------------------------- tabelas

export interface TableRowModel {
  /**
   * Id ESTÁVEL da linha, só pra ser a `key` do React.
   *
   * Não é o `key` abaixo de propósito: aquele passou a ser texto SANITIZADO
   * (BU-13), e duas linhas diferentes podem sanitizar pro mesmo texto — dois
   * `cwd` que só diferem por um caractere invisível, ou dois de 10 kB com o
   * mesmo prefixo de 120. Com `key` duplicada o React reaproveita a linha
   * errada ao reordenar a tabela. O índice é estável dentro de uma renderização
   * (a lista já vem ordenada pelo core) e não depende do conteúdo.
   */
  id: string;
  /** O texto cru JÁ LIMPO — vai pro `title` quando o nome curto esconde algo. */
  key: string;
  /** O que a primeira coluna escreve. */
  name: string;
  messages: string;
  tokens: string;
  cost: string;
  /** Modelo sem preço: a linha inteira em `--warn`. */
  unpriced: boolean;
  /** Largura da barra de participação; ausente na linha "outros". */
  share?: number;
}

export interface TableModel {
  rows: TableRowModel[];
  total: { messages: string; tokens: string; cost: string };
  /** Quantos itens couberam no "outros" — 0 = não houve corte. */
  othersCount: number;
}

/** Soma de um lote de recortes, com a mesma semântica de `cost: null`. */
export function sumTotals(items: readonly UsageTotals[]): UsageTotals {
  const out: UsageTotals = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    tokens: 0,
    messages: 0,
    cost: null,
    costPartial: false,
  };
  for (const item of items) {
    out.input += item.input;
    out.output += item.output;
    out.cacheWrite += item.cacheWrite;
    out.cacheWrite1h += item.cacheWrite1h;
    out.cacheRead += item.cacheRead;
    out.tokens += item.tokens;
    out.messages += item.messages;
    if (item.cost === null) out.costPartial = true;
    else out.cost = (out.cost ?? 0) + item.cost;
    if (item.costPartial) out.costPartial = true;
  }
  return out;
}

export const TOP_N = 8;

export interface TopNResult<T> {
  head: T[];
  /** `undefined` quando não houve corte. */
  others?: { count: number; label: string; totals: UsageTotals };
}

/**
 * Os 8 maiores + `outros (N projetos)`. O core devolve as listas completas
 * (contrato §4.1) porque o corte é decisão de tela: a CLI da Task 3 quer a
 * lista inteira.
 */
export function topNWithOthers<T extends UsageTotals>(
  items: readonly T[],
  noun: CountNoun,
  lang: Language,
  limit: number = TOP_N,
): TopNResult<T> {
  if (items.length <= limit) return { head: [...items] };
  const head = items.slice(0, limit);
  const rest = items.slice(limit);
  return {
    head,
    others: {
      count: rest.length,
      label: tUi(lang, 'uso.tabela.outros', {
        n: rest.length,
        itens: tUi(lang, rest.length === 1 ? noun.one : noun.many),
      }),
      totals: sumTotals(rest),
    },
  };
}

/**
 * Base da barra de participação: o custo quando o recorte tem custo, senão os
 * tokens. Sem a reserva, um mês inteiro de modelos sem preço deixaria a coluna
 * com nove barras vazias — comparação nenhuma.
 */
function shareBasis(total: UsageTotals): 'cost' | 'tokens' {
  return total.cost !== null && total.cost > 0 ? 'cost' : 'tokens';
}

function shareValue(item: UsageTotals, basis: 'cost' | 'tokens'): number {
  return basis === 'cost' ? (item.cost ?? 0) : item.tokens;
}

/** A tabela "Por modelo": sem barra de participação, com a coluna de tokens. */
export function modelTable(report: UsageReport, lang: Language): TableModel {
  const { head, others } = topNWithOthers(report.byModel, MODEL_NOUN, lang);
  const rows: TableRowModel[] = head.map((item: UsageByModel, i: number) => ({
    id: `m${i}`,
    key: displayText(item.model),
    name: modelDisplayName(item.model),
    messages: formatCount(item.messages, lang),
    tokens: formatTokens(item.tokens, lang),
    cost: formatCost(item.cost, lang),
    unpriced: item.unpriced,
  }));
  if (others) {
    rows.push({
      id: '__outros__',
      key: '__outros__',
      name: others.label,
      messages: formatCount(others.totals.messages, lang),
      tokens: formatTokens(others.totals.tokens, lang),
      cost: formatCost(others.totals.cost, lang),
      unpriced: false,
    });
  }
  return {
    rows,
    total: {
      messages: formatCount(report.totals.messages, lang),
      tokens: formatTokens(report.totals.tokens, lang),
      cost: formatCost(report.totals.cost, lang),
    },
    othersCount: others?.count ?? 0,
  };
}

/** A tabela "Por projeto": com barra de participação, sem a coluna de tokens. */
export function projectTable(report: UsageReport, lang: Language): TableModel {
  const { head, others } = topNWithOthers(report.byProject, PROJECT_NOUN, lang);
  const basis = shareBasis(report.totals);
  const total = shareValue(report.totals, basis);
  const rows: TableRowModel[] = head.map((item: UsageByProject, i: number) => ({
    id: `p${i}`,
    key: displayText(item.project),
    name: projectName(item.project),
    messages: formatCount(item.messages, lang),
    tokens: formatTokens(item.tokens, lang),
    cost: formatCost(item.cost, lang),
    unpriced: false,
    share: barPercent(shareValue(item, basis), total),
  }));
  if (others) {
    // A linha "outros" não tem barra: ela é um saco de projetos, não um
    // projeto com participação própria.
    rows.push({
      id: '__outros__',
      key: '__outros__',
      name: others.label,
      messages: formatCount(others.totals.messages, lang),
      tokens: formatTokens(others.totals.tokens, lang),
      cost: formatCost(others.totals.cost, lang),
      unpriced: false,
    });
  }
  return {
    rows,
    total: {
      messages: formatCount(report.totals.messages, lang),
      tokens: formatTokens(report.totals.tokens, lang),
      cost: formatCost(report.totals.cost, lang),
    },
    othersCount: others?.count ?? 0,
  };
}

/**
 * O nome curto de um projeto: a última pasta do `cwd`. O caminho inteiro fica
 * no `title` da célula — nove linhas de `C:\...\...\...` na coluna estreita
 * não deixariam distinguir projeto nenhum.
 */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return displayText(parts[parts.length - 1] ?? cwd);
}

// --------------------------------------------------------------- avisos

/**
 * O aviso abaixo das tabelas. O core já manda `pricingWarnings` com uma frase
 * por problema; o painel escreve a manchete (quantos modelos) e lista o que
 * veio, porque um aviso que só diz "há modelos sem preço" não deixa a pessoa
 * consertar.
 */
export function unpricedModels(report: UsageReport, lang: Language): string[] {
  const todos = report.byModel.filter((item) => item.unpriced).map((item) => displayText(item.model));
  if (todos.length <= TOP_N) return todos;
  // BU-13: esta lista rodava sobre `byModel` INTEIRO, sem o corte que as
  // tabelas aplicam — um transcript com 5 000 ids de modelo distintos virava
  // 5 000 itens no painel e no diálogo de Configurações. O corte é o mesmo
  // `TOP_N` das tabelas, e a cauda vira UMA linha que diz quantos ficaram.
  const restantes = todos.length - TOP_N;
  const cauda =
    restantes === 1 ? tUi(lang, 'uso.aviso.maisModelos.um') : tUi(lang, 'uso.aviso.maisModelos.varios', { n: restantes });
  return [...todos.slice(0, TOP_N), cauda];
}

/**
 * Os avisos do core que NÃO são "modelo sem preço".
 *
 * O core manda uma linha por modelo sem preço e uma linha por problema da
 * TABELA (arquivo ilegível, override malformado). As primeiras já viram a caixa
 * de aviso do painel, com a copy do gate visual e a lista dos modelos — repetir
 * a frase crua embaixo dela seria dizer duas vezes a mesma coisa. As segundas
 * não têm outro lugar: sumir com elas deixaria o dono achando que o
 * `pricingFile` dele está valendo.
 *
 * O prefixo é o formato documentado do contrato (§4.1 da Task 1); um aviso que
 * mude de forma cai no lado seguro — aparece.
 */
export function tableWarnings(report: UsageReport, lang: Language): string[] {
  // Os avisos chegam do core JÁ traduzidos (`unpricedWarning(model, lang)` e
  // companhia): a UI não os retraduz, só separa os "sem preço" — que a caixa
  // acima já mostra com a lista de modelos — dos avisos de TABELA, que não têm
  // outro lugar. O prefixo comparado é o mesmo texto no MESMO idioma, por isso
  // ele também é uma chave de catálogo.
  const prefixo = tUi(lang, 'uso.aviso.prefixoSemPreco');
  return report.pricingWarnings.filter((line) => !line.startsWith(prefixo)).map((line) => displayText(line, 300));
}

export function pricingWarningTitle(models: readonly string[], lang: Language): string | undefined {
  if (models.length === 0) return undefined;
  return models.length === 1
    ? tUi(lang, 'uso.aviso.semPreco.um')
    : tUi(lang, 'uso.aviso.semPreco.varios', { n: models.length });
}

/** Título e dica da seção do gráfico, por métrica. */
export function chartTitle(metric: ChartMetric, lang: Language): string {
  return tUi(lang, metric === 'tokens' ? 'uso.grafico.titulo.tokens' : 'uso.grafico.titulo.custo');
}

/**
 * A dica ao lado do título do gráfico. "últimos 30 dias" só quando é VERDADE
 * — a série de sempre, terminando hoje. Num mês passado ou num ano a frase
 * mentiria sobre o eixo, e a dica passa a escrever as datas da janela.
 */
export function chartHint(report: UsageReport, lang: Language): string {
  const { from, to } = chartWindow(report);
  const endsToday = report.today === undefined || to === report.today;
  if (endsToday && report.byDay.length === CHART_BASE_DAYS) return tUi(lang, 'uso.painel.grafico.dica');
  return tUi(lang, 'uso.painel.grafico.dicaJanela', { de: longDay(from), ate: longDay(to) });
}

/** O rodapé do painel — copy fixada no gate visual (Task 2a). */
export function usageFootnoteProject(lang: Language): string {
  return tUi(lang, 'uso.rodape.projeto');
}
export function usageFootnoteCost(lang: Language): string {
  return tUi(lang, 'uso.rodape.custo');
}

// ---------------------------------------------------- recarga do relatório

/**
 * O evento `usage.changed` manda só os DIAS que a varredura tocou
 * (`dailyTouched`), não os números. Quem decide se vale reler é o painel: um
 * dia de agosto tocado por um transcript antigo não muda o recorte "hoje", e
 * relê à toa toda vez que o poller acha uma linha nova.
 *
 * A janela comparada é a do GRÁFICO (`byDay`), que no período curto é maior
 * que o recorte — a barra de um dia fora do recorte também precisa mudar. E
 * num período PASSADO a janela inteira fica antes de hoje, então o poller de
 * hoje não relê um agosto que ninguém está mudando.
 */
/**
 * A janela da SÉRIE (ver `UsageReport.byDay`), que não é a mesma coisa que o
 * recorte (`from`/`to`). No recorte do mês corrente elas divergem de
 * propósito: `to` é o último dia do mês civil, que ainda não chegou.
 *
 * O `||` cobre um core que mande os campos vazios; a série continua sendo a
 * fonte de verdade do que está desenhado.
 */
export function chartWindow(report: UsageReport): { from: string; to: string } {
  return {
    from: report.chartFrom || report.byDay[0]?.day || report.from,
    to: report.chartTo || report.byDay[report.byDay.length - 1]?.day || report.to,
  };
}

export function touchesReport(report: UsageReport | undefined, days: readonly string[] | undefined): boolean {
  if (!report) return false;
  // Sem a lista (core que só mandou `limits`) não há o que comparar.
  if (!days || days.length === 0) return false;
  const { from, to } = chartWindow(report);
  return days.some((day) => day >= from && day <= to);
}

// ------------------------------------------------------- linha da sessão

export interface SessionLineModel {
  /** `70k ctx` — nunca some. */
  ctx: string;
  /** `Fable 5.1`; o primeiro a cair quando a sidebar aperta. */
  model?: string;
  /** `US$ 0,74`; ausente com `showCost` desligado ou custo desconhecido. */
  cost?: string;
  /** A frase inteira, pro `title` — ela corta com reticências na sidebar. */
  text: string;
}

/**
 * `70k ctx · Fable 5.1 · US$ 0,74` a partir dos campos ESTRUTURADOS do core
 * (`contextTokens`, `model`, `costUsd`), não da `line` pronta do snapshot: a
 * linha do terminal carrega também as janelas de limite, que aqui já vivem no
 * bloco `.sidebar-limits`, uma vez só.
 */
export function sessionLine(
  quota: { contextTokens: number; model?: string; costUsd?: number } | undefined,
  lang: Language,
  opts: { showCost: boolean } = { showCost: true },
): SessionLineModel | undefined {
  if (!quota) return undefined;
  const ctx = `${Math.round(quota.contextTokens / 1000)}k ctx`;
  // O payload manda `display_name` quando tem ("Fable 5.1"), e o `id` cru
  // quando não tem — `modelDisplayName` deixa os dois saírem iguais na tela.
  const model = quota.model && quota.model.trim() !== '' ? modelDisplayName(quota.model) : undefined;
  const cost = opts.showCost && quota.costUsd !== undefined ? formatUsd(quota.costUsd, lang) : undefined;
  const text = [ctx, model, cost].filter((part): part is string => part !== undefined).join(' · ');
  return { ctx, ...(model ? { model } : {}), ...(cost ? { cost } : {}), text };
}

// ------------------------------------------------------ recortes do toggle

export function rangeOptions(lang: Language): ReadonlyArray<{ value: UsageRange; label: string }> {
  return [
    { value: 'day', label: tUi(lang, 'uso.recorte.opcao.dia') },
    { value: 'week', label: tUi(lang, 'uso.recorte.opcao.semana') },
    { value: 'month', label: tUi(lang, 'uso.recorte.opcao.mes') },
    { value: 'year', label: tUi(lang, 'uso.recorte.opcao.ano') },
    { value: 'custom', label: tUi(lang, 'uso.recorte.opcao.personalizado') },
  ];
}

// ------------------------------------------------- navegação entre períodos

/**
 * O período que o painel está mostrando — o estado do App, não a resposta.
 *
 * Nos recortes ancorados, `anchor` AUSENTE quer dizer "o período de hoje": é o
 * que faz o painel aberto às 23h59 continuar mostrando o mês corrente depois
 * da virada, em vez de ficar preso numa data que virou ontem. Uma âncora só
 * existe quando a pessoa andou pra trás, e ela mora no COMEÇO do período
 * (`2026-08-01`, não `2026-08-31`) — é a mesma resposta e uma URL legível.
 */
export type UsagePeriod = { range: UsageAnchoredRange; anchor?: string } | { range: 'custom'; from: string; to: string };

/** O mês corrente — o que o painel abre mostrando. */
export const DEFAULT_USAGE_PERIOD: UsagePeriod = { range: 'month' };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * O dia LOCAL de um instante, pelo relógio do browser. É o fallback de "hoje"
 * enquanto a primeira resposta (que traz o `today` do core) não chega — o
 * browser e o core rodam na mesma máquina, e o `report.today` corrige o resto.
 */
export function localDayOf(now: number = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Aritmética de calendário sobre a STRING do dia, via `Date.UTC` — a mesma
 * disciplina do `aggregate.ts` do core: o dia local já está resolvido, e
 * passar pelo fuso aqui reintroduziria horário de verão numa conta que é puro
 * calendário.
 */
function utcOfDay(day: string): Date {
  const parsed = parseDay(day);
  return new Date(Date.UTC(parsed?.year ?? 1970, (parsed?.month ?? 1) - 1, parsed?.date ?? 1));
}

function isoOfUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const date = utcOfDay(day);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoOfUtc(date);
}

/** `AAAA-MM-DD` que o calendário tem — `2026-02-30` não passa. */
function isCalendarDay(day: string): boolean {
  return parseDay(day) !== undefined && isoOfUtc(utcOfDay(day)) === day;
}

/**
 * O dia, a semana (seg–dom), o mês ou o ano civil que contém `anchor` — as
 * mesmas bordas do `rangeBounds` do core. A UI calcula sozinha porque o botão
 * "anterior" precisa responder na hora, sem esperar a resposta do GET
 * anterior (três cliques rápidos são três meses, não o mesmo mês três vezes).
 */
export function periodBounds(range: UsageAnchoredRange, anchor: string): { from: string; to: string } {
  if (range === 'day') return { from: anchor, to: anchor };
  if (range === 'year') return { from: `${anchor.slice(0, 4)}-01-01`, to: `${anchor.slice(0, 4)}-12-31` };
  const date = utcOfDay(anchor);
  if (range === 'week') {
    const from = addDays(anchor, -((date.getUTCDay() + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  return {
    from: isoOfUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))),
    to: isoOfUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))),
  };
}

/** O período em tela contém hoje? Personalizado nunca é "o atual" — ele não anda. */
export function isCurrentPeriod(period: UsagePeriod, today: string): boolean {
  if (period.range === 'custom') return false;
  if (period.anchor === undefined) return true;
  const { from, to } = periodBounds(period.range, period.anchor);
  return from <= today && today <= to;
}

/** "Próximo" desliga no período de hoje: não há consumo no futuro pra mostrar. */
export function canGoNext(period: UsagePeriod, today: string): boolean {
  return period.range !== 'custom' && !isCurrentPeriod(period, today);
}

/** "Anterior" desliga quando o período já começa no `MIN_USAGE_DAY` (ou antes). */
export function canGoPrev(period: UsagePeriod, today: string): boolean {
  if (period.range === 'custom') return false;
  return periodBounds(period.range, period.anchor ?? today).from > MIN_USAGE_DAY;
}

/**
 * O período que contém `day`, normalizado: âncora no começo dele (e nunca
 * antes do mínimo que o core aceita — a semana de 01/01/2020 começa em 2019),
 * ou SEM âncora quando ele contém hoje.
 */
function anchoredAt(range: UsageAnchoredRange, day: string, today: string): UsagePeriod {
  const { from, to } = periodBounds(range, day);
  if (from <= today && today <= to) return { range };
  return { range, anchor: from < MIN_USAGE_DAY ? MIN_USAGE_DAY : from };
}

/**
 * ‹ e ›: um período pra trás ou pra frente. O vizinho é achado pelo dia
 * IMEDIATAMENTE fora das bordas (`from - 1`, `to + 1`), o que funciona igual
 * pra dia, semana, mês de 28 ou 31 dias e ano bissexto. Movimento proibido
 * (antes do mínimo, depois de hoje, personalizado) devolve o MESMO objeto —
 * o `setState` do React não re-renderiza e nenhum GET sai.
 */
export function shiftPeriod(period: UsagePeriod, delta: -1 | 1, today: string): UsagePeriod {
  if (period.range === 'custom') return period;
  if (delta < 0 ? !canGoPrev(period, today) : !canGoNext(period, today)) return period;
  const { from, to } = periodBounds(period.range, period.anchor ?? today);
  return anchoredAt(period.range, delta < 0 ? addDays(from, -1) : addDays(to, 1), today);
}

/**
 * Troca de recorte no toggle, sem perder o lugar:
 *
 * - ancorado → ancorado mantém a data que se estava olhando (agosto → a
 *   semana de 01/08), e cai no "de hoje" quando ela contém hoje;
 * - → personalizado começa com o período EM TELA (preso em hoje e no
 *   mínimo), que é o ponto de partida mais provável de um ajuste fino;
 * - personalizado → ancorado volta ao período de hoje: um intervalo livre não
 *   tem uma âncora óbvia, e adivinhar uma é pior que o default.
 */
export function switchRange(period: UsagePeriod, range: UsageRange, today: string): UsagePeriod {
  if (range === period.range) return period;
  if (range === 'custom') {
    if (period.range === 'custom') return period;
    const { from, to } = periodBounds(period.range, period.anchor ?? today);
    return { range: 'custom', from: from < MIN_USAGE_DAY ? MIN_USAGE_DAY : from, to: to > today ? today : to };
  }
  if (period.range === 'custom' || period.anchor === undefined) return { range };
  return anchoredAt(range, period.anchor, today);
}

/**
 * A query de `GET /api/usage` pro período. Sem âncora sai só `range=…` — a
 * mesma URL de antes do parâmetro existir, byte a byte.
 */
export function usageQuery(period: UsagePeriod): string {
  if (period.range === 'custom') {
    return `range=custom&from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`;
  }
  return period.anchor === undefined
    ? `range=${period.range}`
    : `range=${period.range}&anchor=${encodeURIComponent(period.anchor)}`;
}

/**
 * Os dois campos de data formam um período que o core ACEITA? A UI aplica só
 * nesse caso: mandar um GET que volta 400 a cada tecla deixaria o painel
 * piscando entre relatório e "Somando…". As regras são as da rota — dias
 * reais, `de <= até`, entre `MIN_USAGE_DAY` e hoje, até `MAX_USAGE_RANGE_DAYS`.
 */
export function customPeriodValid(from: string, to: string, today: string): boolean {
  if (!isCalendarDay(from) || !isCalendarDay(to)) return false;
  if (from > to || from < MIN_USAGE_DAY || to > today) return false;
  const days = Math.round((utcOfDay(to).getTime() - utcOfDay(from).getTime()) / 86_400_000) + 1;
  return days <= MAX_USAGE_RANGE_DAYS;
}
