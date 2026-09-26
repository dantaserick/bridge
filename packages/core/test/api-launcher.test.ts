import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { LauncherStatus, QueuedLaunch, Session } from '../src/model.js';

/**
 * Dor verificada #1, do lado da API — o contrato que a UI (e o cenário 10 do
 * e2e) consome:
 *
 * - `POST /api/sessions { kind: 'agent' }` responde **201** com a sessão
 *   quando há slot, e **202** `{ queued: true, id, position, reason }` quando
 *   o escalonador segurou;
 * - `GET /api/launcher` devolve o `LauncherStatus`;
 * - `POST /api/launcher/launch-now` fura a fila uma vez;
 * - shell NUNCA é enfileirado (a restauração de painel depende disso);
 * - a detecção do limite do servidor sobe pelo PTY de verdade e vira estado
 *   `server-limited` — que é o que o anel laranja da sidebar desenha.
 */
const AUTH = { authorization: 'Bearer T' };

function tmp(): string {
  return tmpDir('bridge-launcher-');
}

function makeCore(): Core {
  return createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
}

/**
 * Um "claude" que sobe na hora e NÃO morre.
 *
 * Não é o `fake-agent.cjs` de propósito: aquele fica vivo lendo `stdin`, e num
 * PTY sob carga o `end` do `stdin` chega sozinho — a sessão virava `exited` no
 * meio do teste e o teto de concorrência media zero agentes vivos. Aqui o
 * processo é um `node -e` com um timer eterno: ele só sai quando o core o
 * mata, que é a única saída que estes testes querem observar.
 */
function fakeClaude(core: Core): void {
  core.deps.adapters.claude = {
    id: 'claude',
    label: 'Claude falso',
    available: async () => ({ ok: true }),
    launch: () => ({
      bin: process.execPath,
      args: ['-e', 'setInterval(() => {}, 60_000)'],
      env: { ...process.env } as Record<string, string>,
      files: [],
    }),
    onHook: () => ({}),
  };
}

async function newPane(core: Core): Promise<string> {
  const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: tmp() } });
  const { pane } = ws.json() as { pane: { id: string } };
  return pane.id;
}

/** Um painel novo por split, pra caber mais de uma sessão na mesma aba. */
async function splitPane(core: Core, paneId: string): Promise<string> {
  const res = await core.app.inject({
    method: 'POST',
    url: `/api/panes/${paneId}/split`,
    headers: AUTH,
    payload: { dir: 'v' },
  });
  return (res.json() as { id: string }).id;
}

async function postAgent(core: Core, paneId: string): Promise<{ status: number; body: Session | QueuedLaunch }> {
  const res = await core.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: AUTH,
    payload: { paneId, kind: 'agent', agent: 'claude' },
  });
  return { status: res.statusCode, body: res.json() as Session | QueuedLaunch };
}

async function launcherStatus(core: Core): Promise<LauncherStatus> {
  const res = await core.app.inject({ method: 'GET', url: '/api/launcher', headers: AUTH });
  return res.json() as LauncherStatus;
}

