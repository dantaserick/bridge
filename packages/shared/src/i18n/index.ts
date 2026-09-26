/**
 * IDIOMA (spec §13) — a porta única por onde todo texto que uma pessoa lê
 * sai do Bridge.
 *
 * Por que um catálogo, e não uma string em cada arquivo: até a 0.12.2 o app
 * inteiro era pt-BR literal, espalhado por cinco pacotes. Não havia como
 * responder "quantos textos o Bridge tem?" nem trocar de idioma sem varrer o
 * repositório à mão. Com o catálogo, o conjunto de textos É um tipo
 * (`MessageKey`), acrescentar um idioma é acrescentar um arquivo, e o teste
 * de guarda de cada pacote (`guard.ts`) impede uma string nova de entrar por
 * fora.
 *
 * O que NÃO passa por aqui, declaradamente (spec §13): a saída dos agentes e
 * dos shells, os logs em arquivo (`core.log`/`shell.log` continuam pt-BR — são
 * do dono e do suporte), o instalador e os docs.
 */
import { en } from './en.js';
import { ptBR } from './pt-BR.js';
import type { MessageKey } from './pt-BR.js';

export { en } from './en.js';
export { ptBR } from './pt-BR.js';
export type { MessageKey } from './pt-BR.js';
// O `guard.ts` NÃO é reexportado aqui de propósito (preocupação nº 6 do report
// da Task 1): ele é ferramenta de TESTE, e cada teste de guarda o importa
// direto de `src/i18n/guard.js`. Reexportá-lo colocava um varredor de texto no
// grafo do bundle da UI, dependendo do tree-shaking pra sair.

/** Os idiomas que o Bridge fala. Um idioma novo é um arquivo novo aqui. */
export type Language = 'pt-BR' | 'en';

/**
 * O que a configuração guarda (`ui.language`). `'system'` não é um idioma —
 * é a instrução de perguntar à máquina, resolvida por `resolveLanguage`.
 */
export type LanguageSetting = Language | 'system';

export const LANGUAGES: readonly Language[] = ['pt-BR', 'en'];

/**
 * As opções de `ui.language`, na ordem em que o diálogo as mostra.
 *
 * É uma TUPLA (`as const`), e não um `readonly LanguageSetting[]`, porque os
 * dois schemas zod que validam o campo (`api/schemas.ts` e `profile.ts`)
 * derivam o `z.enum` daqui. Escrita como array larga, a lista tinha que ser
 * repetida à mão nos dois — e um idioma novo entrava no catálogo sem entrar
 * na validação, ou pior, só num dos dois lados.
 */
export const LANGUAGE_SETTINGS = ['pt-BR', 'en', 'system'] as const satisfies readonly LanguageSetting[];

const CATALOGUES: Record<Language, Record<MessageKey, string>> = { 'pt-BR': ptBR, en };

/** A locale que o `Intl` recebe por idioma — ver `format.ts`. */
export const INTL_LOCALE: Record<Language, string> = { 'pt-BR': 'pt-BR', en: 'en-US' };

/**
 * Estamos em desenvolvimento? Em dev, `t` LANÇA em chave desconhecida e em
 * parâmetro faltando; em produção ele degrada.
 *
 * A pergunta é AFIRMATIVA (`test`/`development`/`BRIDGE_DEV`), e não a negação
 * de `production`, por causa de como o app é empacotado: no `.exe` do
 * electron-builder o `NODE_ENV` simplesmente não existe, e um
 * `!== 'production'` faria o app INSTALADO ser o mais explosivo dos ambientes
 * — exatamente ao contrário do que se quer. Sob o vitest o `NODE_ENV` é
 * `test`, então a rede continua armada onde ela pega defeito de verdade.
 *
 * A pergunta é feita a cada chamada, e não guardada numa constante, porque o
 * teste que prova o comportamento de produção mexe no `NODE_ENV` — um cache
 * congelaria a resposta na primeira chamada do processo. O `try` existe pro
 * renderer: no browser não há `process`.
 */
function isDev(): boolean {
  try {
    if (process.env.BRIDGE_DEV) return true;
    return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  } catch {
    return false;
  }
}

const PARAM_RE = /\{(\w+)\}/g;

/**
 * O texto de `key` em `lang`, com os `{param}` trocados.
 *
 * Em dev, chave que não existe e parâmetro que falta LANÇAM: o tipo já
 * impede a primeira (`MessageKey`), mas um `as` no meio do caminho ou um
 * catálogo carregado de fora passariam batido, e um `{n}` cru na tela é o
 * tipo de defeito que ninguém reporta — só acha feio. Em produção nada disso
 * derruba a janela: a chave vira o próprio texto e o parâmetro fica como
 * está. Um texto errado é ruim; uma tela em branco por causa dele é pior.
 */
export function t(lang: Language, key: MessageKey, params?: Record<string, string | number>): string {
  const template = CATALOGUES[lang][key] as string | undefined;
  if (template === undefined) {
    if (isDev()) throw new Error(`i18n: chave desconhecida "${key}" (${lang})`);
    return key;
  }
  if (!template.includes('{')) return template;
  return template.replace(PARAM_RE, (whole, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      if (isDev()) throw new Error(`i18n: falta o parâmetro "${name}" em "${key}" (${lang})`);
      return whole;
    }
    return String(value);
  });
}

/**
 * `pt*` → `pt-BR`; o resto do mundo → `en` (spec §13).
 *
 * Português de Portugal cai em pt-BR de propósito: as diferenças de
 * vocabulário são reais, mas ler "você" num app é infinitamente melhor do que
 * ler uma língua que não é a sua. Sem locale (ambiente sem ICU,
 * `navigator.language` vazio) o idioma é inglês — é o que mais gente lê.
 */
export function systemLanguage(locale: string | undefined): Language {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (normalized === '') return 'en';
  return normalized === 'pt' || normalized.startsWith('pt-') || normalized.startsWith('pt_') ? 'pt-BR' : 'en';
}

/**
 * O idioma em vigor: a escolha do dono, ou a da máquina quando ele escolheu
 * `'system'`. É a ÚNICA função que resolve isso — core, UI, CLI e shell
 * chamam esta, cada um com a locale que a sua plataforma sabe dizer
 * (`Intl.DateTimeFormat().resolvedOptions().locale`, `navigator.language`,
 * `app.getLocale()`).
 */
export function resolveLanguage(setting: LanguageSetting, systemLocale: string | undefined): Language {
  return setting === 'system' ? systemLanguage(systemLocale) : setting;
}

/** A locale que esta máquina reporta. `undefined` num ambiente sem `Intl`. */
export function currentSystemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
