/**
 * Leitura incremental dos transcripts (ADR-012).
 *
 * NENHUM teste daqui toca no `~/.claude` real: as fixtures são escritas num
 * `tmpDir()` e a raiz é passada à mão. O `vitest.config.ts` do core ainda põe
 * `BRIDGE_CLAUDE_HOME` numa pasta inexistente como segunda rede.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import {
  CHUNK_BYTES,
  CLAUDE_HOME_ENV,
  FINGERPRINT_BYTES,
  MAX_TRANSCRIPT_DEPTH,
  claudeHome,
  fingerprint,
  listTranscripts,
  parseUsageLine,
  scanTranscript,
} from '../src/usage/transcripts.js';

const tmp = (): string => tmpDir('bridge-uso-');

/** Uma linha de assistente como o Claude Code a escreve, só com o que conta. */
function assistantLine(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: 'req_1',
    timestamp: '2026-09-05T12:00:00.000Z',
    cwd: 'C:\\projetos\\a',
    ...overrides,
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, ...usage },
      ...(overrides.message as Record<string, unknown> | undefined),
    },
  });
}

/** Monta `<home>/projects/<pasta>/<arquivo>.jsonl` com as linhas dadas. */
function writeTranscript(home: string, project: string, file: string, lines: string[]): string {
  const dir = join(home, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  return path;
}

describe('claudeHome', () => {
  it('BRIDGE_CLAUDE_HOME vence CLAUDE_CONFIG_DIR, que vence ~/.claude', () => {
    expect(claudeHome({ [CLAUDE_HOME_ENV]: 'C:\\a', CLAUDE_CONFIG_DIR: 'C:\\b' })).toBe('C:\\a');
    expect(claudeHome({ CLAUDE_CONFIG_DIR: 'C:\\b' })).toBe('C:\\b');
    // Sem variável nenhuma sobra o `~/.claude` — o teste só cobra que termina
    // lá, sem fixar o home de quem roda a suíte.
    expect(claudeHome({})).toMatch(/[\\/]\.claude$/);
  });

  it('variável em branco não conta como escolha', () => {
    expect(claudeHome({ [CLAUDE_HOME_ENV]: '   ', CLAUDE_CONFIG_DIR: 'C:\\b' })).toBe('C:\\b');
  });
});

describe('listTranscripts', () => {
  it('acha os .jsonl de todas as subpastas de projects', async () => {
    const home = tmp();
    writeTranscript(home, 'proj-a', 's1.jsonl', [assistantLine()]);
    writeTranscript(home, 'proj-b', 's2.jsonl', [assistantLine()]);
    writeTranscript(home, 'proj-b', 'nao-e-transcript.txt', ['x']);

    const files = (await listTranscripts(home)).files.map((f) => f.path);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('s1.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('nao-e-transcript.txt'))).toBe(false);
  });

  /** Quem nunca rodou o Claude Code não tem a pasta — e isso não é erro. */
  it('pasta ausente devolve lista vazia', async () => {
    expect((await listTranscripts(join(tmp(), 'nao-existe'))).files).toEqual([]);
  });
});

describe('parseUsageLine', () => {
  it('extrai contagens, modelo, projeto e a chave de dedupe', () => {
    const entry = parseUsageLine(assistantLine());
    expect(entry).toMatchObject({
      key: 'msg_1:req_1',
      model: 'claude-sonnet-4-5',
      project: 'C:\\projetos\\a',
      input: 10,
      output: 5,
      cacheWrite: 2,
      cacheWrite1h: 0,
      cacheRead: 3,
    });
  });

  /**
   * `cache_creation_input_tokens` é a SOMA das duas escritas de cache. O
   * detalhamento por TTL vem em `cache_creation`, e os preços são diferentes
   * (5 min custa 1,25 × input; 1 h custa 2 ×). Sem separá-los, a escrita de
   * 1 h era cobrada pelo preço da de 5 min — 22,8 % dos tokens de escrita da
   * máquina do autor saíam mais baratos do que são.
   */
  it('separa a escrita de cache de 1 h da de 5 min quando o detalhamento vem', () => {
    const entry = parseUsageLine(
      assistantLine({}, {
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 300 },
      }),
    );
    expect(entry?.cacheWrite).toBe(700);
    expect(entry?.cacheWrite1h).toBe(300);
  });

  /** Só o campo de 1 h presente: a de 5 min é o RESTO da soma, não zero. */
  it('com só o campo de 1 h, a de 5 min é o resto da soma', () => {
    const entry = parseUsageLine(
      assistantLine({}, { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 400 } }),
    );
    expect(entry?.cacheWrite).toBe(600);
    expect(entry?.cacheWrite1h).toBe(400);
  });

  /**
   * Linha sem `cache_creation` (Claude Code mais antigo) conta tudo como 5
   * min — que é o TTL default, e é o que ela realmente era.
   */
  it('linha sem cache_creation conta a escrita inteira como de 5 min', () => {
    const entry = parseUsageLine(assistantLine({}, { cache_creation_input_tokens: 1000 }));
    expect(entry?.cacheWrite).toBe(1000);
    expect(entry?.cacheWrite1h).toBe(0);
  });

  /** A escrita de 1 h sozinha já basta pra linha contar (o guarda soma os cinco). */
  it('linha só com escrita de 1 h não é descartada como zerada', () => {
    const entry = parseUsageLine(
      assistantLine({}, {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
      }),
    );
    expect(entry?.cacheWrite1h).toBe(500);
  });

  it('linha de usuário, JSON quebrado e linha vazia não contam', () => {
    expect(parseUsageLine(JSON.stringify({ type: 'user', message: { usage: { input_tokens: 9 } } }))).toBeUndefined();
    expect(parseUsageLine('{"type":"assistant","message":')).toBeUndefined();
    expect(parseUsageLine('')).toBeUndefined();
  });

  /**
   * A linha sintética (`<synthetic>`) que o Claude Code grava quando não houve
   * chamada de API tem os quatro contadores em zero. Contá-la não mudaria
   * número nenhum e ainda acenderia um falso "modelo sem preço".
   */
  it('linha de zero token é descartada (é a sintética)', () => {
    const line = assistantLine({ message: { model: '<synthetic>' } }, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(parseUsageLine(line)).toBeUndefined();
  });
});

describe('scanTranscript', () => {
  it('dedupe pela chave message.id + requestId dentro da passada', async () => {
    const home = tmp();
    // A mesma resposta reaparece nas linhas de streaming: uma entrada, não três.
    const path = writeTranscript(home, 'p', 's.jsonl', [assistantLine(), assistantLine(), assistantLine()]);
    const result = await scanTranscript(path);
    expect(result.entries).toHaveLength(1);
    expect(result.lastKey).toBe('msg_1:req_1');
  });

  it('mensagens diferentes contam separado', async () => {
    const home = tmp();
    const path = writeTranscript(home, 'p', 's.jsonl', [
      assistantLine({ requestId: 'req_1', message: { id: 'msg_1' } }),
      assistantLine({ requestId: 'req_2', message: { id: 'msg_2' } }),
    ]);
    expect((await scanTranscript(path)).entries).toHaveLength(2);
  });

  /** Arquivo que cresce: a segunda passada lê SÓ o pedaço novo. */
  it('offset: a segunda passada lê só o que foi acrescentado', async () => {
    const home = tmp();
    const path = writeTranscript(home, 'p', 's.jsonl', [assistantLine({ requestId: 'req_1', message: { id: 'msg_1' } })]);
    const first = await scanTranscript(path);
    expect(first.entries).toHaveLength(1);

    appendFileSync(path, `${assistantLine({ requestId: 'req_2', message: { id: 'msg_2' } })}\n`, 'utf8');
    const second = await scanTranscript(path, { from: first.offset, lastKey: first.lastKey });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.key).toBe('msg_2:req_2');
  });

  /**
   * O `lastKey` é o que impede o vizinho imediato da fronteira de ser contado
   * duas vezes: a `Set` de dedupe é por passada, não pelo histórico inteiro.
   */
  it('lastKey persistido corta o duplicado que atravessa a fronteira do offset', async () => {
    const home = tmp();
    const path = writeTranscript(home, 'p', 's.jsonl', [assistantLine()]);
    const first = await scanTranscript(path);
    appendFileSync(path, `${assistantLine()}\n`, 'utf8');

    const semLastKey = await scanTranscript(path, { from: first.offset });
    expect(semLastKey.entries).toHaveLength(1);

    const comLastKey = await scanTranscript(path, { from: first.offset, lastKey: first.lastKey });
    expect(comLastKey.entries).toHaveLength(0);
  });

  /**
   * O turno ainda está sendo escrito: a linha incompleta fica pra próxima
   * passada inteira, em vez de virar um `JSON.parse` quebrado agora e a linha
   * repetida depois.
   */
  it('linha truncada no fim é ignorada até completar', async () => {
    const home = tmp();
    const completa = assistantLine({ requestId: 'req_1', message: { id: 'msg_1' } });
    const path = writeTranscript(home, 'p', 's.jsonl', []);
    writeFileSync(path, `${completa}\n{"type":"assistant","message":{"usa`, 'utf8');

    const first = await scanTranscript(path);
    expect(first.entries).toHaveLength(1);
    // O offset parou logo depois da linha COMPLETA, não no fim do arquivo.
    expect(first.offset).toBe(Buffer.byteLength(`${completa}\n`, 'utf8'));

    // O resto do turno chega; a passada seguinte lê a linha inteira.
    writeFileSync(path, `${completa}\n${assistantLine({ requestId: 'req_2', message: { id: 'msg_2' } })}\n`, 'utf8');
    const second = await scanTranscript(path, { from: first.offset, lastKey: first.lastKey });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.key).toBe('msg_2:req_2');
  });

  /** O offset é uma posição em BYTES: acento em UTF-8 ocupa dois. */
  it('offset conta bytes, não caracteres (projeto com acento)', async () => {
    const home = tmp();
    const comAcento = assistantLine({ cwd: 'C:\\projetos\\ação', requestId: 'req_1', message: { id: 'msg_1' } });
    const path = writeTranscript(home, 'p', 's.jsonl', [comAcento]);
    const first = await scanTranscript(path);
    expect(first.offset).toBe(Buffer.byteLength(`${comAcento}\n`, 'utf8'));

    appendFileSync(path, `${assistantLine({ requestId: 'req_2', message: { id: 'msg_2' } })}\n`, 'utf8');
    const second = await scanTranscript(path, { from: first.offset, lastKey: first.lastKey });
    expect(second.entries).toHaveLength(1);
  });

  it('teto por passada: sobra marcada em truncated, e a passada seguinte continua', async () => {
    const home = tmp();
    const linhas = Array.from({ length: 20 }, (_, i) =>
      assistantLine({ requestId: `req_${i}`, message: { id: `msg_${i}` } }),
    );
    const path = writeTranscript(home, 'p', 's.jsonl', linhas);

    const first = await scanTranscript(path, { maxBytes: 400 });
    expect(first.truncated).toBe(true);
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.entries.length).toBeLessThan(20);

    const second = await scanTranscript(path, { from: first.offset, lastKey: first.lastKey });
    expect(first.entries.length + second.entries.length).toBe(20);
  });

  it('arquivo inexistente não explode: resultado vazio com o offset intacto', async () => {
    const result = await scanTranscript(join(tmp(), 'nao-existe.jsonl'), { from: 42 });
    expect(result.entries).toEqual([]);
    expect(result.offset).toBe(42);
  });
});

