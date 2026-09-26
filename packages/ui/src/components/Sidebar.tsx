import type { EnvironmentInfo, Session, Workspace } from '@bridge/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.js';
import {
  applyGroupPrefs,
  collapsedGroupState,
  groupWorkspaces,
  launcherErrorLine,
  launcherQueueLine,
  nextRowIndex,
  unreadBellLabel,
} from '../sidebarModel.js';
import { usageLimitBadge } from '../usageModel.js';
import { toggleCollapsed, toggleCollapsedWorkspace, togglePinned, workspaceCollapsed } from '../sidebarPrefs.js';
import type { GroupPrefs } from '../sidebarPrefs.js';
import type { UiState } from '../state.js';
import { BellIcon, BridgeMark, GearIcon, MenuIcon, PlusIcon, TaskIcon } from './icons.js';
import { GroupHeader } from './sidebar/GroupHeader.js';
import { SidebarLimits } from './sidebar/SidebarLimits.js';
import { WorkspaceRow } from './sidebar/WorkspaceRow.js';
import type { WorkspaceMenuAction } from './sidebar/WorkspaceMenu.js';

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 280;

/**
 * BR-03 — o que a linha e o menu precisam saber sobre os filtros do repositório
 * deste workspace, SEM uma chamada de git por render.
 *
 * `trustsFilters` sai do próprio `Repo` (o snapshot já traz). `hasFilters` é
 * deduzido: quando o core recusou a leitura (`error: 'filters-untrusted'`) é
 * porque há driver declarado; quando o dono já confiou, o item de menu tem que
 * continuar aparecendo — é por ele que se desfaz a confiança. Repositório sem
 * driver e sem confiança não cai em nenhum dos dois, e o menu não inventa a
 * pergunta.
 */
function filterFlags(state: UiState, workspace: Workspace): { hasFilters: boolean; trustsFilters: boolean } {
  const repo = workspace.repoId ? state.layout.repos.find((r) => r.id === workspace.repoId) : undefined;
  const trustsFilters = repo?.trustFilters === true;
  // Fix round 4: quem responde e o REPO (`hasFilterDrivers`, medido pelo core),
  // nao mais o `GitStatus` do workspace. O poller so calcula status de
  // worktree, entao um workspace de RAIZ num repo com driver nunca via o item
  // de menu — e sem ele nao havia como confiar antes de criar a primeira
  // tarefa, que e justamente o que o `worktree add` bloqueia.
  //
  // O `untrusted` fica como reforco: se o status ja denunciou, o item aparece
  // mesmo que a medicao do repo ainda nao tenha chegado.
  const untrusted = state.gitByWorkspace[workspace.id]?.error === 'filters-untrusted';
  return { hasFilters: repo?.hasFilterDrivers === true || untrusted, trustsFilters };
}

interface Props {
  state: UiState;
  width: number;
  onWidthChange: (width: number) => void;
  /**
   * Fixado/recolhido de grupos e workspaces. Vem do App (0.12.2) porque o
   * `revealSession` também precisa abrir uma linha, e ele nasce fora daqui —
   * clique no toast, painel de notificações, `Ctrl+Shift+U`.
   */
  groupPrefs: GroupPrefs;
  /** Grava a preferência (o App escreve no `localStorage`). */
  onGroupPrefs: (next: GroupPrefs) => void;
  onNewWorkspace: () => void;
  onNewTask: () => void;
  onActivateWorkspace: (workspaceId: string) => void;
  /** Menu "⋯" da linha: ver diff, mesclar, remover worktree, Explorer, fechar. */
  onWorkspaceMenu: (workspaceId: string, action: WorkspaceMenuAction) => void;
  onRevealSession: (sessionId: string) => void;
  onKillSession: (session: Session) => void;
  onToggleNotifications: () => void;
  onToggleSidebar: () => void;
  onMarkAllRead: () => void;
  /** Engrenagem do cabeçalho e item "Configurações…" do menu "⋯" (`Ctrl+,`). */
  onOpenSettings: () => void;
  /** Item "Uso…" do menu "⋯" (`Ctrl+Shift+Y`). */
  onOpenUsage: () => void;
  /** `usage.showCost`: desligado, a linha da sessão não escreve dinheiro. */
  showCost: boolean;
  /** Dor #2 — os ambientes detectados (`GET /api/environments`); alimenta selo e menu. */
  environments?: readonly EnvironmentInfo[];
  /** Dor #4 — `sessions.scopeGuard`: com ela desligada o menu não oferece o acesso cruzado. */
  scopeGuard?: boolean;
  /** Só existe no shim web: no Electron o toast é nativo. */
  onEnableToasts?: () => void;
  /**
   * "Lançar agora" da fila do escalonador (dor verificada #1): solta o próximo
   * lançamento ignorando o teto uma vez.
   */
  onLaunchNow: () => void;
}

