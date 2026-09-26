/**
 * Dor verificada #3 ponta a ponta dentro do core: o hook `SessionStart` que
 * denuncia o resume vazio, o evento `session.updated` que a UI escuta, e o
 * `POST /api/sessions/:id/recap` que devolve o resumo.
 *
 * O `claude` é falso (o de verdade não sobe em teste), mas o caminho é o real:
 * `POST /api/sessions { resume }` → shim batendo em `/hooks/:id/SessionStart`
 * → rota do resumo lendo o transcript de um `claudeHome` temporário.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { BridgeEvent } from '../src/model.js';
import { transcriptPathFor } from '../src/recap.js';
import { tmpDir } from './tmp.js';

const AUTH = { authorization: 'Bearer T' };
const fakeAgentPath = join(__dirname, 'fake-agent.cjs');
const PEDIDO = 'conversa-antiga-1111';
const OUTRA = 'conversa-nova-2222';

function tmp(): string {
  return tmpDir('bridge-recap-api-');
}

function fakeClaude(core: Core): void {
  core.deps.adapters.claude = {
    id: 'claude',
    label: 'Claude falso',
    available: async () => ({ ok: true }),
    launch: () => ({
      bin: process.execPath,
      args: [fakeAgentPath],
      env: { ...process.env } as Record<string, string>,
      files: [],
    }),
    onHook: () => ({}),
  };
}

/** Workspace novo num `cwd` dado (o `cwd` é o que dá a pasta do transcript). */
async function paneIn(core: Core, cwd: string): Promise<string> {
  const ws = await core.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
  return (ws.json() as { pane: { id: string } }).pane.id;
}

async function agentWithResume(core: Core, paneId: string, resume?: string): Promise<string> {
  const res = await core.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: AUTH,
    payload: { paneId, kind: 'agent', agent: 'claude', ...(resume ? { resume } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

function sessionStart(core: Core, sessionId: string, payload: Record<string, unknown>): Promise<{ statusCode: number }> {
  return core.app.inject({
    method: 'POST',
    // `/hooks/*` autentica por `?token=` e recusa qualquer `Origin` — é a
    // porta do shim, não da UI.
    url: `/hooks/${sessionId}/SessionStart?token=T`,
    payload,
  });
}

function writeTranscript(home: string, cwd: string, id: string, lines: unknown[]): void {
  const path = transcriptPathFor(home, cwd, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

/** `session.updated` que carrega VEREDITO (o do `sawOutput` não carrega). */
function veredito(e: BridgeEvent): boolean {
  return e.type === 'session.updated' && e.session.resumeOutcome !== undefined;
}

const TRANSCRIPT = [
  { type: 'user', message: { content: 'termina o escalonador de lançamentos' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'escalonador pronto, faltam os testes' }] } },
];

describe('dor #3 — SessionStart denuncia o resume vazio', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('id DIFERENTE do pedido → resumeOutcome fresh e session.updated no bus', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const events: BridgeEvent[] = [];
    c.deps.bus.on((ev) => events.push(ev));

    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId, PEDIDO);
    await sessionStart(c, sessionId, { session_id: OUTRA, source: 'startup' });

    expect(c.deps.sessions.get(sessionId)?.resumeOutcome).toBe('fresh');
    // Só os `session.updated` que CARREGAM veredito: o agente falso imprime no
    // PTY, e o primeiro byte emite o seu próprio `session.updated`
    // (`sawOutput`), em corrida com este.
    expect(events.filter(veredito)).toHaveLength(1);
  }, 30000);

  it('id IGUAL ao pedido → resumeOutcome ok, e nenhuma faixa a acender', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId, PEDIDO);
    await sessionStart(c, sessionId, { session_id: PEDIDO, source: 'resume' });

    expect(c.deps.sessions.get(sessionId)?.resumeOutcome).toBe('ok');
  }, 30000);

  it('sessão que não pediu resume não ganha veredito nenhum', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId);
    await sessionStart(c, sessionId, { session_id: OUTRA, source: 'startup' });

    const session = c.deps.sessions.get(sessionId);
    expect(session?.resumeRequested).toBeUndefined();
    expect(session?.resumeOutcome).toBeUndefined();
  }, 30000);

  it('um /clear DEPOIS não reescreve o veredito (nem emite um segundo evento)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const events: BridgeEvent[] = [];
    c.deps.bus.on((ev) => events.push(ev));

    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId, PEDIDO);
    await sessionStart(c, sessionId, { session_id: PEDIDO, source: 'resume' });
    await sessionStart(c, sessionId, { session_id: PEDIDO, source: 'clear' });

    expect(c.deps.sessions.get(sessionId)?.resumeOutcome).toBe('ok');
    expect(events.filter(veredito)).toHaveLength(1);
  }, 30000);

  /**
   * Fix round 1 — a trava era o `resumeOutcome` já gravado, e não a chegada do
   * primeiro `SessionStart`. Um payload sem `session_id` E sem `source` não
   * vira veredito (regra do "não inventa alarme"), então a janela ficava
   * ABERTA — e o `SessionStart` do `/clear` que o próprio dono digitou virava
   * `'fresh'`, acendendo a faixa "o resume falhou" por um contexto que ele
   * acabou de limpar. É o alarme falso que a regra existe pra evitar.
   */
  it('SessionStart mudo FECHA o julgamento: o /clear seguinte não vira fresh', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const events: BridgeEvent[] = [];
    c.deps.bus.on((ev) => events.push(ev));

    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId, PEDIDO);
    // Nem id nem source: o Bridge não tem o que julgar.
    await sessionStart(c, sessionId, { cwd: 'qualquer' });
    expect(c.deps.sessions.get(sessionId)?.resumeOutcome).toBeUndefined();

    // O `/clear` do dono, depois. Não pode virar veredito nenhum.
    await sessionStart(c, sessionId, { session_id: OUTRA, source: 'clear' });

    expect(c.deps.sessions.get(sessionId)?.resumeOutcome).toBeUndefined();
    expect(events.filter(veredito)).toHaveLength(0);
  }, 30000);
});

