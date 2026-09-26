import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { Db } from '../src/db.js';
import { PaneNotFoundError } from '../src/errors.js';
import { EventBus } from '../src/events.js';
import type { BridgeEvent } from '../src/events.js';
import { Layout, lowestCommonSplit } from '../src/layout.js';
import type { LayoutNode } from '../src/model.js';

let db: Db;
let bus: EventBus;
let layout: Layout;
let events: BridgeEvent[];

beforeEach(() => {
  db = openDb(':memory:');
  bus = new EventBus();
  layout = new Layout(db, bus);
  events = [];
  bus.on((e) => events.push(e));
});

afterEach(() => {
  db.close();
});

/**
 * Árvore com 3 leaves: split externo `v` (p1 | resto) e interno `h`
 * (p2 / p3). `setRatio(p2)` tem que mexer SÓ no split interno.
 */
function threeLeaves(): { tabId: string; p1: string; p2: string; p3: string } {
  const { tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
  const p2 = layout.splitPane(pane.id, 'v').id;
  const p3 = layout.splitPane(p2, 'h').id;
  events = [];
  return { tabId: tab.id, p1: pane.id, p2, p3 };
}

function root(tabId: string): LayoutNode {
  const node = db.layouts.get(tabId);
  if (!node) throw new Error('layout sumiu');
  return node;
}

describe('Layout.setRatio', () => {
  it('altera só o split pai mais próximo do leaf e emite um layout.changed', () => {
    const { tabId, p2 } = threeLeaves();

    layout.setRatio(p2, 0.7);

    const outer = root(tabId);
    if (outer.type !== 'split') throw new Error('esperava split');
    expect(outer.ratio).toBe(0.5); // o de fora não foi tocado
    expect(outer.b.type).toBe('split');
    if (outer.b.type !== 'split') throw new Error('esperava split interno');
    expect(outer.b.ratio).toBe(0.7);
    expect(events.filter((e) => e.type === 'layout.changed')).toHaveLength(1);
  });

  it('no leaf que é filho direto da raiz mexe na raiz', () => {
    const { tabId, p1 } = threeLeaves();

    layout.setRatio(p1, 0.25);

    const outer = root(tabId);
    if (outer.type !== 'split') throw new Error('esperava split');
    expect(outer.ratio).toBe(0.25);
  });

  it('clampa entre 0.1 e 0.9', () => {
    const { tabId, p1 } = threeLeaves();

    layout.setRatio(p1, 0.01);
    let node = root(tabId);
    if (node.type !== 'split') throw new Error('esperava split');
    expect(node.ratio).toBe(0.1);

    layout.setRatio(p1, 5);
    node = root(tabId);
    if (node.type !== 'split') throw new Error('esperava split');
    expect(node.ratio).toBe(0.9);
  });

  it('painel único (raiz é leaf) é no-op e não emite evento', () => {
    const { tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
    events = [];

    layout.setRatio(pane.id, 0.8);

    expect(root(tab.id)).toEqual({ type: 'leaf', paneId: pane.id });
    expect(events).toHaveLength(0);
  });

  it('painel inexistente lança PaneNotFoundError', () => {
    expect(() => layout.setRatio('pane_nao_existe', 0.5)).toThrow(PaneNotFoundError);
  });
});

/**
 * R1 — a árvore que o `setRatio` sozinho erra: `split_v { a: split_h{p1,p4}, b: p2 }`.
 * O divisor EXTERNO (vertical) separa p1/p4 de p2; arrastar ele manda os dois
 * leaves das pontas (p1 e p2), e o ratio tem que cair no split de fora, não no
 * `split_h` que é o pai imediato de p1.
 */
function nestedTree(): { tabId: string; p1: string; p2: string; p4: string } {
  const { tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
  const p2 = layout.splitPane(pane.id, 'v').id; // split_v { p1, p2 }
  const p4 = layout.splitPane(pane.id, 'h').id; // split_v { split_h{p1,p4}, p2 }
  events = [];
  return { tabId: tab.id, p1: pane.id, p2, p4 };
}

describe('lowestCommonSplit (R1)', () => {
  it('dois leaves de ramos diferentes devolvem o split que os separa', () => {
    const inner: LayoutNode = { type: 'split', dir: 'h', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p4' } };
    const root: LayoutNode = { type: 'split', dir: 'v', ratio: 0.5, a: inner, b: { type: 'leaf', paneId: 'p2' } };

    expect(lowestCommonSplit(root, 'p1', 'p2')).toBe(root);
    expect(lowestCommonSplit(root, 'p4', 'p2')).toBe(root);
    expect(lowestCommonSplit(root, 'p1', 'p4')).toBe(inner);
  });

  it('leaf ausente, leaf repetido ou raiz-leaf devolvem undefined', () => {
    const root: LayoutNode = { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p2' } };
    expect(lowestCommonSplit(root, 'p1', 'p9')).toBeUndefined();
    expect(lowestCommonSplit(root, 'p1', 'p1')).toBeUndefined();
    expect(lowestCommonSplit({ type: 'leaf', paneId: 'p1' }, 'p1', 'p2')).toBeUndefined();
  });
});

describe('Layout.setRatioBetween (R1)', () => {
  it('drag do divisor externo (p1 + p2) muda o ratio EXTERNO e não o interno', () => {
    const { tabId, p1, p2 } = nestedTree();

    layout.setRatioBetween(p1, p2, 0.7);

    const outer = root(tabId);
    if (outer.type !== 'split') throw new Error('esperava split');
    expect(outer.ratio).toBe(0.7);
    if (outer.a.type !== 'split') throw new Error('esperava split interno');
    expect(outer.a.ratio).toBe(0.5); // o de dentro ficou intacto
    expect(events.filter((e) => e.type === 'layout.changed')).toHaveLength(1);
  });

  it('drag do divisor interno (p1 + p4) muda só o interno', () => {
    const { tabId, p1, p4 } = nestedTree();

    layout.setRatioBetween(p1, p4, 0.2);

    const outer = root(tabId);
    if (outer.type !== 'split') throw new Error('esperava split');
    expect(outer.ratio).toBe(0.5);
    if (outer.a.type !== 'split') throw new Error('esperava split interno');
    expect(outer.a.ratio).toBe(0.2);
  });

  it('clampa entre 0.1 e 0.9 como o setRatio', () => {
    const { tabId, p1, p2 } = nestedTree();

    layout.setRatioBetween(p1, p2, 5);

    const outer = root(tabId);
    expect(outer.type === 'split' && outer.ratio).toBe(0.9);
  });

  it('irmão desconhecido cai no comportamento antigo (split pai imediato)', () => {
    const { tabId, p1 } = nestedTree();

    layout.setRatioBetween(p1, 'pane_nao_existe', 0.3);

    const outer = root(tabId);
    if (outer.type !== 'split') throw new Error('esperava split');
    expect(outer.ratio).toBe(0.5);
    if (outer.a.type !== 'split') throw new Error('esperava split interno');
    expect(outer.a.ratio).toBe(0.3);
  });

  it('painel inexistente lança PaneNotFoundError', () => {
    expect(() => layout.setRatioBetween('pane_nao_existe', 'outro', 0.5)).toThrow(PaneNotFoundError);
  });
});

describe('Layout.setPaneLast', () => {
  it('persiste o último tipo/agente do painel e aparece no snapshot', () => {
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
    events = [];

    layout.setPaneLast(pane.id, 'agent', 'claude');

    const stored = db.panes.get(pane.id);
    expect(stored).toMatchObject({ lastKind: 'agent', lastAgent: 'claude' });
    const snap = layout.snapshot().panes.find((p) => p.id === pane.id);
    expect(snap).toMatchObject({ lastKind: 'agent', lastAgent: 'claude' });
  });

  it('shell vira o tipo do painel mas PRESERVA o agente e a conversa (0.7.0)', () => {
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
    layout.setPaneLast(pane.id, 'agent', 'claude', 'uuid-conversa');

    layout.setPaneLast(pane.id, 'shell');

    // `lastKind` é o que decide o restore automático (e ele passa a ser
    // shell); `lastAgent`/`lastAgentSessionId` ficam pro `bridge resume`, que
    // é justamente o comando pro painel que voltou como shell.
    expect(db.panes.get(pane.id)).toMatchObject({
      lastKind: 'shell',
      lastAgent: 'claude',
      lastAgentSessionId: 'uuid-conversa',
    });
  });

  it('é metadado: não emite layout.changed', () => {
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code' });
    events = [];

    layout.setPaneLast(pane.id, 'agent', 'claude');

    expect(events).toHaveLength(0);
  });

  it('painel inexistente é ignorado em silêncio', () => {
    expect(() => layout.setPaneLast('pane_nao_existe', 'shell')).not.toThrow();
  });
});

describe('migração das colunas last_kind/last_agent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-db-mig-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // arquivo do SQLite ainda segurado pelo Windows — é temp, some sozinho.
    }
  });

  it('banco antigo (sem as colunas) ganha as colunas e os dados sobrevivem', () => {
    const path = join(dir, 'bridge.db');
    // Simula o schema da Fase 1: tabela `panes` sem last_kind/last_agent.
    const oldDb = openDb(path);
    oldDb.raw.exec('DROP TABLE panes');
    oldDb.raw.exec('CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, cwd TEXT NOT NULL)');
    oldDb.raw.prepare('INSERT INTO panes (id, tab_id, cwd) VALUES (?, ?, ?)').run('p1', 't1', 'C:\\projetos\\code');
    oldDb.close();

    const migrated = openDb(path);
    const columns = (migrated.raw.pragma('table_info(panes)') as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('last_kind');
    expect(columns).toContain('last_agent');
    expect(migrated.panes.get('p1')).toEqual({ id: 'p1', tabId: 't1', cwd: 'C:\\projetos\\code' });
    migrated.close();

    // Idempotente: abrir de novo não explode nem duplica coluna.
    const again = openDb(path);
    const columnsAgain = (again.raw.pragma('table_info(panes)') as { name: string }[]).map((c) => c.name);
    expect(columnsAgain.filter((c) => c === 'last_kind')).toHaveLength(1);
    again.close();
  });

  it('round-trip de insert/update com last_kind/last_agent', () => {
    const fresh = openDb(':memory:');
    fresh.panes.insert({ id: 'p1', tabId: 't1', cwd: 'C:\\projetos\\code', lastKind: 'agent', lastAgent: 'claude' });
    expect(fresh.panes.get('p1')).toEqual({
      id: 'p1',
      tabId: 't1',
      cwd: 'C:\\projetos\\code',
      lastKind: 'agent',
      lastAgent: 'claude',
    });

    fresh.panes.update({ id: 'p1', tabId: 't1', cwd: 'C:\\projetos\\outro', lastKind: 'shell' });
    expect(fresh.panes.get('p1')).toEqual({ id: 'p1', tabId: 't1', cwd: 'C:\\projetos\\outro', lastKind: 'shell' });
    fresh.close();
  });
});
