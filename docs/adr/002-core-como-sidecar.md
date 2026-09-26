# ADR-002 — Core como sidecar do Node do sistema

**Status:** aceita (ruling da Fase 2, Task 5); **revisitar na Fase 5**

## Contexto

A spec §3 dizia que o main do Electron embutiria o core no mesmo processo. `node-pty` e `better-sqlite3` são módulos nativos: rodar dentro do Electron exige recompilá-los pro ABI do Electron (`@electron/rebuild`). O monorepo tem um `node_modules` só; a recompilação quebraria a suíte do core, que roda no Node 24 do sistema.

## Decisão

O main do Electron sobe o core como **processo filho** do Node do sistema (`BRIDGE_NODE` ou `node` do PATH) e fala com ele pela mesma API HTTP/WS que a UI usa. O sidecar lê `instance.json` pra descobrir porta e token. Encerramento: `POST /api/shutdown` com deadline de 1,5 s e `taskkill /t /f` de reserva (o `tsx` re-forka em dev, então `child.kill()` deixaria órfãos). Um core do perfil que continue vivo é **adotado** na subida seguinte se responder `GET /api/state` (e `GET /` quando o shell espera UI).

## Consequências

- O app **exige Node.js 22+ na máquina**. É o custo assumido até a Fase 5.
- Toda a comunicação main↔core passa pela API (bem: é a mesma fronteira da UI e da CLI; mal: o main não vê o bus in-process, então usa um cliente WS filtrado `?events=`).
- Reverter exige rebuild dos nativos numa instalação separada de produção, ou trocar `better-sqlite3` pelo `node:sqlite` e o `node-pty` por prebuild com ABI do Electron.
