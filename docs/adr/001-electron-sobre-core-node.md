# ADR-001 — App Electron sobre um core Node + UI web

**Status:** aceita (brainstorming de 03/09/2026, spec §2/§3)

## Contexto

O autor quer um equivalente Windows do cmux (macOS-only, Swift/AppKit sobre libghostty): sidebar com estado por agente, toast nativo, workspaces com painéis, worktrees, CLI `notify`. A pesquisa feita antes de começar não achou alternativa Windows que entregasse o pacote inteiro. A máquina de desenvolvimento não tem GPU. Um projeto anterior do autor já tinha o motor de PTY + hooks do Claude Code em Node — é dele que sai a base de `spawn.ts`/`hooks.ts` do core.

## Decisão

Três processos: um **core** Node (Fastify + node-pty + SQLite, loopback + token) que possui sessões e estado; uma **UI** React + xterm.js que só desenha o que o core manda; um **shell** Electron que adiciona janela, toast e bandeja. Alternativas descartadas: só web local (perde toast confiável), Tauri (PTY em Rust ou sidecar, webview filho imaturo no Windows, zero reaproveitamento do motor Node que já existia).

## Consequências

- O core roda sozinho numa aba de browser (Fase 1 inteira foi assim) — a UI e a CLI usam a mesma fronteira HTTP/WS.
- Terminal renderiza com xterm.js no Chromium (renderer canvas, sem WebGL); sem GPU o Ghostty cairia em software também.
- O peso do Electron é aceito; aceleração de hardware desligada.
