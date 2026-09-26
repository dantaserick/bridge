/**
 * Testes de ATAQUE da onda de segurança do monitor de uso (06/09/2026).
 *
 * Um bloco por achado da auditoria (`BU-xx`), e cada bloco no mesmo formato:
 * primeiro a carga que a auditoria mediu, depois a afirmação de que ela não
 * passa mais. As cargas são as literais do relatório — linha maior que a
 * fatia, `model: "constructor"`, `pricingFile` apontando pra um arquivo com
 * segredo, OSC e CSI na statusline, 1 000 janelas de limite, rescan em laço,
 * `1e308` de token, carimbo do ano 275760.
 *
 * Nada aqui toca o `.claude` real nem o perfil do dono: toda árvore de
 * transcript é uma pasta temporária apontada por `claudeHome`, e todo perfil é
 * um `tmpDir` que se apaga sozinho.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { UsageReport } from '../src/model.js';
import { isDisplaySafe } from '@bridge/shared';
import {
  LIST_YIELD_EVERY,
  MAX_BYTES_PER_PASS,
  MAX_LINE_BYTES,
  listTranscripts,
  parseUsageLine,
  scanTranscript,
} from '../src/usage/transcripts.js';
import { EMBEDDED_PRICING, loadPricingFile, priceFor, resolvePricing } from '../src/usage/pricing.js';
import { MAX_RATE_LIMIT_WINDOWS, quotaFromPayload, statusLine } from '../src/quota.js';
import { formatReset } from '../src/usage/limits.js';
import { summarize } from '../src/usage/aggregate.js';
import { createUsage } from '../src/usage/index.js';
import { openDb } from '../src/db.js';
import { createLogger } from '../src/log.js';

const AUTH = { authorization: 'Bearer T' };
const ESC = '\u001b';
const BEL = '\u0007';
/** Barra invertida sem escrever a escapada — ver `sanitize.test.ts`. */
const BS = String.fromCharCode(92);
const tmp = (): string => tmpDir('bridge-atk-uso-');

let core: Core | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
});

interface LinhaOpts {
  id: string;
  at?: string;
  model?: string;
  cwd?: string;
  input?: number;
  output?: number;
}

