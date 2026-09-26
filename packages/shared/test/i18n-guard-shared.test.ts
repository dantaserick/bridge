import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUncataloguedLiterals } from '../src/i18n/guard.js';

/**
 * A trava de idioma DESTE pacote (spec §13): nenhum texto em pt-BR fora do
 * catálogo em `packages/shared/src`.
 *
 * O `src/i18n/` inteiro fica de fora da varredura — é o catálogo (que é
 * pt-BR por definição) e o próprio guard (cuja lista de palavras é, ela
 * mesma, uma lista de palavras em português).
 *
 * As Tasks 2–4 têm um teste igual a este por pacote, cada um com a sua
 * allowlist. Quem acrescentar uma string nova em pt-BR sem chave descobre
 * aqui, com arquivo e linha.
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * O que esta varredura perdoa: **nada**.
 *
 * A allowlist da Task 1 tinha as duas mensagens de `Error` do `git.ts` (`nome
 * de tarefa inválido`, `ref inválida`) e era declaradamente temporária: quem
 * decidia como traduzir mensagem de erro era a Task 2. A decisão veio — erro
 * que chega à API carrega CHAVE e o texto nasce na borda, com o idioma do
 * instante —, e as duas passaram a sair do catálogo como todo o resto. A lista
 * ficou vazia, e vazia é o estado em que ela deve permanecer.
 */
const ALLOW: RegExp[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'i18n') continue;
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('guarda de idioma — @bridge/shared', () => {
  it('nenhum literal pt-BR fora do catálogo', () => {
    const achados: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      for (const hit of findUncataloguedLiterals(readFileSync(file, 'utf8'), { allow: ALLOW })) {
        achados.push(`${rel}:${hit.line}: ${hit.text}`);
      }
    }
    expect(achados).toEqual([]);
  });
});
