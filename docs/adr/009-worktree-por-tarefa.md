# ADR-009 — One worktree per task in `.worktrees/<name>` inside the repo

**Status:** accepted (owner's decision at brainstorming; spec §7; Phase 3)

## Context

The owner works with one worktree per task inside the repo, one branch per task, merging into main and removing it when done. cmux doesn't create worktrees (its blog suggests a manual "superrepo").

## Decision

"New task" runs `git worktree add .worktrees/<name> -b <name> <base>` in the chosen repo, makes sure `.worktrees/` is in `.git/info/exclude`, and creates the workspace pointing at that folder (with Claude Code if requested). The sidebar shows branch, `+N` (commits ahead of the base), and `~M` (changed files), refreshed by a 15 s poll and right after a `Stop`. Menu: view diff (`git --no-pager diff <base>...HEAD` in a panel), merge (`--ff-only`, offering `--no-ff`), remove worktree, open in Explorer. Refusals: merging with a dirty base; removal with a dirty worktree or an unmerged branch. Out of scope for v1: PR/GitHub, automatic stash, rebase.

## Consequences

- `git` is called via `execFile` with `windowsHide`, never through a shell; tests use their own temporary repos (Bridge's own repo is never committed to by the AI — ADR-003).
- The model was already prepared since Phase 1: `Repo`, `Workspace.repoId/branch/worktree`, grouping by repo in the sidebar.
