import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_GROUP_PREFS,
  SIDEBAR_GROUPS_KEY,
  parseGroupPrefs,
  readGroupPrefs,
  expandWorkspace,
  toggleCollapsed,
  toggleCollapsedWorkspace,
  togglePinned,
  workspaceCollapsed,
  writeGroupPrefs,
} from '../src/sidebarPrefs.js';
import { groupMenuItems } from '../src/components/sidebar/GroupHeader.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
/**
 * O teste roda em `environment: node`: não existe `localStorage` aqui. Cada
 * caso instala o seu (ou um que explode, pra provar que a leitura defensiva
 * segura) e desinstala depois — é o mesmo storage que o modo privado do
 * browser nega.
 */
function installStorage(store: Map<string, string>, broken = false): void {
  const fake = {
    getItem(key: string): string | null {
      if (broken) throw new Error('acesso negado');
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (broken) throw new Error('cota estourada');
      store.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, 'localStorage');
});

// ----------------------------------------------------------- parseGroupPrefs

describe('parseGroupPrefs', () => {
  it('lê o que foi gravado', () => {
    expect(parseGroupPrefs('{"pinned":["r1"],"collapsed":["__loose__"],"collapsedWorkspaces":["ws-1"]}')).toEqual({
      pinned: ['r1'],
      collapsed: ['__loose__'],
      collapsedWorkspaces: ['ws-1'],
    });
  });

  const invalid: Array<[string, string | null | undefined]> = [
    ['nada gravado', null],
    ['undefined', undefined],
    ['string vazia', ''],
    ['JSON quebrado', '{pinned:'],
    ['array no lugar do objeto', '["r1"]'],
    ['null', 'null'],
    ['número', '7'],
  ];

  for (const [name, raw] of invalid) {
    it(`${name} vira preferência vazia`, () => {
      expect(parseGroupPrefs(raw)).toEqual(EMPTY_GROUP_PREFS);
    });
  }

  it('descarta o que não é lista de strings em vez de explodir', () => {
    expect(parseGroupPrefs('{"pinned":3,"collapsed":[1,"r2",null,""],"collapsedWorkspaces":{}}')).toEqual({
      pinned: [],
      collapsed: ['r2'],
      collapsedWorkspaces: [],
    });
  });

  it('tira id repetido', () => {
    expect(parseGroupPrefs('{"pinned":["r1","r1","r2"],"collapsed":[]}').pinned).toEqual(['r1', 'r2']);
  });

  it('objeto sem as chaves vira preferência vazia', () => {
    expect(parseGroupPrefs('{}')).toEqual(EMPTY_GROUP_PREFS);
  });
});

// --------------------------------------------------------- leitura e escrita

