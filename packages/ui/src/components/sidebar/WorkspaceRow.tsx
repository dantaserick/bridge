import type { EnvironmentInfo, GitStatus, Language, LastNotification, Session, Workspace } from '@bridge/shared';
import {
  environmentMissingLabel,
  environmentMissingTitle,
  environmentNoClaudeLabel,
  environmentNoClaudeTitle,
  environmentBadge,
  environmentStatus,
  formatRelativeTime,
} from '@bridge/shared';
import { tUi, useT } from '../../i18n.js';
import {
  aggregateState,
  filtersUntrusted,
  filtersUntrustedLabel,
  filtersUntrustedTitle,
  formatGitBadges,
  missingWorktreeLabel,
  truncate,
  workspaceRowLabel,
  worktreeMissing,
} from '../../sidebarModel.js';
import { ChevronIcon } from '../icons.js';
import { SessionLine } from './SessionLine.js';
import { SessionRow } from './SessionRow.js';
import { StateRing } from './StateRing.js';
import { WorkspaceMenu } from './WorkspaceMenu.js';
import type { WorkspaceMenuAction } from './WorkspaceMenu.js';

/**
 * O rótulo do chevron da linha — ele diz o que o clique VAI fazer, E EM QUEM.
 *
 * O nome do workspace entra no rótulo pela mesma razão do rótulo da linha e do
 * cabeçalho de grupo: numa sidebar com dez workspaces, dez botões chamados
 * "Recolher workspace" são dez controles indistinguíveis pra quem usa leitor de
 * tela — o `title` diferencia pro mouse, mas `title` não é anunciado.
 */
export function workspaceChevronLabel(name: string, expanded: boolean, lang: Language): string {
  return tUi(lang, expanded ? 'sidebar.chevron.recolher' : 'sidebar.chevron.expandir', { nome: name });
}

