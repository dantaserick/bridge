import { DEFAULT_KEYBINDINGS, KEY_ACTIONS } from '@bridge/shared';
import type { KeyAction } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { handleKeyDown, isMatchableChord, matchEvent, parseBindings, parseChord } from '../src/keys.js';
import type { Chord, KeyHandlers, ParsedBindings } from '../src/keys.js';

/** Evento sintético: `matchEvent` só lê estas seis propriedades. */
function ev(
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'repeat'>> = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
    repeat: mods.repeat ?? false,
  } as KeyboardEvent;
}

/** Evento que a chord descreve — o que o browser mandaria ao apertar aquilo. */
function eventFor(chord: Chord, repeat = false): KeyboardEvent {
  return ev(chord.key, { ctrlKey: chord.ctrl, shiftKey: chord.shift, altKey: chord.alt, metaKey: chord.meta, repeat });
}

describe('parseChord', () => {
  it('separa modificadores e normaliza letra pra minúscula', () => {
    expect(parseChord('Ctrl+Shift+D')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'd' });
  });

  it('aceita os três modificadores juntos', () => {
    expect(parseChord('Ctrl+Shift+Alt+N')).toEqual({ ctrl: true, shift: true, alt: true, meta: false, key: 'n' });
  });

  it('mantém o nome das teclas nomeadas', () => {
    expect(parseChord('Alt+ArrowLeft')).toEqual({ ctrl: false, shift: false, alt: true, meta: false, key: 'ArrowLeft' });
    expect(parseChord('Alt+ArrowDown').key).toBe('ArrowDown');
  });

  it('normaliza nome de tecla escrito em caixa livre', () => {
    expect(parseChord('alt+arrowleft').key).toBe('ArrowLeft');
    expect(parseChord('Ctrl+esc').key).toBe('Escape');
    expect(parseChord('ctrl+enter').key).toBe('Enter');
  });

  it('mantém pontuação como está', () => {
    expect(parseChord('Ctrl+Shift+[')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: '[' });
    expect(parseChord('Ctrl+Shift+]').key).toBe(']');
  });

  it('entende a própria tecla + como tecla', () => {
    expect(parseChord('Ctrl++').key).toBe('+');
  });

  it('reconhece meta/cmd', () => {
    expect(parseChord('Meta+K')).toEqual({ ctrl: false, shift: false, alt: false, meta: true, key: 'k' });
    expect(parseChord('Cmd+K').meta).toBe(true);
  });

  it('devolve tecla vazia quando a combinação é só modificador (config inválida)', () => {
    expect(parseChord('Ctrl+Shift').key).toBe('');
    expect(parseChord('').key).toBe('');
  });

  /**
   * Tecla de função sem modificador (`/^f\d{1,2}$/` no `normalizeKey`): o
   * `keybindings.json` aceita a string, e ela tem que continuar casando.
   */
  it('tecla de função vira um acorde sem modificador que o matchEvent casa', () => {
    expect(parseChord('F5')).toEqual({ ctrl: false, shift: false, alt: false, meta: false, key: 'F5' });
    expect(parseChord('f5').key).toBe('F5');
    expect(isMatchableChord(parseChord('F5'))).toBe(true);
  });

  it('parseia todos os 19 defaults sem tecla vazia', () => {
    expect(KEY_ACTIONS).toHaveLength(19);
    for (const action of KEY_ACTIONS) {
      expect(parseChord(DEFAULT_KEYBINDINGS[action]).key, action).not.toBe('');
    }
  });
});

