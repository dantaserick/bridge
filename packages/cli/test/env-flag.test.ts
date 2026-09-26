import type { HelloState } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { cmdNew } from '../src/commands.js';
import type { Ctx } from '../src/commands.js';
import { CliError } from '../src/client.js';
import type { Client } from '../src/client.js';

/**
 * Dor verificada #2 pela CLI: `bridge new --env wsl:Ubuntu`.
 *
 * Cliente de mentira (nenhum core sobe, nenhum PTY nasce): o que se prova é a
 * ORDEM das chamadas — o ambiente é gravado no workspace ANTES do split, senão
 * a sessão nova nasceria no shell antigo — e a recusa de um valor inválido
 * ANTES de qualquer chamada, pra um typo não deixar um painel dividido pra trás.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * `sessionResponse` é o que `POST /api/sessions` devolve. O padrão é a sessão
 * criada (201); passando um `QueuedLaunch` se simula o **202** do escalonador
 * (dor verificada #1), que é o outro desfecho legítimo do mesmo comando.
 */
function fakeCtx(sessionResponse?: unknown): { ctx: Ctx; calls: Call[] } {
  const calls: Call[] = [];
  const state: HelloState = {
    layout: {
      repos: [],
      workspaces: [{ id: 'ws_1', name: 'app', cwd: 'C:\\projetos\\app', createdAt: 1 }],
      tabs: [{ id: 'tab_1', workspaceId: 'ws_1', title: 'Terminal', kind: 'terminal', order: 0 }],
      panes: [{ id: 'pane_1', tabId: 'tab_1', cwd: 'C:\\projetos\\app' }],
      layouts: { tab_1: { type: 'leaf', paneId: 'pane_1' } },
    },
    sessions: [],
    unread: [],
  };
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return state as unknown;
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      if (path.includes('/split')) return { id: 'pane_2', tabId: 'tab_1', cwd: 'C:\\projetos\\app' } as unknown;
      return (sessionResponse ?? { id: 'sess_1', kind: 'shell' }) as unknown;
    },
    patch: async (path: string, body?: unknown) => {
      calls.push({ method: 'PATCH', path, body });
      return {} as unknown;
    },
  } as unknown as Client;
  // Idioma FIXO no teste (spec §13): a suíte não pode depender da locale da
  // máquina que a roda — numa máquina em inglês estas asserções falhariam.
  return { ctx: { client, env: {}, lang: 'pt-BR', showCost: true }, calls };
}

describe('bridge new --env', () => {
  it('grava o ambiente no workspace ANTES de dividir o painel', async () => {
    const { ctx, calls } = fakeCtx();
    const res = await cmdNew(ctx, { env: 'wsl:Ubuntu' });
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      'GET /api/state',
      'PATCH /api/workspaces/ws_1',
      'POST /api/panes/pane_1/split',
      'POST /api/sessions',
    ]);
    expect(calls[1]!.body).toEqual({ environment: { kind: 'wsl', distro: 'Ubuntu' } });
    expect(res.human).toContain('ambiente wsl:Ubuntu');
  });

  it('`--env gitbash` também vale (não é só WSL)', async () => {
    const { ctx, calls } = fakeCtx();
    await cmdNew(ctx, { env: 'gitbash' });
    expect(calls[1]!.body).toEqual({ environment: { kind: 'gitbash' } });
  });

  it('`--env padrao` volta pro shell da configuração global', async () => {
    const { ctx, calls } = fakeCtx();
    const res = await cmdNew(ctx, { env: 'padrao' });
    expect(calls[1]!.body).toEqual({ environment: null });
    expect(res.human).toContain('padrão do Bridge');
  });

  it('valor inválido recusa ANTES de qualquer chamada — nenhum painel dividido pra trás', async () => {
    const { ctx, calls } = fakeCtx();
    await expect(cmdNew(ctx, { env: 'ubunto' })).rejects.toBeInstanceOf(CliError);
    await expect(cmdNew(ctx, { env: 'wsl:' })).rejects.toThrow(/--env/);
    await expect(cmdNew(ctx, { env: 'wsl:-injetado' })).rejects.toThrow(/--env/);
    expect(calls).toHaveLength(0);
  });

  it('sem `--env`, nenhum PATCH acontece — o comportamento de sempre', async () => {
    const { ctx, calls } = fakeCtx();
    const res = await cmdNew(ctx, {});
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.human).not.toContain('ambiente');
  });

  it('flag desconhecida continua sendo erro', async () => {
    const { ctx } = fakeCtx();
    await expect(cmdNew(ctx, { ambiente: 'wsl:Ubuntu' })).rejects.toThrow(/flag desconhecida/);
  });
});

/**
 * Dor verificada #1 pela CLI: `POST /api/sessions` respondeu **202**
 * `{ queued: true, position }` — o escalonador segurou o lançamento.
 *
 * O painel JÁ foi dividido, mas SESSÃO NENHUMA existe ainda. Dizer "Sessão …
 * criada" aqui seria mentira, e um script que lesse o `--json` esperando um id
 * de sessão faria a coisa errada com o id da FILA. O que o comando tem que
 * dizer é: enfileirado, em que posição, e como furar a fila.
 */
describe('bridge new com 202 do escalonador', () => {
  const queued = { queued: true as const, id: 'lnch_1', position: 2, reason: 'slots' as const };

  it('anuncia a fila e a posição — nunca "Sessão … criada"', async () => {
    const { ctx } = fakeCtx(queued);
    const res = await cmdNew(ctx, {});
    expect(res.human).toContain('Sessão enfileirada (posição 2)');
    expect(res.human).toContain('app');
    expect(res.human).toContain('Lançar agora');
    // O texto de sessão criada não pode aparecer, nem por acidente de frase.
    expect(res.human).not.toContain('criada');
    expect(res.human).not.toContain('lnch_1');
  });

  it('o `--json` devolve o QueuedLaunch cru, não uma sessão', async () => {
    const { ctx } = fakeCtx(queued);
    const res = await cmdNew(ctx, {});
    expect(res.json).toEqual(queued);
    // Nada aqui é um id de sessão: quem consome o JSON tem que ver `queued`.
    expect(res.json).not.toHaveProperty('kind');
  });

  it('com `--env`, o 202 continua dizendo em que ambiente o pedido ficou', async () => {
    const { ctx, calls } = fakeCtx(queued);
    const res = await cmdNew(ctx, { env: 'wsl:Ubuntu' });
    // O ambiente foi gravado ANTES do split, como no caminho de 201.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/state',
      'PATCH /api/workspaces/ws_1',
      'POST /api/panes/pane_1/split',
      'POST /api/sessions',
    ]);
    expect(res.human).toContain('Sessão enfileirada (posição 2)');
    expect(res.human).toContain('ambiente wsl:Ubuntu');
  });
});
