/**
 * O miolo puro do painel "Uso" (ADR-012). Ambiente `node`: nada aqui monta
 * componente — o que se cobra é o que a tela escreve, decidido sem DOM.
 */
import type { Session, UsageByModel, UsageByProject, UsageDay, UsageReport, UsageTotals } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import {
  barPercent,
  chartModel,
  chartScale,
  chartTitle,
  emptyState,
  emptyHeaderNote,
  formatCost,
  formatCount,
  headerNote,
  isEmpty,
  limitCards,
  limitLevel,
  limitRows,
  modelTable,
  noPriceLabel,
  pricingWarningTitle,
  projectName,
  projectTable,
  rangeLabel,
  resetParts,
  resetText,
  sessionLine,
  shortDay,
  stripWindowLabel,
  subagentNote,
  sumTotals,
  tableWarnings,
  MODEL_NOUN,
  PROJECT_NOUN,
  topNWithOthers,
  totalCards,
  touchesReport,
  unpricedModels,
  usageLimitBadge,
  windowLabel,
  chartWindow,
  modelDisplayName,
  cacheSub,
  rescanStatus,
  scanCaveat,
  scanningLine,
  canGoNext,
  canGoPrev,
  chartHint,
  customPeriodValid,
  DEFAULT_USAGE_PERIOD,
  isCurrentPeriod,
  localDayOf,
  rangeOptions,
  shiftPeriod,
  switchRange,
  usageQuery,
} from '../src/usageModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
// ------------------------------------------------------------------ fixtures

function totals(over: Partial<UsageTotals> = {}): UsageTotals {
  const base: UsageTotals = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    tokens: 0,
    messages: 0,
    cost: 0,
    costPartial: false,
    ...over,
  };
  return base;
}

function day(dayIso: string, over: Partial<UsageDay> = {}): UsageDay {
  return { day: dayIso, ...totals(), ...over };
}

/** 30 dias terminando em `2026-09-05`, todos zerados salvo o que vier em `over`. */
function series(over: Record<string, Partial<UsageDay>> = {}): UsageDay[] {
  const out: UsageDay[] = [];
  const end = new Date(2026, 8, 5);
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(day(iso, { cost: null, ...over[iso] }));
  }
  return out;
}

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    range: 'month',
    from: '2026-09-01',
    to: '2026-09-30',
    // A série é sempre os últimos 30 dias terminando hoje; o recorte é a parte
    // destacada dela, e no mês os dois divergem de propósito.
    chartFrom: '2026-08-07',
    chartTo: '2026-09-05',
    tz: 'America/Sao_Paulo',
    totals: totals({ input: 742_100, output: 118_600, cacheWrite: 1_940_000, cacheRead: 21_300_000, tokens: 24_100_700, messages: 1284, cost: 48.7 }),
    bySource: { main: totals(), subagents: totals() },
    byDay: series(),
    byModel: [],
    byProject: [],
    limits: [],
    pricingWarnings: [],
    pricingAsOf: '2026-08-01',
    claudeHome: 'D:\\fixture\\claude',
    scannedFiles: 12,
    ...over,
    // `Partial<UsageReport>` deixa `scanning` como `... | undefined`, e o
    // campo e `... | null`: o `?? null` fecha essa fresta sem tirar do
    // fixture a possibilidade de passar um progresso de verdade.
    scanning: over.scanning ?? null,
  };
}

function model(name: string, over: Partial<UsageByModel> = {}): UsageByModel {
  return { model: name, unpriced: false, ...totals(), ...over };
}

function project(cwd: string, over: Partial<UsageByProject> = {}): UsageByProject {
  return { project: cwd, ...totals(), ...over };
}

// --------------------------------------------------------------- formatação

describe('formatação', () => {
  it('formatCount põe ponto de milhar', () => {
    expect(formatCount(1284, PT)).toBe('1.284');
    expect(formatCount(999, PT)).toBe('999');
    expect(formatCount(1_284_000, PT)).toBe('1.284.000');
  });

  /** `cost: null` NÃO é `cost: 0` — é a diferença entre "de graça" e "não sei". */
  it('formatCost distingue custo zero de custo desconhecido', () => {
    expect(formatCost(0, PT)).toBe('US$ 0,00');
    expect(formatCost(1.23, PT)).toBe('US$ 1,23');
    expect(formatCost(null, PT)).toBe(noPriceLabel(PT));
  });
});

// ------------------------------------------------------------- degrau/barra

describe('limitLevel e barPercent', () => {
  it('o degrau é <60 ok, <85 warn, senão bad', () => {
    expect(limitLevel(0)).toBe('ok');
    expect(limitLevel(59.4)).toBe('ok');
    expect(limitLevel(60)).toBe('warn');
    expect(limitLevel(84.9)).toBe('warn');
    expect(limitLevel(85)).toBe('bad');
    expect(limitLevel(140)).toBe('bad');
  });

  /** Conta estourada manda `used_percentage` acima de 100; a barra não vaza. */
  it('a barra fica entre 0 e 100, sempre', () => {
    expect(barPercent(68)).toBe(68);
    expect(barPercent(118)).toBe(100);
    expect(barPercent(-4)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(Number.NaN)).toBe(0);
    expect(barPercent(12.84, 48.7)).toBeCloseTo(26.37, 2);
  });
});

// ----------------------------------------------------------- rótulo/janela

describe('windowLabel', () => {
  it('as conhecidas ganham rótulo humano, sem a chave ao lado', () => {
    expect(windowLabel('five_hour', PT)).toEqual({ label: 'Limite de 5 horas', raw: false });
    expect(windowLabel('seven_day', PT)).toEqual({ label: 'Limite da semana', raw: false });
  });

  /**
   * Traduzir por adivinhação daria um rótulo bonito e possivelmente errado; a
   * chave crua é sempre verdade e é o que a pessoa acha na documentação.
   */
  it('janela desconhecida usa a própria chave, marcada como crua', () => {
    expect(windowLabel('seven_day_opus', PT)).toEqual({ label: 'seven_day_opus', raw: true });
  });

  it('a sidebar usa o rótulo de 20 px', () => {
    expect(stripWindowLabel('five_hour', PT)).toBe('5h');
    expect(stripWindowLabel('seven_day', PT)).toBe('sem');
    expect(stripWindowLabel('seven_day_opus', PT)).toBe('seven_day_opus');
  });
});

// ------------------------------------------------------------------- reset

