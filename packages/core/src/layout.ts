import { win32 } from 'node:path';
import type { Db } from './db.js';
import { PaneNotFoundError, TabAdoptError } from './errors.js';
import type { EventBus } from './events.js';
import { newId } from './ids.js';
import type { AgentId, LayoutNode, LayoutSnapshot, Pane, Tab, Workspace } from './model.js';

export type { LayoutSnapshot } from './model.js';

/**
 * Troca a folha `paneId` por um split que tem ela em `a` e `subtree` em `b`.
 * É a forma geral do split: um painel novo é a subárvore de uma folha só
 * (`splitLeaf`), e uma aba adotada inteira é a árvore dela (`adoptTab`).
 */
export function graftLeaf(root: LayoutNode, paneId: string, dir: 'v' | 'h', subtree: LayoutNode): LayoutNode {
  if (root.type === 'leaf') {
    if (root.paneId !== paneId) return root;
    return { type: 'split', dir, ratio: 0.5, a: { type: 'leaf', paneId }, b: subtree };
  }
  return { ...root, a: graftLeaf(root.a, paneId, dir, subtree), b: graftLeaf(root.b, paneId, dir, subtree) };
}

export function splitLeaf(root: LayoutNode, paneId: string, dir: 'v' | 'h', newPaneId: string): LayoutNode {
  return graftLeaf(root, paneId, dir, { type: 'leaf', paneId: newPaneId });
}

export function leaves(root: LayoutNode): string[] {
  if (root.type === 'leaf') return [root.paneId];
  return [...leaves(root.a), ...leaves(root.b)];
}

export function removeLeaf(root: LayoutNode, paneId: string): LayoutNode | undefined {
  if (root.type === 'leaf') {
    return root.paneId === paneId ? undefined : root;
  }
  if (leaves(root.a).includes(paneId)) {
    const newA = removeLeaf(root.a, paneId);
    return newA === undefined ? root.b : { ...root, a: newA };
  }
  if (leaves(root.b).includes(paneId)) {
    const newB = removeLeaf(root.b, paneId);
    return newB === undefined ? root.a : { ...root, b: newB };
  }
  return root;
}

interface PathEntry {
  split: Extract<LayoutNode, { type: 'split' }>;
  side: 'a' | 'b';
}

function pathTo(root: LayoutNode, paneId: string): PathEntry[] | undefined {
  if (root.type === 'leaf') {
    return root.paneId === paneId ? [] : undefined;
  }
  const inA = pathTo(root.a, paneId);
  if (inA !== undefined) return [{ split: root, side: 'a' }, ...inA];
  const inB = pathTo(root.b, paneId);
  if (inB !== undefined) return [{ split: root, side: 'b' }, ...inB];
  return undefined;
}

export function neighborOf(root: LayoutNode, paneId: string, dir: 'left' | 'right' | 'up' | 'down'): string | undefined {
  const path = pathTo(root, paneId);
  if (path === undefined) return undefined;
  const compatDir = dir === 'left' || dir === 'right' ? 'v' : 'h';
  const wantSide: 'a' | 'b' = dir === 'right' || dir === 'down' ? 'a' : 'b';
  for (const entry of [...path].reverse()) {
    if (entry.split.dir !== compatDir) continue;
    if (entry.side !== wantSide) continue;
    const other = wantSide === 'a' ? entry.split.b : entry.split.a;
    return leaves(other)[0];
  }
  return undefined;
}

/** Extremos do divisor: nem 0 nem 1, senão um dos lados some da tela. */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

/**
 * Devolve uma árvore nova com o `ratio` do split MAIS PRÓXIMO acima do leaf
 * (o divisor que o usuário arrastou é sempre o do pai imediato). `undefined`
 * quando o painel não está na árvore ou é a raiz — nesse caso não há divisor.
 */
export function withLeafRatio(root: LayoutNode, paneId: string, ratio: number): LayoutNode | undefined {
  if (root.type === 'leaf') return undefined;
  const isChild = (n: LayoutNode): boolean => n.type === 'leaf' && n.paneId === paneId;
  if (isChild(root.a) || isChild(root.b)) return { ...root, ratio };
  const a = withLeafRatio(root.a, paneId, ratio);
  if (a) return { ...root, a };
  const b = withLeafRatio(root.b, paneId, ratio);
  if (b) return { ...root, b };
  return undefined;
}

