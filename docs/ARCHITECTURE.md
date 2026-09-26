# Arquitetura do Bridge

Resumo de como o Bridge é montado, para quem vai mexer no código. As decisões,
com contexto e consequências, estão em [`adr/`](adr/README.md). Este documento
é o mapa, não a fonte da verdade.

## Três processos e um shim

```
                 ┌───────────────────────────────────────┐
   Electron      │ shell  (packages/shell)                │
   ──────────    │  janela, bandeja, toast nativo         │
                 └────────────────┬──────────────────────┘
                                  │ spawn (Node do sistema)
                                  ▼
                 ┌───────────────────────────────────────┐
   Node          │ core   (packages/core)                 │
   ──────────    │  Fastify em 127.0.0.1:<porta>          │
                 │  node-pty · SQLite · git/worktree      │
                 └───┬──────────────────┬─────────────────┘
                     │ HTTP /api + /ws  │ HTTP /hooks
                     ▼                  │
         ┌───────────────────────┐      │
         │ ui (packages/ui)      │      │   ┌──────────────────────────┐
         │ React + xterm.js      │      └───┤ shim bridge-hook.cjs     │
         │ servida pelo core     │          │ chamado pelos hooks do   │
         └───────────────────────┘          │ Claude Code, por sessão  │
                                            └──────────────────────────┘
```

- **core** (`packages/core`) é o dono de tudo que é estado: sessões PTY,
  layout, notificações, git. Escuta **só** em `127.0.0.1`, com um token por
  instância gravado em `%APPDATA%\bridge\instance.json`. Roda sozinho
  (`npm run dev:core`) — a UI abre numa aba de browser e funciona.
- **ui** (`packages/ui`) não guarda verdade: ela desenha o snapshot que o core
  manda por `GET /api/state` e aplica os eventos do WebSocket `/ws`. Toda
  mutação é uma rota.
- **shell** (`packages/shell`) é o Electron. Ele **não** embute o core: sobe
  um processo Node filho (ADR-002), porque `node-pty` e `better-sqlite3`
  precisariam de rebuild pro ABI do Electron e isso quebraria a suíte do core,
  que roda no Node do sistema. É por isso que o app **exige Node.js 22+ na
  máquina**.
- **shared** (`packages/shared`) é o contrato: tipos do domínio, eventos do WS,
  defaults de configuração e o mapa de atalhos. Nada de `node:` aqui — o
  pacote entra no bundle do browser.
- **cli** (`packages/cli`) é o comando `bridge`, um bundle CJS de arquivo único
  sem dependências de runtime. Ele fala a mesma API HTTP que a UI.

## Como o estado do agente aparece na sidebar

Nada é lido da tela do terminal. Ao abrir uma sessão de agente, o core escreve
um `settings.json` **só daquela sessão** e lança o Claude Code com
`--settings <caminho>`. Nesse arquivo, todos os hooks e a `statusLine` apontam
pro shim `packages/core/bin/bridge-hook.cjs`, que recebe `<sessionId> <Evento>`,
lê o payload no stdin e faz um POST em
`http://127.0.0.1:<porta>/hooks/<sessionId>/<Evento>`. O adaptador traduz o
evento em estado (ADR-004):

| Hook | Estado | Observação |
| --- | --- | --- |
| `SessionStart` | `idle` | zera contadores |
| `UserPromptSubmit` | `running` | detail "pensando…" |
| `PreToolUse` | `running` | detail = tool + resumo do argumento |
| `PostToolUse` | `running` | limpa o detail da tool |
| `PermissionRequest` | `needs-input` | + notificação |
| `Notification` | `needs-input` ou `idle` | depende da mensagem |
| `Stop` | `done` | + notificação; 5 `Stop` bloqueados seguidos viram `stuck` |
| `StatusLine` | (mantém) | atualiza a cota da sessão e as janelas do monitor de uso, e devolve a statusline montada pelo Bridge |
| saída do PTY | `exited` | guarda o `exitCode`; o painel fica aberto pra você ler |

O shim é Node puro, sem dependências, e sai com código 0 sempre: um core fora
do ar nunca pode derrubar o agente de quem está trabalhando.

Além dos hooks, qualquer painel pode notificar por sequências OSC 9 / 777 / 99
lidas do stream do PTY, ou por `bridge notify "texto"` — canais agnósticos de
agente, que marcam a notificação sem mexer no `state`.

