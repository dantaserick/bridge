# ADR-006 — UI empacotada é servida pelo core em `http://127.0.0.1:<porta>/`, nunca `file://`

**Status:** aceita (ruling da Fase 2, Task 5)

## Contexto

O `/ws` recusa `Origin` fora de loopback (defesa em profundidade), e um `BrowserWindow` carregando de `file://` manda `Origin: file://`. Além disso o token nunca deve ir na URL da janela.

## Decisão

O core serve o build da UI como estático (`@fastify/static`) quando `BRIDGE_UI_DIR`/`createCore({ uiDir })` está definido; caminhos que não sejam `/api`, `/ws`, `/hooks` (após normalização: decode, colapso de `//`, `posix.normalize`) vão pro estático sem bearer; os protegidos sempre caem na auth. O renderer obtém o token por `window.bridge.token()` (preload) e conecta em `/ws?token=`.

## Consequências

- Em dev, `BRIDGE_DEV=1` carrega o Vite em `http://127.0.0.1:5173` (mesma regra de origem).
- O bypass por `//api/state` e `/api%2Fstate` foi fechado com normalização e checagem por segmento.
