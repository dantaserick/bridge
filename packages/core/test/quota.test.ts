import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { TRANSCRIPT_MAX_BYTES, contextFromTranscript, quotaFromPayload, statusLine } from '../src/quota.js';
import { weekdayLabel } from '../src/usage/limits.js';
import { join } from 'node:path';

const fixturesDir = join(__dirname, 'fixtures');
const statuslineFixture = JSON.parse(readFileSync(join(fixturesDir, 'statusline.json'), 'utf8'));
const tmp = () => tmpDir('bridge-quota-');

describe('quotaFromPayload', () => {
  it('lê modelo, contexto, custo e rate limits do payload da statusline', () => {
    const q = quotaFromPayload(statuslineFixture);
    expect(q.model).toBe('Fable 5.1');
    expect(q.contextTokens).toBe(87000);
    expect(q.contextPct).toBe(8.7);
    expect(q.costUsd).toBe(3.42);
    const byWindow = Object.fromEntries(q.rateLimits.map((r) => [r.window, r]));
    expect(byWindow.five_hour?.usedPct).toBe(23);
    expect(byWindow.seven_day?.usedPct).toBe(68);
  });

  it('payload vazio → defaults', () => {
    const q = quotaFromPayload({});
    expect(q.model).toBe('claude');
    expect(q.contextTokens).toBe(0);
    expect(q.rateLimits).toEqual([]);
  });

  it('sem context_window.total_input_tokens, lê o transcript (última linha "usage" não sidechain)', () => {
    const dir = tmp();
    const transcriptPath = join(dir, 't.jsonl');
    const lines = [
      JSON.stringify({ isSidechain: true, message: { usage: { input_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } }),
      JSON.stringify({ notUsage: true }),
    ].join('\n');
    writeFileSync(transcriptPath, lines);
    const q = quotaFromPayload({ transcript_path: transcriptPath, model: { display_name: 'X' } });
    expect(q.contextTokens).toBe(125);
  });

  it('transcript ausente → contextTokens 0', () => {
    const q = quotaFromPayload({ transcript_path: 'X:\\nao\\existe.jsonl' });
    expect(q.contextTokens).toBe(0);
  });
});

describe('quotaFromPayload — campos malformados', () => {
  it('cost com tipo errado (string) → costUsd undefined', () => {
    const q = quotaFromPayload({ model: { display_name: 'X' }, cost: 'x' });
    expect(q.costUsd).toBeUndefined();
  });

  it('rate_limits como array (não objeto de janelas) → rateLimits vazio', () => {
    const q = quotaFromPayload({ model: { display_name: 'X' }, rate_limits: [] });
    expect(q.rateLimits).toEqual([]);
  });
});

describe('statusLine', () => {
  /**
   * A ordem, o formato do dinheiro e os rótulos das janelas são os MESMOS da
   * faixa da sidebar e do `bridge usage`: as três pontas mostram o mesmo dado
   * do mesmo payload, e ver `US$ 3,42` numa e `$3.42` na outra era ruído.
   */
  it('formata contexto, modelo, custo em pt-BR e as janelas — na ordem da faixa', () => {
    const q = quotaFromPayload(statuslineFixture);
    // `resets_at` do fixture é 1_900_000_000 (epoch em segundos); o `now` fixo
    // deixa o reset determinístico em vez de depender do relógio. A janela de
    // 5 h reseta em 2h15; a da semana cai a mais de um dia, então vira o dia
    // da semana.
    const now = 1_900_000_000_000 - (2 * 60 + 15) * 60_000;
    const dia = weekdayLabel(new Date(1_900_400_000_000).getDay(), 'pt-BR');
    expect(statusLine(q, { now, lang: 'pt-BR' })).toBe(
      `87k ctx · Fable 5.1 · US$ 3,42 · 5h 23% (reseta em 2h15) · semana 68% (reseta ${dia})`,
    );
  });

  it('showCost desligado tira o custo da linha, e só ele', () => {
    const q = quotaFromPayload({ ...statuslineFixture, rate_limits: {} });
    expect(statusLine(q, { showCost: false, lang: 'pt-BR' })).toBe('87k ctx · Fable 5.1');
  });

  it('sem custo, omite o segmento de custo', () => {
    const q = quotaFromPayload({ model: { display_name: 'X' }, context_window: { total_input_tokens: 5000 } });
    expect(statusLine(q, { lang: 'pt-BR' })).toBe('5k ctx · X');
  });

  it('modelo vazio some em vez de virar um separador solto', () => {
    const q = { ...quotaFromPayload({ context_window: { total_input_tokens: 5000 } }), model: '' };
    expect(statusLine(q, { lang: 'pt-BR' })).toBe('5k ctx');
  });

  /**
   * Conta de API key não recebe `rate_limits` nenhum: a linha encurta em vez
   * de escrever janelas zeradas, que pareceriam cota intacta.
   */
  it('sem rate_limits, a linha é só contexto/modelo/custo', () => {
    const q = quotaFromPayload({ ...statuslineFixture, rate_limits: {} });
    expect(statusLine(q, { lang: 'pt-BR' })).toBe('87k ctx · Fable 5.1 · US$ 3,42');
  });

  /**
   * `resets_at` no passado não vira "reseta em -2h": a janela aparece só com
   * o percentual, que é a parte que ainda é verdade.
   */
  it('reset vencido some, a janela fica', () => {
    const q = quotaFromPayload({
      model: { display_name: 'X' },
      context_window: { total_input_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: 40, resets_at: 1_000 } },
    });
    expect(statusLine(q, { now: 2_000_000, lang: 'pt-BR' })).toBe('1k ctx · X · 5h 40%');
  });

  /** Janela que o Bridge não conhece aparece com a CHAVE CRUA, não some. */
  it('janela extra do payload aparece com a chave crua', () => {
    const q = quotaFromPayload({
      model: { display_name: 'X' },
      context_window: { total_input_tokens: 1000 },
      rate_limits: { seven_day_opus: { used_percentage: 12 } },
    });
    expect(statusLine(q, { lang: 'pt-BR' })).toBe('1k ctx · X · seven_day_opus 12%');
  });
});

