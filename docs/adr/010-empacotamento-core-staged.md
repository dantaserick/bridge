# ADR-010 — Core staged em `resources/core` com lockfile próprio; sem `@electron/rebuild`

**Status:** aceita (Fase 2, Task 10a)

## Contexto

Consequência do ADR-002: o core roda no Node do sistema, então os nativos precisam do ABI do Node, não do Electron. O empacotamento precisa ser reproduzível e não pode exigir `tsx` nem o checkout do repo em runtime.

## Decisão

`packages/core` é buildado por esbuild em `dist/index.mjs` (ESM, `@bridge/shared` inlinado, `node_modules` externo). O staging (`packages/shell/scripts/stage-core.mjs`) copia `packages/shell/stage/core.package.json` + `core.package-lock.json` (versionados; regenerados só com `--refresh-lock`) pra `.stage/core`, roda `npm ci --omit=dev`, poda `.bin`, prebuilds não-win32-x64, `.pdb` e fontes do `better-sqlite3`, e aborta se as versões diretas divergirem do lockfile da raiz. electron-builder empacota `resources/core/{dist,bin,node_modules,package.json}` e `resources/ui`, `asar: true` pro shell, `npmRebuild: false`, `electronDist` apontando pro `node_modules/electron/dist` (contorna um EPERM no rename de `win-unpacked.tmp` e evita o download de 120 MB), `publish: null`.

## Consequências

- Duas execuções do staging produzem a mesma árvore (hash conferido).
- O instalador não tem ícone nem assinatura (Fase 5).
- Trocar de sidecar pra core embutido (ADR-002) exigiria refazer este staging com rebuild pro Electron.