## Modelo de domínio

```
Repo         { id, path, name, trustFilters, hasFilterDrivers? }
Workspace    { id, name, cwd, repoId?, branch?,
               worktree?: { base, path, baseGuessed? },
               environment?, crossAccess?, createdAt }
Tab          { id, workspaceId, title, kind: 'terminal', order }
Pane         { id, tabId }        # a posição vem da árvore de layout da aba:
                                  # split{ dir: 'v'|'h', ratio, a, b } | leaf{ paneId }
Session      { id, paneId, workspaceId, kind, agent?, state, detail?, tool?,
               lastNotification?, quota?, serverLimit?, resumeRequested?,
               resumeOutcome?, sawOutput?, scopeBlocks?, hosted?,
               pid, exitCode?, startedAt, stateSince }
Notification { id, sessionId, workspaceId, kind, text, at, readAt? }
QuotaSnapshot{ model, contextTokens, contextPct, costUsd, rateLimits[], at }
```

Os campos de sessão da 0.11.0 (`serverLimit`, `resumeRequested`/`resumeOutcome`,
`sawOutput`, `scopeBlocks`) e o `hosted` da 0.12.0 só existem em MEMÓRIA: são
fatos sobre a subida daquele processo, e o processo não sobrevive ao restart.
`environment` e `crossAccess` são do workspace e vão pro SQLite — são decisões
do dono.

`hosted` (`{ agent, since }`) marca a sessão de SHELL que está com um Claude
Code aberto dentro dela. `kind` continua `'shell'` e `agent` continua ausente:
quem responde "que agente é esse" é o `hosted.agent`, e é a regra
`hosted?.agent ?? agent` que a UI usa pro rótulo — ver o módulo
`adapters/hosted.ts` na tabela abaixo.

**Painel ↔ sessão é 1:1** (ADR-005): um painel hospeda no máximo uma sessão
viva. Pedir uma segunda devolve `409`; se a que está lá já saiu (`exited`), ela
dá lugar à nova. É a regra que faz "Enter num painel morto reabre um shell"
funcionar sem ambiguidade.

## Uma tarefa é um `git worktree`

`POST /api/tasks` cria `<repo>/.worktrees/<nome>` num branch de mesmo nome, e
o workspace nasce apontando pra lá (ADR-009). `.worktrees/` entra no
`.git/info/exclude` do repo, não no `.gitignore` versionado. A sidebar mostra
`+N` (commits à frente do base) e `~M` (arquivos sujos) de um poller que só
roda com a janela em foco recente. Merge e remoção passam pelas mesmas rotas,
com recusas explícitas — worktree sujo, branch já mergeado, base inexistente
— em vez de "dar um jeito".

## O monitor de uso

Quanto você já gastou hoje, na semana e no mês — em tokens e em custo estimado
— e quanto ainda cabe nas janelas de limite da conta. Tudo local, tudo do que o
Claude Code já grava (ADR-012, que substitui a ADR-008).

**Duas fontes, nenhuma delas remota:**

| O quê | De onde vem | Quem alimenta |
| --- | --- | --- |
| Janelas de limite (5 h, semana, o que mais o payload trouxer) | `rate_limits` do payload do hook `StatusLine` | `api/hooks.ts` → `usage.noteLimits()` |
| Consumo (tokens, custo, por dia/modelo/projeto) | varredura das transcrições `*.jsonl` | `usagePoller.ts` → `usage.scan()` |

**A varredura é incremental e cede o event loop.** `usage/transcripts.ts` desce
`<claudeHome>\projects` recursivamente (≤ 8 níveis, sem seguir link simbólico),
classifica cada arquivo em `main` (solto na pasta do projeto) ou `subagents`
(aninhado), e lê cada um **a partir do offset gravado**, em fatias de 256 KB,
cedendo o loop entre elas — o core hospeda todos os PTYs, e um `readSync` de
megabytes seguraria os terminais. O que sai da leitura são **contagens**:
tokens, id do modelo, `cwd` e carimbo de tempo. Conteúdo de mensagem não é
extraído e portanto não pode ser gravado.

