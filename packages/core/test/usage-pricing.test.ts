/**
 * A tabela de preços (ADR-012) e — o ponto da revisão — a REGRA DE BUSCA.
 *
 * A primeira versão caía num prefixo mais curto quando não achava o id exato.
 * Isso faz `claude-opus-5` herdar o preço de `claude-opus`: um número errado
 * apresentado com a mesma confiança de um certo. Aqui a busca tem duas
 * tentativas e nada mais.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import {
  EMBEDDED_PRICING,
  EMBEDDED_PRICING_AS_OF,
  EMBEDDED_PRICING_SOURCE,
  cacheWrite1hPrice,
  costOf,
  isPrice,
  normalizeModel,
  parsePricingOverride,
  priceFor,
  resolvePricing,
  type PricingTable,
} from '../src/usage/pricing.js';

const tmp = (): string => tmpDir('bridge-preco-');

describe('a tabela embutida', () => {
  it('declara a data e a fonte — é o que a resposta devolve em pricingAsOf', () => {
    expect(EMBEDDED_PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(EMBEDDED_PRICING_SOURCE).toContain('platform.claude.com');
  });

  it('toda entrada tem os quatro preços, e nenhum é negativo', () => {
    const modelos = Object.entries(EMBEDDED_PRICING);
    expect(modelos.length).toBeGreaterThan(10);
    for (const [model, price] of modelos) {
      expect(isPrice(price), model).toBe(true);
      expect(price.output, model).toBeGreaterThanOrEqual(price.input);
      expect(price.cacheRead, model).toBeLessThanOrEqual(price.input);
    }
  });

  /**
   * Os ids que aparecem de verdade nos transcripts desta geração. A lista está
   * aqui pra que um preço que sumir da tabela apareça como falha, e não como
   * um `cost: null` silencioso no painel do dono.
   */
  it('cobre os modelos em uso', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(priceFor(EMBEDDED_PRICING, model), model).toBeDefined();
    }
  });

  /** O `cacheRead` do Fable 5.1 não segue o padrão 0,1× do input — é 0,025×. */
  it('o cacheRead fora do padrão do Fable 5.1 está registrado', () => {
    expect(priceFor(EMBEDDED_PRICING, 'claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(priceFor(EMBEDDED_PRICING, 'claude-fable-5')?.cacheRead).toBe(1);
  });
});