describe('POST /api/sessions/:id/recap', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('devolve o resumo do transcript da conversa PEDIDA', async () => {
    const home = tmp();
    const cwd = tmp();
    writeTranscript(home, cwd, PEDIDO, TRANSCRIPT);
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
    const c = core;
    fakeClaude(c);
    const paneId = await paneIn(c, cwd);
    const sessionId = await agentWithResume(c, paneId, PEDIDO);

    const res = await c.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/recap`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { text: string };
    expect(body.text).toContain('termina o escalonador de lançamentos');
    expect(body.text).toContain('escalonador pronto');
    // Uma linha só: o texto vai pro PROMPT do agente, e um `\n` seria Enter.
    expect(body.text).not.toContain('\n');
    expect(body.text.length).toBeLessThanOrEqual(2500);
  }, 30000);

  it('sessão sem resume → 422 no-resume', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    fakeClaude(c);
    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId);

    const res = await c.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/recap`, headers: AUTH });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'no-resume' });
  }, 30000);

  it('transcript que não existe mais → 404 transcript-not-found', async () => {
    const home = tmp();
    mkdirSync(join(home, 'projects'), { recursive: true });
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: home });
    const c = core;
    fakeClaude(c);
    const paneId = await paneIn(c, tmp());
    const sessionId = await agentWithResume(c, paneId, PEDIDO);

    const res = await c.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/recap`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'transcript-not-found' });
  }, 30000);

  it('sessão inexistente → 404 session-not-found', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const res = await core.app.inject({ method: 'POST', url: '/api/sessions/sess_naoexiste/recap', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'session-not-found' });
  });

  it('sem token → 401 (a rota lê transcript do disco)', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const res = await core.app.inject({ method: 'POST', url: '/api/sessions/sess_qualquer/recap' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /api/config — sessions.autoRecap', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('nasce desligado e aceita ser ligado sem apagar os vizinhos', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const c = core;
    expect(c.config().sessions.autoRecap).toBe(false);

    const res = await c.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { autoRecap: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(c.config().sessions.autoRecap).toBe(true);
    // O merge é por CHAVE: ligar o resumo não pode zerar o teto do escalonador.
    expect(c.config().sessions.maxConcurrentAgents).toBe(4);
  });
});
