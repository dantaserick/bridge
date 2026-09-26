# ADR-014 — O `claude` de um shell passa por um wrapper da sessão, e o primeiro hook promove o painel

**Status:** aceita (0.12.0 — spec §5, "Claude Code aberto DENTRO de um shell")

## Contexto

Pela ADR-004, o estado que a sidebar mostra vem de hooks injetados por
`--settings` **por sessão**: quem lança o Claude Code é o Bridge, então é o
Bridge que escreve o `settings.json` daquela sessão e passa o argumento.

Isso deixa de fora o caso mais comum de quem usa o app: a pessoa abre um painel
de shell e digita `claude` ali dentro. Esse Claude Code sobe sem `--settings`,
nenhum hook chega ao core, e a linha da sidebar continua dizendo `shell` com um
agente inteiro trabalhando dentro dela — sem anel de estado, sem notificação de
"esperando você", sem statusline, sem registro de uso e sem guarda de escopo.
Foi o pedido literal do dono: "estou rodando claude code e aparece shell".

As saídas descartadas: **ler a tela do PTY** pra adivinhar que um Claude subiu
(é exatamente o que a ADR-004 recusa — heurística sobre pixels em vez de fato
declarado); e **escrever no `settings.json` global do usuário** (o Bridge
passaria a mexer numa configuração que não é dele, e valeria pra todo Claude
Code da máquina, inclusive os que rodam fora do app).

## Decisão

**Duas metades, ambas dentro do que o Bridge já controla.**

1. **O wrapper.** Toda sessão de shell nasce com `<sessionDir>/bin` na frente do
   `PATH` **daquele PTY**, e dentro dela um `claude` que chama o Claude Code
   REAL acrescentando `--settings <sessionDir>/settings.json` — o mesmo
   `buildClaudeSettings(ctx)` das sessões de agente, com os mesmos hooks
   apontando pro shim da ADR-004. O alvo é resolvido no processo do CORE, antes
   do prepend, então o wrapper nunca aponta pra si mesmo; fora do WSL saem os
   dois arquivos (`claude.cmd` pro cmd.exe/PowerShell e `claude` sem extensão
   pro Git Bash), e dentro da distro sai um wrapper que remove o próprio bin do
   `PATH` antes do `exec`. Sem `claude` na máquina, nada é escrito e o `PATH`
   não é tocado.
2. **A promoção.** Quando o primeiro hook de uma sessão de SHELL chega, ela vira
   **hospedeira** (`Session.hosted = { agent, since }`) e dali em diante os
   hooks passam pelo adaptador do Claude como numa sessão de agente. O
   `SessionEnd` de saída desfaz a marca. `kind` **não** muda.

## Consequências

- A ADR-004 continua valendo sem emenda: o estado ainda vem de hook declarado,
  por `--settings` de sessão, pelo mesmo shim. O que mudou foi **quem põe o
  argumento na linha de comando** — antes o Bridge lançando o processo, agora um
  wrapper que o shell atravessa sozinho.
- `kind` deixou de ser a resposta pra "esta sessão tem um agente?". A pergunta
  passou a ser `hosted?.agent ?? agent`, em toda tela e em `liveAgentCount()`.
  A ADR-005 (painel ↔ sessão 1:1) não muda: a hospedagem acontece DENTRO da
  única sessão do painel.
- A sessão hospedeira **conta** no teto de agentes (é um Claude de verdade
  consumindo slot) e **nunca** passa pela fila do escalonador — não foi o Bridge
  que a lançou, e enfileirar depois do fato não faria sentido.
- Restaurar um painel hospedeiro reabre um **shell puro**: a sessão nasceu shell
  e é shell na restauração. Retomar a conversa hospedada ainda não é suportado.
  `POST /api/panes/:id/resume` a alcança pelo `lastAgentSessionId`, mas só num
  painel que já teve uma sessão de agente antes — a rota também exige
  `lastAgent`, e a hospedagem não grava esse.
- A superfície da rota de hooks cresceu: um POST autenticado em
  `/hooks/<sid de um shell>/<Evento>` promove aquele painel. É a mesma confiança
  que a rota já exigia (o token do `instance.json`), com mais painéis do outro
  lado — está escrito no `SECURITY.md`.
- Dois limites declarados: no WSL, um login shell que **zera** o `PATH` (em vez
  de acrescentar) desliga o recurso; e não há heartbeat — um Claude morto sem
  `SessionEnd` deixa a sessão marcada como hospedeira até o shell fechar.
- O interruptor `sessions.hostedAgents` (ligado por padrão) desliga tudo, e vale
  a partir do **próximo** shell.
