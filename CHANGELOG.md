# Changelog — Bridge

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versão única na raiz (`package.json`) espelhada nos pacotes. As entradas de 0.1.0 a 0.9.0 são **anteriores ao primeiro commit público** (ver ADR-003): as datas são de entrega verificada, não de tag. Da 0.9.0 em diante, cada versão é uma tag e uma release.

## [0.18.2] — 2026-09-23 — correções de build

### Corrigido

- Mudanças internas, sem efeito na edição pública.
- SHA-256 de `Bridge Setup 0.18.2.exe` (122 332 789 bytes):
  `1c2ac8bbedea8a2f272c947fac841209dc2235e498631b4dd279a53b55704f5b`.

## [0.18.1] — 2026-09-23 — `bridge focus` leva a janela até a sessão

### Corrigido

- **`bridge focus <sessão>` agora muda o que está na tela.** O comando só
  marcava o foco no core (tirar do `done`, ler as notificações) e a UI nunca
  ficava sabendo: a janela principal continuava no workspace em que estava.
  Agora o CLI manda `reveal: true` no `POST /api/focus`, o core emite
  `session.reveal` e a janela principal vai até a sessão pelo mesmo caminho
  do clique num toast: workspace, aba, painel e janela. O foco que a própria
  UI manda continua sem `reveal`, senão o clique dela voltaria pra ela.
  Sessão inexistente com `reveal` responde 404 em vez de "em foco".

## [0.18.0] — 2026-09-16 — barras de limite fixas

### Corrigido

- **As barras de 5 h e semana não somem mais quando você para de usar.** O
  Claude Code só manda `rate_limits` na statusline enquanto tem resposta
  recente da API; ocioso, o payload vem sem a chave. O core tratava isso, depois
  de dez minutos, como "a conta deixou de ter limites" e apagava as janelas —
  daí as barras sumirem a cada pausa e voltarem no primeiro turno seguinte.
  Agora o payload sem `rate_limits` nunca apaga nada: a última foto fica fixa
  na sidebar, no painel de Uso, na statusline e no `bridge usage`. O que muda
  com o tempo é só o que a janela de fato faz: passado o `resets_at`, ela
  aparece como 0 % e sem hora de reset — renovou —, e a próxima statusline com
  dado real substitui o número (também apaga sozinho o selo vermelho de "limite
  atingido"). Custo assumido: quem troca a assinatura por chave de API fica com
  barras em 0 % em vez de barra nenhuma.

## [0.17.0] — 2026-09-14 — o foco de mentira

### Corrigido

- **Cursor vazado e barra de espaço morta até trocar de tela.** As letras
  entravam, o espaço não, e o cursor do Claude Code ficava sem preenchimento —
  o retrato de um terminal que mandou "perdi o foco" (`ESC[O`, modo `?1004`)
  e nunca mandou "recuperei": o `blur` da caixa de texto do xterm disparou
  (janela em segundo plano, diálogo) e o `focus` de volta não
  foi reemitido, porque o Chromium não repete `focus` num elemento que já é o
  ativo. Agora o terminal confere, a cada tecla e a cada retorno de foco da
  janela, se a caixa de texto é o elemento ativo com o xterm se achando
  desfocado — e refaz o par `blur`/`focus` na hora, então a própria tecla que
  você apertou já sai certa. Quando o conserto dispara fica um aviso no
  console do renderer, pra confirmar o gatilho na próxima vez.

## [0.16.0] — 2026-09-13 — períodos do uso e resume que não se perde

### Adicionado

- **Monitor de uso com outros períodos.** O painel de Uso (`Ctrl+Shift+Y`)
  deixa de olhar só pra hoje: além de dia, semana e mês, há **ano** e
  **personalizado**, com ‹ › pra andar pros períodos anteriores e um "Hoje"
  pra voltar. No personalizado entram duas datas (até 366 dias, a partir de
  01/01/2020). O gráfico passa a mostrar os dias do período escolhido quando
  ele tem 30 dias ou mais — um mês passado mostra aquele mês, não os últimos 30
  dias —; período curto continua com os 30 dias que terminam nele. Na API,
  `GET /api/usage?range=day|week|month|year&anchor=AAAA-MM-DD` e
  `?range=custom&from=AAAA-MM-DD&to=AAAA-MM-DD`, com 400 `invalid-anchor` e
  `invalid-period`; `?range=day` sozinho responde como antes. Na CLI,
  `bridge usage --range ano`, `--anchor AAAA-MM-DD` e
  `--de AAAA-MM-DD --ate AAAA-MM-DD` (aliases `--from`/`--to`).

### Corrigido

- **Um Claude Code que sai sozinho não perde mais o resume.** Na madrugada de
  13/09 o Claude de um painel saiu sem `/exit` (a um minuto de um auto-update
  do Claude Code), e o reboot do Windows Update, 25 minutos depois, devolveu um
  shell no lugar da conversa. O motivo: qualquer morte do processo com o core
  vivo carimbava o painel como `lastEndedBy: 'user'`, e painel `'user'` não é
  retomado. Agora a morte do PTY não carimba nada — o painel fica com o `'app'`
  que nasce com o agente — e `'user'` só vem de intenção declarada: o hook
  `SessionEnd` com motivo `prompt_input_exit`/`exit`/`logout`, ou o
  encerramento pelo próprio Bridge (✕, `DELETE /api/sessions/:id`, fechar aba
  ou workspace). `SessionEnd` sem motivo, com `other` ou de `/clear` deixa o
  painel retomável.
- **A faixa do painel restaurado não some mais debaixo do prompt.** Ela era
  escrita dentro do xterm, e o ConPTY abre toda sessão com `ESC[2J ESC[H`
  (medido na saída do `pwsh -NoLogo`): o caminho da pasta era desenhado por
  cima da dica antes de alguém ler. A faixa virou uma linha do painel, logo
  abaixo do cabeçalho, com um ✕ pra dispensar; "sessão anterior era Claude
  Code" sai sozinha quando o Claude é aberto dentro do shell, e "retomando…"
  sai quando o core julga o resume.

## [0.15.0] — 2026-09-12 — clique do mouse no Claude Code e subagente vivo

### Adicionado

- **Clique do mouse no Claude Code** (`sessions.mouseClicks`, ligada por
  padrão; Configurações → Sessões). O Claude Code só aceita clique (escolher
  uma opção, trocar de aba entre agentes) na interface **fullscreen** dele, e
  a decisão de subir nela é do próprio Claude — por versão, por teste gradual,
  por `settings.tui`. Ligada, cada sessão nova nasce com
  `CLAUDE_CODE_NO_FLICKER=true` (a variável do dono, se existir, vence) e o
  xterm repassa o mouse ao programa; desligada, `CLAUDE_CODE_DISABLE_MOUSE=1` e
  o xterm **engole** os pedidos de rastreio de mouse (`CSI ? 1000/1002/1003/
  1005/1006/1015 h`), então arrastar sempre seleciona texto. O diagnóstico
  que levou a isto: o caminho inteiro já funcionava (xterm → WS → ConPTY →
  Claude, medido byte a byte) — o que faltava era o Claude pedir o mouse.
- **Sessão com subagente vivo não aparece como "terminou".** A conversa
  principal do Claude Code dispara `Stop` quando o turno DELA acaba, mesmo com
  um subagente (`general-purpose`, por exemplo) ainda trabalhando em segundo
  plano — e a sidebar dizia "terminou", com toast e tudo. O adaptador passou a
  ouvir `SubagentStart`/`SubagentStop` e a contar os subagentes vivos
  (`Session.subagents`, só memória): `SubagentStart` põe a sessão em `running`
  ("N subagentes rodando"); o `Stop` da principal com subagente vivo vira
  `running` ("esperando N subagentes") **sem** notificação; o último
  `SubagentStop` com a principal esperando a deixa `running` — o Claude retoma
  sozinho e o `done` de verdade (com o toast) vem do `Stop` desse turno.
- **Modos do terminal sobrevivem à reconexão.** O `Terminal` refaz a tela pelo
  scrollback a cada reconexão do WS com um `reset()`, que zerava os modos
  privados que o programa tinha ligado (mouse, colar entre chaves, setas de
  aplicação) — o clique morria até o Claude reenviar `?1000h`. Agora
  `terminalModes.ts` fotografa `term.modes` (mais o encoding do mouse, que o
  xterm não expõe e o `Terminal` rastreia pelos DECSET que passam) antes do
  `reset()` e reaplica as sequências depois do scrollback.

### Notas

- SHA-256 de `Bridge Setup 0.15.0.exe` (120 320 342 bytes):
  `2a2fe77dea57be42bb4d5fcc6fcea59b539a9bc914e58c2319f4fd824b9efdc8`

## [0.14.0] — 2026-09-11 — sino sempre visível, atalhos de aba e split com aba existente

Três ajustes de UI pedidos pelo dono no mesmo dia, todos em fluxos que já
existiam:

**O sino fica sempre na sidebar.** Ele só era desenhado quando havia
notificação não lida, então quem nunca tinha recebido um alerta não sabia
onde olhar. Agora é um botão fixo ao lado da engrenagem: cinza sem nada,
âmbar com a contagem quando há não lidas (`bell-button`/`has-unread`). No
painel, cada linha ganhou um **cabeçalho por tipo** na cor do anel
("Precisa de você", "Terminou", "Travado", "Aviso" —
`notifications.tipo.*`), antes do workspace e da sessão, e o texto do alerta
quebra em até três linhas em vez de virar reticências — era a reticência que
escondia a parte que explicava ("Permissão: Bash: git push…").

**"Novo Claude Code" e "Novo terminal" no "⋯" do workspace.** O único jeito
de subir um Claude era o atalho (que mira o painel focado) ou o botão do
painel vazio; o "+" da barra de abas abre um shell. As duas entradas novas
criam uma aba no workspace da linha (que pode nem ser o ativo — ele vira o
ativo) e sobem a sessão no painel dela (`newTabWithSession`). Somem com a
pasta do worktree sumida, como tudo que precisa de um shell.

**Dividir um painel com uma aba já aberta.** O cabeçalho do painel ganhou o
menu "Dividir painel": os dois splits vazios de sempre e, por aba de terminal
do **mesmo** workspace, "Trazer Terminal 2 · claude pro lado / pra baixo". No
core, `POST /api/panes/:id/split` aceita `adoptTabId`: a árvore inteira da
aba entra no lado b do split (`graftLeaf`, a forma geral do `splitLeaf`), os
painéis dela passam a ser da aba alvo e a aba esvaziada some — as sessões não
são tocadas, porque apontam pra painel. Recusas tipadas (`TabAdoptError`):
aba inexistente (404), a própria aba e aba de outro workspace (409, com
`code`).

### Notas

- SHA-256 de `Bridge Setup 0.14.0.exe` (120 296 162 bytes):
  `d080cccfe4a0d1c7d9fe5fc6baa1d2aaab1e16ced0d0081cf3f1c660c4bbe137`

## [0.13.0] — 2026-09-09 — idioma selecionável

O pedido do dono, de 08/09/2026, foi de uma linha: **idioma selecionável no
app.** Até aqui o Bridge era **português fixo** — não por decisão, mas por
origem: ele
nasceu pra uma pessoa, na máquina dela, e cada frase foi escrita direto no
arquivo onde ela aparece. O repositório é público desde a 0.9.0 e tem um
`README.en.md`, o que produzia a situação estranha de alguém ler a documentação
em inglês, instalar o app e receber "Aguardando você" numa sidebar em português.

O problema real não era traduzir: era que **não havia o que traduzir**. Os
textos estavam espalhados por cinco pacotes, dentro de `.tsx`, de constantes de
módulo e de literais no meio de uma condição — não dava nem pra responder
"quantos textos o Bridge tem?" sem varrer o repositório à mão. Então a versão
começou pelo lugar certo: um **catálogo de mensagens** em `@bridge/shared`, onde
`pt-BR.ts` é a fonte das CHAVES (um objeto `as const`, e `MessageKey` é o tipo
das chaves dele) e `en.ts` é preso por `satisfies Record<MessageKey, string>` —
chave faltando, ou sobrando, é erro de **typecheck**, não uma frase em branco na
tela de alguém. São **746 chaves**, escritas nos dois idiomas na mesma mudança.

Duas decisões deram forma ao resto. A primeira: o idioma é **UM só pra tudo** e
quem o resolve é o **core**. A UI, o processo do Electron e a CLI não perguntam
à máquina — eles recebem o `languageResolved` que o core já calculou. Sem isso,
`Intl` no core, `navigator.language` no renderer e `app.getLocale()` no main
poderiam dar respostas diferentes no mesmo computador, e o app falaria duas
línguas ao mesmo tempo. A segunda: a troca é **ao vivo**. Não há recarga de
janela, não há "reinicie o app" — e é por isso que praticamente nenhuma
constante de texto sobreviveu ao lote: uma `const` é avaliada quando o módulo é
importado, e congelaria o idioma da primeira montagem. Onde havia constante,
hoje há função de `lang`.

O que **não** foi feito, e por quê: nada de biblioteca de i18n (um mapa de
chaves e uma interpolação de `{nome}` bastam, e o projeto é deliberadamente
magro); nada de detecção por região dentro do inglês (o catálogo tem UM inglês,
`en-US`); e plural continua sendo **chave explícita** (`sessoes.uma` /
`sessoes.varias`) em vez de regra automática — as duas línguas que o Bridge fala
têm a mesma forma de plural, e uma biblioteca de regras custaria mais do que o
`if`.

### Adicionado

- **Catálogo de mensagens em `@bridge/shared`** (`src/i18n/`): `pt-BR.ts` (fonte
  das chaves), `en.ts` (as mesmas 746, presas pelo tipo), `index.ts` com
  `t(lang, key, params?)`, `resolveLanguage`, `systemLanguage` e `INTL_LOCALE`,
  e `guard.ts`, a varredura que os testes usam. As chaves têm nome por
  **superfície** (`sidebar.rodape.novaTarefa`, `uso.painel.total`), não por
  texto, pra sobreviverem a uma reescrita de copy. Em desenvolvimento o `t`
  **lança** em chave desconhecida e em parâmetro faltando; no `.exe` ele
  degrada — a pergunta é afirmativa (`test`/`development`/`BRIDGE_DEV`) porque
  no app empacotado o `NODE_ENV` simplesmente não existe, e um
  `!== 'production'` faria justamente do app instalado o ambiente mais
  explosivo.

- **`ui.language` em Configurações → Aparência**, com três opções: *Português
  (Brasil)*, *English* e *Do sistema*. O default é **`system`**, e a regra é
  curta: locale `pt`, `pt-…` ou `pt_…` (`pt`, `pt-BR`, `pt-PT`, `pt_BR`) vira
  português; **qualquer outra** vira inglês. Quem está no Brasil não configura nada; quem
  está fora recebe inglês sem procurar a opção. Os dois NOMES de idioma
  aparecem sempre na própria língua — quem procura inglês procura "English",
  inclusive numa tela em português; só "Do sistema" é frase e se traduz.

- **A troca vale na hora, em tudo, sem reabrir nada.** O `select` manda o
  `PATCH /api/config`, o core responde com a configuração inteira e o
  `config.changed` do WebSocket troca o idioma da janela — e do processo main
  junto. Passaram a falar os dois idiomas: a interface inteira (sidebar,
  painéis, os dois diálogos de criação, o painel "Uso", o de notificações, as
  faixas escritas no xterm), as **mensagens de erro da API**,
  as **notificações que o Bridge escreve**, a **linha de status**, os textos do
  escalonador de lançamentos, a **razão da recusa da guarda de escopo** — a que
  o agente lê e repete pra você —, a **bandeja**, os toasts nativos e os
  diálogos do Windows.

- **A CLI `bridge` no mesmo idioma do app.** Ela pergunta ao core (uma vez por
  processo) e usa o `languageResolved` dele. Com o Bridge **fechado** —
  `bridge --help`, `bridge --version`, ou qualquer comando antes de a instância
  ser encontrada — vale a variável **`BRIDGE_LANG`** (`pt-BR` ou `en`) e, sem
  ela, a locale da máquina. Com o Bridge aberto o `BRIDGE_LANG` **não** vence o
  app, de propósito: dois terminais da mesma máquina não deveriam responder em
  línguas diferentes sobre o mesmo core.

- **`languageResolved` no `GET /api/config`** — o idioma que o `ui.language`
  deu NESTA máquina. É **somente leitura** pela API (mandá-lo no `PATCH` volta
  `403 read-only`, ao lado de `port`, `profileDir` e `claudeHome`): quem quer
  trocar manda `ui.language`. Ele viaja no `config.changed` junto com o resto
  da configuração, e é dele que a UI, o main e a CLI tiram o idioma.

- **Uma guarda de idioma por pacote.** Um teste em cada um dos cinco varre o
  `src/` dele procurando literal com acento ou palavra pt-BR comum fora do
  catálogo, e falha listando `arquivo:linha`. É a trava contra uma string nova
  entrar sem chave. Perdão de família mora na allowlist do teste (log em
  arquivo, `debug`); perdão de uma linha mora na linha, num `// i18n-ignore`
  com o motivo ao lado. A allowlist da UI é **vazia**, e um segundo teste no
  arquivo é o que a mantém assim.

- **Cenário 14 do e2e** (`npm run e2e`): o app sobe num perfil sem
  `ui.language`, resolve `system` como pt-BR pela locale da máquina, recebe um
  `PATCH { ui: { language: 'en' } }` e — **sem reabrir** — troca cinco
  superfícies com asserção de texto exato (rodapé da sidebar, botões do painel
  vazio, menu "⋯" do workspace, Configurações → Aparência com `English`
  marcado, e uma `Notification` injetada por hook que chega escrita pelo core
  como "Waiting for you"), enquanto o `bridge list` rodado de fora imprime
  `state`/`age`. Depois volta pro `pt-BR` e confere os textos restaurados.

### Alterado

- **`format.ts` passou a exigir o idioma.** `formatUsd`, `formatTokens` e as
  duas funções novas (`formatCount`, `formatRelativeTime`) recebem `lang` e
  usam `Intl` com a locale correspondente: `US$ 3,42` e `há 1 min` em
  português, `US$ 3.42` e `1 min ago` em inglês. O tempo relativo sai do
  catálogo, e não do `Intl.RelativeTimeFormat` — duas chaves resolvem, e cada
  linha da sidebar deixa de pagar a construção de um formatador.

- **Duas coisas passaram a viajar como CHAVE de catálogo, não como frase**,
  porque quem as produz não tem idioma e quem as mostra tem.
  **`LoginItemState.status`** (o "app instalado" / "sem suporte" da seção
  Sistema) sai do processo main como `MessageKey` e é traduzido pelo renderer,
  com o idioma da JANELA — antes o main e a UI resolviam o idioma cada um por
  si, e uma troca podia deixar aquela seção numa língua com o resto do diálogo
  em outra. **`CoreExit.fatal` e `CoreStartError.key`** (`sidecar.ts` →
  `main.ts`) idem: o `sidecar.ts` é quem SOBE o core e não importa `electron`,
  então não tem de onde tirar um idioma; quem traduz é o `main.ts`, no instante
  de abrir o diálogo. Bônus de suporte: a CHAVE é o que vai pro `shell.log`, e
  ler `shell.fatal.semNode` diz mais do que a frase no idioma de quem reportou.
  Junto disso, **qualquer** falha de subida que não seja um `CoreStartError`
  passou a mostrar a frase genérica de "o core não subiu", com o texto cru indo
  pro log — antes uma invariante interna virava diálogo modal.

- **"Restaurar padrões" apareceu em Aparência**, e o que ele faz ali é devolver
  o idioma pro **`Do sistema`**. A seção passou a ter um campo que o `PATCH`
  mexe, então o botão passou a existir; o tema continua desabilitado e não é
  afetado.

- **A ordem dos grupos da sidebar passou a seguir a locale.** O
  `localeCompare` recebe `INTL_LOCALE[lang]`, que é o certo — e quer dizer que
  trocar de idioma pode reordenar dois repositórios cujos nomes só diferem por
  acento.

- **O rodapé do painel "Uso" mudou de negrito**: era `Custo <strong>estimado</strong>`
  e virou `<strong>Custo estimado</strong>`. É obrigatório (em inglês a ordem
  das palavras inverte, e partir a frase por palavra deixaria o destaque na
  palavra errada num dos dois idiomas), mas é uma mudança visível: duas
  palavras em negrito onde havia uma.

- **O processo main passou a falar com o `/api/config`** e a assinar o prefixo
  `config` no `/ws` — nenhuma das duas coisas existia. É como o idioma chega à
  bandeja e aos diálogos nativos. A bandeja é o único texto do main que fica NA
  TELA entre dois eventos, então ela é a única que é **remontada** na troca (o
  `Menu` do Electron é imutável depois de montado); o resto é escrito no
  instante de aparecer.

### Notas

- **O que NÃO é traduzido, declaradamente:** a saída dos agentes e dos shells
  (o texto dentro do terminal é de quem está rodando ali); as notificações que
  o **agente** escreve (`Notification` com `message`, e `bridge notify "texto"`)
  — as que o Bridge escreve, sim; os **logs em arquivo** (`core.log`,
  `shell.log` seguem em pt-BR: são do dono e de quem dá suporte, e uma linha de
  log traduzida é mais difícil de procurar, não mais fácil); o **instalador
  NSIS**; a **documentação** (este arquivo, o README e a spec seguem em
  português, com o resumo em inglês em `README.en.md`); e **nomes próprios e
  identificadores** — `Ctrl+Shift+C`, `wsl:Ubuntu`, `pwsh`, os ids de sessão e
  de workspace, o `kind` das linhas. Uma notificação **já registrada** não é
  reescrita quando você troca de idioma: ela é o registro do que aconteceu, no
  idioma daquele instante. Pelo mesmo motivo, o **`session.detail`** que a
  sidebar mostra ("pensando…", "escrevendo arquivo") fica no idioma do hook
  que o produziu até o próximo hook chegar — ele é o último estado observado,
  não uma frase que o Bridge redesenha.
- **Nenhuma dependência nova**, nada baixado, nenhuma rota nova e nenhum atalho
  novo. A configuração nova é um bloco `ui` no `config.json`, com o mesmo merge
  chave a chave dos outros.
- **A guarda tem um ponto cego conhecido:** ela olha ACENTO. Copy pt-BR sem
  acento (`Todos`, `Base`, `Msg`, `Total`) e texto solto dentro de JSX passam
  batido — o que os achou foi varredura de olho. Mitigação em vigor.
- **Testes**: core 1 089 passando e 3 pulados (57 arquivos), ui 812 (25),
  shell 173 (13), shared 128 (9), cli 90 (4) — **2 292 passando** em 108
  arquivos. O e2e do app real passou **14/14**.
- SHA-256 de `Bridge Setup 0.13.0.exe` (120 247 356 bytes):
  `4f82770c0768697b0fcbb432088319de38671009ad1bf0a1fb6bb5274963b1ae`

## [0.12.2] — 2026-09-09 — ajustes de sidebar e linha de status

Três pedidos do dono, todos da mesma família: o app estava mostrando coisa
demais num lugar e de menos em outro. A sidebar retraía um workspace quando
outro era ativado; o selo da guarda de escopo continuava aceso depois de a
recusa já ter sido autorizada; e os mesmos números de uso apareciam duas vezes
na tela — na sidebar e no rodapé do terminal do Claude Code.

### Alterado

- **Todo workspace da sidebar nasce EXPANDIDO, e recolher passou a ser manual.**
  A pergunta do dono foi essa: *"no workspace quando clico em um o outro se
  retrai, não era pra ser tudo aberto por padrão e se eu quisesse retrair eu
  clicava?"*. Era um acordeão por desenho — a sidebar expandia o workspace
  ATIVO e só ele —, e o efeito prático é que ver as sessões de dois projetos ao
  mesmo tempo era impossível: ativar um fechava o outro.

  Agora as duas coisas são independentes. Cada linha de workspace ganhou um
  **chevron** à esquerda, que recolhe e expande só aquele workspace e não ativa
  nada; clicar no nome continua ATIVANDO (é o que troca a área de conteúdo) e
  não mexe mais na abertura de ninguém. O workspace ativo mantém o realce de
  fundo, que deixou de ser a mesma coisa que "está aberto". Recolhido, o
  workspace mantém o **anel do pior estado entre as sessões dele**, como o
  cabeçalho de grupo recolhido já fazia: fechar uma linha esconde as sessões,
  nunca o aviso de que alguma travou.

  Quais workspaces estão recolhidos é preferência da MÁQUINA, ao lado das de
  grupo: mesmo `localStorage`, mesma chave `bridge.sidebar.groups`, campo novo
  `collapsedWorkspaces` (por id de workspace). A lista guardada é o negativo do
  que se vê — quem não está nela está aberto —, e é por isso que a preferência
  gravada por uma versão anterior, que não tinha o campo, abre tudo em vez de
  fechar tudo. Pelo teclado o chevron é um botão com `aria-expanded` e rótulo
  "Recolher workspace" / "Expandir workspace"; o ↑/↓ continua andando entre
  cabeçalho de grupo, workspace e sessão, sem uma parada nova por linha.

  O custo declarado: com muitos workspaces a sidebar fica mais longa. O recolher
  manual é a resposta, e ele é lembrado.

- **O selo 🛡 some quando você libera o acesso.** O relato: *"o guard bloqueou…
  eu liberei, mas ainda ficou o escudo azul, tem como ele sumir depois que eu
  autorizo?"*. O selo era cumulativo por decisão da 0.11.0 (a tentativa
  aconteceu, e o registro dela era esse número), mas ele descreve uma CERCA — e
  ao ligar "Permitir acesso fora do worktree" a cerca deixou de existir naquele
  workspace. O aviso continuava na tela depois de o dono já ter respondido.

  Agora `PATCH /api/workspaces/:id { crossAccess: true }` zera o contador de
  recusas de todas as sessões vivas daquele workspace e emite um
  `session.updated` por sessão zerada, então o selo some na hora, sem recarregar
  nada; sessões de outros workspaces não são tocadas. A UI também esconde o selo
  enquanto o workspace estiver liberado — é a rede que cobre o instante entre o
  `PATCH` e o evento chegar, e o snapshot que volta do banco ao reabrir o app.

  **Restringir de novo não repõe o número**: ele recomeça do zero na primeira
  recusa nova. O que se perde é o histórico de recusas anteriores, que era
  informativo; cada recusa continua registrada no log do core, com a ferramenta,
  o caminho e a raiz.

