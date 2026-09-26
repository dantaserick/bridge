# ADR-008 — Cota e statusline vinham de um advisor externo, por sessão

**Status:** **substituída** na 0.10.0 pela ADR-012 (monitor de uso nativo) · aceita em 03/09/2026 · emendada na 0.7.0 (caminho detectado)

> A [ADR-012](012-monitor-de-uso-nativo.md) descreve o monitor de uso nativo que tomou este lugar; este arquivo fica como registro do que existiu e por que saiu.

## Contexto

Havia uma ferramenta de terceiros que o autor já usava como statusline do Claude Code: contexto, custo, modelo e janelas de cota (5 h / semana) com farol. A ideia era ter isso também na sidebar do Bridge, sem reimplementar o cálculo.

## Decisão (revogada)

A `statusLine` do settings por sessão apontava pro shim com evento `StatusLine`. O core rodava o advisor como processo filho com o payload no stdin (`windowsHide`, timeout de 2 s, cache de 1 s por sessão) e devolvia a linha dele pro terminal; do mesmo payload saía o `QuotaSnapshot` (modelo, `contextTokens`, custo, `rate_limits`) pra sidebar. Sem advisor no caminho, o snapshot era montado igual e a linha virava a renderização simples dele.

Na 0.7.0 o default de `quotaAdvisorPath` passou de um caminho absoluto de máquina (que só podia dar errado em qualquer outra) pra string vazia = **detectar**, com a busca em `config.json` → variável de ambiente → instalação global do npm → cópia ao lado do core.

## Por que saiu

Três motivos, na ordem em que pesaram:

1. **Dependência externa opcional para uma função central.** A faixa da sidebar é uma das primeiras coisas que se olha no Bridge, e ela dependia de um pacote que a maioria das máquinas não tem. O que "faltava" sem ele era descrito como "só o conselho" — mas era exatamente o farol por janela, que é a informação acionável.
2. **Um `spawn` de Node por statusline.** O Claude Code redesenha a statusline várias vezes por segundo durante o turno. O cache de 1 s por sessão existia só pra segurar isso, e o orçamento de 2 s tinha que caber dentro dos 5 s do shim — um acoplamento de temporização entre três processos para produzir uma linha de texto.
3. **O dado já estava na mão.** Contexto, modelo, custo e as janelas de `rate_limits` vinham o tempo todo no payload que o próprio Claude Code manda pro hook. O advisor não os buscava: ele os formatava.

O que o Bridge não tinha, e nenhum advisor daria, era o **histórico**: consumo diário/semanal/mensal por modelo e por projeto, que só existe somando os transcripts. Construir isso e continuar terceirizando a formatação da linha seria manter duas fontes de verdade para o mesmo número.

## Consequências da remoção (0.10.0)

- Saíram `packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS` de `quota.ts`, os campos `quotaAdvisorPath`/`quotaAdvisorResolved` da configuração e a variável de ambiente `BRIDGE_QUOTA_ADVISOR`.
- A statusline devolvida ao Claude Code passou a ser montada pelo Bridge (`statusLine`, em `quota.ts`), com o mesmo formato pt-BR da faixa da sidebar e do `bridge usage`.
- Nenhum processo filho no caminho do hook `StatusLine`: o orçamento de 5 s do shim virou folga sobre um trabalho em memória.
