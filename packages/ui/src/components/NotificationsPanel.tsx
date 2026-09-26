import type { Notification, Session } from '@bridge/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatRelativeTime } from '@bridge/shared';
import { useT } from '../i18n.js';
import { mergeNotifications, notificationKindLabel, sessionLabel } from '../sidebarModel.js';
import { CloseIcon } from './icons.js';
import { StateRing } from './sidebar/StateRing.js';

const HISTORY_LIMIT = 100;
const ALL = '__all__';

interface Props {
  /** Fila de não lidas do reducer: é ela que traz o que chega pelo WS. */
  unread: Notification[];
  sessions: Record<string, Session>;
  workspaceName: (workspaceId: string) => string;
  /** Esquerda do overlay: encosta na sidebar (ou na borda, com ela fechada). */
  left: number;
  onPick: (notification: Notification) => void;
  onMarkRead: (ids: string[]) => void;
  onClose: () => void;
}

/** Anel da linha: o `kind` da notificação mapeia direto nos estados de sessão. */
function ringOf(kind: Notification['kind']): 'needs-input' | 'done' | 'stuck' | 'idle' {
  return kind === 'custom' ? 'idle' : kind;
}

/**
 * Overlay de 480×640 à direita da sidebar (`Ctrl+Shift+I`). O histórico vem de
 * `GET /api/notifications` na abertura e é mantido vivo pelos eventos do WS;
 * clicar numa linha foca a sessão e marca aquela notificação como lida.
 */
export function NotificationsPanel({ unread, sessions, workspaceName, left, onPick, onMarkRead, onClose }: Props): JSX.Element {
  const { t, lang } = useT();
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<string>(ALL);
  const [error, setError] = useState<string | undefined>();

  // Histórico (lidas + não lidas recentes) — só na abertura; daí em diante o
  // que muda chega por `unread` (notification.new / notification.read).
  useEffect(() => {
    let cancelled = false;
    void api<Notification[]>(`/api/notifications?limit=${HISTORY_LIMIT}`)
      .then((list) => {
        if (!cancelled) setItems((prev) => mergeNotifications([...list, ...prev], unread, Date.now()));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busca única na abertura
  }, []);

  useEffect(() => {
    setItems((prev) => mergeNotifications(prev, unread, Date.now()));
  }, [unread]);

  // Captura: com o foco no terminal o xterm engole o keydown no bubble, então
  // o Esc só chega aqui antes dele. O diálogo modal tem prioridade (o Esc dele
  // é "cancelar"), então quando ele está na tela o painel não reage.
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key !== 'Escape') return;
      if (document.querySelector('.dialog-veil')) return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Duplicatas por id (a mesma notificação pode vir do histórico e do WS) já
  // foram resolvidas no merge; aqui só sobra o filtro.
  const workspaceIds = useMemo(() => [...new Set(items.map((n) => n.workspaceId))], [items]);
  const visible = filter === ALL ? items : items.filter((n) => n.workspaceId === filter);

  // O painel fica aberto por minutos: sem o tique, "agora" nunca vira "há 3 min".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="notifications-panel" style={{ left }} role="dialog" aria-label={t('notifications.titulo')}>
      <div className="notifications-header">
        <span className="notifications-title">{t('notifications.titulo')}</span>
        {unread.length > 0 && (
          <span className="unread-pill mono static">{t('notifications.naoLidas', { n: unread.length })}</span>
        )}
        <span className="pane-spacer" />
        <span className="dim">
          <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd>
        </span>
        <button type="button" className="icon-button" aria-label={t('notifications.fechar')} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="notifications-filters">
        <button type="button" className={`filter-pill${filter === ALL ? ' active' : ''}`} onClick={() => setFilter(ALL)}>
          {t('notifications.filtro.todos')}
        </button>
        {workspaceIds.map((id) => (
          <button key={id} type="button" className={`filter-pill${filter === id ? ' active' : ''}`} onClick={() => setFilter(id)}>
            {workspaceName(id)}
          </button>
        ))}
        <span className="pane-spacer" />
        <button
          type="button"
          className="link-button"
          disabled={unread.length === 0}
          onClick={() => onMarkRead(unread.map((n) => n.id))}
        >
          {t('notifications.marcarLidas')}
        </button>
      </div>

      <div className="notifications-list">
        {error && <div className="notifications-empty error-line">{error}</div>}
        {!error && visible.length === 0 && <div className="notifications-empty dim">{t('notifications.vazio')}</div>}
        {visible.map((n) => {
          const read = n.readAt !== undefined;
          const session = sessions[n.sessionId];
          return (
            <button
              key={n.id}
              type="button"
              className={`notification-row kind-${n.kind}${read ? ' read' : ''}`}
              onClick={() => {
                if (!read) onMarkRead([n.id]);
                onPick(n);
              }}
            >
              <StateRing state={ringOf(n.kind)} />
              <span className="notification-body">
                {/*
                  Primeira linha: o TIPO ("Precisa de você", "Terminou"…) na
                  cor do anel, o workspace e a sessão. É o que responde "o que
                  foi que alertou" antes de ler o texto.
                */}
                <span className="notification-meta">
                  <span className="notification-kind">{notificationKindLabel(n.kind, lang)}</span>
                  <span className="notification-workspace">{workspaceName(n.workspaceId)}</span>
                  <span className="dim mono">{session ? sessionLabel(session, lang) : t('notifications.sessao')}</span>
                  <span className="pane-spacer" />
                  <span className="dim">{formatRelativeTime(n.at, now, lang)}</span>
                </span>
                {/*
                  `n.text` vem do CORE (ou de `bridge notify`, ou de uma OSC do
                  terminal): é texto de fora, e a UI não o retraduz.
                */}
                <span className="notification-text">{n.text}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="notifications-footer dim">
        <span>
          <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>U</kbd> {t('notifications.rodape.foco')}
        </span>
        <span className="pane-spacer" />
        <span>
          <kbd>Esc</kbd> {t('notifications.rodape.fecha')}
        </span>
      </div>
    </div>
  );
}
