/**
 * Formatação dos números que a pessoa lê (ADR-012), agora por IDIOMA
 * (spec §13).
 *
 * Mora no `@bridge/shared`, e não em cada ponta, porque QUATRO superfícies
 * escrevem os mesmos números: a statusline que o core devolve ao Claude Code,
 * a faixa da sidebar, o painel "Uso" e o `bridge usage` da CLI. Cada uma com
 * o seu `toFixed` significava, na prática, `$0.74` no terminal e `US$ 0,74` na
 * tela — o mesmo dado, duas convenções, e o dono percebendo a diferença antes
 * do revisor.
 *
 * **O `lang` é obrigatório.** Um default `'pt-BR'` deixaria toda chamada que
 * ninguém migrou escrevendo português para sempre — e calada, porque o código
 * continuaria compilando. Sem default, o compilador aponta cada ponta que
 * ainda não sabe em que idioma está.
 *
 * **A pontuação vem do `Intl`; as unidades, do catálogo.** `Intl.NumberFormat`
 * sabe que pt-BR agrupa com ponto e decide com vírgula, e en-US o contrário —
 * isso é dado de locale e não se escreve à mão. Já o `US$`, o `k` e o `M` são
 * TEXTO: saem do catálogo (`formato.moeda.usd`, `formato.tokens.mil`) como
 * qualquer outra copy. De quebra, isso resolve o espaço rígido: o `Intl` com
 * `style: 'currency'` põe um U+00A0 depois do `US$`, que atravessa
 * cópia-e-cola e comparação de igualdade como um caractere diferente.
 */
import { INTL_LOCALE, t } from './i18n/index.js';
import type { Language } from './i18n/index.js';

/**
 * Um `Intl.NumberFormat` por (idioma, casas). Construir um `NumberFormat` é
 * caro perto de formatar com ele, e a sidebar reformata a mesma dúzia de
 * números a cada evento de sessão.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();

function nf(lang: Language, min: number, max: number): Intl.NumberFormat {
  const key = `${lang}:${min}:${max}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(INTL_LOCALE[lang], {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      useGrouping: true,
    });
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * Dólar: `US$ 0,74` / `US$ 1.234,56` em pt-BR, `US$ 0.74` / `US$ 1,234.56` em
 * inglês. O símbolo é `US$` nos dois idiomas (spec §13) — o Bridge não é uma
 * loja, e `$` sozinho não diz de que dólar se trata.
 *
 * Sempre duas casas: é dinheiro, e `US$ 1,2` parece um preço pela metade.
 * Valor nulo (modelo sem preço) não passa por aqui — quem chama decide o texto
 * de "sem custo", porque só ele sabe se cabe "—" ou uma frase.
 */
export function formatUsd(value: number, lang: Language): string {
  const abs = Math.abs(value);
  const body = nf(lang, 2, 2).format(abs);
  // O sinal sai do valor ARREDONDADO, não do original: `-0,001` com duas casas
  // é zero, e `US$ -0,00` é um número que não existe. Ele também vem ANTES da
  // moeda (`-US$ 0,01`): é como um valor negativo é escrito, e `US$ -0,01` lê
  // como se o símbolo fosse parte do número. Só aparece num resíduo de
  // arredondamento — o consumo em si nunca é negativo.
  const negative = value < 0 && Number(abs.toFixed(2)) !== 0;
  return t(lang, negative ? 'formato.moeda.usdNegativo' : 'formato.moeda.usd', { valor: body });
}

/**
 * Tokens em escala curta: `842`, `12,3k`, `87k`, `1,2M` (pt-BR); `12.3k`,
 * `1.2M` (en).
 *
 * Uma casa decimal, e ela SOME quando é zero. `1,2M` é a diferença entre um
 * milhão e dois, que importa; `87,0k` é a mesma informação de `87k` gastando
 * duas células a mais numa barra de sidebar de 60 px — por isso o
 * `minimumFractionDigits: 0`.
 */
export function formatTokens(value: number, lang: Language): string {
  const abs = Math.abs(value);
  if (abs < 1_000) return nf(lang, 0, 0).format(value);
  // A escala é escolhida pelo valor ARREDONDADO, não pelo cru: 999.999 tokens
  // arredondam pra 1.000,0k, e `1.000k` é um número que ninguém escreve —
  // quem sobe de casa na unidade tem que subir de unidade junto.
  if (abs < 1_000_000 && Math.round(abs / 100) < 10_000) {
    return t(lang, 'formato.tokens.mil', { valor: nf(lang, 0, 1).format(value / 1_000) });
  }
  return t(lang, 'formato.tokens.milhao', { valor: nf(lang, 0, 1).format(value / 1_000_000) });
}

/**
 * Contagem de coisas inteiras (mensagens, arquivos, dias): `1.284` em pt-BR,
 * `1,284` em inglês. Vinha da UI (`usageModel.formatCount`, que grupava com
 * ponto na marra) e subiu pra cá na 0.13.0 — separador de milhar é locale, e
 * a UI não é a única ponta que conta coisas.
 */
export function formatCount(value: number, lang: Language): string {
  return nf(lang, 0, 0).format(Math.round(value));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Quando foi: `agora`, `há 4 min`, `há 2 h`, `ontem`, `há 9 dias` — e `now`,
 * `4 min ago`, `2 h ago`, `yesterday`, `9 days ago`.
 *
 * O texto sai do CATÁLOGO, não do `Intl.RelativeTimeFormat`. O `Intl`
 * escreveria "há 4 minutos" e "4 minutes ago"; a linha da sidebar tem 60 px e
 * a spec §13 fixa a forma curta (`há 1 min` / `1 min ago`). A unidade abreviada
 * é decisão de design, e decisão de design é copy — logo, catálogo.
 *
 * Relógio que andou pra trás (o `at` no futuro) vira `agora`: o decorrido é
 * grampeado em zero, senão sairia "há -3 min".
 */
export function formatRelativeTime(at: number, now: number, lang: Language): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return t(lang, 'formato.tempo.agora');
  if (elapsed < HOUR_MS) return t(lang, 'formato.tempo.minutos', { n: Math.floor(elapsed / MINUTE_MS) });
  if (elapsed < DAY_MS) return t(lang, 'formato.tempo.horas', { n: Math.floor(elapsed / HOUR_MS) });
  const days = Math.floor(elapsed / DAY_MS);
  // Um dia atrás tem palavra própria em qualquer idioma — "há 1 dias" não
  // existe, e "1 day ago" perde pra "yesterday".
  return days === 1 ? t(lang, 'formato.tempo.ontem') : t(lang, 'formato.tempo.dias', { n: days });
}
