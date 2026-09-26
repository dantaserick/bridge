/**
 * Resolução de `<sessionId|workspace>` contra o snapshot de `GET /api/state`
 * — as poucas formas que a CLI aceita id OU nome (spec §8).
 */
import type { HelloState, Pane, Tab, Workspace } from '@bridge/shared';
import { CliError } from './client.js';

/**
 * Id é único por construção (`newId('ws')`) — casa primeiro e sempre sem
 * ambiguidade. Nome não é único (dois workspaces podem se chamar igual): mais
 * de um casando por nome é erro (fix round 1), não "pega o primeiro" — errar
 * silenciosamente pro workspace errado é pior que forçar o usuário a usar o
 * id.
 */
export function findWorkspace(state: HelloState, idOrName: string): Workspace {
  const byId = state.layout.workspaces.find((w) => w.id === idOrName);
  if (byId) return byId;

  const byName = state.layout.workspaces.filter((w) => w.name === idOrName);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const options = byName.map((w) => `${w.id} (${w.cwd})`).join(', ');
    throw new CliError({
      key: 'cli.resolve.nomeAmbiguo',
      params: { n: byName.length, nome: idOrName, opcoes: options },
    });
  }
  throw new CliError({ key: 'cli.resolve.workspaceNaoEncontrado', params: { alvo: idOrName } });
}

/** `<sessionId|workspaceName>` de `bridge focus` — sessão direta, ou a primeira ativa do workspace. */
export function resolveFocusSessionId(state: HelloState, target: string): string {
  const direct = state.sessions.find((s) => s.id === target);
  if (direct) return direct.id;

  const workspace = findWorkspace(state, target);
  const candidates = state.sessions.filter((s) => s.workspaceId === workspace.id);
  const alive = candidates.find((s) => s.state !== 'exited') ?? candidates[0];
  if (!alive) throw new CliError({ key: 'cli.resolve.workspaceSemSessao', params: { alvo: target } });
  return alive.id;
}

/** Painel-base pra `bridge new`: a primeira aba de terminal do workspace, e o primeiro painel dela. */
export function firstTerminalPane(state: HelloState, workspace: Workspace): Pane {
  const tabs: Tab[] = state.layout.tabs.filter((t) => t.workspaceId === workspace.id && t.kind === 'terminal');
  for (const tab of tabs) {
    const pane = state.layout.panes.find((p) => p.tabId === tab.id);
    if (pane) return pane;
  }
  throw new CliError({ key: 'cli.resolve.workspaceSemAba', params: { workspace: workspace.id } });
}