describe('matchEvent', () => {
  it('casa a combinação exata', () => {
    const chord = parseChord('Ctrl+Shift+D');
    expect(matchEvent(ev('D', { ctrlKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true }), chord)).toBe(true);
  });

  it('exige os modificadores exatos — nem a mais, nem a menos', () => {
    const chord = parseChord('Ctrl+Shift+D');
    expect(matchEvent(ev('d', { ctrlKey: true }), chord)).toBe(false);
    expect(matchEvent(ev('d', { shiftKey: true }), chord)).toBe(false);
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true, altKey: true }), chord)).toBe(false);
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true, metaKey: true }), chord)).toBe(false);
  });

  it('compara tecla nomeada exatamente', () => {
    const chord = parseChord('Alt+ArrowLeft');
    expect(matchEvent(ev('ArrowLeft', { altKey: true }), chord)).toBe(true);
    expect(matchEvent(ev('ArrowRight', { altKey: true }), chord)).toBe(false);
  });

  it('aceita a pontuação deslocada que o Shift produz (Ctrl+Shift+[ chega como "{")', () => {
    expect(matchEvent(ev('{', { ctrlKey: true, shiftKey: true }), parseChord('Ctrl+Shift+['))).toBe(true);
    expect(matchEvent(ev('}', { ctrlKey: true, shiftKey: true }), parseChord('Ctrl+Shift+]'))).toBe(true);
    expect(matchEvent(ev('[', { ctrlKey: true, shiftKey: true }), parseChord('Ctrl+Shift+['))).toBe(true);
    expect(matchEvent(ev('{', { ctrlKey: true, shiftKey: true }), parseChord('Ctrl+Shift+]'))).toBe(false);
  });

  it('nunca casa digitação comum — o resto vai pro xterm', () => {
    for (const action of KEY_ACTIONS) {
      const chord = parseChord(DEFAULT_KEYBINDINGS[action]);
      expect(matchEvent(ev('a'), chord), action).toBe(false);
      expect(matchEvent(ev('Enter'), chord), action).toBe(false);
      expect(matchEvent(ev('c', { ctrlKey: true }), chord), action).toBe(false);
    }
  });

  it('nunca casa combinação inválida', () => {
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true }), parseChord('Ctrl+Shift'))).toBe(false);
  });

  it('só compara a forma da combinação — repetição não é assunto dele', () => {
    const chord = parseChord('Ctrl+Shift+D');
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchEvent(ev('d', { ctrlKey: true, shiftKey: true, repeat: true }), chord)).toBe(true);
  });

  it('cada default casa exatamente uma ação', () => {
    const chords = KEY_ACTIONS.map((action) => [action, parseChord(DEFAULT_KEYBINDINGS[action])] as const);
    for (const [action, chord] of chords) {
      const matched = chords.filter(([, other]) => matchEvent(eventFor(chord), other)).map(([a]) => a);
      expect(matched, action).toEqual([action as KeyAction]);
    }
  });
});

