import { KEY_ACTIONS } from '@bridge/shared';
import type { KeyAction, Keybindings } from '@bridge/shared';
import { useEffect, useMemo, useRef } from 'react';

/** Uma combinação já parseada: modificadores + a tecla normalizada. */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Letra em minúscula (`'d'`), pontuação como está (`'['`) ou nome canônico (`'ArrowLeft'`). */
  key: string;
}

const MODIFIERS: Record<string, keyof Omit<Chord, 'key'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
};

/** Nomes de tecla escritos em caixa livre no `keybindings.json` → forma do DOM. */
const NAMED_KEYS: Record<string, string> = {
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: ' ',
};

/**
 * O que o Shift produz em cima de cada pontuação num layout US: apertar
 * `Ctrl+Shift+[` chega no browser como `key === '{'`, não `'['`. Sem esta
 * tabela os atalhos de workspace anterior/próximo nunca disparariam.
 */
const SHIFTED_PUNCTUATION: Record<string, string> = {
  '[': '{',
  ']': '}',
  ',': '<',
  '.': '>',
  '/': '?',
  ';': ':',
  "'": '"',
  '-': '_',
  '=': '+',
  '`': '~',
  '\\': '|',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
};

function normalizeKey(raw: string): string {
  if (raw.length === 1) return raw.toLowerCase();
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return named;
  if (/^f\d{1,2}$/i.test(raw)) return `F${raw.slice(1)}`;
  return raw;
}

/**
 * `'Ctrl+Shift+D'` → `{ ctrl: true, shift: true, alt: false, meta: false, key: 'd' }`.
 * Combinação sem tecla (só modificadores, ou string vazia) devolve `key: ''`,
 * que nunca casa — configuração inválida não derruba a UI.
 */
export function parseChord(spec: string): Chord {
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  const rest: string[] = [];

  for (const token of spec.split('+')) {
    const trimmed = token.trim();
    const modifier = MODIFIERS[trimmed.toLowerCase()];
    if (modifier) {
      chord[modifier] = true;
      continue;
    }
    rest.push(trimmed);
  }

  // `'Ctrl++'` e `'+'` viram dois tokens vazios no split — é a tecla `+` em
  // pessoa. Um vazio só (string vazia) é combinação inválida.
  const named = rest.filter((token) => token !== '');
  const plus = rest.length - named.length >= 2;
  const key = named.length > 0 ? named[named.length - 1] : plus ? '+' : '';
  chord.key = key ? normalizeKey(key) : '';
  return chord;
}

/**
 * Os nomes de tecla que o `matchEvent` consegue casar com um `event.key`: os
 * canônicos da tabela acima e as teclas de função.
 *
 * `parseChord` devolve o texto CRU quando não reconhece o nome (`'Ctrl+nada'`
 * → `key: 'nada'`), porque descartar ali transformaria um erro de digitação em
 * "combinação vazia" e apagaria a pista. Quem quer saber se a combinação um
 * dia vai disparar pergunta aqui — é o que a seção "Atalhos" usa pra avisar
 * que aquela linha do `keybindings.json` é letra morta.
 */
const MATCHABLE_KEY_NAMES = new Set(Object.values(NAMED_KEYS));

export function isMatchableChord(chord: Chord): boolean {
  if (!chord.key) return false;
  if (chord.key.length === 1) return true;
  if (/^F\d{1,2}$/.test(chord.key)) return true;
  return MATCHABLE_KEY_NAMES.has(chord.key);
}

/**
 * Modificadores conferem exatamente (nem a mais, nem a menos); letra compara
 * sem caixa, tecla nomeada compara literal. Pontuação também aceita a variante
 * deslocada quando a combinação pede Shift.
 */
export function matchEvent(event: KeyboardEvent, chord: Chord): boolean {
  if (!chord.key) return false;
  if (event.ctrlKey !== chord.ctrl) return false;
  if (event.shiftKey !== chord.shift) return false;
  if (event.altKey !== chord.alt) return false;
  if (event.metaKey !== chord.meta) return false;

  if (chord.key.length === 1) {
    const pressed = event.key.toLowerCase();
    if (pressed === chord.key.toLowerCase()) return true;
    const shifted = chord.shift ? SHIFTED_PUNCTUATION[chord.key] : undefined;
    return shifted !== undefined && event.key === shifted;
  }
  return event.key === chord.key;
}

export type KeyHandlers = Partial<Record<KeyAction, () => void>>;

/** Combinações já parseadas, na ordem de `KEY_ACTIONS`. */
export type ParsedBindings = ReadonlyArray<readonly [KeyAction, Chord]>;

export function parseBindings(bindings: Keybindings): ParsedBindings {
  return KEY_ACTIONS.map((action) => [action, parseChord(bindings[action])] as const);
}

/**
 * O que fazer com um `keydown`. Separa duas decisões que não são a mesma:
 *
 * - **consumir** a tecla — vale pra qualquer evento cuja *forma* casa com um
 *   atalho, inclusive as repetições do autorepeat. Deixar a repetição passar
 *   entregaria `Ctrl+D` (EOF) e `Ctrl+C` ao xterm da sessão viva depois do
 *   atraso de repetição do sistema, que é pior do que não fazer nada.
 * - **disparar** a ação — só no `keydown` de verdade (`repeat === false`):
 *   segurar a tecla criaria uma cascata de splits (ou de agentes) contra um
 *   estado que ainda é o de antes do primeiro.
 *
 * Ação sem handler registrado (o diálogo desarma todos) não consome nada: a
 * tecla segue o caminho normal.
 */
export function handleKeyDown(
  chords: ParsedBindings,
  handlers: KeyHandlers,
  event: KeyboardEvent,
): 'ignored' | 'consumed' | 'fired' {
  for (const [action, chord] of chords) {
    if (!matchEvent(event, chord)) continue;
    const handler = handlers[action];
    if (!handler) continue;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return 'consumed';
    handler();
    return 'fired';
  }
  return 'ignored';
}

/**
 * Um único `keydown` no `window`, em fase de captura, delegando a decisão pra
 * `handleKeyDown`. Tecla que não é atalho passa direto — é digitação e
 * pertence ao xterm.
 */
export function useKeybindings(bindings: Keybindings, handlers: KeyHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const chords = useMemo(() => parseBindings(bindings), [bindings]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      handleKeyDown(chords, handlersRef.current, event);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [chords]);
}
