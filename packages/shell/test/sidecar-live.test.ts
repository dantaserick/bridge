import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { t } from '@bridge/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import {
  currentInstance,
  defaultCoreArgs,
  FATAL_NO_NODE,
  FATAL_START,
  defaultLogPath,
  flushShellLog,
  startCore,
  stopCore,
  waitForInstance,
} from '../src/sidecar.js';
import type { Instance } from '../src/sidecar.js';

/**
 * Sobe o core DE VERDADE como processo filho (é o que o Electron faz) e mata.
 * Fica fora de `sidecar.test.ts` porque leva segundos e depende do tsx da raiz.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function tmp(prefix: string): string {
  return tmpDir(prefix);
}

/** Espera uma condição virar verdadeira, com prazo. */
function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = (): void => {
      if (check()) return res();
      if (Date.now() > deadline) return rej(new Error('waitFor: prazo esgotado'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('startCore/stopCore com o core real', () => {
  afterEach(async () => {
    await stopCore(2000);
  });

  it('sobe o core, serve a UI estática e encerra o processo filho no stop', async () => {
    const profileDir = tmp('bridge-sidecar-');
    // Porta 0 = o SO escolhe; assim o teste não briga com um Bridge de pé.
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    const uiDir = tmp('bridge-sidecar-ui-');
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Bridge</title><div id="root"></div>', 'utf8');

    const { port, token, child } = await startCore({
      profileDir,
      uiDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    expect(port).toBeGreaterThan(0);
    expect(token).toHaveLength(64);
    expect(child?.pid).toBeDefined();

    const html = await fetch(`http://127.0.0.1:${port}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<div id="root"></div>');

    const semToken = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(semToken.status).toBe(401);

    const comToken = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(comToken.status).toBe(200);

    await stopCore(5000);
    expect(alive(child!.pid!)).toBe(false);

    const log = readFileSync(defaultLogPath(profileDir), 'utf8');
    expect(log).toContain('[shell] subindo o core');
    expect(log).toContain('[shell] core no ar');
    expect(log).toContain('[shell] core encerrado');
  }, 60_000);

  it('reinicia UMA vez quando o core cai na largada e desiste na segunda', async () => {
    const profileDir = tmp('bridge-sidecar-');
    // "Core" de mentira: escreve o instance.json e cai com código 1 logo depois.
    const fake = [
      '-e',
      "const fs=require('fs'),p=require('path');const d=process.env.BRIDGE_PROFILE_DIR;" +
        "fs.writeFileSync(p.join(d,'instance.json'),JSON.stringify({port:1234,token:'t',pid:process.pid,startedAt:Date.now()}));" +
        'setTimeout(()=>process.exit(1),300);',
    ];

    const restarts: number[] = [];
    const exits: (string | undefined)[] = [];
    const desistiu = new Promise<void>((resolve) => {
      void startCore({
        profileDir,
        node: process.execPath,
        coreEntry: fake,
        timeoutMs: 5000,
        onRestarted: (inst) => restarts.push(inst.pid),
        onExit: (info) => {
          exits.push(info.fatal);
          if (!info.restarting) resolve();
        },
      });
    });

    await desistiu;
    expect(restarts).toHaveLength(1);
    // Primeira queda: só avisa que vai tentar de novo. Segunda: mensagem fatal.
    // `fatal` é uma CHAVE de catálogo desde a Task 4 — quem a traduz é o
    // `main.ts`, com o idioma que ele resolveu no boot.
    expect(exits).toEqual([undefined, FATAL_START]);
  }, 30_000);

  /**
   * R4 — o `stopCore` tenta `POST /api/shutdown` antes do `taskkill`. A prova
   * de que o caminho gracioso foi o usado: o `instance.json` some (quem apaga
   * é o `clearInstance` de dentro do `core.stop()`; o taskkill sozinho deixa
   * o arquivo pra trás) e o log traz a linha do encerramento gracioso.
   */
  it('encerra o core graciosamente: instance.json some e o log registra', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const { child } = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });
    expect(existsSync(join(profileDir, 'instance.json'))).toBe(true);

    await stopCore(5000);

    expect(existsSync(join(profileDir, 'instance.json'))).toBe(false);
    expect(alive(child!.pid!)).toBe(false);
    const log = readFileSync(defaultLogPath(profileDir), 'utf8');
    expect(log).toContain('[shell] core encerrou sozinho (POST /api/shutdown)');
    expect(log).not.toContain('taskkill');
  }, 60_000);

  /**
   * R2 — core órfão de uma janela fechada à força. Com o pid VIVO e a API
   * respondendo, o shell adota em vez de matar e subir outro: é o "fechei a
   * janela mas os agentes continuaram".
   */
  it('adota um core já de pé no mesmo perfil, sem spawnar outro', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const stale = spawn(process.execPath, defaultCoreArgs(REPO_ROOT), {
      env: { ...process.env, BRIDGE_PROFILE_DIR: profileDir, BRIDGE_LOG_CONSOLE: '0' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const staleInstance = await waitForInstance(profileDir, 30_000);
    expect(staleInstance).not.toBeNull();

    const adopted = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    expect(adopted.child).toBeNull(); // nada foi spawnado
    expect(adopted.port).toBe(staleInstance!.port);
    expect(adopted.token).toBe(staleInstance!.token);
    expect(currentInstance()?.pid).toBe(staleInstance!.pid);
    await flushShellLog();
    expect(readFileSync(defaultLogPath(profileDir), 'utf8')).toContain('[shell] core já de pé adotado');

    // O core adotado responde de verdade, e o stop encerra ele.
    const res = await fetch(`http://127.0.0.1:${adopted.port}/api/state`, {
      headers: { authorization: `Bearer ${adopted.token}` },
    });
    expect(res.status).toBe(200);

    await stopCore(5000);
    await waitFor(() => !alive(staleInstance!.pid), 15_000);
    stale.kill();
  }, 90_000);

  /**
   * O outro lado do R2: pid vivo mas API muda (processo travado, ou um pid
   * reciclado por outro programa). Aí não dá pra adotar — mata a árvore e
   * sobe um core novo.
   */
  it('pid vivo com a API muda: mata o órfão e sobe um core novo', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    // Escreve um instance.json apontando pra uma porta que ninguém escuta e
    // fica vivo sem servir nada.
    const fake = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('fs'),p=require('path');const d=process.env.BRIDGE_PROFILE_DIR;" +
          "fs.writeFileSync(p.join(d,'instance.json'),JSON.stringify({port:1,token:'token-do-zumbi',pid:process.pid,startedAt:Date.now()}));" +
          'setInterval(()=>{},1000);',
      ],
      { env: { ...process.env, BRIDGE_PROFILE_DIR: profileDir }, stdio: 'ignore', windowsHide: true },
    );
    const zombie = await waitForInstance(profileDir, 15_000);
    expect(zombie?.token).toBe('token-do-zumbi');

    const started = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    expect(started.child).not.toBeNull();
    expect(started.token).not.toBe('token-do-zumbi');
    expect(started.port).toBeGreaterThan(1);
    await waitFor(() => !alive(zombie!.pid), 15_000);
    await flushShellLog();
    expect(readFileSync(defaultLogPath(profileDir), 'utf8')).toContain('[shell] core órfão não responde');
    fake.kill();
  }, 90_000);

  /**
   * Higiene da Fase 3 — o core ADOTADO não é filho deste processo, então não
   * existe `exit` pra observar: se ele morrer, o app ficava com uma janela
   * apontando pra uma porta morta e nenhum restart. `watchAdopted` cobre isso
   * batendo em `GET /api/state`; 3 falhas seguidas caem no mesmo caminho do
   * `watchExit` (restart uma vez, depois fatal).
   */
  it('core adotado que morre cai no restart automático (mesmo caminho do watchExit)', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const stale = spawn(process.execPath, defaultCoreArgs(REPO_ROOT), {
      env: { ...process.env, BRIDGE_PROFILE_DIR: profileDir, BRIDGE_LOG_CONSOLE: '0' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const staleInstance = await waitForInstance(profileDir, 30_000);
    expect(staleInstance).not.toBeNull();

    const restarts: Instance[] = [];
    const adopted = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
      // 5 s × 3 no uso real; aqui o teste não pode levar 15 s pra provar isso.
      adoptedPollMs: 200,
      onRestarted: (inst) => restarts.push(inst),
    });
    expect(adopted.child).toBeNull();

    // Mata o core adotado por baixo do shell (janela do usuário continua aberta).
    process.kill(staleInstance!.pid);

    await waitFor(() => restarts.length === 1, 60_000);
    const next = restarts[0]!;
    expect(next.port).not.toBe(staleInstance!.port);
    expect(next.token).not.toBe(staleInstance!.token);
    expect(currentInstance()?.port).toBe(next.port);

    // E o core novo responde de verdade.
    const res = await fetch(`http://127.0.0.1:${next.port}/api/state`, {
      headers: { authorization: `Bearer ${next.token}` },
    });
    expect(res.status).toBe(200);

    await flushShellLog();
    expect(readFileSync(defaultLogPath(profileDir), 'utf8')).toContain('[shell] core adotado parou de responder');
    stale.kill();
  }, 120_000);

  /**
   * O `dev:core` do desenvolvedor sobe sem `BRIDGE_UI_DIR`: responder a API não
   * basta pra ser adotado pelo app instalado, senão a janela abre num core que
   * devolve 404 em `/` — tela branca.
   */
  it('core vivo que não serve a UI é morto e respawnado quando o shell espera UI', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');
    const uiDir = tmp('bridge-sidecar-ui-');
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Bridge</title><div id="root"></div>', 'utf8');

    // Sem BRIDGE_UI_DIR de propósito: é o `npm run dev:core`.
    const stale = spawn(process.execPath, defaultCoreArgs(REPO_ROOT), {
      env: { ...process.env, BRIDGE_PROFILE_DIR: profileDir, BRIDGE_LOG_CONSOLE: '0', BRIDGE_UI_DIR: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const staleInstance = await waitForInstance(profileDir, 30_000);
    expect(staleInstance).not.toBeNull();
    expect((await fetch(`http://127.0.0.1:${staleInstance!.port}/`)).status).not.toBe(200);

    const started = await startCore({
      profileDir,
      uiDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    expect(started.child).not.toBeNull(); // spawnou outro em vez de adotar
    expect(started.token).not.toBe(staleInstance!.token);
    await waitFor(() => !alive(staleInstance!.pid), 20_000);

    const html = await fetch(`http://127.0.0.1:${started.port}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<div id="root"></div>');

    await flushShellLog();
    expect(readFileSync(defaultLogPath(profileDir), 'utf8')).toContain('[shell] core de pé não serve a UI');
    stale.kill();
  }, 120_000);

  /** Sem `uiDir` (o `npm run dev:app`, com a página vindo do Vite) a exigência não vale. */
  it('sem uiDir, adota o core mesmo sem UI servida', async () => {
    const profileDir = tmp('bridge-sidecar-');
    writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ port: 0 }), 'utf8');

    const stale = spawn(process.execPath, defaultCoreArgs(REPO_ROOT), {
      env: { ...process.env, BRIDGE_PROFILE_DIR: profileDir, BRIDGE_LOG_CONSOLE: '0', BRIDGE_UI_DIR: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const staleInstance = await waitForInstance(profileDir, 30_000);

    const adopted = await startCore({
      profileDir,
      node: process.execPath,
      coreEntry: defaultCoreArgs(REPO_ROOT),
    });

    expect(adopted.child).toBeNull();
    expect(adopted.token).toBe(staleInstance!.token);
    stale.kill();
  }, 120_000);

  /**
   * O `CoreStartError` carrega a CHAVE de catálogo, não a frase: este módulo
   * não fala com o core e não importa `electron`, então ele não tem idioma —
   * quem traduz é o `main.ts`, no instante de abrir o diálogo. A chave é
   * também o que aparece no `shell.log`, e `shell.fatal.semNode` diz mais, pra
   * quem dá suporte, do que a frase no idioma de quem reportou.
   */
  it('desiste com a chave de "falta o Node" quando o comando do Node não existe', async () => {
    const profileDir = tmp('bridge-sidecar-');
    await expect(
      startCore({
        profileDir,
        node: 'node-que-nao-existe-no-path',
        coreEntry: defaultCoreArgs(REPO_ROOT),
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(FATAL_NO_NODE);
    expect(t('pt-BR', FATAL_NO_NODE)).toBe('Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=<caminho>)');
  }, 30_000);
});