- **A linha de status saiu do terminal do Claude Code (e continua na sidebar).**
  A proposta do dono: *"se já mostramos uso 5h/semana e contexto/preço no
  sidebar, acho melhor tirar no terminal"*. A linha do rodapé da TUI é a
  `statusLine` que o Bridge injeta no `settings.json` da sessão, e ela mostra
  exatamente os mesmos números que a sidebar mostra a poucos centímetros dali.

  A configuração nova é `usage.terminalStatusLine`, e ela **nasce desligada** —
  ou seja, **o padrão mudou**: quem quiser a linha de volta liga em
  **Configurações → Uso**, no interruptor *"Mostrar a linha de status no terminal
  do Claude Code"*. O que **não** mudou é o mais importante: o hook `StatusLine`
  continua sendo injetado e chamado a cada redesenho, e é dele que saem o
  contexto, o modelo, o custo estimado e as janelas de 5 h e da semana que
  alimentam a linha da sessão, as barras de limite da sidebar e o monitor de uso.
  Desligada, o Bridge responde ao hook com uma linha **vazia**. O `bridge usage`
  e a CLI não mudam em nada.

  Medido com um Claude Code REAL (2.1.266) num PTY, com um `settings.json`
  descartável: com o comando da `statusLine` devolvendo string vazia, a TUI
  **não desenha rodapé nenhum** — nem uma barra em branco —, e o comando SEGUE
  sendo chamado a cada redesenho (o mesmo teste com o comando devolvendo texto
  desenha a linha normalmente). Não foi preciso adaptar nada: linha vazia basta.

### Notas

- **Nenhuma dependência nova**, nada baixado, nenhuma rota nova e nenhum atalho
  novo. A configuração nova é um booleano em `usage`, com o mesmo merge chave a
  chave dos outros campos do bloco.
- **Testes**: core 1 054 passando e 3 pulados (55 arquivos), ui 754 (22),
  shell 153 (11), shared 74 (6), cli 69 (3) — **2 104 passando**. O e2e do app
  real passou **13/13**.
- SHA-256 de `Bridge Setup 0.12.2.exe` (120 080 240 bytes):
  `c13b9e0153ddca430ea098b6a604536230cf7d124763e4f54320c0ec4599772b`

## [0.12.1] — 2026-09-08 — restauração sobrevive a morte não limpa

### Corrigido

- **O painel que era Claude Code voltava como shell.** O relato do dono foi
  direto: *"eu voltei e não restaurou minha sessão anterior do claude, só
  aparece o workspace que eu estava trabalhando com o shell"*. O painel dele
  estava no banco com tudo o que a restauração precisa — `last_kind='agent'`,
  `last_agent='claude'`, o `last_agent_session_id` da conversa — e faltando
  exatamente uma coisa: `last_ended_by`, que estava **nulo**.

  A causa: a restauração só retoma um painel marcado como encerrado pelo APP
  (`lastEndedBy === 'app'`), e essa marca era escrita num lugar só — no
  `stop()` do core, ou seja **apenas num encerramento gracioso**. Só que o
  Bridge morre sem encerramento gracioso mais vezes do que parece. O instalador
  NSIS derruba o app em execução sem mandar `WM_CLOSE`; o desligamento do
  Windows faz o mesmo. Nesses casos o `stop()` nunca roda, ninguém marca nada,
  e a subida seguinte devolve um shell. No `shell.log` do dono, as três últimas
  subidas do app começaram com `instance.json órfão descartado` — o rastro de um
  core que morreu sem ninguém pedir — e nenhuma delas foi precedida de um
  `encerrando o core`.

  A correção inverte o MOMENTO da marca. Ela passa a ser escrita **quando o
  agente sobe**, logo depois de o PTY nascer, e quer dizer "se o app morrer
  agora, retome este painel" — não mais "o app fechou direitinho". A saída
  normal do processo do agente (`/exit`, ✕, fechar painel, crash) continua
  carimbando `'user'` por cima, que é o que impede o Bridge de ressuscitar uma
  conversa que você fechou de propósito; e o `stop()` continua marcando, agora
  como cinto. **Retomar deixou de depender de um encerramento limpo.**

  Junto vem uma **migração idempotente** que resgata o painel de quem já perdeu
  a marca: linha de painel com `last_kind='agent'`, id de conversa gravado e
  `last_ended_by` nulo vira `'app'` na próxima abertura do banco. Essa
  combinação só existe por um motivo — o core morreu com o agente vivo —,
  porque a saída normal sempre grava `'user'` e o encerramento sempre grava
  `'app'`. Painel sem id de conversa e painel de shell ficam de fora, e um
  painel já carimbado nunca é reescrito.

  E o shell do Electron passou a tratar o **fim de sessão do Windows**
  (desligar, reiniciar, sair da conta): o `session-end` da janela e o
  `before-quit` do app pedem o mesmo encerramento gracioso do core que o
  `will-quit` sempre pediu, compartilhando um `stopCore()` só — melhor esforço,
  sem bloquear o sistema operacional. Quem continua matando o app sem aviso
  nenhum é o instalador (candidato: a macro
  `customCheckAppRunning` do electron-builder).

  Nada disso muda o shell HOSPEDEIRO da 0.12.0: o `kind` dele continua sendo
  `shell`, ele não ganha marca de agente e segue restaurando como shell puro.

### Notas

- **Nenhuma dependência nova**, nada baixado, nenhuma rota nova, nenhum atalho
  novo, nenhuma configuração nova. A regra da restauração continua sendo
  `lastEndedBy === 'app'` — o que mudou foi quando esse `'app'` é escrito.
- **Cenário 13 do e2e**: com um `claude` falso no PATH, o cenário confere no
  SQLite que o painel do agente já nasce marcado, mata o Electron e a árvore do
  core com `taskkill /f` (nada de `app.close()`, nada de `POST /api/shutdown`,
  e o `instance.json` fica pra trás como prova), relança no mesmo perfil e
  exige o painel de volta como AGENTE, com `--resume <id da conversa>` no argv
  do `claude` e a linha da sidebar dizendo `claude`.
- **Testes**: core 1 045 passando e 3 pulados (55 arquivos), ui 728 (22),
  shell 153 (11), shared 73 (6), cli 69 (3) — **2 068 passando**. O e2e do app real passou **13/13**.
- SHA-256 de `Bridge Setup 0.12.1.exe` (120 078 046 bytes):
  `621279c9b79cfc26ba64c5b7e909004aca45cb84f661a95d06d2dcfc1cf4026f`

## [0.12.0] — 2026-09-08 — Claude Code reconhecido dentro do shell

O pedido do dono foi literal: *"estou rodando claude code e aparece shell"*. E
estava certo. O Bridge só sabia o que uma sessão estava fazendo quando era ELE
quem tinha lançado o agente — porque é nesse momento que ele escreve o
`settings.json` da sessão e passa o `--settings`. Quem abria um painel de shell
e digitava `claude` ali dentro ficava com um Claude Code invisível: nenhum hook
chegava ao core, a linha da sidebar dizia `shell` com anel cinza de sessão
parada, e nada de notificação, statusline, registro de uso ou guarda de escopo —
com um agente inteiro trabalhando dentro daquele painel.

Duas coisas mudaram, e as duas dentro do que o Bridge já controla. **Todo shell
que ele abre nasce com uma pasta própria na frente do `PATH` daquele PTY**, com
um atalho `claude` que chama o Claude Code REAL acrescentando o `--settings` da
sessão — o mesmo arquivo de hooks das sessões de agente. E **quando o primeiro
hook chega, a sessão de shell vira hospedeira**: a linha passa a mostrar
`claude` com anel de estado de verdade, e ao sair do Claude ela volta a dizer
`shell` — com o shell vivo, no mesmo painel, com o mesmo histórico. Nenhuma
tecla nova, nenhum passo a mais: você digita `claude` como sempre digitou.

