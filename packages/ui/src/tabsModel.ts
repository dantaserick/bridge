import type { KeyAction, Keybindings, Language, MessageKey } from '@bridge/shared';
import { tUi } from './i18n.js';
import type { Chord } from './keys.js';
import { parseChord } from './keys.js';
// O nome por extenso de cada ação já existe pra tabela do diálogo de
// configurações; a barra usa a MESMA fonte pra o tooltip não divergir dela.
import { keyActionLabel } from './settingsModel.js';

/**
 * As dicas da direita da barra de abas. Elas eram texto morto; desde a 0.8.0
 * cada uma é o BOTÃO da ação que anuncia.
 *
 * 0.9.0 — as teclas deixaram de ser literais. Elas saem do `Keybindings` em
 * vigor (o `GET /api/keybindings`, que já traz o `keybindings.json` do perfil
 * mesclado por cima dos defaults), então rebindar `pane.close` no arquivo muda
 * a legenda junto. Antes disso a legenda mentia depois de qualquer rebind: o
 * clique ia pro lugar certo (usa a ação) e o `<kbd>` mostrava a tecla de
 * fábrica.
 *
 * 0.11.2 — a combinação saiu da tela. Cinco dicas com os `<kbd>` de cada uma
 * poluíam a barra ("ficou muito poluído", palavra do dono): o que se vê agora
 * é o NOME da ação ("divide", "navega", "uso"), e a combinação vive no
 * tooltip e na tabela de Configurações → Atalhos. Ela continua saindo do
 * `Keybindings` em vigor, então o tooltip não mente depois de um rebind.
 */

/** Um botão de dica: uma ação, o nome que aparece na barra e o tooltip. */
export interface TabHintButton {
  /** A ação que o clique dispara — a mesma do teclado, pelo `KeyHandlers`. */
  action: KeyAction;
  /**
   * O que se LÊ no botão: o nome curto da ação ("divide", "uso") ou, na
   * navegação, a seta — que ali é o nome, não a tecla. Nunca a combinação.
   */
  label: string;
  /** Tooltip e `aria-label`: nome da ação por extenso + a combinação inteira. */
  title: string;
}

/**
 * Um grupo de dicas: um verbo curto ("divide", "navega") e um ou dois botões.
 *
 * O grupo existe por causa da navegação. Até a 0.8.0 a dica `Alt ←→` era UM
 * botão que disparava sempre `pane.right`: quem clicava na última coluna
 * esperando "a próxima" não ia a lugar nenhum, e quem queria voltar pra
 * esquerda não tinha onde clicar. Agora são dois botões — `pane.left` e
 * `pane.right` — com o verbo escrito uma vez só.
 */
export interface TabHintGroup {
  /** Chave estável de render (não é ação: um grupo pode ter duas). */
  id: string;
  /** O verbo curto do grupo ("divide", "navega"). */
  label: string;
  /**
   * Se o verbo do grupo é desenhado ao lado dos botões. Só com mais de um
   * botão: sozinho, o botão JÁ carrega o verbo como rótulo, e repeti-lo
   * escreveria "divide divide" na barra.
   */
  showLabel: boolean;
  buttons: TabHintButton[];
}

/** Os quatro campos booleanos de um `Chord` — os modificadores. */
type ChordModifier = Exclude<keyof Chord, 'key'>;

/** Como cada modificador aparece na legenda — sempre nesta ordem. */
const MODIFIER_LABELS: ReadonlyArray<readonly [ChordModifier, string]> = [
  ['ctrl', 'Ctrl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['meta', 'Win'],
];

/**
 * Teclas nomeadas que ficam melhor como símbolo na barra: a seta ocupa uma
 * célula, `ArrowLeft` ocupa nove e empurra as outras dicas pra fora.
 */
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
};

/**
 * A única tecla nomeada cujo rótulo é uma PALAVRA (e portanto copy). As setas,
 * o `Esc` e as letras são símbolo ou nome próprio, e não passam pelo catálogo.
 */
const SPACE_KEY = ' ';

