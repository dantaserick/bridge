/**
 * Fix round 3 — o modelo de CONFIANÇA nos filtros git (BR-03) e os residuais
 * que o re-review apontou na rodada 2.
 *
 * O ponto do desenho novo: neutralizar `filter.*` com `-c` quebrava repositório
 * legítimo (`git-crypt`, `nbstripout`, `git-lfs` local) — um `clean` vazio faz
 * todo arquivo filtrado parecer modificado para sempre, e o "Mesclar"/"Remover
 * worktree" passa a recusar por `dirty-worktree` sem o usuário ter mexido em
 * nada. Aqui o Bridge só DETECTA e pergunta.
 *
 * Todo repo é temporário e apagado no `afterEach`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import { openDb } from '../src/db.js';
import type { Repo } from '../src/model.js';
import {
  GitError,
  canRemoveWorktree,
  createWorktree,
  invalidateFilterCache,
  listFilterDrivers,
  mergeIntoBase,
  repoHasFilterDrivers,
  status,
} from '../src/git.js';

const AUTH = { authorization: 'Bearer T' };
const trees: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

function cleanup(): void {
  invalidateFilterCache();
  for (const dir of trees.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // pasta travada por antivírus: é temp, o SO limpa depois.
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

/** Repo com um commit, num caminho com espaço (a regra da Fase 3). */
function makeRepo(): string {
  const root = join(tmp('bridge r3 git '), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  writeFileSync(join(root, 'a.txt'), 'aaaa\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

/** Caminho no formato que o `sh` do git entende (ele não fala `\`). */
function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Repo HOSTIL: `.gitattributes` + `filter.evil.clean` que escreve um marcador.
 * O arquivo muda mantendo o MESMO tamanho, que é o caso em que o git precisa
 * comparar conteúdo e por isso roda o filtro.
 */
function repoHostil(): { root: string; marker: string } {
  const root = makeRepo();
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  git(root, ['add', '.gitattributes']);
  git(root, ['commit', '-m', 'attrs']);
  const marker = join(root, 'marker-filter.txt');
  git(root, ['config', 'filter.evil.clean', `sh -c "echo EXECUTOU > '${shPath(marker)}'; cat"`]);
  writeFileSync(join(root, 'a.txt'), 'bbbb\n', 'utf8');
  return { root, marker };
}

/**
 * Repo LEGÍTIMO: um filtro `rot` que transforma o conteúdo dos dois lados
 * (`clean` e `smudge`). É o repro do revisor: com o filtro neutralizado o
 * arquivo fica eternamente sujo; com ele funcionando, `dirty` é 0.
 */
function repoComFiltroLegitimo(): string {
  const root = join(tmp('bridge r3 rot '), 'meu repo');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['config', 'user.email', 'test@bridge.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.safecrlf', 'false']);
  // `tr` é involutivo aqui: o mesmo comando desfaz o que fez.
  git(root, ['config', 'filter.rot.clean', "sh -c \"tr 'A-Za-z' 'N-ZA-Mn-za-m'\""]);
  git(root, ['config', 'filter.rot.smudge', "sh -c \"tr 'A-Za-z' 'N-ZA-Mn-za-m'\""]);
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=rot\n', 'utf8');
  writeFileSync(join(root, 'segredo.txt'), 'texto em claro\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'inicial']);
  return root;
}

describe('fix round 3 — BR-03: detecção dos drivers de filtro', () => {
  afterEach(cleanup);

  it('detecta driver do config LOCAL', async () => {
    const root = makeRepo();
    git(root, ['config', 'filter.evil.clean', 'cat']);

    expect(await listFilterDrivers(root)).toEqual(['evil']);
    expect(await repoHasFilterDrivers(root)).toBe(true);
  });

  /**
   * A rodada 2 enumerava sem `--includes` e um `include.path` escondia o driver
   * da listagem — o repo hostil passava por "sem filtro" e o poller executava
   * o `clean` do mesmo jeito.
   */
  it('detecta driver escondido atrás de include.path', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'extra.cfg'), '[filter "viaInclude"]\n\tclean = cat\n', 'utf8');
    git(root, ['config', 'include.path', shPath(join(root, 'extra.cfg'))]);

    expect(await listFilterDrivers(root)).toContain('viaInclude');
  });

  it('detecta driver do escopo --worktree', async () => {
    const root = makeRepo();
    git(root, ['config', 'extensions.worktreeConfig', 'true']);
    git(root, ['config', '--worktree', 'filter.noWorktree.clean', 'cat']);

    expect(await listFilterDrivers(root)).toContain('noWorktree');
  });

  /**
   * O `-c filter.<nome>.clean=` da rodada 2 não conseguia sequer EXPRESSAR um
   * nome com `=`. Detectar não tem esse problema — e é por isso que o desenho
   * novo é detecção, não neutralização.
   */
  it('detecta nome de driver com `=`', async () => {
    const root = makeRepo();
    git(root, ['config', 'filter.a=b.clean', 'cat']);

    expect(await listFilterDrivers(root)).toContain('a=b');
  });

  it('repo sem filtro nenhum não é afetado', async () => {
    const root = makeRepo();
    expect(await listFilterDrivers(root)).toEqual([]);
    expect(await repoHasFilterDrivers(root)).toBe(false);
  });

  it('enumeração impossível é fail-closed (trata como "tem driver")', async () => {
    const naoRepo = tmp('bridge-r3-sem-repo-');
    writeFileSync(join(naoRepo, '.git'), 'isto nao e um repositorio\n', 'utf8');

    expect(await repoHasFilterDrivers(naoRepo)).toBe(true);
  });
});

