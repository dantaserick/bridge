export interface UiTarget {
  /** `BRIDGE_DEV=1`: o renderer vem do Vite, que já está de pé (não subimos ele). */
  dev: boolean;
  /** Porta do core, que também serve a UI buildada fora do modo dev. */
  port: number;
}

const DEV_PORT = 5173;

/**
 * A UI NUNCA é carregada de `file://`: o `/ws` do core recusa qualquer origem
 * fora de loopback e o token não pode viajar na query string. Em dev a página
 * vem do Vite (proxy pro core); empacotado, vem do próprio core via estático.
 */
export function resolveUiOrigin(target: UiTarget): string {
  return `http://127.0.0.1:${target.dev ? DEV_PORT : target.port}`;
}

export function resolveUiUrl(target: UiTarget): string {
  return target.dev ? resolveUiOrigin(target) : `${resolveUiOrigin(target)}/`;
}

/**
 * O frame que fala IPC é o da UI?
 *
 * Compara ORIGENS, não prefixos de string: com `startsWith`, a origem
 * `http://127.0.0.1:5266` casaria com uma página em `http://127.0.0.1:52660`,
 * e essa página ganharia o token do core.
 */
export function isFromUi(frameUrl: string | null | undefined, expectedOrigin: string): boolean {
  if (!frameUrl || expectedOrigin === '') return false;
  try {
    return new URL(frameUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}
