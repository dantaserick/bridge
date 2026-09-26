# ADR-005 — Panel ↔ session is 1:1

**Status:** accepted (ruling R1 from Phase 1's final wave; spec §4)

## Context

The spec left cardinality implicit. Without a rule, every "＋ Claude" created a new panel forever, and ended sessions kept occupying panels, which Phase 2's split UI would inherit.

## Decision

A panel hosts at most **one** session. `POST /api/sessions` on a panel with a live session → `409 { error: 'pane already has a live session' }`; with an `exited` session, it's replaced (that's "Enter reopens a shell"). `DELETE /api/sessions/:id` kills the PTY, removes the session, and **removes the panel** when the tab has more than one leaf (the last one stays empty). A PTY that dies on its own does **not** remove the panel — the user can still read the output. `DELETE /api/tabs|workspaces/:id` kill the panels' sessions before removing the layout.

## Consequences

- The split tree doesn't grow indefinitely; restore reopens shells in empty panels.
- `Ctrl+Shift+C` on a panel with a live session splits first and creates in the new panel.
