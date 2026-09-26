import { MAX_USAGE_RANGE_DAYS, MIN_USAGE_DAY } from '@bridge/shared';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n.js';
import {
  canGoNext,
  canGoPrev,
  customPeriodValid,
  isCurrentPeriod,
  longDay,
  shiftPeriod,
  type UsagePeriod,
} from '../../usageModel.js';
import { ArrowLeftIcon, ArrowRightIcon } from '../icons.js';

interface Props {
  period: UsagePeriod;
  /** O dia local de hoje — o do core (`report.today`) quando já chegou. */
  today: string;
  onChange: (period: UsagePeriod) => void;
}

/**
 * O "onde no tempo" do painel, ao lado do toggle de recorte.
 *
 * Nos recortes ancorados é `‹ Hoje ›`: um período pra trás, a volta ao de
 * hoje e um pra frente. O "Hoje" fica SEMPRE no lugar, desligado quando já se
 * está no período de hoje — aparecer e sumir faria as setas pularem debaixo
 * do cursor a cada clique. No personalizado são os dois campos de data
 * nativos, que já trazem calendário, teclado e leitor de tela de graça.
 *
 * Toda a regra (o que é "anterior", quando o "próximo" desliga, que período é
 * válido) mora no `usageModel.ts`, testada sem DOM; aqui só se desenha.
 */
export function PeriodNav({ period, today, onChange }: Props): JSX.Element {
  const { t } = useT();
  if (period.range === 'custom') {
    return <CustomRange from={period.from} to={period.to} today={today} onChange={onChange} />;
  }
  const current = isCurrentPeriod(period, today);
  return (
    <div className="usage-period" role="group" aria-label={t('uso.painel.periodo.navegacao')}>
      <button
        type="button"
        className="icon-button"
        aria-label={t('uso.painel.periodo.anterior')}
        title={t('uso.painel.periodo.anterior')}
        disabled={!canGoPrev(period, today)}
        onClick={() => onChange(shiftPeriod(period, -1, today))}
      >
        <ArrowLeftIcon size={11} />
      </button>
      <button
        type="button"
        className="usage-period-today"
        title={t('uso.painel.periodo.hojeTitulo')}
        disabled={current}
        onClick={() => onChange({ range: period.range })}
      >
        {t('uso.painel.periodo.hoje')}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t('uso.painel.periodo.proximo')}
        title={t('uso.painel.periodo.proximo')}
        disabled={!canGoNext(period, today)}
        onClick={() => onChange(shiftPeriod(period, 1, today))}
      >
        <ArrowRightIcon size={11} />
      </button>
    </div>
  );
}

/**
 * De/até do período personalizado. O que se digita é RASCUNHO até formar um
 * período que o core aceita: só então sobe pro App (e sai o GET). Aplicar a
 * cada tecla mandaria pedidos que voltam 400 — o campo de data nativo emite
 * valor no meio da digitação do ano —, e o painel piscaria entre relatório e
 * "Somando…".
 */
function CustomRange({
  from,
  to,
  today,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  onChange: (period: UsagePeriod) => void;
}): JSX.Element {
  const { t } = useT();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  // O período aplicado pode mudar por FORA (trocar de recorte e voltar): o
  // rascunho acompanha em vez de mostrar datas que não são as da tela.
  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to]);

  const valid = customPeriodValid(draftFrom, draftTo, today);
  const apply = (nextFrom: string, nextTo: string): void => {
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    if (customPeriodValid(nextFrom, nextTo, today) && (nextFrom !== from || nextTo !== to)) {
      onChange({ range: 'custom', from: nextFrom, to: nextTo });
    }
  };

  return (
    <div className="usage-period" role="group" aria-label={t('uso.painel.periodo.livre')}>
      <input
        type="date"
        className="usage-date"
        aria-label={t('uso.painel.periodo.de')}
        value={draftFrom}
        min={MIN_USAGE_DAY}
        max={draftTo !== '' && draftTo < today ? draftTo : today}
        aria-invalid={!valid}
        onChange={(ev) => apply(ev.target.value, draftTo)}
      />
      <span className="dim" aria-hidden="true">
        –
      </span>
      <input
        type="date"
        className="usage-date"
        aria-label={t('uso.painel.periodo.ate')}
        value={draftTo}
        min={draftFrom !== '' && draftFrom > MIN_USAGE_DAY ? draftFrom : MIN_USAGE_DAY}
        max={today}
        aria-invalid={!valid}
        onChange={(ev) => apply(draftFrom, ev.target.value)}
      />
      {/* Só com as DUAS datas preenchidas: um campo pela metade ainda é digitação, não erro. */}
      {!valid && draftFrom !== '' && draftTo !== '' && (
        <span className="usage-period-invalid" role="status">
          {t('uso.painel.periodo.invalido', { max: MAX_USAGE_RANGE_DAYS, min: longDay(MIN_USAGE_DAY) })}
        </span>
      )}
    </div>
  );
}