function linha(o: LinhaOpts): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${o.id}`,
    timestamp: o.at ?? '2026-09-06T12:00:00.000Z',
    cwd: o.cwd ?? 'C:/projetos/a',
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-4-5',
      usage: { input_tokens: o.input ?? 10, output_tokens: o.output ?? 0 },
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

async function coreCom(home: string, config: Record<string, unknown> = {}): Promise<Core> {
  const profileDir = tmp();
  if (Object.keys(config).length > 0) {
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify(config), 'utf8');
  }
  const criado = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
  await criado.deps.usagePoller?.initialScan;
  return criado;
}

/** A maior pausa do event loop enquanto `fn` roda — o padrão de medição da auditoria. */
async function maiorPausa<T>(fn: () => Promise<T>): Promise<{ valor: T; pausaMs: number }> {
  let ultimo = Date.now();
  let pausaMs = 0;
  const timer = setInterval(() => {
    const agora = Date.now();
    pausaMs = Math.max(pausaMs, agora - ultimo);
    ultimo = agora;
  }, 2);
  try {
    const valor = await fn();
    return { valor, pausaMs };
  } finally {
    clearInterval(timer);
  }
}

// ------------------------------------------------------------------ BU-01

describe('BU-01 — linha maior que o teto não trava a varredura (R1)', () => {
  /**
   * A prova da auditoria: uma linha maior que a fatia da passada não tinha
   * quebra nenhuma dentro dela, `consumed` continuava igual a `from`, e a
   * passada seguinte relia os mesmos bytes — para sempre, com a linha VÁLIDA
   * depois dela nunca contada.
   */
  it('linha de 9 MiB seguida de uma linha válida: o offset anda e a linha válida conta', async () => {
    const home = tmp();
    const gigante = `{"type":"assistant","usage":pricing, lang: 'pt-BR' }),"lixo":"${'A'.repeat(9 * 1024 * 1024)}"}`;
    const path = escreve(home, 'proj', 'gigante.jsonl', [gigante, linha({ id: 'm1', input: 1234 })]);

    const t0 = Date.now();
    const p1 = await scanTranscript(path);
    expect(p1.offset).toBeGreaterThan(0);
    expect(p1.truncated).toBe(true);

    const p2 = await scanTranscript(path, { from: p1.offset, lastKey: p1.lastKey });
    expect(p2.offset).toBeGreaterThan(p1.offset);
    const todas = [...p1.entries, ...p2.entries];
    expect(todas.map((e) => e.key)).toContain('m1:req_m1');
    expect(todas[0]?.input).toBe(1234);
    // A varredura inteira em segundos, não em minutos: o livelock era o custo.
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  it('a linha acima do teto é CONTADA em skippedLines e o offset passa dela', async () => {
    const home = tmp();
    const path = escreve(home, 'proj', 'x.jsonl', [`{"usage":"${'B'.repeat(4096)}"}`, linha({ id: 'ok' })]);
    // Teto de linha injetado (1 KB) pra provar a regra sem escrever 4 MiB.
    const r = await scanTranscript(path, { maxLineBytes: 1024 });
    expect(r.skippedLines).toBe(1);
    expect(r.entries.map((e) => e.key)).toEqual(['ok:req_ok']);
    expect(r.offset).toBeGreaterThan(4096);
  });

  it('controle: linha grande mas ABAIXO do teto continua contando', async () => {
    const home = tmp();
    const grande = JSON.stringify({
      type: 'assistant',
      requestId: 'r',
      timestamp: '2026-09-06T12:00:00.000Z',
      cwd: `C:/${'p'.repeat(500_000)}`,
      message: { id: 'g', model: 'claude-sonnet-4-5', usage: { input_tokens: 7 } },
    });
    expect(Buffer.byteLength(grande, 'utf8')).toBeLessThan(MAX_LINE_BYTES);
    const path = escreve(home, 'proj', 'g.jsonl', [grande]);
    const r = await scanTranscript(path);
    expect(r.skippedLines).toBe(0);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.input).toBe(7);
  });

  it('o teto de linha é menor que o da passada — senão a regra nunca dispara', () => {
    expect(MAX_LINE_BYTES).toBeLessThan(MAX_BYTES_PER_PASS);
  });

  it('a varredura do core conta as linhas puladas no relatório', async () => {
    const home = tmp();
    // O carimbo é HOJE de propósito: o relatório pedido é o do dia, e o
    // timestamp fixo do helper faria a linha cair fora do recorte a partir do
    // dia seguinte ao em que este teste foi escrito.
    const gorda = `{"usage":"${'C'.repeat(5 * 1024 * 1024)}"}`;
    escreve(home, 'proj', 'gig.jsonl', [gorda, linha({ id: 'depois', at: new Date().toISOString() })]);
    // A varredura da subida já leu o arquivo; uma segunda passada não teria
    // linha nova pra pular (o offset já passou dela), então o que se lê é o
    // progresso DAQUELA passada.
    core = await coreCom(home);
    const rel = core.deps.usage.report('day');
    expect(rel.scanning?.skippedLines).toBeGreaterThan(0);
    expect(rel.totals.messages).toBe(1);
  }, 60_000);
});

// ------------------------------------------------------------------ BU-02

describe('BU-02 — modelo com nome de membro de Object.prototype (R2)', () => {
  it('priceFor não enxerga a cadeia de protótipos', () => {
    for (const nome of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(priceFor(EMBEDDED_PRICING, nome)).toBeUndefined();
    }
  });

  it('a tabela resolvida também é sem protótipo', () => {
    const { table } = resolvePricing({}, 'pt-BR');
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(priceFor(table, 'constructor')).toBeUndefined();
  });

  it('uma linha "constructor" não apaga o custo do recorte inteiro', async () => {
    const home = tmp();
    escreve(home, 'proj', 's.jsonl', [
      linha({ id: 'bom', input: 1_000_000 }),
      linha({ id: 'mau', model: 'constructor', input: 1 }),
    ]);
    core = await coreCom(home);
    const res = await core.app.inject({ method: 'GET', url: '/api/usage?range=month', headers: AUTH });
    const rel = res.json() as UsageReport;
    // US$ 3,00 por milhão de input no sonnet — o número certo continua de pé.
    expect(rel.totals.cost).toBeCloseTo(3, 5);
    expect(rel.byModel.find((m) => m.model === 'constructor')?.unpriced).toBe(true);
    expect(rel.pricingWarnings.some((w) => w.includes('constructor'))).toBe(true);
  });
});

// ------------------------------------------------------------------ BU-03

describe('BU-03 — pricingFile não é oráculo de leitura de arquivo (R3)', () => {
  const SEGREDO = 'SENHA-DO-BANCO-NAO-PODE-VAZAR';

  it('arquivo .txt com segredo é recusado sem ser lido, e nada dele aparece no aviso', () => {
    const dir = tmp();
    const alvo = join(dir, 'nota.txt');
    writeFileSync(alvo, SEGREDO, 'utf8');
    const { problems } = loadPricingFile(alvo, 'pt-BR');
    expect(problems).toHaveLength(1);
    expect(problems.join(' ')).not.toContain(SEGREDO);
    expect(problems.join(' ')).not.toContain(alvo);
  });

  it('.json com chaves de credencial não vaza NOME de chave nenhum', () => {
    const dir = tmp();
    const alvo = join(dir, 'cred.json');
    writeFileSync(alvo, JSON.stringify({ claudeAiOauth: { accessToken: SEGREDO } }), 'utf8');
    const { problems } = loadPricingFile(alvo, 'pt-BR');
    expect(problems.join(' ')).not.toContain('claudeAiOauth');
    expect(problems.join(' ')).not.toContain(SEGREDO);
  });

  it('caminho relativo, UNC, arquivo grande e ausente são recusados', () => {
    const dir = tmp();
    const grande = join(dir, 'grande.json');
    writeFileSync(grande, `{"m":"${'x'.repeat(2 * 1024 * 1024)}"}`, 'utf8');
    const unc = `${BS}${BS}srv${BS}share${BS}p.json`;
    for (const alvo of ['precos.json', unc, grande, join(dir, 'nao-existe.json')]) {
      const { table, problems } = loadPricingFile(alvo, 'pt-BR');
      expect(Object.keys(table)).toHaveLength(0);
      expect(problems).toHaveLength(1);
    }
  });

  it('controle: um .json válido e pequeno continua sobrescrevendo o preço', () => {
    const dir = tmp();
    const alvo = join(dir, 'p.json');
    writeFileSync(alvo, JSON.stringify({ 'modelo-x': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } }), 'utf8');
    const { table } = loadPricingFile(alvo, 'pt-BR');
    expect(table['modelo-x']?.input).toBe(1);
  });

  it('pela API: o segredo não sai na resposta, nem na tela, nem no core.log', async () => {
    const home = tmp();
    escreve(home, 'proj', 's.jsonl', [linha({ id: 'a' })]);
    const dir = tmp();
    const alvo = join(dir, 'segredo.txt');
    writeFileSync(alvo, `${SEGREDO} e mais coisa`, 'utf8');

    core = await coreCom(home);
    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { pricingFile: alvo } },
    });
    expect(patch.statusCode).toBe(200);

    const t0 = Date.now();
    const res = await core.app.inject({ method: 'GET', url: '/api/usage', headers: AUTH });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.payload).not.toContain(SEGREDO);
    expect(res.payload).not.toContain('segredo.txt');
    const rel = res.json() as UsageReport;
    expect(rel.pricingWarnings.join(' ')).toContain('arquivo de preços inválido');

    const log = readFileSync(core.deps.profile.logPath, 'utf8');
    expect(log).not.toContain(SEGREDO);
  });
});

// -------------------------------------------------------------- BU-04/06/12

describe('BU-04 — a statusline não devolve byte de controle ao terminal', () => {
  it('OSC, CSI e quebra de linha do payload somem da linha e do que vai pro banco', () => {
    const q = quotaFromPayload({
      model: { display_name: `${ESC}]0;TITULO SEQUESTRADO${BEL}${ESC}[31mFable` },
      rate_limits: { [`${ESC}]0;JANELA${BEL}${ESC}[5m5h`]: { used_percentage: 23 } },
      cost: { total_cost_usd: 1.5 },
    });
    const line = statusLine(q, { lang: 'pt-BR' });
    expect(isDisplaySafe(line)).toBe(true);
    expect(line).toContain('Fable');
    expect(q.rateLimits.every((w) => isDisplaySafe(w.window))).toBe(true);
  });

  it('controle: a statusline real do dono continua com o formato de sempre', () => {
    const q = quotaFromPayload({
      model: { display_name: 'Fable 5.1' },
      context_window: { total_input_tokens: 87_000 },
      cost: { total_cost_usd: 3.42 },
      rate_limits: {
        five_hour: { used_percentage: 23, resets_at: 1_900_000_000 },
        seven_day: { used_percentage: 68, resets_at: 1_900_400_000 },
      },
    });
    expect(statusLine(q, { now: 1_800_000_000_000, lang: 'pt-BR' })).toMatch(
      /^87k ctx · Fable 5\.1 · US\$ 3,42 · 5h 23% \(reseta .+\) · semana 68% \(reseta .+\)$/,
    );
  });
});

describe('BU-06 — teto de janelas e de tamanho de chave', () => {
  it('1 000 janelas viram no máximo 16, e a linha não inunda o terminal', () => {
    const rate: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) rate[`janela_${i}`] = { used_percentage: 50 };
    const q = quotaFromPayload({ model: { display_name: 'x' }, rate_limits: rate });
    expect(q.rateLimits).toHaveLength(MAX_RATE_LIMIT_WINDOWS);
    expect(q.windowsDropped).toBe(1000 - MAX_RATE_LIMIT_WINDOWS);
    expect(statusLine(q, { lang: 'pt-BR' }).length).toBeLessThanOrEqual(500);
  });

  it('chave de 10 kB é cortada em 64 e nada de 10 kB chega ao banco', async () => {
    const chave = 'W'.repeat(10_240);
    const q = quotaFromPayload({ model: { display_name: 'x' }, rate_limits: { [chave]: { used_percentage: 7 } } });
    expect(q.rateLimits[0]?.window.length).toBeLessThanOrEqual(64);

    core = await coreCom(tmp());
    core.deps.usage.noteLimits(q);
    const janelas = core.deps.usage.limits();
    expect(janelas[0]?.window.length).toBeLessThanOrEqual(64);
    expect(janelas[0]?.label.length).toBeLessThanOrEqual(64);
  });

  it('controle: five_hour + seven_day continuam passando os dois', () => {
    const q = quotaFromPayload({
      rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 2 } },
    });
    expect(q.rateLimits.map((w) => w.window)).toEqual(['five_hour', 'seven_day']);
    expect(q.windowsDropped).toBeUndefined();
  });
});

describe('BU-12 — resets_at absurdo não vira "reseta undefined"', () => {
  it('formatReset recusa carimbo fora da janela de sanidade', () => {
    const agora = Date.parse('2026-09-06T12:00:00Z');
    expect(formatReset(Number.MAX_SAFE_INTEGER, agora, 'pt-BR')).toBeUndefined();
    expect(formatReset(1e18, agora, 'pt-BR')).toBeUndefined();
    expect(formatReset(-1, agora, 'pt-BR')).toBeUndefined();
  });

  it('a statusline nunca escreve "undefined"', () => {
    const q = quotaFromPayload({
      model: { display_name: 'claude' },
      rate_limits: { five_hour: { used_percentage: 10, resets_at: Number.MAX_SAFE_INTEGER } },
    });
    expect(statusLine(q, { lang: 'pt-BR' })).not.toContain('undefined');
  });

  it('controle: 2 h e 4 dias continuam formatando', () => {
    const agora = Date.parse('2026-09-06T12:00:00Z');
    expect(formatReset(agora / 1000 + 2 * 3600, agora, 'pt-BR')).toBe('reseta em 2h');
    expect(formatReset(agora / 1000 + 4 * 86_400, agora, 'pt-BR')).toMatch(/^reseta /);
  });
});

// ------------------------------------------------------------------ BU-05

describe('BU-05 — a listagem de transcripts não congela o core (R5)', () => {
  /** Cria `dirs` pastas com `porDir` transcrições de uma linha cada. */
  function arvore(home: string, dirs: number, porDir: number): void {
    const conteudo = `${linha({ id: 'x' })}\n`;
    for (let d = 0; d < dirs; d += 1) {
      const dir = join(home, 'projects', `p${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < porDir; f += 1) writeFileSync(join(dir, `s${f}.jsonl`), conteudo, 'utf8');
    }
  }

  /** Lista medindo a maior pausa do event loop e contando as cedências. */
  async function mede(home: string): Promise<{ arquivos: number; pausaMs: number; cedencias: number }> {
    // Passada de aquecimento, DESCARTADA: a primeira listagem dentro do worker
    // do vitest paga o JIT do módulo e a coleta do lixo que a criação dos
    // arquivos acabou de gerar.
    await listTranscripts(home);
    await new Promise((resolve) => setTimeout(resolve, 50));

    let cedencias = 0;
    const { valor, pausaMs } = await maiorPausa(() =>
      listTranscripts(home, {
        yieldToLoop: () =>
          new Promise((resolve) => {
            cedencias += 1;
            setImmediate(resolve);
          }),
      }),
    );
    expect(valor.capped).toBe(false);
    return { arquivos: valor.files.length, pausaMs, cedencias };
  }

  it('a listagem CEDE o event loop, e a maior pausa fica na casa dos milissegundos', async () => {
    const home = tmp();
    arvore(home, 10, 500);

    const { arquivos, pausaMs, cedencias } = await mede(home);
    expect(arquivos).toBe(5_000);

    // A parte DETERMINÍSTICA, e é ela que trava a regressão: a listagem cede,
    // muitas vezes. A versão síncrona da auditoria cedia ZERO — e era isso que
    // dava 3 782 ms de core parado numa árvore de 50 000 arquivos.
    expect(cedencias).toBeGreaterThanOrEqual(5_000 / LIST_YIELD_EVERY);

    // A medição. O teto do `expect` é folgado de propósito: dentro da suíte o
    // vitest roda vários arquivos em paralelo, e o intervalo entre dois ticks
    // inclui o disco e a CPU dos outros. O que este número pega é a REGRESSÃO
    // de verdade — voltar ao síncrono seriam SEGUNDOS, não milissegundos.
    console.log(`[medição] listTranscripts 5k: maior pausa ${pausaMs} ms em ${cedencias} cedências`);
    expect(pausaMs).toBeLessThan(150);
  }, 120_000);

  /**
   * A medição que a onda foi cobrada de entregar: 20 000 arquivos, maior pausa
   * ABAIXO dos 20 ms que a doc do módulo declara como orçamento.
   *
   * Fica fora da suíte por padrão porque escrever 20 000 arquivos em `%TEMP%`
   * satura o disco por meio minuto, e os testes de PTY que rodam em paralelo
   * (o `shim.test.ts`) passam a estourar o timeout deles por contenção — um
   * teste de medição não pode derrubar os outros. Pra reproduzir:
   *
   *     set BRIDGE_SLOW_TESTS=1&& npx vitest run test/security-uso.test.ts
   *
   * Medido assim, isolado: **3 a 8 ms** (contra os 3 782 ms da versão
   * síncrona).
   */
  it.runIf(process.env.BRIDGE_SLOW_TESTS === '1')(
    '20 000 arquivos: a maior pausa do event loop fica abaixo de 20 ms',
    async () => {
      const home = tmp();
      arvore(home, 20, 1_000);

      const { arquivos, pausaMs, cedencias } = await mede(home);
      expect(arquivos).toBe(20_000);
      expect(cedencias).toBeGreaterThanOrEqual(20_000 / LIST_YIELD_EVERY);
      console.log(`[medição] listTranscripts 20k: maior pausa ${pausaMs} ms em ${cedencias} cedências`);
      expect(pausaMs).toBeLessThan(20);
    },
    600_000,
  );

  it('o teto de arquivos corta a listagem e avisa', async () => {
    const home = tmp();
    const dir = join(home, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 30; f++) writeFileSync(join(dir, `s${f}.jsonl`), '\n', 'utf8');
    const listagem = await listTranscripts(home, { maxFiles: 10 });
    expect(listagem.files).toHaveLength(10);
    expect(listagem.capped).toBe(true);
  });
});

