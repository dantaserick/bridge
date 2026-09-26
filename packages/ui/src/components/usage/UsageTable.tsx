import type { Language } from '@bridge/shared';
import { tUi, useT } from '../../i18n.js';
import type { TableModel, TableRowModel } from '../../usageModel.js';

/**
 * A tabela de um cartão de seção — usada duas vezes, "Por modelo" e "Por
 * projeto". As colunas mudam entre as duas: modelo mostra tokens, projeto
 * mostra a barra de participação. Com `usage.showCost` desligado a coluna de
 * custo sai e o projeto passa a mostrar tokens no lugar dela: o painel não
 * escreve dinheiro em lugar nenhum quando o dono pediu para não ver.
 *
 * `table-layout: fixed` + `colgroup`: sem a largura declarada, o nome de um
 * projeto longo empurraria os números pra fora do cartão. E é por causa desse
 * mesmo `colgroup` que a célula da barra NUNCA sai do DOM no cartão estreito —
 * ela vai a `width: 0` pela consulta de contêiner. Com `display: none` o
 * `colgroup` passa a casar as larguras por posição errada, e a largura da barra
 * ia parar na coluna "Msg".
 */
type ColumnId = 'share' | 'msg' | 'tok' | 'cost';

interface Column {
  id: ColumnId;
  /** Classe de largura do `<col>`; a primeira coluna (a chave) não tem. */
  width: string;
  header: string;
  headerTitle?: string;
}

/**
 * As colunas são FUNÇÃO do idioma, e não uma constante de módulo: constante é
 * avaliada uma vez, na importação, e a troca de idioma é ao vivo (a mesma
 * razão que matou as `ENVIRONMENT_*` na Task 1 e os `DETAIL_*` na Task 2).
 */
export function tableColumns(variant: 'model' | 'project', showCost: boolean, lang: Language): Column[] {
  const msg = (width: string): Column => ({ id: 'msg', width, header: tUi(lang, 'uso.painel.tabela.msg') });
  const tok = (): Column => ({
    id: 'tok',
    width: 'col-tok',
    header: tUi(lang, 'uso.painel.tabela.tokens'),
    headerTitle: tUi(lang, 'uso.painel.tabela.tokens.titulo'),
  });
  const cost = (width: string): Column => ({ id: 'cost', width, header: tUi(lang, 'uso.painel.tabela.custo') });
  const share: Column = { id: 'share', width: 'col-share', header: '' };
  if (variant === 'model') {
    return showCost ? [msg('col-msg'), tok(), cost('col-cost')] : [msg('col-msg'), tok()];
  }
  return showCost ? [share, msg('col-msg-sm'), cost('col-cost-sm')] : [share, msg('col-msg-sm'), tok()];
}

export function UsageTable({
  model,
  variant,
  title,
  hint,
  keyHeader,
  showCost,
}: {
  model: TableModel;
  variant: 'model' | 'project';
  title: string;
  hint?: string;
  keyHeader: string;
  showCost: boolean;
}): JSX.Element {
  const { t, lang } = useT();
  const columns = tableColumns(variant, showCost, lang);
  return (
    <div className="usage-section">
      <div className="usage-section-head">
        <span className="usage-section-title">{title}</span>
        {hint && <span className="usage-section-hint">{hint}</span>}
      </div>
      <table className="usage-table">
        <colgroup>
          <col />
          {columns.map((column) => (
            <col key={column.id} className={column.width} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th>{keyHeader}</th>
            {columns.map((column) =>
              column.id === 'share' ? (
                <th key={column.id} className="usage-share" />
              ) : (
                <th key={column.id} className="num" title={column.headerTitle}>
                  {column.header}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <Row key={row.id} row={row} columns={columns} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t('uso.painel.tabela.total')}</td>
            {columns.map((column) =>
              column.id === 'share' ? (
                <td key={column.id} className="usage-share" />
              ) : (
                <td key={column.id} className="mono num">
                  {model.total[column.id === 'msg' ? 'messages' : column.id === 'tok' ? 'tokens' : 'cost']}
                </td>
              ),
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Row({ row, columns }: { row: TableRowModel; columns: readonly Column[] }): JSX.Element {
  // A linha "outros" não tem barra (é um saco de itens, não um item com
  // participação própria) e não vai em itálico — itálico sintético em Geist
  // Mono é feio e não carrega informação. Ela se distingue pela cor.
  const others = row.key === '__outros__';
  const className = [others ? 'usage-row-others' : '', row.unpriced ? 'usage-row-noprice' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <tr className={className || undefined}>
      {/* O `title` só existe quando o nome curto esconde alguma coisa — o
          caminho inteiro do projeto, que não cabe na coluna. */}
      <td className="mono usage-key" title={row.key === row.name ? undefined : row.key}>
        {row.name}
      </td>
      {columns.map((column) => {
        if (column.id === 'share') {
          return (
            <td key={column.id} className="usage-share">
              {row.share !== undefined && (
                <span className="usage-share-track">
                  <span className="usage-share-fill" style={{ width: `${row.share}%` }} />
                </span>
              )}
            </td>
          );
        }
        if (column.id === 'cost') {
          return (
            <td key={column.id} className={row.unpriced ? 'mono num noprice-cell' : 'mono num'}>
              {row.cost}
            </td>
          );
        }
        return (
          <td key={column.id} className="mono num">
            {column.id === 'msg' ? row.messages : row.tokens}
          </td>
        );
      })}
    </tr>
  );
}