/**
 * BR-08 (onda de segurança): `transcript_path` vem do PAYLOAD do hook, ou seja,
 * de quem alcançar `/hooks/<id>/StatusLine` — não do dono. Sem forma exigida e
 * sem teto de tamanho, o core abria e lia INTEIRO, em síncrono, qualquer
 * arquivo do usuário: `~/.ssh/id_ed25519`, `C:\pagefile.sys`, um dump de GB.
 * O statusline é chamado várias vezes por segundo durante o turno.
 */
describe('BR-08 — transcript_path do payload não é leitura de arquivo arbitrário', () => {
  it('caminho que não é .jsonl absoluto é ignorado sem abrir o arquivo', () => {
    const dir = tmp();
    const segredo = join(dir, 'id_ed25519');
    writeFileSync(segredo, '-----BEGIN OPENSSH PRIVATE KEY-----\n{"usage":1}\n', 'utf8');

    expect(contextFromTranscript(segredo)).toBe(0);
    expect(quotaFromPayload({ transcript_path: segredo }).contextTokens).toBe(0);
    // Relativo também não passa.
    expect(contextFromTranscript('transcript.jsonl')).toBe(0);
  });

  it('arquivo acima do teto é ignorado (não é lido pra memória)', () => {
    const dir = tmp();
    const grande = join(dir, 'grande.jsonl');
    // Escreve um arquivo esparso de 65 MB: acima de TRANSCRIPT_MAX_BYTES (64 MB).
    const fd = openSync(grande, 'w');
    writeSync(fd, Buffer.from('{"message":{"usage":{"input_tokens":999}}}\n'), 0, 42, TRANSCRIPT_MAX_BYTES + 1024);
    closeSync(fd);

    const inicio = Date.now();
    expect(contextFromTranscript(grande)).toBe(0);
    // Sem o teto isto lia 65 MB pra uma string.
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('CONTROLE: um transcript normal continua sendo lido (e só o fim dele)', () => {
    const dir = tmp();
    const t = join(dir, 'transcript.jsonl');
    const enchimento = `${JSON.stringify({ message: { usage: { input_tokens: 1 } } })}\n`.repeat(200);
    const ultima = `${JSON.stringify({
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } },
    })}\n`;
    writeFileSync(t, enchimento + ultima, 'utf8');

    expect(contextFromTranscript(t)).toBe(125);
    expect(quotaFromPayload({ transcript_path: t }).contextTokens).toBe(125);
  });
});
