/**
 * O idioma DENTRO do processo main (spec §13).
 *
 * O shell tem um problema que a UI não tem: ele começa a falar ANTES do core
 * existir. O diálogo "o core não subiu" é, por definição, a frase de quem não
 * conseguiu perguntar nada ao core. Daí a resolução ter duas fases:
 *
 * 1. **No boot**, antes de qualquer coisa: `resolveLanguage('system',
 *    app.getLocale())`. É a locale que o Electron reporta, e vale só até o core
 *    responder.
 * 2. **Assim que o core sobe**: o `languageResolved` do `GET /api/config`, que é
 *    o MESMO campo que a UI e a CLI usam. A partir daí quem manda é o core —
 *    resolver `'system'` duas vezes, em processos diferentes, é o caminho mais
 *    curto pra bandeja falar uma língua e a janela outra (preocupação nº 5 do
 *    report da Task 1).
 * 3. **Depois**, a cada `config.changed` do canal de eventos que o main já
 *    escuta (`coreEvents.ts`): o menu da bandeja é remontado no idioma novo.
 *
 * É um valor MUTÁVEL de módulo, e não uma constante: constante é avaliada uma
 * vez, na importação, e a troca de idioma é ao vivo. Quem lê chama
 * `tShell(...)` NA HORA de mostrar, nunca guarda a frase.
 */
import { resolveLanguage, t } from '@bridge/shared';
import type { BridgeConfig, Language, MessageKey } from '@bridge/shared';

/**
 * Inglês é o valor inicial pela mesma regra do `systemLanguage` sem locale: até
 * alguém dizer o contrário (e o `bootLanguage` diz, na primeira linha do boot),
 * o idioma é o que mais gente lê.
 */
let current: Language = 'en';

/** O idioma em vigor no main, AGORA. */
export function shellLanguage(): Language {
  return current;
}

/**
 * Troca o idioma do main. Devolve `true` quando ele MUDOU de verdade — é esse
 * booleano que decide se vale remontar o menu da bandeja (um `config.changed`
 * de qualquer outro campo passa por aqui e não deve mexer em nada).
 */
export function setShellLanguage(next: Language): boolean {
  if (next === current) return false;
  current = next;
  return true;
}

/** O `t` do catálogo já preso no idioma do main. */
export function tShell(key: MessageKey, params?: Record<string, string | number>): string {
  return t(current, key, params);
}

/**
 * Fase 1: o idioma da MÁQUINA, pra janela entre o primeiro pixel e a primeira
 * resposta do core. `locale` é o `app.getLocale()` do Electron; ausente (ou
 * vazio) cai em inglês, a mesma regra do `systemLanguage` do `@bridge/shared`.
 */
export function bootLanguage(locale: string | undefined): Language {
  return resolveLanguage('system', locale);
}

/**
 * Fase 2 e 3: o idioma que o CORE resolveu.
 *
 * `undefined` quando a resposta não tem o campo — core de versão anterior ao
 * lote de idioma, ou um JSON que não é a config. Nesse caso o main FICA com o
 * que tinha (a locale do boot), em vez de cair pra inglês em cima de quem já
 * estava lendo português.
 */
export function languageFromConfig(config: Partial<BridgeConfig> | undefined): Language | undefined {
  const value = config?.languageResolved;
  return value === 'pt-BR' || value === 'en' ? value : undefined;
}

/** O `fetch` que o `readCoreLanguage` usa — injetável pro teste não subir core. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/**
 * Teto de espera do `GET /api/config` do boot. Sem ele, um core que aceita a
 * conexão e não responde (porta reciclada, processo travado) deixava esta
 * promessa pendurada pra sempre — e com ela a terceira fase do idioma.
 */
export const CONFIG_FETCH_TIMEOUT_MS = 2000;

/**
 * `GET /api/config` só pelo idioma. Nunca lança: um core que ainda não
 * respondeu, uma porta trocada no meio de um restart ou um 401 devolvem
 * `undefined`, e o main segue com a locale do boot — o idioma é o último
 * motivo aceitável pra derrubar a subida do app.
 */
export async function readCoreLanguage(
  port: number,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Language | undefined> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return languageFromConfig((await res.json()) as Partial<BridgeConfig>);
  } catch {
    return undefined;
  }
}
