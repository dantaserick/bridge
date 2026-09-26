# ADR-002 — Core as a sidecar of the system Node

**Status:** accepted (Phase 2 ruling, Task 5); **revisit in Phase 5**

## Context

Spec §3 said Electron's main process would embed the core in the same process. `node-pty` and `better-sqlite3` are native modules: running inside Electron requires rebuilding them for Electron's ABI (`@electron/rebuild`). The monorepo has a single `node_modules`; rebuilding would break the core's test suite, which runs on the system's Node 24.

## Decision

Electron's main process spawns the core as a **child process** of the system Node (`BRIDGE_NODE` or `node` from PATH) and talks to it through the same HTTP/WS API the UI uses. The sidecar reads `instance.json` to find the port and token. Shutdown: `POST /api/shutdown` with a 1.5 s deadline and a `taskkill /t /f` fallback (`tsx` re-forks in dev, so `child.kill()` would leave orphans). A core from the profile that's still alive is **adopted** on the next startup if it responds to `GET /api/state` (and `GET /` when the shell expects the UI).

## Consequences

- The app **requires Node.js 22+ on the machine**. It's the accepted cost until Phase 5.
- All main↔core communication goes through the API (good: it's the same boundary as the UI and the CLI; bad: main doesn't see the in-process bus, so it uses a filtered WS client, `?events=`).
- Reverting this requires rebuilding the natives in a separate production install, or swapping `better-sqlite3` for `node:sqlite` and `node-pty` for a prebuild with Electron's ABI.
