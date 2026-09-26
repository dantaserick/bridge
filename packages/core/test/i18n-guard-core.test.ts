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
 * catálogo em `packages/core/src`.
 *
 * O modelo é o de `packages/shared/test/i18n-guard-shared.test.ts`, escrito na
 * Task 1. A diferença é a allowlist: o core tem duas famílias de texto que
 * ficam de fora do catálogo por DECISÃO, não por esquecimento — os logs em
 * arquivo (`core.log` é do dono e do suporte) e o SQL do banco.
 *
 * Quem acrescentar uma string nova em pt-BR sem chave descobre aqui, com
 * arquivo e linha.
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * O que esta varredura perdoa, e por quê. Cada regex é testada contra o TEXTO
 * do achado e contra a LINHA inteira — é a segunda forma que perdoa uma
 * chamada inteira sem listar cada frase.
 *
 * O que NÃO está aqui, e por que não precisa estar: as recusas individuais
 * (invariante interna do lançamento, log quebrado em duas linhas) levam um
 * `// i18n-ignore` na própria linha, com o motivo escrito ao lado. Perdão que
 * mora no código é lido por quem edita o código; perdão que mora aqui é regra
 * de família e vale pro arquivo inteiro.
 */
const ALLOW: RegExp[] = [
  // O DDL do SQLite (`db.ts`): é esquema, não copy. As palavras que o guard
  // reconhece vêm dos COMENTÁRIOS SQL (`-- A poda por sessao …`), que ficam
  // dentro do template e por isso não são vistos como comentário.
  /CREATE TABLE IF NOT EXISTS/,
  // `log?.warn(…)` — o `LOG_RE` do guard não conhece o `?.`. É logger opcional
  // (`keybindings.ts`), e log fica em pt-BR por decisão da spec §13.
  /\blog\?\.\s*\w+\s*\(/,
  // Loggers com nome próprio (`usageLog.warn`, `pollerLog.info`): o `LOG_RE`
  // exige a palavra `log` isolada, e `usageLog` não casa. Mesma decisão.
  /\b\w+Log\s*\.\s*\w+\s*\(/,
];

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

describe('guarda de idioma — @bridge/core', () => {
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
