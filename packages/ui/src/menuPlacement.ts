/**
 * Onde o popover do menu "⋯" aparece (R8).
 *
 * O menu era `position: absolute` dentro da linha do workspace, e a sidebar
 * tem `overflow: auto`: uma linha perto do rodapé abria um menu cortado pela
 * borda da lista, com as últimas entradas inalcançáveis. A correção é
 * `position: fixed` com coordenadas calculadas a partir do
 * `getBoundingClientRect()` do gatilho — e essa conta mora aqui, pura, porque
 * é ela que decide se o usuário consegue clicar em "Fechar workspace".
 */

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  /** O menu abriu PRA CIMA do gatilho (não coube embaixo). */
  openUp: boolean;
}

/** Respiro entre o gatilho e o menu, e entre o menu e a borda da janela. */
export const MENU_GAP = 4;
export const VIEWPORT_MARGIN = 8;

/**
 * Alinhado à DIREITA do gatilho (é onde o "⋯" fica na linha) e abaixo dele;
 * quando não cabe embaixo mas cabe em cima, abre pra cima. Não cabendo em
 * lugar nenhum — janela baixíssima — fica embaixo e preso à margem, que ao
 * menos deixa o começo da lista visível.
 *
 * O resultado é sempre preso dentro da viewport: um menu com `left` negativo
 * ou `top` além do fim da janela é um menu que não dá pra usar.
 */
export function menuPlacement(trigger: Rect, menu: Size, viewport: Size): Placement {
  const spaceBelow = viewport.height - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
  const openUp = menu.height > spaceBelow && spaceAbove >= menu.height;

  const rawTop = openUp ? trigger.top - MENU_GAP - menu.height : trigger.bottom + MENU_GAP;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN);
  const top = Math.min(Math.max(VIEWPORT_MARGIN, rawTop), maxTop);

  const rawLeft = trigger.right - menu.width;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), maxLeft);

  return { top, left, openUp };
}
