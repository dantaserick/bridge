/**
 * O wrapper `claude` que cada sessão de SHELL leva na frente do PATH
 * (0.12.0, spec §5 — "Claude Code aberto DENTRO de um shell").
 *
 * A dor: uma sessão de shell não recebe hook nenhum. O `claude` que a pessoa
 * digita nela sobe sem o `--settings` do Bridge, então nenhum `SessionStart`
 * chega ao core e a sidebar segue dizendo "shell" enquanto um agente inteiro
 * trabalha ali dentro.
 *
 * A saída é um wrapper por sessão: o `shellLaunch` grava em
 * `<sessionDir>/bin/` um `claude.cmd` (Windows) e um `claude` de shell POSIX
 * (Git Bash / WSL) que chamam o claude REAL com o `--settings` da sessão — o
 * MESMO `buildClaudeSettings(ctx)` das sessões de agente — e repassam os
 * argumentos intactos.
 *
 * Três decisões que sustentam o resto:
 *
 * 1. O wrapper cita o caminho ABSOLUTO do claude real, nunca `claude` pelo
 *    PATH: com o próprio bin na frente, `claude` acharia a si mesmo e o shell
 *    entraria em recursão. O alvo é resolvido pelo `resolveClaudeBin()`, que
 *    roda no processo do CORE (PATH sem o bin da sessão) — por construção ele
 *    nunca aponta pro wrapper.
 * 2. No WSL o caminho do Windows não serve, e o `claude` da distro é outro
 *    binário; lá o wrapper chama `claude` pelo PATH DEPOIS de tirar TODAS as
 *    ocorrências do próprio bin da lista, entrada por entrada e por comparação
 *    literal — é assim que a recursão é evitada do outro lado da fronteira.
 * 3. Claude não instalado (o `resolveClaudeBin()` caindo no literal
 *    `claude.cmd`) = sem alvo = sessão de shell normal, sem arquivo nenhum e
 *    sem PATH mexido. Um wrapper apontando pra um caminho que não existe
 *    quebraria o `claude` que a pessoa instalasse DEPOIS, dentro da sessão.
 * 4. Nenhum wrapper injeta quando ele já está rodando DENTRO de um Claude Code
 *    (ver `CLAUDECODE_ENV`). O bin da sessão fica na frente do PATH do PTY e,
 *    por herança, de TODO descendente — inclusive da Bash tool da própria
 *    hospedeira. Sem esta guarda, um `claude -p …` disparado lá de dentro
 *    resolveria o wrapper, subiria com o MESMO `settings.json` (mesmo
 *    `BRIDGE_SESSION`) e reportaria na sessão do hospedeiro: um `Stop` espúrio
 *    marcaria "done" com o Claude de verdade ainda trabalhando, e o
 *    `SessionEnd` do filho desospedaria o painel inteiro.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { shQuote } from '../environments.js';
import { buildClaudeSettings, resolveClaudeBin } from './claude.js';
import type { LaunchCtx } from './types.js';

/**
 * O claude REAL desta máquina. O npm instala os dois lado a lado: o `.cmd`
 * (que o cmd.exe/PowerShell executam) e um shim POSIX sem extensão (que o Git
 * Bash executa). O `sh` é opcional porque nem toda instalação tem o par.
 */
export interface HostedTarget {
  cmd: string;
  sh?: string;
}

/**
 * A variável que leva o caminho do claude REAL até o `claude.cmd` da sessão.
 *
 * Existe por causa da codepage: o cmd.exe lê arquivo de lote em OEM, e um
 * caminho com acento gravado em UTF-8 chega mangled ao claude (medido). O
 * ambiente do processo é UTF-16 — atravessa acento, cedilha e espaço sem
 * ninguém precisar acertar codepage.
 */
export const HOSTED_BIN_ENV = 'BRIDGE_CLAUDE_BIN';

/**
 * O marcador de ANINHAMENTO: o Claude Code define esta variável em tudo que ele
 * mesmo spawna (é por isso que o `shell.ts` a TIRA do env do PTY — `STRIPPED_ENV`
 * —, pra que um Claude lançado pelo Bridge não se ache filho do Claude que roda
 * o Bridge). O efeito colateral útil é este: dentro de um PTY do Bridge ela só
 * existe quando quem está executando o wrapper é um Claude Code — e aí o
 * wrapper repassa os argumentos ao alvo SEM `--settings`, porque a hospedagem
 * já é do processo de cima.
 *
 * Limite declarado: o discriminador depende de o Claude Code continuar
 * definindo a variável (BACKLOG).
 */
export const CLAUDECODE_ENV = 'CLAUDECODE';

