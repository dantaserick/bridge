/**
 * Regras puras da janela principal. NADA daqui importa `electron`: é este
 * arquivo que o vitest do pacote roda, enquanto o `main.ts` — que fala com o
 * Electron de verdade — aplica o que sai daqui.
 */

/** O que `isOpenablePath` precisa do disco — injetável pra teste não depender de junction real. */
export interface PathStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface OpenPathFs {
  /** `lstat`: NÃO segue link. É o ponto do BR-16. */
  lstat(path: string): PathStat;
}

/**
 * "Abrir no Explorer" só aceita PASTA REAL existente (BR-16).
 *
 * O `statSync` de antes segue junction e symlink: uma junction chamada `docs`
 * dentro de um repositório hostil, apontando pra `%USERPROFILE%`, fazia o
 * botão abrir a pasta do usuário. Abrir pasta no Explorer não executa nada — o
 * estrago é confusão, não RCE — mas o canal existe pra abrir a pasta do
 * workspace, e um reparse point não é ela.
 */
export function isOpenablePath(path: unknown, fs: OpenPathFs): path is string {
  if (typeof path !== 'string' || path === '') return false;
  try {
    const stat = fs.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Política de menu da janela (R3 da onda final).
 *
 * O menu padrão do Electron traz acelerador de verdade: `Ctrl+W` FECHA a
 * janela (e o app), `Ctrl+R` recarrega o renderer no meio de uma sessão,
 * `Ctrl+Shift+I` abre o devtools e `Ctrl+±` dá zoom na UI inteira. `Ctrl+W` e
 * `Ctrl+Shift+I` são atalhos do Bridge (fechar aba, painel de notificações) —
 * o menu ganhava dos dois. Sem menu nenhum, o renderer recebe as teclas.
 *
 * Devtools continua alcançável em dev, mas por um atalho REGISTRADO à mão
 * (`F12`), que não colide com atalho nenhum da spec §6.
 */
export interface MenuPolicy {
  /** O que vai pro `Menu.setApplicationMenu` — sempre `null`. */
  menu: null;
  /** Registrar o `F12` de devtools? Só com `BRIDGE_DEV=1`. */
  devtoolsShortcut: boolean;
}

export function menuPolicy(dev: boolean): MenuPolicy {
  return { menu: null, devtoolsShortcut: dev };
}
