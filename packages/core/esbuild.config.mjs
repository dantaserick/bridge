import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));

/**
 * O app empacotado não pode depender do `tsx` nem do checkout do repo (Task
 * 10): o core vira um `dist/index.mjs` que o Node do sistema roda direto.
 *
 * O que ENTRA no bundle: as fontes do próprio core e `@bridge/shared` (que é
 * TypeScript sem build — não existe em `node_modules` do app instalado).
 * O que fica FORA: tudo que é dependência real de runtime, listada no
 * `package.json` — inclusive os módulos nativos (`better-sqlite3`,
 * `node-pty`), que precisam do `.node` ao lado e não sobrevivem a um bundle.
 * Essas dependências chegam ao app pelo `stage-core.mjs` do shell.
 *
 * `bin/bridge-hook.cjs` NÃO é buildado: o core resolve o caminho dele por
 * `new URL('../bin/bridge-hook.cjs', import.meta.url)`, e como o entry sai em
 * `dist/`, a mesma relação `../bin` vale no repo e no app empacotado.
 */
await build({
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: resolve(here, 'dist', 'index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // O `name/*` ao lado do `name` não é redundância: o esbuild casa `external`
  // por string EXATA, então um import de subcaminho (`pkg/sub`) cairia dentro
  // do bundle — justamente o que a regra acima diz pra manter fora. As deps
  // continuam chegando ao app pelo `stage-core.mjs` do shell.
  external: Object.keys(pkg.dependencies ?? {})
    .filter((name) => !name.startsWith('@bridge/'))
    .flatMap((name) => [name, `${name}/*`]),
});
