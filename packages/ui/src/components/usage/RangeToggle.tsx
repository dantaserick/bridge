import type { UsageRange } from '@bridge/shared';
import { useT } from '../../i18n.js';
import { rangeOptions } from '../../usageModel.js';

/**
 * `dia | semana | mês | ano | personalizado` numa cápsula só. É UM controle
 * de cinco estados, não cinco botões soltos — por isso `role="group"` com
 * `aria-pressed` por botão, e não `radio`: o grupo não mora num formulário e
 * não tem valor a submeter. QUAL dia/semana/mês é assunto do `PeriodNav` ao
 * lado; este só escolhe o tamanho do recorte.
 */
export function RangeToggle({
  range,
  onChange,
}: {
  range: UsageRange;
  onChange: (range: UsageRange) => void;
}): JSX.Element {
  const { t, lang } = useT();
  return (
    <div className="usage-range" role="group" aria-label={t('uso.painel.intervalo')}>
      {rangeOptions(lang).map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === range ? 'active' : undefined}
          aria-pressed={option.value === range}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
