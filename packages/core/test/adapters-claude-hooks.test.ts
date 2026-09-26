import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import {
  claudeAdapter,
  detailDone,
  detailStuck,
  detailThinking,
  detailWaiting,
  configureClaudeAdapter,
  isHumanWait,
  summarizeTool,
} from '../src/adapters/claude.js';
import { DEFAULT_CONFIG } from '../src/profile.js';
import { isDisplaySafe } from '@bridge/shared';
import type { Session } from '../src/model.js';

/**
 * Idioma FIXO no teste (spec §13): estas asserções são sobre TEXTO, e o
 * default de `ui.language` é `'system'` — numa máquina em inglês elas
 * falhariam sem isto. O idioma da suíte é uma decisão do teste, não da
 * máquina que o roda.
 */
const PT = 'pt-BR' as const;

const fixturesDir = join(__dirname, 'fixtures', 'hooks');
function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
}

const session: Session = {
  id: 'sess_abc',
  paneId: 'pane_1',
  workspaceId: 'ws_1',
  kind: 'agent',
  agent: 'claude',
  state: 'idle',
  startedAt: 0,
  stateSince: 0,
  consecutiveBlockedStops: 0,
  cwd: 'C:\\projetos\\x',
};

describe('onHook — subagentes (12/09/2026)', () => {
  const start = { hook_event_name: 'SubagentStart', agent_id: 'agent_1', agent_type: 'general-purpose' };
  const stop = { hook_event_name: 'SubagentStop', agent_id: 'agent_1', agent_type: 'general-purpose' };
  const mainStop = { hook_event_name: 'Stop', stop_hook_active: false };

  it('SubagentStart conta e põe a sessão em running', () => {
    const out = claudeAdapter.onHook('SubagentStart', start, session, PT);
    expect(out.change).toEqual({ state: 'running', subagents: 1, detail: '1 subagente rodando' });
    const out2 = claudeAdapter.onHook('SubagentStart', start, { ...session, subagents: 1 }, PT);
    expect(out2.change).toEqual({ state: 'running', subagents: 2, detail: '2 subagentes rodando' });
  });

  it('Stop da principal com subagente vivo NÃO é done: vira "esperando", sem notificação', () => {
    const out = claudeAdapter.onHook('Stop', mainStop, { ...session, state: 'running', subagents: 1 }, PT);
    expect(out.change).toEqual({ state: 'running', detail: 'esperando 1 subagente', tool: null, awaitingSubagents: true });
    expect(out.notification).toBeUndefined();
    expect(out.blockedStop).toBeUndefined();
  });

  it('SubagentStop com outro vivo só atualiza a contagem', () => {
    const out = claudeAdapter.onHook('SubagentStop', stop, { ...session, state: 'running', subagents: 2, awaitingSubagents: true }, PT);
    expect(out.change).toEqual({ subagents: 1, detail: '1 subagente rodando' });
    expect(out.notification).toBeUndefined();
  });

  it('último SubagentStop com a principal esperando → segue running (o Claude retoma sozinho; o done vem do Stop seguinte)', () => {
    const out = claudeAdapter.onHook('SubagentStop', stop, { ...session, state: 'running', subagents: 1, awaitingSubagents: true }, PT);
    expect(out.change).toEqual({ state: 'running', subagents: 0, awaitingSubagents: false, tool: null, detail: 'subagente terminou' });
    expect(out.notification).toBeUndefined();
  });

  it('último SubagentStop com a principal ainda trabalhando: só a contagem e o detalhe', () => {
    const out = claudeAdapter.onHook('SubagentStop', stop, { ...session, state: 'running', subagents: 1 }, PT);
    expect(out.change).toEqual({ subagents: 0, detail: 'subagente terminou' });
  });

  it('Stop sem subagente vivo continua done + notificação (e limpa a espera)', () => {
    const out = claudeAdapter.onHook('Stop', mainStop, { ...session, state: 'running', subagents: 0, awaitingSubagents: true }, PT);
    expect(out.change).toEqual({ state: 'done', detail: detailDone(PT), tool: null, awaitingSubagents: false });
    expect(out.notification?.kind).toBe('done');
  });

  it('SessionStart e UserPromptSubmit zeram a contagem (caminho de reset de um SubagentStop perdido)', () => {
    const preso = { ...session, state: 'running' as const, subagents: 1, awaitingSubagents: true };
    expect(claudeAdapter.onHook('UserPromptSubmit', load('user-prompt'), preso, PT).change).toEqual({
      state: 'running', detail: detailThinking(PT), tool: null, subagents: 0, awaitingSubagents: false,
    });
    expect(claudeAdapter.onHook('SessionStart', load('session-start'), preso, PT).change).toEqual({
      state: 'idle', detail: null, tool: null, subagents: 0, awaitingSubagents: false,
    });
    // Sem nada a zerar, o change continua o de sempre (os testes antigos valem).
    expect(claudeAdapter.onHook('UserPromptSubmit', load('user-prompt'), session, PT).change).toEqual({
      state: 'running', detail: detailThinking(PT), tool: null,
    });
  });

  it('com a principal em needs-input, os eventos de subagente só mexem na contagem (a razão fica na linha)', () => {
    const esperando = { ...session, state: 'needs-input' as const, detail: 'aguardando permissão' };
    expect(claudeAdapter.onHook('SubagentStart', start, esperando, PT).change).toEqual({ subagents: 1 });
    expect(claudeAdapter.onHook('SubagentStop', stop, { ...esperando, subagents: 2 }, PT).change).toEqual({ subagents: 1 });
    expect(claudeAdapter.onHook('SubagentStop', stop, { ...esperando, subagents: 1 }, PT).change).toEqual({ subagents: 0 });
  });

  it('SubagentStop sem contagem (evento perdido) não vai pra negativo', () => {
    const out = claudeAdapter.onHook('SubagentStop', stop, session, PT);
    expect(out.change).toEqual({ subagents: 0, detail: 'subagente terminou' });
  });
});

