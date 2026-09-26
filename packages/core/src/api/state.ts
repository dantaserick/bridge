import type { HelloState } from '@bridge/shared';
import type { Core } from '../core.js';

/**
 * O snapshot inteiro (spec §8): o corpo de `GET /api/state` E o `hello` do
 * WS. Existe em um lugar só porque os dois TÊM que ser idênticos — quando o
 * `git` entrou no snapshot, o `hello` que ficasse pra trás faria a sidebar
 * abrir sem os `+N ~M` até o primeiro evento.
 */
export function snapshotState(core: Core): HelloState {
  const snapshot = core.deps.layout.snapshot();
  return {
    // Fix round 4: `hasFilterDrivers` e medido em memoria (nao persiste), e e
    // aqui que ele encontra o snapshot do banco. Sem isto, um workspace de RAIZ
    // num repo com driver nao teria como oferecer o "Confiar nos filtros" — o
    // poller so calcula `GitStatus` de worktree.
    layout: {
      ...snapshot,
      repos: snapshot.repos.map((repo) => ({
        ...repo,
        hasFilterDrivers: core.deps.repoFilters.get(repo.id) ?? false,
      })),
    },
    sessions: core.deps.sessions.list(),
    unread: core.deps.notifications.unread(),
    git: Object.fromEntries(core.deps.gitStatus),
    // BR-07: `false` = o `icacls` falhou e o `instance.json` (que carrega o
    // token) ficou com a ACL herdada. A UI mostra uma faixa; sem isso a falha
    // ficaria só no log, que ninguém abre.
    instanceAclApplied: core.deps.instanceAclApplied,
  };
}
