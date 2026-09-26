/**
 * Erros tipados que cruzam a fronteira core.ts → routes.ts. Existem pra
 * rotas não precisarem inferir o status HTTP a partir do texto de
 * `Error.message` (frágil — qualquer edit na mensagem silenciosamente mudaria
 * o código de resposta).
 *
 * ## Idioma (spec §13) — a regra de toda mensagem de erro do Bridge
 *
 * Erro que chega à API (e portanto à UI e à CLI) carrega um `code` **e** a
 * CHAVE do catálogo com os parâmetros dela (`i18n`); a MENSAGEM é montada na
 * BORDA, com o `core.language()` do instante da resposta — é isso que faz um
 * `PATCH /api/config { ui: { language } }` valer já no próximo 404, sem
 * restart e sem cache pra invalidar.
 *
 * O `Error.message` continua existindo e continua em pt-BR: ele é o que vai
 * pro `core.log` e pro stack trace, que são do dono e do suporte (spec §13).
 * Ou seja, `super(t('pt-BR', key, params))` — o texto em português é o
 * subproduto, não a fonte.
 *
 * Erro INTERNO (invariante do próprio Bridge, que só vira log e 500) não tem
 * `i18n`: ele nunca é lido por quem usa o app, e traduzi-lo seria trabalho
 * sem leitor.
 */
import { sanitizeDisplay, t, type Language, type MessageKey } from '@bridge/shared';

