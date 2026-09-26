/**
 * Leitura INCREMENTAL dos transcripts do Claude Code, só pra contar tokens.
 *
 * **Onde ficam.** A raiz é `<claudeHome>/projects`, e dentro dela a árvore tem
 * dois níveis que contam:
 *
 *     projects/<pasta-do-cwd>/<sessão>.jsonl                    ← conversa principal
 *     projects/<pasta-do-cwd>/<sessão>/subagents/**\/*.jsonl     ← subagentes
 *
 * A primeira versão só olhava o nível de cima e perdia os subagentes. Na
 * máquina do dono isso era a MAIORIA do consumo de um dia — um painel que
 * mostrasse só a conversa principal estaria errado por um fator, não por um
 * detalhe. Por isso a varredura é RECURSIVA (profundidade ≤
 * `MAX_TRANSCRIPT_DEPTH`, sem seguir link simbólico) e cada arquivo é
 * classificado em `main` ou `subagents` pelo lugar onde está: solto na pasta
 * do projeto é conversa principal, aninhado é subagente.
 *
 * O PROJETO nunca vem do caminho: vem do `cwd` de cada linha. Um subagente
 * pode rodar noutra pasta que a sessão que o lançou, e a pergunta que o painel
 * responde ("quanto este projeto consumiu?") é sobre onde o trabalho
 * aconteceu.
 *
 * **Cada linha** que interessa é `type: "assistant"` e carrega
 * `message.usage` (input, output, escrita e leitura de cache),
 * `message.model`, `message.id`, `requestId`, `timestamp` e `cwd`.
 *
 * **Três regras** que fazem isso ser barato o bastante pra rodar a cada 60 s:
 *
 * - **offset persistido**: cada arquivo é lido a partir de onde a última
 *   passada parou, nunca do começo;
 * - **linha parcial fica pra próxima**: o último `\n` manda. O que vier depois
 *   dele é um turno ainda sendo escrito;
 * - **assíncrono e em fatias**: a leitura usa `fs.promises` e cede o event
 *   loop entre pedaços de `CHUNK_BYTES`. O core hospeda TODAS as sessões, e um
 *   `readSync` de megabytes seguraria os PTYs — foi o defeito que a revisão
 *   mediu na primeira versão.
 *
 * Privacidade (a regra do dono): NADA de conteúdo de mensagem sai daqui. O que
 * a função devolve são contagens, id de modelo, `cwd` e carimbo de tempo.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { asNumber, asRecord, asString } from '../adapters/payload.js';

/**
 * Raiz alternativa pros transcripts. Existe pros TESTES (nenhum teste pode ler
 * o `~/.claude` de quem roda a suíte) e pro e2e, e é a primeira coisa
 * consultada — antes até do `CLAUDE_CONFIG_DIR` do próprio Claude Code.
 */
export const CLAUDE_HOME_ENV = 'BRIDGE_CLAUDE_HOME';

/** `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  // `resolve` e não o valor cru: uma variável RELATIVA fazia a raiz depender do
  // `cwd` do processo do core (que muda com quem o lançou) e aparecia relativa
  // em `GET /api/usage.claudeHome`. Nota da auditoria, item 5 dos aceitos.
  const override = env[CLAUDE_HOME_ENV]?.trim();
  if (override) return resolve(override);
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return resolve(configDir);
  return join(homedir(), '.claude');
}

/** `<claudeHome>/projects` — a pasta com uma subpasta por `cwd` codificado. */
export function projectsDir(home: string): string {
  return join(home, 'projects');
}

/**
 * Teto de profundidade da varredura, contado a partir da pasta do projeto.
 * Na árvore real o mais fundo é `<sessão>/subagents/workflows/<wf>/x.jsonl`
 * (4); 8 dá folga pra uma estrutura nova sem virar uma descida sem fim numa
 * pasta que alguém montou por engano dentro de `projects`.
 */
export const MAX_TRANSCRIPT_DEPTH = 8;

