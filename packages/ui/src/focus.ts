/**
 * Batimento do `POST /api/focus` (resíduo da revisão da Fase 3).
 *
 * O poller de git do core só roda quando a janela disse "estou em foco" há
 * menos de `FOCUS_FRESH_MS` (60 s, `core.ts: shouldPollGit`). Antes disto a UI
 * só mandava foco no `focus`/`blur` da janela e na troca de painel: quem abria
 * o Bridge e ficava lendo o terminal sem trocar de painel via os `+N ~M` das
 * tarefas congelarem depois de um minuto — o gate fechava e ninguém reabria.
 */

/** De quanto em quanto tempo o foco precisa ser reafirmado. */
export const FOCUS_HEARTBEAT_MS = 30_000;

/**
 * Manda outro `POST /api/focus` agora? Só com a janela visível (minimizada não
 * segura o gate aberto — é justamente quando o poller não deve rodar) e com o
 * último POST já vencido.
 *
 * O tique do timer é metade de `FOCUS_HEARTBEAT_MS`, então o pior caso entre
 * dois POSTs é 45 s: abaixo dos 60 s de validade do core, com folga pra um
 * tique perdido por aba ocupada.
 */
export function shouldHeartbeat(
  visibilityState: DocumentVisibilityState,
  lastPostAt: number,
  now: number,
): boolean {
  if (visibilityState !== 'visible') return false;
  return now - lastPostAt >= FOCUS_HEARTBEAT_MS;
}