/**
 * A árvore real tem duas camadas: o transcript da conversa solto na pasta do
 * projeto, e os dos SUBAGENTES aninhados sob `<sessão>/subagents/**`. A
 * primeira versão só via a de cima — na máquina do dono isso deixava de fora a
 * maior parte do consumo de um dia.
 */
describe('subagentes na árvore', () => {
  it('acha os transcripts aninhados e marca a origem de cada um', async () => {
    const home = tmp();
    writeTranscript(home, 'proj-a', 's1.jsonl', [assistantLine()]);
    const fundo = join(home, 'projects', 'proj-a', 'sessao-1', 'subagents', 'workflows', 'wf_1');
    mkdirSync(fundo, { recursive: true });
    writeFileSync(join(fundo, 'sub.jsonl'), `${assistantLine()}\n`, 'utf8');
    mkdirSync(join(home, 'projects', 'proj-a', 'sessao-1', 'subagents'), { recursive: true });
    writeFileSync(join(home, 'projects', 'proj-a', 'sessao-1', 'subagents', 'raso.jsonl'), `${assistantLine()}\n`, 'utf8');

    const { files } = await listTranscripts(home);
    expect(files).toHaveLength(3);
    const bySource = files.reduce<Record<string, number>>((acc, f) => {
      acc[f.source] = (acc[f.source] ?? 0) + 1;
      return acc;
    }, {});
    // Solto na pasta do projeto é conversa principal; qualquer aninhamento é subagente.
    expect(bySource).toEqual({ main: 1, subagents: 2 });
  });

  it('não desce além do teto de profundidade', async () => {
    const home = tmp();
    let dir = join(home, 'projects', 'proj-a');
    for (let i = 0; i <= MAX_TRANSCRIPT_DEPTH + 2; i++) dir = join(dir, `n${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fundo.jsonl'), `${assistantLine()}\n`, 'utf8');
    expect((await listTranscripts(home)).files).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('arquivo menor que o teto não tem impressão (ela mudaria a cada linha nova)', async () => {
    const home = tmp();
    const path = writeTranscript(home, 'p', 's.jsonl', [assistantLine()]);
    const small = statSync(path).size;
    expect(small).toBeLessThan(FINGERPRINT_BYTES);
    expect(await fingerprint(path, small)).toBeUndefined();
  });

  /**
   * Transcript é append-only: os primeiros 512 bytes de um arquivo que só
   * cresce nunca mudam. É isso que faz a impressão ser um sinal de REESCRITA,
   * e não de crescimento.
   */
  it('não muda quando o arquivo só cresce; muda quando ele é reescrito', async () => {
    const home = tmp();
    const linhas = Array.from({ length: 6 }, (_, i) => assistantLine({ requestId: `req_${i}`, message: { id: `msg_${i}` } }));
    const path = writeTranscript(home, 'p', 's.jsonl', linhas);
    const antes = await fingerprint(path, statSync(path).size);
    expect(antes).toBeDefined();

    appendFileSync(path, `${assistantLine({ requestId: 'req_x', message: { id: 'msg_x' } })}\n`, 'utf8');
    expect(await fingerprint(path, statSync(path).size)).toBe(antes);

    writeFileSync(path, `${linhas.slice(3).join('\n')}\n${linhas.join('\n')}\n`, 'utf8');
    expect(await fingerprint(path, statSync(path).size)).not.toBe(antes);
  });
});

/**
 * O ponto do item 4 da revisão: a varredura roda no processo que hospeda todos
 * os PTYs. Um bloqueio longo do event loop é saída de terminal travando.
 */
describe('a leitura não bloqueia o event loop', () => {
  it('cede entre fatias, e o maior bloqueio de um transcript grande fica abaixo de 20 ms', async () => {
    const home = tmp();
    // ~3 MB de linhas reais, bem acima de uma fatia de CHUNK_BYTES.
    const linhas = Array.from({ length: 9000 }, (_, i) =>
      assistantLine({ requestId: `req_${i}`, message: { id: `msg_${i}` } }),
    );
    const path = writeTranscript(home, 'p', 'grande.jsonl', linhas);
    expect(statSync(path).size).toBeGreaterThan(2 * CHUNK_BYTES);

    const tamanho = statSync(path).size;
    let cedencias = 0;
    let ultimo = process.hrtime.bigint();
    let maiorMs = 0;
    const result = await scanTranscript(path, {
      maxBytes: 32 * 1024 * 1024,
      yieldToLoop: () =>
        new Promise((resolve) => {
          cedencias += 1;
          const agora = process.hrtime.bigint();
          maiorMs = Math.max(maiorMs, Number(agora - ultimo) / 1e6);
          setImmediate(() => {
            ultimo = process.hrtime.bigint();
            resolve();
          });
        }),
    });

    expect(result.entries).toHaveLength(9000);
    // A parte DETERMINÍSTICA: uma cedência por fatia. É ela que prova que o
    // arquivo não é lido de uma vez só — a medição de tempo abaixo depende da
    // carga da máquina e não serve como trava.
    expect(cedencias).toBeGreaterThanOrEqual(Math.floor(tamanho / CHUNK_BYTES) - 1);
    // A medição: o alvo da revisão é < 20 ms, e isolado fica bem abaixo. O
    // teto aqui é folgado de propósito — a suíte roda vários arquivos em
    // paralelo, e o intervalo entre duas cedências inclui a espera de disco e
    // a CPU dos outros. O que este número pega é a REGRESSÃO (voltar a ler o
    // arquivo inteiro num bloco só seria centenas de ms).
    expect(maiorMs).toBeLessThan(150);
    console.log(`[medição] maior bloqueio entre cedências: ${maiorMs.toFixed(2)} ms em ${cedencias} fatias`);
  });
});
