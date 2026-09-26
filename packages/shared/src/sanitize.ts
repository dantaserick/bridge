/**
 * `sanitizeDisplay` — a única limpeza de texto que vai pra TELA (A5/A7).
 *
 * Por que existe, e por que mora aqui. Três superfícies do Bridge escrevem
 * strings que vieram de fora — do payload do hook `StatusLine` (que o agente
 * escolhe) e das linhas de transcript (que qualquer processo do usuário pode
 * gravar):
 *
 * - a **statusline** que o core devolve ao Claude Code, e que o Claude Code
 *   imprime no terminal do dono;
 * - o **`bridge usage`**, que escreve `model`/`project`/`label` no `stdout`;
 * - o **painel**, onde os mesmos textos viram `title` e `aria-label`.
 *
 * O React escapa HTML, então a UI nunca teve injeção; o TERMINAL não escapa
 * nada. Uma chave de janela como `ESC ] 0 ; X BEL` devolvida na statusline faz
 * o Bridge PRODUZIR o byte de controle e entregá-lo ao terminal do dono:
 * sequestro de título (OSC 0), cor, piscar, apagar tela (CSI 2 J) — e, pior,
 * uma ponte até o scanner de OSC do próprio Bridge, que transforma `OSC 9` em
 * notificação do Windows. Quem emite o byte é o Bridge; não dá pra depender de
 * o Claude Code sanitizar antes de imprimir.
 *
 * A função é **pura** e vive no `@bridge/shared` pelo mesmo motivo de
 * `formatUsd`: quatro pontas escrevendo o mesmo dado com quatro regras
 * diferentes é como uma delas fica de fora na próxima mudança.
 *
 * O que ela faz, nesta ordem:
 *
 * 1. remove a SEQUÊNCIA inteira de escape (OSC com terminador BEL/ST, CSI, e o
 *    ESC solto), e não só o byte `0x1B` — apagar só o ESC deixaria `]0;TITULO`
 *    como texto visível, que é ruído, e `[31m` idem;
 * 2. troca os controles que são espaço em branco (`\t`, `\n`, `\r`, `\v`,
 *    `\f`) por espaço, e apaga os outros C0/C1/DEL. Um `\r\n` no meio de um
 *    `cwd` não pode transformar `a\r\nb` em `ab`: as duas partes eram
 *    separadas. Junto com eles saem os caracteres de FORMATO invisíveis
 *    (Trojan Source: o RLO que inverte a leitura, os de largura zero, o BOM);
 * 3. colapsa espaço repetido e apara as pontas — a tabela do `bridge usage`
 *    alinha por `.length`, e um `cwd` cheio de espaços destrói a coluna;
 * 4. corta em `max` CARACTERES, com `…` no lugar do último. O corte é o teto
 *    de verdade: `sanitizeDisplay(s, 64).length <= 64` sempre.
 *
 * O que ela NÃO faz: escapar HTML (a UI é React e já escapa) e mexer no
 * `--json` da CLI ou no corpo da API — JSON é dado, não tela, e cortá-lo ali
 * mentiria sobre o que está no disco.
 *
 * **A única exceção no corpo da API é o campo `error`** (desde a onda de
 * conserto da 0.13.0): ele é COPY DE TELA — a CLI imprime aquilo cru no
 * terminal e a UI mostra na faixa —, e parte dele carrega texto de fora
 * (o `{stderr}` do git). Por isso o `errorMessage()` do core passa o resultado
 * por aqui. O `code`, o `detail` estruturado e os dados do `--json` continuam
 * intocados: eles são contrato, não frase.
 */

/** Teto padrão: um rótulo de tela, não um parágrafo. */
export const DISPLAY_MAX = 200;

/**
 * OSC: ESC `]` … terminado por BEL, por ESC `\` (ST) ou pelo ST de um byte
 * (`\u009c`). Sem terminador (a cauda do texto) some inteira — é exatamente o
 * caso do payload cortado no meio.
 */
const OSC = /\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b[\u005c]|\u009c)?/g;
/** A mesma coisa com o OSC de um byte (`\u009d`). */
const OSC_C1 = /\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?/g;
/** CSI: ESC `[` parâmetros intermediários final (cor, apagar tela, cursor). */
const CSI = /\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]?/g;
/** CSI de um byte (`\u009b`). */
const CSI_C1 = /\u009b[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]?/g;
/** Qualquer outra sequência de escape: ESC + intermediários + final. */
const ESC_OTHER = /\u001b[\u0020-\u002f]*[\u0030-\u007e]?/g;
/** Controle que é espaço em branco — vira espaço, não some. */
const CONTROL_SPACE = /[\t\n\v\f\r]/g;
/**
 * Caracteres de FORMATO invisíveis — o vetor Trojan Source.
 *
 * `U+202E` (RIGHT-TO-LEFT OVERRIDE) reordena o que vem depois dele na hora de
 * RENDERIZAR, sem mudar um byte do texto: um `cwd` de transcript pode fazer a
 * tabela do `bridge usage` e o `title` do painel mostrarem um caminho que não
 * é o caminho. `U+200B` e companhia (largura zero, junta/não-junta, BOM)
 * fazem o contrário — somem da tela e quebram a comparação de olho entre dois
 * nomes de modelo.
 *
 * Nenhum deles tem uso legítimo num `cwd`, num id de modelo ou numa chave de
 * janela, que é tudo que passa por aqui. Saem inteiros, sem virar espaço: eles
 * não separavam nada.
 */
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** O que sobrou de C0/C1/DEL depois das duas regras acima. */
const CONTROL_REST = /[\u0000-\u001f\u007f-\u009f]/g;
/** O predicado de "pode ir pro terminal": nenhum C0/C1/DEL e nenhum formato. */
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;

/**
 * Texto de fora pronto pra terminal, `title` ou `aria-label`.
 *
 * `max` é o teto em caracteres do resultado (o `…` do corte conta). Valor
 * ausente usa `DISPLAY_MAX`; valor não positivo devolve string vazia. Entrada
 * que não é string devolve string vazia — o chamador costuma vir de um
 * payload, onde `model` pode ser um número.
 */
export function sanitizeDisplay(value: unknown, max: number = DISPLAY_MAX): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const limit = Number.isFinite(max) ? Math.floor(max) : DISPLAY_MAX;
  if (limit <= 0) return '';

  const clean = value
    .replace(OSC, '')
    .replace(OSC_C1, '')
    .replace(CSI, '')
    .replace(CSI_C1, '')
    .replace(ESC_OTHER, '')
    .replace(CONTROL_SPACE, ' ')
    .replace(CONTROL_REST, '')
    .replace(FORMAT, '')
    .replace(/ {2,}/g, ' ')
    .trim();

  if (clean.length <= limit) return clean;
  if (limit === 1) return '…';
  const head = clean.slice(0, limit - 1);
  // Um par substituto cortado ao meio vira `\ufffd` na tela; o meio par sai.
  const last = head.charCodeAt(head.length - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * `true` quando a string NÃO tem byte de controle nenhum — o predicado que os
 * testes de ataque usam pra afirmar "isto pode ir pro terminal".
 */
export function isDisplaySafe(value: string): boolean {
  return !ANY_CONTROL.test(value);
}
