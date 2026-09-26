# ADR-006 — The packaged UI is served by the core at `http://127.0.0.1:<port>/`, never `file://`

**Status:** accepted (Phase 2 ruling, Task 5)

## Context

`/ws` refuses an `Origin` outside loopback (defense in depth), and a `BrowserWindow` loading from `file://` sends `Origin: file://`. Besides that, the token should never go in the window's URL.

## Decision

The core serves the UI build as static content (`@fastify/static`) when `BRIDGE_UI_DIR`/`createCore({ uiDir })` is set; paths that aren't `/api`, `/ws`, `/hooks` (after normalization: decode, `//` collapse, `posix.normalize`) go to the static handler without a bearer token; protected ones always hit auth. The renderer gets the token via `window.bridge.token()` (preload) and connects at `/ws?token=`.

## Consequences

- In dev, `BRIDGE_DEV=1` loads Vite at `http://127.0.0.1:5173` (same origin rule).
- The `//api/state` and `/api%2Fstate` bypasses were closed with normalization and per-segment checking.
