/**
 * Spec §5 — "Claude Code aberto DENTRO de um shell", do ponto de vista de QUEM
 * CHAMA: o `POST /hooks/<sid>/<Evento>` que o shim bate. O wrapper da Task 1
 * faz o hook CHEGAR com o id da sessão de SHELL; aqui se prova o que o core faz
 * com ele — a promoção a hospedeira, o caminho de agente daí em diante, e o
 * `SessionEnd` que devolve o painel a "shell" sem matar o PTY.
 *
 * As sessões são criadas direto na `Sessions` (sem PTY, como em
 * `api-scope.test.ts`): o que se está provando é a decisão da rota, e subir um
 * shell de verdade só acrescentaria flakiness a um teste sobre JSON. Que o PTY
 * continua vivo aparece aqui como "a sessão NÃO ficou `exited` e nenhum
 * `session.exited` foi emitido" — o resto é do e2e.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { detailDone, detailThinking } from '../src/adapters/claude.js';
import { PaneBusyError } from '../src/errors.js';
import type { BridgeEvent, LauncherStatus, Session } from '../src/model.js';
import { tmpDir } from './tmp.js';

const AUTH = { authorization: 'Bearer T' };

interface Cenario {
  core: Core;
  /** A sessão de SHELL do painel (a candidata a hospedeira). */
  session: Session;
  paneId: string;
  cwd: string;
  /** Tudo que passou pelo bus desde a criação da sessão. */
  events: BridgeEvent[];
}

/** Um core com um workspace e uma sessão de shell de pé nele. */
function cenario(opts: { hostedAgents?: boolean } = {}): Cenario {
  const core = createCore({ profileDir: tmpDir('bridge-hosted-api-'), dbPath: ':memory:', port: 0, token: 'T' });
  if (opts.hostedAgents === false) core.updateConfig({ sessions: { hostedAgents: false } });
  const cwd = tmpDir('bridge-hosted-cwd-');
  const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
  const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'shell', cwd });
  const events: BridgeEvent[] = [];
  core.deps.bus.on((e) => events.push(e));
  return { core, session, paneId: pane.id, cwd, events };
}

function hook(
  core: Core,
  sessionId: string,
  event: string,
  payload: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown>; json: () => unknown }> {
  return core.app.inject({ method: 'POST', url: `/hooks/${sessionId}/${event}?token=T`, payload }) as Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
    json: () => unknown;
  }>;
}

/** Só os `session.updated` desta sessão (o evento que a Task 3 escuta). */
function updates(events: BridgeEvent[], id: string): Session[] {
  return events.filter((e): e is Extract<BridgeEvent, { type: 'session.updated' }> => e.type === 'session.updated')
    .filter((e) => e.session.id === id)
    .map((e) => e.session);
}

