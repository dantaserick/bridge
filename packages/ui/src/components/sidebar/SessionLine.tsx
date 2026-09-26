import type { Session } from '@bridge/shared';
import { useLang } from '../../i18n.js';
import { sessionLine } from '../../usageModel.js';

/**
 * `70k ctx · Fable 5.1 · US$ 0,74` dentro do workspace expandido — o que
 * sobrou da `QuotaStrip` depois que os limites viraram bloco único da sidebar.
 *
 * O modelo é o primeiro a cair quando a sidebar aperta (`@container sessionline
 * (max-width: 200px)`): contexto e custo são os dois números que mudam a
 * decisão de continuar ou dar `/clear`; o nome do modelo é contexto.
 *
 * Sessão sem cota (shell, agente que ainda não mandou statusline) não desenha
 * nada.
 */
export function SessionLine({ session, showCost }: { session: Session; showCost: boolean }): JSX.Element | null {
  const line = sessionLine(session.quota, useLang(), { showCost });
  if (!line) return null;
  return (
    // `title` com a frase inteira: a linha corta com reticências na sidebar
    // estreita, e o corte não pode esconder o custo.
    <div className="session-line mono" title={line.text}>
      {line.ctx}
      {line.model && <span className="session-line-model"> · {line.model}</span>}
      {line.cost && <> · {line.cost}</>}
    </div>
  );
}
