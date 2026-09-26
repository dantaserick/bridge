/**
 * `bridge` fim-a-fim: sobe um core real (Fase 1-3, em memória) e roda o
 * binário BUILDADO (`bin/bridge.cjs`, gerado pelo `pretest` do
 * `package.json` — `npm run build && vitest run`) como processo filho, do
 * jeito que um usuário rodaria. Nenhuma chamada HTTP direta daqui: quem fala
 * com o core é sempre o binário, exatamente como em produção.
 */
import { execFileSync, spawn } from 'node:child_process';
import { NOTIFY_TEXT_MAX, truncateNotifyText } from '../src/commands.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore } from '../../core/src/core.js';
import type { Core } from '../../core/src/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'bridge.cjs');
/** O `.cmd` é o que o Windows resolve como `bridge` — `where bridge` acha ELE. */
const cmdPath = join(here, '..', 'bin', 'bridge.cmd');

/** Pausa síncrona curta (git local é rápido; usada só pro retry do `git`). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Mesmo cuidado do `api-tasks.test.ts` do core: antivírus/indexador do Windows às vezes segura o `.git` recém-criado. */
function git(cwd: string, args: string[]): string {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
    } catch (err) {
      last = err;
      sleepSync(150);
    }
  }
  throw last;
}

/** Todo diretório temporário nasce aqui — `afterAll` limpa a lista inteira (fix round 1, best effort). */
const trees: string[] = [];

