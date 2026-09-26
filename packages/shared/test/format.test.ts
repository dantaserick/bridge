import { describe, expect, it } from 'vitest';
import { formatCount, formatRelativeTime, formatTokens, formatUsd } from '../src/format.js';

/**
 * O gate visual fixou o formato do dinheiro em pt-BR (ADR-012). Estes testes
 * existem porque QUATRO superfícies escrevem o mesmo número — statusline do
 * terminal, faixa da sidebar, painel "Uso" e `bridge usage` — e antes cada
 * uma tinha o seu `toFixed`.
 *
 * Desde a 0.13.0 todo formatador recebe o IDIOMA (spec §13). O parâmetro é
 * obrigatório de propósito: um default `'pt-BR'` deixaria uma ponta calada em
 * português para sempre, e ninguém descobriria — o app continuaria compilando.
 */
describe('formatUsd', () => {
  it('vírgula decimal, duas casas, prefixo US$ com espaço normal', () => {
    expect(formatUsd(0.74, 'pt-BR')).toBe('US$ 0,74');
    expect(formatUsd(3.4, 'pt-BR')).toBe('US$ 3,40');
    expect(formatUsd(0, 'pt-BR')).toBe('US$ 0,00');
  });

  /**
   * Em inglês o SÍMBOLO continua `US$` (spec §13: `en → US$ 3.42`) — o que
   * muda é a pontuação. O Bridge não é uma loja: o símbolo diz de que dólar
   * se trata, e trocá-lo por `$` no idioma inglês perderia essa informação.
   */
  it('em inglês, ponto decimal e o mesmo símbolo US$', () => {
    expect(formatUsd(0.74, 'en')).toBe('US$ 0.74');
    expect(formatUsd(3.4, 'en')).toBe('US$ 3.40');
    expect(formatUsd(3.42, 'en')).toBe('US$ 3.42');
  });

  it('ponto de milhar acima de mil', () => {
    expect(formatUsd(1234.5, 'pt-BR')).toBe('US$ 1.234,50');
    expect(formatUsd(1_234_567.891, 'pt-BR')).toBe('US$ 1.234.567,89');
    expect(formatUsd(1234.5, 'en')).toBe('US$ 1,234.50');
    expect(formatUsd(1_234_567.891, 'en')).toBe('US$ 1,234,567.89');
  });

  /**
   * O `Intl` com `style: 'currency'` põe um espaço RÍGIDO (U+00A0) depois do
   * `US$`. Ele passa despercebido na tela e depois quebra um `toBe` e a
   * comparação de quem copiou o texto — por isso a moeda vem do catálogo e só
   * o NÚMERO passa pelo `Intl`.
   */
  it('o espaço depois de US$ é o espaço comum, não o rígido', () => {
    expect(formatUsd(1, 'pt-BR').charCodeAt(3)).toBe(32);
    expect(formatUsd(1, 'en').charCodeAt(3)).toBe(32);
    expect(formatUsd(1_234_567, 'pt-BR')).not.toMatch(/ /);
    expect(formatUsd(1_234_567, 'en')).not.toMatch(/ /);
  });

  /**
   * O sinal vem ANTES da moeda: é como um valor negativo é escrito em pt-BR, e
   * `US$ -2,50` lê como se o símbolo fizesse parte do número.
   */
  it('negativo põe o sinal antes da moeda', () => {
    expect(formatUsd(-2.5, 'pt-BR')).toBe('-US$ 2,50');
    expect(formatUsd(-1234.56, 'pt-BR')).toBe('-US$ 1.234,56');
    expect(formatUsd(-2.5, 'en')).toBe('-US$ 2.50');
  });

  /**
   * `US$ -0,00` é um número que não existe. O sinal sai do valor ARREDONDADO,
   * não do original: um resíduo de ponto flutuante negativo (o custo de um
   * ajuste que quase zerou) não pode virar um débito na tela.
   */
  it('resíduo negativo que arredonda pra zero perde o sinal', () => {
    expect(formatUsd(-0.001, 'pt-BR')).toBe('US$ 0,00');
    expect(formatUsd(-0, 'pt-BR')).toBe('US$ 0,00');
    expect(formatUsd(-0.005, 'pt-BR')).toBe('-US$ 0,01');
    expect(formatUsd(-0.001, 'en')).toBe('US$ 0.00');
  });
});

