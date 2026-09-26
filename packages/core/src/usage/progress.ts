/**
 * Progresso da varredura de transcrições — a parte PURA (ADR-012).
 *
 * A varredura é o único trabalho do Bridge que pode levar minutos: na máquina
 * do autor são 8.431 arquivos e 12,8 GB de transcrição, e antes disto o painel
 * dizia "nenhuma transcrição encontrada" o tempo todo em que estava lendo —
 * uma frase falsa, que manda a pessoa procurar um defeito inexistente.
 *
 * O que mora aqui é a REGRA DE EMISSÃO, separada do serviço pra poder ser
 * testada sem tocar em disco: quando um progresso novo vira um evento
 * `usage.changed` e quando ele é engolido.
 */
import type { UsageScanProgress } from '@bridge/shared';

/**
 * Intervalo mínimo entre dois eventos de progresso NO MEIO de uma passada.
 *
 * Um por arquivo seriam oito mil eventos numa varredura completa, todos com o
 * mesmo destino: uma barra que a pessoa lê como fração. Um por segundo é o que
 * uma barra precisa — e é o teto que o contrato do evento promete.
 */
export const PROGRESS_EMIT_MS = 1000;

/** Progresso zerado de uma passada que vai começar. */
export function startProgress(filesTotal: number, bytesTotal: number): UsageScanProgress {
  return { active: true, filesDone: 0, filesTotal, bytesDone: 0, bytesTotal, skippedLines: 0 };
}

export function progressEqual(a: UsageScanProgress | undefined, b: UsageScanProgress): boolean {
  if (!a) return false;
  return (
    a.active === b.active &&
    a.filesDone === b.filesDone &&
    a.filesTotal === b.filesTotal &&
    a.bytesDone === b.bytesDone &&
    a.bytesTotal === b.bytesTotal &&
    a.skippedLines === b.skippedLines &&
    (a.capped ?? false) === (b.capped ?? false)
  );
}

/**
 * Este progresso vira evento?
 *
 * Três regras, nesta ordem:
 *
 * 1. progresso idêntico ao último emitido **não** sai — a passada percorre
 *    arquivos já lidos sem mudar número nenhum, e repetir a mesma foto é ruído;
 * 2. a virada de `active` sai SEMPRE, nos dois sentidos. O começo é o que
 *    acende o "ainda lendo" e o fim é o que o apaga; engolir o fim por causa do
 *    relógio deixaria a UI presa num "lendo…" que já acabou;
 * 3. no meio da passada, no máximo um por `intervalMs`.
 */
export function shouldEmitProgress(
  last: { at: number; progress: UsageScanProgress } | undefined,
  next: UsageScanProgress,
  now: number,
  intervalMs: number = PROGRESS_EMIT_MS,
): boolean {
  if (!last) return true;
  if (progressEqual(last.progress, next)) return false;
  if (last.progress.active !== next.active) return true;
  return now - last.at >= intervalMs;
}
