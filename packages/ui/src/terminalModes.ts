/**
 * Modos do terminal que um `reset()` apaga e o programa não reenvia sozinho.
 *
 * O `Terminal` refaz a tela pelo scrollback do core a cada reconexão do WS,
 * e o `term.reset()` de antes zera os modos privados que o Claude Code tinha
 * ligado — o rastreio de mouse (`?1000h`/`?1006h`), o colar entre chaves
 * (`?2004h`), as setas de aplicação (`?1h`). Sem reaplicar, o clique morre
 * até o programa reenviar as sequências, e isso pode nunca acontecer. Este
 * módulo é puro: lê o `term.modes` do xterm e devolve as sequências que o
 * recolocam no mesmo estado.
 */

export type MouseEncoding = 'default' | 'utf8' | 'sgr' | 'urxvt' | 'sgrPixels';

/** O que o `term.modes` do xterm expõe (sem o encoding do mouse — ver `nextMouseEncoding`). */
export interface XtermModes {
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  sendFocusMode: boolean;
  wraparoundMode: boolean;
  originMode: boolean;
  insertMode: boolean;
  reverseWraparoundMode: boolean;
}

export interface TerminalModeSnapshot {
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  mouseEncoding: MouseEncoding;
  /** O `reset()` volta pro buffer normal; um TUI fullscreen mora no alternativo (`?1049h`). */
  alternateScreen: boolean;
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  sendFocusMode: boolean;
  wraparoundMode: boolean;
  originMode: boolean;
  insertMode: boolean;
  reverseWraparoundMode: boolean;
}

const MOUSE_TRACKING_PARAM: Record<TerminalModeSnapshot['mouseTrackingMode'], number | undefined> = {
  none: undefined,
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003,
};

const MOUSE_ENCODING_PARAM: Record<TerminalModeSnapshot['mouseEncoding'], number | undefined> = {
  default: undefined,
  utf8: 1005,
  sgr: 1006,
  urxvt: 1015,
  sgrPixels: 1016,
};

/** Os parâmetros DECSET que ligam/desligam o mouse — é o que o xterm engole com o clique desligado. */
export const MOUSE_DECSET_PARAMS = new Set([9, 1000, 1002, 1003, 1005, 1006, 1015, 1016]);

const MOUSE_ENCODING_BY_PARAM: Record<number, MouseEncoding> = { 1005: 'utf8', 1006: 'sgr', 1015: 'urxvt', 1016: 'sgrPixels' };

/**
 * O xterm não expõe o encoding do mouse em `term.modes`; o `Terminal` vê
 * passar todo `CSI ? Pm h|l` e chama isto pra manter o seu: um `h` com
 * 1005/1006/1015 troca o encoding, um `l` com o encoding corrente volta ao
 * default, e qualquer outro parâmetro não mexe.
 */
export function nextMouseEncoding(current: MouseEncoding, params: readonly number[], enabled: boolean): MouseEncoding {
  let next = current;
  for (const p of params) {
    const enc = MOUSE_ENCODING_BY_PARAM[p];
    if (enc === undefined) continue;
    if (enabled) next = enc;
    else if (next === enc) next = 'default';
  }
  return next;
}

/** Copia o que importa do `term.modes` (o objeto do xterm é um getter vivo) mais o encoding rastreado. */
export function snapshotModes(modes: XtermModes, mouseEncoding: MouseEncoding, alternateScreen: boolean): TerminalModeSnapshot {
  return {
    mouseTrackingMode: modes.mouseTrackingMode,
    mouseEncoding,
    alternateScreen,
    bracketedPasteMode: modes.bracketedPasteMode,
    applicationCursorKeysMode: modes.applicationCursorKeysMode,
    applicationKeypadMode: modes.applicationKeypadMode,
    sendFocusMode: modes.sendFocusMode,
    wraparoundMode: modes.wraparoundMode,
    originMode: modes.originMode,
    insertMode: modes.insertMode,
    reverseWraparoundMode: modes.reverseWraparoundMode,
  };
}

/**
 * As sequências que levam um terminal recém-`reset()` (todos os modos no
 * default) ao estado guardado. Só escreve o que difere do default, então um
 * snapshot "tudo padrão" devolve a string vazia.
 */
export function modeSequences(m: TerminalModeSnapshot): string {
  const out: string[] = [];
  // Primeiro o buffer: o resto dos modos vale nos dois, mas o desenho do
  // scrollback de um TUI fullscreen tem que cair no alternativo.
  if (m.alternateScreen) out.push('\x1b[?1049h');
  const tracking = MOUSE_TRACKING_PARAM[m.mouseTrackingMode];
  if (tracking !== undefined) out.push(`\x1b[?${tracking}h`);
  const encoding = MOUSE_ENCODING_PARAM[m.mouseEncoding];
  if (encoding !== undefined) out.push(`\x1b[?${encoding}h`);
  if (m.bracketedPasteMode) out.push('\x1b[?2004h');
  if (m.applicationCursorKeysMode) out.push('\x1b[?1h');
  if (m.applicationKeypadMode) out.push('\x1b=');
  if (m.sendFocusMode) out.push('\x1b[?1004h');
  if (!m.wraparoundMode) out.push('\x1b[?7l');
  if (m.originMode) out.push('\x1b[?6h');
  if (m.insertMode) out.push('\x1b[4h');
  if (m.reverseWraparoundMode) out.push('\x1b[?45h');
  return out.join('');
}

/**
 * Um DECSET/DECRST (`CSI ? Pm h|l`) é só de mouse? É o critério pra engolir o
 * pedido com o clique desligado: um `?1000;1006h` some inteiro; um pedido
 * misto (mouse junto com outra coisa) passa, pra não perder o resto.
 */
export function isMouseOnlyDecset(params: readonly number[]): boolean {
  return params.length > 0 && params.every((p) => MOUSE_DECSET_PARAMS.has(p));
}
