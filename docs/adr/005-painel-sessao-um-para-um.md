# ADR-005 — Painel ↔ sessão é 1:1

**Status:** aceita (ruling R1 da onda final da Fase 1; spec §4)

## Contexto

A spec deixava a cardinalidade implícita. Sem regra, cada "＋ Claude" criava um painel novo pra sempre e sessões encerradas ficavam ocupando painéis, o que a UI de splits da Fase 2 herdaria.

## Decisão

Um painel hospeda no máximo **uma** sessão. `POST /api/sessions` num painel com sessão viva → `409 { error: 'painel já tem uma sessão ativa' }`; com sessão `exited`, ela é substituída (é o "Enter reabre um shell"). `DELETE /api/sessions/:id` mata o PTY, apaga a sessão e **remove o painel** quando a aba tem mais de um leaf (o último fica vazio). PTY que morre sozinho **não** remove o painel — o usuário ainda lê a saída. `DELETE /api/tabs|workspaces/:id` matam as sessões dos painéis antes de remover o layout.

## Consequências

- A árvore de splits não cresce indefinidamente; o restore reabre shells em painéis vazios.
- `Ctrl+Shift+C` num painel com sessão viva divide primeiro e cria no painel novo.
