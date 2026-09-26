/**
 * A grade (`cols`×`rows`) que o core JÁ SABE de uma sessão — a decisão pura por
 * trás de cada `resize` que o `Terminal` manda pelo WS.
 *
 * Ela mora fora do componente porque o `Terminal` não é testável aqui
 * (`packages/ui` roda `vitest` em `node`, e o lote não tem teste de
 * componente): dentro do efeito de montagem, a regra só podia ser conferida
 * lendo o arquivo. São duas perguntas, e as duas doem quando erradas:
 *
 * 1. **Mandar?** Só quando a grade MUDOU — arrastar poucos pixels não muda a
 *    grade de caracteres, e cada `resize` vira um `ConPTY.resize` no core. Sem
 *    grade conhecida (`undefined`) manda-se sempre: é o primeiro aviso da
 *    sessão, e é ele que tira o PTY dos `DEFAULT_COLS`.
 * 2. **Passou a saber?** Só quando o aviso SAIU. O `bridgeWs.send` descarta em
 *    silêncio com o socket fora do `OPEN` (não há fila) e a UI pede o
 *    `GET /api/state` ANTES de abrir o WS, então o primeiro `fit()` de um
 *    terminal pode acontecer com o handshake em voo. Gravando a grade assim
 *    mesmo, todo `fit()` seguinte deduplicaria em cima de um tamanho que o core
 *    nunca recebeu.
 */
export interface Grid {
  cols: number;
  rows: number;
}

/**
 * As duas respostas de uma vez: `send` é a decisão de dedupe (antes de mandar)
 * e `grid` é o que passa a valer como "o core JÁ SABE" depois da tentativa —
 * `next` só quando `sent` é `true`, senão o `last` continua valendo e o sync
 * seguinte manda de novo.
 */
export function gridAfterSync(
  last: Grid | undefined,
  next: Grid,
  sent: boolean,
): { send: boolean; grid: Grid | undefined } {
  const send = last === undefined || last.cols !== next.cols || last.rows !== next.rows;
  return { send, grid: sent ? next : last };
}
