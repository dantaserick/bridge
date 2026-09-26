# ADR-013 — Hooks for a WSL session run through Windows's Node, via interop

**Status:** accepted (0.11.0, verified pain point #2 — spec §3/§5)

## Context

Since 0.11.0 the session's environment belongs to the workspace, and with
`{ kind: 'wsl', distro }` both the shell **and** Claude Code start inside the
distro (`wsl.exe -d <distro> --cd <translated cwd> -- sh -lc …`). The
sidebar's state, though, still comes from hooks: the session's
`settings.json` points all of them at the shim `bridge-hook.cjs`, which
does `POST http://127.0.0.1:<port>/hooks/…` to the core (ADR-004).

The obvious path — running the shim with the distro's own `node`, and
falling back to Windows's Node only when it doesn't have one — was
implemented first and **is wrong**: in WSL2's default networking mode
(NAT), loopback is **not** shared with the host. From inside the distro,
`127.0.0.1` is the distro itself, and the shim's POST doesn't reach any
core. `networkingMode=mirrored` would share it, but it's optional and
recent: depending on it would mean depending on a setting the installing
machine might not have — and the failure is silent (the session comes up,
the hooks vanish, the sidebar sits at "idle" forever).

## Decision

The shim for a WSL session is **always** run by Windows's `node.exe`,
reached from inside the distro via interop — never the distro's `node`,
even when it has one. The executable's path is derived from the core's
`process.execPath` **by `wslpath` itself** (never a hand-written
`/mnt/c/Program Files/nodejs/node.exe`), and the shim's path travels in
**Windows form** (`C:\...\bridge-hook.cjs`), including in `BRIDGE_SHIM`:
interop passes the argv through untranslated, and a `/mnt/c/...` would
reach `node.exe` as a nonexistent file.

Since this requires `binfmt_misc/WSLInterop` to be on, each distro's probe
(`WSL_PROBE_SCRIPT`) answers three things — does it have `claude`? does it
have `node`? is interop on? — and interop comes **first** in the warning:
without it the session still comes up, but no hook ever arrives.
`BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_SESSION`, and `BRIDGE_SHIM` cross
the boundary via `WSLENV` (the user's own is preserved).

## Consequences

- A distro **without `node`** stops being a special case: the path is the
  same for all of them, and the only requirement is interop.
- `EnvironmentInfo.node` becomes purely **informative** (it shows up in
  the environment list), and `EnvironmentInfo.interop` is what turns into
  a real warning.
- `resolveEnvContext` **fails** (`environment-unavailable`, 422) when it
  can't reach Windows's Node via interop, instead of starting a session
  that would never report state.
- The shim is still the same file, with the same contract as ADR-004:
  what changes is who runs it and in what form the path arrives.
- None of this was verified on a REAL distro — the build machine has none
  (`wsl -l -q` empty, 2026-09-06). The whole chain is under test against a
  simulated `wsl.exe`, and the manual verification is logged in the
  README.