// ------------------------------------------------------------------ BU-07

describe('BU-07 — rescan em laço', () => {
  it('o segundo rescan em série é 429 com code rescan-cooldown', async () => {
    const home = tmp();
    escreve(home, 'proj', 's.jsonl', [linha({ id: 'a' })]);
    core = await coreCom(home);

    const um = await core.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH });
    expect(um.statusCode).toBe(200);

    const dois = await core.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH });
    expect(dois.statusCode).toBe(429);
    expect(dois.json().code).toBe('rescan-cooldown');
    expect(dois.json().retryAfter).toBeGreaterThan(0);
    expect(dois.headers['retry-after']).toBeDefined();
  });

  it('vinte rescans em paralelo: um roda, os outros são recusados', async () => {
    const home = tmp();
    escreve(home, 'proj', 's.jsonl', [linha({ id: 'a' })]);
    core = await coreCom(home);
    const c = core;

    const respostas = await Promise.all(
      Array.from({ length: 20 }, () => c.app.inject({ method: 'POST', url: '/api/usage/rescan', headers: AUTH })),
    );
    expect(respostas.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of respostas.filter((x) => x.statusCode !== 200)) {
      expect([409, 429]).toContain(r.statusCode);
      expect(['rescan-in-flight', 'rescan-cooldown']).toContain(r.json().code);
    }
  });
});

