import { describe, expect, it } from 'vitest';
import { settleLimit, settleLimits } from '../src/model.js';

describe('settleLimit — a janela como ela está agora (16/09/2026)', () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);

  it('reset ainda no futuro: a foto vale como está', () => {
    const limit = { window: 'five_hour', usedPct: 68, resetsAt: (now + 60_000) / 1000 };
    expect(settleLimit(limit, now)).toBe(limit);
  });

  it('reset vencido: a janela renovou — 0 % e sem hora de reset', () => {
    const limit = { window: 'five_hour', usedPct: 68, resetsAt: (now - 1) / 1000 };
    expect(settleLimit(limit, now)).toEqual({ window: 'five_hour', usedPct: 0, resetsAt: undefined });
  });

  it('reset exatamente agora conta como vencido', () => {
    expect(settleLimit({ usedPct: 50, resetsAt: now / 1000 }, now).usedPct).toBe(0);
  });

  it('sem resets_at (ou inválido) não há o que decidir: fica como está', () => {
    const semReset = { usedPct: 41 };
    expect(settleLimit(semReset, now)).toBe(semReset);
    const nan = { usedPct: 41, resetsAt: Number.NaN };
    expect(settleLimit(nan, now)).toBe(nan);
  });

  it('settleLimits aplica a regra janela a janela, preservando a ordem', () => {
    const limits = [
      { window: 'five_hour', usedPct: 68, resetsAt: (now - 1000) / 1000 },
      { window: 'seven_day', usedPct: 41, resetsAt: (now + 86_400_000) / 1000 },
    ];
    expect(settleLimits(limits, now).map((l) => [l.window, l.usedPct])).toEqual([
      ['five_hour', 0],
      ['seven_day', 41],
    ]);
  });
});
