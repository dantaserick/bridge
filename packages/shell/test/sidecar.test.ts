import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { resolveUiOrigin, resolveUiUrl } from '../src/resolveUi.js';
import {
  appendShellLog,
  defaultCoreArgs,
  flushShellLog,
  nodeCommand,
  parseInstance,
  resolveCoreLaunch,
  resolveRepoRoot,
  waitForInstance,
} from '../src/sidecar.js';

function tmp(): string {
  return tmpDir('bridge-shell-');
}

/** Pid impossível no Windows (pids são múltiplos de 4 e muito menores). */
const DEAD_PID = 2147483646;

function instanceJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ port: 4560, token: 'abc', pid: process.pid, startedAt: Date.now(), ...over });
}

describe('resolveUiUrl', () => {
  it('em dev aponta pro Vite, ignorando a porta do core', () => {
    expect(resolveUiUrl({ dev: true, port: 4560 })).toBe('http://127.0.0.1:5173');
  });

  it('fora de dev aponta pra UI estática servida pelo próprio core', () => {
    expect(resolveUiUrl({ dev: false, port: 4560 })).toBe('http://127.0.0.1:4560/');
    expect(resolveUiUrl({ dev: false, port: 51234 })).toBe('http://127.0.0.1:51234/');
  });
});

describe('resolveUiOrigin', () => {
  it('devolve a origem sem barra final, pra validar o remetente do IPC', () => {
    expect(resolveUiOrigin({ dev: true, port: 4560 })).toBe('http://127.0.0.1:5173');
    expect(resolveUiOrigin({ dev: false, port: 4560 })).toBe('http://127.0.0.1:4560');
  });

  it('casa por prefixo com a URL que o frame realmente carrega', () => {
    const origin = resolveUiOrigin({ dev: false, port: 4560 });
    expect(resolveUiUrl({ dev: false, port: 4560 }).startsWith(origin)).toBe(true);
  });
});

describe('parseInstance', () => {
  it('aceita um instance.json válido de um processo vivo', () => {
    const inst = parseInstance(instanceJson());
    expect(inst).toEqual({ port: 4560, token: 'abc', pid: process.pid, startedAt: expect.any(Number) });
  });

  it('recusa json inválido', () => {
    expect(parseInstance('{')).toBeNull();
    expect(parseInstance('')).toBeNull();
    expect(parseInstance('null')).toBeNull();
  });

  it('recusa json válido com o formato errado', () => {
    expect(parseInstance(JSON.stringify({ port: '4560', token: 'abc', pid: process.pid, startedAt: 1 }))).toBeNull();
    expect(parseInstance(JSON.stringify({ token: 'abc', pid: process.pid, startedAt: 1 }))).toBeNull();
  });

  it('recusa instância de um pid morto (core caiu sem limpar o arquivo)', () => {
    expect(parseInstance(instanceJson({ pid: DEAD_PID }))).toBeNull();
  });
});

describe('nodeCommand', () => {
  it('usa BRIDGE_NODE quando definido', () => {
    expect(nodeCommand({ BRIDGE_NODE: 'C:\\nvm\\v22\\node.exe' })).toBe('C:\\nvm\\v22\\node.exe');
  });

  it('cai pro node do PATH quando BRIDGE_NODE não está definido ou está vazio', () => {
    expect(nodeCommand({})).toBe('node');
    expect(nodeCommand({ BRIDGE_NODE: '' })).toBe('node');
    expect(nodeCommand({ BRIDGE_NODE: '   ' })).toBe('node');
  });
});

