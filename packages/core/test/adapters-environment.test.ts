import { describe, expect, it } from 'vitest';
import { WSL_AGENT_COMMAND, buildClaudeSettings, claudeAdapter, hookCommand } from '../src/adapters/claude.js';
import { WSL_HOSTED_SHELL_COMMAND } from '../src/adapters/hosted.js';
import { WSL_SHARED_ENV, WSL_SHELL_COMMAND, baseEnv, mergeWslEnv, shellLaunch } from '../src/adapters/shell.js';
import type { EnvContext } from '../src/environments.js';
import type { LaunchCtx } from '../src/adapters/types.js';

/**
 * Dor verificada #2 — a MONTAGEM do comando, dos dois lados da fronteira.
 *
 * Nada aqui spawna: o `EnvContext` já vem resolvido (é o que o
 * `resolveEnvContext` produz, testado em `environments.test.ts` contra um
 * `wsl.exe` de mentira). O que se prova aqui é o argv exato — inclusive com
 * espaço e acento no caminho, que é o cenário real de `C:\Meus Projetos`.
 */

/**
 * O ambiente JÁ resolvido de uma sessão WSL. Repare no que NÃO existe aqui: um
 * caminho POSIX pro shim. O shim é aberto pelo `node.exe` do Windows, e o
 * interop não traduz argv — quem vai pro comando de hook é `ctx.shimPath`, em
 * forma de Windows.
 */
const wslCtx: EnvContext = {
  kind: 'wsl',
  distro: 'Ubuntu-22.04',
  cwdUnix: '/mnt/c/Meus Projetos/app',
  sessionDirUnix: '/mnt/c/perfil/sessions/sess_abc123',
  nodeCommand: '/mnt/c/Program Files/nodejs/node.exe',
};

function ctxWith(environment?: EnvContext): LaunchCtx {
  return {
    sessionId: 'sess_abc123',
    cwd: 'C:\\Meus Projetos\\app',
    sessionDir: 'C:\\perfil\\sessions\\sess_abc123',
    port: 4560,
    token: 'tok123',
    shimPath: 'C:\\Bridge\\core\\bin\\bridge-hook.cjs',
    cols: 80,
    rows: 24,
    environment,
  };
}

describe('shellLaunch — WSL', () => {
  it('sobe `wsl.exe -d <distro> --cd <caminho traduzido> -- sh -lc <$SHELL>`', () => {
    const spec = shellLaunch('wsl', ctxWith(wslCtx));
    expect(spec.bin).toBe('wsl.exe');
    expect(spec.args).toEqual([
      '-d',
      'Ubuntu-22.04',
      '--cd',
      '/mnt/c/Meus Projetos/app',
      '--',
      'sh',
      '-lc',
      WSL_SHELL_COMMAND,
    ]);
    // O caminho com espaço é UM argumento: nada foi para uma linha de shell.
    expect(spec.args[3]).toBe('/mnt/c/Meus Projetos/app');
  });

  it('o comando do shell usa o `$SHELL` da distro, não um bash fixo', () => {
    expect(WSL_SHELL_COMMAND).toContain('${SHELL');
    expect(WSL_SHELL_COMMAND.startsWith('exec ')).toBe(true);
  });

  it('sem distro ou sem caminho traduzido, recusa em vez de subir na pasta errada', () => {
    expect(() => shellLaunch('wsl', ctxWith({ kind: 'wsl', distro: 'Ubuntu' }))).toThrow(/traduzido/);
    expect(() => shellLaunch('wsl', ctxWith(undefined))).toThrow(/WSL/);
  });

  /**
   * 0.12.0 — a mesma sessão WSL, agora hospedando o Claude Code do shell. O
   * que muda é SÓ a linha do `sh -lc`: o `--cd`, o argv e a fronteira
   * Windows→WSL continuam exatamente como estão testados acima.
   */
  it('hospedada, o `sh -lc` põe o bin da sessão na frente do PATH da distro', () => {
    const ctx = { ...ctxWith(wslCtx), hosted: { target: { cmd: 'C:\\npm\\claude.cmd' } } };
    const spec = shellLaunch('wsl', ctx);
    expect(spec.args.at(-1)).toBe(WSL_HOSTED_SHELL_COMMAND('/mnt/c/perfil/sessions/sess_abc123/bin'));
    expect(spec.args.slice(0, 7)).toEqual([
      '-d',
      'Ubuntu-22.04',
      '--cd',
      '/mnt/c/Meus Projetos/app',
      '--',
      'sh',
      '-lc',
    ]);
    expect(spec.files.map((f) => f.path)).toEqual([
      'C:\\perfil\\sessions\\sess_abc123\\settings.json',
      'C:\\perfil\\sessions\\sess_abc123\\bin\\claude',
    ]);
  });

  it('os ambientes do Windows seguem exatamente como antes', () => {
    expect(shellLaunch('pwsh', ctxWith({ kind: 'pwsh' }))).toMatchObject({ bin: 'pwsh.exe', args: ['-NoLogo'] });
    expect(shellLaunch('gitbash', ctxWith({ kind: 'gitbash' })).args).toEqual(['--login', '-i']);
  });
});

