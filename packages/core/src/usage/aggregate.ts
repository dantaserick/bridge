/**
 * Recortes de tempo e agregação — a parte PURA do monitor de uso.
 *
 * Duas decisões do dono moram aqui:
 *
 * - **o dia começa à meia-noite LOCAL**. Não UTC: quem trabalha às 22h em São
 *   Paulo veria o consumo cair no "amanhã" e o painel discordaria do relógio
 *   da parede. Todo carimbo ISO do transcript é convertido pro dia do fuso
 *   antes de somar, e a chave que vai pro banco já é esse dia local;
 * - **semana é segunda a domingo**, mês é mês civil. Ambos no mesmo fuso.
 *
 * O fuso é o do PROCESSO. O parâmetro `tz` existe pra que os testes possam
 * atravessar meia-noite, virada de semana e virada de mês sem depender da
 * máquina de quem roda a suíte — não é um recurso do produto.
 */
import { MAX_USAGE_RANGE_DAYS, MIN_USAGE_DAY, USAGE_RANGES, t, type Language, type MessageKey } from '@bridge/shared';
import type {
  UsageAnchoredRange,
  UsageByModel,
  UsageByProject,
  UsageBySource,
  UsageDay,
  UsageRange,
  UsageTotals,
} from '@bridge/shared';
import { costOf, priceFor, unpricedWarning, type PricingTable, type UsagePrice } from './pricing.js';

/**
 * Tamanho MÍNIMO da série do gráfico, em dias. Período mais curto que isso
 * (um dia, uma semana, o mês corrente no começo) desenha os 30 dias terminando
 * no fim dele; período mais longo desenha a si mesmo. Ver `chartBounds`.
 */
export const CHART_DAYS = 30;

/** O fuso do processo, quando ninguém pediu outro. */
export function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** `tz` que o `Intl` aceita? Usado pelo `GET /api/usage` pra recusar lixo com 400. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(tz, fmt);
  }
  return fmt;
}

/**
 * O dia LOCAL (`AAAA-MM-DD`) de um instante. Aceita ISO, epoch ms ou `Date`.
 * Carimbo impossível de ler devolve `undefined` — a linha é descartada em vez
 * de cair num dia inventado.
 */
export function localDay(at: string | number | Date, tz: string): string | undefined {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = dayFormatter(tz).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) return undefined;
  return `${year}-${month}-${day}`;
}

/**
 * Aritmética de calendário sobre a STRING do dia, via `Date.UTC`. É de
 * propósito: o dia local já foi resolvido em `localDay`, e voltar pro fuso
 * aqui reintroduziria horário de verão numa conta que é puro calendário
 * (28/02 + 1 = 01/03 não depende de fuso nenhum).
 */
function toUtcDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `AAAA-MM-DD` deslocado em `delta` dias (aceita negativo). */
export function shiftDay(day: string, delta: number): string {
  const date = toUtcDate(day);
  date.setUTCDate(date.getUTCDate() + delta);
  return fromUtcDate(date);
}

/** Dias de `from` a `to`, inclusive nas duas pontas. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  // Teto de segurança: um `from`/`to` invertido não pode virar laço infinito.
  for (let i = 0; i <= 3660 && cursor <= to; i++) {
    days.push(cursor);
    cursor = shiftDay(cursor, 1);
  }
  return days;
}

/** Segunda a domingo da semana que contém `day`. */
export function weekBounds(day: string): { from: string; to: string } {
  const date = toUtcDate(day);
  // `getUTCDay()` é 0 no domingo; a semana do dono começa na segunda.
  const offset = (date.getUTCDay() + 6) % 7;
  const from = shiftDay(day, -offset);
  return { from, to: shiftDay(from, 6) };
}

/** Primeiro e último dia do mês civil que contém `day`. */
export function monthBounds(day: string): { from: string; to: string } {
  const date = toUtcDate(day);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: fromUtcDate(first), to: fromUtcDate(last) };
}

/** Primeiro e último dia do ano civil que contém `day`. */
export function yearBounds(day: string): { from: string; to: string } {
  const year = day.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Quantos dias de `from` a `to`, inclusive nas duas pontas. Conta pela
 * diferença de `Date.UTC`, sem montar a lista: validar um intervalo de um ano
 * não precisa de 366 strings.
 */
export function dayCount(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000) + 1;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `AAAA-MM-DD` que o calendário TEM. A forma sozinha não basta: `2026-02-30`
 * passa num regex e o `Date.UTC` rola ele pra 02/03 calado — um período que
 * a pessoa não pediu. A volta de ida-e-volta pela string é o que pega isso.
 */
export function isCalendarDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return !Number.isNaN(date.getTime()) && fromUtcDate(date) === value;
}

