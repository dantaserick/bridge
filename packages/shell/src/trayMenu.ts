/**
 * O TEXTO da bandeja, separado do Electron (`tray.ts`) de propósito: é isto
 * que o vitest deste pacote consegue rodar (ambiente node, sem `Tray` nem `Menu`), e é isto que
 * muda quando o idioma muda.
 *
 * Quem monta o `Menu.buildFromTemplate` e chama `tray.setToolTip` é o
 * `tray.ts`, com o que sair daqui.
 */
import { t } from '@bridge/shared';
import type { Language } from '@bridge/shared';

/** As ações do menu, por id — o `tray.ts` liga cada uma ao seu `click`. */
export type TrayItemId = 'show' | 'quit';

export interface TrayItem {
  id: TrayItemId;
  label: string;
}

/**
 * Os dois itens do menu (spec §4), nesta ordem: "Mostrar" primeiro porque é o
 * que se clica todo dia, "Sair" por último porque é o que não tem volta.
 */
export function trayMenuItems(lang: Language): TrayItem[] {
  return [
    { id: 'show', label: t(lang, 'shell.bandeja.mostrar') },
    { id: 'quit', label: t(lang, 'shell.bandeja.sair') },
  ];
}

/**
 * O tooltip do ícone. Sem nada por ler é só a MARCA — "Bridge" não é copy e
 * não se traduz; o que se traduz é a contagem que vem depois dela.
 */
export function trayTooltip(unread: number, lang: Language): string {
  return unread > 0 ? t(lang, 'shell.bandeja.naoLidas', { n: unread }) : 'Bridge';
}
