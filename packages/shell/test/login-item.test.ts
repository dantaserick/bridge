import { describe, expect, it } from 'vitest';
import { t } from '@bridge/shared';
import {
  HIDDEN_ARG,
  LOGIN_ITEM_DEV_STATUS,
  LOGIN_ITEM_PLATFORM_STATUS,
  loginItemArgs,
  loginItemSupport,
  parseLoginItemInput,
  readLoginItem,
  shouldStartHidden,
} from '../src/loginItem.js';

const EXE = 'C:\\perfil\\dev\\AppData\\Local\\Programs\\Bridge\\Bridge.exe';

describe('loginItemArgs', () => {
  it('só põe --hidden quando o usuário pediu pra começar na bandeja', () => {
    expect(loginItemArgs(true)).toEqual([HIDDEN_ARG]);
    expect(loginItemArgs(false)).toEqual([]);
  });

  it('devolve um array novo a cada chamada (nada compartilhado com o registro)', () => {
    const first = loginItemArgs(true);
    first.push('--outro');
    expect(loginItemArgs(true)).toEqual([HIDDEN_ARG]);
  });
});

describe('shouldStartHidden', () => {
  it('acha o --hidden no argv do app empacotado e do dev', () => {
    expect(shouldStartHidden([EXE, HIDDEN_ARG])).toBe(true);
    expect(shouldStartHidden(['electron.exe', '.', HIDDEN_ARG])).toBe(true);
  });

  it('é falso no boot normal', () => {
    expect(shouldStartHidden([EXE])).toBe(false);
    expect(shouldStartHidden([])).toBe(false);
  });

  it('não confunde com um argumento que só CONTÉM a palavra', () => {
    // Um `--hidden-coisa` (ou um caminho com "--hidden" no meio) não pode
    // esconder a janela: o `includes` de string faria isso.
    expect(shouldStartHidden([EXE, '--hidden-tab'])).toBe(false);
    expect(shouldStartHidden([EXE, 'C:\\pasta\\--hidden\\x.txt'])).toBe(false);
    expect(shouldStartHidden([EXE, '--Hidden'])).toBe(false);
  });
});

describe('readLoginItem', () => {
  /**
   * As duas consultas do Electron, do jeito que ele responde de verdade
   * (medido no Electron 44, 04/09/2026, com a entrada no registro):
   *
   * | registro                | consulta com --hidden      | consulta sem args          |
   * | ---                     | ---                        | ---                        |
   * | nada                    | open=false, exeWill=false  | open=false, exeWill=false  |
   * | `"exe" --hidden`        | open=TRUE,  exeWill=true   | open=false, exeWill=true   |
   * | `"exe"`                 | open=false, exeWill=true   | open=TRUE,  exeWill=true   |
   */
  const semEntrada = {
    hidden: { openAtLogin: false, executableWillLaunchAtLogin: false },
    plain: { openAtLogin: false, executableWillLaunchAtLogin: false },
  };
  const comHidden = {
    hidden: { openAtLogin: true, executableWillLaunchAtLogin: true },
    plain: { openAtLogin: false, executableWillLaunchAtLogin: true },
  };
  const semArgs = {
    hidden: { openAtLogin: false, executableWillLaunchAtLogin: true },
    plain: { openAtLogin: true, executableWillLaunchAtLogin: true },
  };

  it('sem entrada no Run: desligado', () => {
    expect(readLoginItem(semEntrada)).toEqual({ enabled: false, startMinimized: false });
  });

  it('entrada com --hidden: ligado E minimizado', () => {
    expect(readLoginItem(comHidden)).toEqual({ enabled: true, startMinimized: true });
  });

  it('entrada sem argumento: ligado, sem minimizar', () => {
    expect(readLoginItem(semArgs)).toEqual({ enabled: true, startMinimized: false });
  });

  it('o LIGADO não sai do openAtLogin sozinho — era o bug do --hidden invisível', () => {
    // Este é EXATAMENTE o caso que quebrava: entrada gravada com `--hidden`,
    // e um `getLoginItemSettings()` sem argumentos devolvendo `openAtLogin:
    // false`. Quem lesse só esse campo mostraria o checkbox desligado com o
    // Bridge subindo com o Windows.
    expect(readLoginItem(comHidden).enabled).toBe(true);
    expect(comHidden.plain.openAtLogin).toBe(false);
  });

  it('entrada editada na mão com outro argumento: ligada, sem minimizar', () => {
    // `"exe" --foo`: nenhuma das duas consultas casa os args, mas o exe é o
    // nosso — o Windows VAI abrir o Bridge no login, e o checkbox tem que
    // dizer isso.
    expect(
      readLoginItem({
        hidden: { openAtLogin: false, executableWillLaunchAtLogin: true },
        plain: { openAtLogin: false, executableWillLaunchAtLogin: true },
      }),
    ).toEqual({ enabled: true, startMinimized: false });
  });

  it('aguenta a plataforma que não devolve executableWillLaunchAtLogin', () => {
    expect(readLoginItem({ hidden: { openAtLogin: true }, plain: { openAtLogin: false } })).toEqual({
      enabled: true,
      startMinimized: true,
    });
    expect(readLoginItem({ hidden: { openAtLogin: false }, plain: { openAtLogin: false } })).toEqual({
      enabled: false,
      startMinimized: false,
    });
  });

  it('nunca diz "minimizado" com o auto-start desligado', () => {
    expect(readLoginItem({ hidden: { openAtLogin: false }, plain: { openAtLogin: false } }).startMinimized).toBe(false);
  });
});

