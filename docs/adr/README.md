# ADRs — Bridge

Architecture decision records. Each one came out of a ruling made during the build or an approved spec. Short format: context, decision, consequences, status. A change that contradicts a decision here calls for a new ADR that supersedes it — not a silent edit of the old one.

| # | Decision | Status |
|---|---|---|
| [001](001-electron-sobre-core-node.md) | Electron app over a Node core + web UI (approach A) | accepted (2026-09-03) |
| [002](002-core-como-sidecar.md) | Core runs as a sidecar of the system Node, not embedded in main | accepted, revisit in Phase 5 |
| [003](003-historico-sem-commits.md) | No commits during the build; snapshot ledgers as history | closed at publication |
| [004](004-hooks-por-sessao-via-settings-e-shim.md) | Agent state comes from hooks injected per session via `--settings`, through an HTTP shim | accepted |
| [005](005-painel-sessao-um-para-um.md) | Panel ↔ session is 1:1 | accepted |
| [006](006-ui-servida-pelo-core.md) | The packaged UI is served by the core at `http://127.0.0.1:<port>/`, never `file://` | accepted |
| [007](007-toasts-coalescing-leading-edge.md) | Toast policy: the core decides `toast`, the shell coalesces leading-edge per session | accepted |
| [008](008-quota-advisor-embutido.md) | Quota and statusline used to come from an external advisor, per session | **superseded** in 0.10.0 by ADR-012 (native usage monitor) |
| [009](009-worktree-por-tarefa.md) | One worktree per task in `.worktrees/<name>` inside the repo | accepted (spec §7) |
| [010](010-empacotamento-core-staged.md) | Core staged in `resources/core` with its own lockfile; no `@electron/rebuild` | accepted |
| 011 | — number not used | — |
| [012](012-monitor-de-uso-nativo.md) | Native usage monitor, read from transcripts (supersedes 008) | accepted (0.10.0) |
| [013](013-hooks-de-wsl-pelo-node-do-windows.md) | Hooks for a WSL session run through Windows's Node, via interop (WSL2's NAT loopback isn't shared) | accepted (0.11.0) |
| [014](014-wrapper-claude-no-path-do-shell.md) | The `claude` typed in a shell goes through a session wrapper (which injects `--settings`), and the first hook promotes the panel to host | accepted (0.12.0) |
