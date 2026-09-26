# Segurança do Bridge

O Bridge é um app **local**: um core Fastify que escuta em `127.0.0.1`, uma UI
servida por ele dentro do Electron, terminais em ConPTY e uma CLI. Não há
servidor remoto, conta, nem dado seu saindo da máquina. Este documento diz o que
o Bridge protege, o que ele **não** protege de propósito, e como avisar de uma
falha.

Última revisão de segurança: **0.10.1 (06/09/2026)** — auditoria do monitor de
uso e das superfícies novas desde a 0.8.0, com onda de correção e teste de
ataque por achado. A fase anterior (**0.8.0**, 05/09/2026) cobriu o resto do
app com auditoria, cinco rodadas de correção e re-review adversarial. Os planos
das duas fases e os ledgers de execução
(auditoria, report de correção e rulings) ficam fora do repositório público,
como os das outras fases.

## Versões

O Bridge não tem versões antigas mantidas em paralelo: a correção sai na versão
seguinte, e a única linha suportada é a **mais recente** (hoje, 0.15.0).

## Modelo de ameaça

Seis atacantes considerados, todos com um caminho concreto até o Bridge:

- **A1 — saída hostil de um processo no terminal.** Um agente ou um `cat` de
  arquivo qualquer imprimindo sequências OSC: título, notificação, texto que a
  UI e o toast do Windows vão renderizar.
- **A2 — outro processo local do mesmo usuário.** Lê o `instance.json`, pega o
  token, fala com a API como se fosse a UI.
- **A3 — conteúdo de repositório hostil.** Nome de branch, de worktree e de
  tarefa; `.git/config`, `.gitattributes`, `.gitmodules` e hooks que vieram
  junto num zip, backup ou pendrive.
- **A4 — payload de hook malformado ou hostil.** O shim é chamado pelo agente
  com o que ele quiser: `session_id`, evento, `transcript_path`, tamanho.
- **A5 — cadeia de dependências e instalador.** `npm audit`, e o caminho de
  instalação escolhido pelo usuário chegando numa linha de PowerShell do NSIS.
- **A6 — transcrição hostil.** Um `.jsonl` sob `<claudeHome>\projects` escrito
  por outro processo seu, por um agente rodando dentro de uma sessão, ou
  restaurado de um backup: linha de dezenas de MB, JSON com tipos errados,
  `cwd`/`model` com sequência de terminal ou 10 kB de tamanho, `timestamp` do
  ano 275760, contador de token negativo ou `1e308`, nome de modelo igual a um
  membro de `Object.prototype`, junction apontando pra fora da árvore, milhões
  de arquivos. O monitor de uso (0.10.0) lê esses arquivos sozinho, a cada
  60 s, sem ninguém pedir — é a única superfície do Bridge que trabalha em cima
  de conteúdo que você não digitou.

**O que fica FORA do escopo, declaradamente:**

- **Outro usuário da máquina.** O modelo é **mesmo usuário = mesma confiança**,
  igual ao do próprio Claude Code: quem já roda código com a sua conta pode
  fazer tudo que o Bridge faz, com ou sem o Bridge. A única defesa aqui é a ACL
  do `instance.json` (abaixo), e ela é contra *outro* usuário, não contra você.
- **Rede externa.** O core só escuta em loopback; não há autenticação de
  múltiplos usuários porque não há múltiplos usuários.
- **Ataque físico** à máquina.

**Bens protegidos:** o token da instância; a execução de comandos no PTY
(injeção de comando ou de argumento); os arquivos do usuário (travessia de
caminho em `openPath`, `cwd`, worktrees); a integridade da UI (XSS via dado de
terminal, hook ou git); a disponibilidade do core (DoS por WS, hook ou corpo
grande); a privacidade dos logs (payload de hook com conteúdo de conversa) **e
o conteúdo das suas conversas com o agente**, que o monitor de uso lê e não
guarda (abaixo).

## O que está em pé hoje

