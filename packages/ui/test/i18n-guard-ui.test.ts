import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// O guard é ferramenta de TESTE e não é reexportado pela raiz de
// `@bridge/shared` (ele não deve entrar no grafo do bundle da UI): cada teste
// de guarda o importa do arquivo direto.
import { findUncataloguedLiterals } from '../../shared/src/i18n/guard.js';

/**
 * A trava de idioma DESTE pacote (spec §13): nenhum texto em pt-BR fora do
 * catálogo em `packages/ui/src`.
 *
 * Uma ressalva que vale escrever, porque ela define o que este teste NÃO
 * prova: o guard só enxerga texto ACENTUADO fora de literal. `<span>Novo
 * workspace</span>` passa por ele. Nos `.tsx` a varredura de olho continua
 * obrigatória — foi ela, e não este teste, que achou boa parte do que as
 * Tasks 3 e 4 levaram para o catálogo (`Todos`, `Base`, `Msg`, `Tokens`,
 * `branch: —` e companhia não têm um acento sequer).
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * O que esta varredura perdoa: **nada**.
 *
 * A lista temporária da Task 3 — os 16 arquivos de painel, diálogo,
 * notificação, terminal e restauração, cada um com um comentário
 * `// TASK 4 (idioma)` no topo — foi esvaziada pela Task 4, e o bloco inteiro
 * (mais o teste que conferia se cada caminho dela ainda existia) saiu junto:
 * allowlist vazia é o estado em que ela deve ficar, como a do `@bridge/shared`.
 *
 * O perdão que sobreviveu mora no CÓDIGO, num `// i18n-ignore` com o motivo ao
 * lado (`main.tsx`, `bridge.ts`). É de propósito: perdão que mora aqui é regra
 * de família e vale pro arquivo inteiro; perdão que mora na linha é lido por
 * quem edita a linha.
 */
const ALLOW: RegExp[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return file.slice(SRC.length + 1).split('\\').join('/');
}

describe('guarda de idioma — @bridge/ui', () => {
  it('nenhum literal pt-BR fora do catálogo', () => {
    const achados: string[] = [];
    for (const file of walk(SRC)) {
      const path = rel(file);
      for (const hit of findUncataloguedLiterals(readFileSync(file, 'utf8'), { allow: ALLOW })) {
        achados.push(`${path}:${hit.line}: ${hit.text}`);
      }
    }
    expect(achados).toEqual([]);
  });

  /**
   * A allowlist está vazia, e este teste é o que a mantém assim: acrescentar
   * uma entrada "só por enquanto" passa a exigir mexer aqui e explicar por quê.
   */
  it('a allowlist continua vazia', () => {
    expect(ALLOW).toEqual([]);
  });
});
