# Contribuir com o Bridge

Obrigado por olhar. O Bridge é um projeto pessoal de uma pessoa só, então a
melhor contribuição costuma ser uma **issue com repro** antes de um PR grande:
é barato pra você e me diz se a mudança cabe no desenho atual.

A documentação do projeto é em **português do Brasil** — README, ADRs, spec e
comentários de código. Issues e PRs em inglês são bem-vindos; só peço que o
texto que vai pro repositório continue em pt-BR, pra não ficar meio a meio.

**A interface é a exceção desde a 0.13.0:** ela fala pt-BR *e* inglês, e nenhum
texto de tela mora mais dentro de um `.tsx` ou de um `.ts` — tudo vem de um
catálogo de chaves. Ver "Como acrescentar uma string" abaixo.

## O que você precisa

- **Windows 11** x64 — o app é nativo de Windows (PTY via ConPTY, registro,
  NSIS). Não há build para Linux/macOS e não é um objetivo hoje.
- **Node.js 22+** no `PATH`.
- **Git**, com um repositório de verdade pra exercitar as rotas de worktree.
- Opcional, pra mexer no adaptador: o **Claude Code** (`claude` no `PATH`).

## Rodar

```
npm install                  # na raiz — é um monorepo de workspaces npm

npm run dev:core             # só o core (Fastify + node-pty + SQLite) em 127.0.0.1:4560
npm run dev:ui               # Vite em 127.0.0.1:5173, com proxy de /api e /ws pro core
npm run dev:app              # o app Electron inteiro (builda o shell e sobe o Electron)
```

`dev:core` + `dev:ui` abre a UI numa aba de browser: é o caminho mais rápido
pra mexer em core ou UI. O token da instância fica em
`%APPDATA%\bridge\instance.json` e a tela inicial pede ele.

Pra não sujar o seu perfil de verdade enquanto testa, aponte o perfil pra uma
pasta descartável:

```powershell
$env:BRIDGE_PROFILE_DIR = "$env:TEMP\bridge-dev"
```

## Testar

```
npm test                     # vitest em todos os pacotes
npm run typecheck            # tsc --noEmit nos cinco pacotes (TypeScript strict, ESM)
npm run build                # UI (Vite) + core, CLI e shell (esbuild)
npm run e2e                  # Playwright + Electron de verdade (16 cenários)
npm run dist                 # build + stage das deps do core + electron-builder (NSIS x64)
```

Um pacote de cada vez também funciona: `npm test -w @bridge/core`,
`npm run typecheck -w @bridge/ui`, e assim por diante.

O `npm run e2e` sobe **Electron, core e PTY reais** e no fim de cada cenário
confere que nenhum processo sobrou. **Nenhum script, teste ou agente mata
processo por NOME** (`Stop-Process -Name`, `taskkill /IM`): só por PID, e só PID
que ele mesmo criou — matar por nome derruba o Bridge que você tem aberto, que
tem o mesmo nome de imagem do que está sendo testado. Só **um** cenário levanta um Claude Code de
verdade (o do `resume`, que precisa de um agente real pra provar que o painel
volta como agente); os outros que precisam de um usam um `claude.cmd` falso no
começo do `PATH`, e o caminho do toast é exercitado por
`POST /api/sessions/:id/notify`, o mesmo `Notifications.push` que o adaptador
usa. Se você mexer em algo que muda a interface, rode o e2e
antes de abrir o PR — ele pega regressão de layout e de restauração que o
vitest não vê.

`npm run dist` precisa que o par
`packages/shell/stage/core.package.json` + `core.package-lock.json` descreva as
dependências de runtime do core. Depois de mudar as `dependencies` do
`packages/core`, regrave o par:

```
npm run stage:refresh-lock -w @bridge/shell
```

## Como o código é organizado

| Pacote | O que é |
| --- | --- |
| `packages/core` | O servidor: sessões PTY, hooks, git/worktree, SQLite, API HTTP/WS. Roda no Node do sistema. |
| `packages/shared` | Tipos, protocolo e o **catálogo de mensagens** (`src/i18n/`). É a única dependência comum entre core e UI — nada de `node:` aqui. |
| `packages/ui` | React + xterm.js. Só desenha o que o core manda; toda mutação é uma rota. |
| `packages/shell` | O Electron: janela, bandeja, toast nativo, empacotamento. |
| `packages/cli` | O comando `bridge`, um bundle CJS sem dependências de runtime. |