**O que o banco guarda:** `usage_files` (o marcador de leitura por transcrição:
tamanho, mtime, offset, última chave de dedupe e a impressão digital dos
primeiros 512 bytes), `usage_daily` (contagens por dia × modelo × projeto ×
origem, com o upsert que SOMA) e `usage_limits` (a última foto das janelas).

**Três decisões que explicam o resto do módulo:**

- **subagente conta.** Numa amostra da máquina do autor, 62,8 % dos tokens
  vinham de transcrições de subagente. Contar só a conversa principal não é uma
  simplificação, é um erro por um fator;
- **custo é estimativa, e `null` não é `0`.** A tabela (`usage/pricing.json`)
  tem `asOf` e fonte; modelo que não está nela conta em tokens e sai do custo,
  com aviso nomeando-o. Um total baixo porque metade não tinha preço não pode
  parecer boa notícia;
- **a escrita de cache de 1 h é uma coluna própria.** Ela custa 2 × input
  (a de 5 min, 1,25 ×), e o payload traz as duas somadas em
  `cache_creation_input_tokens` com o detalhamento em `cache_creation`.

Quem consome: `GET /api/usage` (o painel e a CLI), `GET /api/usage/limits` (a
faixa da sidebar), `POST /api/usage/rescan` (o botão "Reler transcrições") e o
evento `usage.changed`, que carrega as janelas, os dias tocados e o progresso
da varredura (no máximo um por segundo — as janelas também, desde a 0.10.1).

**O atacante A7, e o sanitizador único (0.10.1).** Este é o **único** módulo do
Bridge que trabalha sozinho, a cada 60 s, em cima de conteúdo que o dono não
digitou: um `.jsonl` sob `<claudeHome>\projects` pode ter sido escrito por
outro processo dele, por um agente rodando dentro de uma sessão, ou restaurado
de um backup. A fase de segurança de 06/09/2026 acrescentou esse atacante ao
modelo de ameaça e endureceu o módulo em cima dele: teto de linha (4 MiB, com a
linha pulada e CONTADA em vez de travar o offset do arquivo), faixa nos
contadores de token e no dia do carimbo, tabela de preços sem protótipo
consultada por `Object.hasOwn`, listagem assíncrona com teto de arquivos, e
tetos no payload da statusline (janelas, tamanho de chave, `resets_at`).

A peça transversal é `sanitizeDisplay`, em `@bridge/shared`: **uma** função
pura para todo texto de fora que vai pra TELA — a statusline que o core devolve
ao Claude Code, a saída humana do `bridge usage` e os `title`/`aria-label` do
painel. Ela mora no `shared` pelo mesmo motivo de `formatUsd`: três pontas
escrevendo o mesmo dado com três regras diferentes é como uma delas fica de
fora na próxima mudança. O `--json` da CLI e o corpo da API continuam **crus**,
de propósito: são dado, não tela, e cortá-los mentiria sobre o que está no
disco.

## As quatro dores verificadas (0.11.0)

Cinco módulos novos, todos no core, todos com a mesma forma: a decisão mora num
módulo **sem I/O** e quem tem estado (o `core.ts`) chama. É o mesmo padrão do
`usage/aggregate.ts` — é o que deixa a regra sob teste sem PTY, sem banco e sem
`wsl.exe`.

| Módulo | O que decide | Quem chama, e o que sai |
| --- | --- | --- |
| `serverLimit.ts` | a saída do terminal casa com uma frase de limite do SERVIDOR? Janela rolante de 4 KB por sessão, ANSI removido, quatro padrões exatos | o `bus.on('pty.data')` do `core.ts` → `sessions.markServerLimited` → `session.state` com `serverLimit`. Sai no primeiro `Stop`/`UserPromptSubmit` (em `api/hooks.ts`) ou em 5 min |
| `launcher.ts` | este lançamento de agente pode sair agora? (`slots` \| `jitter` \| `backoff`) — classe pura, com relógio, sorteio e agendador injetáveis | `POST /api/sessions` (**201** ou **202** com a posição), `GET /api/launcher`, `POST /api/launcher/launch-now`, `DELETE /api/launcher/pending/:id`, evento `launcher.changed` |
| `environments.ts` | que ambientes esta máquina tem, e como traduzir cwd/`settings.json` pra dentro de uma distro (`wslpath`), com cache de 60 s | `GET /api/environments`; `resolveEnvContext` entra no `LaunchCtx` dos adaptadores (`adapters/shell.ts` e `adapters/claude.ts` montam o `wsl.exe`) |
| `recap.ts` | o `--resume` voltou vazio? (`resumeOutcomeOf`) e o resumo determinístico do transcript antigo (`readRecap`/`buildRecap`, leitura pela cauda) | `api/hooks.ts` no `SessionStart` → `session.updated` com `resumeOutcome`; `POST /api/sessions/:id/recap` → `{ text }` |
| `scopeGuard.ts` | este caminho está dentro da raiz da sessão? (`resolveTarget`, `scopeRootOf`, `checkScope`, `scopeDenyReply`) | `api/hooks.ts` no `PreToolUse`, **antes** do `adapter.onHook`: fora da raiz, a resposta É o `deny` e o adaptador nem é consultado. `sessions.noteScopeBlock` → `session.updated` com `scopeBlocks` |

