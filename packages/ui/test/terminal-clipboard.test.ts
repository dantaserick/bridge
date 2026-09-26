import { describe, expect, it } from 'vitest';
import { terminalKeyAction } from '../src/terminalClipboard.js';
import type { TerminalKeyEvent } from '../src/terminalClipboard.js';

/** Evento de teclado mínimo: `keydown` sem modificador, salvo o que o teste pedir. */
function ev(over: Partial<TerminalKeyEvent>): TerminalKeyEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

/** Ctrl+<letra>, do jeito que o Chromium entrega (`key` é a letra, `code` é `Key<L>`). */
function ctrl(key: string, over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return ev({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, ...over });
}

describe('terminalKeyAction — colar', () => {
  it('Ctrl+V cola', () => {
    expect(terminalKeyAction(ctrl('v'), false)).toBe('paste');
  });

  it('Ctrl+V cola também com seleção viva (colar não vira copiar)', () => {
    expect(terminalKeyAction(ctrl('v'), true)).toBe('paste');
  });

  it('Ctrl+Shift+V cola', () => {
    expect(terminalKeyAction(ctrl('V', { shiftKey: true }), false)).toBe('paste');
  });

  it('Shift+Insert cola', () => {
    expect(terminalKeyAction(ev({ key: 'Insert', code: 'Insert', shiftKey: true }), false)).toBe('paste');
  });

  it('não olha a caixa da letra (o Shift deixa `key` maiúsculo)', () => {
    expect(terminalKeyAction(ctrl('V'), false)).toBe('paste');
  });

  it('cai no `code` quando o `key` não é letra (tecla morta / composição)', () => {
    expect(terminalKeyAction(ev({ key: 'Dead', code: 'KeyV', ctrlKey: true }), false)).toBe('paste');
  });
});

describe('terminalKeyAction — copiar', () => {
  it('Ctrl+C COM seleção copia', () => {
    expect(terminalKeyAction(ctrl('c'), true)).toBe('copy');
  });

  it('Ctrl+Insert com seleção copia', () => {
    expect(terminalKeyAction(ev({ key: 'Insert', code: 'Insert', ctrlKey: true }), true)).toBe('copy');
  });
});

describe('terminalKeyAction — o que NÃO é do clipboard', () => {
  it('Ctrl+C SEM seleção segue pro xterm (é o SIGINT de sempre)', () => {
    expect(terminalKeyAction(ctrl('c'), false)).toBe('passthrough');
  });

  it('Ctrl+Shift+C segue pro app (é o atalho "abrir Claude", spec §6)', () => {
    expect(terminalKeyAction(ctrl('C', { shiftKey: true }), true)).toBe('passthrough');
  });

  it('Ctrl+Alt+V segue pro terminal (AltGr do ABNT2 chega como Ctrl+Alt)', () => {
    expect(terminalKeyAction(ctrl('v', { altKey: true }), false)).toBe('passthrough');
  });

  it('Ctrl+Alt+C com seleção também segue', () => {
    expect(terminalKeyAction(ctrl('c', { altKey: true }), true)).toBe('passthrough');
  });

  it('Meta+V segue (atalho do sistema, não nosso)', () => {
    expect(terminalKeyAction(ctrl('v', { metaKey: true }), false)).toBe('passthrough');
  });

  it('`v` sozinho é digitação, não colagem', () => {
    expect(terminalKeyAction(ev({ key: 'v', code: 'KeyV' }), false)).toBe('passthrough');
  });

  it('`c` sozinho com seleção é digitação, não cópia', () => {
    expect(terminalKeyAction(ev({ key: 'c', code: 'KeyC' }), true)).toBe('passthrough');
  });

  it('keyup não faz nada (senão a ação rodaria duas vezes por tecla)', () => {
    expect(terminalKeyAction(ctrl('v', { type: 'keyup' }), false)).toBe('passthrough');
    expect(terminalKeyAction(ctrl('c', { type: 'keyup' }), true)).toBe('passthrough');
  });

  it('keypress não faz nada', () => {
    expect(terminalKeyAction(ctrl('v', { type: 'keypress' }), false)).toBe('passthrough');
  });

  it('Insert puro continua sendo Insert', () => {
    expect(terminalKeyAction(ev({ key: 'Insert', code: 'Insert' }), true)).toBe('passthrough');
  });

  it('Ctrl+Shift+Insert não é nem cópia nem colagem (combinação indefinida)', () => {
    expect(terminalKeyAction(ev({ key: 'Insert', code: 'Insert', ctrlKey: true, shiftKey: true }), true)).toBe(
      'passthrough',
    );
  });

  it('Ctrl+Insert SEM seleção segue (não escreve string vazia por cima do clipboard)', () => {
    expect(terminalKeyAction(ev({ key: 'Insert', code: 'Insert', ctrlKey: true }), false)).toBe('passthrough');
  });

  it('outras teclas de controle continuam intactas (Ctrl+D, Ctrl+L)', () => {
    expect(terminalKeyAction(ctrl('d'), true)).toBe('passthrough');
    expect(terminalKeyAction(ctrl('l'), true)).toBe('passthrough');
  });

  it('Ctrl+Enter e afins não têm letra e seguem', () => {
    expect(terminalKeyAction(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), true)).toBe('passthrough');
  });
});