describe('handleKeyDown — consumir x disparar', () => {
  /** Evento espião: guarda se a tecla foi consumida pelo atalho. */
  function spy(key: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'repeat'>> = {}) {
    const consumed = { prevented: 0, stopped: 0 };
    const event = {
      ...ev(key, mods),
      preventDefault: () => {
        consumed.prevented += 1;
      },
      stopPropagation: () => {
        consumed.stopped += 1;
      },
    } as unknown as KeyboardEvent;
    return { event, consumed };
  }

  function setup(): { chords: ParsedBindings; fired: KeyAction[]; handlers: KeyHandlers } {
    const fired: KeyAction[] = [];
    const handlers: KeyHandlers = {};
    for (const action of KEY_ACTIONS) handlers[action] = () => fired.push(action);
    return { chords: parseBindings(DEFAULT_KEYBINDINGS), fired, handlers };
  }

  it('combinação conhecida sem repeat: consome e dispara', () => {
    const { chords, fired, handlers } = setup();
    const { event, consumed } = spy('D', { ctrlKey: true, shiftKey: true });
    expect(handleKeyDown(chords, handlers, event)).toBe('fired');
    expect(consumed).toEqual({ prevented: 1, stopped: 1 });
    expect(fired).toEqual(['pane.splitV']);
  });

  /**
   * A regressão que este teste tranca: se o autorepeat não fosse consumido, o
   * `Ctrl+D` (EOF) e o `Ctrl+C` chegariam no xterm da sessão viva depois do
   * atraso de repetição do sistema.
   */
  it('combinação conhecida COM repeat: consome mas não dispara', () => {
    const { chords, fired, handlers } = setup();
    const { event, consumed } = spy('D', { ctrlKey: true, shiftKey: true, repeat: true });
    expect(handleKeyDown(chords, handlers, event)).toBe('consumed');
    expect(consumed).toEqual({ prevented: 1, stopped: 1 });
    expect(fired).toEqual([]);
  });

  it('nenhum dos 17 atalhos vaza pro terminal enquanto está repetindo', () => {
    for (const action of KEY_ACTIONS) {
      const { chords, fired, handlers } = setup();
      const chord = parseChord(DEFAULT_KEYBINDINGS[action]);
      const { event, consumed } = spy(chord.key, {
        ctrlKey: chord.ctrl,
        shiftKey: chord.shift,
        altKey: chord.alt,
        metaKey: chord.meta,
        repeat: true,
      });
      expect(handleKeyDown(chords, handlers, event), action).toBe('consumed');
      expect(consumed.prevented, action).toBe(1);
      expect(fired, action).toEqual([]);
    }
  });

  it('tecla comum (mesmo repetindo) passa direto pro terminal', () => {
    const { chords, fired, handlers } = setup();
    const { event, consumed } = spy('a', { repeat: true });
    expect(handleKeyDown(chords, handlers, event)).toBe('ignored');
    expect(consumed).toEqual({ prevented: 0, stopped: 0 });
    expect(fired).toEqual([]);

    const plain = spy('c', { ctrlKey: true });
    expect(handleKeyDown(chords, handlers, plain.event)).toBe('ignored');
    expect(plain.consumed).toEqual({ prevented: 0, stopped: 0 });
  });

  it('sem handler pra ação (diálogo aberto) a tecla não é consumida', () => {
    const chords = parseBindings(DEFAULT_KEYBINDINGS);
    const { event, consumed } = spy('D', { ctrlKey: true, shiftKey: true });
    expect(handleKeyDown(chords, {}, event)).toBe('ignored');
    expect(consumed).toEqual({ prevented: 0, stopped: 0 });
  });

  it('dispara no máximo uma ação por evento', () => {
    const { chords, fired, handlers } = setup();
    const { event } = spy('ArrowLeft', { altKey: true });
    handleKeyDown(chords, handlers, event);
    expect(fired).toEqual(['pane.left']);
  });
});

/**
 * `parseChord` guarda o nome CRU quando não reconhece a tecla (descartar ali
 * apagaria a pista do que foi digitado). Quem precisa saber se aquela
 * combinação um dia dispara — a seção "Atalhos" do diálogo, que avisa — usa
 * este predicado.
 */
describe('isMatchableChord (a combinação chega a disparar?)', () => {
  it('todo atalho de fábrica é casável', () => {
    for (const action of KEY_ACTIONS) {
      expect(isMatchableChord(parseChord(DEFAULT_KEYBINDINGS[action])), action).toBe(true);
    }
  });

  it('letra, pontuação e tecla nomeada passam', () => {
    for (const spec of ['Ctrl+D', 'Ctrl+,', 'Alt+ArrowLeft', 'Shift+Enter', 'Ctrl+F5', 'Ctrl+Space']) {
      expect(isMatchableChord(parseChord(spec)), spec).toBe(true);
    }
  });

  it('só modificador, vazio ou nome de tecla que não existe: nunca dispara', () => {
    for (const spec of ['', 'Ctrl+', 'Ctrl+Shift', 'Ctrl+nada', 'Alt+ArrowLeftt']) {
      expect(isMatchableChord(parseChord(spec)), spec).toBe(false);
    }
  });

  /**
   * Contraprova: nenhuma tecla QUE UM TECLADO PRODUZ casa com o que ele recusa.
   * (`matchEvent` compara nome com nome, então um evento sintético com
   * `key: 'nada'` casaria — só que o DOM nunca emite um.)
   */
  it('nenhuma tecla de verdade casa com o que ele recusa', () => {
    const chord = parseChord('Ctrl+nada');
    expect(isMatchableChord(chord)).toBe(false);
    for (const key of ['n', 'a', 'Enter', 'ArrowLeft', 'F5', ' ']) {
      expect(matchEvent(ev(key, { ctrlKey: true }), chord), key).toBe(false);
    }
  });
});