describe('loginItemSupport', () => {
  it('só o app empacotado no Windows pode escrever no Run', () => {
    expect(loginItemSupport({ platform: 'win32', packaged: true })).toEqual({ supported: true, status: '' });
  });

  it('em dev vira no-op com o motivo — execPath é o electron.exe', () => {
    const result = loginItemSupport({ platform: 'win32', packaged: false });
    expect(result.supported).toBe(false);
    expect(result.status).toBe(LOGIN_ITEM_DEV_STATUS);
  });

  it('fora do Windows também é no-op, com outro motivo', () => {
    expect(loginItemSupport({ platform: 'linux', packaged: true })).toEqual({
      supported: false,
      status: LOGIN_ITEM_PLATFORM_STATUS,
    });
  });

  /**
   * O `status` é CHAVE de catálogo desde a Task 4, não frase: quem traduz é o
   * `loginItemView` da UI, com o idioma da janela. Isto aqui prova as duas
   * coisas que importam — que a chave EXISTE nos dois catálogos, e que ela
   * responde à pergunta que a seção "Sistema" faz.
   */
  it('os dois status são chaves de catálogo, e dizem a mesma coisa nos dois idiomas', () => {
    expect(t('pt-BR', LOGIN_ITEM_DEV_STATUS)).toContain('app instalado');
    expect(t('en', LOGIN_ITEM_DEV_STATUS)).toContain('installed app');
    expect(t('pt-BR', LOGIN_ITEM_PLATFORM_STATUS)).toContain('Windows');
    expect(t('en', LOGIN_ITEM_PLATFORM_STATUS)).toContain('Windows');
  });
});

describe('parseLoginItemInput', () => {
  it('aceita o par de booleanos que a UI manda', () => {
    expect(parseLoginItemInput({ enabled: true, startMinimized: false })).toEqual({
      enabled: true,
      startMinimized: false,
    });
  });

  it('recusa qualquer coisa que não seja o par de booleanos', () => {
    for (const raw of [null, undefined, 'ligado', 1, [], {}, { enabled: true }, { enabled: 'sim', startMinimized: true }]) {
      expect(parseLoginItemInput(raw)).toBeNull();
    }
  });
});
