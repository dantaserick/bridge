/**
 * Fix round 2 da onda de segurança — os vetores que o re-review adversarial
 * reabriu.
 *
 * O BR-01 aqui NÃO pode ser testado com `app.inject()`: o light-my-request
 * monta o request-target por conta própria e sempre em origin-form. O ataque é
 * na CAMADA HTTP, então o teste abre um `net.Socket` e escreve as linhas do
 * pedido à mão — é a única forma de mandar absolute-form de verdade.
 *
 * Perfil temporário em tudo; nada toca `%APPDATA%\bridge`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { openDb } from '../src/db.js';
import { currentUserForAcl, loadProfile, restrictToCurrentUser, writeInstance } from '../src/profile.js';
import { isTranscriptPath } from '../src/quota.js';

const trees: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of trees.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // pasta travada por antivírus: é temp, o SO limpa depois.
    }
  }
}

/**
 * Manda um pedido HTTP CRU e devolve a primeira linha da resposta. `target` vai
 * literal na linha de requisição — é o ponto do teste.
 */
function rawRequest(
  port: number,
  method: string,
  target: string,
  extraHeaders: string[] = [],
  body = '',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timeout no socket cru'));
    });
    socket.on('connect', () => {
      const headers = [
        `${method} ${target} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: close',
        ...extraHeaders,
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
        'Content-Type: application/json',
        '',
        body,
      ];
      socket.write(headers.join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

function statusOf(responseLine: string): number {
  return Number(responseLine.split(' ')[1] ?? 0);
}

describe('fix round 2 — BR-01: request-target fora da origin-form', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    cleanup();
  });

  /**
   * O bloco [D]/[D2]/[D3] do re-review: absolute-form com o host de loopback,
   * com um host hostil, e com o esquema em maiúsculas. Antes disso tudo
   * devolvia 200 (ou chegava ao handler) SEM token e com `Origin` hostil,
   * porque o hook de auth lia `req.raw.url` começando em `h` e classificava
   * como público, enquanto o find-my-way normalizava e roteava.
   */
  it('absolute-form não alcança rota nenhuma, com ou sem Origin hostil', async () => {
    core = createCore({ profileDir: tmp('bridge-r2-'), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();

    const alvos: Array<[string, string, string[]]> = [
      ['GET', `http://127.0.0.1:${port}/api/state`, []],
      ['GET', `http://127.0.0.1:${port}/api/state`, ['Origin: https://evil.example']],
      ['GET', 'http://evil.example/api/state', []],
      ['GET', `HTTP://127.0.0.1:${port}/api/state`, []],
      ['POST', `http://127.0.0.1:${port}/hooks/sess_aaaaaaaaaaaa/Stop`, []],
      ['POST', `http://127.0.0.1:${port}/api/sessions`, ['Origin: https://evil.example']],
    ];

    for (const [method, target, headers] of alvos) {
      const line = await rawRequest(port, method, target, headers, '{}');
      const code = statusOf(line);
      expect([400, 401, 403], `${method} ${target} → ${line}`).toContain(code);
    }
  });

  it('authority-form e asterisk-form também são 400', async () => {
    core = createCore({ profileDir: tmp('bridge-r2-'), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();

    expect(statusOf(await rawRequest(port, 'OPTIONS', '*'))).toBe(400);
    expect(statusOf(await rawRequest(port, 'GET', '127.0.0.1:4560'))).toBe(400);
  });

  it('CONTROLE: origin-form continua com o comportamento de sempre pelo socket cru', async () => {
    core = createCore({ profileDir: tmp('bridge-r2-'), dbPath: ':memory:', port: 0, token: 'T' });
    const { port } = await core.start();

    // Sem token → 401 (não 400: a classificação rodou).
    expect(statusOf(await rawRequest(port, 'GET', '/api/state'))).toBe(401);
    // Com token → 200. É a prova de que o guard novo não fechou o caminho certo.
    expect(statusOf(await rawRequest(port, 'GET', '/api/state', ['Authorization: Bearer T']))).toBe(200);
  });
});

