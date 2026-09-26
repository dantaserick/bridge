/**
 * Dor verificada #4 na pele: o selo 🛡 da linha da sessão, a entrada "Acesso
 * cruzado" do menu "⋯" e o campo `sessions.scopeGuard` do diálogo. Funções
 * puras — nada de DOM.
 */
import type { BridgeConfig, Session, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/components/sidebar/WorkspaceMenu.js';
import { SCOPE_BLOCK_LABEL, scopeBlockNote, scopeBlockBadge } from '../src/sidebarModel.js';
import { SETTINGS_DEFAULTS, fieldValue, patchForField } from '../src/settingsModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    kind: 'agent',
    agent: 'claude',
    state: 'running',
    startedAt: 1,
    stateSince: 1,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\repo\\.worktrees\\a',
    ...overrides,
  };
}

const tarefa: Workspace = {
  id: 'ws-1',
  name: 'mailbox',
  cwd: 'C:\\repo\\.worktrees\\mailbox',
  worktree: { base: 'main', path: 'C:\\repo\\.worktrees\\mailbox' },
  createdAt: 1,
};

const raiz: Workspace = { id: 'ws-2', name: 'repo', cwd: 'C:\\repo', repoId: 'repo-1', createdAt: 1 };

describe('scopeBlockBadge — o selo 🛡 da linha da sessão', () => {
  it('sessão sem recusa nenhuma não ganha selo', () => {
    expect(scopeBlockBadge(session(), PT)).toBeUndefined();
    expect(scopeBlockBadge(session({ scopeBlocks: { count: 0, paths: [] } }), PT)).toBeUndefined();
  });

  it('o texto é o contador e o tooltip traz os caminhos', () => {
    const badge = scopeBlockBadge(
      session({ scopeBlocks: { count: 3, paths: ['C:\\repo\\.worktrees\\b\\x.ts', 'C:\\repo\\.worktrees\\b\\y.ts'] } }),
      PT,
      { worktree: true },
    );
    expect(badge?.text).toBe(`${SCOPE_BLOCK_LABEL} 3`);
    expect(badge?.title).toContain(scopeBlockNote(true, PT));
    expect(badge?.title).toContain('C:\\repo\\.worktrees\\b\\x.ts');
    expect(badge?.title).toContain('C:\\repo\\.worktrees\\b\\y.ts');
  });

  it('contador sem caminhos (lista perdida num cliente antigo) ainda mostra o selo', () => {
    const badge = scopeBlockBadge(session({ scopeBlocks: { count: 2, paths: [] } }), PT, { worktree: true });
    expect(badge?.text).toBe(`${SCOPE_BLOCK_LABEL} 2`);
    expect(badge?.title).toBe(scopeBlockNote(true, PT));
  });

  it('o selo não depende do ESTADO da sessão — a recusa aconteceu e o agente seguiu', () => {
    for (const state of ['idle', 'running', 'done', 'needs-input', 'exited'] as const) {
      expect(scopeBlockBadge(session({ state, scopeBlocks: { count: 1, paths: ['x'] } }), PT)).toBeDefined();
    }
  });

  /**
   * 0.12.2 — a queixa do dono: "eu liberei, mas ainda ficou o escudo azul".
   * Quem zera o contador é o core (`setWorkspaceCrossAccess`); esta trava é a
   * rede da UI, e ela cobre dois instantes reais — o intervalo entre o `PATCH`
   * e o `session.updated` chegar pelo `/ws`, e o snapshot de um workspace já
   * liberado que volta com contador ao reabrir o app.
   */
  it('workspace LIBERADO não mostra o selo, mesmo com contador na sessão', () => {
    const comRecusa = session({ scopeBlocks: { count: 2, paths: ['C:\\repo\\.worktrees\\b\\x.ts'] } });
    expect(scopeBlockBadge(comRecusa, PT, { crossAccess: true })).toBeUndefined();
  });

  it('workspace RESTRITO (ou sem a informação) mostra o selo como antes', () => {
    const comRecusa = session({ scopeBlocks: { count: 2, paths: [] } });
    expect(scopeBlockBadge(comRecusa, PT, { crossAccess: false })?.text).toBe(`${SCOPE_BLOCK_LABEL} 2`);
    expect(scopeBlockBadge(comRecusa, PT, {})?.text).toBe(`${SCOPE_BLOCK_LABEL} 2`);
    expect(scopeBlockBadge(comRecusa, PT)?.text).toBe(`${SCOPE_BLOCK_LABEL} 2`);
  });

  it('liberar e restringir de novo devolve o selo — o contador recomeça do zero no core', () => {
    // A UI não apaga nada: ela só decide o que desenhar. Depois de restringir,
    // a contagem que voltar do core aparece de novo.
    const depoisDeUmaRecusaNova = session({ scopeBlocks: { count: 1, paths: ['C:\\repo\\leiame.md'] } });
    expect(scopeBlockBadge(depoisDeUmaRecusaNova, PT, { crossAccess: false })?.text).toBe(`${SCOPE_BLOCK_LABEL} 1`);
  });
});

