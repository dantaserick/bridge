/**
 * A parte PURA do monitor de uso (ADR-012): recortes de tempo e agregação.
 *
 * Tudo aqui roda com `tz` explícito e sem tocar em disco. Não é preciosismo:
 * a decisão do dono é "o dia começa à meia-noite LOCAL", e cobrar isso com o
 * fuso da máquina de quem roda a suíte daria um teste que passa em São Paulo
 * e falha em qualquer CI que rode em UTC.
 */
import { describe, expect, it } from 'vitest';
import { MAX_USAGE_RANGE_DAYS, MIN_USAGE_DAY } from '@bridge/shared';
import {
  CHART_DAYS,
  chartBounds,
  dayCount,
  daysBetween,
  isCalendarDay,
  isValidTimeZone,
  localDay,
  monthBounds,
  rangeBounds,
  resolvePeriod,
  shiftDay,
  summarize,
  weekBounds,
  yearBounds,
  type DailyRow,
} from '../src/usage/aggregate.js';
import { EMBEDDED_PRICING, type PricingTable } from '../src/usage/pricing.js';

const SP = 'America/Sao_Paulo';

function row(overrides: Partial<DailyRow> & { day: string }): DailyRow {
  return {
    model: 'claude-sonnet-4-5',
    source: 'main',
    project: 'C:\\projetos\\a',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    messages: 1,
    ...overrides,
  };
}

describe('localDay — meia-noite LOCAL, não UTC', () => {
  /**
   * O caso que motiva a decisão do dono: 22h em São Paulo é 01h do dia
   * SEGUINTE em UTC. Somar pelo UTC jogaria o trabalho da noite no "amanhã", e
   * o painel discordaria do relógio da parede.
   */
  it('22h em São Paulo é o MESMO dia local, e o dia seguinte em UTC', () => {
    const at = '2026-09-05T01:30:00.000Z';
    expect(localDay(at, SP)).toBe('2026-09-04');
    expect(localDay(at, 'UTC')).toBe('2026-09-05');
  });

  it('a virada da meia-noite local muda o dia', () => {
    expect(localDay('2026-09-05T02:59:00.000Z', SP)).toBe('2026-09-04');
    expect(localDay('2026-09-05T03:01:00.000Z', SP)).toBe('2026-09-05');
  });

  it('carimbo ilegível não vira um dia inventado', () => {
    expect(localDay('nem data nem nada', SP)).toBeUndefined();
  });

  it('fuso desconhecido é recusado antes de virar UTC calado', () => {
    expect(isValidTimeZone(SP)).toBe(true);
    expect(isValidTimeZone('Marte/Olympus')).toBe(false);
  });
});

