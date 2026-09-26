import type { EnvironmentInfo, Language, Workspace } from '@bridge/shared';
import { environmentId } from '@bridge/shared';
import { tUi, useT } from '../../i18n.js';
import { PopoverMenu } from './PopoverMenu.js';
import type { PopoverItem } from './PopoverMenu.js';

export { shouldRefocusTrigger } from './PopoverMenu.js';
export type { CloseReason } from './PopoverMenu.js';

/** O que o menu pede; quem executa é o `App` (as ações de `actions.ts`). */
export type WorkspaceMenuAction =
  /** Aba nova neste workspace com um Claude Code / um shell dentro. */
  | 'newClaude'
  | 'newShell'
  | 'diff'
  | 'merge'
  | 'removeWorktree'
  | 'setBase'
  | 'explorer'
  /** BR-03: liga/desliga a confiança nos drivers de `filter.*` do repositório. */
  | 'trustFilters'
  /**
   * Dor verificada #4: liga/desliga a guarda de escopo NESTE workspace
   * ("Permitir acesso fora do worktree" / "Restringir ao worktree").
   */
  | 'crossAccess'
  /**
   * Dor verificada #2 — "Ambiente": uma entrada por ambiente detectado, mais a
   * volta pro padrão. O sufixo é o id textual (`wsl:Ubuntu`, `gitbash`) ou
   * vazio pra "padrão do Bridge".
   */
  | `environment:${string}`
  | 'close';

/** O id do ambiente que a ação carrega; `undefined` = voltar pro padrão. */
export function environmentOfAction(action: WorkspaceMenuAction): string | undefined {
  if (!action.startsWith('environment:')) return undefined;
  const id = action.slice('environment:'.length);
  return id === '' ? undefined : id;
}

export function isEnvironmentAction(action: WorkspaceMenuAction): boolean {
  return action.startsWith('environment:');
}

interface Props {
  workspace: Workspace;
  /** Dor #2 — os ambientes que o core detectou (`GET /api/environments`). */
  environments?: readonly EnvironmentInfo[];
  /** R4 — o branch de AGORA (o do `GitStatus`), não o gravado no banco. */
  branch?: string;
  /** A pasta do worktree sumiu do disco: só sobra "Fechar workspace". */
  missing?: boolean;
  /** BR-03: o repositório declara driver de `filter.*`? */
  hasFilters?: boolean;
  /** BR-03: o dono já disse que confia nesses drivers? */
  trustsFilters?: boolean;
  /** Dor #4: a guarda de escopo está LIGADA na configuração global? */
  scopeGuard?: boolean;
  onPick: (action: WorkspaceMenuAction) => void;
}

type Item = PopoverItem<WorkspaceMenuAction>;

export interface MenuContext {
  /** Branch corrente do worktree; `HEAD` = checkout destacado. */
  branch?: string;
  /** A pasta do worktree não existe mais. */
  missing?: boolean;
  /**
   * BR-03 — o repositório declara driver de `filter.*` (`clean`/`smudge`/
   * `process`). Só com isto o item de confiança aparece: num repo sem filtro
   * nenhum a pergunta não faz sentido e o menu não deve inventá-la.
   */
  hasFilters?: boolean;
  /** BR-03 — o dono já confiou nos drivers deste repositório. */
  trustsFilters?: boolean;
  /** Dor #2 — os ambientes detectados na máquina. Lista vazia = nenhuma entrada de ambiente. */
  environments?: readonly EnvironmentInfo[];
  /**
   * Dor #4 — a guarda de escopo está ligada na configuração global
   * (`sessions.scopeGuard`). Com ela desligada o item não aparece: oferecer
   * "permitir acesso fora do worktree" quando NADA está sendo barrado seria um
   * interruptor que não faz nada.
   */
  scopeGuard?: boolean;
}

