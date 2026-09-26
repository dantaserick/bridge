import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));

/**
 * `bridge` é um binário sem dependência nenhuma em runtime (Global
 * Constraints da Fase 4): tudo — `src/*.ts` e `@bridge/shared`, que também é
 * TypeScript sem build — vira UM arquivo CJS que o Node do sistema roda
 * direto, sem `node_modules` ao lado. `fetch` é global no Node 22+.
 *
 * Sem `banner` de propósito: `src/index.ts` já começa com `#!/usr/bin/env
 * node`, e o esbuild detecta e reposiciona esse shebang sozinho — um banner
 * com o mesmo texto duplicava a linha (`SyntaxError` no `require` direto).
 *
 * `define.__CLI_VERSION__`: fonte única da versão que `bridge status`
 * imprime — o `version` do `package.json` deste pacote, substituído em
 * tempo de build (fix round 1). Sem isso a versão vivia hardcoded em
 * `commands.ts` e as duas podiam divergir silenciosamente.
 */
await build({
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: resolve(here, 'bin', 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