describe('hook numa sessão de shell — promoção a hospedeira', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('o primeiro hook promove: hosted.agent claude, estado running e UM session.updated', async () => {
    const c = cenario();
    core = c.core;
    const antes = Date.now();

    const res = await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.agent).toBe('claude');
    expect(s?.hosted?.since).toBeGreaterThanOrEqual(antes);
    expect(s?.hosted?.since).toBeLessThanOrEqual(Date.now());
    // O anel de estado passa a ser o do Claude — é o ponto do recurso.
    expect(s?.state).toBe('running');
    expect(s?.detail).toBe(detailThinking('pt-BR'));
    // `kind` NUNCA muda: a sessão nasceu shell e volta a ser só shell no fim.
    expect(s?.kind).toBe('shell');
    expect(s?.agent).toBeUndefined();

    const comHosted = updates(c.events, c.session.id).filter((u) => u.hosted !== undefined);
    expect(comHosted).toHaveLength(1);
    expect(comHosted[0]?.hosted?.agent).toBe('claude');
  });

  it('o segundo hook não regrava o `since` nem repete o session.updated da promoção', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    const since = c.core.deps.sessions.get(c.session.id)?.hosted?.since;
    await new Promise((r) => setTimeout(r, 5));
    await hook(c.core, c.session.id, 'PreToolUse', { session_id: 'conv_hosp_1', tool_name: 'Read', tool_input: {} });

    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.since).toBe(since);
    expect(s?.tool).toBe('Read');
    expect(updates(c.events, c.session.id).filter((u) => u.hosted !== undefined)).toHaveLength(1);
  });

  it('Stop numa hospedeira: done + notificação, igualzinho a uma sessão de agente', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    await hook(c.core, c.session.id, 'Stop', { session_id: 'conv_hosp_1' });

    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.state).toBe('done');
    expect(s?.detail).toBe(detailDone('pt-BR'));
    const unread = c.core.deps.notifications.unread();
    expect(unread.some((n) => n.sessionId === c.session.id && n.kind === 'done')).toBe(true);
  });

  it('Notification que espera gente: needs-input na hospedeira', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'Notification', {
      session_id: 'conv_hosp_1',
      message: 'Claude needs your permission to use Bash',
    });
    expect(c.core.deps.sessions.get(c.session.id)?.state).toBe('needs-input');
  });

  it('o session_id do payload vira agentSessionId da sessão e do painel', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'SessionStart', { session_id: 'conv_hosp_7', source: 'startup' });

    expect(c.core.deps.sessions.get(c.session.id)?.agentSessionId).toBe('conv_hosp_7');
    expect(c.core.deps.db.panes.get(c.paneId)?.lastAgentSessionId).toBe('conv_hosp_7');
    // Sessão de shell não pediu resume nenhum: não há veredito a dar.
    expect(c.core.deps.sessions.get(c.session.id)?.resumeOutcome).toBeUndefined();
  });

  it('StatusLine da hospedeira responde text/plain e grava a cota (a linha do terminal é opcional)', async () => {
    const c = cenario();
    core = c.core;
    const payload = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'statusline.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const res = await hook(c.core, c.session.id, 'StatusLine', payload);

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    // 0.12.2 — `usage.terminalStatusLine` nasce desligada, então o terminal
    // recebe linha vazia; o que a hospedeira precisa continuar tendo é a COTA,
    // e ela vem do mesmo payload.
    expect(res.body).toBe('');
    expect(c.core.deps.sessions.get(c.session.id)?.quota).toMatchObject({ contextTokens: 87_000 });
    expect(c.core.deps.sessions.get(c.session.id)?.quota?.line).toContain('87k ctx');
    expect(c.core.deps.sessions.get(c.session.id)?.hosted?.agent).toBe('claude');

    // Ligada, a hospedeira desenha a linha como qualquer sessão de agente.
    c.core.updateConfig({ usage: { terminalStatusLine: true } });
    const ligada = await hook(c.core, c.session.id, 'StatusLine', payload);
    expect(ligada.body).toContain('87k ctx');
  });

  it('GET /api/state serializa o `hosted` da sessão', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    const res = await c.core.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const { sessions } = res.json() as { sessions: Session[] };
    const s = sessions.find((x) => x.id === c.session.id);
    expect(s?.hosted).toEqual({ agent: 'claude', since: c.core.deps.sessions.get(c.session.id)?.hosted?.since });
    expect(s?.kind).toBe('shell');
  });
});

