/**
 * Escape de caminho de instalação para dentro de uma string de aspas SIMPLES
 * do PowerShell — a regra que o `installer.nsh` aplica com `${WordReplace}`
 * (BR-13).
 *
 * O NSIS substitui `$INSTDIR` TEXTUALMENTE dentro do `-Command "…"`, e a aspa
 * simples é caractere válido em nome de pasta no Windows: instalar em
 * `C:\Programas\O'Brien\Bridge` fechava a string em `O` e o resto virava token de
 * comando; uma pasta escolhida como `C:\x'; iwr …; '` executava o que viesse
 * depois, com `-ExecutionPolicy Bypass`, na instalação E na desinstalação (onde
 * o `$INSTDIR` vem do registro).
 *
 * Dentro de aspas simples o PowerShell não interpreta `$`, crase nem `;`: o
 * ÚNICO caractere que fecha a string é a própria aspa simples, e o escape dela
 * é dobrá-la. A aspa dupla — que fecharia o `-Command "…"` de fora — é
 * impossível em caminho do Windows.
 *
 * Esta função é a especificação executável da linha do `.nsh`: não há harness
 * de NSIS no repo, então o teste prende a REGRA aqui e confere, por leitura do
 * arquivo, que o `.nsh` continua aplicando-a.
 */
export function escapeForPowerShellSingleQuoted(path: string): string {
  return path.split("'").join("''");
}
