/**
 * O foco "de mentira" do xterm (14/09/2026).
 *
 * O xterm só sabe se está focado pelos eventos `focus`/`blur` da textarea
 * dele — e é nesse par que ele manda ao programa `ESC[I`/`ESC[O` (modo
 * `?1004`, que o pwsh e o Claude Code ligam) e escolhe desenhar o cursor cheio
 * ou vazado. O que o dono viu: cursor sem preenchimento e a barra de espaço
 * morta enquanto as letras continuavam entrando, e tudo voltando ao trocar de
 * tela. As letras entrarem prova que a textarea É o elemento ativo; o cursor
 * vazado prova que o xterm acredita no contrário. É o estado em que um `blur`
 * disparou (janela que perdeu o foco, diálogo) e o
 * `focus` de volta nunca foi reemitido — o Chromium não repete `focus` num
 * elemento que já é o ativo, e o `textarea.focus()` que o `Pane` chama a cada
 * ativação é silencioso pelo mesmo motivo. Trocar de tela resolve porque
 * esconder o painel (`display: none`) tira o foco de verdade e devolvê-lo
 * dispara o par inteiro.
 *
 * A decisão é pura pra ser testável: precisa de resync quando a textarea é o
 * ativo, o documento tem o foco, e o xterm ainda assim se acha desfocado. O
 * conserto (quem chama faz) é `blur()` + `focus()` na textarea — isso reemite
 * os dois eventos, o `ESC[O`/`ESC[I` sai na ordem certa e o cursor volta a
 * encher, na PRÓPRIA tecla que a pessoa apertou.
 */
export interface FocusSnapshot {
  /** `document.activeElement === term.textarea`. */
  textareaIsActive: boolean;
  /** `document.hasFocus()` — sem o foco da janela nada disso é sobre nós. */
  documentHasFocus: boolean;
  /** O xterm se acha focado (`term.element.classList.contains('focus')`). */
  xtermBelievesFocused: boolean;
}

export function focusResyncNeeded(s: FocusSnapshot): boolean {
  return s.textareaIsActive && s.documentHasFocus && !s.xtermBelievesFocused;
}