describe('SessionEnd numa hospedeira', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('motivo de saída desfaz a hospedagem: idle, sem detail/tool, e o shell NÃO fica exited', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    await hook(c.core, c.session.id, 'PreToolUse', {
      session_id: 'conv_hosp_1',
      tool_name: 'Read',
      tool_input: { file_path: join(c.cwd, 'x.ts') },
    });

    const res = await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted).toBeUndefined();
    expect(s?.state).toBe('idle');
    expect(s?.detail).toBeUndefined();
    expect(s?.tool).toBeUndefined();
    expect(s?.kind).toBe('shell');
    expect(s?.exitCode).toBeUndefined();
    // O PTY do shell continua vivo: nada de `session.exited` no bus.
    expect(c.events.some((e) => e.type === 'session.exited')).toBe(false);
    // A conversa fica guardada (a Task 3 mostra; retomar é BACKLOG).
    expect(s?.agentSessionId).toBe('conv_hosp_1');
    // O fim da hospedagem sai pelo mesmo evento da promoção.
    const ultimos = updates(c.events, c.session.id);
    expect(ultimos.at(-1)?.hosted).toBeUndefined();
  });

  it('SessionEnd sem motivo também desfaz (é o mesmo critério do adaptador)', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted).toBeUndefined();
    expect(c.core.deps.sessions.get(c.session.id)?.state).toBe('idle');
  });

  it('SessionEnd de /clear NÃO desfaz: o Claude continua aberto no shell', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'clear' });

    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.agent).toBe('claude');
    expect(s?.state).toBe('running');
  });

  it('depois do fim, um hook novo hospeda de novo com um `since` novo', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    const primeiro = c.core.deps.sessions.get(c.session.id)?.hosted?.since ?? 0;
    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    await new Promise((r) => setTimeout(r, 5));
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_2' });

    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.since).toBeGreaterThan(primeiro);
    expect(s?.state).toBe('running');
  });
});

describe('hook atrasado numa sessão de shell já `exited`', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /**
   * Review final da 0.12.0: o PTY morreu (a pessoa fechou o painel, ou o shell
   * caiu) e o shim do Claude que rodava lá dentro ainda bate um hook. Promover
   * agora marcaria como hospedeira uma sessão que já acabou — ela voltaria a
   * ocupar um slot do teto e a linha da sidebar viraria `claude` sem nada vivo
   * atrás.
   */
  it('não promove: nada de `hosted`, nada de estado, e a sessão continua exited', async () => {
    const c = cenario();
    core = c.core;
    c.core.deps.sessions.exited(c.session.id, 0);

    const res = await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted).toBeUndefined();
    expect(s?.state).toBe('exited');
    expect(c.core.deps.sessions.liveAgentCount()).toBe(0);
    expect(updates(c.events, c.session.id).some((u) => u.hosted !== undefined)).toBe(false);
  });

  /**
   * O contraponto: hospedeira VIVA que fica `exited` (o PTY morreu com o Claude
   * aberto dentro) continua sendo tratada pelo caminho de sempre — a guarda é
   * só da PROMOÇÃO, não da hospedagem em curso.
   */
  it('hospedeira que já foi promovida continua com a marca depois do PTY morrer', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    c.core.deps.sessions.exited(c.session.id, 0);

    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted).toBeUndefined();
  });
});

/**
 * Review final da 0.12.0 — as duas rotas que TROCAM a sessão de um painel.
 *
 * Uma hospedeira é um shell no `kind` e um agente na prática: matar o PTY dela
 * mata o Claude Code que está trabalhando lá dentro. O `POST /api/panes/:id/resume`
 * olhava só `kind === 'agent'` e o `replaceableShell` do core só `kind === 'shell'
 * && state !== 'exited'` — os dois derrubavam a hospedeira sem perguntar. O
 * critério agora é o mesmo do `runsAgent` da UI: `hosted` conta como agente.
 */
