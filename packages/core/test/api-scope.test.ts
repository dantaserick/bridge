/**
 * Dor verificada #4 — a guarda de escopo do ponto de vista de QUEM CHAMA: o
 * `POST /hooks/<sid>/PreToolUse` (o que o shim faz a cada ferramenta) e o
 * `PATCH /api/workspaces/:id { crossAccess }` (o que o menu "⋯" faz).
 *
 * As sessões aqui são criadas direto na `Sessions` (sem PTY): o que se está
 * provando é a decisão da rota, e subir um processo de agente só acrescentaria
 * flakiness a um teste sobre JSON.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { Session, Workspace } from '../src/model.js';
import { realPathOfExisting } from '../src/scopeGuard.js';
import { isDisplaySafe } from '@bridge/shared';
import { tmpDir } from './tmp.js';

const AUTH = { authorization: 'Bearer T' };
const ESC = '\u001b';
const BEL = '\u0007';

interface Cenario {
  core: Core;
  workspace: Workspace;
  session: Session;
  /** Worktree da tarefa (a raiz permitida) e o worktree IRMÃO. */
  a: string;
  b: string;
  repo: string;
}

/**
 * Um core com um workspace de TAREFA (worktree `a`) e um worktree irmão `b` no
 * mesmo repo, com uma sessão de agente de pé no `a`. É o cenário da dor.
 */
function cenario(opts: { crossAccess?: boolean; scopeGuard?: boolean; wsl?: boolean } = {}): Cenario {
  const profileDir = tmpDir('bridge-scope-api-');
  const repo = realPathOfExisting(tmpDir('bridge-scope-repo-'))!;
  const a = join(repo, '.worktrees', 'tarefa-a');
  const b = join(repo, '.worktrees', 'tarefa-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'meu.ts'), 'a', 'utf8');
  writeFileSync(join(b, 'alheio.ts'), 'b', 'utf8');

  const core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });
  if (opts.scopeGuard === false) core.updateConfig({ sessions: { scopeGuard: false } });

  const { workspace, pane } = core.deps.layout.createWorkspace({ cwd: a });
  // O `createWorkspace` do layout não detecta git (quem detecta é o core, com
  // um repo de verdade). O worktree é gravado à mão porque o que a guarda lê é
  // exatamente este campo.
  const withWorktree: Workspace = {
    ...workspace,
    worktree: { base: 'main', path: a },
    crossAccess: opts.crossAccess ? true : undefined,
    environment: opts.wsl ? { kind: 'wsl', distro: 'Ubuntu' } : undefined,
  };
  core.deps.db.workspaces.update(withWorktree);

  const session = core.deps.sessions.create({
    paneId: pane.id,
    workspaceId: workspace.id,
    kind: 'agent',
    agent: 'claude',
    cwd: a,
  });
  return { core, workspace: withWorktree, session, a, b, repo };
}

/**
 * O corpo que o shim manda no `PreToolUse`. Tipado (e não `unknown`) porque o
 * `inject` do Fastify pede um `InjectPayload`, e afrouxar com `as` esconderia
 * um erro de forma no próprio teste.
 */
interface PreToolUsePayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /**
   * O `cwd` que o Claude Code manda em TODO hook — o diretório de verdade do
   * processo dele, que pode não ser o `cwd` com que a sessão subiu (a pessoa
   * deu `cd` antes de abrir o `claude` dentro do shell). É contra ele que o
   * caminho relativo resolve. Tipado como `unknown` porque metade dos testes
   * daqui manda coisa que não é caminho.
   */
  cwd?: unknown;
}

function preToolUse(
  core: Core,
  sessionId: string,
  payload: PreToolUsePayload,
): Promise<{ statusCode: number; json: () => unknown }> {
  return core.app.inject({ method: 'POST', url: `/hooks/${sessionId}/PreToolUse?token=T`, payload });
}

interface DenyBody {
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
}

