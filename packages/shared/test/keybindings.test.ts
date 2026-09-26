import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../src/index.js';
import type { KeyAction } from '../src/index.js';

/**
 * As 19 ações da spec §6 (as 16 da v1 + `pane.close` + `settings.open` +
 * `usage.open`),
 * escritas à mão de propósito: se uma `KeyAction` nascer ou sumir sem que
 * este teste (e o default correspondente) mude, a lista abaixo denuncia. O
 * `satisfies` no
 * `protocol.ts` cobre o lado do tipo; aqui é o lado dos dados.
 */
const ACTIONS: KeyAction[] = [
  'workspace.new',
  'task.new',
  'tab.new',
  'tab.close',
  'pane.splitV',
  'pane.splitH',
  'pane.close',
  'pane.left',
  'pane.right',
  'pane.up',
  'pane.down',
  'workspace.prev',
  'workspace.next',
  'notifications.jump',
  'notifications.panel',
  'agent.claude',
  'sidebar.toggle',
  'settings.open',
  'usage.open',
];

describe('DEFAULT_KEYBINDINGS', () => {
  it('cobre exatamente as 19 ações da spec §6', () => {
    expect(ACTIONS).toHaveLength(19);
    expect(Object.keys(DEFAULT_KEYBINDINGS).sort()).toEqual([...ACTIONS].sort());
  });

  it('todo valor é um atalho não vazio', () => {
    for (const action of ACTIONS) {
      expect(typeof DEFAULT_KEYBINDINGS[action]).toBe('string');
      expect(DEFAULT_KEYBINDINGS[action].length).toBeGreaterThan(0);
    }
  });

  it('traz os atalhos travados na spec', () => {
    expect(DEFAULT_KEYBINDINGS).toEqual({
      'workspace.new': 'Ctrl+Shift+N',
      'task.new': 'Ctrl+Shift+Alt+N',
      'tab.new': 'Ctrl+Shift+T',
      'tab.close': 'Ctrl+Shift+W',
      'pane.splitV': 'Ctrl+Shift+D',
      'pane.splitH': 'Ctrl+Shift+E',
      'pane.close': 'Ctrl+Shift+X',
      'pane.left': 'Alt+ArrowLeft',
      'pane.right': 'Alt+ArrowRight',
      'pane.up': 'Alt+ArrowUp',
      'pane.down': 'Alt+ArrowDown',
      'workspace.prev': 'Ctrl+Shift+[',
      'workspace.next': 'Ctrl+Shift+]',
      'notifications.jump': 'Ctrl+Shift+U',
      'notifications.panel': 'Ctrl+Shift+I',
      'agent.claude': 'Ctrl+Shift+C',
      'sidebar.toggle': 'Ctrl+Shift+S',
      'settings.open': 'Ctrl+,',
      'usage.open': 'Ctrl+Shift+Y',
    });
  });

  it('nenhum atalho é usado por duas ações', () => {
    const values = Object.values(DEFAULT_KEYBINDINGS);
    expect(new Set(values).size).toBe(values.length);
  });
});
