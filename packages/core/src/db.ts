import Database from 'better-sqlite3';
import type { Language } from '@bridge/shared';
import type { LayoutNode, Notification, Pane, QuotaSnapshot, Repo, Tab, UsageLimitWindow, Workspace } from './model.js';
import { windowLabel } from './usage/limits.js';

/** Onde a varredura de transcripts parou em UM arquivo (ver `usagePoller.ts`). */
export interface UsageFileState {
  path: string;
  size: number;
  mtime: number;
  /** Byte de onde a próxima passada começa. */
  offset: number;
  /** Última chave de dedupe consumida (`message.id:requestId`), ou `undefined`. */
  lastId?: string;
  /**
   * Hash dos primeiros bytes do arquivo (ver `fingerprint`, em
   * `usage/transcripts.ts`). É o que denuncia o transcript REESCRITO, que o
   * par `size`/`mtime` sozinho não pega. `undefined` num arquivo ainda menor
   * que o teto da impressão.
   */
  headHash?: string;
  /**
   * Quantas linhas deste arquivo foram DESCARTADAS por passarem do teto de
   * linha (BU-01/R1). Acumula ao longo da vida do arquivo: e o retrato de
   * quanto daquele transcript nao entrou na contagem.
   */
  skippedLines?: number;
}

/** Um balde de `usage_daily` — a granularidade é dia × modelo × projeto × origem. */
export interface UsageDailyRow {
  day: string;
  model: string;
  project: string;
  /** `main` = conversa principal; `subagents` = os subagentes dela. */
  source: 'main' | 'subagents';
  input: number;
  output: number;
  /** Escrita de cache com TTL de 5 minutos (o default do Claude Code). */
  cacheWrite: number;
  /**
   * Escrita de cache com TTL de 1 hora, contada em separado porque ela CUSTA
   * o dobro da de 5 minutos (2x o input, contra 1,25x). Numa amostra da
   * maquina do autor ela era 22,8% dos tokens de escrita: dobrar a coluna
   * unica pelo preco de 5 minutos subestimava a conta.
   */
  cacheWrite1h: number;
  cacheRead: number;
  cost: number | null;
  messages: number;
}

export interface Db {
  raw: Database.Database;
  repos: {
    /**
     * Grava o repo e devolve o registro que FICOU no banco — que nem sempre é
     * o que entrou: quando outro `id` já ocupa o mesmo `path` (a coluna é
     * `UNIQUE`), o registro existente é o que manda. Ver a implementação.
     */
    upsert(r: Repo): Repo;
    list(): Repo[];
    get(id: string): Repo | undefined;
    byPath(path: string): Repo | undefined;
    /** BR-03: o dono confia (ou deixa de confiar) nos drivers de filtro do repo. */
    setTrustFilters(id: string, trust: boolean): Repo | undefined;
  };
  workspaces: {
    insert(w: Workspace): void;
    update(w: Workspace): void;
    remove(id: string): void;
    list(): Workspace[];
    get(id: string): Workspace | undefined;
  };
  tabs: {
    insert(t: Tab): void;
    update(t: Tab): void;
    remove(id: string): void;
    listByWorkspace(wsId: string): Tab[];
    get(id: string): Tab | undefined;
  };
  panes: {
    insert(p: Pane): void;
    update(p: Pane): void;
    remove(id: string): void;
    listByTab(tabId: string): Pane[];
    get(id: string): Pane | undefined;
  };
  layouts: { get(tabId: string): LayoutNode | undefined; set(tabId: string, node: LayoutNode): void; remove(tabId: string): void };
  notifications: {
    insert(n: Notification): void;
    markRead(ids: string[], at: number): void;
    listUnread(): Notification[];
    /**
     * A não lida MAIS RECENTE, com desempate por `rowid` (ordem de inserção).
     *
     * Existe como consulta, e não como varredura em JS por cima do
     * `listUnread()`: duas notificações no MESMO milissegundo — trivial com o
     * `Ctrl+Shift+U` saltando pra "a última" enquanto um agente despeja OSC —
     * empatavam no `at`, e quem ganhava dependia da ordem que o SQLite
     * devolvia sem `ORDER BY` de desempate. `rowid DESC` fixa isso na
     * inserção, que é a resposta que o dono espera.
     */
    latestUnread(): Notification | undefined;
    list(limit: number): Notification[];
    /**
     * Apaga notificação LIDA fora das `keep` mais recentes; devolve quantas
     * saíram (BR-12). Antes disso marca como lida a não lida ANTIGA de cada
     * sessão (fora das `keepUnreadPerSession` mais novas dela) — sem isso uma
     * sessão que nunca é lida cresceria para sempre, fora do alcance da poda.
     */
    prune(keep: number, keepUnreadPerSession?: number): number;
  };
  quota: { set(sessionId: string, q: QuotaSnapshot): void; get(sessionId: string): QuotaSnapshot | undefined };
  /**
   * Monitor de uso (ADR-012). Três tabelas, e nenhuma guarda conteúdo de
   * mensagem: `usage_files` é só o marcador de leitura de cada transcript,
   * `usage_daily` são contagens por dia × modelo × projeto, e `usage_limits`
   * é a última foto das janelas de cota.
   */
  usage: {
    /** Onde a varredura parou num arquivo. `undefined` = nunca lido. */
    fileState(path: string): UsageFileState | undefined;
    /** Todos os marcadores — o poller compara `size`/`mtime` com o disco. */
    listFiles(): UsageFileState[];
    setFileState(state: UsageFileState): void;
    /** Quantos transcripts já foram varridos (linha do estado vazio do painel). */
    fileCount(): number;
    /**
     * SOMA os deltas nos baldes do dia (upsert com `+`). Uma transação só: um
     * lote de mil linhas não pode virar mil commits no meio de um turno.
     */
    addDaily(rows: UsageDailyRow[]): void;
    /** As linhas de `from` a `to` (dias LOCAIS, inclusive nas duas pontas). */
    daily(from: string, to: string): UsageDailyRow[];
    /** Zera contagens E marcadores — é o que `POST /api/usage/rescan` faz. */
    reset(): void;
    limits(lang: Language): UsageLimitWindow[];
    setLimits(limits: UsageLimitWindow[]): void;
  };
  close(): void;
}

