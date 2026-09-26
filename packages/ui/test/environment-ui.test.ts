import type { EnvironmentInfo, Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { environmentNote } from '../src/components/NewWorkspaceDialog.js';
import { environmentOfAction, isEnvironmentAction, menuItems } from '../src/components/sidebar/WorkspaceMenu.js';
import { workspaceRowLabel } from '../src/sidebarModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
/**
 * Dor verificada #2 na pele: as entradas de "Ambiente" no menu "⋯" e o que o
 * leitor de tela anuncia na linha do workspace. Funções puras — nada de DOM.
 */

const environments: EnvironmentInfo[] = [
  // Fora do WSL `interop` é sempre `true`. Na `Ubuntu` daqui o interop está
  // ligado (por isso o `reason` é o de "sem claude", e não o de interop); a
  // `Parada` nem respondeu, então não tem interop nenhum.
  { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7 (pwsh)', available: true, claude: true, node: true, interop: true },
  { id: 'gitbash', kind: 'gitbash', label: 'Git Bash', available: true, claude: true, node: true, interop: true },
  {
    id: 'wsl:Ubuntu',
    kind: 'wsl',
    distro: 'Ubuntu',
    label: 'WSL · Ubuntu',
    available: true,
    claude: false,
    node: true,
    interop: true,
    reason: 'sem claude nesta distro (o Bridge não sobe agente aqui)',
  },
  {
    id: 'wsl:Parada',
    kind: 'wsl',
    distro: 'Parada',
    label: 'WSL · Parada',
    available: false,
    claude: false,
    node: false,
    interop: false,
    reason: 'a distro não respondeu (não instalada, parada ou sem shell)',
  },
];

function workspace(environment?: Workspace['environment']): Workspace {
  return { id: 'ws_1', name: 'app', cwd: 'C:\\projetos\\app', environment, createdAt: 1 };
}

describe('menuItems — "Ambiente"', () => {
  it('sem lista de ambientes, o menu é exatamente o de antes', () => {
    const labels = menuItems(workspace(), PT).map((i) => i.label);
    expect(labels.some((l) => l.startsWith('Ambiente'))).toBe(false);
    // A guarda de escopo (dor #4) acrescentou UMA entrada a este menu, e a
    // fixture é um workspace de repositório (sem `worktree`) — a cerca dele é
    // o repo inteiro, e o rótulo diz isso. O que este teste continua provando
    // é que sem lista de ambientes não existe entrada "Ambiente".
    expect(labels).toEqual([
      'Novo Claude Code',
      'Novo terminal',
      'Permitir acesso fora do repositório',
      'Abrir no Explorer',
      'Fechar workspace',
    ]);
  });

  it('uma entrada por ambiente detectado, com o aviso no rótulo', () => {
    const items = menuItems(workspace(), PT, { environments });
    const envItems = items.filter((i) => i.action.startsWith('environment:'));
    expect(envItems.map((i) => i.label)).toEqual([
      'Ambiente: PowerShell 7 (pwsh)',
      'Ambiente: Git Bash',
      'Ambiente: WSL · Ubuntu (sem claude)',
      'Ambiente: WSL · Parada (indisponível)',
    ]);
    expect(envItems[2]!.title).toContain('sem claude');
  });

  it('o ambiente EM VIGOR vem marcado e ganha a saída "padrão do Bridge"', () => {
    const items = menuItems(workspace({ kind: 'wsl', distro: 'Ubuntu' }), PT, { environments });
    const marked = items.find((i) => i.label.startsWith('• '));
    expect(marked?.action).toBe('environment:wsl:Ubuntu');
    expect(items.some((i) => i.action === 'environment:')).toBe(true);
  });

  it('sem ambiente escolhido não existe "voltar pro padrão" (não há o que desfazer)', () => {
    const items = menuItems(workspace(), PT, { environments });
    expect(items.some((i) => i.action === 'environment:')).toBe(false);
  });

  it('as entradas de git continuam antes das de ambiente num worktree', () => {
    const task = { ...workspace(), worktree: { base: 'main', path: 'C:\\wt' } };
    const actions = menuItems(task, PT, { environments, branch: 'tarefa' }).map((i) => i.action);
    expect(actions.indexOf('diff')).toBeLessThan(actions.indexOf('environment:pwsh'));
    expect(actions[actions.length - 1]).toBe('close');
  });
});

describe('environmentOfAction / isEnvironmentAction', () => {
  it('extrai o id, e o sufixo vazio quer dizer "padrão do Bridge"', () => {
    expect(environmentOfAction('environment:wsl:Ubuntu')).toBe('wsl:Ubuntu');
    expect(environmentOfAction('environment:gitbash')).toBe('gitbash');
    expect(environmentOfAction('environment:')).toBeUndefined();
  });

  it('não confunde com as outras ações do menu', () => {
    expect(isEnvironmentAction('close')).toBe(false);
    expect(isEnvironmentAction('trustFilters')).toBe(false);
    expect(environmentOfAction('merge')).toBeUndefined();
  });
});

describe('workspaceRowLabel — o ambiente no leitor de tela', () => {
  it('sem ambiente, o rótulo é o de antes', () => {
    expect(workspaceRowLabel({ name: 'app', state: 'idle', sessions: 1 }, PT)).toBe('Workspace app, 1 sessão, ociosa');
  });

  it('com ambiente escolhido, ele entra no fim', () => {
    expect(workspaceRowLabel({ name: 'app', state: 'idle', sessions: 1, environment: 'wsl:Ubuntu' }, PT)).toBe(
      'Workspace app, 1 sessão, ociosa, ambiente wsl:Ubuntu',
    );
  });

  it('ambiente com problema é anunciado — é a única pista pra quem não vê o âmbar', () => {
    expect(
      workspaceRowLabel({ name: 'app', state: 'idle', sessions: 0, environment: 'wsl:Alpine', environmentProblem: true }, PT),
    ).toBe('Workspace app, sem sessões, ambiente wsl:Alpine, ambiente sem claude ou indisponível');
  });
});

/**
 * Fix round 1 — a frase do diálogo tem que ser VERDADE nos dois casos.
 *
 * Escolher Git Bash não muda onde o Claude Code roda: o adaptador resolve o
 * `claude.cmd` do PATH do Windows e o PTY sobe ele direto, sem passar pelo
 * shell escolhido. Só `wsl:` move os dois. A primeira versão dizia "o shell E
 * o Claude Code sobem aqui dentro" pros quatro ambientes.
 */
describe('environmentNote — o que a escolha REALMENTE muda', () => {
  it('WSL: os dois sobem dentro da distro', () => {
    const nota = environmentNote('wsl:Ubuntu', PT);
    expect(nota).toContain('Claude Code');
    expect(nota).toContain('distro');
  });

  it('ambiente do Windows: muda o shell, e diz que o Claude continua no Windows', () => {
    for (const id of ['pwsh', 'powershell', 'gitbash']) {
      const nota = environmentNote(id, PT);
      expect(nota, id).toContain('shell');
      expect(nota, id).toContain('Windows');
      // Nada de prometer que o agente muda de lugar.
      expect(nota, id).not.toContain('distro');
    }
  });

  it('sem escolha, aponta pro shell da configuração', () => {
    expect(environmentNote('', PT)).toContain('configuração');
  });
});
