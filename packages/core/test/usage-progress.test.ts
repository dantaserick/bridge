/**
 * Progresso da varredura e as janelas de limite FIXAS (Task 3, ADR-012;
 * 16/09/2026).
 *
 * O progresso nasceu de uma preocupação medida na Task 1: a primeira varredura
 * de um histórico grande leva minutos (8.431 arquivos, 12,8 GB na máquina do
 * autor) e o painel dizia "nenhuma transcrição encontrada" o tempo inteiro. As
 * janelas: um payload de statusline sem `rate_limits` — que é o que TODO
 * Claude ocioso manda — nunca apaga as barras; a janela vencida é que vira 0 %.
 *
 * A maior parte é testada PURA (as duas regras estão em funções sem I/O); só o
 * que precisa de disco — a contagem de arquivos e bytes de uma passada de
 * verdade — sobe um core com a raiz de transcrições numa pasta temporária.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageScanProgress } from '@bridge/shared';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { openDb } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { createUsage } from '../src/usage/index.js';
import { PROGRESS_EMIT_MS, progressEqual, shouldEmitProgress, startProgress } from '../src/usage/progress.js';

const tmp = (): string => tmpDir('bridge-uso-prog-');

let core: Core | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
});

function progresso(p: Partial<UsageScanProgress> = {}): UsageScanProgress {
  return { active: true, filesDone: 1, filesTotal: 10, bytesDone: 100, bytesTotal: 1000, skippedLines: 0, ...p };
}

describe('shouldEmitProgress', () => {
  it('o primeiro progresso sempre sai', () => {
    expect(shouldEmitProgress(undefined, startProgress(3, 300), 0)).toBe(true);
  });

  /**
   * A passada percorre arquivos já lidos sem mudar número nenhum — repetir a
   * mesma foto seria um evento por arquivo sem informação nova.
   */
  it('progresso idêntico ao último emitido não sai', () => {
    const p = progresso();
    expect(shouldEmitProgress({ at: 0, progress: p }, progresso(), 999_999)).toBe(false);
  });

  it('no meio da passada, no máximo um por segundo', () => {
    const last = { at: 10_000, progress: progresso({ filesDone: 1 }) };
    expect(shouldEmitProgress(last, progresso({ filesDone: 2 }), 10_500)).toBe(false);
    expect(shouldEmitProgress(last, progresso({ filesDone: 2 }), 10_000 + PROGRESS_EMIT_MS)).toBe(true);
  });

  /**
   * O começo acende o "ainda lendo" e o fim o apaga. Estrangular a virada de
   * `active` deixaria a tela presa num "lendo…" de uma varredura encerrada.
   */
  it('a virada de active sai sempre, nos dois sentidos', () => {
    const lendo = { at: 10_000, progress: progresso({ active: true, filesDone: 9 }) };
    expect(shouldEmitProgress(lendo, progresso({ active: false, filesDone: 10 }), 10_001)).toBe(true);

    const parado = { at: 10_000, progress: progresso({ active: false, filesDone: 10 }) };
    expect(shouldEmitProgress(parado, startProgress(10, 1000), 10_001)).toBe(true);
  });

  it('progressEqual compara os cinco campos', () => {
    expect(progressEqual(progresso(), progresso())).toBe(true);
    expect(progressEqual(progresso(), progresso({ bytesDone: 101 }))).toBe(false);
    expect(progressEqual(undefined, progresso())).toBe(false);
  });
});


