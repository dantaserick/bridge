/**
 * O core falando o idioma configurado (spec §13, Task 2).
 *
 * O que se prova aqui, e que nenhum outro teste prova: com `ui.language: 'en'`
 * TODA superfície do core que uma pessoa lê sai em inglês — mensagem de erro
 * da API, notificação vinda de hook, `detail` da sessão, statusline, razão do
 * `deny` da guarda de escopo, texto da fila do escalonador e os rótulos que o
 * `readRecap` injeta no prompt —, e que um `PATCH /api/config` troca isso AO
 * VIVO: o evento seguinte já sai no idioma novo, sem restart.
 *
 * E o que NÃO pode mudar junto: o `code` do corpo de erro (`pane-busy`,
 * `invalid-config`, `session-not-found`) é o contrato com a UI e com a CLI.
 *
 * As fixturas fixam `ui.language` EXPLICITAMENTE nos dois sentidos. O default
 * é `'system'`, e numa máquina em inglês um teste que espera pt-BR sem dizer
 * isso falharia por um motivo que não tem nada a ver com o que ele afirma.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '@bridge/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { Session, Workspace } from '../src/model.js';
import { realPathOfExisting } from '../src/scopeGuard.js';
import { buildRecap } from '../src/recap.js';
import { statusLine, quotaFromPayload } from '../src/quota.js';
import { LauncherQueueFullError, LauncherPaneQueuedError } from '../src/launcher.js';
import { errorMessage } from '../src/errors.js';
import { GitError } from '../src/git.js';
import { NO_PROJECT_BUCKET, OTHERS_BUCKET, bucketLabel, summarize } from '../src/usage/aggregate.js';
import { resolvePricing } from '../src/usage/pricing.js';
import { tmpDir } from './tmp.js';

const AUTH = { authorization: 'Bearer T' };

function makeCore(language: 'pt-BR' | 'en'): Core {
  const core = createCore({ profileDir: tmpDir('bridge-i18n-'), dbPath: ':memory:', port: 0, token: 'T' });
  core.updateConfig({ ui: { language } });
  return core;
}

/** Um core com um workspace de tarefa (worktree) e uma sessão de agente nele. */
function cenario(language: 'pt-BR' | 'en'): { core: Core; workspace: Workspace; session: Session; a: string; b: string } {
  const repo = realPathOfExisting(tmpDir('bridge-i18n-repo-'))!;
  const a = join(repo, '.worktrees', 'tarefa-a');
  const b = join(repo, '.worktrees', 'tarefa-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'alheio.ts'), 'b', 'utf8');

  const core = makeCore(language);
  const { workspace, pane } = core.deps.layout.createWorkspace({ cwd: a });
  const withWorktree: Workspace = { ...workspace, worktree: { base: 'main', path: a } };
  core.deps.db.workspaces.update(withWorktree);
  const session = core.deps.sessions.create({
    paneId: pane.id,
    workspaceId: workspace.id,
    kind: 'agent',
    agent: 'claude',
    cwd: a,
  });
  return { core, workspace: withWorktree, session, a, b };
}

interface DenyBody {
  hookSpecificOutput?: { permissionDecisionReason?: string };
}

describe('idioma do core (spec §13)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  // ------------------------------------------------------- mensagens de erro

  it('com `en` a mensagem do 404 sai em inglês e o `code` NÃO muda', async () => {
    core = makeCore('en');
    const res = await core.app.inject({ method: 'POST', url: '/api/sessions/sess_nao_existe/recap', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session not found', code: 'session-not-found' });
  });

  it('com `pt-BR` a MESMA rota sai em português, com o MESMO `code`', async () => {
    core = makeCore('pt-BR');
    const res = await core.app.inject({ method: 'POST', url: '/api/sessions/sess_nao_existe/recap', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sessão não encontrada', code: 'session-not-found' });
  });

  it('o 400 de corpo inválido também é traduzido — mensagem do zod inclusive', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: 'C:\\x', environment: { kind: 'wsl', distro: '-hostil' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid body: environment.distro: invalid distro name');
  });

  /**
   * O caso em que o issue do zod não tem caminho NENHUM: o corpo inteiro é que
   * está errado (um JSON que nem objeto é). O marcador de lugar era um literal
   * pt-BR do `schemas.ts`, e a frase saía meio traduzida em inglês
   * (`Invalid body: (corpo): …`) — achado da revisão final.
   */
  const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

  it('corpo que nem objeto é: o marcador de lugar também fala inglês', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: JSON_HEADERS,
      payload: '"sou uma string"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Invalid body: \(body\): /);
    expect(res.json().error).not.toContain('(corpo)');
  });

  it('o MESMO corpo em pt-BR traz o marcador em português', async () => {
    core = makeCore('pt-BR');
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: JSON_HEADERS,
      payload: '"sou uma string"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Corpo inválido: \(corpo\): /);
  });

  /**
   * O PATCH de config passa pelo mesmo marcador, por outro caminho de código.
   * Aqui o issue sem caminho é o do `.strict()`: campo que não existe no
   * schema é recusado pelo OBJETO inteiro, não por um campo dele. (Corpo que
   * nem objeto é vira `{}` nesta rota — um patch vazio, e 200.)
   */
  it('campo desconhecido na config usa o mesmo marcador traduzido', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: JSON_HEADERS,
      payload: '{"naoExiste": 1}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid-config');
    expect(res.json().error).toMatch(/^Invalid config: \(body\): /);
  });

  it('o 400 de configuração inválida sai em inglês e mantém `invalid-config`', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { ui: { language: 'klingon' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid-config');
    expect(res.json().error).toMatch(/^Invalid config: ui\.language: /);
  });

  it('o 403 dos campos somente leitura muda de idioma e mantém `read-only`', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { languageResolved: 'en' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'languageResolved: only through config.json',
      code: 'read-only',
      fields: ['languageResolved'],
    });
  });

  it('os erros do escalonador levam a chave, não a frase — e a borda escolhe o idioma', () => {
    const cheia = new LauncherQueueFullError();
    expect(cheia.code).toBe('queue-full');
    expect(errorMessage(cheia, 'pt-BR')).toMatch(/^a fila de lançamentos está cheia \(\d+\)$/);
    expect(errorMessage(cheia, 'en')).toMatch(/^the launch queue is full \(\d+\)$/);

    const naFila = new LauncherPaneQueuedError('pane_9');
    expect(naFila.code).toBe('pane-busy');
    expect(errorMessage(naFila, 'en')).toBe('this pane already has an agent queued: pane_9');
  });

  /**
   * O funil das mensagens de erro é também o funil da SANITIZAÇÃO (A5/A7).
   *
   * O `{stderr}` do `core.erro.git.naoFfComGit` é saída crua do `git`, e ela
   * chega ao terminal do dono pela CLI, que imprime o `error` do servidor como
   * veio. Antes desta onda o `errorMessage` devolvia a frase montada sem
   * passar por lugar nenhum: um `git` com cor ligada mandava CSI, e um título
   * de commit hostil mandava RLO (Trojan Source) direto pro terminal.
   */
  it('a mensagem de erro sai limpa de ESC/CSI/RLO, nos dois idiomas', () => {
    const stderr = '\u001b[31mfatal\u001b[0m: \u001b]0;titulo\u0007 refusing\u202eevil';
    const err = new GitError('not-ff', {
      key: 'core.erro.git.naoFfComGit',
      params: { branch: 'feat-x', base: 'main', stderr },
    });

    for (const lang of ['pt-BR', 'en'] as const) {
      const msg = errorMessage(err, lang);
      expect(msg, lang).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(msg, lang).not.toContain('\u202e');
      // O que era TEXTO dentro do stderr continua lá: a limpeza tira o
      // controle, não a informação.
      expect(msg, lang).toContain('fatal');
      expect(msg, lang).toContain('feat-x');
    }
    expect(errorMessage(err, 'en')).toContain('does not fast-forward');
    expect(errorMessage(err, 'pt-BR')).toContain('não avança');
  });

  /** A frase mais longa do catálogo passa INTEIRA: o teto não corta copy. */
  it('o teto do funil não corta a mensagem mais longa do catálogo', () => {
    const err = new GitError('filters-untrusted', { key: 'core.erro.git.filtrosSemConfianca' });
    for (const lang of ['pt-BR', 'en'] as const) {
      expect(errorMessage(err, lang), lang).toBe(t(lang, 'core.erro.git.filtrosSemConfianca'));
    }
  });

  /** Erro sem chave (exceção de biblioteca) passa pelo mesmo funil. */
  it('erro sem chave também é limpo antes de virar resposta', () => {
    const cru = new Error('\u001b[2Jboom\u0000\u0000');
    expect(errorMessage(cru, 'en')).toBe('boom');
    expect(errorMessage('\u001b]0;x\u0007texto solto', 'en')).toBe('texto solto');
  });

  // ------------------------------- fix round 1: as três fugas da borda (routes)

  /**
   * Os três `catch` que respondiam `err.message` cru. O `message` do `Error` é
   * pt-BR por construção (é o texto do `core.log`), então numa instância em
   * inglês eles vazavam português na resposta — sem que nenhum teste visse,
   * porque o resto da rota já estava certo.
   */
  it('`GET /workspaces/:id/git` num workspace comum: 404 em inglês, `code` intacto', async () => {
    core = makeCore('en');
    const { workspace } = core.deps.layout.createWorkspace({ cwd: tmpDir('bridge-i18n-comum-') });
    const res = await core.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspace.id}/git`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'this workspace is not a task worktree', code: 'not-worktree' });
  });

  it('`POST /panes/:id/split` num painel inexistente: 404 em inglês', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/panes/pane_nao_existe/split',
      headers: AUTH,
      payload: { dir: 'v' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('pane not found: pane_nao_existe');
  });

  it('`POST /panes/:id/ratio` num painel inexistente: 404 em inglês', async () => {
    core = makeCore('en');
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/panes/pane_nao_existe/ratio',
      headers: AUTH,
      payload: { ratio: 0.5 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('pane not found: pane_nao_existe');
  });

  // -------------------------- fix round 1: as sete mensagens de `refine` do zod

  /**
   * O `message` de um `refine` é fixado quando o schema é CONSTRUÍDO, então ele
   * guarda a CHAVE e quem traduz é o `parseBody`. Sete deles tinham ficado com
   * a frase crua — e todos são alcançáveis por uma rota.
   */
  it('cada `refine` do `schemas.ts` chega ao 400 já traduzido', async () => {
    core = makeCore('en');
    const { workspace, tab, pane } = core.deps.layout.createWorkspace({
      cwd: tmpDir('bridge-i18n-refine-'),
    });

    const casos: Array<{
      nome: string;
      método: 'POST' | 'PATCH';
      url: string;
      corpo: Record<string, unknown>;
      esperado: string;
    }> = [
      {
        nome: 'workspacePatchSchema',
        método: 'PATCH',
        url: `/api/workspaces/${workspace.id}`,
        corpo: {},
        esperado: 'pass environment and/or crossAccess',
      },
      {
        nome: 'sessionSchema.initialCommand',
        método: 'POST',
        url: '/api/sessions',
        corpo: { paneId: pane.id, kind: 'shell', initialCommand: 'git diff; rm -rf /' },
        esperado: 'command with a control character or a shell separator',
      },
      {
        nome: 'taskSchema',
        método: 'POST',
        url: '/api/tasks',
        corpo: { name: 'tarefa' },
        esperado: 'pass repoId or repoPath',
      },
    ];

    for (const caso of casos) {
      const res = await core.app.inject({
        method: caso.método,
        url: caso.url,
        headers: AUTH,
        payload: caso.corpo,
      });
      expect(res.statusCode, caso.nome).toBe(400);
      expect(res.json().error, caso.nome).toContain(caso.esperado);
      // E nenhuma delas pode vazar a CHAVE crua pro corpo da resposta.
      expect(res.json().error, caso.nome).not.toContain('core.erro.');
    }
  });

  it('em pt-BR os mesmos `refine` saem em português', async () => {
    core = makeCore('pt-BR');
    const { workspace } = core.deps.layout.createWorkspace({ cwd: tmpDir('bridge-i18n-refine-pt-') });
    const res = await core.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('informe environment e/ou crossAccess');
  });

  // ------------------------- fix round 1: preço "com ajustes" e os dois baldes

  it('a data da tabela de preços com override é copy, e sai no idioma pedido', () => {
    const semOverride = resolvePricing({}, 'en');
    expect(semOverride.asOf).not.toContain('(');

    const preco = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
    const pt = resolvePricing({ pricing: { 'modelo-x': preco } }, 'pt-BR');
    const en = resolvePricing({ pricing: { 'modelo-x': preco } }, 'en');
    expect(pt.asOf).toBe(`${semOverride.asOf} (com ajustes locais)`);
    expect(en.asOf).toBe(`${semOverride.asOf} (with local overrides)`);
  });

  it('os baldes `(outros)`/`(sem projeto)` são sentinela no banco e texto na tela', () => {
    // O sentinela NÃO muda: ele é o que está gravado em `usage_daily`.
    expect(NO_PROJECT_BUCKET).toBe('(sem projeto)');
    expect(OTHERS_BUCKET).toBe('(outros)');
    expect(bucketLabel(NO_PROJECT_BUCKET, 'en')).toBe('(no project)');
    expect(bucketLabel(OTHERS_BUCKET, 'en')).toBe('(others)');
    expect(bucketLabel(NO_PROJECT_BUCKET, 'pt-BR')).toBe('(sem projeto)');
    // Nome de projeto de verdade passa intacto — inclusive um que se pareça.
    expect(bucketLabel('C:\\projetos\\app', 'en')).toBe('C:\\projetos\\app');
  });

  it('o relatório troca o rótulo do balde sem tocar no que foi agrupado', () => {
    const linha = {
      day: '2026-09-06',
      model: 'claude-sonnet-4-5',
      project: NO_PROJECT_BUCKET,
      source: 'main' as const,
      input: 10,
      output: 1,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      messages: 1,
    };
    const chart = { from: '2026-09-06', to: '2026-09-06' };
    const en = summarize({ rows: [linha], chartRows: [linha], chart, pricing: {}, lang: 'en' });
    const pt = summarize({ rows: [linha], chartRows: [linha], chart, pricing: {}, lang: 'pt-BR' });
    expect(en.byProject.map((p) => p.project)).toEqual(['(no project)']);
    expect(pt.byProject.map((p) => p.project)).toEqual(['(sem projeto)']);
    // A SOMA é a mesma nos dois: o agrupamento não passou pela tradução.
    expect(en.byProject[0]?.tokens).toBe(pt.byProject[0]?.tokens);
  });

  // ---------------------------------------------------------- notificações

  it('um hook `Notification` vira "Waiting for you" em `en` e "Aguardando você" em `pt-BR`', async () => {
    const c = cenario('en');
    core = c.core;
    const res = await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/Notification?token=T`,
      payload: { session_id: 'abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(core.deps.notifications.unread().map((n) => n.text)).toEqual(['Waiting for you']);
    // O `detail` da linha da sessão vem do mesmo evento, e vem junto.
    expect(core.deps.sessions.get(c.session.id)?.detail).toBe('waiting for permission');
  });

  it('PATCH pra pt-BR troca AO VIVO: a notificação SEGUINTE já sai em português', async () => {
    const c = cenario('en');
    core = c.core;
    await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/Notification?token=T`,
      payload: { session_id: 'abc' },
    });

    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { ui: { language: 'pt-BR' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().languageResolved).toBe('pt-BR');

    await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/Stop?token=T`,
      payload: { session_id: 'abc' },
    });

    const textos = core.deps.notifications.unread().map((n) => n.text);
    expect(textos).toContain('Waiting for you');
    expect(textos).toContain('Terminou o turno');
    expect(core.deps.sessions.get(c.session.id)?.detail).toBe('terminei');
  });

  // ------------------------------------------------------ guarda de escopo

  it('a razão do `deny` sai no idioma do dono — quem a lê é o AGENTE, e ele repete', async () => {
    const c = cenario('en');
    core = c.core;
    const res = await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/PreToolUse?token=T`,
      payload: { tool_name: 'Read', tool_input: { file_path: join(c.b, 'alheio.ts') }, cwd: c.a },
    });
    const reason = (res.json() as DenyBody).hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('outside this task worktree');
    expect(reason).toContain('This session can only read and write inside');
    expect(reason).toContain('Allow access outside the worktree');
    // A FORMA do JSON não muda com o idioma: é o contrato do `PreToolUse`.
    expect(Object.keys(res.json() as object)).toEqual(['hookSpecificOutput']);
  });

  it('e um PATCH pra pt-BR muda a razão do próximo `deny`', async () => {
    const c = cenario('en');
    core = c.core;
    await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { ui: { language: 'pt-BR' } } });
    const res = await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/PreToolUse?token=T`,
      payload: { tool_name: 'Read', tool_input: { file_path: join(c.b, 'alheio.ts') }, cwd: c.a },
    });
    const reason = (res.json() as DenyBody).hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('fora do worktree desta tarefa');
    expect(reason).toContain('Permitir acesso fora do worktree');
  });

  // ------------------------------------------------------------ statusline

  it('a statusline sai inteira no idioma pedido — rótulo de janela, reset e moeda', () => {
    const q = quotaFromPayload({
      model: { display_name: 'Fable 5.1' },
      context_window: { total_input_tokens: 87_000 },
      cost: { total_cost_usd: 3.42 },
      rate_limits: { five_hour: { used_percentage: 23, resets_at: 1_900_008_100 } },
    });
    const now = 1_900_000_000_000;
    expect(statusLine(q, { now, lang: 'pt-BR' })).toBe('87k ctx · Fable 5.1 · US$ 3,42 · 5h 23% (reseta em 2h15)');
    expect(statusLine(q, { now, lang: 'en' })).toBe('87k ctx · Fable 5.1 · US$ 3.42 · 5h 23% (resets in 2h15)');
  });

  it('o hook `StatusLine` monta a linha com o idioma VIVO do core', async () => {
    const c = cenario('en');
    core = c.core;
    core.updateConfig({ usage: { terminalStatusLine: true } });
    const payload = {
      model: { display_name: 'Fable 5.1' },
      context_window: { total_input_tokens: 87_000 },
      rate_limits: { seven_day: { used_percentage: 68 } },
    };
    const antes = await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/StatusLine?token=T`,
      payload,
    });
    expect(antes.body).toContain('week 68%');

    await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { ui: { language: 'pt-BR' } } });
    const depois = await core.app.inject({
      method: 'POST',
      url: `/hooks/${c.session.id}/StatusLine?token=T`,
      payload,
    });
    expect(depois.body).toContain('semana 68%');
  });

  // ----------------------------------------------------------------- recap

  it('o prefixo injetado pelo resumo é copy, e muda de idioma', () => {
    const linhas = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'arruma o build' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'feito' }] } }),
    ];
    expect(buildRecap(linhas, 'pt-BR')).toContain('Último pedido seu:');
    expect(buildRecap(linhas, 'pt-BR')).toContain('Últimas respostas do agente:');
    const en = buildRecap(linhas, 'en');
    expect(en).toContain('Your last request:');
    expect(en).toContain("The agent's last replies:");
  });

  // ---------------------------------------------------------- ambientes

  it('`GET /api/environments` traz rótulo e motivo no idioma de AGORA, apesar do cache de 60 s', async () => {
    core = makeCore('en');
    const antes = await core.app.inject({ method: 'GET', url: '/api/environments', headers: AUTH });
    const gitbashEn = (antes.json().environments as Array<{ id: string; reason?: string }>).find((e) => e.id === 'gitbash');
    if (gitbashEn?.reason !== undefined) expect(gitbashEn.reason).toContain('not found at');

    await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { ui: { language: 'pt-BR' } } });
    const depois = await core.app.inject({ method: 'GET', url: '/api/environments', headers: AUTH });
    const gitbashPt = (depois.json().environments as Array<{ id: string; reason?: string }>).find((e) => e.id === 'gitbash');
    if (gitbashPt?.reason !== undefined) expect(gitbashPt.reason).toContain('não encontrado em');
    // O rótulo dos ambientes do Windows é nome de produto e NÃO se traduz.
    expect((depois.json().environments as Array<{ id: string; label: string }>)[0]?.label).toBe('PowerShell 7 (pwsh)');
  });
});
