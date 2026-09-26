/**
 * O monitor de uso de ponta a ponta (ADR-012): transcript no disco →
 * varredura → banco → `GET /api/usage`, mais os limites, o rescan e a tabela
 * de preços.
 *
 * A raiz dos transcripts é SEMPRE uma pasta temporária passada por
 * `claudeHome`: nenhum teste lê o `~/.claude` de quem roda a suíte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { UsageReport } from '../src/model.js';

const AUTH = { authorization: 'Bearer T' };
const SP = 'America/Sao_Paulo';
const tmp = (): string => tmpDir('bridge-uso-api-');

let core: Core | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
});

interface LinhaOpts {
  id: string;
  req?: string;
  at: string;
  model?: string;
  cwd?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

function linha(o: LinhaOpts): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: o.req ?? `req_${o.id}`,
    timestamp: o.at,
    cwd: o.cwd ?? 'C:\\projetos\\a',
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-4-5',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
      },
    },
  });
}

function escreve(home: string, projeto: string, arquivo: string, linhas: string[]): string {
  const dir = join(home, 'projects', projeto);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, arquivo);
  writeFileSync(path, `${linhas.join('\n')}\n`, 'utf8');
  return path;
}

/**
 * Um core com a raiz de transcripts apontada pra `home` e a varredura inicial
 * já concluída — sem esperar por ela, o `GET /api/usage` responderia com o
 * banco ainda vazio.
 */
async function coreCom(home: string, config: Record<string, unknown> = {}): Promise<Core> {
  const profileDir = tmp();
  if (Object.keys(config).length > 0) {
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify(config), 'utf8');
  }
  const created = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
  await created.deps.usagePoller?.initialScan;
  return created;
}

