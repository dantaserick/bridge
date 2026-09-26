#!/usr/bin/env node
/**
 * `bridge` — cliente de linha de comando do core (spec §8). Parser minúsculo
 * de propósito: positionals, `--flag valor`, `--flag=valor`, `--flag`
 * (booleano), `--` (terminador — tudo depois é positional, mesmo começando
 * com `--`) e o `--json` global, sem dependência nenhuma.
 */
import type { CommandResult, Ctx, Flags } from './commands.js';
import {
  cmdFocus,
  cmdList,
  cmdNew,
  cmdNotify,
  cmdResume,
  cmdSend,
  cmdStatus,
  cmdTaskMerge,
  cmdTaskNew,
  cmdTaskRm,
} from './commands.js';
import { Client, CliError, cliMessage, resolveInstance } from './client.js';
import { sanitizeDisplay, t, type Language } from '@bridge/shared';
import { offlineLanguage, resolveCliSettings, type CliConfig } from './lang.js';

/**
 * Teto da mensagem de erro impressa no terminal (BU-16). Uma frase de erro
 * legítima do Bridge cabe folgada; o que passa disso é eco de payload.
 */
const ERROR_MAX = 300;
import { CLI_VERSION } from './commands.js';
import { cmdUsage } from './usage.js';
import { cmdWatch } from './watch.js';

interface ParsedArgv {
  positionals: string[];
  flags: Flags;
  json: boolean;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Flags = {};
  let json = false;
  // Fix round 1: `--` desliga o parser de flags pro resto da linha — sem
  // isso, `bridge notify "--urgente: build quebrou"` comia o texto como uma
  // flag desconhecida em vez de tratá-lo como o argumento da mensagem.
  let terminated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!terminated && arg === '--') {
      terminated = true;
      continue;
    }
    if (!terminated && arg === '--json') {
      json = true;
      continue;
    }
    if (!terminated && arg.startsWith('--')) {
      const raw = arg.slice(2);
      // `--flag=valor` (fix round 1): sem isto virava uma flag booleana
      // chamada literalmente `flag=valor`.
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && next !== '--' && !next.startsWith('--')) {
        flags[raw] = next;
        i += 1;
      } else {
        flags[raw] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags, json };
}

/**
 * Ajuda (minor 12 da onda final). Sai no STDOUT com código 0, e — o ponto —
 * SEM falar com o core: `bridge --help` com o Bridge fechado imprimia "Bridge
 * não está aberto", que é exatamente a hora em que a pessoa está procurando a
 * lista de comandos. Mesma lista da spec §8 e do README.
 */
const help = (lang: Language): string => t(lang, 'cli.ajuda', { versao: CLI_VERSION });

async function dispatch(ctx: Ctx, positionals: string[], flags: Flags): Promise<CommandResult> {
  const [command, ...rest] = positionals;
  switch (command) {
    case 'notify':
      return cmdNotify(ctx, rest, flags);
    case 'list':
      return cmdList(ctx, flags);
    case 'focus':
      return cmdFocus(ctx, rest, flags);
    case 'new':
      return cmdNew(ctx, flags);
    case 'resume':
      return cmdResume(ctx, rest, flags);
    case 'send':
      return cmdSend(ctx, rest, flags);
    case 'status':
      return cmdStatus(ctx, flags);
    case 'usage':
      return cmdUsage(ctx, flags);
    case 'task': {
      const [sub, ...taskRest] = rest;
      if (sub === 'new') return cmdTaskNew(ctx, taskRest, flags);
      if (sub === 'merge') return cmdTaskMerge(ctx, taskRest, flags);
      if (sub === 'rm') return cmdTaskRm(ctx, taskRest, flags);
      throw new CliError({ key: 'cli.uso.task' });
    }
    default:
      throw new CliError({
        key: 'cli.erro.comandoDesconhecido',
        params: { comando: command ?? t(ctx.lang, 'cli.erro.comandoNenhum') },
      });
  }
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, flags, json } = parseArgv(argv);
  // Antes de QUALQUER descoberta de instância: ajuda e versão são as duas
  // coisas que têm que funcionar com o Bridge fechado. `bridge` pelado também
  // é pedido de ajuda — não erro — e sai por stdout com 0.
  if (flags.version !== undefined || flags.v !== undefined) {
    console.log(CLI_VERSION);
    return 0;
  }
  if (flags.help !== undefined || flags.h !== undefined || positionals[0] === 'help' || positionals.length === 0) {
    // A ajuda NÃO fala com o core: ela tem que sair com o Bridge fechado, que
    // é justamente quando alguém procura a lista de comandos. Idioma pelo
    // `BRIDGE_LANG`, senão pela locale da máquina (ver `lang.ts`).
    console.log(help(offlineLanguage(env)));
    return 0;
  }
  // O idioma é resolvido UMA vez, antes do comando: toda saída humana deste
  // processo sai nele, inclusive a linha de erro do `catch` lá embaixo. Fora
  // do `try` de propósito — nem a falha de descoberta da instância pode sair
  // sem idioma.
  let lang: Language = offlineLanguage(env);
  try {
    const instance = resolveInstance(env);
    // `watch` sai do molde dos outros: ele não faz UMA chamada e imprime um
    // `CommandResult` — fica ligado no `/ws` imprimindo linha por linha até o
    // socket fechar. Por isso é despachado aqui, antes do `dispatch`, e não
    // passa pelo `Client` (que é HTTP).
    const client = new Client(instance, env.BRIDGE_SESSION);
    // UMA chamada ao `/api/config` por processo: dela saem o idioma e o
    // `usage.showCost`. Antes do fix round 1 o `bridge usage` pedia a mesma
    // rota de novo, só pra ler o booleano.
    const settings = await resolveCliSettings(env, () => client.get<CliConfig>('/api/config'));
    lang = settings.lang;
    if (positionals[0] === 'watch') return cmdWatch(instance, flags, json, lang);
    // `BRIDGE_SESSION` vira o header `X-Bridge-Session` de toda chamada: é a
    // sessão de onde o comando saiu (ver `Client`).
    const result = await dispatch({ client, env, lang, showCost: settings.showCost }, positionals, flags);
    if (json) console.log(JSON.stringify(result.json));
    else console.log(result.human);
    return 0;
  } catch (err) {
    const cliErr = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), 1);
    const message = cliMessage(cliErr, lang);
    if (json) console.error(JSON.stringify({ error: message }));
    // BU-16: a mensagem pode ser o ECO de um valor do pedido (um `repoId`, um
    // `?tz=`) ou de um `keybindings.json` que veio num zip — e aqui ela vira
    // bytes no terminal do dono. O `--json` sai cru de propósito: é JSON.
    else console.error(sanitizeDisplay(message, ERROR_MAX));
    return cliErr.exitCode;
  }
}

// Único consumidor deste módulo é o bundle (`bin/bridge.cjs`) — roda direto,
// sem guarda de entrypoint (os testes chamam o binário buildado, não importam isto).
//
// `exitCode` em vez de `process.exit()`: o `fetch` do Node (undici) mantém o
// socket keep-alive vivo até a resposta terminar de ser processada, e um
// `process.exit()` imediato corre com o libuv fechando esse handle — no
// Windows isso derruba o processo com `Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)` em vez de sair limpo. Só marcar o
// código e deixar o event loop esvaziar sozinho evita a corrida; como cada
// request já teve o corpo consumido (`res.text()`), o loop esvazia rápido.
void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
