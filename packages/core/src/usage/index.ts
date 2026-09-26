/**
 * O monitor de uso do Bridge (ADR-012) — a peça que junta transcripts,
 * preços, banco e janelas de limite numa única superfície.
 *
 * Quem consome: o `usagePoller` (varredura periódica), o hook `StatusLine`
 * (janelas vivas + a linha devolvida ao terminal), as rotas `/api/usage*` e a
 * CLI. Ninguém mais fala com `transcripts.ts`/`aggregate.ts` direto.
 *
 * O que ele **não** guarda: conteúdo de mensagem. A varredura lê o transcript,
 * soma tokens por dia × modelo × projeto (`cwd`) × origem e joga o resto fora.
 */
import type {
  Language,
  QuotaSnapshot,
  UsageConfig,
  UsageLimitWindow,
  UsagePeriodQuery,
  UsageRange,
  UsageReport,
  UsageScanProgress,
} from '@bridge/shared';
import { MIN_USAGE_DAY, settleLimits } from '@bridge/shared';
import type { Db, UsageDailyRow } from '../db.js';
import type { Logger } from '../log.js';
import {
  NO_PROJECT_BUCKET,
  chartBounds,
  localDay,
  processTimeZone,
  resolvePeriod,
  summarize,
  type PeriodQuery,
  type PeriodResolution,
} from './aggregate.js';
import { LIMITS_EMIT_MS, limitsChanged, limitsFromRateLimits, sortWindows } from './limits.js';
import { shouldEmitProgress, startProgress } from './progress.js';
import { costOf, priceFor, resolvePricing, type PricingTable } from './pricing.js';
import {
  claudeHome as resolveClaudeHome,
  fingerprint,
  listTranscripts,
  MAX_LINE_BYTES,
  MAX_TRANSCRIPT_FILES,
  scanTranscript,
  transcriptLabel,
  type TranscriptFile,
  type UsageEntry,
  type UsageSource,
} from './transcripts.js';

export interface UsageOptions {
  db: Db;
  log: Logger;
  /** A configuração VIVA (`profile.config.usage`) — lida a cada uso, não copiada. */
  config: () => UsageConfig;
  /**
   * O idioma VIVO (`core.language()`), pelo mesmo motivo do `config`: os
   * rótulos de janela e os avisos de preço são texto de gente (spec §13) e
   * têm que sair no idioma do instante em que a resposta é montada.
   */
  language: () => Language;
  /** Raiz dos transcripts. O default é `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. */
  claudeHome?: string;
  /** Injetável pro teste; o default é o fuso do processo. */
  timeZone?: string;
  /** Injetável pro teste da janela de reconstrução; o default é `Date.now`. */
  now?: () => number;
  /**
   * Chamado quando o progresso da varredura muda o bastante pra virar evento
   * (ver `progress.ts`: começo e fim sempre, no meio no máximo 1/s). Quem
   * conecta isto ao `usage.changed` é o `createCore`.
   */
  onProgress?: (progress: UsageScanProgress) => void;
  /** Injetável pro teste do estrangulamento do progresso. */
  progressIntervalMs?: number;
  /**
   * Chamado quando as janelas de limite mudam e o estrangulador de 1/s deixa
   * (BU-14). Quem conecta isto ao `usage.changed { limits }` é o `createCore`;
   * é por aqui que sai a foto ATRASADA da última mudança engolida.
   */
  onLimits?: (limits: UsageLimitWindow[]) => void;
  /** Injetável pro teste do estrangulamento dos limites. */
  limitsIntervalMs?: number;
}

export interface ScanResult {
  /** Dias LOCAIS cujo consumo mudou — vira `usage.changed.dailyTouched`. */
  dailyTouched: string[];
  /** Arquivos efetivamente lidos nesta passada. */
  filesScanned: number;
  /** Entradas novas contabilizadas. */
  entries: number;
  /**
   * Linhas descartadas por passarem do teto de linha (BU-01/R1). Zero é o
   * normal; acima disso a contagem desta passada é MENOR que o consumo real.
   */
  skippedLines: number;
  /** Algum arquivo bateu no teto da passada e tem mais pra ler. */
  more: boolean;
  /**
   * Esta passada foi uma reconstrução do zero (o `rescan`, ou o disparo
   * automático de um transcript reescrito).
   */
  rebuilt: boolean;
}

