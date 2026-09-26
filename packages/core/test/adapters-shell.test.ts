import { afterEach, describe, expect, it } from 'vitest';
import { baseEnv, shellLaunch } from '../src/adapters/shell.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { geminiAdapter } from '../src/adapters/gemini.js';
import { availableOnPath, findOnPath } from '../src/adapters/which.js';
import { adapters } from '../src/adapters/index.js';
import type { LaunchCtx } from '../src/adapters/types.js';

const ctx: LaunchCtx = {
  sessionId: 'sess_abc123',
  cwd: 'C:\\projetos\\x',
  sessionDir: 'C:\\projetos\\x\\.bridge\\sess_abc123',
  port: 4560,
  token: 'tok123',
  shimPath: 'C:\\projetos\\bridge\\packages\\core\\bin\\bridge-hook.cjs',
  cols: 80,
  rows: 24,
};

describe('shellLaunch', () => {
  it('pwsh', () => {
    const spec = shellLaunch('pwsh', ctx);
    expect(spec.bin).toBe('pwsh.exe');
    expect(spec.args).toEqual(['-NoLogo']);
    expect(spec.env.BRIDGE_SESSION).toBe(ctx.sessionId);
    expect(spec.env.BRIDGE_PORT).toBe('4560');
    expect(spec.env.BRIDGE_TOKEN).toBe('tok123');
    expect(spec.env.TERM).toBe('xterm-256color');
  });

  it('gitbash', () => {
    const spec = shellLaunch('gitbash', ctx);
    expect(spec.bin).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(spec.args).toEqual(['--login', '-i']);
  });

  it('powershell', () => {
    const spec = shellLaunch('powershell', ctx);
    expect(spec.bin).toBe('powershell.exe');
    expect(spec.args).toEqual(['-NoLogo']);
  });
});

describe('baseEnv — strips Claude Code nesting markers', () => {
  const prev = process.env.CLAUDE_CODE_CHILD_SESSION;

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = prev;
  });

  it('não copia CLAUDE_CODE_CHILD_SESSION quando o core roda dentro de uma sessão Claude Code', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    const env = baseEnv(ctx);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });
});

describe('baseEnv — clique do mouse no Claude Code (sessions.mouseClicks)', () => {
  it('ligado: põe CLAUDE_CODE_NO_FLICKER=true quando o dono não definiu', () => {
    const before = process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    try {
      const env = baseEnv({ ...ctx, mouseClicks: true });
      expect(env.CLAUDE_CODE_NO_FLICKER).toBe('true');
      expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.CLAUDE_CODE_NO_FLICKER = before;
    }
  });

  it('ligado: a variável do dono vence', () => {
    const before = process.env.CLAUDE_CODE_NO_FLICKER;
    process.env.CLAUDE_CODE_NO_FLICKER = 'false';
    try {
      expect(baseEnv({ ...ctx, mouseClicks: true }).CLAUDE_CODE_NO_FLICKER).toBe('false');
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER;
      else process.env.CLAUDE_CODE_NO_FLICKER = before;
    }
  });

  it('desligado: CLAUDE_CODE_DISABLE_MOUSE=1 e nada de NO_FLICKER', () => {
    const before = process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    try {
      const env = baseEnv({ ...ctx, mouseClicks: false });
      expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1');
      expect(env.CLAUDE_CODE_NO_FLICKER).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.CLAUDE_CODE_NO_FLICKER = before;
    }
  });

  it('ligado: apaga um CLAUDE_CODE_DISABLE_MOUSE herdado do ambiente', () => {
    const before = process.env.CLAUDE_CODE_DISABLE_MOUSE;
    process.env.CLAUDE_CODE_DISABLE_MOUSE = '1';
    try {
      expect(baseEnv({ ...ctx, mouseClicks: true }).CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_DISABLE_MOUSE;
      else process.env.CLAUDE_CODE_DISABLE_MOUSE = before;
    }
  });

  it('WSL: as duas variáveis entram na WSLENV', () => {
    const env = baseEnv({ ...ctx, mouseClicks: true, environment: { kind: 'wsl', distro: 'Ubuntu' } as never });
    expect(env.WSLENV).toContain('CLAUDE_CODE_NO_FLICKER');
    expect(env.WSLENV).toContain('CLAUDE_CODE_DISABLE_MOUSE');
  });

  it('ausente (ctx antigo): não toca em nenhuma das duas', () => {
    const env = baseEnv(ctx);
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined();
  });
});

describe('codexAdapter', () => {
  it('available() resolve ok:false nesta máquina (codex não instalado)', async () => {
    const res = await codexAdapter.available('pt-BR');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/não encontrado/);
  });

  it('launch() lança "não implementado"', () => {
    expect(() => codexAdapter.launch(ctx)).toThrow(/não implementado/);
  });
});

/**
 * `codex.ts` e `gemini.ts` carregavam a MESMA `findOnPath` copiada (anotado no
 * BACKLOG). Agora ela mora em `adapters/which.ts` e é o único lugar que
 * conhece o `where.exe`, o timeout e a frase de recusa.
 */
describe('findOnPath / availableOnPath (adapters/which.ts)', () => {
  it('acha um binário que existe no PATH e não acha um que não existe', async () => {
    // `cmd` está no PATH de qualquer Windows; o outro tem um nome que ninguém
    // instala por acidente.
    expect(await findOnPath('cmd')).toBe(process.platform === 'win32');
    expect(await findOnPath('bridge-binario-que-nao-existe-9f3a')).toBe(false);
  });

  it('availableOnPath monta a recusa no idioma pedido, com o nome do binário', async () => {
    expect(await availableOnPath('bridge-binario-que-nao-existe-9f3a', 'en')).toEqual({
      ok: false,
      reason: 'bridge-binario-que-nao-existe-9f3a not found on PATH',
    });
    expect(await availableOnPath('bridge-binario-que-nao-existe-9f3a', 'pt-BR')).toEqual({
      ok: false,
      reason: 'bridge-binario-que-nao-existe-9f3a não encontrado no PATH',
    });
  });

  it('gemini usa o mesmo helper e devolve a mesma forma de recusa que o codex', async () => {
    const gemini = await geminiAdapter.available('pt-BR');
    expect(gemini).toEqual({ ok: false, reason: 'gemini não encontrado no PATH' });
    expect(await codexAdapter.available('pt-BR')).toEqual({ ok: false, reason: 'codex não encontrado no PATH' });
  });
});

describe('adapters()', () => {
  it('tem as três chaves', () => {
    const all = adapters();
    expect(Object.keys(all).sort()).toEqual(['claude', 'codex', 'gemini']);
  });
});
