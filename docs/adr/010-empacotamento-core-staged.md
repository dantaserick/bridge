# ADR-010 — Core staged in `resources/core` with its own lockfile; no `@electron/rebuild`

**Status:** accepted (Phase 2, Task 10a)

## Context

A consequence of ADR-002: the core runs on the system's Node, so the natives need the Node ABI, not Electron's. Packaging needs to be reproducible and can't require `tsx` or checking out the repo at runtime.

## Decision

`packages/core` is built by esbuild into `dist/index.mjs` (ESM, `@bridge/shared` inlined, `node_modules` external). Staging (`packages/shell/scripts/stage-core.mjs`) copies `packages/shell/stage/core.package.json` + `core.package-lock.json` (versioned; regenerated only with `--refresh-lock`) into `.stage/core`, runs `npm ci --omit=dev`, prunes `.bin`, non-win32-x64 prebuilds, `.pdb` files, and `better-sqlite3` sources, and aborts if the direct versions diverge from the root lockfile. electron-builder packages `resources/core/{dist,bin,node_modules,package.json}` and `resources/ui`, `asar: true` for the shell, `npmRebuild: false`, `electronDist` pointing at `node_modules/electron/dist` (works around an EPERM on the `win-unpacked.tmp` rename and avoids a 120 MB download), `publish: null`.

## Consequences

- Two runs of the staging step produce the same tree (hash checked).
- The installer has no icon or signature (Phase 5).
- Switching from sidecar to embedded core (ADR-002) would require redoing this staging with a rebuild for Electron.