/** Espera uma condição virar verdadeira (o evento atrasado do BU-14). */
async function esperaAte(cond: () => boolean, timeoutMs: number): Promise<void> {
  const ate = Date.now() + timeoutMs;
  while (!cond() && Date.now() < ate) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function relatorio(c: Core, query: string): Promise<UsageReport> {
  const res = await c.app.inject({ method: 'GET', url: `/api/usage${query}`, headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json() as UsageReport;
}

describe('GET /api/usage', () => {
  /**
   * Três projetos × dois modelos, com dias que cruzam a meia-noite local, a
   * virada de semana e a virada de mês. O `tz` fixo é o que torna isso
   * determinístico em qualquer máquina.
   */
  it('agrega dia/semana/mês por dia local, com byModel e byProject', async () => {
    const home = tmp();
    escreve(home, 'proj-a', 's1.jsonl', [
      // 2026-09-05T01:30Z = 04/09 22h30 em São Paulo — dia local ANTERIOR.
      linha({ id: 'm1', at: '2026-09-05T01:30:00.000Z', input: 1000, output: 100 }),
      // 2026-09-05T03:30Z = 05/09 00h30 em São Paulo — já é o dia seguinte.
      linha({ id: 'm2', at: '2026-09-05T03:30:00.000Z', input: 2000, output: 200 }),
    ]);
    escreve(home, 'proj-b', 's2.jsonl', [
      linha({ id: 'm3', at: '2026-09-05T15:00:00.000Z', cwd: 'C:\\projetos\\b', model: 'claude-haiku-4-5', input: 500 }),
      // Domingo 30/08 (local): fora da semana de 31/08 a 06/09, dentro do mês.
      linha({ id: 'm4', at: '2026-08-30T15:00:00.000Z', cwd: 'C:\\projetos\\b', input: 40 }),
    ]);
    escreve(home, 'proj-c', 's3.jsonl', [
      // 31/07 local — fora do mês de setembro E fora da série de 30 dias.
      linha({ id: 'm5', at: '2026-07-31T15:00:00.000Z', cwd: 'C:\\projetos\\c', input: 7 }),
    ]);
    core = await coreCom(home);

    // "Hoje" é 05/09 em São Paulo. O `now` da rota é o relógio real, então o
    // recorte é cobrado por leitura direta do serviço, com o `now` fixo.
    const dia = core.deps.usage.report('day', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(dia.from).toBe('2026-09-05');
    expect(dia.to).toBe('2026-09-05');
    expect(dia.totals.input).toBe(2500);
    expect(dia.totals.messages).toBe(2);
    // A série é sempre 30 dias até hoje, mesmo no recorte de um dia só.
    expect(dia.byDay).toHaveLength(30);
    expect(dia.chartFrom).toBe('2026-08-07');
    expect(dia.chartTo).toBe('2026-09-05');

    const semana = core.deps.usage.report('week', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(semana.from).toBe('2026-08-31');
    expect(semana.to).toBe('2026-09-06');
    // 04/09 (1000) + 05/09 (2000 + 500). O domingo 30/08 ficou de fora.
    expect(semana.totals.input).toBe(3500);
    expect(semana.byDay).toHaveLength(30);
    expect(semana.chartTo).toBe('2026-09-05');

    const mes = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(mes.from).toBe('2026-09-01');
    expect(mes.to).toBe('2026-09-30');
    // O recorte vai até o fim do mês CIVIL; a série para em hoje, sem cauda
    // de dias futuros zerados.
    expect(mes.chartTo).toBe('2026-09-05');
    expect(mes.byDay.at(-1)?.day).toBe('2026-09-05');
    expect(mes.totals.input).toBe(3500);
    expect(mes.byProject.map((p) => p.project)).toEqual(['C:\\projetos\\a', 'C:\\projetos\\b']);
    expect(mes.byModel.map((m) => m.model)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);

    // O de julho existe no banco, só não em nenhum destes recortes.
    const julho = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-07-31T15:00:00.000Z') });
    expect(julho.totals.input).toBe(7);
  });

  it('a rota aceita range e tz e recusa lixo com 400', async () => {
    core = await coreCom(tmp());

    const ok = await relatorio(core, `?range=week&tz=${encodeURIComponent(SP)}`);
    expect(ok.range).toBe('week');
    expect(ok.tz).toBe(SP);

    const semRange = await relatorio(core, '');
    expect(semRange.range).toBe('day');

    const rangeRuim = await core.app.inject({ method: 'GET', url: '/api/usage?range=decada', headers: AUTH });
    expect(rangeRuim.statusCode).toBe(400);
    expect(rangeRuim.json().code).toBe('invalid-range');

    const tzRuim = await core.app.inject({ method: 'GET', url: '/api/usage?tz=Marte/Olympus', headers: AUTH });
    expect(tzRuim.statusCode).toBe(400);
    expect(tzRuim.json().code).toBe('invalid-tz');
  });

  /**
   * Outros períodos: o mês PASSADO, o ano e o intervalo livre. O `now` é fixo
   * pela leitura direta do serviço — a rota usa o relógio real e é cobrada no
   * teste de baixo só com datas que não dependem de "hoje".
   */
  it('anchor e custom: o período pedido, com a série do próprio período', async () => {
    const home = tmp();
    escreve(home, 'proj-a', 's1.jsonl', [
      linha({ id: 'a1', at: '2026-08-10T15:00:00.000Z', input: 40 }),
      linha({ id: 'a2', at: '2026-09-04T15:00:00.000Z', input: 1000 }),
      linha({ id: 'a3', at: '2025-12-31T15:00:00.000Z', input: 7 }),
    ]);
    core = await coreCom(home);
    const now = Date.parse('2026-09-05T15:00:00.000Z');

    const agosto = core.deps.usage.report({ range: 'month', anchor: '2026-08-15' }, { tz: SP, now });
    expect(agosto).toMatchObject({
      range: 'month',
      anchor: '2026-08-15',
      today: '2026-09-05',
      from: '2026-08-01',
      to: '2026-08-31',
      chartFrom: '2026-08-01',
      chartTo: '2026-08-31',
    });
    expect(agosto.byDay).toHaveLength(31);
    expect(agosto.totals.input).toBe(40);

    // O mês atual sem anchor continua igual a antes: 30 dias até hoje.
    const atual = core.deps.usage.report('month', { tz: SP, now });
    expect(atual.anchor).toBe('2026-09-05');
    expect(atual.chartFrom).toBe('2026-08-07');
    expect(atual.byDay).toHaveLength(30);

    const ano = core.deps.usage.report({ range: 'year', anchor: '2025-03-01' }, { tz: SP, now });
    expect(ano).toMatchObject({ from: '2025-01-01', to: '2025-12-31', chartFrom: '2025-01-01', chartTo: '2025-12-31' });
    expect(ano.byDay).toHaveLength(365);
    expect(ano.totals.input).toBe(7);

    // Ano corrente: o recorte vai a 31/12, a série para em hoje.
    const anoAtual = core.deps.usage.report('year', { tz: SP, now });
    expect(anoAtual.chartFrom).toBe('2026-01-01');
    expect(anoAtual.chartTo).toBe('2026-09-05');
    expect(anoAtual.byDay).toHaveLength(248);
    expect(anoAtual.totals.input).toBe(1040);

    // `to` no futuro é preso em hoje; 27 dias ainda desenham os 30 até hoje.
    const livre = core.deps.usage.report({ range: 'custom', from: '2026-08-10', to: '2026-12-31' }, { tz: SP, now });
    expect(livre).toMatchObject({ range: 'custom', from: '2026-08-10', to: '2026-09-05', chartFrom: '2026-08-07' });
    expect(livre).not.toHaveProperty('anchor');
    expect(livre.totals.input).toBe(1040);

    expect(() => core?.deps.usage.report({ range: 'custom' }, { tz: SP, now })).toThrow(/invalid-period/);
  });

  it('a rota aceita anchor e custom, e recusa período ruim com 400', async () => {
    core = await coreCom(tmp());

    const ano = await relatorio(core, `?range=year&anchor=2021-06-01&tz=${encodeURIComponent(SP)}`);
    expect(ano).toMatchObject({
      range: 'year',
      anchor: '2021-06-01',
      from: '2021-01-01',
      to: '2021-12-31',
      chartFrom: '2021-01-01',
      chartTo: '2021-12-31',
    });
    expect(ano.byDay).toHaveLength(365);

    const livre = await relatorio(core, '?range=custom&from=2021-02-01&to=2021-02-10');
    expect(livre).toMatchObject({ range: 'custom', from: '2021-02-01', to: '2021-02-10', chartFrom: '2021-01-12', chartTo: '2021-02-10' });

    // Compatibilidade: `?range=day` sozinho é o dia de hoje, como sempre foi.
    const dia = await relatorio(core, '?range=day');
    expect(dia.from).toBe(dia.to);
    expect(dia.anchor).toBe(dia.from);
    expect(dia.today).toBe(dia.from);
    expect(dia.chartTo).toBe(dia.from);
    expect(dia.byDay).toHaveLength(30);

    for (const [query, code] of [
      ['range=month&anchor=2021-02-30', 'invalid-anchor'],
      ['range=month&anchor=2999-01-01', 'invalid-anchor'],
      ['range=month&anchor=2019-12-31', 'invalid-anchor'],
      ['range=month&anchor=2021-01-01&anchor=2021-02-01', 'invalid-anchor'],
      ['range=custom&anchor=2021-01-01&from=2021-01-01&to=2021-01-02', 'invalid-anchor'],
      ['range=custom&from=2021-01-01', 'invalid-period'],
      ['range=custom&from=2021-01-10&to=2021-01-01', 'invalid-period'],
      ['range=custom&from=2021-01-01&to=2022-01-02', 'invalid-period'],
      ['range=custom&from=2999-01-01&to=2999-01-02', 'invalid-period'],
      ['range=custom&from=2019-12-31&to=2020-01-02', 'invalid-period'],
      ['range=month&from=2021-01-01&to=2021-01-02', 'invalid-period'],
      ['range=decada', 'invalid-range'],
    ] as const) {
      const res = await core.app.inject({ method: 'GET', url: `/api/usage?${query}`, headers: AUTH });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().code, query).toBe(code);
      expect(typeof res.json().error, query).toBe('string');
      expect((res.json().error as string).length, query).toBeGreaterThan(0);
    }
  });

  /**
   * Estado vazio: o painel precisa dizer ONDE procurou, senão "nenhum
   * transcript encontrado" não ajuda ninguém a consertar.
   */
  it('sem transcript nenhum: totais zerados e o caminho onde o Bridge procurou', async () => {
    const home = join(tmp(), 'sem-nada');
    core = await coreCom(home);

    const r = await relatorio(core, '');
    expect(r.totals.tokens).toBe(0);
    expect(r.scannedFiles).toBe(0);
    expect(r.claudeHome).toBe(home);
    expect(r.limits).toEqual([]);
  });
});

describe('preços', () => {
  it('modelo sem preço: tokens contam, custo null e aviso nomeando o modelo', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', model: 'claude-inventado-9', input: 1_000_000 }),
    ]);
    core = await coreCom(home);

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.tokens).toBe(1_000_000);
    expect(r.totals.cost).toBeNull();
    expect(r.pricingWarnings.some((w) => w.includes('claude-inventado-9'))).toBe(true);
    expect(r.byModel[0]?.unpriced).toBe(true);
  });

  it('usage.pricing do config.json completa a tabela embutida', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', model: 'claude-inventado-9', input: 1_000_000 }),
    ]);
    core = await coreCom(home, {
      usage: { pricing: { 'claude-inventado-9': { input: 2, output: 8, cacheWrite: 2.5, cacheRead: 0.2 } } },
    });

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.cost).toBeCloseTo(2, 6);
    expect(r.pricingWarnings).toEqual([]);
  });

  /**
   * Arquivo de preços quebrado não pode derrubar o monitor: ele vira aviso e
   * a tabela embutida continua valendo. Um app que não abre porque alguém
   * digitou uma vírgula a mais num JSON opcional seria pior que o custo
   * faltando.
   */
  it('pricingFile inválido vira aviso, e a tabela embutida continua valendo', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', model: 'claude-sonnet-4-5', input: 1_000_000 }),
    ]);
    const pricingFile = join(tmp(), 'precos.json');
    writeFileSync(pricingFile, '{ isto não é json', 'utf8');
    core = await coreCom(home, { usage: { pricingFile } });

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.pricingWarnings.some((w) => w.includes('pricingFile'))).toBe(true);
    expect(r.totals.cost).toBeCloseTo(3, 6);
  });

  it('entrada malformada dentro do pricingFile é descartada sozinha, com aviso', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', model: 'modelo-x', input: 1_000_000 }),
    ]);
    const pricingFile = join(tmp(), 'precos.json');
    writeFileSync(
      pricingFile,
      JSON.stringify({
        'modelo-x': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
        'modelo-y': { input: 'de graça' },
      }),
      'utf8',
    );
    core = await coreCom(home, { usage: { pricingFile } });

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.cost).toBeCloseTo(1, 6);
    // BU-03: o aviso diz QUANTAS entradas caíram, nunca QUAIS — a lista de
    // chaves de um `.json` apontado por `pricingFile` era um oráculo de
    // leitura. O `modelo-x` válido continua valendo (o custo acima prova).
    expect(r.pricingWarnings.some((w) => w.includes('1 entrada ignorada'))).toBe(true);
    expect(r.pricingWarnings.join(' ')).not.toContain('modelo-y');
  });
});

