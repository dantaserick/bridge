import type { UsageReport, UsageScanProgress } from '@bridge/shared';
import { useEffect, useRef } from 'react';
import { useLang, useT } from '../i18n.js';
import {
  emptyHeaderNote,
  emptyState,
  headerNote,
  isEmpty,
  localDayOf,
  modelTable,
  pricingWarningTitle,
  projectTable,
  rescanStatus,
  scanCaveat,
  scanningLine,
  switchRange,
  tableWarnings,
  unpricedModels,
  usageFootnoteCost,
  usageFootnoteProject,
  type UsagePeriod,
} from '../usageModel.js';
import { CloseIcon } from './icons.js';
import { DayChart } from './usage/DayChart.js';
import { LimitCards } from './usage/LimitCard.js';
import { PeriodNav } from './usage/PeriodNav.js';
import { RangeToggle } from './usage/RangeToggle.js';
import { TotalCards } from './usage/TotalCards.js';
import { UsageTable } from './usage/UsageTable.js';

interface Props {
  /** Resposta de `GET /api/usage`; ausente enquanto o primeiro GET não volta. */
  report?: UsageReport;
  /** O período escolhido (estado do App) — recorte, âncora ou de/até. */
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
  /** `usage.showCost` da config: desligado, o cartão e a coluna de custo somem. */
  showCost: boolean;
  /** `POST /api/usage/rescan` — o CTA do estado vazio. */
  onRescan: () => void;
  /** Rescan em voo: o botão fica ocupado. */
  busy?: boolean;
  /**
   * Progresso da varredura (`usage.changed { scanning }`). É o que troca o
   * "não encontrei nada" por "ainda lendo" enquanto a primeira leitura de um
   * histórico grande acontece — ela leva minutos.
   */
  scanning?: UsageScanProgress | null;
  /** O `{ files, entries, days }` do último rescan — vira a linha de status. */
  rescanResult?: { files: number; entries: number; days: number };
  onClose: () => void;
  /** Injetado pra frase de reset não depender de `Date.now` no teste. */
  now?: number;
}

/**
 * O painel "Uso" (`Ctrl+Shift+Y`, item "Uso…" do menu "⋯" da sidebar).
 *
 * A ordem vertical é a ordem da pergunta: **posso continuar agora** (limites) →
 * **quanto já gastei** (cartões) → **como isso se distribuiu no tempo**
 * (gráfico) → **em quê** (tabelas) → **o quanto disso é estimativa** (aviso e
 * rodapé). Os limites vêm primeiro porque são a única informação com prazo.
 *
 * Mesma mecânica do `SettingsDialog`: `Esc` fecha, clique no véu fecha, e não
 * há OK nem Cancelar — não há nada a confirmar, é uma tela de leitura.
 */
