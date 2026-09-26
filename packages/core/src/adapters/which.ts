/**
 * `where.exe <bin>` — a pergunta "esse agente está instalado?" que os
 * adaptadores fazem no `available()`.
 *
 * Existe como módulo próprio porque `codex.ts` e `gemini.ts` carregavam a
 * MESMA função copiada (anotado no BACKLOG): duas cópias que precisavam ser
 * corrigidas juntas — o timeout, o `windowsHide`, o tratamento de saída vazia.
 * Fora do Windows `where.exe` não existe e a chamada falha; o `false` daí é o
 * desfecho certo (o adaptador diz "não encontrado no PATH"), não um crash.
 *
 * Nunca `shell: true`: o nome do binário é literal do código, mas a regra da
 * casa é execução por `execFile` com argumentos separados, sem exceção.
 */
import { execFile } from 'node:child_process';
import { t, type Language } from '@bridge/shared';

/** Teto por consulta. `where.exe` é local; passar disso é PATH de rede travado. */
export const WHICH_TIMEOUT_MS = 3000;

/** `true` quando o `where.exe` devolveu pelo menos um caminho pro binário. */
export function findOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('where.exe', [bin], { timeout: WHICH_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * O `available()` que `codex` e `gemini` compartilham: só a pergunta do PATH,
 * com a mesma frase de recusa — no idioma em vigor (spec §13). O `lang` vem de
 * quem pergunta (`core.language()`), porque a recusa vira `error.message` de
 * um 422 e é lida pelo dono.
 */
export async function availableOnPath(
  bin: string,
  lang: Language,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return (await findOnPath(bin))
    ? { ok: true }
    : { ok: false, reason: t(lang, 'core.erro.binNaoEncontrado', { bin }) };
}