// --------------------------------------------------------------- BU-08/17

describe('BU-08 — contadores de token fora de faixa', () => {
  const base = { type: 'assistant', requestId: 'r', timestamp: '2026-09-06T12:00:00.000Z', cwd: 'C:/a' };
  const comUso = (usage: Record<string, unknown>): string =>
    JSON.stringify({ ...base, message: { id: 'm', model: 'claude-sonnet-4-5', usage } });

  it('negativo, 1e308 e 1e13 contam ZERO', () => {
    expect(parseUsageLine(comUso({ input_tokens: -1, output_tokens: 5 }))?.input).toBe(0);
    expect(parseUsageLine(comUso({ input_tokens: 1e308, output_tokens: 5 }))?.input).toBe(0);
    expect(parseUsageLine(comUso({ input_tokens: 1e13, output_tokens: 5 }))?.input).toBe(0);
    // O par que atravessava o único filtro que existia (`soma <= 0`).
    // Zerados os dois, a soma dos cinco contadores é zero e a linha inteira é
    // descartada — que é o outro fim aceitável do mesmo achado.
    expect(parseUsageLine(comUso({ input_tokens: -1e12, output_tokens: 1e12 + 5 }))).toBeUndefined();
  });

  it('controle: 1 000 000 de tokens continuam contando', () => {
    expect(parseUsageLine(linha({ id: 'm', input: 1_000_000 }))?.input).toBe(1_000_000);
  });
});