function waitFor(check: () => boolean, timeoutMs = 15000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout esperando condição'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('API do escalonador de lançamentos', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('além do teto: 202 com a posição, e a fila aparece no GET /api/launcher', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    // Teto 1 e escalonador ligado: o segundo agente já vai pra fila, e o teste
    // não precisa subir quatro processos pra provar a regra.
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });

    const first = await newPane(c);
    const second = await splitPane(c, first);

    const um = await postAgent(c, first);
    expect(um.status).toBe(201);

    const dois = await postAgent(c, second);
    expect(dois.status).toBe(202);
    expect(dois.body).toMatchObject({ queued: true, position: 1, reason: 'slots' });

    const status = await launcherStatus(c);
    expect(status).toMatchObject({ enabled: true, maxConcurrent: 1, active: 1 });
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).toMatchObject({ paneId: second, agent: 'claude', position: 1 });
    // A sessão da fila ainda NÃO existe: 202 é promessa, não sessão.
    expect(c.deps.sessions.list().filter((s) => s.paneId === second)).toHaveLength(0);
  }, 30000);

  it('"Lançar agora" fura a fila e a sessão nasce', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const first = await newPane(c);
    const second = await splitPane(c, first);
    await postAgent(c, first);
    await postAgent(c, second);

    const res = await c.app.inject({ method: 'POST', url: '/api/launcher/launch-now', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paneId: second });

    await waitFor(() => c.deps.sessions.list().some((s) => s.paneId === second));
    expect((await launcherStatus(c)).pending).toHaveLength(0);
  }, 30000);

  it('"Lançar agora" com a fila vazia → 404 queue-empty', async () => {
    core = makeCore();
    const res = await core.app.inject({ method: 'POST', url: '/api/launcher/launch-now', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'queue-empty' });
  });

  it('cancelar um pendente tira da fila; o segundo DELETE é 404', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const first = await newPane(c);
    const second = await splitPane(c, first);
    await postAgent(c, first);
    const queued = (await postAgent(c, second)).body as QueuedLaunch;

    const del = await c.app.inject({ method: 'DELETE', url: `/api/launcher/pending/${queued.id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
    expect((await launcherStatus(c)).pending).toHaveLength(0);

    const again = await c.app.inject({ method: 'DELETE', url: `/api/launcher/pending/${queued.id}`, headers: AUTH });
    expect(again.statusCode).toBe(404);
  }, 30000);

  it('SHELL nunca é enfileirado — nem com o teto de agentes estourado', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const first = await newPane(c);
    const second = await splitPane(c, first);
    await postAgent(c, first);

    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: second, kind: 'shell' },
    });
    expect(shell.statusCode).toBe(201);
  }, 30000);

  it('painel OCUPADO é 409 na hora, não uma promessa na fila', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const first = await newPane(c);
    await postAgent(c, first);
    // R1 vale antes da fila: a restauração da UI conta com o 409 pra saber que
    // alguém chegou primeiro naquele painel.
    const repetido = await postAgent(c, first);
    expect(repetido.status).toBe(409);
    expect((await launcherStatus(c)).pending).toHaveLength(0);
  }, 30000);

  it('painel inexistente é 404 na hora, não uma promessa na fila', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: 'pane_que_nao_existe', kind: 'agent', agent: 'claude' },
    });
    expect(res.statusCode).toBe(404);
    expect((await launcherStatus(c)).pending).toHaveLength(0);
  });

  it('escalonador DESLIGADO: nada é enfileirado', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1, scheduleLaunches: false } });
    const first = await newPane(c);
    const second = await splitPane(c, first);
    expect((await postAgent(c, first)).status).toBe(201);
    expect((await postAgent(c, second)).status).toBe(201);
    expect((await launcherStatus(c)).enabled).toBe(false);
  }, 30000);

  it('PATCH /api/config valida a faixa do teto e o GET reflete na hora', async () => {
    core = makeCore();
    const c = core;
    const ruim = await c.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { maxConcurrentAgents: 0 } },
    });
    expect(ruim.statusCode).toBe(400);

    const bom = await c.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { maxConcurrentAgents: 7 } },
    });
    expect(bom.statusCode).toBe(200);
    expect((await launcherStatus(c)).maxConcurrent).toBe(7);
    // O merge é PROFUNDO: mexer no teto não pode desligar o escalonador.
    expect((await launcherStatus(c)).enabled).toBe(true);
  });

  it('a fila anda sozinha quando um slot vaga', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);
    c.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    const first = await newPane(c);
    const second = await splitPane(c, first);
    const um = (await postAgent(c, first)).body as Session;
    await postAgent(c, second);

    // A sessão de pé morre: o slot vaga e a fila anda sem ninguém pedir nada.
    await c.app.inject({ method: 'DELETE', url: `/api/sessions/${um.id}`, headers: AUTH });
    await waitFor(() => c.deps.sessions.list().some((s) => s.paneId === second));
    expect((await launcherStatus(c)).pending).toHaveLength(0);
  }, 30000);
});

describe('limite do servidor detectado na saída do PTY', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /**
   * O caminho INTEIRO, com PTY de verdade: a frase do Claude Code sai num
   * `echo` do shell, o scanner a reconhece na saída, a sessão vira
   * `server-limited` com a prova, e o escalonador passa a espaçar por backoff.
   *
   * O `echo` é um jeito legítimo de provocar o detector: ele não sabe (nem
   * pode saber) QUEM escreveu no terminal — o que ele afirma é "esta frase
   * apareceu nesta sessão", e é isso que está sob teste.
   */
  it('a frase vira estado `server-limited` com a prova, e o backoff assume', async () => {
    core = makeCore();
    const c = core;
    const paneId = await newPane(c);
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    const id = (shell.json() as Session).id;

    await c.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/input`,
      headers: AUTH,
      payload: { data: 'echo Server is temporarily limiting requests\r' },
    });

    await waitFor(() => c.deps.sessions.get(id)?.state === 'server-limited');
    const session = c.deps.sessions.get(id)!;
    expect(session.serverLimit?.pattern).toBe('limiting-requests');
    expect(session.serverLimit?.phrase).toContain('server is temporarily limiting requests');
    expect(session.detail).toBe('limite do servidor');

    const status = await launcherStatus(c);
    expect(status.serverLimited).toBe(1);
    expect(status.spacingMs).toBeGreaterThanOrEqual(5000);

    // E o `GET /api/state` leva o estado novo pra UI.
    const state = await c.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const listed = (state.json() as { sessions: Session[] }).sessions.find((s) => s.id === id);
    expect(listed?.state).toBe('server-limited');
    expect(listed?.serverLimit?.since).toBeGreaterThan(0);
  }, 40000);

  /**
   * O caminho que o `launcher.test.ts` NÃO cobre: lá o
   * `noteServerLimitCleared()` é chamado à mão. Aqui quem o chama é o core, em
   * `session.exited` — a sessão estrangulada MORRE em vez de sair do estado.
   *
   * Sem essa ligação o degrau do backoff ficava lá em cima (até 60 s) sem
   * ninguém estrangulado na tela, e o próximo estrangulamento já começaria do
   * degrau velho. A prova é medida: 5 s de piso → 10 s depois de um
   * lançamento → jitter (nada estrangulado) → 5 s DE NOVO no estrangulamento
   * seguinte, e não 10 s.
   */
  it('a sessão estrangulada MORRENDO devolve o backoff ao piso', async () => {
    core = makeCore();
    const c = core;
    fakeClaude(c);

    // 1. Uma sessão de shell estrangulada: o escalonador entra em backoff.
    const paneId = await newPane(c);
    const shell = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    const limitedId = (shell.json() as Session).id;
    await c.app.inject({
      method: 'POST',
      url: `/api/sessions/${limitedId}/input`,
      headers: AUTH,
      payload: { data: 'echo Server is temporarily limiting requests\r' },
    });
    await waitFor(() => c.deps.sessions.get(limitedId)?.state === 'server-limited');
    expect((await launcherStatus(c)).spacingMs).toBe(5000);

    // 2. Um agente sobe COM o estrangulamento em cena: o degrau dobra.
    const agentPane = await splitPane(c, paneId);
    expect((await postAgent(c, agentPane)).status).toBe(201);
    expect((await launcherStatus(c)).spacingMs).toBe(10_000);

    // 3. A estrangulada morre. Ninguém mais estrangulado → o espaçamento volta
    //    a ser o jitter, e não o backoff.
    await c.app.inject({ method: 'DELETE', url: `/api/sessions/${limitedId}`, headers: AUTH });
    await waitFor(() => c.deps.sessions.serverLimitedCount() === 0);
    const solto = await launcherStatus(c);
    expect(solto.serverLimited).toBe(0);
    expect(solto.spacingMs).toBeGreaterThanOrEqual(300);
    expect(solto.spacingMs).toBeLessThanOrEqual(900);

    // 4. E o DEGRAU foi zerado, não só escondido: o estrangulamento seguinte
    //    recomeça em 5 s. Com o bug, este número seria os 10 s do passo 2.
    const outroPane = await splitPane(c, agentPane);
    const outro = await c.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: outroPane, kind: 'shell' },
    });
    const outroId = (outro.json() as Session).id;
    await c.app.inject({
      method: 'POST',
      url: `/api/sessions/${outroId}/input`,
      headers: AUTH,
      payload: { data: 'echo Server is temporarily limiting requests\r' },
    });
    await waitFor(() => c.deps.sessions.get(outroId)?.state === 'server-limited');
    expect((await launcherStatus(c)).spacingMs).toBe(5000);
  }, 60000);
});
