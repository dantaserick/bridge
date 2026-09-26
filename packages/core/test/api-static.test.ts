import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { normalizePath } from '../src/api/auth.js';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('normalizePath', () => {
  it.each([
    ['/api/state', '/api/state'],
    ['//api/state', '/api/state'],
    ['////api//state', '/api/state'],
    ['/api%2Fstate', '/api/state'],
    ['/./api/state', '/api/state'],
    ['/static/../api/state', '/api/state'],
    ['/../../api/state', '/api/state'],
    ['/api/state?token=x', '/api/state'],
    ['/api/state#frag', '/api/state'],
    ['/assets/app.js', '/assets/app.js'],
    // `/apiece` não é `/api`: o casamento é por segmento, não por prefixo cru.
    ['/apiece', '/apiece'],
    ['', '/'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePath(raw)).toBe(expected);
  });

  it('devolve null quando o percent-encoding é inválido', () => {
    expect(normalizePath('/%zz')).toBeNull();
    expect(normalizePath('/api/%E0%A4%A')).toBeNull();
  });
});

function tmp(prefix: string): string {
  return tmpDir(prefix);
}

function buildUiDir(): string {
  const dir = tmp('bridge-ui-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Bridge</title><div id="root"></div>', 'utf8');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("bridge")', 'utf8');
  return dir;
}

describe('UI estática servida pelo core', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('com uiDir, GET / devolve o index.html sem bearer', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const res = await core.app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="root"></div>');
  });

  it('com uiDir, os assets também saem sem bearer e um arquivo inexistente é 404', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const asset = await core.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log("bridge")');

    const missing = await core.app.inject({ method: 'GET', url: '/assets/nada.js' });
    expect(missing.statusCode).toBe(404);
  });

  it('com uiDir, /api continua exigindo o bearer', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const semToken = await core.app.inject({ method: 'GET', url: '/api/state' });
    expect(semToken.statusCode).toBe(401);

    const comToken = await core.app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer T' } });
    expect(comToken.statusCode).toBe(200);
  });

  it('com uiDir, /api com Origin de terceiro é 403 mesmo com o bearer certo', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const evil = await core.app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: 'Bearer T', origin: 'http://evil.example' },
    });
    expect(evil.statusCode).toBe(403);

    // A página da própria UI (servida deste core) continua passando.
    const ui = await core.app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: 'Bearer T', origin: 'http://127.0.0.1:4560' },
    });
    expect(ui.statusCode).toBe(200);

    // E o estático segue sem bearer: a checagem de Origin não vale pra ele
    // (é justamente a página que ainda não tem token nenhum).
    const index = await core.app.inject({ method: 'GET', url: '/', headers: { origin: 'http://evil.example' } });
    expect(index.statusCode).toBe(200);
  });

  // O estático é a única rota sem bearer. Se a classificação do caminho puder
  // ser enganada, `/api` inteiro vaza por ela — daí a bateria abaixo.
  it.each([
    ['//api/state', 'barra dobrada'],
    ['/api%2Fstate', 'barra percent-encoded'],
    ['/./api/state', 'segmento ponto'],
    ['/static/../api/state', 'travessia com ..'],
    ['/api/./state', 'ponto no meio'],
    ['//ws', 'barra dobrada no ws'],
    ['//hooks/status', 'barra dobrada no hook'],
  ])('com uiDir, %s não escapa da autenticação (%s)', async (url) => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const res = await core.app.inject({ method: 'GET', url });

    expect(res.statusCode).not.toBe(200);
    // 400 entrou na lista na onda de segurança (BR-01): separador de caminho
    // codificado (`%2F`/`%5C`) é recusado ANTES de classificar, porque é o que
    // fazia o hook de auth e o roteador do Fastify discordarem.
    expect([400, 401, 403]).toContain(res.statusCode);
  });

  it('com uiDir, o arquivo estático de verdade continua saindo sem bearer', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const res = await core.app.inject({ method: 'GET', url: '/index.html' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root"></div>');
  });

  it('percent-encoding quebrado vira 400, não um caminho classificado errado', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T', uiDir: buildUiDir() });

    const res = await core.app.inject({ method: 'GET', url: '/%zz' });

    expect(res.statusCode).toBe(400);
  });

  it('sem uiDir, GET / é 404 como antes', async () => {
    core = createCore({ profileDir: tmp('bridge-profile-'), dbPath: ':memory:', port: 0, token: 'T' });

    const res = await core.app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(404);
  });

  it('uiDir apontando pra pasta inexistente não derruba o core: volta a ser 404', async () => {
    core = createCore({
      profileDir: tmp('bridge-profile-'),
      dbPath: ':memory:',
      port: 0,
      token: 'T',
      uiDir: join(tmpdir(), 'bridge-ui-que-nao-existe'),
    });

    const res = await core.app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(404);
  });
});