describe('hospedeira e as rotas que trocam a sessão do painel', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  /**
   * O `claude` falso — só o que SOBE. O `onHook` continua sendo o do adaptador
   * de verdade: é ele que promove a hospedeira e escreve o estado, e trocá-lo
   * por um `() => ({})` deixaria a sessão `idle` (a linha da sidebar de que
   * estes testes falam some junto).
   */
  function fakeClaude(c: Core): void {
    const real = c.deps.adapters.claude!;
    c.deps.adapters.claude = {
      ...real,
      available: async () => ({ ok: true }),
      launch: () => ({
        bin: process.execPath,
        args: [join(__dirname, 'fake-agent.cjs')],
        env: { ...process.env } as Record<string, string>,
        files: [],
      }),
      onHook: (...args: Parameters<typeof real.onHook>) => real.onHook(...args),
    };
  }

  function resume(c: Core, paneId: string): Promise<{ statusCode: number; json: () => unknown }> {
    return c.app.inject({ method: 'POST', url: `/api/panes/${paneId}/resume`, headers: AUTH });
  }

  it('shell hospedeiro + `bridge resume` → 409 pane-busy, e a hospedagem fica INTACTA', async () => {
    const c = cenario();
    core = c.core;
    fakeClaude(c.core);
    c.core.deps.layout.setPaneLast(c.paneId, 'agent', 'claude', 'conversa-antiga');
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted?.agent).toBe('claude');

    const res = await resume(c.core, c.paneId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'pane-busy' });
    // Nada foi tocado: a sessão é a mesma, ainda hospedeira e ainda viva.
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.agent).toBe('claude');
    expect(s?.state).toBe('running');
    expect(s?.state).not.toBe('exited');
    expect(c.core.deps.sessions.byPane(c.paneId)?.id).toBe(c.session.id);
    expect(c.events.some((e) => e.type === 'session.exited')).toBe(false);
  });

  it('depois do SessionEnd de saída, o resume volta a funcionar como antes', async () => {
    const c = cenario();
    core = c.core;
    fakeClaude(c.core);
    c.core.deps.layout.setPaneLast(c.paneId, 'agent', 'claude', 'conversa-antiga');
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted).toBeUndefined();

    const res = await resume(c.core, c.paneId);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; resumedFrom: string };
    expect(body.kind).toBe('agent');
    // A conversa retomada é a que rodava HOSPEDADA: o hook gravou o
    // `session_id` dela no painel (`lastAgentSessionId`) por cima da anterior.
    expect(body.resumedFrom).toBe('conv_hosp_1');
    // O shell (que nunca foi hospedeiro de novo) cedeu o painel, como sempre.
    expect(c.core.deps.sessions.get(c.session.id)).toBeUndefined();
    expect(c.core.deps.sessions.byPane(c.paneId)?.id).toBe(body.id);
  }, 25000);

  it('`replaceLiveShell` no core NÃO derruba hospedeira: PaneBusyError', async () => {
    const c = cenario();
    core = c.core;
    fakeClaude(c.core);
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    await expect(
      c.core.createSession({
        paneId: c.paneId,
        kind: 'agent',
        agent: 'claude',
        resume: 'conversa-antiga',
        replaceLiveShell: true,
      }),
    ).rejects.toThrow(PaneBusyError);
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted?.agent).toBe('claude');
    expect(s?.state).toBe('running');
    expect(c.core.deps.sessions.byPane(c.paneId)?.id).toBe(c.session.id);
  });

  it('sem hospedagem o `replaceLiveShell` continua trocando o shell vivo pelo agente', async () => {
    const c = cenario();
    core = c.core;
    fakeClaude(c.core);

    const session = await c.core.createSession({
      paneId: c.paneId,
      kind: 'agent',
      agent: 'claude',
      resume: 'conversa-antiga',
      replaceLiveShell: true,
    });

    expect(session.kind).toBe('agent');
    expect(c.core.deps.sessions.get(c.session.id)).toBeUndefined();
    expect(c.core.deps.sessions.byPane(c.paneId)?.id).toBe(session.id);
  }, 25000);

  it('`POST /api/sessions` num painel hospedeiro também é 409 (a rota nem chega ao core)', async () => {
    const c = cenario();
    core = c.core;
    fakeClaude(c.core);
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    const res = await c.core.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId: c.paneId, kind: 'agent', agent: 'claude' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'pane-busy' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted?.agent).toBe('claude');
  });
});

