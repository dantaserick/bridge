import type { Workspace } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { MENU_GAP, VIEWPORT_MARGIN, menuPlacement } from '../src/menuPlacement.js';
import { menuItems } from '../src/components/sidebar/WorkspaceMenu.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
/**
 * R8 — o menu "⋯" era `position: absolute` dentro da linha, e a lista de
 * workspaces tem `overflow: auto`: uma tarefa perto do rodapé abria um menu
 * cortado, com "Fechar workspace" fora de alcance. A conta que resolve isso é
 * pura e mora em `menuPlacement`.
 */
describe('menuPlacement (R8)', () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 180, height: 120 };

  function trigger(top: number, right = 260): { top: number; left: number; right: number; bottom: number } {
    return { top, bottom: top + 18, left: right - 18, right };
  }

  it('cabendo embaixo, abre embaixo e alinhado à direita do gatilho', () => {
    const place = menuPlacement(trigger(100), menu, viewport);
    expect(place).toEqual({ top: 118 + MENU_GAP, left: 260 - menu.width, openUp: false });
  });

  it('sem espaço embaixo mas com espaço em cima, abre PRA CIMA', () => {
    const place = menuPlacement(trigger(740), menu, viewport);
    expect(place.openUp).toBe(true);
    expect(place.top).toBe(740 - MENU_GAP - menu.height);
  });

  it('nunca sai da viewport: preso pelas margens dos dois lados', () => {
    // Gatilho colado na esquerda: o alinhamento à direita jogaria o menu pra
    // fora, e o resultado tem que ficar na margem.
    const colado = menuPlacement({ top: 10, bottom: 28, left: 0, right: 40 }, menu, viewport);
    expect(colado.left).toBe(VIEWPORT_MARGIN);

    // Janela baixa demais pros dois lados: fica embaixo, preso à margem, com o
    // começo da lista visível (melhor que um menu inteiro fora da tela).
    const apertado = menuPlacement(trigger(60), { width: 180, height: 700 }, { width: 1000, height: 300 });
    expect(apertado.openUp).toBe(false);
    expect(apertado.top).toBe(VIEWPORT_MARGIN);
    expect(apertado.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it('gatilho colado na direita não empurra o menu pra fora', () => {
    const place = menuPlacement({ top: 10, bottom: 28, left: 982, right: 1000 }, menu, viewport);
    // Alinhar à direita do gatilho colaria o menu na borda: a margem vence.
    expect(place.left).toBe(viewport.width - menu.width - VIEWPORT_MARGIN);
    expect(place.left + menu.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
  });
});

// ------------------------------------------------------------------ entradas

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'feat-x',
    cwd: 'C:\\projetos\\repo\\.worktrees\\feat-x',
    branch: 'feat-x',
    createdAt: 1,
    worktree: { base: 'main', path: 'C:\\projetos\\repo\\.worktrees\\feat-x' },
    ...overrides,
  };
}

const labels = (items: { label: string }[]): string[] => items.map((i) => i.label);

describe('menuItems', () => {
  it('tarefa: diff, mesclar, remover, definir base, explorer e fechar', () => {
    expect(labels(menuItems(workspace(), PT))).toEqual([
      'Novo Claude Code',
      'Novo terminal',
      'Ver diff',
      'Mesclar no base',
      'Remover worktree',
      'Definir base…',
      // Dor #4: a guarda de escopo nasce ligada, então o menu sempre oferece a
      // saída dela — antes do Explorer, junto das outras decisões sobre o
      // workspace.
      'Permitir acesso fora do worktree',
      'Abrir no Explorer',
      'Fechar workspace',
    ]);
  });

  it('workspace comum não tem entrada de git nenhuma', () => {
    expect(labels(menuItems(workspace({ worktree: undefined, branch: 'main' }), PT))).toEqual([
      'Novo Claude Code',
      'Novo terminal',
      'Permitir acesso fora do repositório',
      'Abrir no Explorer',
      'Fechar workspace',
    ]);
  });

  /** R4: em checkout destacado não há branch pra mesclar no base. */
  it('branch HEAD (checkout destacado) esconde "Mesclar no base"', () => {
    expect(labels(menuItems(workspace(), PT, { branch: 'HEAD' }))).not.toContain('Mesclar no base');
    expect(labels(menuItems(workspace(), PT, { branch: 'HEAD' }))).toContain('Ver diff');
  });

  /** Item 13: a pasta sumiu — nenhuma operação tem onde rodar. */
  it('worktree com a pasta sumida deixa só "Fechar workspace"', () => {
    // Dor #4: o acesso cruzado é decisão sobre o WORKSPACE, não operação de
    // git — ele sobrevive à pasta sumida (e é por ele que se desfaz uma
    // liberação dada por engano). Com a guarda desligada, some também.
    expect(labels(menuItems(workspace(), PT, { missing: true, scopeGuard: false }))).toEqual(['Fechar workspace']);
    expect(labels(menuItems(workspace(), PT, { missing: true }))).toEqual([
      'Permitir acesso fora do worktree',
      'Fechar workspace',
    ]);
  });

  it('base deduzido aparece no title das entradas que dependem dele (R3)', () => {
    const items = menuItems(
      workspace({ worktree: { base: 'main', path: 'C:\\projetos\\repo\\.worktrees\\feat-x', baseGuessed: true } }),
      PT,
    );
    expect(items.find((i) => i.action === 'merge')?.title).toContain('(base deduzida)');
    expect(items.find((i) => i.action === 'setBase')?.title).toContain('(base deduzida)');
  });

  it('o branch mostrado no title da remoção é o de AGORA, não o do banco', () => {
    const items = menuItems(workspace(), PT, { branch: 'feat-y' });
    expect(items.find((i) => i.action === 'removeWorktree')?.title).toContain('feat-y');
  });
});

/**
 * BR-03 (fix round 3): a decisão de confiar nos filtros git é do REPOSITÓRIO,
 * e o item só aparece quando há driver declarado — num repo sem filtro nenhum
 * a pergunta não faz sentido e o menu não deve inventá-la.
 */
describe('menuItems — confiança nos filtros git', () => {
  it('sem driver declarado, o item não existe', () => {
    const items = menuItems(workspace(), PT, { hasFilters: false });
    expect(items.find((i) => i.action === 'trustFilters')).toBeUndefined();
  });

  it('com driver e sem confiança, oferece confiar', () => {
    const items = menuItems(workspace(), PT, { hasFilters: true, trustsFilters: false });
    const item = items.find((i) => i.action === 'trustFilters');
    expect(item?.label).toBe('Confiar nos filtros git deste repositório');
  });

  it('já confiado, oferece retirar a confiança', () => {
    const items = menuItems(workspace(), PT, { hasFilters: true, trustsFilters: true });
    const item = items.find((i) => i.action === 'trustFilters');
    expect(item?.label).toBe('Retirar a confiança nos filtros');
  });

  /**
   * A confiança é do repo, não do worktree: com a pasta sumida o dono ainda
   * precisa conseguir DESFAZER uma confiança dada por engano.
   */
  it('continua aparecendo com a pasta do worktree sumida', () => {
    const items = menuItems(workspace(), PT, { missing: true, hasFilters: true, trustsFilters: true });
    expect(items.find((i) => i.action === 'trustFilters')).toBeDefined();
    // e as ações de git continuam fora, como antes.
    expect(items.find((i) => i.action === 'merge')).toBeUndefined();
  });
});
