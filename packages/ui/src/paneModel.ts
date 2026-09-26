/**
 * O que o painel decide sem desenhar: o que o painel VAZIO oferece de clique e
 * qual detalhe vai no cabeçalho. Está fora do `Pane.tsx` de propósito — são
 * decisões de produto (rótulo, tooltip, ordem, o "no shell" da hospedeira) e
 * são testadas direto, sem montar o React nem o xterm que o componente
 * arrasta junto.
 */
import type { Language, Session, Tab } from '@bridge/shared';
import type { PopoverItem } from './components/sidebar/PopoverMenu.js';
import { tUi } from './i18n.js';
import { hostedDetail } from './sidebarModel.js';

export type EmptyPaneActionId = 'shell' | 'claude' | 'close';

export interface EmptyPaneAction {
  id: EmptyPaneActionId;
  label: string;
  /** Tooltip: o que o botão faz + o atalho equivalente. */
  title: string;
}

/**
 * Os três botões abaixo das dicas do painel vazio. A ordem é a do custo:
 * o shell (que o `Enter` também abre) primeiro, fechar o painel por último.
 */
export function emptyPaneActions(lang: Language): EmptyPaneAction[] {
  return [
    { id: 'shell', label: tUi(lang, 'pane.vazio.shell'), title: tUi(lang, 'pane.vazio.shell.titulo') },
    { id: 'claude', label: tUi(lang, 'pane.vazio.claude'), title: tUi(lang, 'pane.vazio.claude.titulo') },
    { id: 'close', label: tUi(lang, 'pane.vazio.fechar'), title: tUi(lang, 'pane.vazio.fechar.titulo') },
  ];
}

// ------------------------------------------------------- menu "Dividir"

/**
 * O que o menu "Dividir" do cabeçalho do painel pede: o split vazio de sempre
 * (`split:<dir>`) ou trazer uma aba já aberta pra dentro deste split
 * (`adopt:<dir>:<tabId>`). `v` é lado a lado, `h` é em cima/embaixo — a mesma
 * convenção da árvore do core.
 */
export type SplitMenuAction = 'split:v' | 'split:h' | `adopt:v:${string}` | `adopt:h:${string}`;

export interface AdoptableTab {
  id: string;
  /** Como a aba aparece no menu: "Terminal 2 · claude". */
  label: string;
}

/**
 * As abas que este painel pode adotar: as OUTRAS abas de terminal do mesmo
 * workspace, na ordem da barra (é o número que a pessoa vê lá), com o rótulo
 * da sessão que roda no primeiro painel delas quando há uma — todas se chamam
 * "Terminal", e sem isso o menu ofereceria três entradas iguais.
 */
export function adoptableTabs(
  tabs: readonly Tab[],
  currentTabId: string,
  firstSessionLabel: (tabId: string) => string | undefined,
  lang: Language,
): AdoptableTab[] {
  const out: AdoptableTab[] = [];
  tabs.forEach((tab, index) => {
    if (tab.kind !== 'terminal' || tab.id === currentTabId) return;
    const base = tUi(lang, 'pane.dividir.aba', { titulo: tab.title, n: index + 1 });
    const session = firstSessionLabel(tab.id);
    out.push({ id: tab.id, label: session ? `${base} · ${session}` : base });
  });
  return out;
}

/** As entradas do menu: dois splits vazios e, por aba adotável, as duas direções. */
export function splitMenuItems(tabs: readonly AdoptableTab[], lang: Language): PopoverItem<SplitMenuAction>[] {
  const items: PopoverItem<SplitMenuAction>[] = [
    { action: 'split:v', label: tUi(lang, 'pane.dividir.lado'), title: tUi(lang, 'pane.dividir.lado.titulo') },
    { action: 'split:h', label: tUi(lang, 'pane.dividir.abaixo'), title: tUi(lang, 'pane.dividir.abaixo.titulo') },
  ];
  for (const tab of tabs) {
    items.push(
      { action: `adopt:v:${tab.id}`, label: tUi(lang, 'pane.dividir.trazerLado', { aba: tab.label }), title: tUi(lang, 'pane.dividir.trazer.titulo') },
      { action: `adopt:h:${tab.id}`, label: tUi(lang, 'pane.dividir.trazerAbaixo', { aba: tab.label }), title: tUi(lang, 'pane.dividir.trazer.titulo') },
    );
  }
  return items;
}

export function parseSplitAction(action: SplitMenuAction): { dir: 'v' | 'h'; tabId?: string } {
  if (action === 'split:v' || action === 'split:h') return { dir: action.endsWith('v') ? 'v' : 'h' };
  const rest = action.slice('adopt:'.length);
  const dir = rest.startsWith('v:') ? 'v' : 'h';
  return { dir, tabId: rest.slice(2) };
}

/**
 * O detalhe que o cabeçalho do painel mostra ao lado do rótulo.
 *
 * Normalmente é o `detail` que o core mandou ("pensando…", "Edit · src"). A
 * exceção é a sessão de SHELL hospedando um Claude Code (0.12.0): enquanto ela
 * está parada, o cabeçalho diz "no shell" (spec §5) — a mesma palavra da linha
 * da sidebar, e a única coisa na tela que separa esse Claude do que o Bridge
 * subiu. Painel encerrado não repete nada: a faixa "encerrou · código N" já
 * ocupa esse lugar.
 */
export function paneDetail(session: Session | undefined, lang: Language): string | undefined {
  if (!session) return undefined;
  // O `detail` do core já vem traduzido — a UI não o retraduz.
  if (session.detail) return session.detail;
  if (session.hosted && session.state !== 'exited') return hostedDetail(lang);
  return undefined;
}
