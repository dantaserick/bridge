import { describe, expect, it } from 'vitest';
import { focusResyncNeeded } from '../src/terminalFocus.js';

describe('focusResyncNeeded — o foco "de mentira" do xterm (14/09/2026)', () => {
  it('textarea ativa, janela com foco e xterm se achando desfocado: resync', () => {
    expect(focusResyncNeeded({ textareaIsActive: true, documentHasFocus: true, xtermBelievesFocused: false })).toBe(true);
  });

  it('estado coerente (os dois focados) não mexe em nada', () => {
    expect(focusResyncNeeded({ textareaIsActive: true, documentHasFocus: true, xtermBelievesFocused: true })).toBe(false);
  });

  it('textarea não é o ativo (foco na sidebar, num botão): não é nosso problema', () => {
    expect(focusResyncNeeded({ textareaIsActive: false, documentHasFocus: true, xtermBelievesFocused: false })).toBe(false);
  });

  it('janela sem foco (outra janela por cima): o xterm está certo em se achar desfocado', () => {
    expect(focusResyncNeeded({ textareaIsActive: true, documentHasFocus: false, xtermBelievesFocused: false })).toBe(false);
  });
});
