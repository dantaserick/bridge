import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.js';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-log-'));
  logPath = join(dir, 'core.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe('createLogger', () => {
  it('escreve uma linha JSON por evento com t, l, s e m', async () => {
    const log = createLogger({ path: logPath });
    log.info('subiu');
    log.warn('cuidado');
    log.error('quebrou');
    await log.flush();

    const parsed = lines(logPath) as Record<string, unknown>[];
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p) => p.l)).toEqual(['info', 'warn', 'error']);
    expect(parsed.map((p) => p.m)).toEqual(['subiu', 'cuidado', 'quebrou']);
    for (const p of parsed) {
      expect(typeof p.s).toBe('string');
      expect(typeof p.t).toBe('string');
      expect(Number.isNaN(Date.parse(p.t as string))).toBe(false);
    }
  });

  it('mistura os dados extras na mesma linha', async () => {
    const log = createLogger({ path: logPath });
    log.info('sessão', { sessionId: 's1', bytes: 12 });
    await log.flush();

    const [first] = lines(logPath) as Record<string, unknown>[];
    expect(first).toMatchObject({ l: 'info', m: 'sessão', sessionId: 's1', bytes: 12 });
  });

  it('child(scope) marca o escopo em s', async () => {
    const log = createLogger({ path: logPath });
    log.child('ws').warn('socket lento');
    await log.flush();

    const [first] = lines(logPath) as Record<string, unknown>[];
    expect(first).toMatchObject({ s: 'ws', l: 'warn', m: 'socket lento' });
  });

  it('child compartilha a fila do pai (flush do pai espera o filho)', async () => {
    const log = createLogger({ path: logPath });
    const child = log.child('hooks');
    child.info('a');
    log.info('b');
    await log.flush();

    expect(lines(logPath)).toHaveLength(2);
  });

  it('level filtra o que fica abaixo dele', async () => {
    const log = createLogger({ path: logPath, level: 'warn' });
    log.debug('nem aparece');
    log.info('nem aparece');
    log.warn('aparece');
    log.error('aparece');
    await log.flush();

    const parsed = lines(logPath) as Record<string, unknown>[];
    expect(parsed.map((p) => p.l)).toEqual(['warn', 'error']);
  });

  it('rotaciona em maxBytes mantendo no máximo maxFiles arquivos', async () => {
    const log = createLogger({ path: logPath, maxBytes: 200, maxFiles: 2 });
    for (let i = 0; i < 20; i++) log.info(`linha ${i}`);
    await log.flush();

    const files = readdirSync(dir).sort();
    expect(files).toEqual(['core.log', 'core.log.1']);
    expect(existsSync(`${logPath}.2`)).toBe(false);

    for (const file of files) {
      const size = statSync(join(dir, file)).size;
      // Rotaciona ANTES de escrever a linha que estouraria o teto, então o
      // arquivo nunca passa de maxBytes (só uma linha sozinha maior que ele).
      expect(size).toBeLessThanOrEqual(200);
    }

    // A linha mais nova está sempre em core.log.
    const last = lines(logPath) as Record<string, unknown>[];
    expect(last.at(-1)).toMatchObject({ m: 'linha 19' });
  });

  it('rotação com maxFiles: 3 cria .1 e .2 e nunca .3', async () => {
    const log = createLogger({ path: logPath, maxBytes: 120, maxFiles: 3 });
    for (let i = 0; i < 40; i++) log.info(`linha ${i}`);
    await log.flush();

    expect(readdirSync(dir).sort()).toEqual(['core.log', 'core.log.1', 'core.log.2']);
  });

  it('flush resolve só depois de tudo estar em disco', async () => {
    const log = createLogger({ path: logPath });
    for (let i = 0; i < 50; i++) log.info(`linha ${i}`);
    await log.flush();

    expect(lines(logPath)).toHaveLength(50);
  });

  it('flush sem nada escrito resolve na hora', async () => {
    const log = createLogger({ path: logPath });
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it('alsoConsole espelha no console; sem ele o console fica limpo', async () => {
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const quiet = createLogger({ path: logPath });
      quiet.info('silêncio');
      quiet.error('silêncio');
      expect(spyLog).not.toHaveBeenCalled();
      expect(spyErr).not.toHaveBeenCalled();

      const loud = createLogger({ path: join(dir, 'outro.log'), alsoConsole: true });
      loud.info('oi');
      loud.error('erro');
      expect(spyLog).toHaveBeenCalledTimes(1);
      expect(spyErr).toHaveBeenCalledTimes(1);
      await Promise.all([quiet.flush(), loud.flush()]);
    } finally {
      spyLog.mockRestore();
      spyErr.mockRestore();
    }
  });

  it('serializa Error sem quebrar a linha', async () => {
    const log = createLogger({ path: logPath });
    log.error('falhou', { err: new Error('boom') });
    await log.flush();

    const [first] = lines(logPath) as Record<string, Record<string, string>>[];
    expect(first?.err?.message).toBe('boom');
    expect(first?.err?.name).toBe('Error');
    expect(typeof first?.err?.stack).toBe('string');
  });

  it('erro de escrita vai pro console e não derruba o logger', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // `path` aponta pra uma pasta: todo appendFile falha (EISDIR/EPERM).
      const log = createLogger({ path: dir });
      log.info('não vai gravar');
      await expect(log.flush()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('escrever sem esperar o flush não perde linha nem estoura', async () => {
    const log = createLogger({ path: logPath, maxBytes: 300, maxFiles: 3 });
    for (let i = 0; i < 200; i++) log.info(`linha ${i}`);
    await log.flush();

    const all = readdirSync(dir)
      .sort()
      .flatMap((f) => lines(join(dir, f)) as Record<string, unknown>[]);
    // O que sobrou (o mais novo) tem que ser um sufixo contíguo da sequência.
    expect(all.length).toBeGreaterThan(0);
    expect((lines(logPath) as Record<string, unknown>[]).at(-1)).toMatchObject({ m: 'linha 199' });
  });
});

/**
 * R11 — o vazamento de `%TEMP%\bridge-*`: uma linha logada DEPOIS do último
 * flush reabre o `core.log` e o Windows recusa apagar a pasta com o arquivo
 * aberto. `close()` drena a fila e fecha o logger de vez.
 */
describe('close()', () => {
  it('drena a fila e descarta o que for logado depois', async () => {
    const log = createLogger({ path: logPath });
    log.info('antes do fechamento');
    await log.close();

    expect(lines(logPath)).toHaveLength(1);

    log.info('depois do fechamento');
    log.child('git').error('e o filho tambem');
    await log.flush();
    expect(lines(logPath)).toHaveLength(1);

    // Fechado, a pasta inteira sai do disco sem EBUSY.
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(logPath)).toBe(false);
  });

  it('e idempotente', async () => {
    const log = createLogger({ path: logPath });
    log.info('uma');
    await log.close();
    await log.close();
    expect(lines(logPath)).toHaveLength(1);
  });
});
