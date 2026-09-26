# ADR-003 — No commits during the build; history lives in the ledgers and the CHANGELOG

**Status:** accepted (Phase 1 setup ruling) · **closed** at publication: from here on, history is git

## Context

Bridge was built entirely by agent sessions, with per-task review, and the author doesn't want a commit made by AI without an explicit request — not even for documentation. But the subagent-driven development workflow (SDD) uses the diff between commits to review each task, and without commits there's no diff.

## Decision

During the build, no commit is created. Per-task review uses **snapshots**: a copy of the tree (without `node_modules`, `dist`, `release`, `.stage`, lockfile) and a `git diff --no-index` against the last accepted snapshot; the reviewed tree becomes the new baseline. Each phase's `progress.md` ledger holds every ruling (with the cost of being wrong), parked findings, and deferred minor issues.

## Consequences

- The first commit carries all five phases at once, and `.gitattributes` (LF) normalizes line endings so it doesn't turn into noise.
- `git bisect` and `blame` are lost for the build period; a narrative history per decision is gained, which is what these ADRs and `CHANGELOG.md` are.
- The ledgers (`.superpowers/sdd/*/progress.md`) stay **outside** the public repository, via `.gitignore`: what was worth keeping from them was promoted into the ADRs and `CHANGELOG.md`.
- **From publication onward this ADR is closed**: the project's history is git, one commit per change, like any repository.
