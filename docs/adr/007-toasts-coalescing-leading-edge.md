# ADR-007 — Política de toast: o core decide `toast`, o shell coalesce leading-edge por sessão

**Status:** aceita (spec §4; ruling da Fase 2, Task 8)

## Contexto

O toast tem que sair quando o agente termina ou pede input **e** o usuário não está olhando aquela sessão; rajadas (vários `done` em segundos) não podem virar uma chuva de notificações; e o primeiro aviso não pode atrasar.

## Decisão

O core aplica a política (`needs-input`, `done`, `stuck`, `custom`; `toast:false` quando a sessão é a focada na janela em foco) e manda `toast: true|false` no evento `notification.new`. O shell mostra o **primeiro** toast de uma sessão imediatamente; os seguintes dentro de 2 s viram um só ("n avisos · último: …") entregue ao fim da janela; sessões nunca se misturam. Clique no toast foca janela + workspace + aba + painel (IPC `bridge:focus-session` → `revealSession`). O objeto `Notification` fica retido num `Set` até fechar/clicar (senão o GC come o handler). `needs-input` fora de foco também faz `flashFrame`.

## Consequências

- Contagem de não lidas tem fonte única no main (`presentUnread`), alimentada pelo `hello` e pelos eventos, e reaplicada em `did-finish-load`.
- Para e2e, `BRIDGE_TOAST_LOG=<arquivo>` troca o toast por uma linha JSON.