/** `<sessionDir>/bin` — a pasta que entra na frente do PATH da sessão. */
export function hostedBinDir(sessionDir: string): string {
  return join(sessionDir, 'bin');
}

/**
 * O alvo a partir de um caminho JÁ resolvido. Separado do
 * `resolveHostedTarget()` porque o `where.exe` não é testável: aqui a regra
 * ("é absoluto? existe? tem shim POSIX ao lado?") fica exposta.
 */
export function hostedTargetFrom(bin: string): HostedTarget | undefined {
  // O `resolveClaudeBin()` devolve o literal `claude.cmd` quando o `where.exe`
  // não acha nada — relativo, e portanto inútil dentro de um wrapper.
  if (!isAbsolute(bin) || !existsSync(bin)) return undefined;
  const sh = bin.replace(/\.cmd$/i, '');
  return sh !== bin && existsSync(sh) ? { cmd: bin, sh } : { cmd: bin };
}

/**
 * O claude real, ou `undefined` quando não há nenhum. Roda ANTES do prepend do
 * PATH (é o PATH do processo do core), então nunca acha o próprio wrapper.
 */
export function resolveHostedTarget(): HostedTarget | undefined {
  return hostedTargetFrom(resolveClaudeBin());
}

/** `C:\Meus Projetos\x` → `C:/Meus Projetos/x` — o que um shell POSIX entende. */
function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * A linha do login shell da distro quando a sessão é hospedada: o bin da
 * sessão na frente do `PATH` e o `$SHELL` do usuário, como no
 * `WSL_SHELL_COMMAND` de sempre.
 *
 * Limite declarado (spec §5): um `/etc/profile` que ZERA o `PATH` em vez de
 * acrescentar desliga o recurso — o wrapper continua no disco, mas o login
 * shell já não o enxerga.
 */
export const WSL_HOSTED_SHELL_COMMAND = (binUnix: string): string =>
  `PATH=${shQuote(binUnix)}:$PATH exec "\${SHELL:-/bin/sh}" -l`;

/**
 * Os arquivos que a sessão hospedada grava. O `settings.json` fica na RAIZ da
 * sessão (mesmo caminho das sessões de agente, `claude.ts`); os wrappers, no
 * `bin/`.
 *
 * Fora do WSL saem os DOIS wrappers, não um por `kind`: o `claude.cmd` é o que
 * o pwsh/PowerShell resolvem (via `PATHEXT`) e o `claude` sem extensão é o que
 * o Git Bash resolve — e é comum abrir um dentro do outro. Ter os dois na
 * pasta não confunde nenhum dos dois shells (verificado na máquina do dono:
 * `Get-Command` devolve o `.cmd`, `command -v` devolve o sem extensão).
 */