/**
 * R1 — o split que SEPARA dois leaves (menor ancestral comum). É o divisor que
 * o usuário arrastou: a UI manda o primeiro leaf de cada lado do divisor, e
 * só o split que tem um deles em cada ramo pode ser o dono daquele arraste.
 *
 * `withLeafRatio` sozinho não serve: ele sobe até o pai IMEDIATO de um leaf,
 * e numa árvore `split_v { a: split_h{p1,p4}, b: p2 }` arrastar o divisor
 * externo com o id de p1 mexeria no `split_h` interno — o bug F2.
 *
 * `undefined` quando um dos leaves não está na árvore, quando são o mesmo, ou
 * quando a raiz é leaf (não existe divisor nenhum).
 */
export function lowestCommonSplit(
  root: LayoutNode,
  paneA: string,
  paneB: string,
): Extract<LayoutNode, { type: 'split' }> | undefined {
  if (paneA === paneB) return undefined;
  if (root.type === 'leaf') return undefined;
  const inA = leaves(root.a);
  const inB = leaves(root.b);
  const aLeft = inA.includes(paneA);
  const bLeft = inA.includes(paneB);
  const aRight = inB.includes(paneA);
  const bRight = inB.includes(paneB);
  if (!(aLeft || aRight) || !(bLeft || bRight)) return undefined;
  // Um de cada lado: este split é o divisor entre eles.
  if ((aLeft && bRight) || (aRight && bLeft)) return root;
  return lowestCommonSplit(aLeft ? root.a : root.b, paneA, paneB);
}

/** Troca o `ratio` de um split específico (comparação por identidade) na árvore. */
function withSplitRatio(
  root: LayoutNode,
  target: Extract<LayoutNode, { type: 'split' }>,
  ratio: number,
): LayoutNode {
  if (root.type === 'leaf') return root;
  if (root === target) return { ...root, ratio };
  return { ...root, a: withSplitRatio(root.a, target, ratio), b: withSplitRatio(root.b, target, ratio) };
}

export class Layout {
  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  snapshot(): LayoutSnapshot {
    const workspaces = this.db.workspaces.list();
    const tabs: Tab[] = [];
    const panes: Pane[] = [];
    const layouts: Record<string, LayoutNode> = {};
    for (const ws of workspaces) {
      const wsTabs = this.db.tabs.listByWorkspace(ws.id);
      tabs.push(...wsTabs);
      for (const tab of wsTabs) {
        panes.push(...this.db.panes.listByTab(tab.id));
        const node = this.db.layouts.get(tab.id);
        if (node) layouts[tab.id] = node;
      }
    }
    return { repos: this.db.repos.list(), workspaces, tabs, panes, layouts };
  }

  createWorkspace(input: {
    name?: string;
    cwd: string;
    environment?: Workspace['environment'];
  }): { workspace: Workspace; tab: Tab; pane: Pane } {
    const name = input.name ?? (win32.basename(input.cwd) || input.cwd);
    const workspace: Workspace = {
      id: newId('ws'),
      name,
      cwd: input.cwd,
      environment: input.environment,
      createdAt: Date.now(),
    };
    this.db.workspaces.insert(workspace);

    const tab: Tab = { id: newId('tab'), workspaceId: workspace.id, title: 'Terminal', kind: 'terminal', order: 0 };
    this.db.tabs.insert(tab);

    const pane: Pane = { id: newId('pane'), tabId: tab.id, cwd: workspace.cwd };
    this.db.panes.insert(pane);
    this.db.layouts.set(tab.id, { type: 'leaf', paneId: pane.id });

    this.bus.emit({ type: 'layout.changed' });
    return { workspace, tab, pane };
  }

  /**
   * Grava o que a detecção de repo descobriu sobre o workspace (Fase 3):
   * `repoId`, branch corrente e, quando o cwd é um worktree, `{ base, path }`.
   *
   * Fica separado do `createWorkspace` de propósito — ele continua PURO
   * (nenhum `git` roda dentro do Layout); quem detecta é o `Core`, que é
   * async. Emite `layout.changed` porque a linha do workspace na sidebar
   * mostra o branch: sem o evento, uma segunda janela ficaria com a linha
   * vazia até o próximo redesenho por outro motivo.
   */
  setWorkspaceGit(id: string, git: Pick<Workspace, 'repoId' | 'branch' | 'worktree'>): Workspace | undefined {
    const workspace = this.db.workspaces.get(id);
    if (!workspace) return undefined;
    const updated: Workspace = { ...workspace, repoId: git.repoId, branch: git.branch, worktree: git.worktree };
    this.db.workspaces.update(updated);
    this.bus.emit({ type: 'layout.changed' });
    return updated;
  }

