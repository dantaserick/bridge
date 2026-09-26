# Bridge

> **English:** [`README.md`](README.md).

Um app de desktop para Windows que roda **vários agentes de código lado a
lado**. Cada sessão do Claude Code vive num painel de terminal, o Bridge lê os
*hooks* dela e mostra numa sidebar o que cada uma está fazendo — pensando,
esperando permissão, terminou, travou — e avisa por toast nativo quando uma
precisa de você. É a resposta Windows ao [cmux](https://github.com/manaflow-ai/cmux),
que só existe no macOS.

![Demonstração: os agentes mudam de estado na sidebar, a tarefa termina, outra pede permissão e o painel de uso abre](docs/img/demo.gif)

O que ele faz, em uma linha cada:

- **Sidebar com estado por sessão** — anel colorido por agente, última
  notificação, e a faixa de cota: contexto, modelo, custo e as janelas de 5 h e
  semana, tudo do payload que o Claude Code manda pra statusline.
- **Workspaces com abas e splits** — vários terminais por pasta, layout
  persistente, atalhos de teclado pra tudo.
- **Integração real com o Claude Code** — um `settings.json` por sessão em que
  todos os hooks e a statusline apontam pra um shim HTTP local; nada de parsear
  a tela do terminal.
- **Uma tarefa = um `git worktree`** — branch e worktree criados juntos,
  `+N ~M` na sidebar, merge e remoção pelo menu.
- **CLI `bridge`** — `list`, `notify`, `send`, `open`, `resume`… O agente pode
  chamar `bridge notify "terminei"` de dentro da própria sessão.
- **Retomar onde parou** — ao reabrir, cada painel volta com
  `claude --resume <id>` da conversa que estava ali.

Tudo é local: o core escuta só em `127.0.0.1`, com token por instância, e nada
sai da máquina.

## Pra quem é

Pra quem trabalha no Windows com agentes de linha de comando e cansou de
perder o fio entre cinco terminais abertos. Se você roda duas ou três sessões
do Claude Code ao mesmo tempo, alterna entre elas o dia inteiro e quer saber
qual delas parou pra pedir permissão sem ficar olhando uma por uma, é isso.

Não é: um editor, um serviço em nuvem, nem um app multiusuário. É uma
ferramenta de uma pessoa, na máquina dela.

## Telas

As telas são da versão pública rodando com dados de demonstração: os
projetos são fictícios e os "agentes" só disparam os hooks do Claude Code.

![O Bridge com três projetos, uma tarefa em worktree e agentes rodando, pedindo permissão, travado e prontos](docs/img/bridge.png)

| Notificações | Nova tarefa (worktree) | Configurações |
|---|---|---|
| ![Painel de notificações](docs/img/notificacoes.png) | ![Diálogo de nova tarefa](docs/img/tarefa.png) | ![Configurações](docs/img/configuracoes.png) |

## Requisitos

- **Windows 11** (x64). Não foi testado em Windows 10 nem em outros sistemas.
- **Node.js 22 ou mais novo, no `PATH`.** O core roda como processo Node
  separado e o instalador **não** embute um Node. Sem ele, o app abre um
  diálogo dizendo exatamente isso.
- O agente que você for usar instalado por conta própria — hoje o adaptador
  testado é o do **Claude Code** (`claude` no `PATH`).

## Instalar

O instalador sai em **[GitHub Releases](https://github.com/dantaserick/bridge/releases)**:
baixe o `Bridge Setup <versão>.exe` da release mais recente e execute.
Instalação por usuário (nada de administrador), com escolha da pasta; a pasta
da CLI entra no `PATH` da sua conta automaticamente.

> **Aviso do SmartScreen.** O instalador **não é assinado** (certificado de
> code signing é caro e este é um projeto pessoal), então o Windows mostra uma
> tela azul dizendo "O Windows protegeu o computador" / "editor desconhecido".
> Para continuar: **Mais informações → Executar assim mesmo**. Se preferir não
> confiar num binário sem assinatura — o que é uma posição legítima —, compile
> do código-fonte (logo abaixo): o resultado é o mesmo `.exe`.

Confira o download comparando o SHA-256 publicado na release:

```powershell
Get-FileHash "$HOME\Downloads\Bridge Setup 0.15.0.exe" -Algorithm SHA256
```

## Compilar do código-fonte

```
git clone https://github.com/dantaserick/bridge
cd bridge
npm install
npm run dist
```

O instalador aparece em `packages\shell\release\`. Para só rodar sem
empacotar, `npm run dev:app` sobe o Electron com o core e a UI buildada. Os
detalhes de build, empacotamento e teste estão em
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

**0.15.0 — pré-release.** É o que o autor usa todo dia, na máquina dele, e
funciona; mas é uma versão pública recente, sem instalador assinado e sem
bateria de testes em máquinas de outras pessoas. Espere arestas, e abra uma
issue quando encontrar uma.

O que cada versão entregou está no [`CHANGELOG.md`](CHANGELOG.md) — de 0.1.0
(núcleo e status) até 0.15.0, passando pela 0.13.0 (**o app
inteiro em português ou em inglês**, com a troca valendo na hora), pela
0.12.2 (a sidebar com todos os workspaces abertos, o selo 🛡 que some ao liberar o acesso e a linha de status
fora do terminal), pela 0.12.1 (a restauração que sobrevive a uma morte não
limpa do app), pela 0.12.0 (o Claude Code aberto dentro de um shell,
reconhecido como agente na sidebar) e pela 0.11.0 (as quatro dores
verificadas de quem usa o Claude Code: o limite do servidor e o escalonador, o
ambiente da sessão por workspace, o resume que volta vazio e a guarda de escopo
entre worktrees).

Licença: [FSL-1.1-MIT](LICENSE) — pode usar, modificar e usar no trabalho à vontade; só não pode oferecer o Bridge (ou algo equivalente feito a partir dele) como produto comercial concorrente. Cada versão vira MIT dois anos depois de publicada. A documentação é em português — há um resumo em inglês
em [`README.md`](README.md) —, mas **o app em si fala os dois idiomas**
desde a 0.13.0: `Ctrl+,` → Aparência → Idioma (ver "Idioma").

---

O resto deste arquivo é a documentação técnica: como cada parte funciona, as
rotas, os atalhos, a CLI e o troubleshooting.

## Arquitetura em três processos

Pacotes: `packages/core` (o servidor), `packages/shared` (tipos e protocolo),
`packages/ui` (React + xterm) e `packages/shell` (o app Electron). Um **core**
local (Fastify + node-pty + SQLite) é dono das sessões e do estado; a **UI**
fala com ele por HTTP (`/api/*`) e WebSocket (`/ws`); o **shell** Electron
adiciona janela, toast nativo e bandeja. A UI roda tanto no
Vite dev server (com proxy pro core) quanto servida pelo próprio core dentro do
Electron. Ver `docs/adr/001-electron-sobre-core-node.md`. O modelo de ameaça, as
proteções em pé e os riscos aceitos estão em [`SECURITY.md`](SECURITY.md).

## Rodar só o core + a UI no browser (sem Electron)

1. Instalar as dependências na raiz (workspaces): `npm install`.
2. Subir o core: `npm run dev:core` — ele escreve o token em
   `%APPDATA%\bridge\instance.json` e imprime a porta (padrão `4560`).
3. Em outro terminal, subir a UI: `npm run dev:ui` — Vite sobe em
   `http://127.0.0.1:5173` e faz proxy de `/api` e `/ws` pro core (`/hooks` não
   passa pelo Vite: é rota só do shim local).
4. Abrir `http://127.0.0.1:5173` no browser. Colar o token de
   `%APPDATA%\bridge\instance.json` na tela inicial e clicar "Conectar".
5. Clicar "Novo workspace" e apontar pra uma pasta de código (`C:\projetos\meu-repo`).
6. No workspace criado, clicar "＋ Claude" — deve aparecer uma sessão com
   anel `idle`. Mandar um prompt qualquer no terminal: o anel deve virar
   `running` com o `detail` mostrando a tool em uso, e depois `done` (com
   toast, se "Ativar avisos" tiver sido clicado e a permissão concedida).
7. Clicar "＋ shell" no mesmo workspace e confirmar que abre um shell comum
   (sem `BRIDGE_SESSION` de agente — não reage a hooks).
8. Para exercitar `needs-input` de verdade: no terminal do Claude, pedir uma
   ação que exija permissão (ex.: rodar um comando fora do allowlist) e
   confirmar que o anel vira `needs-input` (pulsando) até a permissão ser
   respondida no próprio terminal.

É o caminho mais curto pra ver o core funcionando sem empacotar nada.

## App Electron (`packages/shell`, Fase 2)

O shell **não** embute o core: `node-pty` e `better-sqlite3` precisariam de
rebuild pro ABI do Electron, o que quebraria a suíte do core (que roda no Node
do sistema). O main lança o core como **processo Node filho**
(`BRIDGE_NODE` ou o `node` do PATH), descobre porta e token lendo
`instance.json` do perfil, e passa o token pro renderer pelo preload
(`window.bridge.token()`) — nunca pela URL. A UI vem de
`http://127.0.0.1:<porta>` (o próprio core serve o build estático); `file://`
está fora de questão, o `/ws` recusa essa origem.

- **Dev** — `npm run dev:ui` num terminal (o Vite **tem que estar de pé**: o
  shell não sobe ele) e `npm run dev:app` em outro. A janela carrega
  `http://127.0.0.1:5173`.
- **Como fica empacotado** — `npm run build:ui` e depois
  `npm run dev -w @bridge/shell` sem `BRIDGE_DEV`. A janela carrega
  `http://127.0.0.1:<porta>/`, servida pelo core a partir de
  `packages/ui/dist` (ou de `BRIDGE_UI_DIR`).
- Fechar a janela encerra o core e as sessões: primeiro `POST /api/shutdown`
  (encerramento gracioso, 1,5 s de prazo — é ele que mata as sessões, apaga o
  `instance.json` e grava a última leva de log) e, se o core não sair sozinho,
  `taskkill /t /f` na árvore. O log do shell fica em
  `%APPDATA%\bridge\logs\shell.log` (5 MB, rotaciona pra `shell.log.1`); o do
  core, em `core.log` ao lado (5 × 5 MB).
- Se o app abrir e encontrar um core do mesmo perfil **ainda de pé** (a janela
  foi fechada à força e os agentes continuaram), ele **adota** esse core —
  mesma porta, mesmo token, sessões intactas — desde que a API responda em
  2 s. Não respondendo, a árvore é morta e um core novo sobe.
- Se o core cair nos primeiros 30 s, o shell tenta uma vez mais; na segunda
  falha mostra um diálogo e encerra. Sem Node no PATH, a mensagem é
  "Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=&lt;caminho&gt;)".

## Como buildar e empacotar

Requer **Node.js 22+ no PATH** — inclusive na máquina onde o Bridge for
instalado: o core roda como processo Node separado (ver acima), então o
instalador **não** carrega um Node embutido. Sem Node, o app abre um diálogo
dizendo "Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=&lt;caminho&gt;)".

```
npm install          # na raiz (workspaces)
npm run build        # UI (Vite) + core (esbuild -> dist/index.mjs) + CLI + shell (esbuild)
npm run dist         # build + stage das deps do core + electron-builder (NSIS x64)
```

O `npm run dist` deixa em `packages/shell/release/`:

- `Bridge Setup 0.9.0.exe` — instalador NSIS (~120 MB), por usuário, com
  escolha da pasta de instalação e a pasta da CLI indo pro PATH do usuário
  (`installer.nsh` — ver "CLI `bridge`" mais abaixo);
- `win-unpacked/Bridge.exe` — o app já expandido, útil pra testar sem instalar.

O ícone do instalador/`.exe` (`packages/shell/build/icon.ico`, 16 a 256 px) é
o `BridgeMark` de `packages/ui/src/components/icons.tsx` sobre um quadrado
arredondado `--bg-elevated`, gerado por `packages/shell/scripts/make-icon.mjs`
— sem dependência nova, distância-a-segmento pura (`src/iconMark.ts`) + PNG
via `zlib` (`src/png.ts`), a mesma marca do tray (`src/tray.ts`) e do favicon
da UI (`packages/ui/index.html`). Já vem gerado no repo; só rodar de novo
(`npm run build -w @bridge/shell && node scripts/make-icon.mjs`) se a marca
mudar — é idempotente.

Dentro do app, o core vive **fora** do `asar`, em `resources/`:
`core/dist/index.mjs` (bundle do core, sem `tsx`), `core/bin/bridge-hook.cjs`
(o shim dos hooks), `core/node_modules/` (só as dependências de runtime), `ui/`
(o build do Vite, que o core serve em `/`) e `cli/` (`bridge.cjs` +
`bridge.cmd`, o binário da linha de comando). Os módulos nativos (`node-pty`,
`better-sqlite3`) ficam com os prebuilds do **Node do sistema** — nada de
`@electron/rebuild` aqui.

A árvore empacotada é **reprodutível**: `packages/shell/scripts/stage-core.mjs`
instala com `npm ci` a partir do par versionado
`packages/shell/stage/core.package.json` + `core.package-lock.json`, então as
transitivas não são re-resolvidas a cada build. Depois de mexer nas
`dependencies` do `packages/core` (ou de um `npm update` na raiz), regrave esse
par — senão o próximo `npm run dist` falha dizendo exatamente isso:

```
npm run stage:refresh-lock -w @bridge/shell
```

`node packages/shell/scripts/stage-core.mjs --help` lista as duas flags sem
montar nada — a ajuda sai antes de o script apagar o `.stage/core`, então um
comando digitado errado não custa o stage.

## Tarefa = worktree (Fase 3)

Uma **tarefa** é um `git worktree` mais o workspace que vive dentro dele. O
worktree nasce sempre em `<repo>/.worktrees/<nome>`, num branch com o mesmo
nome; `.worktrees/` entra no `.git/info/exclude` do repo (idempotente, e nunca
no `.gitignore`: o Bridge não altera arquivo versionado do usuário). O nome é
normalizado igual nos dois lados (`normalizeTaskName`, em `packages/shared`):
minúsculas, só `[a-z0-9._-]`, espaço vira `-`, 1–60 caracteres — "Mailbox do
Chefe!" vira o branch `mailbox-do-chefe`.

**O fluxo.** `Ctrl+Shift+Alt+N` (ou "Nova tarefa" no rodapé da sidebar) abre o
diálogo: repositório (a lista de `GET /api/repos`, os repos que o Bridge já viu,
mais "Escolher pasta…"), nome da tarefa com o branch previsto embaixo, base
(default = a branch atual do repo) e "Subir Claude Code no primeiro painel",
marcado. Enter cria o worktree, o workspace, a aba, o painel e — se pedido — a
sessão do agente já dentro da pasta nova. Se o Claude não subir, a **tarefa
continua existindo** (o core devolve `201` sem `session`) e o rodapé avisa:
tentar de novo criaria uma segunda tarefa.

**Na sidebar.** A linha do workspace mostra a branch e, quando é tarefa, dois
indicadores: `+N` = commits à frente da base (`git rev-list --count
<base>..HEAD`) e `~M` = linhas de `git status --porcelain --untracked-files=all`
(`~M > 0` sai em âmbar). Os números vêm do core — a UI nunca calcula git — e são
recalculados a cada `gitPollSeconds` (`config.json`, default 15 s) **enquanto a
janela estiver visível com a UI conectada** — um cliente do `/ws` que receba
`workspace.git` (o processo main do Electron filtra esse prefixo e não conta) e
um `POST /api/focus` com `windowFocused: true` nos últimos 60 s. Fora disso o
core não lança `git` nenhum. Há refresh imediato quando uma sessão daquele
workspace dá `Stop` e quando a tarefa é criada.

A branch mostrada é a do **disco** (vem do `GitStatus` do core): trocar de
branch dentro do worktree pelo terminal aparece na sidebar no próximo poll, e é
esse branch que "Mesclar no base" e "Remover worktree" usam. Worktree cuja
pasta sumiu do disco mostra **"(pasta sumiu)"** e o menu fica só com "Fechar
workspace".

**Base deduzida.** Tarefa criada pelo Bridge sabe seu base (é o `base` do
`worktree add`). Um worktree **adotado** — a pasta já existia quando você abriu
o workspace — não: o base sai do upstream do branch (`origin/main`) e, se não
houver, do branch corrente do repo principal, marcado como **"(base deduzida)"**
no tooltip e nas confirmações. O menu "⋯" tem **Definir base…** pra corrigir
(`PATCH /api/workspaces/:id/worktree`, que recusa um ref que não existe).

**O menu "⋯"** da linha (aparece no hover e no foco):

- **Ver diff** — abre `git --no-pager diff <base>...HEAD` num painel livre do
  workspace (dividindo o focado se não houver nenhum). É um shell comum com
  `initialCommand`: depois de ler o diff você continua no prompt.
- **Mesclar no base** — `--ff-only` primeiro; se não for fast-forward, o core
  responde `409 { code: 'not-ff' }` e a UI pergunta se pode fazer merge com
  commit (`no-ff`, mensagem `Merge task/<branch>`). Some quando o worktree está
  em checkout destacado (branch `HEAD`).
- **Remover worktree** — apaga a pasta e o branch (`git worktree remove` +
  `git branch -d`).
- **Definir base…** — troca o base do worktree por outro ref (útil quando ele
  foi deduzido).
- **Abrir no Explorer** e **Fechar workspace** (esta só tira da tela; não mexe
  no disco).

### As recusas (spec §7/§10)

O Bridge não desfaz trabalho sem avisar. Toda recusa vem com
`{ error, code, detail? }` e o texto inteiro vai pra faixa de status. `409` é o
estado do repo que o usuário resolve; `422` é o pedido que o git não conseguiu
executar:

**O `code` é o contrato** — a UI e a CLI decidem por ele, nunca pelo texto nem
pelo `detail` (que é só apoio humano: o `--porcelain` do worktree sujo, o nome
do branch em que o principal está). O `stderr` cru do git, quando houve, entra
na mensagem.

| Ação | HTTP | `code` | Quando | O que fazer |
|---|---|---|---|---|
| Mesclar | 409 | `dirty-base` | o worktree PRINCIPAL tem alteração não commitada | commitar ou guardar antes (o Bridge não faz stash) |
| Mesclar | 409 | `base-not-checked-out` | o repo principal está em outro branch | fazer `git checkout <base>` você mesmo — o Bridge **não** troca o checkout do seu repo |
| Mesclar | 409 | `base-in-use` | o base está com checkout em OUTRO worktree | fechar aquele worktree, ou mesclar por lá |
| Mesclar `ff-only` | 409 | `not-ff` | a base andou desde que a tarefa nasceu | aceitar o merge com commit que a UI oferece |
| Mesclar `no-ff` | 409 | `conflict` | conflito | o core dá `merge --abort` e devolve o repo como estava; resolver no terminal |
| Remover | 409 | `dirty-worktree` | o worktree tem arquivo alterado/novo | commitar ou descartar (o `detail` lista o `--porcelain`) |
| Remover | 409 | `not-merged` | o branch não aparece em `git branch --merged <base>` | mesclar antes, ou apagar o branch à mão |
| Criar tarefa | 409 | `exists` | já existe a pasta ou o branch com esse nome | outro nome |
| Criar tarefa | 422 | `no-commits` | o repositório não tem nenhum commit | fazer o primeiro commit (um `worktree add` não tem de onde partir) |
| Criar tarefa | 422 | `not-a-repo` / `invalid-name` | a pasta não é repo, ou o nome fica vazio/inválido depois de normalizar (`..` no meio e nomes reservados do Windows — `con`, `nul`, `com1`… — são recusados) | escolher outra pasta / outro nome |
| Definir base | 422 | `unknown-ref` | o ref digitado não existe no repo | conferir o nome (`git branch -a`) |

As duas recusas da remoção são checadas **antes** de qualquer coisa
irreversível — o core só mata as sessões do workspace depois de saber que a
remoção vai passar. Fora de escopo, de propósito: PR/GitHub, stash automático e
rebase.

## Guarda de escopo entre worktrees

Duas tarefas do mesmo repositório rodam em `.worktrees/a` e `.worktrees/b`. O
`cwd` do processo é uma **sugestão**, não uma cerca: nada impede o Claude Code
da tarefa A de abrir — e reescrever — um arquivo de B com um caminho absoluto.
O isolamento do `git worktree` existe pro git; pro agente, não existia. A
guarda de escopo é essa cerca, e ela mora onde o Bridge já estava: no hook.

**Como funciona.** O `PreToolUse` é o único hook do Claude Code que aceita uma
decisão de permissão na resposta. A cada chamada de ferramenta o Bridge resolve
o caminho declarado e, se ele cair fora da raiz da sessão, responde:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Bridge: fora do worktree desta tarefa (…)…" } }
```

O texto inteiro que o agente recebe é:

> Bridge: fora do worktree desta tarefa (`<caminho>`). Esta sessão só pode ler e
> escrever dentro de `<raiz>`. Libere em ⋯ → "Permitir acesso fora do worktree".

Num workspace de repositório a redação muda pra "fora do repositório deste
workspace"; num workspace fora de repo, "fora da pasta deste workspace" — e o
item citado no fim vira "Permitir acesso fora do repositório", que é o rótulo
que o menu desenha nesses dois casos. A frase nomeia o item de menu EXATO de
propósito: quem lê a recusa é o agente, e é ele quem vai repeti-la pra você;
mandar procurar um item que não existe no "⋯" seria pior que não dizer nada.
Quando a recusa é de um caminho UNC, entra também a frase "Caminhos UNC e `\\?\` são
sempre recusados". A razão é escrita **pro agente ler**, porque é ele quem vai
relatar isso na conversa — daí ela dizer onde a sessão está presa e por onde
você libera.

**Qual é a raiz.** Workspace de **tarefa** → a pasta do worktree (o isolamento
que você pediu ao criar a tarefa). Workspace de **repositório** (a raiz, sem
worktree) → o **repositório inteiro**: quem abre o repo na raiz está trabalhando
no repo, e cercá-lo no `cwd` de um painel seria uma cerca que ninguém pediu.
Workspace fora de repositório → o `cwd` dele. Raiz que sumiu do disco (unidade
desconectada) **desliga** a guarda daquela sessão em vez de barrar tudo — "não
sei" não pode virar "nega tudo".

**O que é julgado**, e só isso: `Read`, `Edit`, `Write`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep` e `LS`, pelos campos `file_path`, `notebook_path`
e `path` do `tool_input`. O `pattern` do `Glob`/`Grep` **não** entra: ele é
padrão de busca, não caminho, e o resultado dele já é filtrado pelo `path`.

**O `Bash` NÃO é barrado**, de propósito. Um comando de shell não declara
caminho: declara texto (`npm test`, `git log -- ../outro`, um pipeline com
`cd`), e o alvo real depende do `cwd`, do `PATH`, de variáveis e do próprio
shell. Julgar caminho dentro de string de comando erraria nos dois sentidos ao
mesmo tempo — falso positivo (todo `..` de um `--exclude=../x` viraria recusa, e
um `npm test` legítimo pararia de rodar) e falso negativo (um
`powershell -EncodedCommand` passaria batido) —, e uma guarda que erra nos dois
lados ensina você a desligá-la. O `SECURITY.md` diz isso com todas as letras.

**Como o caminho é resolvido**, antes de qualquer comparação: relativo resolve
contra o `cwd` **da sessão**; `.`, `..` e a mistura de `/` com `\` somem;
symlink e junction são desmascarados por `realpath` — inclusive num arquivo que
ainda **não existe** (a resolução sobe até o primeiro ancestral que o disco
conhece, senão todo `Write` de arquivo novo seria barrado). Caminho **UNC**
(`\\servidor\share`) e o namespace de dispositivo (`\\?\`, `\\.\`) são
reprovados sem comparação nenhuma: o `\\?\` desliga a normalização do próprio
Windows, então comparar prefixo ali daria uma resposta que o sistema de arquivos
não honra — e um caminho de rede nunca está dentro de um worktree local. Caminho
que não resolve de jeito nenhum conta como **fora**: a guarda é fail-closed. A
própria raiz conta como dentro (o `LS` do worktree é legítimo), e a comparação
ignora caixa no Windows.

**O selo 🛡.** A recusa é respondida pro agente, que segue em frente sozinho;
sem sinal na tela você só descobriria pelo comportamento estranho do Claude. A
linha da sessão na sidebar ganha um selo azul **🛡 N** — `N` é o total de
recusas daquela sessão — e o tooltip lista os **cinco últimos** caminhos, do
mais recente pro mais antigo, depois da frase "A guarda de escopo barrou estes
caminhos (fora da raiz desta sessão). Libere em ⋯ → Permitir acesso fora do
worktree." O selo acumula enquanto a guarda vale: ele não some quando a sessão
volta ao normal, porque a tentativa aconteceu. **Liberar o workspace apaga o
selo** (0.12.2): ao ligar "Permitir acesso fora do worktree", o core zera o
contador das sessões daquele workspace e a linha volta ao normal — o selo
descreve uma cerca, e a cerca deixou de existir. Restringir de novo não repõe
o número: ele recomeça do zero na primeira recusa nova (o histórico de cada
recusa fica no log do core, não neste contador). Todo caminho passa por
`sanitizeDisplay` antes de chegar ao tooltip ou à mensagem — o `tool_input` vem
do agente, e o agente lê arquivo de repositório alheio.

**Liberar um workspace.** No menu "⋯" da linha do workspace: **"Permitir acesso
fora do worktree"** (ou **"Permitir acesso fora do repositório"**, conforme a
raiz), que vira **"Restringir ao worktree"** / **"Restringir ao repositório"**
depois de ligado. É a rota `PATCH /api/workspaces/:id` com
`{ "crossAccess": true }` (ou `false`), que devolve o workspace atualizado e
vale **na hora**, no `PreToolUse` seguinte — não é preciso reabrir sessão. A
decisão é persistida no workspace e sobrevive ao restart. O item continua no
menu quando a pasta do worktree sumiu (é uma decisão sobre o workspace, não uma
operação de git) e some quando a guarda está desligada na configuração —
oferecer liberação de uma cerca que não existe seria mentira.

**A liberação é TOTAL, não "acesso ao worktree irmão".** Com `crossAccess`
ligado, as sessões daquele workspace voltam a poder ler e escrever em **qualquer
lugar do disco** — não só no worktree do lado, e não só no repositório. É a
mesma liberdade que o agente tinha em qualquer versão anterior à 0.11.0, e é por
isso que ela é por workspace e explícita, num item de menu que diz o que faz.

**Desligar tudo.** Em **Configurações → Sessões**, a opção *"Guarda de escopo
entre worktrees"* (`sessions.scopeGuard`) é o interruptor geral e nasce
**ligada**. Desligada, o Bridge não opina sobre caminho nenhum. A diferença
entre as duas: `sessions.scopeGuard` é global, `crossAccess` libera **um**
workspace.

**Contra quem ela existe.** Contra **erro do agente** e contra **repositório
hostil** — o caso em que ninguém queria que aquele arquivo fosse tocado e
ninguém ficou sabendo. Ela **não** é uma barreira contra você: quem controla o
terminal desliga a guarda, edita o `config.json` ou roda `git` na mão. Ver
[`SECURITY.md`](SECURITY.md).

## Filtros git e confiança

O git executa comandos declarados no `.git/config` do **próprio repositório**.
Um deles é o driver de filtro:

```ini
# .gitattributes            # .git/config
*.txt filter=exemplo        [filter "exemplo"]
                                clean  = <comando>
                                smudge = <comando>
```

O `clean` roda em todo `git status` que precise comparar **conteúdo** — o que
acontece sempre que um arquivo rastreado tem o mesmo tamanho e mtime novo, ou
seja, um arquivo editado. E o Bridge roda `git status` sozinho: o poller da
sidebar lê cada worktree a cada 15 s pra manter o `+N ~M`. Num repositório de
origem desconhecida (um zip, um backup, um pendrive — qualquer coisa que
preserve o `.git/`, ao contrário de um `git clone`, que não traz a config)
isso é execução de comando repetida, sem você clicar em nada.

Desligar os filtros não serve: `git-crypt`, `nbstripout` e `git-lfs` são
exatamente a mesma mecânica, e um `clean` neutralizado faz todo arquivo
filtrado parecer modificado para sempre — o `~M` cravado e o "Mesclar"/"Remover
worktree" recusando por `dirty-worktree` sem você ter mexido em nada.

Então o Bridge **detecta e pergunta**:

- Repositório **sem** driver de filtro: nada muda. É o caso da esmagadora
  maioria.
- Repositório **com** driver e **sem** confiança declarada: a sidebar mostra
  **⚠ filtros** no lugar do `+N ~M`, e o core **não roda** comando de git que
  toque conteúdo ali. O branch continua aparecendo (vem do `HEAD`, que não
  passa por filtro). "Mesclar no base" e "Remover worktree" respondem
  **409 `filters-untrusted`**.
- Repositório **confiado**: tudo funciona como antes — inclusive os filtros,
  que voltam a rodar. É a sua escolha, feita de propósito.

O bloqueio vale também para **"Nova tarefa"**: `git worktree add` faz checkout, e
checkout roda o `smudge` do driver. Num repo não confiado a rota responde
**409 `filters-untrusted`** e nenhum arquivo é escrito. Por isso o item de menu
aparece em **qualquer** workspace do repositório, worktree ou raiz — sem isso não
haveria como confiar antes de criar a primeira tarefa.

Pra confiar: menu **"⋯"** do workspace → **"Confiar nos filtros git deste
repositório"**. O diálogo diz o que passa a ser executado. Pra desfazer, o mesmo
menu vira **"Retirar a confiança nos filtros"**.

A confiança é do **repositório**, não do workspace: vale pra todos os worktrees
dele, é gravada no `bridge.db` do perfil e sobrevive ao reinício. Um repo
recém-aberto **nunca** nasce confiado.

Pela API:

```
PATCH /api/repos/:id   { "trustFilters": true }   → o repo atualizado
GET   /api/repos/:id/filters                      → { "drivers": ["exemplo"] }
```

Detalhes de implementação que importam:

- A detecção usa `git config --local --includes --name-only --list` **e** o
  escopo `--worktree`, na raiz **e em cada worktree** do repositório. O
  `--includes` é obrigatório: sem ele um `include.path = outro.cfg` esconde o
  driver da listagem.
- **Submódulos** entram na conta. A config de um submódulo mora em
  `.git/modules/<sub>/config`, que a enumeração do superprojeto não enxerga — o
  Bridge desce em cada submódulo inicializado (até 3 níveis) e junta o que achar.
  Só desce onde é seguro: a pasta e o gitdir que o git resolve pra ela precisam
  ficar, pelo `realpath`, **dentro** do repositório. Caminho declarado com `..`,
  absoluto, pasta que é junction pra fora ou `.git` que é um arquivo
  `gitdir: <fora>` não são visitados — contam como suspeitos.
- As leituras passivas rodam com `--ignore-submodules=all`. Efeito colateral
  assumido: **submódulo sujo deixa de contar no `~M`** da sidebar.
- Quando a enumeração falha por qualquer motivo — inclusive um `.gitmodules`
  ilegível — o repo é tratado como "tem driver" (fail-closed).

## Estados de uma sessão

O anel na sidebar é o `state` da sessão no core. Quem decide a transição é o
adaptador do agente, a partir dos hooks; sessão `shell` fica em `idle` até o
PTY morrer.

| Estado | Anel | Quando entra | Como sai |
|---|---|---|---|
| `idle` | cinza | `SessionStart`; `Notification` de espera ociosa; foco do user numa sessão em `done` | prompt novo (`UserPromptSubmit`) |
| `running` | azul | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`. O `detail` mostra a tool e o argumento (`Bash · npm test`), ou `pensando…` entre tools | `Stop`, `PermissionRequest`, `Notification` |
| `needs-input` | âmbar pulsando | `PermissionRequest`, ou `Notification` que não é de ociosidade. Dispara notificação `needs-input` | só por hook (responder a permissão no terminal); foco do user **não** limpa |
| `done` | verde | `Stop` limpo. Dispara notificação `done` | foco do user na sessão (com a janela em foco) → `idle`; prompt novo → `running` |
| `stuck` | vermelho | 5 `Stop` bloqueados seguidos (`stop_hook_active: true`). Dispara notificação `stuck` | prompt novo zera o contador |
| `server-limited` | laranja | a saída do PTY casou com uma das frases do limite do SERVIDOR ("Server is temporarily limiting requests", "not your usage limit", `overloaded_error`, `API Error: 529`) | primeiro `Stop`/`UserPromptSubmit` seguinte, ou 5 min |
| `exited` | cinza riscado | PTY morreu, ou `SessionEnd` com motivo de saída (`exit`, `prompt_input_exit`, `logout` — `clear` **não** encerra) | o painel fica aberto com a saída; criar sessão nova nele substitui a morta |

Cardinalidade: **um painel hospeda no máximo uma sessão**. Criar sessão num
painel que já tem uma viva devolve `409`; se a sessão dele está `exited`, a nova
substitui a antiga. `DELETE /api/sessions/:id` remove o painel junto, a menos
que ele seja o único da aba.

## O Claude Code que você abre dentro de um shell

Até a 0.11.x, digitar `claude` num painel de shell dava um Claude Code que o
Bridge não enxergava: sem `--settings`, nenhum hook chegava ao core, e a linha
da sidebar continuava dizendo `shell` enquanto um agente inteiro trabalhava ali
dentro. Da **0.12.0** em diante ela diz `claude`.

Como funciona: todo shell que o Bridge abre nasce com uma pasta própria na
frente do `PATH` dele, com um atalho `claude` que chama o Claude Code REAL
acrescentando `--settings <pasta da sessão>\settings.json` — o mesmo arquivo de
configuração (hooks e statusline) que uma sessão de agente recebe. Você digita
`claude` normalmente, com os argumentos que quiser; eles são repassados
intactos.

Quando o primeiro hook chega, a sessão vira **hospedeira**:

- a linha da sidebar e o cabeçalho do painel passam a mostrar `claude`, com
  anel de estado de verdade (`running`, `esperando você`, `terminei`) e o
  detalhe `no shell` quando não há nada acontecendo;
- valem as notificações, a statusline, o registro de uso, o selo do limite do
  servidor e a guarda de escopo — como numa sessão de agente;
- ao sair do Claude (`/exit`, `Ctrl+D`), a linha volta a dizer `shell` e **o
  shell continua vivo**, no mesmo painel, com o mesmo histórico.

O que NÃO muda: o `kind` da sessão continua sendo `shell` do começo ao fim. Ela
nunca vira uma sessão de agente — e por isso, ao reabrir o Bridge, o painel
volta como um shell puro, sem retomar a conversa. Num painel que **já teve uma sessão de
agente antes**, porém, o botão **"Reabrir com contexto"** passa a alcançar a
conversa hospedada: o `POST /api/panes/:id/resume` retoma o último
`lastAgentSessionId` que o painel viu, e um Claude aberto dentro do shell grava
o dele ali. Num painel que só teve shell, a rota continua respondendo `422
nothing-to-resume` — falta o `lastAgent`.

Uma hospedeira **conta** no teto de `sessions.maxConcurrentAgents` (é um Claude
Code de verdade consumindo um slot), mas nunca passa pela fila do escalonador —
não foi o Bridge que a lançou, e não haveria o que enfileirar.

Desligar: `Ctrl+,` → **Sessões** → "Reconhecer o Claude Code aberto dentro de um
shell" (ou `PATCH /api/config { "sessions": { "hostedAgents": false } }`).
Ligar ou desligar vale para o **próximo** shell que você abrir; uma hospedagem
em curso termina sozinha, do jeito normal. Numa máquina sem `claude` no PATH
nada disso acontece: sem alvo, não há wrapper nem `PATH` mexido.

## Limite do servidor × limite de uso e o escalonador

Os dois aparecem como "limite" no terminal e não são a mesma coisa. Confundir
um com o outro é a dor mais comum de quem roda várias sessões do Claude Code
lado a lado — e foi ela que motivou esta parte do Bridge.

| | Limite de **uso** | Limite do **servidor** |
|---|---|---|
| De quem é | seu (5 h / semana da sua conta) | da infraestrutura da Anthropic, compartilhada |
| Escala com o plano? | sim | **não** |
| O que o terminal diz | a cota chegou a 100 % | `Server is temporarily limiting requests (not your usage limit)`, `API Error: 529`, `overloaded_error` |
| Como o Bridge mostra | selo **vermelho** na sidebar, com o horário do reset | anel e selo **laranja** (`⏳ servidor`) na linha da sessão, com a frase lida no terminal no tooltip |
| Como sai | esperando o reset | sozinho, em segundos a minutos |

### O que o Bridge faz com isso

**Detecta.** Toda saída de PTY passa por um scanner com janela rolante de 4 KB
por sessão (ANSI removido, sem diferenciar maiúsculas). Casou uma das frases, a
sessão entra em `server-limited` com a frase guardada como prova. A sessão sai
do estado no primeiro turno normal seguinte (hook `Stop` ou `UserPromptSubmit`)
ou depois de **5 minutos** — o que vier primeiro.

O casamento exige a frase inteira do Claude Code (ou o token que só existe no
corpo do erro da API). Um `// TODO: tratar rate limit` num diff, um
`if (err.status === 529)` num arquivo aberto no terminal e um `HTTP 429` não
disparam nada: falso positivo aqui é pior que detecção nenhuma, porque ensina a
ignorar o indicador.

**Escalona os lançamentos.** Ligado por padrão (Configurações → **Sessões**):

- **teto de agentes simultâneos** (`sessions.maxConcurrentAgents`, padrão `4`).
  Pedido além do teto entra numa fila e o `POST /api/sessions` responde
  `202 { queued: true, position }` em vez de `201`;
- **jitter de 300–900 ms** entre lançamentos pedidos em rajada — a restauração
  de um workspace com vários painéis é justamente uma rajada;
- **backoff de 5 s a 60 s** (dobrando a cada lançamento) enquanto **alguma**
  sessão estiver em `server-limited`: com o servidor estrangulando, subir mais
  um agente na mesma cadência é jogar lenha.

Nada disso mata, pausa ou enfileira sessão que já existe — uma vez de pé, o
agente é seu. E dois caminhos NÃO passam pela fila, porque são um clique
deliberado numa sessão só: `POST /api/panes/:id/resume` (o `bridge resume`) e o
agente que nasce junto com uma tarefa nova.

**Mostra a fila.** Com alguém esperando, a sidebar ganha a linha
`2 sessões aguardando slot` e o botão **Lançar agora**, que solta o próximo
ignorando o escalonador uma vez.

### Rotas

| Rota | O que faz |
|---|---|
| `GET /api/launcher` | `{ enabled, maxConcurrent, active, serverLimited, spacingMs, nextAt?, pending[], lastError? }` |
| `POST /api/sessions` | `201` com a sessão, ou `202 { queued: true, id, position, reason }` (`reason`: `slots` \| `jitter` \| `backoff`). Painel inexistente (`404`) e painel ocupado (`409`) continuam imediatos — nada entra na fila pra falhar depois |
| `POST /api/launcher/launch-now` | `{ id? }` — solta o pendente (sem `id`, o primeiro da fila). `404` `queue-empty` / `launch-not-found` |
| `DELETE /api/launcher/pending/:id` | tira da fila sem subir nada |

O evento `launcher.changed` leva o status inteiro pelo `/ws` a cada mudança da
fila; `session.state` passou a carregar `serverLimit` (`{ since, phrase, pattern }`)
junto do estado.

### Desligar

Configurações → **Sessões** → *Escalonar lançamentos de agente*. Desligado, todo
pedido sobe na hora e o teto deixa de valer — a detecção do limite do servidor
continua funcionando (ela só informa; não segura nada).

## Grupos da sidebar

A sidebar agrupa os workspaces por repositório git; quem não tem repositório cai
no grupo **"Sem repositório"**, que fica por último. Cada cabeçalho de grupo é um
controle:

- **clicar no título recolhe e expande** o grupo (o chevron diz qual dos dois).
  Recolhido, as linhas de workspace somem e o cabeçalho passa a mostrar o
  contador de workspaces à direita e o **anel do pior estado do grupo** — travar
  uma sessão dentro de um grupo recolhido continua acendendo o aviso;
- o **"⋯"** que aparece no hover tem "Fixar no topo" / "Desafixar". Grupos
  fixados vêm primeiro, na ordem em que foram fixados; depois os de repositório
  por nome, e "Sem repositório" no fim — a menos que ele mesmo esteja fixado.

Fixado e recolhido são preferência da máquina, não estado do core: ficam no
`localStorage`, na chave `bridge.sidebar.groups`
(`{ pinned: string[], collapsed: string[], collapsedWorkspaces: string[] }` — os
dois primeiros por id de grupo, que é o id do repositório ou `__loose__` para
"Sem repositório", e o terceiro por id de workspace). Valor ausente ou
corrompido é lido como preferência vazia.

### Workspaces abertos por padrão (0.12.2)

**Todo workspace nasce expandido**: as sessões de todos ficam à vista ao mesmo
tempo. Cada linha de workspace tem um **chevron** à esquerda que recolhe e
expande só aquele — e é a única coisa que faz isso. Clicar no nome do workspace
apenas **ATIVA** ele (é o que troca a área de conteúdo); ativar um não retrai
mais o outro. O workspace ativo continua com o realce de fundo.

Recolhido, o workspace mantém o **anel do pior estado entre as sessões dele**,
como o cabeçalho de grupo recolhido: fechar uma linha esconde as sessões, nunca
o aviso de que alguma travou. Pelo teclado, o chevron é um botão com
`aria-expanded` e rótulo "Recolher workspace" / "Expandir workspace"; o ↑/↓
continua andando entre cabeçalho de grupo, workspace e sessão, sem parar nele.

*História: até a 0.12.1 a sidebar era um acordeão — só o workspace ATIVO ficava
expandido, e abrir um fechava o anterior.*

### Teclado e leitor de tela na sidebar (0.9.0)

As três linhas da sidebar — cabeçalho de grupo, workspace e sessão — são
controles de verdade: entram no Tab, ativam com `Enter`/`Espaço` e **andam com
↑/↓** na ordem em que estão desenhadas. Nas pontas a seta volta a ser da página
(a lista rola em vez de dar a volta), e com o foco no "⋯" de uma linha a seta
continua sendo do menu.

Cada linha também tem um `aria-label` que diz em texto o que a cor diz na tela:
`"Workspace exemplo, 2 sessões, esperando você"`, `"Sessão claude, travada,
editando, em foco"`, `"Grupo forja, 3 workspaces, travada, recolhido"`. Sem
isso, o anel colorido e a faixa azul do foco simplesmente não existiam pra quem
usa leitor de tela. O foco por teclado também revela o `✕` da sessão e o `⋯` da
linha, que antes só apareciam no hover.

## Fechar painel

`Ctrl+Shift+X` fecha o painel alvo (o focado, ou o primeiro da aba ativa). O
mesmo caminho tem duas portas de mouse: o **✕** que aparece no cabeçalho do
painel quando o ponteiro passa por cima (como o ✕ da aba) e o botão **"Fechar
painel"** do painel vazio.

Funciona em painel vazio, encerrado e vivo. Quem apaga é o core
(`DELETE /api/panes/:id`): ele encerra a sessão do painel se houver e, quando
era o **último painel da aba**, fecha a aba junto. A UI só pergunta quando há
uma sessão de **agente** viva pra perder ("Fechar este painel encerra a sessão
claude. Continuar?"); shell vivo fecha direto, porque reabrir um shell custa um
`Enter`. Depois de fechar, o foco vai pro painel vizinho (o core responde em
`GET /api/panes/:id/neighbor?dir=`) ou, se não houver, pro primeiro da aba.

O painel vazio também tem os botões **"Abrir shell"** e **"Abrir Claude
Code"** — o `Enter` continua abrindo o shell, e o atalho de cada botão está no
tooltip dele. E as dicas da direita da barra de abas (**divide**, **← →
navega**, **uso**, **fecha painel**) são botões: clicar dispara
exatamente a mesma ação do atalho.

Desde a 0.11.2 a barra mostra o **nome** de cada ação, não a combinação: com
cinco dicas, os `<kbd>` de todas elas poluíam a barra inteira. A tecla continua
a um passo — ela está no tooltip de cada botão e na tabela de **Configurações →
Atalhos** —, e ela sai do `keybindings.json` em vigor, não de literais:
rebindar `pane.close` muda o tooltip junto, e ação sem combinação no arquivo
avisa "(sem atalho)" com o botão ainda clicável.

A navegação continua sendo **duas ações** desde a 0.9.0: `←` vai pro painel da
esquerda (`pane.left`) e `→` pro da direita (`pane.right`) — as setas ali são o
nome do sentido, não a tecla.

## Terminal: fonte

O painel de terminal é xterm 5.5 no renderer **DOM** (sem `@xterm/addon-canvas`
nem `@xterm/addon-webgl`), então **todo glifo vem da fonte** — o desenho
próprio de box-drawing e blocos do xterm (`customGlyphs`) só existe nos
renderers de canvas/WebGL. Se a fonte não tem o glifo, o Chromium cai na
próxima da lista, glifo a glifo, e o resultado é uma célula com largura
diferente da que o xterm mediu: logo do Claude Code esmigalhado e statusline
embolada.

O default mora em `packages/shared/src/model.ts` (`DEFAULT_STORED_CONFIG`) —
fonte única de onde o core (`DEFAULT_CONFIG`) e a UI (`TERMINAL_DEFAULTS`, em
`packages/ui/src/terminalPrefs.ts`) derivam:

```
'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace
```

- **Cascadia Mono** vem no pacote do Windows Terminal e fica registrada na
  coleção de fontes do DirectWrite (não aparece em `C:\Windows\Fonts`, mas o
  Electron a enxerga). Cobre box-drawing 128/128, blocos 32/32, formas
  geométricas 96/96 e braille 256/256, tudo no mesmo avanço do `W` — é o que
  faz símbolo e célula terem a mesma largura.
- **Consolas** é a rede de segurança se o Windows Terminal não estiver
  instalado. Tem box-drawing completo, mas só 8/32 dos blocos: falta o
  quadrante (U+2596–259F) do logo do Claude.
- **Geist Mono** (o `.woff2` do próprio bundle) é um subset de 225 codepoints,
  Latin-1 e pouco mais. Bonito pra texto, inútil pra terminal — por isso ficou
  atrás.

Os emoji que o agente imprime no terminal precisam de mais que fonte. Sem addon,
o xterm usa a tabela de largura do **Unicode 6**, onde U+1F300–U+1F9FF conta
como largura 1 — e o emoji, que o Segoe UI Emoji desenha a mais de duas
células, encavalava a letra seguinte. O `@xterm/addon-unicode11` (a **única** dependência
adicionada por causa disso) é carregado
com `term.unicode.activeVersion = '11'` e resolve isso. Ele é API proposta do
xterm, então o `XTerm` precisa nascer com `allowProposedApi: true`: sem a flag
o addon lança na montagem e o renderer inteiro fica em branco.

O que ainda cai em fallback do sistema, porque nenhuma mono da máquina tem:
`✻` (U+273B, o spinner do Claude Code), `❄` (U+2744) e `⛔` (U+26D4).

Instalar uma **Nerd Font** (Cascadia Code NF, JetBrainsMono NF) resolveria os
símbolos que sobraram e traria os glifos de powerline — é download, então fica
como sugestão, não como padrão. E a pilha depende do **Windows Terminal estar
instalado** pra Cascadia Mono existir: sem ele ela degrada pro Consolas, que é
correção parcial (falta o quadrante do logo do Claude, e o logo volta a
quebrar).

## Terminal: copiar e colar

A convenção é a do Windows Terminal e a do terminal do VS Code:

| Tecla | O que faz |
| --- | --- |
| `Ctrl+V` | cola o clipboard no terminal |
| `Ctrl+Shift+V` | idem |
| `Shift+Insert` | idem |
| `Ctrl+C` **com seleção** | copia a seleção e a desmarca |
| `Ctrl+C` **sem seleção** | continua sendo `^C` (SIGINT) — é pra isso que ele serve num terminal |
| `Ctrl+Insert` | copia a seleção |
| **Botão direito** | com seleção copia, sem seleção cola (não há menu de contexto) |

Colagem de várias linhas vai como **uma** entrada: o `term.paste` embrulha o
texto em *bracketed paste* quando a aplicação do outro lado ligou o modo 2004 —
o Claude Code liga.

Duas combinações ficam de fora de propósito. **`Ctrl+Shift+C` continua sendo
"abrir Claude"** (é o atalho do app; se você prefere que ele copie, remapeie
`agent.claude` no `keybindings.json`). E **`Ctrl+Alt+V` / `Ctrl+Alt+C` seguem
pro terminal**, porque no teclado ABNT2 o `AltGr` chega como `Ctrl+Alt` e
sequestrá-lo quebraria a digitação normal.

### Clique do mouse no Claude Code

O Claude Code aceita clique — escolher uma opção, trocar de aba entre os
agentes — só na interface **fullscreen** dele, e quem decide subir nela é o
próprio Claude (versão, teste gradual, `settings.tui`). O Bridge repassa o
mouse desde sempre: o clique vira uma sequência SGR no xterm, atravessa o
WebSocket e o ConPTY e chega ao programa byte a byte. O que faltava era o
Claude pedir.

Configurações → Sessões → **"Clique do mouse no Claude Code"**
(`sessions.mouseClicks`, ligada por padrão) resolve isso dos dois lados: ligada,
cada sessão nova nasce com `CLAUDE_CODE_NO_FLICKER=true` (se você já definiu
essa variável, a sua vence) e o terminal repassa o mouse; desligada, a sessão
nasce com `CLAUDE_CODE_DISABLE_MOUSE=1` e o terminal ignora qualquer pedido de
rastreio de mouse — arrastar sempre seleciona texto, como num terminal sem
mouse. Vale para sessões abertas depois da mudança; as que já estão de pé
seguem como nasceram. Na interface fullscreen a rolagem é do próprio Claude (ele
tem scrollback virtual; a roda do mouse anda por ele), não do terminal.
Independente da opção, os modos que o programa ligou
(mouse, colar entre chaves, setas de aplicação) sobrevivem a uma reconexão do
core: o terminal os fotografa antes de redesenhar pelo scrollback e reaplica
depois.

## Idioma (0.13.0)

O Bridge fala **português do Brasil** e **inglês**. A escolha é uma só e vale
pro app inteiro: a interface, as mensagens de erro da API, as notificações, a
linha de status, os textos da fila de lançamento, a razão da guarda de escopo
(a que o agente lê), a bandeja, os toasts nativos, os diálogos do Windows e a
CLI `bridge`.

**Onde trocar:** `Ctrl+,` → **Aparência** → **Idioma**, com três opções —
*Português (Brasil)*, *English* e *Do sistema*. A troca vale **na hora, sem
reabrir a janela**: não há botão de salvar, nem recarga, nem "reinicie o app".
Os nomes dos dois idiomas aparecem sempre na própria língua (quem procura
inglês procura "English", inclusive numa tela em português); só *Do sistema* é
frase e se traduz.

**O padrão é `Do sistema`** (`ui.language: "system"` no `config.json`), e a
regra é simples: locale `pt`, `pt-…` ou `pt_…` (`pt`, `pt-BR`, `pt-PT`,
`pt_BR`) vira português; **qualquer outra** vira inglês. Numa máquina em português você não
precisa configurar nada, e quem instala o Bridge fora do Brasil recebe inglês
sem procurar a opção. Quem resolve o `system` é o **core**, com a locale do
processo dele (`Intl.DateTimeFormat().resolvedOptions().locale`) — a UI, o
shell e a CLI recebem o idioma já resolvido, pra que dois pedaços do mesmo app
nunca falem línguas diferentes na mesma máquina.

O idioma resolvido aparece no `GET /api/config` como **`languageResolved`**
(somente leitura: quem quer trocar manda `ui.language`).

**Na CLI.** `bridge` pergunta o idioma ao core, e é ele que manda. Com o Bridge
**fechado** — `bridge --help`, `bridge --version`, ou qualquer comando antes de
a instância ser encontrada — vale a variável **`BRIDGE_LANG`** (`pt-BR` ou
`en`) e, sem ela, a locale da máquina:

```powershell
$env:BRIDGE_LANG = "en"
bridge --help          # a ajuda sai em inglês, com o Bridge fechado
```

Com o Bridge **aberto**, o `BRIDGE_LANG` não vence o app: `bridge list` sai no
idioma que está configurado no Bridge. É de propósito — dois terminais da mesma
máquina não deveriam responder em línguas diferentes sobre o mesmo core.

**O que NÃO é traduzido**, declaradamente:

- **a saída dos agentes e dos shells** — o texto dentro do terminal é de quem
  está rodando ali, não do Bridge (um `claude` em inglês continua em inglês);
- **as notificações que o agente escreve** (`Notification` com `message`, e o
  `bridge notify "texto"`) — elas saem como vieram. As que o **Bridge** escreve
  ("Aguardando você", "Terminou o turno") são traduzidas;
- **os logs em arquivo** (`logs\core.log`, `logs\shell.log`) — continuam em
  pt-BR: eles são do dono e de quem dá suporte, e uma linha de log no idioma de
  quem abriu a issue é mais difícil de procurar, não mais fácil;
- **o instalador NSIS** — a tela de instalação continua no idioma do
  electron-builder;
- **a documentação** — este arquivo é em português e há a versão em inglês em
  [`README.md`](README.md);
- **nomes próprios e identificadores** — `Ctrl+Shift+C`, `wsl:Ubuntu`,
  `pwsh`, os ids de sessão e de workspace, o `kind` das linhas de estado.

Uma **notificação já registrada não é reescrita** quando você troca de idioma:
ela é o registro do que aconteceu, no idioma daquele instante. O que muda é a
próxima. Pelo mesmo motivo, o **detalhe da sessão** na sidebar ("pensando…",
"escrevendo arquivo") fica no idioma do hook que o produziu até o próximo hook
chegar: ele é o último estado observado, não uma frase que o Bridge redesenha.

## Configurações

A configuração do Bridge mora em `%APPDATA%\bridge\config.json`
(`BRIDGE_PROFILE_DIR` troca a pasta). Duas rotas mexem nela — as duas exigem o
bearer da instância, como o resto da API:

| Rota | O que faz |
| --- | --- |
| `GET /api/config` | Devolve a configuração inteira em vigor. |
| `PATCH /api/config` | Recebe um subconjunto, valida, aplica e devolve a configuração inteira já mesclada. |

Campos que o `PATCH` aceita:

| Campo | Tipo / faixa | Quando vale |
| --- | --- | --- |
| `shell` | `pwsh` \| `powershell` \| `gitbash` | Sessões **novas** (as vivas continuam no shell com que nasceram). |
| `gitPollSeconds` | inteiro, 5–120 | Na hora: o poller de git é reagendado em voo. |
| `toast.enabled` | booleano | Na hora, na próxima notificação. |
| `toast.quietWhenFocused` | booleano | Na hora, na próxima notificação. |
| `terminal.fontFamily` | texto, 1–200 chars | Na hora (a UI aplica nos terminais abertos). |
| `terminal.fontSize` | inteiro, 8–24 | Na hora (a UI aplica nos terminais abertos). |
| `restore.resumeAgents` | booleano | Na próxima **subida** do app (é ela que decide se o painel de agente volta como agente ou como shell). |
| `sessions.maxConcurrentAgents` | inteiro, 1–16 | Na hora: o escalonador relê o teto e solta quem estiver na fila se ele subiu. |
| `sessions.scheduleLaunches` | booleano | Na hora (desligado, todo pedido sobe na hora e a fila deixa de existir). |
| `sessions.autoRecap` | booleano | No próximo resume que voltar vazio. |
| `sessions.scopeGuard` | booleano | No `PreToolUse` seguinte — nenhuma sessão precisa ser reaberta. |
| `sessions.hostedAgents` | booleano | No **próximo shell** que você abrir (é ele que nasce com o wrapper `claude` e com o PATH mexido). Uma hospedagem em curso não é interrompida: ela termina sozinha no `SessionEnd`. |
| `ui.language` | `pt-BR` \| `en` \| `system` | Na hora, em tudo: a janela troca de idioma pelo `config.changed` do WS, sem reabrir, e o core passa a escrever no idioma novo. Ver "Idioma". |

`toast`, `terminal`, `restore`, `sessions`, `usage` e `ui` são
mesclados **chave a chave**:
mandar `{ "toast": { "enabled": false } }` não repõe o `quietWhenFocused`
padrão, e `{ "sessions": { "scopeGuard": false } }` não mexe no teto de
agentes.

Campo que não passa na validação é **ignorado**, e o resto do arquivo continua
valendo — um `"shell": "zsh"` não derruba o app nem apaga a sua porta. Já o
arquivo INTEIRO ilegível (JSON quebrado por uma edição à mão, ou um topo que
não é objeto) faz o Bridge subir na configuração **padrão** e registrar o
motivo no `core.log`, em `warn`, com o caminho do arquivo:
`config.json: JSON inválido (…); usando a configuração padrão`. Antes isso
acontecia calado, e a configuração parecia ter sumido sozinha. Cuidado com a
ordem: um `PATCH /api/config` (ou uma mudança pelo diálogo de configurações)
regrava o arquivo por cima — conserte o JSON **antes** de mexer nas
configurações pela UI.

`port` é **somente leitura pela API** — só editando o `config.json` com o
Bridge parado. Trocar a porta com o servidor no ar não reabriria o socket (e
derrubaria o token gravado no `instance.json`).

### Uso e limites (`usage`)

O Bridge conta o consumo de tokens **sozinho**, lendo as transcrições que o
Claude Code já grava. Antes da 0.10.0 essa parte da tela vinha de uma
ferramenta externa de cota; agora é código do próprio Bridge (ADR-012, que
substitui a ADR-008).

**O que entra na conta.** Toda linha de assistente das transcrições em
`<claudeHome>\projects`, das duas origens: a conversa que você digitou
(`main`) **e os subagentes que ela lançou** (`subagents`, os `*.jsonl`
aninhados sob a pasta da sessão). Os dois SEMPRE somam no total — a separação
existe pra o painel poder dizer "inclui subagentes", nunca pra esconder metade
do consumo atrás de um filtro. Na máquina do autor os subagentes são a maior
parte do consumo de um dia; um painel que mostrasse só a conversa principal
estaria errado por um fator, não por um detalhe.

**Onde o dia começa.** À **meia-noite local** — a hora do relógio da sua
máquina, não UTC. Uma sessão da madrugada conta no dia em que você estava
trabalhando. `semana` é de segunda a domingo locais; `mês` é o mês civil local.

**O custo é ESTIMATIVA, não fatura.** Ele sai de uma tabela de preços de lista
embutida (`packages/core/src/usage/pricing.json`), que carrega a data em que
foi conferida contra a documentação oficial — a resposta da API devolve essa
data em `pricingAsOf` e a seção Configurações → Uso a escreve na tela. Os
quatro tipos de token são cobrados separados, com a escrita de cache de **1
hora** contada à parte da de 5 minutos: ela custa o dobro do input (a de 5 min,
1,25 ×), e somá-las numa coluna só subestimava a conta.

**Privacidade.** O Bridge lê as transcrições só pra SOMAR. Nada de conteúdo de
mensagem sai da leitura: o que vai pro banco são contagens de token, o id do
modelo, a pasta de trabalho (`cwd`) e o carimbo do dia. Ver `SECURITY.md`.

**Enquanto ele ainda está lendo.** A primeira varredura de um histórico grande
é uma tarefa longa (na máquina do autor são 8.431 transcrições e 12,8 GB). Ela
roda em segundo plano, retoma de onde parou e informa o progresso: o painel
mostra "ainda lendo as transcrições (N de M arquivos)" no lugar de "nenhuma
transcrição encontrada" — que seria falso — e o botão "Reler transcrições"
mostra a fração enquanto anda e o resultado (`{ arquivos, mensagens, dias }`)
quando termina.

O bloco `usage` do `config.json` configura o monitor:

| Campo | O que faz |
| --- | --- |
| `dayBoundary` | Só aceita `'local'`: o dia começa à meia-noite do fuso da máquina. |
| `showCost` | Mostrar o custo estimado na faixa, no painel e na statusline. |
| `terminalStatusLine` | Desenhar a linha de status **dentro do terminal** do Claude Code. Nasce `false` (0.12.2): a sidebar já mostra os mesmos números, e o hook continua rodando de qualquer jeito. |
| `pricingFile` | Caminho de um JSON `{ modelo: { input, output, cacheWrite, cacheRead } }` (USD por milhão). |
| `pricing` | O mesmo mapa, inline — vence o arquivo, que vence a tabela embutida. |

Cada entrada de preço tem `input`, `output`, `cacheWrite` (escrita de 5
minutos) e `cacheRead`, todos em USD por milhão, mais um `cacheWrite1h`
**opcional**: sem ele vale a regra oficial, `2 × input`, e uma tabela que você
escreveu antes desta versão continua valendo.

A busca por modelo tem **duas tentativas e nada mais**: o id exato e o id sem o
sufixo de data (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). Não há
fallback por prefixo — ele fazia `claude-opus-5` herdar o preço de uma geração
anterior, um número errado com a mesma cara de um certo.

Modelo que não está em nenhuma das três tabelas conta em **tokens** normalmente
e fica de fora do **custo**: o recorte devolve `cost: null` (ou
`costPartial: true`) e um aviso em `pricingWarnings` nomeando o modelo. Um custo
chutado seria pior que custo nenhum — ele pareceria resposta.

O `GET /api/config` devolve ainda um `claudeHome`, somente leitura: a pasta de
onde os transcripts são lidos (`BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` →
`~/.claude`). É derivada, não mora no `config.json`.

O `GET` devolve ainda um `profileDir`: o caminho **absoluto** da pasta do perfil
(`BRIDGE_PROFILE_DIR`, ou `%APPDATA%\bridge`). Ele também é somente leitura, e
por um motivo mais forte que os outros dois — ele não está no `config.json` e
nunca é gravado nele. É derivado de ONDE o arquivo está, e guardá-lo dentro do
próprio arquivo seria uma verdade com data de validade: bastaria mover a pasta.
Existe porque a UI precisa de um caminho real pra abrir no Explorer.

Erros:

| Situação | Resposta |
| --- | --- |
| Corpo traz `port`, `profileDir` ou `claudeHome` | `403 { code: 'read-only', fields: [...] }` |
| Valor fora da faixa, tipo errado ou campo desconhecido | `400 { code: 'invalid-config' }` |
| Sem bearer | `401` |

Um `PATCH` aceito grava o `config.json` de forma atômica (escreve
`config.json.tmp` e renomeia por cima), aplica em memória e emite
`config.changed { config }` no `/ws` — é assim que a UI atualiza sem recarregar.
A gravação vem antes da aplicação: se o disco recusar, nada muda em memória e o
app continua se comportando como o arquivo descreve.

### O painel "Uso" (0.10.0)

![O painel Uso com limites, custo por dia e divisão por modelo e por projeto](docs/img/uso.png)

`Ctrl+Shift+Y`, a dica **uso** na barra de abas ou "Uso…" no menu "⋯" da sidebar
abrem o painel. `Esc` (ou o clique no véu) fecha. Ele não tem OK nem Cancelar
porque não há nada a confirmar: é uma tela de leitura.

A ordem de cima pra baixo é a ordem da pergunta:

1. **posso continuar agora** — um medidor por janela de limite viva (5 h,
   semana, e o que mais o payload trouxer), com percentual, barra colorida pelo
   degrau (`ok < 60 <= warn < 85 <= bad`) e "reseta em 2h15" / "reseta na
   segunda". As barras são **fixas** (0.18.0): o Claude Code só manda
   `rate_limits` enquanto tem resposta recente da API, então com todos os
   Claudes ociosos a última foto fica na tela — e uma janela cujo reset já
   passou aparece como 0 %, porque renovou. Conta de **chave de API** nunca
   recebe `rate_limits`: no lugar da grade aparece um cartão dizendo isso,
   nunca duas barras zeradas — que leriam como cota intacta;
2. **quanto já gastei** — entrada, saída, cache (com a repartição
   escrita/leitura), custo estimado e mensagens. A linha de mensagens diz
   quantos modelos e projetos entraram no recorte e quantas vieram de
   **subagentes**;
3. **como isso se distribuiu no tempo** — custo por dia dos últimos 30 dias, em
   CSS puro. As barras **fora** do intervalo escolhido ficam cinza: o recorte em
   evidência, o contexto ainda visível. Cada coluna é focável pelo teclado e o
   valor sai no tooltip, no `title` e no `aria-label` — nada é escrito dentro da
   barra, que não passaria em contraste;
4. **em quê** — uma tabela por modelo e uma por projeto (as 8 maiores +
   `outros (N projetos)`), com barra de participação na de projeto. **Projeto é
   a pasta de trabalho da sessão do Claude Code**, não o workspace do Bridge:
   duas tarefas na mesma pasta somam no mesmo projeto;
5. **o quanto disso é estimativa** — o aviso dos modelos sem preço e o rodapé
   dizendo que o custo vem da tabela, não da fatura.

O cabeçalho tem o recorte (`dia | semana | mês`); "meia-noite local" só aparece
no recorte de **dia**, que é onde a borda decide se a madrugada conta hoje ou
ontem. Sem transcrição nenhuma varrida, o corpo vira um estado vazio com a pasta
que o core está lendo e um único botão, "Reler transcrições".

Com `usage.showCost` **desligado** o painel não escreve dinheiro em lugar
nenhum: o cartão e as colunas de custo somem e o gráfico passa a contar tokens
por dia.

#### Na sidebar

Os limites são da **conta**, não do workspace — por isso ficam num bloco único
logo abaixo do cabeçalho da sidebar (duas barras compactas, percentual e reset),
e não repetidos dentro de cada workspace expandido. Quando a sidebar aperta, o
texto de reset encolhe (`reseta em 2h15` → `2h15` → some) antes da barra e do
percentual; a frase inteira fica no `title`.

Dentro do workspace expandido fica só a linha da sessão focada:
`70k ctx · Fable 5.1 · US$ 0,74`. Apertando, o **modelo** é o primeiro a cair:
contexto e custo são os dois números que mudam a decisão de continuar ou dar
`/clear`.

O dinheiro é `US$ 0,74` em todo lugar — painel, sidebar e a statusline devolvida
ao Claude Code. Um app em pt-BR mostrando `$0.74` está mostrando o formato de
outra língua.

#### No terminal do Claude Code

A mesma linha pode ser desenhada no rodapé da TUI do Claude Code — é a
`statusLine` que o Bridge injeta no `settings.json` da sessão. Desde a 0.12.2
ela vem **desligada**: a sidebar mostra exatamente os mesmos números logo ao
lado, e ter os dois na mesma tela era dizer tudo duas vezes. Para ligá-la, marque
**"Mostrar a linha de status no terminal do Claude Code"** em Configurações →
Uso (`usage.terminalStatusLine`).

O que **não** muda com o interruptor: o hook `StatusLine` continua sendo
injetado e chamado a cada redesenho, e é dele que saem o contexto, o modelo, o
custo e as janelas de 5 h e da semana que a sidebar mostra. Desligada, o Bridge
responde ao hook com uma linha vazia — medido no Claude Code 2.1.266: a TUI não
desenha rodapé nenhum, nem uma barra em branco.

#### Configurações → Uso

| Campo | O que faz |
| --- | --- |
| **Mostrar o custo estimado** | `usage.showCost`. Vale no painel, na sidebar e na statusline. |
| **Mostrar a linha de status no terminal do Claude Code** | `usage.terminalStatusLine`, **desligada** por padrão. Desligada, o rodapé da TUI fica limpo e a sidebar continua com os mesmos números. |
| **Arquivo de preços** | `usage.pricingFile`. Vazio volta pra tabela embutida; arquivo ausente ou malformado vira aviso no painel, nunca erro. |
| **Reler transcrições** | `POST /api/usage/rescan`: zera as contagens e relê tudo do zero. É o conserto dos dois casos que o incremental não cobre — transcript reescrito por fora e tabela de preços corrigida depois do fato. |

Abaixo deles a seção lista os **modelos sem preço** na tabela em vigor e mostra
o formato esperado do JSON. Ela existe porque a tabela embutida só traz preço de
lista público que dá pra afirmar, e os modelos mais novos — justamente os que
estão em uso — costumam chegar sem preço; sem a lista e sem o exemplo à vista,
"preencha `usage.pricing`" seria uma instrução que exige ler o código. A frase
de apoio diz de quando é a tabela em vigor (`pricingAsOf`).

### O diálogo

`Ctrl+,`, a engrenagem no cabeçalho da sidebar ou "Configurações…" no menu "⋯"
abrem o diálogo. Seções em coluna à esquerda:

| Seção | O que tem |
| --- | --- |
| **Terminal** | Fonte (campo de texto com sugestões de mono conhecidas — aceita lista com fallback, como no CSS), tamanho (8–24), shell padrão, e uma prévia de três linhas com box-drawing, blocos e statusline na fonte escolhida. |
| **Sessões** | "Ao reabrir, retomar as sessões do Claude Code automaticamente" (`restore.resumeAgents`, ligada por padrão) — ver "Retomar o Claude Code ao reabrir" —, o escalonador (`sessions.scheduleLaunches` e o teto de agentes), a injeção do resumo (`sessions.autoRecap`), a guarda de escopo (`sessions.scopeGuard`) e **"Reconhecer o Claude Code aberto dentro de um shell"** (`sessions.hostedAgents`, ligada por padrão, 0.12.0) — ver "O Claude Code que você abre dentro de um shell"; e **"Clique do mouse no Claude Code"** (`sessions.mouseClicks`, ligada por padrão) — ver "Clique do mouse no Claude Code" |
| **Notificações** | Toasts ligados; silenciar com a janela em foco. |
| **Uso** | Mostrar o custo estimado, caminho do arquivo de preços, botão "Reler transcrições" e a lista dos modelos sem preço com o formato de tabela esperado — ver "O painel Uso". |
| **Git** | Intervalo do poll (5–120 s). |
| **Atalhos** | Tabela read-only das ações × teclas em vigor (as do `keybindings.json` carregado), com uma **faixa de aviso** quando o arquivo tem atalho que não vai funcionar, e "Abrir pasta do perfil" — o botão abre a pasta no Explorer (é lá que o `keybindings.json` fica). No navegador, e enquanto o `profileDir` não chegou, aparece o caminho cheio em texto selecionável no lugar do botão. |
| **Aparência** | **Idioma** (`ui.language`: *Português (Brasil)* / *English* / *Do sistema*, 0.13.0) — a troca vale na hora, na janela inteira; ver "Idioma". E "Tema: Escuro", ainda desabilitado: o tema claro precisa de direção de design antes. |
| **Sistema** | Início automático com o Windows (ver a seção abaixo). É a única seção que **não** passa pelo `PATCH /api/config`. |

**Não há OK nem Cancelar.** Cada campo manda o seu próprio `PATCH` — ao alterar
(select, checkbox, número) ou ao perder o foco (o texto da fonte) — e a config
que volta já vale. O que existe é "Restaurar padrões" por seção. Um valor fora
da faixa vira uma faixa vermelha dentro do diálogo, e nada é enviado; o campo de
número volta pro valor em vigor quando você sai dele.

"Restaurar padrões" apareceu em **Aparência** na 0.13.0 — a seção passou a ter
um campo que o `PATCH` mexe, e o botão dela devolve o idioma pro **`Do
sistema`**. É o único efeito dele ali: o tema não é editável.

Trocar fonte ou tamanho vale nos terminais **já abertos**, na hora: o xterm
troca `fontFamily`/`fontSize`, remede a grade e avisa o ConPTY quando
`cols`/`rows` mudaram de verdade.

A prévia da fonte mostra os três símbolos que nenhuma mono do Windows tem
(`✻ ❄ ⛔`) **fora** da moldura de propósito: eles sempre vêm de uma fonte de
fallback com largura própria, e dentro da caixa eles a desalinhavam mesmo com a
fonte certa instalada. Dentro da moldura fica só o que uma mono de terminal
precisa desenhar na largura da célula.

### Quando a seção "Atalhos" avisa (0.9.0)

O core aceita qualquer string não vazia no `keybindings.json` — ele só recusa o
que não é string e a ação desconhecida, e nos dois casos mantém o padrão daquela
ação e escreve um aviso no log. Resultado: uma linha impossível chegava na tabela
com cara de atalho de verdade, e você ficava apertando uma tecla que nunca ia
disparar. A seção agora confere a tabela recebida com o **mesmo parser** que
decide se a tecla casa e mostra uma faixa amarela, com uma linha por problema,
marcando as linhas afetadas com ⚠:

- **combinação que o Bridge não sabe ler** — `"Ctrl+"` (só modificador),
  `"Ctrl+Shift+xyz"` (nome de tecla que não existe). O atalho nunca dispara;
- **duas ações na mesma combinação** — quem casa primeiro na ordem da tabela
  fica com a tecla, e a ação de baixo vira inalcançável pelo teclado. O aviso diz
  qual das duas ganhou.

Na MESMA faixa entram os problemas que só o core enxerga, porque acontecem na
LEITURA do arquivo e nunca chegam à tabela — eles vêm no campo `problems` do
`GET /api/keybindings` (ver "Rotas"), e são listados primeiro, porque explicam
por que a tabela abaixo mostra os atalhos de fábrica:

- **JSON quebrado** ou **topo que não é objeto** — o arquivo INTEIRO foi
  descartado e valem os padrões;
- **chave que não é uma ação** (typo) — aquela linha do arquivo foi ignorada;
- **valor que não é um texto de combinação** — o padrão daquela ação continua
  valendo.

Cada frase diz o que o core FEZ, e não só o que ele viu: com o arquivo
descartado inteiro, saber que o Bridge voltou pros padrões é a informação que
falta. Até a 0.8.0 nada disso aparecia na tela — o aviso ia só pro `core.log`,
e o diálogo mostrava os atalhos de fábrica como se fossem a sua escolha.

## Iniciar com o Windows

`Ctrl+,` → **Sistema** tem dois checkboxes:

| Opção | O que faz |
| --- | --- |
| **Iniciar o Bridge junto com o Windows** | Cria uma entrada em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` apontando pro `Bridge.exe` instalado. |
| **Começar minimizado na bandeja** | Acrescenta `--hidden` a essa entrada: o Bridge sobe com o core e as sessões de pé, mas **sem janela**. |

Os dois vêm **desligados**, e o Bridge nunca liga sozinho.

Com `--hidden`, a janela nasce com `show: false` e aparece pelo clique no ícone
da bandeja, pelo item **Mostrar** do menu dela, ou pelo clique numa notificação
— os mesmos caminhos de sempre. Sem o argumento, o boot é o normal.

O estado **não** mora no `config.json`: quem manda é o registro do Windows. A
UI lê (`app.getLoginItemSettings()`) e escreve (`app.setLoginItemSettings()`)
pelo main do Electron, por dois canais IPC origem-validados como os outros
(`bridge:getLoginItem` / `bridge:setLoginItem`). O motivo é que essa entrada
pode ser removida por fora — Gerenciador de Tarefas › **Aplicativos de
inicialização**, ou um `reg delete` — e uma cópia no arquivo viraria uma segunda
verdade: o checkbox diria "ligado" com o registro limpo. Toda leitura vai no
Windows, e toda escrita relê de lá antes de responder.

Conferir à mão (o **nome do valor** é o `APP_ID` do app — hoje
`com.erickdantas.bridge`):

```
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
```

Ligado com "começar minimizado", a linha fica
`"C:\...\Bridge.exe" --hidden`; sem ele, só o caminho do executável.

Duas armadilhas do Electron que a leitura tem que contornar — as duas medidas
contra o Electron 44, com a entrada de verdade no registro, não deduzidas da
documentação (ver `packages/shell/src/loginItem.ts`):

- **`launchItems[].args` vem sempre vazio.** O Electron devolve ali o
  `GetArgs()` da `base::CommandLine` do Chromium, que lista só os argumentos
  posicionais — `--hidden` conta como *switch* e some. Ler o "minimizado" dali
  dava `false` com a entrada gravada certinha.
- **`openAtLogin` não é "inicia com o Windows".** É "existe entrada que bate
  com o executável **e com os `args` desta consulta**". Com `--hidden` gravado,
  um `getLoginItemSettings()` sem argumentos devolve `false`.

Por isso o shell faz **duas** consultas: `executableWillLaunchAtLogin` (de
qualquer uma das duas) responde o **ligado**, e o `openAtLogin` da consulta
feita **com** `--hidden` responde o **minimizado**.

**Em dev a opção é no-op, com aviso na tela.** Rodando pelo checkout
(`npm run dev:app`), `process.execPath` é o `electron.exe` do `node_modules`:
gravar isso no `Run` faria o Windows abrir um Electron cru no próximo login, e
a entrada apontaria pra uma pasta que some no próximo `npm ci`. Nesse caso os
checkboxes ficam travados e a seção mostra o motivo — o recurso só funciona no
app instalado. No navegador (UI numa aba) a seção diz a mesma coisa.

## Como o hook e o shim funcionam

O core não conversa com o Claude Code por API: ele configura o próprio Claude
pra ligar de volta.

1. Ao criar uma sessão de agente, o core escreve
   `%APPDATA%\bridge\sessions\<sessionId>\settings.json` com um hook por evento
   (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
   `Notification`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`) e
   uma `statusLine`, todos apontando pro mesmo comando:
   `"<node absoluto>" "<...>\bin\bridge-hook.cjs" <sessionId> <Evento>`.
2. O PTY sobe `claude --settings <esse arquivo>` (via `cmd.exe /c`, porque
   `claude.cmd` não roda direto), com `BRIDGE_PORT`, `BRIDGE_TOKEN` e
   `BRIDGE_SESSION` na env.
3. A cada evento, o Claude executa o shim. Ele lê o payload no stdin e faz
   `POST http://127.0.0.1:<porta>/hooks/<sessionId>/<Evento>?token=…`.
4. O core traduz o payload em mudança de estado + notificação (`adapters/claude.ts`)
   e devolve o JSON que o hook espera. No `StatusLine`, devolve a linha do
   Bridge — que o shim imprime no stdout e o Claude desenha no rodapé.
5. **O shim nunca derruba o agente**: timeout de 5 s, qualquer falha (porta
   fechada, token errado, 4xx/5xx, JSON quebrado) vira `{}` — linha vazia no
   StatusLine — e `exit 0`.

Segurança da rota: `/hooks/*` exige o token na query **e** recusa qualquer
request que traga header `Origin` (só processo local bate ali, nunca um
browser). `/api/*` e `/ws` exigem `Bearer <token>`, e o `/ws` só aceita `Origin`
de `http://127.0.0.1:*` / `http://localhost:*`.

## Windows, Git Bash e WSL: o ambiente da sessão

No Windows, "abrir o Claude Code na pasta do projeto" não diz onde ele vai
rodar. Com o Git Bash escolhido como shell, o terminal cai num MINGW64: PATH
sem o toolchain Linux, `node` que não é o da distro e caminhos de rede
(`\wsl.localhost\...`) onde deveria haver `/home`. Quem trabalha dentro de uma
distro WSL quer a sessão INTEIRA lá dentro — o shell e o agente —, não um
agente do Windows olhando pra uma pasta montada.

Por isso o ambiente é propriedade do **workspace**, não da configuração global:
a mesma máquina tem um repositório que só compila no Ubuntu e outro que só roda
em `pwsh`.

### O que cada escolha muda

| Ambiente | Sessão de terminal | Claude Code |
| --- | --- | --- |
| Padrão do Bridge | o `shell` da configuração | Windows |
| `pwsh` / `powershell` / `gitbash` | o shell escolhido | **Windows, como sempre** |
| `wsl:<distro>` | `$SHELL` da distro | **dentro da distro** |

Isto é importante e não é óbvio: escolher **Git Bash não muda onde o Claude
Code roda**. O adaptador resolve o `claude.cmd` do PATH do Windows e o PTY sobe
ele direto, sem passar pelo shell escolhido. Só `wsl:<distro>` move os dois.

### Onde escolher

- **Diálogo de novo workspace** (`Ctrl+Shift+N`): campo "Ambiente", com os
  ambientes detectados nesta máquina. O padrão é "Padrão do Bridge (shell da
  configuração)" — o comportamento de sempre.
- **Menu "⋯" da linha do workspace**: as entradas `Ambiente: …`. O ambiente em
  vigor vem marcado com `•`, e "Ambiente: padrão do Bridge" desfaz a escolha.
  A troca vale **da próxima sessão em diante**: o terminal que já está aberto
  continua no shell em que subiu (matá-lo jogaria fora o trabalho de lá).
- **CLI**: `bridge new --env wsl:Ubuntu`, `bridge new --env gitbash`,
  `bridge new --env padrao`. A flag grava o ambiente no workspace e só então
  abre a sessão; se a sessão não subir, o ambiente volta ao que era.
- **Tarefas** (`bridge task new`, "Nova tarefa"): o worktree **herda** o
  ambiente dos workspaces do mesmo repositório. `POST /api/tasks` aceita
  `environment` pra mandar em outro.

A linha do workspace passa a mostrar o selo `wsl:Ubuntu` (ou `gitbash`, `pwsh`)
ao lado do branch. Ele só aparece quando houve escolha.

### O que o Bridge detecta

`GET /api/environments` responde com `pwsh`, `powershell`, o Git Bash (se o
`bash.exe` do Git for Windows existir) e **uma entrada por distro** do
`wsl.exe -l -q`. Para cada distro, o Bridge pergunta lá dentro:

```
command -v claude; command -v node; \
  [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] \
  && echo __bridge_interop__; echo __bridge_ok__
```

Três respostas: **`claude`** existe? (decide se uma sessão de agente sobe ali),
**`node`** existe? (informativo — os hooks não o usam) e o **interop** está
ligado? A última marca (`__bridge_ok__`) é a sentinela que diz que a distro
subiu: sem ela, uma distro viva sem `claude` e sem `node` seria lida como
"não respondeu". A lista é cacheada por 60 s.

Distro **sem `claude`** continua escolhível (dá pra querer só um shell ali),
mas a linha do workspace acende **⚠ sem claude** e uma sessão de agente ali é
recusada com 422 antes de gastar o painel. Distro que não responde vira
**⚠ ambiente sumiu**.

### Como a sessão sobe dentro do WSL

```
wsl.exe -d <distro> --cd <cwd traduzido> -- sh -lc 'exec "${SHELL:-/bin/sh}" -l'
wsl.exe -d <distro> --cd <cwd traduzido> -- sh -lc 'exec claude "$@"' claude --settings <...>
```

Três decisões que valem o registro:

1. **`--cd` recebe o caminho traduzido por `wslpath -a`**, não o do Windows.
   Passar um caminho com acento (ou uma unidade de rede) funcionaria por acaso
   em alguns casos e falharia calado em outros — exatamente a dor. O
   `--settings` do agente também vai em `/mnt/c/...`, embora o ARQUIVO continue
   sendo escrito pelo core no caminho do Windows.
2. **O shell é o `$SHELL` do usuário da distro** (bash, zsh, fish), e o agente
   sobe por um login shell (`sh -lc`) — é o mesmo caminho que a detecção
   percorre. Sem isso, a sidebar diria "tem claude aqui" e o lançamento
   falharia assim mesmo, porque `~/.local/bin`/nvm só entram no PATH no login.
3. **Os hooks rodam pelo Node do WINDOWS, por interop.** O `settings.json`
   gerado aponta pro mesmo `bridge-hook.cjs`, e quem o executa dentro da distro
   é o `node.exe` do Windows (`/mnt/c/.../node.exe`, derivado do
   `process.execPath` pelo próprio `wslpath`) — **nunca o `node` da distro,
   mesmo quando ela tem um**.

O motivo do item 3 é o único que importa: o shim precisa POSTar em
`127.0.0.1:<porta>` do core, e **o loopback do WSL2 não é compartilhado com o
Windows** no modo de rede padrão (NAT) — de dentro da distro, `127.0.0.1` é a
própria distro. (O modo espelhado, `networkingMode=mirrored`, compartilharia,
mas é opcional e o Bridge não pode depender de uma configuração que talvez não
exista na máquina.) Executado pelo `node.exe`, o shim é um processo do Windows
e o `127.0.0.1` dele é o do host, sempre.

Duas consequências disso:

- **o caminho do shim vai em forma de Windows** (`C:\...\bridge-hook.cjs`), e
  o mesmo vale pro `BRIDGE_SHIM`: o interop repassa o argv sem tradução, e um
  `/mnt/c/...` chegaria ao `node.exe` como arquivo inexistente;
- **exige interop ligado** (`/proc/sys/fs/binfmt_misc/WSLInterop`). Desligado,
  o Bridge avisa na lista de ambientes e no menu do workspace: a sessão até
  sobe, mas nenhum hook chega e ela fica parada em "ociosa" na sidebar.

`BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_SESSION` e `BRIDGE_SHIM` atravessam a
fronteira pela `WSLENV` (a do usuário é preservada).

O nome da distro é validado antes de virar argumento: nada que comece com `-`
passa. O argv vai separado (nunca uma linha de shell), mas `-d --alguma-coisa`
seria injeção de argumento no parser do próprio `wsl.exe`.

### Limites conhecidos da sessão de WSL

- **A guarda de escopo não vale numa sessão de WSL** nesta versão: o agente
  declara caminho POSIX (`/mnt/d/...`) e a raiz permitida do workspace está em
  forma de Windows, então o menu "⋯" nem oferece "Permitir acesso fora do
  worktree" — não há cerca pra liberar (`SECURITY.md`, risco 18).
- **O monitor de uso e o "Retomar a conversa" não enxergam sessão de WSL**: o
  Claude Code lançado pelo `wsl.exe` grava a transcrição no `~/.claude/projects`
  DA DISTRO, e o Bridge lê o do Windows — o custo daquela sessão não entra nos
  totais e o resumo da retomada volta vazio.
- **Um login shell que ZERA o `PATH` desliga o `claude` hospedado** (0.12.0): o
  wrapper da sessão entra pelo `PATH=` da própria linha do `exec`, antes de a
  distro ler o `/etc/profile` e o `~/.profile`. Um perfil que ACRESCENTA ao
  `$PATH` (o caso normal) preserva o wrapper; um que o reescreve do zero o
  apaga, e o `claude` digitado ali dentro volta a subir sem os hooks do Bridge.
  O arquivo continua no disco — o que se perdeu foi o caminho até ele.
- **Um `/etc/wsl.conf` com `metadata` e `fmask` restritivo também desliga**
  (0.12.0): o Bridge grava o wrapper pelo lado do Windows e **não** roda
  `chmod`. No DrvFs padrão isso basta — todo arquivo aparece como `0777` lá
  dentro —, mas uma distro configurada com `options = "metadata"` e um
  `fmask` que tira o bit de execução faz o `claude` da sessão responder
  "Permission denied". A saída é um `chmod +x` no wrapper ou afrouxar o
  `fmask`.

### Verificação manual pendente

A máquina em que este recurso foi construído **não tem distro WSL**
(`wsl -l -q` volta vazio, 06/09/2026). Toda a montagem de comando, o parsing
UTF-16LE do `wsl.exe -l -q`, a tradução por `wslpath` e o caminho do shim estão
cobertos por teste **contra um `wsl.exe` simulado**. Falta, numa máquina com
distro instalada:

1. `GET /api/environments` listar a distro com `claude`/`node`/`interop`
   corretos;
2. abrir um workspace com `--env wsl:<distro>` e ver o shell subir em `/home`,
   não em `/mnt/c`, inclusive com espaço ou acento no caminho do projeto;
3. subir o Claude Code nesse workspace e confirmar que **os hooks chegam** (a
   sidebar sai de "ociosa" e a statusline aparece) — inclusive numa distro
   **sem `node`**, já que o shim nunca usa o node de lá;
4. conferir o aviso numa distro com o interop desligado.

Está anotado no backlog interno do dono como verificação manual.

## Retomar o Claude Code ao reabrir

O layout volta quando o Bridge reabre, e a sessão do Claude Code volta com ele:
o painel sobe com `claude --resume <id>`, na mesma conversa em que estava.

Como o core sabe disso:

- **Qual conversa era.** Todo hook do Claude Code traz o `session_id` dele. O
  core grava esse id na sessão (`Session.agentSessionId`, memória) e no painel
  (`Pane.lastAgentSessionId`, SQLite — é o que sobrevive ao fechamento). Desde
  a 0.7.0 o id **sobrevive também a um shell no painel**: quem decide retomar
  sozinho continua sendo `lastKind`/`lastEndedBy`, mas o painel que voltou como
  shell guarda qual era a conversa — é o que o `bridge resume` lê depois.
- **Quem encerrou.** `Pane.lastEndedBy` é `'app'` quando o painel estava com um
  agente e quem acabou com ele foi o Bridge, e `'user'` quando o processo saiu
  com o core de pé — `/exit`, ✕, fechar painel, crash. Só o caso `'app'` é
  retomado: quem digitou `/exit` fechou a conversa de propósito, e o painel dele
  volta como shell com a dica de sempre. Desde a **0.12.1** a marca `'app'` é
  escrita quando o agente SOBE (ela quer dizer "se o app morrer agora, retome"),
  então **retomar não depende mais de um encerramento limpo**: o instalador que
  mata o Bridge sem avisar, o desligamento do Windows e um core que simplesmente
  morre deixam o painel retomável do mesmo jeito.
- **Como sobe.** `POST /api/sessions { paneId, kind: 'agent', agent: 'claude',
  resume: '<id>' }` — o adaptador acrescenta `--resume <id>` logo depois do
  `--settings`. Sem id não há fallback pro `--continue`: com dois Claudes na
  mesma pasta ele é ambíguo e retomaria a conversa do painel errado; nesse caso
  sobe um Claude limpo.

O que se vê na tela: o painel volta rotulado **claude** (não `shell`), e o
terminal abre com uma linha cinza — `retomando a sessão anterior do Claude Code
· 9f1a2b3c` — antes do primeiro desenho do agente. Os oito caracteres são o
começo do id da conversa, o mesmo prefixo que o `claude --resume` mostra na
lista dele. Se o Claude não subir (binário fora do PATH, pasta que sumiu), o
painel cai pro shell com a dica antiga e o rodapé conta o motivo: "Não deu pra
retomar o Claude Code: …".

E o `Ctrl+Shift+C` deixou de virar dois terminais: o atalho divide o painel
quando ele já tem sessão viva, e antes da 0.6.0 o painel voltava como shell —
quem apertava o atalho pra recuperar o Claude ganhava um split. Agora o painel
já volta como Claude e não há o que apertar.

Pra desligar: **Configurações → Sessões → "Ao reabrir, retomar as sessões do
Claude Code automaticamente"** (`restore.resumeAgents` no `config.json`, ligado
por padrão). Desligado, o painel de agente volta como shell com a dica "a
sessão anterior era Claude Code", que é o comportamento da 0.5.0.

Um banco de uma versão anterior sobe normalmente: as colunas novas
(`last_agent_session_id`, `last_ended_by`) entram por migração idempotente e
ficam nulas — painel sem id e sem marca não retoma nada.

### Restauração × workspace nascendo (0.9.0)

A restauração roda **uma vez por workspace**, na primeira vez que ele vira o
ativo. Ela tem que ficar quieta enquanto um workspace está NASCENDO: o core
emite `layout.changed` ao criar, antes de responder o `POST`, então o workspace
novo vira o ativo com o painel ainda vazio — e o Claude que o diálogo pediu leva
segundos pra subir. Reabrir um shell ali seria um `pwsh` por cima do que o
usuário pediu.

O que mudou na 0.9.0: esse silêncio passou a ser **escopado ao workspace que
pode estar nascendo**, e deixou de ser definitivo.

- Cada criação em voo guarda os workspaces que **já existiam** quando ela
  começou. Um workspace que estava lá não pode ser o que está nascendo, e
  restaura normalmente — antes, qualquer criação em voo silenciava qualquer
  workspace que virasse ativo naquela janela.
- Um workspace silenciado **não fica marcado como restaurado**: quando a criação
  termina, ele é reexaminado sozinho, sem depender de você sair dele e voltar.
  Antes a marca era gravada mesmo no pulo, e o workspace perdia a restauração
  para o resto daquela execução do app (só reabrindo painel por painel à mão).
- Duas criações podem se cruzar e terminar fora de ordem (o diálogo de workspace
  leva um `Escape` no meio do `POST` e o de tarefa responde primeiro): cada uma
  tem identidade própria, então o fim de uma nunca solta o silêncio da outra.

O workspace que a criação de fato criou continua sem restauração automática: ele
já nasce como você pediu, com ou sem Claude no primeiro painel.

## Quando o resume volta vazio

`claude --resume <id>` (e o `--continue`) às vezes sobe sem erro nenhum e abre
uma conversa **nova**: o painel acende, o agente responde, e o contexto
acumulado simplesmente não está lá. Você só descobre quando pergunta algo que
depende do que já tinha sido dito. É uma das dores mais relatadas de quem usa o
Claude Code por muito tempo no mesmo projeto, e o Bridge está numa posição
privilegiada pra ver isso acontecer.

**Como o Bridge percebe.** Todo hook do Claude Code carrega o `session_id` que
o agente adotou, e o `SessionStart` carrega também o `source` (`resume`,
`startup`, `clear`, `compact`). Quando o painel pediu uma conversa e o primeiro
`SessionStart` volta com **outro id** — ou com um `source` que não é `resume` —
o Bridge marca a sessão como `resumeOutcome: 'fresh'` e o painel mostra uma
faixa:

> A conversa anterior não foi retomada (o Claude abriu uma sessão nova).
> **[Reabrir com contexto]** **[Ignorar]**

Se o payload não trouxer nem id nem `source`, não há veredito e a faixa não
aparece: um alarme falso aqui ensinaria você a ignorar o aviso.

**O que "Reabrir com contexto" faz.** O Bridge lê o transcript da conversa
antiga (`<claudeHome>/projects/<pasta do cwd>/<id>.jsonl`, o mesmo lugar de onde
sai o monitor de uso) e monta um resumo **determinístico** — nenhum modelo é
chamado pra isso:

- o **último pedido seu** e as **últimas três respostas de texto** do agente;
- `tool_use`, `tool_result`, subagentes e as linhas de metadado ficam de fora;
- cada trecho é truncado em 600 caracteres e o resumo inteiro em **2 500**;
- tudo passa por `sanitizeDisplay` e sai em **uma linha só** — o texto é escrito
  no prompt do agente, e uma quebra de linha ali dentro seria um Enter no meio
  do resumo.

Aí ele escreve no terminal, com um Enter no fim:

```
Contexto da sessão anterior (resumo automático do Bridge): Último pedido seu: … · Últimas respostas do agente: … — Continue de onde parou.
```

**Isso não é o contexto de volta**, e a faixa não promete isso. É o suficiente
pra o agente novo saber de que assunto vocês estavam falando; o histórico
detalhado ficou no transcript antigo.

**Ignorar** some com o aviso daquela sessão sem escrever nada. A marca é por
sessão, não por painel: um resume vazio no mesmo painel meia hora depois volta a
avisar.

**Fazer sozinho.** Em **Configurações → Sessões**, a opção *"Ao falhar o resume,
injetar o resumo automaticamente"* (`sessions.autoRecap`) faz a injeção
acontecer sem clique. Ela nasce **desligada**: escrever no prompt do agente é a
única coisa aqui que mexe no seu terminal por conta própria.

**As três respostas de "não deu"**, todas legítimas:

| resposta | o que aconteceu |
| --- | --- |
| `no-resume` (422) | a sessão não pediu pra retomar conversa nenhuma |
| `transcript-not-found` (404) | o `.jsonl` daquela conversa não está mais no disco |
| `recap-empty` (422) | o transcript existe, mas só tem chamada de ferramenta |

A rota é `POST /api/sessions/:id/recap` e devolve `{ "text": "…" }`. Ela só
monta o resumo — quem escreve no PTY é a UI, com um `POST
/api/sessions/:id/input`. Quer dizer: **nada é escrito no seu terminal sem um
clique seu** (ou sem a opção acima ligada).

## Rotas de tarefa e git (Fase 3)

Todas em `/api`, com `Authorization: Bearer <token>`.

| Rota | O que faz |
|---|---|
| `GET /api/repos` | os repositórios que o Bridge já detectou (`{ id, path, name }`) — é a lista do diálogo |
| `GET /api/git/detect?cwd=<pasta>` | `RepoInfo \| null` sem criar nada: `{ root, branch, isWorktree, base?, worktreePath?, mainPath }`. É o que diz, no diálogo, se a pasta escolhida serve |
| `POST /api/tasks` | `{ repoId? \| repoPath?, name, base?, agent?: 'claude' }` → `201 { workspace, tab, pane, session? }`. Cria o worktree, o branch e o workspace |
| `GET /api/workspaces/:id/git` | o `GitStatus` corrente `{ branch, base, ahead, dirty, at, error? }`; `404 { code: 'not-worktree' }` num workspace comum. `error: 'missing'` = a pasta do worktree sumiu do disco |
| `POST /api/workspaces/:id/git/refresh` | recalcula agora (204). Não precisa de corpo — e `content-type: application/json` com corpo vazio é aceito (vale pra toda rota da API) |
| `PATCH /api/workspaces/:id/worktree` | `{ base }` → o workspace atualizado. Troca o base do worktree; recusa `422 { code: 'unknown-ref' }` se o ref não existir |
| `POST /api/workspaces/:id/merge` | `{ mode: 'ff-only' \| 'no-ff' }` → `{ mode, message? }` |
| `DELETE /api/workspaces/:id/worktree` | 204; mata as sessões, remove a pasta e o branch, tira o workspace do layout |

`POST /api/sessions` aceita **`initialCommand`** (string, ≤ 2000 chars): o core
escreve `initialCommand + '\r'` no PTY depois do **primeiro byte que o shell
imprime** (piso de 200 ms, teto de 3 s) — esperar o prompt aparecer é o que
impede o pwsh de engolir o começo da linha numa máquina carregada. É como o
"Ver diff" abre o `git diff` num painel sem precisar de um tipo de sessão novo.
Erros dessa rota também vêm com `code` (`pane-not-found` 404, `pane-busy` 409,
`agent-unavailable`/`unknown-agent`/`cwd-missing` 422); qualquer outra falha é
bug do Bridge e sai como 500.

Erros: `409` pro estado do repo que o usuário resolve (`exists`, `dirty-base`,
`dirty-worktree`, `not-merged`, `not-ff`, `conflict`, `base-not-checked-out`,
`base-in-use`) e `422` pro pedido que o git não executou (`not-a-repo`,
`invalid-name`, `no-commits`, `unknown-ref`, `git-failed`). O corpo é sempre
`{ error, code, detail? }` — a UI decide pelo `code`, nunca pelo texto.

**`GET /api/keybindings`** devolve a tabela de atalhos em vigor (os defaults da
spec §6 com o `keybindings.json` do perfil por cima, ação por ação). Quando o
arquivo tem problema, a resposta ganha um campo irmão `problems`, uma lista de
`{ kind, action? }`: `json-invalido` e `nao-e-objeto` (o arquivo inteiro foi
descartado), `acao-desconhecida` (uma chave que não é ação — typo) e
`atalho-invalido` (valor que não é uma string não vazia). Arquivo impecável, ou
ausente, responde **sem** o campo — exatamente o que a rota respondia antes. Os
mesmos problemas continuam indo pro `core.log` em `warn`; o campo existe porque
o `warn` não chega a quem está com o diálogo de configurações aberto.

**Sessão que não morre.** Fechar aba (`DELETE /api/tabs/:id`), fechar workspace
(`DELETE /api/workspaces/:id`) e remover a tarefa
(`DELETE /api/workspaces/:id/worktree`) encerram as sessões **antes** de mexer
no layout. A tentativa acontece em todas elas: uma sessão travada não aborta o
lote, as irmãs morrem do mesmo jeito. Se alguma resistir, a resposta é
`500 { error, code: 'kill-failed', killed, failed, failedIds }` — o desfecho
dos dois lados, com o id de quem ficou de pé — e o layout **fica** (removê-lo
por cima de um PTY vivo deixaria o processo órfão, sem painel que o mostre).
Repetir a chamada é seguro: a segunda tentativa só encontra as teimosas.

## Duas rotas que não são da UI

- **`POST /api/shutdown`** (bearer) — encerramento gracioso: responde `202` e,
  no tick seguinte, roda o `stop()` do core (mata as sessões, apaga
  `instance.json`, esvazia o log) e sai com código 0. É o que o shell chama
  antes de considerar o `taskkill`.
- **`GET /ws?events=<prefixos>`** — filtro de eventos por prefixo de `type`,
  separados por vírgula (ex.: `events=notification,session,layout`). O servidor
  só manda os eventos que casam; o `hello` vai sempre. Sem o parâmetro, vai
  tudo (é o que a UI usa — ela precisa do `pty.data`). Quem usa o filtro é o
  processo main do Electron, que decide toast e badge sem desenhar terminal
  nenhum e não tem o que fazer com o volume de `pty.data` — e o
  `bridge watch --events …` da CLI, que é o mesmo parâmetro pela linha de
  comando. Um cliente que não é browser (a CLI, o shim, o main do Electron)
  não manda header custom no handshake, então o `/ws` também aceita o token
  por `?token=`. O evento
  `workspace.git` (os badges `+N ~M`) entra no prefixo `workspace` — e quem
  filtra esse prefixo **não** conta como "alguém olhando" pro poller de git: o
  core só roda `git` quando existe cliente que receberia o resultado.

## CLI `bridge` (Fase 4)

Cliente de linha de comando fino do core (`packages/cli`, `@bridge/cli`) —
zero dependências em runtime: usa só o `fetch` do Node 22+.

**Descoberta da instância.** Primeiro `BRIDGE_PORT`/`BRIDGE_TOKEN` do
ambiente — todo painel que o Bridge abre já tem os dois (é a env de dentro de
um terminal do próprio app, `baseEnv` do shell); sem eles, lê
`%APPDATA%\bridge\instance.json` (ou `%BRIDGE_PROFILE_DIR%\instance.json`) e
confirma que o `pid` gravado ainda está vivo. Sem core rodando (arquivo
ausente, corrompido, ou processo morto), qualquer comando sai com código `1` e

```
Bridge não está aberto (instance.json não encontrado ou core morto)
```

— e a CLI nunca imprime o token, nem aceita um por argumento.

**"A sessão atual".** `bridge notify` sem `--session` e `bridge new` sem
`--workspace` usam a sessão de `BRIDGE_SESSION` do ambiente — a mesma
variável que o Bridge injeta em todo PTY que ele cria (spec §3). Sem
`BRIDGE_SESSION` nem a flag, `bridge notify` sai com `1` e "sem sessão: use
--session ou rode de dentro de um painel do Bridge".

### Comandos

```
bridge notify "texto" [--session <id>]
bridge list [--json]                                     # id, workspace, estado, detail, há quanto tempo
bridge focus <sessionId|workspace>                        # leva a janela até a sessão: workspace, aba, painel
bridge new [--agent claude] [--cwd <pasta>] [--workspace <id>] [--split v|h]
bridge task new <repo> <nome> [--base <branch>] [--no-agent]   # <repo> = id conhecido ou pasta
bridge task merge <workspace> [--no-ff]                   # default ff-only; --no-ff se recusar com not-ff
bridge task rm <workspace>
bridge resume [paneId]                                    # retoma a conversa do agente daquele painel
bridge send <sessionId> "texto"                           # escreve no stdin (a CLI põe o \r)
bridge status [--json]
bridge usage [--range dia|semana|mes|ano] [--anchor AAAA-MM-DD] [--json]  # consumo, custo estimado e limites em tabela de texto
bridge usage --de AAAA-MM-DD --ate AAAA-MM-DD [--json]    # período personalizado (até 366 dias)
bridge usage --rescan [--json]                            # relê todas as transcrições do zero
bridge watch [--events notification,session] [--json]     # os eventos do core, um por linha, até Ctrl+C
bridge --help | --version                                 # stdout, código 0, sem precisar do core
```

`bridge` sem argumento nenhum, `bridge help` e `bridge --help` imprimem a
mesma ajuda no **stdout** e saem com `0` — inclusive com o Bridge fechado, que
é justamente quando alguém procura a lista de comandos. `--version` imprime só
o número.

`<workspace>` (em `focus`/`new`/`task merge`/`task rm`) aceita
id **ou** nome — resolvido contra `GET /api/state`. Nome não é único: se mais
de um workspace tiver o mesmo nome, a CLI sai com `1` listando os ids pra
desempatar (`nome ambíguo: 2 workspaces chamados 'x' — use o id: ws_a
(C:\...), ws_b (C:\...)`). `--json` funciona em **todos** os comandos: imprime
o corpo cru em vez da frase/tabela em pt-BR.

**Retomar a conversa.** `bridge resume [paneId]` sobe de novo, **no painel**, o
agente que rodava ali, com `claude --resume <conversa>` — o mesmo caminho da
restauração da UI (§10 da spec), só que pedido da linha de comando. Quem
escolhe agente, pasta e conversa é o painel (`lastAgent` /
`lastAgentSessionId`), não a linha de comando. Sem `paneId` vale o painel da
sessão corrente (`BRIDGE_SESSION`) ou, fora de uma sessão do Bridge, o painel
em foco.

**Shell vivo no painel dá lugar ao agente**: com o `restore.resumeAgents`
desligado (ou com o resume da subida falhando) o painel volta como shell — mas
guardando qual conversa rodava ali —, e é de dentro dele que o comando é
digitado; o core encerra esse shell e sobe o agente no lugar. Um **agente**
vivo, esse sim, barra: sai com `1` e "este painel já está com um agente"
(`409 { code: 'pane-busy' }`), e aí o jeito é passar outro `paneId`. Painel que
nunca teve agente sai com `1` e "Este painel não tem conversa pra retomar"
(`422 { code: 'nothing-to-resume' }`).

O shell só cai **depois** de tudo ter dado certo: o core valida agente
(`claude --version`), pasta e conversa primeiro e só então encerra o que estava
no painel. Pedido recusado — sem conversa guardada, Claude fora do PATH, pasta
do painel que sumiu — deixa o terminal que você tinha na mão exatamente onde
estava. `--json` devolve a sessão criada mais `resumedFrom`, o id da conversa
retomada.

Uma consequência de encerrar o shell: rodado DE DENTRO do painel que está
sendo retomado, o `bridge` morre junto com o PTY e a frase "Retomando a
conversa…" (ou o `--json`) pode não aparecer. O retorno visível é o painel
virando o agente; de outro painel (`bridge resume <paneId>`) a saída sai
normal.

**Uso pela linha de comando.** `bridge usage` imprime o mesmo relatório do
painel em texto: totais (entrada, saída, cache com a repartição
escrita/escrita 1h/leitura, mensagens e o custo estimado com a data da
tabela), a linha "inclui subagentes: N% dos tokens", a tabela por modelo, os
**5 maiores projetos** (o resto vira uma linha `outros (N projetos)`, somada e
não escondida) e as janelas de limite. `--range` aceita os nomes em pt-BR
(`dia`, `semana`, `mes`, `ano`) e também os da API (`day`, `week`, `month`,
`year`); sem a flag, é `dia`. `--anchor AAAA-MM-DD` escolhe QUAL dia, semana,
mês ou ano (o que contém aquela data; sem ela, o atual) — `bridge usage --range
mes --anchor 2026-08-01` é agosto inteiro. `--de AAAA-MM-DD --ate AAAA-MM-DD`
(ou `--from`/`--to`) é um período personalizado, inclusivo, de até 366 dias e
a partir de 01/01/2020; não combina com `--anchor`. No painel `Ctrl+Shift+Y`
são os mesmos recortes, com ‹ › pra andar entre períodos e duas datas no
"personalizado".

Ele fala com a MESMA rota que a tela (`GET /api/usage`), então não existe
chance de o número do terminal divergir do número do painel — não há segunda
conta. Com `usage.showCost` desligado, nenhuma linha escreve dinheiro. Se a
varredura ainda estiver rodando, a primeira linha avisa ("varredura em
andamento: N de M transcrições lidas — os números ainda vão subir"), porque um
total baixo por leitura incompleta se parece com um total baixo de verdade.

`bridge usage --rescan` zera as contagens e relê tudo (é o mesmo
`POST /api/usage/rescan` do botão das Configurações) e responde quando termina:
`Releitura concluída: 8.431 transcrições, 184.000 mensagens, 96 dias com
consumo.` Ele **recusa** `--range`, `--anchor`, `--de` e `--ate` junto —
releitura não tem recorte, e ignorar a flag deixaria você achando que releu "o
mês".

**Assistir aos eventos.** `bridge watch` liga no `WS /ws` do core e imprime
**uma linha por evento** até você apertar `Ctrl+C`. Sem flag vem a hora, o
`type` e o id que o evento carrega (`12:03:41  notification.new  ntf_ab12`);
com `--json` sai o corpo cru do evento, um JSON por linha — pronto pra `| jq`,
porque a linha de status ("# ligado em 127.0.0.1:…") vai pro **stderr**.

`--events` recebe **prefixos** de `type` separados por vírgula e é o mesmo
filtro `?events=` que o processo main do Electron usa: `--events notification`
pega `notification.new` e `notification.read`; `--events session,workspace`
pega o estado das sessões e o `+N ~M` dos worktrees. Sem a flag vem tudo,
`pty.data` incluído — que num painel ativo é muita coisa. A primeira linha é
sempre o `hello` (o snapshot que abre a conexão); ele ignora o filtro de
propósito, senão um cliente começaria sem estado nenhum. O token **não** é
impresso.

**Sessão que não existe.** `bridge notify` e `bridge send` contra uma sessão
inexistente (ou já encerrada) saem com `1` e "sessão não encontrada" — a rota
responde `404 { code: 'session-not-found' }`. Antes disso a chamada dizia
"avisado"/"enviado" sem nada ter acontecido. Os hooks dos agentes (`/hooks/*`)
seguem lenientes de propósito: um agente não pode quebrar porque o Bridge já
encerrou a sessão dele.

**Flags.** `--flag valor` e `--flag=valor` são equivalentes; `--flag` sozinho
é booleano (`--no-agent`, `--no-ff`). Uma flag que o comando não reconhece sai
com `1` e "flag desconhecida: --x". `--` encerra o parser de flags — tudo
depois dele vira texto, mesmo que comece com `--`: é o jeito de mandar um
texto pra `notify`/`send` que começa com `--` sem virar (tentativa de) flag —
`bridge notify -- "--urgente: build quebrou"`. Sem aspas, `notify`/`send`
juntam os positionals restantes com espaço (`bridge send <id> echo duas
palavras` manda `echo duas palavras`).

### No app instalado

`npm run dist` empacota a CLI junto: o app instalado fica com `bridge.cjs` e
`bridge.cmd` em

```
%LOCALAPPDATA%\Programs\bridge\resources\cli
```

e o `installer.nsh` (NSIS) **põe essa pasta no PATH do usuário** durante a
instalação — e a tira na desinstalação. A gravação é feita **no registro**
(`HKCU\Environment`), lendo o valor cru
(`GetValue(..., DoNotExpandEnvironmentNames)`, pra um `%VAR%` no PATH não ser
congelado no que ele vale hoje) e escrevendo de volta sempre como
`REG_EXPAND_SZ` (`Set-ItemProperty -Type ExpandString`), que é o tipo canônico
dessa chave; depois um `WM_SETTINGCHANGE` avisa o Windows. Um terminal aberto
DEPOIS da instalação enxerga o comando:

```
where bridge          # ...\resources\cli\bridge.cmd
bridge status
```

Por que não `[Environment]::SetEnvironmentVariable(…, 'User')`: ele grava
`REG_SZ` quando o valor não tem `%`, e trocar o tipo do PATH de usuário faz um
`%JAVA_HOME%\bin` que estava lá deixar de expandir. Por que não `ReadRegStr`
do NSIS: ele trunca no `NSIS_MAX_STRLEN`, e reescrever o truncado apagaria o
resto do PATH em silêncio.

**Se não funcionar** (PowerShell bloqueado por política na hora da instalação,
ou app instalado antes desta versão), dá pra pôr na mão — a instalação não é
desfeita por isso. **Não use `setx`**: ele trunca em 1024 caracteres e grava
`REG_SZ`, ou seja, pode destruir o PATH da sua conta. No PowerShell, no escopo
do usuário:

```powershell
$k = 'HKCU:\Environment'
$p = (Get-Item $k).GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$d = "$env:LOCALAPPDATA\Programs\bridge\resources\cli"
if (($p -split ';') -notcontains $d) {
  Set-ItemProperty -Path $k -Name Path -Value (($p.TrimEnd(';') + ';' + $d)) -Type ExpandString
}
```

…ou pelo Painel de Controle → "Editar as variáveis de ambiente da sua conta" →
`Path` → Novo (que faz a coisa certa sozinho). Nos dois casos, abra um
terminal NOVO depois. O que o Windows resolve como `bridge` é o **`.cmd`**, não
o `.cjs` — por isso os dois arquivos ficam lado a lado. O `.cmd` honra
`BRIDGE_NODE` (caminho do `node.exe`) antes do PATH e, sem nenhum dos dois,
diz "Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=&lt;caminho&gt;)" em
vez do `'node' não é reconhecido` do cmd.exe.

> A gravação do PATH pelo NSIS é exercitada só numa instalação de verdade (o
> `npm run dist` gera o `.exe`, não o executa).

### Usar em dev (sem instalar)

```
npm run build:cli            # esbuild -> packages\cli\bin\bridge.cjs (single file)
```

Sem PATH nenhum, dá pra chamar direto: `node packages/cli/bin/bridge.cjs list`
— é assim que o e2e roda a CLI, e é o que se usa como `initialCommand` de uma
sessão (`node "<caminho>\bridge.cjs" notify oi`). Pra virar o comando `bridge`
dentro do checkout, adicione `packages\cli\bin` ao PATH do usuário — o
`bridge.cmd` ao lado do `.cjs` é o que o Windows resolve (`where bridge` tem
que achar o `.cmd`, não o `.cjs`).

Sem build nenhum, `npx tsx packages/cli/src/index.ts status` também roda: a
versão sai como `dev`, porque quem carimba o número de verdade é o `define` do
esbuild.

## Troubleshooting

**`npm install` reclama de node-pty / a sessão não sobe com erro de módulo
nativo.** node-pty é compilado contra a versão do Node. Trocou de Node, é
preciso recompilar:

```
npm rebuild node-pty
```

Se falhar, faltam as ferramentas de build do Windows (Visual Studio Build Tools
com "Desktop development with C++" e Python 3). O `AttachConsole failed` que
aparece no stderr a cada `kill()` **não** é esse problema: é ruído conhecido do
node-pty, sem efeito funcional.

**"Token inválido" (401) na UI.** O token é sorteado a cada subida do core: o
que está no localStorage do browser é o da instância anterior. Pegue o novo em
`%APPDATA%\bridge\instance.json` (campo `token`) e cole de novo na tela inicial.
O arquivo some no encerramento limpo; se ele existe mas o core não responde, é
um `instance.json` órfão de um processo morto.

**"porta 4560 ocupada — outra instância do Bridge?"** Já tem um core de pé
(ou outro programa nessa porta). Confira o `pid` em `instance.json` e encerre a
instância antiga, ou mude a porta em `%APPDATA%\bridge\config.json`
(`{ "port": 4570 }`) — lembrando de ajustar o alvo do proxy em
`packages/ui/vite.config.ts`.

**A sidebar mostra `0k ctx`.** O core foi lançado de dentro de uma sessão do
Claude Code e o filho herdou os marcadores de sessão-filha — ver o aviso do
smoke real abaixo. O Bridge já remove esses marcadores; se persistir, confira se
a sessão está mesmo com o `statusLine` do Bridge no `settings.json` dela.

## Avisos do smoke real (03/09/2026)

- **Diálogo de confiança da pasta.** Na primeira vez que o Claude Code abre numa pasta, ele mostra
  "Is this a project you created or one you trust?" com o cursor em **"No, exit"**. Enter puro
  encerra a sessão (o anel vai pra `exited`). Use **↓ e depois Enter** pra confiar. Isso é do Claude
  Code, não do Bridge.
- **`needs-input` só aparece se o Claude pedir permissão.** Conta em modo automático (ou tool no
  allowlist) roda sem perguntar, então o anel vai direto de `running` pra `done`. Pra ver o âmbar
  pulsando, use uma sessão em modo de permissão padrão e peça algo fora do allowlist.
- A statusline do Bridge junta contexto, modelo, custo e janelas numa linha só;
  a sidebar mostra a segunda e transforma a primeira em badges.
- Se o core for lançado de dentro de uma sessão do Claude Code, o Bridge remove os marcadores de
  sessão-filha (`CLAUDE_CODE_CHILD_SESSION` etc.) da env do PTY; sem isso o Claude filho desliga o
  transcript e a statusline mostra `0k ctx`.

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — o mapa do código: os três processos, o shim dos hooks, o modelo de domínio, onde procurar cada coisa.
- [`SECURITY.md`](SECURITY.md) — modelo de ameaça, proteções em pé, riscos aceitos e como reportar uma falha.
- `CHANGELOG.md` — o que cada versão entregou, da 0.1.0 em diante.
- `docs/adr/` — decisões de arquitetura (sidecar, hooks por sessão, painel 1:1, UI servida pelo core, toasts, worktrees, empacotamento, monitor de uso, hooks de WSL por interop, wrapper `claude` no PATH do shell).
- `CONTRIBUTING.md` — como rodar, testar, empacotar e mandar um PR.

> Os ledgers de execução (`.superpowers/sdd/`) e o material de direção visual
> (`design/`) ficam **fora** deste repositório, por `.gitignore`. Alguns
> documentos em `docs/` citam esses caminhos: as decisões que importam foram
> promovidas pros ADRs e pro CHANGELOG.