export function UsagePanel({
  report,
  period,
  onPeriodChange,
  showCost,
  onRescan,
  busy,
  scanning,
  rescanResult,
  onClose,
  now = Date.now(),
}: Props): JSX.Element {
  const { t, lang } = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // O foco entra no painel ao abrir: sem isso o `Esc` só funcionaria depois de
  // um clique, e o Tab continuaria andando pela janela atrás do véu.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const empty = report !== undefined && isEmpty(report);
  const note =
    report === undefined
      ? ''
      : empty
        ? emptyHeaderNote(lang)
        : headerNote(report.range, report.from, report.to, lang, report.today);
  /*
    "Hoje" é o do CORE quando a resposta já chegou — é o fuso dele que fatia os
    dias —, e o do browser só antes disso (mesma máquina, mesmo relógio).
  */
  const today = report?.today ?? localDayOf(now);

  return (
    <div
      className="dialog-veil"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="dialog usage-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('uso.painel.titulo')}
        onKeyDown={(ev) => {
          if (ev.key !== 'Escape') return;
          ev.preventDefault();
          ev.stopPropagation();
          onClose();
        }}
      >
        <div className="dialog-title usage-header">
          <span>{t('uso.painel.titulo')}</span>
          <span className="dim">{note}</span>
          <span className="pane-spacer" />
          <PeriodNav period={period} today={today} onChange={onPeriodChange} />
          <RangeToggle range={period.range} onChange={(range) => onPeriodChange(switchRange(period, range, today))} />
          <button
            type="button"
            className="icon-button"
            ref={closeRef}
            aria-label={t('uso.painel.fechar.rotulo')}
            title={t('uso.painel.fechar.titulo')}
            onClick={onClose}
          >
            <CloseIcon size={10} />
          </button>
        </div>

        <div className="usage-body" ref={bodyRef}>
          {report === undefined && <div className="usage-empty usage-empty-hint">{t('uso.painel.somando')}</div>}
          {report !== undefined && empty && (
            <EmptyState
              report={report}
              onRescan={onRescan}
              busy={busy}
              scanning={scanning}
              rescanResult={rescanResult}
            />
          )}
          {report !== undefined && !empty && (
            <Content report={report} showCost={showCost} now={now} />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  report,
  onRescan,
  busy,
  scanning,
  rescanResult,
}: {
  report: UsageReport;
  onRescan: () => void;
  busy?: boolean;
  scanning?: UsageScanProgress | null;
  rescanResult?: { files: number; entries: number; days: number };
}): JSX.Element {
  const { t, lang } = useT();
  const state = emptyState(report, lang);
  /*
    Com a varredura EM VOO o título muda de afirmação: "nenhuma transcrição
    encontrada" é falso enquanto o core ainda está lendo — as transcrições
    existem, ele é que não chegou nelas. Numa árvore grande esse intervalo dura
    minutos, e era o primeiro contato de quem abre o painel pela primeira vez.
  */
  const lendo = scanningLine(scanning, lang);
  const status = rescanStatus(scanning, rescanResult, lang);
  const ressalva = scanCaveat(scanning, lang);
  return (
    <div className="usage-empty">
      <div className="usage-empty-title">
        {lendo ?? state.title} {lendo === undefined && <span className="mono">{state.home}</span>}
      </div>
      <div className="usage-empty-hint">
        {lendo === undefined ? state.hint : t('uso.painel.lendoDe', { home: state.home })}
      </div>
      {/* UM CTA só: com dois, nenhum é o próximo passo. */}
      <div className="usage-empty-actions">
        <button type="button" className="primary" disabled={busy} onClick={onRescan}>
          {t('uso.painel.reler')}
        </button>
        {status !== undefined && (
          <span className="usage-empty-status dim" role="status">
            {status}
          </span>
        )}
      </div>
      {/*
        O que a varredura não leu (linha acima do teto, árvore acima do teto).
        Fica no estado VAZIO também porque é aqui que a pessoa chega quando o
        número não bate com o que ela esperava.
      */}
      {ressalva !== undefined && (
        <div className="settings-warn" role="status">
          {ressalva}
        </div>
      )}
    </div>
  );
}

function Content({ report, showCost, now }: { report: UsageReport; showCost: boolean; now: number }): JSX.Element {
  const { t, lang } = useT();
  const unpriced = unpricedModels(report, lang);
  const warning = pricingWarningTitle(unpriced, lang);
  const ressalva = scanCaveat(report.scanning, lang);
  return (
    <>
      <LimitCards limits={report.limits} now={now} />
      {/*
        ANTES dos cartões de total, e não depois das tabelas: é uma ressalva
        sobre os números que vêm em seguida, e ler a ressalva depois de já ter
        acreditado no total não serve pra nada.
      */}
      {ressalva !== undefined && (
        <div className="settings-warn" role="status">
          {ressalva}
        </div>
      )}
      <TotalCards report={report} showCost={showCost} />
      {/* Sem custo, o gráfico conta TOKENS por dia: a estrutura serve pras
          duas métricas, e um dashboard sem série temporal perde a pergunta
          "quando isso aconteceu?". */}
      <DayChart report={report} metric={showCost ? 'cost' : 'tokens'} />
      <div className="usage-tables">
        <UsageTable
          model={modelTable(report, lang)}
          variant="model"
          title={t('uso.painel.tabela.porModelo')}
          keyHeader={t('uso.painel.tabela.modelo')}
          showCost={showCost}
        />
        <UsageTable
          model={projectTable(report, lang)}
          variant="project"
          title={t('uso.painel.tabela.porProjeto')}
          hint={t('uso.painel.tabela.dicaProjeto')}
          keyHeader={t('uso.painel.tabela.projeto')}
          showCost={showCost}
        />
      </div>
      {/*
        O aviso fica FORA do cartão da tabela, sobre `--bg-sidebar`: o
        `rgba(230,180,80,.08)` do `.settings-warn` compõe um fundo diferente
        sobre `--surface`, e ali o texto cairia de 7,67:1 para 6,96:1.
      */}
      {showCost && warning && (
        <div className="settings-warn" role="status">
          {warning} (<span className="mono">{unpriced.join(', ')}</span>):{' '}
          {unpriced.length === 1 ? t('uso.painel.semPreco.um') : t('uso.painel.semPreco.varios')}{' '}
          <strong>{t('uso.painel.configuracoesUso')}</strong> {t('uso.painel.semPreco.arquivo')}
        </div>
      )}
      {/*
        Os avisos que o CORE mandou (arquivo de preços ilegível, override
        malformado) são outra coisa que "modelo sem preço": eles falam da
        TABELA, não do consumo, e sumir com eles deixaria o dono achando que o
        `pricingFile` dele está valendo.
      */}
      {showCost && tableWarnings(report, lang).length > 0 && (
        <div className="settings-warn" role="status">
          <ul>
            {tableWarnings(report, lang).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="usage-footnote">
        {usageFootnoteProject(lang)}
        {/*
          O rótulo inteiro vai dentro do `<strong>` (e não só a palavra
          "estimado"): a ordem das palavras muda entre os idiomas — "Custo
          estimado" × "Estimated cost" — e destacar meia expressão deixaria o
          destaque na palavra errada num dos dois.
        */}
        {showCost && (
          <>
            {' '}
            <strong>{t('uso.cartao.custo')}</strong> {usageFootnoteCost(lang)}{' '}
            <strong>{t('uso.painel.configuracoesUso')}</strong>.
          </>
        )}
      </p>
    </>
  );
}
