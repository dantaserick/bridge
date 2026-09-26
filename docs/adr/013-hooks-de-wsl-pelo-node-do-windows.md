# ADR-013 — Hooks de uma sessão em WSL rodam pelo Node do Windows, por interop

**Status:** aceita (0.11.0, dor verificada #2 — spec §3/§5)

## Contexto

A partir da 0.11.0 o ambiente da sessão é do workspace, e com
`{ kind: 'wsl', distro }` o shell **e** o Claude Code sobem dentro da distro
(`wsl.exe -d <distro> --cd <cwd traduzido> -- sh -lc …`). O estado da sidebar,
porém, continua vindo dos hooks: o `settings.json` da sessão aponta todos eles
pro shim `bridge-hook.cjs`, que faz `POST http://127.0.0.1:<porta>/hooks/…` no
core (ADR-004).

O caminho óbvio — rodar o shim com o `node` da própria distro, e cair no Node do
Windows só quando ela não tem um — foi implementado primeiro e **está errado**:
no modo de rede padrão do WSL2 (NAT) o loopback **não** é compartilhado com o
host. De dentro da distro, `127.0.0.1` é a própria distro, e o POST do shim não
chega em core nenhum. O `networkingMode=mirrored` compartilharia, mas é opcional
e recente: depender dele seria depender de uma configuração que a máquina de
quem instala talvez não tenha — e a falha é silenciosa (a sessão sobe, os hooks
somem, a sidebar fica em "ociosa" pra sempre).

## Decisão

O shim de uma sessão em WSL é executado **sempre** pelo `node.exe` do Windows,
alcançado de dentro da distro por interop — nunca pelo `node` da distro, mesmo
quando ela tem um. O caminho do executável é derivado do `process.execPath` do
core **pelo próprio `wslpath`** (nada de `/mnt/c/Program Files/nodejs/node.exe`
escrito à mão), e o caminho do shim viaja em **forma de Windows**
(`C:\...\bridge-hook.cjs`), inclusive no `BRIDGE_SHIM`: o interop repassa o argv
sem tradução, e um `/mnt/c/...` chegaria ao `node.exe` como arquivo inexistente.

Como isso exige `binfmt_misc/WSLInterop` ligado, a sonda de cada distro
(`WSL_PROBE_SCRIPT`) responde três coisas — tem `claude`?, tem `node`?, o
interop está ligado? — e o interop vem **primeiro** no aviso: sem ele a sessão
até sobe, mas nenhum hook chega. `BRIDGE_PORT`, `BRIDGE_TOKEN`,
`BRIDGE_SESSION` e `BRIDGE_SHIM` atravessam a fronteira pela `WSLENV` (a do
usuário é preservada).

## Consequências

- Uma distro **sem `node`** deixa de ser um caso especial: o caminho é o mesmo
  pra todas, e o único requisito é o interop.
- `EnvironmentInfo.node` fica **informativo** (aparece na lista de ambientes),
  e `EnvironmentInfo.interop` é o que vira aviso de verdade.
- `resolveEnvContext` **falha** (`environment-unavailable`, 422) quando não
  consegue alcançar o Node do Windows por interop, em vez de subir uma sessão
  que nunca reportaria estado.
- O shim continua sendo o mesmo arquivo, com o mesmo contrato da ADR-004: o
  que muda é quem o executa e em que forma o caminho chega.
- Nada disso foi verificado numa distro REAL — a máquina de construção não tem
  nenhuma (`wsl -l -q` vazio, 06/09/2026). A cadeia inteira está sob teste
  contra um `wsl.exe` simulado, e a verificação manual está registrada no README.
