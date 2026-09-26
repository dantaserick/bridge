/**
 * Tabela de preços por modelo e o custo estimado a partir dela.
 *
 * A tabela embutida (`pricing.json`) traz os preços de lista publicados na
 * documentação oficial, com a data em que foram conferidos (`asOf`) e a fonte
 * (`source`) dentro do próprio arquivo — a resposta da API devolve a data em
 * `pricingAsOf`, pra que ninguém precise adivinhar se a tabela envelheceu.
 *
 * Modelo que não está lá não ganha um número inventado: o custo dele sai
 * `null` e o modelo entra em `pricingWarnings`, que a UI mostra. Um custo
 * chutado é pior que custo nenhum: ele parece resposta.
 *
 * Quem quiser completar a tabela tem duas portas, nesta ordem de precedência
 * (a última vence):
 *
 *   1. `pricing.json` embutido;
 *   2. `usage.pricingFile` do `config.json` — um JSON com a MESMA forma;
 *   3. `usage.pricing` do `config.json` — override parcial, inline.
 *
 * A unidade é sempre **USD por milhão de tokens**, que é como a tabela
 * pública é publicada. Nada aqui é fatura: é estimativa, e a UI rotula assim.
 */
import { t, type Language } from '@bridge/shared';
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import type { UsageConfig, UsagePrice } from '@bridge/shared';
import embedded from './pricing.json' with { type: 'json' };

export type { UsagePrice } from '@bridge/shared';

export type PricingTable = Record<string, UsagePrice>;

/** A tabela que vem no pacote. Congelada: ninguém muta a fonte embutida. */
interface EmbeddedPricing {
  asOf: string;
  source: string;
  unit: string;
  models: PricingTable;
}

const embeddedFile = embedded as unknown as EmbeddedPricing;

/**
 * Uma tabela de precos SEM PROTOTIPO (BU-02/R2).
 *
 * `PricingTable` e consultada por uma chave que vem do PAYLOAD (`message.model`
 * de uma linha de transcript). Num objeto literal, `table['constructor']`
 * devolve o membro herdado de `Object.prototype` — que e *truthy*. O calculo
 * entao tratava a linha como PRECIFICADA, multiplicava tokens por
 * `price.input` (que e `undefined`), somava `NaN` no total do recorte, e o
 * painel inteiro passava a dizer "nenhum modelo do recorte tem preco" enquanto
 * o consumo real acontecia — sem aviso nenhum, porque `cost !== undefined`.
 *
 * `Object.create(null)` mais o `Object.hasOwn` de `priceFor` fecham os dois
 * lados: nao ha cadeia pra herdar, e nem uma chave propria sorrateira passa
 * sem ser vista.
 */
export function emptyPricingTable(): PricingTable {
  return Object.create(null) as PricingTable;
}

/** A tabela que vem no pacote. Sem prototipo e congelada: ninguem muta a fonte embutida. */
export const EMBEDDED_PRICING: PricingTable = Object.freeze(
  Object.assign(emptyPricingTable(), embeddedFile.models),
);

/** Data em que os preços embutidos foram conferidos contra a fonte oficial. */
export const EMBEDDED_PRICING_AS_OF: string = embeddedFile.asOf;

/** De onde os preços embutidos vieram. */
export const EMBEDDED_PRICING_SOURCE: string = embeddedFile.source;

/** Contagem crua de tokens de um recorte — o que multiplica o preço. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Número de preço válido: finito e não negativo. */
function isPriceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Uma entrada de preço só vale se os QUATRO campos obrigatórios forem números
 * finitos ≥ 0. `cacheWrite1h` é opcional: uma tabela escrita à mão antes desta
 * versão não o tem, e recusá-la inteira por causa dele apagaria preços
 * corretos. Presente e inválido, aí sim, invalida a entrada — meio preço é
 * pior que preço nenhum.
 */
export function isPrice(value: unknown): value is UsagePrice {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (p.cacheWrite1h !== undefined && !isPriceNumber(p.cacheWrite1h)) return false;
  return (['input', 'output', 'cacheWrite', 'cacheRead'] as const).every((k) => isPriceNumber(p[k]));
}

/**
 * O preço da escrita de cache de 1 hora. Ausente da tabela, vale a regra
 * oficial: **o dobro do input** (a de 5 minutos é 1,25 ×). Deduzir é seguro
 * aqui — a razão é a mesma para toda a família de modelos e está publicada —
 * e é o que faz uma tabela antiga do dono continuar cobrando certo.
 */
export function cacheWrite1hPrice(price: UsagePrice): number {
  return price.cacheWrite1h ?? price.input * 2;
}

/**
 * O sufixo de data que o Claude Code carimba no id do modelo
 * (`claude-haiku-4-5-20251001`). A tabela é escrita pela FAMÍLIA; uma entrada
 * por data de release seria uma tabela que envelhece sozinha.
 */
export const DATED_MODEL_ID = /^(.+)-\d{8}$/;