describe('hostedAgents desligado e sessão de agente', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('com `sessions.hostedAgents` false o hook do shell não muda nada e responde {}', async () => {
    const c = cenario({ hostedAgents: false });
    core = c.core;
    const res = await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted).toBeUndefined();
    expect(s?.state).toBe('idle');
    expect(s?.agentSessionId).toBeUndefined();
    expect(updates(c.events, c.session.id)).toHaveLength(0);
    expect(c.core.deps.sessions.liveAgentCount()).toBe(0);
  });

  /**
   * O interruptor da seção Sessões pode ser desligado com um Claude JÁ aberto
   * dentro de um shell. Barrar a rota nesse caso prenderia a hospedagem: o
   * `SessionEnd` nunca chegaria, e o painel ficaria "claude" — ocupando um slot
   * do teto — até o PTY morrer. Ele decide PROMOÇÃO, não interrompe hospedagem.
   */
  it('desligar `hostedAgents` no meio NÃO prende a hospedagem: ela termina pelo caminho normal', async () => {
    const c = cenario();
    core = c.core;
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted?.agent).toBe('claude');

    c.core.updateConfig({ sessions: { hostedAgents: false } });

    // O turno em curso continua sendo desenhado.
    await hook(c.core, c.session.id, 'Stop', { session_id: 'conv_hosp_1' });
    expect(c.core.deps.sessions.get(c.session.id)?.state).toBe('done');
    expect(c.core.deps.sessions.liveAgentCount()).toBe(1);

    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    const s = c.core.deps.sessions.get(c.session.id);
    expect(s?.hosted).toBeUndefined();
    expect(s?.state).toBe('idle');
    expect(c.core.deps.sessions.liveAgentCount()).toBe(0);

    // E com o interruptor desligado ela não volta a ser promovida.
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_2' });
    expect(c.core.deps.sessions.get(c.session.id)?.hosted).toBeUndefined();
    expect(c.core.deps.sessions.get(c.session.id)?.state).toBe('idle');
  });

  it('sessão de AGENTE segue exatamente como antes (sem hosted)', async () => {
    const c = cenario();
    core = c.core;
    const agente = c.core.deps.sessions.create({
      paneId: c.paneId,
      workspaceId: c.core.deps.sessions.get(c.session.id)!.workspaceId,
      kind: 'agent',
      agent: 'claude',
      cwd: c.cwd,
    });
    await hook(c.core, agente.id, 'UserPromptSubmit', { session_id: 'conv_agente' });
    const s = c.core.deps.sessions.get(agente.id);
    expect(s?.state).toBe('running');
    expect(s?.hosted).toBeUndefined();
    expect(s?.agentSessionId).toBe('conv_agente');

    // E o `SessionEnd` de saída continua marcando `exited` num agente.
    await hook(c.core, agente.id, 'SessionEnd', { session_id: 'conv_agente', reason: 'exit' });
    expect(c.core.deps.sessions.get(agente.id)?.state).toBe('exited');
  });

  it('a hospedeira conta no teto do escalonador e aparece em `active`', async () => {
    const c = cenario();
    core = c.core;
    expect(c.core.deps.sessions.liveAgentCount()).toBe(0);
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });
    expect(c.core.deps.sessions.liveAgentCount()).toBe(1);

    const res = await c.core.app.inject({ method: 'GET', url: '/api/launcher', headers: AUTH });
    expect((res.json() as LauncherStatus).active).toBe(1);

    // E o slot vaga quando a hospedagem acaba.
    await hook(c.core, c.session.id, 'SessionEnd', { session_id: 'conv_hosp_1', reason: 'exit' });
    expect(c.core.deps.sessions.liveAgentCount()).toBe(0);
  });

  it('a hospedeira nunca entra na fila do escalonador', async () => {
    const c = cenario();
    core = c.core;
    c.core.updateConfig({ sessions: { maxConcurrentAgents: 1 } });
    await hook(c.core, c.session.id, 'UserPromptSubmit', { session_id: 'conv_hosp_1' });

    const res = await c.core.app.inject({ method: 'GET', url: '/api/launcher', headers: AUTH });
    const status = res.json() as LauncherStatus;
    expect(status.pending).toEqual([]);
  });
});
