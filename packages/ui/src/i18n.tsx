/**
 * O idioma DENTRO do renderer (spec §13).
 *
 * São três coisas, e vale separar:
 *
 * 1. **`tUi(lang, key, params)`** — a mesma função `t` do `@bridge/shared`, com
 *    nome próprio. Os modelos puros (`sidebarModel`, `usageModel`,
 *    `settingsModel`, …) importam ESTA: eles recebem `lang` como argumento e
 *    não têm hook nenhum, o que é o que os deixa testáveis em ambiente `node`,
 *    sem montar React.
 * 2. **`LanguageProvider` + `useT()`** — o mesmo idioma, para os componentes,
 *    sem passar `lang` por dez níveis de props.
 * 3. **De onde o idioma vem.** Do `languageResolved` do `GET /api/config` (e do
 *    `config.changed` do WS, que é o mesmo `configSnapshot()`), **nunca** de
 *    uma resolução própria do renderer. Quem resolve `'system'` é o CORE, com a
 *    locale do processo dele; resolver de novo aqui, com `navigator.language`,
 *    poderia dar dois idiomas na mesma máquina — a UI em português e as
 *    notificações em inglês (preocupação nº 5 do report da Task 1).
 *
 * O `navigator.language` só entra ANTES da primeira config: é a janela entre o
 * primeiro frame e a resposta do `GET /api/config`. Escolher inglês fixo ali
 * faria a tela piscar de idioma na subida de todo mundo que fala português.
 *
 * A troca é AO VIVO: o `config.changed` reescreve `state.config`, o App
 * re-renderiza com o `languageResolved` novo e todo componente e todo modelo
 * abaixo dele recebem o idioma novo. Não há recarga de janela, e não há
 * constante de módulo guardando texto — é a mesma razão pela qual a Task 1
 * matou as quatro `ENVIRONMENT_*` e a Task 2 matou os `DETAIL_*`.
 */
import { systemLanguage, t } from '@bridge/shared';
import type { BridgeConfig, Language, MessageKey } from '@bridge/shared';
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

/**
 * O `t` do catálogo, para os MODELOS. Existe com nome próprio para que uma
 * busca por `tUi(` encontre exatamente o texto que a UI escreve — o `t` cru é
 * usado também pelo core e pela CLI.
 */
export function tUi(lang: Language, key: MessageKey, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}

/**
 * O idioma que o BROWSER reporta. É reserva, não fonte: só vale enquanto o
 * `GET /api/config` não voltou. Fora do browser (o `vitest` deste pacote roda
 * em ambiente `node`) não há `navigator`, e aí a regra é a mesma do core sem
 * ICU — inglês.
 */
export function browserLanguage(): Language {
  try {
    return systemLanguage(typeof navigator === 'undefined' ? undefined : navigator.language);
  } catch {
    return 'en';
  }
}

/**
 * O idioma em vigor a partir da config em mãos: o do CORE quando ela já
 * chegou, o do browser enquanto não chegou. É a única função que decide isso —
 * o provider e quem precisar do idioma fora da árvore React chamam esta.
 */
export function uiLanguage(config: BridgeConfig | undefined): Language {
  return config?.languageResolved ?? browserLanguage();
}

/**
 * `undefined` = sem provider acima. Não é um idioma de fábrica: quem lê cai no
 * `browserLanguage()` NO MOMENTO DA LEITURA, e não numa constante avaliada na
 * importação do módulo.
 */
const LanguageContext = createContext<Language | undefined>(undefined);

export function LanguageProvider({ config, children }: { config?: BridgeConfig; children: ReactNode }): JSX.Element {
  const lang = uiLanguage(config);
  return <LanguageContext.Provider value={lang}>{children}</LanguageContext.Provider>;
}

/** O idioma em vigor. É o que os componentes passam para os modelos. */
export function useLang(): Language {
  return useContext(LanguageContext) ?? browserLanguage();
}

export interface Translator {
  /** O idioma em vigor — para repassar aos modelos, que o recebem explícito. */
  lang: Language;
  /** `t(key, params)` já com o idioma preso. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

/**
 * O hook dos componentes: `const { t, lang } = useT()`.
 *
 * O objeto é memoizado por idioma para que passá-lo adiante numa prop não
 * invalide um `memo` a cada render.
 */
export function useT(): Translator {
  const lang = useLang();
  return useMemo(() => ({ lang, t: (key: MessageKey, params?: Record<string, string | number>) => tUi(lang, key, params) }), [lang]);
}
