import type { Session } from '@bridge/shared';
import { useT } from '../../i18n.js';
import {
  scopeBlockBadge,
  serverLimitBadge,
  sessionDetail,
  sessionLabel,
  sessionRowLabel,
  sessionRowTitle,
} from '../../sidebarModel.js';
import { CloseIcon } from '../icons.js';
import { StateRing } from './StateRing.js';

interface Props {
  session: Session;
  focused: boolean;
  /**
   * O workspace desta sessão está com "Permitir acesso fora do worktree"
   * ligado? Ligado, o selo 🛡 não aparece — ver `scopeBlockBadge`.
   */
  crossAccess?: boolean;
  /**
   * O workspace desta sessão é uma TAREFA (tem worktree)? É o que decide como
   * o tooltip do 🛡 chama a cerca — o mesmo nome que o item do menu "⋯" tem.
   */
  worktree?: boolean;
  onReveal: () => void;
  onKill: () => void;
}

/**
 * Uma sessão dentro do workspace expandido. A focada leva a faixa azul à
 * esquerda; o "✕" (encerrar) só aparece no hover (ou no foco por teclado) pra
 * não competir com o detalhe, que é a informação que importa na varredura
 * vertical.
 *
 * O "✕" é IRMÃO da área clicável, não filho — a mesma regra da `WorkspaceRow`:
 * botão dentro de um `role="button"` é conteúdo interativo aninhado, o leitor
 * de tela anuncia um controle só, e o clique no ✕ precisava de um
 * `stopPropagation` pra não virar "revelar a sessão".
 */
export function SessionRow({
  session,
  focused,
  crossAccess,
  worktree,
  onReveal,
  onKill,
}: Props): JSX.Element {
  const { t, lang } = useT();
  const label = sessionLabel(session, lang);
  const detail = sessionDetail(session, lang);
  // 0.12.0 — a hospedeira: um shell com um Claude Code aberto dentro. A linha
  // passa a dizer `claude` e o `kind` continua `'shell'`, então este tooltip é
  // o único lugar da tela onde essa diferença está escrita.
  const hostedTitle = sessionRowTitle(session, lang);
  // Dor verificada #1 — o selo laranja do limite do SERVIDOR. Ele acompanha o
  // anel (que já é laranja nesse estado) porque o anel sozinho não diz de QUAL
  // limite se trata, e é justamente essa confusão que a dor descreve.
  const limited = serverLimitBadge(session, lang);
  // Dor verificada #4 — o selo 🛡 da guarda de escopo. Ele acumula enquanto a
  // guarda vale (não depende do estado da sessão, ao contrário do laranja
  // acima): a recusa aconteceu e o agente seguiu em frente, então o único
  // registro visível dela é este contador. LIBERADO o workspace (0.12.2), ele
  // some — a cerca que o selo descreve deixou de existir.
  const blocked = scopeBlockBadge(session, lang, { crossAccess, worktree });
  return (
    <div className={`session-row${focused ? ' focused' : ''}`}>
      <div
        className="session-row-main"
        role="button"
        tabIndex={0}
        // O anel e a faixa azul da linha focada não existem pra quem não vê a
        // tela: o estado e o "em foco" entram no rótulo.
        aria-label={sessionRowLabel({ label, state: session.state, detail, focused }, lang)}
        aria-current={focused ? 'true' : undefined}
        data-sidebar-row="session"
        data-hosted={session.hosted ? 'true' : undefined}
        title={hostedTitle}
        onClick={onReveal}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onReveal();
          }
        }}
      >
        <StateRing state={session.state} />
        <span className="session-label">{label}</span>
        {limited && (
          <span className="session-badge server-limited" title={limited.title}>
            {limited.text}
          </span>
        )}
        {blocked && (
          <span className="session-badge scope-blocked" title={blocked.title}>
            {blocked.text}
          </span>
        )}
        <span className="session-detail dim mono">{detail}</span>
      </div>
      <button
        type="button"
        className="session-close"
        title={t('sidebar.sessao.encerrar')}
        aria-label={t('sidebar.sessao.encerrarRotulo', { rotulo: label })}
        onClick={onKill}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
