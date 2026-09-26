# ADR-003 — Sem commits durante a construção; o histórico vive nos ledgers e no CHANGELOG

**Status:** aceita (ruling de setup da Fase 1) · **encerrada** com a publicação: daqui pra frente o histórico é o git

## Contexto

O Bridge foi construído inteiro por sessões de agente, com revisão por task, e o autor não quer commit feito por IA sem pedido explícito — nem de documentação. Mas o fluxo de desenvolvimento por subagentes (SDD) usa diff entre commits pra revisar cada task, e sem commits não há diff.

## Decisão

Durante a construção, nenhum commit é criado. A revisão por task usa **snapshots**: uma cópia da árvore (sem `node_modules`, `dist`, `release`, `.stage`, lockfile) e um `git diff --no-index` contra o último snapshot aceito; a árvore revisada vira o novo baseline. O ledger `progress.md` de cada fase guarda todos os rulings (com o custo de estarem errados), achados parqueados e minors adiados.

## Consequências

- O primeiro commit carrega as cinco fases de uma vez, e o `.gitattributes` (LF) normaliza o fim de linha pra ele não virar ruído.
- Perde-se `git bisect` e `blame` do período de construção; ganha-se um histórico narrativo por decisão, que é o que estes ADRs e o `CHANGELOG.md` são.
- Os ledgers (`.superpowers/sdd/*/progress.md`) ficam **fora** do repositório público, por `.gitignore`: o que valia deles foi promovido pros ADRs e pro `CHANGELOG.md`.
- **A partir da publicação esta ADR está encerrada**: o histórico do projeto é o git, um commit por mudança, como em qualquer repositório.
