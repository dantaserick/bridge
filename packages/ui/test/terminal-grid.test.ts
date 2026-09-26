/**
 * A grade (`cols`×`rows`) que o core JÁ SABE de uma sessão: a decisão pura por
 * trás de cada `resize` que o `Terminal` manda pelo WS.
 *
 * Por que ela é um módulo à parte (achado de 11/09/2026): a regra morava dentro do efeito de montagem do `Terminal`, que
 * `packages/ui` não consegue montar (a suíte roda em `node`, e não há teste de
 * componente por ruling). Lá, ela nascia errada — o `gridRef` era semeado com
 * o `term.cols`/`term.rows` do CONSTRUTOR do xterm (80×24, antes de qualquer
 * `fit()`), e um painel cuja primeira medição desse exatamente 80×24 tinha o
 * primeiro `resize` deduplicado e nunca contava a grade pro core: o PTY ficava
 * com os `DEFAULT_COLS` (120) e o terminal desenhava 80 colunas.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gridAfterSync } from '../src/terminalGrid.js';

const G80 = { cols: 80, rows: 24 };
const G120 = { cols: 120, rows: 30 };

describe('gridAfterSync — mandar ou não mandar', () => {
  it('a PRIMEIRA grade sempre sai, mesmo sendo os 80×24 do construtor', () => {
    // É o defeito inteiro num caso: sem grade conhecida não existe dedupe.
    expect(gridAfterSync(undefined, G80, false).send).toBe(true);
  });

  it('a mesma grade de novo não sai: arrastar poucos pixels não muda a grade', () => {
    expect(gridAfterSync(G120, { ...G120 }, false).send).toBe(false);
  });

  it('grade diferente sai — em qualquer um dos dois eixos', () => {
    expect(gridAfterSync(G120, { cols: 119, rows: 30 }, false).send).toBe(true);
    expect(gridAfterSync(G120, { cols: 120, rows: 29 }, false).send).toBe(true);
  });
});

describe('gridAfterSync — o que o core passa a saber', () => {
  it('o aviso que SAIU vira a grade conhecida', () => {
    expect(gridAfterSync(undefined, G120, true).grid).toEqual(G120);
  });

  it('o aviso PERDIDO não vira nada: a grade fica por confirmar', () => {
    // `bridgeWs.send` descarta em silêncio com o socket fora do `OPEN` (não há
    // fila), e a UI pede o `GET /api/state` ANTES de abrir o WS: o primeiro
    // `fit()` de um terminal pode muito bem acontecer com o handshake em voo.
    expect(gridAfterSync(undefined, G120, false).grid).toBeUndefined();
    expect(gridAfterSync(G80, G120, false).grid).toEqual(G80);
  });

  it('aviso perdido é remandado no sync seguinte; aviso entregue não é', () => {
    const perdido = gridAfterSync(undefined, G120, false);
    expect(gridAfterSync(perdido.grid, G120, false).send).toBe(true);

    const entregue = gridAfterSync(undefined, G120, true);
    expect(gridAfterSync(entregue.grid, G120, false).send).toBe(false);
  });
});

/**
 * O único pedaço que não cabe no módulo puro: a SEMENTE do ref na montagem do
 * `Terminal`. Uma linha, e é a linha que o defeito acima escreveu errado —
 * daí o arame farpado.
 */
describe('Terminal — a semente da grade', () => {
  it('nasce por confirmar (undefined), e não com a grade do construtor', () => {
    const SRC = readFileSync(new URL('../src/components/Terminal.tsx', import.meta.url), 'utf8');
    expect(SRC).toContain('gridRef.current = undefined;');
  });
});
