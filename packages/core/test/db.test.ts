import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { UsageDailyRow } from '../src/db.js';
import type { Notification, Pane, QuotaSnapshot, Repo, Tab, Workspace } from '../src/model.js';

function makeRepo(): Repo {
  return { id: 'repo_1', path: 'C:\\projetos\\code\\proj', name: 'proj', trustFilters: false };
}
function makeWorkspace(repoId?: string): Workspace {
  return {
    id: 'ws_1',
    name: 'proj',
    cwd: 'C:\\projetos\\code\\proj',
    repoId,
    branch: repoId ? 'main' : undefined,
    worktree: repoId ? { base: 'C:\\projetos\\code\\proj', path: 'C:\\projetos\\code\\proj-wt' } : undefined,
    createdAt: 1000,
  };
}
function makeTab(): Tab {
  return { id: 'tab_1', workspaceId: 'ws_1', title: 'Terminal', kind: 'terminal', order: 0 };
}
function makePane(): Pane {
  return { id: 'pane_1', tabId: 'tab_1', cwd: 'C:\\projetos\\code\\proj' };
}

describe('openDb', () => {
  it('repos: upsert/list/byPath', () => {
    const db = openDb(':memory:');
    const r = makeRepo();
    db.repos.upsert(r);
    expect(db.repos.list()).toEqual([r]);
    expect(db.repos.byPath('C:\\projetos\\code\\proj')).toEqual(r);
    expect(db.repos.byPath('nope')).toBeUndefined();
    const r2 = { ...r, name: 'renamed' };
    db.repos.upsert(r2);
    expect(db.repos.list()).toEqual([r2]);
    db.close();
  });

  it('workspaces: insert/get/list/update/remove round-trip com campos opcionais undefined', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    const ws = makeWorkspace();
    db.workspaces.insert(ws);
    expect(db.workspaces.get('ws_1')).toEqual(ws);
    expect(db.workspaces.list()).toEqual([ws]);

    const wsNoOptional: Workspace = { id: 'ws_2', name: 'bare', cwd: 'C:\\projetos\\x', createdAt: 2000 };
    db.workspaces.insert(wsNoOptional);
    expect(db.workspaces.get('ws_2')).toEqual(wsNoOptional);

    const wsUpdated = { ...ws, name: 'renamed-ws', branch: 'dev' };
    db.workspaces.update(wsUpdated);
    expect(db.workspaces.get('ws_1')).toEqual(wsUpdated);

    db.workspaces.remove('ws_2');
    expect(db.workspaces.get('ws_2')).toBeUndefined();
    expect(db.workspaces.list()).toEqual([wsUpdated]);
    db.close();
  });

  it('tabs: insert/get/listByWorkspace/update/remove', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    const tab = makeTab();
    db.tabs.insert(tab);
    expect(db.tabs.get('tab_1')).toEqual(tab);
    expect(db.tabs.listByWorkspace('ws_1')).toEqual([tab]);

    const tab2: Tab = { id: 'tab_2', workspaceId: 'ws_1', title: 'Outro', kind: 'terminal', order: 1 };
    db.tabs.insert(tab2);
    expect(db.tabs.listByWorkspace('ws_1')).toEqual([tab, tab2]);
    expect(db.tabs.get('tab_2')).toEqual(tab2);

    const tabUpdated = { ...tab, title: 'renamed-tab' };
    db.tabs.update(tabUpdated);
    expect(db.tabs.get('tab_1')).toEqual(tabUpdated);

    db.tabs.remove('tab_2');
    expect(db.tabs.get('tab_2')).toBeUndefined();
    expect(db.tabs.listByWorkspace('ws_1')).toEqual([tabUpdated]);
    db.close();
  });

  it('panes: insert/get/listByTab/update/remove', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    db.tabs.insert(makeTab());
    const pane = makePane();
    db.panes.insert(pane);
    expect(db.panes.get('pane_1')).toEqual(pane);
    expect(db.panes.listByTab('tab_1')).toEqual([pane]);

    const paneUpdated = { ...pane, cwd: 'C:\\projetos\\code\\proj\\sub' };
    db.panes.update(paneUpdated);
    expect(db.panes.get('pane_1')).toEqual(paneUpdated);

    db.panes.remove('pane_1');
    expect(db.panes.get('pane_1')).toBeUndefined();
    expect(db.panes.listByTab('tab_1')).toEqual([]);
    db.close();
  });

  it('panes: round-trip do metadado de restauração (lastAgentSessionId, lastEndedBy)', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    db.tabs.insert(makeTab());
    const pane: Pane = {
      ...makePane(),
      lastKind: 'agent',
      lastAgent: 'claude',
      lastAgentSessionId: '9f1a2b3c-0000-4444-8888-aaaabbbbcccc',
      lastEndedBy: 'app',
    };
    db.panes.insert(pane);
    expect(db.panes.get('pane_1')).toEqual(pane);

    // Voltar pra shell zera os dois campos — e o UPDATE tem que gravar NULL,
    // não deixar o valor velho no banco.
    const asShell: Pane = { ...pane, lastKind: 'shell', lastAgent: undefined, lastAgentSessionId: undefined, lastEndedBy: undefined };
    db.panes.update(asShell);
    expect(db.panes.get('pane_1')).toEqual(asShell);
    db.close();
  });

  /**
   * O banco de um Bridge 0.5.0 não tem `last_agent_session_id` nem
   * `last_ended_by`. A migração é `ALTER TABLE ... ADD COLUMN` guardada por
   * `PRAGMA table_info` (o SQLite não tem `IF NOT EXISTS` aí): abrir o banco
   * velho tem que funcionar, preservar as linhas e ser repetível.
   */
  it('migração: banco sem as colunas novas sobe, preserva as linhas e reabrir é no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    const path = join(dir, 'legado.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE panes (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_kind TEXT,
        last_agent TEXT
      );
      INSERT INTO panes (id, tab_id, cwd, last_kind, last_agent)
      VALUES ('pane_velho', 'tab_1', 'C:\\projetos\\code\\proj', 'agent', 'claude');
    `);
    legacy.close();

    const db = openDb(path);
    const migrated = db.panes.get('pane_velho');
    expect(migrated?.lastKind).toBe('agent');
    expect(migrated?.lastAgent).toBe('claude');
    // Painel de uma versão que não sabia gravar isto: sem id e sem marca — que
    // é exatamente o que ele era. A restauração não retoma nada dele.
    expect(migrated?.lastAgentSessionId).toBeUndefined();
    expect(migrated?.lastEndedBy).toBeUndefined();

    db.panes.update({ ...migrated!, lastAgentSessionId: 'uuid-1', lastEndedBy: 'app' });
    db.close();

    const reopened = openDb(path);
    expect(reopened.panes.get('pane_velho')?.lastAgentSessionId).toBe('uuid-1');
    expect(reopened.panes.get('pane_velho')?.lastEndedBy).toBe('app');
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Layout salvo por uma edição do Bridge com outros tipos de aba: a aba que
   * não é de terminal é descartada ao abrir o banco (com o layout dela), e as
   * de terminal seguem intactas. Reabrir é no-op.
   */
  it('migração: aba que não é de terminal no banco salvo é descartada ao abrir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    const path = join(dir, 'legado.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tabs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        ord INTEGER NOT NULL,
        url TEXT,
        file_path TEXT
      );
      CREATE TABLE layouts (tab_id TEXT PRIMARY KEY, node_json TEXT NOT NULL);
      INSERT INTO tabs (id, workspace_id, title, kind, ord, url, file_path)
      VALUES ('tab_term', 'ws_1', 'Terminal', 'terminal', 0, NULL, NULL),
             ('tab_web', 'ws_1', 'Web', 'browser', 1, 'https://x.dev', 'a.md');
      INSERT INTO layouts (tab_id, node_json) VALUES ('tab_web', '{"type":"leaf","paneId":"p"}');
    `);
    legacy.close();

    const db = openDb(path);
    expect(db.tabs.listByWorkspace('ws_1').map((t) => t.id)).toEqual(['tab_term']);
    expect(db.tabs.get('tab_web')).toBeUndefined();
    expect(db.layouts.get('tab_web')).toBeUndefined();
    expect(db.tabs.get('tab_term')).toEqual({ id: 'tab_term', workspaceId: 'ws_1', title: 'Terminal', kind: 'terminal', order: 0 });
    db.close();

    const reopened = openDb(path);
    expect(reopened.tabs.listByWorkspace('ws_1')).toHaveLength(1);
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 0.12.1 — o painel do dono, resgatado na subida.
   *
   * Uma linha com `last_kind='agent'`, id de conversa gravado e `last_ended_by`
   * NULO só pode ter nascido de um core que MORREU com o agente vivo: a saída
   * normal do processo grava `'user'` e o `stop()` grava `'app'`. A migração
   * carimba `'app'` nessas linhas (e só nessas) pra restauração alcançá-las.
   */
  it('migração 0.12.1: painel de agente com conversa e sem marca vira app; os vizinhos não são tocados', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    const path = join(dir, 'morte-suja.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE panes (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_kind TEXT,
        last_agent TEXT,
        last_agent_session_id TEXT,
        last_ended_by TEXT
      );
      INSERT INTO panes (id, tab_id, cwd, last_kind, last_agent, last_agent_session_id, last_ended_by) VALUES
        ('pane_orfao',  'tab_1', 'C:\\projetos\\a', 'agent', 'claude', 'conversa-viva', NULL),
        ('pane_fechado','tab_1', 'C:\\projetos\\b', 'agent', 'claude', 'conversa-morta', 'user'),
        ('pane_sem_id', 'tab_1', 'C:\\projetos\\c', 'agent', 'claude', NULL,             NULL),
        ('pane_shell',  'tab_1', 'C:\\projetos\\d', 'shell', 'claude', 'conversa-guardada', NULL);
    `);
    legacy.close();

    const db = openDb(path);
    // O painel do relato: agente + conversa + sem marca → resgatado.
    expect(db.panes.get('pane_orfao')?.lastEndedBy).toBe('app');
    // Quem o dono fechou continua fechado.
    expect(db.panes.get('pane_fechado')?.lastEndedBy).toBe('user');
    // Sem id não há o que retomar: a marca não inventa conversa.
    expect(db.panes.get('pane_sem_id')?.lastEndedBy).toBeUndefined();
    // Painel que virou shell não retoma (a conversa fica só pro `bridge resume`).
    expect(db.panes.get('pane_shell')?.lastEndedBy).toBeUndefined();
    db.close();

    // Idempotente: o dono fecha a conversa retomada, e reabrir o banco NÃO
    // pode carimbar `'app'` de novo por cima do `'user'`.
    const segunda = openDb(path);
    segunda.panes.update({ ...segunda.panes.get('pane_orfao')!, lastEndedBy: 'user' });
    segunda.close();
    const terceira = openDb(path);
    expect(terceira.panes.get('pane_orfao')?.lastEndedBy).toBe('user');
    terceira.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('layouts: get/set/remove', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    db.tabs.insert(makeTab());
    expect(db.layouts.get('tab_1')).toBeUndefined();
    const node = { type: 'leaf' as const, paneId: 'pane_1' };
    db.layouts.set('tab_1', node);
    expect(db.layouts.get('tab_1')).toEqual(node);
    const node2 = { type: 'split' as const, dir: 'v' as const, ratio: 0.5, a: { type: 'leaf' as const, paneId: 'pane_1' }, b: { type: 'leaf' as const, paneId: 'pane_2' } };
    db.layouts.set('tab_1', node2);
    expect(db.layouts.get('tab_1')).toEqual(node2);
    db.layouts.remove('tab_1');
    expect(db.layouts.get('tab_1')).toBeUndefined();
    db.close();
  });

  it('notifications: insert/listUnread/markRead/list(limit) ordenado por at DESC', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    const n1: Notification = { id: 'n_1', sessionId: 's_1', workspaceId: 'ws_1', kind: 'done', text: 'terminou', at: 100 };
    const n2: Notification = { id: 'n_2', sessionId: 's_1', workspaceId: 'ws_1', kind: 'needs-input', text: 'precisa de input', at: 200 };
    const n3: Notification = { id: 'n_3', sessionId: 's_1', workspaceId: 'ws_1', kind: 'stuck', text: 'travou', at: 300 };
    db.notifications.insert(n1);
    db.notifications.insert(n2);
    db.notifications.insert(n3);

    expect(db.notifications.listUnread()).toEqual([n1, n2, n3]);

    db.notifications.markRead(['n_1', 'n_2'], 500);
    const unread = db.notifications.listUnread();
    expect(unread).toEqual([n3]);

    const all = db.notifications.list(2);
    expect(all).toEqual([n3, { ...n2, readAt: 500 }]);
    db.close();
  });

  /**
   * `latestUnread` é o alvo do `Ctrl+Shift+U` e de
   * `GET /api/notifications/latest-unread`. Empate em `at` é o caso comum (um
   * agente despejando OSC produz várias no mesmo milissegundo), e sem
   * desempate a resposta dependia da ordem que o planejador do SQLite
   * escolhesse. O critério é o `rowid`: a última INSERIDA ganha.
   */
  it('notifications: latestUnread desempata por rowid e ignora as já lidas', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.workspaces.insert(makeWorkspace());
    const base = { sessionId: 's_1', workspaceId: 'ws_1', kind: 'done' as const, text: 'x' };
    // Ids fora de ordem alfabética de propósito: se o desempate caísse no `id`
    // (ou na ordem natural da tabela por acaso), `n_a` ganharia.
    const antiga: Notification = { ...base, id: 'n_z', at: 100 };
    const empate1: Notification = { ...base, id: 'n_m', at: 300 };
    const empate2: Notification = { ...base, id: 'n_a', at: 300 };
    db.notifications.insert(antiga);
    db.notifications.insert(empate1);
    db.notifications.insert(empate2);

    expect(db.notifications.latestUnread()).toEqual(empate2);
    // A ordem da lista também é estável no empate (o painel não pode dançar).
    expect(db.notifications.listUnread().map((n) => n.id)).toEqual(['n_z', 'n_m', 'n_a']);

    db.notifications.markRead(['n_a'], 900);
    expect(db.notifications.latestUnread()).toEqual(empate1);

    db.notifications.markRead(['n_m', 'n_z'], 900);
    expect(db.notifications.latestUnread()).toBeUndefined();
    db.close();
  });

  /**
   * `path` é `UNIQUE` e só o conflito de `id` era tratado: dois `upsertRepo`
   * da mesma pasta em voo geravam ids diferentes e o segundo `INSERT`
   * estourava `SQLITE_CONSTRAINT_UNIQUE` no meio de `POST /api/workspaces`.
   * Quem ganha é o registro que já está no banco — é o id que os workspaces
   * referenciam e a quem a confiança de filtros (BR-03) está amarrada.
   */
  it('repos: upsert com o path já ocupado por outro id não lança, mantém o registro existente e a confiança', () => {
    const db = openDb(':memory:');
    db.repos.upsert(makeRepo());
    db.repos.setTrustFilters('repo_1', true);

    const gravado = db.repos.upsert({ id: 'repo_2', path: 'C:\\projetos\\code\\proj', name: 'proj (outro nome)', trustFilters: false });

    expect(gravado).toEqual({ id: 'repo_1', path: 'C:\\projetos\\code\\proj', name: 'proj (outro nome)', trustFilters: true });
    expect(db.repos.list()).toEqual([gravado]);
    expect(db.repos.get('repo_2')).toBeUndefined();
    // O `id` continua sendo chave: o upsert normal segue devolvendo o próprio.
    expect(db.repos.upsert({ id: 'repo_3', path: 'C:\\projetos\\code\\outro', name: 'outro', trustFilters: false }).id).toBe('repo_3');
    db.close();
  });

  it('quota: set sobrescreve o anterior', () => {
    const db = openDb(':memory:');
    const q1: QuotaSnapshot = { model: 'claude', contextTokens: 1000, rateLimits: [], line: 'ok', at: 1 };
    const q2: QuotaSnapshot = { model: 'claude', contextTokens: 2000, contextPct: 50, costUsd: 1.5, rateLimits: [{ window: '5h', usedPct: 10, resetsAt: 999, pacingPct: 5 }], line: 'quase', at: 2 };
    db.quota.set('s_1', q1);
    expect(db.quota.get('s_1')).toEqual(q1);
    db.quota.set('s_1', q2);
    expect(db.quota.get('s_1')).toEqual(q2);
    expect(db.quota.get('s_2')).toBeUndefined();
    db.close();
  });
});

/**
 * As três tabelas do monitor de uso (ADR-012). O que se cobra aqui é o que o
 * resto do módulo assume: o upsert de `usage_daily` SOMA (a varredura manda
 * deltas, não totais), a migração é idempotente sobre um banco antigo, e
 * `reset()` limpa contagem E marcador junto — reler sem zerar dobraria o
 * histórico.
 */
describe('db — uso', () => {
  const linha = (over: Partial<UsageDailyRow> = {}): UsageDailyRow => ({
    day: '2026-09-05',
    model: 'claude-sonnet-4-5',
    source: 'main',
    project: 'C:\\projetos\\a',
    input: 10,
    output: 5,
    cacheWrite: 2,
    cacheWrite1h: 0,
    cacheRead: 3,
    cost: 0.5,
    messages: 1,
    ...over,
  });

  it('addDaily SOMA no mesmo balde (dia × modelo × projeto)', () => {
    const db = openDb(':memory:');
    db.usage.addDaily([linha(), linha()]);
    db.usage.addDaily([linha({ input: 100, cost: null })]);

    const rows = db.usage.daily('2026-09-01', '2026-09-30');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input: 120, output: 15, messages: 3 });
    // Delta sem preço (`cost: null`) não apaga o custo já acumulado.
    expect(rows[0]?.cost).toBeCloseTo(1, 6);
    db.close();
  });

  it('baldes diferentes não se misturam, e a faixa de dias é inclusiva', () => {
    const db = openDb(':memory:');
    db.usage.addDaily([
      linha({ day: '2026-09-04' }),
      linha({ day: '2026-09-05', model: 'claude-haiku-4-5' }),
      linha({ day: '2026-09-05', project: 'C:\\projetos\\b' }),
      linha({ day: '2026-10-01' }),
    ]);

    expect(db.usage.daily('2026-09-04', '2026-09-05')).toHaveLength(3);
    expect(db.usage.daily('2026-09-05', '2026-09-05')).toHaveLength(2);
    db.close();
  });

  it('marcadores de arquivo: grava, relê e conta', () => {
    const db = openDb(':memory:');
    expect(db.usage.fileState('C:\\x.jsonl')).toBeUndefined();
    expect(db.usage.fileCount()).toBe(0);

    db.usage.setFileState({ path: 'C:\\x.jsonl', size: 100, mtime: 5, offset: 90, lastId: 'msg:req' });
    expect(db.usage.fileState('C:\\x.jsonl')).toEqual({
      path: 'C:\\x.jsonl',
      size: 100,
      mtime: 5,
      offset: 90,
      lastId: 'msg:req',
      // BU-01/R1: a coluna nova nasce zerada e acumula linhas puladas.
      skippedLines: 0,
    });

    db.usage.setFileState({ path: 'C:\\x.jsonl', size: 200, mtime: 6, offset: 200 });
    expect(db.usage.fileState('C:\\x.jsonl')?.offset).toBe(200);
    expect(db.usage.fileState('C:\\x.jsonl')?.lastId).toBeUndefined();
    expect(db.usage.fileCount()).toBe(1);
    db.close();
  });

  it('reset zera contagem e marcador — é o que o rescan faz antes de reler', () => {
    const db = openDb(':memory:');
    db.usage.addDaily([linha()]);
    db.usage.setFileState({ path: 'C:\\x.jsonl', size: 1, mtime: 1, offset: 1 });

    db.usage.reset();
    expect(db.usage.daily('2000-01-01', '2100-01-01')).toEqual([]);
    expect(db.usage.fileCount()).toBe(0);
    db.close();
  });

  /**
   * Um banco da 0.9.0 (sem nenhuma das tabelas de uso) tem que subir sozinho.
   * O `CREATE TABLE IF NOT EXISTS` é o guarda; este teste é quem cobra que
   * ninguém o troque por um `CREATE TABLE` seco.
   */
  it('migração idempotente: banco antigo ganha as tabelas, e reabrir não perde dado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-uso-'));
    const path = join(dir, 'bridge.db');
    try {
      // Um banco "da versão anterior": só a tabela que já existia.
      const antigo = new Database(path);
      antigo.exec('CREATE TABLE IF NOT EXISTS quota (session_id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);');
      antigo.close();

      const db = openDb(path);
      db.usage.addDaily([linha()]);
      db.close();

      const reaberto = openDb(path);
      expect(reaberto.usage.daily('2026-09-01', '2026-09-30')).toHaveLength(1);
      reaberto.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