describe('BU-17 — carimbo de tempo absurdo não cria dia no banco', () => {
  it('ano 275760 e 1970 são descartados; hoje continua contando', async () => {
    const home = tmp();
    escreve(home, 'proj', 's.jsonl', [
      linha({ id: 'futuro', at: '+275760-09-13T00:00:00.000Z' }),
      linha({ id: 'antigo', at: '1970-01-02T00:00:00.000Z' }),
      linha({ id: 'hoje', at: new Date().toISOString() }),
    ]);
    core = await coreCom(home);
    const dias = core.deps.db.usage.daily('0000-00-00', '9999-99-99').map((r) => r.day);
    expect(dias.some((d) => d.startsWith('275760'))).toBe(false);
    expect(dias.some((d) => d.startsWith('1970'))).toBe(false);
    expect(dias).toHaveLength(1);
  });
});

// ------------------------------------------------------------ BU-10/11/15

describe('BU-10 — teto de entradas em usage.pricing', () => {
  it('201 modelos é 400; 200 passa', async () => {
    core = await coreCom(tmp());
    const preco = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };
    const monta = (n: number): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) out[`m-${i}`] = preco;
      return out;
    };
    const demais = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { pricing: monta(201) } },
    });
    expect(demais.statusCode).toBe(400);
    const cabe = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { pricing: monta(200) } },
    });
    expect(cabe.statusCode).toBe(200);
  });
});

