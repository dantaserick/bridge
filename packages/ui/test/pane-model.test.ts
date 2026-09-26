import { describe, expect, it } from 'vitest';
import type { Tab } from '@bridge/shared';
import { adoptableTabs, emptyPaneActions, parseSplitAction, splitMenuItems } from '../src/paneModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
/**
 * Os testes de UI rodam em ambiente de nó (sem DOM): o que dá pra provar do
 * painel vazio é a LISTA de botões — rótulo, ordem e tooltip —, que é
 * exatamente o que o `Pane` mapeia pra um `<button>` cada.
 */
function tab(id: string, order = 0): Tab {
  return { id, workspaceId: 'ws-1', title: 'Terminal', kind: 'terminal', order };
}

/**
 * "Dividir com uma aba já aberta" (pedido do dono, 10/09/2026): o menu do
 * cabeçalho do painel oferece o split vazio de sempre e, por aba de terminal
 * do MESMO workspace, trazê-la pra dentro deste split.
 */
describe('adoptableTabs', () => {
  it('lista as outras abas de terminal do workspace, numeradas na ordem da barra e com a sessão que roda nelas', () => {
    const tabs = [tab('tab-1'), tab('tab-2', 1), tab('tab-3', 2)];
    const labels = (id: string): string | undefined => (id === 'tab-2' ? 'claude' : undefined);
    expect(adoptableTabs(tabs, 'tab-1', labels, PT)).toEqual([
      { id: 'tab-2', label: 'Terminal 2 · claude' },
      { id: 'tab-3', label: 'Terminal 3' },
    ]);
  });

  it('sem outra aba de terminal, não há o que trazer', () => {
    expect(adoptableTabs([tab('tab-1')], 'tab-1', () => undefined, PT)).toEqual([]);
  });
});

describe('splitMenuItems', () => {
  it('sempre oferece os dois splits vazios e, por aba, trazê-la pro lado ou pra baixo', () => {
    const items = splitMenuItems([{ id: 'tab-2', label: 'Terminal 2 · claude' }], PT);
    expect(items.map((i) => [i.action, i.label])).toEqual([
      ['split:v', 'Dividir ao lado'],
      ['split:h', 'Dividir abaixo'],
      ['adopt:v:tab-2', 'Trazer Terminal 2 · claude pro lado'],
      ['adopt:h:tab-2', 'Trazer Terminal 2 · claude pra baixo'],
    ]);
  });

  it('sem aba adotável, só os dois splits', () => {
    expect(splitMenuItems([], PT).map((i) => i.action)).toEqual(['split:v', 'split:h']);
  });
});

describe('parseSplitAction', () => {
  it('separa direção e aba', () => {
    expect(parseSplitAction('split:h')).toEqual({ dir: 'h' });
    expect(parseSplitAction('adopt:v:tab-2')).toEqual({ dir: 'v', tabId: 'tab-2' });
  });
});

describe('emptyPaneActions', () => {
  it('traz os três botões pedidos, nesta ordem', () => {
    expect(emptyPaneActions(PT).map((a) => a.label)).toEqual(['Abrir shell', 'Abrir Claude Code', 'Fechar painel']);
  });

  /**
   * Desde a 0.11.2 o painel vazio não desenha mais as duas linhas de `<kbd>`
   * ("Enter abre um shell aqui"): o tooltip destes botões é o único lugar do
   * painel onde a combinação aparece, então ele TEM que trazê-la.
   */
  it('cada botão tem id único e tooltip com o atalho equivalente', () => {
    const actions = emptyPaneActions(PT);
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    expect(actions.find((a) => a.id === 'shell')?.title).toContain('Enter');
    expect(actions.find((a) => a.id === 'claude')?.title).toContain('Ctrl+Shift+C');
    expect(actions.find((a) => a.id === 'close')?.title).toContain('Ctrl+Shift+X');
  });

  it('é pt-BR sem emoji (DESIGN.md)', () => {
    for (const action of emptyPaneActions(PT)) {
      expect(action.label).toMatch(/^[A-Za-zÀ-ÿ ]+$/);
    }
  });
});