O que ficou de fora, por decisão: nada é lido da TELA do terminal pra adivinhar
que um Claude subiu (é o que a ADR-004 recusa desde sempre — heurística sobre
pixels em vez de fato declarado), e nada é escrito no `settings.json` GLOBAL do
usuário (o Bridge passaria a mexer numa configuração que não é dele, e que vale
pra todo Claude Code da máquina). O registro está na
[ADR-014](docs/adr/014-wrapper-claude-no-path-do-shell.md).

### Adicionado

- **Wrapper `claude` por sessão de shell** (`packages/core/src/adapters/hosted.ts`).
  Em `<pasta da sessão>\bin` saem um `claude.cmd` (o que o pwsh e o
  PowerShell resolvem, via `PATHEXT`) e um `claude` sem extensão (o que o Git
  Bash resolve) — os dois na mesma pasta, sem que nenhum dos dois shells se
  confunda. Eles chamam o caminho ABSOLUTO do claude real, nunca `claude` pelo
  PATH: com o próprio bin na frente, o wrapper acharia a si mesmo. O alvo é
  resolvido pelo processo do CORE, antes de qualquer prepend, então por
  construção ele nunca aponta pro wrapper. Os argumentos são repassados
  intactos.
- **`Session.hosted = { agent, since }`**, presente só enquanto a hospedagem
  dura, em todo lugar em que uma sessão é serializada (`GET /api/state`,
  `session.created`, `session.updated`).
