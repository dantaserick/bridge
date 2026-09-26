import { describe, expect, it } from 'vitest';
import { isMouseOnlyDecset, modeSequences, nextMouseEncoding, snapshotModes } from '../src/terminalModes.js';
import type { TerminalModeSnapshot } from '../src/terminalModes.js';

const DEFAULTS: TerminalModeSnapshot = {
  mouseTrackingMode: 'none',
  mouseEncoding: 'default',
  alternateScreen: false,
  bracketedPasteMode: false,
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
  sendFocusMode: false,
  wraparoundMode: true,
  originMode: false,
  insertMode: false,
  reverseWraparoundMode: false,
};

describe('modeSequences', () => {
  it('terminal no default não precisa de nada', () => {
    expect(modeSequences(DEFAULTS)).toBe('');
  });

  it('o que o Claude Code liga na interface fullscreen volta inteiro: mouse SGR, colar entre chaves, setas de aplicação', () => {
    const seq = modeSequences({
      ...DEFAULTS,
      mouseTrackingMode: 'any',
      mouseEncoding: 'sgr',
      bracketedPasteMode: true,
      applicationCursorKeysMode: true,
      sendFocusMode: true,
    });
    expect(seq).toBe('\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?1004h');
    expect(modeSequences({ ...DEFAULTS, alternateScreen: true, mouseTrackingMode: 'vt200' })).toBe('\x1b[?1049h\x1b[?1000h');
  });

  it('cada modo de mouse tem o seu parâmetro', () => {
    expect(modeSequences({ ...DEFAULTS, mouseTrackingMode: 'vt200' })).toBe('\x1b[?1000h');
    expect(modeSequences({ ...DEFAULTS, mouseTrackingMode: 'drag' })).toBe('\x1b[?1002h');
    expect(modeSequences({ ...DEFAULTS, mouseTrackingMode: 'x10' })).toBe('\x1b[?9h');
    expect(modeSequences({ ...DEFAULTS, mouseEncoding: 'urxvt' })).toBe('\x1b[?1015h');
    expect(modeSequences({ ...DEFAULTS, mouseEncoding: 'sgrPixels' })).toBe('\x1b[?1016h');
  });

  it('modos que saem do default pelo lado "desligado" também voltam (wraparound)', () => {
    expect(modeSequences({ ...DEFAULTS, wraparoundMode: false, applicationKeypadMode: true, insertMode: true })).toBe(
      '\x1b=\x1b[?7l\x1b[4h',
    );
  });
});

describe('snapshotModes', () => {
  it('copia os campos do xterm, junta o encoding rastreado e nada mais', () => {
    const { mouseEncoding: _drop, alternateScreen: _drop2, ...xtermModes } = DEFAULTS;
    const live = { ...xtermModes, mouseTrackingMode: 'vt200' as const, extra: 1 };
    const snap = snapshotModes(live, 'sgr', true);
    expect(snap).toEqual({ ...DEFAULTS, mouseTrackingMode: 'vt200', mouseEncoding: 'sgr', alternateScreen: true });
    expect('extra' in snap).toBe(false);
  });
});

describe('nextMouseEncoding', () => {
  it('liga pelo DECSET e desliga pelo DECRST do mesmo encoding', () => {
    expect(nextMouseEncoding('default', [1000, 1006], true)).toBe('sgr');
    expect(nextMouseEncoding('sgr', [1006], false)).toBe('default');
    expect(nextMouseEncoding('sgr', [1005], false)).toBe('sgr');
  });

  it('parâmetro que não é encoding não mexe', () => {
    expect(nextMouseEncoding('sgr', [1000, 2004], true)).toBe('sgr');
    expect(nextMouseEncoding('default', [1049], true)).toBe('default');
  });
});

describe('isMouseOnlyDecset', () => {
  it('pedido só de mouse (um ou vários parâmetros) é engolido com o clique desligado', () => {
    expect(isMouseOnlyDecset([1000])).toBe(true);
    expect(isMouseOnlyDecset([1000, 1006])).toBe(true);
    expect(isMouseOnlyDecset([1003, 1005])).toBe(true);
    expect(isMouseOnlyDecset([1016])).toBe(true);
  });

  it('pedido misto ou de outra coisa passa', () => {
    expect(isMouseOnlyDecset([1049])).toBe(false);
    expect(isMouseOnlyDecset([1000, 2004])).toBe(false);
    expect(isMouseOnlyDecset([])).toBe(false);
  });
});
