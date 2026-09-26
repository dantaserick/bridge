import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { TabAdoptError } from '../src/errors.js';
import { Layout, graftLeaf, leaves, neighborOf, removeLeaf, splitLeaf } from '../src/layout.js';
import type { LayoutNode } from '../src/model.js';

describe('splitLeaf', () => {
  it('em raiz leaf vira split v com ratio 0.5', () => {
    const root: LayoutNode = { type: 'leaf', paneId: 'p1' };
    const result = splitLeaf(root, 'p1', 'v', 'p2');
    expect(result).toEqual({
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: { type: 'leaf', paneId: 'p2' },
    });
  });

  it('em leaf aninhado substitui só aquele nó', () => {
    const root: LayoutNode = {
      type: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: { type: 'leaf', paneId: 'p2' },
    };
    const result = splitLeaf(root, 'p2', 'v', 'p3');
    expect(result).toEqual({
      type: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'leaf', paneId: 'p2' }, b: { type: 'leaf', paneId: 'p3' } },
    });
  });
});

describe('graftLeaf', () => {
  it('põe uma SUBÁRVORE inteira no lado b do split novo', () => {
    const sub: LayoutNode = { type: 'split', dir: 'h', ratio: 0.5, a: { type: 'leaf', paneId: 'x' }, b: { type: 'leaf', paneId: 'y' } };
    expect(graftLeaf({ type: 'leaf', paneId: 'p1' }, 'p1', 'v', sub)).toEqual({
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: sub,
    });
  });
});

describe('removeLeaf', () => {
  it('de b devolve a (colapso)', () => {
    const root: LayoutNode = {
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: { type: 'leaf', paneId: 'p2' },
    };
    expect(removeLeaf(root, 'p2')).toEqual({ type: 'leaf', paneId: 'p1' });
  });

  it('do único leaf devolve undefined', () => {
    const root: LayoutNode = { type: 'leaf', paneId: 'p1' };
    expect(removeLeaf(root, 'p1')).toBeUndefined();
  });
});

