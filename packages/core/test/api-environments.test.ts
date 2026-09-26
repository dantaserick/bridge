import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { openDb } from '../src/db.js';
import { WSL_INTEROP_MARKER, WSL_OK_MARKER, WSL_PROBE_SCRIPT } from '../src/environments.js';
import type { Runner } from '../src/environments.js';
import { tmpDir } from './tmp.js';

/**
 * Dor verificada #2 pela API: a rota de detecção, o ambiente gravado na criação
 * do workspace, o `PATCH` do menu e a migração da coluna nova.
 */
const AUTH = { authorization: 'Bearer T' };

let core: Core | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
});

function startCore(environmentRunner?: Runner): Core {
  core = createCore({
    profileDir: tmpDir('bridge-env-profile-'),
    dbPath: ':memory:',
    port: 0,
    token: 'T',
    environmentRunner,
  });
  return core;
}

/**
 * `wsl.exe` de mentira pro core: uma distro que SOBE mas não tem `claude`.
 *
 * Esta máquina não tem distro nenhuma (`wsl -l -q` vazio), então sem esta
 * injeção o caminho "distro viva sem claude" seria inalcançável — e é
 * justamente ele que o portão do agente existe pra recusar.
 */
function fakeWslWithoutClaude(distro: string): Runner {
  return async (_bin, args) => {
    if (args[0] === '-l' && args[1] === '-q') {
      // Como o `wsl.exe` de verdade escreve: UTF-16LE com BOM e `\r\n`.
      return { code: 0, stdout: Buffer.from(`﻿${distro}\r\n`, 'utf16le') };
    }
    const rest = args.slice(args.indexOf('--') + 1);
    if (rest[0] === 'sh' && rest[2] === WSL_PROBE_SCRIPT) {
      // Sem `claude`; a sentinela e o interop saem.
      const out = `/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n`;
      return { code: 0, stdout: Buffer.from(out, 'utf8') };
    }
    return { code: 1, stdout: Buffer.alloc(0) };
  };
}

/** `git` do teste, com o mesmo retry dos outros arquivos (lock do Windows). */
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  throw last;
}

