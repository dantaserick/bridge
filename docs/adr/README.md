# ADRs — Bridge

Registros de decisão de arquitetura. Cada um nasceu de um ruling da construção ou da spec aprovada. Formato curto: contexto, decisão, consequências, status. Mudança que contrarie uma decisão daqui pede um ADR novo que a substitua — não uma edição calada da antiga.

| # | Decisão | Status |
|---|---|---|
| [001](001-electron-sobre-core-node.md) | App Electron sobre um core Node + UI web (abordagem A) | aceita (03/09/2026) |
| [002](002-core-como-sidecar.md) | Core roda como sidecar do Node do sistema, não embutido no main | aceita, revisitar na Fase 5 |
| [003](003-historico-sem-commits.md) | Sem commits durante a construção; ledgers por snapshot como histórico | encerrada na publicação |
| [004](004-hooks-por-sessao-via-settings-e-shim.md) | Estado do agente vem de hooks injetados por `--settings` por sessão, através de um shim HTTP | aceita |
| [005](005-painel-sessao-um-para-um.md) | Painel ↔ sessão é 1:1 | aceita |
| [006](006-ui-servida-pelo-core.md) | UI empacotada é servida pelo core em `http://127.0.0.1:<porta>/`, nunca `file://` | aceita |
| [007](007-toasts-coalescing-leading-edge.md) | Política de toast: core decide `toast`, shell coalesce leading-edge por sessão | aceita |
| [008](008-quota-advisor-embutido.md) | Cota e statusline vinham de um advisor externo, por sessão | **substituída** na 0.10.0 pela ADR-012 (monitor de uso nativo) |
| [009](009-worktree-por-tarefa.md) | Um worktree por tarefa em `.worktrees/<nome>` dentro do repo | aceita (spec §7) |
| [010](010-empacotamento-core-staged.md) | Core staged em `resources/core` com lockfile próprio; sem `@electron/rebuild` | aceita |
| 011 | — número não usado | — |
| [012](012-monitor-de-uso-nativo.md) | Monitor de uso nativo, lido das transcrições (substitui a 008) | aceita (0.10.0) |
| [013](013-hooks-de-wsl-pelo-node-do-windows.md) | Hooks de uma sessão em WSL rodam pelo Node do Windows, por interop (o loopback do WSL2 em NAT não é compartilhado) | aceita (0.11.0) |
| [014](014-wrapper-claude-no-path-do-shell.md) | O `claude` digitado num shell passa por um wrapper da sessão (que injeta o `--settings`), e o primeiro hook promove o painel a hospedeiro | aceita (0.12.0) |
