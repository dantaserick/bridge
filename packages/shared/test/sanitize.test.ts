/**
 * Testes de ATAQUE do `sanitizeDisplay` (BU-04/BU-09/BU-13/BU-16).
 *
 * As cargas são as MESMAS da auditoria do monitor de uso: o OSC 0 que sequestra
 * o título da janela, o CSI de cor, o `\r\n` que quebra a tabela alinhada da
 * CLI e o campo de 10 kB que destrói a coluna. Cada uma é reproduzida crua
 * (afirmando que o perigo existe) e depois passada pela função.
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_MAX, isDisplaySafe, sanitizeDisplay } from '../src/sanitize.js';

const ESC = '\u001b';
const BEL = '\u0007';
const BS = String.fromCharCode(92);

describe('sanitizeDisplay', () => {
  it('apaga a sequência OSC inteira, terminador incluído', () => {
    const cru = `${ESC}]0;TITULO SEQUESTRADO${BEL}Fable`;
    expect(isDisplaySafe(cru)).toBe(false);
    const limpo = sanitizeDisplay(cru);
    expect(limpo).toBe('Fable');
    expect(isDisplaySafe(limpo)).toBe(true);
  });

  it('apaga o OSC sem terminador (payload cortado no meio)', () => {
    expect(sanitizeDisplay(`ok${ESC}]9;notificação falsa`)).toBe('ok');
  });

  it('apaga CSI de cor, de piscar e de apagar tela', () => {
    expect(sanitizeDisplay(`${ESC}[31mvermelho${ESC}[0m`)).toBe('vermelho');
    expect(sanitizeDisplay(`${ESC}[5mpisca`)).toBe('pisca');
    expect(sanitizeDisplay(`${ESC}[2J${ESC}[H MODELO FALSO`)).toBe('MODELO FALSO');
  });

  it('apaga os equivalentes C1 de um byte (OSC e CSI)', () => {
    expect(sanitizeDisplay('\u009d0;x\u0007fim')).toBe('fim');
    expect(sanitizeDisplay('\u009b31mfim')).toBe('fim');
  });

  it('troca \r\n por espaço em vez de colar as duas partes', () => {
    expect(sanitizeDisplay(`C:${BS}a\r\nC:${BS}b`)).toBe(`C:${BS}a C:${BS}b`);
    expect(sanitizeDisplay('a\tb')).toBe('a b');
  });

  it('apaga DEL e os C1 que sobraram, e colapsa o espaço', () => {
    expect(sanitizeDisplay('a\u007fb\u0090c')).toBe('abc');
    expect(sanitizeDisplay('  a     b  ')).toBe('a b');
  });

  it('corta em `max` caracteres contando o `…` (campo de 10 kB)', () => {
    const enorme = `C:${BS}${'A'.repeat(10_240)}`;
    const limpo = sanitizeDisplay(enorme, 80);
    expect(limpo.length).toBe(80);
    expect(limpo.endsWith('…')).toBe(true);
    expect(sanitizeDisplay('x'.repeat(1000)).length).toBe(DISPLAY_MAX);
    expect(sanitizeDisplay('x'.repeat(1000), 64).length).toBe(64);
  });

  it('não corta o que já cabe, e devolve vazio pro que não é string', () => {
    expect(sanitizeDisplay('claude-sonnet-4-5', 64)).toBe('claude-sonnet-4-5');
    expect(sanitizeDisplay('five_hour', 64)).toBe('five_hour');
    expect(sanitizeDisplay(undefined)).toBe('');
    expect(sanitizeDisplay(42)).toBe('');
    expect(sanitizeDisplay('abc', 0)).toBe('');
  });

  it('não parte um par substituto ao meio', () => {
    // O emoji ocupa duas unidades UTF-16; o corte não pode deixar meia.
    const limpo = sanitizeDisplay(`ab\u{1f4a5}cd`, 4);
    expect(limpo).toBe('ab…');
    expect(/[\ud800-\udbff]$/.test(limpo.slice(0, -1))).toBe(false);
  });

  it('a linha inteira da statusline sai limpa mesmo com tudo junto', () => {
    const cru = `0 ctx · ${ESC}]0;X${BEL}${ESC}[31mFable · US$ 1,50 · ${ESC}]0;J${BEL}5h 23%`;
    const limpo = sanitizeDisplay(cru, 500);
    expect(isDisplaySafe(limpo)).toBe(true);
    expect(limpo).toContain('Fable');
    expect(limpo).toContain('US$ 1,50');
  });

  /**
   * Trojan Source: `U+202E` (RLO) reordena a RENDERIZAÇÃO sem mudar um byte, e
   * os de largura zero somem da tela. Um `cwd` de transcript com RLO faz a
   * tabela do `bridge usage` e o `title` do painel mostrarem um caminho que
   * não é o caminho.
   */
  it('apaga os caracteres de formato invisíveis (Trojan Source)', () => {
    const rlo = 'C:/proj/gnp.exe' + '‮' + 'txt.dat';
    expect(isDisplaySafe(rlo)).toBe(false);
    const limpo = sanitizeDisplay(rlo);
    expect(limpo).not.toContain('‮');
    expect(isDisplaySafe(limpo)).toBe(true);

    for (const invisivel of ['​', '‎', '‏', '‪', '⁠', '⁦', '⁯', '﻿']) {
      const sujo = `claude${invisivel}-sonnet-4-5`;
      expect(isDisplaySafe(sujo)).toBe(false);
      expect(sanitizeDisplay(sujo)).toBe('claude-sonnet-4-5');
    }
  });

  it('controle: acento, cedilha e o separador da statusline continuam passando', () => {
    expect(sanitizeDisplay('Uso · manutenção · São Paulo')).toBe('Uso · manutenção · São Paulo');
    expect(isDisplaySafe('87k ctx · Fable 5.1 · US$ 3,42')).toBe(true);
  });
});