  /**
   * Troca o AMBIENTE do workspace (dor verificada #2). `undefined` volta pro
   * `shell` da configuração global.
   *
   * Vale da PRÓXIMA sessão em diante — mudar o ambiente não mexe em PTY vivo:
   * o processo já está de pé no shell de antes, e matá-lo por causa de uma
   * escolha de menu jogaria fora o trabalho que está rodando ali. Emite
   * `layout.changed` porque a linha da sidebar mostra o ambiente.
   */
  setWorkspaceEnvironment(id: string, environment: Workspace['environment']): Workspace | undefined {
    const workspace = this.db.workspaces.get(id);
    if (!workspace) return undefined;
    const updated: Workspace = { ...workspace, environment };
    this.db.workspaces.update(updated);
    this.bus.emit({ type: 'layout.changed' });
    return updated;
  }

  /**
   * Liga/desliga o acesso fora da raiz do workspace (dor verificada #4).
   *
   * Ao contrário do ambiente, esta troca vale NA HORA: a guarda é consultada a
   * cada `PreToolUse`, então o próximo `Read` do agente que já está de pé já
   * enxerga a decisão nova — que é o que o menu promete quando o dono libera
   * no meio de um turno travado.
   */
  setWorkspaceCrossAccess(id: string, crossAccess: boolean): Workspace | undefined {
    const workspace = this.db.workspaces.get(id);
    if (!workspace) return undefined;
    const updated: Workspace = { ...workspace, crossAccess: crossAccess ? true : undefined };
    this.db.workspaces.update(updated);
    this.bus.emit({ type: 'layout.changed' });
    return updated;
  }

  removeWorkspace(id: string): void {
    const tabs = this.db.tabs.listByWorkspace(id);
    for (const tab of tabs) this.removeTabInternal(tab.id);
    this.db.workspaces.remove(id);
    this.bus.emit({ type: 'layout.changed' });
  }

  createTab(workspaceId: string): { tab: Tab; pane: Pane } {
    const existing = this.db.tabs.listByWorkspace(workspaceId);
    const order = existing.length === 0 ? 0 : Math.max(...existing.map((t) => t.order)) + 1;
    const tab: Tab = { id: newId('tab'), workspaceId, title: 'Terminal', kind: 'terminal', order };
    this.db.tabs.insert(tab);

    const workspace = this.db.workspaces.get(workspaceId);
    const cwd = workspace?.cwd ?? '';
    const pane: Pane = { id: newId('pane'), tabId: tab.id, cwd };
    this.db.panes.insert(pane);
    this.db.layouts.set(tab.id, { type: 'leaf', paneId: pane.id });

    this.bus.emit({ type: 'layout.changed' });
    return { tab, pane };
  }

  removeTab(id: string): void {
    this.removeTabInternal(id);
    this.bus.emit({ type: 'layout.changed' });
  }

  private removeTabInternal(id: string): void {
    const panes = this.db.panes.listByTab(id);
    for (const pane of panes) this.db.panes.remove(pane.id);
    this.db.layouts.remove(id);
    this.db.tabs.remove(id);
  }

  /**
   * Consistência de erro nesta classe: os métodos que PRECISAM do painel pra
   * ter resultado (`splitPane`, `paneCwd`) lançam `PaneNotFoundError` — a rota
   * traduz em 404. Os idempotentes (`removePane`, `neighbor`) continuam
   * silenciosos de propósito: remover algo que já não existe é sucesso, e
   * "não tem vizinho" e "não tem painel" são a mesma resposta pro chamador.
   */
  splitPane(paneId: string, dir: 'v' | 'h'): Pane {
    const pane = this.db.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);

    const newPane: Pane = { id: newId('pane'), tabId: pane.tabId, cwd: pane.cwd };
    this.db.panes.insert(newPane);

    const root = this.db.layouts.get(pane.tabId) ?? { type: 'leaf' as const, paneId };
    this.db.layouts.set(pane.tabId, splitLeaf(root, paneId, dir, newPane.id));

