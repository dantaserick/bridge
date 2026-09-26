/**
 * O portão do encerramento do core (0.12.1).
 *
 * Três caminhos pedem a mesma coisa — "derruba o core antes de o app sumir" —
 * e nenhum deles sabe se os outros já pediram:
 *
 * - `will-quit` da aplicação: o caminho normal (fechar a janela, sair pela
 *   bandeja). É ele que segura o `quit` até o `stopCore()` terminar.
 * - `before-quit` da aplicação: chega ANTES do `will-quit` em toda saída, e é
 *   o que ainda chega quando o Windows encerra a sessão do usuário.
 * - `session-end` da janela: desligamento/reinício/logoff forçado do Windows.
 *   Aqui o sistema operacional não espera ninguém — o pedido é o que der pra
 *   fazer no tempo que houver, e por isso não bloqueia nada.
 *
 * O portão garante que os três compartilhem UM `stopCore()`: quem chega
 * primeiro dispara, os outros recebem a mesma promessa e esperam por ela. Sem
 * isso, o `before-quit` de uma saída normal ou dispararia um segundo
 * encerramento por cima do primeiro, ou faria o `will-quit` deixar o app sair
 * com o core meio de pé.
 *
 * Um encerramento que estoura vira linha de log e resolve assim mesmo: quem
 * chamou está a caminho do `app.quit()`, e uma rejeição solta aqui seria um
 * `unhandledRejection` no meio da saída.
 */

/** A linha que o log do shell registra quando o Windows encerra a sessão. */
// i18n-ignore: linha de `shell.log` — os logs em arquivo ficam em pt-BR por
// decisão da spec §13 (eles são do dono e de quem dá suporte).
export const SESSION_END_LOG = '[shell] sessão do Windows encerrando: pedindo POST /api/shutdown'; // i18n-ignore

/** A linha do `before-quit` — a saída normal do app passa por ela primeiro. */
export const BEFORE_QUIT_LOG = '[shell] app encerrando: pedindo o encerramento do core';

export interface ShutdownGate {
  /** Alguém já pediu o encerramento? */
  readonly claimed: boolean;
  /**
   * Pede o encerramento. Devolve sempre a MESMA promessa — a do primeiro
   * pedido —, e só o `reason` de quem chegou primeiro vira log (os outros não
   * aconteceram: eles se penduraram num encerramento que já estava em curso).
   */
  request(reason?: string): Promise<void>;
}

export function createShutdownGate(stop: () => Promise<void>, log: (line: string) => void): ShutdownGate {
  let inflight: Promise<void> | null = null;
  return {
    get claimed(): boolean {
      return inflight !== null;
    },
    request(reason?: string): Promise<void> {
      if (inflight) return inflight;
      if (reason) log(reason);
      inflight = stop().catch((err: unknown) => {
        log(`[shell] o encerramento do core falhou: ${(err as Error).message}`);
      });
      return inflight;
    },
  };
}