describe('baseEnv — a travessia Windows → WSL', () => {
  it('sem ambiente WSL, a WSLENV do processo passa INTACTA e o shim fica no caminho do Windows', () => {
    const env = baseEnv(ctxWith({ kind: 'pwsh' }));
    expect(env.BRIDGE_SHIM).toBe('C:\\Bridge\\core\\bin\\bridge-hook.cjs');
    // Fora do WSL o Bridge não tem o que compartilhar e não toca no campo. (A
    // máquina do teste pode já ter uma `WSLENV` — o Windows Terminal põe uma.)
    expect(env.WSLENV).toBe(process.env.WSLENV);
    if (env.WSLENV !== undefined) expect(env.WSLENV.split(':')).not.toContain('BRIDGE_TOKEN');
  });

  it('em WSL, `WSLENV` compartilha porta/token/sessão/shim — e o shim segue em forma de WINDOWS', () => {
    const env = baseEnv(ctxWith(wslCtx));
    // Quem vai abrir esse arquivo é o `node.exe` do Windows, por interop: um
    // `/mnt/c/...` chegaria lá como caminho inexistente.
    expect(env.BRIDGE_SHIM).toBe('C:\\Bridge\\core\\bin\\bridge-hook.cjs');
    for (const name of WSL_SHARED_ENV) expect(env.WSLENV!.split(':')).toContain(name);
    // Sem sufixo `/p`: o WSL não deve traduzir nada disso.
    expect(env.WSLENV).not.toContain('BRIDGE_SHIM/p');
    expect(env.BRIDGE_PORT).toBe('4560');
    expect(env.BRIDGE_TOKEN).toBe('tok123');
  });

  it('mergeWslEnv preserva a WSLENV que o usuário já tinha e não duplica', () => {
    expect(mergeWslEnv('MINHA_VAR/p', ['BRIDGE_PORT'])).toBe('MINHA_VAR/p:BRIDGE_PORT');
    expect(mergeWslEnv('BRIDGE_PORT', ['BRIDGE_PORT'])).toBe('BRIDGE_PORT');
    expect(mergeWslEnv(undefined, ['A', 'B'])).toBe('A:B');
    // Nome com sufixo de tradução já presente conta como o mesmo nome.
    expect(mergeWslEnv('BRIDGE_SHIM/p', ['BRIDGE_SHIM'])).toBe('BRIDGE_SHIM/p');
  });
});