Decisões de arquitetura estão em `docs/adr/` — leia o ADR relevante antes de
propor mudar o que ele decidiu; se a decisão estiver errada hoje, o caminho é
um ADR novo que a substitua, não uma mudança calada.

Os ledgers de execução (`.superpowers/sdd/`) e o material de direção visual
(`design/`) ficam fora do repositório público, por `.gitignore`. O que vale de
lá foi promovido pros ADRs e pro `CHANGELOG.md`.

## Como acrescentar uma string (0.13.0)

Nenhum texto de tela mora num `.tsx`/`.ts`. Todos saem do catálogo em
`packages/shared/src/i18n/`, e a regra é curta:

1. **Escreva a chave nos DOIS arquivos** — `pt-BR.ts` (que é a fonte das
   chaves) e `en.ts`. Faltando no `en.ts`, ou sobrando lá, o
   `satisfies Record<MessageKey, string>` quebra o **typecheck** — não é um
   teste que avisa, é o compilador.
2. **O nome da chave é a SUPERFÍCIE, não o texto.** `sidebar.rodape.novaTarefa`,
   `uso.painel.total`, `dialog.tarefa.branchPreview` — assim reescrever a copy
   não obriga a renomear nada. Chave que descreve o texto (`novaTarefaAzul`)
   envelhece na primeira revisão de redação.
3. **Use** `t(lang, 'chave', { param })` no core/CLI/shared, `tUi(lang, …)` nos
   modelos da UI e `const { t } = useT()` nos componentes. Interpolação é
   `{nome}`; não há dependência de i18n nenhuma, e não vai ter.
4. **Plural é chave explícita**, não regra: `sessoes.uma` / `sessoes.varias`.
   As duas línguas que o Bridge fala têm a mesma forma de plural, e uma
   biblioteca de regras plurais custaria mais do que a linha do `if`.
5. **Passe `sanitizeDisplay` ANTES** em tudo que vem de PTY, de payload de hook
   ou de transcript — o catálogo interpola, ele não sanitiza. Um caminho de
   arquivo com `\r` dentro de um `{param}` desenha a linha errada na sidebar.
6. **Rode o teste do pacote.** Cada pacote tem uma guarda que varre o `src/`
   dele e falha listando `arquivo:linha` quando acha literal com acento ou
   palavra pt-BR comum fora do catálogo. Se a sua linha for uma exceção
   legítima (log em arquivo, invariante de parser), ponha um `// i18n-ignore`
   com o motivo ao lado.

**O ponto cego, que ninguém pode ignorar:** a guarda olha ACENTO. Copy sem
acento — `Todos`, `Base`, `Msg`, `Total`, e principalmente texto solto dentro de
JSX — passa batido. Depois de mexer num `.tsx`, dê uma passada de olho
procurando texto que você digitou e não pôs no catálogo; foi assim, e não pelo
teste, que os últimos foram achados.

**Um idioma novo** é, antes de tudo, **um arquivo novo** em `src/i18n/` com as
mesmas chaves — é o trabalho de verdade, e o `satisfies` diz quando ele está
completo. O resto é acrescentar o código a cinco listas de
`shared/src/i18n/index.ts` (a união `Language`, `LANGUAGES`,
`LANGUAGE_SETTINGS`, `CATALOGUES` e `INTL_LOCALE`), uma linha no
`LANGUAGE_KEYS` de `packages/ui/src/settingsModel.ts` (o mapa de opção → chave
do nome do idioma; sem ela o seletor não sabe como chamar a opção nova) e a
regra de `systemLanguage`, se a locale da máquina tiver que cair nele. Os dois
`z.enum` de `ui.language` (`api/schemas.ts` e `profile.ts`) **não** precisam ser
mexidos: os dois derivam do `LANGUAGE_SETTINGS`. O seletor da tela também não —
ele é gerado da mesma lista; só falta a chave `idioma.<código>` com o nome do
idioma **na própria língua**, em todos os catálogos. Fora
`CATALOGUES` e a lista de `MessageKey`, o TypeScript aponta cada lugar que
faltou — nenhuma dessas listas aceita ficar incompleta em silêncio.