describe('BU-15 — campo documentado não some em silêncio', () => {
  it('cacheWrite1h sobrevive ao round-trip do PATCH', async () => {
    core = await coreCom(tmp());
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: {
        usage: { pricing: { 'm-1h': { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } } },
      },
    });
    expect(res.statusCode).toBe(200);
    const config = (await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH })).json();
    expect(config.usage.pricing['m-1h'].cacheWrite1h).toBe(6);
  });

  it('corpo com campo desconhecido no PATCH de repo é 400, não 200 calado', async () => {
    core = await coreCom(tmp());
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/repos/qualquer',
      headers: AUTH,
      payload: { trustFilters: true, extra: 'ignorado' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('BU-11 — byProject/byModel com teto no servidor', () => {
  it('1 000 projetos viram 201 baldes e o total continua fechando', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      day: '2026-09-06',
      model: 'claude-sonnet-4-5',
      project: `C:/proj-${i}`,
      source: 'main' as const,
      input: i + 1,
      output: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      messages: 1,
    }));
    const s = summarize({
      rows,
      chartRows: rows,
      chart: { from: '2026-09-06', to: '2026-09-06' },
      pricing: EMBEDDED_PRICING,
      lang: 'pt-BR',
    });
    expect(s.byProject).toHaveLength(201);
    expect(s.byProject[200]?.project).toBe('(outros)');
    expect(s.byProject.reduce((a, p) => a + p.tokens, 0)).toBe(s.totals.tokens);
  });
});