describe('varredura incremental e rescan', () => {
  /** Arquivo que cresce entre passadas: a segunda soma só o pedaço novo. */
  it('transcript que cresce é somado uma vez só', async () => {
    const home = tmp();
    const path = escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = await coreCom(home);
    const antes = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(antes.totals.input).toBe(100);

    writeFileSync(
      path,
      `${linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })}\n${linha({ id: 'm2', at: '2026-09-05T16:00:00.000Z', input: 50 })}\n`,
      'utf8',
    );
    const result = await core.deps.usagePoller!.refresh();
    expect(result).toEqual(['2026-09-05']);

    const depois = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(depois.totals.input).toBe(150);
  });

  /** Passada sem novidade não mexe em nada — nem em número, nem em evento. */
  it('passada sem arquivo novo não muda os totais', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = await coreCom(home);

    expect(await core.deps.usagePoller!.refresh()).toEqual([]);
    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.input).toBe(100);
  });

  /**
   * O rescan ZERA antes de varrer: a varredura normal soma deltas, e reler sem
   * zerar dobraria o histórico.
   */
  it('POST /api/usage/rescan relê tudo sem dobrar os números', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = await coreCom(home);

    const res = await core.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ files: 1, entries: 1 });

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.input).toBe(100);
  });

  it('o rescan aplica a tabela de preços que estiver valendo agora', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', model: 'modelo-novo', input: 1_000_000 }),
    ]);
    core = await coreCom(home);
    expect(core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') }).totals.cost).toBeNull();

    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { pricing: { 'modelo-novo': { input: 4, output: 4, cacheWrite: 4, cacheRead: 4 } } } },
    });
    await core.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH });

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.cost).toBeCloseTo(4, 6);
    expect(r.pricingWarnings).toEqual([]);
  });
});

