import type { UiAction } from './state.js';
import type { ClientMessage, ServerMessage } from '@bridge/shared';

type Dispatch = (action: UiAction) => void;
type PtyDataListener = (data: string) => void;

const BACKOFF_STEPS_MS = [1000, 2000, 4000] as const;
const MAX_BACKOFF_MS = 10000;

class BridgeWs {
  private socket: WebSocket | undefined;
  private dispatch: Dispatch | undefined;
  private token: string | undefined;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUser = false;
  private ptyListeners = new Map<string, Set<PtyDataListener>>();
  private helloCount = 0;
  private reconnectListeners = new Set<() => void>();
  private connectedListeners = new Set<() => void>();

  connect(token: string, dispatch: Dispatch): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.token = token;
    this.dispatch = dispatch;
    this.closedByUser = false;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /**
   * Manda a mensagem e diz se ela **saiu**. Socket ausente, ainda em
   * handshake ou já fechado: a mensagem é DESCARTADA (não há fila), e quem
   * chamou precisa saber — o `resize` do terminal, por exemplo, guarda a grade
   * que o core "já sabe" e só pode fazer isso quando o aviso de fato foi.
   */
  send(msg: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  /** Assina os chunks `pty.data` de uma sessão sem passar pelo reducer/React state. */
  onPtyData(sessionId: string, listener: PtyDataListener): () => void {
    let set = this.ptyListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.ptyListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.ptyListeners.delete(sessionId);
    };
  }

  /**
   * Avisa quando o socket volta depois de cair (todo `hello` que não é o
   * primeiro). Enquanto esteve fora, os `pty.data` do intervalo se perderam —
   * quem desenha terminal precisa refazer o scrollback em vez de continuar
   * escrevendo por cima de uma tela desatualizada.
   */
  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * Avisa a cada socket ABERTO — inclusive o primeiro, e é essa a diferença
   * pro `onReconnected` (que só fala do segundo `hello` em diante, porque o
   * problema dele é o buraco no `pty.data`).
   *
   * Ele existe pra quem manda mensagem CEDO: a UI sobe o `GET /api/state`
   * antes do `bridgeWs.connect`, então um terminal pode montar, medir a grade
   * e mandar o `resize` com o handshake ainda em voo — e esse `resize` é
   * descartado em silêncio. Quem se importa refaz o envio aqui.
   */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => {
      this.connectedListeners.delete(listener);
    };
  }

  private open(): void {
    if (!this.token) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.dispatch?.({ type: 'connected', value: true });
      // Cópia da lista: um ouvinte pode se desinscrever de dentro do aviso.
      for (const listener of [...this.connectedListeners]) listener();
    });

    socket.addEventListener('message', (ev) => {
      if (socket !== this.socket) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      this.dispatch?.({ type: 'connected', value: false });
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (socket !== this.socket) return;
      socket.close();
    });
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === 'hello') {
      this.helloCount += 1;
      this.dispatch?.({ type: 'hello', state: msg.state });
      if (this.helloCount > 1) {
        for (const listener of [...this.reconnectListeners]) listener();
      }
      return;
    }
    if (msg.type === 'pty.data') {
      const listeners = this.ptyListeners.get(msg.sessionId);
      if (listeners) for (const listener of listeners) listener(msg.data);
      return;
    }
    this.dispatch?.({ type: 'event', event: msg });
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_STEPS_MS[this.attempt] ?? MAX_BACKOFF_MS;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}

export const bridgeWs = new BridgeWs();
