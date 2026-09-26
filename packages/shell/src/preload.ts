import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from './ipc.js';
import type {
  BridgeApi,
  FocusSessionPayload,
  LoginItemInput,
  LoginItemState,
} from './ipc.js';

/**
 * Única ponte entre o renderer (sandbox, sem Node) e o main. O token do core
 * chega por aqui — nunca pela URL da janela, que o Chromium guardaria no
 * histórico e vazaria em qualquer `Referer`.
 */
const api: BridgeApi = {
  token: () => ipcRenderer.invoke(IPC.token) as Promise<string>,
  port: () => ipcRenderer.invoke(IPC.port) as Promise<number>,
  focusWindow: () => ipcRenderer.invoke(IPC.focusWindow) as Promise<void>,
  // O `webPrompt` do renderer é ignorado aqui (ver `ipc.ts`): o diálogo é nativo.
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,
  openPath: (path: string) => ipcRenderer.invoke(IPC.openPath, path) as Promise<void>,
  setBadge: (unread: number) => ipcRenderer.invoke(IPC.setBadge, unread) as Promise<void>,
  loginItem: {
    get: () => ipcRenderer.invoke(IPC.getLoginItem) as Promise<LoginItemState>,
    set: (next: LoginItemInput) => ipcRenderer.invoke(IPC.setLoginItem, next) as Promise<LoginItemState>,
  },
  onFocusSession: (cb: (payload: FocusSessionPayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: FocusSessionPayload): void => cb(payload);
    ipcRenderer.on(IPC.focusSession, listener);
    return () => {
      ipcRenderer.removeListener(IPC.focusSession, listener);
    };
  },
};

contextBridge.exposeInMainWorld('bridge', api);
