import type { EnvironmentKind } from '@bridge/shared';
import { shQuote } from '../environments.js';
import { HOSTED_BIN_ENV, WSL_HOSTED_SHELL_COMMAND, hostedBinDir, hostedFiles, prependPath } from './hosted.js';
import type { LaunchCtx, LaunchSpec } from './types.js';

// When the Bridge core itself runs inside a Claude Code session (e.g. dev/debug),
// these nesting markers leak into every PTY it spawns, making a launched Claude
// Code child think it's a subagent of that outer session ("Transcript saving is
// off — inherited CLAUDE_CODE_CHILD_SESSION marker"). Strip them explicitly
// rather than prefix-matching CLAUDE_CODE_* so user-set vars like
// CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX / CLAUDE_CODE_MAX_OUTPUT_TOKENS /
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC still pass through untouched.
export const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

/**
 * As variáveis do Bridge que precisam ATRAVESSAR a fronteira Windows→WSL.
 *
 * `wsl.exe` não repassa o ambiente do processo pai: quem escolhe o que passa é
 * a `WSLENV`, uma lista separada por `:`. Sem ela o shim de hook subiria
 * dentro da distro sem `BRIDGE_PORT`/`BRIDGE_TOKEN` e sairia calado — hook
 * nenhum chegaria no core, e a sessão ficaria eternamente "idle" na sidebar.
 *
 * Nenhuma leva o sufixo `/p` (tradução de caminho pelo próprio WSL), e o
 * `BRIDGE_SHIM` atravessa em forma de **Windows**: quem o executa é o
 * `node.exe` do Windows por interop (ver `hookCommand`), e o interop não
 * traduz argv — um `/mnt/c/...` chegaria lá como arquivo inexistente.
 */
export const WSL_SHARED_ENV = [
  'BRIDGE_PORT',
  'BRIDGE_TOKEN',
  'BRIDGE_SESSION',
  'BRIDGE_SHIM',
  // Clique do mouse no Claude Code: o Claude dentro da distro é o mesmo
  // programa que a opção mira, então as duas atravessam a fronteira.
  'CLAUDE_CODE_NO_FLICKER',
  'CLAUDE_CODE_DISABLE_MOUSE',
];

export function baseEnv(ctx: LaunchCtx): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !STRIPPED_ENV.includes(key)) env[key] = value;
  }
  env.BRIDGE_PORT = String(ctx.port);
  env.BRIDGE_TOKEN = ctx.token;
  env.BRIDGE_SESSION = ctx.sessionId;
  env.BRIDGE_SHIM = ctx.shimPath;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  // Clique do mouse no Claude Code (12/09/2026). O clique só funciona na
  // interface fullscreen do Claude Code, e é `CLAUDE_CODE_NO_FLICKER=true` que
  // a liga sem depender de gate nem de versão; a variável do dono, se existir,
  // vence. Desligado, `CLAUDE_CODE_DISABLE_MOUSE=1` faz o Claude nem pedir o
  // mouse ao terminal (e o xterm ainda ignora o pedido, por garantia).
  if (ctx.mouseClicks === false) env.CLAUDE_CODE_DISABLE_MOUSE = '1';
  else if (ctx.mouseClicks === true) {
    // A opção LIGADA tem que vencer um `CLAUDE_CODE_DISABLE_MOUSE` herdado do
    // ambiente — senão o checkbox promete clique e ele não vem.
    delete env.CLAUDE_CODE_DISABLE_MOUSE;
    if (env.CLAUDE_CODE_NO_FLICKER === undefined) env.CLAUDE_CODE_NO_FLICKER = 'true';
  }

  // Dentro da distro o `BRIDGE_SHIM` continua sendo o caminho do WINDOWS (é o
  // `node.exe` do Windows que vai abri-lo); o que muda é só a `WSLENV`, que
  // decide o que atravessa a fronteira.
  if (ctx.environment?.kind === 'wsl') env.WSLENV = mergeWslEnv(env.WSLENV, WSL_SHARED_ENV);
  return env;
}

/** Junta a `WSLENV` que já existia (a do usuário) com a do Bridge, sem duplicar. */
export function mergeWslEnv(existing: string | undefined, names: string[]): string {
  const parts = (existing ?? '').split(':').filter((p) => p.trim().length > 0);
  const known = new Set(parts.map((p) => p.split('/')[0]));
  for (const name of names) {
    if (!known.has(name)) parts.push(name);
  }
  return parts.join(':');
}