/**
 * `'Ctrl+Shift+D'` → `['Ctrl', 'Shift', 'D']`; `'Alt+ArrowLeft'` → `['Alt', '←']`.
 *
 * Passa pelo MESMO `parseChord` que decide se a tecla casa, e não por um split
 * ingênuo: assim a legenda mostra a combinação como o Bridge a entendeu
 * (ordem canônica, `control` virando `Ctrl`, `cmd` virando `Win`), não como
 * ela foi digitada no arquivo. Combinação inválida (só modificadores, string
 * vazia) devolve lista vazia — é o mesmo `key: ''` que nunca casa.
 */
export function formatChord(spec: string, lang: Language): string[] {
  const chord = parseChord(spec);
  if (!chord.key) return [];
  const keys = MODIFIER_LABELS.filter(([flag]) => chord[flag] === true).map(([, label]) => label);
  const named = chord.key === SPACE_KEY ? tUi(lang, 'tabs.tecla.espaco') : KEY_LABELS[chord.key];
  keys.push(named ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
  return keys;
}

/**
 * A ordem em que os grupos aparecem, quais ações cada um anuncia e o NOME de
 * cada botão na barra. O nome é curto de propósito: é uma barra de abas, não
 * uma legenda — o nome por extenso (`keyActionLabel`) vai pro tooltip.
 */
const HINT_SPECS: ReadonlyArray<{
  id: string;
  label: MessageKey;
  buttons: ReadonlyArray<{ action: KeyAction; label: MessageKey | null }>;
}> = [
  { id: 'split', label: 'tabs.dica.divide', buttons: [{ action: 'pane.splitV', label: 'tabs.dica.divide' }] },
  // As setas SÃO o nome dos dois sentidos ("esquerda"/"direita" ocupariam meia
  // barra) — e por serem símbolo não têm chave (`label: null`). O verbo
  // "navega" fica ao lado delas, escrito uma vez só.
  {
    id: 'nav',
    label: 'tabs.dica.navega',
    buttons: [
      { action: 'pane.left', label: null },
      { action: 'pane.right', label: null },
    ],
  },
  // ADR-012 — a única entrada visível do painel "Uso" fora do menu "⋯". Sem
  // ela o atalho existiria só na tabela de configurações, e um dashboard que
  // ninguém sabe abrir não é um dashboard.
  { id: 'usage', label: 'tabs.dica.uso', buttons: [{ action: 'usage.open', label: 'tabs.dica.uso' }] },
  {
    id: 'close',
    label: 'tabs.dica.fechaPainel',
    buttons: [{ action: 'pane.close', label: 'tabs.dica.fechaPainel' }],
  },
];

/** O símbolo de cada botão sem chave — a seta é o rótulo, e não se traduz. */
const ARROW_LABELS: Partial<Record<KeyAction, string>> = { 'pane.left': '←', 'pane.right': '→' };

/**
 * As dicas da `tabs-bar`, na ordem em que aparecem, com o nome de cada ação na
 * tela e a combinação do `Keybindings` em vigor no tooltip.
 *
 * O tooltip carrega a combinação INTEIRA (`Painel à esquerda (Alt+←)`) porque
 * ela não aparece em lugar nenhum da barra: quem quer a tecla ou passa o mouse
 * aqui, ou abre Configurações → Atalhos.
 */
export function hintGroups(bindings: Keybindings, lang: Language): TabHintGroup[] {
  return HINT_SPECS.map((spec) => ({
    id: spec.id,
    label: tUi(lang, spec.label),
    showLabel: spec.buttons.length > 1,
    buttons: spec.buttons.map(({ action, label }) => {
      const keys = formatChord(bindings[action], lang);
      const acao = keyActionLabel(action, lang);
      return {
        action,
        label: label === null ? (ARROW_LABELS[action] ?? '') : tUi(lang, label),
        title:
          keys.length > 0
            ? tUi(lang, 'tabs.dica.titulo', { acao, teclas: keys.join('+') })
            : tUi(lang, 'tabs.dica.semAtalho', { acao }),
      };
    }),
  }));
}