describe('formatTokens', () => {
  it('abaixo de mil, o número inteiro', () => {
    expect(formatTokens(0, 'pt-BR')).toBe('0');
    expect(formatTokens(842, 'pt-BR')).toBe('842');
    expect(formatTokens(842, 'en')).toBe('842');
  });

  it('milhares com uma casa, e a casa some quando é zero', () => {
    expect(formatTokens(12_300, 'pt-BR')).toBe('12,3k');
    expect(formatTokens(87_000, 'pt-BR')).toBe('87k');
    expect(formatTokens(1_000, 'pt-BR')).toBe('1k');
    expect(formatTokens(999_400, 'pt-BR')).toBe('999,4k');
  });

  it('em inglês, a casa decimal é ponto e o sufixo é o mesmo', () => {
    expect(formatTokens(12_300, 'en')).toBe('12.3k');
    expect(formatTokens(87_000, 'en')).toBe('87k');
    expect(formatTokens(999_400, 'en')).toBe('999.4k');
    expect(formatTokens(1_200_000, 'en')).toBe('1.2M');
  });

  it('milhões com uma casa', () => {
    expect(formatTokens(1_200_000, 'pt-BR')).toBe('1,2M');
    expect(formatTokens(2_000_000, 'pt-BR')).toBe('2M');
  });

  /**
   * `1.000k` é um número que ninguém escreve: quem sobe de casa dentro da
   * unidade tem que subir de unidade junto. A fronteira é o ARREDONDAMENTO,
   * não o valor cru — 999.999 já arredonda pra 1.000,0k.
   */
  it('a virada pra M acontece no arredondamento, não no valor cru', () => {
    expect(formatTokens(999_900, 'pt-BR')).toBe('999,9k');
    expect(formatTokens(999_949, 'pt-BR')).toBe('999,9k');
    expect(formatTokens(999_999, 'pt-BR')).toBe('1M');
    expect(formatTokens(1_000_000, 'pt-BR')).toBe('1M');
    expect(formatTokens(999_999, 'en')).toBe('1M');
  });

  it('negativo mantém o sinal em qualquer escala', () => {
    expect(formatTokens(-12_300, 'pt-BR')).toBe('-12,3k');
    expect(formatTokens(-2_000_000, 'pt-BR')).toBe('-2M');
    expect(formatTokens(-12_300, 'en')).toBe('-12.3k');
  });
});

/**
 * O contador de mensagens/arquivos: sem casa decimal, com separador de
 * milhar. Vinha da UI (`usageModel.formatCount`) e sobe pro `shared` na
 * 0.13.0 porque ele também tem locale.
 */
describe('formatCount', () => {
  it('separador de milhar por idioma, sem casas', () => {
    expect(formatCount(1284, 'pt-BR')).toBe('1.284');
    expect(formatCount(1284, 'en')).toBe('1,284');
    expect(formatCount(0, 'pt-BR')).toBe('0');
    expect(formatCount(999, 'en')).toBe('999');
  });

  it('arredonda — o contador é de coisas inteiras', () => {
    expect(formatCount(1284.6, 'pt-BR')).toBe('1.285');
    expect(formatCount(1284.4, 'en')).toBe('1,284');
  });
});

/**
 * Tempo relativo da última notificação (sidebar). A forma CURTA é decisão de
 * design (a linha tem 60 px), então o texto sai do catálogo em vez do
 * `Intl.RelativeTimeFormat` — que escreveria "há 4 minutos" e "4 minutes ago".
 * A spec §13 fixa justamente `há 1 min` / `1 min ago`.
 */
describe('formatRelativeTime', () => {
  const AGORA = 1_000_000_000_000;
  const MIN = 60_000;
  const HORA = 60 * MIN;
  const DIA = 24 * HORA;

  it('menos de um minuto é "agora"', () => {
    expect(formatRelativeTime(AGORA - 5_000, AGORA, 'pt-BR')).toBe('agora');
    expect(formatRelativeTime(AGORA - 5_000, AGORA, 'en')).toBe('now');
  });

  it('minutos e horas', () => {
    expect(formatRelativeTime(AGORA - 4 * MIN, AGORA, 'pt-BR')).toBe('há 4 min');
    expect(formatRelativeTime(AGORA - 4 * MIN, AGORA, 'en')).toBe('4 min ago');
    expect(formatRelativeTime(AGORA - 2 * HORA, AGORA, 'pt-BR')).toBe('há 2 h');
    expect(formatRelativeTime(AGORA - 2 * HORA, AGORA, 'en')).toBe('2 h ago');
  });

  /**
   * A forma curta da spec §13 é a MESMA no singular: `há 1 min` / `1 min ago`,
   * não "há um minuto". A asserção existe porque o singular é exatamente onde
   * um `Intl.RelativeTimeFormat` (ou uma regra de plural bem-intencionada)
   * mudaria a frase sem que nenhum outro teste percebesse.
   */
  it('o singular usa a mesma forma curta do plural', () => {
    expect(formatRelativeTime(AGORA - MIN, AGORA, 'pt-BR')).toBe('há 1 min');
    expect(formatRelativeTime(AGORA - MIN, AGORA, 'en')).toBe('1 min ago');
    expect(formatRelativeTime(AGORA - HORA, AGORA, 'pt-BR')).toBe('há 1 h');
    expect(formatRelativeTime(AGORA - HORA, AGORA, 'en')).toBe('1 h ago');
  });

  it('um dia é "ontem"; mais que isso é a contagem', () => {
    expect(formatRelativeTime(AGORA - DIA, AGORA, 'pt-BR')).toBe('ontem');
    expect(formatRelativeTime(AGORA - DIA, AGORA, 'en')).toBe('yesterday');
    expect(formatRelativeTime(AGORA - 9 * DIA, AGORA, 'pt-BR')).toBe('há 9 dias');
    expect(formatRelativeTime(AGORA - 9 * DIA, AGORA, 'en')).toBe('9 days ago');
  });

  /**
   * Relógio que andou pra trás (o `at` no futuro) não vira "há -3 min": o
   * decorrido é grampeado em zero, como a UI já fazia.
   */
  it('futuro vira "agora"', () => {
    expect(formatRelativeTime(AGORA + 5 * MIN, AGORA, 'pt-BR')).toBe('agora');
  });
});
