import type { UsageReport } from '@bridge/shared';
import { useLang } from '../../i18n.js';
import { totalCards } from '../../usageModel.js';

/**
 * Os cartões de total: entrada, saída, cache, custo estimado e mensagens.
 *
 * O de custo some quando `usage.showCost` está desligado — e some da LISTA,
 * não da grade: `repeat(5, 1fr)` com um cartão a menos deixaria um buraco à
 * direita, enquanto quatro cartões numa grade de cinco colunas se redistribuem
 * sozinhos.
 */
export function TotalCards({ report, showCost }: { report: UsageReport; showCost: boolean }): JSX.Element {
  // No topo, como em todo componente daqui: hook é lido na primeira linha do
  // corpo, e não no meio do JSX — assim dá pra ver a ordem dos hooks de olho.
  const lang = useLang();
  return (
    <div className="usage-cards">
      {totalCards(report, { showCost }, lang).map((card) => (
        <div className={card.id === 'cost' ? 'usage-card cost' : 'usage-card'} key={card.id}>
          <div className="usage-card-label">{card.label}</div>
          <div className="usage-card-value mono">{card.value}</div>
          {/* `title` porque o sub corta com reticências no painel estreito. */}
          <div className="usage-card-sub" title={card.sub}>
            {card.sub}
          </div>
        </div>
      ))}
    </div>
  );
}
