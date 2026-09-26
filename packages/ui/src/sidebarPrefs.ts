/**
 * O que a sidebar lembra entre uma sessão e outra: quais GRUPOS estão fixados
 * no topo (e em que ordem foram fixados), quais estão recolhidos e quais
 * WORKSPACES quem olha a tela mandou recolher. Mora no `localStorage` da
 * máquina, como a largura da sidebar — é preferência de quem olha a tela, não
 * estado do core.
 *
 * Tudo aqui é defensivo: `localStorage` pode não existir (o teste roda em
 * `environment: node`), pode lançar (modo privado, storage cheio) e o valor
 * gravado pode ter sido editado à mão. Preferência quebrada vira preferência
 * vazia — nunca uma sidebar que não renderiza.
 */

/** Chave do `localStorage`. Namespaceada pra não brigar com nada do host. */
export const SIDEBAR_GROUPS_KEY = 'bridge.sidebar.groups';

export interface GroupPrefs {
  /** Ids de grupo fixados, NA ORDEM EM QUE FORAM FIXADOS (é a ordem da lista). */
  pinned: string[];
  /** Ids de grupo recolhidos; a ordem aqui não significa nada. */
  collapsed: string[];
  /**
   * Ids de WORKSPACE recolhidos (0.12.2). A lista é o negativo do que se vê:
   * todo workspace nasce expandido, e só entra aqui quem foi recolhido no
   * chevron. É por isso que a preferência gravada por uma versão anterior —
   * que não tinha o campo — abre tudo em vez de fechar tudo.
   */
  collapsedWorkspaces: string[];
}

/** Nada lembrado: o estado inicial e também o de qualquer valor inválido. */
export const EMPTY_GROUP_PREFS: GroupPrefs = { pinned: [], collapsed: [], collapsedWorkspaces: [] };

/** Só strings, sem repetição e sem vazias — o resto do array é descartado. */
function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) seen.add(item);
  }
  return [...seen];
}

/**
 * Lê o JSON gravado. Qualquer coisa que não seja um objeto com listas de
 * strings — `null`, texto quebrado, `[1,2]`, `{pinned: 3}` — devolve vazio em
 * vez de explodir: o usuário perde a preferência, não a sidebar.
 */
export function parseGroupPrefs(raw: string | null | undefined): GroupPrefs {
  if (typeof raw !== 'string' || raw.length === 0) return EMPTY_GROUP_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_GROUP_PREFS;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_GROUP_PREFS;
  const record = parsed as Record<string, unknown>;
  return {
    pinned: cleanIds(record.pinned),
    collapsed: cleanIds(record.collapsed),
    // Campo ausente (preferência gravada antes da 0.12.2) vira lista vazia, e
    // lista vazia é "nada recolhido" — a sidebar abre inteira.
    collapsedWorkspaces: cleanIds(record.collapsedWorkspaces),
  };
}

export function readGroupPrefs(): GroupPrefs {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_GROUP_PREFS;
    return parseGroupPrefs(localStorage.getItem(SIDEBAR_GROUPS_KEY));
  } catch {
    return EMPTY_GROUP_PREFS;
  }
}

/** Grava. Falha de escrita é silenciosa: preferência não vale um erro na tela. */
export function writeGroupPrefs(prefs: GroupPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(prefs));
  } catch {
    // Sem storage (modo privado, cota estourada): a preferência vale só nesta sessão.
  }
}

/** Fixar ENFILEIRA no fim — é isso que dá a "ordem em que foram fixados". */
export function togglePinned(prefs: GroupPrefs, id: string): GroupPrefs {
  const pinned = prefs.pinned.includes(id) ? prefs.pinned.filter((x) => x !== id) : [...prefs.pinned, id];
  return { ...prefs, pinned };
}

export function toggleCollapsed(prefs: GroupPrefs, id: string): GroupPrefs {
  const collapsed = prefs.collapsed.includes(id) ? prefs.collapsed.filter((x) => x !== id) : [...prefs.collapsed, id];
  return { ...prefs, collapsed };
}

/**
 * Recolhe/expande UM workspace (0.12.2). O padrão é expandido, então recolher
 * é ACRESCENTAR à lista — e expandir é tirar dela.
 */
export function toggleCollapsedWorkspace(prefs: GroupPrefs, id: string): GroupPrefs {
  const collapsedWorkspaces = prefs.collapsedWorkspaces.includes(id)
    ? prefs.collapsedWorkspaces.filter((x) => x !== id)
    : [...prefs.collapsedWorkspaces, id];
  return { ...prefs, collapsedWorkspaces };
}

/**
 * Este workspace está recolhido? É a única pergunta que a sidebar faz — a
 * resposta padrão (id que ninguém recolheu, preferência de versão anterior,
 * `localStorage` negado) é NÃO, e é isso que deixa tudo aberto por padrão.
 */
export function workspaceCollapsed(prefs: GroupPrefs, id: string): boolean {
  return prefs.collapsedWorkspaces.includes(id);
}

/**
 * Abre o workspace, sem alternar: usado quando o app LEVA você até uma sessão
 * (clique no toast, painel de notificações, `Ctrl+Shift+U`). Revelar uma sessão
 * dentro de um workspace que você tinha recolhido levaria a um painel em foco e
 * a uma sidebar que não mostra a linha dele — o app apontando pra um lugar que
 * ele mesmo esconde.
 *
 * Devolve a MESMA preferência quando não há nada a abrir. É o que deixa o App
 * pular a gravação no `localStorage` (e o re-render) no caso comum, em que o
 * workspace já estava aberto.
 */
export function expandWorkspace(prefs: GroupPrefs, id: string): GroupPrefs {
  if (!prefs.collapsedWorkspaces.includes(id)) return prefs;
  return { ...prefs, collapsedWorkspaces: prefs.collapsedWorkspaces.filter((x) => x !== id) };
}