/** Repo git temporário com um commit — pasta com espaço, como no resto da suíte. */
function makeRepo(): string {
  const root = join(tmpDir('bridge env repo '), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Env Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'leiame.md'), 'ola\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

describe('GET /api/environments', () => {
  it('lista os ambientes do Windows (esta máquina não tem distro WSL nenhuma)', async () => {
    const res = await startCore().app.inject({ method: 'GET', url: '/api/environments', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { environments: Array<{ id: string; kind: string; label: string }> };
    expect(body.environments.map((e) => e.id).slice(0, 3)).toEqual(['pwsh', 'powershell', 'gitbash']);
    expect(body.environments[0]!.label).toContain('PowerShell');
  });

  /**
   * Regressão do fix round 2: a entrada de WSL chegava na API sem `label`, e o
   * `<select>` do diálogo de novo workspace desenhava uma opção em branco. O
   * teste acima só olhava o `pwsh`, que nunca perdeu o rótulo.
   */
  it('a distro detectada chega com `id` e `label` exatos', async () => {
    const app = startCore(fakeWslWithoutClaude('Ubuntu')).app;
    const res = await app.inject({ method: 'GET', url: '/api/environments', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { environments: Array<{ id: string; kind: string; label: string }> };
    const wsl = body.environments.find((e) => e.kind === 'wsl')!;
    expect(wsl.id).toBe('wsl:Ubuntu');
    expect(wsl.label).toBe('WSL · Ubuntu');
    for (const env of body.environments) expect(env.label, env.id).toBeTruthy();
  });

  it('exige bearer', async () => {
    const res = await startCore().app.inject({ method: 'GET', url: '/api/environments' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/workspaces { environment }', () => {
  it('grava o ambiente e ele volta no GET /api/state', async () => {
    const app = startCore().app;
    const cwd = tmpDir('bridge env ws ');
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd, environment: { kind: 'wsl', distro: 'Ubuntu' } },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = (created.json() as { workspace: { id: string; environment: unknown } }).workspace.id;
    expect((created.json() as { workspace: { environment: unknown } }).workspace.environment).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
    });

    const state = await app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    const workspaces = (state.json() as { layout: { workspaces: Array<{ id: string; environment?: unknown }> } }).layout
      .workspaces;
    expect(workspaces.find((w) => w.id === workspaceId)!.environment).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('sem `environment` o workspace nasce sem ambiente — o comportamento de sempre', async () => {
    const app = startCore().app;
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: tmpDir('bridge env ws ') },
    });
    expect((created.json() as { workspace: { environment?: unknown } }).workspace.environment).toBeUndefined();
  });

  it('`wsl` sem distro, distro em ambiente que não é wsl e distro com `-` na frente são 400', async () => {
    const app = startCore().app;
    const cwd = tmpDir('bridge env ws ');
    const bodies = [
      { kind: 'wsl' },
      { kind: 'pwsh', distro: 'Ubuntu' },
      { kind: 'wsl', distro: '--dangerously-skip-permissions' },
      { kind: 'bash' },
    ];
    for (const environment of bodies) {
      const res = await app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd, environment } });
      expect(res.statusCode, JSON.stringify(environment)).toBe(400);
    }
  });
});

describe('PATCH /api/workspaces/:id', () => {
  async function makeWorkspace(): Promise<{ app: Core['app']; id: string }> {
    const app = startCore().app;
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: tmpDir('bridge env ws ') },
    });
    return { app, id: (created.json() as { workspace: { id: string } }).workspace.id };
  }

  it('troca o ambiente e devolve o workspace atualizado', async () => {
    const { app, id } = await makeWorkspace();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${id}`,
      headers: AUTH,
      payload: { environment: { kind: 'gitbash' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { environment: unknown }).environment).toEqual({ kind: 'gitbash' });
  });

  it('`environment: null` volta pro padrão do Bridge', async () => {
    const { app, id } = await makeWorkspace();
    await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${id}`,
      headers: AUTH,
      payload: { environment: { kind: 'wsl', distro: 'Ubuntu' } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${id}`,
      headers: AUTH,
      payload: { environment: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { environment?: unknown }).environment).toBeUndefined();
  });

  it('workspace inexistente → 404; corpo vazio ou campo desconhecido → 400', async () => {
    const { app, id } = await makeWorkspace();
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/workspaces/ws_nao_existe',
      headers: AUTH,
      payload: { environment: null },
    });
    expect(missing.statusCode).toBe(404);

    expect((await app.inject({ method: 'PATCH', url: `/api/workspaces/${id}`, headers: AUTH, payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/workspaces/${id}`, headers: AUTH, payload: { env: 'wsl' } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('portão do agente por AMBIENTE (fix round 1)', () => {
  async function workspaceWith(environment: unknown, runner?: Runner): Promise<{ app: Core['app']; paneId: string }> {
    const app = startCore(runner).app;
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: tmpDir('bridge env ws '), environment },
    });
    return { app, paneId: (created.json() as { pane: { id: string } }).pane.id };
  }

  it('distro que não responde: sessão de agente é 422 NOMEANDO o ambiente', async () => {
    const { app, paneId } = await workspaceWith({ kind: 'wsl', distro: 'Fantasma' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe('agent-unavailable');
    expect(body.error).toContain('wsl:Fantasma');
  });

  it('distro VIVA mas sem claude: 422 dizendo que falta o claude naquele ambiente', async () => {
    const { app, paneId } = await workspaceWith({ kind: 'wsl', distro: 'Ubuntu' }, fakeWslWithoutClaude('Ubuntu'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'agent', agent: 'claude' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe('agent-unavailable');
    expect(body.error).toContain('claude não encontrado em wsl:Ubuntu');
  });

  it('o portão NÃO barra sessão de shell — dá pra querer só um terminal na distro', async () => {
    const { app, paneId } = await workspaceWith({ kind: 'wsl', distro: 'Fantasma' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: AUTH,
      payload: { paneId, kind: 'shell' },
    });
    // A distro não existe, então o lançamento falha — mas por AMBIENTE
    // (tradução de caminho), não por "agente indisponível".
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('environment-unavailable');
  });
});

describe('POST /api/tasks herda o ambiente do repositório', () => {
  it('a tarefa nasce no ambiente do workspace de raiz, e um `environment` explícito manda', async () => {
    const app = startCore().app;
    const repo = makeRepo();

    // Workspace de RAIZ do repo, com ambiente escolhido.
    const root = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: AUTH,
      payload: { cwd: repo, environment: { kind: 'wsl', distro: 'Ubuntu' } },
    });
    expect(root.statusCode).toBe(201);

    const herdada = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: repo, name: 'herda' },
    });
    expect(herdada.statusCode).toBe(201);
    expect((herdada.json() as { workspace: { environment: unknown } }).workspace.environment).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
    });

    const explicita = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: repo, name: 'explicita', environment: { kind: 'gitbash' } },
    });
    expect(explicita.statusCode).toBe(201);
    expect((explicita.json() as { workspace: { environment: unknown } }).workspace.environment).toEqual({
      kind: 'gitbash',
    });
  });

  it('repo sem ambiente nenhum: a tarefa nasce sem ambiente (comportamento de sempre)', async () => {
    const app = startCore().app;
    const repo = makeRepo();
    await app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: repo } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: repo, name: 'sem-ambiente' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { workspace: { environment?: unknown } }).workspace.environment).toBeUndefined();
  });

  it('`environment` malformado em POST /api/tasks é 400', async () => {
    const app = startCore().app;
    const repo = makeRepo();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: AUTH,
      payload: { repoPath: repo, name: 't', environment: { kind: 'wsl' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('migração idempotente de `workspaces.environment_json`', () => {
  it('banco de versão anterior (sem a coluna) sobe com ela nula e o workspace continua sem ambiente', () => {
    const dir = tmpDir('bridge-env-db-');
    const path = join(dir, 'bridge.db');

    // O schema ANTES desta task: `workspaces` sem `environment_json`.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_id TEXT,
        branch TEXT,
        worktree_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare('INSERT INTO workspaces (id, name, cwd, created_at) VALUES (?, ?, ?, ?)')
      .run('ws_velho', 'antigo', 'C:\\x', 1);
    legacy.close();

    const db = openDb(path);
    const workspace = db.workspaces.get('ws_velho')!;
    expect(workspace.name).toBe('antigo');
    expect(workspace.environment).toBeUndefined();

    // E a partir daqui o ambiente grava e volta.
    db.workspaces.update({ ...workspace, environment: { kind: 'wsl', distro: 'Ubuntu' } });
    expect(db.workspaces.get('ws_velho')!.environment).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
    db.close();

    // Abrir de novo NÃO tenta o ALTER de novo (`ALTER TABLE` não tem IF NOT EXISTS).
    const again = openDb(path);
    expect(again.workspaces.get('ws_velho')!.environment).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
    again.close();
  });
});