/** De onde o consumo veio: a conversa principal ou um subagente dela. */
export type UsageSource = 'main' | 'subagents';

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
  source: UsageSource;
}

/**
 * Teto de arquivos por listagem (BU-05/R5).
 *
 * A árvore da máquina do autor tem 8.431 transcripts; 50 000 é seis vezes
 * isso. Acima disso a listagem PARA e avisa, em vez de montar um array
 * proporcional ao que alguém plantou em `projects/` — o `usage.changed` e a
 * passada inteira andam em cima dessa lista.
 */
export const MAX_TRANSCRIPT_FILES = 50_000;

/**
 * Quantas entradas de diretório a listagem processa entre uma cedência do
 * event loop e a próxima (BU-05/R5).
 *
 * A leitura dos arquivos já era assíncrona e fatiada; a LISTAGEM não era, e
 * era ela que segurava o core por 3,78 s numa árvore de 50 000 arquivos — o
 * pior bloqueio medido na auditoria, e ele acontecia a cada passada do poller,
 * sem atacante nenhum. 500 é o tamanho de lote que mantém a pausa máxima
 * abaixo do orçamento de 20 ms do módulo sem transformar a listagem em um
 * `await` por arquivo.
 */
export const LIST_YIELD_EVERY = 500;

/**
 * Orçamento de tempo entre duas cedências da listagem, em ms.
 *
 * O contador de 500 entradas sozinho não bastou: numa árvore de 20 000
 * arquivos a maior pausa medida foi de **25 ms**, acima do orçamento de 20 ms
 * que a doc deste módulo declara. O motivo é que as 500 conclusões de `stat`
 * entre uma cedência e outra são resolvidas como microtarefas DENTRO da mesma
 * volta do event loop — quem força a volta (e portanto deixa os timers e o
 * I/O dos PTYs correrem) é o `setImmediate` da cedência, não o `await`.
 *
 * Então valem os dois: 500 entradas OU 5 ms, o que vier primeiro — com 5 ms
 * a maior pausa medida na mesma árvore cai pra ~8 ms.
 */
export const LIST_YIELD_MS = 5;

export interface TranscriptListing {
  files: TranscriptFile[];
  /** A árvore tem mais que `MAX_TRANSCRIPT_FILES` — o resto ficou de fora. */
  capped: boolean;
}

export interface ListOptions {
  /** Injetável pro teste medir a cedência; o default é `setImmediate`. */
  yieldToLoop?: () => Promise<void>;
  /** Injetável pro teste do teto; o default é `MAX_TRANSCRIPT_FILES`. */
  maxFiles?: number;
  /**
   * `true` quando o core está encerrando: a listagem desiste na entrada
   * seguinte. A listagem virou assíncrona (BU-05), então ela passou a ser um
   * ponto onde o `core.stop()` pode esperar — e um encerramento gracioso não
   * pode ficar preso percorrendo a árvore inteira.
   */
  shouldStop?: () => boolean;
}

/**
 * Todo `*.jsonl` sob `projects/`, recursivamente — ASSÍNCRONA e cedendo o
 * event loop a cada `LIST_YIELD_EVERY` entradas.
 *
 * Pasta ausente devolve lista vazia (é o estado de quem nunca rodou o Claude
 * Code), e uma subpasta ilegível não derruba a varredura das outras. Link
 * simbólico é ignorado: seguir um deles é como um laço infinito entra numa
 * varredura recursiva, e nenhum transcript legítimo é um. (No Windows a
 * junction criada por `mklink /J` também chega aqui como link simbólico no
 * `Dirent`, e cai no mesmo `continue` — foi medido na auditoria.)
 */