/** Uma linha de assistente mínima, só pra o arquivo ter tamanho e conteúdo. */
function linha(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${id}`,
    timestamp: '2026-09-06T12:00:00.000Z',
    cwd: 'C:\\projetos\\a',
    message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 1 } },
  });
}

function escreve(home: string, projeto: string, arquivo: string, quantas: number): void {
  const dir = join(home, 'projects', projeto);
  mkdirSync(dir, { recursive: true });
  const linhas = Array.from({ length: quantas }, (_, i) => linha(`${projeto}-${arquivo}-${i}`));
  writeFileSync(join(dir, arquivo), `${linhas.join('\n')}\n`, 'utf8');
}

describe('progresso numa varredura de verdade', () => {
  it('GET /api/usage traz scanning com os arquivos e bytes da última passada', async () => {
    const home = tmp();
    escreve(home, 'proj-a', 's1.jsonl', 3);
    escreve(home, 'proj-b', 's2.jsonl', 2);
    mkdirSync(join(home, 'projects', 'proj-a', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(home, 'projects', 'proj-a', 's1', 'subagents', 'sub.jsonl'), `${linha('sub-1')}\n`, 'utf8');

    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
    await core.deps.usagePoller?.initialScan;

    const res = await core.app.inject({ method: 'GET', url: '/api/usage', headers: { authorization: 'Bearer T' } });
    expect(res.statusCode).toBe(200);
    const scanning = (res.json() as { scanning: UsageScanProgress | null }).scanning;
    expect(scanning).not.toBeNull();
    // A varredura acabou: `active` falso é o que apaga o "ainda lendo".
    expect(scanning?.active).toBe(false);
    // Três transcrições: duas principais e uma de subagente.
    expect(scanning?.filesTotal).toBe(3);
    expect(scanning?.filesDone).toBe(3);
    expect(scanning?.bytesTotal).toBeGreaterThan(0);
    expect(scanning?.bytesDone).toBe(scanning?.bytesTotal);
  });

  /**
   * O evento é o que a UI usa: sem ele o painel só saberia do progresso
   * relendo o relatório inteiro em laço.
   */
  it('usage.changed carrega o scanning do começo e do fim da passada', async () => {
    const home = tmp();
    escreve(home, 'proj-a', 's1.jsonl', 2);

    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
    await core.deps.usagePoller?.initialScan;

    const vistos: (UsageScanProgress | null | undefined)[] = [];
    const off = core.deps.bus.on((ev) => {
      if (ev.type === 'usage.changed' && ev.scanning !== undefined) vistos.push(ev.scanning);
    });
    await core.deps.usage.rescan();
    off();

    expect(vistos.length).toBeGreaterThanOrEqual(2);
    expect(vistos[0]?.active).toBe(true);
    expect(vistos[0]?.filesDone).toBe(0);
    expect(vistos.at(-1)?.active).toBe(false);
    expect(vistos.at(-1)?.filesDone).toBe(1);
  });

  /**
   * Um payload de statusline SEM `rate_limits` chegando logo depois de um COM
   * não pode apagar as janelas: é o caso das duas contas lado a lado.
   */
  it('statusline sem rate_limits não apaga janelas reportadas há pouco', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    await core.deps.usagePoller?.initialScan;

    const agora = Date.now();
    const comLimites = core.deps.usage.noteLimits({
      model: 'Fable 5.1',
      contextTokens: 1000,
      rateLimits: [{ window: 'five_hour', usedPct: 23, resetsAt: Math.floor(agora / 1000) + 3600 }],
      at: agora,
      line: '',
    });
    expect(comLimites).toHaveLength(1);

    const semLimites = core.deps.usage.noteLimits({
      model: 'Claude',
      contextTokens: 500,
      rateLimits: [],
      at: agora,
      line: '',
    });
    expect(semLimites).toBeUndefined();
    expect(core.deps.usage.limits()).toHaveLength(1);
  });
});

/**
 * O relógio é injetado aqui em vez de adiantado no processo: o core roda um
 * servidor Fastify de verdade nos testes acima, e congelar o relógio dele com
 * `vi.useFakeTimers` trava o event loop das requisições vizinhas.
 */
describe('limpeza de janelas com o relógio injetado', () => {
  function usageCom(now: () => number) {
    const dir = tmpDir('bridge-uso-clock-');
    const db = openDb(':memory:');
    const log = createLogger({ path: join(dir, 'core.log') });
    const usage = createUsage({
      db,
      log,
      config: () => ({ dayBoundary: 'local' as const, showCost: true, terminalStatusLine: false }),
      claudeHome: tmpDir('bridge-uso-clock-home-'),
      language: () => 'pt-BR',
      now,
    });
    return { usage, db, log };
  }

  const quota = (pct?: number) => ({
    model: 'X',
    contextTokens: 10,
    rateLimits: pct === undefined ? [] : [{ window: 'five_hour', usedPct: pct }],
    at: 0,
    line: '',
  });

  /**
   * O defeito de 16/09/2026: o dono parava de usar por um tempo, as barras de
   * 5 h e semana sumiam da sidebar, e voltavam no primeiro turno seguinte. O
   * Claude Code omite `rate_limits` sempre que não tem resposta recente da
   * API, e a carência de dez minutos apagava as janelas.
   */
  it('payload sem rate_limits NUNCA apaga as janelas — nem horas depois', () => {
    let agora = Date.parse('2026-09-06T12:00:00.000Z');
    const { usage, db, log } = usageCom(() => agora);
    try {
      expect(usage.noteLimits(quota(23))).toHaveLength(1);
      for (const salto of [60_000, 10 * 60_000, 3 * 3600_000]) {
        agora += salto;
        expect(usage.noteLimits(quota())).toBeUndefined();
        expect(usage.limits()).toHaveLength(1);
        expect(usage.limits()[0]?.usedPct).toBe(23);
      }
    } finally {
      usage.stop();
      db.close();
      void log.close();
    }
  });

  it('janela com resets_at vencido volta como 0 % e sem reset; a próxima foto real substitui', () => {
    let agora = Date.parse('2026-09-06T12:00:00.000Z');
    const { usage, db, log } = usageCom(() => agora);
    try {
      const resetsAt = Math.floor(agora / 1000) + 3600;
      usage.noteLimits({ ...quota(), rateLimits: [{ window: 'five_hour', usedPct: 68, resetsAt }] });
      expect(usage.limits()[0]).toMatchObject({ usedPct: 68, resetsAt });

      agora += 3600_000 + 1;
      expect(usage.limits()[0]).toMatchObject({ usedPct: 0 });
      expect(usage.limits()[0]?.resetsAt).toBeUndefined();

      usage.noteLimits({ ...quota(), rateLimits: [{ window: 'five_hour', usedPct: 3, resetsAt: resetsAt + 18_000 }] });
      expect(usage.limits()[0]).toMatchObject({ usedPct: 3, resetsAt: resetsAt + 18_000 });
    } finally {
      usage.stop();
      db.close();
      void log.close();
    }
  });
});
