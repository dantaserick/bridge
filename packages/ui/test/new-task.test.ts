import type { Pane, Session, Tab, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import {
  branchPreview,
  canSubmitTask,
  repoDetectLine,
  repoFromDetect,
  submitTask,
  taskErrorMessage,
  taskRequestBody,
} from '../src/newTask.js';
import type { CreatedTask, DetectedRepo, TaskDraft } from '../src/newTask.js';

/**
 * O idioma destes testes. É EXPLÍCITO em cada chamada desde a Task 3 do lote
 * de idioma: as asserções abaixo descrevem o pt-BR, e um default escondido
 * faria a suíte depender da máquina de quem a roda.
 */
const PT = 'pt-BR' as const;

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return { repoId: 'repo-1', name: 'Feat Mailbox', base: 'main', agent: true, ...overrides };
}

function detected(overrides: Partial<DetectedRepo> = {}): DetectedRepo {
  return { root: 'C:\\projetos\\repo', branch: 'main', isWorktree: false, mainPath: 'C:\\projetos\\repo', ...overrides };
}

describe('branchPreview', () => {
  it('mostra o branch que vai nascer, com a MESMA normalização do core', () => {
    expect(branchPreview('Feat Mailbox!', PT)).toEqual({ branch: 'feat-mailbox' });
  });

  it('nome vazio não vira erro vermelho — ainda não digitaram nada', () => {
    expect(branchPreview('   ', PT)).toEqual({});
  });

  it('nome que some inteiro na normalização explica o problema', () => {
    expect(branchPreview('!!!', PT)).toEqual({ error: 'nome inválido: sobra vazio depois de normalizar' });
  });
});

describe('canSubmitTask', () => {
  it('com repo e nome válidos, pode', () => {
    expect(canSubmitTask(draft(), PT)).toBe(true);
  });

  it('pasta escolhida à mão também serve de repo', () => {
    expect(canSubmitTask(draft({ repoId: undefined, repoPath: 'C:\\projetos\\repo' }), PT)).toBe(true);
  });

  it('sem repo nenhum, não', () => {
    expect(canSubmitTask(draft({ repoId: undefined }), PT)).toBe(false);
  });

  it('sem nome aproveitável, não', () => {
    expect(canSubmitTask(draft({ name: '  ' }), PT)).toBe(false);
    expect(canSubmitTask(draft({ name: '???' }), PT)).toBe(false);
  });
});

describe('taskRequestBody', () => {
  it('manda o nome cru (quem normaliza é o core) e o agente pedido', () => {
    expect(taskRequestBody(draft())).toEqual({ repoId: 'repo-1', name: 'Feat Mailbox', base: 'main', agent: 'claude' });
  });

  it('sem "Subir Claude Code" o campo `agent` some do corpo', () => {
    expect(taskRequestBody(draft({ agent: false })).agent).toBeUndefined();
  });

  it('base em branco vira ausente: o core usa o branch atual do repo', () => {
    expect(taskRequestBody(draft({ base: '   ' })).base).toBeUndefined();
  });

  it('repoId vence repoPath quando os dois estão preenchidos', () => {
    const body = taskRequestBody(draft({ repoPath: 'C:\\projetos\\outro' }));
    expect(body).toMatchObject({ repoId: 'repo-1' });
    expect(body.repoPath).toBeUndefined();
  });

  it('só a pasta: manda repoPath', () => {
    expect(taskRequestBody(draft({ repoId: undefined, repoPath: 'C:\\projetos\\repo' }))).toMatchObject({ repoPath: 'C:\\projetos\\repo' });
  });
});