/**
 * As entradas do menu (spec §7). As de git só existem pra workspace de
 * worktree — num workspace comum não há base pra mesclar nem worktree pra
 * remover, e mostrar a entrada desabilitada só faria o usuário clicar.
 *
 * Duas exclusões vieram da onda de correção final:
 * - `missing` (a pasta sumiu do disco): nenhuma operação de git tem onde
 *   rodar, então sobra "Fechar workspace";
 * - branch `HEAD` (checkout destacado dentro do worktree): não existe branch
 *   pra mesclar no base, e o `git merge HEAD` faria coisa nenhuma ou coisa
 *   errada. "Ver diff" continua (o diff de `base...HEAD` é legítimo).
 */
export function menuItems(workspace: Workspace, lang: Language, ctx: MenuContext = {}): Item[] {
  const worktree = workspace.worktree;
  const branch = ctx.branch ?? workspace.branch;
  const items: Item[] = [];

  // Pedido do dono (10/09/2026): subir um Claude Code direto do menu, sem
  // depender do atalho (que mira o painel focado) nem de um painel vazio.
  // Com a pasta sumida não há onde abrir um shell, então nada disso aparece.
  if (!ctx.missing) {
    items.push(
      { action: 'newClaude', label: tUi(lang, 'menu.novoClaude'), title: tUi(lang, 'menu.novoClaude.titulo') },
      { action: 'newShell', label: tUi(lang, 'menu.novoTerminal'), title: tUi(lang, 'menu.novoTerminal.titulo') },
    );
  }

  if (worktree && !ctx.missing) {
    const base = worktree.base;
    const guessed = worktree.baseGuessed === true;
    items.push({ action: 'diff', label: tUi(lang, 'menu.diff'), title: tUi(lang, 'menu.diff.titulo', { base }) });
    if (branch !== 'HEAD') {
      items.push({
        action: 'merge',
        label: tUi(lang, 'menu.mesclar'),
        title: tUi(lang, guessed ? 'menu.mesclar.tituloDeduzida' : 'menu.mesclar.titulo', { base }),
      });
    }
    items.push({
      action: 'removeWorktree',
      label: tUi(lang, 'menu.removerWorktree'),
      title: branch
        ? tUi(lang, 'menu.removerWorktree.titulo', { branch })
        : tUi(lang, 'menu.removerWorktree.tituloSemBranch'),
    });
    items.push({
      action: 'setBase',
      label: tUi(lang, 'menu.definirBase'),
      title: tUi(lang, guessed ? 'menu.definirBase.tituloDeduzida' : 'menu.definirBase.titulo', { base }),
    });
  }

  /*
   * BR-03: a decisão sobre os filtros do REPOSITÓRIO. Aparece só quando há
   * driver declarado — e continua aparecendo com a pasta `missing`, porque é
   * uma propriedade do repo, não do worktree, e é o caminho pra desfazer uma
   * confiança dada por engano.
   */
  // Fix round 4 (cosmético): a condição é `hasFilters` E SÓ. Antes o item
  // aparecia por `trustsFilters` sozinho, então um repo confiado que perdeu o
  // driver continuava oferecendo "Retirar a confiança" pra sempre.
  if (ctx.hasFilters) {
    items.push(
      ctx.trustsFilters
        ? {
            action: 'trustFilters',
            label: tUi(lang, 'menu.filtros.retirar'),
            title: tUi(lang, 'menu.filtros.retirar.titulo'),
          }
        : {
            action: 'trustFilters',
            label: tUi(lang, 'menu.filtros.confiar'),
            title: tUi(lang, 'menu.filtros.confiar.titulo'),
          },
    );
  }

  /*
   * Dor verificada #2 — "Ambiente". Uma entrada por ambiente DETECTADO (o
   * `GET /api/environments`), mais "Padrão do Bridge" pra voltar ao `shell` da
   * configuração global. O ambiente em vigor entra marcado com `•` e não some
   * da lista: sumir faria o menu não dizer onde a sessão sobe hoje.
   *
   * Ambiente sem `claude` continua ESCOLHÍVEL (só o rótulo avisa): quem vai
   * abrir um shell numa distro não precisa do agente instalado nela.
   */
  const current = workspace.environment ? environmentId(workspace.environment) : undefined;
  for (const env of ctx.environments ?? []) {
    const mark = env.id === current ? '• ' : '';
    const warn = env.available
      ? env.claude
        ? ''
        : tUi(lang, 'menu.ambiente.semClaude')
      : tUi(lang, 'menu.ambiente.indisponivel');
    items.push({
      action: `environment:${env.id}`,
      // `env.label` e `env.reason` chegam do core JÁ traduzidos
      // (`environments.list(lang)`) — a UI não os retraduz.
      // Concatenação e não template: dentro de um template a guarda de idioma
      // lê o texto INTEIRO (chaves de catálogo incluídas) e o denuncia como
      // literal em pt-BR. Somar as três partes diz a mesma coisa sem o falso
      // positivo.
      label: mark + tUi(lang, 'menu.ambiente.rotulo', { rotulo: env.label }) + warn,
      title: env.reason ?? tUi(lang, 'menu.ambiente.titulo', { id: env.id }),
    });
  }
  if (current !== undefined) {
    items.push({
      action: 'environment:',
      label: tUi(lang, 'menu.ambiente.padrao'),
      title: tUi(lang, 'menu.ambiente.padrao.titulo'),
    });
  }

  /*
   * Dor verificada #4 — a liberação da guarda de escopo DESTE workspace.
   *
   * Continua aparecendo com a pasta `missing` (é uma decisão sobre o
   * workspace, não uma operação de git), e o rótulo diz qual é a raiz: num
   * workspace de tarefa a cerca é o worktree, num workspace de repo é o repo
   * inteiro. Sem essa distinção o menu prometeria uma cerca que não existe.
   *
   * Workspace de WSL não mostra o item porque na 0.11.0 a guarda não vale lá
   * (`SECURITY.md` risco 18): oferecer "Permitir acesso fora do worktree" numa
   * sessão que já pode tudo é prometer uma cerca que não existe — o mesmo
   * motivo de o item sumir com a guarda desligada na configuração.
   */
  if (ctx.scopeGuard !== false && workspace.environment?.kind !== 'wsl') {
    // As MESMAS chaves que a razão do `deny` do core usa (`core.escopo.menu.*`):
    // a recusa que o agente lê manda procurar "Permitir acesso fora do
    // worktree" pelo nome, e o item precisa se chamar exatamente assim.
    const cerca = tUi(lang, worktree ? 'core.escopo.menu.worktree' : 'core.escopo.menu.repo');
    items.push(
      workspace.crossAccess
        ? {
            action: 'crossAccess',
            label: tUi(lang, 'menu.escopo.restringir', { menu: cerca }),
            title: tUi(lang, 'menu.escopo.restringir.titulo'),
          }
        : {
            action: 'crossAccess',
            label: tUi(lang, 'menu.escopo.permitir', { menu: cerca }),
            title: tUi(lang, 'menu.escopo.permitir.titulo'),
          },
    );
  }

  if (!ctx.missing) items.push({ action: 'explorer', label: tUi(lang, 'menu.explorer'), title: workspace.cwd });
  items.push({ action: 'close', label: tUi(lang, 'menu.fechar') });
  return items;
}

/**
 * O "⋯" da linha do workspace. A mecânica (abrir, fechar, posicionar, andar de
 * seta) é do `PopoverMenu`; o que é do workspace são as entradas.
 */
export function WorkspaceMenu({
  workspace,
  branch,
  missing,
  hasFilters,
  trustsFilters,
  environments,
  scopeGuard,
  onPick,
}: Props): JSX.Element {
  const { t, lang } = useT();
  return (
    <PopoverMenu
      variant="workspace-menu"
      // O nome entra no rótulo: com uma linha por workspace, um leitor de tela
      // anunciaria N botões "Ações do workspace" idênticos.
      label={t('sidebar.workspace.acoes', { nome: workspace.name })}
      items={menuItems(workspace, lang, { branch, missing, hasFilters, trustsFilters, environments, scopeGuard })}
      onPick={onPick}
    />
  );
}
