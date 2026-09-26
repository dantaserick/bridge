# ADR-004 — Agent state comes from hooks injected per session via `--settings`, through an HTTP shim

**Status:** accepted (spec §3/§5, Phase 1)

## Context

cmux discovers "agent finished / wants input" through three channels: terminal OSC, native per-agent hooks, and a `notify` CLI. Parsing the screen is fragile. Claude Code accepts an extra settings file per invocation (`--settings`), added on top of the user's own.

## Decision

Every agent session starts with `claude --settings <profile>/sessions/<id>/settings.json`, where **all** hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SubagentStart, SubagentStop, SessionEnd) and the `statusLine` point at the shim `bin/bridge-hook.cjs <sessionId> <Event>`. The shim (plain Node, zero dependencies) reads the payload on stdin, does a `POST /hooks/<sid>/<event>?token=` to the core, and prints the response; it **never** takes the agent down (any failure → `{}` and exit 0, 5 s timeout, responses ≥ 400 become `{}`). The command uses the absolute `process.execPath` (Claude's process may not have `node` on PATH). An `AgentAdapter` per agent translates each event into a `HookOutcome` (state change + notification); Codex/Gemini are stubs until they're installed. Agent-agnostic channels still work: OSC 9/99/777 in the PTY stream and `POST /api/sessions/:id/notify`.

## Consequences

- 100% reliable state when the hook arrives; cmux itself suffers from a "flaky" sidebar from depending only on hooks — here, `stuck` (5 blocked Stops) and the PTY exit are safety nets.
- The PTY's env strips `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` (otherwise a child Claude inherits the child-session marker and turns off its transcript).
- `claude.cmd` launches via `cmd.exe /c` (node-pty doesn't spawn `.cmd` files).