describe('resetParts / resetText', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const inMinutes = (m: number): number => (now + m * 60_000) / 1000;

  it('abaixo de uma hora conta minutos', () => {
    expect(resetText(inMinutes(43), PT, now)).toBe('reseta em 43min');
    // Menos de um minuto ainda diz "1min": "reseta em 0min" seria mentira.
    expect(resetText(inMinutes(0.4), PT, now)).toBe('reseta em 1min');
  });

  it('abaixo de 24 h conta horas e minutos, com o zero à esquerda', () => {
    expect(resetText(inMinutes(135), PT, now)).toBe('reseta em 2h15');
    expect(resetText(inMinutes(125), PT, now)).toBe('reseta em 2h05');
    expect(resetText(inMinutes(120), PT, now)).toBe('reseta em 2h');
  });

  /** A partir de 24 h o dia da semana é o que a pessoa usa pra se planejar. */
  it('a partir de 24 h vira dia da semana, longo no painel e curto na sidebar', () => {
    // 2026-09-05 é um sábado; +3 dias cai na terça.
    const parts = resetParts(inMinutes(3 * 24 * 60), PT, now);
    expect(parts?.word).toBe('reseta ');
    expect(parts?.long).toBe('na terça');
    expect(parts?.short).toBe('ter');
    expect(resetText(inMinutes(3 * 24 * 60), PT, now)).toBe('reseta na terça');
  });

  /**
   * "reseta em -2h" seria pior que não escrever nada: um `resets_at` no passado
   * só quer dizer que a janela ainda não foi renovada no payload que temos.
   */
  it('reset vencido ou ausente não vira frase', () => {
    expect(resetText(inMinutes(-10), PT, now)).toBeUndefined();
    expect(resetText(undefined, PT, now)).toBeUndefined();
    expect(resetText(Number.NaN, PT, now)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- limites

describe('limitCards e limitRows', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const limits = [
    { window: 'five_hour', label: '5h', usedPct: 68, resetsAt: (now + 135 * 60_000) / 1000, seenAt: now },
    { window: 'seven_day', label: 'semana', usedPct: 41, seenAt: now },
  ];

  it('um cartão por janela do array, com degrau, barra e reset', () => {
    const cards = limitCards(limits, PT, now);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ label: 'Limite de 5 horas', pct: '68%', level: 'warn', fill: 68, reset: 'reseta em 2h15' });
    // Janela sem `resets_at`: o cartão fica só com o percentual.
    expect(cards[1]).toMatchObject({ label: 'Limite da semana', pct: '41%', level: 'ok', fill: 41 });
    expect(cards[1]?.reset).toBeUndefined();
  });

  it('a linha da sidebar leva as duas formas do reset e o título inteiro', () => {
    const rows = limitRows(limits, PT, now);
    expect(rows[0]).toMatchObject({ label: '5h', pct: '68%', level: 'warn' });
    expect(rows[0]?.reset).toEqual({ word: 'reseta em ', short: '2h15', long: '2h15' });
    // O `title` é o que sobra quando a consulta de contêiner esconde o reset.
    expect(rows[0]?.title).toBe('Limite de 5 horas · 68% · reseta em 2h15');
    expect(rows[1]?.title).toBe('Limite da semana · 41%');
  });

  /**
   * 16/09/2026 — as barras são fixas: a foto pode ter horas. Passado o
   * `resets_at`, a janela renovou e a tela mostra 0 % sem reset, no tique do
   * relógio da sidebar, sem esperar o core.
   */
  it('janela com reset vencido vira 0 % sem reset — no cartão, na linha e no selo', () => {
    const depois = now + 136 * 60_000;
    expect(limitCards(limits, PT, depois)[0]).toMatchObject({ pct: '0%', level: 'ok', fill: 0 });
    expect(limitCards(limits, PT, depois)[0]?.reset).toBeUndefined();
    const row = limitRows(limits, PT, depois)[0];
    expect(row).toMatchObject({ pct: '0%', level: 'ok', fill: 0 });
    expect(row?.reset).toBeUndefined();
    expect(row?.title).toBe('Limite de 5 horas · 0%');
    // A da semana, sem reset, fica como está.
    expect(limitRows(limits, PT, depois)[1]?.pct).toBe('41%');
    // O selo de 100 % apaga sozinho quando a janela renova.
    const estourada = [{ window: 'five_hour', usedPct: 100, resetsAt: (now + 60_000) / 1000 }];
    expect(usageLimitBadge(estourada, PT, now)).toBeDefined();
    expect(usageLimitBadge(estourada, PT, now + 60_001)).toBeUndefined();
  });
});

// -------------------------------------------------------- cabeçalho/recorte

describe('rangeLabel e headerNote', () => {
  it('nomeia o recorte', () => {
    expect(rangeLabel('day', '2026-09-05', '2026-09-05', PT)).toBe('hoje');
    expect(rangeLabel('week', '2026-08-31', '2026-09-06', PT)).toBe('semana de 31/08');
    expect(rangeLabel('month', '2026-09-01', '2026-09-05', PT)).toBe('setembro de 2026');
  });

  /** "meia-noite local" é a borda que decide se a madrugada conta hoje ou ontem. */
  it('só o recorte de dia fala da meia-noite', () => {
    expect(headerNote('day', '2026-09-05', '2026-09-05', PT)).toBe('hoje · o dia começa à meia-noite local');
    expect(headerNote('month', '2026-09-01', '2026-09-05', PT)).toBe('setembro de 2026');
  });

  it('shortDay não passa por Date (que leria a string como UTC)', () => {
    expect(shortDay('2026-08-31')).toBe('31/08');
    expect(shortDay('nada')).toBe('');
  });
});

/** Dias de `from` a `to`, zerados — a série de um período qualquer. */
function between(from: string, to: string): UsageDay[] {
  const out: UsageDay[] = [];
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  for (let d = new Date(fy, fm - 1, fd); ; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (iso > to) break;
    out.push(day(iso, { cost: null }));
  }
  return out;
}

describe('rangeLabel com hoje e os recortes novos', () => {
  const hoje = '2026-09-13';

  it('dia passado vira a data; o de hoje continua "hoje"', () => {
    expect(rangeLabel('day', hoje, hoje, PT, hoje)).toBe('hoje');
    expect(rangeLabel('day', '2026-09-10', '2026-09-10', PT, hoje)).toBe('10/09/2026');
    expect(headerNote('day', '2026-09-10', '2026-09-10', PT, hoje)).toBe('10/09/2026 · o dia começa à meia-noite local');
  });

  it('semana de outro ano leva o ano', () => {
    expect(rangeLabel('week', '2026-08-31', '2026-09-06', PT, hoje)).toBe('semana de 31/08');
    expect(rangeLabel('week', '2025-12-29', '2026-01-04', PT, hoje)).toBe('semana de 29/12/2025');
  });

  it('ano e personalizado', () => {
    expect(rangeLabel('year', '2025-01-01', '2025-12-31', PT, hoje)).toBe('2025');
    expect(rangeLabel('custom', '2026-08-01', '2026-09-13', PT, hoje)).toBe('01/08 – 13/09/2026');
    expect(rangeLabel('custom', '2025-12-20', '2026-01-05', PT, hoje)).toBe('20/12/2025 – 05/01/2026');
    expect(rangeLabel('custom', '2026-08-01', '2026-08-01', PT, hoje)).toBe('01/08/2026');
    expect(headerNote('custom', '2026-08-01', '2026-09-13', PT, hoje)).toBe('01/08 – 13/09/2026');
  });

  it('o toggle tem os cinco recortes', () => {
    expect(rangeOptions(PT).map((o) => o.value)).toEqual(['day', 'week', 'month', 'year', 'custom']);
    expect(rangeOptions(PT).map((o) => o.label)).toEqual(['dia', 'semana', 'mês', 'ano', 'personalizado']);
  });
});

describe('navegação de período', () => {
  // 13/09/2026 é um domingo: a semana dele começou na segunda 07/09.
  const hoje = '2026-09-13';

  it('o default é o mês atual, sem âncora — e "atual" não tem próximo', () => {
    expect(DEFAULT_USAGE_PERIOD).toEqual({ range: 'month' });
    expect(isCurrentPeriod({ range: 'month' }, hoje)).toBe(true);
    expect(canGoNext({ range: 'month' }, hoje)).toBe(false);
    expect(canGoPrev({ range: 'month' }, hoje)).toBe(true);
  });

  it('anterior e próximo andam uma unidade, com a âncora no começo do período', () => {
    expect(shiftPeriod({ range: 'month' }, -1, hoje)).toEqual({ range: 'month', anchor: '2026-08-01' });
    expect(shiftPeriod({ range: 'month', anchor: '2026-08-01' }, -1, hoje)).toEqual({ range: 'month', anchor: '2026-07-01' });
    expect(shiftPeriod({ range: 'month', anchor: '2026-07-01' }, 1, hoje)).toEqual({ range: 'month', anchor: '2026-08-01' });
    expect(shiftPeriod({ range: 'week' }, -1, hoje)).toEqual({ range: 'week', anchor: '2026-08-31' });
    expect(shiftPeriod({ range: 'day' }, -1, hoje)).toEqual({ range: 'day', anchor: '2026-09-12' });
    expect(shiftPeriod({ range: 'year' }, -1, hoje)).toEqual({ range: 'year', anchor: '2025-01-01' });
  });

  /** Voltar ao período de hoje TIRA a âncora: ele segue "atual" depois da meia-noite. */
  it('chegar ao período de hoje volta pro sem-âncora, e o próximo não passa dele', () => {
    expect(shiftPeriod({ range: 'month', anchor: '2026-08-01' }, 1, hoje)).toEqual({ range: 'month' });
    expect(shiftPeriod({ range: 'day' }, 1, hoje)).toEqual({ range: 'day' });
    expect(isCurrentPeriod({ range: 'week', anchor: '2026-09-07' }, hoje)).toBe(true);
    expect(canGoNext({ range: 'day', anchor: '2026-09-12' }, hoje)).toBe(true);
  });

  it('anterior para no primeiro dia que o core aceita', () => {
    expect(canGoPrev({ range: 'year', anchor: '2020-06-01' }, hoje)).toBe(false);
    expect(shiftPeriod({ range: 'year', anchor: '2020-06-01' }, -1, hoje)).toEqual({ range: 'year', anchor: '2020-06-01' });
    expect(canGoPrev({ range: 'month', anchor: '2020-02-01' }, hoje)).toBe(true);
    // A semana de 01/01/2020 começa em 2019; a âncora não pode cair antes do mínimo.
    expect(canGoPrev({ range: 'week', anchor: '2020-01-01' }, hoje)).toBe(false);
    expect(shiftPeriod({ range: 'week', anchor: '2020-01-06' }, -1, hoje)).toEqual({ range: 'week', anchor: '2020-01-01' });
  });

  it('personalizado nunca é "atual" e não navega', () => {
    const livre = { range: 'custom', from: '2026-08-01', to: '2026-08-15' } as const;
    expect(isCurrentPeriod(livre, hoje)).toBe(false);
    expect(canGoNext(livre, hoje)).toBe(false);
    expect(canGoPrev(livre, hoje)).toBe(false);
    expect(shiftPeriod(livre, 1, hoje)).toEqual(livre);
  });

  it('trocar de recorte', () => {
    // Ancorado → ancorado mantém a data que se estava olhando.
    expect(switchRange({ range: 'month', anchor: '2026-07-01' }, 'week', hoje)).toEqual({ range: 'week', anchor: '2026-06-29' });
    expect(switchRange({ range: 'month', anchor: '2026-07-01' }, 'year', hoje)).toEqual({ range: 'year' });
    // → personalizado começa com o período em tela, preso em hoje.
    expect(switchRange({ range: 'month' }, 'custom', hoje)).toEqual({ range: 'custom', from: '2026-09-01', to: hoje });
    expect(switchRange({ range: 'month', anchor: '2026-07-01' }, 'custom', hoje)).toEqual({ range: 'custom', from: '2026-07-01', to: '2026-07-31' });
    // Personalizado → ancorado volta ao período de hoje.
    expect(switchRange({ range: 'custom', from: '2026-07-01', to: '2026-07-31' }, 'week', hoje)).toEqual({ range: 'week' });
    // O mesmo recorte não mexe em nada.
    const livre = { range: 'custom', from: '2026-07-01', to: '2026-07-31' } as const;
    expect(switchRange(livre, 'custom', hoje)).toBe(livre);
  });

  it('a query da rota: sem anchor no período atual, from/to no personalizado', () => {
    expect(usageQuery({ range: 'month' })).toBe('range=month');
    expect(usageQuery({ range: 'day', anchor: '2026-09-12' })).toBe('range=day&anchor=2026-09-12');
    expect(usageQuery({ range: 'custom', from: '2026-08-01', to: '2026-08-15' })).toBe('range=custom&from=2026-08-01&to=2026-08-15');
  });

  it('período personalizado válido', () => {
    expect(customPeriodValid('2026-08-01', '2026-08-15', hoje)).toBe(true);
    expect(customPeriodValid('2026-08-15', '2026-08-01', hoje)).toBe(false);
    expect(customPeriodValid('2026-08-01', '2026-09-14', hoje)).toBe(false);
    expect(customPeriodValid('2019-12-31', '2020-01-10', hoje)).toBe(false);
    expect(customPeriodValid('2025-09-13', hoje, hoje)).toBe(true);
    expect(customPeriodValid('2025-09-12', hoje, hoje)).toBe(false);
    expect(customPeriodValid('2026-02-30', hoje, hoje)).toBe(false);
    expect(customPeriodValid('', hoje, hoje)).toBe(false);
  });

  it('localDayOf lê o dia LOCAL, não o UTC', () => {
    expect(localDayOf(new Date(2026, 8, 13, 23, 59).getTime())).toBe('2026-09-13');
    expect(localDayOf(new Date(2026, 8, 13, 0, 1).getTime())).toBe('2026-09-13');
  });
});

describe('chartModel — séries longas', () => {
  const ano = report({
    range: 'year',
    from: '2025-01-01',
    to: '2025-12-31',
    chartFrom: '2025-01-01',
    chartTo: '2025-12-31',
    byDay: between('2025-01-01', '2025-12-31'),
  });

  it('um ano marca o primeiro dia de cada mês e fica denso', () => {
    const chart = chartModel(ano, PT);
    expect(chart.columns).toHaveLength(365);
    expect(chart.columns.filter((c) => c.tick !== '').map((c) => c.tick)).toEqual([
      '01/01', '01/02', '01/03', '01/04', '01/05', '01/06', '01/07', '01/08', '01/09', '01/10', '01/11', '01/12',
    ]);
    expect(chart.dense).toBe(true);
    expect(chartModel(report(), PT).dense).toBe(false);
  });

  /** O tooltip encosta nas BORDAS — um décimo da série, no mínimo três colunas. */
  it('a borda do tooltip acompanha o tamanho da série', () => {
    const curto = chartModel(report(), PT).columns;
    expect(curto.map((c) => c.edge).slice(0, 4)).toEqual(['start', 'start', 'start', undefined]);
    expect(curto.map((c) => c.edge).slice(26)).toEqual([undefined, 'end', 'end', 'end']);
    const longo = chartModel(ano, PT).columns;
    expect(longo[36]?.edge).toBe('start');
    expect(longo[37]?.edge).toBeUndefined();
    expect(longo[327]?.edge).toBeUndefined();
    expect(longo[328]?.edge).toBe('end');
  });
});

describe('chartHint', () => {
  it('os 30 dias até hoje mantêm a frase de sempre', () => {
    expect(chartHint(report({ today: '2026-09-05' }), PT)).toBe('últimos 30 dias · barra azul = intervalo selecionado');
    // Core anterior ao campo `today`: a série de 30 é a de sempre.
    expect(chartHint(report(), PT)).toBe('últimos 30 dias · barra azul = intervalo selecionado');
  });

  it('outra janela escreve as datas dela', () => {
    expect(chartHint({ ...ano2025(), today: '2026-09-13' }, PT)).toBe('01/01/2025 a 31/12/2025 · barra azul = intervalo selecionado');
  });

  function ano2025(): UsageReport {
    return report({ range: 'year', from: '2025-01-01', to: '2025-12-31', chartFrom: '2025-01-01', chartTo: '2025-12-31', byDay: between('2025-01-01', '2025-12-31') });
  }
});

// ------------------------------------------------------------ estado vazio

describe('estado vazio', () => {
  /**
   * "Nenhum transcript VARRIDO" não é "nenhum consumo no recorte": um mês sem
   * uso numa máquina cheia de transcrições é um painel zerado legítimo.
   */
  it('vazio é ZERO arquivo varrido, não zero mensagem', () => {
    expect(isEmpty(report({ scannedFiles: 0 }))).toBe(true);
    expect(isEmpty(report({ scannedFiles: 12, totals: totals() }))).toBe(false);
  });

  it('mostra a pasta que o core informou, com o /projects no fim', () => {
    expect(emptyState(report({ claudeHome: 'D:\\fixture\\claude' }), PT).home).toBe('D:\\fixture\\claude\\projects');
    expect(emptyState(report({ claudeHome: 'D:\\fixture\\claude\\' }), PT).home).toBe('D:\\fixture\\claude\\projects');
    expect(emptyHeaderNote(PT)).toBe('nada para somar ainda');
  });
});

// ----------------------------------------------------------------- cartões

describe('totalCards', () => {
  it('cinco cartões, com o cache somado e a repartição no sub', () => {
    const cards = totalCards(report({ byModel: [model('a')], byProject: [project('x')] }), { showCost: true }, PT);
    expect(cards.map((c) => c.id)).toEqual(['input', 'output', 'cache', 'cost', 'messages']);
    expect(cards[0]?.value).toBe('742,1k');
    expect(cards[2]?.value).toBe('23,2M');
    expect(cards[2]?.sub).toBe('1,9M escrita · 21,3M leitura');
    expect(cards[3]?.value).toBe('US$ 48,70');
    expect(cards[4]?.value).toBe('1.284');
    expect(cards[4]?.sub).toBe('1 modelo · 1 projeto');
  });

  /** Some da LISTA, não da grade: a grade tem cinco colunas e se redistribui. */
  it('sem custo, o cartão de custo não existe', () => {
    const cards = totalCards(report(), { showCost: false }, PT);
    expect(cards.map((c) => c.id)).toEqual(['input', 'output', 'cache', 'messages']);
  });

  it('custo nulo escreve "sem preço", não zero', () => {
    const cards = totalCards(report({ totals: totals({ cost: null, messages: 3 }) }), { showCost: true }, PT);
    expect(cards.find((c) => c.id === 'cost')?.value).toBe(noPriceLabel(PT));
  });
});

describe('subagentNote', () => {
  it('conta a fatia dos subagentes quando ela existe', () => {
    const r = report({ bySource: { main: totals({ messages: 900 }), subagents: totals({ messages: 384 }) } });
    expect(subagentNote(r, PT)).toBe('inclui 384 de subagentes');
    expect(totalCards(r, { showCost: true }, PT).find((c) => c.id === 'messages')?.sub).toContain('inclui 384 de subagentes');
  });

  /** "inclui 0 de subagentes" é ruído; core velho sem o campo, idem. */
  it('cala quando não houve subagente', () => {
    expect(subagentNote(report(), PT)).toBeUndefined();
    expect(subagentNote(report({ bySource: undefined as unknown as UsageReport['bySource'] }), PT)).toBeUndefined();
  });
});

// ----------------------------------------------------------------- gráfico

describe('chartScale', () => {
  /** Quatro marcas: o topo é sempre passo × 3, senão o eixo sai quebrado. */
  it('arredonda o topo pra cima num passo redondo', () => {
    expect(chartScale([16, 3, 0], PT)).toEqual({ max: 18, ticks: ['US$ 18', '12', '6', '0'] });
    expect(chartScale([1.1], PT)).toEqual({ max: 1.5, ticks: ['US$ 1,5', '1', '0,5', '0'] });
    expect(chartScale([31], PT)).toEqual({ max: 36, ticks: ['US$ 36', '24', '12', '0'] });
  });

  /** Eixo em branco pareceria gráfico quebrado; as barras zeradas já contam. */
  it('recorte sem custo nenhum ainda tem escala', () => {
    expect(chartScale([0, 0, 0], PT)).toEqual({ max: 3, ticks: ['US$ 3', '2', '1', '0'] });
  });

  it('em tokens a escala e os rótulos mudam junto', () => {
    expect(chartScale([1_800_000], PT, 'tokens').ticks[0]).toBe('3M');
    expect(chartTitle('tokens', PT)).toBe('Tokens por dia');
    expect(chartTitle('cost', PT)).toBe('Custo por dia');
  });
});

describe('chartModel', () => {
  const r = report({
    byDay: series({
      '2026-08-22': { cost: 2.3, messages: 61, tokens: 700_000 },
      '2026-09-03': { cost: 6, messages: 148, tokens: 1_900_000 },
    }),
  });

  it('trinta colunas, com marca a cada seis dias e sempre a última', () => {
    const chart = chartModel(r, PT);
    expect(chart.columns).toHaveLength(30);
    expect(chart.columns.filter((c) => c.tick !== '')).toHaveLength(6);
    expect(chart.columns[0]?.tick).toBe('07/08');
    expect(chart.columns[29]?.tick).toBe('05/09');
  });

  /** Fora do recorte a barra recua pro cinza: contexto, não dado apagado. */
  it('marca as colunas fora do recorte', () => {
    const chart = chartModel(r, PT);
    expect(chart.columns.find((c) => c.day === '2026-08-22')?.out).toBe(true);
    expect(chart.columns.find((c) => c.day === '2026-09-03')?.out).toBe(false);
  });

  /**
   * Dia sem mensagem nenhuma é um TRAÇO, não uma barra de zero — e escreve
   * `US$ 0,00`, não "sem preço": o core devolve `cost: null` num dia zerado
   * porque não houve modelo a precificar, e "sem preço" ali mandaria procurar
   * uma tabela que não faltou.
   */
  it('dia zerado vira traço com custo zero', () => {
    const zero = chartModel(r, PT).columns.find((c) => c.day === '2026-08-08');
    expect(zero?.zero).toBe(true);
    expect(zero?.height).toBe(0);
    expect(zero?.cost).toBe('US$ 0,00');
  });

  /** Dia com consumo e custo perto de zero ainda desenha um fio. */
  it('dia com mensagem nunca some na linha de base', () => {
    const chart = chartModel(report({ byDay: series({ '2026-09-04': { cost: 0.001, messages: 2, tokens: 10 }, '2026-09-05': { cost: 20, messages: 9, tokens: 10 } }) }), PT);
    const thin = chart.columns.find((c) => c.day === '2026-09-04');
    expect(thin?.zero).toBe(false);
    expect(thin?.height).toBe(1.5);
  });

  it('o rótulo da coluna carrega dia, custo e mensagens', () => {
    const col = chartModel(r, PT).columns.find((c) => c.day === '2026-08-22');
    expect(col?.label).toBe('sáb, 22/08 · US$ 2,30 · 61 mensagens');
    expect(col?.sub).toBe('61 mensagens · 700k tokens');
  });
});

// ----------------------------------------------------------------- tabelas

describe('topNWithOthers', () => {
  it('não corta o que já cabe', () => {
    const items = [totals({ tokens: 3 }), totals({ tokens: 1 })];
    expect(topNWithOthers(items, PROJECT_NOUN, PT).others).toBeUndefined();
  });

  it('agrupa o que passa do oitavo, somando os totais', () => {
    const items = Array.from({ length: 13 }, (_, i) => totals({ tokens: 100 - i, messages: 10, cost: 1 }));
    const result = topNWithOthers(items, PROJECT_NOUN, PT);
    expect(result.head).toHaveLength(8);
    expect(result.others?.label).toBe('outros (5 projetos)');
    expect(result.others?.totals.messages).toBe(50);
    expect(result.others?.totals.cost).toBe(5);
  });

  it('um item sobrando usa o singular', () => {
    const items = Array.from({ length: 9 }, () => totals());
    expect(topNWithOthers(items, MODEL_NOUN, PT).others?.label).toBe('outros (1 modelo)');
  });
});

describe('sumTotals', () => {
  /** Um item sem preço contamina o `costPartial`, sem zerar o que se sabe. */
  it('soma e propaga o "parte disso não tem preço"', () => {
    const sum = sumTotals([totals({ cost: 2, tokens: 10 }), totals({ cost: null, tokens: 5 })]);
    expect(sum.cost).toBe(2);
    expect(sum.tokens).toBe(15);
    expect(sum.costPartial).toBe(true);
  });

  it('nenhum item com preço deixa o custo NULO, não zero', () => {
    expect(sumTotals([totals({ cost: null }), totals({ cost: null })]).cost).toBeNull();
  });
});

describe('modelTable / projectTable', () => {
  const r = report({
    byModel: [
      model('Fable 5.1', { messages: 612, tokens: 14_800_000, cost: 31.42 }),
      model('claude-3-5-haiku', { messages: 13, tokens: 200_000, cost: null, unpriced: true }),
    ],
    byProject: [
      project('D:\\projetos\\bridge', { messages: 341, tokens: 9_000_000, cost: 12.84 }),
      project('D:\\projetos\\portal-web', { messages: 208, tokens: 5_000_000, cost: 7.95 }),
    ],
  });

  it('a tabela por modelo marca a linha sem preço', () => {
    const table = modelTable(r, PT);
    expect(table.rows[0]).toMatchObject({ name: 'Fable 5.1', messages: '612', tokens: '14,8M', cost: 'US$ 31,42', unpriced: false });
    expect(table.rows[1]).toMatchObject({ name: 'claude-3-5-haiku', cost: noPriceLabel(PT), unpriced: true });
    expect(table.total).toEqual({ messages: '1.284', tokens: '24,1M', cost: 'US$ 48,70' });
  });

  /** A barra compara por comprimento; a base é o custo do recorte. */
  it('a tabela por projeto calcula a participação pelo custo', () => {
    const table = projectTable(r, PT);
    expect(table.rows[0]?.name).toBe('bridge');
    expect(table.rows[0]?.share).toBeCloseTo(26.37, 2);
    expect(table.rows[1]?.share).toBeCloseTo(16.32, 2);
  });

  /**
   * Sem custo no recorte inteiro (tudo sem preço), a barra cai nos tokens —
   * senão a coluna ficaria com nove barras vazias, comparação nenhuma.
   */
  it('recorte sem custo compara por tokens', () => {
    const table = projectTable(report({ totals: totals({ cost: null, tokens: 14_000_000 }), byProject: r.byProject }), PT);
    expect(table.rows[0]?.share).toBeCloseTo((9_000_000 / 14_000_000) * 100, 2);
  });

  /** A linha "outros" é um saco de projetos, não um projeto: não tem barra. */
  it('a linha "outros" entra sem barra de participação', () => {
    const many = Array.from({ length: 10 }, (_, i) => project(`D:\\p${i}`, { messages: 1, cost: 1, tokens: 10 }));
    const table = projectTable(report({ byProject: many, totals: totals({ cost: 10, tokens: 100, messages: 10 }) }), PT);
    expect(table.rows).toHaveLength(9);
    expect(table.rows[8]?.name).toBe('outros (2 projetos)');
    expect(table.rows[8]?.share).toBeUndefined();
  });

  it('o nome do projeto é a última pasta do cwd', () => {
    expect(projectName('D:\\projetos\\bridge')).toBe('bridge');
    expect(projectName('/home/x/loja-api')).toBe('loja-api');
    expect(projectName('(sem projeto)')).toBe('(sem projeto)');
  });
});

// ------------------------------------------------------------------ avisos

describe('avisos de preço', () => {
  it('lista os modelos sem preço e conta no título', () => {
    const r = report({ byModel: [model('a'), model('b', { unpriced: true }), model('c', { unpriced: true })] });
    expect(unpricedModels(r, PT)).toEqual(['b', 'c']);
    expect(pricingWarningTitle(unpricedModels(r, PT), PT)).toBe('2 modelos sem preço na tabela');
    expect(pricingWarningTitle(['b'], PT)).toBe('1 modelo sem preço na tabela');
  });

  it('sem modelo sem preço não há aviso', () => {
    expect(pricingWarningTitle([], PT)).toBeUndefined();
  });
});

// ---------------------------------------------------- recarga do relatório

describe('touchesReport', () => {
  const r = report();

  /**
   * O `usage.changed` manda os DIAS que a varredura tocou, não os números: um
   * dia de julho tocado por um transcript antigo não muda o que está na tela, e
   * reler a cada passada do poller faria o core agregar um mês por nada.
   */
  it('só relê quando o dia tocado cai na janela do gráfico', () => {
    expect(touchesReport(r, ['2026-09-04'])).toBe(true);
    expect(touchesReport(r, ['2026-08-07'])).toBe(true);
    expect(touchesReport(r, ['2026-07-30'])).toBe(false);
    expect(touchesReport(r, ['2026-09-06'])).toBe(false);
  });

  it('sem relatório, ou sem lista de dias, não há o que reler', () => {
    expect(touchesReport(undefined, ['2026-09-04'])).toBe(false);
    expect(touchesReport(r, undefined)).toBe(false);
    expect(touchesReport(r, [])).toBe(false);
  });
});

// ------------------------------------------------------- linha da sessão

describe('sessionLine', () => {
  const quota: NonNullable<Session['quota']> = {
    model: 'Fable 5.1',
    contextTokens: 70_400,
    costUsd: 0.74,
    rateLimits: [],
    line: 'linha da statusline',
    at: 0,
  };

  /**
   * O formato do dinheiro é `US$ 0,74` em TODO lugar — painel, sidebar e a
   * statusline devolvida ao Claude Code. Até a 0.9.0 a faixa escrevia `$0.74`,
   * o formato de outra língua num app em pt-BR.
   */
  it('monta ctx · modelo · custo em pt-BR', () => {
    const line = sessionLine(quota, PT);
    expect(line?.text).toBe('70k ctx · Fable 5.1 · US$ 0,74');
    expect(line?.ctx).toBe('70k ctx');
    expect(line?.model).toBe('Fable 5.1');
    expect(line?.cost).toBe('US$ 0,74');
  });

  it('omite o que o core não mandou', () => {
    expect(sessionLine({ ...quota, costUsd: undefined }, PT)?.text).toBe('70k ctx · Fable 5.1');
    expect(sessionLine({ ...quota, model: '' }, PT)?.text).toBe('70k ctx · US$ 0,74');
    expect(sessionLine(undefined, PT)).toBeUndefined();
  });

  it('com o custo desligado a linha para no modelo', () => {
    const line = sessionLine(quota, PT, { showCost: false });
    expect(line?.text).toBe('70k ctx · Fable 5.1');
    expect(line?.cost).toBeUndefined();
  });

  /**
   * A linha é montada dos campos ESTRUTURADOS, nunca da `line` pronta do
   * snapshot: a linha do terminal carrega também as janelas de limite, que
   * agora vivem no bloco da sidebar, uma vez só.
   */
  it('ignora a linha pronta do snapshot', () => {
    expect(sessionLine({ ...quota, model: 'Fable 5.1' }, PT)?.text).not.toContain('statusline');
  });
});

describe('tableWarnings', () => {
  /**
   * O aviso "modelo sem preço" já vira a caixa com a copy do gate e a lista dos
   * modelos; repetir a frase crua do core embaixo dela diria duas vezes a mesma
   * coisa. O que fala da TABELA (arquivo ilegível, override malformado) não tem
   * outro lugar e continua aparecendo.
   */
  it('separa o que é da tabela do que é modelo sem preço', () => {
    const r = report({
      pricingWarnings: [
        'modelo sem preço: claude-x — o consumo dele conta nos tokens, mas fica de fora do custo estimado',
        'usage.pricingFile: não deu pra ler "D:\precos.json" (ENOENT); usando a tabela embutida',
      ],
    });
    expect(tableWarnings(r, PT)).toEqual([
      'usage.pricingFile: não deu pra ler "D:\precos.json" (ENOENT); usando a tabela embutida',
    ]);
  });

  /** Formato de aviso que o core mude no futuro cai no lado seguro: aparece. */
  it('aviso desconhecido não é engolido', () => {
    expect(tableWarnings(report({ pricingWarnings: ['algo novo do core'] }), PT)).toEqual(['algo novo do core']);
  });
});

// ------------------------------------------------------------ nome do modelo

describe('modelDisplayName', () => {
  it('encurta as famílias conhecidas', () => {
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelDisplayName('claude-mythos-5-1')).toBe('Mythos 5.1');
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  /** O id datado é o que aparece de verdade nos transcripts. */
  it('descarta o sufixo de data do snapshot', () => {
    expect(modelDisplayName('claude-sonnet-4-5-20260514')).toBe('Sonnet 4.5');
    expect(modelDisplayName('claude-opus-5-20260901')).toBe('Opus 5');
  });

  /**
   * Encurtar na marra o que não se reconhece é como se inventa um nome errado:
   * família nova, snapshot com forma própria e a linha sintética voltam
   * INTEIROS.
   */
  it('id que não casa volta cru', () => {
    expect(modelDisplayName('claude-nao-catalogado-1')).toBe('claude-nao-catalogado-1');
    expect(modelDisplayName('claude-3-5-haiku')).toBe('claude-3-5-haiku');
    expect(modelDisplayName('<synthetic>')).toBe('<synthetic>');
    expect(modelDisplayName('gpt-qualquer')).toBe('gpt-qualquer');
  });

  /** A tabela mostra o nome curto e guarda o id cru na chave (que vira `title`). */
  it('a tabela por modelo mostra o nome e guarda o id', () => {
    const table = modelTable(
      report({ byModel: [model('claude-fable-5-1', { messages: 10, tokens: 1000, cost: 1 })] }),PT,
    );
    expect(table.rows[0]?.name).toBe('Fable 5.1');
    expect(table.rows[0]?.key).toBe('claude-fable-5-1');
  });

  it('a linha da sessão também normaliza o modelo', () => {
    const quota = { contextTokens: 70_400, model: 'claude-fable-5-1', costUsd: 0.74 };
    expect(sessionLine(quota, PT)?.text).toBe('70k ctx · Fable 5.1 · US$ 0,74');
  });
});

// --------------------------------------------------------- janela do gráfico

describe('chartWindow', () => {
  /**
   * A série é SEMPRE os últimos 30 dias terminando hoje, em qualquer recorte: o
   * `range` é a parte destacada dela, não uma série diferente.
   */
  it('usa o chartFrom/chartTo do core quando ele manda', () => {
    const r = report({ chartFrom: '2026-08-08', chartTo: '2026-09-06', from: '2026-09-01', to: '2026-09-30' });
    expect(chartWindow(r)).toEqual({ from: '2026-08-08', to: '2026-09-06' });
  });

  /** Core anterior à fix round: a janela sai da própria série. */
  it('sem os campos, deduz da série', () => {
    const r = report();
    expect(chartWindow(r)).toEqual({ from: r.byDay[0]?.day, to: r.byDay[r.byDay.length - 1]?.day });
  });

  it('touchesReport passa a comparar contra a janela do gráfico', () => {
    const r = report({ chartFrom: '2026-08-08', chartTo: '2026-09-06' });
    expect(touchesReport(r, ['2026-08-08'])).toBe(true);
    expect(touchesReport(r, ['2026-09-06'])).toBe(true);
    expect(touchesReport(r, ['2026-08-07'])).toBe(false);
    expect(touchesReport(r, ['2026-09-07'])).toBe(false);
  });
});

// --------------------------------------------- progresso da varredura

describe('scanningLine', () => {
  const lendo = { active: true, filesDone: 1200, filesTotal: 8431, bytesDone: 100, bytesTotal: 1000, skippedLines: 0 };

  /**
   * "Nenhuma transcrição encontrada" é FALSO enquanto o core está lendo: elas
   * existem, ele é que não chegou nelas. Numa árvore de 12,8 GB esse intervalo
   * dura minutos — e era o primeiro contato de quem abre o painel.
   */
  it('a varredura em voo vira a frase do estado vazio, com a fração', () => {
    expect(scanningLine(lendo, PT)).toBe('ainda lendo as transcrições (1.200 de 8.431 arquivos)');
  });

  it('varredura parada, ausente ou nula não escreve nada', () => {
    expect(scanningLine({ ...lendo, active: false }, PT)).toBeUndefined();
    expect(scanningLine(null, PT)).toBeUndefined();
    expect(scanningLine(undefined, PT)).toBeUndefined();
  });
});

describe('rescanStatus', () => {
  /**
   * A fração é dos BYTES: numa árvore real convivem transcrições de 4 KB e de
   * 200 MB, e uma porcentagem por contagem de arquivos anda em saltos que não
   * têm relação nenhuma com o tempo que falta.
   */
  it('enquanto lê, mostra a fração de arquivos e a porcentagem de bytes', () => {
    expect(
      rescanStatus({ active: true, filesDone: 40, filesTotal: 200, bytesDone: 250, bytesTotal: 1000, skippedLines: 0 }, undefined, PT),
    ).toBe('Lendo… 40 de 200 arquivos (25%)');
  });

  it('árvore vazia não vira divisão por zero — a porcentagem some', () => {
    expect(rescanStatus({ active: true, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, skippedLines: 0 }, undefined, PT)).toBe(
      'Lendo… 0 de 0 arquivos',
    );
  });

  it('terminada, vira o resultado do rescan', () => {
    expect(rescanStatus(null, { files: 8431, entries: 184000, days: 96 }, PT)).toBe(
      'Pronto: 8.431 arquivos, 184.000 mensagens, 96 dias com consumo.',
    );
    expect(rescanStatus(null, { files: 2, entries: 3, days: 1 }, PT)).toBe('Pronto: 2 arquivos, 3 mensagens, 1 dia com consumo.');
  });

  /** O progresso VENCE o resultado: uma varredura nova em voo é a notícia. */
  it('sem varredura e sem resultado não escreve nada', () => {
    expect(rescanStatus(null, undefined, PT)).toBeUndefined();
    expect(
      rescanStatus({ active: true, filesDone: 1, filesTotal: 2, bytesDone: 1, bytesTotal: 2, skippedLines: 0 }, { files: 9, entries: 9, days: 9 }, PT),
    ).toContain('Lendo…');
  });
});

describe('cacheSub', () => {
  /**
   * A escrita de 1 h custa o DOBRO do input (a de 5 min, 1,25 ×). Somar as
   * duas numa parcela só esconderia de onde o custo veio.
   */
  it('a escrita de 1 h aparece como parcela própria quando existe', () => {
    expect(cacheSub(totals({ cacheWrite: 1_900_000, cacheWrite1h: 400_000, cacheRead: 21_300_000 }), PT)).toBe(
      '1,9M escrita · 400k escrita 1h · 21,3M leitura',
    );
  });

  /** Zero não ganha parcela: uma linha que diz "0 escrita 1h" gasta espaço pra dizer "não houve". */
  it('sem escrita de 1 h, a sub-linha continua com duas parcelas', () => {
    expect(cacheSub(totals({ cacheWrite: 1_900_000, cacheWrite1h: 0, cacheRead: 21_300_000 }), PT)).toBe(
      '1,9M escrita · 21,3M leitura',
    );
  });
});

/**
 * BU-13 — a UI nunca teve injeção (o React escapa, e o grep por
 * `dangerouslySetInnerHTML`/`innerHTML`/`eval` em `packages/ui/src` continua
 * zerado). O que faltava era TAMANHO e CONTROLE: um `cwd` de 10 kB num
 * `title`, uma chave de janela de 64 caracteres num rótulo sem reticências, e
 * a lista de "modelos sem preço" rodando sobre o `byModel` inteiro.
 */
describe('BU-13 — rótulo hostil de transcript e de payload', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const SEM_CONTROLE = /[ --]/;

  it('o nome do projeto sai limpo e cortado', () => {
    const sujo = `${ESC}]0;X${BEL}${ESC}[31mprojeto` + String.fromCharCode(13, 10) + 'x';
    expect(SEM_CONTROLE.test(projectName(sujo))).toBe(false);
    expect(projectName('C:/' + 'A'.repeat(10_240)).length).toBeLessThanOrEqual(120);
  });

  it('o id de modelo desconhecido sai limpo', () => {
    expect(SEM_CONTROLE.test(modelDisplayName(`${ESC}[2J MODELO`))).toBe(false);
  });

  it('a chave da tabela (que vira `title`) sai limpa e cortada', () => {
    const r = report({ byProject: [project('C:/' + 'B'.repeat(10_240))] });
    const linha = projectTable(r, PT).rows[0];
    expect(linha?.key.length).toBeLessThanOrEqual(120);
    expect(SEM_CONTROLE.test(linha?.key ?? '')).toBe(false);
  });

  it('o rótulo e o `title` de uma janela desconhecida saem limpos', () => {
    const chave = `${ESC}]0;J${BEL}janela`;
    expect(SEM_CONTROLE.test(windowLabel(chave, PT).label)).toBe(false);
    expect(SEM_CONTROLE.test(stripWindowLabel(chave, PT))).toBe(false);
    const linhas = limitRows([{ window: chave, usedPct: 10 }], PT, Date.now());
    expect(SEM_CONTROLE.test(linhas[0]?.title ?? '')).toBe(false);
    const cartoes = limitCards([{ window: chave, usedPct: 10 }], PT, Date.now());
    expect(SEM_CONTROLE.test(cartoes[0]?.label ?? '')).toBe(false);
  });

  it('50 modelos sem preço viram 8 linhas + "(e mais 42 modelos)"', () => {
    const byModel = Array.from({ length: 50 }, (_, i) => model(`modelo-${i}`, { unpriced: true }));
    const lista = unpricedModels(report({ byModel }), PT);
    expect(lista).toHaveLength(9);
    expect(lista[8]).toBe('(e mais 42 modelos)');
  });

  it('controle: oito ou menos continuam saindo inteiros', () => {
    const byModel = Array.from({ length: 3 }, (_, i) => model(`modelo-${i}`, { unpriced: true }));
    expect(unpricedModels(report({ byModel }), PT)).toEqual(['modelo-0', 'modelo-1', 'modelo-2']);
  });

  it('os avisos de tabela saem limpos', () => {
    const r = report({ pricingWarnings: [`usage.pricingFile: ${ESC}[31m x`] });
    expect(SEM_CONTROLE.test(tableWarnings(r, PT).join(' '))).toBe(false);
  });
});

/**
 * Rodada 2 — Trojan Source na UI. O React escapa HTML, então nunca houve
 * injeção; o que passava era o `U+202E`, que reordena a RENDERIZAÇÃO de um
 * `title`/`aria-label` sem mudar um byte, e os de largura zero.
 */
describe('rodada 2 — bidi e largura zero', () => {
  const INVISIVEL = /[​-‏‪-‮⁠-⁯﻿]/;

  it('projeto, modelo, chave da tabela e rótulo de janela saem sem eles', () => {
    expect(INVISIVEL.test(projectName('C:/proj/gnp‮txt.exe'))).toBe(false);
    expect(INVISIVEL.test(modelDisplayName('claude​sonnet'))).toBe(false);
    const r = report({ byProject: [project('C:/a‮b')], byModel: [model('claude​x', { unpriced: true })] });
    expect(INVISIVEL.test(projectTable(r, PT).rows[0]?.key ?? '')).toBe(false);
    expect(INVISIVEL.test(modelTable(r, PT).rows[0]?.key ?? '')).toBe(false);
    expect(INVISIVEL.test(windowLabel('five‮hour', PT).label)).toBe(false);
    expect(INVISIVEL.test(limitRows([{ window: 'w​', usedPct: 1 }], PT, 0)[0]?.title ?? '')).toBe(false);
    expect(INVISIVEL.test(unpricedModels(r, PT).join(' '))).toBe(false);
  });

  /**
   * A `key` do React não pode ser o texto sanitizado: dois `cwd` diferentes
   * podem virar o MESMO texto (um invisível a menos), e com `key` repetida o
   * React reaproveita a linha errada ao reordenar.
   */
  it('a id de linha é estável mesmo quando dois nomes sanitizam pro mesmo texto', () => {
    const r = report({ byProject: [project('C:/a​b'), project('C:/ab')] });
    const linhas = projectTable(r, PT).rows;
    expect(linhas[0]?.key).toBe(linhas[1]?.key);
    expect(linhas[0]?.id).not.toBe(linhas[1]?.id);
    expect(new Set(linhas.map((l) => l.id)).size).toBe(linhas.length);
  });
});

describe('scanCaveat — o que a varredura não leu', () => {
  const base = { active: false, filesDone: 3, filesTotal: 3, bytesDone: 9, bytesTotal: 9 };

  it('conta as linhas puladas e diz que o número está menor que o real', () => {
    const texto = scanCaveat({ ...base, skippedLines: 7 }, PT);
    expect(texto).toContain('7 linhas ignoradas por tamanho');
    expect(texto).toContain('menor que o consumo real');
  });

  it('uma linha só sai no singular, e a lista cortada entra junto', () => {
    expect(scanCaveat({ ...base, skippedLines: 1 }, PT)).toContain('1 linha ignorada por tamanho');
    const dois = scanCaveat({ ...base, skippedLines: 2, capped: true }, PT);
    expect(dois).toContain('2 linhas ignoradas');
    expect(dois).toContain('lista limitada a 50.000 arquivos');
  });

  it('varredura limpa não escreve nada', () => {
    expect(scanCaveat({ ...base, skippedLines: 0 }, PT)).toBeUndefined();
    expect(scanCaveat(null, PT)).toBeUndefined();
    expect(scanCaveat(undefined, PT)).toBeUndefined();
  });
});

// ------------------------------ dor #1: limite de USO atingido (100 %)

/**
 * O selo VERMELHO do limite de uso — o gemeo do laranja do servidor. Os dois
 * ficam perto na sidebar de proposito: a dor verificada #1 e exatamente a
 * pessoa nao conseguir distinguir um do outro.
 */
describe('usageLimitBadge', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);

  it('abaixo de 100 % não há selo — a barra já conta a história', () => {
    expect(usageLimitBadge([{ window: 'five_hour', usedPct: 99 }], PT, now)).toBeUndefined();
  });

  it('em 100 % diz o que aconteceu e quando reseta', () => {
    const badge = usageLimitBadge([{ window: 'five_hour', usedPct: 100, resetsAt: (now + 43 * 60_000) / 1000 }], PT, now);
    expect(badge?.text).toBe('limite de uso atingido · reseta em 43min');
    expect(badge?.title).toContain('Este é o SEU limite de uso');
  });

  it('sem reset no payload, o selo nomeia a janela em vez de inventar hora', () => {
    expect(usageLimitBadge([{ window: 'seven_day', usedPct: 100 }], PT, now)?.text).toBe('limite de uso atingido (sem)');
  });

  it('lista vazia (conta de chave de API) não desenha nada', () => {
    expect(usageLimitBadge([], PT, now)).toBeUndefined();
  });
});