Duas coisas que valem a leitura no código antes de mexer:

- **o `PreToolUse` tem dois donos.** A guarda decide primeiro e, quando recusa,
  `return` antes do adaptador — a ferramenta não vai rodar, então marcar
  `session.tool` mostraria na sidebar um trabalho que não aconteceu;
- **os hooks de uma sessão em WSL rodam pelo `node.exe` do WINDOWS**, por
  interop, mesmo quando a distro tem `node`: o loopback do WSL2 em NAT não é
  compartilhado, e o shim precisa alcançar o core em `127.0.0.1:<porta>` do
  host ([ADR-013](adr/013-hooks-de-wsl-pelo-node-do-windows.md)).

## O Claude Code aberto dentro de um shell (0.12.0)

Um módulo novo, na mesma forma dos cinco acima — a decisão num arquivo sem I/O,
e quem tem estado chamando:

| Módulo | O que decide | Quem chama, e o que sai |
| --- | --- | --- |
| `adapters/hosted.ts` | qual é o `claude` REAL desta máquina (`resolveHostedTarget`/`hostedTargetFrom`), o CONTEÚDO exato dos wrappers de cada sessão de shell (`hostedFiles`: `settings.json` + `bin/claude.cmd` + `bin/claude`, ou o wrapper de distro no WSL) e como o `bin` entra no PATH (`prependPath`, `WSL_HOSTED_SHELL_COMMAND`) | `adapters/shell.ts` (`shellLaunch`) monta os `files` e o `env`; o `core.ts` (`createSessionReserved`) resolve o alvo ANTES do prepend e põe `hosted` no `LaunchCtx` quando `sessions.hostedAgents` está ligada e o `kind` é `shell` |

Três coisas que só se veem no código:

- **o wrapper `.cmd` é ASCII puro, e isso é obrigatório**: o cmd.exe lê arquivo
  de lote na codepage OEM do console, não em UTF-8, então um caminho com acento
  escrito ali chega mangled ao Claude. O alvo viaja no ambiente
  (`BRIDGE_CLAUDE_BIN`) e o `settings.json` vem do `%~dp0`;
- **a promoção mora na rota, não no adaptador** (`api/hooks.ts`): quando um hook
  chega numa sessão `kind: 'shell'` que ainda não hospeda, a rota chama
  `core.noteHosted` e segue pelo MESMO caminho de uma sessão de agente
  (`adapters.claude`). O `SessionEnd` com motivo de saída é desviado ANTES do
  adaptador, pra `core.noteHostedEnd` — senão a UI desenharia um `exited` de um
  shell que continua vivo;
- **`sessions.setHosted`/`clearHosted`** são o par que guarda a marca:
  `setHosted` é idempotente (o `since` da primeira promoção fica de pé) e
  `clearHosted` devolve a sessão a `idle` sem tocar em `agentSessionId`,
  `quota`, `scopeBlocks` nem `exitCode` — o shell não morreu, só o Claude que
  estava dentro dele.

## O idioma (0.13.0)

Todo texto que uma pessoa lê sai de **um** catálogo, em `@bridge/shared`. São
quatro arquivos:

| Arquivo | O que é |
| --- | --- |
| `shared/src/i18n/pt-BR.ts` | a **fonte das chaves**: um objeto `as const`, e `MessageKey = keyof typeof ptBR` |
| `shared/src/i18n/en.ts` | as MESMAS chaves, preso por `satisfies Record<MessageKey, string>` — chave faltando **ou sobrando** é erro de tipo, não de runtime |
| `shared/src/i18n/index.ts` | `t(lang, key, params?)` (interpola `{nome}`, sem dependência nova), `resolveLanguage`, `systemLanguage`, `currentSystemLocale`, `LANGUAGES`, `INTL_LOCALE` |
| `shared/src/i18n/guard.ts` | `findUncataloguedLiterals(source, opts)` — a varredura pura que os testes de guarda de cada pacote rodam. **Não** é reexportada pela raiz do pacote: quem a usa é teste, e ela não tem por que entrar no bundle da UI |

`shared/src/format.ts` (custo, tokens, contagem, tempo relativo) recebe `lang`
**obrigatório** e usa `Intl` com `INTL_LOCALE[lang]`. O tempo relativo sai do
catálogo, não do `Intl.RelativeTimeFormat`: "há 1 min" e "1 min ago" cabem em
duas chaves e não pagam a construção de um formatador por linha da sidebar.

**Como o idioma chega em cada processo.** Quem resolve `'system'` é o **core**,
uma vez, no `updateConfig` (`core.ts`, `language()`): a locale da máquina não
muda com o app aberto, e resolver a cada notificação faria cada uma pagar um
`Intl.DateTimeFormat()`. Todo mundo consome o resultado dele,
`configSnapshot().languageResolved`, e **ninguém resolve de novo**:

| Processo | Como pega | Fallback antes da primeira resposta |
| --- | --- | --- |
| core | `core.language()`, lido **ao vivo** em cada mensagem, notificação, statusline e razão de `deny` | — |
| UI | `languageResolved` do `GET /api/config` e do `config.changed` do `/ws`; `LanguageProvider` → `useT()`/`useLang()` (`ui/src/i18n.tsx`) | `navigator.language` (`browserLanguage()`), só até a config chegar |
| shell (main) | `readCoreLanguage()` no boot + o evento `config.changed` (`shell/src/language.ts`, `tShell`) | `app.getLocale()` (`bootLanguage`), porque o diálogo "o core não subiu" é, por definição, o de quem não conseguiu perguntar nada |
| CLI | `languageResolved` da ÚNICA chamada que ela faz ao `/api/config` (`cli/src/lang.ts`) | `BRIDGE_LANG`, depois a locale da máquina — é o que faz `bridge --help` funcionar com o Bridge fechado |

**A troca é ao vivo, e é por isso que não há constante de texto.** Uma
`const RECAP_BANNER = 'retomando…'` é avaliada na importação do módulo e
congelaria o idioma da primeira montagem; toda uma família dessas virou função
de `lang` (`environmentLabel`, `detail*`, `recapBannerText`, `tableColumns`, …).
No `main` do Electron a exceção é a **bandeja**, o único texto que fica NA TELA
entre dois eventos: o `Menu` é imutável depois de montado, então
`TrayHandles.setLanguage` remonta o template — e o `setShellLanguage` só devolve
`true` quando o idioma MUDOU, senão todo `config.changed` (fonte do terminal,
teto do escalonador) remontaria o menu à toa.

**Duas coisas viajam como CHAVE, não como frase**, porque o produtor não tem
idioma e o consumidor tem: `LoginItemState.status` (main → IPC → `settingsModel`
da UI, traduzido com o idioma da JANELA) e `CoreExit.fatal`/`CoreStartError.key`
(`sidecar.ts` → `main.ts`, traduzido no instante de abrir o `showErrorBox`). O
bônus é de suporte: `shell.fatal.semNode` no `shell.log` diz mais do que a frase
no idioma de quem reportou.

**A guarda.** Um teste por pacote (`i18n-guard-shared.test.ts`,
`i18n-guard-core.test.ts`, `i18n-guard-ui.test.ts`, `i18n-guard-shell.test.ts` e
o bloco final de `cli/test/i18n-cli.test.ts`) varre o `src/` daquele pacote
procurando literal com acento ou palavra
pt-BR comum fora do catálogo, e falha listando `arquivo:linha`. É a trava contra
string nova entrar sem chave. Cada teste tem uma **allowlist de regex por
família** (log, `debug`, `appendShellLog`) e o código pode carregar um
`// i18n-ignore` na linha, com o motivo ao lado — perdão de família mora no
teste, perdão de uma linha mora na linha. A allowlist da UI é **vazia**, e um
segundo teste no arquivo é o que a mantém assim.

