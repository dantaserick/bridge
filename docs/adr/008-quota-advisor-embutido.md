# ADR-008 — Quota and statusline used to come from an external advisor, per session

**Status:** **superseded** in 0.10.0 by [ADR-012](012-monitor-de-uso-nativo.md) · accepted on 2026-09-03 · amended in 0.7.0 (path detection)

> [ADR-012](012-monitor-de-uso-nativo.md) describes the native usage monitor that took this place; this file stays on record for what existed and why it left.

## Context

There was a third-party tool the author already used as Claude Code's statusline: context, cost, model, and quota windows (5 h / week) with a status light. The idea was to have this on the Bridge sidebar too, without reimplementing the calculation.

## Decision (revoked)

The per-session settings' `statusLine` pointed at the shim with the `StatusLine` event. The core ran the advisor as a child process with the payload on stdin (`windowsHide`, 2 s timeout, 1 s cache per session) and returned its line to the terminal; the same payload produced the `QuotaSnapshot` (model, `contextTokens`, cost, `rate_limits`) for the sidebar. With no advisor on the path, the snapshot was assembled the same way and the line became its plain rendering.

In 0.7.0 the `quotaAdvisorPath` default changed from an absolute machine path (which could only go wrong on any other machine) to an empty string meaning **detect**, searching `config.json` → environment variable → global npm install → a copy next to the core.

## Why it left

Three reasons, in the order they weighed in:

1. **An optional external dependency for a central feature.** The sidebar bar is one of the first things you look at in Bridge, and it depended on a package most machines don't have. What was "missing" without it was described as "just the advice" — but it was exactly the per-window status light, which is the actionable information.
2. **A Node `spawn` per statusline.** Claude Code redraws the statusline several times per second during a turn. The 1 s per-session cache existed purely to absorb this, and the 2 s budget had to fit inside the shim's 5 s — a timing coupling across three processes to produce one line of text.
3. **The data was already at hand.** Context, model, cost, and the `rate_limits` windows came every time in the payload Claude Code itself sends to the hook. The advisor didn't fetch them: it formatted them.

What Bridge lacked, and no advisor would give it, was **history**: daily/weekly/monthly consumption by model and by project, which only exists by summing the transcripts. Building that and still outsourcing the line's formatting would mean keeping two sources of truth for the same number.

## Consequences of the removal (0.10.0)

- `packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS` from `quota.ts`, the `quotaAdvisorPath`/`quotaAdvisorResolved` config fields, and the `BRIDGE_QUOTA_ADVISOR` environment variable are gone.
- The statusline returned to Claude Code is now assembled by Bridge itself (`statusLine`, in `quota.ts`), in the same format as the sidebar bar and `bridge usage`.
- No child process in the `StatusLine` hook's path: the shim's 5 s budget became slack over in-memory work.