/**
 * O comando do shell dentro da distro. `$SHELL` é o shell de LOGIN do usuário
 * da distro (o que ele configurou: bash, zsh, fish) — subir `bash` fixo daria
 * um terminal que não é o dele. O `exec` troca o `sh` pelo shell de verdade,
 * pra não sobrar um processo intermediário pendurado no PTY.
 */
export const WSL_SHELL_COMMAND = 'exec "${SHELL:-/bin/sh}" -l';

/**
 * `wsl.exe -d <distro> --cd <caminho POSIX> -- <comando>`.
 *
 * O `--cd` recebe o caminho JÁ traduzido por `wslpath -a`: passar o caminho do
 * Windows funcionaria por acaso em alguns casos e falharia calado em pasta com
 * acento ou em unidade de rede — e é exatamente o "caminho UNC" da dor #2.
 */
export function wslArgs(distro: string, cwdUnix: string, command: string[]): string[] {
  return ['-d', distro, '--cd', cwdUnix, '--', ...command];
}

/**
 * O shell da sessão — e, quando `ctx.hosted` está preenchido (spec §5), o
 * wrapper `claude` da sessão na frente do PATH.
 *
 * Sem `ctx.hosted` nada muda: `files: []` e o `env` como sempre foi. É o que o
 * `sessions.hostedAgents` desligado produz, e o que uma máquina sem claude
 * produz sozinha.
 */
export function shellLaunch(kind: EnvironmentKind, ctx: LaunchCtx): LaunchSpec {
  const env = baseEnv(ctx);
  const hosted = ctx.hosted;
  const files = hosted ? hostedFiles(ctx, hosted.target) : [];
  // No WSL o PATH que importa é o de DENTRO da distro (a linha do login
  // shell). Prepender o bin no `Path` do Windows aqui seria pior que inútil: o
  // interop reinjeta o PATH do Windows TRADUZIDO no fim do PATH da distro, e o
  // mesmo `bin` apareceria duas vezes — uma pela linha do login shell, outra
  // pelo interop. O wrapper remove TODAS as ocorrências do próprio bin antes do
  // `exec` (é o laço em `hosted.ts`), então a duplicata não causa recursão;
  // mas ela também não serve pra nada, e o `Path` do Windows de uma sessão de
  // WSL não é lugar de wrapper `.cmd` que a distro nunca vai executar.
  if (hosted && kind !== 'wsl') {
    prependPath(env, hostedBinDir(ctx.sessionDir));
    // O `claude.cmd` da sessão lê o alvo DAQUI (ver `HOSTED_BIN_ENV`): o
    // ambiente é UTF-16 e atravessa acento; o corpo do .cmd, lido em codepage
    // OEM pelo cmd.exe, não atravessaria.
    env[HOSTED_BIN_ENV] = hosted.target.cmd;
  }
  switch (kind) {
    case 'pwsh':
      return { bin: 'pwsh.exe', args: ['-NoLogo'], env, files };
    case 'powershell':
      return { bin: 'powershell.exe', args: ['-NoLogo'], env, files };
    case 'gitbash':
      return { bin: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], env, files };
    case 'wsl': {
      const wsl = ctx.environment;
      if (wsl?.kind !== 'wsl' || !wsl.distro || !wsl.cwdUnix) {
        // Invariante do core, igual ao `claude.ts`: 500 e log, nunca tela.
        throw new Error('ambiente WSL sem distro ou sem caminho traduzido'); // i18n-ignore
      }
      // Sem `wsl.sessionDirUnix` o `hostedFiles` acima já teria lançado (é ele
      // quem exige o caminho traduzido): testá-lo de novo aqui era guarda
      // MORTA, e o `!` explicita que a única saída sem caminho é a exceção.
      const command = hosted ? WSL_HOSTED_SHELL_COMMAND(`${wsl.sessionDirUnix!}/bin`) : WSL_SHELL_COMMAND;
      return {
        bin: 'wsl.exe',
        args: wslArgs(wsl.distro, wsl.cwdUnix, ['sh', '-lc', command]),
        env,
        files,
      };
    }
  }
}

/** Só pra deixar explícito de onde vem o `shQuote` do comando de hook do WSL. */
export { shQuote };
