import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { QuotaSnapshot, RateLimitWindow } from './model.js';
import { asBoolean, asNumber, asRecord, asString } from './adapters/payload.js';
import { formatTokens, formatUsd, sanitizeDisplay, t, type Language } from '@bridge/shared';
import { MAX_RESET_AHEAD_MS, clampPct, formatReset, sortWindows, windowLabel } from './usage/limits.js';

/**
 * Teto de tamanho do transcript: acima disso o arquivo é ignorado (BR-08).
 * O statusline é chamado várias vezes por SEGUNDO durante o turno, e um
 * `readFileSync` síncrono de um arquivo de GB trava o event loop do core —
 * que hospeda TODAS as sessões — quando não o derruba por OOM.
 */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Quanto do FIM do arquivo é lido. A função varre de trás pra frente atrás da
 * última linha com `"usage"`; o começo do transcript nunca é usado.
 */
export const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/**
 * O `transcript_path` vem do PAYLOAD do hook, ou seja, de quem chamar
 * `/hooks/<id>/StatusLine` — não do dono. Sem forma exigida, era leitura de
 * arquivo arbitrário do usuário (`~/.ssh/id_ed25519`, `C:\pagefile.sys`).
 * O Claude Code sempre manda um caminho ABSOLUTO de `.jsonl`.
 */
export function isTranscriptPath(path: string): boolean {
  if (!path.toLowerCase().endsWith('.jsonl')) return false;
  // Re-review: caminho UNC (`\\servidor\share\x.jsonl`, e o `\\?\`/`\\.\` que
  // chegam ao driver direto) é "absoluto" pro Node, mas fazer o core abrir um
  // share de rede escolhido por um payload de hook é I/O bloqueante contra um
  // host de terceiro — o oposto do que o teto de tamanho existe pra evitar.
  if (path.startsWith('\\\\') || path.startsWith('//')) return false;
  // No Windows, só caminho com LETRA DE UNIDADE (`C:\…`). Fora do Windows vale
  // o absoluto POSIX de sempre — os testes do módulo rodam nos dois.
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path);
  return isAbsolute(path);
}

/** Lê no máximo os últimos `TRANSCRIPT_TAIL_BYTES` do arquivo, sem carregar o resto. */
function readTail(path: string, size: number): string {
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const position = Math.max(0, size - length);
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function contextFromTranscript(path: string): number {
  if (!isTranscriptPath(path)) return 0;
  if (!existsSync(path)) return 0;
  let content: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > TRANSCRIPT_MAX_BYTES) return 0;
    content = readTail(path, stat.size);
  } catch {
    return 0;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(obj);
    if (asBoolean(record.isSidechain)) continue;
    const message = asRecord(record.message);
    const usage = asRecord(message.usage);
    const inputTokens = asNumber(usage.input_tokens);
    if (inputTokens === undefined) continue;
    const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
    const cacheCreation = asNumber(usage.cache_creation_input_tokens) ?? 0;
    return inputTokens + cacheRead + cacheCreation;
  }
  return 0;
}

/**
 * Teto de janelas de `rate_limits` aceitas de um payload (BU-06).
 *
 * A conta real tem DUAS (`five_hour`, `seven_day`); o payload pode ganhar uma
 * terceira amanhã, e 16 dá folga pra isso. O que ele impede: 5 000 janelas
 * viravam uma statusline de 153 KB devolvida ao terminal do dono a cada
 * redesenho, 495 KB de `GET /api/usage/limits`, 5 000 cartões na tela e — com
 * 40 000 — um `too many SQL variables` que subia como **500 na rota da
 * statusline**, quebrando o hook do agente.
 *
 * O teto fica AQUI, na porta de entrada, e não no banco: assim statusline, WS,
 * API e UI herdam a mesma trava de uma vez.
 */
export const MAX_RATE_LIMIT_WINDOWS = 16;

/** Teto do nome de uma janela. `seven_day_opus` tem 14 caracteres. */
export const MAX_WINDOW_KEY = 64;

/** Teto do nome do modelo na statusline. `Claude Sonnet 4.5` tem 17. */
export const MAX_MODEL_LABEL = 60;

/**
 * Teto da linha inteira devolvida ao terminal. A linha real tem ~80
 * caracteres; 500 é folga pra uma janela nova sem virar inundação de terminal.
 */
export const MAX_STATUS_LINE = 500;

/**
 * Janela de sanidade do `resets_at` (BU-12), em segundos de epoch: dez anos
 * pra trás e dez pra frente. `Number.MAX_SAFE_INTEGER` virava um `Date`
 * inválido e a statusline imprimia `reseta undefined`; e um carimbo absurdo
 * também ia parar no banco.
 */
export const RESETS_AT_WINDOW_S = MAX_RESET_AHEAD_MS / 1000;

/** `resets_at` dentro da janela de sanidade, ou `undefined`. */
function sanitizeResetsAt(value: number | undefined, at: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const nowS = at / 1000;
  if (value < nowS - RESETS_AT_WINDOW_S || value > nowS + RESETS_AT_WINDOW_S) return undefined;
  return value;
}

