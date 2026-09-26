/**
 * Cliente WS do processo main pro core (ruling da Task 8): o core roda num
 * processo separado (sidecar.ts), então quem quer decidir toast/badge no main
 * SEM depender do renderer/UI carregado precisa da própria conexão — a mesma
 * `/ws` que a UI usa, só que do lado de dentro do Electron.
 *
 * Usa o `WebSocket` global do Node (Electron 44 roda em Node novo o bastante
 * pra ter isso) e cai pro pacote `ws` só se ele não existir — por exemplo, um
 * runtime mais velho no instalador.
 */
import type { BridgeEvent, HelloState, ServerMessage } from '@bridge/shared';

/** Superfície comum entre o `WebSocket` global (undici) e o cliente do pacote `ws`. */
interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

type WsCtor = new (url: string) => WsLike;

let wsCtorPromise: Promise<WsCtor> | null = null;

async function resolveWsCtor(): Promise<WsCtor> {
  if (typeof WebSocket !== 'undefined') return WebSocket as unknown as WsCtor;
  const mod = (await import('ws')) as unknown as { default: WsCtor };
  return mod.default;
}

function wsCtor(): Promise<WsCtor> {
  wsCtorPromise ??= resolveWsCtor();
  return wsCtorPromise;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 10_000;

/**
 * R7 — prefixos de evento que o main assina no `/ws`. O core corta o resto na
 * origem, então `pty.data` (o único evento com volume de verdade) nem chega
 * aqui: sem isso o processo que desenha a janela fazia trabalho por chunk de
 * PTY de TODA sessão, só pra decidir que não ia usar nenhum deles (F1).
 *
 * `config` entrou na Task 4 do lote de idioma: o menu da bandeja é texto que
 * fica NA TELA entre um evento e outro, e sem o `config.changed` ele
 * continuaria no idioma antigo até o app reabrir.
 */
const EVENT_PREFIXES = 'notification,session,layout,config';

export interface CoreEventsHandlers {
  /** Chega uma vez por conexão (inclusive reconexão), com o snapshot inteiro. */
  onHello?: (state: HelloState) => void;
  onEvent?: (event: BridgeEvent) => void;
  log?: (line: string) => void;
}

/**
 * Conecta em `ws://127.0.0.1:<port>/ws?token=<token>`, reconecta com backoff
 * (1 s, 2 s, 4 s… até 10 s) quando o socket cai, e refaz o mapa de nomes de
 * workspace a cada `hello`/`layout.changed` — é dele que o `main.ts` tira o
 * `Bridge · <workspace>` do título do toast.
 */
export class CoreEventsClient {
  private port = 0;
  private token = '';
  private closed = true;
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private socket: WsLike | null = null;
  /** Protege contra callback de uma conexão velha chegando depois de `reconnect()`/`close()`. */
  private connSeq = 0;
  private workspaceNames = new Map<string, string>();

  constructor(private handlers: CoreEventsHandlers = {}) {}

  getWorkspaceName(id: string): string | undefined {
    return this.workspaceNames.get(id);
  }

  /**
   * Conecta (ou troca de porta/token — chamar de novo com valores diferentes
   * é seguro): derruba qualquer socket vivo antes, senão uma segunda chamada
   * deixaria o socket antigo aberto e falando sozinho.
   */
  connect(port: number, token: string): void {
    this.teardownSocket();
    this.port = port;
    this.token = token;
    this.closed = false;
    this.backoffMs = BACKOFF_START_MS;
    this.clearReconnectTimer();
    this.openSocket();
  }

  /** Core reiniciou (sidecar `onRestarted`): porta e token são novos. */
  reconnect(port: number, token: string): void {
    this.connect(port, token);
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSocket(): void {
    this.connSeq += 1;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // já fechado — sem problema.
    }
  }

  private log(line: string): void {
    this.handlers.log?.(line);
  }

  private openSocket(): void {
    const seq = ++this.connSeq;
    const url = `ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}&events=${EVENT_PREFIXES}`;
    wsCtor()
      .then((Ctor) => {
        if (seq !== this.connSeq || this.closed) return;
        const socket = new Ctor(url);
        this.socket = socket;
        socket.onopen = () => {
          if (seq !== this.connSeq) return;
          this.backoffMs = BACKOFF_START_MS;
        };
        socket.onmessage = (ev) => {
          if (seq !== this.connSeq) return;
          this.handleMessage(ev.data, seq);
        };
        socket.onerror = () => {
          // `onclose` sempre segue `onerror` num WebSocket — a reconexão é tratada lá.
        };
        socket.onclose = () => {
          if (seq !== this.connSeq) return;
          this.socket = null;
          if (this.closed) return;
          this.scheduleReconnect();
        };
      })
      .catch((err: unknown) => {
        if (seq !== this.connSeq || this.closed) return;
        this.log(`[shell] core-events: sem WebSocket disponível: ${(err as Error).message}`);
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.log(`[shell] core-events: desconectou; tentando de novo em ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(raw: unknown, seq: number): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    // O socket é autenticado, mas "autenticado" não é "bem formado": um core
    // mais velho, um bug de serialização ou um peer com o token na mão manda
    // JSON sem `type` string e o `startsWith` lá embaixo lançaria dentro do
    // `onmessage` — no processo que desenha a janela.
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    if (msg.type === 'hello') {
      this.workspaceNames = new Map(msg.state.layout.workspaces.map((w) => [w.id, w.name]));
      this.handlers.onHello?.(msg.state);
      return;
    }
    // Cinto e suspensório do R7: um core mais velho (ou um bug de filtro) pode
    // mandar `pty.*` mesmo assim, e nada aqui em cima usa esses eventos.
    if (msg.type.startsWith('pty.')) return;
    if (msg.type === 'layout.changed') void this.refreshWorkspaces(seq);
    this.handlers.onEvent?.(msg);
  }

  /** Um workspace pode nascer/mudar de nome depois do `hello` — busca o snapshot atual. */
  private async refreshWorkspaces(seq: number): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/state`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (!res.ok || seq !== this.connSeq) return;
      const state = (await res.json()) as HelloState;
      if (seq !== this.connSeq) return;
      this.workspaceNames = new Map(state.layout.workspaces.map((w) => [w.id, w.name]));
    } catch {
      // rede instável: mantém o mapa antigo até o próximo hello.
    }
  }
}