export async function listTranscripts(home: string, opts: ListOptions = {}): Promise<TranscriptListing> {
  const root = projectsDir(home);
  const yieldToLoop = opts.yieldToLoop ?? defaultYield;
  const maxFiles = opts.maxFiles ?? MAX_TRANSCRIPT_FILES;
  const shouldStop = opts.shouldStop ?? (() => false);
  const files: TranscriptFile[] = [];
  let capped = false;
  let seen = 0;
  let ultimaCedencia = Date.now();

  /** Cede a cada `LIST_YIELD_EVERY` entradas OU a cada `LIST_YIELD_MS`. */
  async function tick(): Promise<void> {
    seen += 1;
    const porContagem = seen % LIST_YIELD_EVERY === 0;
    const porTempo = Date.now() - ultimaCedencia >= LIST_YIELD_MS;
    if (!porContagem && !porTempo) return;
    ultimaCedencia = Date.now();
    await yieldToLoop();
  }

  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { files, capped };
  }

  /** `depth` é a distância até a pasta do projeto: 0 = solto nela. */
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_TRANSCRIPT_DEPTH || capped) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped || shouldStop()) return;
      await tick();
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (files.length >= maxFiles) {
        capped = true;
        return;
      }
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs, source: depth === 0 ? 'main' : 'subagents' });
      } catch {
        // Arquivo que sumiu entre o `readdir` e o `stat` — a próxima passada vê.
      }
    }
  }

  for (const project of projects) {
    if (capped || shouldStop()) break;
    await walk(join(root, project), 0);
  }
  return { files, capped };
}

/** Uma linha de assistente já reduzida ao que o agregador precisa. */
export interface UsageEntry {
  /** `message.id:requestId` — a chave de dedupe (a mesma resposta reaparece no streaming). */
  key: string;
  /** ISO do payload, como veio. Quem fatia em dias é o `aggregate.ts`. */
  timestamp: string;
  model: string;
  /** `cwd` da linha — é o nome do projeto na visão do dono. */
  project: string;
  input: number;
  output: number;
  /** Escrita de cache de 5 minutos (`ephemeral_5m_input_tokens`). */
  cacheWrite: number;
  /** Escrita de cache de 1 hora (`ephemeral_1h_input_tokens`) — preço dobrado. */
  cacheWrite1h: number;
  cacheRead: number;
}

/**
 * Teto de tokens de UMA mensagem (BU-08).
 *
 * `asNumber` só exigia `Number.isFinite`, e o único filtro do parser era
 * "a soma dos cinco contadores é maior que zero" — que um par
 * `{-1e12, +1e12+5}` atravessa. O que entrava no banco entrava no upsert que
 * SOMA: um contador negativo COME o consumo real dos outros baldes do mesmo
 * dia, e dois `1e308` viram `Infinity`, que o `JSON.stringify` manda pra UI
 * como `null` num campo tipado `number`.
 *
 * 1e12 tokens numa mensagem é seis ordens de grandeza acima de qualquer
 * janela de contexto real: o que passa disso não é consumo, é payload.
 */
export const MAX_TOKENS_PER_MESSAGE = 1e12;

/** Contador de token do payload já preso na faixa `[0, MAX_TOKENS_PER_MESSAGE]`. */
function count(value: unknown): number {
  return countOrUndefined(value) ?? 0;
}

/** Igual ao `count`, mas distinguindo "ausente" de "zero" (o detalhe de cache). */
function countOrUndefined(value: unknown): number | undefined {
  const n = asNumber(value);
  if (n === undefined) return undefined;
  if (!Number.isFinite(n) || n < 0 || n > MAX_TOKENS_PER_MESSAGE) return 0;
  return n;
}

/**
 * Uma linha crua → `UsageEntry`, ou `undefined` quando ela não conta.
 *
 * Fica de fora: o que não é `type: "assistant"`, o que não tem `usage`, o que
 * não tem chave de dedupe, e o que soma ZERO token nos quatro contadores —
 * este último é a linha sintética que o Claude Code grava quando não houve
 * chamada de API nenhuma (`model: "<synthetic>"`). Contá-la não mudaria número
 * nenhum e ainda acenderia um falso "modelo sem preço".
 */