function HeaderMenu({
  onToggleSidebar,
  onMarkAllRead,
  onOpenSettings,
  onOpenUsage,
  onEnableToasts,
}: Pick<Props, 'onToggleSidebar' | 'onMarkAllRead' | 'onOpenSettings' | 'onOpenUsage' | 'onEnableToasts'>): JSX.Element {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocument(ev: MouseEvent): void {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocument);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(fn: () => void): void {
    setOpen(false);
    fn();
  }

  return (
    <div className="header-menu" ref={ref}>
      <button
        type="button"
        className="icon-button"
        aria-label={t('sidebar.menu.rotulo')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MenuIcon />
      </button>
      {open && (
        <div className="header-menu-list" role="menu">
          {onEnableToasts && (
            <button type="button" role="menuitem" onClick={() => pick(onEnableToasts)}>
              {t('sidebar.menu.ativarAvisos')}
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => pick(onMarkAllRead)}>
            {t('sidebar.menu.marcarLidas')}
          </button>
          <button type="button" role="menuitem" onClick={() => pick(onToggleSidebar)}>
            {t('sidebar.menu.alternarSidebar')}
          </button>
          <button type="button" role="menuitem" onClick={() => pick(onOpenUsage)}>
            {t('sidebar.menu.uso')}
          </button>
          <button type="button" role="menuitem" onClick={() => pick(onOpenSettings)}>
            {t('sidebar.menu.configuracoes')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A lista de "quem precisa de mim" (DESIGN.md): grupos por repositório, uma
 * linha por workspace com o anel agregado, e TODOS os workspaces expandidos —
 * cada um num bloco com a linha da sessão e as sessões. Recolher é manual, no
 * chevron da linha, e a escolha fica no `localStorage` junto das de grupo
 * (0.12.2: antes só o ativo ficava aberto, então ativar um retraía o outro).
 * Os limites de uso ficam num bloco
 * único sob o cabeçalho — eles são da conta, não do workspace. A borda direita arrasta pra
 * redimensionar (200–480 px, persistido pelo App).
 */
export function Sidebar({
  state,
  width,
  onWidthChange,
  groupPrefs,
  onGroupPrefs,
  onNewWorkspace,
  onNewTask,
  onActivateWorkspace,
  onWorkspaceMenu,
  onRevealSession,
  onKillSession,
  onToggleNotifications,
  onToggleSidebar,
  onMarkAllRead,
  onOpenSettings,
  onOpenUsage,
  onEnableToasts,
  onLaunchNow,
  showCost,
  environments,
  scopeGuard,
}: Props): JSX.Element {
  // Fixado/recolhido é preferência de quem olha a tela, não estado do core:
  // vive no `localStorage`, e desde a 0.12.2 quem o GUARDA é o App — o
  // `revealSession` também precisa abrir uma linha, e ele nasce fora daqui.
  // A sidebar só decide o que alternar e manda pelo `onGroupPrefs`.

  const { t, lang } = useT();
  const groups = applyGroupPrefs(groupWorkspaces(state.layout, lang), groupPrefs);
  const sessions = Object.values(state.sessions);
  const queue = launcherQueueLine(state.launcher, lang);
  // Um `now` por render: todas as linhas contam o tempo relativo do mesmo
  // instante, e um tick de 30 s mantém "agora" virando "há 1 min" sozinho.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // Depende do `now` do tick: a frase de reset envelhece junto com as barras.
  const usageBadge = usageLimitBadge(state.usageLimits, lang, now);
  // Fila vazia depois de um lançamento que falhou: o recado não tem mais onde
  // morar (a linha da fila sumiu), então vira faixa. Ver `launcherErrorLine`.
  const queueError = launcherErrorLine(state.launcher, now, lang);

  /**
   * ↑/↓ andam de linha em linha na sidebar (cabeçalhos de grupo, workspaces e
   * sessões, na ordem em que estão desenhados). Enter/Espaço já ativam cada
   * linha — isso é de cada componente; o que faltava era chegar até elas sem
   * dar dezenas de Tab.
   *
   * O handler fica no CONTÊINER e lê as linhas do DOM (`[data-sidebar-row]`)
   * em vez de manter um índice em estado: a lista muda a cada evento do core
   * (grupo recolhe, workspace expande e traz as sessões dele), e um índice
   * guardado ficaria apontando pra linha errada no meio de uma navegação. Quem
   * decide o destino é o `nextRowIndex`, que é puro e testado.
   */
  const onRowsKeyDown = useCallback((ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    const rows = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-row]'));
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next = nextRowIndex(rows.length, current, ev.key === 'ArrowDown' ? 1 : -1);
    // Nas pontas (e com a sidebar vazia) a tecla segue o caminho normal: rolar
    // a lista é melhor do que engolir a seta e não fazer nada.
    if (next === undefined) return;
    ev.preventDefault();
    rows[next]?.focus();
  }, []);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;

  const startDrag = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault();
    const rect = ev.currentTarget.parentElement?.getBoundingClientRect();
    dragRef.current = { startX: ev.clientX, startWidth: rect ? rect.width : SIDEBAR_DEFAULT };
  }, []);

  useEffect(() => {
    function onMove(ev: MouseEvent): void {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, drag.startWidth + (ev.clientX - drag.startX)));
      onWidthChangeRef.current(next);
    }
    function onUp(): void {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <aside className="sidebar" style={{ width, flexBasis: width }}>
      <div className="sidebar-header">
        <div className="wordmark">
          <BridgeMark />
          <span>Bridge</span>
        </div>
        <span className="pane-spacer" />
        {/*
          O sino fica SEMPRE ao lado da engrenagem: cinza quando não há nada e
          âmbar com a contagem quando há não lidas. Antes ele só existia com
          fila cheia, e quem nunca tinha visto um alerta não sabia onde olhar.
        */}
        <button
          type="button"
          className={`bell-button${state.unread.length > 0 ? ' has-unread' : ''}`}
          onClick={onToggleNotifications}
          title={t('sidebar.notificacoes.titulo')}
          aria-label={unreadBellLabel(state.unread.length, lang)}
          data-unread={state.unread.length}
        >
          <BellIcon />
          {state.unread.length > 0 && <span className="bell-count">{state.unread.length}</span>}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onOpenSettings}
          title={t('sidebar.configuracoes.titulo')}
          aria-label={t('sidebar.configuracoes.rotulo')}
        >
          <GearIcon />
        </button>
        <HeaderMenu
          onToggleSidebar={onToggleSidebar}
          onMarkAllRead={onMarkAllRead}
          onOpenSettings={onOpenSettings}
          onOpenUsage={onOpenUsage}
          onEnableToasts={onEnableToasts}
        />
      </div>

      {/*
        ADR-012 — os limites da CONTA, uma vez só, entre o cabeçalho e os
        grupos. Lista vazia (conta de API key) não desenha nada.
      */}
      <SidebarLimits limits={state.usageLimits} now={now} />

      {/*
        Dor verificada #1 — os dois avisos que a pessoa precisa saber
        distinguir, um embaixo do outro e com cores diferentes: o limite de USO
        (vermelho, com reset) é dela e escala com o plano; a fila do
        escalonador só existe porque o limite do SERVIDOR (laranja, na linha da
        sessão) não escala com nada.
      */}
      {usageBadge && (
        <div className="sidebar-alert usage-limit" title={usageBadge.title}>
          {usageBadge.text}
        </div>
      )}
      {queueError && <div className="sidebar-alert launch-error">{queueError}</div>}
      {queue && (
        <div className="sidebar-queue" title={queue.title}>
          <span className="sidebar-queue-text">{queue.text}</span>
          <button
            type="button"
            className="sidebar-queue-action"
            onClick={onLaunchNow}
            title={t('sidebar.fila.lancarAgora.titulo')}
          >
            {t('sidebar.fila.lancarAgora')}
          </button>
        </div>
      )}

      <div className="sidebar-body" onKeyDown={onRowsKeyDown}>
        {groups.length === 0 && <div className="sidebar-empty dim">{t('sidebar.vazio')}</div>}
        {groups.map((group) => (
          <div className="repo-group" key={group.id}>
            <GroupHeader
              name={group.name}
              count={group.workspaces.length}
              collapsed={group.collapsed}
              pinned={group.pinned}
              ringState={group.collapsed ? collapsedGroupState(group, sessions) : undefined}
              onToggleCollapsed={() => onGroupPrefs(toggleCollapsed(groupPrefs, group.id))}
              // Roteia pela AÇÃO, não pelo fato de o menu ter sido usado: hoje
              // as duas entradas alternam a mesma preferência, mas tratar
              // "desafixar" como "alterna" só funciona enquanto o menu tiver
              // uma entrada por estado — a primeira entrada nova (esconder,
              // renomear) viraria um "fixar" silencioso.
              onMenuAction={(action) => {
                if (action !== 'pin' && action !== 'unpin') return;
                if ((action === 'pin') === group.pinned) return;
                onGroupPrefs(togglePinned(groupPrefs, group.id));
              }}
            />
            {!group.collapsed &&
              group.workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  sessions={sessions.filter((s) => s.workspaceId === workspace.id)}
                  // 0.12.2 — todos abertos por padrão; só fecha quem quem olha
                  // a tela fechou no chevron. Ativar deixou de retrair o
                  // vizinho.
                  expanded={!workspaceCollapsed(groupPrefs, workspace.id)}
                  active={workspace.id === state.activeWorkspaceId}
                  focusedSessionId={state.focusedSessionId}
                  now={now}
                  git={state.gitByWorkspace[workspace.id]}
                  {...filterFlags(state, workspace)}
                  environments={environments}
                  scopeGuard={scopeGuard}
                  onActivate={() => onActivateWorkspace(workspace.id)}
                  onToggleCollapsed={() => onGroupPrefs(toggleCollapsedWorkspace(groupPrefs, workspace.id))}
                  onMenuAction={(action) => onWorkspaceMenu(workspace.id, action)}
                  onReveal={onRevealSession}
                  onKill={onKillSession}
                  showCost={showCost}
                />
              ))}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <button type="button" onClick={onNewTask} title={t('sidebar.rodape.novaTarefa.titulo')}>
          <TaskIcon />
          {t('sidebar.rodape.novaTarefa')}
        </button>
        <button type="button" onClick={onNewWorkspace} title={t('sidebar.rodape.workspace.titulo')}>
          <PlusIcon />
          {t('sidebar.rodape.workspace')}
        </button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startDrag} role="separator" aria-label={t('sidebar.largura')} />
    </aside>
  );
}
