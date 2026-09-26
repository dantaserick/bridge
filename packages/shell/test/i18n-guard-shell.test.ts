import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// O guard é ferramenta de TESTE e não é reexportado pela raiz de
// `@bridge/shared` (ele não deve entrar no grafo do bundle): cada teste de
// guarda o importa do arquivo direto.
import { findUncataloguedLiterals } from '../../shared/src/i18n/guard.js';

/**
 * A trava de idioma DESTE pacote (spec §13): nenhum texto em pt-BR fora do
 * catálogo em `packages/shell/src`.
 *
 * O modelo é o de `packages/core/test/i18n-guard-core.test.ts`. A diferença é
 * a allowlist: o processo main tem UMA família de texto que fica de fora do
 * catálogo por DECISÃO, e não por esquecimento — as linhas de
 * `shell.log`, que são do dono e do suporte (spec §13).
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * O que esta varredura perdoa, e por quê. Cada regex é testada contra o TEXTO
 * do achado e contra a LINHA inteira — é a segunda forma que perdoa uma
 * chamada inteira sem listar cada frase.
 *
 * O `log(` cru já é perdoado pelo próprio guard; aqui ficam as formas que ele
 * não reconhece.
 */
const ALLOW: RegExp[] = [
  // `appendShellLog(path, '…')` e `this.log(…)`/`opts.log?.(…)`: são as MESMAS
  // linhas de `shell.log`, escritas pelas funções que têm o arquivo em mãos.
  // O `LOG_RE` do guard exige a palavra `log` isolada antes do parêntese, e
  // `appendShellLog` não casa.
  /\bappendShellLog\s*\(/,
  /\blog\?\.\s*\(/,
  // `debug('…')` — o log de diagnóstico atrás de `BRIDGE_DEBUG=1` (`main.ts`).
  // Mesma decisão do `log(`: é diagnóstico em arquivo, não texto de tela.
  /\bdebug\s*\(/,
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

describe('guarda de idioma — @bridge/shell', () => {
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
