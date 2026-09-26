/**
 * Pasta temporária de teste que se APAGA sozinha.
 *
 * Por que existe (Task 3, higiene): cada arquivo de teste do core cria perfil,
 * repo e worktree em `%TEMP%` e vários nunca apagavam nada — em algumas dezenas
 * de execuções isso virava mais de mil pastas `bridge-*` na máquina do dono. Em
 * vez de repetir `afterEach(() => rmSync(...))` em cada arquivo, quem importa
 * este módulo já ganha o `afterAll` de limpeza: o `afterAll` do topo é
 * registrado na coleção, e a coleção acontece dentro do arquivo de teste que
 * importou — ou seja, o hook é POR ARQUIVO, com a lista de pastas do arquivo.
 *
 * A remoção é silenciosa de propósito: no Windows um `core.log` ainda aberto ou
 * o antivírus seguram a pasta, e derrubar a suíte por lixo em `%TEMP%` seria
 * pior. O que escapar aqui é apanhado pelo `globalTeardown` (`test/setup.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const created: string[] = [];

/** `mkdtempSync` em `%TEMP%` que registra a pasta para remoção no fim do arquivo. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Apaga (e esquece) tudo que o `tmpDir` criou até aqui. Devolve quantas saíram. */
export function removeRegisteredTmpDirs(): number {
  let removed = 0;
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      // Pasta travada: o `globalTeardown` tenta de novo no fim da execução.
    }
  }
  return removed;
}

afterAll(removeRegisteredTmpDirs);