- **A UI inteira lê a hospedeira como agente**: rótulo `claude` e anel de estado
  na linha da sidebar e no cabeçalho do painel, `detail` **"no shell"** quando
  não há nada acontecendo, tooltip "Claude Code aberto dentro deste shell", os
  contadores do rodapé ("1 rodando", "1 pedem input"), o painel de notificações
  e a pergunta de fechar painel ("Fechar este painel encerra a sessão claude.
  Continuar?").
- **Configurações → Sessões: "Reconhecer o Claude Code aberto dentro de um
  shell"** (`sessions.hostedAgents`, **ligada** por padrão), com a nota
  explicando o que a sessão ganha e o que ela continua sendo.
- **Cenário 12 do e2e**: com um `claude` falso no PATH, um `claude --version`
  digitado no PTY prova nas linhas do xterm que o argv chegou ao alvo com o
  `--settings` da sessão; depois os hooks entram pela rota real e a linha faz o
  caminho inteiro `shell` → `claude` (`running`, `done`) → `shell`, com o
  `active` do `GET /api/launcher` indo de 1 a 0 e o shell respondendo a um
  `echo` no fim.

### Alterado

- **`kind` NUNCA muda.** Uma sessão hospedeira nasceu `shell` e continua
  `shell`; `agent` continua ausente. Quem diz qual agente está lá dentro é o
  `hosted.agent`, e a regra de leitura em toda a tela passou a ser
  `hosted?.agent ?? agent`. É por isso que **restaurar um painel hospedeiro
  reabre um shell puro**, sem retomar a conversa. Num painel que JÁ TEVE uma sessão de agente antes, porém, o
  botão **"Reabrir com contexto"** passa a alcançá-la: o
  `POST /api/panes/:id/resume` ignora o `lastKind` de propósito e retoma o
  `lastAgentSessionId` que o painel guardou — que agora pode ser o de um Claude
  aberto dentro do shell. Num painel que só teve shell, a rota continua
  respondendo `422 nothing-to-resume`.
- **A hospedeira conta no teto de `sessions.maxConcurrentAgents` e nunca entra
  na fila.** Ela é um Claude Code de verdade consumindo um slot
  (`liveAgentCount()` a soma), mas não foi o Bridge que a lançou — enfileirar
  depois do fato não faria sentido. Efeito colateral honesto: com o teto em 1 e
  uma hospedeira de pé, todo `POST /api/sessions` de agente vai pra fila.
- **O `claude.cmd` é ASCII puro, de propósito.** O cmd.exe lê arquivo de lote na
  **codepage OEM do console** (437/850), não em UTF-8: um `C:\Users\João\...`
  gravado no corpo do wrapper chegava ao claude como `C:\Users\Jo├úo\...` —
  "Settings file not found", medido. Então o alvo viaja no AMBIENTE
  (`BRIDGE_CLAUDE_BIN`, que é UTF-16 do processo pai até o filho) e o settings
  vem do `%~dp0`, o caminho do próprio wrapper, que o cmd expande a partir do
  disco. O wrapper do Git Bash continua com caminho literal — ali o acento
  atravessa —, com os dois caminhos citados em aspas simples.
- **No WSL o `PATH` é montado na LINHA do `exec` do login shell**
  (`PATH='<bin>':$PATH exec "${SHELL:-/bin/sh}" -l`), e o wrapper da distro
  remove **todas** as ocorrências do próprio bin antes de chamar o `claude` de
  lá — entrada por entrada, por comparação literal, com o glob desligado. Não é
  preciosismo: a linha do `sh -lc` roda ANTES do `~/.profile`, que no Ubuntu faz
  `PATH="$HOME/.local/bin:$PATH"`, e um corte que só pegasse a primeira
  ocorrência deixaria o `exec claude` reencontrar o wrapper — laço infinito.
  **Limite declarado:** um perfil de login que ZERA o `PATH` (em vez de
  acrescentar) desliga o recurso; o wrapper continua no disco, o login shell é
  que já não o enxerga.
- **O interruptor vale pro PRÓXIMO shell.** Ligar ou desligar
  `sessions.hostedAgents` não interrompe uma hospedagem em curso: ela termina
  sozinha no `SessionEnd`. (Desligar no meio prendia a hospedagem, e isso foi
  corrigido antes de a versão sair.)
- **Não há heartbeat.** Um Claude morto com `taskkill`, sem `SessionEnd`, deixa
  a sessão marcada como hospedeira até o shell fechar — ocupando um slot do
  teto. Está no `SECURITY.md` (risco 20).
- **`resolveClaudeBin()` tem cache por processo do core.** Instalar o Claude
  Code com o Bridge aberto não faz os shells novos ganharem wrapper: é preciso
  reiniciar o core (fechar e reabrir o app). Sem claude na máquina, nada
  acontece — nenhum arquivo, nenhum PATH mexido.
- **A guarda de escopo passou a valer pro `claude` que você digita no shell** —
  e isso MUDA o que acontecia na 0.11.x. Num workspace de tarefa (worktree) ou
  de repositório, a raiz permitida é a do WORKSPACE, não a pasta em que você
  está: um `cd ..\outro-repo` seguido de `claude` dava, até a 0.11.2, um agente
  sem cerca nenhuma — e agora os `Read`/`Edit` daquele outro repositório saem
  **negados**, com o selo 🛡 na linha e o caminho barrado no painel. É o preço
  de a sessão passar a ser reconhecida: ela ganhou anel, notificação e registro
  de uso pela mesma porta por onde a guarda entra. Quando o acesso de fora for
  legítimo, a saída é a que já existia: **"Permitir acesso fora do worktree"**
  no menu **"⋯"** do workspace — ou desligar **Configurações → Sessões →
  "Reconhecer o Claude Code aberto dentro de um shell"**, que devolve o
  comportamento da 0.11.x no próximo shell. O caminho RELATIVO resolve contra o
  `cwd` do PAYLOAD do hook (você pode ter dado `cd` antes de abrir o Claude); a
  raiz permitida continua vindo só do workspace — ver `SECURITY.md`.
- **Um `claude` aberto DENTRO da hospedeira não é reinjetado.** O bin da sessão
  fica na frente do `PATH` do PTY e de todo descendente — inclusive da
  ferramenta `Bash` do próprio Claude hospedado. Sem guarda, um `claude -p …`
  disparado lá de dentro resolvia o wrapper, subia com o MESMO `settings.json`
  (mesmo `BRIDGE_SESSION`) e reportava na sessão do hospedeiro: o `Stop` do
  filho marcava "done" com o Claude de verdade ainda trabalhando, e o
  `SessionEnd` dele desospedava o painel inteiro. Agora os três wrappers checam
  o `CLAUDECODE` — a variável que só existe dentro de um Claude Code, e que o
  Bridge tira do ambiente de todo PTY que abre — e, quando ela está definida,
  chamam o claude real **sem** `--settings`, repassando o código de saída. O
  sub-Claude roda igual; ele é que não fala mais pelo pai.
- **Painel com hospedeira não é trocado por baixo.** O `bridge resume` e o
  "Reabrir com contexto" (`POST /api/panes/:id/resume`) decidiam olhando só
  `kind === 'agent'` e matavam o shell — junto com o Claude Code que trabalhava
  dentro dele. Agora uma sessão com `hosted` responde **409 `pane-busy`**, e o
  `replaceLiveShell` do core recusa pelo mesmo critério que a UI já usava pra
  perguntar antes de fechar o painel. Depois do `SessionEnd`, com o shell de
  volta a ser só shell, o resume funciona como sempre funcionou.
- **Nenhum atalho novo.** Nada foi adicionado, trocado ou removido do teclado.

### Notas

- **Nenhuma dependência nova**, nada baixado.
- Dois acertos de última hora, na mesma fix wave: o `detail` de ferramenta que
  a sidebar e o `bridge list` mostram passou a sair por `sanitizeDisplay` (o
  `tool_input` é escolhido pelo modelo, e um `ESC]0;…` chegava cru ao terminal
  do dono), e um hook atrasado numa sessão de shell **já encerrada** não promove
  mais nada — antes ele marcava como hospedeira uma sessão morta, que seguia
  ocupando um slot do teto.
- Um wrapper de código do core foi endurecido junto: os dois caminhos do
  wrapper do Git Bash passaram a ser citados com `shQuote` (aspas simples), como
  os do WSL já eram — um `$` ou uma crase no caminho do perfil expandiriam
  dentro de aspas duplas. Coberto por teste de texto e por execução real do
  wrapper no `sh` do Git, numa pasta com `$` e aspas simples no nome.
- **Testes**: core 1 041 passando e 3 pulados (55 arquivos), ui 728 (22), shell
  148 (10), shared 73 (6), cli 69 (3) — **2 059 passando**. O e2e do app real
  passou **12/12**.
- SHA-256 de `Bridge Setup 0.12.0.exe` (120 075 433 bytes):
  `63e78dc4be292b41f1f1dcdbb2479ad9fa0062016e98bf1adeb8930be414e28b`

## [0.11.2] — 2026-09-07 — barra de atalhos mais limpa

### Alterado

- **A barra de abas mostra o nome da ação, não a combinação.** Eram cinco dicas
  com os `<kbd>` de cada uma (`Ctrl Shift D divide`, `Alt ← → navega`,
  `Ctrl Shift Y uso`, `Ctrl Shift X fecha painel`), e
  juntas elas tomavam a barra inteira — "ficou muito poluído", nas palavras do
  dono. Agora se lê **divide**, **← →** com o verbo *navega*,
  **uso** e **fecha painel**; cada um continua sendo o botão da ação que
  anuncia, e o clique dispara exatamente o que a tecla dispararia. A combinação
  não sumiu: ela está no tooltip de cada botão ("Fechar painel (Ctrl+Shift+X)"),
  lida do `keybindings.json` em vigor como antes — rebindar continua mudando o
  que o Bridge diz —, e na tabela de **Configurações → Atalhos**, que não mudou.
  O painel vazio perdeu, pela mesma razão, as duas linhas de tecla acima dos
  botões ("Enter abre um shell aqui", "Ctrl Shift C abre o Claude Code"): elas
  repetiam em `<kbd>` o que os botões logo abaixo já dizem por nome, e o atalho
  de cada um segue no tooltip dele. Nenhuma tecla foi trocada, adicionada ou
  removida.

### Notas

- **Nenhuma dependência nova**, nenhuma rota tocada, nada no core.
- **Testes**: `@bridge/ui` 694 passando (21 arquivos) e `@bridge/shared` 72 (6).
  O e2e do app real passou **11/11**, sem mudança de seletor — nenhum cenário
  clicava nos `<kbd>` da barra.
- SHA-256 de `Bridge Setup 0.11.2.exe` (120 064 977 bytes):
  `199189638fdd3fb61a5e42369879a5d9f9c31421501124cb3149ecda4bab71fc`

## [0.11.1] — 2026-09-07 — copiar e colar no terminal

Correção de uma coisa básica que nunca funcionou: copiar uma URL fora do Bridge
e colar no terminal do Claude Code com `Ctrl+V` não fazia nada.

### Corrigido

- **`Ctrl+V` cola no terminal.** O xterm 5.5 transforma `Ctrl`+letra em byte de
  controle e **cancela** o `keydown`: `Ctrl+V` virava `^V` (0x16) mandado pro
  PTY, e a colagem nativa do Chromium nunca chegava a acontecer. O Bridge, do
  lado dele, nunca tinha ligado o clipboard no terminal — o `Terminal.tsx` não
  tinha `attachCustomKeyEventHandler`, nem `term.paste`, nem `contextmenu`. O
  que funcionava era `Shift+Insert` (por uma exceção do próprio xterm), que
  ninguém usa. Agora **`Ctrl+V`, `Ctrl+Shift+V` e `Shift+Insert`** colam, pela
  convenção do Windows Terminal e do terminal do VS Code. A colagem vai por
  `term.paste`, que embrulha o texto em *bracketed paste* quando a aplicação
  ligou o modo 2004 — o Claude Code liga, então colar várias linhas continua
  sendo **uma** entrada em vez de virar N Enters.
- **`Ctrl+C` com seleção copia** (e desmarca a seleção). **Sem** seleção ele
  continua sendo `^C`/SIGINT — é pra isso que ele serve num terminal, e trocar
  isso incondicionalmente tiraria a única forma de interromper um comando.
  `Ctrl+Insert` também copia.
- **Botão direito no terminal**: com seleção copia, sem seleção cola. Não há
  menu de contexto, e a janela não tem menu de aplicação nenhum — era por isso
  que não sobrava nenhum outro caminho pro clipboard.

### Notas

- **`Ctrl+Shift+C` não mudou**: continua sendo "abrir Claude" (o atalho do app),
  remapeável em `keybindings.json`. E `Ctrl+Alt+V`/`Ctrl+Alt+C` seguem intactos
  pro terminal, porque no ABNT2 o `AltGr` chega como `Ctrl+Alt`.
- **Como o clipboard é lido**: `navigator.clipboard.readText()/writeText()`. A
  UI é servida em `http://127.0.0.1:<porta>`, que o Chromium trata como contexto
  seguro, e a sessão padrão da janela (que não tem handler de permissão) devolve
  `clipboard-read: granted`. Isso foi **medido** no Electron 44 desta build, não
  suposto. Se um Electron futuro apertar esse default, a colagem para de chamar
  `preventDefault()` a partir da primeira recusa e deixa o Chromium colar
  sozinho pelo caminho nativo — custa uma tecla e volta a funcionar.
- **Nenhuma dependência nova.**
- **Testes**: `@bridge/ui` 693 passando (21 arquivos, +22 do
  `terminal-clipboard.test.ts` novo), `@bridge/core` 969 (3 pulados, 53
  arquivos), `@bridge/shell` 148 (10), `@bridge/shared` 72 (6),
  `@bridge/cli` 69 (3) — **1 951 testes**. O e2e do app real
  passou **11/11**, com o cenário novo que cola com `Ctrl+V` num xterm de
  verdade, copia a linha selecionada com `Ctrl+C` e confere o clipboard **do
  processo main**, e faz os dois pelo botão direito.
- SHA-256 de `Bridge Setup 0.11.1.exe` (120 065 043 bytes):
  `f73ed1dda431c8e82767680b28dced11b73bc951e03e78e2e902a4de1b7fab90`

## [0.11.0] — 2026-09-07 — dores verificadas dos usuários do Claude Code

Esta versão não saiu de uma lista de ideias: saiu de uma pesquisa do autor sobre
o que as pessoas relatam em issues do `anthropics/claude-code`. De 25 alegações
levantadas, **6 sobreviveram à verificação adversarial** e **4 tinham evidência
primária** e aderência ao que o Bridge é — um app que roda vários Claude Code
lado a lado no Windows. São essas quatro, na ordem de volume × aderência:
o **limite do servidor** confundido com o limite de uso, o **ambiente errado**
no Windows/WSL, o **`--resume` que volta vazio** e a **falta de isolamento entre
worktrees irmãs**.

Três decisões atravessam a versão inteira e vale dizê-las em voz alta, porque
elas explicam o que o Bridge **não** faz aqui. Primeira: o Bridge não é dono do
estado do agente, então em nenhuma das quatro ele finge consertar o que é do
Claude Code — ele **mostra**, **espaça** e **cerca**. Segunda: falso positivo é
pior que detecção nenhuma em todas as quatro, porque um aviso que erra ensina
você a ignorá-lo — daí o detector exigir a frase inteira, o veredito de resume
não ser chutado quando o payload é mudo e a guarda de escopo não julgar comando
de shell. Terceira: nenhuma dependência nova entrou.

### Adicionado

**O limite do SERVIDOR, separado do seu limite de uso (dor #1).** São coisas
diferentes e o terminal chama as duas de "limite": o de **uso** é da sua conta
(5 h / semana), escala com o plano e reseta numa hora conhecida; o do
**servidor** (`Server is temporarily limiting requests (not your usage limit)`,
`API Error: 529`, `overloaded_error`) é da infraestrutura compartilhada, **não
escala com plano nenhum** e some sozinho em minutos. Quem não distingue os dois
vai mexer no plano por um problema que não é dele. O Bridge agora lê a saída do
PTY por uma janela rolante de 4 KB por sessão (ANSI removido) e, casando uma das
quatro frases, marca a sessão como `server-limited`: anel e selo **laranja**
`⏳ servidor` na linha, com a frase lida no tooltip como prova. O limite de USO
em 100 % ganhou selo próprio, **vermelho**, com o horário do reset. O estado sai
no primeiro `Stop`/`UserPromptSubmit` seguinte ou em 5 minutos. O casamento
exige a frase INTEIRA do Claude Code (ou um token que só existe no corpo do erro
da API): `// TODO: tratar rate limit` num diff, `if (err.status === 529)` num
arquivo aberto e um `HTTP 429` não disparam nada, e há um teste por linha dessas.

**Escalonador de lançamentos** (`sessions.scheduleLaunches`, ligado por padrão).
Em cima da detecção veio a única alavanca que o Bridge tem sobre a CAUSA — a
rajada de agentes subindo juntos, que é exatamente o que a restauração de um
workspace com vários painéis fazia: teto de `sessions.maxConcurrentAgents`
agentes vivos (padrão **4**; além dele o `POST /api/sessions` responde
**`202 { queued: true, position }`** em vez de `201`), **jitter de 300–900 ms**
entre lançamentos de uma rajada e **backoff de 5 s a 60 s** enquanto alguma
sessão estiver estrangulada. A sidebar mostra `N sessões aguardando slot` com o
botão **Lançar agora**. Ele nunca mata nem pausa sessão viva, e `POST
/api/panes/:id/resume` e o agente que nasce com uma tarefa **não** passam pela
fila — são um clique deliberado numa sessão só. Rotas: `GET /api/launcher`,
`POST /api/launcher/launch-now`, `DELETE /api/launcher/pending/:id`, evento
`launcher.changed`, e **429 `queue-full`** acima de 64 pendentes.

**Ambiente da sessão por workspace (dor #2)** — `pwsh`, Windows PowerShell, Git
Bash ou uma distro **WSL**, escolhido no diálogo de novo workspace, no menu "⋯"
ou por `bridge new --env wsl:Ubuntu`. É propriedade do **workspace**, não da
configuração global: a mesma máquina tem um repositório que só compila numa
distro e outro que só roda em `pwsh`. Com `{ kind: 'wsl', distro }` o shell **e**
o Claude Code sobem dentro da distro, por login shell, com o `cwd` e o
`--settings` traduzidos por `wslpath -a` (a dor relatada é justamente a pasta com
acento ou o caminho de rede que "funciona por acaso" e falha calado). A troca
vale da **próxima** sessão: derrubar um PTY vivo por uma escolha de menu jogaria
fora o trabalho que está lá dentro. `GET /api/environments` lista o que a
máquina tem, com "tem `claude`?", "tem `node`?" e "o interop está ligado?" por
ambiente, e a linha do workspace ganha o selo `wsl:<distro>` / `gitbash` mais os
avisos **⚠ sem claude** e **⚠ ambiente sumiu**.

**Os hooks de uma sessão em WSL rodam pelo Node do WINDOWS, por interop**
([ADR-013](docs/adr/013-hooks-de-wsl-pelo-node-do-windows.md)) — nunca pelo
`node` da distro, mesmo quando ela tem um. O motivo é medido, não estético: no
modo de rede padrão do WSL2 (NAT) **o loopback não é compartilhado**, e de dentro
da distro `127.0.0.1` é a própria distro — o POST do shim não chegaria em core
nenhum, e a sessão ficaria em "ociosa" pra sempre, sem erro. Executado pelo
`node.exe`, o shim é um processo do Windows e o loopback dele é o do host. Por
isso o caminho do shim viaja em forma de Windows (o interop repassa o argv sem
tradução) e `BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_SESSION` e `BRIDGE_SHIM`
atravessam pela `WSLENV`.

**Detecção do `--resume` que volta vazio, e o "Reabrir com contexto" (dor #3).**
`claude --resume <id>` às vezes sobe sem erro nenhum e abre uma conversa **nova**
— você só descobre quando pergunta algo que dependia do que já tinha sido dito.
O Bridge julga no primeiro `SessionStart`: `session_id` diferente do pedido, ou
`source` que não é `resume`, vira `Session.resumeOutcome = 'fresh'` e o painel
mostra a faixa *"A conversa anterior não foi retomada (o Claude abriu uma sessão
nova)"* com **Reabrir com contexto** e **Ignorar**. Payload sem id **e** sem
`source` não vira veredito nenhum. O botão chama `POST
/api/sessions/:id/recap`, que lê o transcript ANTIGO pela cauda (2 MiB) e monta
um resumo **determinístico — nenhum modelo é chamado**: o último pedido seu e as
três últimas respostas de texto do agente, sem `tool_use`/`tool_result`/
subagente, 600 caracteres por trecho, 2 500 no total, tudo por `sanitizeDisplay`
e em **uma linha só** (uma quebra de linha ali seria um Enter no meio do resumo).
**Isso não é o contexto de volta**, e a faixa não promete isso: é o suficiente
pra o agente novo saber de que assunto vocês estavam falando.
`sessions.autoRecap` faz a injeção sem clique e nasce **desligada** — escrever no
prompt do agente é a única coisa aqui que mexeria no seu terminal por conta
própria. As três falhas legítimas são `no-resume` (422),
`transcript-not-found` (404) e `recap-empty` (422).

**Guarda de escopo entre worktrees (dor #4).** Duas tarefas do mesmo repositório
rodam em `.worktrees/a` e `.worktrees/b`, e o `cwd` de um processo é uma
sugestão, não uma cerca: nada impedia o Claude da tarefa A de abrir — e
reescrever — um arquivo de B por caminho absoluto. O `PreToolUse` é o único hook
do Claude Code que aceita decisão de permissão na resposta, e é ali que o Bridge
decide: `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep` e
`LS` têm o `file_path`/`notebook_path`/`path` resolvido contra o `cwd` da sessão
(com `..`, barras misturadas e symlink/junction desfeitos por `realpath`) e
comparado com a raiz permitida. **A raiz depende do tipo de workspace**: o
worktree, numa tarefa; o **repositório inteiro**, num workspace de repo (quem
abre o repo na raiz está trabalhando no repo, e cercá-lo no `cwd` de um painel
seria uma cerca que ninguém pediu); o `cwd`, fora de repositório. Fora dela a
resposta é `permissionDecision: "deny"` com a razão escrita **pro agente ler** —
ela nomeia o item de menu exato que libera, porque é o agente quem vai repeti-la
pra você. Cada recusa acende o selo **🛡 N** na linha da sessão, com os cinco
últimos caminhos no tooltip. Liga e desliga: `sessions.scopeGuard`
(Configurações → Sessões, **ligado** por padrão) é o interruptor geral;
`PATCH /api/workspaces/:id { crossAccess }`, pelo menu "⋯", libera **um**
workspace e vale no `PreToolUse` seguinte, sem reabrir sessão.

**O que a guarda NÃO cobre, de propósito:** o **`Bash`** e o `pattern` do
`Glob`/`Grep`. Um comando de shell declara texto, não caminho, e o alvo real
depende do `cwd`, do `PATH`, de variáveis e do próprio shell — julgar caminho
dentro de string erraria por falso positivo (`--exclude=../x`) e por falso
negativo (`powershell -EncodedCommand`) ao mesmo tempo, e uma guarda que erra dos
dois lados ensina você a desligá-la; o `pattern` é padrão de busca, e o resultado
dele já é filtrado pelo `path`. E a liberação por workspace (`crossAccess`) é
**total**: ligada, as sessões daquele workspace voltam a poder ler e escrever em
qualquer lugar do disco, não só no worktree do lado. Isso está no
[`SECURITY.md`](SECURITY.md) (risco aceito 17) — a guarda é contra **erro do
agente** e **repositório hostil** (A4), nunca contra você (A3), e não deve ser
descrita como "isolamento".

### Alterado

- `SessionState` ganhou **`server-limited`**, e a severidade foi renumerada:
  `stuck > needs-input > server-limited > done > running > idle > exited`.
- `POST /api/sessions` de agente passou a ter **dois** códigos de sucesso (201 e
  202). `404 pane-not-found` e `409 pane-busy` continuam **imediatos**: são
  validados antes de enfileirar, porque um 202 pra um painel que não existe seria
  uma promessa que a fila não tem como cumprir.
- `session.state` carrega `serverLimit` (substituído, nunca mesclado: evento sem
  o campo = a sessão saiu do estado) e `session.updated` passou a levar
  `resumeOutcome` e `scopeBlocks`. Toda sessão agora emite um `session.updated` a
  mais, no primeiro byte do PTY — é o portão que impede a injeção automática do
  resumo de escrever antes de a TUI do agente aceitar texto.
- `USAGE_LIMIT_REACHED_PCT` (100 %) entrou no `@bridge/shared`: o limiar do
  limite de USO é política compartilhada, mas o selo continua sendo montado
  **só na UI** (`usageLimitBadge`). `GET /api/usage/limits` não ganhou campo
  novo.
- `config.json` ganhou o objeto `sessions`
  (`maxConcurrentAgents: 4`, `scheduleLaunches: true`, `autoRecap: false`,
  `scopeGuard: true`), mesclado chave a chave como os outros, e uma seção
  **Sessões** nas Configurações.
- Colunas novas em `workspaces` (`environment_json`, `cross_access`), com
  migração idempotente: um perfil de 0.10.x abre normalmente.
- `bridge new` aceita `--env pwsh | powershell | gitbash | wsl:<distro> | padrao`
  e sabe imprimir o `202` do escalonador (`Sessão enfileirada (posição N)`) sem
  chamar de "criada" uma sessão que não existe.

### Corrigido

- **A restauração de painéis não sobe mais todos os agentes no mesmo instante** —
  ela é a rajada mais fácil de provocar, e agora passa pelo espaçamento como
  qualquer outro lançamento.
- **O teto de concorrência não é furável pela rajada.** O escalonador reserva o
  slot no DESPACHO, não quando a sessão existe: entre uma coisa e outra corre o
  `claude --version`, e oito pedidos com teto 4 passavam todos pela verificação
  antes de o primeiro virar sessão.
- **Um `SessionStart` mudo não deixa mais o `/clear` seguinte virar alarme
  falso.** A janela do julgamento fecha no primeiro `SessionStart`, mesmo quando
  ele não produz veredito — antes a trava era o veredito já gravado, e um
  `/clear` do próprio dono (`source: 'clear'`) acendia a faixa "o resume falhou".
- **A guarda de escopo não é mais enganada por um reparse point ilegível.** A
  resolução de caminho só "sobe" um nível quando o erro é `ENOENT`/`ENOTDIR` (o
  arquivo que ainda não existe); qualquer outro erro — `EPERM` numa junction com
  ACL negando leitura — passou a contar como **fora** (fail-closed). Antes o nome
  do segmento era reatado como texto e a comparação de prefixo dizia "dentro".
- **A razão do `deny` nomeia um item de menu que existe.** Ela citava "⋯ →
  Acesso cruzado", que o menu nunca desenhou; agora diz "Permitir acesso fora do
  worktree" / "…do repositório", conforme a raiz. Quem lê essa frase é o agente,
  e é ele quem a repete pra você.
- **`bridge new --env` e o diálogo de novo workspace tratam o `202`** em vez de
  lê-lo como uma sessão criada.

### Notas

- **Nenhuma dependência nova.** As quatro dores foram fechadas com o que já
  estava no lockfile.
- **Testes**: `@bridge/core` 966 passando (3 pulados, 53 arquivos),
  `@bridge/ui` 669 (20), `@bridge/shell` 148 (10), `@bridge/shared` 72 (6),
  `@bridge/cli` 69 (3) — **1 924 testes**. O e2e do app real
  (`npm run e2e`, Electron + core + PTY de verdade) passou **10/10**, com dois
  cenários novos: o `PreToolUse` que volta `deny` pelo shim com o selo 🛡 na
  sidebar, e a fila do escalonador (202 → "Lançar agora" → a sessão nasce).
- **A execução real em WSL não foi verificada**: a máquina de construção não tem
  distro (`wsl -l -q` volta vazio). Toda a cadeia está sob teste contra um
  `wsl.exe` simulado, e a verificação manual está registrada no
  README.
- SHA-256 de `Bridge Setup 0.11.0.exe` (120 064 606 bytes):
  `a3a4aa65f4953de2fad31514f46805354827073d15130645b49c7f8e04ad7e29`

## [0.10.1] — 2026-09-06 — segurança do monitor de uso

Fase de segurança sobre o que a 0.10.0 trouxe (o monitor de uso) e sobre as
superfícies novas desde a 0.8.0: auditoria somente-leitura, onda de correção
com **um teste de ataque por achado** e re-review adversarial por um revisor
diferente. Foram **18 achados — 0 críticos, 4 altos, 6 médios, 8 baixos** —,
todos fechados. O modelo de ameaça
atualizado (com o atacante novo, **A6 — transcrição hostil**) está no
`SECURITY.md`.

O que a auditoria mostrou, e que vale dizer em voz alta: o monitor de uso é a
**única** superfície do Bridge que trabalha sozinha, a cada 60 s, em cima de
conteúdo que você não digitou. Um `.jsonl` sob `<claudeHome>\projects` pode ter
sido escrito por outro processo seu, por um agente rodando dentro de uma
sessão, ou restaurado de um backup.

### Corrigido

**Integridade da contagem (BU-01, BU-02, BU-08, BU-17).** Uma linha de
transcrição maior que a fatia de leitura travava aquele arquivo **para sempre**:
o offset não avançava, a passada seguinte relia os mesmos bytes, e todo o
consumo depois dela sumia em silêncio — o "Reler transcrições" caía no mesmo
laço. Agora linha acima de 4 MiB é **pulada e contada**, e o offset sempre anda.
Um modelo chamado `constructor` achava "preço" na cadeia de protótipos e
transformava o custo do recorte inteiro em `NaN` (o painel dizia "nenhum modelo
tem preço" enquanto o gasto acontecia): a tabela de preços passou a ser
`Object.create(null)` e toda consulta usa `Object.hasOwn`. Contador de token
fora de `[0, 1e12]` conta zero (um par `{-1e12, +1e12+5}` atravessava o único
filtro que existia e **comia** o consumo real dos outros baldes do dia), e
carimbo de tempo fora de `[2020-01-01, hoje + 2 dias]` descarta a linha — o ano
275760 criava uma linha imortal no banco.

**Leitura de arquivo pelo `usage.pricingFile` (BU-03).** O campo lia **qualquer**
arquivo, devolvia pedaço do conteúdo no aviso (as chaves de topo de um JSON, os
~10 primeiros caracteres de um texto) e bloqueava o event loop por **1 069 ms**
com um arquivo de 200 MB — tudo isso repetido em toda subida do core, porque o
caminho fica no `config.json`. Agora exige extensão `.json`, caminho absoluto,
arquivo regular e no máximo 1 MiB (conferidos **antes** de ler), e qualquer
falha vira um aviso genérico: sem trecho de conteúdo, sem nome de chave e sem o
caminho, em nenhum lugar — nem na resposta, nem na tela, nem no `core.log`.

**Texto hostil chegando ao seu terminal (BU-04, BU-09, BU-13, BU-16).** A
statusline que o Bridge devolve ao Claude Code repassava `ESC`/`BEL` do payload
do hook: sequestro do título da janela, cor, piscar, apagar tela — e uma ponte
até o próprio scanner de OSC do Bridge, que vira notificação do Windows. O
`bridge usage` imprimia `cwd` e `model` crus. Entrou um sanitizador **único**,
`sanitizeDisplay` em `@bridge/shared`, usado pelas três pontas de tela
(statusline, saída humana da CLI, `title`/`aria-label` do painel): ele remove
sequências de escape inteiras, C0/C1, DEL e os caracteres de **formato
invisíveis** do Trojan Source (`U+202E` e os outros bidi, os de largura zero, o
BOM), colapsa espaço e corta no teto do campo. O `--json` da CLI e o corpo da
API continuam crus de propósito: são dado, não tela. Ecos de `repoId`, `?tz=` e
de ação desconhecida do `keybindings.json` também saem limpos e cortados.

**Disponibilidade (BU-05, BU-07, BU-11, BU-14).** A **listagem** da árvore de
transcrições era síncrona e parava o core por **3,78 s** numa árvore de 50 000
arquivos — a cada passada do poller, sem atacante nenhum; virou assíncrona,
cedendo o event loop a cada 500 entradas ou 5 ms (maior pausa medida numa
árvore de 20 000 arquivos: **3 a 16 ms**), com teto de 50 000 arquivos e aviso.
`POST /api/usage/rescan` ganhou **409** com uma releitura em voo e **429** dentro
de 30 s da última — o custo dele é proporcional ao seu histórico inteiro, não ao
pedido. `byModel`/`byProject` saem com no máximo 200 baldes mais uma linha
`(outros)` somada (20 000 projetos davam 4,17 MB de JSON por pedido), e o evento
`usage.changed { limits }` ganhou o mesmo teto de 1/s que o progresso já tinha,
com a última foto sempre entregue.

**Payload de statusline com tetos (BU-06, BU-12).** No máximo 16 janelas de
`rate_limits` (5 000 viravam uma statusline de 153 KB devolvida ao seu terminal
a cada redesenho; 40 000 estouravam o limite de variáveis do SQLite e viravam
**500** na rota do hook), chave de janela limpa e cortada em 64 caracteres, e
`resets_at` só dentro de ±10 anos — um carimbo absurdo imprimia literalmente
`reseta undefined`.

**Configuração (BU-10, BU-15).** O teto de 200 modelos em `usage.pricing` que a
documentação prometia agora é imposto — pela API e pelo `config.json`. O campo
`cacheWrite1h`, documentado e suportado pelo cálculo, não estava declarado no
schema e era **removido em silêncio**: quem ajustasse o preço da escrita de 1 h
recebia `200` e nada acontecia. `PATCH /api/repos/:id` e `POST /api/sessions`
passaram a recusar campo desconhecido em vez de engoli-lo.

**Privacidade, por escrito (BU-18).** O `SECURITY.md` dizia o que o monitor
**não** guarda; agora diz também o que ele **guarda**: `usage_daily.project`
tem o `cwd` de cada linha e `usage_files.path` o caminho de cada transcrição,
os dois em `%APPDATA%\bridge\bridge.db`, e o `core.log` recebe caminhos nos
avisos. Caminho de projeto é dado pessoal, e apagar tem receita.

### Adicionado

- **`sanitizeDisplay`/`isDisplaySafe`** em `@bridge/shared` — a regra única de
  "texto de fora indo pra tela", com teste contra as cargas da auditoria.
- **`skippedLines` e `capped` visíveis.** Quando a varredura pula linha por
  tamanho, ou corta a lista no teto de arquivos, o painel "Uso", o
  **Configurações → Uso** e o `bridge usage` escrevem quantas foram e avisam
  que o número mostrado é **menor** que o consumo real. Uma contagem menor que
  a real apresentada como total é o defeito do BU-01 de novo, só que educado.
- Coluna `usage_files.skipped_lines` (migração automática: as tabelas de uso
  são derivadas e se reconstroem sozinhas).

### Notas

- A varredura desiste na entrada seguinte quando o core está encerrando: sem
  isso, tornar a listagem assíncrona estourava o orçamento de 1 500 ms do
  encerramento gracioso numa árvore grande e deixava o `instance.json` pra
  trás. Foi o e2e que pegou.
- Clicar **Reler transcrições** duas vezes dentro de 30 s agora mostra a frase
  de carência em vez de reler. É a única mudança de comportamento visível.
- Nenhuma dependência nova entrou (`npm audit`: **0 vulnerabilidades**).

## [0.10.0] — 2026-09-06 — monitor de uso nativo

A integração com a ferramenta externa de cota saiu do repositório e no lugar
dela o Bridge ganhou um monitor de uso próprio: limites vivos de 5 h e da
semana, consumo diário/semanal/mensal em tokens e custo estimado, um painel
com dashboard (`Ctrl+Shift+Y`), a statusline montada pelo próprio Bridge e o
comando `bridge usage`. Decisões do dono: o dia começa à **meia-noite local**,
o **custo aparece**, e o painel é um dashboard ("não tem isso no cmux"). A decisão está
em
[ADR-012](docs/adr/012-monitor-de-uso-nativo.md), que **substitui a ADR-008**.

### Adicionado

**Monitor de uso no core** (`packages/core/src/usage/`) — varredura incremental
das transcrições que o Claude Code grava em `<claudeHome>\projects`, somando
tokens por dia × modelo × projeto × origem. Ela é **recursiva**: além da
conversa principal, conta os `*.jsonl` de **subagente** aninhados sob a pasta
da sessão. Isso não é um detalhe — numa amostra de 400 transcrições da máquina
do autor, **62,8 % dos tokens vinham de subagentes**, e a primeira versão do
módulo não os enxergava. Os dois lados sempre entram no total; `bySource`
existe pra o painel poder dizer "inclui subagentes", nunca pra esconder metade
do consumo atrás de um filtro.

A leitura é **assíncrona e em fatias de 256 KB**, cedendo o event loop entre
elas (maior trecho síncrono medido: **8,3 ms**, contra um alvo de 20 ms): o
core hospeda todos os PTYs, e um `readSync` de megabytes seguraria os
terminais de quem está trabalhando. Cada arquivo é lido a partir do offset
gravado, a linha parcial do fim fica pra próxima passada, e o dedupe é por
`message.id:requestId`.

**Painel "Uso"** (`Ctrl+Shift+Y`, a dica **uso** na barra de abas, ou "Uso…" no
menu "⋯" da sidebar). Na ordem da pergunta: os medidores de limite (posso
continuar agora?) → os cartões de total → o gráfico dos últimos 30 dias → as
tabelas por modelo e por projeto → o que é estimativa. Recorte `dia | semana |
mês`. Estado vazio com a pasta que está sendo lida e um único CTA.

**Bloco de limites na sidebar** — uma vez só, logo abaixo do cabeçalho, porque
os limites são da **conta** e não do workspace: repetir a mesma barra de 5 h em
cada workspace expandido diria três vezes a mesma coisa, e a leitura errada
seria "cada projeto tem a cota dele". Dentro do workspace expandido ficou a
linha da sessão: `70k ctx · Fable 5.1 · US$ 0,74`.

**Configurações → Uso** — mostrar o custo estimado, arquivo de preços, o botão
"Reler transcrições" (com progresso e o resultado `{ arquivos, mensagens,
dias }`) e a lista dos modelos que a tabela em vigor não cobre, com o exemplo
do JSON esperado.

**`bridge usage [--range dia|semana|mes] [--json]`** e **`bridge usage
--rescan`** — o mesmo relatório em tabela de texto: totais, por modelo, os 5
maiores projetos (o resto vira `outros (N projetos)`, somado e não escondido),
as janelas de limite, a data da tabela de preços e a linha "inclui
subagentes". Ele usa a MESMA rota da tela, então não existe chance de o número
do terminal divergir do número do painel.

**Rotas e evento** — `GET /api/usage?range=day|week|month`,
`GET /api/usage/limits`, `POST /api/usage/rescan` e o evento `usage.changed`,
que carrega as janelas, os dias tocados pela última varredura e o **progresso
da varredura** (no máximo um por segundo, sempre no começo e no fim).

**Progresso de varredura** — `GET /api/usage` devolve `scanning: { active,
filesDone, filesTotal, bytesDone, bytesTotal } | null`. A primeira leitura de
um histórico grande leva minutos (8.431 transcrições e 12,8 GB nesta máquina),
e até aqui o painel afirmava "nenhuma transcrição encontrada" o tempo todo em
que estava, na verdade, lendo — uma frase falsa que manda a pessoa procurar um
defeito inexistente. Agora ele diz "ainda lendo as transcrições (N de M
arquivos)".

**`role="meter"` nos medidores de limite** (painel e sidebar), com
`aria-valuenow/min/max` além do rótulo. Eram `role="img"`: uma figura com
legenda, que quem navega por medidores não encontrava.

**Formatação compartilhada** — `formatUsd`/`formatTokens` em `@bridge/shared`,
usados pela statusline do core, pela UI e pela CLI. Quatro superfícies
escrevem os mesmos números, e cada uma com o seu `toFixed` significava `$0.74`
no terminal e `US$ 0,74` na tela.

### Alterado

**A statusline devolvida ao Claude Code é montada pelo Bridge**, em memória:
`87k ctx · Fable 5.1 · US$ 3,42 · 5h 23% (reseta em 2h15) · semana 68%
(reseta seg)`. Ordem fixa contexto → modelo → custo → janelas; campo ausente
some. **Nenhum processo filho** no caminho de uma linha que é redesenhada
várias vezes por segundo.

**Escrita de cache de 1 hora contada e cobrada à parte.** O payload traz
`cache_creation_input_tokens` como a SOMA das duas escritas, com o
detalhamento em `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. A
de 1 h custa **2 × input**; a de 5 min, 1,25 ×. Tratá-las como uma coluna só
subestimava a conta — **22,8 % dos tokens de escrita** da máquina do autor são
de 1 hora. Entrou a coluna `cache_write_1h` em `usage_daily`, o campo
`cacheWrite1h` nos totais e o preço `cacheWrite1h` em todos os modelos da
tabela; uma tabela de preços escrita à mão sem esse campo continua valendo,
caindo na regra oficial `2 × input`.

**Janela de limite que some de um payload não vazio agora é apagada.** O
`setLimits` só fazia upsert: se a conta perdesse o limite de `seven_day` e
mantivesse o de `five_hour`, o `seven_day` fossilizava no banco e
`GET /api/usage/limits` devolvia para sempre o percentual e o reset de uma
janela que já não existe.

**Carência de dez minutos antes de apagar TODAS as janelas.** Um payload sem
`rate_limits` é o sinal legítimo de "esta conta não tem limites" — mas com uma
sessão de assinatura e outra de chave de API abertas lado a lado, a segunda
apagava as janelas da primeira a cada statusline e a primeira as repunha: a
faixa piscava. Enquanto alguma sessão tiver reportado janelas nos últimos dez
minutos, o payload vazio não limpa nada.

**A busca de preço por modelo tem duas tentativas e nada mais**: o id exato e o
id sem o sufixo de data. O fallback por prefixo saiu — ele fazia
`claude-opus-4-8` herdar 15/75 de uma entrada `claude-opus` em vez de 5/25, ou
seja, três vezes o preço real apresentado com a mesma confiança de um número
certo.

**`POST /api/usage/rescan` emite `usage.changed` mesmo sem dia tocado**
(`rescanned: true`). Uma reconstrução que só REMOVE dias — transcrição apagada
por fora, preço corrigido pra menos — não toca dia nenhum, e o painel ficava
com os números velhos depois de um botão que diz ter relido tudo.

**`formatUsd` negativo põe o sinal antes da moeda** (`-US$ 0,01`): é como um
valor negativo se escreve em pt-BR, e `US$ -0,01` lê como se o símbolo fizesse
parte do número.

**`bridge` conhece um comando novo** e a ajuda o lista; a seção **Uso** entrou
no diálogo de configurações (oito seções agora).

### Removido

**A integração com a ferramenta externa de cota**, inteira:
`packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS` de
`quota.ts`, o cache de linha por sessão do adaptador, os campos
`quotaAdvisorPath`/`quotaAdvisorResolved` da configuração, a variável de
ambiente `BRIDGE_QUOTA_ADVISOR`, o campo somente-leitura do diálogo de
configurações e os dois processos falsos dos testes. Ela era **opcional** e o
dado sempre veio do payload do próprio Claude Code — o que ela fazia era
formatar. Num repositório público isso era uma dependência que ninguém tem,
uma fonte de verdade fora do repositório, e ainda assim sem a resposta que
faltava: quanto foi ontem, na semana, por projeto. Ver ADR-008 (substituída) e
ADR-012.

**`QuotaStrip` da sidebar** — virou `SidebarLimits` (o bloco da conta) mais
`SessionLine` (a linha da sessão).

### Privacidade

O monitor lê as transcrições **para contar**. O que sai da leitura são as
quatro contagens de token, o id do modelo, o `cwd` da linha e o carimbo de
tempo — conteúdo de mensagem não é extraído e portanto não pode ser gravado.
As três tabelas novas (`usage_files`, `usage_daily`, `usage_limits`) não têm
coluna de conteúdo, e nada sai da máquina: os preços são um arquivo do pacote,
não uma consulta. A raiz é `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` →
`~/.claude`, e `claudeHome` é somente leitura pela API. Ver `SECURITY.md`.

### Migração

As tabelas `usage_daily` e `usage_files` são **derivadas** — tudo nelas pode
ser recalculado relendo as transcrições. Um banco de uma versão anterior do
lote tem as duas derrubadas e recriadas na abertura, o que força uma varredura
completa: `source` e a escrita de 1 h entram na estrutura, o SQLite não altera
chave primária, e migrar contagens agregadas sem saber de qual arquivo cada
uma veio custaria correção. `usage_limits` não é tocada.

## [0.9.0] — 2026-09-05 — polimento

Fecha os resíduos de UI, core e docs que sobraram da fase de segurança e que
não dependiam de decisão do dono — nada de tema claro, nada de produto novo.
É a versão preparada pra ser a primeira release pública: o repositório público
virou o único repo vivo, e a árvore foi normalizada pra que o primeiro commit
não carregue o CRLF do disco de quem a montou.

### Adicionado

**`bridge watch`** — os eventos do `/ws` saindo no terminal, uma linha por
evento até `Ctrl+C`, com `--events` (os mesmos prefixos do `?events=` do
servidor) e `--json` (JSON-lines no stdout, saudação no stderr, pra `| jq`).
Até aqui só o processo main do Electron conseguia olhar o barramento: um
agente rodando dentro de um painel, ou o dono depurando um hook que não
dispara, não tinha como responder "o core está emitindo isso?" sem abrir a
janela. Sem dependência nova — o `WebSocket` é global no Node 22+, e o token
vai por `?token=` (ele não é impresso: a linha de status mostra só a porta).

**`problems` no `GET /api/keybindings`** — um campo IRMÃO das ações (não um
envelope, que quebraria todo cliente que lê a tabela crua) dizendo o que o core
achou de errado ao LER o `keybindings.json`: `json-invalido`, `nao-e-objeto`,
`acao-desconhecida`, `atalho-invalido`. Antes disso o arquivo quebrado sumia em
silêncio — o `warn` ia pro `core.log` e a rota respondia uma tabela
indistinguível de um arquivo impecável, com os atalhos de fábrica no lugar da
escolha do dono. A seção "Atalhos" do diálogo de configurações mostra esses
problemas na MESMA faixa amarela dos que a própria UI deduz da tabela
(combinação que o Bridge não sabe ler, duas ações na mesma tecla). Campo
ausente = arquivo impecável, ou perfil sem arquivo nenhum.

**Acessibilidade da sidebar** — cabeçalho de grupo, linha de workspace e linha
de sessão viraram controles de verdade: `role`, `tabIndex`, `aria-label` com
estado, contagem e foco (`"Sessão claude, travada, editando, em foco"`),
`aria-expanded` no workspace, `aria-current` na sessão, e navegação por ↑/↓
entre as linhas (sem dar a volta nas pontas, e sem sequestrar a seta quando o
foco está num menu aberto). O anel colorido, a faixa azul do foco e o contador
do grupo recolhido simplesmente não existiam pra quem usa leitor de tela. O
"✕" da sessão virou IRMÃO da área clicável, e não filho — botão dentro de
`role="button"` é conteúdo interativo aninhado, anunciado como um controle só.

**Dicas da barra de abas derivadas dos atalhos reais** — a legenda sai do
`Keybindings` em vigor, passando pelo MESMO parser que decide se a tecla casa:
rebindar no `keybindings.json` deixava a legenda mentindo. A dica `Alt ←→`
virou DUAS ações clicáveis (esquerda e direita) com o modificador comum
desenhado uma vez só — era um botão único que disparava sempre `pane.right`.

**`.gitattributes` com normalização de fim de linha** — `* text=auto eol=lf`,
`.cmd`/`.bat`/`.ps1`/`.nsh` presos em `eol=crlf` (o `cmd.exe` não lê `.cmd`
com LF de forma confiável) e os binários (`.png`, `.ico`, `.woff2`, `.exe`)
marcados à mão, pra que a heurística de conteúdo não resolva por eles. A
árvore foi normalizada junto: sem isso o primeiro commit carregaria a mistura
de CRLF e LF que a cópia deixou, e todo diff futuro viraria ruído.

### Corrigido

**`latestUnread` sem critério de desempate** — a última não lida era escolhida
varrendo a lista inteira em JS, e o empate em `at` (trivial quando um agente
despeja OSC — exatamente o caso que o rate limit existe pra conter) ficava por
conta da ordem que o SQLite devolvesse. Virou consulta, com
`ORDER BY at DESC, rowid DESC LIMIT 1`; o `listUnread` ganhou o mesmo desempate,
porque a ordem dele é a que o painel mostra e ela não pode dançar entre duas
leituras iguais.

**`repos.upsert` com o `path` já ocupado por outro id** — `path` é `UNIQUE` e
só o conflito de `id` era tratado: dois `upsertRepo` da mesma pasta em voo
(dois workspaces do mesmo repositório abertos junto, ou dois cores no mesmo
perfil) achavam ambos que o repo era novo e o segundo `INSERT` estourava
`SQLITE_CONSTRAINT_UNIQUE`, que subia como 500 no meio do
`POST /api/workspaces`. Agora o upsert roda em transação, o registro existente
vence (é o id que os workspaces referenciam, e a quem a confiança de filtros
está amarrada), `trust_filters` continua fora de qualquer UPDATE e o método
devolve o `Repo` que ficou gravado.

**Falha parcial ao matar sessões** — fechar aba ou workspace com uma sessão
travada respondia 500 sem dizer o quê. As demais já eram mortas
(`Promise.allSettled`); o que faltava era o corpo contar: as três rotas de
remoção respondem `{ error, code: 'kill-failed', killed, failed, failedIds }`,
e cada falha vai pro log com o `sessionId`. Continua 500 e não 207 de
propósito — o layout NÃO é removido (remover por cima de um PTY vivo deixaria
o processo órfão, sem painel que o mostre), então o pedido não se cumpriu nem
em parte. O que mudou é que a resposta diz em qual painel olhar, e repetir a
chamada é seguro.

**Badge de cota órfão na largura padrão da sidebar (280 px)** — cada badge era
um item solto de um `flex-wrap`, então o segundo descia sozinho pra linha de
baixo: um `sem 42%` isolado, que lia como erro em vez de segunda janela de
cota. Os badges foram pra um invólucro (a faixa passou a ter dois itens de
flex: ou eles cabem ao lado do texto, ou descem juntos) e a linha de texto
encolhe com reticências e `title` inteiro. Medido no DOM a 280 px: o topo dos
dois badges era 83 e 106 px, virou 103 e 103.

**Restauração de painel × workspace nascendo** — a marca de "tem criação em
voo" era um contador global: enquanto ele fosse > 0, o efeito de restauração
pulava QUALQUER workspace que virasse ativo **e o marcava como restaurado**.
Trocar pra um workspace nunca restaurado enquanto o diálogo esperava o `POST`
perdia a restauração dele — e, como a marca ficava, ele nunca mais restaurava
naquela execução. Agora cada criação em voo tem IDENTIDADE (um registro com um
id por criação, cujo fim é idempotente) e guarda os workspaces que JÁ existiam
quando ela começou: um workspace que estava lá restaura normalmente, e o
suspeito é pulado **sem marcar**. Fim de criação reexamina o workspace ativo,
então quem ficou ativo a criação inteira restaura sozinho, sem ação do
usuário. O contrato dos diálogos acompanhou: `onBusyChange(boolean)` (um
"acabou" anônimo, impossível de atribuir ao pedido certo) virou
`beginCreating(): () => void`.

**Detalhes de acabamento** — o "✕" do painel em criação continua desabilitado,
mas agora explica por quê no `title` (botão apagado sem motivo lê como bug do
app); `findOnPath` deixou de estar copiado em `codex.ts` e `gemini.ts`;
`stage-core.mjs` ganhou `--help`, impresso ANTES do `rmSync` que abre a
execução (quem digitava `--help` por reflexo perdia o stage e continuava sem
saber as flags); a linha da sessão na sidebar não promete mais clique no vão
entre a área clicável e o "✕"; e o `bridge watch` tira os handlers de
`SIGINT`/`SIGTERM` também no caminho de exceção do fechamento.

### Alterado

**`git ls-files --stage` só quando pode haver gitlink** — a enumeração de
drivers de filtro roda por repositório a cada ciclo do poller, e lia o índice
INTEIRO só pra achar linhas de modo `160000`. A chamada passou a ser pulada
quando as **três** condições valem juntas: não há `.gitmodules`, a última
leitura bem-sucedida daquele `cwd` não achou gitlink nenhum, e o arquivo de
índice continua com a mesma assinatura (`tamanho:mtimeMs:ctimeMs`) de então —
a terceira é o que faz um `git submodule add` posterior voltar a ser visto.
Fail-closed em toda saída de erro: assinatura que não dá pra ler nunca
autoriza pular. Medido num repositório sintético de 20 000 arquivos: a
enumeração completa caiu **36%**.

**`config.json` ilegível virou aviso** — JSON quebrado (ou JSON válido cujo
topo não é objeto: `[]`, `"pwsh"`, `null`, `42`) caía em `{}` calado, e a
configuração do dono "sumia" sem deixar pista de onde procurar. Agora o perfil
carrega o motivo e o core o escreve em `warn` no `core.log` assim que o logger
existe — ele não pode ser usado dentro do carregamento do perfil, porque é o
perfil quem diz onde o log fica.

**`pty.exit` fica na superfície do protocolo, documentado** — o evento parecia
redundante com `session.exited`, mas tem consumidor (o reducer da UI) e diz
outra coisa: `session.exited` é estado de SESSÃO (uma sessão já removida não
emite nada), `pty.exit` é o fato cru do processo, com o `exitCode` — que é o
que o `bridge watch --events pty` observa. A razão está escrita no
`protocol.ts`, no lugar da dúvida.

## [0.8.0] — 2026-09-05 — Segurança

Fase de segurança pedida pelo dono ("faz uma fase de segurança e vulnerabilidade do app de forma autônoma, auto corrigindo o que encontrar"): auditoria contra um modelo de ameaça explícito (A1 saída hostil no terminal, A2 processo local do mesmo usuário, A3 repositório hostil, A4 payload de hook, A5 dependências e instalador), correção autônoma de tudo que era Crítico/Alto/Médio e do que era barato entre os Baixos, e **cinco rodadas** de re-review adversarial com tentativa de contornar cada correção. 21 achados: 17 corrigidos, 1 parcial (fuses do Electron, sem dependência nova), 4 aceitos com motivo. A auditoria, o report das cinco rodadas e o ledger ficam fora do repositório público.

### Corrigido

**Autenticação e superfície HTTP (BR-01)** — a classificação de rota virou **default-deny** e passou a olhar a união do caminho CRU com o normalizado: `GET /%2Fapi/state` chegava ao handler como público. Caminho com `%2F`, `%5C` ou `\` é **400** antes de qualquer decisão. E, depois do re-review, request-target em forma absoluta (`GET http://127.0.0.1:<porta>/api/state HTTP/1.1`, que o Node entrega cru) também é **400**: o `find-my-way` normalizava e roteava enquanto o guard via "público" nas duas classificações — medido com `net.Socket` escrevendo as linhas do pedido à mão.

**Travessia e validação de ids (BR-02, BR-02b, BR-06, BR-09)** — `POST /hooks/:sessionId/:event` com `../` no id ou no evento escrevia arquivo fora da pasta de logs do perfil; agora id e evento passam por regex na entrada, o dump é montado com `basename()` e confinado por prefixo, e cada arquivo tem teto de 8 MB. `session_id` de hook só vira `claude --resume <id>` se casar `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (nada começando com `-`), e `base` de tarefa/worktree exige forma de ref com `max(255)` — os 50 000 caracteres que davam 500 `ENAMETOOLONG` agora são 400.

**Git e repositório hostil (BR-03, BR-04, BR-18)** — todo comando git roda com `-c core.fsmonitor=false -c core.useBuiltinFSMonitor=false -c core.pager=cat`, e as leituras passivas (poller, detecção de repo) com `core.hooksPath` numa pasta vazia do perfil, `--ignore-submodules=all` e `--` antes das refs: um repositório de origem desconhecida executava comando a cada 15 s, sem clique nenhum. Os drivers de `filter.*` **não** são neutralizados (isso quebraria `git-crypt`/`nbstripout`/`git-lfs`) — viraram **modelo de confiança**, abaixo em "Alterado". Nome de branch hostil (`main; whoami`) deixou de virar comando no PTY pelo "Ver diff": `isSafeRef` no `@bridge/shared`, `diffCommand` citando com aspas simples, e a UI parando antes do POST.

**Token e perfil (BR-07)** — `mode: 0o600` no `instance.json` é no-op no Windows (medido: nenhuma ACE), então o arquivo que carrega o token herdava a permissão da pasta. Agora o core roda `icacls /inheritance:r /grant:r "<DOMÍNIO\usuário>:(R,W)"` depois de gravar. A falha **não** é mais silenciosa (era fail-open com um `warn` num log que ninguém abre): vira `error`, `instanceAclApplied: false` no estado e banner na UI.

**Hooks, quota e DoS (BR-08, BR-11, BR-12, BR-15)** — `transcript_path` do payload de statusline lia arquivo arbitrário inteiro (`~/.ssh/id_ed25519`, um esparso de 65 MB, um caminho UNC); passou a exigir caminho absoluto com letra de unidade e extensão `.jsonl`, desistir acima de 64 MB e ler só o último 1 MB. WS com `maxPayload` de 1 MiB (era 100 MB) e teto de 32 conexões; `resize` entre 1 e 1000; notificação truncada em 2000 caracteres, com 10/s por sessão e poda periódica que agora alcança também as **não lidas** antigas (e ficou O(n) — o `UPDATE` anterior levava 41 s em 20 000 linhas, dentro do caminho de um OSC impresso no terminal).

**Electron e instalador (BR-13, BR-14, BR-16, BR-17)** — `$INSTDIR` deixou de ser interpolado cru na linha do PowerShell do NSIS (aspa simples dobrada por `WordReplace`); `openPath` usa `lstat` e não segue mais junction/symlink; `app.enableSandbox()` antes do `whenReady`.

**Dependências (BR-05)** — `@fastify/static` **8.3.0 → 10.1.3**, fechando quatro advisories (um Alto) de bypass de guarda de rota e travessia por caminho não canônico. `npm audit` (com e sem `--omit=dev`): **0 vulnerabilidades**.

**`mergeIntoBase` só olhava a raiz** (carry da rodada 3) — o escopo `--worktree` do git é por worktree, e um driver declarado no `config.worktree` do worktree da tarefa é invisível pra enumeração feita na raiz. A mesclagem agora exige confiança nos **dois** caminhos; `canRemoveWorktree` já exigia.

**Quatro resíduos baixos do re-review final** — (1) o tick do poller disparava um `refreshRepoFilters` por repo de uma vez; virou o mesmo pool de 4 do `start()`, com `.catch` (sem `await`, uma rejeição ali seria `unhandledRejection`). (2) `listFilterDrivers` ganhou **dedupe em voo**: o cache só é gravado no fim da enumeração, então duas chamadas concorrentes no mesmo repo varriam os submódulos duas vezes — agora a segunda espera a mesma promessa, e uma invalidação no meio do caminho impede que a leitura velha seja gravada por cima. (3) **Contenção por realpath** nos submódulos: além do caminho declarado, a pasta do submódulo **e** o gitdir que o git resolve pra ela (`rev-parse --absolute-git-dir`) precisam ficar sob o `realpath` do repositório — fecha a junction e o `.git` que é um arquivo `gitdir: <caminho de fora>` (medido: sem isso, o driver do repositório de fora entrava na conta). (4) `isSafeSubmodulePath` na **raiz de uma unidade**: `resolve('C:\')` já termina em `\`, e o `base + sep` cru reprovava todo submódulo de um repositório aberto ali.

**Higiene da suíte** — os arquivos de teste que criavam pasta em `%TEMP%` sem nunca apagar (11 no core, 3 no shell) passaram a usar um `tmpDir()` que se registra pra remoção no fim do arquivo, e o vitest do core ganhou `globalTeardown`: no fim da execução some tudo que ela criou (prefixos `bridge-`, `bridge `, `t5-`, `t5f-`), além da varredura de uma hora que já existia. A suíte deixava mais de mil pastas na máquina do dono.

### Alterado

- **Modelo de confiança nos filtros git.** Repositório que declara driver de filtro (`clean`/`smudge`) e ainda não foi confiado: a sidebar mostra **⚠ filtros** no lugar do `+N ~M`, o core não roda comando de git que toque conteúdo ali, e "Nova tarefa", "Mesclar no base" e "Remover worktree" respondem **409 `filters-untrusted`**. Confiar é um item no menu "⋯" do workspace, é do **repositório** (vale pros worktrees, grava no `bridge.db`, sobrevive ao reinício) e nunca vem ligado. A detecção enumera `--local` e `--worktree` com `--includes`, na raiz e em cada worktree, e desce nos submódulos pelo `.gitmodules` (lido com `-z`) **e** pelos gitlinks do índice, recusando caminho declarado que seja absoluto, vazio, com `..` ou fora do repositório; falha de enumeração conta como "tem driver". README: seção "Filtros git e confiança".
- **`--ignore-submodules=all` em toda leitura passiva de `status`.** Efeito colateral assumido: submódulo com alteração não commitada deixa de contar no `~M` da sidebar.
- Caminho de requisição com `%2F`, `%5C` ou `\`, e request-target fora da forma origin: **400** em qualquer rota.
- `POST /hooks/:sessionId/:event`: **400** quando o id não casa `^[A-Za-z0-9_-]{1,64}$` ou o evento não casa `^[A-Za-z]{1,40}$` (todos os eventos do Claude Code passam).
- `POST /api/sessions`: `resume` passou a exigir `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; `initialCommand` recusa caractere de controle e os metacaracteres de shell.
- `POST /api/tasks` e `PATCH /api/workspaces/:id/worktree`: `base` exige forma de ref e `max(255)`.
- `POST /api/sessions/:id/resize` e a mensagem `resize` do WS: `cols`/`rows` entre **1 e 1000**.
- `POST /api/sessions/:id/notify`: `text` com **max 2000** (a CLI trunca no cliente e avisa; a API crua responde 400).
- `/ws`: `maxPayload` de **1 MiB** e no máximo **32** conexões (a 33ª fecha com 1013).
- `GET /` e assets saem com `Content-Security-Policy`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`.
- `diffCommand(base)` (`@bridge/shared`) **lança** em ref inválida e cita a ref com aspas simples.
- O token **não** mudou de transporte: continua em `Authorization: Bearer` para `/api` e `/ws`, e em `?token=` para `/ws` e `/hooks`. Nenhum cliente (UI, shell, CLI, shim) precisou mudar.
- Versões em **0.8.0** (raiz, 5 pacotes, `packages/shell/stage/core.package.json` e as entradas do `package-lock.json`).

### Adicionado

- **`SECURITY.md`** na raiz (linkado no README): modelo de ameaça resumido (A1–A5, o que fica fora do escopo, "mesmo usuário = mesma confiança"), as proteções em pé, os **riscos aceitos** com o motivo de cada um, as verificações manuais que faltam e como reportar uma falha.
- **`PATCH /api/repos/:id` `{ trustFilters: boolean }`** e **`GET /api/repos/:id/filters`** → `{ drivers: [...] }` (a segunda une a raiz e todos os worktrees do repositório). `Repo.trustFilters` (SQLite, migração idempotente, preservado no `upsert`) e `Repo.hasFilterDrivers` (medido em memória na adoção do repo, a cada passada do poller e no `start()` do core, exposto pelo snapshot) no `@bridge/shared`.
- **Banner persistente da ACL**: quando o `icacls` do `instance.json` falha, a UI mostra "Não consegui restringir a permissão do instance.json — outro usuário desta máquina pode ler o token" no rodapé, com ✕ pra dispensar. Não é linha de status de 4 segundos: some sozinho quando um core seguinte consegue aplicar a ACL.
- Testes de segurança: `packages/core/test/security.test.ts`, `security-round2..5.test.ts`, `security-task3.test.ts` e `temp-hygiene.test.ts`; `packages/shell/test/shell-security.test.ts`; blocos novos em `git`, `quota`, `notifications`, `profile`, `api-static`, `db`, `api-tasks` (core), `shared/test/git.test.ts`, `ui/test/{actions,sidebar-model,menu}.test.ts` e `cli/test/cli.test.ts`. Cada correção tem um teste que **reproduz o ataque** e, onde havia fluxo legítimo no mesmo caminho, um teste de **CONTROLE** provando que ele continua passando.

## [0.7.0] — 2026-09-04 — auto-start com o Windows e `bridge resume`

Duas features da Fase 5 que o dono pediu: o Bridge pode subir junto com o Windows (opcionalmente sem janela, só na bandeja) e a CLI ganhou `bridge resume` — retomar na mão a conversa do Claude Code de um painel, sem depender do resume automático da subida. Codex/Gemini continuam fora por decisão do dono.

### Adicionado
- **Iniciar o Bridge junto com o Windows** — Configurações (`Ctrl+,`) → seção **Sistema** (a sétima), com dois checkboxes: "Iniciar o Bridge junto com o Windows" e a sub-opção "Começar minimizado na bandeja". Ligar grava uma entrada em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` apontando pro `Bridge.exe`; a sub-opção acrescenta `--hidden`. Os dois vêm **desligados** e o Bridge nunca liga sozinho.
- **`--hidden`**: com o argumento, o `main.ts` cria a janela com `show: false` — o core e as sessões sobem, mas nada aparece até o clique na bandeja, o item "Mostrar" do menu dela, o clique numa notificação ou uma segunda instância. Sem o argumento, o boot é o de sempre.
- **`packages/shell/src/loginItem.ts`** (novo, parte pura e testada): `loginItemArgs`, `shouldStartHidden`, `readLoginItem`, `loginItemSupport`, `parseLoginItemInput`. O estado **não** mora no `config.json` — quem manda é o registro, que pode ser mexido por fora (Gerenciador de Tarefas › Aplicativos de inicialização); toda leitura vai no Windows e toda escrita relê de lá antes de responder. Dois canais IPC origem-validados (`bridge:getLoginItem` / `bridge:setLoginItem`, com `assertFromUi`) e `window.bridge.loginItem.get()/set({enabled, startMinimized})`.
- **`bridge resume [paneId]`** na CLI: sobe de novo, no painel, o agente que rodava ali, com `claude --resume <conversa>`. Sem argumento vale o painel da sessão corrente (`BRIDGE_SESSION` → header `X-Bridge-Session`) ou, fora de uma sessão do Bridge, o painel em foco. `--json` devolve a sessão criada mais `resumedFrom` (o id da conversa retomada).
- **`POST /api/panes/:id/resume`** no core: `:id` é um paneId **ou** o literal `current` (resolvido pelo header `X-Bridge-Session` e, na falta dele, pela sessão em foco). Cria a sessão com `agent = pane.lastAgent` e `resume = pane.lastAgentSessionId`, e responde `201` com a sessão + `resumedFrom`. Erros: `404 pane-not-found` (painel inexistente, ou nenhum painel atual), `409 pane-busy` ("este painel já está com um agente"), `422 nothing-to-resume` ("Este painel não tem conversa pra retomar") e os códigos do próprio launch (`agent-unavailable`, `cwd-missing`). `lastEndedBy` **não** entra na decisão: quem digitou o comando está pedindo a conversa de volta na mão.
- **Shell vivo cede o painel pro agente retomado**: `CreateSessionInput.replaceLiveShell` (opt-in, hoje com um único chamador — a rota do resume). É o caso normal do comando, porque com `restore.resumeAgents` desligado (ou com o resume da subida falhando) o painel volta como **shell** e é de dentro dele que a pessoa digita `bridge resume`. Um **agente** vivo continua sendo `PaneBusyError`/409 com ou sem a flag.
- Testes: `packages/shell/test/login-item.test.ts` (novo, 17), `packages/core/test/api-resume.test.ts` (novo, 14 — inclui o fim-a-fim agente → app fecha → shell na subida → resume), `packages/ui/test/settings-model.test.ts` (+6) e `packages/cli/test/cli.test.ts` (+6, contra um core real).

### Corrigido
- **O painel que voltava como shell esquecia qual conversa era.** Até a 0.6.0, `setPaneLast(paneId, 'shell')` apagava `lastAgent` e `lastAgentSessionId` ("aqui não é mais o Claude"). Como a restauração com `resumeAgents` desligado (ou com resume que falhou) sobe justamente um shell no painel, a memória da conversa morria ali e `bridge resume` respondia `422 nothing-to-resume` no cenário mais comum. Agora o shell **preserva** os dois campos (só `lastKind` vira `'shell'` e `lastEndedBy` é zerado), e a rota do resume deixou de olhar o `lastKind`.
- **Leitura do auto-start pelo Electron.** `getLoginItemSettings().openAtLogin` não responde "inicia com o Windows" — ele é "existe entrada que bate com o executável **e com os `args` desta consulta**", e `launchItems[].args` volta sempre vazio (o Electron devolve o `GetArgs()` do Chromium, que lista só argumentos posicionais e descarta o *switch* `--hidden`). Medido no Electron 44 com entrada real no registro. O shell faz **duas** consultas: `executableWillLaunchAtLogin` responde o "ligado", e o `openAtLogin` da consulta feita **com** `--hidden` responde o "minimizado". `setLoginItemSettings` vai **sem** a opção `name` — passar `name: 'Bridge'` grava um nome bonito no `Run` e cega a leitura (medido: `openAtLogin` falso em todas as consultas), então o nome do valor é o `APP_ID`.

### Alterado
- **`layout.setPaneLast`**: com `kind === 'shell'`, `lastAgent`/`lastAgentSessionId` são preservados (ver "Corrigido"). O restore automático **não muda**: `panesToRestore` decide por `lastKind === 'agent'` **e** `lastEndedBy === 'app'`, e o shell continua zerando os dois. Agente novo continua não herdando id.
- **`createSession`** só lança `PaneBusyError` quando a sessão viva do painel não é um shell substituível (`replaceLiveShell`), e a substituição acontece **depois** de todas as validações (`available()` do adaptador e o `cwd`): pedido recusado deixa o terminal que a pessoa tem na mão exatamente onde estava. O descarte continua sendo o do `disposeSession(existing.id, { removePane: false })` que já existia — um `pty.kill` só, e o painel não sai do layout.
- **Rodar `bridge resume` de dentro do painel que está sendo retomado**: a frase "Retomando a conversa …" (ou o `--json`) pode não aparecer, porque o shell que hospeda a CLI morre junto. Documentado na CLI, no README e nos testes; o retorno visível é o painel virando o agente, e de outro painel a saída sai normal.
- README ganhou "Iniciar com o Windows", a linha **Sistema** na tabela do diálogo, a linha `bridge resume [paneId]` na tabela da CLI e o parágrafo "Retomar a conversa". No fechamento entraram também duas lacunas herdadas da 0.6.0: a seção **Sessões** na tabela do diálogo e o campo `restore.resumeAgents` na tabela dos campos que o `PATCH /api/config` aceita (`restore` é mesclado chave a chave como `toast` e `terminal`).
- **e2e**: o cenário das configurações cobrava **6** seções no diálogo e a seção **Sistema** fez sete — a asserção foi atualizada em `packages/shell/test/e2e.spec.ts`. Era a única falha da suíte no fechamento da 0.7.0.
- Versões em **0.7.0** (raiz, 5 pacotes, `packages/shell/stage/core.package.json` e as 7 entradas do `package-lock.json`).

## [0.6.0] — 2026-09-04 — retomar o Claude Code ao reabrir

O sintoma que o dono reportou na 0.5.0: fechar o Bridge com um Claude Code aberto e reabrir devolvia um **shell** com a dica "sessão anterior era Claude Code", e o `Ctrl+Shift+C` nesse painel dividia a tela — dois terminais onde antes havia um Claude. Agora o painel volta com a **mesma conversa**, como o cmux faz.

### Adicionado
- **Resume automático.** Painel que estava com um Claude Code **vivo quando o app fechou** volta com `claude --resume <id>`, na conversa em que estava. Painel cujo agente o **usuário** encerrou (`/exit`, ✕, fechar painel, `DELETE /api/sessions/:id`) volta como shell com a dica de sempre — retomar o que alguém fechou de propósito seria ressuscitar conversa morta.
- **Id da conversa.** Todo hook do Claude Code traz o `session_id` dele; o core grava em `Session.agentSessionId` (memória) e `Pane.lastAgentSessionId` (SQLite, colunas novas `last_agent_session_id` e `last_ended_by` com migração idempotente guardada por `PRAGMA table_info`). A gravação é no-op quando o valor não muda, então sai **um** `layout.changed` por sessão — não um por ferramenta usada.
- **Quem encerrou.** `Pane.lastEndedBy`: `'user'` quando a sessão sai com o core de pé (um ouvinte de `session.exited` cobre todos os caminhos de uma vez), `'app'` quando o `stop()` do core marca os painéis de agente vivos **antes** de matá-los, com uma trava `stopping` pra que o `session.exited` de cada PTY morto não carimbe `'user'` por cima.
- **`POST /api/sessions` aceita `resume?: string`** (1–200 chars) e o adaptador do Claude põe `--resume <id>` logo depois do `--settings`. Sem id gravado **não** há fallback pro `--continue` (ambíguo com dois Claudes na mesma pasta): sobe um Claude limpo, nunca um shell.
- **Configurações → Sessões** (seção nova, a sexta): "Ao reabrir, retomar as sessões do Claude Code automaticamente" — `restore.resumeAgents` no `GET`/`PATCH /api/config` e no `config.json`, **ligada por padrão** (o dono confirmou que é o que o cmux faz). Desligada, todo painel volta como shell com a dica.
- **Banner do resume** no topo do xterm restaurado: `retomando a sessão anterior do Claude Code · 9f1a2b3c` (os 8 primeiros do id, o mesmo prefixo que o `claude --resume` lista). O painel que volta como shell mantém o banner antigo — o texto é escolhido por painel, não por restauração.
- **Falha do resume não deixa painel órfão**: 4xx/5xx do `POST` (binário fora do PATH, cwd que sumiu) cai pro shell com a dica antiga e o rodapé conta o motivo — "Não deu pra retomar o Claude Code: …". O 409 do painel que este mesmo restore está reabrindo continua sendo silêncio (R9).
- e2e: **cenário 7**, o único do arquivo que sobe um **Claude Code de verdade** — workspace com "Abrir um Claude Code" marcado, diálogo de confiança aceito (`ArrowDown` + `Enter`), espera o `agentSessionId` chegar pelo hook `SessionStart`, `app.close()` gracioso, relança no mesmo perfil e cobra painel `claude` (não `shell`) com o banner do resume e o prefixo do id certo no xterm. 7/7 em duas execuções seguidas.

### Corrigido
- **`Ctrl+Shift+C` virando dois terminais** ao reabrir. A causa não estava no atalho (ele divide quando o painel tem sessão viva, e isso continua igual — tem teste travando o comportamento): estava no painel voltar como shell, o que empurrava o dono a apertar o atalho pra recuperar o Claude. Com o painel voltando como Claude, não há o que apertar.

### Alterado
- `panesToRestore` devolve `{ paneId, hint, resume? }` — `resume` só quando `lastKind === 'agent'` **e** `lastEndedBy === 'app'` **e** `restore.resumeAgents`; `bannerFor` e a fila de dicas pendentes passaram a carregar o **texto** do banner (mapa `session.id → banner`), não só o id.
- O restore da subida **espera o `GET /api/config`** antes de decidir: a config não vem no `hello`, e sem a espera um dono que tinha desligado o resume veria os Claudes subirem do mesmo jeito quando a resposta atrasasse.
- Versões em **0.6.0** (raiz, 5 pacotes, `packages/shell/stage/core.package.json` e as 7 entradas do `package-lock.json`).

## [0.5.0] — 2026-09-04 — lote do dono: ícone, fonte do terminal, painéis, sidebar, configurações

As seis sugestões que o dono fez na primeira execução real do app instalado, num lote só.

### Adicionado
- **Ícone próprio do app**: `packages/shell/build/icon.ico` (16, 24, 32, 48, 64, 128 e 256 px, PNG-in-ICO) com o `BridgeMark` sobre quadrado arredondado `--bg-elevated`, apontado em `electron-builder.yml` (`win.icon`) — o instalador e o `Bridge.exe` deixaram de sair com o ícone padrão do Electron.
- `packages/shell/scripts/make-icon.mjs` gera o `.ico` e o PNG 256 sem dependência nova: rasterizador por distância-a-segmento (`src/iconMark.ts`) + PNG por `zlib` (`src/png.ts`), determinístico e idempotente. `src/tray.ts` passou a desenhar a MESMA marca (saiu o losango placeholder) e `packages/ui/index.html` ganhou o favicon SVG inline equivalente.
- **Fechar painel** (`pane.close`, `Ctrl+Shift+X`): fecha painel vazio, encerrado ou vivo por `DELETE /api/panes/:id` — que encerra a sessão e, se era o último painel da aba, fecha a aba. Três portas: o atalho, o **✕** do cabeçalho do painel (no hover, como o da aba) e o botão do painel vazio. Sessão de **agente** viva pede confirmação; shell vivo fecha direto. O foco vai pro vizinho (`GET /api/panes/:id/neighbor`) ou pro primeiro painel da aba.
- **Painel vazio com botões** "Abrir shell", "Abrir Claude Code" e "Fechar painel" abaixo das dicas de tecla (o `Enter` continua abrindo o shell), e as **dicas da barra de abas viraram botões**: clicar dispara a mesma ação do atalho, incluindo a dica nova `Ctrl Shift X fecha painel`.
- **Grupos da sidebar fixáveis e recolhíveis**: clicar no título recolhe/expande (com contador de workspaces e o **anel do pior estado** do grupo recolhido, pra não esconder um `stuck`); o "⋯" do hover tem "Fixar no topo"/"Desafixar". Fixados vêm primeiro, na ordem em que foram fixados. Preferência local (`localStorage`, chave `bridge.sidebar.groups`), com leitura defensiva — valor corrompido vira preferência vazia. Componente `sidebar/PopoverMenu.tsx` extraído do `WorkspaceMenu` e reusado pelo `GroupHeader`.
- **Configurações** (spec §6): `GET /api/config` e `PATCH /api/config` (subconjunto validado, merge profundo em `toast`/`terminal`, gravação atômica tmp+rename, aplicação em memória e evento `config.changed { config }` no `/ws`). `shell` vale pras sessões novas, `gitPollSeconds` reagenda o poller em voo, `toast` vale na próxima notificação, `terminal` vale nos terminais já abertos.
- **Diálogo de configurações** (`Ctrl+,`, engrenagem no cabeçalho da sidebar, "Configurações…" no menu "⋯"): seções Terminal (fonte com sugestões de mono, tamanho 8–24, shell padrão, prévia de três linhas com box-drawing e blocos), Notificações, Git, Atalhos (tabela read-only das 19 ações × teclas + "Abrir pasta do perfil") e Aparência ("Tema: Escuro", desabilitado). Sem OK nem Cancelar: cada campo manda o seu próprio `PATCH` e a config que volta já vale; "Restaurar padrões" por seção; 400 do core vira faixa dentro do diálogo.
- `BridgeConfig` ganhou `profileDir` (caminho absoluto da pasta do perfil), **somente leitura** e **nunca gravado**: o `config.json` guarda o tipo novo `StoredConfig`, e é o compilador que impede o campo derivado de ir parar no arquivo.
- **Dependência nova (a única do lote, autorizada pelo dono)**: `@xterm/addon-unicode11@^0.8.0` em `@bridge/ui`, carregado com `term.unicode.activeVersion = '11'` — sem ele o xterm mede os emoji da statusline do quota-advisor (`🟢`, `🧭`) pela tabela do Unicode 6, com largura 1, e eles encavalavam a letra seguinte.
- e2e: dois cenários novos (5 — `Ctrl+Shift+T` abre a aba, `Ctrl+Shift+X` fecha o painel vazio e a aba some junto; 6 — `Ctrl+,` abre o diálogo, o corpo da fonte vai a 16, o xterm aberto re-renderiza e `GET /api/config` confirma).

### Corrigido
- **Logo do Claude Code e statusline quebrados dentro do xterm** (o sintoma que o dono reportou). Causa: o `geist-mono-variable.woff2` embutido é um subset de 225 codepoints, sem box-drawing, blocos, braille nem setas; o Chromium resolve fonte **por glifo**, então as letras vinham do Geist (avanço 7,20 px em 12 px) e todo símbolo caía na fonte seguinte com avanço próprio (7,03 px) — a fonte que dava a medida da célula não era a que desenhava os símbolos, e a deriva chegava a ~27 px numa linha de 160 colunas. A pilha default virou `'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace` (Cascadia Mono vem do pacote do Windows Terminal e é vista pelo DirectWrite: box-drawing 128/128, blocos 32/32, braille 256/256, tudo no avanço do `W`).
- `lineHeight` do terminal de 1.5 pra **1.0** (`design/tokens.json → font.lineTerminal`): com 1.5 as três fileiras do logo do Claude nunca se tocavam e ele saía listrado.
- `Unicode11Addon` exige `allowProposedApi: true` no `XTerm`; sem a flag ele lançava na montagem e o **renderer inteiro ficava em branco** (achado da Task 4, corrigido antes de sair da execução).
- `mergeConfig` fazia **shallow copy** de `toast`: `{ "toast": { "enabled": false } }` repunha o `quietWhenFocused` padrão. O merge passou a ser chave a chave em `toast` e `terminal`, tanto no `config.json` da subida quanto no `PATCH`.
- Corrida entre `pane.close` e uma sessão **em voo**: um painel com o `POST /api/sessions` do "Abrir Claude Code" ainda pendente continuava sendo `empty` pra UI, e o ✕ matava o agente recém-nascido sem perguntar. Agora a trava de ação em voo recusa o fechamento ("Aguarde a sessão abrir"), os botões do painel ficam `disabled` nessa janela, e o estado é relido imediatamente antes do `DELETE`.
- Corrida de respostas do `PATCH` nos campos numéricos do diálogo (digitar `1` e depois `4` podia deixar valer o `1`): contador de envio **por campo**, e a resposta que não é a mais recente é descartada. Um `PATCH` recusado agora devolve o rascunho ao valor que o servidor confirmou.
- "Abrir keybindings.json" não abria nada: mandava o literal `%APPDATA%\bridge\keybindings.json` pro `openPath`, que não expande variável de ambiente e (por R12 da Fase 3) só aceita **pasta existente**. Virou "Abrir pasta do perfil", com o caminho absoluto do `profileDir` ao lado; sem Electron, o caminho aparece em texto selecionável no lugar do botão.
- README: a nota "o addon unicode11 não está no lockfile" ficou obsoleta quando o dono autorizou a instalação; e o caminho do perfil na seção "Configurações" tinha perdido a barra invertida (`%APPDATA%ridge`).

### Alterado
- O grupo **"Solto"** da sidebar virou **"Sem repositório"** (`LOOSE_GROUP_NAME`) — o dono achou o nome anterior opaco, e este é o literal do critério.
- Os defaults do `config.json` deixaram de existir em duplicata: nasceu `DEFAULT_STORED_CONFIG` em `packages/shared/src/model.ts`, e o `DEFAULT_CONFIG` do core e o `SETTINGS_DEFAULTS`/`TERMINAL_DEFAULTS` da UI passaram a **derivar** dele. Antes eram três cópias escritas à mão, e mudar um default num lado deixava o "Restaurar padrões" do diálogo repondo o valor velho, calado.
- `Terminal` expõe `fontFamily`/`fontSize` como props (o diálogo as liga a `config.terminal`) e troca a fonte do xterm **ao vivo**, remedindo a grade e só avisando o ConPTY quando `cols`/`rows` mudam de verdade.
- Versões em **0.5.0** (raiz, 5 pacotes, `packages/shell/stage/core.package.json` e o `package-lock.json`).

## [0.4.2] — 2026-09-04 — correção: trazer a sidebar de volta

### Corrigido
- Com a sidebar escondida (menu ☰ → "Esconder sidebar" ou `Ctrl+Shift+S`) não havia nada visível pra trazê-la de volta — só o atalho, que o dono não tinha como descobrir. A barra de abas ganha um botão ☰ no canto esquerdo enquanto a sidebar está escondida (tooltip com o atalho).

## [0.4.1] — 2026-09-04 — correção: subida do core em instalação fresca

### Corrigido
- O shell esperava só 10 s pelo `instance.json` do core; numa instalação fresca em outro disco (disco frio, Defender escaneando os módulos nativos) o core levou 55 s pra subir e o app mostrava "O core não subiu" com o core ainda carregando. Agora o shell espera até 90 s **enquanto o filho estiver vivo**, e grava `ainda esperando o core (N s)` no `shell.log` a cada 10 s.
- Ao desistir, o shell derruba a **árvore** do core (`taskkill /t /f`), não só o processo direto: o core sobrevivente escrevia o `instance.json` depois do app já ter fechado.

## [0.4.0] — 2026-09-04 — Fase 4: CLI `bridge`

### Adicionado
- **CLI `bridge`** (`packages/cli`, bundle CJS único por esbuild, zero dependências em runtime): `notify`, `list`, `focus`, `new`, `task new|merge|rm`, `send`, `status`, com `--json` em todos. Descobre a instância por `BRIDGE_PORT`/`BRIDGE_TOKEN` (ambiente de todo painel do Bridge) ou pelo `instance.json` do perfil, e nunca imprime nem aceita token.
- Empacotamento: `resources/cli/{bridge.cjs,bridge.cmd}` no app instalado, e `packages/shell/installer.nsh` põe essa pasta no PATH do usuário na instalação (e tira na desinstalação) via `[Environment]::SetEnvironmentVariable(..., 'User')`. O `npm run build` da raiz agora builda a CLI antes do shell.
- Screenshots reais em `design/screenshots/task5-fase4-cli.png`.

### Corrigido (onda de correção final da Fase 4, pós-revisão whole-branch)

- **Janela sem menu de aplicação** — o menu padrão do Electron dava a `Ctrl+W` (fechar janela/app), `Ctrl+R` e `Ctrl+Shift+I` prioridade sobre os atalhos do Bridge de mesmo nome. `Menu.setApplicationMenu(null)`, zoom travado em 1× (janela e views) e devtools só com `BRIDGE_DEV=1`, por `F12`.
- **`POST /api/sessions/:id/notify` e `/input` de sessão inexistente → `404 { code: 'session-not-found' }`** (respondiam `200 {}`): `bridge notify` dizia "avisado" sem notificação nenhuma e `bridge send` dizia "enviado" pra um PTY que não existe. Os `/hooks/*` seguem lenientes.
- **`installer.nsh` preserva o tipo do PATH** — `[Environment]::SetEnvironmentVariable(…, 'User')` grava `REG_SZ` quando o valor não tem `%`, e trocar o tipo do `HKCU\Environment\Path` faria um `%JAVA_HOME%\bin` do usuário deixar de expandir. Passou a ler cru (`GetValue(..., DoNotExpandEnvironmentNames)`), escrever `-Type ExpandString` e avisar o Windows com `WM_SETTINGCHANGE` (`SendMessageTimeout`, 5 s, ABORTIFHUNG). A desinstalação tira só a entrada do Bridge, com o mesmo cuidado. **Continua nunca executado.**
- **`bridge.cmd` honra `BRIDGE_NODE`** e, sem Node, diz "Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=&lt;caminho&gt;)" em vez do `'node' não é reconhecido` do cmd.exe.
- **`bridge --help`, `bridge --version` e `bridge` sem argumento** saem por stdout com código 0 **sem falar com o core** — antes, com o Bridge fechado, a ajuda virava "Bridge não está aberto".
- README: o `setx` (que trunca em 1024 chars e grava `REG_SZ`) saiu do fallback manual de PATH, trocado por `Set-ItemProperty … -Type ExpandString` no escopo do usuário; parágrafo do `X-Bridge-Session` com os acentos que faltavam.
- `Client.probe` (sonda morta da Task 1) removido da CLI.

### Corrigido (higiene herdada das revisões das Fases 3 e 4)
- **`/api/*` recusa `Origin` fora do loopback com 403** (R12 da Fase 3), mesma regra que já valia pro `/ws`. Pedido sem `Origin` (CLI, shim, main do Electron) continua passando, e o estático segue sem bearer.
- **`bridge:openPath` exige pasta existente** (`statSync(...).isDirectory()`) antes do `shell.openPath` (R12 da Fase 3): "Abrir no Explorer" é a única razão do canal existir, e abrir um arquivo qualquer pelo programa associado seria execução.
- **`Core.resolveRepo` reconfere `hasCommits` no disco quando vem `repoId`**: uma linha de `repos` gravada por uma versão anterior (antes do R7) podia apontar pra repo sem commit nenhum e furar a recusa `no-commits`.
- `CLI_VERSION` com guarda de `typeof`: `tsx packages/cli/src/index.ts` roda sem o `define` do esbuild (imprime `dev`) em vez de estourar `ReferenceError`.
- Comentários e títulos desatualizados: `initialCommand` no `schemas.ts` (é "após o primeiro byte do PTY, piso 200 ms e teto 3 s", não "200 ms depois do spawn"); título do teste de conflito em `git.test.ts` (`code`, não `detail`); nota em `theme.css` proibindo `transform`/`filter`/`will-change` na árvore da sidebar, que quebrariam o `position: fixed` do menu "⋯".

## [0.3.0] — 2026-09-03 — Fase 3: worktrees e git na sidebar

### Adicionado
- `packages/core/src/git.ts`: serviço git por cima do BINÁRIO `git` (`execFile`, `windowsHide`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, timeout de 20 s) — `detectRepo`, `ensureExclude`, `createWorktree`, `status`, `mergeIntoBase`, `canRemoveWorktree`, `removeWorktree`, `removeWorktreeForce`, `diffCommand`. Erros tipados (`GitError` com `code`/`detail`/`stderr`).
- `packages/shared/src/git.ts`: `normalizeTaskName` (minúsculas, `[a-z0-9._-]`, espaço vira `-`, 1–60 chars) — a MESMA função no core e na UI.
- `packages/core/src/gitPoller.ts`: status por workspace de worktree a cada `gitPollSeconds` (default 15) **só enquanto houver cliente WS**; emite `workspace.git` apenas quando `ahead`/`dirty`/`branch` mudam; `refresh(id)` imediato (rota, hook `Stop` e criação da tarefa).
- Rotas: `GET /api/repos`, `GET /api/git/detect?cwd=`, `POST /api/tasks`, `GET /api/workspaces/:id/git`, `POST /api/workspaces/:id/git/refresh` (204), `POST /api/workspaces/:id/merge` (`ff-only`|`no-ff`), `DELETE /api/workspaces/:id/worktree` (204). `POST /api/sessions` aceita `initialCommand` (≤ 2000 chars, escrito no PTY 200 ms depois do spawn).
- Protocolo: evento `workspace.git` e `git: Record<workspaceId, GitStatus>` no snapshot/`hello`.
- `Core.createWorkspace` detecta o repo da pasta (`repos` upsert pelo worktree PRINCIPAL) e grava `repoId`, `branch` e `worktree { base, path }`.
- UI: diálogo **Nova tarefa** (`Ctrl+Shift+Alt+N` e o botão do rodapé) com repo (lista de `GET /api/repos` + "Escolher pasta…"), preview do branch normalizado, base e "Subir Claude Code"; badges `+N ~M` na linha do workspace (`~M > 0` em âmbar, tooltip com a base); menu "⋯" com **Ver diff · Mesclar no base · Remover worktree · Abrir no Explorer · Fechar workspace** (as três de git só em workspace de worktree).
- Recusas da spec §10, com o que falta escrito na faixa de status: `dirty-base` no merge, `dirty-worktree` e `not-merged` na remoção (checadas ANTES de matar as sessões do workspace), `exists` no nome repetido; `ff-only` que não é fast-forward volta `code: 'not-ff'` e a UI oferece o merge com commit; conflito no `no-ff` faz `merge --abort` e volta `code: 'conflict'`.
- e2e: terceiro cenário Playwright `_electron` num repo git temporário — tarefa criada pelo diálogo, badges `+0 ~0` → `~1` → `+1 ~0`, as duas recusas da remoção na faixa de status, merge ff-only e remoção (pasta e branch somem).

### Corrigido (onda de correção final, pós-revisão whole-branch)
- **Merge não troca mais o checkout do usuário (R1)**: com o repo principal em outro branch, `mergeIntoBase` recusa com `409 { code: 'base-not-checked-out' }` ("O repositório principal está em `<head>`; faça checkout de `<base>` antes de mesclar") em vez de dar `git checkout`. Base checked out em OUTRO worktree vira `409 { code: 'base-in-use' }` com o caminho dele.
- **Contrato de erro por `code` (R2)**: `not-ff` e `conflict` viraram `GitErrorCode` de verdade — `409 { code: 'not-ff' }` / `409 { code: 'conflict' }`. O `detail` deixou de ser marcador (é só texto humano); o `stderr` cru continua no campo próprio. A UI decide pelo `code`.
- **Base deduzida (R3)**: worktree ADOTADO tira o base do upstream do branch e, na falta dele, do branch corrente do principal com `worktree.baseGuessed: true`. Tooltip, confirmação de merge e de remoção dizem "(base deduzida)", e o menu ganhou **Definir base…** (`PATCH /api/workspaces/:id/worktree`, que valida o ref).
- **Branch do disco (R4)**: o poller grava no workspace o branch que o worktree tem agora; a UI mostra `git.branch`; merge e remoção leem o branch corrente em vez do gravado na criação; "Mesclar no base" some em checkout destacado.
- **Custo do poll (R5)**: `status()` virou UMA chamada (`git status --porcelain=v2 --branch --untracked-files=all`); o `+N` sai do `# branch.ab` quando o upstream é o próprio base, senão do `rev-list` de sempre. O poller só roda com um cliente WS que RECEBA `workspace.git` **e** um `POST /api/focus` com `windowFocused: true` nos últimos 60 s.
- **Refresh no meio de uma leitura (R6)**: o `refresh` que chega depois do início de uma leitura em voo encadeia uma segunda e devolve a dela — o hook `Stop` não recebe mais o número de antes do commit.
- **Corpo vazio com `content-type: application/json` (item 7)**: parser global aceita `''` como `{}`; JSON quebrado continua 400.
- **Menu "⋯" recortado (R8)**: o popover virou `position: fixed` posicionado por `menuPlacement(triggerRect, menuSize, viewport)`, abre pra cima quando não cabe embaixo e fecha em scroll/resize.
- **Restauração de painéis (R9)**: paralela (`Promise.allSettled`) com trava por painel em voo; 409 do próprio painel é silêncio, o resto vira uma linha de status.
- **Flake do 2º e2e (pendência aberta desde a Fase 2)**: a sidebar às vezes voltava da relançada com 1 sessão e o core com 2 — o `GET /api/state` da subida era atendido NO MEIO da restauração e sua resposta (snapshot com um painel) chegava depois dos `session.created`, sobrescrevendo o mapa de sessões da UI. `fetchState` ganhou guard de sequência (só a resposta do pedido mais novo é aplicada) e a restauração dispara um `fetchState` de convergência ao terminar. 10 rodadas seguidas do teste, sem falha.
- **`initialCommand` (R10)**: escrito depois do primeiro `onData` do PTY (piso 200 ms, teto 3 s) em vez de um timer cego de 200 ms.
- **Repo sem commit (R7)**: `detectRepo` devolve `hasCommits`; `createWorkspace` não registra repo sem commit (o `%USERPROFILE%` desta máquina sai do `GET /api/repos`) e `POST /api/tasks` recusa com `422 { code: 'no-commits' }`.
- **Vazamento de `%TEMP%` (R11)**: `log.close()` (drena a fila e fecha) roda no `core.stop()` antes de qualquer `rmSync`, e o `globalSetup` do vitest do core varre `%TEMP%\bridge-*` com mais de 1 h.
- **Minors**: `diffCommand` foi pro `@bridge/shared` (uma cópia só); `POST /api/sessions` devolve `code` e manda exceção desconhecida pro 500; `GET /api/workspaces/:id/git` em workspace comum vira `404 { code: 'not-worktree' }`; worktree cuja pasta sumiu vira `GitStatus.error: 'missing'` (linha mostra "(pasta sumiu)", menu só com "Fechar workspace"); `normalizeTaskName` recusa `..` no meio e nomes reservados do Windows.
- Higiene da Fase 2: `presentUnread(…, { force: true })` no `did-finish-load` (o "(n)" do título sobrevive a um reload do renderer); guard de tipo no `startsWith('pty.')` do `coreEvents`; core **adotado** ganhou vigilância (`watchAdopted`: `GET /api/state` a cada 5 s, 3 falhas = saída inesperada) e a adoção exige `GET /` = 200 quando o shell foi lançado com `uiDir` (não adota mais um `dev:core` sem UI); stub restaurado em `try/finally` no teste do 500 de `api-panes`.

## [0.2.0] — 2026-09-03 — Fase 2: shell Electron e terminais

### Adicionado
- `packages/shared`: tipos do domínio e do protocolo compartilhados por core, UI e shell; `DEFAULT_KEYBINDINGS` (17 ações).
- `packages/shell`: app Electron 44 — janela única (sem aceleração de hardware), preload `window.bridge` com IPC validado por origem, core rodando como **sidecar** (processo filho do Node do sistema; ver ADR-002), cliente WS filtrado (`/ws?events=`), toast nativo com coalescing leading-edge, bandeja, badge no título, `flashFrame` em `needs-input`, encerramento gracioso (`POST /api/shutdown`) com `taskkill /t` de reserva, adoção de core órfão na subida.
- Empacotamento: `npm run dist` → `Bridge Setup 0.2.0.exe` (NSIS x64) e `win-unpacked/`; core buildado em JS e staged em `resources/core` com lockfile próprio; UI em `resources/ui` servida pelo core.
- Core: logger de arquivo rotativo (`logs/core.log`), rotas `GET /api/panes/:id/neighbor`, `POST /api/panes/:id/ratio` (com `siblingPaneId`, menor ancestral comum), `GET /api/keybindings`, `POST /api/shutdown`, `GET /api/notifications/latest-unread`; `last_kind/last_agent` por painel; `DELETE /api/tabs|workspaces/:id` matam as sessões; servidor estático da UI (`BRIDGE_UI_DIR`) com auth de path normalizado.
- UI: abas por workspace, árvore de splits com divisor arrastável, um xterm por painel, painel vazio/encerrado com Enter reabrindo shell, 17 atalhos (guard de autorepeat + trava de ação em voo), diálogo Novo workspace, sidebar e painel de notificações no design (`design/`), faixa de status, fontes Geist locais, restore de layout na primeira conexão com banner na sessão restaurada, só o workspace ativo montado.
- Testes: e2e Playwright `_electron` (2 cenários: fluxo completo e relaunch/restore).

### Corrigido (onda final da Fase 2)
- Main do Electron fazia I/O síncrono e `setTitle` a cada chunk de PTY; `shell.log` sem rotação.
- Ratio de divisor caía no split errado em layout aninhado.
- Core órfão (janela morta à força) bricava o launch seguinte.
- Todos os painéis de todos os workspaces ficavam montados.
- Core nunca encerrava gracioso (flush do log perdido).
- Bypass de auth por `//api` e `%2F`; checagem de origem do IPC por prefixo de string.

## [0.1.0] — 2026-09-03 — Fase 1: núcleo e status

### Adicionado
- `packages/core`: servidor Fastify em `127.0.0.1` com token por instância; sessões em PTY (node-pty/ConPTY); `--settings` por sessão apontando hooks e statusline do Claude Code pro shim `bin/bridge-hook.cjs`; máquina de estados `idle → running → needs-input/done/stuck → exited`; adaptador Claude Code (Codex/Gemini como stubs); quota via quota-advisor; OSC 9/99/777; notificações com política de toast; SQLite; API HTTP + WS com backpressure; agente falso pra testes.
- `packages/ui` (provisória): sidebar com anel por sessão, um terminal por sessão, Web Notifications.
- Verificado com Claude Code real (dois smokes) e onda de correção em duas rodadas após revisão whole-branch.