/** A chave do catálogo + os parâmetros dela, guardados até a borda traduzir. */
export interface I18nMessage {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** Erro que sabe se dizer em qualquer idioma. */
export interface Translatable {
  readonly i18n: I18nMessage;
}

export function isTranslatable(err: unknown): err is Error & Translatable {
  if (!(err instanceof Error)) return false;
  // `typeof null === 'object'` — sem esta linha um `{ i18n: null }` (que só
  // aparece se alguém desserializar um erro) passava pelo guarda e explodia no
  // `err.i18n.key` do `errorMessage`, que é o caminho de TODA resposta de erro.
  const i18n = (err as Partial<Translatable>).i18n;
  return typeof i18n === 'object' && i18n !== null && typeof i18n.key === 'string';
}

/**
 * A mensagem de `err` no idioma pedido — o ÚNICO jeito de uma rota escrever
 * `error:` no corpo.
 *
 * Erro sem chave (exceção de biblioteca, invariante interna) devolve o
 * `message` como está: um texto não traduzido é melhor que um campo vazio.
 *
 * O `sanitizeDisplay` na saída é a trava do funil (A5/A7): parte destas
 * mensagens carrega texto de FORA dentro de si — o `{stderr}` do git em
 * `core.erro.git.naoFfComGit` é o caso vivo, e ele chega ao terminal do dono
 * pela CLI, que imprime o `error` do servidor cru. Um `git` com `color.ui`
 * ligado (ou um nome de branch hostil) mandava ESC, OSC e RLO por esse
 * caminho. Sanitizar aqui, e não em cada `new XError(…)`, é o que garante que
 * mensagem NENHUMA escapa — inclusive as que ainda vão ser escritas.
 *
 * O teto é o `DISPLAY_MAX` do `@bridge/shared`, e não o `ECHO_MAX` (120) que
 * as rotas usam pra ECOAR um id: aqui o que passa é a frase INTEIRA, e a mais
 * longa do catálogo (`core.erro.git.filtrosSemConfianca`, 125 caracteres) já
 * seria cortada no meio por 120. O que 200 corta é o rabo de um `stderr`
 * enorme — exatamente o que se quer cortar.
 */
export function errorMessage(err: unknown, lang: Language): string {
  const raw = isTranslatable(err)
    ? t(lang, err.i18n.key, err.i18n.params)
    : err instanceof Error
      ? err.message
      : String(err);
  return sanitizeDisplay(raw);
}

/**
 * `super(...)` de todo erro traduzível: o pt-BR é o texto de LOG (spec §13 —
 * `core.log` continua em português) e o fallback de quem não passa pela borda.
 */
export function ptBRMessage(i18n: I18nMessage): string {
  return t('pt-BR', i18n.key, i18n.params);
}

export class PaneNotFoundError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(paneId: string) {
    const i18n: I18nMessage = { key: 'core.erro.painelNaoEncontrado', params: { paneId } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'PaneNotFoundError';
  }
}

/**
 * "Dividir com uma aba já aberta" (pedido do dono, 10/09/2026): a adoção de
 * uma aba pelo split de um painel tem três recusas, e cada uma leva um
 * `code` próprio pra rota escolher o status (404 pra aba inexistente, 409 pro
 * resto) e a UI dizer o motivo.
 */
export type TabAdoptReason = 'tab-not-found' | 'same-tab' | 'other-workspace';

const TAB_ADOPT_KEYS: Record<TabAdoptReason, MessageKey> = {
  'tab-not-found': 'core.erro.adotarAba.naoEncontrada',
  'same-tab': 'core.erro.adotarAba.mesmaAba',
  'other-workspace': 'core.erro.adotarAba.outroWorkspace',
};

export class TabAdoptError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(
    readonly code: TabAdoptReason,
    readonly tabId: string,
  ) {
    const i18n: I18nMessage = { key: TAB_ADOPT_KEYS[code], params: { tabId } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'TabAdoptError';
  }
}

/**
 * R1: painel hospeda no máximo UMA sessão. Tentar criar outra num painel que
 * já tem sessão viva (`state !== 'exited'`) vira 409 na rota.
 */
const PANE_BUSY: I18nMessage = { key: 'core.erro.painelOcupado' };

export class PaneBusyError extends Error implements Translatable {
  readonly i18n = PANE_BUSY;
  constructor(readonly paneId: string) {
    super(ptBRMessage(PANE_BUSY));
    this.name = 'PaneBusyError';
  }
}

/** Workspace inexistente numa rota que precisa dele (vira 404). */
export class WorkspaceNotFoundError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(readonly workspaceId: string) {
    const i18n: I18nMessage = { key: 'core.erro.workspaceNaoEncontradoComId', params: { workspaceId } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Merge / remoção de worktree pedidos num workspace que não é worktree de
 * tarefa. Não é erro de git (nem chegou a rodar `git`), mas a rota responde no
 * mesmo formato dos `GitError` de recusa: 409 `{ error, code }`.
 */
const NOT_WORKTREE: I18nMessage = { key: 'core.erro.naoEWorktree' };

export class NotWorktreeError extends Error implements Translatable {
  readonly code = 'not-worktree';
  readonly i18n = NOT_WORKTREE;
  constructor(readonly workspaceId: string) {
    super(ptBRMessage(NOT_WORKTREE));
    this.name = 'NotWorktreeError';
  }
}

/**
 * Nome de tarefa que não sobrevive à normalização (`'!!!'` → vazio). Vira 422:
 * o pedido está mal formado, mas quem decide isso é a regra de nome do Bridge,
 * não o git — sem um erro tipado, a rota teria que tratar TODA exceção
 * desconhecida como 422 e esconderia bug de verdade atrás de um 4xx.
 */
export class InvalidTaskNameError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(readonly requested: string) {
    const i18n: I18nMessage = { key: 'core.erro.nomeTarefaInvalido', params: { nome: requested } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'InvalidTaskNameError';
  }
}

/**
 * Pedido de sessão bem formado que o core não consegue atender: agente sem
 * binário no PATH, agente desconhecido, cwd que não existe. Vira 422 com
 * `code` — sem ele, `POST /api/sessions` tratava TODA exceção desconhecida
 * como 422 e escondia bug do Bridge atrás de um 4xx que culpa o usuário.
 */
export class SessionLaunchError extends Error {
  /**
   * Ausente no ÚNICO caso em que a mensagem não é do Bridge: o `reason` que o
   * `available()` do adaptador devolveu (o texto do `execFile` que falhou, que
   * o sistema operacional escreve em inglês e ninguém traduz). Esse texto já
   * chega no idioma da chamada — o `available()` recebe o `lang` — e a
   * resposta HTTP é a MESMA chamada, então não há foto velha a envelhecer.
   */
  readonly i18n?: I18nMessage;
  constructor(
    readonly code:
      | 'agent-unavailable'
      | 'unknown-agent'
      | 'no-agent'
      | 'cwd-missing'
      /** O ambiente do workspace (distro WSL) não respondeu — dor verificada #2. */
      | 'environment-unavailable',
    message: I18nMessage | string,
  ) {
    super(typeof message === 'string' ? message : ptBRMessage(message));
    if (typeof message !== 'string') this.i18n = message;
    this.name = 'SessionLaunchError';
  }
}

/**
 * Alguma sessão do workspace não morreu, então o layout/worktree NÃO pode ser
 * removido — remover deixaria PTY órfão sem dono na árvore. Vira 500 na rota,
 * igual ao caminho de `DELETE /api/workspaces/:id`.
 *
 * O desfecho é PARCIAL, e o corpo do erro diz isso: as outras sessões do lote
 * FORAM encerradas (`killed`) e as que resistiram vêm nomeadas (`failedIds`).
 * Repetir a chamada é seguro e é o que se espera do dono — a segunda tentativa
 * já só encontra as teimosas.
 */
export class KillFailedError extends Error implements Translatable {
  readonly i18n: I18nMessage;
  constructor(
    readonly failed: number,
    readonly killed = 0,
    readonly failedIds: string[] = [],
  ) {
    const i18n: I18nMessage = { key: 'core.erro.killFalhou', params: { n: failed } };
    super(ptBRMessage(i18n));
    this.i18n = i18n;
    this.name = 'KillFailedError';
  }
}
