# ADR-001 — Electron app over a Node core + web UI

**Status:** accepted (brainstorming on 2026-09-03, spec §2/§3)

## Context

The author wants a Windows equivalent of cmux (macOS-only, Swift/AppKit over libghostty): a sidebar with per-agent state, native toast, workspaces with panels, worktrees, a `notify` CLI. Research done before starting found no Windows alternative delivering the whole package. The development machine has no GPU. An earlier project of the author's already had the PTY engine + Claude Code hooks in Node — that's where the core's `spawn.ts`/`hooks.ts` foundation comes from.

## Decision

Three processes: a Node **core** (Fastify + node-pty + SQLite, loopback + token) that owns sessions and state; a React + xterm.js **UI** that only draws what the core sends; an Electron **shell** that adds window, toast, and tray. Alternatives discarded: local web only (loses reliable toast), Tauri (PTY in Rust or a sidecar, immature child webview on Windows, zero reuse of the existing Node engine).

## Consequences

- The core runs standalone in a browser tab (all of Phase 1 was like this) — the UI and the CLI use the same HTTP/WS boundary.
- The terminal renders with xterm.js in Chromium (canvas renderer, no WebGL); without a GPU, Ghostty would also fall back to software.
- Electron's weight is accepted; hardware acceleration is off.