function undef<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

interface RepoRow { id: string; path: string; name: string; trust_filters: number | null }
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  repo_id: string | null;
  branch: string | null;
  worktree_json: string | null;
  environment_json: string | null;
  cross_access: number | null;
  created_at: number;
}
interface TabRow {
  id: string;
  workspace_id: string;
  title: string;
  kind: string;
  ord: number;
}
interface PaneRow {
  id: string;
  tab_id: string;
  cwd: string;
  last_kind: string | null;
  last_agent: string | null;
  last_agent_session_id: string | null;
  last_ended_by: string | null;
}
interface LayoutRow { tab_id: string; node_json: string }
interface NotificationRow {
  id: string;
  session_id: string;
  workspace_id: string;
  kind: string;
  text: string;
  at: number;
  read_at: number | null;
}
interface QuotaRow { session_id: string; json: string; at: number }
interface UsageFileRow {
  path: string;
  size: number;
  mtime: number;
  offset: number;
  last_id: string | null;
  head_hash: string | null;
  skipped_lines: number | null;
}
interface UsageDailyDbRow {
  day: string;
  model: string;
  project: string;
  source: string;
  input: number;
  output: number;
  cache_write: number;
  cache_write_1h: number;
  cache_read: number;
  cost: number | null;
  messages: number;
}
interface UsageLimitRow { window: string; used_pct: number; resets_at: number | null; seen_at: number }

function repoFromRow(row: RepoRow): Repo {
  return { id: row.id, path: row.path, name: row.name, trustFilters: row.trust_filters === 1 };
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    repoId: undef(row.repo_id),
    branch: undef(row.branch),
    worktree: row.worktree_json ? JSON.parse(row.worktree_json) : undefined,
    environment: row.environment_json ? JSON.parse(row.environment_json) : undefined,
    // `=== 1` e não `!== 0`: coluna NULA (banco de versão anterior) é
    // `undefined`, que é "restrito" — o default seguro da guarda de escopo.
    crossAccess: row.cross_access === 1 ? true : undefined,
    createdAt: row.created_at,
  };
}

function tabFromRow(row: TabRow): Tab {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    kind: 'terminal',
    order: row.ord,
  };
}

function paneFromRow(row: PaneRow): Pane {
  return {
    id: row.id,
    tabId: row.tab_id,
    cwd: row.cwd,
    lastKind: undef(row.last_kind) as Pane['lastKind'],
    lastAgent: undef(row.last_agent) as Pane['lastAgent'],
    lastAgentSessionId: undef(row.last_agent_session_id),
    lastEndedBy: undef(row.last_ended_by) as Pane['lastEndedBy'],
  };
}

/**
 * Migração idempotente: `panes` nasceu na Fase 1 sem `last_kind`/`last_agent`,
 * e ganhou `last_agent_session_id`/`last_ended_by` no lote do resume
 * (04/09/2026). `ALTER TABLE ... ADD COLUMN` não tem `IF NOT EXISTS` no
 * SQLite, então o `PRAGMA table_info` é o guarda — abrir um banco já migrado
 * não faz nada, e o banco de uma versão anterior sobe com as colunas novas
 * nulas (painel sem id de agente e sem marca de quem encerrou, que é
 * exatamente o que ele era).
 */