describe('onHook', () => {
  it('SessionStart', () => {
    const out = claudeAdapter.onHook('SessionStart', load('session-start'), session, PT);
    expect(out.change).toEqual({ state: 'idle', detail: null, tool: null });
  });

  it('UserPromptSubmit', () => {
    const out = claudeAdapter.onHook('UserPromptSubmit', load('user-prompt'), session, PT);
    expect(out.change).toEqual({ state: 'running', detail: detailThinking(PT), tool: null });
  });

  it('PreToolUse (Bash)', () => {
    const out = claudeAdapter.onHook('PreToolUse', load('pre-tool-bash'), session, PT);
    expect(out.change).toEqual({ state: 'running', tool: 'Bash', detail: 'Bash · npm test -- --run' });
  });

  it('PreToolUse (Edit)', () => {
    const out = claudeAdapter.onHook('PreToolUse', load('pre-tool-edit'), session, PT);
    expect(out.change).toEqual({ state: 'running', tool: 'Edit', detail: 'Edit · app.ts' });
  });

  it('PostToolUse', () => {
    const out = claudeAdapter.onHook('PostToolUse', load('post-tool'), session, PT);
    expect(out.change).toEqual({ state: 'running', tool: null, detail: detailThinking(PT) });
  });

  it('PermissionRequest', () => {
    const out = claudeAdapter.onHook('PermissionRequest', load('permission-request'), session, PT);
    expect(out.change).toEqual({ state: 'needs-input', detail: detailWaiting(PT) });
    expect(out.notification).toEqual({ kind: 'needs-input', text: 'Permissão: Bash · rm -rf dist' });
  });

  it('Notification (permission_prompt → humano esperando)', () => {
    const out = claudeAdapter.onHook('Notification', load('notification-permission'), session, PT);
    expect(out.change).toEqual({ state: 'needs-input', detail: detailWaiting(PT) });
    expect(out.notification).toEqual({ kind: 'needs-input', text: 'Claude needs your permission to use Bash' });
  });

  it('Notification (idle_prompt → idle)', () => {
    const out = claudeAdapter.onHook('Notification', load('notification-idle'), session, PT);
    expect(out.change).toEqual({ state: 'idle' });
    expect(out.notification).toBeUndefined();
  });

  it('Stop não bloqueado', () => {
    const out = claudeAdapter.onHook('Stop', load('stop'), session, PT);
    expect(out.change).toEqual({ state: 'done', detail: detailDone(PT), tool: null });
    expect(out.notification).toEqual({ kind: 'done', text: 'Terminou o turno' });
  });

  it('Stop bloqueado', () => {
    const out = claudeAdapter.onHook('Stop', load('stop-blocked'), session, PT);
    expect(out.blockedStop).toBe(true);
    expect(out.change).toEqual({ state: 'running' });
  });

  it('SubagentStop', () => {
    const out = claudeAdapter.onHook('SubagentStop', load('subagent-stop'), session, PT);
    expect(out.change).toEqual({ subagents: 0, detail: 'subagente terminou' });
  });

  it('SessionEnd sem reason → exited', () => {
    const out = claudeAdapter.onHook('SessionEnd', { session_id: 'abc', hook_event_name: 'SessionEnd' }, session, PT);
    expect(out.change).toEqual({ state: 'exited' });
  });

  it.each(['exit', 'prompt_input_exit', 'logout'])('SessionEnd reason %s → exited', (reason) => {
    const out = claudeAdapter.onHook('SessionEnd', { hook_event_name: 'SessionEnd', reason }, session, PT);
    expect(out.change).toEqual({ state: 'exited' });
  });

  it('SessionEnd reason "clear" mantém o estado (o /clear não encerra o processo)', () => {
    const out = claudeAdapter.onHook('SessionEnd', { hook_event_name: 'SessionEnd', reason: 'clear' }, session, PT);
    expect(out.change).toBeUndefined();
    expect(out.reply).toEqual({});
  });

  it('evento desconhecido → {}', () => {
    const out = claudeAdapter.onHook('SomeOtherEvent', {}, session, PT);
    expect(out).toEqual({});
  });

  it('reply é sempre {} quando presente', () => {
    const out = claudeAdapter.onHook('UserPromptSubmit', load('user-prompt'), session, PT);
    if ('reply' in out) expect(out.reply).toEqual({});
  });
});

