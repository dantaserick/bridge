/**
 * Início automático com o Windows (Fase 5, Task 2).
 *
 * O estado NÃO mora no `config.json`: quem manda é o Windows. Ligar a opção
 * escreve uma entrada em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
 * (é isso que `app.setLoginItemSettings` faz nesta plataforma), e é de lá que
 * o valor é lido de volta (`app.getLoginItemSettings`). Guardar uma cópia no
 * arquivo daria duas verdades: o usuário pode tirar a entrada pelo Gerenciador
 * de Tarefas do Windows a qualquer momento, e o Bridge não fica sabendo.
 *
 * Este módulo é só a parte PURA — sem `electron`, sem registro, sem
 * `process` — pra caber no vitest do pacote (ambiente node, igual ao
 * `windowPolicy.ts`). O `main.ts` é quem chama o Electron de verdade.
 */

import type { MessageKey } from '@bridge/shared';

/** O argumento que a entrada do Run carrega quando o app deve subir na bandeja. */
export const HIDDEN_ARG = '--hidden';

/**
 * Argumentos da entrada de início automático. Com "começar minimizado", a
 * linha do registro fica `"...\Bridge.exe" --hidden`, e é esse argumento que
 * `shouldStartHidden` lê no boot pra criar a janela com `show: false`.
 */
export function loginItemArgs(startMinimized: boolean): string[] {
  return startMinimized ? [HIDDEN_ARG] : [];
}

/**
 * O app subiu pra ficar na bandeja? Lê o `process.argv` inteiro (inclusive o
 * `argv[0]`, que é o executável — um caminho nunca é `--hidden`), então serve
 * tanto pro app empacotado (`Bridge.exe --hidden`) quanto pro dev
 * (`electron . --hidden`).
 */
export function shouldStartHidden(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === HIDDEN_ARG);
}

/** O que a UI mostra na seção "Sistema". */
export interface LoginItemState {
  /** O Windows tem a entrada de início automático do Bridge agora. */
  enabled: boolean;
  /** Essa entrada carrega `--hidden` (sobe direto na bandeja). */
  startMinimized: boolean;
  /** Dá pra MEXER nisso aqui? Falso em dev e fora do Windows. */
  supported: boolean;
  /**
   * A CHAVE de catálogo que explica por que não dá; vazia quando dá.
   *
   * É chave, e não frase, de propósito (Task 4): este campo atravessa o IPC até
   * o renderer, que tem o idioma da JANELA. Mandando a frase pronta, uma troca
   * de idioma podia pegar a seção "Sistema" numa língua e o resto do diálogo em
   * outra — e o main não tem por que resolver duas vezes o que a UI já resolve.
   * Quem traduz é o `loginItemView` da UI.
   */
  status: MessageKey | '';
}

/** O que a UI manda quando o usuário mexe num dos dois checkboxes. */
export interface LoginItemInput {
  enabled: boolean;
  startMinimized: boolean;
}

/**
 * O recorte de `app.getLoginItemSettings(...)` que este módulo lê.
 *
 * **Só estes dois campos servem**, e a razão está documentada no
 * `readLoginItem` abaixo — foi medida contra o Electron 44 de verdade
 * (04/09/2026), não deduzida da documentação.
 */
export interface LoginItemSettingsLike {
  /** A entrada do `Run` bate EXATAMENTE com o exe + os `args` consultados. */
  openAtLogin: boolean;
  /** Existe alguma entrada apontando pro nosso exe, com os args que forem. */
  executableWillLaunchAtLogin?: boolean;
}

/** As duas consultas que `readLoginItem` precisa (ver o porquê lá). */
export interface LoginItemQuery {
  /** `getLoginItemSettings({ path: execPath, args: loginItemArgs(true) })`. */
  hidden: LoginItemSettingsLike;
  /** `getLoginItemSettings({ path: execPath, args: loginItemArgs(false) })`. */
  plain: LoginItemSettingsLike;
}

/**
 * As DUAS consultas do Electron → o que a UI mostra.
 *
 * Por que duas, e por que nada de `launchItems` — medido no Electron 44 com a
 * entrada de verdade no registro:
 *
 * 1. `launchItems[].args` vem **sempre vazio** pro nosso caso. O Electron
 *    devolve ali o `GetArgs()` da `base::CommandLine` do Chromium, que lista só
 *    os argumentos POSICIONAIS — `--hidden` é classificado como *switch* e some
 *    da lista. Ler o "minimizado" dali dava `false` com a entrada gravada
 *    certinha (`"...\Bridge.exe" --hidden` no registro).
 * 2. `openAtLogin` não é "o app inicia com o Windows": é "existe uma entrada
 *    que bate com o exe **e com os `args` desta consulta**". Com `--hidden`
 *    gravado, um `getLoginItemSettings()` sem argumentos devolve `false` — o
 *    checkbox apareceria desligado com o auto-start ligado.
 * 3. `executableWillLaunchAtLogin` é o campo que responde "tem entrada pro
 *    nosso exe?", independente dos argumentos. É esse o `enabled`.
 *
 * Daí: `enabled` sai do `executableWillLaunchAtLogin`, e `startMinimized` sai
 * do `openAtLogin` da consulta feita COM `--hidden` — a única que devolve
 * `true` justamente quando a entrada tem o argumento.
 *
 * Entrada editada na mão com outro argumento (`--foo`) cai no caso honesto:
 * ligado, sem "minimizado".
 */
export function readLoginItem(query: LoginItemQuery): Pick<LoginItemState, 'enabled' | 'startMinimized'> {
  const enabled =
    query.hidden.executableWillLaunchAtLogin === true ||
    query.plain.executableWillLaunchAtLogin === true ||
    query.hidden.openAtLogin === true ||
    query.plain.openAtLogin === true;
  return { enabled, startMinimized: enabled && query.hidden.openAtLogin === true };
}

/** O que a seção "Sistema" mostra quando o app está rodando em dev. */
export const LOGIN_ITEM_DEV_STATUS: MessageKey = 'shell.loginItem.dev';

/** Pra quando não é Windows (o Bridge é um app de Windows, mas o código não presume). */
export const LOGIN_ITEM_PLATFORM_STATUS: MessageKey = 'shell.loginItem.plataforma';

/**
 * Dá pra escrever no registro? Só no app EMPACOTADO e no Windows.
 *
 * Em dev `process.execPath` é o `electron.exe` do `node_modules`: gravar isso
 * no `Run` deixaria o Windows abrindo um Electron sem app (ou, pior, uma
 * entrada apontando pra uma pasta que some no próximo `npm ci`) — e sem jeito
 * óbvio de o dono descobrir de onde veio. Por isso o `set` vira no-op com
 * status em vez de mentir que salvou.
 */
export function loginItemSupport(env: {
  platform: string;
  packaged: boolean;
}): { supported: boolean; status: MessageKey | '' } {
  if (env.platform !== 'win32') return { supported: false, status: LOGIN_ITEM_PLATFORM_STATUS };
  if (!env.packaged) return { supported: false, status: LOGIN_ITEM_DEV_STATUS };
  return { supported: true, status: '' };
}

/**
 * Valida o que veio do renderer pelo IPC. O canal é origem-validada
 * (`assertFromUi`), mas o payload continua sendo dado de fora: um objeto
 * torto não pode virar `setLoginItemSettings` com `undefined` dentro.
 */
export function parseLoginItemInput(raw: unknown): LoginItemInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return null;
  if (typeof value.startMinimized !== 'boolean') return null;
  return { enabled: value.enabled, startMinimized: value.startMinimized };
}