describe('readGroupPrefs / writeGroupPrefs', () => {
  it('sem localStorage nenhum (o caso deste ambiente), lê vazio e escrever não quebra', () => {
    expect(readGroupPrefs()).toEqual(EMPTY_GROUP_PREFS);
    expect(() => writeGroupPrefs({ pinned: ['r1'], collapsed: [], collapsedWorkspaces: [] })).not.toThrow();
  });

  it('grava e relê pela chave bridge.sidebar.groups', () => {
    const store = new Map<string, string>();
    installStorage(store);
    writeGroupPrefs({ pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-9'] });
    expect(store.get(SIDEBAR_GROUPS_KEY)).toBe(
      '{"pinned":["r1"],"collapsed":["r2"],"collapsedWorkspaces":["ws-9"]}',
    );
    expect(readGroupPrefs()).toEqual({ pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-9'] });
  });

  it('storage que lança (modo privado, cota) não derruba a sidebar', () => {
    installStorage(new Map(), true);
    expect(readGroupPrefs()).toEqual(EMPTY_GROUP_PREFS);
    expect(() => writeGroupPrefs({ pinned: ['r1'], collapsed: [], collapsedWorkspaces: [] })).not.toThrow();
  });

  it('valor editado à mão e inválido vira vazio', () => {
    const store = new Map<string, string>([[SIDEBAR_GROUPS_KEY, 'lixo']]);
    installStorage(store);
    expect(readGroupPrefs()).toEqual(EMPTY_GROUP_PREFS);
  });
});

// ---------------------------------------------------------------- alternâncias

describe('togglePinned', () => {
  it('fixar enfileira no fim — é isso que dá a ordem de fixação', () => {
    let prefs = EMPTY_GROUP_PREFS;
    prefs = togglePinned(prefs, 'r2');
    prefs = togglePinned(prefs, 'r1');
    expect(prefs.pinned).toEqual(['r2', 'r1']);
  });

  it('fixar de novo desafixa e não mexe nos outros', () => {
    const prefs = togglePinned({ pinned: ['r2', 'r1'], collapsed: ['r9'], collapsedWorkspaces: ['ws-1'] }, 'r2');
    expect(prefs).toEqual({ pinned: ['r1'], collapsed: ['r9'], collapsedWorkspaces: ['ws-1'] });
  });

  it('não muta a preferência que recebeu', () => {
    const before = { pinned: ['r1'], collapsed: [], collapsedWorkspaces: [] };
    togglePinned(before, 'r2');
    expect(before.pinned).toEqual(['r1']);
  });
});

describe('toggleCollapsed', () => {
  it('recolhe e expande o mesmo grupo', () => {
    const collapsed = toggleCollapsed({ pinned: ['r1'], collapsed: [], collapsedWorkspaces: [] }, 'r1');
    expect(collapsed).toEqual({ pinned: ['r1'], collapsed: ['r1'], collapsedWorkspaces: [] });
    expect(toggleCollapsed(collapsed, 'r1').collapsed).toEqual([]);
  });
});

// -------------------------------------- workspaces recolhidos (0.12.2)

/**
 * O pedido do dono de 09/09/2026: "não era pra ser tudo aberto por padrão e se
 * eu quisesse retrair eu clicava?". A lista gravada é o NEGATIVO do que se vê
 * — quem não está nela está aberto —, e é isso que faz uma preferência gravada
 * por uma versão anterior (sem o campo) abrir tudo em vez de fechar tudo.
 */
describe('workspaceCollapsed / toggleCollapsedWorkspace', () => {
  it('workspace que ninguém recolheu está EXPANDIDO', () => {
    expect(workspaceCollapsed(EMPTY_GROUP_PREFS, 'ws-1')).toBe(false);
    expect(workspaceCollapsed({ pinned: [], collapsed: [], collapsedWorkspaces: ['ws-2'] }, 'ws-1')).toBe(false);
  });

  it('só quem está na lista está recolhido', () => {
    expect(workspaceCollapsed({ pinned: [], collapsed: [], collapsedWorkspaces: ['ws-1'] }, 'ws-1')).toBe(true);
  });

  it('o chevron recolhe e expande o mesmo workspace', () => {
    const recolhido = toggleCollapsedWorkspace(EMPTY_GROUP_PREFS, 'ws-1');
    expect(recolhido.collapsedWorkspaces).toEqual(['ws-1']);
    expect(workspaceCollapsed(recolhido, 'ws-1')).toBe(true);
    const aberto = toggleCollapsedWorkspace(recolhido, 'ws-1');
    expect(aberto.collapsedWorkspaces).toEqual([]);
    expect(workspaceCollapsed(aberto, 'ws-1')).toBe(false);
  });

  it('não mexe nas preferências de GRUPO nem nos outros workspaces', () => {
    const antes = { pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-9'] };
    const depois = toggleCollapsedWorkspace(antes, 'ws-1');
    expect(depois).toEqual({ pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-9', 'ws-1'] });
    // E não muta o que recebeu — a `Sidebar` guarda o anterior em estado.
    expect(antes.collapsedWorkspaces).toEqual(['ws-9']);
  });

  /**
   * Compatibilidade com a preferência gravada antes da 0.12.2: o campo não
   * existia, e ler `undefined` como "tudo recolhido" abriria o app com a
   * sidebar toda fechada na primeira subida.
   */
  it('preferência de versão anterior (sem o campo) abre tudo', () => {
    const prefs = parseGroupPrefs('{"pinned":["r1"],"collapsed":["r2"]}');
    expect(prefs.collapsedWorkspaces).toEqual([]);
    expect(workspaceCollapsed(prefs, 'ws-1')).toBe(false);
  });

  it('lista de workspaces editada à mão com lixo dentro vira lista limpa', () => {
    const prefs = parseGroupPrefs('{"collapsedWorkspaces":["ws-1",7,"",null,"ws-1","ws-2"]}');
    expect(prefs.collapsedWorkspaces).toEqual(['ws-1', 'ws-2']);
  });
});

/**
 * `expandWorkspace` abre sem alternar — é o que o `revealSession` usa quando o
 * app LEVA você até uma sessão (toast, painel de notificações, `Ctrl+Shift+U`).
 * A identidade do objeto devolvido é contrato: é por ela que o App decide não
 * gravar no `localStorage` nem re-renderizar no caso comum.
 */
describe('expandWorkspace', () => {
  it('tira o id da lista de recolhidos', () => {
    const prefs = expandWorkspace({ pinned: [], collapsed: [], collapsedWorkspaces: ['ws-1', 'ws-2'] }, 'ws-1');
    expect(prefs.collapsedWorkspaces).toEqual(['ws-2']);
    expect(workspaceCollapsed(prefs, 'ws-1')).toBe(false);
  });

  it('workspace que já estava aberto devolve a MESMA preferência (nada a gravar)', () => {
    const antes = { pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-9'] };
    expect(expandWorkspace(antes, 'ws-1')).toBe(antes);
    expect(expandWorkspace(EMPTY_GROUP_PREFS, 'ws-1')).toBe(EMPTY_GROUP_PREFS);
  });

  it('não mexe nas preferências de grupo nem muta o que recebeu', () => {
    const antes = { pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-1', 'ws-2'] };
    const depois = expandWorkspace(antes, 'ws-2');
    expect(depois).toEqual({ pinned: ['r1'], collapsed: ['r2'], collapsedWorkspaces: ['ws-1'] });
    expect(antes.collapsedWorkspaces).toEqual(['ws-1', 'ws-2']);
  });

  it('abrir é IDEMPOTENTE — o contrário do toggle', () => {
    const uma = expandWorkspace({ pinned: [], collapsed: [], collapsedWorkspaces: ['ws-1'] }, 'ws-1');
    expect(expandWorkspace(uma, 'ws-1')).toBe(uma);
    // …enquanto o chevron, esse sim, alterna.
    expect(toggleCollapsedWorkspace(uma, 'ws-1').collapsedWorkspaces).toEqual(['ws-1']);
  });
});

// ------------------------------------------------------------- menu do grupo

describe('groupMenuItems', () => {
  it('grupo solto oferece "Fixar no topo"', () => {
    expect(groupMenuItems(false, PT).map((i) => [i.action, i.label])).toEqual([['pin', 'Fixar no topo']]);
  });

  it('grupo fixado oferece "Desafixar"', () => {
    expect(groupMenuItems(true, PT).map((i) => [i.action, i.label])).toEqual([['unpin', 'Desafixar']]);
  });
});