interface Props {
  workspace: Workspace;
  sessions: Session[];
  /**
   * As sessões estão à vista? 0.12.2: TODO workspace nasce expandido, e só
   * fecha quando quem olha a tela clica no chevron — antes disso o único
   * expandido era o ativo, e ativar um retraía o outro.
   */
  expanded: boolean;
  /** O workspace ativo (o que a área de conteúdo está mostrando). É o realce. */
  active: boolean;
  focusedSessionId?: string;
  /** Agora, injetado pelo pai pro tempo relativo não depender de `Date.now`. */
  now: number;
  /** Último status git do core (só workspace de worktree tem). */
  git?: GitStatus;
  /** BR-03: o repositório deste workspace declara driver de `filter.*`? */
  hasFilters?: boolean;
  /** BR-03: o dono já confiou nesses drivers? */
  trustsFilters?: boolean;
  /** Dor #2: os ambientes detectados na máquina (`GET /api/environments`). */
  environments?: readonly EnvironmentInfo[];
  /** Dor #4: `sessions.scopeGuard` da configuração — some o item quando desligada. */
  scopeGuard?: boolean;
  onActivate: () => void;
  /** O chevron: recolhe/expande SEM ativar o workspace. */
  onToggleCollapsed: () => void;
  onMenuAction: (action: WorkspaceMenuAction) => void;
  onReveal: (sessionId: string) => void;
  onKill: (session: Session) => void;
  /** `usage.showCost`: desligado, a linha da sessão para no contexto e no modelo. */
  showCost: boolean;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…\\${parts.slice(-2).join('\\')}`;
}

/** A notificação mais recente entre as sessões do workspace. */
function lastNotification(sessions: Session[]): LastNotification | undefined {
  let last: LastNotification | undefined;
  for (const session of sessions) {
    const candidate = session.lastNotification;
    if (candidate && (last === undefined || candidate.at > last.at)) last = candidate;
  }
  return last;
}

/** A sessão de agente cuja cota vale a pena mostrar: a focada, senão a primeira. */
function quotaSession(sessions: Session[], focusedSessionId: string | undefined): Session | undefined {
  const withQuota = sessions.filter((s) => s.quota !== undefined);
  return withQuota.find((s) => s.id === focusedSessionId) ?? withQuota[0];
}

/**
 * Uma linha de workspace na sidebar. Expandida (o padrão): bloco com a faixa
 * de cota e as sessões dentro. Recolhida no chevron: anel AGREGADO (pior
 * estado entre as sessões, a mesma ideia do `collapsedGroupState`), nome,
 * branch em mono e a última notificação abaixo — recolher esconde as linhas,
 * nunca o aviso de que alguma sessão travou.
 *
 * O realce de "este é o workspace ativo" é do `active`, não do `expanded`:
 * desde a 0.12.2 os dois deixaram de ser a mesma coisa.
 */
export function WorkspaceRow({
  workspace,
  sessions,
  expanded,
  active,
  focusedSessionId,
  now,
  git,
  hasFilters,
  trustsFilters,
  scopeGuard,
  environments,
  onActivate,
  onToggleCollapsed,
  onMenuAction,
  onReveal,
  onKill,
  showCost,
}: Props): JSX.Element {
  const { t, lang } = useT();
  const state = aggregateState(sessions) ?? 'empty';
  const note = lastNotification(sessions);
  const quota = quotaSession(sessions, focusedSessionId);
  const missing = worktreeMissing(git);
  /**
   * Fix round 4: o selo tambem sai em workspace de RAIZ. Ali nao ha `GitStatus`
   * (o poller so mede worktree), entao o motivo vem do REPO: tem driver e o
   * dono ainda nao confiou. Nos worktrees o `GitStatus` continua mandando.
   */
  const untrusted = filtersUntrusted(git) || (hasFilters === true && trustsFilters !== true);
  /**
   * Dor verificada #2 — onde as sessões deste workspace sobem. O selo só
   * aparece quando o dono ESCOLHEU um ambiente: sem escolha vale o `shell` da
   * configuração global, e um `pwsh` em toda linha só faria ruído.
   */
  const envBadge = environmentBadge(workspace.environment);
  const envStatus = environmentStatus(workspace.environment, environments);
  // `+N ~M` é coisa de tarefa: workspace comum mostra só o branch.
  const badges = workspace.worktree
    ? formatGitBadges(git, lang, workspace.worktree.base, workspace.worktree.baseGuessed)
    : undefined;
  /**
   * R4 — o branch vem do `GitStatus` (lido do disco pelo poller) e só cai pro
   * `workspace.branch` do banco enquanto o primeiro status não chega: o
   * gravado envelhece no instante em que o usuário dá `git checkout` dentro do
   * worktree pelo terminal.
   */
  const branch = git?.error === undefined ? (git?.branch ?? workspace.branch) : workspace.branch;

  /**
   * O "⋯" é IRMÃO da área clicável, não filho: botão dentro de um
   * `role="button"` é conteúdo interativo aninhado — leitor de tela anuncia um
   * controle só, e o clique no menu teria que cancelar a ativação da linha.
   */
  const head = (
    <div className="workspace-head">
      {/*
        O chevron é IRMÃO da área clicável pelo mesmo motivo do "⋯": botão
        dentro de `role="button"` é conteúdo interativo aninhado. E ele é o
        ÚNICO jeito de recolher — clicar no nome ATIVA o workspace e mais nada,
        que era a queixa do dono (ativar um retraía o outro).

        Sem `data-sidebar-row`: o ↑/↓ anda entre linhas (grupo, workspace,
        sessão), e uma parada extra por workspace dobraria o caminho até a
        sessão que travou. Pelo Tab ele continua alcançável.
      */}
      <button
        type="button"
        className="workspace-chevron"
        aria-label={workspaceChevronLabel(workspace.name, expanded, lang)}
        aria-expanded={expanded}
        title={workspaceChevronLabel(workspace.name, expanded, lang)}
        onClick={onToggleCollapsed}
      >
        <ChevronIcon open={expanded} />
      </button>
      <div
        className="workspace-head-main"
        role="button"
        tabIndex={0}
        /*
         * A linha é a única coisa que diz "este workspace tem uma sessão
         * travada" — na tela isso é a cor do anel, e no leitor de tela é este
         * rótulo. Sem ele, a linha inteira era anunciada como "botão" e o texto
         * saía picado (nome, branch, `+3`, `~5`) sem dizer o que era cada
         * pedaço.
         */
        aria-label={workspaceRowLabel(
          {
            name: workspace.name,
            state,
            sessions: sessions.length,
            missing,
            untrusted,
            environment: envBadge,
            environmentProblem: envStatus === 'no-claude' || envStatus === 'missing',
          },
          lang,
        )}
        /*
         * NÃO leva `aria-expanded`: desde a 0.12.2 este controle só ATIVA o
         * workspace. Quem recolhe e expande é o chevron ao lado, e é lá que o
         * estado é anunciado. `aria-current` é o que sobra pra dizer, em
         * texto, o que a cor de fundo diz na tela.
         */
        aria-current={active ? 'true' : undefined}
        data-sidebar-row="workspace"
        onClick={onActivate}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onActivate();
          }
        }}
      >
        <StateRing state={state} />
        <span className="workspace-name">{workspace.name}</span>
        <span className={missing ? 'workspace-branch dim mono missing' : 'workspace-branch dim mono'}>
          {missing ? missingWorktreeLabel(lang) : (branch ?? shortCwd(workspace.cwd))}
        </span>
        {badges && (
          <span className="workspace-git mono" title={badges.title}>
            <span className="git-ahead">{badges.ahead}</span>
            <span className={badges.dirtyWarn ? 'git-dirty warn' : 'git-dirty'}>{badges.dirty}</span>
          </span>
        )}
        {untrusted && (
          <span className="workspace-git filters-untrusted" title={filtersUntrustedTitle(lang)}>
            {filtersUntrustedLabel(lang)}
          </span>
        )}
        {envBadge && (
          <span
            className={envStatus === 'ok' || envStatus === 'unknown' ? 'workspace-env mono' : 'workspace-env mono warn'}
            title={
              envStatus === 'no-claude'
                ? environmentNoClaudeTitle(lang)
                : envStatus === 'missing'
                  ? environmentMissingTitle(lang)
                  : t('sidebar.ambiente.titulo', { id: envBadge })
            }
            data-env={envBadge}
          >
            {envBadge}
          </span>
        )}
        {envStatus === 'no-claude' && (
          <span className="workspace-git env-warn" title={environmentNoClaudeTitle(lang)}>
            {environmentNoClaudeLabel(lang)}
          </span>
        )}
        {envStatus === 'missing' && (
          <span className="workspace-git env-warn" title={environmentMissingTitle(lang)}>
            {environmentMissingLabel(lang)}
          </span>
        )}
      </div>
      <WorkspaceMenu
        workspace={workspace}
        branch={branch}
        missing={missing}
        hasFilters={hasFilters}
        trustsFilters={trustsFilters}
        environments={environments}
        scopeGuard={scopeGuard}
        onPick={onMenuAction}
      />
    </div>
  );

  const noteLine = note ? (
    <div className={`workspace-note${note.kind === 'stuck' ? ' stuck' : ''}`}>
      {truncate(note.text)} · {formatRelativeTime(note.at, now, lang)}
    </div>
  ) : null;

  // `active` e `expanded` são classes independentes: o realce é de quem está
  // ativo, o bloco é de quem está aberto.
  const className = ['workspace', active ? 'active' : '', expanded ? 'expanded' : ''].filter(Boolean).join(' ');

  if (!expanded) {
    return (
      <div className={className}>
        {head}
        {noteLine}
      </div>
    );
  }

  return (
    <div className={className}>
      {head}
      {noteLine}
      {quota && <SessionLine session={quota} showCost={showCost} />}
      {sessions.length > 0 && (
        <div className="workspace-sessions">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              focused={session.id === focusedSessionId}
              crossAccess={workspace.crossAccess === true}
              worktree={workspace.worktree !== undefined}
              onReveal={() => onReveal(session.id)}
              onKill={() => onKill(session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