describe('priceFor', () => {
  const tabela: PricingTable = {
    'claude-opus': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  };

  it('id exato vence', () => {
    expect(priceFor(tabela, 'claude-opus-5')?.input).toBe(5);
  });

  it('id com sufixo de data cai na entrada da família', () => {
    expect(normalizeModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(priceFor(tabela, 'claude-sonnet-4-5-20250929')?.input).toBe(3);
  });

  /**
   * O defeito que a revisão pegou: sem esta regra, `claude-opus-4-8` casaria
   * com `claude-opus` e sairia a 15/75 — três vezes o preço real.
   */
  it('NÃO cai num prefixo mais curto: desconhecido é desconhecido', () => {
    expect(priceFor(tabela, 'claude-opus-4-8')).toBeUndefined();
    expect(priceFor(tabela, 'claude-opus-5-thinking')).toBeUndefined();
    expect(priceFor(tabela, 'modelo-que-nao-existe')).toBeUndefined();
  });

  it('sufixo que não é data de 8 dígitos não é normalizado', () => {
    expect(normalizeModel('claude-sonnet-4-5-2025')).toBe('claude-sonnet-4-5-2025');
  });
});

describe('costOf', () => {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };

  it('cada tipo de token com o seu preço, em USD por milhão', () => {
    const price = { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
    expect(costOf(price, { ...zero, input: 1_000_000 })).toBeCloseTo(3, 9);
    expect(costOf(price, { ...zero, cacheRead: 2_000_000 })).toBeCloseTo(0.6, 9);
    expect(costOf(price, { ...zero, cacheWrite: 1_000_000 })).toBeCloseTo(3.75, 9);
    expect(costOf(price, zero)).toBe(0);
  });

  /**
   * A escrita de 1 h custa o DOBRO do input; a de 5 min, 1,25 ×. Cobrar as
   * duas pela mesma coluna subestimava a conta — na amostra da máquina do
   * autor 22,8 % dos tokens de escrita eram de 1 h.
   */
  it('a escrita de 1 h é cobrada pelo preço dela, não pelo de 5 min', () => {
    const price = { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
    expect(costOf(price, { ...zero, cacheWrite1h: 1_000_000 })).toBeCloseTo(6, 9);
  });

  /**
   * Tabela escrita à mão antes desta versão não tem `cacheWrite1h`. Recusá-la
   * apagaria preços corretos; deduzir `2 × input` é a regra oficial publicada.
   */
  it('tabela sem cacheWrite1h cai na regra oficial de 2 × input', () => {
    const antiga = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
    expect(cacheWrite1hPrice(antiga)).toBe(6);
    expect(costOf(antiga, { ...zero, cacheWrite1h: 1_000_000 })).toBeCloseTo(6, 9);
  });

  it('a tabela embutida traz cacheWrite1h = 2 × input em todos os modelos', () => {
    for (const [model, price] of Object.entries(EMBEDDED_PRICING)) {
      expect(price.cacheWrite1h, model).toBeCloseTo(price.input * 2, 9);
    }
  });
});

describe('overrides', () => {
  it('entrada malformada é descartada sozinha, com aviso, e o resto sobrevive', () => {
    const { table, problems } = parsePricingOverride(
      {
        bom: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
        semCampo: { input: 1 },
        negativo: { input: -1, output: 2, cacheWrite: 3, cacheRead: 4 },
      },
      'usage.pricing',
    'pt-BR',
    );
    expect(Object.keys(table)).toEqual(['bom']);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('semCampo');
  });

  it('topo que não é objeto é ignorado inteiro, com aviso', () => {
    expect(parsePricingOverride([1, 2], 'usage.pricing', 'pt-BR').problems).toHaveLength(1);
    expect(parsePricingOverride(undefined, 'usage.pricing', 'pt-BR')).toEqual({ table: {}, problems: [] });
  });

  it('a precedência é embutido → arquivo → config, e a data marca o ajuste', () => {
    const pricingFile = join(tmp(), 'precos.json');
    writeFileSync(
      pricingFile,
      JSON.stringify({ 'claude-sonnet-4-5': { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 } }),
      'utf8',
    );

    const soEmbutido = resolvePricing({}, 'pt-BR');
    expect(soEmbutido.table['claude-sonnet-4-5']?.input).toBe(3);
    expect(soEmbutido.asOf).toBe(EMBEDDED_PRICING_AS_OF);

    const comArquivo = resolvePricing({ pricingFile }, 'pt-BR');
    expect(comArquivo.table['claude-sonnet-4-5']?.input).toBe(99);
    expect(comArquivo.asOf).toContain('com ajustes locais');

    const comConfig = resolvePricing({
      pricingFile,
      pricing: { 'claude-sonnet-4-5': { input: 7, output: 7, cacheWrite: 7, cacheRead: 7 } },
    }, 'pt-BR');
    expect(comConfig.table['claude-sonnet-4-5']?.input).toBe(7);
  });

  /**
   * Um app que não abre porque alguém digitou uma vírgula a mais num JSON
   * opcional seria pior que o custo faltando.
   */
  it('arquivo ilegível vira aviso e a tabela embutida continua valendo', () => {
    const pricingFile = join(tmp(), 'quebrado.json');
    writeFileSync(pricingFile, '{ nada disso é json', 'utf8');
    const { table, warnings } = resolvePricing({ pricingFile }, 'pt-BR');
    expect(warnings[0]).toContain('pricingFile');
    expect(table['claude-sonnet-4-5']?.input).toBe(3);
  });

  it('a tabela embutida não é mutada por override nenhum', () => {
    resolvePricing({ pricing: { 'claude-sonnet-4-5': { input: 999, output: 1, cacheWrite: 1, cacheRead: 1 } } }, 'pt-BR');
    expect(EMBEDDED_PRICING['claude-sonnet-4-5']?.input).toBe(3);
  });
});