/**
 * O recorte ancorado: o dia, a semana (seg–dom), o mês ou o ano civil que
 * CONTÉM `anchor`. Hoje é só a âncora default — quem decide qual é o chamador.
 */
export function rangeBounds(range: UsageAnchoredRange, anchor: string): { from: string; to: string } {
  if (range === 'day') return { from: anchor, to: anchor };
  if (range === 'week') return weekBounds(anchor);
  if (range === 'year') return yearBounds(anchor);
  return monthBounds(anchor);
}

/**
 * A janela da SÉRIE do gráfico de um período.
 *
 * O fim é `min(to, hoje)`, sempre: amarrada ao `to` cru, o mês civil corrente
 * terminava no dia 30 e a série vinha com uma cauda de dias FUTUROS zerados —
 * um gráfico que desce até o chão no fim porque o mês ainda não acabou, o que
 * qualquer pessoa lê como "o consumo caiu".
 *
 * O começo depende do tamanho até esse fim:
 *
 * - `CHART_DAYS` dias ou mais → o próprio período. Um mês passado, um ano, um
 *   intervalo livre longo mostram os dias DELES (e só eles — o teto de
 *   `MAX_USAGE_RANGE_DAYS` já limita o tamanho da série);
 * - menos que isso → os `CHART_DAYS` dias terminando no fim, com o recorte
 *   como a parte destacada. No período que contém hoje isso é exatamente o
 *   "últimos 30 dias até hoje" de antes, e trocar de "mês" pra "dia" continua
 *   mudando a ênfase sem trocar o eixo debaixo do cursor.
 *
 * Quem responde "quanto foi no recorte" são `totals`, `byModel` e
 * `byProject`, calculados sobre `from`/`to`. A resposta traz as duas janelas
 * separadas (`from`/`to` e `chartFrom`/`chartTo`) justamente pra que a UI
 * nunca precise deduzir uma da outra.
 */
export function chartBounds(period: { from: string; to: string }, today: string): { from: string; to: string } {
  const to = period.to < today ? period.to : today;
  if (period.from <= to && dayCount(period.from, to) >= CHART_DAYS) return { from: period.from, to };
  return { from: shiftDay(to, -(CHART_DAYS - 1)), to };
}

/** O período validado: o que o relatório soma. */
export interface ResolvedPeriod {
  range: UsageRange;
  /** Só nos recortes ancorados — a pedida, ou hoje. */
  anchor?: string;
  from: string;
  to: string;
}

/**
 * A recusa de uma query de período. Guarda a CHAVE do catálogo e os
 * parâmetros, não a frase: quem traduz é a rota, no idioma do instante, e é
 * ela também quem limpa o eco (BU-16) antes de escrever.
 */
export interface PeriodError {
  ok: false;
  code: 'invalid-range' | 'invalid-anchor' | 'invalid-period';
  key: MessageKey;
  params: Record<string, string | number>;
}

export type PeriodResolution = { ok: true; period: ResolvedPeriod } | PeriodError;