export function normalizeModel(model: string): string {
  return DATED_MODEL_ID.exec(model)?.[1] ?? model;
}

/**
 * O preço de um modelo, em DUAS tentativas e nada mais: o id exato, e o id sem
 * o sufixo de data.
 *
 * Não há busca por prefixo aqui, de propósito. A rodada de revisão pegou o
 * motivo: `claude-opus-5` casaria com uma entrada `claude-opus` e herdaria o
 * preço de uma geração anterior — um número errado apresentado com a mesma
 * confiança de um certo. Modelo desconhecido tem que sair `undefined` e virar
 * aviso; é a única resposta que não mente.
 */
export function priceFor(table: PricingTable, model: string): UsagePrice | undefined {
  // `Object.hasOwn` e nao `table[model]`: ver a doc de `emptyPricingTable`. A
  // trava e dupla de proposito — a tabela ja nasce sem prototipo, mas uma
  // tabela montada por outro caminho (um teste, um chamador futuro) nao pode
  // reabrir o buraco.
  if (Object.hasOwn(table, model)) return table[model];
  const normalized = normalizeModel(model);
  return Object.hasOwn(table, normalized) ? table[normalized] : undefined;
}

/**
 * USD estimados de um recorte. `price` em USD por milhao.
 *
 * Devolve `undefined` quando a conta nao da um numero finito — cinto e
 * suspensorio do BU-02: um `NaN` que chegasse ao total apagaria a coluna de
 * custo inteira, e `null` na resposta le como "nenhum modelo tem preco".
 */
export function costOf(price: UsagePrice, counts: TokenCounts): number | undefined {
  const total =
    (counts.input * price.input +
      counts.output * price.output +
      counts.cacheWrite * price.cacheWrite +
      counts.cacheWrite1h * cacheWrite1hPrice(price) +
      counts.cacheRead * price.cacheRead) /
    1_000_000;
  return Number.isFinite(total) ? total : undefined;
}

/** A frase que a UI mostra pro modelo que ficou de fora do custo. */
export function unpricedWarning(model: string, lang: Language): string {
  return t(lang, 'core.uso.aviso.modeloSemPreco', { modelo: model });
}

export interface PricingOverride {
  table: PricingTable;
  /** O que foi ignorado, em pt-BR — vira `pricingWarnings` na resposta. */
  problems: string[];
}

/**
 * Um objeto `{ modelo: preço }` vindo de fora (config ou arquivo), entrada a
 * entrada: o que não tem forma de preço é DESCARTADO com aviso, nunca derruba
 * o resto. Um `pricing` mal editado não pode apagar a tabela inteira.
 */
export function parsePricingOverride(raw: unknown, source: string, lang: Language): PricingOverride {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { table: emptyPricingTable(), problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      table: emptyPricingTable(),
      problems: [t(lang, 'core.uso.aviso.precosNaoObjeto', { origem: source })],
    };
  }
  const table: PricingTable = emptyPricingTable();
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPrice(value)) {
      problems.push(t(lang, 'core.uso.aviso.precoInvalido', { origem: source, modelo: model }));
      continue;
    }
    table[model] = {
      input: value.input,
      output: value.output,
      cacheWrite: value.cacheWrite,
      cacheRead: value.cacheRead,
      ...(value.cacheWrite1h === undefined ? {} : { cacheWrite1h: value.cacheWrite1h }),
    };
  }
  return { table, problems };
}

/**
 * Teto de tamanho do `usage.pricingFile` (BU-03/R3).
 *
 * A tabela embutida inteira tem menos de 4 KB; 1 MiB dá folga de duas ordens
 * de grandeza pra uma tabela escrita à mão. Acima disso não é tabela de preço,
 * e ler o arquivo era um bloqueio síncrono do event loop proporcional ao
 * tamanho dele (1 069 ms medidos com 200 MB, repetidos em toda subida do core
 * e em todo rescan, porque o caminho fica gravado no `config.json`).
 */
export const PRICING_FILE_MAX_BYTES = 1024 * 1024;

/**
 * O `pricingFile` tem FORMA de arquivo de preço?
 *
 * As mesmas três travas que o `transcript_path` do hook já tinha
 * (`quota.ts`), porque o problema é o mesmo: o caminho vem de um `PATCH
 * /api/config`, que qualquer processo com o token faz — e sem forma exigida
 * isso era leitura de arquivo arbitrário do usuário.
 *
 * - caminho absoluto (no Windows, com LETRA DE UNIDADE);
 * - nada de UNC nem de caminho de dispositivo (share de rede e `NUL`/
 *   `PhysicalDrive0`: I/O bloqueante contra um host ou driver de terceiro);
 * - extensão `.json`, e só ela.
 */
export function isPricingFilePath(path: string): boolean {
  if (extname(path).toLowerCase() !== '.json') return false;
  if (path.startsWith('\\\\') || path.startsWith('//')) return false;
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path);
  return isAbsolute(path);
}

