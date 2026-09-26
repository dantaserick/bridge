import type { SessionState } from '@bridge/shared';
import { useT } from '../../i18n.js';
import { sessionStateLabels } from '../../sidebarModel.js';

/** Estados possíveis do anel: os da sessão mais "sem sessão nenhuma". */
export type RingState = SessionState | 'empty';

/**
 * Anel de 8px (6px na faixa de rodapé). É o elemento que o olho lê primeiro
 * na sidebar, então carrega o `title` com o estado por extenso.
 *
 * O texto vem do `sessionStateLabels` do `sidebarModel` — o MESMO que entra no
 * `aria-label` das linhas: até a 0.8.0 havia duas listas de palavras pro mesmo
 * estado ("parada" no tooltip, nada no leitor de tela), e o `empty` (que não é
 * estado de sessão nenhuma) é o único acréscimo.
 *
 * `aria-hidden` quando a linha em volta já diz o estado no `aria-label` dela:
 * senão o leitor de tela anuncia o estado duas vezes.
 */
export function StateRing({
  state,
  strip = false,
  hidden = false,
}: {
  state: RingState;
  strip?: boolean;
  hidden?: boolean;
}): JSX.Element {
  const { t, lang } = useT();
  const label = state === 'empty' ? t('sidebar.estado.semSessao') : sessionStateLabels(lang)[state];
  return <span className={`ring ${state}${strip ? ' strip' : ''}`} title={label} aria-hidden={hidden || undefined} />;
}