export function quotaFromPayload(payload: unknown, at: number = Date.now()): QuotaSnapshot {
  const p = asRecord(payload);
  const modelObj = asRecord(p.model);
  // BU-04: o `display_name` é escolhido por quem chama o hook, e a linha
  // montada aqui é DEVOLVIDA ao terminal do dono. Ver `sanitizeDisplay`.
  const model =
    sanitizeDisplay(modelObj.display_name, MAX_MODEL_LABEL) ||
    sanitizeDisplay(modelObj.id, MAX_MODEL_LABEL) ||
    'claude';

  const contextWindow = asRecord(p.context_window);
  let contextTokens = asNumber(contextWindow.total_input_tokens);
  if (contextTokens === undefined) {
    const transcriptPath = asString(p.transcript_path);
    contextTokens = transcriptPath ? contextFromTranscript(transcriptPath) : 0;
  }

  const contextPct = asNumber(contextWindow.used_percentage);
  const costObj = asRecord(p.cost);
  const costUsd = asNumber(costObj.total_cost_usd);

  const rateLimits: RateLimitWindow[] = [];
  const rl = asRecord(p.rate_limits);
  let windowsDropped = 0;
  // Duas chaves DIFERENTES podem virar a mesma depois da limpeza e do corte em
  // 64 (`five_hour` + um invisível no meio, ou dois nomes de 80 caracteres com
  // o mesmo prefixo). Sem esta `Set`, as duas viravam janelas distintas com o
  // MESMO rótulo — dois cartões idênticos no painel — e no banco a segunda
  // sobrescrevia a primeira, porque `usage_limits.window` é chave primária.
  const vistas = new Set<string>();
  for (const [rawWindow, raw] of Object.entries(rl)) {
    const value = asRecord(raw);
    const usedPct = asNumber(value.used_percentage);
    if (usedPct === undefined) continue;
    // Chave sanitizada e cortada em 64: ela vira rótulo na statusline, chave
    // primária em `usage_limits`, `title`/`aria-label` no painel e linha do
    // `bridge usage`. Uma chave de 10 kB destruía as quatro.
    const window = sanitizeDisplay(rawWindow, MAX_WINDOW_KEY);
    if (!window) {
      windowsDropped += 1;
      continue;
    }
    if (vistas.has(window)) {
      windowsDropped += 1;
      continue;
    }
    if (rateLimits.length >= MAX_RATE_LIMIT_WINDOWS) {
      windowsDropped += 1;
      continue;
    }
    vistas.add(window);
    rateLimits.push({ window, usedPct, resetsAt: sanitizeResetsAt(asNumber(value.resets_at), at) });
  }

  return {
    model,
    contextTokens,
    contextPct,
    costUsd,
    rateLimits,
    line: '',
    at,
    ...(windowsDropped > 0 ? { windowsDropped } : {}),
  };
}

/**
 * A statusline que o Bridge devolve ao Claude Code (ADR-012).
 *
 * Tudo aqui sai do payload que o PRÓPRIO Claude Code manda no hook
 * `StatusLine`: contexto, modelo, custo e as janelas de `rate_limits`. O
 * formato é
 *
 *     87k ctx · Fable 5.1 · US$ 3,42 · 5h 23% (reseta em 2h15) · semana 68% (reseta seg)
 *
 * e a ordem, o formato do custo (`formatUsd`) e os rótulos das janelas são os
 * MESMOS da faixa da sidebar e do `bridge usage`: o dono não deveria ver
 * `US$ 0,74` numa ponta e `$0.74` na outra pro mesmo dado.
 *
 * Detalhes que não são gosto:
 *
 * - campo ausente SOME em vez de virar `undefined`: modelo vazio, custo nulo
 *   e conta de API key (que não manda `rate_limits` nenhum) encurtam a linha;
 * - `resets_at` vencido não vira "reseta em -2h": a janela aparece só com o
 *   percentual, que é o que ainda é verdade;
 * - `showCost: false` tira o custo daqui também. A configuração é sobre
 *   mostrar dinheiro na tela, e a statusline é tela.
 */
export interface StatusLineOptions {
  /** `usage.showCost` do `config.json`. Default `true`. */
  showCost?: boolean;
  /** Injetável pro teste calcular o reset contra um relógio fixo. */
  now?: number;
  /**
   * O idioma da linha (spec §13) — `core.language()` no instante em que o hook
   * `StatusLine` responde. Obrigatório: a statusline é a superfície do Bridge
   * que aparece mais vezes por minuto, e um default aqui esconderia a ponta
   * que esqueceu de perguntar.
   */
  lang: Language;
}

export function statusLine(q: QuotaSnapshot, opts: StatusLineOptions): string {
  const now = opts.now ?? Date.now();
  const lang = opts.lang;
  const parts = [t(lang, 'core.statusline.contexto', { tokens: formatTokens(q.contextTokens, lang) })];
  if (q.model) parts.push(q.model);
  if (opts.showCost !== false && q.costUsd != null) parts.push(formatUsd(q.costUsd, lang));

  for (const window of sortWindows(q.rateLimits)) {
    const label = windowLabel(window.window, lang);
    const pct = `${label} ${Math.round(clampPct(window.usedPct))}%`;
    const reset = formatReset(window.resetsAt, now, lang);
    parts.push(reset ? `${pct} (${reset})` : pct);
  }

  // Rede final (BU-04): mesmo que um campo novo entre aqui amanhã sem passar
  // pela limpeza de cima, a LINHA que sai pro terminal não leva byte de
  // controle. É o último ponto antes do `reply.send`.
  return sanitizeDisplay(parts.join(' · '), MAX_STATUS_LINE);
}