/**
 * O aviso ÚNICO de arquivo de preço recusado ou ilegível.
 *
 * Genérico de propósito (BU-03/R3): a mensagem antiga repassava o texto do
 * `SyntaxError` do V8, que carrega os ~10 primeiros caracteres do conteúdo, e
 * as chaves de topo de um JSON viravam uma linha de aviso cada. Isso ia pra
 * resposta HTTP, pra tela **e pro `core.log`**, que persiste — ou seja, o
 * `pricingFile` era um oráculo de leitura parcial de qualquer arquivo que a
 * conta do usuário conseguisse abrir. Nem o trecho do conteúdo nem o CAMINHO
 * saem daqui: o caminho está no `config.json`, que é de quem o escreveu.
 */
export const pricingFileWarning = (lang: Language): string => t(lang, 'core.uso.aviso.arquivoPrecosInvalido');

/**
 * O aviso de entradas descartadas DENTRO de um arquivo de preços válido.
 *
 * Diz QUANTAS, nunca QUAIS: a lista de chaves de topo de um `.json` qualquer
 * era metade do oráculo do BU-03 (aponte o `pricingFile` pra um
 * `.credentials.json` e o painel imprimia os nomes das chaves dele). O dono
 * continua sabendo que o arquivo dele tem problema e quantos — o arquivo é
 * dele, e é lá que se vê qual. O `usage.pricing` do `config.json` continua
 * nomeando o modelo: aquele conteúdo é a configuração do próprio Bridge.
 */
export function pricingFileEntriesWarning(count: number, lang: Language): string {
  // Plural é chave explícita (Task 1, §1.3): a regra do português não é a do
  // inglês, e nenhuma das duas cabe num `count === 1 ? …`.
  return count === 1
    ? t(lang, 'core.uso.aviso.entradasIgnoradas.uma')
    : t(lang, 'core.uso.aviso.entradasIgnoradas.varias', { n: count });
}

/**
 * Lê `usage.pricingFile`. Arquivo recusado/ausente/ilegível/malformado vira o
 * aviso genérico acima, nunca exceção e nunca um pedaço do conteúdo.
 *
 * O `statSync` vem ANTES do `readFileSync`: é ele que impede o arquivo de
 * 200 MB, o diretório, o dispositivo e o pipe de chegarem à leitura.
 */
export function loadPricingFile(path: string, lang: Language): PricingOverride {
  const refused: PricingOverride = { table: emptyPricingTable(), problems: [pricingFileWarning(lang)] };
  if (!isPricingFilePath(path)) return refused;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > PRICING_FILE_MAX_BYTES) return refused;
  } catch {
    return refused;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return refused;
  }
  const parsed = parsePricingOverride(raw, 'usage.pricingFile', lang);
  // Os avisos por ENTRADA citam a chave que falhou — o que num arquivo
  // qualquer é a lista de chaves de topo dele. Ver `pricingFileEntriesWarning`:
  // a tabela válida fica, e o aviso passa a dizer quantas caíram, não quais.
  if (parsed.problems.length > 0) {
    return { table: parsed.table, problems: [pricingFileEntriesWarning(parsed.problems.length, lang)] };
  }
  return parsed;
}

export interface ResolvedPricing {
  table: PricingTable;
  /** Problemas da RESOLUÇÃO (arquivo, override). Modelo sem preço é avisado na hora do cálculo. */
  warnings: string[];
  /**
   * Data dos preços em vigor. É a do arquivo embutido; um `pricingFile` ou um
   * `usage.pricing` por cima torna a data uma referência PARCIAL — por isso o
   * campo vira `<data> (com ajustes locais)` quando há override.
   */
  asOf: string;
}

/**
 * A tabela em vigor: embutida, com o arquivo por cima, com o override do
 * `config.json` por cima de tudo. Nunca lança — o monitor de uso não pode
 * parar de contar tokens por causa de um preço mal digitado.
 */
export function resolvePricing(
  usage: Pick<UsageConfig, 'pricingFile' | 'pricing'>,
  lang: Language,
): ResolvedPricing {
  const warnings: string[] = [];
  const table: PricingTable = Object.assign(emptyPricingTable(), EMBEDDED_PRICING);

  let fromFileTable: PricingTable = emptyPricingTable();
  const file = usage.pricingFile?.trim();
  if (file) {
    const fromFile = loadPricingFile(file, lang);
    warnings.push(...fromFile.problems);
    fromFileTable = fromFile.table;
    Object.assign(table, fromFileTable);
  }

  const inline = parsePricingOverride(usage.pricing, 'usage.pricing', lang);
  warnings.push(...inline.problems);
  Object.assign(table, inline.table);

  const overridden = Object.keys(fromFileTable).length > 0 || Object.keys(inline.table).length > 0;
  const asOf = overridden
    ? t(lang, 'core.uso.precos.comAjustes', { data: EMBEDDED_PRICING_AS_OF })
    : EMBEDDED_PRICING_AS_OF;
  return { table, warnings, asOf };
}
