# ADR-012 — Monitor de uso nativo, lido das transcrições

**Status:** aceita (06/09/2026) · **substitui a [ADR-008](008-quota-advisor-embutido.md)**

## Contexto

Até a 0.9.0 a statusline que o Bridge devolvia ao Claude Code e a faixa de cota da sidebar dependiam de uma ferramenta externa de cota — um projeto separado do autor, detectado no `PATH`. Ela era opcional (o dado sempre veio do payload do próprio Claude Code; a ferramenta o FORMATAVA), mas trazia três problemas para um repositório público:

1. **uma dependência que o usuário não tem.** Quem instala o Bridge não tem a ferramenta, e a única coisa que ele via era um aviso no log dizendo que faltava algo que ele nunca ouviu falar;
2. **uma fonte de verdade fora do repositório.** O formato da linha, as cores e os limiares eram decididos noutro projeto, com outro ciclo de release. Mudar a régua do Bridge exigia mudar a ferramenta;
3. **ela não respondia a pergunta que faltava.** Nem ela nem o payload dizem quanto foi gasto **ontem**, **na semana** ou **por projeto**. Esse número só existe somando as transcrições, e uma vez que o Bridge as some, terceirizar a formatação da linha seria manter duas fontes de verdade para o mesmo dado.

O dono decidiu (05/09/2026): tirar a integração e construir o monitor dentro do Bridge, com dashboard — "não tem isso no cmux".

## Decisão

O Bridge conta o próprio consumo, de duas fontes locais, e monta a própria statusline.

**Limites vivos** vêm do `rate_limits` do payload do hook `StatusLine`. Eles são da **conta**, não da sessão: saem do `QuotaSnapshot` por sessão e viram estado global (`usage_limits`), que alimenta a faixa única da sidebar e `GET /api/usage/limits`. Janela desconhecida (`seven_day_opus`, o que vier) aparece com a chave crua como rótulo em vez de sumir.

**Consumo** vem da varredura incremental das transcrições em `<claudeHome>\projects\**`, com `claudeHome` = `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`. A varredura é recursiva e classifica cada arquivo em `main` (a conversa que a pessoa digitou) ou `subagents` (os subagentes que ela lançou); lê cada arquivo a partir do offset gravado, em fatias, cedendo o event loop; deduplica por `message.id:requestId`; e joga fora tudo que não for contagem.

**Custo** é estimativa, de uma tabela de preços de lista embutida com `asOf` e fonte, sobreponível por `usage.pricingFile` e `usage.pricing`. Modelo fora da tabela conta em tokens e sai do custo, com aviso nomeando-o.

**A statusline** é montada em memória pelo core: `87k ctx · Fable 5.1 · US$ 3,42 · 5h 23% (reseta em 2h15) · semana 68% (reseta seg)`.

## Consequências

- Saíram `packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS`, os campos `quotaAdvisorPath`/`quotaAdvisorResolved` e a variável `BRIDGE_QUOTA_ADVISOR`. **Nenhum processo filho no caminho da statusline** — que é redesenhada várias vezes por segundo.
- Entraram `packages/core/src/usage/` (transcrições, agregação, preços, limites, progresso), `usagePoller.ts`, três tabelas no SQLite, três rotas (`GET /api/usage`, `GET /api/usage/limits`, `POST /api/usage/rescan`), o evento `usage.changed`, o painel `Ctrl+Shift+Y`, a seção Configurações → Uso e o comando `bridge usage`.
- **Privacidade é parte da decisão, não um detalhe de implementação:** o parser devolve contagens, id de modelo, `cwd` e carimbo. Não há coluna de conteúdo em tabela nenhuma, e nada sai da máquina — a tabela de preços é um arquivo do pacote, não uma consulta.
- **O custo passa a ser uma afirmação do Bridge.** Por isso ele é rotulado estimativa em todo lugar, traz a data da tabela, e `cost: null` (com `costPartial`) existe para não deixar "não dá pra saber" parecer "custou pouco".
- **A primeira varredura de um histórico grande é longa** — 8.431 transcrições e 12,8 GB na máquina do autor. Ela roda em segundo plano, persiste o offset por arquivo, retoma sozinha e informa o progresso (`usage.changed { scanning }`, no máximo um por segundo), que é o que deixa o painel dizer "ainda lendo" em vez de "não encontrei nada".
- **Transcrição reescrita por fora** (truncada, copiada por cima) é detectada por tamanho + impressão digital dos primeiros 512 bytes, e dispara uma reconstrução completa — no máximo uma por hora. É caro; a alternativa barata (uma tabela de contribuição por arquivo × dia, com subtração exata) está registrada no backlog interno do dono.