describe('menuItems — "Permitir acesso fora do worktree" / "Restringir"', () => {
  const labels = (ws: Workspace, scopeGuard?: boolean): string[] =>
    menuItems(ws, PT, { scopeGuard }).map((item) => item.label);

  it('workspace de TAREFA oferece a liberação, nomeando o worktree', () => {
    expect(labels(tarefa)).toContain('Permitir acesso fora do worktree');
  });

  it('workspace de REPOSITÓRIO nomeia o repositório (a cerca é outra)', () => {
    expect(labels(raiz)).toContain('Permitir acesso fora do repositório');
  });

  it('já liberado, o item vira "Restringir"', () => {
    expect(labels({ ...tarefa, crossAccess: true })).toContain('Restringir ao worktree');
    expect(labels({ ...tarefa, crossAccess: true })).not.toContain('Permitir acesso fora do worktree');
  });

  it('com a guarda desligada na configuração, o item some', () => {
    expect(labels(tarefa, false).some((l) => l.includes('acesso fora'))).toBe(false);
    expect(labels(tarefa, false).some((l) => l.startsWith('Restringir'))).toBe(false);
  });

  it('workspace de WSL não oferece o item — a guarda não vale lá na 0.11.0', () => {
    // Oferecer "Permitir acesso fora do worktree" numa sessão que já pode tudo
    // prometeria uma cerca que não existe (SECURITY.md, risco 18).
    const wsl: Workspace = { ...tarefa, environment: { kind: 'wsl', distro: 'Ubuntu' } };
    expect(labels(wsl).some((l) => l.includes('acesso fora'))).toBe(false);
    expect(labels(wsl).some((l) => l.startsWith('Restringir'))).toBe(false);
    // …e um workspace de Git Bash continua oferecendo.
    expect(labels({ ...tarefa, environment: { kind: 'gitbash' } })).toContain('Permitir acesso fora do worktree');
  });

  it('a ação é `crossAccess` e ela continua existindo com a pasta sumida', () => {
    const items = menuItems(tarefa, PT, { missing: true, scopeGuard: true });
    expect(items.find((i) => i.action === 'crossAccess')).toBeDefined();
    // …enquanto as operações de git somem, como já era.
    expect(items.find((i) => i.action === 'merge')).toBeUndefined();
  });
});

describe('sessions.scopeGuard no diálogo de configurações', () => {
  const config = (sessions: Partial<BridgeConfig['sessions']>): BridgeConfig =>
    ({ sessions: { ...SETTINGS_DEFAULTS.sessions, ...sessions } }) as BridgeConfig;

  it('o default é LIGADA', () => {
    expect(SETTINGS_DEFAULTS.sessions.scopeGuard).toBe(true);
    expect(fieldValue(undefined, 'sessions.scopeGuard')).toBe(true);
  });

  it('um `false` do core não é confundido com campo ausente', () => {
    expect(fieldValue(config({ scopeGuard: false }), 'sessions.scopeGuard')).toBe(false);
  });

  it('o patch é aninhado em `sessions`', () => {
    expect(patchForField('sessions.scopeGuard', false, PT)).toEqual({
      ok: true,
      patch: { sessions: { scopeGuard: false } },
    });
    expect(patchForField('sessions.scopeGuard', true, PT)).toEqual({
      ok: true,
      patch: { sessions: { scopeGuard: true } },
    });
  });
});
