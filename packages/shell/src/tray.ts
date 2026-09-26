/**
 * Bandeja do Bridge (spec §4): ícone gerado em memória (sem asset externo pra
 * não depender de arquivo binário no repo) com a MESMA marca do ícone do app
 * (`iconMark.ts`, o `BridgeMark` de `icons.tsx`), menu "Mostrar" / "Sair", e
 * clique no ícone que traz a janela pra frente.
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import type { Language } from '@bridge/shared';
import { renderMarkRgba } from './iconMark.js';
import { encodePng } from './png.js';
import { trayMenuItems, trayTooltip } from './trayMenu.js';
import type { TrayItemId } from './trayMenu.js';

/**
 * Ícone 16×16 sem fundo (transparente): dá pra ver tanto na barra de tarefas
 * clara quanto na escura do Windows, sem precisar de dois arquivos.
 */
export function buildTrayIconPng(): Buffer {
  const size = 16;
  return encodePng(size, size, renderMarkRgba(size, { background: null }));
}

export interface TrayHandles {
  tray: Tray;
  /** Atualiza o tooltip pela contagem de não lidas (spec §4). */
  setUnread(n: number): void;
  /**
   * Idioma novo (`config.changed`): remonta o menu e reescreve o tooltip.
   *
   * O menu do Electron é IMUTÁVEL depois de montado — `Menu.buildFromTemplate`
   * devolve um objeto pronto, e não há como trocar o `label` de um item. Então
   * a troca de idioma constrói outro e chama `setContextMenu` de novo, que é
   * exatamente o que o `createTray` já faz na primeira vez.
   */
  setLanguage(lang: Language): void;
  destroy(): void;
}

function showAndFocus(win: BrowserWindow | null): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function createTray(getWindow: () => BrowserWindow | null, lang: Language): TrayHandles {
  const icon = nativeImage.createFromBuffer(buildTrayIconPng());
  const tray = new Tray(icon);
  // A contagem é guardada porque o tooltip depende das DUAS coisas (idioma e
  // não lidas), e as duas mudam sozinhas: sem isto, uma troca de idioma
  // apagaria o "· 3 não lidas" que estava na tela.
  let unread = 0;
  let current = lang;

  // `TrayItemId`, e não `string`: um item novo no `trayMenuItems` sem ação
  // aqui vira erro de compilação, e não um item de menu que não faz nada.
  const run: Record<TrayItemId, () => void> = {
    show: () => showAndFocus(getWindow()),
    quit: () => app.quit(),
  };

  function applyMenu(): void {
    tray.setContextMenu(
      Menu.buildFromTemplate(trayMenuItems(current).map((item) => ({ label: item.label, click: run[item.id] }))),
    );
  }

  applyMenu();
  tray.setToolTip(trayTooltip(unread, current));
  tray.on('click', () => showAndFocus(getWindow()));

  return {
    tray,
    setUnread(n: number): void {
      unread = n;
      tray.setToolTip(trayTooltip(unread, current));
    },
    setLanguage(next: Language): void {
      current = next;
      applyMenu();
      tray.setToolTip(trayTooltip(unread, current));
    },
    destroy(): void {
      tray.destroy();
    },
  };
}