describe('taskErrorMessage', () => {
  it('409 exists vira a frase do diálogo', () => {
    expect(taskErrorMessage(new ApiError('worktree já existe', 409, 'exists'), PT)).toBe('Já existe uma tarefa com esse nome');
  });

  it('422 not-a-repo explica a pasta', () => {
    expect(taskErrorMessage(new ApiError('não é repo', 422, 'not-a-repo'), PT)).toBe('A pasta escolhida não é um repositório git');
  });

  it('qualquer outro erro do core passa a mensagem dele', () => {
    expect(taskErrorMessage(new ApiError('git falhou feio', 422, 'git-failed'), PT)).toBe('git falhou feio');
    expect(taskErrorMessage(new Error('rede caiu'), PT)).toBe('rede caiu');
  });
});

describe('submitTask', () => {
  const workspace: Workspace = { id: 'ws-1', name: 'mailbox', cwd: 'C:\\projetos\\repo\\.worktrees\\mailbox', createdAt: 1 };
  const tab: Tab = { id: 'tab-1', workspaceId: 'ws-1', title: 'Terminal', kind: 'terminal', order: 0 };
  const pane: Pane = { id: 'pane-1', tabId: 'tab-1', cwd: 'C:\\projetos\\repo\\.worktrees\\mailbox' };
  const session: Session = {
    id: 'sess-1',
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    kind: 'agent',
    agent: 'claude',
    state: 'idle',
    startedAt: 1,
    stateSince: 1,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\repo\\.worktrees\\mailbox',
  };

  /** `api` de mentira: grava a chamada e devolve a resposta combinada. */
  function fakeApi(response: CreatedTask): { api: <T>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; calls: { path: string; method?: string; body?: unknown }[] } {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    return {
      api: async <T,>(path: string, options: { method?: string; body?: unknown } = {}) => {
        calls.push({ path, method: options.method, body: options.body });
        return response as T;
      },
      calls,
    };
  }

  it('cria a tarefa e, com o Claude de pé, não avisa nada', async () => {
    const { api, calls } = fakeApi({ workspace, tab, pane, session });
    const result = await submitTask(api, draft({ name: 'mailbox' }), PT);

    expect(calls).toEqual([
      { path: '/api/tasks', method: 'POST', body: { repoId: 'repo-1', name: 'mailbox', base: 'main', agent: 'claude' } },
    ]);
    expect(result.warning).toBeUndefined();
    expect(result.created.workspace.id).toBe('ws-1');
  });

  it('o core devolve 201 SEM sessão quando o Claude não sobe: a tarefa vale, com aviso', async () => {
    const { api } = fakeApi({ workspace, tab, pane });
    const result = await submitTask(api, draft(), PT);

    expect(result.created.workspace.id).toBe('ws-1');
    expect(result.warning).toBe('Tarefa criada, mas o Claude não subiu — abra com Ctrl+Shift+C');
  });

  it('sem pedir agente, sessão ausente é o esperado — nada de aviso', async () => {
    const { api } = fakeApi({ workspace, tab, pane });
    expect((await submitTask(api, draft({ agent: false }), PT)).warning).toBeUndefined();
  });
});

describe('detecção da pasta escolhida', () => {
  it('pasta sem git avisa em vez de deixar submeter', () => {
    expect(repoDetectLine(null, PT)).toEqual({ ok: false, text: 'não é um repositório git' });
  });

  it('repo detectado mostra o caminho principal e o branch', () => {
    expect(repoDetectLine(detected(), PT)).toEqual({ ok: true, text: 'C:\\projetos\\repo · main' });
  });

  it('escolher um worktree aponta pro repo principal e usa a base dele', () => {
    const info = detected({
      root: 'C:\\projetos\\repo\\.worktrees\\feat',
      branch: 'feat',
      isWorktree: true,
      base: 'main',
      worktreePath: 'C:\\projetos\\repo\\.worktrees\\feat',
      mainPath: 'C:\\projetos\\repo',
    });
    expect(repoFromDetect(info)).toEqual({ repoPath: 'C:\\projetos\\repo', base: 'main' });
  });

  it('repo comum: a base default é o branch atual', () => {
    expect(repoFromDetect(detected({ branch: 'master' }))).toEqual({ repoPath: 'C:\\projetos\\repo', base: 'master' });
  });
});
