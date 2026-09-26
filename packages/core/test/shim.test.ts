import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { baseEnv } from '../src/adapters/shell.js';
import type { LaunchCtx, LaunchSpec } from '../src/adapters/types.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { join } from 'node:path';

function tmp(): string {
  return tmpDir('bridge-shim-');
}

function readFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', 'hooks', `${name}.json`), 'utf8');
}

function runShim(
  shim: string,
  sessionId: string,
  event: string,
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim, sessionId, event], { env });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('close', (code) => resolve({ stdout, exitCode: code }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout esperando condição'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('bridge-hook.cjs (shim)', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('POST bem-sucedido: stdout {} e sessão passa a running', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: 'T' };
    const { stdout, exitCode } = await runShim(core.deps.shimPath, session.id, 'UserPromptSubmit', env, readFixture('user-prompt'));

    expect(exitCode).toBe(0);
    expect(stdout).toBe('{}');
    expect(core.deps.sessions.get(session.id)?.state).toBe('running');
  }, 10000);

  it('porta fechada: stdout {}, exit 0, em menos de 4s', async () => {
    const start = Date.now();
    const shim = join(__dirname, '..', 'bin', 'bridge-hook.cjs');
    const env = { ...process.env, BRIDGE_PORT: '1', BRIDGE_TOKEN: 'T' };
    const { stdout, exitCode } = await runShim(shim, 'sess_qualquer', 'UserPromptSubmit', env, readFixture('user-prompt'));

    expect(exitCode).toBe(0);
    expect(stdout).toBe('{}');
    expect(Date.now() - start).toBeLessThan(4000);
  }, 8000);

  it('core respondendo 401 (token errado no env): stdout {} — nunca ecoa o corpo de erro', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: 'ERRADO' };
    const { stdout, exitCode } = await runShim(core.deps.shimPath, session.id, 'UserPromptSubmit', env, readFixture('user-prompt'));

    expect(exitCode).toBe(0);
    expect(stdout).toBe('{}');
    expect(core.deps.sessions.get(session.id)?.state).toBe('idle');
  }, 10000);

  it('StatusLine com core respondendo 401: stdout vazio, não o JSON de erro', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();

    const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: 'ERRADO' };
    const { stdout, exitCode } = await runShim(core.deps.shimPath, 'sess_x', 'StatusLine', env, '{}');

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  }, 10000);

  /**
   * O shim é quem espera a resposta do core: se ele desistir antes, a
   * statusline sai vazia. Desde a ADR-012 não há mais processo externo neste
   * caminho (a linha é montada do próprio payload), então o orçamento de 5 s é
   * folga sobre um trabalho em memória — e continua cobrado aqui pra que
   * ninguém o encurte sem perceber.
   */
  it('orçamento de hook: o shim espera 5 s pela resposta do core', () => {
    const shimSource = readFileSync(join(__dirname, '..', 'bin', 'bridge-hook.cjs'), 'utf8');
    const match = /const TIMEOUT_MS = (\d+);/.exec(shimSource);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(5000);
  });

  it('StatusLine: stdout com a linha crua quando ela está ligada, e VAZIO no padrão', async () => {
    const profileDir = tmp();
    core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T', claudeHome: tmp() });
    const { port } = await core.start();
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: 'T' };
    const statusline = readFileSync(join(__dirname, 'fixtures', 'statusline.json'), 'utf8');

    // 0.12.2 — no padrão o core responde linha vazia, e o shim ecoa isso: é
    // exatamente o que o Claude Code recebe, e o que o teste com um `claude`
    // REAL mostrou que faz a TUI não desenhar rodapé nenhum.
    const padrao = await runShim(core.deps.shimPath, session.id, 'StatusLine', env, statusline);
    expect(padrao.exitCode).toBe(0);
    expect(padrao.stdout).toBe('');
    // …e a cota chegou do mesmo jeito (é o que a sidebar mostra).
    expect(core.deps.sessions.get(session.id)?.quota).toMatchObject({ contextTokens: 87_000 });

    core.updateConfig({ usage: { terminalStatusLine: true } });
    const { stdout, exitCode } = await runShim(core.deps.shimPath, session.id, 'StatusLine', env, statusline);

    expect(exitCode).toBe(0);
    // A linha é montada pelo Bridge a partir do payload (ADR-012). O trecho do
    // reset depende do relógio, então o que se cobra é o formato + o que veio
    // do payload — não um texto congelado.
    expect(stdout).toMatch(/^87k ctx · Fable 5\.1 · US\$ 3,42 · 5h 23% \(reseta .+\) · semana 68% \(reseta .+\)$/);
  }, 10000);

  it('sessão "turn" via fake-agent no PTY: fica done com notificação done', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { port, token } = await c.start();
    const cwd = tmp();
    const { workspace, pane } = c.deps.layout.createWorkspace({ cwd });
    const session = c.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const fakeAgentPath = join(__dirname, 'fake-agent.cjs');
    const ctx: LaunchCtx = {
      sessionId: session.id,
      cwd,
      sessionDir: join(c.deps.profile.sessionsDir, session.id),
      port,
      token,
      shimPath: c.deps.shimPath,
      cols: 80,
      rows: 24,
    };
    const spec: LaunchSpec = { bin: process.execPath, args: [fakeAgentPath, 'turn'], env: baseEnv(ctx), files: [] };
    c.deps.pty.spawn(session.id, spec, { cwd, cols: 80, rows: 24 });

    await waitFor(() => c.deps.sessions.get(session.id)?.state === 'done', 5000);

    const unread = c.deps.notifications.unread();
    expect(unread.some((n) => n.sessionId === session.id && n.kind === 'done')).toBe(true);

    c.deps.pty.write(session.id, 'q\n');
    await c.deps.pty.kill(session.id);
  }, 15000);

  it('sessão "loop" via fake-agent no PTY: fica stuck', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    const { port, token } = await c.start();
    const cwd = tmp();
    const { workspace, pane } = c.deps.layout.createWorkspace({ cwd });
    const session = c.deps.sessions.create({ paneId: pane.id, workspaceId: workspace.id, kind: 'agent', agent: 'claude', cwd });

    const fakeAgentPath = join(__dirname, 'fake-agent.cjs');
    const ctx: LaunchCtx = {
      sessionId: session.id,
      cwd,
      sessionDir: join(c.deps.profile.sessionsDir, session.id),
      port,
      token,
      shimPath: c.deps.shimPath,
      cols: 80,
      rows: 24,
    };
    const spec: LaunchSpec = { bin: process.execPath, args: [fakeAgentPath, 'loop'], env: baseEnv(ctx), files: [] };
    c.deps.pty.spawn(session.id, spec, { cwd, cols: 80, rows: 24 });

    await waitFor(() => c.deps.sessions.get(session.id)?.state === 'stuck', 5000);

    c.deps.pty.write(session.id, 'q\n');
    await c.deps.pty.kill(session.id);
  }, 15000);
});
