import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_DEFAULTS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  resolveTerminalPrefs,
} from '../src/terminalPrefs.js';
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';

/** Nomes de fonte da lista, na ordem, sem aspas nem espaço em volta. */
function families(stack: string): string[] {
  return stack.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, ''));
}

describe('TERMINAL_DEFAULTS', () => {
  it('é o DEFAULT_STORED_CONFIG.terminal do shared, não uma cópia à mão', () => {
    // Carry-over do lote de 04/09/2026: o default do terminal era escrito duas
    // vezes (aqui e no DEFAULT_CONFIG do core). Agora a UI é um alias do
    // shared — e este teste é o que impede a cópia de voltar.
    expect(TERMINAL_DEFAULTS).toEqual(DEFAULT_STORED_CONFIG.terminal);
  });

  it('é uma cópia própria: mexer nele não contamina o default do shared', () => {
    expect(TERMINAL_DEFAULTS).not.toBe(DEFAULT_STORED_CONFIG.terminal);
  });

  it('usa corpo 12', () => {
    expect(TERMINAL_DEFAULTS.fontSize).toBe(12);
  });

  it('põe a Cascadia Mono na frente e o Consolas logo atrás', () => {
    const list = families(TERMINAL_DEFAULTS.fontFamily);
    // Cascadia Mono: box-drawing 128/128, blocos 32/32, braille 256/256, tudo
    // no mesmo avanço do 'W' — a célula do xterm bate com o glifo.
    expect(list.indexOf('Cascadia Mono')).toBe(0);
    // Consolas é a rede de segurança (sempre presente no Windows) se o pacote
    // do Windows Terminal, que registra a Cascadia, não estiver na máquina.
    expect(list.indexOf('Consolas')).toBe(1);
  });

  it('mantém o Geist Mono na lista, mas atrás das duas monos com símbolos', () => {
    const list = families(TERMINAL_DEFAULTS.fontFamily);
    // O subset embutido do Geist Mono não tem box-drawing nem blocos; na
    // frente, ele fazia cada símbolo cair num fallback com avanço diferente
    // do da célula (que o xterm mede com o 'W' do próprio Geist).
    expect(list.indexOf('Geist Mono')).toBeGreaterThan(list.indexOf('Consolas'));
  });

  it('termina em monospace genérico', () => {
    expect(families(TERMINAL_DEFAULTS.fontFamily).at(-1)).toBe('monospace');
  });
});

describe('resolveTerminalPrefs', () => {
  it('sem props devolve o default', () => {
    expect(resolveTerminalPrefs(undefined)).toEqual(TERMINAL_DEFAULTS);
    expect(resolveTerminalPrefs({})).toEqual(TERMINAL_DEFAULTS);
  });

  it('respeita fonte e corpo válidos', () => {
    expect(resolveTerminalPrefs({ fontFamily: 'Cascadia Mono, monospace', fontSize: 16 })).toEqual({
      fontFamily: 'Cascadia Mono, monospace',
      fontSize: 16,
    });
  });

  it('fonte vazia ou só espaço cai no default', () => {
    expect(resolveTerminalPrefs({ fontFamily: '' }).fontFamily).toBe(TERMINAL_DEFAULTS.fontFamily);
    expect(resolveTerminalPrefs({ fontFamily: '   ' }).fontFamily).toBe(TERMINAL_DEFAULTS.fontFamily);
  });

  it('corpo fora do intervalo, NaN ou não-número cai no default', () => {
    for (const size of [TERMINAL_FONT_SIZE_MIN - 1, TERMINAL_FONT_SIZE_MAX + 1, Number.NaN, Infinity]) {
      expect(resolveTerminalPrefs({ fontSize: size }).fontSize).toBe(TERMINAL_DEFAULTS.fontSize);
    }
    expect(resolveTerminalPrefs({ fontSize: '14' as unknown as number }).fontSize).toBe(TERMINAL_DEFAULTS.fontSize);
  });

  it('aceita as pontas do intervalo', () => {
    expect(resolveTerminalPrefs({ fontSize: TERMINAL_FONT_SIZE_MIN }).fontSize).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(resolveTerminalPrefs({ fontSize: TERMINAL_FONT_SIZE_MAX }).fontSize).toBe(TERMINAL_FONT_SIZE_MAX);
  });
});

/**
 * O token `--font-mono-terminal` do `theme.css` é um ESPELHO manual do
 * `TERMINAL_DEFAULTS.fontFamily` (o CSS não importa TypeScript). Ele é o que a
 * prévia do diálogo de configurações e qualquer amostra de terminal na UI
 * usam quando não há valor escolhido — se os dois divergirem, a prévia passa a
 * mentir sobre o que o xterm vai desenhar. Este teste lê o arquivo e compara,
 * que é o único jeito de a divergência doer aqui e não na tela do dono.
 */
describe('--font-mono-terminal (theme.css)', () => {
  it('é literalmente a mesma lista do TERMINAL_DEFAULTS.fontFamily', () => {
    const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
    const match = /--font-mono-terminal:\s*([^;]+);/.exec(css);
    expect(match, 'token --font-mono-terminal não existe mais em theme.css').not.toBeNull();
    expect(match?.[1]?.trim()).toBe(TERMINAL_DEFAULTS.fontFamily);
  });
});