/**
 * O defeito CRÍTICO da primeira versão: `scan()` e `rescan()` liam os mesmos
 * bytes ao mesmo tempo e o upsert que SOMA transformava isso em consumo
 * inflado (a revisão mediu 1,67× no rescan clicado duas vezes). Agora as duas
 * compartilham um guarda só.
 */
describe('varreduras concorrentes não dobram a contagem', () => {
  function totalDe(c: Core): number {
    return c.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') }).totals.input;
  }

  it('rescan + scan ao mesmo tempo dão o mesmo total de uma passada só', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 }),
      linha({ id: 'm2', at: '2026-09-05T16:00:00.000Z', input: 50 }),
    ]);
    core = await coreCom(home);
    const referencia = totalDe(core);
    expect(referencia).toBe(150);

    await Promise.all([core.deps.usage.rescan(), core.deps.usage.scan()]);
    expect(totalDe(core)).toBe(referencia);
  });

  it('dois rescans ao mesmo tempo (o duplo clique no botão) idem', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = await coreCom(home);

    await Promise.all([core.deps.usage.rescan(), core.deps.usage.rescan()]);
    expect(totalDe(core)).toBe(100);
  });

  it('duas rotas de rescan em voo ao mesmo tempo idem', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = await coreCom(home);
    const c = core;

    await Promise.all([
      c.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH }),
      c.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH }),
    ]);
    expect(totalDe(c)).toBe(100);
  });

  it('scan chamado duas vezes em paralelo devolve a MESMA passada', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
    await core.deps.usagePoller?.initialScan;

    const [a, b] = await Promise.all([core.deps.usage.scan(), core.deps.usage.scan()]);
    expect(a).toBe(b);
    expect(totalDe(core)).toBe(100);
  });
});

