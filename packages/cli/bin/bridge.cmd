@echo off
rem Bridge CLI — o que o Windows resolve como `bridge` (o instalador põe esta
rem pasta no PATH do usuário). O `.cjs` ao lado é o bundle de verdade.
rem
rem BRIDGE_NODE tem prioridade sobre o PATH: quem tem o Node só num nvm/volta
rem por sessão (ou instalou o Bridge numa máquina sem Node no PATH do sistema)
rem aponta o executável por ali. Sem nenhum dos dois, a mensagem é do BRIDGE,
rem não o "'node' não é reconhecido..." do cmd.exe — sem acento de propósito,
rem porque o console do Windows sai em codepage OEM.
setlocal EnableExtensions
set "BRIDGE_NODE_EXE=%BRIDGE_NODE%"
if not defined BRIDGE_NODE_EXE (
  where node >nul 2>nul && set "BRIDGE_NODE_EXE=node"
)
if not defined BRIDGE_NODE_EXE (
  >&2 echo Bridge precisa do Node.js 22+ no PATH ^(ou BRIDGE_NODE^=^<caminho^>^)
  exit /b 1
)
"%BRIDGE_NODE_EXE%" "%~dp0bridge.cjs" %*