export function parseUsageLine(line: string): UsageEntry | undefined {
  if (!line.includes('"usage"')) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  if (asString(record.type) !== 'assistant') return undefined;

  const message = asRecord(record.message);
  const usage = asRecord(message.usage);
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);

  // `cache_creation_input_tokens` é a SOMA das duas escritas de cache; o
  // detalhamento por TTL vem em `cache_creation`, quando o modelo o informa.
  // Os dois preços são diferentes (5 min custa 1,25 × input, 1 h custa 2 ×),
  // então tratá-los como uma coluna só subestima a conta — 22,8 % dos tokens
  // de escrita da máquina do autor eram de 1 h. Linha sem o detalhamento
  // (Claude Code mais antigo) conta tudo como 5 min, que é o default.
  const cacheWriteTotal = count(usage.cache_creation_input_tokens);
  const creation = asRecord(usage.cache_creation);
  const write1h = countOrUndefined(creation.ephemeral_1h_input_tokens);
  const write5m = countOrUndefined(creation.ephemeral_5m_input_tokens);
  const cacheWrite1h = write1h ?? 0;
  const cacheWrite =
    write5m ?? (write1h === undefined ? cacheWriteTotal : Math.max(0, cacheWriteTotal - write1h));

  if (input + output + cacheWrite + cacheWrite1h + cacheRead <= 0) return undefined;

  const messageId = asString(message.id);
  const requestId = asString(record.requestId);
  if (!messageId && !requestId) return undefined;

  const timestamp = asString(record.timestamp);
  if (!timestamp) return undefined;

  return {
    key: `${messageId ?? ''}:${requestId ?? ''}`,
    timestamp,
    model: asString(message.model) || 'desconhecido',
    project: asString(record.cwd) ?? '',
    input,
    output,
    cacheWrite,
    cacheWrite1h,
    cacheRead,
  };
}

/** Quanto de UM arquivo é lido por passada. Ver a doc do módulo. */
export const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;

/**
 * Teto de UMA LINHA (BU-01/R1). Acima disso a linha é PULADA.
 *
 * O defeito que isto fecha: `scanTranscript` só avançava o offset até o último
 * `\n` consumido, e não havia teto de linha. Uma primeira linha nova maior que
 * a fatia da passada não tinha `\n` nenhum dentro dela — `consumed` continuava
 * igual a `from`, `truncated` saía `true`, e a passada seguinte relia
 * exatamente os mesmos bytes. Para sempre: 11,3 s na subida, 229 ms a cada
 * 60 s, e TODO consumo daquele arquivo a partir dali deixava de ser contado em
 * silêncio, inclusive as linhas legítimas DEPOIS da gigante. O botão "Reler
 * transcrições" caía no mesmo laço.
 *
 * A regra agora é um invariante: *toda passada sobre um arquivo que cresceu
 * avança o offset*. Linha acima do teto vira `skippedLines` (que sobe até a
 * barra de progresso e o relatório) e o arquivo continua sendo lido da linha
 * seguinte em diante.
 *
 * 4 MiB é o dobro do maior turno real medido — um turno legítimo grande
 * continua contando.
 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Tamanho da fatia entre uma cedência do event loop e a próxima.
 *
 * 256 KB é o número que a revisão pediu pra medir: é grande o bastante pra não
 * virar mil `await` num transcript de 8 MB, e pequeno o bastante pra que o
 * `JSON.parse` das linhas dessa fatia caiba com folga abaixo do orçamento de
 * 20 ms de bloqueio do event loop.
 */
export const CHUNK_BYTES = 256 * 1024;

/** Quantos bytes do começo do arquivo entram na impressão digital. */
export const FINGERPRINT_BYTES = 512;