    this.bus.emit({ type: 'layout.changed' });
    return newPane;
  }

  /**
   * "Dividir com uma aba já aberta": a árvore inteira da aba `tabId` entra no
   * lado b do split novo do painel, os painéis dela passam a ser da aba do
   * painel, e a aba esvaziada some. As sessões não são tocadas — elas apontam
   * pra `paneId`, e os painéis continuam os mesmos. Só aba do
   * MESMO workspace: cwd e ambiente são do workspace, e misturar dois num
   * layout só prometeria um contexto que o painel não tem.
   */
  adoptTab(paneId: string, dir: 'v' | 'h', tabId: string): { tabId: string; removedTabId: string } {
    const pane = this.db.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);
    const source = this.db.tabs.get(tabId);
    if (!source) throw new TabAdoptError('tab-not-found', tabId);
    if (source.id === pane.tabId) throw new TabAdoptError('same-tab', tabId);
    const target = this.db.tabs.get(pane.tabId);
    if (!target || target.workspaceId !== source.workspaceId) throw new TabAdoptError('other-workspace', tabId);

    const sourcePanes = this.db.panes.listByTab(source.id);
    const first = sourcePanes[0];
    // Uma aba sem painel nenhum não tem o que trazer: só some.
    const subtree: LayoutNode | undefined =
      this.db.layouts.get(source.id) ?? (first ? { type: 'leaf', paneId: first.id } : undefined);

    for (const p of sourcePanes) this.db.panes.update({ ...p, tabId: target.id });
    this.db.layouts.remove(source.id);
    this.db.tabs.remove(source.id);
    if (subtree) {
      const root = this.db.layouts.get(target.id) ?? { type: 'leaf' as const, paneId };
      this.db.layouts.set(target.id, graftLeaf(root, paneId, dir, subtree));
    }

    this.bus.emit({ type: 'layout.changed' });
    return { tabId: target.id, removedTabId: source.id };
  }

  removePane(paneId: string): void {
    const pane = this.db.panes.get(paneId);
    if (!pane) return;
    const tabId = pane.tabId;
    const root = this.db.layouts.get(tabId);
    const newRoot = root ? removeLeaf(root, paneId) : undefined;

    if (newRoot === undefined) {
      this.removeTabInternal(tabId);
    } else {
      this.db.panes.remove(paneId);
      this.db.layouts.set(tabId, newRoot);
    }

    this.bus.emit({ type: 'layout.changed' });
  }

  neighbor(paneId: string, dir: 'left' | 'right' | 'up' | 'down'): string | undefined {
    const pane = this.db.panes.get(paneId);
    if (!pane) return undefined;
    const root = this.db.layouts.get(pane.tabId);
    if (!root) return undefined;
    return neighborOf(root, paneId, dir);
  }

  /**
   * Grava o `ratio` do divisor imediatamente acima do painel (arrastar o
   * divisor na UI). Painel único na aba é no-op silencioso: não existe
   * divisor pra mexer, e emitir `layout.changed` faria a UI redesenhar à toa.
   */
  setRatio(paneId: string, ratio: number): void {
    const pane = this.db.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);
    if (!Number.isFinite(ratio)) return;
    const root = this.db.layouts.get(pane.tabId);
    if (!root) return;

    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    const updated = withLeafRatio(root, paneId, clamped);
    if (!updated) return;

    this.db.layouts.set(pane.tabId, updated);
    this.bus.emit({ type: 'layout.changed' });
  }

  /**
   * R1 — grava o `ratio` do divisor que separa DOIS painéis: a UI manda o
   * primeiro leaf de cada lado do divisor arrastado, e o core resolve o menor
   * ancestral comum dos dois. É o caminho certo em árvore aninhada, onde o pai
   * imediato de um leaf não é necessariamente o divisor que o usuário pegou.
   *
   * Sem irmão resolvível (id desconhecido, mesmo painel, árvore sem esse par)
   * cai no `setRatio` de sempre — o pai imediato — que continua correto pro
   * caso simples e não deixa o arraste sem efeito nenhum.
   */
  setRatioBetween(paneId: string, siblingPaneId: string, ratio: number): void {
    const pane = this.db.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);
    if (!Number.isFinite(ratio)) return;
    const root = this.db.layouts.get(pane.tabId);
    if (!root) return;

    const split = lowestCommonSplit(root, paneId, siblingPaneId);
    if (!split) {
      this.setRatio(paneId, ratio);
      return;
    }

    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    this.db.layouts.set(pane.tabId, withSplitRatio(root, split, clamped));
    this.bus.emit({ type: 'layout.changed' });
  }

  /**
   * Marca o que rodou por último no painel. É metadado do restore (spec §10),
   * não geometria: NÃO emite `layout.changed` — vai junto no snapshot na
   * próxima leitura, e a UI não precisa redesenhar a árvore por causa disso.
   *
   * 0.7.0 — **o id da conversa sobrevive ao shell**. Antes um shell no painel
   * apagava `lastAgent`/`lastAgentSessionId` ("aqui não é mais o Claude"), e
   * isso matava o `bridge resume`: com o `restore.resumeAgents` desligado (ou
   * com o resume da subida falhando) o painel volta como SHELL, e era
   * exatamente aí que a memória de qual conversa rodava ali se perdia — o
   * comando não tinha o que retomar. Quem decide RETOMAR SOZINHO continua
   * sendo `lastKind === 'agent'` + `lastEndedBy === 'app'` (`panesToRestore`
   * na UI), e os dois seguem sendo escritos como antes; o id guardado é só a
   * memória que o `bridge resume` explícito lê depois.
   */
  setPaneLast(paneId: string, kind: 'shell' | 'agent', agent?: AgentId, resume?: string): void {
    const pane = this.db.panes.get(paneId);
    if (!pane) return;
    this.db.panes.update({
      ...pane,
      lastKind: kind,
      // Shell PRESERVA o agente do painel (ver acima); só um agente novo
      // redefine quem é o dono da vaga.
      lastAgent: kind === 'agent' ? agent : pane.lastAgent,
      // Sessão NOVA no painel: a marca de quem encerrou a anterior morre aqui.
      // Deixá-la faria a próxima subida achar que este painel ainda estava
      // com um agente fechado pelo app — e retomar por cima do que subiu agora.
      lastEndedBy: undefined,
      // Agente NOVO: o id é o da conversa que ESTA sessão retoma (`--resume`),
      // ou nada — um agente novo não herda o id antigo (se o app fechasse
      // antes do primeiro hook, a próxima subida retomaria uma conversa que
      // esta sessão nunca foi); o SessionStart grava o id definitivo em
      // segundos. Shell só passa por cima do painel: a conversa fica guardada.
      lastAgentSessionId: kind === 'agent' ? resume : pane.lastAgentSessionId,
    });
  }

  /**
   * Grava o `session_id` do agente no painel (vem do hook, via core). Só
   * escreve quando MUDA: todo hook do Claude Code traz o id, e regravar a
   * cada `PreToolUse` seria uma escrita no SQLite por ferramenta usada.
   *
   * Devolve `true` quando gravou — é o que diz ao core se vale emitir o
   * `layout.changed` que faz a UI reler o estado.
   */
  setPaneAgentSession(paneId: string, agentSessionId: string): boolean {
    const pane = this.db.panes.get(paneId);
    if (!pane || pane.lastAgentSessionId === agentSessionId) return false;
    this.db.panes.update({ ...pane, lastAgentSessionId: agentSessionId });
    return true;
  }

  /**
   * Marca quem encerrou a última sessão do painel. Metadado de restauração,
   * como o `setPaneLast`: NÃO emite `layout.changed` — quem lê é a próxima
   * subida do Bridge, lendo o SQLite, e a UI já soube do fim pelo
   * `session.exited`.
   */
  setPaneEnded(paneId: string, by: 'user' | 'app'): void {
    const pane = this.db.panes.get(paneId);
    if (!pane || pane.lastEndedBy === by) return;
    this.db.panes.update({ ...pane, lastEndedBy: by });
  }

  paneCwd(paneId: string): string {
    const pane = this.db.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);
    return pane.cwd;
  }

  /**
   * Quantos painéis (leaves) a aba do painel tem. R1 usa isso pra decidir se
   * `killSession` pode remover o painel: com um leaf só, remover fecharia a
   * aba inteira, então o painel fica vazio no lugar.
   */
  leafCountForPane(paneId: string): number {
    const pane = this.db.panes.get(paneId);
    if (!pane) return 0;
    const root = this.db.layouts.get(pane.tabId);
    if (!root) return 0;
    return leaves(root).length;
  }
}
