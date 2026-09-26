import type { Db } from './db.js';
import type { EventBus } from './events.js';
import { newId } from './ids.js';
import type { Notification, NotificationKind } from './model.js';
import type { StoredConfig } from './profile.js';
import type { Sessions } from './sessions.js';

/** BR-12: teto do texto gravado. O mesmo do `notifySchema`. */
export const NOTIFICATION_TEXT_MAX = 2000;

/** Quantas notificações LIDAS ficam no banco depois da poda. */
export const NOTIFICATION_KEEP = 2000;

/** A poda roda a cada N inserções — varrer a tabela a cada OSC seria pior que o problema. */
export const NOTIFICATION_PRUNE_EVERY = 200;

/** Teto de notificações por sessão por segundo (BR-12): o excedente é descartado. */
export const NOTIFICATION_RATE_PER_SECOND = 10;

export function truncateNotificationText(text: string): string {
  if (text.length <= NOTIFICATION_TEXT_MAX) return text;
  return `${text.slice(0, NOTIFICATION_TEXT_MAX - 1)}…`;
}

export class Notifications {
  /** Janela de 1 s por sessão pro rate limit: `{ inicio, contagem }`. */
  private rate = new Map<string, { since: number; count: number }>();
  private sinceLastPrune = 0;

  /**
   * Atualizado pela API (POST /api/focus). O `at` é o instante do último
   * aviso: o poller de git (R5) só roda quando a janela disse "estou em foco"
   * há pouco tempo — um blur perdido (UI travada, janela morta) não pode
   * deixar o core lançando `git` para sempre em background.
   */
  focused: { sessionId?: string; windowFocused: boolean; at?: number } = { windowFocused: false };

  constructor(
    private db: Db,
    private bus: EventBus,
    private sessions: Sessions,
    private config: StoredConfig,
  ) {}

  push(sessionId: string, kind: NotificationKind, text: string): Notification | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const at = Date.now();
    // BR-12: rate limit por sessão. Um `printf '\033]9;…\007'` em laço no
    // painel gerava uma linha no banco e um evento em TODO cliente WS por
    // iteração; o excedente da janela de 1 s é descartado em silêncio.
    if (!this.allow(sessionId, at)) return undefined;

    const notification: Notification = {
      id: newId('ntf'),
      sessionId,
      workspaceId: session.workspaceId,
      kind,
      text: truncateNotificationText(text),
      at,
    };

    this.db.notifications.insert(notification);
    this.sinceLastPrune += 1;
    if (this.sinceLastPrune >= NOTIFICATION_PRUNE_EVERY) {
      this.sinceLastPrune = 0;
      this.db.notifications.prune(NOTIFICATION_KEEP);
    }
    this.sessions.noteNotification(sessionId, { kind, text: notification.text, at });

    const quiet = this.config.toast.quietWhenFocused && this.focused.windowFocused && this.focused.sessionId === sessionId;
    const toast = this.config.toast.enabled && !quiet;
    this.bus.emit({ type: 'notification.new', notification, toast });
    return notification;
  }

  /** `true` quando a sessão ainda cabe na janela de 1 s (BR-12). */
  private allow(sessionId: string, at: number): boolean {
    const window = this.rate.get(sessionId);
    if (!window || at - window.since >= 1000) {
      this.rate.set(sessionId, { since: at, count: 1 });
      return true;
    }
    if (window.count >= NOTIFICATION_RATE_PER_SECOND) return false;
    window.count += 1;
    return true;
  }

  markRead(ids: string[]): void {
    if (ids.length === 0) return;
    const at = Date.now();
    this.db.notifications.markRead(ids, at);
    this.bus.emit({ type: 'notification.read', ids });
  }

  markReadForSession(sessionId: string): void {
    const ids = this.db.notifications
      .listUnread()
      .filter((n) => n.sessionId === sessionId)
      .map((n) => n.id);
    this.markRead(ids);
  }

  unread(): Notification[] {
    return this.db.notifications.listUnread();
  }

  /**
   * A não lida mais recente (o alvo do `Ctrl+Shift+U` e de
   * `GET /api/notifications/latest-unread`).
   *
   * Delegado ao SQLite com `ORDER BY at DESC, rowid DESC LIMIT 1`: a varredura
   * em JS que existia aqui lia a tabela INTEIRA de não lidas pra devolver uma
   * linha, e o empate em `at` (duas notificações no mesmo milissegundo, o caso
   * comum quando um agente despeja OSC) era decidido pela ordem de retorno do
   * banco — sem `ORDER BY` que a garantisse.
   */
  latestUnread(): Notification | undefined {
    return this.db.notifications.latestUnread();
  }
}