/**
 * A impressão digital do começo de um transcript, ou `undefined` quando o
 * arquivo ainda é menor que `FINGERPRINT_BYTES`.
 *
 * Existe pra pegar o arquivo REESCRITO (truncado, copiado por cima, rodado)
 * que o `size`/`mtime` sozinhos não denunciam: um transcript é append-only, e
 * os primeiros 512 bytes de um arquivo que só cresce nunca mudam. Arquivo
 * menor que o teto não tem impressão porque ela mudaria a cada linha nova —
 * nesse tamanho o `size < offset` já basta como sinal.
 *
 * **O ponto cego, declarado.** Um arquivo reescrito que mantenha (a) o mesmo
 * tamanho ou um maior que o offset gravado E (b) os mesmos 512 primeiros
 * bytes passa despercebido: os bytes a partir do offset são lidos como se
 * fossem continuação, e o que veio antes deles some da contagem. Na prática
 * isso exige uma reescrita que preserve o cabeçalho da conversa — o Claude
 * Code não faz isso, e um `git checkout` de transcrição também não.
 *
 * O erro que ele produz é sempre para MENOS, nunca para mais: o Bridge deixa
 * de contar linhas que o arquivo novo trouxe antes do offset, e não conta
 * duas vezes as que já contou. Um número menor que o real é o lado seguro
 * de errar num painel de custo, e o botão "Reler transcrições" corrige. Ler o
 * arquivo inteiro pra fechar essa fresta custaria a árvore toda a cada
 * passada — 12,8 GB por minuto na máquina do autor.
 */