describe('onHook — payloads malformados', () => {
  it('PreToolUse sem tool_name string → running, tool null, pensando', () => {
    const out = claudeAdapter.onHook('PreToolUse', { hook_event_name: 'PreToolUse', tool_input: { command: 'x' } }, session, PT);
    expect(out.change).toEqual({ state: 'running', tool: null, detail: detailThinking(PT) });
  });

  it('PermissionRequest sem tool_name → notificação "Permissão solicitada"', () => {
    const out = claudeAdapter.onHook('PermissionRequest', { hook_event_name: 'PermissionRequest' }, session, PT);
    expect(out.change).toEqual({ state: 'needs-input', detail: detailWaiting(PT) });
    expect(out.notification).toEqual({ kind: 'needs-input', text: 'Permissão solicitada' });
  });

  it('Notification com message não-string → humano esperando, texto "Aguardando você"', () => {
    const out = claudeAdapter.onHook('Notification', { hook_event_name: 'Notification', message: { weird: true } }, session, PT);
    expect(out.change).toEqual({ state: 'needs-input', detail: detailWaiting(PT) });
    expect(out.notification).toEqual({ kind: 'needs-input', text: 'Aguardando você' });
  });

  it('Stop sem stop_hook_active boolean → tratado como false (Stop normal)', () => {
    const out = claudeAdapter.onHook('Stop', { hook_event_name: 'Stop' }, session, PT);
    expect(out.blockedStop).toBeUndefined();
    expect(out.change).toEqual({ state: 'done', detail: detailDone(PT), tool: null });
    expect(out.notification).toEqual({ kind: 'done', text: 'Terminou o turno' });
  });
});

describe('summarizeTool', () => {
  it('Bash com comando curto', () => {
    expect(summarizeTool('Bash', { command: 'npm test -- --run' })).toBe('Bash · npm test -- --run');
  });

  it('corta em 40 chars + …', () => {
    const long = 'a'.repeat(60);
    const result = summarizeTool('Bash', { command: long });
    expect(result).toBe(`Bash · ${'a'.repeat(40)}…`);
  });

  it('Edit usa file_path (basename)', () => {
    expect(summarizeTool('Edit', { file_path: 'C:\\projetos\\x\\src\\app.ts' })).toBe('Edit · app.ts');
  });

  it('ferramenta desconhecida → só o nome', () => {
    expect(summarizeTool('MyTool', { foo: 'bar' })).toBe('MyTool');
  });

  it('argumento ausente/vazio → só o nome', () => {
    expect(summarizeTool('Bash', {})).toBe('Bash');
    expect(summarizeTool('Bash', { command: '' })).toBe('Bash');
  });

  /**
   * Review final da 0.12.0: o `detail` que sai daqui é IMPRESSO no console pelo
   * `bridge list`, e o `tool_input` é escolhido pelo modelo (ou por qualquer
   * arquivo que ele esteja lendo). O `collapseWhitespace` daqui só junta
   * espaço: um `ESC]0;…BEL` atravessava inteiro e virava sequência de controle
   * no terminal do dono. Agora tudo sai por `sanitizeDisplay`.
   */
  it('ESC e BEL no tool_input não chegam ao terminal', () => {
    const detail = summarizeTool('Bash', { command: 'echo \u001b]0;dono\u0007 \u001b[31mvermelho\u001b[0m' });
    expect(isDisplaySafe(detail)).toBe(true);
    expect(detail).not.toContain('\u001b');
    expect(detail).not.toContain('\u0007');
    expect(detail).toBe('Bash · echo vermelho');
  });

  it('o nome da ferramenta também é sanitizado (ele vem do mesmo payload)', () => {
    const detail = summarizeTool('My\u001b[2JTool', { foo: 'bar' });
    expect(isDisplaySafe(detail)).toBe(true);
    expect(detail).toBe('MyTool');
  });
});

