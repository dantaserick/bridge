import { DEFAULT_KEYBINDINGS, KEY_ACTIONS } from '@bridge/shared';
import type { KeyAction, Keybindings } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { makeKeyHandlers } from '../src/actions.js';
import type { ActionDeps } from '../src/actions.js';
import { keyActionLabel } from '../src/settingsModel.js';
import { emptyUiState } from '../src/state.js';
import { formatChord, hintGroups } from '../src/tabsModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
/**
 * `deps` mínimo: aqui não se chama rota nenhuma, só se pergunta se a ação da
 * dica EXISTE no mapa de handlers — é o que o clique da `TabsBar` faz
 * (`handlers[action]?.()`), e é o que quebraria se a dica citasse uma ação
 * que ninguém registra.
 */
function noopDeps(): ActionDeps {
  return {
    state: emptyUiState(),
    lang: PT,
    latestState: () => emptyUiState(),
    dispatch: () => {},
    api: async () => ({}) as never,
    setStatus: () => {},
    openWorkspaceDialog: () => {},
    openTaskDialog: () => {},
    openSettingsDialog: () => {},
    openUsagePanel: () => {},
    inflight: new Set<string>(),
    confirm: () => true,
    windowFocused: () => true,
    focusWindow: () => {},
    openPath: () => {},
    prompt: () => null,
    expandWorkspaceRow: () => {},
  };
}

/** Um `Keybindings` completo com algumas ações trocadas. */
function bindings(overrides: Partial<Keybindings> = {}): Keybindings {
  return { ...DEFAULT_KEYBINDINGS, ...overrides };
}

/** Todos os botões de todos os grupos, achatados na ordem de desenho. */
function buttons(bind: Keybindings = DEFAULT_KEYBINDINGS) {
  return hintGroups(bind, PT).flatMap((group) => group.buttons.map((button) => ({ ...button, group: group.id })));
}

describe('formatChord (a combinação como o Bridge a entendeu, PT)', () => {
  it('desenha modificadores em ordem canônica e a letra em caixa alta', () => {
    expect(formatChord('Ctrl+Shift+D', PT)).toEqual(['Ctrl', 'Shift', 'D']);
    // Escrito fora de ordem e em caixa livre no `keybindings.json`: a legenda
    // sai canônica, que é como o `parseChord` lê a tecla.
    expect(formatChord('shift+ctrl+d', PT)).toEqual(['Ctrl', 'Shift', 'D']);
  });

  it('seta vira símbolo — `ArrowLeft` não cabe na barra', () => {
    expect(formatChord('Alt+ArrowLeft', PT)).toEqual(['Alt', '←']);
    expect(formatChord('Alt+ArrowRight', PT)).toEqual(['Alt', '→']);
    expect(formatChord('Alt+ArrowUp', PT)).toEqual(['Alt', '↑']);
    expect(formatChord('Alt+ArrowDown', PT)).toEqual(['Alt', '↓']);
  });

  it('pontuação passa como está, e `meta` aparece como Win', () => {
    expect(formatChord('Ctrl+,', PT)).toEqual(['Ctrl', ',']);
    expect(formatChord('Ctrl++', PT)).toEqual(['Ctrl', '+']);
    expect(formatChord('Meta+K', PT)).toEqual(['Win', 'K']);
  });

  it('combinação inválida devolve lista vazia (é a mesma que nunca casa)', () => {
    expect(formatChord('', PT)).toEqual([]);
    expect(formatChord('Ctrl+', PT)).toEqual([]);
    expect(formatChord('Ctrl+Shift', PT)).toEqual([]);
  });
});