**Autenticação e superfície HTTP.** Toda rota exige `Authorization: Bearer` —
a classificação é **default-deny**: o que não for reconhecido como público (a
UI estática do `BRIDGE_UI_DIR`) é tratado como protegido. O caminho é
classificado pela união da forma CRUA com a normalizada, e qualquer `%2F`,
`%5C` ou `\` no caminho é **400** antes de qualquer decisão — separador
codificado não existe em nenhum cliente legítimo. Request-target que não começa
com `/` (forma absoluta, `CONNECT`, `OPTIONS *`) é **400** antes da
classificação: era por ali que o auth foi furado no re-review. `Origin` fora de
loopback é recusado, e `/hooks/*` exige o token sempre.

**Ids por regex.** `sessionId`, evento de hook, `resume` e nomes de ref passam
por regex estrita na entrada (`^[A-Za-z0-9_-]{1,64}$` para ids,
`^[A-Za-z]{1,40}$` para eventos, forma de ref para branch/base) — nada que
comece com `-` chega a virar argumento de processo, e nada com `..` ou barra
chega a virar caminho de arquivo. O **nome da distro** do ambiente de WSL
(0.11.0) entra na mesma disciplina: `isValidDistro` recusa nome vazio, com
caractere de controle ou começando com `-` **antes** de ele virar argumento de
`wsl.exe -d <distro>`. O argv vai separado (nenhuma execução nova passa por
shell), então o que se evita ali não é injeção de comando, e sim injeção de
ARGUMENTO no parser do próprio `wsl.exe` — o mesmo motivo do `--resume`.

**Contenção do git e modelo de confiança nos filtros (A3).** Todo comando git
roda com `-c core.fsmonitor=false -c core.useBuiltinFSMonitor=false
-c core.pager=cat`; as leituras **passivas** (o poller da sidebar, a detecção de
repo) rodam ainda com `core.hooksPath` apontando pra uma pasta vazia do perfil,
com `--ignore-submodules=all`, e com `--` antes de qualquer ref. Os drivers de
`filter.*` **não** são neutralizados — desligá-los quebraria `git-crypt`,
`nbstripout` e `git-lfs` —, são **detectados**: repositório que declara um
driver e ainda não foi confiado não recebe comando que toque conteúdo, a
sidebar mostra **⚠ filtros**, e "Nova tarefa", "Mesclar" e "Remover worktree"
respondem **409 `filters-untrusted`** até você confiar pelo menu do workspace.
A detecção enumera os escopos `--local` e `--worktree` (com `--includes`), na
raiz e em **cada worktree**, e desce nos submódulos — pelos caminhos do
`.gitmodules` (lido com `-z`, então nome com espaço não engana o parser) **e**
pelos gitlinks do índice, com contenção **dupla** de caminho: o declarado
(`path` vazio, absoluto ou com `..` não é seguido) e o **real** — a pasta do
submódulo e o gitdir que o git resolve pra ela (`rev-parse --absolute-git-dir`)
têm que ficar sob o `realpath` do repositório, o que fecha a junction e o `.git`
que é um arquivo `gitdir: <caminho de fora>`. Falha de enumeração conta como
"tem driver" (fail-closed). Detalhes de uso no README, seção "Filtros git e
confiança".

**Guarda de escopo entre worktrees (A3).** O `cwd` de um processo é uma
sugestão, não uma cerca: o agente da tarefa A podia abrir e reescrever um
arquivo do worktree irmão com um caminho absoluto, e ninguém ficava sabendo. O
`PreToolUse` é o único hook do Claude Code que aceita decisão de permissão na
resposta, e é ali que o Bridge julga: `Read`, `Edit`, `Write`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep` e `LS` têm o `file_path`/`notebook_path`/`path`
resolvido contra o `cwd` **da sessão** (com `.`, `..`, barras misturadas e
symlink/junction desfeitos por `realpath`) e comparado com a raiz permitida — o
worktree, num workspace de tarefa; o repositório inteiro, num workspace de repo;
o `cwd`, fora de repositório. Fora dela, a resposta é
`permissionDecision: "deny"` com a razão em pt-BR, e a sessão ganha um contador
com os cinco últimos caminhos (todos por `sanitizeDisplay`, como todo texto que
vem de fora e vai pra tela). UNC e o namespace de dispositivo (`\\?\`, `\\.\`)
são recusados sem comparação, e caminho irresolvível conta como fora
(**fail-closed**). Raiz que sumiu do disco desliga a guarda daquela sessão em
vez de barrar tudo. E a liberação por workspace (`crossAccess`) é **total**,
não "acesso ao worktree irmão": ligada, as sessões daquele workspace voltam a
poder ler e escrever em qualquer lugar do disco, como em qualquer versão
anterior à 0.11.0.

**Contra quem ela existe, e contra quem NÃO existe.** Ela é uma proteção contra
**erro do agente** e contra **conteúdo de repositório hostil** (A3) — um
`CLAUDE.md`, um README ou um comentário de código que instrua o agente a "ler o
arquivo `X` da pasta do lado". Ela **não** é uma barreira contra o dono da
máquina nem contra outro processo dele (A2): quem controla o terminal desliga a
guarda em Configurações → Sessões, libera o workspace pelo menu "⋯"
(`PATCH /api/workspaces/:id { crossAccess: true }`), edita o `config.json` ou
simplesmente roda `git` na mão — e isso é o item 1 dos riscos aceitos, não um
furo. A guarda vale exatamente enquanto o dono quiser que valha, e o botão de
desligar é dele, à vista, no menu.

**O wrapper `claude` de cada shell (0.12.0).** Toda sessão de shell nasce com
uma pasta `bin` dentro da pasta DA SESSÃO, no perfil
(`%APPDATA%\bridge\sessions\<id>\bin`), e essa pasta entra na frente do `PATH`
**só do PTY daquela sessão** — nada é escrito fora do perfil, nenhuma variável
de ambiente do usuário ou da máquina é tocada, e o `PATH` do Windows continua
como estava para todo processo que não nasceu dentro de um painel do Bridge. É a
mesma pasta de perfil que guarda o `instance.json` — com a ressalva de que a ACL
descrita abaixo é aplicada ao ARQUIVO do token, e não à pasta: o que protege o
resto do perfil é a permissão padrão do perfil do usuário no Windows, e o modelo
continua sendo "mesmo usuário = mesma confiança". **A3 não alcança isso**: um
repositório hostil escreve no repositório, não no perfil — e nada do conteúdo do
wrapper vem do repo. O alvo sai do `where.exe` do processo do core; o
`claude.cmd` não cita caminho literal nenhum (o alvo vem do ambiente e o
settings do `%~dp0`), e os wrappers de shell POSIX citam os dois caminhos com o
mesmo `shQuote` (aspas simples) do resto do core. O `settings.json` que o
wrapper passa é o MESMO das sessões de agente, com os mesmos hooks apontando
pro shim.

O alvo do wrapper viaja no ambiente da sessão (`BRIDGE_CLAUDE_BIN`, uma decisão
de codepage: o cmd.exe lê arquivo de lote em OEM e um caminho com acento
gravado ali chega corrompido). Isso quer dizer, dito em voz alta: **qualquer
processo rodando DENTRO daquele shell pode reapontar as chamadas seguintes de
`claude` daquela sessão** — trocando a variável, ou pondo outro `claude` mais à
frente no `PATH`. Isso está **fora** de A2/A3 pelo mesmo motivo do risco 1:
quem já executa código dentro do seu terminal, com a sua conta, não precisa do
Bridge pra fazer isso — ele digitaria o caminho que quisesse. O que o Bridge
garante é o estado INICIAL do shell que ele abriu.

**A promoção por hook (0.12.0).** Desde esta versão, **qualquer POST
autenticado em `/hooks/<sid de uma sessão de shell>/<Evento>` promove aquele
painel a hospedeiro** — a linha passa a dizer `claude`, a sessão passa a contar
no teto de agentes e os hooks seguintes atravessam o adaptador do Claude. É a
MESMA confiança que a rota de hooks já dava às sessões de agente (o token do
`instance.json`, A2), mas a **superfície é maior**: antes só sessões de agente
respondiam a ela, agora todo painel de shell também. Quem consegue chamar já
tem o token, e com o token já podia criar sessão, matar sessão e ler estado —
o dano de uma promoção falsa é uma linha da sidebar dizendo `claude` e um slot
do escalonador ocupado até o shell fechar.

**O `cwd` do payload de hook não alarga a cerca (A4).** Com a guarda de escopo
valendo também para a sessão hospedeira, o `PreToolUse` passou a resolver
caminho RELATIVO contra o `cwd` que vem no payload (a pessoa pode ter dado `cd`
antes de abrir o Claude ali dentro), e não mais só contra o `cwd` da sessão. A
**raiz permitida continua vindo exclusivamente do workspace** — o payload
escolhe de onde o relativo parte, nunca até onde ele pode chegar, então um `cwd`
mentiroso só faz o caminho apontar pra outro lugar, e apontando pra fora da raiz
é recusa como qualquer outro. Só `cwd` absoluto é aceito. Um caminho absoluto
SEM letra de unidade (`/foo`, que é o que uma sessão em WSL escreveria) herda a
unidade do processo do core na resolução do `win32` — o pior caso disso é uma
recusa indevida, nunca uma fuga: a comparação continua sendo contra a raiz do
workspace.

**ACL do `instance.json`.** No Windows, `mode: 0o600` é no-op — não gera ACE
nenhuma. Depois de gravar o arquivo que carrega o token, o core roda
`icacls <arquivo> /inheritance:r /grant:r "<DOMÍNIO\usuário>:(R,W)"`. Se isso
falhar (política de grupo, `icacls` fora do PATH), o core **sobe assim mesmo** —
derrubar o app por causa disso seria pior — mas a falha vira `error` no log,
o campo `instanceAclApplied: false` no estado, e um **banner persistente** na
UI: "Não consegui restringir a permissão do instance.json — outro usuário desta
máquina pode ler o token". O banner só some quando um core seguinte consegue
aplicar a ACL (ou quando você o fecha).

**Limites (DoS).** Corpo de requisição em 1 MiB (Fastify); WS com `maxPayload`
de 1 MiB e no máximo 32 conexões; `resize` entre 1 e 1000 linhas/colunas; texto
de notificação em 2000 caracteres, com limite de 10 notificações por segundo por
sessão e poda periódica do banco (que também alcança as **não lidas** antigas —
uma sessão que despeja OSC e nunca é lida não cresce pra sempre); scrollback com
teto de 512 KB por sessão; leitura de transcript só na cauda (1 MB), recusando
caminho relativo, UNC e arquivo acima de 64 MB.

**UI e toast (A1).** Nada de `dangerouslySetInnerHTML`/`innerHTML` em lugar
nenhum; o texto que vem do terminal é filho de nó React. O toast nativo trunca
título e corpo (200/1000). A UI sai com `Content-Security-Policy`
(`script-src 'self'`, sem `unsafe-inline` e sem `eval`; `object-src`,
`frame-ancestors`, `base-uri` e `form-action` em `'none'`),
`X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`.

**Transcrições: lidas para CONTAR, nunca guardadas (0.10.0).** O monitor de uso
(ADR-012) lê os `*.jsonl` que o Claude Code grava em
`<claudeHome>\projects\**` pra somar tokens. Três garantias, nesta ordem:

- **o que sai da leitura são números.** O parser devolve as quatro contagens de
  token, o id do modelo, o `cwd` da linha e o carimbo de tempo. Texto de
  mensagem, nome de arquivo citado, saída de ferramenta — nada disso é
  extraído, e portanto nada disso pode ser gravado. As tabelas do banco
  (`usage_daily`, `usage_files`, `usage_limits`) não têm coluna de conteúdo;
- **nada sai da máquina.** O core continua escutando só em `127.0.0.1`, e o
  monitor não fala com rede nenhuma: os preços são uma tabela EMBUTIDA no
  pacote, não uma consulta;
- **você escolhe a pasta.** A raiz é `BRIDGE_CLAUDE_HOME` →
  `CLAUDE_CONFIG_DIR` → `~/.claude`, nessa ordem. A variável existe pros testes
  e pro e2e (nenhum teste do repositório lê o `~/.claude` de quem roda a
  suíte) e serve pra apontar o monitor pra outro lugar — ou pra uma pasta
  vazia, se você não quiser que ele leia nada. `claudeHome` aparece em
  `GET /api/config` como **somente leitura**: mudá-lo por API mudaria o que o
  app lê do disco a partir de um pedido HTTP, e essa decisão fica no ambiente.

O que o monitor NÃO protege: ele lê a pasta que a variável aponta, inteira e
recursivamente (até 8 níveis, sem seguir link simbólico — no Windows a junction
de `mklink /J` também é pulada). Se você apontar `BRIDGE_CLAUDE_HOME` pra uma
pasta com `*.jsonl` de outra coisa, ele vai abrir esses arquivos pra procurar
linhas de assistente. Continua valendo o item 1 dos riscos aceitos: quem já
roda código com a sua conta já podia ler tudo isso.

**Transcrição hostil (A6), 0.10.1.** O que o monitor faz com um `.jsonl` que
não veio do Claude Code:

- **linha maior que 4 MiB é PULADA**, contada e avisada uma vez por arquivo. O
  offset SEMPRE avança: antes disso, uma linha maior que a fatia de leitura
  travava aquele arquivo para sempre e sumia, em silêncio, com todo o consumo
  depois dela. E a contagem não fica só no log: quando alguma linha é pulada —
  ou quando a árvore passa do teto de arquivos — o painel "Uso", o
  **Configurações → Uso** e o `bridge usage` escrevem quantas foram e dizem que
  o número mostrado é MENOR que o consumo real;
- **contador de token fora de `[0, 1e12]` conta zero**, e carimbo de tempo fora
  de `[2020-01-01, hoje + 2 dias]` descarta a linha — números de payload não
  entram no banco pelo tamanho que vierem;
- **nome de modelo é consultado com `Object.hasOwn` numa tabela sem protótipo**:
  um `model: "constructor"` não "acha preço" na cadeia de `Object.prototype`
  nem transforma o custo do recorte inteiro em `NaN`;
- **a listagem da árvore é assíncrona**, cede o event loop a cada 500 entradas
  ou 5 ms, e para em 50 000 arquivos com aviso. Numa árvore de 20 000 arquivos
  a maior pausa medida é de 3 a 8 ms, contra os 3,78 s da versão síncrona;
- **todo texto que veio de fora e vai pra TELA passa por um sanitizador só**
  (`sanitizeDisplay`, em `@bridge/shared`): a statusline devolvida ao terminal,
  o `bridge usage`, e os `title`/`aria-label` do painel. Ele remove sequência
  de escape (OSC, CSI, ESC solto), C0/C1, DEL **e os caracteres de formato
  invisíveis do Trojan Source** (`U+202E` e o resto dos bidi, os de largura
  zero, o BOM) — um `cwd` com RLO renderiza um caminho que não é o caminho —,
  colapsa espaço e corta no teto do campo. O `--json` da CLI e o corpo da API
  continuam CRUS de propósito: são dado, não tela;
- **o payload da statusline tem tetos**: no máximo 16 janelas de `rate_limits`,
  chave de janela em 64 caracteres, `resets_at` só dentro de ±10 anos.

**O recap é o segundo consumidor de transcrição hostil (0.11.0).** O monitor de
uso lê o `.jsonl` pra CONTAR; o `recap.ts` lê o mesmo tipo de arquivo pra
extrair TEXTO, e o texto extraído acaba sendo digitado no PTY do agente
restaurado. Duas travas seguram isso:

- **o caminho é conferido contra a raiz de `projects/` mesmo quando o id vem do
  SQLite** (`recap.ts:106` no caminho direto, `recap.ts:117` na varredura de
  pastas): o `agentSessionId` já passou pelo `AGENT_SESSION_ID` do hook antes de
  ser gravado, mas um banco adulterado não pode virar leitura de arquivo
  arbitrário — é a mesma disciplina do dump de hooks;
- **o texto sai em UMA linha, por `sanitizeDisplay`** — por trecho
  (`recap.ts:185`) e de novo no resumo já montado (`recap.ts:222`). É isso que
  impede o ataque específico deste consumidor: um `\n` injetado numa mensagem da
  transcrição viraria um **Enter** no prompt do agente, ou seja, a transcrição
  escolhendo o que o Claude Code executa ao ser retomado. Sem quebra de linha
  não há submissão — sobra texto que o dono lê antes de mandar.

**O que o monitor GUARDA de você (privacidade).** Além de "nada de conteúdo de
mensagem", vale dizer o que É gravado, porque caminho de projeto é dado pessoal
(nome de cliente, nome de produto que ainda não foi anunciado):

- `usage_daily.project` guarda o `cwd` de cada linha de transcrição;
- `usage_files.path` guarda o caminho absoluto de cada `.jsonl` já lido;
- os dois ficam em `%APPDATA%\bridge\bridge.db`, e caminhos de
  transcrição também aparecem em avisos no `%APPDATA%\bridge\logs\core.log`.

Nada disso sai da máquina. Para apagar: esvazie (ou aponte pra outro lugar) a
pasta de transcrições e clique em **Reler transcrições** (`POST
/api/usage/rescan`), ou simplesmente apague o `bridge.db` — ele é derivado, e o
Bridge o reconstrói.

**Instalador (A5).** O caminho de instalação escolhido pelo usuário deixou de
ser interpolado cru na linha do PowerShell: a aspa simples é dobrada antes
(`WordReplace` no `installer.nsh`), e a regra vive como função pura testada.

**Dependências.** `npm audit --omit=dev` e completo: **0 vulnerabilidades** na
0.8.0 (`@fastify/static` foi de 8.3.0 para 10.1.3, fechando quatro advisories,
um deles Alto).

## Riscos aceitos (e por quê)

Nenhum destes é desconhecido: cada um foi medido, discutido e deixado de pé com
motivo. Se algum deles for inaceitável pro seu uso, o Bridge não é a ferramenta.

1. **Qualquer processo seu manda no Bridge.** O `instance.json` é legível pela
   sua conta, e com ele vem o token. É o mesmo modelo do Claude Code, e é a
   consequência direta de "mesmo usuário = mesma confiança". Não há defesa
   possível que não seja teatro.
2. **Driver de filtro na config GLOBAL ou de SISTEMA.** A detecção enumera só o
   que é do repositório (`--local`, `--worktree` e os submódulos). Um driver no
   seu `~/.gitconfig` não aparece — e nem deveria: aquilo é você configurando a
   sua máquina, não um repositório trazendo comando de fora.
3. **`--ignore-submodules=all` esconde sujeira de submódulo.** Foi o preço de
   impedir que o `status` do superprojeto descesse no submódulo (onde pode
   haver driver invisível): **submódulo com alteração não commitada deixa de
   contar no `~M`** da sidebar.
4. **Leitura de `*.jsonl` arbitrário pelo `transcript_path`.** (Este é o hook;
   a varredura do monitor de uso é outra coisa e está descrita acima.) O payload de
   hook (A4) escolhe qual transcript ler; o Bridge exige caminho absoluto com
   letra de unidade, extensão `.jsonl`, arquivo abaixo de 64 MB, e lê só o
   último 1 MB. Ainda assim é um arquivo escolhido por quem chamou o hook —
   quem chama o hook é o agente que **você** abriu, com a **sua** conta.
5. **Token no query string do `/ws` e do shim.** Trocar por header mudaria o
   contrato de UI, shell, CLI e shim de uma vez. A auditoria mediu que o token
   não vaza: o Fastify sobe com `logger: false`, nenhuma chamada de log carrega
   URL ou token, e o canal é loopback sem proxy.
6. **`LOOPBACK_ORIGIN` aceita qualquer porta de loopback.** Uma página servida
   por você mesmo em `http://127.0.0.1:<outra porta>` passa no teste de origem —
   mas continua precisando do **token**, que ela não tem. A regex é ancorada
   (`http://localhost.evil.com` é recusado).
7. **Token no `localStorage` no modo web de desenvolvimento.** No Electron —
   que é o produto — o token vem pelo `preload` e nunca toca `localStorage` nem
   a URL. Vale só pra quem roda a UI no Vite à mão.
8. **Fuses do Electron ainda não aplicados.** `RunAsNode`,
   `EnableNodeCliInspectArguments`, `EnableEmbeddedAsarIntegrityValidation` e
   `OnlyLoadAppFromAsar` exigem o pacote `@electron/fuses`, que não está no
   lockfile — e a fase de segurança rodou sob a regra de **não** instalar
   dependência nova. Está registrado no backlog interno do dono, aguardando autorização. Sem os
   fuses, quem já pode rodar programa com a sua conta pode usar o `Bridge.exe`
   como um Node genérico (`ELECTRON_RUN_AS_NODE`) — o que, de novo, é o item 1.
9. **Sem rate limit genérico de rota.** `POST /api/tasks` em laço cria
    worktrees até o disco acabar. Quem consegue chamar já tem o token (A2). O
    único caminho **sem** token (notificação por OSC, A1) tem limite próprio.
    A exceção é `POST /api/usage/rescan`, que ganhou limite próprio na 0.10.1
    (**409** com uma releitura em voo, **429** dentro de 30 s da última): o
    custo dele é proporcional ao seu HISTÓRICO inteiro, não ao pedido. Desde a
    0.11.0 a fila do escalonador tem teto próprio: `POST /api/sessions` de
    agente acumula no máximo **64** pendentes e responde **429
    `queue-full`** depois disso — a fila é de memória, e crescer sem teto seria
    trocar o custo de subir agentes pelo custo de guardá-los.
10. **Hooks do git rodam nas ações que você pede.** `worktree add` e `merge`
    executam os hooks do repositório — é o comportamento contratado do git, e
    desligá-los quebraria o fluxo de quem tem hook legítimo. O caminho
    **passivo** (o poller, que roda sozinho a cada 15 s) é que foi fechado.
11. **`bridge usage --json` mostra os seus caminhos de projeto.** É JSON, é
    local, e quem roda o comando é você. O caminho HUMANO do mesmo comando sai
    sanitizado e cortado; o `--json` sai cru porque é o corpo da rota.
12. **`usage.pricingFile` lê um arquivo que VOCÊ apontou.** Desde a 0.10.1 ele
    exige `.json`, arquivo regular e no máximo 1 MiB, e qualquer falha vira um
    aviso genérico — sem trecho do conteúdo, sem nome de chave e sem o caminho,
    em lugar nenhum (resposta, tela ou log). O que sobra é o que você mesmo
    configurou.
13. **Contagem menor que a real numa transcrição fora do padrão.** Linha maior
    que 4 MiB é pulada de propósito (a alternativa era travar a leitura daquele
    arquivo para sempre). O painel, o `bridge usage` e o **Configurações → Uso**
    dizem quantas foram, e o `core.log` diz de qual arquivo — mas o consumo
    daquelas linhas não é recuperado.
14. **O aviso do `pricingFile` conta as entradas inválidas.** Ele diz "N
    entradas ignoradas" e nunca o nome delas, justamente pra não virar um
    oráculo das chaves do arquivo apontado — mas a CONTAGEM ainda é um bit de
    informação sobre um arquivo que você escolheu. É o preço de avisar que a
    sua tabela de preços tem erro.
15. **O teto do `pricingFile` é verificado antes da leitura (`stat` → `read`).**
    Entre as duas chamadas o arquivo pode ser trocado por outro; quem consegue
    fazer isso já roda código com a sua conta (item 1). O que a trava fecha é o
    caminho acidental e o alvo escolhido pelo payload, não uma corrida de quem
    já está dentro.
16. **O teto de 50 000 arquivos corta por ordem de caminhada, não por data.**
    Numa árvore acima do teto, o que fica de fora é o fim da varredura
    alfabética, e não o mais antigo. O painel avisa que a lista foi cortada; a
    saída é apontar `BRIDGE_CLAUDE_HOME` pra uma árvore menor.
17. **A guarda de escopo não cobre o `Bash`.** Um comando de shell não declara
    caminho — declara texto, e o alvo depende do `cwd`, do `PATH`, de variáveis
    e do shell. Julgar caminho dentro de string de comando erraria nos dois
    sentidos (o `..` de um `--exclude=../x` viraria recusa; um
    `powershell -EncodedCommand` passaria batido), e uma guarda que erra nos dois
    lados ensina o dono a desligá-la. Vale o mesmo pro `pattern` do `Glob`/`Grep`
    (é padrão de busca, e o resultado já é filtrado pelo `path`) e pro que
    acontece DEPOIS da decisão: a guarda julga o que a ferramenta DECLARA, não o
    que o processo faz — um `Read` aprovado que siga um symlink criado entre a
    decisão e a leitura é a mesma corrida do item 15, e quem consegue fazer isso
    já roda código com a sua conta (item 1).
18. **A guarda de escopo não cobre sessão de WSL.** Num workspace com ambiente
    `wsl:<distro>` o agente roda DENTRO da distro e declara caminho POSIX
    (`/mnt/d/repo/.worktrees/a/x.ts`), enquanto a raiz permitida gravada no
    workspace é caminho do Windows. São dois espaços de nomes diferentes: no
    `win32`, `resolve` gruda o `/mnt/d/…` na unidade do `cwd` e o `realpath`
    sobe até a raiz dela, então comparar um contra o outro recusaria **toda**
    ferramenta com caminho — inclusive a leitura do arquivo da própria tarefa.
    Na 0.11.0 a guarda simplesmente **não se aplica** a esses workspaces: sem
    `deny`, sem contador, sem selo 🛡, e o menu "⋯" não oferece "Permitir acesso
    fora do worktree" (não há cerca pra liberar). É o mesmo estado da 0.10.x
    para essas sessões. O conserto óbvio — traduzir a raiz pro espaço POSIX e
    comparar lá — não entrou porque sem `realpath` **dentro** da distro ele
    reabriria o desvio por symlink que a guarda existe pra fechar, e proteção
    falsa é pior que limite declarado. O follow-up (raiz e `cwd` traduzidos no
    lançamento, pelo `resolveEnvContext`) está registrado no backlog interno do dono.

19. **O `claude` de um shell do Bridge é reapontável de dentro do próprio
    shell.** O wrapper chama o alvo que está em `BRIDGE_CLAUDE_BIN`, e essa
    variável (como o `PATH`) é do processo do shell — quem roda comando lá
    dentro troca as duas. É o item 1 outra vez, do lado do terminal: quem digita
    no seu shell já escolhe o que executar. O que o wrapper garante é que o
    `claude` que a SESSÃO abriu nasceu com o `--settings` do Bridge.
20. **A rota de hooks promove painel de shell (0.12.0).** Um POST autenticado em
    `/hooks/<sid>/<Evento>` numa sessão de shell marca o painel como hospedeiro
    e ocupa um slot do teto de agentes até o `SessionEnd` ou até o shell fechar.
    Não há heartbeat: um Claude morto com `taskkill`, sem `SessionEnd`, deixa a
    sessão marcada como hospedeira. É estado de tela e de contador, não de
    permissão — nenhuma rota nova fica acessível por causa disso —, e quem
    consegue chamar já tem o token (item 1). Está registrado no backlog interno do dono.
21. **O token do Bridge está no ambiente de TODO PTY do Bridge.** `BRIDGE_TOKEN`,
    `BRIDGE_PORT` e `BRIDGE_SHIM` entram no env de cada sessão (é assim que o
    `bridge` da CLI e o shim de hook sabem com quem falar), então qualquer
    processo aberto num terminal do Bridge — inclusive o `claude` hospedado e
    tudo que ele executa — pode chamar a API inteira com a sua autorização. É o
    item 1 dentro do terminal: precede a 0.12.0, a CLI depende disso, e tirar as
    variáveis desligaria o `bridge` de dentro do painel sem fechar nada (quem
    está no terminal lê o `instance.json` do mesmo jeito).

## Verificações manuais que faltam

Estas não dá pra automatizar aqui, e estão registradas no backlog interno do dono:

- **Instalador em caminho com aspa simples.** Instalar em algo como
  `C:\Programas\O'Brien\Bridge` e conferir que a instalação termina, que o PATH do
  usuário recebeu `...\resources\cli` com o tipo intacto (`REG_EXPAND_SZ`) e
  que a desinstalação desfaz só isso. O escape está testado como função pura; o
  instalador rodando, não.
- **Escape do toast nativo do Windows.** O toast é montado pelo Electron
  (`new Notification`), que gera o XML do Windows internamente. Que ele escapa
  o título e o corpo não foi verificado por experimento — só o truncamento
  (200/1000 caracteres) e o teto de ~4 KB do scanner de OSC.
- **CVEs do Electron 44.1.1** — não verificado online na sessão da auditoria.

## Como reportar uma falha

Se você achou algo, **não abra issue pública com o passo a passo**. Escreva
para `<e-mail do autor>` ou abra uma **issue privada** (security advisory) no
repositório. Inclua: versão do Bridge, o passo a passo mínimo pra reproduzir, o
que você conseguiu fazer com isso, e qual dos atacantes acima descreve a sua
posição (ou por que ele não está na lista).

Não há programa de recompensa. O que existe é resposta: um projeto de uma pessoa
só, num app local, respondendo o mais rápido que der.