describe('waitForInstance', () => {
  it('resolve quando o arquivo aparece depois de 200 ms', async () => {
    const dir = tmp();
    const timer = setTimeout(() => writeFileSync(join(dir, 'instance.json'), instanceJson({ port: 4599 })), 200);
    try {
      const inst = await waitForInstance(dir, 5000);
      expect(inst?.port).toBe(4599);
      expect(inst?.token).toBe('abc');
    } finally {
      clearTimeout(timer);
    }
  });

  it('devolve null quando o prazo acaba sem arquivo', async () => {
    const started = Date.now();
    const inst = await waitForInstance(tmp(), 300);
    expect(inst).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('ignora a instância anterior ao lançamento (o core novo ainda não escreveu a dele)', async () => {
    const dir = tmp();
    const antes = Date.now() - 5000;
    writeFileSync(join(dir, 'instance.json'), instanceJson({ port: 4560, startedAt: antes }));
    expect(await waitForInstance(dir, 300, { minStartedAt: antes + 1 })).toBeNull();
    expect((await waitForInstance(dir, 300, { minStartedAt: antes }))?.port).toBe(4560);
  });

  it('desiste na hora quando o filho já morreu', async () => {
    const started = Date.now();
    expect(await waitForInstance(tmp(), 5000, { giveUp: () => true })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('appendShellLog (fila assíncrona + rotação)', () => {
  it('grava as linhas na ordem, com timestamp, e cria a pasta', async () => {
    const path = join(tmp(), 'logs', 'shell.log');

    appendShellLog(path, '[shell] primeira');
    appendShellLog(path, '[shell] segunda');
    await flushShellLog();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[shell] primeira');
    expect(lines[1]).toContain('[shell] segunda');
    // ISO na frente de cada linha.
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('não bloqueia quem chama: a escrita só acontece no flush', async () => {
    const path = join(tmp(), 'shell.log');
    appendShellLog(path, '[shell] depois');
    expect(existsSync(path)).toBe(false);
    await flushShellLog();
    expect(readFileSync(path, 'utf8')).toContain('[shell] depois');
  });

  it('passando do teto, renomeia pra shell.log.1 e recomeça', async () => {
    const path = join(tmp(), 'shell.log');
    const gordo = 'x'.repeat(480);

    appendShellLog(path, gordo, 500);
    await flushShellLog();
    appendShellLog(path, '[shell] depois da rotação', 500);
    await flushShellLog();

    expect(readFileSync(`${path}.1`, 'utf8')).toContain(gordo);
    const atual = readFileSync(path, 'utf8');
    expect(atual).toContain('[shell] depois da rotação');
    expect(atual).not.toContain(gordo);
  });

  it('caminho impossível não lança nem trava a fila', async () => {
    const impossible = join(tmp(), 'shell.log', 'nao', 'da', 'shell.log');
    writeFileSync(join(dirname(dirname(dirname(impossible)))), '');
    appendShellLog(impossible, '[shell] some');
    await expect(flushShellLog()).resolves.toBeUndefined();

    // A fila continua funcionando pro próximo caminho válido.
    const ok = join(tmp(), 'shell.log');
    appendShellLog(ok, '[shell] segue');
    await flushShellLog();
    expect(readFileSync(ok, 'utf8')).toContain('[shell] segue');
  });
});

describe('resolveRepoRoot', () => {
  it('sobe três níveis a partir de packages/shell/dist', () => {
    expect(resolveRepoRoot(resolve('C:/projetos/bridge/packages/shell/dist'))).toBe(resolve('C:/projetos/bridge'));
  });
});

describe('defaultCoreArgs', () => {
  it('roda o index.ts do core pelo tsx da raiz do monorepo', () => {
    const root = resolve('C:/projetos/bridge');
    expect(defaultCoreArgs(root)).toEqual([
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'packages', 'core', 'src', 'index.ts'),
    ]);
  });
});

describe('resolveCoreLaunch', () => {
  const repoRoot = resolve('C:/projetos/bridge');
  const resourcesPath = resolve('C:/Program Files/Bridge/resources');

  it('em dev roda o TypeScript pelo tsx, com a UI do build do Vite no repo', () => {
    const launch = resolveCoreLaunch({ isPackaged: false, resourcesPath, repoRoot });
    expect(launch.args).toEqual(defaultCoreArgs(repoRoot));
    expect(launch.cwd).toBe(repoRoot);
    expect(launch.uiDir).toBe(join(repoRoot, 'packages', 'ui', 'dist'));
  });

  it('empacotado roda o dist/index.mjs dos resources — sem tsx e sem o repo', () => {
    const launch = resolveCoreLaunch({ isPackaged: true, resourcesPath, repoRoot });
    expect(launch.args).toEqual([join(resourcesPath, 'core', 'dist', 'index.mjs')]);
    expect(launch.cwd).toBe(join(resourcesPath, 'core'));
    expect(launch.uiDir).toBe(join(resourcesPath, 'ui'));
    // A regressão que importa: nada do lançamento empacotado pode citar o
    // checkout nem o tsx, senão o app instalado depende da máquina de quem buildou.
    const mentions = [...launch.args, launch.cwd, launch.uiDir].join(' ');
    expect(mentions).not.toContain('tsx');
    expect(mentions).not.toContain(repoRoot);
  });

  it('empacotado não vaza nada do repo mesmo quando repoRoot vem absurdo', () => {
    const launch = resolveCoreLaunch({ isPackaged: true, resourcesPath, repoRoot: 'Z:/nao/existe' });
    expect(launch.args).toEqual([join(resourcesPath, 'core', 'dist', 'index.mjs')]);
    expect(launch.uiDir).toBe(join(resourcesPath, 'ui'));
  });
});
