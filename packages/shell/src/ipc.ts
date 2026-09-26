import type { LoginItemInput, LoginItemState } from './loginItem.js';

/** Nomes dos canais IPC entre o preload e o main. Fonte única dos dois lados. */
export const IPC = {
  /** invoke → token da instância do core (nunca vai na URL da janela). */
  token: 'bridge:token',
  /** invoke → porta do core. */
  port: 'bridge:port',
  /** invoke → traz a janela pra frente. */
  focusWindow: 'bridge:focusWindow',
  /** invoke → diálogo de pasta; devolve o caminho ou null. */
  pickFolder: 'bridge:pickFolder',
  /** invoke(path) → abre no Explorer / app padrão. */
  openPath: 'bridge:openPath',
  /** invoke(n) → contagem de não lidas no título da janela. */
  setBadge: 'bridge:setBadge',
  /** invoke → estado do início automático com o Windows (Fase 5). */
  getLoginItem: 'bridge:getLoginItem',
  /** invoke({enabled, startMinimized}) → grava e devolve o estado relido. */
  setLoginItem: 'bridge:setLoginItem',
  /** main → renderer: foca a sessão que o toast/bandeja apontou (Task 8). */
  focusSession: 'bridge:focus-session',
} as const;

/**
 * Início automático com o Windows — reexportado do `loginItem.ts` pra este
 * arquivo continuar sendo a fonte única da superfície do preload.
 */
export type { LoginItemInput, LoginItemState } from './loginItem.js';

/** Payload que o clique no toast (ou o menu "Mostrar" com foco pendente) manda pro renderer. */
export interface FocusSessionPayload {
  sessionId: string;
  workspaceId: string;
}

/** Superfície que o preload publica em `window.bridge`. */
export interface BridgeApi {
  token(): Promise<string>;
  port(): Promise<number>;
  focusWindow(): Promise<void>;
  /**
   * O renderer manda um rótulo (`webPrompt`) que só a reserva WEB usa — num
   * navegador comum não há diálogo nativo e o fallback é um `window.prompt`.
   * Aqui ele é IGNORADO de propósito: quem escreve o título da janela de
   * escolha de pasta é o Windows.
   */
  pickFolder(webPrompt?: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  setBadge(unread: number): Promise<void>;
  /**
   * Início automático com o Windows. `get` lê o que o Windows tem agora (não
   * o `config.json`: quem manda é o registro); `set` grava e devolve o estado
   * RELIDO — inclusive quando não deu pra gravar (dev), caso em que o estado
   * volta com `supported: false` e o motivo em `status`.
   */
  loginItem: {
    get(): Promise<LoginItemState>;
    set(next: LoginItemInput): Promise<LoginItemState>;
  };
  onFocusSession(cb: (payload: FocusSessionPayload) => void): () => void;
}