/*
 * O describe do BR-03 que ficava aqui testava a NEUTRALIZAÇÃO dos drivers de
 * filtro (`-c filter.<n>.clean=`), desenho que a rodada 3 substituiu: ele
 * quebrava repositório legítimo (git-crypt, nbstripout, git-lfs), não via
 * `include.path` nem o escopo `--worktree`, e o `-c` nem conseguia expressar
 * nome de driver com `=`. A cobertura do BR-03 vive em
 * `security-round3.test.ts`, com repo hostil, repo legítimo e o CONTROLE.
 */

describe('fix round 2 — BR-07: icacls que falha não passa em silêncio', () => {
  afterEach(cleanup);

  const windows = process.platform === 'win32';

  it.skipIf(!windows)('icacls ausente devolve `falhou` e chama o callback de erro', () => {
    const p = loadProfile(tmp('bridge-r2-acl-'));
    const erros: string[] = [];
    const antes = process.env.BRIDGE_ICACLS;
    const antesGate = process.env.BRIDGE_TEST_HOOKS;
    // O override do binário só é lido com o gate ligado (fix round 3): sem ele,
    // uma variável de ambiente qualquer mandaria o app rodar outro executável
    // no lugar do `icacls`.
    process.env.BRIDGE_TEST_HOOKS = '1';
    process.env.BRIDGE_ICACLS = join(tmpdir(), 'icacls-que-nao-existe-bridge.exe');
    try {
      const outcome = writeInstance(p, { port: 1, token: 'segredo', pid: process.pid, startedAt: 1 }, (msg) =>
        erros.push(msg),
      );
      expect(outcome).toBe('falhou');
      expect(erros).toHaveLength(1);
      expect(erros[0]).toContain('instance.json');
    } finally {
      if (antes === undefined) delete process.env.BRIDGE_ICACLS;
      else process.env.BRIDGE_ICACLS = antes;
      if (antesGate === undefined) delete process.env.BRIDGE_TEST_HOOKS;
      else process.env.BRIDGE_TEST_HOOKS = antesGate;
    }
  });

  it.skipIf(!windows)('com o icacls de verdade o desfecho é `aplicada`', () => {
    const p = loadProfile(tmp('bridge-r2-acl-'));
    const outcome = writeInstance(p, { port: 1, token: 'segredo', pid: process.pid, startedAt: 1 });
    expect(outcome).toBe('aplicada');
    expect(restrictToCurrentUser(p.instancePath)).toBe('aplicada');
    expect(currentUserForAcl().length).toBeGreaterThan(0);
  });

  it.skipIf(!windows)('GET /api/state expõe instanceAclApplied: false quando o icacls falha', async () => {
    const antes = process.env.BRIDGE_ICACLS;
    const antesGate = process.env.BRIDGE_TEST_HOOKS;
    process.env.BRIDGE_TEST_HOOKS = '1';
    process.env.BRIDGE_ICACLS = join(tmpdir(), 'icacls-que-nao-existe-bridge.exe');
    let core: Core | undefined;
    try {
      core = createCore({ profileDir: tmp('bridge-r2-acl-'), dbPath: ':memory:', port: 0, token: 'T' });
      await core.start();
      const res = await core.app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer T' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { instanceAclApplied?: boolean }).instanceAclApplied).toBe(false);
    } finally {
      if (core) await core.stop();
      if (antes === undefined) delete process.env.BRIDGE_ICACLS;
      else process.env.BRIDGE_ICACLS = antes;
      if (antesGate === undefined) delete process.env.BRIDGE_TEST_HOOKS;
      else process.env.BRIDGE_TEST_HOOKS = antesGate;
    }
  });

  it.skipIf(!windows)('sem BRIDGE_TEST_HOOKS=1 o override do binário é IGNORADO', () => {
    const p = loadProfile(tmp('bridge-r2-acl-'));
    const antes = process.env.BRIDGE_ICACLS;
    const antesGate = process.env.BRIDGE_TEST_HOOKS;
    delete process.env.BRIDGE_TEST_HOOKS;
    process.env.BRIDGE_ICACLS = join(tmpdir(), 'icacls-que-nao-existe-bridge.exe');
    try {
      // O `icacls` de verdade roda: o override só existe pro teste, e sem o
      // gate ele não é lido.
      expect(writeInstance(p, { port: 1, token: 'segredo', pid: process.pid, startedAt: 1 })).toBe('aplicada');
    } finally {
      if (antes === undefined) delete process.env.BRIDGE_ICACLS;
      else process.env.BRIDGE_ICACLS = antes;
      if (antesGate === undefined) delete process.env.BRIDGE_TEST_HOOKS;
      else process.env.BRIDGE_TEST_HOOKS = antesGate;
    }
  });

  it('CONTROLE: com a ACL aplicada (ou fora do Windows) o estado diz true', async () => {
    let core: Core | undefined;
    try {
      core = createCore({ profileDir: tmp('bridge-r2-acl-'), dbPath: ':memory:', port: 0, token: 'T' });
      await core.start();
      const res = await core.app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer T' } });
      expect((res.json() as { instanceAclApplied?: boolean }).instanceAclApplied).toBe(true);
    } finally {
      if (core) await core.stop();
    }
  });
});