export async function fingerprint(path: string, size: number): Promise<string | undefined> {
  if (size < FINGERPRINT_BYTES) return undefined;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(FINGERPRINT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FINGERPRINT_BYTES, 0);
    if (bytesRead < FINGERPRINT_BYTES) return undefined;
    return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface ScanOptions {
  /** Byte de onde começar (o `offset` gravado). */
  from?: number;
  /**
   * A última chave de dedupe da passada anterior. A `Set` de dedupe é POR
   * PASSADA (guardar todas as chaves de todos os arquivos custaria memória
   * proporcional ao histórico inteiro), então o único duplicado que
   * atravessaria a fronteira do offset é o vizinho imediato — e é justamente
   * ele que isto corta.
   */
  lastKey?: string;
  maxBytes?: number;
  /** Injetável pro teste do teto de linha; o default é `MAX_LINE_BYTES`. */
  maxLineBytes?: number;
  /** Injetável pro teste medir a cedência; o default é `setImmediate`. */
  yieldToLoop?: () => Promise<void>;
}

export interface ScanResult {
  entries: UsageEntry[];
  /** Onde a próxima passada começa: o byte logo depois do último `\n` consumido. */
  offset: number;
  /** A chave da última entrada aceita, pra gravar em `usage_files.last_id`. */
  lastKey?: string;
  /** Sobrou arquivo além do teto desta passada — vale chamar de novo. */
  truncated: boolean;
  /**
   * Linhas descartadas por passarem de `MAX_LINE_BYTES` (BU-01/R1). Sai daqui,
   * é somado no `usage_files` daquele arquivo e aparece no progresso e no
   * relatório: uma contagem que ficou menor que a real tem que dizer isso.
   */
  skippedLines: number;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Lê o pedaço novo de um transcript e devolve as entradas dele, já
 * deduplicadas dentro da passada.
 *
 * ASSÍNCRONA e fatiada: entre um `CHUNK_BYTES` e o próximo o event loop volta
 * a rodar, então os PTYs continuam fluindo mesmo durante a varredura inicial
 * do histórico inteiro.
 *
 * Arquivo ilegível/sumido devolve o resultado vazio com o offset intacto: a
 * varredura de uso é pano de fundo e não pode derrubar nada.
 */
export async function scanTranscript(path: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const from = Math.max(0, opts.from ?? 0);
  const maxBytes = opts.maxBytes ?? MAX_BYTES_PER_PASS;
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const yieldToLoop = opts.yieldToLoop ?? defaultYield;
  const entries: UsageEntry[] = [];
  const seen = new Set<string>();
  if (opts.lastKey) seen.add(opts.lastKey);
  let lastKey = opts.lastKey;

  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return { entries, offset: from, lastKey, truncated: false, skippedLines: 0 };
    size = info.size;
  } catch {
    return { entries, offset: from, lastKey, truncated: false, skippedLines: 0 };
  }
  if (size <= from) return { entries, offset: from, lastKey, truncated: false, skippedLines: 0 };

  const limit = Math.min(size - from, maxBytes);
  const truncated = size - from > maxBytes;

  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { entries, offset: from, lastKey, truncated: false, skippedLines: 0 };
  }

  // `pending` guarda a cauda sem `\n` entre um chunk e o próximo; `consumed`
  // anda só até o fim da ÚLTIMA linha completa — é ele que vira o offset.
  let pending = '';
  let consumed = from;
  let skippedLines = 0;
  // Estamos DENTRO de uma linha que passou do teto: tudo até o próximo `\n` é
  // descartado, e os bytes descartados contam como consumidos (é isso que
  // impede o livelock do BU-01).
  let skipping = false;

  /**
   * Esvazia o `pending`: consome as linhas completas e, se o resto sozinho já
   * passou de `maxLineBytes`, entra em modo "pulando linha".
   *
   * O laço é necessário: sair do modo de pulo pode revelar linhas completas
   * logo atrás, que precisam ser processadas na mesma volta.
   */
  function drain(): void {
    for (;;) {
      if (skipping) {
        const nl = pending.indexOf('\n');
        if (nl === -1) {
          // A linha gigante continua; o pedaço lido é jogado fora, mas o
          // offset ANDA por cima dele.
          consumed += Buffer.byteLength(pending, 'utf8');
          pending = '';
          return;
        }
        consumed += Buffer.byteLength(pending.slice(0, nl + 1), 'utf8');
        pending = pending.slice(nl + 1);
        skipping = false;
        continue;
      }

      const nl = pending.lastIndexOf('\n');
      if (nl !== -1) {
        const complete = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        // Bytes, não caracteres: o offset é uma posição no ARQUIVO, e um
        // acento em UTF-8 ocupa dois. Contar `length` deixaria o offset
        // atrasado e a passada seguinte releria (e recontaria) linhas.
        consumed += Buffer.byteLength(complete, 'utf8') + 1;

        for (const line of complete.split('\n')) {
          // O teto vale pra linha COMPLETA também, e não só pra que não cabe
          // na fatia: uma linha de 6 MiB com quebra no fim não travava o
          // offset, mas custava um `JSON.parse` de 6 MiB dentro do processo
          // que hospeda os PTYs. `length` em caracteres nunca passa do
          // tamanho em bytes, então este teste só descarta o que de fato
          // estourou o teto.
          if (line.length > maxLineBytes) {
            skippedLines += 1;
            continue;
          }
          const entry = parseUsageLine(line);
          if (!entry) continue;
          if (seen.has(entry.key)) continue;
          seen.add(entry.key);
          entries.push(entry);
          lastKey = entry.key;
        }
      }

      // O que sobrou é UMA linha ainda sem `\n`. Passou do teto: descarta,
      // conta, e segue pulando até achar a quebra.
      if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) {
        skippedLines += 1;
        consumed += Buffer.byteLength(pending, 'utf8');
        pending = '';
        skipping = true;
        continue;
      }
      return;
    }
  }

  try {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit));
    // `StringDecoder` e não `Buffer.toString`: um caractere multibyte cortado
    // na fronteira do chunk viraria `�` e quebraria o `JSON.parse` da linha
    // inteira — o decoder segura os bytes incompletos até o próximo.
    const decoder = new StringDecoder('utf8');
    let position = from;
    const end = from + limit;
    while (position < end) {
      const want = Math.min(buffer.length, end - position);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));

      drain();

      // A cedência fica DEPOIS do parse da fatia, e não antes: é o parse que
      // custa, e o ponto é devolver o event loop assim que ele termina.
      if (position < end) await yieldToLoop();
    }
  } catch {
    // Leitura interrompida no meio: fica valendo o que já foi consumido.
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { entries, offset: consumed, lastKey, truncated, skippedLines };
}

/** `<projeto>` a partir de um caminho de transcript — só pro log de diagnóstico. */
export function transcriptLabel(home: string, path: string): string {
  const root = projectsDir(home) + sep;
  return path.startsWith(root) ? path.slice(root.length) : path;
}
