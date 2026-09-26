import type { UsageLimitWindow } from '@bridge/shared';
import { useLang } from '../../i18n.js';
import { limitRows } from '../../usageModel.js';

/**
 * As barras de limite da sidebar, UMA vez só, logo abaixo do cabeçalho.
 *
 * Os limites são da CONTA, não do workspace: repetir a mesma barra de 5 h
 * dentro de cada workspace expandido — que é onde a `QuotaStrip` os desenhava
 * até a 0.9.0 — diria três vezes a mesma coisa, e a leitura errada seria "cada
 * projeto tem a cota dele".
 *
 * Lista vazia (conta de API key, ou `rate_limits` que ainda não chegou) não
 * desenha nada: duas barras zeradas leriam como cota intacta. Quem explica o
 * estado é o painel "Uso", que tem espaço pra frase inteira.
 */
export function SidebarLimits({ limits, now }: { limits: readonly UsageLimitWindow[]; now: number }): JSX.Element | null {
  const lang = useLang();
  if (limits.length === 0) return null;
  return (
    <div className="sidebar-limits">
      {limitRows(limits, lang, now).map((row) => (
        // `title` com a frase inteira: em 200 px o reset some por consulta de
        // contêiner, e o dado não pode sumir junto.
        <div className="limit-row" key={row.window} title={row.title}>
          <span className="limit-row-label mono">{row.label}</span>
          {/* Mesmo medidor do painel — ver `LimitCard`. */}
          <span
            className="limit-row-bar"
            role="meter"
            aria-label={row.title}
            aria-valuenow={row.fill}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className={`limit-row-fill ${row.level}`} style={{ width: `${row.fill}%` }} />
          </span>
          {/*
            O percentual fica em `--text` (16,3:1) e a cor do degrau vive só na
            barra: `--bad` em 10,5 px daria 4,34:1 sobre `--bg-sidebar`, abaixo
            do AA — e a informação já está na barra, que passa como elemento
            gráfico.
          */}
          <span className="limit-row-pct mono">{row.pct}</span>
          {row.reset && (
            <span className="limit-row-reset mono">
              <span className="reset-word">{row.reset.word}</span>
              {row.reset.short}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
