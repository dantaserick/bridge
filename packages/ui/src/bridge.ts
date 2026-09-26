/**
 * A UI roda em dois lugares: dentro do Electron (`packages/shell`, que expõe
 * `window.bridge` pelo preload) e numa aba do navegador durante o dev. Este
 * módulo é a única porta entre os dois — o resto do código nunca testa
 * `window.bridge` na mão.
 */
import type { MessageKey } from '@bridge/shared';

export interface BridgeApi {
  /** Token do core. No Electron vem do preload; no web, do localStorage. */
  token(): Promise<string>;
  port(): Promise<number>;
  focusWindow(): void;
  /**
   * Diálogo nativo de pasta; `null` quando o usuário cancela.
   *
   * `webPrompt` é o rótulo do `window.prompt` de reserva — a aba do navegador
   * não tem diálogo nativo. O Electron o ignora (quem escreve o título da
   * janela de pasta é o Windows). Ele é ARGUMENTO, e não uma constante daqui,
   * porque este módulo não tem idioma: quem chama é um componente, e é ele que
   * tem o `t` (Task 4).
   */
  pickFolder(webPrompt: string): Promise<string | null>;
  openPath(p: string): void;
  /** Contagem de não lidas: bandeja/taskbar no Electron, título no web. */
  setBadge(n: number): void;
  /**
   * Início automático com o Windows (seção "Sistema" das Configurações). O
   * estado NÃO vem do `config.json`: quem manda é o registro do Windows, lido
   * pelo main a cada `get`. No navegador o shim devolve `supported: false`.
   */
  loginItem: {
    get(): Promise<LoginItemState>;
    set(next: LoginItemInput): Promise<LoginItemState>;
  };
  /** Clique no toast nativo → foca a sessão. Devolve o cancelamento. */
  onFocusSession(cb: (p: { sessionId: string; workspaceId: string }) => void): () => void;
}

/**
 * Estado do início automático, do jeito que o main devolve. É um ESPELHO do
 * `LoginItemState` de `packages/shell/src/loginItem.ts` — a UI não importa do
 * shell (ela também roda numa aba do navegador, sem ele).
 */
export interface LoginItemState {
  /** O Windows tem a entrada de início automático do Bridge agora. */
  enabled: boolean;
  /** Essa entrada sobe o app direto na bandeja (`--hidden`). */
  startMinimized: boolean;
  /** Dá pra mexer? Falso no navegador e no app rodando em dev. */
  supported: boolean;
  /**
   * A CHAVE de catálogo que diz por que não dá; vazia quando dá.
   *
   * É chave, e não frase, de propósito (Task 4): este campo atravessa o IPC
   * vindo de OUTRO processo (o main do Electron), que resolve o idioma na hora
   * dele. Mandando a frase pronta, uma troca de idioma podia pegar a seção
   * "Sistema" com uma linha no idioma antigo enquanto o resto da janela já
   * tinha trocado. Quem traduz é o `loginItemView`, com o idioma da UI.
   */
  status: MessageKey | '';
}

/** O que a UI manda ao mexer num dos dois checkboxes da seção "Sistema". */
export interface LoginItemInput {
  enabled: boolean;
  startMinimized: boolean;
}

declare global {
  interface Window {
    bridge?: BridgeApi;
  }
}

/** Sem token guardado no browser: o App mostra o formulário de token. */
export class NoTokenError extends Error {
  constructor() {
    // i18n-ignore: sentinela interna. Quem a mostra na tela é o App, com o
    // `app.erro.semToken` do catálogo — este texto nunca chega a ninguém.
    super('sem token guardado');
    this.name = 'NoTokenError';
  }
}

export const TOKEN_KEY = 'bridgeToken';

export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.bridge !== 'undefined';
}

/**
 * O que a seção "Sistema" diz quando a UI está numa aba do navegador — a CHAVE,
 * não a frase (ver `LoginItemState.status`). É a mesma família dos dois status
 * que o shell manda (`shell.loginItem.dev`, `.plataforma`), e por isso mora no
 * mesmo bloco do catálogo.
 */
export const LOGIN_ITEM_WEB_STATUS: MessageKey = 'shell.loginItem.web';

/**
 * Fallback web: o que dá pra fazer numa aba do navegador. `openPath` não tem
 * equivalente (abrir o Explorer do usuário) e `onFocusSession` não tem quem
 * chame — os dois viram no-op de propósito, não TODO.
 */
const webShim: BridgeApi = {
  async token(): Promise<string> {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) throw new NoTokenError();
    return stored;
  },
  async port(): Promise<number> {
    const port = Number(location.port);
    return Number.isFinite(port) && port > 0 ? port : 4560;
  },
  focusWindow(): void {
    window.focus();
  },
  async pickFolder(webPrompt: string): Promise<string | null> {
    return window.prompt(webPrompt);
  },
  openPath(): void {
    // Sem diálogo nativo numa aba do navegador.
  },
  setBadge(n: number): void {
    document.title = n > 0 ? `Bridge (${n})` : 'Bridge';
  },
  loginItem: {
    // Uma aba do navegador não mexe no `Run` do Windows — a seção "Sistema"
    // mostra a frase do `status` no lugar dos checkboxes.
    async get(): Promise<LoginItemState> {
      return { enabled: false, startMinimized: false, supported: false, status: LOGIN_ITEM_WEB_STATUS };
    },
    async set(): Promise<LoginItemState> {
      return { enabled: false, startMinimized: false, supported: false, status: LOGIN_ITEM_WEB_STATUS };
    },
  },
  onFocusSession(): () => void {
    return () => {
      // Nada assina foco de sessão fora do Electron.
    };
  },
};

export function getBridge(): BridgeApi {
  return (typeof window !== 'undefined' && window.bridge) || webShim;
}