/**
 * Migração idempotente da coluna de confiança nos filtros (BR-03, fix round 3).
 * Mesmo padrão do `addMissingPaneColumns`: `ALTER TABLE ... ADD COLUMN` não
 * tem `IF NOT EXISTS` no SQLite, então o `PRAGMA table_info` é o guarda. Um
 * banco de versão anterior sobe com a coluna nova em `0` — ou seja, nenhum
 * repositório já conhecido nasce confiado, que é o default seguro.
 */
function addMissingRepoColumns(raw: Database.Database): void {
  const existing = new Set((raw.pragma('table_info(repos)') as { name: string }[]).map((c) => c.name));
  if (!existing.has('trust_filters')) raw.exec('ALTER TABLE repos ADD COLUMN trust_filters INTEGER DEFAULT 0');
}

/**
 * Migração idempotente do ambiente da sessão por workspace (dor verificada
 * #2). Mesmo padrão dos dois acima: `ALTER TABLE ... ADD COLUMN` não tem
 * `IF NOT EXISTS` no SQLite, então o `PRAGMA table_info` é o guarda. Banco de
 * versão anterior sobe com a coluna nula — ou seja, todo workspace já
 * existente continua no `shell` da configuração global, que é exatamente o que
 * ele era.
 */
function addMissingWorkspaceColumns(raw: Database.Database): void {
  const existing = new Set((raw.pragma('table_info(workspaces)') as { name: string }[]).map((c) => c.name));
  if (!existing.has('environment_json')) raw.exec('ALTER TABLE workspaces ADD COLUMN environment_json TEXT');
  // Dor verificada #4 — a liberação da guarda de escopo, por workspace. Banco
  // de versão anterior sobe com `0`: todo workspace já existente nasce
  // RESTRITO, que é o default seguro (e o que ele efetivamente era, já que a
  // guarda não existia).
  if (!existing.has('cross_access')) raw.exec('ALTER TABLE workspaces ADD COLUMN cross_access INTEGER DEFAULT 0');
}

/**
 * Validação de fronteira do layout salvo: o banco pode vir de uma edição do
 * Bridge que tinha outros tipos de aba além de terminal. Aba que não é
 * `terminal` é descartada ao abrir (com o layout e os painéis dela, se
 * houver), em vez de subir como uma aba que ninguém sabe desenhar.
 */
function dropUnknownTabs(raw: Database.Database): void {
  const ids = (raw.prepare("SELECT id FROM tabs WHERE kind <> 'terminal'").all() as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    raw.prepare('DELETE FROM panes WHERE tab_id = ?').run(id);
    raw.prepare('DELETE FROM layouts WHERE tab_id = ?').run(id);
    raw.prepare('DELETE FROM tabs WHERE id = ?').run(id);
  }
}

function addMissingPaneColumns(raw: Database.Database): void {
  const existing = new Set((raw.pragma('table_info(panes)') as { name: string }[]).map((c) => c.name));
  if (!existing.has('last_kind')) raw.exec('ALTER TABLE panes ADD COLUMN last_kind TEXT');
  if (!existing.has('last_agent')) raw.exec('ALTER TABLE panes ADD COLUMN last_agent TEXT');
  if (!existing.has('last_agent_session_id')) raw.exec('ALTER TABLE panes ADD COLUMN last_agent_session_id TEXT');
  if (!existing.has('last_ended_by')) raw.exec('ALTER TABLE panes ADD COLUMN last_ended_by TEXT');
}

/**
 * Migração idempotente da 0.12.1 — **o painel que o core deixou órfão**.
 *
 * Uma linha com `last_kind='agent'`, id de conversa gravado e `last_ended_by`
 * NULO só pode existir por um motivo: o core morreu com o agente vivo. Desde a
 * 0.12.1 o lançamento do agente já grava `'app'`, a saída deliberada grava
 * `'user'` (13/09/2026: `SessionEnd` com motivo de saída ou ✕ do Bridge) e o
 * encerramento do app grava `'app'` — nenhum deles deixa a coluna nula. O que deixa é o core ser MORTO: o
 * instalador NSIS derruba o app sem `WM_CLOSE`, e o desligamento do Windows
 * também.
 *
 * Como a restauração só retoma com `'app'`, essas linhas nunca voltavam. Este
 * carimbo as alcança na próxima subida — inclusive as que já estavam no banco
 * antes da correção que passou a marcar o painel junto com o lançamento do
 * agente.
 *
 * Roda em toda abertura e é idempotente por construção: o `WHERE` exige a
 * coluna NULA, então um painel já carimbado (por aqui ou pelo core, com `'app'`
 * ou com `'user'`) nunca é reescrito. Painel sem id de conversa fica de fora
 * (não há o que retomar) e painel de shell também (shell não retoma).
 */