describe('leaves', () => {
  it('em ordem a -> b', () => {
    const root: LayoutNode = {
      type: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p2' } },
      b: { type: 'leaf', paneId: 'p3' },
    };
    expect(leaves(root)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('neighborOf', () => {
  it('split v (a=p1,b=p2): right de p1 = p2, left de p2 = p1, up de p1 = undefined', () => {
    const root: LayoutNode = {
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: 'p1' },
      b: { type: 'leaf', paneId: 'p2' },
    };
    expect(neighborOf(root, 'p1', 'right')).toBe('p2');
    expect(neighborOf(root, 'p2', 'left')).toBe('p1');
    expect(neighborOf(root, 'p1', 'up')).toBeUndefined();
  });

  it('split h (a=split v(p1,p2), b=p3): down de p2 = p3', () => {
    const root: LayoutNode = {
      type: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p2' } },
      b: { type: 'leaf', paneId: 'p3' },
    };
    expect(neighborOf(root, 'p2', 'down')).toBe('p3');
  });
});

describe('Layout', () => {
  function setup() {
    const db = openDb(':memory:');
    const bus = new EventBus();
    const layout = new Layout(db, bus);
    return { db, bus, layout };
  }

  it('createWorkspace cria aba + painel e persiste (reabrir devolve o mesmo snapshot)', () => {
    const { db, bus, layout } = setup();
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const { workspace, tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    expect(workspace.name).toBe('proj');
    expect(workspace.cwd).toBe('C:\\projetos\\code\\proj');
    expect(tab.title).toBe('Terminal');
    expect(tab.kind).toBe('terminal');
    expect(tab.order).toBe(0);
    expect(pane.cwd).toBe('C:\\projetos\\code\\proj');
    expect(events).toEqual(['layout.changed']);

    const snap1 = layout.snapshot();
    const layout2 = new Layout(db, bus);
    const snap2 = layout2.snapshot();
    expect(snap2).toEqual(snap1);
  });

  it('createWorkspace usa nome informado quando presente', () => {
    const { layout } = setup();
    const { workspace } = layout.createWorkspace({ name: 'custom', cwd: 'C:\\projetos\\code\\proj' });
    expect(workspace.name).toBe('custom');
  });

  it('createTab: order = max atual + 1, terminal nasce com 1 painel, emite exatamente um layout.changed', () => {
    const { layout, bus } = setup();
    const { workspace } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const { tab, pane } = layout.createTab(workspace.id);
    expect(tab.order).toBe(1);
    expect(pane).toBeDefined();
    expect(pane!.cwd).toBe(workspace.cwd);
    expect(layout.snapshot().layouts[tab.id]).toEqual({ type: 'leaf', paneId: pane!.id });
    expect(events).toEqual(['layout.changed']);
  });

  it('splitPane persiste layout e emite layout.changed', () => {
    const { layout, bus } = setup();
    const { tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const newPane = layout.splitPane(pane.id, 'v');
    expect(newPane.cwd).toBe(pane.cwd);
    expect(events).toEqual(['layout.changed']);
    expect(layout.snapshot().layouts[tab.id]).toEqual({
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: pane.id },
      b: { type: 'leaf', paneId: newPane.id },
    });
  });

  it('adoptTab traz a árvore da outra aba pro split e apaga a aba esvaziada, num só layout.changed', () => {
    const { layout, bus } = setup();
    const { workspace, tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const second = layout.createTab(workspace.id);
    const extra = layout.splitPane(second.pane!.id, 'h');
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const result = layout.adoptTab(pane.id, 'v', second.tab.id);
    expect(result).toEqual({ tabId: tab.id, removedTabId: second.tab.id });
    expect(events).toEqual(['layout.changed']);

    const snap = layout.snapshot();
    expect(snap.tabs.map((t) => t.id)).toEqual([tab.id]);
    expect(snap.layouts[second.tab.id]).toBeUndefined();
    expect(snap.layouts[tab.id]).toEqual({
      type: 'split',
      dir: 'v',
      ratio: 0.5,
      a: { type: 'leaf', paneId: pane.id },
      b: {
        type: 'split',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', paneId: second.pane!.id },
        b: { type: 'leaf', paneId: extra.id },
      },
    });
    // Os painéis adotados continuam existindo (é neles que as sessões vivem) e
    // passam a ser da aba alvo.
    expect(snap.panes.filter((p) => p.tabId === tab.id).map((p) => p.id).sort()).toEqual(
      [pane.id, second.pane!.id, extra.id].sort(),
    );
  });

  it('adoptTab preserva o que o painel adotado lembrava (último tipo, agente, conversa)', () => {
    const { layout } = setup();
    const { workspace, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const second = layout.createTab(workspace.id);
    layout.setPaneLast(second.pane!.id, 'agent', 'claude');
    layout.setPaneAgentSession(second.pane!.id, 'conv-1');

    layout.adoptTab(pane.id, 'h', second.tab.id);
    const adopted = layout.snapshot().panes.find((p) => p.id === second.pane!.id);
    expect(adopted).toMatchObject({ tabId: pane.tabId, lastKind: 'agent', lastAgent: 'claude', lastAgentSessionId: 'conv-1' });
  });

  it('adoptTab recusa: aba inexistente, a própria aba e aba de outro workspace', () => {
    const { layout } = setup();
    const { workspace, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const other = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\outro' });

    const reasons = (tabId: string): string | undefined => {
      try {
        layout.adoptTab(pane.id, 'v', tabId);
        return undefined;
      } catch (err) {
        return err instanceof TabAdoptError ? err.code : 'outro-erro';
      }
    };
    expect(reasons('tab_nao_existe')).toBe('tab-not-found');
    expect(reasons(pane.tabId)).toBe('same-tab');
    expect(reasons(other.tab.id)).toBe('other-workspace');
    // Nada mudou.
    expect(layout.snapshot().tabs).toHaveLength(2);
  });

  it('removePane do último painel remove a aba e emite exatamente um layout.changed', () => {
    const { layout, bus } = setup();
    const { workspace, tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    layout.removePane(pane.id);
    expect(layout.snapshot().tabs.find((t) => t.id === tab.id)).toBeUndefined();
    expect(layout.snapshot().panes.find((p) => p.id === pane.id)).toBeUndefined();
    expect(layout.snapshot().layouts[tab.id]).toBeUndefined();
    expect(layout.snapshot().workspaces.find((w) => w.id === workspace.id)).toBeDefined();
    expect(events).toEqual(['layout.changed']);
  });

  it('removePane colapsa o split quando há mais de um painel e emite exatamente um layout.changed', () => {
    const { layout, bus } = setup();
    const { tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const newPane = layout.splitPane(pane.id, 'h');
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    layout.removePane(newPane.id);
    expect(layout.snapshot().layouts[tab.id]).toEqual({ type: 'leaf', paneId: pane.id });
    expect(layout.snapshot().tabs.find((t) => t.id === tab.id)).toBeDefined();
    expect(events).toEqual(['layout.changed']);
  });

  it('removeTab remove painéis e layout da aba, emite exatamente um layout.changed', () => {
    const { layout, bus } = setup();
    const { workspace, tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    layout.removeTab(tab.id);
    expect(layout.snapshot().tabs).toEqual([]);
    expect(layout.snapshot().panes.find((p) => p.id === pane.id)).toBeUndefined();
    expect(layout.snapshot().layouts[tab.id]).toBeUndefined();
    expect(layout.snapshot().workspaces.find((w) => w.id === workspace.id)).toBeDefined();
    expect(events).toEqual(['layout.changed']);
  });

  it('removeWorkspace limpa tudo e emite exatamente um layout.changed', () => {
    const { layout, bus } = setup();
    const { workspace, tab, pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    layout.removeWorkspace(workspace.id);

    expect(events).toEqual(['layout.changed']);
    const snap = layout.snapshot();
    expect(snap.workspaces.find((w) => w.id === workspace.id)).toBeUndefined();
    expect(snap.tabs.find((t) => t.id === tab.id)).toBeUndefined();
    expect(snap.panes.find((p) => p.id === pane.id)).toBeUndefined();
    expect(snap.layouts[tab.id]).toBeUndefined();
  });

  it('neighbor delega pra neighborOf via árvore da aba', () => {
    const { layout } = setup();
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const newPane = layout.splitPane(pane.id, 'v');
    expect(layout.neighbor(pane.id, 'right')).toBe(newPane.id);
    expect(layout.neighbor(newPane.id, 'left')).toBe(pane.id);
  });

  it('paneCwd devolve o cwd do painel', () => {
    const { layout } = setup();
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    expect(layout.paneCwd(pane.id)).toBe('C:\\projetos\\code\\proj');
  });

  // ------------------------------------- metadado de restauração (resume 0.6)

  it('setPaneAgentSession grava o id do agente e só devolve true quando MUDA', () => {
    const { layout, bus } = setup();
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    expect(layout.setPaneAgentSession(pane.id, 'uuid-1')).toBe(true);
    expect(layout.snapshot().panes[0]?.lastAgentSessionId).toBe('uuid-1');
    // Todo hook do Claude traz o mesmo id: regravar seria uma escrita no
    // SQLite por ferramenta usada, e um evento por hook em cima disso.
    expect(layout.setPaneAgentSession(pane.id, 'uuid-1')).toBe(false);
    expect(layout.setPaneAgentSession(pane.id, 'uuid-2')).toBe(true);
    expect(layout.snapshot().panes[0]?.lastAgentSessionId).toBe('uuid-2');
    // Metadado, não geometria: nada de layout.changed vindo da própria Layout.
    expect(events).toEqual([]);
    expect(layout.setPaneAgentSession('pane_inexistente', 'uuid-3')).toBe(false);
  });

  it('setPaneEnded grava quem encerrou, sem emitir evento', () => {
    const { layout, bus } = setup();
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    layout.setPaneEnded(pane.id, 'app');
    expect(layout.snapshot().panes[0]?.lastEndedBy).toBe('app');
    layout.setPaneEnded(pane.id, 'user');
    expect(layout.snapshot().panes[0]?.lastEndedBy).toBe('user');
    expect(events).toEqual([]);
  });

  it('setPaneLast limpa o lastEndedBy; agente novo não herda o id da conversa, shell preserva', () => {
    const { layout } = setup();
    const { pane } = layout.createWorkspace({ cwd: 'C:\\projetos\\code\\proj' });

    layout.setPaneLast(pane.id, 'agent', 'claude');
    layout.setPaneAgentSession(pane.id, 'uuid-1');
    layout.setPaneEnded(pane.id, 'app');

    // Sessão de agente nova no mesmo painel: a marca de encerramento morre e o
    // id antigo NÃO é herdado — só volta se a sessão nasce retomando (`resume`).
    layout.setPaneLast(pane.id, 'agent', 'claude');
    let saved = layout.snapshot().panes[0];
    expect(saved?.lastEndedBy).toBeUndefined();
    expect(saved?.lastAgentSessionId).toBeUndefined();

    layout.setPaneAgentSession(pane.id, 'uuid-1');
    layout.setPaneEnded(pane.id, 'app');
    layout.setPaneLast(pane.id, 'agent', 'claude', 'uuid-1');
    saved = layout.snapshot().panes[0];
    expect(saved?.lastAgentSessionId).toBe('uuid-1');

    // Virou shell: o painel passa a ser shell (e o `lastEndedBy` morre, como
    // em toda sessão nova), mas a conversa FICA guardada — 0.7.0. É esse id
    // que o `bridge resume` lê no painel que a restauração devolveu como
    // shell (`resumeAgents` desligado, ou resume da subida que falhou); quem
    // decide retomar SOZINHO continua sendo `lastKind`/`lastEndedBy`, e
    // `lastKind` aqui já é `'shell'`.
    layout.setPaneEnded(pane.id, 'app');
    layout.setPaneLast(pane.id, 'shell');
    saved = layout.snapshot().panes[0];
    expect(saved?.lastKind).toBe('shell');
    expect(saved?.lastEndedBy).toBeUndefined();
    expect(saved?.lastAgent).toBe('claude');
    expect(saved?.lastAgentSessionId).toBe('uuid-1');
  });
});