describe('hintGroups (dicas clicáveis da barra de abas, PT)', () => {
  it('anuncia dividir, navegar (esquerda e direita), uso e fechar painel', () => {
    expect(hintGroups(DEFAULT_KEYBINDINGS, PT).map((g) => g.id)).toEqual(['split', 'nav', 'usage', 'close']);
    expect(buttons().map((b) => b.action)).toEqual([
      'pane.splitV',
      'pane.left',
      'pane.right',
      'usage.open',
      'pane.close',
    ]);
  });

  /**
   * O bug de 0.8.0: a dica `Alt ←→` era UM botão e disparava sempre
   * `pane.right`. Quem clicava na última coluna esperando "a próxima" não ia
   * a lugar nenhum, e não havia onde clicar pra voltar.
   */
  it('a dica de navegação tem DUAS ações, uma por sentido', () => {
    const nav = hintGroups(DEFAULT_KEYBINDINGS, PT).find((g) => g.id === 'nav');
    expect(nav?.buttons.map((b) => b.action)).toEqual(['pane.left', 'pane.right']);
    expect(nav?.label).toBe('navega');
  });

  /**
   * A 0.11.1 escrevia a combinação de cinco dicas na barra ("ficou muito
   * poluído"). Desde a 0.11.2 o que se lê é o NOME da ação; a tecla vive no
   * tooltip e em Configurações → Atalhos.
   */
  it('o que se lê em cada botão é o nome da ação, nunca a combinação', () => {
    expect(buttons().map((b) => b.label)).toEqual(['divide', '←', '→', 'uso', 'fecha painel']);
    for (const button of buttons()) {
      for (const modifier of ['Ctrl', 'Shift', 'Alt', 'Win']) {
        expect(button.label).not.toContain(modifier);
      }
    }
  });

  it('o verbo do grupo só aparece quando há mais de um botão', () => {
    const groups = hintGroups(DEFAULT_KEYBINDINGS, PT);
    expect(groups.filter((g) => g.showLabel).map((g) => g.id)).toEqual(['nav']);
    // Sozinho, o botão JÁ é o verbo — repetir escreveria "divide divide".
    for (const group of groups.filter((g) => !g.showLabel)) {
      expect(group.buttons[0]?.label).toBe(group.label);
    }
  });

  it('as duas setas da navegação são o nome dos sentidos, não a tecla', () => {
    const nav = hintGroups(bindings({ 'pane.left': 'Ctrl+Alt+H' }), PT).find((g) => g.id === 'nav');
    // Rebindar `pane.left` pra `Ctrl+Alt+H` não mexe no que está escrito: a
    // seta é o rótulo do sentido, e a combinação nova só aparece no tooltip.
    expect(nav?.buttons.map((b) => b.label)).toEqual(['←', '→']);
    expect(nav?.buttons[0]?.title).toContain('Ctrl+Alt+H');
  });

  /**
   * O defeito que este modelo fecha: as teclas eram literais, então rebindar
   * no `keybindings.json` deixava a legenda mentindo — o clique ia pro lugar
   * certo (usa a ação) e o `<kbd>` mostrava a tecla de fábrica. Agora quem
   * carrega a combinação é o tooltip, e é ele que acompanha o rebind.
   */
  it('rebind no keybindings.json muda o tooltip junto', () => {
    const rebound = bindings({ 'pane.close': 'Ctrl+Alt+W', 'usage.open': 'Ctrl+Shift+F2' });
    const map = new Map(buttons(rebound).map((b) => [b.action, b.title]));
    expect(map.get('pane.close')).toBe('Fechar painel (Ctrl+Alt+W)');
    expect(map.get('usage.open')).toBe('Abrir o painel de uso (Ctrl+Shift+F2)');
  });

  it('com os defaults, o tooltip de cada botão bate com o `DEFAULT_KEYBINDINGS` da ação dele', () => {
    for (const button of buttons()) {
      expect(button.title).toBe(`${keyActionLabel(button.action, PT)} (${formatChord(DEFAULT_KEYBINDINGS[button.action], PT).join('+')})`);
    }
  });

  it('ação sem combinação continua clicável, com o nome na tela e o aviso no tooltip', () => {
    const semAtalho = hintGroups(bindings({ 'pane.close': '' }), PT).find((g) => g.id === 'close');
    expect(semAtalho?.buttons[0]?.label).toBe('fecha painel');
    expect(semAtalho?.buttons[0]?.title).toContain('sem atalho');
    expect(semAtalho?.buttons[0]?.action).toBe('pane.close');
  });

  it('toda dica aponta pra uma ação existente e com handler registrado', () => {
    const handlers = makeKeyHandlers(noopDeps());
    for (const button of buttons()) {
      expect(KEY_ACTIONS).toContain(button.action);
      expect(typeof handlers[button.action as KeyAction]).toBe('function');
    }
  });

  it('cada botão tem tooltip com o nome da ação e a combinação, e nenhuma ação se repete', () => {
    const all = buttons();
    expect(new Set(all.map((b) => b.action)).size).toBe(all.length);
    for (const button of all) {
      expect(button.title).toContain(keyActionLabel(button.action, PT));
      expect(button.title).toContain(formatChord(DEFAULT_KEYBINDINGS[button.action], PT).join('+'));
    }
  });
});
