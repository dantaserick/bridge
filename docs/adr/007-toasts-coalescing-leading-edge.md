# ADR-007 — Toast policy: the core decides `toast`, the shell coalesces leading-edge per session

**Status:** accepted (spec §4; Phase 2 ruling, Task 8)

## Context

The toast has to fire when the agent finishes or wants input **and** the user isn't looking at that session; bursts (several `done`s in seconds) can't turn into a flood of notifications; and the first alert can't be delayed.

## Decision

The core applies the policy (`needs-input`, `done`, `stuck`, `custom`; `toast:false` when the session is the one focused in the focused window) and sends `toast: true|false` in the `notification.new` event. The shell shows a session's **first** toast immediately; the following ones within 2 s coalesce into one ("n notices · last: …") delivered at the end of the window; sessions never mix. Clicking the toast focuses window + workspace + tab + panel (IPC `bridge:focus-session` → `revealSession`). The `Notification` object is held in a `Set` until closed/clicked (otherwise GC eats the handler). `needs-input` out of focus also does `flashFrame`.

## Consequences

- Unread count has a single source in main (`presentUnread`), fed by `hello` and by events, and reapplied on `did-finish-load`.
- For e2e, `BRIDGE_TOAST_LOG=<file>` swaps the toast for a JSON line.
