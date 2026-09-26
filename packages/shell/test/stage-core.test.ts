/**
 * `scripts/stage-core.mjs --help`.
 *
 * O script começa a execução apagando e remontando `.stage/core`, e a única
 * documentação dele era o comentário no topo do arquivo (anotado no BACKLOG:
 * "`stage-core.mjs` sem `--help`"). Quem digitasse `--help` por reflexo, ou
 * errasse `--refresh-lock`, perdia o stage — e continuava sem saber as flags.
 *
 * O que se afirma aqui é justamente isso: a ajuda sai por STDOUT com código 0
 * e SEM efeito colateral nenhum no `.stage`.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'stage-core.mjs');
const stageDir = resolve(here, '..', '..', '..', '.stage', 'core');

/** `{ existe, mtime }` do `.stage/core` — a testemunha de "nada foi mexido". */
function stageState(): { existe: boolean; mtimeMs?: number } {
  if (!existsSync(stageDir)) return { existe: false };
  return { existe: true, mtimeMs: statSync(stageDir).mtimeMs };
}

describe('stage-core.mjs --help', () => {
  it('imprime as flags no stdout, sai 0 e não toca no .stage', async () => {
    const antes = stageState();

    for (const flag of ['--help', '-h']) {
      const { stdout, stderr } = await execFileAsync(process.execPath, [script, flag], { encoding: 'utf8' });
      expect(stderr).toBe('');
      expect(stdout).toContain('Uso: node scripts/stage-core.mjs');
      expect(stdout).toContain('--refresh-lock');
      // Um `execFileAsync` que não lança já provou o código 0.
    }

    expect(stageState()).toEqual(antes);
  }, 30000);
});