export interface Usage {
  /** Onde os transcripts são lidos (caminho absoluto). */
  readonly home: string;
  /** A tabela de preços em vigor. */
  pricing(): PricingTable;
  /** Problemas da tabela (arquivo ausente, entrada inválida) — entram em `pricingWarnings`. */
  pricingWarnings(): string[];
  /** Data dos preços em vigor — vai pra resposta em `pricingAsOf`. */
  pricingAsOf(): string;
  /** Relê `usage.pricingFile`/`usage.pricing` (subida, `PATCH /api/config`, rescan). */
  reloadPricing(): void;
  /**
   * Uma passada incremental. Chamada com uma varredura JÁ EM VOO, devolve a
   * promessa dela em vez de começar outra — duas varreduras concorrentes
   * somariam os mesmos deltas duas vezes (a revisão mediu 1,67× no rescan
   * clicado duas vezes).
   */
  scan(): Promise<ScanResult>;
  /**
   * Zera contagens e marcadores e relê tudo (`POST /api/usage/rescan`). Espera
   * a varredura em voo antes de zerar — apagar o banco embaixo dela
   * reintroduziria as linhas que ela ainda ia gravar.
   */
  rescan(): Promise<ScanResult>;
  /**
   * O progresso da varredura em voo — ou o da última, com `active: false`.
   * `null` enquanto nenhuma começou. Vai pro corpo de `GET /api/usage`.
   */
  scanning(): UsageScanProgress | null;
  /** Há uma reconstrução (`rescan`) em voo agora — o 409 da rota (BU-07). */
  rescanning(): boolean;
  /** As janelas de limite conhecidas. */
  limits(): UsageLimitWindow[];
  /**
   * Grava as janelas que vieram num payload de statusline. Devolve a lista
   * nova quando algo MUDOU (o chamador emite `usage.changed`), `undefined`
   * quando é a mesma foto — a statusline é redesenhada várias vezes por
   * segundo e não pode virar um evento por redesenho.
   *
   * Payload SEM `rate_limits` limpa as janelas e devolve `[]`: ver a
   * implementação.
   */
  noteLimits(quota: QuotaSnapshot): UsageLimitWindow[] | undefined;
  /** O corpo de `GET /api/usage`. */
  /**
   * Valida uma query de período (`range`/`anchor`/`from`/`to`) contra o hoje
   * do fuso — é o que a rota usa pra responder 400 antes de montar relatório.
   */
  period(query: PeriodQuery, opts?: { tz?: string; now?: number }): PeriodResolution;
  /**
   * O relatório de um período: o recorte cru (`'month'` = o de hoje) ou a
   * query inteira. Query inválida LANÇA — a validação com resposta é `period`.
   */
  report(request: UsageRange | UsagePeriodQuery, opts?: { tz?: string; now?: number }): UsageReport;
  /**
   * Encerra: a varredura em voo para no PRÓXIMO arquivo em vez de ir até o
   * fim. Sem isto, o `core.stop()` esperava a varredura inteira do histórico
   * antes de apagar o `instance.json` — um encerramento gracioso de segundos
   * virava minutos na primeira subida.
   */
  stop(): void;
}

/**
 * Quantos arquivos a varredura processa em paralelo.
 *
 * Agora que a leitura é assíncrona (`fs.promises` + cedência entre fatias) os
 * dois trabalhadores de fato se intercalam: enquanto um espera o disco, o
 * outro decodifica. Dois, e não mais, pra não brigar por disco com o agente
 * que está escrevendo o transcript ao lado.
 */
export const SCAN_CONCURRENCY = 2;

/**
 * Janela mínima entre duas reconstruções automáticas (transcript reescrito).
 * Um arquivo que alguém fica regravando não pode fazer o core reler o
 * histórico inteiro a cada minuto.
 */
export const REBUILD_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Primeiro dia que o monitor aceita de um carimbo de transcript (BU-17). O
 * Claude Code não existia antes disso; um dia anterior é carimbo inventado.
 * Mora no `@bridge/shared` desde que `anchor`/`from` da rota passaram a ser
 * cobrados contra ele também — e a UI precisa do número pro `min` do campo de
 * data. O re-export mantém quem importava daqui.
 */
export { MIN_USAGE_DAY };

/**
 * Folga pro carimbo no FUTURO: dois dias. Cobre relógio adiantado e fuso
 * exótico sem aceitar o ano 275760.
 */
