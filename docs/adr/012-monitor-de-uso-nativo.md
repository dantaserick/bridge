# ADR-012 — Native usage monitor, read from transcripts

**Status:** accepted (2026-09-06) · **supersedes [ADR-008](008-quota-advisor-embutido.md)**

## Context

Up through 0.9.0, the statusline Bridge returned to Claude Code and the sidebar's quota bar depended on an external quota tool — a separate project of the author's, detected on `PATH`. It was optional (the data always came from Claude Code's own payload; the tool just FORMATTED it), but it brought three problems for a public repository:

1. **a dependency the user doesn't have.** Whoever installs Bridge doesn't have the tool, and all they'd see was a log warning about something missing they'd never heard of;
2. **a source of truth outside the repository.** The line's format, colors, and thresholds were decided in another project, on another release cycle. Changing Bridge's ruler meant changing the tool;
3. **it didn't answer the question that was missing.** Neither it nor the payload says how much was spent **yesterday**, **this week**, or **per project**. That number only exists by summing the transcripts, and once Bridge sums them, outsourcing the line's formatting would mean keeping two sources of truth for the same data.

The owner decided (2026-09-05): drop the integration and build the monitor inside Bridge, with a dashboard — "cmux doesn't have this."

## Decision

Bridge counts its own consumption, from two local sources, and assembles its own statusline.

**Live limits** come from the `rate_limits` field of the `StatusLine` hook payload. They belong to the **account**, not the session: they leave the per-session `QuotaSnapshot` and become global state (`usage_limits`), which feeds the sidebar's single bar and `GET /api/usage/limits`. An unknown window (`seven_day_opus`, whatever comes) shows up with the raw key as its label instead of disappearing.

**Consumption** comes from an incremental sweep of the transcripts at `<claudeHome>\projects\**`, with `claudeHome` = `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. The sweep is recursive and classifies each file as `main` (the conversation the person typed) or `subagents` (the subagents they launched); reads each file from its stored offset, in slices, yielding the event loop; deduplicates by `message.id:requestId`; and discards anything that isn't a count.

**Cost** is an estimate, from a built-in list-price table with an `asOf` and a source, overridable via `usage.pricingFile` and `usage.pricing`. A model outside the table counts in tokens and drops out of the cost, with a warning naming it.

**The statusline** is assembled in memory by the core:
`87k ctx · Fable 5.1 · US$ 3.42 · 5h 23% (resets in 2h15) · week 68% (resets Mon)`.

## Consequences

- `packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS`, the `quotaAdvisorPath`/`quotaAdvisorResolved` fields, and the `BRIDGE_QUOTA_ADVISOR` variable are gone. **No child process in the statusline's path** — which gets redrawn several times per second.
- `packages/core/src/usage/` (transcripts, aggregation, pricing, limits, progress), `usagePoller.ts`, three SQLite tables, three routes (`GET /api/usage`, `GET /api/usage/limits`, `POST /api/usage/rescan`), the `usage.changed` event, the `Ctrl+Shift+Y` panel, the Settings → Usage section, and the `bridge usage` command are new.
- **Privacy is part of the decision, not an implementation detail:** the parser returns counts, model id, `cwd`, and timestamp. There's no content column in any table, and nothing leaves the machine — the pricing table is a file shipped with the package, not a lookup.
- **Cost becomes a claim Bridge makes.** That's why it's labeled an estimate everywhere, carries the table's date, and `cost: null` (with `costPartial`) exists so "can't tell" doesn't look like "cost little."
- **The first sweep of a large history is long** — 8,431 transcripts and 12.8 GB on the author's machine. It runs in the background, persists the offset per file, resumes on its own, and reports progress (`usage.changed { scanning }`, at most once per second), which is what lets the panel say "still reading" instead of "found nothing."
- **A transcript rewritten from outside** (truncated, copied over) is detected via size + a fingerprint of the first 512 bytes, and triggers a full rebuild — at most once an hour. It's expensive; the cheap alternative (a per-file × day contribution table, with exact subtraction) is logged in the owner's internal backlog.