function tmpTree(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

/** Repo git temporário com um commit inicial — mesma receita do core (pasta com espaço, fora do repo do Bridge). */
function makeRepo(): string {
  const root = join(tmpTree('bridge cli tasks '), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge CLI Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'leiame.md'), 'ola\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

function waitFor(check: () => boolean, timeoutMs = 15000, intervalMs = 50): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return res();
      if (Date.now() - start > timeoutMs) return rej(new Error('timeout esperando condição'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * `spawnSync` NÃO SERVE aqui: ele bloqueia o event loop do processo que o
 * chama até o filho sair — e o core (Fastify) roda `in-process`, no MESMO
 * worker do vitest que chamaria `spawnSync`. `bridge notify` (o filho) fica
 * esperando a resposta HTTP do core; o core fica preso porque o loop que
 * processaria a request está congelado esperando o filho — dois lados
 * travados um no outro pra sempre. `spawn` assíncrono mantém o loop vivo.
 */
function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge ${args.join(' ')} não terminou em ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Ambiente pro `.cmd`: PATH controlado (só o System32, pra `where.exe`
 * existir) e sem duplicar a chave `Path`/`PATH` — no Windows as duas seriam a
 * mesma variável, e passar as duas pro filho é comportamento indefinido.
 */
function envWithPath(base: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.Path = path;
  return env;
}

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/** Roda o `bridge.cmd` pelo cmd.exe, como um terminal do usuário faria. */
function runCmd(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    // Args separados (nada de montar a linha na mão): o `cmd /c` com a linha
    // inteira entre aspas ainda passa pelo escape do `spawn` e vira lixo.
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmdPath, ...args], {
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge.cmd ${args.join(' ')} não terminou em ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

let core: Core;
let profileDir: string;
let port: number;
let token: string;
let baseEnv: NodeJS.ProcessEnv;
let workspaceId: string;
let workspaceName: string;
let tabId: string;
let paneId: string;
let sessionId: string;

beforeAll(async () => {
  profileDir = tmpTree('bridge-cli-profile-');
  core = createCore({ profileDir, dbPath: ':memory:', port: 0 });
  // Idioma FIXO (spec §13): estes testes afirmam TEXTO, e o default do
  // produto é `'system'`. Sem fixar os dois lados — o do core, que a CLI
  // pergunta, e o `BRIDGE_LANG`, que vale com o core fechado — a suíte
  // falharia numa máquina em inglês por um motivo que não é o dela.
  core.updateConfig({ ui: { language: 'pt-BR' } });
  const started = await core.start();
  port = started.port;
  token = started.token;

  baseEnv = { ...process.env, BRIDGE_PROFILE_DIR: profileDir, BRIDGE_LANG: 'pt-BR' };
  delete baseEnv.BRIDGE_PORT;
  delete baseEnv.BRIDGE_TOKEN;
  delete baseEnv.BRIDGE_SESSION;

  const wsDir = tmpTree('bridge-cli-ws-');
  const created = await core.createWorkspace({ cwd: wsDir });
  workspaceId = created.workspace.id;
  workspaceName = created.workspace.name;
  tabId = created.tab.id;
  paneId = created.pane.id;

  const session = await core.createSession({ paneId, kind: 'shell' });
  sessionId = session.id;
});

afterAll(async () => {
  await core.stop();
  // Fix round 1 (minor): best effort — um handle preso (AV/indexador do
  // Windows) não pode derrubar a suíte inteira, então cada remoção é
  // isolada e o erro, engolido.
  for (const dir of trees) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('bridge (CLI)', () => {
  it('sem core: sai 1 com a mensagem pt-BR', async () => {
    const emptyProfile = tmpTree('bridge-cli-sem-core-');
    const env = { ...baseEnv, BRIDGE_PROFILE_DIR: emptyProfile };
    const res = await runCli(['status'], env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Bridge não está aberto (instance.json não encontrado ou core morto)');
  });

  it('resolveInstance via BRIDGE_PORT/BRIDGE_TOKEN do ambiente, sem instance.json (fix round 1)', async () => {
    // `APPDATA` aponta pra uma pasta vazia de propósito: prova que o caminho
    // do ambiente é usado ANTES (e sem precisar) de qualquer instance.json —
    // se a implementação regredisse pro fallback de arquivo, este teste
    // pegaria (a pasta não tem `bridge\instance.json` nenhum).
    const emptyAppData = tmpTree('bridge-cli-appdata-');
    const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: token, APPDATA: emptyAppData };
    delete env.BRIDGE_PROFILE_DIR;
    delete env.BRIDGE_SESSION;

    const res = await runCli(['status', '--json'], env);
    expect(res.status).toBe(0);
    const status = JSON.parse(res.stdout) as { alive: boolean; port: number };
    expect(status.alive).toBe(true);
    expect(status.port).toBe(port);
  });

  it('notify: cria notificação custom na sessão atual (BRIDGE_SESSION)', async () => {
    const env = { ...baseEnv, BRIDGE_SESSION: sessionId };
    const res = await runCli(['notify', 'notificacao cli', '--json'], env);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toMatchObject({ ok: true, sessionId, text: 'notificacao cli' });

    const list = core.deps.db.notifications.list(50);
    expect(list.some((n) => n.sessionId === sessionId && n.kind === 'custom' && n.text === 'notificacao cli')).toBe(
      true,
    );
  });

  it('notify sem sessão: exit 1 pedindo --session ou painel do Bridge', async () => {
    const res = await runCli(['notify', 'oi'], baseEnv);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('sem sessão: use --session ou rode de dentro de um painel do Bridge');
  });

  it('notify -- "--texto": o terminador libera texto que começa com -- (fix round 1)', async () => {
    const env = { ...baseEnv, BRIDGE_SESSION: sessionId };
    const res = await runCli(['notify', '--', '--urgente: build quebrou'], env);
    expect(res.status).toBe(0);
    const list = core.deps.db.notifications.list(50);
    expect(list.some((n) => n.sessionId === sessionId && n.text === '--urgente: build quebrou')).toBe(true);
  });

  it('notify: sem aspas, sem terminador, "--texto" solto vira flag desconhecida (fix round 1)', async () => {
    const env = { ...baseEnv, BRIDGE_SESSION: sessionId };
    const res = await runCli(['notify', '--nao-e-uma-flag'], env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('flag desconhecida: --nao-e-uma-flag');
  });

  it('list --json: lista a sessão criada', async () => {
    const res = await runCli(['list', '--json'], baseEnv);
    expect(res.status).toBe(0);
    const sessions = JSON.parse(res.stdout) as Array<{ id: string; state: string }>;
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
  });

  it('list (humano): tabela com o id da sessão', async () => {
    const res = await runCli(['list'], baseEnv);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(sessionId);
  });

  it('flag desconhecida: exit 1 (fix round 1, minor)', async () => {
    const res = await runCli(['list', '--bogus', '--json'], baseEnv);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('flag desconhecida: --bogus');
  });

  it('focus <sessionId>: marca as notificações da sessão como lidas e emite session.reveal pra UI', async () => {
    const notif = core.deps.notifications.push(sessionId, 'custom', 'foco pendente');
    expect(notif).toBeDefined();
    expect(core.deps.notifications.unread().some((n) => n.id === notif!.id)).toBe(true);
    const reveals: string[] = [];
    const off = core.deps.bus.on((e) => {
      if (e.type === 'session.reveal') reveals.push(e.id);
    });

    const res = await runCli(['focus', sessionId, '--json'], baseEnv);
    off();
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, sessionId });
    expect(core.deps.notifications.unread().some((n) => n.id === notif!.id)).toBe(false);
    // É o evento que leva a janela principal até a sessão (workspace, aba,
    // painel) — sem ele o comando só marcava o foco no core.
    expect(reveals).toEqual([sessionId]);
  });

  it('focus <workspaceName>: resolve pra uma sessão do workspace', async () => {
    const notif = core.deps.notifications.push(sessionId, 'custom', 'foco por workspace');
    expect(core.deps.notifications.unread().some((n) => n.id === notif!.id)).toBe(true);

    const res = await runCli(['focus', workspaceName, '--json'], baseEnv);
    expect(res.status).toBe(0);
    expect(core.deps.notifications.unread().some((n) => n.id === notif!.id)).toBe(false);
  });

  it('nome de workspace ambíguo: exit 1 com os dois ids (fix round 1)', async () => {
    // Dois workspaces com o MESMO nome, criados só pra este teste — nasce
    // depois do teste de `focus <workspaceName>` acima de propósito, senão
    // `workspaceName` deixaria de resolver pra uma sessão só.
    const dupDir = tmpTree('bridge-cli-dup-');
    const dup = await core.createWorkspace({ cwd: dupDir, name: workspaceName });

    const res = await runCli(['task', 'rm', workspaceName, '--json'], baseEnv);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`nome ambíguo: 2 workspaces chamados '${workspaceName}' — use o id:`);
    expect(res.stderr).toContain(workspaceId);
    expect(res.stderr).toContain(dup.workspace.id);

    // Não é worktree nenhum dos dois — nada foi de fato removido, mas
    // confirma que a resolução do nome falhou ANTES de tocar a rota.
    expect(core.deps.db.workspaces.get(workspaceId)).toBeDefined();
    expect(core.deps.db.workspaces.get(dup.workspace.id)).toBeDefined();
  });

  it('new --workspace: cria sessão shell num split do workspace', async () => {
    const before = core.deps.db.panes.listByTab(tabId).length;
    const res = await runCli(['new', '--workspace', workspaceId, '--json'], baseEnv);
    expect(res.status).toBe(0);
    const session = JSON.parse(res.stdout) as { id: string; kind: string; paneId: string };
    expect(session.kind).toBe('shell');
    expect(session.paneId).not.toBe(paneId);

    const after = core.deps.db.panes.listByTab(tabId).length;
    expect(after).toBe(before + 1);
    expect(core.deps.sessions.get(session.id)?.kind).toBe('shell');
  });

  it('--workspace=<id> (fix round 1): --flag=valor funciona igual --flag valor', async () => {
    const res = await runCli(['new', `--workspace=${workspaceId}`, '--json'], baseEnv);
    expect(res.status).toBe(0);
    const session = JSON.parse(res.stdout) as { kind: string };
    expect(session.kind).toBe('shell');
  });

  it('--split inválido: exit 1 (fix round 1, minor)', async () => {
    const res = await runCli(['new', '--workspace', workspaceId, '--split', 'diagonal', '--json'], baseEnv);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--split');
  });

  it('send: escreve no stdin e aparece no scrollback', async () => {
    const res = await runCli(['send', sessionId, 'echo bridge-cli-marca'], baseEnv);
    expect(res.status).toBe(0);
    await waitFor(() => core.deps.pty.scrollback(sessionId).includes('bridge-cli-marca'));
  });

  it('send: positionals extras (texto sem aspas) são unidos com espaço (fix round 1)', async () => {
    const res = await runCli(['send', sessionId, 'echo', 'varias', 'palavras'], baseEnv);
    expect(res.status).toBe(0);
    await waitFor(() => core.deps.pty.scrollback(sessionId).includes('varias palavras'));
  });

  it('status --json: core vivo, porta e sessões', async () => {
    const res = await runCli(['status', '--json'], baseEnv);
    expect(res.status).toBe(0);
    const status = JSON.parse(res.stdout) as { alive: boolean; port: number; sessions: number };
    expect(status.alive).toBe(true);
    expect(status.port).toBe(port);
    expect(status.sessions).toBeGreaterThan(0);
  });

  it('task new / merge / rm: worktree fim-a-fim, sem agente', async () => {
    const repoPath = makeRepo();

    const created = await runCli(['task', 'new', repoPath, 'minha-tarefa', '--no-agent', '--json'], baseEnv);
    expect(created.status).toBe(0);
    const task = JSON.parse(created.stdout) as { workspace: { id: string; name: string; worktree?: { path: string } } };
    expect(task.workspace.worktree?.path).toBeTruthy();
    expect(core.deps.db.workspaces.get(task.workspace.id)?.worktree).toBeDefined();

    const merged = await runCli(['task', 'merge', task.workspace.id, '--json'], baseEnv);
    expect(merged.status).toBe(0);
    expect(JSON.parse(merged.stdout)).toMatchObject({ mode: 'ff-only' });

    const removed = await runCli(['task', 'rm', task.workspace.id, '--json'], baseEnv);
    expect(removed.status).toBe(0);
    expect(core.deps.db.workspaces.get(task.workspace.id)).toBeUndefined();
  });

  it('--base=main (fix round 1): --flag=valor em task new', async () => {
    const repoPath = makeRepo();
    const res = await runCli(
      ['task', 'new', repoPath, 'outra-tarefa', '--base=main', '--no-agent', '--json'],
      baseEnv,
    );
    expect(res.status).toBe(0);
    const task = JSON.parse(res.stdout) as { workspace: { id: string; worktree?: { path: string; base?: string } } };
    expect(task.workspace.worktree?.path).toBeTruthy();

    // limpa pra não deixar worktree pendurado além do que o `afterAll` já cobre.
    await runCli(['task', 'rm', task.workspace.id, '--json'], baseEnv);
  });

  /**
   * `bridge resume [paneId]` (Fase 5): retoma a conversa do agente que rodava
   * num painel. O adaptador `claude` é trocado por um falso — o Claude de
   * verdade não sobe em teste, mas o caminho (rota → `createSession` →
   * `launch` com `--resume`) é o mesmo de produção.
   */
  describe('resume', () => {
    const fakeAgentPath = join(here, '..', '..', 'core', 'test', 'fake-agent.cjs');

    /** Workspace novo (painel livre) já marcado como "aqui rodava o Claude <conversa>". */
    async function paneComConversa(conversa: string): Promise<string> {
      const created = await core.createWorkspace({ cwd: tmpTree('bridge-cli-resume-') });
      core.deps.layout.setPaneLast(created.pane.id, 'agent', 'claude', conversa);
      return created.pane.id;
    }

    beforeAll(() => {
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
    });

    it('resume <paneId> --json: sobe o agente com a conversa guardada', async () => {
      const pane = await paneComConversa('11111111-2222-3333-4444-555555555555');
      const res = await runCli(['resume', pane, '--json'], baseEnv);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      const session = JSON.parse(res.stdout) as { id: string; kind: string; paneId: string; resumedFrom: string };
      expect(session.kind).toBe('agent');
      expect(session.paneId).toBe(pane);
      expect(session.resumedFrom).toBe('11111111-2222-3333-4444-555555555555');
      expect(core.deps.sessions.get(session.id)?.kind).toBe('agent');
    }, 30000);

    it('resume <paneId> (humano): "Retomando a conversa <id8> no painel <paneId>"', async () => {
      const pane = await paneComConversa('abcdef12-2222-3333-4444-555555555555');
      const res = await runCli(['resume', pane], baseEnv);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(`Retomando a conversa abcdef12 no painel ${pane}`);
    }, 30000);

    it('painel sem conversa: exit 1 com "Este painel não tem conversa pra retomar"', async () => {
      const created = await core.createWorkspace({ cwd: tmpTree('bridge-cli-resume-vazio-') });
      const res = await runCli(['resume', created.pane.id], baseEnv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Este painel não tem conversa pra retomar');
    });

    it('sem paneId, de dentro do painel: o shell dá lugar ao agente retomado', async () => {
      // O caso normal do comando (fix round 1): o painel voltou como SHELL
      // vivo e é de dentro dele que se digita `bridge resume`. Aqui a CLI roda
      // fora do PTY (é filho do vitest), então dá pra ver a frase que o
      // usuário, no painel de verdade, perde junto com o shell.
      const created = await core.createWorkspace({ cwd: tmpTree('bridge-cli-resume-shell-') });
      const shell = await core.createSession({ paneId: created.pane.id, kind: 'shell' });
      core.deps.layout.setPaneLast(created.pane.id, 'agent', 'claude', 'fedcba98-2222-3333-4444-555555555555');

      const env = { ...baseEnv, BRIDGE_SESSION: shell.id };
      const res = await runCli(['resume'], env);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(`Retomando a conversa fedcba98 no painel ${created.pane.id}`);
      expect(core.deps.sessions.get(shell.id)).toBeUndefined();
      expect(core.deps.sessions.byPane(created.pane.id)?.kind).toBe('agent');
    }, 30000);

    it('painel com agente vivo: exit 1 com a dica de passar outro painel', async () => {
      const created = await core.createWorkspace({ cwd: tmpTree('bridge-cli-resume-agente-') });
      await core.createSession({ paneId: created.pane.id, kind: 'agent', agent: 'claude', resume: 'conversa-viva' });

      const res = await runCli(['resume', created.pane.id], baseEnv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('este painel já está com um agente');
      expect(res.stderr).toContain('bridge resume <paneId>');
    }, 30000);

    it('painel inexistente: exit 1 com a mensagem do core', async () => {
      const res = await runCli(['resume', 'pane_nao_existe'], baseEnv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('painel não encontrado: pane_nao_existe');
    });
  });
  /**
   * Minor 12 da onda final: ajuda e versão são o primeiro contato de quem
   * instalou o app — e não podem depender do core estar de pé (`bridge` num
   * terminal com o Bridge fechado imprimia "Bridge não está aberto" pra
   * `--help`, que é a hora em que a pessoa mais precisa da lista de comandos).
   */
  describe('ajuda e versão', () => {
    const noCoreEnv = (): NodeJS.ProcessEnv => ({ ...baseEnv, BRIDGE_PROFILE_DIR: tmpTree('bridge-cli-help-') });

    it('bridge --help sai 0 com a lista de comandos no stdout, SEM core', async () => {
      const res = await runCli(['--help'], noCoreEnv());
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('bridge notify');
      expect(res.stdout).toContain('--json');
    });

    it('bridge sem argumento nenhum mostra a ajuda no stdout e sai 0', async () => {
      const res = await runCli([], noCoreEnv());
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('bridge notify');
      expect(res.stderr).toBe('');
    });

    it('bridge --version imprime a versão e sai 0, SEM core', async () => {
      const res = await runCli(['--version'], noCoreEnv());
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('comando desconhecido continua sendo erro (1, no stderr)', async () => {
      // Com o core de pé: o desconhecido tem que morrer no dispatch, e não
      // antes — nem virar ajuda.
      const res = await runCli(['inventado'], baseEnv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('comando desconhecido');
    });
  });

  /**
   * Minor 11: o `bridge.cmd` é o que o Windows resolve como `bridge` (o
   * instalador põe a pasta dele no PATH). Sem Node no PATH ele dizia
   * `'node' não é reconhecido` — mensagem do cmd.exe, não do Bridge.
   */
  describe('bridge.cmd (o que o Windows resolve como `bridge`)', () => {
    it('sem node no PATH: mensagem pt-BR do Bridge e código 1', async () => {
      const env = envWithPath(baseEnv, SYSTEM32);
      delete env.BRIDGE_NODE;
      const res = await runCmd(['status'], env);
      expect(res.status).toBe(1);
      expect(`${res.stderr}${res.stdout}`).toContain('Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=<caminho>)');
    });

    it('BRIDGE_NODE aponta o executável quando o PATH não tem node', async () => {
      const env = envWithPath(baseEnv, SYSTEM32);
      env.BRIDGE_NODE = process.execPath;
      const res = await runCmd(['status', '--json'], env);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect((JSON.parse(res.stdout) as { alive: boolean }).alive).toBe(true);
    });

    it('com node no PATH funciona sem BRIDGE_NODE nenhum', async () => {
      const env = envWithPath(baseEnv, `${dirname(process.execPath)};${SYSTEM32}`);
      delete env.BRIDGE_NODE;
      const res = await runCmd(['status', '--json'], env);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect((JSON.parse(res.stdout) as { alive: boolean }).alive).toBe(true);
    });
  });

  /**
   * `bridge watch` (BACKLOG, "Ideias"): o filtro `?events=` do `/ws` existia
   * só pro processo main do Electron. Aqui ele vira comando — e é a única
   * forma de olhar o barramento do core sem abrir a janela.
   *
   * O processo não termina sozinho: cada teste coleta a saída até a condição e
   * mata o filho. Nada de `SIGINT` (no Windows ele não chega ao processo);
   * `kill()` basta, e o que se afirma é a SAÍDA, não o código de retorno.
   */
  describe('watch', () => {
    /** Sobe `bridge watch`, espera `until` na saída acumulada e mata o filho. */
    function watchUntil(args: string[], until: (out: string) => boolean, timeoutMs = 15000): Promise<CliRun> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binPath, 'watch', ...args], { env: baseEnv });
        let stdout = '';
        let stderr = '';
        const finish = (): void => {
          clearTimeout(timer);
          child.kill();
          resolve({ status: 0, stdout, stderr });
        };
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`bridge watch não produziu o esperado em ${timeoutMs}ms (stdout: ${stdout} / stderr: ${stderr})`));
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (until(stdout)) finish();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    }

    it('--json imprime o hello e os eventos que passam pelo filtro, um por linha', async () => {
      const run = watchUntil(['--events', 'notification', '--json'], (out) => out.includes('notification.new'));
      // Dá tempo do socket abrir antes de o core emitir o evento.
      await new Promise((r) => setTimeout(r, 800));
      core.deps.notifications.push(sessionId, 'done', 'evento pro watch');
      const res = await run;

      const linhas = res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l) as { type: string });
      // O `hello` ignora o filtro de propósito (é o snapshot que abre a conexão).
      expect(linhas[0]?.type).toBe('hello');
      expect(linhas.some((l) => l.type === 'notification.new')).toBe(true);
      // O filtro é do SERVIDOR: nada de `pty.*` chega aqui.
      expect(linhas.some((l) => l.type.startsWith('pty.'))).toBe(false);
      // A saudação vai pro STDERR, senão `bridge watch --json | jq` engasgaria.
      expect(res.stderr).toContain('eventos: notification');
      expect(res.stderr).not.toContain(token);
    }, 30000);

    it('sem --json sai uma linha por evento com hora, type e o id que ele carrega', async () => {
      const run = watchUntil(['--events', 'notification'], (out) => out.includes('notification.new'));
      await new Promise((r) => setTimeout(r, 800));
      core.deps.notifications.push(sessionId, 'stuck', 'linha humana');
      const res = await run;

      const linha = res.stdout.split(/\r?\n/).find((l) => l.includes('notification.new'));
      expect(linha).toMatch(/^\d{2}:\d{2}:\d{2} {2}notification\.new/);
    }, 30000);

    it('flag desconhecida é erro, como no resto da CLI', async () => {
      const res = await runCli(['watch', '--evets', 'notification'], baseEnv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('flag desconhecida: --evets');
    });
  });
});

/**
 * BR-12/BR-03 (fix round 3): o corte do texto de notificação é do CLIENTE — o
 * core mantém o 400 na API crua, mas quem digitou `bridge notify "$(cat log)"`
 * merece a notificação truncada, não um erro.
 */
describe('truncateNotifyText', () => {
  it('texto dentro do teto passa intacto', () => {
    expect(truncateNotifyText('oi')).toBe('oi');
    expect(truncateNotifyText('x'.repeat(NOTIFY_TEXT_MAX))).toHaveLength(NOTIFY_TEXT_MAX);
  });

  it('acima do teto corta e marca com reticências', () => {
    const cortado = truncateNotifyText('x'.repeat(NOTIFY_TEXT_MAX + 500));
    expect(cortado).toHaveLength(NOTIFY_TEXT_MAX);
    expect(cortado.endsWith('…')).toBe(true);
  });

  /**
   * O corte é por UNIDADE DE CÓDIGO: caindo no meio de um par substituto
   * (emoji, ideograma fora do BMP), o high surrogate solto vira U+FFFD na
   * tela. Ele tem que sair junto.
   */
  it('não deixa metade de um par substituto na ponta', () => {
    // 🙂 = 2 unidades. Com o teto ímpar em relação ao texto, o corte cai no meio.
    const texto = `${'a'.repeat(NOTIFY_TEXT_MAX - 2)}🙂🙂`;
    const cortado = truncateNotifyText(texto);

    const semReticencias = cortado.slice(0, -1);
    // Nenhuma unidade solta: a string inteira sobrevive a um round-trip.
    expect([...semReticencias].every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
    const ultima = semReticencias.charCodeAt(semReticencias.length - 1);
    expect(ultima >= 0xd800 && ultima <= 0xdbff).toBe(false);
  });

  it('par substituto INTEIRO na ponta é preservado', () => {
    const texto = `${'a'.repeat(NOTIFY_TEXT_MAX - 3)}🙂🙂`;
    const cortado = truncateNotifyText(texto);
    expect(cortado.endsWith('🙂…')).toBe(true);
  });
});
