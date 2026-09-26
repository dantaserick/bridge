/**
 * Regras puras do diálogo "Nova tarefa" (spec §7): preview do branch, o que
 * pode ser submetido, o corpo do `POST /api/tasks` e a tradução dos erros do
 * core. Fica fora do `.tsx` de propósito — é o que dá pra testar em nó, sem
 * DOM, e é onde mora a única cópia dessas decisões.
 */
import { normalizeTaskName } from '@bridge/shared';
import type { Language, Pane, Session, Tab, Workspace } from '@bridge/shared';
import { ApiError } from './api.js';
import { tUi } from './i18n.js';

/**
 * `GET /api/git/detect?cwd=` (Task 3). Espelha o `RepoInfo` do core; não vive
 * no `@bridge/shared` porque só o diálogo consome, e o core é a autoridade.
 */
export interface DetectedRepo {
  /** Toplevel da pasta consultada — num worktree, o próprio worktree. */
  root: string;
  branch: string;
  isWorktree: boolean;
  /** Branch do worktree principal, quando a pasta escolhida é um worktree. */
  base?: string;
  worktreePath?: string;
  /** Caminho do worktree PRINCIPAL: é nele que a tarefa nasce. */
  mainPath: string;
}

export interface TaskDraft {
  /** Repo escolhido na lista de `GET /api/repos`. */
  repoId?: string;
  /** Pasta escolhida à mão, quando não é um repo já conhecido. */
  repoPath?: string;
  name: string;
  base: string;
  /** "Subir Claude Code" — marcado por padrão. */
  agent: boolean;
}

export interface TaskBody {
  repoId?: string;
  repoPath?: string;
  name: string;
  base?: string;
  agent?: 'claude';
}

/**
 * O branch que vai nascer, com a normalização do core (`@bridge/shared`, a
 * MESMA função dos dois lados). Sem nome ainda não é erro — é campo vazio.
 */
export function branchPreview(name: string, lang: Language): { branch?: string; error?: string } {
  if (name.trim() === '') return {};
  try {
    return { branch: normalizeTaskName(name) };
  } catch {
    return { error: tUi(lang, 'dialog.task.nomeInvalido') };
  }
}

export function canSubmitTask(draft: TaskDraft, lang: Language): boolean {
  const hasRepo = (draft.repoId ?? '') !== '' || (draft.repoPath ?? '').trim() !== '';
  return hasRepo && branchPreview(draft.name, lang).branch !== undefined;
}

/**
 * Corpo do `POST /api/tasks`. Manda o nome CRU: quem normaliza é o core (o
 * preview é só cortesia), e campo vazio some do corpo em vez de virar `''` —
 * `base` ausente faz o core usar o branch atual do repo.
 */
export function taskRequestBody(draft: TaskDraft): TaskBody {
  const body: TaskBody = { name: draft.name.trim() };
  // Repo conhecido vence a pasta: é o id que o core resolve sem tocar no disco.
  if ((draft.repoId ?? '') !== '') body.repoId = draft.repoId;
  else if ((draft.repoPath ?? '').trim() !== '') body.repoPath = draft.repoPath?.trim();
  if (draft.base.trim() !== '') body.base = draft.base.trim();
  if (draft.agent) body.agent = 'claude';
  return body;
}

/** Erro do `POST /api/tasks` em uma linha pro usuário, por `code` (não por texto). */
export function taskErrorMessage(err: unknown, lang: Language): string {
  if (err instanceof ApiError) {
    if (err.code === 'exists') return tUi(lang, 'dialog.task.erro.existe');
    if (err.code === 'not-a-repo') return tUi(lang, 'dialog.task.erro.naoERepo');
    // O resto é o `error.message` do core, que já vem traduzido — a UI não o
    // retraduz (contrato §8 do report da Task 2).
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Resposta do `POST /api/tasks`: o worktree já virou workspace com aba e painel. */
export interface CreatedTask {
  workspace: Workspace;
  tab: Tab;
  pane: Pane;
  /** Ausente quando não foi pedido agente — ou quando ele não subiu. */
  session?: Session;
}

/**
 * O aviso que sobra depois de criar. O core NÃO desfaz a tarefa quando o
 * Claude não sobe: ele devolve 201 sem `session` e loga o problema. Então a
 * tarefa existe (worktree, branch, workspace) e o que falta é só o agente —
 * some no rodapé, não um erro que sugira tentar de novo e criar tudo em dobro.
 */
export function taskWarning(draft: TaskDraft, created: CreatedTask, lang: Language): string | undefined {
  if (!draft.agent || created.session) return undefined;
  return tUi(lang, 'dialog.task.aviso.claudeNaoSubiu');
}

/** `api` do diálogo, só o que ele usa (evita arrastar `actions.ts` pra cá). */
type TaskApi = <T>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;

/**
 * `POST /api/tasks`. Devolve o que foi criado e, quando for o caso, o aviso de
 * que o agente não subiu — quem falha aqui é a chamada, não a tarefa.
 */
export async function submitTask(
  api: TaskApi,
  draft: TaskDraft,
  lang: Language,
): Promise<{ created: CreatedTask; warning?: string }> {
  const created = await api<CreatedTask>('/api/tasks', { method: 'POST', body: taskRequestBody(draft) });
  const warning = taskWarning(draft, created, lang);
  return warning ? { created, warning } : { created };
}

/** Linha de detecção embaixo do campo de pasta. */
export function repoDetectLine(info: DetectedRepo | null, lang: Language): { ok: boolean; text: string } {
  if (!info) return { ok: false, text: tUi(lang, 'dialog.task.detect.naoERepo') };
  return { ok: true, text: `${info.mainPath} · ${info.branch}` };
}

/**
 * O que a detecção preenche no formulário. Escolher um WORKTREE aponta a
 * tarefa pro repo principal (worktree de worktree não existe) e a base default
 * vira a do worktree — o branch da tarefa vizinha não serve de base.
 */
export function repoFromDetect(info: DetectedRepo): { repoPath: string; base: string } {
  return { repoPath: info.mainPath, base: info.isWorktree ? (info.base ?? info.branch) : info.branch };
}
