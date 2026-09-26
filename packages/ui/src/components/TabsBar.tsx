import type { KeyAction, Keybindings, Session, Tab } from '@bridge/shared';
import { useT } from '../i18n.js';
import { aggregateState } from '../sidebarModel.js';
import { hintGroups } from '../tabsModel.js';
import { CloseIcon, MenuIcon } from './icons.js';

interface Props {
  tabs: Tab[];
  activeTabId?: string;
  sessions: Session[];
  /** Painéis de cada aba, na ordem da árvore de layout. */
  panesByTab: Record<string, string[]>;
  onActivate: (tabId: string) => void;
  onNewTab: () => void;
  onClose: (tabId: string) => void;
  /** Clique numa dica da direita: dispara a MESMA ação do atalho anunciado. */
  onHint: (action: KeyAction) => void;
  /**
   * Os atalhos em vigor (`GET /api/keybindings`). As dicas da direita saem
   * daqui: com teclas literais, rebindar no `keybindings.json` deixava a
   * legenda mentindo.
   */
  keybindings: Keybindings;
  /** Presente só com a sidebar escondida: o botão que a traz de volta. */
  onShowSidebar?: () => void;
}

/** Anel da aba = pior estado entre as sessões dos painéis dela. */
function tabRing(sessions: Session[], tabPaneIds: Set<string>): string {
  const inTab = sessions.filter((s) => tabPaneIds.has(s.paneId));
  return aggregateState(inTab) ?? 'idle';
}

export function TabsBar({
  tabs,
  activeTabId,
  sessions,
  panesByTab,
  onActivate,
  onNewTab,
  onClose,
  onHint,
  onShowSidebar,
  keybindings,
}: Props): JSX.Element {
  const { t, lang } = useT();
  return (
    <div className="tabs-bar">
      {onShowSidebar && (
        <button
          type="button"
          className="tab-new tab-show-sidebar"
          onClick={onShowSidebar}
          title={t('tabs.mostrarSidebar.titulo')}
          aria-label={t('tabs.mostrarSidebar')}
        >
          <MenuIcon size={13} />
        </button>
      )}
      {tabs.map((tab) => {
        const paneIds = panesByTab[tab.id] ?? [];
        const title = tab.title;
        return (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? ' active' : ''}`}
            // Botão do meio fecha, como em qualquer barra de abas.
            onAuxClick={(ev) => {
              if (ev.button !== 1) return;
              ev.preventDefault();
              onClose(tab.id);
            }}
          >
            <button type="button" className="tab-main" onClick={() => onActivate(tab.id)} title={title}>
              <span className={`ring ${tabRing(sessions, new Set(paneIds))}`} />
              <span className="tab-title">{title}</span>
              <span className="tab-count mono">{paneIds.length}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              title={t('tabs.fechar', { titulo: title })}
              aria-label={t('tabs.fechar', { titulo: title })}
              onClick={() => onClose(tab.id)}
            >
              <CloseIcon size={9} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-new"
        onClick={onNewTab}
        title={t('tabs.nova.titulo')}
        aria-label={t('tabs.nova')}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3 L8 13 M3 8 L13 8" />
        </svg>
      </button>
      <span className="tabs-spacer" />
      <div className="tabs-hints">
        {hintGroups(keybindings, lang).map((group) => (
          <span key={group.id} className="tabs-hint-group">
            {/*
              Só o NOME da ação aparece aqui. A combinação vive no `title` (e na
              tabela de Configurações → Atalhos): com cinco dicas, os `<kbd>` de
              cada uma poluíam a barra inteira. O clique continua sendo o mesmo
              da tecla — `onHint` chama a ação, não a combinação.
            */}
            {group.buttons.map((button) => (
              <button
                key={button.action}
                type="button"
                className="tabs-hint"
                title={button.title}
                aria-label={button.title}
                onClick={() => onHint(button.action)}
              >
                {button.label}
              </button>
            ))}
            {/* O verbo do grupo, só onde ele não é o rótulo do próprio botão. */}
            {group.showLabel && <span className="tabs-hint-label">{group.label}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