describe('recortes', () => {
  it('semana é de segunda a domingo', () => {
    // 2026-09-05 é um sábado.
    expect(weekBounds('2026-09-05')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    // O domingo pertence à semana que COMEÇOU na segunda anterior.
    expect(weekBounds('2026-09-06')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    // E a segunda seguinte já abre a próxima.
    expect(weekBounds('2026-09-07')).toEqual({ from: '2026-09-07', to: '2026-09-13' });
  });

  it('mês é o civil, com o fim certo em fevereiro bissexto', () => {
    expect(monthBounds('2026-09-05')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthBounds('2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthBounds('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('dia é só ele', () => {
    expect(rangeBounds('day', '2026-09-05')).toEqual({ from: '2026-09-05', to: '2026-09-05' });
  });

  /**
   * A série NÃO acompanha o recorte: ela é sempre os últimos 30 dias até
   * HOJE. Amarrada ao recorte, o mês civil terminava no dia 30 e a série vinha
   * com uma cauda de dias FUTUROS zerados — que qualquer pessoa lê como "o
   * consumo caiu".
   */
  it('a série do gráfico do recorte ATUAL continua sendo 30 dias terminando hoje', () => {
    const hoje = '2026-09-05';
    for (const range of ['day', 'week', 'month'] as const) {
      const grafico = chartBounds(rangeBounds(range, hoje), hoje);
      expect(grafico, range).toEqual({ from: '2026-08-07', to: hoje });
      expect(daysBetween(grafico.from, grafico.to)).toHaveLength(CHART_DAYS);
    }

    // O recorte de mês termina no dia 30 — a série não vai até lá.
    expect(rangeBounds('month', hoje).to).toBe('2026-09-30');
  });

  it('shiftDay atravessa virada de mês e de ano', () => {
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('ano é o civil, com 366 dias no bissexto', () => {
    expect(yearBounds('2024-07-01')).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(daysBetween('2024-01-01', '2024-12-31')).toHaveLength(366);
    expect(dayCount('2024-01-01', '2024-12-31')).toBe(366);
    expect(dayCount('2026-01-01', '2026-12-31')).toBe(365);
    expect(rangeBounds('year', '2026-09-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  /** O recorte é o que CONTÉM a âncora — hoje é só a âncora default. */
  it('rangeBounds ancora na data pedida, não em hoje', () => {
    expect(rangeBounds('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(rangeBounds('week', '2025-12-31')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(rangeBounds('day', '2021-03-10')).toEqual({ from: '2021-03-10', to: '2021-03-10' });
  });

  it('isCalendarDay recusa forma errada e dia que o calendário não tem', () => {
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('2026-9-1')).toBe(false);
    expect(isCalendarDay('2026-09-01T00:00')).toBe(false);
    expect(isCalendarDay('')).toBe(false);
  });
});

/**
 * A janela do gráfico deixou de ser "sempre os 30 dias até hoje": um mês
 * PASSADO precisa mostrar os dias DELE. A regra: o fim é `min(to, hoje)`;
 * com 30 dias ou mais até lá, a série é o próprio período; com menos, são os
 * 30 dias terminando nesse fim — que é exatamente o comportamento antigo no
 * recorte atual.
 */
describe('chartBounds — período atual, passado e longo', () => {
  const hoje = '2026-09-05';

  it('mês passado mostra os próprios dias', () => {
    expect(chartBounds({ from: '2026-08-01', to: '2026-08-31' }, hoje)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('fevereiro (28 dias) completa 30 terminando no fim dele', () => {
    expect(chartBounds({ from: '2026-02-01', to: '2026-02-28' }, hoje)).toEqual({ from: '2026-01-30', to: '2026-02-28' });
  });

  it('semana ou dia passados: 30 dias terminando no fim do recorte', () => {
    expect(chartBounds({ from: '2026-06-01', to: '2026-06-07' }, hoje)).toEqual({ from: '2026-05-09', to: '2026-06-07' });
  });

  it('período longo é a série inteira; o ano corrente para em hoje', () => {
    expect(chartBounds({ from: '2025-09-06', to: '2026-09-05' }, hoje)).toEqual({ from: '2025-09-06', to: hoje });
    expect(chartBounds(rangeBounds('year', hoje), hoje)).toEqual({ from: '2026-01-01', to: hoje });
    // Ano corrente em janeiro ainda não tem 30 dias: volta pro comportamento curto.
    expect(chartBounds(rangeBounds('year', '2026-01-10'), '2026-01-10')).toEqual({ from: '2025-12-12', to: '2026-01-10' });
  });
});

describe('resolvePeriod — a validação da query', () => {
  const hoje = '2026-09-05';

  it('sem nada é o dia de hoje — o comportamento antigo de `?range=day`', () => {
    expect(resolvePeriod({}, hoje)).toEqual({
      ok: true,
      period: { range: 'day', anchor: hoje, from: hoje, to: hoje },
    });
    expect(resolvePeriod({ range: 'month' }, hoje)).toEqual({
      ok: true,
      period: { range: 'month', anchor: hoje, from: '2026-09-01', to: '2026-09-30' },
    });
  });

  it('anchor escolhe o período que a contém; string vazia é ausência', () => {
    expect(resolvePeriod({ range: 'year', anchor: '2021-06-01' }, hoje)).toEqual({
      ok: true,
      period: { range: 'year', anchor: '2021-06-01', from: '2021-01-01', to: '2021-12-31' },
    });
    const vazio = resolvePeriod({ range: 'week', anchor: '  ' }, hoje);
    expect(vazio.ok && vazio.period.anchor).toBe(hoje);
  });

  it('recusa range desconhecido', () => {
    const r = resolvePeriod({ range: 'decada' }, hoje);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('invalid-range');
  });

  it('anchor inválida, antes do mínimo, no futuro, repetida ou com custom é invalid-anchor', () => {
    for (const query of [
      { range: 'month', anchor: '2026-02-30' },
      { range: 'month', anchor: 'ontem' },
      { range: 'month', anchor: shiftDay(MIN_USAGE_DAY, -1) },
      { range: 'day', anchor: '2026-09-06' },
      { range: 'day', anchor: ['2026-09-01', '2026-09-02'] },
      { range: 'custom', anchor: '2026-09-01', from: '2026-09-01', to: '2026-09-02' },
    ]) {
      const r = resolvePeriod(query, hoje);
      expect(r.ok, JSON.stringify(query)).toBe(false);
      expect(!r.ok && r.code, JSON.stringify(query)).toBe('invalid-anchor');
    }
    // O próprio mínimo e o próprio hoje valem.
    expect(resolvePeriod({ range: 'day', anchor: MIN_USAGE_DAY }, hoje).ok).toBe(true);
    expect(resolvePeriod({ range: 'day', anchor: hoje }, hoje).ok).toBe(true);
  });

  it('custom válido; `to` no futuro é preso em hoje', () => {
    expect(resolvePeriod({ range: 'custom', from: '2026-08-01', to: '2026-08-15' }, hoje)).toEqual({
      ok: true,
      period: { range: 'custom', from: '2026-08-01', to: '2026-08-15' },
    });
    expect(resolvePeriod({ range: 'custom', from: '2026-08-01', to: '2026-12-31' }, hoje)).toEqual({
      ok: true,
      period: { range: 'custom', from: '2026-08-01', to: hoje },
    });
  });

  it('custom com teto de MAX_USAGE_RANGE_DAYS dias', () => {
    expect(MAX_USAGE_RANGE_DAYS).toBe(366);
    const cheio = resolvePeriod({ range: 'custom', from: shiftDay(hoje, -(MAX_USAGE_RANGE_DAYS - 1)), to: hoje }, hoje);
    expect(cheio.ok).toBe(true);
    const longo = resolvePeriod({ range: 'custom', from: shiftDay(hoje, -MAX_USAGE_RANGE_DAYS), to: hoje }, hoje);
    expect(!longo.ok && longo.code).toBe('invalid-period');
  });

  it('custom incompleto, inválido, invertido, antes do mínimo ou começando no futuro é invalid-period', () => {
    for (const query of [
      { range: 'custom' },
      { range: 'custom', from: '2026-08-01' },
      { range: 'custom', from: '2026-08-01', to: '2026-02-30' },
      { range: 'custom', from: '2026-08-10', to: '2026-08-01' },
      { range: 'custom', from: shiftDay(MIN_USAGE_DAY, -1), to: '2020-02-01' },
      { range: 'custom', from: '2026-09-06', to: '2026-09-10' },
      // from/to num recorte ancorado: aceitar calado faria parecer que filtrou.
      { range: 'month', from: '2026-08-01', to: '2026-08-02' },
    ]) {
      const r = resolvePeriod(query, hoje);
      expect(r.ok, JSON.stringify(query)).toBe(false);
      expect(!r.ok && r.code, JSON.stringify(query)).toBe('invalid-period');
    }
  });
});

describe('summarize', () => {
  const chart = { from: '2026-09-01', to: '2026-09-03' };

  it('soma totais, dias, modelos e projetos numa passada', () => {
    const rows = [
      row({ day: '2026-09-01', input: 100, output: 10, messages: 2 }),
      row({ day: '2026-09-02', input: 200, output: 20, project: 'C:\\projetos\\b' }),
      row({ day: '2026-09-02', input: 50, model: 'claude-haiku-4-5' }),
    ];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });

    expect(s.totals.input).toBe(350);
    expect(s.totals.output).toBe(30);
    expect(s.totals.tokens).toBe(380);
    expect(s.totals.messages).toBe(4);

    // Dia sem consumo entra ZERADO: buraco na série viraria um gráfico que
    // mente sobre o eixo do tempo.
    expect(s.byDay.map((d) => d.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(s.byDay[2]?.tokens).toBe(0);

    expect(s.byModel.map((m) => m.model)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);
    expect(s.byProject.map((p) => p.project)).toEqual(['C:\\projetos\\b', 'C:\\projetos\\a']);
  });

  /**
   * O caso que a tabela embutida NÃO cobre — e não pode cobrir por chute. O
   * consumo continua contando em tokens; o que fica `null` é o custo, com o
   * aviso nomeando o modelo.
   */
  it('modelo sem preço: tokens contam, custo fica null e sai aviso', () => {
    const rows = [row({ day: '2026-09-01', input: 1_000_000, model: 'modelo-que-nao-existe' })];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });

    expect(s.totals.tokens).toBe(1_000_000);
    expect(s.totals.cost).toBeNull();
    expect(s.byModel[0]?.unpriced).toBe(true);
    expect(s.pricingWarnings).toHaveLength(1);
    expect(s.pricingWarnings[0]).toContain('modelo-que-nao-existe');
  });

  /**
   * `costPartial` é o que separa "custou pouco" de "metade do consumo não tem
   * preço". Sem ele, um total baixo pareceria uma boa notícia.
   */
  it('mistura de modelo com e sem preço soma o que dá e marca costPartial', () => {
    const rows = [
      row({ day: '2026-09-01', input: 1_000_000, model: 'claude-sonnet-4-5' }),
      row({ day: '2026-09-01', input: 1_000_000, model: 'modelo-sem-preco' }),
    ];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });

    expect(s.totals.cost).toBeCloseTo(3, 6);
    expect(s.totals.costPartial).toBe(true);
  });

  it('custo usa os quatro tipos de token, cada um com o seu preço', () => {
    const pricing: PricingTable = {
      'modelo-x': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    };
    const rows = [
      row({
        day: '2026-09-01',
        model: 'modelo-x',
        input: 1_000_000,
        output: 1_000_000,
        cacheWrite: 1_000_000,
        cacheRead: 1_000_000,
      }),
    ];
    const s = summarize({ rows, chartRows: rows, chart, pricing, lang: 'pt-BR' });
    expect(s.totals.cost).toBeCloseTo(3 + 15 + 3.75 + 0.3, 6);
    expect(s.totals.costPartial).toBe(false);
  });

  /**
   * O id com sufixo de data (`-20251001`) é o mesmo modelo da tabela: uma
   * entrada por data de release seria uma tabela que envelhece sozinha.
   */
  it('id com sufixo de data cai na entrada da família', () => {
    const rows = [row({ day: '2026-09-01', model: 'claude-haiku-4-5-20251001', input: 1_000_000 })];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });
    expect(s.totals.cost).toBeCloseTo(1, 6);
    expect(s.pricingWarnings).toEqual([]);
  });

  it('recorte vazio: totais zerados, custo zero e nenhum aviso', () => {
    const s = summarize({ rows: [], chartRows: [], chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });
    expect(s.totals.tokens).toBe(0);
    expect(s.totals.cost).toBeNull();
    expect(s.byModel).toEqual([]);
    expect(s.pricingWarnings).toEqual([]);
  });
});

describe('bySource', () => {
  const chart = { from: '2026-09-01', to: '2026-09-03' };

  /**
   * Os subagentes SEMPRE entram nos `totals`: a separação existe pra o painel
   * poder dizer "inclui subagentes", não pra esconder metade do consumo.
   */
  it('separa conversa principal de subagentes sem tirar nada do total', () => {
    const rows = [
      row({ day: '2026-09-01', input: 100, source: 'main' }),
      row({ day: '2026-09-01', input: 900, source: 'subagents' }),
      row({ day: '2026-09-02', input: 50, source: 'subagents', project: 'C:\projetos\b' }),
    ];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });

    expect(s.totals.input).toBe(1050);
    expect(s.bySource.main.input).toBe(100);
    expect(s.bySource.subagents.input).toBe(950);
    expect(s.bySource.main.messages + s.bySource.subagents.messages).toBe(s.totals.messages);
  });

  it('sem subagente nenhum, o lado deles fica zerado com custo null', () => {
    const rows = [row({ day: '2026-09-01', input: 10, source: 'main' })];
    const s = summarize({ rows, chartRows: rows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });
    expect(s.bySource.subagents.tokens).toBe(0);
    expect(s.bySource.subagents.cost).toBeNull();
  });
});

/**
 * A série do gráfico é MAIS LARGA que o recorte em `week`/`month`. Um modelo
 * sem preço que só aparece nos dias de fora não pode gerar um aviso sobre um
 * recorte em que ele não está — a pessoa procuraria o modelo na tabela e não o
 * acharia em lugar nenhum.
 */
describe('pricingWarnings ficam no recorte', () => {
  it('modelo sem preço só na série do gráfico não vira aviso', () => {
    const chart = { from: '2026-08-01', to: '2026-09-03' };
    const rows = [row({ day: '2026-09-01', input: 10, model: 'claude-sonnet-4-5' })];
    const chartRows = [...rows, row({ day: '2026-08-05', input: 10, model: 'modelo-de-fora' })];
    const s = summarize({ rows, chartRows, chart, pricing: EMBEDDED_PRICING, lang: 'pt-BR' });

    expect(s.pricingWarnings).toEqual([]);
    // O dia de fora continua no gráfico, com os tokens dele.
    expect(s.byDay.find((d) => d.day === '2026-08-05')?.tokens).toBe(10);
  });
});