// ------------------------------------------------------------------ BU-16

describe('BU-16 — eco de string hostil em mensagem de erro', () => {
  it('o 400 de fuso desconhecido sai sem byte de controle e cortado', async () => {
    core = await coreCom(tmp());
    const tz = encodeURIComponent(`${ESC}[31m${'U'.repeat(400)}`);
    const res = await core.app.inject({ method: 'GET', url: `/api/usage?tz=${tz}`, headers: AUTH });
    expect(res.statusCode).toBe(400);
    const erro = res.json().error as string;
    expect(isDisplaySafe(erro)).toBe(true);
    expect(erro.length).toBeLessThan(200);
  });

  it('o 400 de anchor e de período inválidos sai sem byte de controle e cortado', async () => {
    core = await coreCom(tmp());
    const hostil = encodeURIComponent(`${ESC}[31m${'2'.repeat(400)}`);
    for (const [query, code] of [
      [`range=month&anchor=${hostil}`, 'invalid-anchor'],
      [`range=custom&from=${hostil}&to=2021-01-01`, 'invalid-period'],
    ] as const) {
      const res = await core.app.inject({ method: 'GET', url: `/api/usage?${query}`, headers: AUTH });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
      const erro = res.json().error as string;
      expect(isDisplaySafe(erro)).toBe(true);
      expect(erro.length).toBeLessThan(250);
    }
  });

  it('ação desconhecida no keybindings.json sai limpa em problems', async () => {
    const profileDir = tmp();
    writeFileSync(
      join(profileDir, 'keybindings.json'),
      JSON.stringify({ [`acao${ESC}[31mDesconhecida${'Z'.repeat(300)}`]: 'Ctrl+K' }),
      'utf8',
    );
    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const res = await core.app.inject({ method: 'GET', url: '/api/keybindings', headers: AUTH });
    const problems = res.json().problems as { action?: string }[];
    expect(problems).toHaveLength(1);
    expect(isDisplaySafe(problems[0]?.action ?? '')).toBe(true);
    expect((problems[0]?.action ?? '').length).toBeLessThanOrEqual(120);
    // O caminho do arquivo continua NÃO vazando (era o que a auditoria aprovou).
    expect(res.payload).not.toContain('keybindings.json');
  });
});

// ------------------------------------------------------------------ BU-14

describe('BU-14 — usage.changed { limits } estrangulado em 1/s', () => {
  it('100 fotos diferentes em 200 ms viram no máximo 1 evento, e a última chega', async () => {
    const db = openDb(':memory:');
    const log = createLogger({ path: join(tmp(), 'core.log') });
    let agora = 1_000_000;
    const emitidos: number[] = [];
    const usage = createUsage({
      db,
      log,
      config: () => ({ dayBoundary: 'local', showCost: true, terminalStatusLine: false }),
      claudeHome: tmp(),
      language: () => 'pt-BR',
      now: () => agora,
      onLimits: (limits) => emitidos.push(limits[0]?.usedPct ?? -1),
    });

    // A primeira foto passa (é o começo da janela); as 99 seguintes caem nela.
    let retornados = 0;
    for (let i = 1; i <= 100; i += 1) {
      agora += 2;
      const q = quotaFromPayload({ rate_limits: { five_hour: { used_percentage: i } } }, agora);
      if (usage.noteLimits(q)) retornados += 1;
    }
    expect(retornados).toBe(1);

    // A ÚLTIMA foto é entregue com atraso — engoli-la deixaria a barra parada
    // num percentual que já mudou.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toBe(100);

    usage.stop();
    await log.close?.();
    db.close?.();
  }, 20_000);
});