describe('POST /hooks/:id/PreToolUse — guarda de escopo', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('Read do próprio worktree passa e a sessão continua andando', async () => {
    const c = cenario();
    core = c.core;
    const res = await preToolUse(c.core, c.session.id, {
      session_id: 'conv_1',
      tool_name: 'Read',
      tool_input: { file_path: join(c.a, 'meu.ts') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    // O adaptador continua mandando na sessão quando a guarda não interfere.
    expect(c.core.deps.sessions.get(c.session.id)?.state).toBe('running');
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
  });

  it('Read do worktree IRMÃO volta `deny` no formato documentado', async () => {
    const c = cenario();
    core = c.core;
    const alvo = join(c.b, 'alheio.ts');
    const res = await preToolUse(c.core, c.session.id, {
      session_id: 'conv_1',
      tool_name: 'Read',
      tool_input: { file_path: alvo },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DenyBody;
    expect(body.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(body.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput?.permissionDecisionReason).toContain(alvo);
    expect(body.hookSpecificOutput?.permissionDecisionReason).toContain(
      'Libere em ⋯ → "Permitir acesso fora do worktree"',
    );
  });

  it('a recusa NÃO marca a ferramenta na sessão (ela não vai rodar)', async () => {
    const c = cenario();
    core = c.core;
    await preToolUse(c.core, c.session.id, { tool_name: 'Edit', tool_input: { file_path: join(c.b, 'alheio.ts') } });
    expect(c.core.deps.sessions.get(c.session.id)?.tool).toBeUndefined();
  });

  it('conta as recusas e guarda no máximo 5 caminhos, do mais recente pro mais antigo', async () => {
    const c = cenario();
    core = c.core;
    for (let i = 0; i < 7; i += 1) {
      await preToolUse(c.core, c.session.id, {
        tool_name: 'Read',
        tool_input: { file_path: join(c.b, `f${i}.ts`) },
      });
    }
    const blocks = c.core.deps.sessions.get(c.session.id)?.scopeBlocks;
    expect(blocks?.count).toBe(7);
    expect(blocks?.paths).toHaveLength(5);
    expect(blocks?.paths[0]).toBe(join(c.b, 'f6.ts'));
    expect(blocks?.paths[4]).toBe(join(c.b, 'f2.ts'));
  });

  it('o mesmo caminho repetido soma no contador mas não duplica na lista', async () => {
    const c = cenario();
    core = c.core;
    const alvo = join(c.b, 'alheio.ts');
    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    const blocks = c.core.deps.sessions.get(c.session.id)?.scopeBlocks;
    expect(blocks?.count).toBe(2);
    expect(blocks?.paths).toEqual([alvo]);
  });

  it('caminho com sequência de terminal chega SANITIZADO na sessão e na razão', async () => {
    const c = cenario();
    core = c.core;
    // O `tool_input` vem do agente, e o agente lê arquivo de repositório
    // alheio: o caminho é texto hostil até prova em contrário. Ele acaba em
    // dois lugares que uma pessoa lê — o tooltip do selo (via `scopeBlocks`)
    // e a razão que o Claude repete na conversa.
    const hostil = `${join(c.b, 'alheio')}${ESC}]0;titulo${BEL}.ts`;
    const res = await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: hostil } });
    const razao = (res.json() as DenyBody).hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(razao).toContain('fora do worktree desta tarefa');
    expect(isDisplaySafe(razao)).toBe(true);
    const paths = c.core.deps.sessions.get(c.session.id)?.scopeBlocks?.paths ?? [];
    expect(paths).toHaveLength(1);
    expect(isDisplaySafe(paths[0]!)).toBe(true);
    expect(paths[0]).not.toContain(ESC);
  });

  it('a recusa emite `session.updated` com a sessão inteira', async () => {
    const c = cenario();
    core = c.core;
    const vistos: Session[] = [];
    c.core.deps.bus.on((ev) => {
      if (ev.type === 'session.updated') vistos.push(ev.session);
    });
    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: join(c.b, 'x.ts') } });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]?.scopeBlocks?.count).toBe(1);
  });

  it('Bash com o caminho do irmão no comando NÃO é barrado', async () => {
    const c = cenario();
    core = c.core;
    const res = await preToolUse(c.core, c.session.id, {
      tool_name: 'Bash',
      tool_input: { command: `type ${join(c.b, 'alheio.ts')}` },
    });
    expect(res.json()).toEqual({});
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
  });

  it('workspace com `crossAccess` deixa passar', async () => {
    const c = cenario({ crossAccess: true });
    core = c.core;
    const res = await preToolUse(c.core, c.session.id, {
      tool_name: 'Read',
      tool_input: { file_path: join(c.b, 'alheio.ts') },
    });
    expect(res.json()).toEqual({});
  });

  it('`sessions.scopeGuard: false` desliga a guarda inteira', async () => {
    const c = cenario({ scopeGuard: false });
    core = c.core;
    const res = await preToolUse(c.core, c.session.id, {
      tool_name: 'Read',
      tool_input: { file_path: 'C:\\Windows\\system.ini' },
    });
    expect(res.json()).toEqual({});
  });

  /*
   * Limite declarado da 0.11.0 (`SECURITY.md` risco 18). O agente de uma
   * sessão de WSL roda DENTRO da distro e declara caminho POSIX; a raiz
   * gravada no workspace é do Windows. Julgar um contra o outro no `win32`
   * grudaria `/mnt/d/…` na unidade do `cwd` e recusaria TODA ferramenta com
   * caminho — inclusive a leitura do próprio arquivo da tarefa. Enquanto a
   * tradução pro espaço POSIX não existe (BACKLOG), a guarda não se aplica
   * ali: nem `deny`, nem contador.
   */
  it('workspace de WSL: caminho POSIX de dentro E de fora passam, sem contador', async () => {
    const c = cenario({ wsl: true });
    core = c.core;
    // Como o agente escreveria de dentro da distro: o worktree da tarefa…
    const dentro = `/mnt/d/repo/.worktrees/tarefa-a/meu.ts`;
    // …e um lugar que a guarda barraria num workspace do Windows.
    const fora = `/mnt/d/repo/.worktrees/tarefa-b/alheio.ts`;
    for (const alvo of [dentro, fora, '/etc/passwd']) {
      const res = await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
      expect(res.statusCode, alvo).toBe(200);
      expect(res.json(), alvo).toEqual({});
    }
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
    // O caminho do Windows do worktree irmão também passa: o que está
    // desligado é a guarda do workspace inteiro, não só a leitura de `/mnt`.
    const irmao = await preToolUse(c.core, c.session.id, {
      tool_name: 'Read',
      tool_input: { file_path: join(c.b, 'alheio.ts') },
    });
    expect(irmao.json()).toEqual({});
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
  });

  /**
   * Até a 0.11.x o hook de uma sessão de shell era descartado na porta, e a
   * guarda nunca era consultada. Na 0.12.0 esse mesmo hook PROMOVE a sessão a
   * hospedeira (spec §5) e passa a ser julgado como o de um agente — o que
   * segura o comportamento antigo é o interruptor `sessions.hostedAgents`.
   */
  it('sessão de SHELL não é julgada quando `hostedAgents` está desligada', async () => {
    const c = cenario();
    core = c.core;
    c.core.updateConfig({ sessions: { hostedAgents: false } });
    const shell = c.core.deps.sessions.create({
      paneId: c.session.paneId,
      workspaceId: c.workspace.id,
      kind: 'shell',
      cwd: c.a,
    });
    const res = await preToolUse(c.core, shell.id, { tool_name: 'Read', tool_input: { file_path: join(c.b, 'x.ts') } });
    expect(res.json()).toEqual({});
    expect(c.core.deps.sessions.get(shell.id)?.hosted).toBeUndefined();
  });

  it('sessão de SHELL HOSPEDEIRA é julgada como um agente', async () => {
    const c = cenario();
    core = c.core;
    const shell = c.core.deps.sessions.create({
      paneId: c.session.paneId,
      workspaceId: c.workspace.id,
      kind: 'shell',
      cwd: c.a,
    });
    const res = await preToolUse(c.core, shell.id, { tool_name: 'Read', tool_input: { file_path: join(c.b, 'x.ts') } });
    expect((res.json() as DenyBody).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('PATCH /api/workspaces/:id { crossAccess }', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('liga, persiste e vale NA HORA pro próximo PreToolUse', async () => {
    const c = cenario();
    core = c.core;
    const alvo = join(c.b, 'alheio.ts');

    const antes = await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    expect((antes.json() as DenyBody).hookSpecificOutput?.permissionDecision).toBe('deny');

    const patch = await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: { crossAccess: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: c.workspace.id, crossAccess: true });
    expect(c.core.deps.db.workspaces.get(c.workspace.id)?.crossAccess).toBe(true);

    const depois = await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    expect(depois.json()).toEqual({});
  });

  /**
   * 0.12.2 — a queixa do dono: "eu liberei, mas ainda ficou o escudo azul".
   * Liberar zera o contador das sessões DAQUELE workspace e emite um
   * `session.updated` por sessão zerada; restringir de novo não repõe o
   * histórico, e o contador recomeça do zero na primeira recusa nova.
   */
  it('liberar ZERA o selo das sessões do workspace, com um `session.updated` por sessão', async () => {
    const c = cenario();
    core = c.core;
    const alvo = join(c.b, 'alheio.ts');

    // Uma segunda sessão no MESMO workspace, e uma terceira num workspace de
    // fora: a limpeza é do workspace liberado, não de tudo que está de pé.
    const irma = c.core.deps.sessions.create({
      paneId: `${c.session.paneId}-2`,
      workspaceId: c.workspace.id,
      kind: 'agent',
      agent: 'claude',
      cwd: c.a,
    });
    const { workspace: outro, pane: outroPane } = c.core.deps.layout.createWorkspace({ cwd: c.repo });
    const deFora = c.core.deps.sessions.create({
      paneId: outroPane.id,
      workspaceId: outro.id,
      kind: 'agent',
      agent: 'claude',
      cwd: c.repo,
    });
    c.core.deps.sessions.noteScopeBlock(deFora.id, 'C:\\alheio\\x.ts');

    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: join(c.repo, 'leiame.md') } });
    await preToolUse(c.core, irma.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks?.count).toBe(2);
    expect(c.core.deps.sessions.get(irma.id)?.scopeBlocks?.count).toBe(1);

    const vistos: Session[] = [];
    c.core.deps.bus.on((ev) => {
      if (ev.type === 'session.updated') vistos.push(ev.session);
    });
    const patch = await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: { crossAccess: true },
    });
    expect(patch.statusCode).toBe(200);

    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
    expect(c.core.deps.sessions.get(irma.id)?.scopeBlocks).toBeUndefined();
    // A sessão de OUTRO workspace não foi tocada — a liberação é daquele ali.
    expect(c.core.deps.sessions.get(deFora.id)?.scopeBlocks?.count).toBe(1);

    // Um evento por sessão zerada, com a sessão inteira dentro (é assim que a
    // UI apaga o selo sem recarregar o snapshot).
    expect(vistos.map((s) => s.id).sort()).toEqual([c.session.id, irma.id].sort());
    expect(vistos.every((s) => s.scopeBlocks === undefined)).toBe(true);
  });

  it('liberar workspace SEM recusa nenhuma não emite evento nenhum', async () => {
    const c = cenario();
    core = c.core;
    const vistos: string[] = [];
    c.core.deps.bus.on((ev) => {
      if (ev.type === 'session.updated') vistos.push(ev.session.id);
    });
    await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: { crossAccess: true },
    });
    expect(vistos).toEqual([]);
  });

  it('restringir de novo: o contador recomeça do ZERO na próxima recusa', async () => {
    const c = cenario();
    core = c.core;
    const alvo = join(c.b, 'alheio.ts');
    const patch = (crossAccess: boolean): Promise<{ statusCode: number }> =>
      c.core.app.inject({
        method: 'PATCH',
        url: `/api/workspaces/${c.workspace.id}`,
        headers: AUTH,
        payload: { crossAccess },
      });

    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks?.count).toBe(2);

    await patch(true);
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();

    // Restringir NÃO devolve o 2 — o histórico é do log, não deste número.
    await patch(false);
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();

    const negado = await preToolUse(c.core, c.session.id, { tool_name: 'Read', tool_input: { file_path: alvo } });
    expect((negado.json() as DenyBody).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks?.count).toBe(1);
  });

  it('desliga de volta', async () => {
    const c = cenario({ crossAccess: true });
    core = c.core;
    const res = await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: { crossAccess: false },
    });
    expect(res.statusCode).toBe(200);
    expect(c.core.deps.db.workspaces.get(c.workspace.id)?.crossAccess).toBeUndefined();
  });

  it('corpo vazio continua sendo 400 (o PATCH tem que dizer alguma coisa)', async () => {
    const c = cenario();
    core = c.core;
    const res = await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('`environment` e `crossAccess` podem vir juntos', async () => {
    const c = cenario();
    core = c.core;
    const res = await c.core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${c.workspace.id}`,
      headers: AUTH,
      payload: { crossAccess: true, environment: { kind: 'gitbash' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ crossAccess: true, environment: { kind: 'gitbash' } });
  });

  it('workspace desconhecido → 404', async () => {
    const c = cenario();
    core = c.core;
    const res = await c.core.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/ws_nao_existe',
      headers: AUTH,
      payload: { crossAccess: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/config { sessions: { scopeGuard } }', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('nasce LIGADA e o patch desliga', async () => {
    core = createCore({ profileDir: tmpDir('bridge-scope-cfg-'), dbPath: ':memory:', port: 0, token: 'T' });
    expect(core.config().sessions.scopeGuard).toBe(true);
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { scopeGuard: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(core.config().sessions.scopeGuard).toBe(false);
  });
});

/**
 * O `cwd` do PAYLOAD (0.12.0). Até aqui o caminho relativo do agente resolvia
 * sempre contra o `cwd` com que a SESSÃO subiu. Isso passou a ser mentira com o
 * Claude Code aberto dentro de um shell (spec §5): a pessoa dá `cd` numa
 * subpasta e só então digita `claude`, e o processo do agente está noutro
 * lugar. Vale pras duas — sessão de agente e sessão hospedeira.
 */
describe('PreToolUse — o `cwd` do payload manda no caminho relativo', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('relativo resolve contra o `cwd` do payload: `../meu.ts` de uma subpasta está DENTRO', async () => {
    const c = cenario();
    core = c.core;
    const sub = join(c.a, 'sub');
    mkdirSync(sub, { recursive: true });
    // Contra o `cwd` da sessão (`a`) este mesmo caminho sairia da raiz e viraria
    // recusa — é exatamente a diferença que o payload conserta.
    const res = await preToolUse(c.core, c.session.id, {
      cwd: sub,
      tool_name: 'Read',
      tool_input: { file_path: join('..', 'meu.ts') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(c.core.deps.sessions.get(c.session.id)?.scopeBlocks).toBeUndefined();
  });

  it('e pega o `cd` pra worktree IRMÃ: relativo que sai da raiz é recusado', async () => {
    const c = cenario();
    core = c.core;
    // Contra o `cwd` da sessão, `alheio.ts` seria um arquivo do próprio
    // worktree (dentro da raiz). O payload diz que o agente está no irmão.
    const res = await preToolUse(c.core, c.session.id, {
      cwd: c.b,
      tool_name: 'Read',
      tool_input: { file_path: 'alheio.ts' },
    });
    const body = res.json() as DenyBody;
    expect(body.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput?.permissionDecisionReason).toContain(join(c.b, 'alheio.ts'));
  });

  it('`cwd` que não é caminho absoluto é ignorado — vale o da sessão', async () => {
    const c = cenario();
    core = c.core;
    const dentro = await preToolUse(c.core, c.session.id, {
      cwd: 'nao/eh/absoluto',
      tool_name: 'Read',
      tool_input: { file_path: 'meu.ts' },
    });
    expect(dentro.json()).toEqual({});

    const fora = await preToolUse(c.core, c.session.id, {
      cwd: 42,
      tool_name: 'Read',
      tool_input: { file_path: join('..', 'tarefa-b', 'alheio.ts') },
    });
    expect((fora.json() as DenyBody).hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('a sessão HOSPEDEIRA tem a mesma guarda, com o `cwd` do payload', async () => {
    const c = cenario();
    core = c.core;
    const shell = c.core.deps.sessions.create({
      paneId: c.session.paneId,
      workspaceId: c.session.workspaceId,
      kind: 'shell',
      cwd: c.a,
    });
    // O primeiro hook promove E já é julgado: a guarda vale desde o começo.
    const res = await preToolUse(c.core, shell.id, {
      session_id: 'conv_hosp_1',
      cwd: c.b,
      tool_name: 'Read',
      tool_input: { file_path: 'alheio.ts' },
    });
    expect((res.json() as DenyBody).hookSpecificOutput?.permissionDecision).toBe('deny');
    const s = c.core.deps.sessions.get(shell.id);
    expect(s?.hosted?.agent).toBe('claude');
    expect(s?.scopeBlocks?.count).toBe(1);
    // Recusa não marca ferramenta (a chamada não vai rodar) — nem na hospedeira.
    expect(s?.tool).toBeUndefined();
  });

  it('shell NÃO hospedada (hostedAgents desligado) continua sem guarda e sem estado', async () => {
    const c = cenario();
    core = c.core;
    c.core.updateConfig({ sessions: { hostedAgents: false } });
    const shell = c.core.deps.sessions.create({
      paneId: c.session.paneId,
      workspaceId: c.session.workspaceId,
      kind: 'shell',
      cwd: c.a,
    });
    const res = await preToolUse(c.core, shell.id, {
      cwd: c.b,
      tool_name: 'Read',
      tool_input: { file_path: 'alheio.ts' },
    });
    expect(res.json()).toEqual({});
    expect(c.core.deps.sessions.get(shell.id)?.scopeBlocks).toBeUndefined();
  });
});
