import type { UsageReport } from '@bridge/shared';
import { useT } from '../../i18n.js';
import { chartHint, chartModel, chartTitle } from '../../usageModel.js';
import type { ChartColumnModel, ChartMetric } from '../../usageModel.js';

/** Dia, custo e a linha de apoio — o mesmo bloco no dia cheio e no zerado. */
function ChartTip({ column }: { column: ChartColumnModel }): JSX.Element {
  return (
    <div className="chart-tip">
      <div className="chart-tip-day mono">{column.when}</div>
      <div className="chart-tip-cost mono">{column.cost}</div>
      <div className="chart-tip-sub mono">{column.sub}</div>
    </div>
  );
}

/**
 * O gráfico de custo por dia — CSS puro, sem lib e sem canvas: as colunas
 * num `grid`, cada uma com a altura em porcentagem.
 *
 * A série é a que a API mandou (`byDay`): no período de hoje, os últimos 30
 * dias, e trocar de "mês" para "dia" muda a ÊNFASE sem trocar o eixo debaixo
 * do cursor; num mês passado ou num ano, os dias do próprio período. As barras
 * fora do intervalo selecionado recuam pro `--border-strong` — o recorte fica
 * em evidência e o contexto continua visível.
 *
 * Cada coluna carrega o valor em três lugares — `aria-label`, `title` e o
 * tooltip que abre no `:hover` e no `:focus-visible`. Nada é escrito DENTRO
 * da barra: `--text` sobre `--accent` dá 3,09:1, reprovado em AA.
 *
 * Série DENSA (acima de dois meses, até um ano) muda três coisas: as barras
 * perdem o vão, o eixo marca meses em vez de dias, e as colunas saem da ordem
 * do Tab — 365 paradas de teclado entre o cabeçalho e as tabelas tornariam o
 * resto do painel inalcançável. O valor de cada dia continua no `title` e no
 * `aria-label`.
 */
export function DayChart({ report, metric = 'cost' }: { report: UsageReport; metric?: ChartMetric }): JSX.Element | null {
  const { lang } = useT();
  const chart = chartModel(report, lang, metric);
  /**
   * Série vazia (core sem a rota, ou resposta pela metade) não desenha eixo
   * nenhum: um plot em branco parece gráfico quebrado.
   */
  if (chart.columns.length === 0) return null;
  // As colunas seguem a SÉRIE, não um 30 fixo. `minmax(0, 1fr)` e não `1fr`:
  // o `1fr` puro tem mínimo `auto`, e o rótulo "01/01" do eixo alargaria a
  // coluna dele — com 365 colunas o gráfico estouraria o cartão.
  const columns = { gridTemplateColumns: `repeat(${chart.columns.length}, minmax(0, 1fr))` };
  const dense = chart.dense ? ' dense' : '';
  return (
    <div className="usage-section">
      <div className="usage-section-head">
        <span className="usage-section-title">{chartTitle(metric, lang)}</span>
        <span className="usage-section-hint">{chartHint(report, lang)}</span>
      </div>
      <div className="usage-chart">
        <div className="chart-scale mono">
          <span className="chart-y y3">{chart.ticks[0]}</span>
          <span className="chart-y y2">{chart.ticks[1]}</span>
          <span className="chart-y y1">{chart.ticks[2]}</span>
          <span className="chart-y y0">{chart.ticks[3]}</span>
        </div>
        <div className="chart-area">
          <div className={`chart-plot${dense}`} style={columns}>
            {chart.columns.map((column) => (
              <div
                key={column.day}
                className={['chart-col', column.out ? 'out' : '', column.edge ? `tip-${column.edge}` : '']
                  .filter(Boolean)
                  .join(' ')}
                tabIndex={chart.dense ? undefined : 0}
                role="img"
                aria-label={column.label}
                title={column.label}
              >
                {/*
                  O tooltip é ancorado no topo da BARRA (ou do traço), não no
                  topo da coluna: nos dias de pico ele subiria por cima dos
                  cartões de total.
                */}
                {column.zero ? (
                  <div className="chart-zero">
                    <ChartTip column={column} />
                  </div>
                ) : (
                  <div className="chart-bar" style={{ height: `${column.height}%` }}>
                    <ChartTip column={column} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className={`chart-axis${dense}`} style={columns} aria-hidden="true">
            {chart.columns.map((column) => (
              <div className="chart-tick mono" key={column.day}>
                {column.tick}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