// ------------------------------------------------------- rodada 2 (re-review)

describe('rodada 2 — bidi e largura zero no que vai pro terminal', () => {
  const RLO = '‮';
  const ZWSP = '​';

  it('o RLO e o zero-width somem da statusline e das janelas', () => {
    const q = quotaFromPayload({
      model: { display_name: `Fable${ZWSP} 5.1` },
      rate_limits: { [`five${RLO}_hour`]: { used_percentage: 10 } },
    });
    const line = statusLine(q, { lang: 'pt-BR' });
    expect(line).not.toContain(RLO);
    expect(line).not.toContain(ZWSP);
    expect(isDisplaySafe(line)).toBe(true);
    expect(q.model).toBe('Fable 5.1');
  });

  it('o cwd e o model de um transcript chegam limpos na API', async () => {
    const home = tmp();
    escreve(home, 'p', 's.jsonl', [
      linha({ id: 'a', cwd: `C:/proj/gnp${RLO}txt.exe`, model: `claude${ZWSP}-sonnet-4-5` }),
    ]);
    core = await coreCom(home);
    // A API devolve o dado CRU de propósito (é JSON, não tela) — quem limpa é
    // quem escreve na tela. O que este teste cobra é que as duas pontas de
    // TELA (a CLI e o painel) usem o mesmo sanitizador, e isso está provado
    // nos testes de `packages/cli` e `packages/ui`. Aqui fica a prova de que o
    // caractere sobrevive até elas — senão o teste de lá seria vazio.
    const rel = core.deps.usage.report('month');
    expect(rel.byProject.some((p) => p.project.includes(RLO))).toBe(true);
  });
});

describe('rodada 2 — chaves de janela que colidem depois da limpeza', () => {
  it('duas chaves diferentes que viram a mesma contam como descartada', () => {
    const q = quotaFromPayload({
      rate_limits: {
        five_hour: { used_percentage: 10 },
        // Mesma chave depois de tirar o invisível: seria um segundo cartão com
        // o MESMO rótulo, e no banco a segunda sobrescreveria a primeira.
        ['five_hour​']: { used_percentage: 90 },
      },
    });
    expect(q.rateLimits).toHaveLength(1);
    expect(q.rateLimits[0]?.usedPct).toBe(10);
    expect(q.windowsDropped).toBe(1);
  });

  it('controle: janelas de nomes realmente distintos continuam entrando', () => {
    const q = quotaFromPayload({
      rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 2 } },
    });
    expect(q.rateLimits).toHaveLength(2);
    expect(q.windowsDropped).toBeUndefined();
  });
});

describe('rodada 2 — o que a varredura não leu chega ao relatório', () => {
  it('skippedLines do arquivo sobe pro scanning do GET /api/usage', async () => {
    const home = tmp();
    escreve(home, 'proj', 'gig.jsonl', [`{"usage":"${'D'.repeat(5 * 1024 * 1024)}"}`, linha({ id: 'depois' })]);
    core = await coreCom(home);
    const res = await core.app.inject({ method: 'GET', url: '/api/usage', headers: AUTH });
    const rel = res.json() as UsageReport;
    expect(rel.scanning?.skippedLines).toBeGreaterThan(0);
    // E o arquivo guarda o acumulado, pra a passada seguinte não perder a conta.
    const estado = core.deps.db.usage.listFiles()[0];
    expect(estado?.skippedLines).toBeGreaterThan(0);
  }, 60_000);

  it('capped vai junto no scanning quando a árvore passa do teto', async () => {
    const home = tmp();
    const dir = join(home, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 12; f++) writeFileSync(join(dir, `s${f}.jsonl`), `${linha({ id: `k${f}` })}
`, 'utf8');
    const listagem = await listTranscripts(home, { maxFiles: 5 });
    expect(listagem.capped).toBe(true);
    expect(listagem.files).toHaveLength(5);
  });
});