/**
 * Na árvore real os subagentes vivem em `<sessão>/subagents/**` e respondem
 * pela maior parte do consumo. Eles contam nos totais, e a divisão aparece em
 * `bySource` pra o painel poder dizer "inclui subagentes".
 */
describe('subagentes', () => {
  it('contam nos totais e aparecem separados em bySource', async () => {
    const home = tmp();
    escreve(home, 'proj-a', 's1.jsonl', [linha({ id: 'm1', at: '2026-09-05T15:00:00.000Z', input: 100 })]);
    const fundo = join(home, 'projects', 'proj-a', 'sessao-1', 'subagents', 'workflows', 'wf_1');
    mkdirSync(fundo, { recursive: true });
    writeFileSync(
      join(fundo, 'sub.jsonl'),
      `${linha({ id: 'm2', at: '2026-09-05T15:10:00.000Z', input: 900, cwd: 'C:\\projetos\\b' })}\n`,
      'utf8',
    );
    core = await coreCom(home);

    const r = core.deps.usage.report('month', { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') });
    expect(r.totals.input).toBe(1000);
    expect(r.bySource.main.input).toBe(100);
    expect(r.bySource.subagents.input).toBe(900);
    // O PROJETO é o `cwd` de cada linha, não a pasta onde o arquivo está: um
    // subagente pode rodar noutra pasta que a sessão que o lançou.
    expect(r.byProject.map((p) => p.project)).toEqual(['C:\\projetos\\b', 'C:\\projetos\\a']);
  });
});

describe('janelas de limite', () => {
  const payload = (rateLimits?: Record<string, unknown>): Record<string, unknown> => ({
    model: { display_name: 'X' },
    context_window: { total_input_tokens: 1000 },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  });

  async function sessaoDe(c: Core): Promise<string> {
    const cwd = tmp();
    const { workspace, pane } = c.deps.layout.createWorkspace({ cwd });
    return c.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd }).id;
  }

  /**
   * A conta deixou de informar limites (assinatura → chave de API). Guardar a
   * última foto faria a faixa mostrar para sempre um percentual congelado que
   * já não descreve nada.
   *
   * Mas a limpeza tem CARÊNCIA de dez minutos (Task 3): com uma sessão de
   * assinatura e outra de chave de API abertas ao mesmo tempo, o payload sem
   * `rate_limits` da segunda chegaria entre dois da primeira e a faixa
   * piscaria. Aqui a limpeza é cobrada com o relógio injetado — a carência já
   * vencida.
   */
  it('payload SEM rate_limits limpa as janelas e emite usage.changed com lista vazia', async () => {
    core = await coreCom(tmp());
    const c = core;
    const sessionId = await sessaoDe(c);

    await c.app.inject({
      method: 'POST',
      url: `/hooks/${sessionId}/StatusLine?token=T`,
      payload: payload({ five_hour: { used_percentage: 23 } }),
    });
    expect((await c.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH })).json().limits).toHaveLength(1);

    const eventos: unknown[] = [];
    c.deps.bus.on((e) => {
      if (e.type === 'usage.changed') eventos.push(e);
    });

    // Dentro da carência: NADA acontece — é o caso das duas contas lado a lado.
    await c.app.inject({ method: 'POST', url: `/hooks/${sessionId}/StatusLine?token=T`, payload: payload() });
    expect(eventos).toEqual([]);
    expect((await c.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH })).json().limits).toHaveLength(1);

    // O outro lado (passada a carência, apaga uma vez só) é cobrado no
    // `usage-progress.test.ts`, com o relógio injetado — adiantar o relógio
    // com o servidor no ar congelaria o loop do Fastify junto.
  });

  /**
   * O outro lado do mesmo problema: a lista continua NÃO VAZIA, mas uma janela
   * sumiu dela. Sem apagar as ausentes, a janela que saiu fossilizava no banco
   * e `GET /api/usage/limits` devolvia para sempre um percentual e um reset de
   * uma janela que a conta já não tem.
   */
  it('janela que some de um payload não vazio é apagada, não fossiliza', async () => {
    core = await coreCom(tmp());
    const c = core;
    const sessionId = await sessaoDe(c);

    await c.app.inject({
      method: 'POST',
      url: `/hooks/${sessionId}/StatusLine?token=T`,
      payload: payload({ five_hour: { used_percentage: 30 }, seven_day: { used_percentage: 80 } }),
    });
    expect(
      ((await c.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH })).json().limits as { window: string }[]).map(
        (l) => l.window,
      ),
    ).toEqual(['five_hour', 'seven_day']);

    const eventos: { limits?: { window: string }[] }[] = [];
    c.deps.bus.on((e) => {
      if (e.type === 'usage.changed' && e.limits) eventos.push(e);
    });

    // A carência NÃO vale aqui: a lista veio com janela, então é uma foto nova
    // e completa da conta — vale na hora.
    await c.app.inject({
      method: 'POST',
      url: `/hooks/${sessionId}/StatusLine?token=T`,
      payload: payload({ five_hour: { used_percentage: 31 } }),
    });

    // BU-14: o `usage.changed { limits }` ganhou o mesmo teto de 1 evento/s do
    // progresso, com a ÚLTIMA foto sempre entregue. Como a foto anterior saiu
    // no primeiro `POST` deste teste, esta cai na janela de espera e chega com
    // atraso — por isso o `esperaAte` em vez da leitura imediata. O que se
    // cobra continua sendo o mesmo: UM evento, com a janela que sobrou.
    await esperaAte(() => eventos.length > 0, 3000);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.limits?.map((l) => l.window)).toEqual(['five_hour']);
    const limits = (await c.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH })).json().limits as {
      window: string;
      usedPct: number;
    }[];
    expect(limits.map((l) => l.window)).toEqual(['five_hour']);
    expect(limits[0]?.usedPct).toBe(31);
    // E o relatório inteiro vê a mesma lista.
    expect(c.deps.usage.report('day').limits.map((l) => l.window)).toEqual(['five_hour']);
  });

  it('percentual fora da faixa é preso antes de chegar ao banco', async () => {
    core = await coreCom(tmp());
    const c = core;
    const sessionId = await sessaoDe(c);

    await c.app.inject({
      method: 'POST',
      url: `/hooks/${sessionId}/StatusLine?token=T`,
      payload: payload({ five_hour: { used_percentage: 120 }, seven_day: { used_percentage: -5 } }),
    });

    const limits = (await c.app.inject({ method: 'GET', url: '/api/usage/limits', headers: AUTH })).json()
      .limits as { window: string; usedPct: number }[];
    expect(limits.map((l) => l.usedPct)).toEqual([100, 0]);
  });
});

