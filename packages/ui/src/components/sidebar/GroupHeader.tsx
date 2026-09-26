import type { Language, SessionState } from '@bridge/shared';
import { tUi, useT } from '../../i18n.js';
import { groupCountLabel, groupHeaderLabel } from '../../sidebarModel.js';
import { ChevronIcon, PinIcon } from '../icons.js';
import { PopoverMenu } from './PopoverMenu.js';
import type { PopoverItem } from './PopoverMenu.js';
import { StateRing } from './StateRing.js';

/** O que o menu "⋯" do grupo pede; quem grava a preferência é a `Sidebar`. */
export type GroupMenuAction = 'pin' | 'unpin';

interface Props {
  name: string;
  /** Quantos workspaces o grupo tem — vira o contador quando ele está recolhido. */
  count: number;
  collapsed: boolean;
  pinned: boolean;
  /**
   * Pior estado entre as sessões do grupo (`collapsedGroupState`). Só chega
   * preenchido com o grupo recolhido: aberto, cada linha já mostra o seu.
   */
  ringState?: SessionState;
  onToggleCollapsed: () => void;
  onMenuAction: (action: GroupMenuAction) => void;
}

/** Uma entrada só, e ela alterna: fixado desafixa, solto fixa. */
export function groupMenuItems(pinned: boolean, lang: Language): PopoverItem<GroupMenuAction>[] {
  return pinned
    ? [
        {
          action: 'unpin',
          label: tUi(lang, 'sidebar.grupo.desafixar'),
          title: tUi(lang, 'sidebar.grupo.desafixar.titulo'),
        },
      ]
    : [
        {
          action: 'pin',
          label: tUi(lang, 'sidebar.grupo.fixar'),
          title: tUi(lang, 'sidebar.grupo.fixar.titulo'),
        },
      ];
}

/**
 * O cabeçalho de um grupo da sidebar. O título é um botão: clicar recolhe e
 * expande (o chevron diz qual dos dois), e o "⋯" do hover fixa o grupo no
 * topo. Recolhido, o cabeçalho passa a carregar o contador de workspaces e o
 * anel do pior estado do grupo — recolher esconde as linhas, nunca o aviso de
 * que alguma sessão travou.
 *
 * O "⋯" é IRMÃO do botão do título, não filho: botão dentro de botão é
 * conteúdo interativo aninhado, e o clique no menu teria que cancelar o
 * recolher (é a mesma regra da `WorkspaceRow`).
 */
export function GroupHeader({
  name,
  count,
  collapsed,
  pinned,
  ringState,
  onToggleCollapsed,
  onMenuAction,
}: Props): JSX.Element {
  const { t, lang } = useT();
  return (
    <div className={pinned ? 'group-header pinned' : 'group-header'}>
      <button
        type="button"
        className="group-header-main"
        aria-expanded={!collapsed}
        // O contador e o anel do grupo recolhido são a única pista de que há
        // algo lá dentro pedindo atenção; sem rótulo, o leitor de tela lia só
        // o nome do repositório e um número solto.
        aria-label={groupHeaderLabel({ name, count, collapsed, ringState }, lang)}
        title={t(collapsed ? 'sidebar.chevron.expandir' : 'sidebar.chevron.recolher', { nome: name })}
        data-sidebar-row="group"
        onClick={onToggleCollapsed}
      >
        <ChevronIcon open={!collapsed} />
        <span className="group-name">{name}</span>
        {pinned && <PinIcon className="group-pin" />}
      </button>
      {/*
        O anel e o contador ficam FORA do botão, então o leitor de tela os leria
        DEPOIS do `aria-label` que já diz as duas coisas. Escondidos aqui, sobra
        um controle só — e o `title` continua valendo pro mouse.
      */}
      {collapsed && ringState && <StateRing state={ringState} hidden />}
      {collapsed && (
        <span className="group-count" title={groupCountLabel(count, lang)} aria-hidden="true">
          {count}
        </span>
      )}
      {/* O nome do grupo entra no rótulo pelo mesmo motivo da linha do workspace. */}
      <PopoverMenu
        variant="group-menu"
        label={t('sidebar.grupo.acoes', { nome: name })}
        items={groupMenuItems(pinned, lang)}
        onPick={onMenuAction}
      />
    </div>
  );
}
