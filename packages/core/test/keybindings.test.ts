import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '@bridge/shared';
import { loadKeybindings, loadKeybindingsWithProblems } from '../src/keybindings.js';
import { loadProfile } from '../src/profile.js';
import type { Profile } from '../src/profile.js';

let dir: string;
let profile: Profile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-keys-'));
  profile = loadProfile(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeKeybindings(content: unknown): void {
  writeFileSync(join(dir, 'keybindings.json'), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

interface Warned {
  msg: string;
  data?: object;
}

function fakeLog(warns: Warned[]): { warn(msg: string, data?: object): void } {
  return { warn: (msg, data) => warns.push({ msg, data }) };
}

describe('loadKeybindings', () => {
  it('sem arquivo devolve os defaults', () => {
    expect(loadKeybindings(profile)).toEqual(DEFAULT_KEYBINDINGS);
  });

  it('arquivo parcial mescla com os defaults', () => {
    writeKeybindings({ 'pane.splitV': 'Ctrl+Alt+D' });

    const keys = loadKeybindings(profile);

    expect(keys['pane.splitV']).toBe('Ctrl+Alt+D');
    expect(keys['pane.splitH']).toBe(DEFAULT_KEYBINDINGS['pane.splitH']);
    expect(Object.keys(keys)).toHaveLength(19);
  });

  it('chave desconhecida é ignorada com warn', () => {
    const warns: Warned[] = [];
    writeKeybindings({ 'pane.teleport': 'Ctrl+Shift+Z', 'tab.new': 'F2' });

    const keys = loadKeybindings(profile, fakeLog(warns));

    expect(keys['tab.new']).toBe('F2');
    expect(Object.keys(keys)).toHaveLength(19);
    expect(keys as Record<string, string>).not.toHaveProperty('pane.teleport');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain('desconhecida');
  });

  it('valor não-string é ignorado com warn', () => {
    const warns: Warned[] = [];
    writeKeybindings({ 'tab.close': 42, 'tab.new': '' });

    const keys = loadKeybindings(profile, fakeLog(warns));

    expect(keys['tab.close']).toBe(DEFAULT_KEYBINDINGS['tab.close']);
    expect(keys['tab.new']).toBe(DEFAULT_KEYBINDINGS['tab.new']);
    expect(warns).toHaveLength(2);
  });

  it('JSON quebrado cai nos defaults com warn', () => {
    const warns: Warned[] = [];
    writeKeybindings('{ isso não é json');

    expect(loadKeybindings(profile, fakeLog(warns))).toEqual(DEFAULT_KEYBINDINGS);
    expect(warns).toHaveLength(1);
  });

  it('JSON que não é objeto cai nos defaults com warn', () => {
    const warns: Warned[] = [];
    writeKeybindings(['Ctrl+Shift+D']);

    expect(loadKeybindings(profile, fakeLog(warns))).toEqual(DEFAULT_KEYBINDINGS);
    expect(warns).toHaveLength(1);
  });

  /**
   * O `warn` no `core.log` não chega a quem está com o diálogo de
   * configurações aberto: a resposta do `GET /api/keybindings` chegava íntegra
   * e indistinguível da de um arquivo perfeito. `problems` é o que a UI precisa
   * pra dizer que o arquivo do dono está sendo ignorado.
   */
  it('problems relata o que foi descartado, e some quando não há nada a avisar', () => {
    expect(loadKeybindingsWithProblems(profile).problems).toBeUndefined();

    writeKeybindings({ 'tab.new': 'F2' });
    expect(loadKeybindingsWithProblems(profile).problems).toBeUndefined();

    writeKeybindings({ 'pane.teleport': 'Ctrl+Shift+Z', 'tab.close': 42 });
    expect(loadKeybindingsWithProblems(profile).problems).toEqual([
      { kind: 'acao-desconhecida', action: 'pane.teleport' },
      { kind: 'atalho-invalido', action: 'tab.close' },
    ]);

    writeKeybindings('{ isso não é json');
    expect(loadKeybindingsWithProblems(profile).problems).toEqual([{ kind: 'json-invalido' }]);

    writeKeybindings(['Ctrl+Shift+D']);
    expect(loadKeybindingsWithProblems(profile).problems).toEqual([{ kind: 'nao-e-objeto' }]);

    // A tabela em si é a mesma dos dois lados: `loadKeybindings` só tira o campo.
    expect(loadKeybindings(profile)).toEqual(DEFAULT_KEYBINDINGS);
    expect(Object.keys(loadKeybindings(profile))).toHaveLength(19);
  });

  it('não muda os defaults do módulo (cópia, não referência)', () => {
    writeKeybindings({ 'tab.new': 'F2' });

    loadKeybindings(profile);

    expect(DEFAULT_KEYBINDINGS['tab.new']).toBe('Ctrl+Shift+T');
  });
});