describe('hookCommand', () => {
  it('Windows: node.exe do processo, aspas duplas', () => {
    const cmd = hookCommand('C:\\shim.cjs', 'sess_1', 'Stop');
    expect(cmd).toContain(process.execPath);
    expect(cmd.endsWith('sess_1 Stop')).toBe(true);
  });

  /**
   * A regra do fix round 1, e o detalhe que mais engana: dentro da distro o
   * NODE é referido por `/mnt/c` (quem o localiza é o kernel do WSL), mas o
   * SHIM vai no caminho do Windows — quem lê esse argumento é o `node.exe`, e
   * o interop repassa argv sem traduzir.
   */
  it('WSL: node.exe do Windows por /mnt/c, shim no caminho do WINDOWS', () => {
    const cmd = hookCommand('C:\\Bridge\\core\\bin\\bridge-hook.cjs', 'sess_1', 'Stop', wslCtx);
    expect(cmd).toBe(
      `'/mnt/c/Program Files/nodejs/node.exe' 'C:\\Bridge\\core\\bin\\bridge-hook.cjs' 'sess_1' 'Stop'`,
    );
    expect(cmd).not.toContain('/mnt/c/Bridge');
  });

  it('WSL: o espaço de "Program Files" e a barra invertida do shim ficam protegidos', () => {
    const cmd = hookCommand('C:\\Meus Arquivos\\shim.cjs', 'sess_1', 'StatusLine', wslCtx);
    expect(cmd).toBe(
      `'/mnt/c/Program Files/nodejs/node.exe' 'C:\\Meus Arquivos\\shim.cjs' 'sess_1' 'StatusLine'`,
    );
  });

  it('WSL: sessionId e evento também vão citados', () => {
    const cmd = hookCommand('C:\\shim.cjs', 'sess_abc', 'PreToolUse', wslCtx);
    expect(cmd.endsWith(`'sess_abc' 'PreToolUse'`)).toBe(true);
  });

  it('sem `nodeCommand` resolvido, cai na linha do Windows em vez de montar meia linha', () => {
    const cmd = hookCommand('C:\\shim.cjs', 'sess_1', 'Stop', { kind: 'wsl', distro: 'Ubuntu' });
    expect(cmd).toContain(process.execPath);
  });
});

describe('buildClaudeSettings em WSL', () => {
  const settings = buildClaudeSettings(ctxWith(wslCtx)) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    statusLine: { command: string };
  };

  it('todo hook roda o shim (caminho do Windows) pelo node.exe do Windows', () => {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const command = entries[0]!.hooks[0]!.command;
      expect(command, event).toContain(`'/mnt/c/Program Files/nodejs/node.exe'`);
      expect(command, event).toContain(`'C:\\Bridge\\core\\bin\\bridge-hook.cjs'`);
      // Nunca o node da distro, e nunca o shim traduzido.
      expect(command, event).not.toContain(`'node'`);
      expect(command, event).not.toContain('/mnt/c/Bridge');
    }
  });

  it('a statusline segue a mesma regra', () => {
    expect(settings.statusLine.command).toContain(`'/mnt/c/Program Files/nodejs/node.exe'`);
    expect(settings.statusLine.command.endsWith(`'StatusLine'`)).toBe(true);
  });
});

describe('claudeAdapter.launch em WSL', () => {
  it('sobe `claude` pelo login shell da distro, com o --settings em caminho POSIX', () => {
    const spec = claudeAdapter.launch(ctxWith(wslCtx));
    expect(spec.bin).toBe('wsl.exe');
    expect(spec.args).toEqual([
      '-d',
      'Ubuntu-22.04',
      '--cd',
      '/mnt/c/Meus Projetos/app',
      '--',
      'sh',
      '-lc',
      WSL_AGENT_COMMAND,
      'claude',
      '--settings',
      '/mnt/c/perfil/sessions/sess_abc123/settings.json',
    ]);
  });

  it('o arquivo de settings continua sendo ESCRITO no caminho do Windows', () => {
    const spec = claudeAdapter.launch(ctxWith(wslCtx));
    expect(spec.files).toHaveLength(1);
    expect(spec.files[0]!.path).toBe('C:\\perfil\\sessions\\sess_abc123\\settings.json');
  });

  it('`--resume` e `--model` entram depois do --settings, dentro da distro', () => {
    const spec = claudeAdapter.launch({ ...ctxWith(wslCtx), resume: 'abc123', model: 'opus' });
    expect(spec.args.slice(-6)).toEqual([
      '--settings',
      '/mnt/c/perfil/sessions/sess_abc123/settings.json',
      '--resume',
      'abc123',
      '--model',
      'opus',
    ]);
  });

  it('sem ambiente, o lançamento é o de sempre (binário do Windows, caminho do Windows)', () => {
    const spec = claudeAdapter.launch(ctxWith(undefined));
    expect(spec.bin).not.toBe('wsl.exe');
    expect(spec.args[0]).toBe('--settings');
    expect(spec.args[1]).toBe('C:\\perfil\\sessions\\sess_abc123\\settings.json');
  });
});