**O ponto cego declarado:** o guard olha ACENTO em literal. `Todos`, `Base`,
`Msg`, `Total` — pt-BR sem acento, e ainda por cima em texto de JSX — passam.
Foi a varredura de olho, e não o teste, que achou esses. Quem acrescenta copy em
`.tsx` precisa contar com isso (ver `CONTRIBUTING.md`).

## Persistência

Tudo mora no perfil, `%APPDATA%\bridge` (ou `BRIDGE_PROFILE_DIR`):

| Arquivo | O que é |
| --- | --- |
| `config.json` | porta, shell, poll de git, toasts, fonte do terminal, restauração, `usage` (custo e tabela de preços) e `ui` (o idioma, 0.13.0). Escrito de forma atômica. |
| `keybindings.json` | o mapa de atalhos, lido a cada pedido |
| `bridge.db` | SQLite: repos, workspaces, abas, painéis, layout, notificações, cota da sessão e as três tabelas do monitor de uso (`usage_files`, `usage_daily`, `usage_limits`) |
| `instance.json` | porta + token da instância viva (modo `0600`) |
| `logs\core.log`, `logs\shell.log` | logs |
| `sessions\<id>\` | o `settings.json` daquela sessão; some quando a sessão morre |

**Sessão não é persistida.** Ao reabrir, o Bridge restaura o *layout* e decide
por painel: quem tinha um Claude Code vivo volta com `claude --resume <id>` (se
`restore.resumeAgents` estiver ligado), o resto volta como shell.

**Restauração × workspace nascendo.** A restauração é por workspace ativado, e
criar um workspace muda o layout ANTES de o `POST` responder com o id — então
não dá pra saber pelo id quem está nascendo. O `App` mantém um registro de
criações em voo (`restore.ts`), uma entrada por criação, guardando os
workspaces que JÁ existiam quando aquele pedido começou: quem estava lá
restaura normal, o suspeito é pulado **sem** ser marcado como restaurado, e o
fim de uma criação reexamina o workspace ativo. A entrada é fechada por
IDENTIDADE (a função que o `begin` devolve, idempotente), não por posição —
duas criações cruzadas terminando fora de ordem removeriam a errada.

**Higiene de temporários.** O Bridge não escreve fora do perfil: o
`settings.json` de cada sessão mora em `sessions\<id>\` e some com ela, e o
dump de hook vai pra `logs\` confinado por prefixo, com nome derivado de
`basename()` e teto de 8 MB por arquivo. Quem cria pasta em `%TEMP%` é a
SUÍTE, não o app: o `globalSetup` do vitest e o e2e trabalham em pastas
`bridge-*` e as apagam no fim — uma execução interrompida (ou um cenário de
e2e que falhe segurando o `cwd`) pode deixar uma pra trás, e o corte de 1 hora
do `globalSetup` seguinte é quem varre.

**Modelo de confiança, em uma frase.** O Bridge trata a máquina e quem está
logado nela como confiáveis, e **tudo que entra de fora como hostil** — a
saída do terminal, o payload de hook e o
**repositório git**, que é código de terceiro capaz de rodar comando por
`filter.*` a cada `git status`: por isso o core detecta os drivers e
**pergunta** (`Repo.trustFilters`) em vez de neutralizar. O modelo de ameaça
inteiro, com o que ficou aceito, está em [`../SECURITY.md`](../SECURITY.md).

## O empacotamento

`npm run dist` gera um NSIS x64 por usuário. O core vai **fora** do `asar`
(ADR-010), em `resources/`: `core/dist/index.mjs`, `core/bin/*.cjs`,
`core/node_modules/` (só runtime, instalado com `npm ci` a partir de um par
`package.json`+lockfile versionado em `packages/shell/stage/`), `ui/` (o build
do Vite, que o core serve em `/`) e `cli/`. Os módulos nativos ficam com os
prebuilds do **Node do sistema** — nada de `@electron/rebuild`.

## Testes

- **vitest por pacote** para tudo que é função pura e rota: o padrão é extrair
  a decisão num módulo sem I/O (`settingsModel.ts`, `sidebarModel.ts`,
  `usage/aggregate.ts`) e testar isso, não o componente.
- **Playwright + Electron real** (`packages/shell/test/e2e.spec.ts`, `npm run
  e2e`): 17 cenários com core, PTY e janela de verdade; no fim de cada um ele
  confere que nenhum processo sobrou. Só o cenário do `resume` levanta um Claude
  Code de verdade; os outros que precisam de um agente usam um `claude.cmd`
  falso no começo do `PATH`, porque o que está sob prova é o caminho do dado, e
  não o binário.
- `npm run typecheck` é parte do contrato: `packages/ui/test/types-contract.test.ts`
  importa os tipos do core e quebra o typecheck da UI se os dois divergirem.

## Onde procurar cada coisa

| Quero mexer em… | Comece por |
| --- | --- |
| estado do agente, hooks | `packages/core/src/adapters/claude.ts` |
| rotas HTTP | `packages/core/src/api/routes.ts` + `schemas.ts` |
| PTY, scrollback, backpressure | `packages/core/src/pty.ts` |
| árvore de painéis | `packages/core/src/layout.ts` |
| worktree e git | `packages/core/src/git.ts`, `gitPoller.ts` |
| monitor de uso | `packages/core/src/usage/` + `usagePoller.ts`; na UI, `usageModel.ts` + `components/usage/` |
| limite do servidor, fila de lançamento | `packages/core/src/serverLimit.ts` + `launcher.ts`; na UI, `sidebarModel.ts` (`serverLimitBadge`, `launcherQueueLine`) |
| ambiente da sessão (pwsh/Git Bash/WSL) | `packages/core/src/environments.ts` + `adapters/{shell,claude}.ts`; no shared, `environment.ts` |
| resume vazio e o resumo | `packages/core/src/recap.ts`; na UI, `recap.ts` + `components/Pane.tsx` |
| guarda de escopo | `packages/core/src/scopeGuard.ts` + o bloco `PreToolUse` de `api/hooks.ts` |
| o wrapper `claude` de cada shell | `packages/core/src/adapters/hosted.ts` + `adapters/shell.ts` (`shellLaunch`) |
| promoção da sessão de shell a hospedeira | o ramo `kind === 'shell'` de `packages/core/src/api/hooks.ts` + `core.ts` (`noteHosted`, `noteHostedEnd`) e `sessions.ts` (`setHosted`, `clearHosted`) |
| rótulo `claude` de uma hospedeira na tela | `packages/ui/src/sidebarModel.ts` (`sessionLabel`, `sessionDetail`, `runsAgent`) + `paneModel.ts` (`paneDetail`) |
| sidebar | `packages/ui/src/sidebarModel.ts` + `components/sidebar/` |
| atalhos | `packages/shared/src/protocol.ts` (`DEFAULT_KEYBINDINGS`) |
| o texto de qualquer tela, em qualquer idioma | `packages/shared/src/i18n/pt-BR.ts` + `en.ts` (a chave é por SUPERFÍCIE: `sidebar.rodape.novaTarefa`, `uso.painel.total`) |
| como o idioma chega em cada processo | `packages/core/src/core.ts` (`language()`), `packages/ui/src/i18n.tsx`, `packages/shell/src/language.ts`, `packages/cli/src/lang.ts` |
| o seletor de idioma | `packages/ui/src/settingsModel.ts` (`languageOptions`) + o ramo `appearance` do `components/SettingsDialog.tsx` |
| janela, bandeja, toast | `packages/shell/src/main.ts`, `tray.ts` |
| quem manda `resize` pro PTY quando há dois xterms na mesma sessão | `packages/ui/src/terminalGrid.ts` (`gridAfterSync`) + as props `readOnly`/`onFitted` do `components/Terminal.tsx` |
| marca de restauração do painel (quem encerrou) | `packages/core/src/core.ts` (`createSessionReserved`, o ouvinte de `session.exited` e o `stop()`) + `layout.ts` (`setPaneEnded`) e a migração de `db.ts` (`rescueOrphanAgentPanes`); na UI, `restore.ts` (`panesToRestore`) |
| encerrar o core (saída normal e fim de sessão do Windows) | `packages/shell/src/shutdown.ts` + os ouvintes `before-quit`/`will-quit`/`session-end` do `main.ts` |
| empacotamento | `packages/shell/electron-builder.yml`, `scripts/stage-core.mjs` |
