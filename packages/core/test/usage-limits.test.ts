/**
 * As janelas de limite (ADR-012): rótulo, frase de reset, ordem e o que conta
 * como "mudou". A persistência é coberta junto, porque o rótulo NÃO é
 * gravado — ele é derivado da chave a cada leitura, pra que uma janela nova
 * ganhe rótulo sem migração de banco.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import {
  weekdayLabel,
  clampPct,
  formatReset,
  limitsChanged,
  limitsFromRateLimits,
  sortWindows,
  windowLabel,
} from '../src/usage/limits.js';

describe('windowLabel', () => {
  it('as duas janelas conhecidas ganham rótulo pt-BR', () => {
    expect(windowLabel('five_hour', 'pt-BR')).toBe('5h');
    expect(windowLabel('seven_day', 'pt-BR')).toBe('semana');
  });

  /**
   * Janela desconhecida sai com a CHAVE CRUA. Traduzir por adivinhação daria
   * um rótulo bonito e possivelmente errado; a chave é sempre verdade e é o
   * que a pessoa encontra na documentação do Claude Code.
   */
  it('janela desconhecida sai com a chave crua', () => {
    expect(windowLabel('seven_day_opus', 'pt-BR')).toBe('seven_day_opus');
    expect(windowLabel('coisa_nova', 'pt-BR')).toBe('coisa_nova');
  });
});

describe('formatReset', () => {
  const agora = Date.parse('2026-09-05T12:00:00.000Z');
  const em = (ms: number): number => (agora + ms) / 1000;

  it('minutos abaixo de uma hora', () => {
    expect(formatReset(em(43 * 60_000), agora, 'pt-BR')).toBe('reseta em 43min');
    // Menos de um minuto ainda é "1min": "0min" pareceria já ter resetado.
    expect(formatReset(em(20_000), agora, 'pt-BR')).toBe('reseta em 1min');
  });

  it('horas com minutos colados e zero à esquerda', () => {
    expect(formatReset(em((2 * 60 + 15) * 60_000), agora, 'pt-BR')).toBe('reseta em 2h15');
    expect(formatReset(em((2 * 60 + 5) * 60_000), agora, 'pt-BR')).toBe('reseta em 2h05');
    expect(formatReset(em(3 * 3600_000), agora, 'pt-BR')).toBe('reseta em 3h');
  });

  /**
   * A partir de 24 h a contagem em horas sugere um controle que ninguém
   * exerce: o dia da semana é o que a pessoa usa pra se planejar.
   */
  it('a partir de 24 h vira o dia da semana', () => {
    const daqui = agora + 50 * 3600_000;
    expect(formatReset(daqui / 1000, agora, 'pt-BR')).toBe(`reseta ${weekdayLabel(new Date(daqui).getDay(), 'pt-BR')}`);
  });

  it('reset ausente ou vencido não vira frase nenhuma', () => {
    expect(formatReset(undefined, agora, 'pt-BR')).toBeUndefined();
    expect(formatReset(em(-3600_000), agora, 'pt-BR')).toBeUndefined();
    expect(formatReset(Number.NaN, agora, 'pt-BR')).toBeUndefined();
  });
});

describe('ordem e mudança', () => {
  it('5h vem antes da semana, e o resto vem depois em ordem alfabética', () => {
    const ordenadas = sortWindows([
      { window: 'zzz_outra' },
      { window: 'seven_day' },
      { window: 'seven_day_opus' },
      { window: 'five_hour' },
    ]);
    expect(ordenadas.map((w) => w.window)).toEqual(['five_hour', 'seven_day', 'seven_day_opus', 'zzz_outra']);
  });

  /**
   * `seenAt` muda a cada statusline (várias vezes por segundo enquanto o turno
   * roda). Se ele contasse como mudança, a UI repintaria a faixa sem parar.
   */
  it('só percentual e reset contam como mudança — seenAt não', () => {
    const antes = limitsFromRateLimits([{ window: 'five_hour', usedPct: 23, resetsAt: 100 }], 1, 'pt-BR');
    const soOTempo = limitsFromRateLimits([{ window: 'five_hour', usedPct: 23, resetsAt: 100 }], 999, 'pt-BR');
    const outroPct = limitsFromRateLimits([{ window: 'five_hour', usedPct: 24, resetsAt: 100 }], 1, 'pt-BR');
    const outroReset = limitsFromRateLimits([{ window: 'five_hour', usedPct: 23, resetsAt: 200 }], 1, 'pt-BR');
    const janelaNova = limitsFromRateLimits(
      [
        { window: 'five_hour', usedPct: 23, resetsAt: 100 },
        { window: 'seven_day', usedPct: 1 },
      ],
      1,
      'pt-BR',
    );

    expect(limitsChanged(antes, soOTempo)).toBe(false);
    expect(limitsChanged(antes, outroPct)).toBe(true);
    expect(limitsChanged(antes, outroReset)).toBe(true);
    expect(limitsChanged(antes, janelaNova)).toBe(true);
  });
});

describe('persistência', () => {
  it('grava e relê as janelas, com o rótulo DERIVADO da chave', () => {
    const db = openDb(':memory:');
    try {
      db.usage.setLimits(
        limitsFromRateLimits(
          [
            { window: 'five_hour', usedPct: 23, resetsAt: 1_900_000_000 },
            { window: 'seven_day_opus', usedPct: 5 },
          ],
          1234,
          'pt-BR',
        ),
      );

      expect(db.usage.limits('pt-BR')).toEqual([
        { window: 'five_hour', label: '5h', usedPct: 23, resetsAt: 1_900_000_000, seenAt: 1234 },
        { window: 'seven_day_opus', label: 'seven_day_opus', usedPct: 5, resetsAt: undefined, seenAt: 1234 },
      ]);

      // Uma leitura nova por cima substitui a foto, não acumula linha.
      db.usage.setLimits(limitsFromRateLimits([{ window: 'five_hour', usedPct: 90 }], 5678, 'pt-BR'));
      expect(db.usage.limits('pt-BR').find((l) => l.window === 'five_hour')?.usedPct).toBe(90);
    } finally {
      db.close();
    }
  });
});

/**
 * O payload vem de fora. Um `used_percentage` de 120 (já visto quando a janela
 * estoura) viraria uma barra transbordando o cartão; um negativo, uma barra de
 * largura negativa. O número é preso ANTES do banco, pra que nenhuma ponta
 * precise se defender de novo.
 */
describe('clampPct', () => {
  it('prende em [0, 100]', () => {
    expect(clampPct(120)).toBe(100);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(23.4)).toBe(23.4);
    expect(clampPct(Number.NaN)).toBe(0);
  });

  it('as janelas já saem presas de limitsFromRateLimits', () => {
    const janelas = limitsFromRateLimits(
      [
        { window: 'five_hour', usedPct: 120 },
        { window: 'seven_day', usedPct: -5 },
      ],
      1,
      'pt-BR',
    );
    expect(janelas.map((j) => j.usedPct)).toEqual([100, 0]);
  });
});
