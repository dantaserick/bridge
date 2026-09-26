import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PLAIN_EVENTS,
  CLAUDE_TOOL_EVENTS,
  buildClaudeSettings,
  claudeAdapter,
  hookCommand,
  resolveClaudeBin,
} from '../src/adapters/claude.js';
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

describe('hookCommand', () => {
  it('usa process.execPath e o shim, termina em "<sid> <event>"', () => {
    const cmd = hookCommand(ctx.shimPath, ctx.sessionId, 'PreToolUse');
    expect(cmd).toContain(process.execPath);
    expect(cmd).toContain(ctx.shimPath);
    expect(cmd.endsWith(`${ctx.sessionId} PreToolUse`)).toBe(true);
  });
});

describe('buildClaudeSettings', () => {
  const settings = buildClaudeSettings(ctx) as any;

  it('uma entrada por evento plain, sem matcher', () => {
    for (const event of CLAUDE_PLAIN_EVENTS) {
      const arr = settings.hooks[event];
      expect(arr).toHaveLength(1);
      expect(arr[0].matcher).toBeUndefined();
      expect(arr[0].hooks[0].type).toBe('command');
      expect(arr[0].hooks[0].command).toContain(ctx.sessionId);
      expect(arr[0].hooks[0].command).toContain(event);
    }
  });

  it('uma entrada por evento de tool, com matcher *', () => {
    for (const event of CLAUDE_TOOL_EVENTS) {
      const arr = settings.hooks[event];
      expect(arr).toHaveLength(1);
      expect(arr[0].matcher).toBe('*');
      expect(arr[0].hooks[0].type).toBe('command');
      expect(arr[0].hooks[0].command).toContain(event);
    }
  });

  it('statusLine.command termina em StatusLine', () => {
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.command.endsWith('StatusLine')).toBe(true);
  });
});

describe('claudeAdapter.launch', () => {
  it('devolve --settings <sessionDir>\\settings.json, --model só quando informado, files[0].content é JSON válido', () => {
    const spec = claudeAdapter.launch(ctx);
    const settingsIdx = spec.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const settingsPath = spec.args[settingsIdx + 1];
    expect(settingsPath).toBe(`${ctx.sessionDir}\\settings.json`);
    expect(spec.args).not.toContain('--model');
    expect(spec.files).toHaveLength(1);
    expect(spec.files[0]!.path).toBe(settingsPath);
    expect(() => JSON.parse(spec.files[0]!.content)).not.toThrow();

    const withModel = claudeAdapter.launch({ ...ctx, model: 'opus' });
    expect(withModel.args).toContain('--model');
    expect(withModel.args[withModel.args.indexOf('--model') + 1]).toBe('opus');
  });

  it('sem resume, nenhum --resume e nenhum --continue nos args', () => {
    const spec = claudeAdapter.launch(ctx);
    expect(spec.args).not.toContain('--resume');
    // Nada de fallback pro `--continue`: com dois Claudes na mesma pasta ele é
    // ambíguo e retomaria a conversa do painel errado.
    expect(spec.args).not.toContain('--continue');
  });

  it('com resume, --resume <id> vem depois do --settings (e convive com --model)', () => {
    const id = '9f1a2b3c-0000-4444-8888-aaaabbbbcccc';
    const spec = claudeAdapter.launch({ ...ctx, resume: id, model: 'opus' });

    const settingsIdx = spec.args.indexOf('--settings');
    const resumeIdx = spec.args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(settingsIdx);
    expect(spec.args[resumeIdx + 1]).toBe(id);
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('opus');
    expect(spec.args).toEqual(['--settings', `${ctx.sessionDir}\\settings.json`, '--resume', id, '--model', 'opus']);
  });
});

describe('resolveClaudeBin', () => {
  it('resolve para um .cmd nesta máquina (claude instalado)', () => {
    expect(resolveClaudeBin().toLowerCase().endsWith('.cmd')).toBe(true);
  });
});

describe('claudeAdapter.available', () => {
  it.skipIf(!process.env.BRIDGE_REAL_CLAUDE)('resolve ok:true com version contendo dígitos', async () => {
    const res = await claudeAdapter.available('pt-BR');
    expect(res.ok).toBe(true);
    expect(res.version).toMatch(/\d/);
  });
});