export function hostedFiles(ctx: LaunchCtx, target: HostedTarget): Array<{ path: string; content: string }> {
  const settingsPath = join(ctx.sessionDir, 'settings.json');
  const bin = hostedBinDir(ctx.sessionDir);
  const files = [{ path: settingsPath, content: JSON.stringify(buildClaudeSettings(ctx), null, 2) }];

  if (ctx.environment?.kind === 'wsl') {
    const sessionDirUnix = ctx.environment.sessionDirUnix;
    if (!sessionDirUnix) throw new Error('ambiente WSL sem caminho traduzido da pasta da sessão'); // i18n-ignore: invariante do core (500 + log)
    files.push({
      path: join(bin, 'claude'),
      // O wrapper tira o PRÓPRIO bin do PATH antes do `exec` — sem isso o
      // `claude` acharia a si mesmo e o shell entraria em recursão infinita.
      //
      // A remoção é entrada por entrada, com comparação LITERAL, e não com o
      // `${PATH#<bin>:}` da primeira versão: aquele só cortava o bin quando ele
      // era o PRIMEIRO da lista, e ele quase nunca é. A linha do `sh -lc` roda
      // ANTES do `/etc/profile` e do `~/.profile`, e o `~/.profile` padrão do
      // Ubuntu faz `PATH="$HOME/.local/bin:$PATH"` — ou seja, no momento em que
      // o wrapper roda o bin já está no meio. Com o bin no meio o corte era um
      // no-op, com o bin duplicado sobrava a segunda ocorrência, e um `[` no
      // caminho fazia o casamento de padrão falhar sozinho.
      //
      // `set -f` desliga o glob antes do laço (o `$PATH` sem aspas sofre
      // pathname expansion, e `[`/`*` num caminho viraria outra coisa) e
      // `IFS=:` faz o corte por campo. Tudo em `sh` puro: a distro pode não ter
      // bash.
      content:
        '#!/bin/sh\n' +
        `BIN=${shQuote(sessionDirUnix + '/bin')}\n` +
        "NEW=''\n" +
        'set -f\n' +
        'IFS=:\n' +
        'for p in $PATH; do\n' +
        '  [ "$p" = "$BIN" ] || NEW="${NEW:+$NEW:}$p"\n' +
        'done\n' +
        'unset IFS\n' +
        'set +f\n' +
        'PATH=$NEW\n' +
        'export PATH\n' +
        // Aninhamento (ver `CLAUDECODE_ENV`): o corte do PATH acima continua
        // valendo (sem ele o `claude` daqui seria o próprio wrapper), só o
        // `--settings` fica de fora — quem hospeda é o Claude de cima.
        `if [ -n "$${CLAUDECODE_ENV}" ]; then exec claude "$@"; fi\n` +
        `exec claude --settings ${shQuote(sessionDirUnix + '/settings.json')} "$@"\n`,
    });
    return files;
  }

  // CRLF e `%*`: é um arquivo de lote, lido pelo cmd.exe. Sem `call`, de
  // propósito — o código de saída do claude é o código de saída do wrapper.
  //
  // Nenhum caminho aparece LITERAL aqui, e o motivo foi medido (prova real da
  // task): o cmd.exe lê o .bat/.cmd na CODEPAGE OEM do console (437/850), não
  // em UTF-8. Um `C:\Users\João\...` gravado em UTF-8 chegava ao claude como
  // `C:\Users\Jo├úo\...` — "Settings file not found", com o caminho mangled na
  // mensagem. Então o alvo vem pelo AMBIENTE (`BRIDGE_CLAUDE_BIN`, que é
  // UTF-16 do começo ao fim) e o settings vem de `%~dp0`, o caminho do próprio
  // wrapper, que o cmd expande a partir do disco. O arquivo fica 100% ASCII e
  // o acento deixa de ter por onde se perder.
  //
  // As duas linhas do `if defined` são a guarda de aninhamento (ver
  // `CLAUDECODE_ENV`). São DUAS, e não um bloco `( … & exit /b %ERRORLEVEL% )`,
  // por causa da expansão do cmd.exe: dentro de parênteses o `%ERRORLEVEL%` é
  // substituído quando o BLOCO é lido, ou seja ANTES de o claude rodar — o
  // wrapper devolveria o código de saída anterior. `exit /b` sem argumento
  // preserva o ERRORLEVEL do último comando, que é exatamente o que se quer.
  files.push({
    path: join(bin, 'claude.cmd'),
    content:
      '@echo off\r\n' +
      `if defined ${CLAUDECODE_ENV} "%${HOSTED_BIN_ENV}%" %*\r\n` +
      `if defined ${CLAUDECODE_ENV} exit /b\r\n` +
      `"%${HOSTED_BIN_ENV}%" --settings "%~dp0..\\settings.json" %*\r\n`,
  });
  // LF, sem BOM, caminhos em barra normal e `"$@"`: o Git Bash abre o arquivo
  // pelo shebang, e um `\r` no fim da linha vira parte do argumento.
  //
  // Os dois caminhos passam pelo `shQuote` (aspas SIMPLES), como os do wrapper
  // do WSL: entre aspas duplas, um `$` ou uma crase no caminho do perfil ou da
  // instalação do npm expandiriam, e uma aspa dupla fecharia a citação.
  const alvo = shQuote(toSlash(target.sh ?? target.cmd));
  files.push({
    path: join(bin, 'claude'),
    content:
      '#!/bin/sh\n' +
      // Aninhamento (ver `CLAUDECODE_ENV`): repassa os argumentos ao alvo sem
      // o `--settings`, porque a hospedagem é do Claude que está por cima.
      `if [ -n "$${CLAUDECODE_ENV}" ]; then exec ${alvo} "$@"; fi\n` +
      `exec ${alvo} --settings ${shQuote(toSlash(settingsPath))} "$@"\n`,
  });
  return files;
}

/**
 * Põe `dir` na frente do PATH REUSANDO a chave que já existe.
 *
 * No Windows as variáveis de ambiente são case-insensitive e o `process.env`
 * costuma trazer `Path`, não `PATH`: criar uma segunda chave deixaria as duas
 * no ambiente do filho, e qual delas o processo enxerga depende de quem o
 * criou — o wrapper simplesmente não seria achado, calado.
 */
export function prependPath(env: Record<string, string>, dir: string): void {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (key === undefined) {
    env.Path = dir;
    return;
  }
  env[key] = `${dir};${env[key]}`;
}