## Convenções

- **TypeScript strict, ESM.** Sem `any` solto, sem `// @ts-ignore` sem
  explicação do porquê na linha de cima.
- **Teste junto com a mudança.** O padrão do repositório é vitest por pacote,
  testando função pura sempre que dá; rota nova ganha teste de rota.
- **Comentário explica o *porquê*, não o *o quê*.** Boa parte dos comentários
  daqui registra uma medição ou um erro que custou caro — mantenha esse
  padrão em vez de descrever o que a linha ao lado já diz.
- **Texto de interface: pelo catálogo, nunca literal** (ver a seção acima). O
  pt-BR é a fonte, com tratamento "você"; o inglês é escrito junto, na mesma
  mudança.
- **Nada de dependência nova sem necessidade clara.** O projeto é
  deliberadamente magro; cada dependência a mais é peso no instalador e
  superfície de manutenção. Se a sua mudança precisa de uma, diga na issue por
  quê antes de escrever o código.
- **Nenhum caminho da sua máquina no código.** Nada de caminho absoluto real
  nem do seu nome de usuário em default, teste ou documentação — use uma
  variável de ambiente, detecção, ou um placeholder genérico
  (`C:\projetos\meu-repo`, que é o que os fixtures usam).
- **Fim de linha é LF, e quem manda é o `.gitattributes`.** A raiz tem
  `* text=auto eol=lf`, com `.cmd`/`.bat`/`.ps1`/`.nsh` presos em `eol=crlf`
  (o `cmd.exe` não lê `.cmd` com LF de forma confiável) e os binários
  (`.png`, `.ico`, `.woff2`, `.exe`) marcados à mão, pra a heurística de
  conteúdo não decidir por eles e corromper um arquivo na normalização.
  Você não precisa configurar `core.autocrlf`: clone, edite e comite — se um
  diff seu vier com o arquivo INTEIRO mudado, é fim de linha, e o conserto é
  `git add --renormalize .`, não reescrever o arquivo.

## Fluxo de PR

1. Abra (ou comente em) uma issue descrevendo o problema e como reproduzir.
2. Faça um fork e crie um branch a partir do `main`, com nome descritivo
   (`fix/statusline-vazia`, `feat/atalho-fechar-aba`).
3. Faça commits pequenos, com mensagem no imperativo e em uma linha
   (`corrige a leitura do login item com --hidden`). O corpo, quando existir,
   explica o porquê.
4. Antes de abrir o PR: `npm test`, `npm run typecheck` e `npm run build`
   verdes. Rode `npm run e2e` se você tocou na UI ou no shell.
5. Na descrição do PR, diga o que muda pra quem usa o app, como você verificou
   e o que você **não** verificou. Um "não testei o instalador" honesto vale
   mais que um checklist otimista.

Mudanças que alteram a interface merecem um screenshot no PR — antes e depois.

## Reportar um bug

Inclua: versão do Bridge (canto do diálogo de configurações ou o nome do
instalador), versão do Windows, versão do Node (`node -v`), o que você fez,
o que aconteceu e o que você esperava. Se o app deu erro de subida, o log do
core está em `%APPDATA%\bridge\logs\core.log` e o do shell em
`%APPDATA%\bridge\logs\shell.log` — cole o trecho relevante, não o arquivo
inteiro.

## Segurança

O core escuta só em `127.0.0.1`, com um token por instância gravado em
`%APPDATA%\bridge\instance.json`. Se você encontrar algo que fure esse limite
(execução remota, vazamento de token, escrita fora do perfil), **não abra uma
issue pública**: mande uma mensagem privada pelo GitHub descrevendo o problema
e como reproduzir.

## Licença das contribuições

Ao abrir um pull request você concorda que a sua contribuição entra sob a
mesma licença do projeto, a [FSL-1.1-MIT](LICENSE).
