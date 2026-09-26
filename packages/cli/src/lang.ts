/**
 * O idioma da CLI (spec §13).
 *
 * A ordem é a mesma do resto do produto, com uma diferença que só existe aqui:
 * a CLI é um processo de UM comando, que morre antes de qualquer troca de
 * idioma acontecer. Não há nada a atualizar ao vivo — o idioma é resolvido uma
 * vez, no começo, e vale pro comando inteiro.
 *
 * 1. **`languageResolved` do `GET /api/config`** — a resposta do CORE, que é
 *    quem manda: foi lá que o dono escolheu, e é lá que a locale da máquina
 *    foi consultada. Resolver de novo aqui poderia dar OUTRO idioma no mesmo
 *    computador (o core roda como serviço, a CLI roda no terminal do dono, e
 *    `Intl` pode enxergar coisas diferentes nos dois).
 * 2. **`BRIDGE_LANG`** (`pt-BR` | `en`) — o Bridge fechado, ou o core sem a
 *    rota. Também é a saída de quem quer forçar um idioma num script sem
 *    mexer na configuração do app.
 * 3. **A locale desta máquina** (`Intl.DateTimeFormat().resolvedOptions()`),
 *    pela mesma regra do core: `pt*` → pt-BR, o resto → inglês.
 *
 * O `bridge --help` e o `bridge --version` param no passo 2: eles têm que
 * funcionar com o Bridge fechado — é exatamente quando alguém procura a lista
 * de comandos —, e falar com o core antes de imprimir a ajuda trocaria uma
 * garantia por um refinamento.
 */
import { LANGUAGES, currentSystemLocale, resolveLanguage, systemLanguage, type Language } from '@bridge/shared';

/** `BRIDGE_LANG`, quando ela nomeia um idioma que o Bridge fala. */
export function envLanguage(env: NodeJS.ProcessEnv): Language | undefined {
  const raw = env.BRIDGE_LANG?.trim();
  if (!raw) return undefined;
  return (LANGUAGES as readonly string[]).includes(raw) ? (raw as Language) : undefined;
}

/** Os passos 2 e 3 — o que vale sem falar com o core. */
export function offlineLanguage(env: NodeJS.ProcessEnv): Language {
  return envLanguage(env) ?? systemLanguage(currentSystemLocale());
}

/** O que a CLI precisa do `GET /api/config` — e é tudo o que ela pede. */
export interface CliConfig {
  languageResolved?: string;
  usage?: { showCost?: boolean };
}

/** O que a borda resolveu na única chamada que ela faz ao core. */
export interface CliSettings {
  lang: Language;
  /** `usage.showCost`; `true` quando o core não respondeu (o default do produto). */
  showCost: boolean;
}

/**
 * O idioma do comando: o do core quando ele responde, o local quando não.
 *
 * Nunca lança e nunca deixa o comando cair: um core fora do ar, uma rota que
 * não existe (core mais velho) ou um corpo sem o campo são todos "não
 * consegui perguntar", e a resposta disso é o passo 2.
 */
export async function resolveCliSettings(
  env: NodeJS.ProcessEnv,
  fetchConfig: () => Promise<CliConfig>,
): Promise<CliSettings> {
  try {
    const body = await fetchConfig();
    const resolved = body.languageResolved;
    return {
      lang:
        resolved && (LANGUAGES as readonly string[]).includes(resolved)
          ? (resolved as Language)
          : offlineLanguage(env),
      showCost: body.usage?.showCost ?? true,
    };
  } catch {
    // Core fechado ou sem a rota: cai pro ambiente/máquina, sem barulho.
    return { lang: offlineLanguage(env), showCost: true };
  }
}

/** Só o idioma — o que a maioria dos chamadores quer. */
export async function resolveCliLanguage(
  env: NodeJS.ProcessEnv,
  fetchConfig: () => Promise<CliConfig>,
): Promise<Language> {
  return (await resolveCliSettings(env, fetchConfig)).lang;
}

export { resolveLanguage };