export const DAY_FUTURE_SLACK_MS = 2 * 24 * 3600 * 1000;

/**
 * Janela mínima entre dois `POST /api/usage/rescan` (BU-07). O custo de um
 * rescan é proporcional ao HISTÓRICO inteiro (12,8 GB na máquina do autor),
 * não ao pedido — é o que separa este caso do "sem rate limit genérico de
 * rota" que o `SECURITY.md` aceita.
 */
export const RESCAN_COOLDOWN_MS = 30 * 1000;

export function createUsage(opts: UsageOptions): Usage {
  const { db, log } = opts;
  const home = opts.claudeHome ?? resolveClaudeHome();
  const usageLog = log.child('usage');
  const defaultTz = opts.timeZone ?? processTimeZone();
  const clock = opts.now ?? Date.now;

  let pricing: PricingTable = {};
  let warnings: string[] = [];
  let asOf = '';
  function reloadPricing(): void {
    const resolved = resolvePricing(opts.config(), opts.language());
    pricing = resolved.table;
    warnings = resolved.warnings;
    asOf = resolved.asOf;
    for (const warning of warnings) usageLog.warn(warning);
  }
  reloadPricing();

  /** Última foto das janelas, em memória, pra decidir se `usage.changed` sai. */
  let lastLimits: UsageLimitWindow[] = sortWindows(db.usage.limits(opts.language()));

  /** O core está encerrando: a varredura desiste na fronteira do próximo arquivo. */
  let stopped = false;

  /**
   * A varredura em voo. Existe pra que `scan()` e `rescan()` compartilhem UM
   * guarda: sem ele, o poller e o botão "Reler transcripts" liam os mesmos
   * bytes ao mesmo tempo, e o upsert que SOMA transformava isso em consumo
   * inflado (1,67× na medição da revisão).
   */
  let inFlight: Promise<ScanResult> | undefined;
  /** A reconstrução pedida e ainda não concluída — no máximo uma na fila. */
  let pendingRebuild: Promise<ScanResult> | undefined;
  /** Quando a última reconstrução automática rodou (janela de `REBUILD_COOLDOWN_MS`). */
  let lastAutoRebuildAt = 0;

  /**
   * Estrangulador do `usage.changed { limits }` (BU-14): quando o último saiu,
   * e a foto que ficou esperando o fim da janela de 1 s.
   */
  let lastLimitsEmit = 0;
  let pendingLimits: UsageLimitWindow[] | undefined;
  let limitsTimer: NodeJS.Timeout | undefined;

  /** Avisa UMA vez por core que um payload trouxe janelas demais (BU-06). */
  let warnedWindowsDropped = false;

  /** O progresso da varredura: `null` até a primeira começar. */
  let progress: UsageScanProgress | null = null;
  /** A última foto que virou evento, com o carimbo — o estrangulador de 1/s. */
  let lastProgressEmit: { at: number; progress: UsageScanProgress } | undefined;

  /** Grava o progresso e emite se a regra de `progress.ts` deixar. */
  function publishProgress(next: UsageScanProgress): void {
    progress = next;
    if (!opts.onProgress) return;
    const now = clock();
    if (!shouldEmitProgress(lastProgressEmit, next, now, opts.progressIntervalMs)) return;
    lastProgressEmit = { at: now, progress: next };
    opts.onProgress(next);
  }

  /**
   * As entradas de um arquivo viram deltas de `usage_daily`. O dia é o LOCAL
   * do carimbo (decisão do dono); carimbo ilegível é descartado em vez de cair
   * num dia inventado. A ORIGEM é do arquivo (conversa principal ou
   * subagente); o PROJETO é o `cwd` de cada linha, que num subagente pode ser
   * outro que o da sessão que o lançou.
   */
  function foldEntries(entries: UsageEntry[], source: UsageSource, tz: string): { deltas: UsageDailyRow[]; days: Set<string> } {
    const buckets = new Map<string, UsageDailyRow>();
    const days = new Set<string>();
    // BU-17: `"+275760-09-13T00:00:00.000Z"` é um carimbo VÁLIDO pro `Date`, e
    // virava chave primária em `usage_daily` — uma linha que nenhum recorte
    // alcança (a comparação é de string) e que só sai com `db.usage.reset()`.
    const maxDay = localDay(clock() + DAY_FUTURE_SLACK_MS, tz);
    for (const entry of entries) {
      const day = localDay(entry.timestamp, tz);
      if (!day) continue;
      if (day < MIN_USAGE_DAY || (maxDay !== undefined && day > maxDay)) continue;
      // SENTINELA, não copy: este valor vai pro banco. Ver `bucketLabel`.
      const project = entry.project || NO_PROJECT_BUCKET;
      const key = `${day} ${entry.model} ${project} ${source}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          day,
          model: entry.model,
          project,
          source,
          input: 0,
          output: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          cost: null,
          messages: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.input += entry.input;
      bucket.output += entry.output;
      bucket.cacheWrite += entry.cacheWrite;
      bucket.cacheWrite1h += entry.cacheWrite1h;
      bucket.cacheRead += entry.cacheRead;
      bucket.messages += 1;
      days.add(day);
    }

    for (const bucket of buckets.values()) {
      const price = priceFor(pricing, bucket.model);
      // `cost` fica `null` pro modelo sem preço: a coluna é um retrato do que
      // se sabia na varredura, e `0` seria uma afirmação falsa. Quem responde
      // a API recalcula com a tabela em vigor (ver `report`). `costOf` também
      // devolve `undefined` pra conta não finita (BU-02), e isso cai no mesmo
      // `null`: um `NaN` gravado vira `NULL` na coluna REAL de qualquer jeito,
      // mas por este caminho ele não contamina o total antes.
      bucket.cost = price ? (costOf(price, bucket) ?? null) : null;
    }
    return { deltas: [...buckets.values()], days };
  }

  /** Cede o event loop: a varredura roda no processo que hospeda as sessões. */
  function yieldToLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Uma passada de verdade. Nunca chamada direto: quem entra aqui passou pelo
   * guarda de `startScan`.
   */
  async function runScan(full: boolean): Promise<ScanResult> {
    const tz = defaultTz;
    if (stopped) {
      return { dailyTouched: [], filesScanned: 0, entries: 0, skippedLines: 0, more: false, rebuilt: full };
    }
    // A LISTAGEM é assíncrona e cede o event loop a cada 500 entradas
    // (BU-05/R5): era ela, e não a leitura, que segurava o core por 3,78 s
    // numa árvore de 50 000 arquivos — a cada passada do poller.
    const { files, capped } = await listTranscripts(home, { shouldStop: () => stopped });
    if (capped) {
      usageLog.warn('há mais transcrições que o teto da varredura; o excedente ficou de fora desta passada', {
        teto: MAX_TRANSCRIPT_FILES,
      });
    }
    const touched = new Set<string>();
    let filesScanned = 0;
    let entryCount = 0;
    let skippedLines = 0;
    let more = false;
    /** Transcript reescrito por fora — o que dispara a reconstrução (ver abaixo). */
    let rewritten: string | undefined;

    // O progresso conta TODO arquivo da passada, inclusive o que ela pula por
    // já estar lido: quem olha a barra quer saber quanto falta pro fim da
    // varredura, não quantos arquivos tiveram bytes novos.
    const filesTotal = files.length;
    const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
    let filesDone = 0;
    let bytesDone = 0;
    publishProgress({ ...startProgress(filesTotal, bytesTotal), ...(capped ? { capped: true } : {}) });

    let next = 0;
    async function worker(): Promise<void> {
      for (;;) {
        // Fronteira de arquivo é o ponto de parada: o que já foi lido está
        // gravado (contagem + offset), então desistir aqui não perde nada.
        if (stopped) return;
        const index = next++;
        const file = files[index];
        if (!file) return;

        await handleFile(file);
        filesDone += 1;
        bytesDone += file.size;
        publishProgress({
          active: true,
          filesDone,
          filesTotal,
          bytesDone,
          bytesTotal,
          skippedLines,
          ...(capped ? { capped: true } : {}),
        });
      }
    }

    /**
     * Um arquivo. Extraída do laço pra que o progresso ande em TODA saída —
     * inclusive nas duas que não leem byte nenhum (arquivo reescrito, arquivo
     * sem nada além do offset). Com os `continue` soltos no laço, a barra
     * pulava esses arquivos e travava perto do fim.
     */
    async function handleFile(file: TranscriptFile): Promise<void> {
    const stored = full ? undefined : db.usage.fileState(file.path);
    const head = await fingerprint(file.path, file.size);
    const from = stored?.offset ?? 0;
    const lastKey = stored?.lastId;

    if (stored) {
      // O arquivo foi REESCRITO (truncado, copiado por cima, rodado): ou
      // encolheu abaixo de onde paramos, ou os primeiros bytes mudaram —
      // e num arquivo append-only eles nunca mudam.
      //
      // Não dá pra "desfazer" a contribuição dele: `usage_daily` é
      // agregada por dia × modelo × projeto × origem, não por arquivo, e
      // guardar a contribuição de cada arquivo pra poder subtraí-la
      // custaria uma tabela do tamanho do histórico pra atender um caso
      // que quase não acontece. A saída correta e barata é RECONSTRUIR
      // tudo, uma vez por hora no máximo (`REBUILD_COOLDOWN_MS`).
      //
      // O arquivo é PULADO nesta passada, de propósito: relê-lo do zero
      // sem zerar o banco antes seria justamente somar duas vezes o que
      // ele já tinha contribuído. Quem o lê do começo é a reconstrução,
      // logo abaixo — e quando ela está em cooldown, o número dele fica
      // parado (velho) em vez de virar um número inflado (errado).
      const shrank = file.size < stored.offset;
      const changedHead = head !== undefined && stored.headHash !== undefined && head !== stored.headHash;
      if (shrank || changedHead) {
        rewritten ??= transcriptLabel(home, file.path);
        return;
      }
      if (file.size <= stored.offset && file.mtimeMs <= stored.mtime) {
        // Nada além de onde paramos e nenhuma escrita desde então: não há
        // o que ler. (Só `size > offset` não bastaria — a diferença pode
        // ser a linha parcial que já estava lá na passada anterior.)
        return;
      }
    }

    const result = await scanTranscript(file.path, { from, lastKey });
    filesScanned += 1;
    if (result.truncated) more = true;
    // BU-01/R1: UMA linha do arquivo passou do teto e foi pulada. O aviso sai
    // uma vez por arquivo (a passada seguinte já começa depois dela, então não
    // se repete), e o número sobe até a barra de progresso e o relatório — uma
    // contagem menor que a real não pode ficar em silêncio.
    if (result.skippedLines > 0) {
      skippedLines += result.skippedLines;
      usageLog.warn('linha de transcrição maior que o teto; ela não conta no consumo', {
        path: file.path,
        linhas: result.skippedLines,
        teto: MAX_LINE_BYTES,
      });
    }

    const { deltas, days } = foldEntries(result.entries, file.source, tz);
    entryCount += result.entries.length;
    try {
      db.usage.addDaily(deltas);
      db.usage.setFileState({
        path: file.path,
        size: file.size,
        mtime: file.mtimeMs,
        offset: result.offset,
        lastId: result.lastKey,
        headHash: head,
        // Acumulado, não substituído: o arquivo pode ter mais de uma linha
        // gigante ao longo da vida, e a linha do banco é o histórico dele.
        skippedLines: (stored?.skippedLines ?? 0) + result.skippedLines,
      });
    } catch (err) {
      // Banco travado (WAL em uso, disco cheio): a passada seguinte tenta
      // de novo a partir do MESMO offset, então nada é perdido.
      usageLog.warn('falhou ao gravar o consumo de um transcript', { path: file.path, err });
      return;
    }
    for (const day of days) touched.add(day);
    await yieldToLoop();
  }

    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, files.length)) }, worker));
    // O `active: false` sai SEMPRE (a regra de emissão não o estrangula): é ele
    // que apaga o "ainda lendo as transcrições" da tela.
    publishProgress({
      active: false,
      filesDone,
      filesTotal,
      bytesDone,
      bytesTotal,
      skippedLines,
      ...(capped ? { capped: true } : {}),
    });
    const result: ScanResult = {
      dailyTouched: [...touched].sort(),
      filesScanned,
      entries: entryCount,
      skippedLines,
      more,
      rebuilt: full,
    };

    // A reconstrução vem DEPOIS da passada, e não no meio dela: interromper a
    // varredura no arquivo N deixaria os outros pela metade.
    if (rewritten !== undefined && !full && !stopped) {
      const since = clock() - lastAutoRebuildAt;
      if (since >= REBUILD_COOLDOWN_MS) {
        usageLog.warn('transcript reescrito por fora; reconstruindo a contagem do zero', { transcript: rewritten });
        lastAutoRebuildAt = clock();
        return rebuild();
      }
      usageLog.warn(
        // i18n-ignore: linha de log, quebrada em duas — o guard só reconhece a
        // chamada de log quando o literal começa na MESMA linha dela.
        'transcript reescrito por fora, mas a última reconstrução foi há pouco; ' + // i18n-ignore
          'a contagem pode estar inflada até a próxima (ou use "Reler transcrições")', // i18n-ignore
        { transcript: rewritten },
      );
    }
    return result;
  }

  /** Zera e relê. Só entra aqui quem já é dono do guarda. */
  async function rebuild(): Promise<ScanResult> {
    db.usage.reset();
    reloadPricing();
    return runScan(true);
  }

  function startScan(full: boolean): Promise<ScanResult> {
    const promise = (async () => {
      try {
        return full ? await rebuild() : await runScan(false);
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = promise;
    return promise;
  }

  function scan(): Promise<ScanResult> {
    return inFlight ?? startScan(false);
  }

  function rescan(): Promise<ScanResult> {
    if (pendingRebuild) return pendingRebuild;
    const promise = (async () => {
      try {
        // Espera a varredura em voo TERMINAR antes de zerar: um `reset()` no
        // meio dela apagaria as linhas já gravadas e deixaria as que ela ainda
        // vai gravar — o pior dos dois mundos.
        while (inFlight) await inFlight.catch(() => undefined);
        return await startScan(true);
      } finally {
        pendingRebuild = undefined;
      }
    })();
    pendingRebuild = promise;
    return promise;
  }

  /**
   * As janelas como estão AGORA: a última foto do banco, com `resets_at`
   * vencido virando 0 % (`settleLimits`, 16/09/2026). É o que `GET
   * /api/usage/limits`, o `hello` e o `bridge usage` mostram — e o que a
   * sidebar desenha fixo, mesmo com todos os Claudes ociosos.
   */
  function limits(): UsageLimitWindow[] {
    return settleLimits(sortWindows(db.usage.limits(opts.language())), clock());
  }

  /**
   * Entrega a foto das janelas ao `onLimits`, no máximo uma por
   * `LIMITS_EMIT_MS` — e a ÚLTIMA sempre, nem que com atraso (BU-14).
   *
   * Devolve o que `noteLimits` responde ao chamador: a lista quando ela sai
   * agora, `undefined` quando ela foi agendada. Sem `onLimits` configurado o
   * comportamento antigo vale inteiro (quem emite é quem chamou).
   */
  function emitLimits(next: UsageLimitWindow[]): UsageLimitWindow[] | undefined {
    if (!opts.onLimits) return next;
    const interval = opts.limitsIntervalMs ?? LIMITS_EMIT_MS;
    const now = clock();
    if (now - lastLimitsEmit >= interval) {
      lastLimitsEmit = now;
      pendingLimits = undefined;
      return next;
    }
    pendingLimits = next;
    if (limitsTimer === undefined) {
      limitsTimer = setTimeout(() => {
        limitsTimer = undefined;
        const foto = pendingLimits;
        pendingLimits = undefined;
        if (!foto || stopped) return;
        lastLimitsEmit = clock();
        opts.onLimits?.(foto);
      }, Math.max(1, interval - (now - lastLimitsEmit)));
      // O core não pode ficar de pé por causa deste timer.
      limitsTimer.unref?.();
    }
    return undefined;
  }

  /**
   * Payload SEM `rate_limits` NÃO apaga as janelas (16/09/2026).
   *
   * Até aqui ele apagava depois de dez minutos de carência, pensando na troca
   * de assinatura por chave de API. Só que o Claude Code omite `rate_limits`
   * sempre que não tem resposta recente da API — ou seja, em TODO Claude
   * ocioso — e as barras da sidebar sumiam a cada pausa do dono e voltavam no
   * primeiro turno seguinte. A foto congelada que a regra antiga temia é
   * resolvida no outro lado: `limits()` devolve 0 % pra janela cujo
   * `resets_at` já passou (`settleLimits`). O custo assumido: quem troca a
   * conta por chave de API fica com barras em 0 % em vez de barra nenhuma.
   */
  function noteLimits(quota: QuotaSnapshot): UsageLimitWindow[] | undefined {
    // BU-06: um payload com 1 000 janelas não é erro do dono nem da conta — é
    // payload. O teto já foi aplicado em `quotaFromPayload`; aqui o aviso sai
    // UMA vez por core, pra o log não virar uma linha por statusline.
    if (quota.windowsDropped && !warnedWindowsDropped) {
      warnedWindowsDropped = true;
      usageLog.warn('payload de statusline com janelas de limite demais; o excedente foi ignorado', {
        descartadas: quota.windowsDropped,
      });
    }
    if (quota.rateLimits.length === 0) return undefined;
    const next = limitsFromRateLimits(quota.rateLimits, quota.at, opts.language());
    if (!limitsChanged(lastLimits, next)) return undefined;
    db.usage.setLimits(next);
    lastLimits = next;
    return emitLimits(next);
  }

  /** O dia LOCAL de hoje no fuso pedido — a âncora default e o teto dos períodos. */
  function todayIn(tz: string, now: number): string {
    return localDay(now, tz) ?? localDay(now, 'UTC') ?? '1970-01-01';
  }

  /**
   * Valida uma query de período (`range`/`anchor`/`from`/`to`) contra o hoje
   * do fuso pedido. É o que a rota chama ANTES do relatório pra responder 400
   * com a chave certa; a regra em si é a pura `resolvePeriod`.
   */
  function period(query: PeriodQuery, periodOpts: { tz?: string; now?: number } = {}): PeriodResolution {
    return resolvePeriod(query, todayIn(periodOpts.tz ?? defaultTz, periodOpts.now ?? clock()));
  }

  /**
   * O relatório de um período. Aceita o recorte cru (`'month'` = o mês de
   * hoje, o contrato antigo) ou a query inteira (`{ range: 'month', anchor }`,
   * `{ range: 'custom', from, to }`).
   *
   * Query inválida aqui é ERRO de quem chamou: a rota valida com `period()`
   * antes e responde 400; chegar com lixo direto no serviço é bug, e um
   * relatório silenciosamente "de hoje" no lugar do pedido esconderia o bug.
   */
  function report(request: UsageRange | UsagePeriodQuery, reportOpts: { tz?: string; now?: number } = {}): UsageReport {
    const tz = reportOpts.tz ?? defaultTz;
    const now = reportOpts.now ?? clock();
    const today = todayIn(tz, now);
    const resolved = resolvePeriod(typeof request === 'string' ? { range: request } : request, today);
    if (!resolved.ok) throw new Error(resolved.code);
    const bounds = resolved.period;
    // A série termina em min(to, hoje); ver `chartBounds` pra regra do começo.
    const chart = chartBounds(bounds, today);

    // Uma consulta só, cobrindo a união das duas janelas: a série pode ser
    // mais larga que o recorte (dia, semana, mês corrente) e o recorte pode
    // passar de hoje (o fim do mês civil) — a união é o que as duas precisam.
    const from = chart.from < bounds.from ? chart.from : bounds.from;
    const to = chart.to > bounds.to ? chart.to : bounds.to;
    const all = db.usage.daily(from, to);
    const rows = all.filter((row) => row.day >= bounds.from && row.day <= bounds.to);

    const summary = summarize({ rows, chartRows: all, chart, pricing, lang: opts.language() });
    return {
      range: bounds.range,
      ...(bounds.anchor !== undefined ? { anchor: bounds.anchor } : {}),
      today,
      from: bounds.from,
      to: bounds.to,
      chartFrom: chart.from,
      chartTo: chart.to,
      tz,
      totals: summary.totals,
      bySource: summary.bySource,
      byDay: summary.byDay,
      byModel: summary.byModel,
      byProject: summary.byProject,
      limits: limits(),
      pricingWarnings: [...warnings, ...summary.pricingWarnings],
      pricingAsOf: asOf,
      claudeHome: home,
      scannedFiles: db.usage.fileCount(),
      scanning: progress,
    };
  }

  return {
    home,
    pricing: () => pricing,
    pricingWarnings: () => [...warnings],
    pricingAsOf: () => asOf,
    reloadPricing,
    scan,
    rescan,
    scanning: () => progress,
    rescanning: () => pendingRebuild !== undefined,
    limits,
    noteLimits,
    period,
    report,
    stop(): void {
      stopped = true;
      if (limitsTimer !== undefined) {
        clearTimeout(limitsTimer);
        limitsTimer = undefined;
      }
      pendingLimits = undefined;
    },
  };
}
