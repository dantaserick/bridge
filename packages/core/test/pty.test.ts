import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import type { BridgeEvent } from '../src/events.js';
import { PtyHost, SCROLLBACK_BYTES, Scrollback, resolveSpawn } from '../src/pty.js';
import { Sessions } from '../src/sessions.js';
import type { LaunchSpec } from '../src/adapters/types.js';
import type { OscNotification } from '../src/osc.js';

function shellExe(): string {
  try {
    execFileSync('where.exe', ['pwsh'], { timeout: 3000 });
    return 'pwsh.exe';
  } catch {
    return 'powershell.exe';
  }
}

const SHELL = shellExe();

function spec(args: string[]): LaunchSpec {
  return { bin: SHELL, args, env: { ...process.env } as Record<string, string>, files: [] };
}

describe('resolveSpawn', () => {
  it('.cmd vira cmd.exe /c <bin> <args>', () => {
    const result = resolveSpawn({ bin: 'claude.cmd', args: ['--settings', 'x'], env: {}, files: [] });
    expect(result).toEqual({ file: 'cmd.exe', args: ['/c', 'claude.cmd', '--settings', 'x'] });
  });

  it('.CMD (maiúsculo) também vira cmd.exe /c', () => {
    const result = resolveSpawn({ bin: 'foo.CMD', args: ['a'], env: {}, files: [] });
    expect(result).toEqual({ file: 'cmd.exe', args: ['/c', 'foo.CMD', 'a'] });
  });

  it('.bat também vira cmd.exe /c', () => {
    const result = resolveSpawn({ bin: 'run.bat', args: [], env: {}, files: [] });
    expect(result).toEqual({ file: 'cmd.exe', args: ['/c', 'run.bat'] });
  });

  it('bin normal fica inalterado', () => {
    const result = resolveSpawn({ bin: 'pwsh.exe', args: ['-NoLogo'], env: {}, files: [] });
    expect(result).toEqual({ file: 'pwsh.exe', args: ['-NoLogo'] });
  });
});

describe('Scrollback (buffer por chunks, sem O(n) por chunk nem corte no meio de UTF-8)', () => {
  it('acumula na ordem e devolve o texto inteiro enquanto cabe', () => {
    const sb = new Scrollback(1024);
    sb.push('um ');
    sb.push('dois ');
    sb.push('três');
    expect(sb.text()).toBe('um dois três');
    expect(sb.bytes).toBe(Buffer.byteLength('um dois três', 'utf8'));
  });

  it('empurrando 3× o limite: fica ≤ limite, o fim é preservado e o começo sumiu', () => {
    const cap = 1000;
    const sb = new Scrollback(cap);
    const chunkSize = 10;
    const total = cap * 3;
    for (let i = 0; i < total / chunkSize; i++) {
      sb.push(String(i % 10).repeat(chunkSize));
    }
    sb.push('FIM-DA-SAIDA');

    expect(sb.bytes).toBeLessThanOrEqual(cap);
    expect(sb.text().length).toBeLessThanOrEqual(cap);
    expect(sb.text().endsWith('FIM-DA-SAIDA')).toBe(true);
  });

  it('não parte caracteres multibyte: os chunks saem inteiros', () => {
    const sb = new Scrollback(12);
    sb.push('áéíóú');
    sb.push('çãõ');
    sb.push('ok');
    // Nenhum U+FFFD: o corte é por chunk inteiro, nunca no meio de um code point.
    expect(sb.text()).not.toContain('�');
    expect(sb.text().endsWith('ok')).toBe(true);
  });

  it('nunca zera: o último chunk sobrevive mesmo maior que o teto', () => {
    const sb = new Scrollback(4);
    sb.push('a'.repeat(50));
    expect(sb.text()).toBe('a'.repeat(50));
  });

  it('o default do PtyHost é o SCROLLBACK_BYTES exportado', () => {
    expect(SCROLLBACK_BYTES).toBe(512 * 1024);
    expect(new Scrollback().cap).toBe(SCROLLBACK_BYTES);
  });
});