describe('fix round 2 — residuais', () => {
  afterEach(cleanup);

  it('transcript_path recusa UNC e, no Windows, exige letra de unidade', () => {
    expect(isTranscriptPath('\\\\servidor\\share\\conversa.jsonl')).toBe(false);
    expect(isTranscriptPath('//servidor/share/conversa.jsonl')).toBe(false);
    expect(isTranscriptPath('\\\\?\\C:\\conversa.jsonl')).toBe(false);
    expect(isTranscriptPath('conversa.jsonl')).toBe(false);
    expect(isTranscriptPath('C:\\perfil\\x\\.ssh\\id_ed25519')).toBe(false);
    if (process.platform === 'win32') {
      expect(isTranscriptPath('C:\\perfil\\x\\conversa.jsonl')).toBe(true);
      expect(isTranscriptPath('C:/Users/x/conversa.jsonl')).toBe(true);
      // Absoluto POSIX no Windows não é caminho de disco.
      expect(isTranscriptPath('/home/x/conversa.jsonl')).toBe(false);
    } else {
      expect(isTranscriptPath('/home/x/conversa.jsonl')).toBe(true);
    }
  });

  it('prune também limita as NÃO LIDAS por sessão', () => {
    const db = openDb(':memory:');
    try {
      for (let i = 0; i < 500; i += 1) {
        db.notifications.insert({
          id: `a_${i}`,
          sessionId: 'sess_a',
          workspaceId: 'ws_1',
          kind: 'custom',
          text: `a ${i}`,
          at: 1000 + i,
        });
      }
      for (let i = 0; i < 50; i += 1) {
        db.notifications.insert({
          id: `b_${i}`,
          sessionId: 'sess_b',
          workspaceId: 'ws_1',
          kind: 'custom',
          text: `b ${i}`,
          at: 1000 + i,
        });
      }
      expect(db.notifications.listUnread()).toHaveLength(550);

      db.notifications.prune(10_000, 200);

      const unread = db.notifications.listUnread();
      // A sessão que despejou 500 fica com 200; a outra, intocada.
      expect(unread.filter((n) => n.sessionId === 'sess_a')).toHaveLength(200);
      expect(unread.filter((n) => n.sessionId === 'sess_b')).toHaveLength(50);
      // As mais NOVAS é que sobrevivem.
      expect(unread.some((n) => n.id === 'a_499')).toBe(true);
      expect(unread.some((n) => n.id === 'a_0')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a pasta de hooksPath vazio nasce dentro do perfil, não em %TEMP%', async () => {
    const profileDir = tmp('bridge-r2-nohooks-');
    let core: Core | undefined;
    try {
      core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });
      expect(existsSync(join(profileDir, 'no-hooks'))).toBe(true);
    } finally {
      if (core) await core.stop();
    }
  });
});