describe('isHumanWait', () => {
  it('idle_prompt → false', () => {
    expect(isHumanWait({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).toBe(false);
  });

  it('permission_prompt → true', () => {
    expect(isHumanWait({ notification_type: 'permission_prompt', message: 'needs permission' })).toBe(true);
  });

  it('sem tipo, mensagem sem waiting/idle → true', () => {
    expect(isHumanWait({ message: 'Something happened' })).toBe(true);
  });

  it('sem tipo, mensagem com waiting → false', () => {
    expect(isHumanWait({ message: 'Claude is waiting for your input' })).toBe(false);
  });
});

/**
 * 0.12.2 — `usage.terminalStatusLine`. A MESMA chamada faz duas coisas que
 * agora se separam: ler a cota do payload (contexto, modelo, custo, janelas —
 * é o que alimenta a sidebar e o `noteLimits` do monitor de uso) e devolver o
 * texto que o Claude Code desenha no rodapé da TUI. Desligada — o padrão —, só
 * o texto some.
 *
 * Medido com o Claude Code 2.1.266 num PTY: com o comando da `statusLine`
 * devolvendo string vazia, a TUI não desenha rodapé nenhum (nem uma barra em
 * branco) e o comando SEGUE sendo chamado a cada redesenho.
 */
describe('statusLine — usage.terminalStatusLine', () => {
  const statuslineFixture: unknown = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'statusline.json'), 'utf8'),
  );

  afterEach(() => {
    configureClaudeAdapter({
      showCost: DEFAULT_CONFIG.usage.showCost,
      terminalStatusLine: DEFAULT_CONFIG.usage.terminalStatusLine,
    });
  });

  it('desligada (o padrão): o terminal recebe linha VAZIA e a cota continua sendo lida', async () => {
    configureClaudeAdapter({ showCost: true, terminalStatusLine: false });
    const out = await claudeAdapter.statusLine!(statuslineFixture, session, PT);
    expect(out.line).toBe('');
    // O parse é o que não pode ter mudado: é dele que saem a linha da sessão na
    // sidebar, o selo de contexto e as janelas de 5 h/semana.
    expect(out.quota?.model).toBe('Fable 5.1');
    expect(out.quota?.contextTokens).toBe(87000);
    expect(out.quota?.costUsd).toBe(3.42);
    expect(out.quota?.rateLimits.map((r) => r.window).sort()).toEqual(['five_hour', 'seven_day']);
    // O `quota.line` guarda a linha CHEIA: ela é o retrato do que o Bridge leu,
    // e quem a consome não deveria depender de uma preferência do terminal.
    expect(out.quota?.line).toContain('87k ctx');
    expect(out.quota?.line).toContain('Fable 5.1');
  });

  it('ligada: a linha volta a ser a de sempre', async () => {
    configureClaudeAdapter({ showCost: true, terminalStatusLine: true });
    const out = await claudeAdapter.statusLine!(statuslineFixture, session, PT);
    expect(out.line).toContain('87k ctx');
    expect(out.line).toContain('Fable 5.1');
    expect(out.line).toContain('US$ 3,42');
    expect(out.line).toBe(out.quota?.line);
  });

  it('o interruptor do custo continua valendo dentro da linha ligada', async () => {
    configureClaudeAdapter({ showCost: false, terminalStatusLine: true });
    const out = await claudeAdapter.statusLine!(statuslineFixture, session, PT);
    expect(out.line).not.toContain('US$');
    expect(out.line).toContain('87k ctx');
  });

  it('o default do adaptador é a linha DESLIGADA', async () => {
    configureClaudeAdapter({
      showCost: DEFAULT_CONFIG.usage.showCost,
      terminalStatusLine: DEFAULT_CONFIG.usage.terminalStatusLine,
    });
    const out = await claudeAdapter.statusLine!(statuslineFixture, session, PT);
    expect(DEFAULT_CONFIG.usage.terminalStatusLine).toBe(false);
    expect(out.line).toBe('');
  });
});

void detailStuck(PT);
