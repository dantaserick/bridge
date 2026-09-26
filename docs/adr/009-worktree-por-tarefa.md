# ADR-009 — Um worktree por tarefa em `.worktrees/<nome>` dentro do repo

**Status:** aceita (decisão do dono no brainstorming; spec §7; Fase 3)

## Contexto

O dono trabalha com um worktree por tarefa dentro do repo, branch por tarefa, merge no main e remoção ao terminar. O cmux não cria worktrees (o blog dele sugere um "superrepo" manual).

## Decisão

"Nova tarefa" roda `git worktree add .worktrees/<nome> -b <nome> <base>` no repo escolhido, garante `.worktrees/` em `.git/info/exclude` e cria o workspace apontando pra essa pasta (com Claude Code se pedido). A sidebar mostra branch, `+N` (commits à frente do base) e `~M` (arquivos alterados), atualizados por poll de 15 s e logo após um `Stop`. Menu: ver diff (`git --no-pager diff <base>...HEAD` num painel), mesclar (`--ff-only`, com oferta de `--no-ff`), remover worktree, abrir no Explorer. Recusas: merge com base sujo; remoção com worktree sujo ou branch não mesclado. Fora da v1: PR/GitHub, stash automático, rebase.

## Consequências

- `git` é chamado por `execFile` com `windowsHide`, nunca por shell; testes usam repos temporários próprios (o repo do Bridge nunca é commitado pela IA — ADR-003).
- Modelo já preparado desde a Fase 1: `Repo`, `Workspace.repoId/branch/worktree`, agrupamento por repo na sidebar.