describe('pricingAsOf', () => {
  it('a resposta diz de quando é a tabela de preços', async () => {
    core = await coreCom(tmp());
    const r = await relatorio(core, '');
    expect(r.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('override local marca a data como parcial', async () => {
    core = await coreCom(tmp(), {
      usage: { pricing: { 'modelo-x': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } },
    });
    const r = await relatorio(core, '');
    expect(r.pricingAsOf).toContain('com ajustes locais');
  });
});

/**
 * Transcript REESCRITO por fora (truncado, copiado por cima). Não dá pra
 * desfazer a contribuição dele — `usage_daily` é agregada por dia × modelo ×
 * projeto × origem, não por arquivo —, então a saída correta e barata é
 * reconstruir tudo, no máximo uma vez por hora.
 */
describe('transcript reescrito por fora', () => {
  it('a impressão digital dispara a reconstrução, e o total fica certo', async () => {
    const home = tmp();
    // Precisa passar de FINGERPRINT_BYTES pra ter impressão digital.
    const originais = Array.from({ length: 8 }, (_, i) =>
      linha({ id: `m${i}`, at: '2026-09-05T15:00:00.000Z', input: 10 }),
    );
    const path = escreve(home, 'p', 's.jsonl', originais);
    core = await coreCom(home);
    const hoje = { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') };
    expect(core.deps.usage.report('month', hoje).totals.input).toBe(80);

    // Reescreve com QUATRO linhas novas na frente. O começo do arquivo muda,
    // que é o sinal de reescrita; o total correto passa a ser 4000 + 80.
    const novas = Array.from({ length: 4 }, (_, i) =>
      linha({ id: `n${i}`, at: '2026-09-05T16:00:00.000Z', input: 1000 }),
    );
    writeFileSync(path, `${[...novas, ...originais].join('\n')}\n`, 'utf8');
    await core.deps.usagePoller!.refresh();

    // Sem a detecção, a passada incremental leria do offset antigo e recontaria
    // a cauda: daria 120, não 4080.
    expect(core.deps.usage.report('month', hoje).totals.input).toBe(4080);
  });

  /**
   * Uma reescrita por hora, no máximo: um arquivo que alguém fica regravando
   * não pode fazer o core reler o histórico inteiro a cada minuto.
   */
  it('a segunda reescrita dentro da janela não dispara outra reconstrução', async () => {
    const home = tmp();
    const originais = Array.from({ length: 8 }, (_, i) =>
      linha({ id: `m${i}`, at: '2026-09-05T15:00:00.000Z', input: 10 }),
    );
    const path = escreve(home, 'p', 's.jsonl', originais);
    core = await coreCom(home);
    const hoje = { tz: SP, now: Date.parse('2026-09-05T15:00:00.000Z') };

    writeFileSync(path, `${[...originais].reverse().join('\n')}\n`, 'utf8');
    await core.deps.usagePoller!.refresh();
    const depoisDaPrimeira = core.deps.usage.report('month', hoje).totals.input;

    writeFileSync(path, `${originais.join('\n')}\n`, 'utf8');
    const segunda = await core.deps.usage.scan();
    expect(segunda.rebuilt).toBe(false);
    // O número não piora: a reconstrução em cooldown vira aviso no log, e o
    // dono tem o botão "Reler transcrições" quando quiser forçar.
    expect(core.deps.usage.report('month', hoje).totals.input).toBe(depoisDaPrimeira);
  });
});
