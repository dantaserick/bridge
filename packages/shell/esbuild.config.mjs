import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => resolve(here, 'dist', name);
const src = (name) => resolve(here, 'src', name);

/**
 * `@bridge/shared` é TypeScript sem build; por isso NADA além do `electron`
 * pode ficar external — o bundle tem que carregar as fontes junto. O core NÃO
 * entra aqui: ele roda como processo Node separado (ver `sidecar.ts`).
 */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

// Electron 44 aceita ESM no main; o preload, por rodar em sandbox, tem que ser CJS.
await build({ ...common, entryPoints: [src('main.ts')], outfile: out('main.mjs'), format: 'esm' });
await build({ ...common, entryPoints: [src('preload.ts')], outfile: out('preload.cjs'), format: 'cjs' });
/**
 * Gerador do ícone do app (Task 1): próprio módulo pra `scripts/make-icon.mjs`
 * importar sem precisar do `tsx`.
 */
await build({ ...common, entryPoints: [src('makeIco.ts')], outfile: out('makeIco.mjs'), format: 'esm' });
