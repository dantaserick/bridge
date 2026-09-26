import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { menuPlacement } from '../../menuPlacement.js';
import type { Placement } from '../../menuPlacement.js';
import { MoreIcon } from '../icons.js';

/**
 * O "⋯" e o popover que ele abre — a mecânica que a linha do workspace e o
 * cabeçalho do grupo compartilham. Aparece no hover e no foco (teclado), fecha
 * no Esc, no clique fora, no scroll e no resize, e as setas andam pelos itens.
 * O estado de aberto é DELE: quem usa só recebe a ação escolhida.
 *
 * R8 — o popover é `position: fixed`, posicionado pelo
 * `getBoundingClientRect()` do gatilho (`menuPlacement`). Como `absolute`
 * dentro da linha ele era cortado pelo `overflow: auto` da sidebar: workspace
 * perto do rodapé abria um menu com as últimas entradas inalcançáveis. Sendo
 * fixed, ele não acompanha o scroll — por isso o scroll fecha o menu em vez de
 * deixá-lo flutuando longe da linha que o abriu.
 */

export interface PopoverItem<A extends string> {
  action: A;
  label: string;
  title?: string;
}

interface Props<A extends string> {
  items: PopoverItem<A>[];
  onPick: (action: A) => void;
  /**
   * Prefixo das classes CSS: sai `<prefix>`, `<prefix>-button` e
   * `<prefix>-list`. É o que deixa o menu do workspace e o do grupo terem
   * peles diferentes com a mesma mecânica.
   */
  variant: string;
  /** Nome acessível do gatilho (vai no `aria-label` e no `title`). */
  label: string;
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** Por que o menu fechou — decide pra onde vai o foco. */
export type CloseReason = 'escape' | 'pick' | 'outside';

/**
 * O foco volta pro "⋯" quando o menu fecha: sem isso ele cai no `<body>` e
 * quem navega por teclado perde o lugar na sidebar.
 *
 * A exceção é o clique fora: aí o usuário já escolheu onde quer estar (um
 * campo, outra linha), e puxar o foco de volta pro botão seria roubar. Só que
 * um clique fora em área não-focável deixa o foco DENTRO do menu que acabou de
 * sumir — nesse caso ele também volta pro botão.
 */
export function shouldRefocusTrigger(reason: CloseReason, focusInsideMenu: boolean): boolean {
  return reason !== 'outside' || focusInsideMenu;
}

export function PopoverMenu<A extends string>({ items, onPick, variant, label }: Props<A>): JSX.Element {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | undefined>();
  const ref = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /** Único caminho de fechar: fecha e devolve o foco quando é o certo. */
  const close = useRef((reason: CloseReason): void => {
    const inside = ref.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    setPlacement(undefined);
    if (shouldRefocusTrigger(reason, inside)) triggerRef.current?.focus();
  }).current;

  useEffect(() => {
    if (!open) return;
    function onDocument(ev: MouseEvent): void {
      const target = ev.target as Node;
      if (!ref.current?.contains(target) && !listRef.current?.contains(target)) close('outside');
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') close('escape');
    }
    // `capture` no scroll: a sidebar rola num container interno, e evento de
    // scroll não borbulha até o document.
    const onScroll = (): void => close('outside');
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDocument);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  /**
   * Mede o menu JÁ RENDERIZADO e só então o posiciona: a altura depende de
   * quantas entradas ele tem, e um palpite erraria justamente no caso que o R8
   * corrige. Até a medida ele fica invisível — um frame com o menu no canto
   * seria pior que nenhum.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = listRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    setPlacement(
      menuPlacement(trigger, { width: menu.width, height: menu.height }, { width: innerWidth, height: innerHeight }),
    );
  }, [open, items.length]);

  // Abriu: o primeiro item recebe o foco, senão o teclado ficaria no botão.
  useEffect(() => {
    if (open) listRef.current?.querySelector('button')?.focus();
  }, [open]);

  function pick(action: A): void {
    close('pick');
    onPick(action);
  }

  function onListKeyDown(ev: React.KeyboardEvent<HTMLDivElement>): void {
    if (!NAV_KEYS.has(ev.key)) return;
    ev.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll('button') ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    const index =
      ev.key === 'Home'
        ? 0
        : ev.key === 'End'
          ? buttons.length - 1
          : (((current === -1 ? 0 : current) + step) % buttons.length + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }

  return (
    <div className={variant} ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className={`${variant}-button`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => {
          if (open) close('escape');
          else setOpen(true);
        }}
      >
        <MoreIcon />
      </button>
      {open && (
        <div
          className={`${variant}-list`}
          role="menu"
          ref={listRef}
          onKeyDown={onListKeyDown}
          style={placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0, visibility: 'hidden' }}
        >
          {items.map((item) => (
            <button key={item.action} type="button" role="menuitem" title={item.title} onClick={() => pick(item.action)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
