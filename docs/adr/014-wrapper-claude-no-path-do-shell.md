# ADR-014 — A shell's `claude` goes through a session wrapper, and the first hook promotes the panel

**Status:** accepted (0.12.0 — spec §5, "Claude Code opened INSIDE a shell")

## Context

Per ADR-004, the state the sidebar shows comes from hooks injected via
`--settings` **per session**: whoever launches Claude Code is Bridge, so
it's Bridge that writes that session's `settings.json` and passes the
argument.

That leaves out the most common case for someone using the app: opening a
shell panel and typing `claude` in it. That Claude Code starts without
`--settings`, no hook reaches the core, and the sidebar row keeps saying
`shell` with a whole agent working inside it — no state ring, no "waiting
for you" notification, no statusline, no usage logging, and no scope
guard. It was the owner's literal request: "I'm running claude code and
it shows shell."

The discarded options: **reading the PTY screen** to guess a Claude came
up (that's exactly what ADR-004 rejects — heuristics over pixels instead
of a declared fact); and **writing to the user's global `settings.json`**
(Bridge would start touching a config that isn't its own, and it would
apply to every Claude Code on the machine, including ones running outside
the app).

## Decision

**Two halves, both within what Bridge already controls.**

1. **The wrapper.** Every shell session is born with `<sessionDir>/bin` at
   the front of the `PATH` **of that PTY**, and inside it a `claude` that
   calls the REAL Claude Code, adding `--settings <sessionDir>/settings.json`
   — the same `buildClaudeSettings(ctx)` used by agent sessions, with the
   same hooks pointing at ADR-004's shim. The target is resolved in the
   CORE's process, before the prepend, so the wrapper never points at
   itself; outside WSL there are two files (`claude.cmd` for
   cmd.exe/PowerShell and `claude` with no extension for Git Bash), and
   inside the distro there's a wrapper that removes its own bin from
   `PATH` before the `exec`. Without `claude` on the machine, nothing is
   written and `PATH` isn't touched.
2. **The promotion.** When the first hook for a SHELL session arrives, it
   becomes a **host** (`Session.hosted = { agent, since }`), and from then
   on its hooks go through the Claude adapter just like an agent session.
   The exit `SessionEnd` undoes the mark. `kind` does **not** change.

## Consequences

- ADR-004 still holds unamended: state still comes from a declared hook,
  via a session's `--settings`, through the same shim. What changed is
  **who puts the argument on the command line** — before it was Bridge
  launching the process, now it's a wrapper the shell goes through on its
  own.
- `kind` stopped being the answer to "does this session have an agent?".
  The question became `hosted?.agent ?? agent`, on every screen and in
  `liveAgentCount()`. ADR-005 (panel ↔ session 1:1) doesn't change: the
  hosting happens INSIDE the panel's single session.
- A host session **counts** toward the agent cap (it's a real Claude
  consuming a slot) and **never** goes through the scheduler queue —
  Bridge didn't launch it, and queueing it after the fact wouldn't make
  sense.
- Restoring a host panel reopens a **plain shell**: the session was born
  a shell and stays a shell on restore. Resuming the hosted conversation
  isn't supported yet. `POST /api/panes/:id/resume` reaches it via
  `lastAgentSessionId`, but only in a panel that already had an agent
  session before — the route also requires `lastAgent`, and hosting
  doesn't write that.
- The hooks route's surface grew: an authenticated POST to
  `/hooks/<sid of a shell>/<Event>` promotes that panel. It's the same
  trust the route already required (the `instance.json` token), with more
  panels on the other side — it's written up in `SECURITY.md`.
- Two declared limits: on WSL, a login shell that **clears** `PATH`
  (instead of appending to it) turns the feature off; and there's no
  heartbeat — a Claude killed without a `SessionEnd` leaves the session
  marked as a host until the shell closes.
- The `sessions.hostedAgents` switch (on by default) turns everything
  off, and takes effect starting with the **next** shell.