describe('fix round 3 — BR-03: repo HOSTIL', () => {
  afterEach(cleanup);

  it('sem confiança: status não roda o clean e devolve `filters-untrusted`', async () => {
    const { root, marker } = repoHostil();

    const result = await status(root, 'main', { trustFilters: false });

    expect(existsSync(marker)).toBe(false);
    expect(result.error).toBe('filters-untrusted');
    // O branch continua saindo (vem do HEAD, que não toca conteúdo).
    expect(result.branch).toBe('main');
    // E os números NÃO são inventados.
    expect(result.dirty).toBe(0);
    expect(result.ahead).toBe(0);
  });

  it('sem confiança: merge é 409 `filters-untrusted`', async () => {
    const { root, marker } = repoHostil();
    await createWorktree(root, 'tarefa', 'main');

    const err = await mergeIntoBase(root, 'tarefa', 'main', 'ff-only', { trustFilters: false }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('filters-untrusted');
    expect(existsSync(marker)).toBe(false);
  });

  it('sem confiança: canRemoveWorktree é 409 `filters-untrusted`', async () => {
    const { root } = repoHostil();
    const wt = await createWorktree(root, 'tarefa', 'main');

    const err = await canRemoveWorktree(root, wt.path, wt.branch, 'main', { trustFilters: false }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('filters-untrusted');
  });

  /**
   * CONFIADO o comportamento volta a ser o do git puro — inclusive executar o
   * filtro. É a escolha do dono, feita explicitamente; o Bridge não finge que
   * pode proteger de um repositório que a pessoa mandou confiar.
   */
  it('confiado: status roda de verdade (o filtro executa — é a escolha do dono)', async () => {
    const { root, marker } = repoHostil();

    const result = await status(root, 'main', { trustFilters: true });

    expect(result.error).toBeUndefined();
    expect(result.dirty).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('fix round 3 — BR-03: repo LEGÍTIMO (o repro do revisor)', () => {
  afterEach(cleanup);

  it('sem confiança fica em `filters-untrusted`; confiado, dirty é 0 e o ff-merge passa', async () => {
    const root = repoComFiltroLegitimo();

    // 1. Sem confiança: o Bridge não mede nada.
    const semConfianca = await status(root, 'main', { trustFilters: false });
    expect(semConfianca.error).toBe('filters-untrusted');

    // 2. Confiado: o filtro roda como o git manda e o worktree está LIMPO —
    //    era exatamente isto que a neutralização da rodada 2 quebrava
    //    (`dirty` cravado em 1 para sempre).
    const confiado = await status(root, 'main', { trustFilters: true });
    expect(confiado.error).toBeUndefined();
    expect(confiado.dirty).toBe(0);

    // 3. E o fluxo do dono funciona: tarefa, commit, merge ff-only.
    const wt = await createWorktree(root, 'tarefa', 'main');
    writeFileSync(join(wt.path, 'novo.txt'), 'mais texto\n', 'utf8');
    git(wt.path, ['add', 'novo.txt']);
    git(wt.path, ['commit', '-m', 'novo']);

    const merged = await mergeIntoBase(root, wt.branch, 'main', 'ff-only', { trustFilters: true });
    expect(merged.mode).toBe('ff-only');
  }, 30000);
});

describe('fix round 3 — residuais', () => {
  afterEach(cleanup);

  /**
   * O `UPDATE` da rodada 2 usava `IN (SELECT ... LIMIT)` correlacionado por
   * sessão: O(n²), 41 s em 20 000 linhas — e roda dentro do `push`, ou seja,
   * no caminho de um OSC impresso no terminal.
   */
  /** Enche `n` notificações não lidas espalhadas por 20 sessões e devolve o tempo do `prune`. */
  function medirPrune(n: number): number {
    const db = openDb(':memory:');
    try {
      const inserir = db.raw.transaction(() => {
        for (let i = 0; i < n; i += 1) {
          db.notifications.insert({
            id: `n_${i}`,
            sessionId: `sess_${i % 20}`,
            workspaceId: 'ws_1',
            kind: 'custom',
            text: `aviso ${i}`,
            at: 1000 + i,
          });
        }
      });
      inserir();

      const inicio = Date.now();
      db.notifications.prune(n, 200);
      const gasto = Date.now() - inicio;

      // O resultado tem que continuar CERTO: 200 não lidas por sessão × 20.
      expect(db.notifications.listUnread()).toHaveLength(200 * 20);
      return gasto;
    } finally {
      db.close();
    }
  }

  /**
   * O `UPDATE` da rodada 2 usava `IN (SELECT ... LIMIT)` correlacionado por
   * sessão: O(n²), 41 s em 20 000 linhas — e roda dentro do `push`, ou seja,
   * no caminho de um OSC impresso no terminal.
   *
   * A asserção é sobre a FORMA da curva, não sobre um número de parede: a
   * suíte roda 30 arquivos em paralelo e um teto de milissegundos viraria
   * teste instável. Dobrar as linhas numa consulta linear custa ~2×; na
   * quadrática, ~4× — e, no caso medido pelo revisor, dezenas de segundos.
   */
  it('prune com window function escala linear (a versão O(n²) levava 41 s)', () => {
    const dezMil = medirPrune(10_000);
    const vinteMil = medirPrune(20_000);

    // Teto absoluto folgado: a versão antiga levava 41 000 ms em 20 000 linhas.
    expect(vinteMil).toBeLessThan(3000);
    // E a curva: no máximo 3× ao dobrar (linear é 2×; a quadrática seria ~4×).
    // O `+ 20` protege de divisão por um tempo perto de zero.
    expect(vinteMil).toBeLessThan((dezMil + 20) * 3);
  }, 60000);

  it('o índice por (session_id, at) existe', () => {
    const db = openDb(':memory:');
    try {
      const nomes = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
        .map((r) => r.name);
      expect(nomes).toContain('idx_notifications_session_at');
    } finally {
      db.close();
    }
  });

  it('migração do trust_filters é idempotente e o default é 0', () => {
    const dir = tmp('bridge-r3-db-');
    const file = join(dir, 'bridge.db');
    const primeira = openDb(file);
    primeira.repos.upsert({ id: 'repo_1', path: 'C:\\projetos\\x', name: 'x', trustFilters: false });
    primeira.close();

    // Reabrir não pode explodir no `ALTER TABLE` nem perder a confiança.
    const segunda = openDb(file);
    try {
      expect(segunda.repos.get('repo_1')?.trustFilters).toBe(false);
      expect(segunda.repos.setTrustFilters('repo_1', true)?.trustFilters).toBe(true);
      // `upsert` do core roda a cada workspace aberto: NÃO pode apagar a confiança.
      segunda.repos.upsert({ id: 'repo_1', path: 'C:\\projetos\\x', name: 'x', trustFilters: false });
      expect(segunda.repos.get('repo_1')?.trustFilters).toBe(true);
    } finally {
      segunda.close();
    }
  });
});

describe('fix round 3 — PATCH /api/repos/:id', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
    cleanup();
  });

  it('liga e desliga a confiança, e o GET /api/repos reflete', async () => {
    const root = makeRepo();
    git(root, ['config', 'filter.evil.clean', 'cat']);
    core = createCore({ profileDir: tmp('bridge-r3-api-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: root } });
    const repos = (await c.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH })).json() as Repo[];
    const repo = repos[0]!;
    expect(repo.trustFilters).toBe(false);

    const ligado = await c.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repo.id}`,
      headers: AUTH,
      payload: { trustFilters: true },
    });
    expect(ligado.statusCode).toBe(200);
    expect((ligado.json() as Repo).trustFilters).toBe(true);

    const desligado = await c.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repo.id}`,
      headers: AUTH,
      payload: { trustFilters: false },
    });
    expect((desligado.json() as Repo).trustFilters).toBe(false);
  }, 30000);

  it('GET /api/repos/:id/filters lista os drivers declarados', async () => {
    const root = makeRepo();
    git(root, ['config', 'filter.evil.clean', 'cat']);
    core = createCore({ profileDir: tmp('bridge-r3-api-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;
    await c.app.inject({ method: 'POST', url: '/api/workspaces', headers: AUTH, payload: { cwd: root } });
    const repo = ((await c.app.inject({ method: 'GET', url: '/api/repos', headers: AUTH })).json() as Repo[])[0]!;

    const res = await c.app.inject({ method: 'GET', url: `/api/repos/${repo.id}/filters`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { drivers: string[] }).drivers).toEqual(['evil']);
  }, 30000);

  it('corpo inválido é 400 e repo desconhecido é 422', async () => {
    core = createCore({ profileDir: tmp('bridge-r3-api-'), dbPath: ':memory:', port: 0, token: 'T' });
    const c = core;

    const ruim = await c.app.inject({
      method: 'PATCH',
      url: '/api/repos/repo_x',
      headers: AUTH,
      payload: { trustFilters: 'sim' },
    });
    expect(ruim.statusCode).toBe(400);

    const inexistente = await c.app.inject({
      method: 'PATCH',
      url: '/api/repos/repo_x',
      headers: AUTH,
      payload: { trustFilters: true },
    });
    expect(inexistente.statusCode).toBe(422);
  });

  it('sem bearer é 401', async () => {
    core = createCore({ profileDir: tmp('bridge-r3-api-'), dbPath: ':memory:', port: 0, token: 'T' });
    const res = await core.app.inject({ method: 'PATCH', url: '/api/repos/repo_x', payload: { trustFilters: true } });
    expect(res.statusCode).toBe(401);
  });
});