describe('PtyHost (integração real com pwsh/powershell)', () => {
  let host: PtyHost | undefined;
  const spawned: string[] = [];

  afterEach(async () => {
    if (host) {
      for (const id of [...spawned]) {
        if (host.alive(id)) await host.kill(id);
      }
    }
    spawned.length = 0;
    host = undefined;
  });

  function setup() {
    const bus = new EventBus();
    const events: BridgeEvent[] = [];
    bus.on((e) => events.push(e));
    const sessions = new Sessions(bus);
    host = new PtyHost(bus, sessions);
    return { bus, events, sessions, host };
  }

  it('spawn roda um comando, emite pty.data e pty.exit com o código de saída; sessão fica exited', async () => {
    const { events, sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    const { pid } = host.spawn(session.id, spec(['-NoLogo', '-Command', 'Write-Output ok-bridge; exit 3']), {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    expect(pid).toBeGreaterThan(0);

    await vi_waitFor(() => events.some((e) => e.type === 'pty.exit'), 10000);

    const dataEvents = events.filter((e): e is Extract<BridgeEvent, { type: 'pty.data' }> => e.type === 'pty.data');
    expect(dataEvents.some((e) => e.data.includes('ok-bridge'))).toBe(true);

    const exitEvent = events.find((e) => e.type === 'pty.exit');
    expect(exitEvent).toEqual({ type: 'pty.exit', sessionId: session.id, exitCode: 3 });

    expect(sessions.get(session.id)?.state).toBe('exited');
    expect(sessions.get(session.id)?.exitCode).toBe(3);
    expect(host.alive(session.id)).toBe(false);
  }, 15000);

  it('write manda entrada pro pty interativo e scrollback acumula a saída; kill resolve com sessão exited', async () => {
    const { events, sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    host.spawn(session.id, spec(['-NoLogo', '-NoExit', '-Command', '-']), { cwd: process.cwd(), cols: 80, rows: 24 });
    await vi_waitFor(() => host.scrollback(session.id).length > 0, 5000);

    host.write(session.id, 'echo hi\r');
    await vi_waitFor(() => host.scrollback(session.id).includes('hi'), 8000);

    expect(host.scrollback(session.id)).toContain('hi');

    await host.kill(session.id);
    expect(sessions.get(session.id)?.state).toBe('exited');
    expect(host.alive(session.id)).toBe(false);
    expect(events.some((e) => e.type === 'pty.exit')).toBe(true);
  }, 20000);

  it('scrollback sobrevive ao exit (o painel fica aberto, R1) e só some com sessions.remove', async () => {
    const { events, sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    host.spawn(session.id, spec(['-NoLogo', '-Command', 'Write-Output marca-de-saida; exit 0']), {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });

    await vi_waitFor(() => events.some((e) => e.type === 'pty.exit'), 10000);
    expect(host.alive(session.id)).toBe(false);
    expect(sessions.get(session.id)?.state).toBe('exited');

    // Sem isso, a UI refazia o scrollback na reconexão do WS e apagava a tela
    // de uma sessão morta — o oposto do "painel fica aberto com a saída".
    expect(host.scrollback(session.id)).toContain('marca-de-saida');

    sessions.remove(session.id);
    expect(host.scrollback(session.id)).toBe('');
  }, 15000);

  it('respawn no mesmo id não herda o scrollback da sessão anterior', async () => {
    const { events, sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    host.spawn(session.id, spec(['-NoLogo', '-Command', 'Write-Output saida-antiga; exit 0']), {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    await vi_waitFor(() => events.some((e) => e.type === 'pty.exit'), 10000);
    expect(host.scrollback(session.id)).toContain('saida-antiga');

    host.spawn(session.id, spec(['-NoLogo', '-NoExit', '-Command', '-']), { cwd: process.cwd(), cols: 80, rows: 24 });
    expect(host.scrollback(session.id)).not.toContain('saida-antiga');

    await host.kill(session.id);
  }, 20000);

  /**
   * Minor da onda final: com o prazo do kill estourado (aqui forçado a 0 ms,
   * antes do PTY conseguir morrer), `alive()` não pode continuar dizendo que
   * a sessão está de pé — e a saída dela tem que sobreviver, como sobrevive
   * no caminho normal do `exit`.
   */
  it('kill que estoura o prazo tira a sessão de alive() e preserva o scrollback', async () => {
    const { events, sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    host.spawn(session.id, spec(['-NoLogo', '-Command', 'Write-Host marca; Start-Sleep -Seconds 30']), {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    await vi_waitFor(() => host.scrollback(session.id).includes('marca'), 15000);

    await host.kill(session.id, 0);

    // Prova de que foi o PRAZO que tirou a sessão de `alive()`: o `exit` do
    // PTY ainda não chegou (ele só vem alguns ticks depois do `child.kill()`).
    expect(events.some((e) => e.type === 'pty.exit')).toBe(false);
    expect(host.alive(session.id)).toBe(false);
    expect(host.scrollback(session.id)).toContain('marca');

    // O exit de verdade chega depois e ainda tem que marcar a sessão.
    await vi_waitFor(() => events.some((e) => e.type === 'pty.exit'), 15000);
    expect(sessions.get(session.id)?.state).toBe('exited');
    expect(host.scrollback(session.id)).toContain('marca');
  }, 30000);

  it('kill em sessão desconhecida resolve imediatamente sem lançar', async () => {
    const { host } = setup();
    await expect(host.kill('nao-existe')).resolves.toBeUndefined();
  });

  it('write/resize em sessão morta ou desconhecida não lançam', () => {
    const { host } = setup();
    expect(() => host.write('nope', 'x')).not.toThrow();
    expect(() => host.resize('nope', 10, 10)).not.toThrow();
    expect(host.scrollback('nope')).toBe('');
  });

  it('onOsc dispara quando o processo imprime OSC 9', async () => {
    const { sessions, host } = setup();
    const session = sessions.create({ paneId: 'p1', workspaceId: 'w1', kind: 'shell', cwd: process.cwd() });
    spawned.push(session.id);

    const seen: OscNotification[] = [];
    host.onOsc = (_id, n) => seen.push(n);

    host.spawn(
      session.id,
      spec(['-NoLogo', '-Command', "[Console]::Write([char]27 + ']9;alerta' + [char]7)"]),
      { cwd: process.cwd(), cols: 80, rows: 24 },
    );

    await vi_waitFor(() => seen.length > 0, 10000);
    expect(seen).toEqual([{ body: 'alerta' }]);
  }, 15000);
});

function vi_waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout esperando condição'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