/** A query crua — `unknown` porque `?anchor=a&anchor=b` chega como array. */
export interface PeriodQuery {
  range?: unknown;
  anchor?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Um parâmetro de data da query: a string aparada; `undefined` quando veio
 * ausente ou vazio (mesma leitura do `?tz=`); `null` quando veio com forma
 * que não é string — repetido na URL, por exemplo.
 */
function dateParam(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function periodError(code: PeriodError['code'], key: MessageKey, params: PeriodError['params'] = {}): PeriodError {
  return { ok: false, code, key, params };
}

/**
 * Valida a query de período de `GET /api/usage` e devolve o período que o
 * relatório soma. Pura: `today` vem de fora (o dia local no fuso pedido),
 * então os testes atravessam "anchor = hoje" e "to no futuro" sem relógio.
 *
 * A validação é ESTRITA de propósito — tudo que é ambíguo vira 400 em vez de
 * um default calado, porque um relatório "de outro período" que a pessoa não
 * pediu é um número errado que parece certo:
 *
 * - `anchor` precisa ser um dia do calendário entre `MIN_USAGE_DAY` e hoje;
 *   num recorte ancorado sem `anchor`, a âncora é hoje (o `?range=day` de
 *   sempre continua idêntico);
 * - `from`/`to` só com `custom`, e `anchor` só sem ele;
 * - no `custom`: as duas datas, reais, `from <= to`, `from` entre o mínimo e
 *   hoje. `to` no futuro é PRESO em hoje (não há consumo a somar lá, e o
 *   rótulo do período não pode prometer dias que não existem); o teto de
 *   `MAX_USAGE_RANGE_DAYS` é contado já depois de preso.
 */
export function resolvePeriod(query: PeriodQuery, today: string): PeriodResolution {
  const rawRange = query.range ?? 'day';
  if (typeof rawRange !== 'string' || !(USAGE_RANGES as readonly string[]).includes(rawRange)) {
    return periodError('invalid-range', 'core.erro.rangeInvalido', { opcoes: USAGE_RANGES.join(', ') });
  }
  const range = rawRange as UsageRange;
  const anchor = dateParam(query.anchor);
  const from = dateParam(query.from);
  const to = dateParam(query.to);

  if (range !== 'custom') {
    if (from !== undefined || to !== undefined) return periodError('invalid-period', 'core.erro.periodoSoCustom');
    if (anchor === null || (anchor !== undefined && (!isCalendarDay(anchor) || anchor < MIN_USAGE_DAY || anchor > today))) {
      return periodError('invalid-anchor', 'core.erro.ancoraInvalida', {
        valor: anchor ?? String(query.anchor),
        min: MIN_USAGE_DAY,
        hoje: today,
      });
    }
    const at = anchor ?? today;
    return { ok: true, period: { range, anchor: at, ...rangeBounds(range, at) } };
  }

  if (anchor !== undefined) return periodError('invalid-anchor', 'core.erro.ancoraComCustom');
  if (from === undefined || to === undefined) return periodError('invalid-period', 'core.erro.periodoIncompleto');
  if (from === null || !isCalendarDay(from)) {
    return periodError('invalid-period', 'core.erro.periodoDataInvalida', { campo: 'from', valor: from ?? String(query.from) });
  }
  if (to === null || !isCalendarDay(to)) {
    return periodError('invalid-period', 'core.erro.periodoDataInvalida', { campo: 'to', valor: to ?? String(query.to) });
  }
  if (from > to) return periodError('invalid-period', 'core.erro.periodoInvertido', { de: from, ate: to });
  if (from < MIN_USAGE_DAY) return periodError('invalid-period', 'core.erro.periodoAntesDoMinimo', { min: MIN_USAGE_DAY });
  if (from > today) return periodError('invalid-period', 'core.erro.periodoFuturo', { hoje: today });
  const end = to > today ? today : to;
  const dias = dayCount(from, end);
  if (dias > MAX_USAGE_RANGE_DAYS) {
    return periodError('invalid-period', 'core.erro.periodoLongo', { dias, max: MAX_USAGE_RANGE_DAYS });
  }
  return { ok: true, period: { range: 'custom', from, to: end } };
}

/** Uma linha de `usage_daily`, como o banco a devolve. */
export interface DailyRow {
  day: string;
  model: string;
  project: string;
  /** `main` = conversa principal; `subagents` = os subagentes dela. */
  source: 'main' | 'subagents';
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  messages: number;
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    tokens: 0,
    messages: 0,
    cost: 0,
    costPartial: false,
  };
}

/**
 * Soma uma linha num acumulador. `cost` fica `null` enquanto NENHUMA linha do
 * grupo teve preço — é o que separa "custou zero" de "não dá pra saber".
 */
function addRow(target: UsageTotals, row: DailyRow, cost: number | undefined): void {
  target.input += row.input;
  target.output += row.output;
  target.cacheWrite += row.cacheWrite;
  target.cacheWrite1h += row.cacheWrite1h;
  target.cacheRead += row.cacheRead;
  target.tokens += row.input + row.output + row.cacheWrite + row.cacheWrite1h + row.cacheRead;
  target.messages += row.messages;
  if (cost === undefined) target.costPartial = true;
  else target.cost = (target.cost ?? 0) + cost;
}

/** Grupo que nunca viu um preço fica com `cost: null`, não com `0`. */
function sealTotals(totals: UsageTotals, sawPrice: boolean): UsageTotals {
  if (!sawPrice) totals.cost = null;
  return totals;
}

/**
 * Teto de baldes por lista em `byModel`/`byProject` (BU-11).
 *
 * O corte "top 8 + outros" continua sendo da UI (e "top 5" da CLI); este é o
 * teto do SERVIDOR, e existe por outro motivo: um histórico com 20 000 `cwd`
 * distintos virava um corpo de 4,17 MB por pedido de `GET /api/usage`,
 * serializado no processo que hospeda os PTYs, pra a UI mostrar oito linhas.
 * Duzentos baldes é dez vezes o que a maior lista da UI usa, e o resto vira
 * UMA linha somada — some do detalhamento, nunca do total.
 */
export const MAX_BUCKETS = 200;

/**
 * Os dois BALDES do relatório. São SENTINELAS, não copy: `(sem projeto)` está
 * gravado em `usage_daily` (é o `project` de toda linha sem `cwd`), e
 * `(outros)` é a chave de agrupamento do `capBuckets`. Traduzi-los na ESCRITA
 * partiria o mesmo balde em dois no histórico no dia em que o dono trocasse de
 * idioma; por isso o valor é estável e a tradução acontece na LEITURA, em
 * `bucketLabel`, no ponto em que o relatório é montado.
 */
export const OTHERS_BUCKET = '(outros)';
export const NO_PROJECT_BUCKET = '(sem projeto)';

/** O sentinela virado texto de tela; qualquer outro nome sai como está. */
export function bucketLabel(name: string, lang: Language): string {
  if (name === OTHERS_BUCKET) return t(lang, 'core.uso.balde.outros');
  if (name === NO_PROJECT_BUCKET) return t(lang, 'core.uso.balde.semProjeto');
  return name;
}

/** Soma linhas JÁ seladas num total só — o balde `(outros)` de `capBuckets`. */
function sumSealed(rows: readonly UsageTotals[]): UsageTotals {
  const out = emptyTotals();
  let sawPrice = false;
  for (const row of rows) {
    out.input += row.input;
    out.output += row.output;
    out.cacheWrite += row.cacheWrite;
    out.cacheWrite1h += row.cacheWrite1h;
    out.cacheRead += row.cacheRead;
    out.tokens += row.tokens;
    out.messages += row.messages;
    if (row.cost === null) out.costPartial = true;
    else {
      sawPrice = true;
      out.cost = (out.cost ?? 0) + row.cost;
    }
    if (row.costPartial) out.costPartial = true;
  }
  return sealTotals(out, sawPrice);
}

/**
 * Os `MAX_BUCKETS` maiores mais uma linha `(outros)` com a soma do resto. A
 * soma de `tokens` da lista devolvida continua igual à da lista inteira: uma
 * tabela por projeto que não fecha com o total geral faria a pessoa procurar
 * um consumo que sumiu.
 */
function capBuckets<T extends UsageTotals>(rows: T[], others: (totals: UsageTotals) => T, limit = MAX_BUCKETS): T[] {
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit);
  head.push(others(sumSealed(rows.slice(limit))));
  return head;
}

