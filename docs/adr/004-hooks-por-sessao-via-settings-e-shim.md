# ADR-004 — Estado do agente vem de hooks injetados por `--settings` por sessão, através de um shim HTTP

**Status:** aceita (spec §3/§5, Fase 1)

## Contexto

O cmux descobre "agente terminou / pede input" por três canais: OSC no terminal, hooks nativos por agente e uma CLI `notify`. Parsear a tela é frágil. O Claude Code aceita um arquivo extra de settings por invocação (`--settings`), que se soma aos do usuário.

## Decisão

Cada sessão de agente sobe com `claude --settings <perfil>/sessions/<id>/settings.json`, onde **todos** os hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SubagentStart, SubagentStop, SessionEnd) e a `statusLine` apontam pro shim `bin/bridge-hook.cjs <sessionId> <Evento>`. O shim (Node puro, zero dependências) lê o payload no stdin, faz `POST /hooks/<sid>/<evento>?token=` no core e imprime a resposta; **nunca** derruba o agente (qualquer falha → `{}` e exit 0, timeout 5 s, respostas ≥ 400 viram `{}`). O comando usa `process.execPath` absoluto (o processo do Claude pode não ter `node` no PATH). Um `AgentAdapter` por agente traduz cada evento em `HookOutcome` (mudança de estado + notificação); Codex/Gemini são stubs até serem instalados. Canais agnósticos continuam valendo: OSC 9/99/777 no stream do PTY e `POST /api/sessions/:id/notify`.

## Consequências

- Estado 100% confiável quando o hook chega; o próprio cmux sofre com sidebar "flaky" por depender só de hooks — aqui o `stuck` (5 Stops bloqueados) e o exit do PTY são redes de segurança.
- A env do PTY remove `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` (senão o Claude filho herda o marcador de sessão-filha e desliga o transcript).
- `claude.cmd` sobe via `cmd.exe /c` (node-pty não spawna `.cmd`).
