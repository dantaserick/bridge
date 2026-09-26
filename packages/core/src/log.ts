import { appendFile, rename, rm, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  /** Um logger irmão que marca `s` com outro escopo — mesma fila, mesmo arquivo. */
  child(scope: string): Logger;
  /** Resolve depois que TUDO que já foi logado chegou no disco. */
  flush(): Promise<void>;
  /**
   * Drena a fila e FECHA o logger: o que for logado depois é descartado.
   *
   * Existe porque `flush()` sozinho não basta pra quem vai apagar a pasta em
   * seguida (os testes do core, que criam o perfil em `%TEMP%`): qualquer
   * linha logada durante o próprio encerramento reabre o `core.log` e o
   * Windows recusa o `rmSync` do arquivo aberto — a pasta ficava pra trás em
   * `%TEMP%\bridge-*` a cada execução da suíte.
   */
  close(): Promise<void>;
}

export interface LogOptions {
  path: string;
  /** Teto por arquivo antes de rotacionar. Padrão 5 MB. */
  maxBytes?: number;
  /** Quantos arquivos no total (`core.log` + `.1` … `.{maxFiles-1}`). Padrão 5. */
  maxFiles?: number;
  /** Espelha cada linha no console (dev). Padrão: só arquivo. */
  alsoConsole?: boolean;
  /** Nível mínimo. Padrão `debug` (a rotação é quem limita o tamanho). */
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const ROOT_SCOPE = 'core';

/** Erro não sobrevive a `JSON.stringify` (vira `{}`); ciclo derruba. Os dois viram texto. */
function serialize(entry: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(entry, (_key, value: unknown) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

/**
 * Logger de arquivo com rotação, sem dependência nenhuma (spec §9).
 *
 * Uma linha JSON por evento: `{"t":ISO,"l":level,"s":scope,"m":msg,...data}`.
 * A escrita é assíncrona e enfileirada — `debug/info/warn/error` voltam na
 * hora, um `appendFile` encadeado drena a fila. Nada de timer: a fila só
 * existe enquanto tem linha pra gravar, então ela nunca segura o processo de
 * pé. Falha de disco vai pro `console.error` e não derruba quem logou.
 */
export function createLogger(opts: LogOptions): Logger {
  const path = opts.path;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const minLevel = LEVEL_ORDER[opts.level ?? 'debug'];
  const alsoConsole = opts.alsoConsole ?? false;

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Sem pasta, cada append falha e cai no aviso de disco lá embaixo.
  }

  const queue: string[] = [];
  let draining: Promise<void> | null = null;
  /** Depois do `close()` nada mais entra na fila (R11). */
  let closed = false;
  /** Tamanho corrente de `path`; `-1` = ainda não medido nesta execução. */
  let size = -1;

  async function rotate(): Promise<void> {
    if (maxFiles <= 1) {
      await rm(path, { force: true });
      return;
    }
    // O mais antigo sai de cena; `.{maxFiles-1}` é o maior índice que existe.
    await rm(`${path}.${maxFiles - 1}`, { force: true });
    for (let n = maxFiles - 1; n >= 1; n--) {
      const src = n === 1 ? path : `${path}.${n - 1}`;
      try {
        await rename(src, `${path}.${n}`);
      } catch {
        // Arquivo desse degrau ainda não existe — nada a mover.
      }
    }
  }

  async function writeLine(line: string): Promise<void> {
    if (size < 0) {
      try {
        size = (await stat(path)).size;
      } catch {
        size = 0;
      }
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    // Rotaciona ANTES de gravar a linha que estouraria o teto: assim nenhum
    // arquivo passa de maxBytes (a não ser uma linha sozinha maior que ele).
    if (size > 0 && size + bytes > maxBytes) {
      await rotate();
      size = 0;
    }
    await appendFile(path, line, 'utf8');
    size += bytes;
  }

  function schedule(): void {
    if (draining) return;
    draining = (async () => {
      try {
        while (queue.length > 0) {
          const line = queue.shift() as string;
          try {
            await writeLine(line);
          } catch (err) {
            // Disco cheio, pasta apagada, arquivo travado: avisa e segue.
            console.error(`[log] falhou ao escrever em ${path}`, err);
          }
        }
      } finally {
        draining = null;
      }
    })();
  }

  function emit(scope: string, level: LogLevel, msg: string, data?: object): void {
    if (closed || LEVEL_ORDER[level] < minLevel) return;
    const line = `${serialize({ t: new Date().toISOString(), l: level, s: scope, m: msg, ...data })}\n`;
    if (alsoConsole) {
      const text = line.trimEnd();
      if (level === 'error' || level === 'warn') console.error(text);
      else console.log(text);
    }
    queue.push(line);
    schedule();
  }

  function make(scope: string): Logger {
    return {
      debug: (msg, data) => emit(scope, 'debug', msg, data),
      info: (msg, data) => emit(scope, 'info', msg, data),
      warn: (msg, data) => emit(scope, 'warn', msg, data),
      error: (msg, data) => emit(scope, 'error', msg, data),
      child: (childScope) => make(childScope),
      flush: async () => {
        // Uma volta pode não bastar: quem logou durante o await entra numa
        // drenagem nova, e o flush só termina quando a fila esvazia de fato.
        while (draining) await draining;
      },
      close: async () => {
        // Fecha ANTES de drenar: uma linha logada durante o próprio
        // encerramento reabriria o arquivo depois do último `appendFile` e o
        // handle continuaria de pé quando quem chamou for apagar a pasta.
        closed = true;
        while (draining) await draining;
      },
    };
  }

  return make(ROOT_SCOPE);
}