export interface SummaryInput {
  /** Linhas do recorte pedido — alimentam `totals`, `byModel` e `byProject`. */
  rows: DailyRow[];
  /** Linhas da janela do gráfico — alimentam `byDay`. Pode ser a mesma lista. */
  chartRows: DailyRow[];
  chart: { from: string; to: string };
  pricing: PricingTable;
  /** O idioma dos avisos de modelo sem preço (spec §13). */
  lang: Language;
}

export interface Summary {
  totals: UsageTotals;
  bySource: UsageBySource;
  byDay: UsageDay[];
  byModel: UsageByModel[];
  byProject: UsageByProject[];
  /** Modelos sem preço encontrados no recorte, um aviso por modelo. */
  pricingWarnings: string[];
}

/**
 * Os quatro agregados de uma vez, numa passada por lista. Pura: os testes
 * cobram meia-noite, virada de semana e modelo sem preço sem tocar em disco.
 *
 * `byModel` e `byProject` saem ordenados por tokens (desc) e desempatados
 * pelo nome — a ordem que a UI mostra não pode dançar entre dois pedidos
 * iguais. O corte "top 8 + outros" é da UI, não daqui: a CLI e o painel
 * cortam em lugares diferentes, e quem tem os dados é quem decide. O que sai
 * daqui é só o TETO de `MAX_BUCKETS` (BU-11), que é sobre tamanho de corpo
 * HTTP, não sobre apresentação.
 */