function rescueOrphanAgentPanes(raw: Database.Database): void {
  raw.exec(`
    UPDATE panes SET last_ended_by = 'app'
     WHERE last_kind = 'agent'
       AND last_agent_session_id IS NOT NULL
       AND last_ended_by IS NULL
  `);
}

function notificationFromRow(row: NotificationRow): Notification {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    kind: row.kind as Notification['kind'],
    text: row.text,
    at: row.at,
    readAt: undef(row.read_at),
  };
}

/**
 * As tabelas do monitor de uso (ADR-012). Numa função separada porque a
 * migração abaixo precisa recriá-las depois de derrubá-las.
 */
function createUsageTables(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS usage_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      -- Aspas obrigatorias: OFFSET e palavra reservada do SQLite.
      "offset" INTEGER NOT NULL,
      last_id TEXT,
      head_hash TEXT,
      -- BU-01/R1: linhas maiores que o teto, puladas pra o offset nunca travar.
      skipped_lines INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'main',
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      -- Escrita de cache de 1 h: coluna propria porque o preco dela e outro
      -- (2x input, contra 1,25x da de 5 min). Ver UsageDailyRow.
      cache_write_1h INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      messages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model, project, source)
    );
    -- Todo recorte da API e uma faixa de dias; sem este indice, o filtro por
    -- day varre a tabela inteira, que cresce um balde por dia x modelo x
    -- projeto x origem.
    CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);
    CREATE TABLE IF NOT EXISTS usage_limits (
      -- Aspas pelo mesmo motivo da coluna offset: WINDOW e reservada.
      "window" TEXT PRIMARY KEY,
      used_pct REAL NOT NULL,
      resets_at INTEGER,
      seen_at INTEGER NOT NULL
    );
  `);
}

/**
 * Migração das tabelas de uso quando o banco vem de uma versão anterior do
 * próprio lote (`usage_daily` sem `source`, `usage_files` sem `head_hash`).
 *
 * Aqui a migração DERRUBA e reconstrói em vez de fazer `ALTER TABLE`, e é uma
 * escolha, não preguiça: `source` entra na CHAVE PRIMÁRIA, e o SQLite não
 * altera chave primária de tabela existente. Mais importante — as duas tabelas
 * são **derivadas**: tudo que está nelas pode ser recalculado lendo os
 * transcripts de novo. Reconstruir custa uma varredura; migrar contagens
 * agregadas sem saber de qual arquivo cada uma veio custaria correção.
 *
 * `usage_limits` não é tocada: ela é a foto do payload, não um agregado.
 */
function rebuildUsageIfStale(raw: Database.Database): void {
  const dailyCols = new Set((raw.pragma('table_info(usage_daily)') as { name: string }[]).map((c) => c.name));
  const fileCols = new Set((raw.pragma('table_info(usage_files)') as { name: string }[]).map((c) => c.name));
  if (
    dailyCols.has('source') &&
    dailyCols.has('cache_write_1h') &&
    fileCols.has('head_hash') &&
    fileCols.has('skipped_lines')
  ) {
    return;
  }
  raw.exec('DROP TABLE IF EXISTS usage_daily; DROP TABLE IF EXISTS usage_files;');
  createUsageTables(raw);
}

export function openDb(path: string | ':memory:'): Db {
  const raw = new Database(path);
  if (path !== ':memory:') {
    raw.pragma('journal_mode = WAL');
  }

  raw.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      trust_filters INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_id TEXT,
      branch TEXT,
      worktree_json TEXT,
      environment_json TEXT,
      cross_access INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      ord INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tabs_workspace_id ON tabs (workspace_id);
    CREATE TABLE IF NOT EXISTS panes (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      last_kind TEXT,
      last_agent TEXT,
      last_agent_session_id TEXT,
      last_ended_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_panes_tab_id ON panes (tab_id);
    CREATE TABLE IF NOT EXISTS layouts (
      tab_id TEXT PRIMARY KEY,
      node_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications (read_at);
    -- A poda por sessao (BR-03/BR-12) particiona por session_id e ordena por at.
    CREATE INDEX IF NOT EXISTS idx_notifications_session_at ON notifications (session_id, at);
    CREATE TABLE IF NOT EXISTS quota (
      session_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      at INTEGER NOT NULL
    );
`);

  createUsageTables(raw);
  rebuildUsageIfStale(raw);

  addMissingRepoColumns(raw);
  addMissingWorkspaceColumns(raw);
  dropUnknownTabs(raw);
  addMissingPaneColumns(raw);
  // Depois do ALTER acima: a coluna precisa existir pra ser carimbada.
  rescueOrphanAgentPanes(raw);

  const insertRepo = raw.prepare(
    `INSERT INTO repos (id, path, name, trust_filters) VALUES (@id, @path, @name, @trust_filters)
     ON CONFLICT(id) DO UPDATE SET path = @path, name = @name`,
  );
  const repoById = raw.prepare('SELECT * FROM repos WHERE id = ?');
  const repoByPath = raw.prepare('SELECT * FROM repos WHERE path = ?');

  /**
   * `path` é `UNIQUE`, e só o conflito de `id` era tratado: dois
   * `upsertRepo(mesmaPasta)` em voo (dois workspaces do mesmo repositório
   * abertos junto, ou dois cores no mesmo perfil) achavam os dois que o repo
   * era novo, geravam ids diferentes e o segundo `INSERT` estourava
   * `SQLITE_CONSTRAINT_UNIQUE` — que subia como 500 no meio do
   * `POST /api/workspaces`.
   *
   * Quem ganha a colisão é o registro que JÁ ESTÁ no banco: é o `id` que os
   * workspaces referenciam e a quem a confiança de filtros (BR-03) está
   * amarrada. Do lado que perdeu aproveita-se só o `name`. Por isso a função
   * devolve o repo gravado — o chamador precisa saber com qual `id` ficou.
   *
   * `trust_filters` NÃO entra em UPDATE nenhum, de propósito: o `upsertRepo`
   * do core roda toda vez que um workspace é aberto, e um objeto `Repo`
   * montado sem o campo apagaria a confiança que o dono deu. Quem muda a
   * confiança é `setTrustFilters`, e só ele.
   */
  const upsertRepoTx = raw.transaction((r: Repo): Repo => {
    const collision = repoByPath.get(r.path) as RepoRow | undefined;
    if (collision && collision.id !== r.id) {
      raw.prepare('UPDATE repos SET name = ? WHERE id = ?').run(r.name, collision.id);
      return repoFromRow({ ...collision, name: r.name });
    }
    insertRepo.run({ id: r.id, path: r.path, name: r.name, trust_filters: r.trustFilters ? 1 : 0 });
    return repoFromRow(repoById.get(r.id) as RepoRow);
  });

  const repos: Db['repos'] = {
    upsert(r) {
      return upsertRepoTx(r);
    },
    list() {
      return (raw.prepare('SELECT * FROM repos').all() as RepoRow[]).map(repoFromRow);
    },
    get(id) {
      const row = raw.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
      return row ? repoFromRow(row) : undefined;
    },
    byPath(path) {
      const row = raw.prepare('SELECT * FROM repos WHERE path = ?').get(path) as RepoRow | undefined;
      return row ? repoFromRow(row) : undefined;
    },
    setTrustFilters(id, trust) {
      raw.prepare('UPDATE repos SET trust_filters = ? WHERE id = ?').run(trust ? 1 : 0, id);
      const row = raw.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
      return row ? repoFromRow(row) : undefined;
    },
  };

  const workspaces: Db['workspaces'] = {
    insert(w) {
      raw
        .prepare(
          `INSERT INTO workspaces (id, name, cwd, repo_id, branch, worktree_json, environment_json, cross_access, created_at)
           VALUES (@id, @name, @cwd, @repo_id, @branch, @worktree_json, @environment_json, @cross_access, @created_at)`,
        )
        .run({
          id: w.id,
          name: w.name,
          cwd: w.cwd,
          repo_id: w.repoId ?? null,
          branch: w.branch ?? null,
          worktree_json: w.worktree ? JSON.stringify(w.worktree) : null,
          environment_json: w.environment ? JSON.stringify(w.environment) : null,
          cross_access: w.crossAccess ? 1 : 0,
          created_at: w.createdAt,
        });
    },
    update(w) {
      raw
        .prepare(
          `UPDATE workspaces SET name=@name, cwd=@cwd, repo_id=@repo_id, branch=@branch, worktree_json=@worktree_json,
                                 environment_json=@environment_json, cross_access=@cross_access, created_at=@created_at
           WHERE id=@id`,
        )
        .run({
          id: w.id,
          name: w.name,
          cwd: w.cwd,
          repo_id: w.repoId ?? null,
          branch: w.branch ?? null,
          worktree_json: w.worktree ? JSON.stringify(w.worktree) : null,
          environment_json: w.environment ? JSON.stringify(w.environment) : null,
          cross_access: w.crossAccess ? 1 : 0,
          created_at: w.createdAt,
        });
    },
    remove(id) {
      raw.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    },
    list() {
      return (raw.prepare('SELECT * FROM workspaces').all() as WorkspaceRow[]).map(workspaceFromRow);
    },
    get(id) {
      const row = raw.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
      return row ? workspaceFromRow(row) : undefined;
    },
  };

  function tabParams(t: Tab): Record<string, string | number | null> {
    return {
      id: t.id,
      workspace_id: t.workspaceId,
      title: t.title,
      kind: t.kind,
      ord: t.order,
    };
  }

  const tabs: Db['tabs'] = {
    insert(t) {
      raw
        .prepare(
          `INSERT INTO tabs (id, workspace_id, title, kind, ord)
           VALUES (@id, @workspace_id, @title, @kind, @ord)`,
        )
        .run(tabParams(t));
    },
    update(t) {
      raw
        .prepare(
          `UPDATE tabs SET workspace_id=@workspace_id, title=@title, kind=@kind, ord=@ord WHERE id=@id`,
        )
        .run(tabParams(t));
    },
    remove(id) {
      raw.prepare('DELETE FROM tabs WHERE id = ?').run(id);
    },
    listByWorkspace(wsId) {
      return (raw.prepare('SELECT * FROM tabs WHERE workspace_id = ? ORDER BY ord ASC').all(wsId) as TabRow[]).map(tabFromRow);
    },
    get(id) {
      const row = raw.prepare('SELECT * FROM tabs WHERE id = ?').get(id) as TabRow | undefined;
      return row ? tabFromRow(row) : undefined;
    },
  };

  function paneParams(p: Pane): Record<string, string | null> {
    return {
      id: p.id,
      tab_id: p.tabId,
      cwd: p.cwd,
      last_kind: p.lastKind ?? null,
      last_agent: p.lastAgent ?? null,
      last_agent_session_id: p.lastAgentSessionId ?? null,
      last_ended_by: p.lastEndedBy ?? null,
    };
  }

  const panes: Db['panes'] = {
    insert(p) {
      raw
        .prepare(
          `INSERT INTO panes (id, tab_id, cwd, last_kind, last_agent, last_agent_session_id, last_ended_by)
           VALUES (@id, @tab_id, @cwd, @last_kind, @last_agent, @last_agent_session_id, @last_ended_by)`,
        )
        .run(paneParams(p));
    },
    update(p) {
      raw
        .prepare(
          `UPDATE panes SET tab_id=@tab_id, cwd=@cwd, last_kind=@last_kind, last_agent=@last_agent,
             last_agent_session_id=@last_agent_session_id, last_ended_by=@last_ended_by
           WHERE id=@id`,
        )
        .run(paneParams(p));
    },
    remove(id) {
      raw.prepare('DELETE FROM panes WHERE id = ?').run(id);
    },
    listByTab(tabId) {
      return (raw.prepare('SELECT * FROM panes WHERE tab_id = ?').all(tabId) as PaneRow[]).map(paneFromRow);
    },
    get(id) {
      const row = raw.prepare('SELECT * FROM panes WHERE id = ?').get(id) as PaneRow | undefined;
      return row ? paneFromRow(row) : undefined;
    },
  };

  const layouts: Db['layouts'] = {
    get(tabId) {
      const row = raw.prepare('SELECT * FROM layouts WHERE tab_id = ?').get(tabId) as LayoutRow | undefined;
      return row ? (JSON.parse(row.node_json) as LayoutNode) : undefined;
    },
    set(tabId, node) {
      raw
        .prepare(
          `INSERT INTO layouts (tab_id, node_json) VALUES (@tab_id, @node_json)
           ON CONFLICT(tab_id) DO UPDATE SET node_json = @node_json`,
        )
        .run({ tab_id: tabId, node_json: JSON.stringify(node) });
    },
    remove(tabId) {
      raw.prepare('DELETE FROM layouts WHERE tab_id = ?').run(tabId);
    },
  };

  const notifications: Db['notifications'] = {
    insert(n) {
      raw
        .prepare(
          `INSERT INTO notifications (id, session_id, workspace_id, kind, text, at, read_at)
           VALUES (@id, @session_id, @workspace_id, @kind, @text, @at, @read_at)`,
        )
        .run({
          id: n.id,
          session_id: n.sessionId,
          workspace_id: n.workspaceId,
          kind: n.kind,
          text: n.text,
          at: n.at,
          read_at: n.readAt ?? null,
        });
    },
    markRead(ids, at) {
      const stmt = raw.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
      const tx = raw.transaction((idList: string[]) => {
        for (const id of idList) stmt.run(at, id);
      });
      tx(ids);
    },
    listUnread() {
      // `rowid ASC` no desempate: sem ele, duas notificações com o mesmo `at`
      // saíam na ordem que o planejador escolhesse. A ordem da lista é a que a
      // UI mostra no painel — ela não pode dançar entre duas leituras iguais.
      return (
        raw.prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY at ASC, rowid ASC').all() as NotificationRow[]
      ).map(notificationFromRow);
    },
    latestUnread() {
      const row = raw
        .prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY at DESC, rowid DESC LIMIT 1')
        .get() as NotificationRow | undefined;
      return row ? notificationFromRow(row) : undefined;
    },
    list(limit) {
      return (raw.prepare('SELECT * FROM notifications ORDER BY at DESC LIMIT ?').all(limit) as NotificationRow[]).map(
        notificationFromRow,
      );
    },
    /**
     * BR-12: a tabela nunca era podada. Uma saída hostil no terminal (A2 —
     * o único atacante que não precisa do token) imprimindo OSC 9 em laço
     * fazia o `bridge.db` do perfil crescer sem limite, e junto com ele o
     * custo de `listUnread()`/`GET /api/notifications`, que varrem a tabela.
     *
     * NÃO lida nunca é apagada: ela ainda tem que aparecer pro dono. O corte
     * é só nas lidas fora das `keep` mais recentes.
     */
    prune(keep, keepUnreadPerSession = 200) {
      const at = Date.now();
      // Re-review do BR-12: só podar LIDAS deixava um buraco — uma sessão que
      // despeja OSC e nunca é lida acumulava linhas não lidas para sempre, e a
      // poda nunca as alcançava. Aqui as não lidas ANTIGAS de cada sessão (fora
      // das `keepUnreadPerSession` mais recentes DELA) são marcadas como lidas;
      // o DELETE logo abaixo então as trata como qualquer outra lida.
      // Window function em vez do `IN (SELECT ... LIMIT)` correlacionado da
      // rodada 2: aquele era O(n^2) (o revisor mediu 41 s em 20 000 linhas) e
      // roda dentro do `push`, ou seja, no caminho de um OSC do terminal.
      // `ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY at DESC, id DESC)`
      // numera as nao lidas de cada sessao numa passada so; o `id DESC` e o
      // desempate estavel quando duas caem no mesmo milissegundo.
      raw
        .prepare(
          `UPDATE notifications SET read_at = @at
           WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY at DESC, id DESC) AS rn
               FROM notifications
               WHERE read_at IS NULL
             )
             WHERE rn > @keepUnread
           )`,
        )
        .run({ at, keepUnread: keepUnreadPerSession });

      const result = raw
        .prepare(
          `DELETE FROM notifications
           WHERE read_at IS NOT NULL
             AND id NOT IN (SELECT id FROM notifications ORDER BY at DESC LIMIT ?)`,
        )
        .run(keep);
      return result.changes;
    },
  };

  const quota: Db['quota'] = {
    set(sessionId, q) {
      raw
        .prepare(
          `INSERT INTO quota (session_id, json, at) VALUES (@session_id, @json, @at)
           ON CONFLICT(session_id) DO UPDATE SET json = @json, at = @at`,
        )
        .run({ session_id: sessionId, json: JSON.stringify(q), at: q.at });
    },
    get(sessionId) {
      const row = raw.prepare('SELECT * FROM quota WHERE session_id = ?').get(sessionId) as QuotaRow | undefined;
      return row ? (JSON.parse(row.json) as QuotaSnapshot) : undefined;
    },
  };

  const selectFile = raw.prepare('SELECT * FROM usage_files WHERE path = ?');
  const upsertFile = raw.prepare(
    `INSERT INTO usage_files (path, size, mtime, "offset", last_id, head_hash, skipped_lines)
     VALUES (@path, @size, @mtime, @offset, @last_id, @head_hash, @skipped_lines)
     ON CONFLICT(path) DO UPDATE SET
       size = @size, mtime = @mtime, "offset" = @offset, last_id = @last_id, head_hash = @head_hash,
       skipped_lines = @skipped_lines`,
  );
  /**
   * O upsert que SOMA. `excluded.*` é a linha que tentou entrar: sem o `+`,
   * uma segunda passada no mesmo dia substituiria o total do dia pelo delta
   * daquela passada — o painel zeraria a cada minuto.
   *
   * `cost` é `COALESCE(usage_daily.cost, 0) + excluded.cost` só quando o
   * delta tem custo; delta sem preço (`NULL`) deixa o acumulado como está,
   * porque somar `NULL` apagaria o custo que já estava lá.
   */
  const upsertDaily = raw.prepare(
    `INSERT INTO usage_daily (day, model, project, source, input, output, cache_write, cache_write_1h, cache_read, cost, messages)
     VALUES (@day, @model, @project, @source, @input, @output, @cache_write, @cache_write_1h, @cache_read, @cost, @messages)
     ON CONFLICT(day, model, project, source) DO UPDATE SET
       input = input + excluded.input,
       output = output + excluded.output,
       cache_write = cache_write + excluded.cache_write,
       cache_write_1h = cache_write_1h + excluded.cache_write_1h,
       cache_read = cache_read + excluded.cache_read,
       cost = CASE WHEN excluded.cost IS NULL THEN usage_daily.cost ELSE COALESCE(usage_daily.cost, 0) + excluded.cost END,
       messages = messages + excluded.messages`,
  );
  const addDailyTx = raw.transaction((rows: UsageDailyRow[]) => {
    for (const row of rows) {
      upsertDaily.run({
        day: row.day,
        model: row.model,
        project: row.project,
        source: row.source,
        input: row.input,
        output: row.output,
        cache_write: row.cacheWrite,
        cache_write_1h: row.cacheWrite1h,
        cache_read: row.cacheRead,
        cost: row.cost,
        messages: row.messages,
      });
    }
  });
  /**
   * Grava a lista INTEIRA de janelas: as que vieram entram (ou sao
   * atualizadas) e as que NAO vieram saem, na mesma transacao.
   *
   * O apagar e o ponto. So com o upsert, uma janela que some do payload
   * (a conta perde o limite de `seven_day` e mantem o de `five_hour`)
   * fossilizava no banco: `GET /api/usage/limits` continuava devolvendo o
   * percentual e o reset de uma janela que ja nao existe, para sempre, e a
   * faixa da sidebar desenhava uma barra que nao descreve nada.
   *
   * A lista VAZIA nao chega aqui — e desde 16/09/2026 nao ha caminho que
   * apague tudo: a ultima foto fica, e `settleLimits` a zera quando a janela
   * renova (ver `noteLimits`).
   */
  const setLimitsTx = raw.transaction((limits: UsageLimitWindow[]) => {
    const stmt = raw.prepare(
      `INSERT INTO usage_limits ("window", used_pct, resets_at, seen_at)
       VALUES (@window, @used_pct, @resets_at, @seen_at)
       ON CONFLICT("window") DO UPDATE SET used_pct = @used_pct, resets_at = @resets_at, seen_at = @seen_at`,
    );
    for (const limit of limits) {
      stmt.run({
        window: limit.window,
        used_pct: limit.usedPct,
        resets_at: limit.resetsAt ?? null,
        seen_at: limit.seenAt,
      });
    }
    const keep = limits.map((l) => l.window);
    const holes = keep.map(() => '?').join(', ');
    raw.prepare(`DELETE FROM usage_limits WHERE "window" NOT IN (${holes})`).run(...keep);
  });

  function fileFromRow(row: UsageFileRow): UsageFileState {
    return {
      path: row.path,
      size: row.size,
      mtime: row.mtime,
      offset: row.offset,
      lastId: undef(row.last_id),
      headHash: undef(row.head_hash),
      skippedLines: row.skipped_lines ?? 0,
    };
  }

  function dailyFromRow(row: UsageDailyDbRow): UsageDailyRow {
    return {
      day: row.day,
      model: row.model,
      project: row.project,
      source: row.source === 'subagents' ? 'subagents' : 'main',
      input: row.input,
      output: row.output,
      cacheWrite: row.cache_write,
      cacheWrite1h: row.cache_write_1h,
      cacheRead: row.cache_read,
      cost: row.cost,
      messages: row.messages,
    };
  }

  const usage: Db['usage'] = {
    fileState(path) {
      const row = selectFile.get(path) as UsageFileRow | undefined;
      return row ? fileFromRow(row) : undefined;
    },
    listFiles() {
      return (raw.prepare('SELECT * FROM usage_files').all() as UsageFileRow[]).map(fileFromRow);
    },
    setFileState(state) {
      upsertFile.run({
        path: state.path,
        size: state.size,
        mtime: state.mtime,
        offset: state.offset,
        last_id: state.lastId ?? null,
        head_hash: state.headHash ?? null,
        skipped_lines: state.skippedLines ?? 0,
      });
    },
    fileCount() {
      return (raw.prepare('SELECT COUNT(*) AS n FROM usage_files').get() as { n: number }).n;
    },
    addDaily(rows) {
      if (rows.length === 0) return;
      addDailyTx(rows);
    },
    daily(from, to) {
      return (
        raw.prepare('SELECT * FROM usage_daily WHERE day >= ? AND day <= ? ORDER BY day ASC').all(from, to) as UsageDailyDbRow[]
      ).map(dailyFromRow);
    },
    reset() {
      raw.exec('DELETE FROM usage_daily; DELETE FROM usage_files;');
    },
    limits(lang) {
      const rows = raw.prepare('SELECT * FROM usage_limits').all() as UsageLimitRow[];
      return rows.map((row) => ({
        window: row.window,
        // O rótulo é DERIVADO da chave, não persistido: uma janela nova
        // (`seven_day_opus`) ganha rótulo pela regra sem migração de banco — e
        // no idioma de AGORA, porque o banco guarda a janela, não a copy.
        label: windowLabel(row.window, lang),
        usedPct: row.used_pct,
        resetsAt: undef(row.resets_at),
        seenAt: row.seen_at,
      }));
    },
    setLimits(limits) {
      if (limits.length === 0) return;
      setLimitsTx(limits);
    },
  };

  return {
    raw,
    repos,
    workspaces,
    tabs,
    panes,
    layouts,
    notifications,
    quota,
    usage,
    close() {
      raw.close();
    },
  };
}
