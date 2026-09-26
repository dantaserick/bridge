/**
 * Regra de copiar/colar do terminal, separada do React pra poder ser testada
 * sem DOM e sem xterm.
 *
 * Por que isto existe: o xterm 5.5 (`src/common/input/Keyboard.ts`) transforma
 * Ctrl+letra em byte de controle e CANCELA o keydown — Ctrl+V virava `^V`
 * (0x16) mandado ao PTY e a colagem nativa do Chromium nunca acontecia; Ctrl+C
 * virava `^C` (SIGINT) e nunca copiava. Só Shift+Insert e Ctrl+Insert escapavam,
 * por uma exceção do próprio xterm (`case 45`). Quem instalou o Bridge colava
 * uma URL de fora e não acontecia nada.
 *
 * A convenção adotada é a do Windows Terminal / VS Code:
 *
 * - **Colar:** Ctrl+V, Ctrl+Shift+V e Shift+Insert.
 * - **Copiar:** Ctrl+C *com seleção* (sem seleção continua sendo `^C`/SIGINT,
 *   que é o uso legítimo de Ctrl+C num terminal) e Ctrl+Insert.
 * - Tudo o mais segue pro xterm como sempre (`passthrough`).
 *
 * Duas exceções de propósito:
 *
 * - **Alt ou Meta seguros = `passthrough`.** Em teclado ABNT2 o AltGr chega
 *   como Ctrl+Alt, e sequestrar Ctrl+Alt+V/C quebraria a digitação normal.
 * - **Ctrl+Shift+C = `passthrough`,** porque é o atalho "abrir Claude" do app
 *   (spec §6). Quem quiser copiar com ele remapeia no `keybindings.json`.
 */

/** O que a UI deve fazer com um evento de teclado do terminal. */
export type TerminalKeyAction = 'copy' | 'paste' | 'passthrough';

/**
 * Só os campos do `KeyboardEvent` que a regra olha — assim o teste monta o
 * evento como objeto literal, sem DOM.
 */
export interface TerminalKeyEvent {
  /** `'keydown'`, `'keyup'`, `'keypress'`. Só `keydown` decide alguma coisa. */
  type: string;
  /** `KeyboardEvent.key` (`'v'`, `'V'`, `'Insert'`). */
  key: string;
  /** `KeyboardEvent.code` (`'KeyV'`, `'Insert'`) — usado quando `key` não é letra. */
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * A letra da tecla em minúscula, ou `''` quando não é letra.
 *
 * `key` é a fonte principal (respeita o layout: quem usa Dvorak espera colar na
 * tecla onde ESTÁ o V). `code` só entra quando `key` não serve — teclas mortas e
 * composição chegam como `'Dead'`/`'Unidentified'`, e aí a posição física é a
 * única informação que sobrou.
 */
function letterOf(ev: TerminalKeyEvent): string {
  if (ev.key.length === 1) {
    const lower = ev.key.toLowerCase();
    return lower >= 'a' && lower <= 'z' ? lower : '';
  }
  return /^Key[A-Z]$/.test(ev.code) ? ev.code.slice(3).toLowerCase() : '';
}

/**
 * Decide o que fazer com uma tecla digitada dentro do terminal.
 *
 * @param ev evento de teclado (só `keydown` produz `copy`/`paste`).
 * @param hasSelection se o xterm tem seleção agora — é o que separa
 *   "Ctrl+C copia" de "Ctrl+C manda SIGINT".
 */
export function terminalKeyAction(ev: TerminalKeyEvent, hasSelection: boolean): TerminalKeyAction {
  if (ev.type !== 'keydown') return 'passthrough';
  // AltGr do ABNT2 chega como Ctrl+Alt; Meta é do sistema. Nenhum dos dois é nosso.
  if (ev.altKey || ev.metaKey) return 'passthrough';

  if (ev.key === 'Insert' || ev.code === 'Insert') {
    if (ev.ctrlKey && !ev.shiftKey) return hasSelection ? 'copy' : 'passthrough';
    if (ev.shiftKey && !ev.ctrlKey) return 'paste';
    return 'passthrough';
  }

  if (!ev.ctrlKey) return 'passthrough';

  const letter = letterOf(ev);
  // Ctrl+V e Ctrl+Shift+V colam.
  if (letter === 'v') return 'paste';
  // Ctrl+C copia SÓ com seleção; Ctrl+Shift+C é o "abrir Claude" do app.
  if (letter === 'c' && !ev.shiftKey && hasSelection) return 'copy';
  return 'passthrough';
}