export function summarize({ rows, chartRows, chart, pricing, lang }: SummaryInput): Summary {
  const totals = emptyTotals();
  let totalsSawPrice = false;

  const byDay = new Map<string, { totals: UsageTotals; sawPrice: boolean }>();
  for (const day of daysBetween(chart.from, chart.to)) {
    byDay.set(day, { totals: emptyTotals(), sawPrice: false });
  }
  const byModel = new Map<string, { totals: UsageTotals; sawPrice: boolean; unpriced: boolean }>();
  const byProject = new Map<string, { totals: UsageTotals; sawPrice: boolean }>();
  const bySource = {
    main: { totals: emptyTotals(), sawPrice: false },
    subagents: { totals: emptyTotals(), sawPrice: false },
  };
  /**
   * Modelos sem preço encontrados NO RECORTE. A série do gráfico pode ser mais
   * larga que o recorte (dia, semana, mês curto), e um modelo que só aparece nos dias de
   * fora não pode gerar um aviso sobre um recorte em que ele não está.
   */
  const unpriced = new Set<string>();

  // Memoiza o preço por modelo: a busca é barata, mas roda uma vez por linha
  // e um mês de uso tem milhares delas.
  const priceCache = new Map<string, UsagePrice | undefined>();
  function costOfRow(row: DailyRow, inRange: boolean): number | undefined {
    if (!priceCache.has(row.model)) priceCache.set(row.model, priceFor(pricing, row.model));
    const price = priceCache.get(row.model);
    if (!price && inRange) unpriced.add(row.model);
    return price ? costOf(price, row) : undefined;
  }

  for (const row of rows) {
    const cost = costOfRow(row, true);
    if (cost !== undefined) totalsSawPrice = true;
    addRow(totals, row, cost);

    const source = bySource[row.source] ?? bySource.main;
    if (cost !== undefined) source.sawPrice = true;
    addRow(source.totals, row, cost);

    let model = byModel.get(row.model);
    if (!model) {
      model = { totals: emptyTotals(), sawPrice: false, unpriced: cost === undefined };
      byModel.set(row.model, model);
    }
    if (cost !== undefined) model.sawPrice = true;
    addRow(model.totals, row, cost);

    const key = row.project || NO_PROJECT_BUCKET;
    let project = byProject.get(key);
    if (!project) {
      project = { totals: emptyTotals(), sawPrice: false };
      byProject.set(key, project);
    }
    if (cost !== undefined) project.sawPrice = true;
    addRow(project.totals, row, cost);
  }

  for (const row of chartRows) {
    const bucket = byDay.get(row.day);
    if (!bucket) continue;
    const cost = costOfRow(row, false);
    if (cost !== undefined) bucket.sawPrice = true;
    addRow(bucket.totals, row, cost);
  }

  /** Mais tokens primeiro; empate pelo nome, pra a ordem não dançar entre dois pedidos iguais. */
  function byTokens(aTokens: number, aName: string, bTokens: number, bName: string): number {
    return bTokens - aTokens || aName.localeCompare(bName);
  }

  return {
    totals: sealTotals(totals, totalsSawPrice),
    bySource: {
      main: sealTotals(bySource.main.totals, bySource.main.sawPrice),
      subagents: sealTotals(bySource.subagents.totals, bySource.subagents.sawPrice),
    },
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...sealTotals(v.totals, v.sawPrice) })),
    // O `bucketLabel` roda no FIM, depois do agrupamento e da ordenação: o
    // que agrupa e o que ordena é o sentinela; o que sai é o texto.
    byModel: capBuckets(
      [...byModel.entries()]
        .map(([model, v]) => ({ model, unpriced: v.unpriced, ...sealTotals(v.totals, v.sawPrice) }))
        .sort((a, b) => byTokens(a.tokens, a.model, b.tokens, b.model)),
      (totals) => ({ model: OTHERS_BUCKET, unpriced: false, ...totals }),
    ).map((m) => ({ ...m, model: bucketLabel(m.model, lang) })),
    byProject: capBuckets(
      [...byProject.entries()]
        .map(([project, v]) => ({ project, ...sealTotals(v.totals, v.sawPrice) }))
        .sort((a, b) => byTokens(a.tokens, a.project, b.tokens, b.project)),
      (totals) => ({ project: OTHERS_BUCKET, ...totals }),
    ).map((p) => ({ ...p, project: bucketLabel(p.project, lang) })),
    pricingWarnings: [...unpriced].sort().map((model) => unpricedWarning(model, lang)),
  };
}
