import type { UsageLimitWindow } from '@bridge/shared';
import { useLang } from '../../i18n.js';
import { limitCards, noLimitsLabel, noLimitsNote } from '../../usageModel.js';

/**
 * Os medidores de limite do painel: UM cartão por janela do array, nunca dois
 * fixos. O payload do Claude Code pode ganhar `seven_day_opus` amanhã, e a
 * janela nova tem que aparecer com a chave crua como rótulo (`.limit-label
 * .raw`) em vez de sumir.
 *
 * Lista vazia é resposta legítima (conta de API key não recebe `rate_limits`):
 * o lugar da grade vira um cartão chato dizendo por quê, e não duas barras
 * zeradas, que leriam como cota intacta.
 */
export function LimitCards({ limits, now }: { limits: readonly UsageLimitWindow[]; now: number }): JSX.Element {
  const lang = useLang();
  if (limits.length === 0) {
    return (
      <div className="usage-limits">
        <div className="limit-card flat">
          <span className="limit-flat-label">{noLimitsLabel(lang)}</span>
          <p className="limit-flat-note">{noLimitsNote(lang)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="usage-limits">
      {limitCards(limits, lang, now).map((card) => (
        <div className="limit-card" key={card.window}>
          <div className="limit-head">
            <span className={card.raw ? 'limit-label raw mono' : 'limit-label'}>{card.label}</span>
          </div>
          <div className="limit-figure">
            <span className={`limit-pct mono ${card.level}`}>{card.pct}</span>
            {card.reset && <span className="limit-reset">{card.reset}</span>}
          </div>
          {/*
            `role="meter"` com `aria-valuenow/min/max`: isto É um medidor, e o
            papel certo faz o leitor de tela anunciar "23 de 100" além do
            rótulo — com `role="img"` a barra era só uma figura com legenda, e
            quem navega por medidores não a encontrava.

            O `aria-label` continua junto porque o número sozinho não diz de
            QUAL janela é; e o valor é o mesmo `fill` que desenha a barra (já
            preso em 0–100), pra que o que se ouve e o que se vê nunca
            divirjam.
          */}
          <div
            className="limit-bar"
            role="meter"
            aria-label={`${card.label}: ${card.pct}`}
            aria-valuenow={card.fill}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className={`limit-fill ${card.level}`} style={{ width: `${card.fill}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
