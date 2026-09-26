/**
 * Testes de ATAQUE da onda de segurança (Task 2 da fase 2026-09-05).
 *
 * Cada bloco reproduz o vetor descrito no `security-findings.md` contra um core
 * em processo (`createCore` + `app.inject()`), num perfil temporário — nada aqui
 * toca `%APPDATA%\bridge`. Onde o achado tinha um "controle" (o fluxo legítimo
 * do dono), ele também está aqui: a correção não pode ter fechado a porta certa.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { UI_SECURITY_HEADERS } from '../src/api/app.js';
import { effectiveZone } from '../src/api/auth.js';
import { WS_MAX_CLIENTS } from '../src/api/ws.js';

const AUTH = { authorization: 'Bearer T' };
const fakeAgentPath = join(__dirname, 'fake-agent.cjs');

/** Adaptador `claude` falso — o Claude de verdade não sobe em teste. */
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
const trees: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

function buildUiDir(): string {
  const dir = tmp('bridge-sec-ui-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Bridge</title><div id="root"></div>', 'utf8');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("bridge")', 'utf8');
  return dir;
}

describe('segurança do core', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    // A remoção é SILENCIOSA, pela mesma razão escrita em `test/tmp.ts`: no
    // Windows o `cwd` de um PTY que acabou de morrer, um `core.log` ainda
    // aberto ou o antivírus seguram a pasta por alguns milissegundos, e o
    // `rmSync` sai com `EPERM`. Derrubar um teste de SEGURANÇA por lixo em
    // `%TEMP%` é trocar o sinal pelo ruído — a asserção do teste já passou
    // quando este `afterEach` roda. O que escapar aqui é apanhado pelo
    // `globalTeardown` (`test/setup.ts`), que varre `%TEMP%` no fim.
    for (const dir of trees.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Ver acima.
      }
    }
  });

  // ---------------------------------------------------------------- BR-01

  describe('BR-01 — separador codificado no parâmetro tira o caminho do prefixo protegido', () => {
    /**
     * O ataque provado na auditoria: `%2F..%2F..%2F..%2FStop` faz o hook de auth
     * ver `/Stop` (que não casa `/hooks`) enquanto o roteador continua casando
     * `POST /hooks/:sessionId/:event`. Sem token, sem `Origin` local — e o
     * handler rodava.
     */
    it.each([
      ['POST', '/hooks/sess_aaaaaaaaaaaa/x%2F..%2F..%2F..%2FStop'],
      ['GET', '/api/sessions/..%2F..%2Fzzz/scrollback'],
      ['DELETE', '/api/sessions/..%2F..%2Fzzz'],
      ['POST', '/api/sessions/..%2F..%2Fzzz/input'],
      ['GET', '/api/sessions/..%5C..%5Czzz/scrollback'],
    ])('%s %s sem token nunca chega ao handler', async (method, url) => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

      const res = await core.app.inject({ method: method as 'GET', url, payload: {} });

      // 400 (separador codificado recusado na porta) — nunca 200 nem o 404 do handler.
      expect(res.statusCode).toBe(400);
    });

    it('a mesma URL com Origin hostil também não escapa do 403/400', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions/..%2F..%2Fzzz/input',
        headers: { origin: 'https://evil.example' },
        payload: { data: 'x' },
      });

      expect([400, 403]).toContain(res.statusCode);
    });

    /**
     * O `inject` do light-my-request já resolve `..` antes de bater no
     * servidor, então a discordância entre parsers é testada onde ela mora:
     * na função de classificação. `effectiveZone` é a união do que o caminho
     * CRU (o que o roteador enxerga) e o NORMALIZADO dizem — nunca a
     * interseção, que era o buraco.
     */
    it('effectiveZone é default-deny: basta um dos dois parsers ver zona protegida', () => {
      expect(effectiveZone('/hooks/sess_x/a/../../../Stop', '/Stop')).toBe('hooks');
      expect(effectiveZone('/estatico/../api/state', '/api/state')).toBe('api');
      expect(effectiveZone('//api/state', '/api/state')).toBe('api');
      expect(effectiveZone('/api/x/../../ws', '/ws')).toBe('ambiguo');
      expect(effectiveZone('/assets/app.js', '/assets/app.js')).toBe('public');
      expect(effectiveZone('/apiece', '/apiece')).toBe('public');
    });

    it('CONTROLE: o shim continua passando (POST /hooks/<id>/Stop?token=T → 200)', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

      const res = await core.app.inject({
        method: 'POST',
        url: '/hooks/sess_aaaaaaaaaaaa/Stop?token=T',
        payload: { session_id: 'abc' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('CONTROLE: a UI estática continua saindo sem bearer', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

      const index = await core.app.inject({ method: 'GET', url: '/' });
      const asset = await core.app.inject({ method: 'GET', url: '/assets/app.js' });

      expect(index.statusCode).toBe(200);
      expect(asset.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------- BR-02

  describe('BR-02 — travessia no nome do arquivo de dump de hook', () => {
    beforeEach(() => {
      process.env.BRIDGE_DEBUG_HOOKS = '1';
    });
    afterEach(() => {
      delete process.env.BRIDGE_DEBUG_HOOKS;
    });

    it('sessionId com travessia é 400 e não cria arquivo nenhum fora de logs/', async () => {
      const profileDir = tmp('bridge-sec-hooks-');
      core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });
      const acima = dirname(profileDir);
      const antes = new Set(readdirSync(acima));

      const res = await core.app.inject({
        method: 'POST',
        url: '/hooks/..%2F..%2F..%2Fbridge-probe-fora/Stop?token=T',
        payload: { conversa_do_usuario: 'SEGREDO' },
      });

      expect(res.statusCode).toBe(400);
      expect(existsSync(join(profileDir, 'bridge-probe-fora.jsonl'))).toBe(false);
      expect(existsSync(join(acima, 'bridge-probe-fora.jsonl'))).toBe(false);
      // E nenhum `.jsonl` novo apareceu na pasta acima do perfil (a suite roda
      // em paralelo e outros testes criam pastas temporarias no mesmo lugar).
      expect(readdirSync(acima).filter((n) => !antes.has(n) && n.endsWith('.jsonl'))).toEqual([]);
    });

    it('evento com barra também é 400 (o parâmetro não vira caminho)', async () => {
      const profileDir = tmp('bridge-sec-hooks-');
      core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/hooks/sess_aaaaaaaaaaaa/..%2F..%2Fx?token=T',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('CONTROLE: o dump legítimo continua sendo gravado em <perfil>/logs', async () => {
      const profileDir = tmp('bridge-sec-hooks-');
      core = createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/hooks/sess_aaaaaaaaaaaa/Stop?token=T',
        payload: { session_id: 'abc' },
      });

      expect(res.statusCode).toBe(200);
      expect(existsSync(join(profileDir, 'logs', 'hooks-sess_aaaaaaaaaaaa.jsonl'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- BR-06

  describe('BR-06 — session_id de hook vira --resume sem validação', () => {
    it('`session_id` que começa com `-` NÃO é gravado no painel', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });
      const c = core;
      fakeClaude(c);
      const cwd = tmp('bridge-sec-cwd-');
      const ws = await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd } });
      const { pane } = ws.json() as { pane: { id: string } };
      const session = await c.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: AUTH,
        payload: { paneId: pane.id, kind: 'agent', agent: 'claude' },
      });
      expect(session.statusCode).toBe(201);
      const sessionId = (session.json() as { id: string }).id;

      const hostil = await c.app.inject({
        method: 'POST',
        url: `/hooks/${sessionId}/SessionStart?token=T`,
        payload: { session_id: '--dangerously-skip-permissions' },
      });
      expect(hostil.statusCode).toBe(200);
      expect(c.deps.db.panes.get(pane.id)?.lastAgentSessionId).toBeUndefined();
      expect(c.deps.sessions.get(sessionId)?.agentSessionId).toBeUndefined();

      // CONTROLE: um UUID de verdade continua sendo gravado.
      await c.app.inject({
        method: 'POST',
        url: `/hooks/${sessionId}/SessionStart?token=T`,
        payload: { session_id: '550e8400-e29b-41d4-a716-446655440000' },
      });
      expect(c.deps.db.panes.get(pane.id)?.lastAgentSessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }, 25000);

    it('POST /api/sessions com `resume` começando em `-` é 400', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: AUTH,
        payload: { paneId: 'pane_x', kind: 'agent', agent: 'claude', resume: '--dangerously-skip-permissions' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- BR-04

  describe('BR-04 — initialCommand montado a partir de dado hostil', () => {
    it.each([
      ['x; calc', 'ponto e vírgula'],
      ['git diff main && calc', 'e comercial'],
      ['git diff `calc`', 'crase'],
      ['git diff $(calc)', 'substituição de comando'],
      ['git diff main\rcalc', 'retorno de carro'],
    ])('POST /api/sessions com initialCommand %s é 400 (%s)', async (initialCommand) => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: AUTH,
        payload: { paneId: 'pane_x', kind: 'shell', initialCommand },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- BR-09

  describe('BR-09 — base sem teto nem forma', () => {
    it.each([
      ['a'.repeat(50_000), '50 000 chars (era 500 ENAMETOOLONG)'],
      ['--upload-pack=calc.exe', 'argumento com `-`'],
      ['main;whoami', 'separador de comando'],
      ['../fora', 'travessia'],
    ])('POST /api/tasks com base inválido é 400, não 500 (%s)', async (base) => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: AUTH,
        payload: { repoPath: process.cwd(), name: 'tarefa', base },
      });

      expect(res.statusCode).toBe(400);
    });

    it('PATCH .../worktree com base hostil também é 400', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws_x/worktree',
        headers: AUTH,
        payload: { base: '--upload-pack=x' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- BR-10

  describe('BR-10 — cabeçalhos de segurança da UI', () => {
    it.each(['/', '/index.html', '/assets/app.js'])('%s traz CSP, nosniff e Referrer-Policy', async (url) => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

      const res = await core.app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(UI_SECURITY_HEADERS['content-security-policy']);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('a CSP não libera script inline nem origem externa', () => {
      const csp = UI_SECURITY_HEADERS['content-security-policy']!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  // ---------------------------------------------------------------- BR-15

  describe('BR-15 — resize sem teto chega ao ConPTY', () => {
    it.each([
      [2_147_483_648, 2_147_483_648],
      [1e9, 24],
      [0, 24],
      [-1, 24],
    ])('POST /api/sessions/:id/resize {cols:%s,rows:%s} é 400', async (cols, rows) => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions/zzz/resize',
        headers: AUTH,
        payload: { cols, rows },
      });

      expect(res.statusCode).toBe(400);
    });

    it('CONTROLE: um resize normal continua aceito', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions/zzz/resize',
        headers: AUTH,
        payload: { cols: 120, rows: 30 },
      });

      expect(res.statusCode).toBe(200);
    });

    it('mensagem WS de resize fora da faixa é ignorada (pty.resize nunca é chamado)', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });
      const { port } = await core.start();
      const chamadas: unknown[][] = [];
      const original = core.deps.pty.resize.bind(core.deps.pty);
      core.deps.pty.resize = (...args: [string, number, number]) => {
        chamadas.push(args);
        original(...args);
      };

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      socket.send(JSON.stringify({ type: 'resize', sessionId: 'zzz', cols: -1, rows: 24 }));
      socket.send(JSON.stringify({ type: 'resize', sessionId: 'zzz', cols: 1e308, rows: 24 }));
      socket.send(JSON.stringify({ type: 'resize', sessionId: 'zzz', cols: 120, rows: 30 }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      socket.close();

      expect(chamadas).toEqual([['zzz', 120, 30]]);
    });
  });

  // ---------------------------------------------------------------- BR-11

  describe('BR-11 — WebSocket sem teto de payload nem de conexões', () => {
    it('a conexão além do teto é recusada com 1013', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });
      const { port } = await core.start();
      const abertos: WebSocket[] = [];

      try {
        for (let i = 0; i < WS_MAX_CLIENTS; i += 1) {
          const s = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
          abertos.push(s);
          await new Promise<void>((resolve, reject) => {
            s.on('open', () => resolve());
            s.on('error', reject);
          });
        }

        const extra = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
        abertos.push(extra);
        const code = await new Promise<number>((resolve, reject) => {
          extra.on('close', (c: number) => resolve(c));
          extra.on('error', reject);
          setTimeout(() => reject(new Error('a 33ª conexão não foi fechada')), 5000);
        });

        expect(code).toBe(1013);
      } finally {
        for (const s of abertos) s.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });

    it('mensagem acima do maxPayload derruba o socket em vez de ser parseada', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });
      const { port } = await core.start();

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      const fechado = new Promise<number>((resolve) => socket.on('close', (c: number) => resolve(c)));
      socket.send(JSON.stringify({ type: 'input', sessionId: 'zzz', data: 'A'.repeat(2 * 1024 * 1024) }));

      // 1009 = "message too big". O socket cai; o core não parseia 2 MB.
      const code = await Promise.race([
        fechado,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error('socket não fechou')), 5000)),
      ]);
      expect(code).toBe(1009);
    });
  });

  // ---------------------------------------------------------------- BR-12

  describe('BR-12 — notificação sem teto de texto nem de taxa', () => {
    it('POST .../notify com texto acima do teto é 400', async () => {
      core = createCore({ profileDir: tmp('bridge-sec-'), dbPath: ':memory:', port: 0, token: 'T' });

      const res = await core.app.inject({
        method: 'POST',
        url: '/api/sessions/zzz/notify',
        headers: AUTH,
        payload: { text: 'x'.repeat(5000) },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
