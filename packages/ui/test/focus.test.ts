import { describe, expect, it } from 'vitest';
import { FOCUS_HEARTBEAT_MS, shouldHeartbeat } from '../src/focus.js';

describe('shouldHeartbeat', () => {
  const now = 1_000_000;

  it('janela visível e o último POST já venceu: manda de novo', () => {
    expect(shouldHeartbeat('visible', now - FOCUS_HEARTBEAT_MS, now)).toBe(true);
    expect(shouldHeartbeat('visible', now - FOCUS_HEARTBEAT_MS * 3, now)).toBe(true);
  });

  it('POST recente não repete — o tique é mais rápido que o intervalo de propósito', () => {
    expect(shouldHeartbeat('visible', now - 1000, now)).toBe(false);
    expect(shouldHeartbeat('visible', now, now)).toBe(false);
  });

  it('janela escondida (minimizada, outra área de trabalho) não mantém o gate aceso', () => {
    expect(shouldHeartbeat('hidden', now - FOCUS_HEARTBEAT_MS * 5, now)).toBe(false);
  });

  it('sem nenhum POST ainda (lastPostAt = 0) manda o primeiro', () => {
    expect(shouldHeartbeat('visible', 0, now)).toBe(true);
  });

  it('o intervalo cabe folgado no prazo de 60 s do gate do core', () => {
    // O core (`FOCUS_FRESH_MS`) descarta foco com mais de 60 s; o tique é
    // metade do intervalo, então o pior caso é 1,5 × 30 s = 45 s.
    expect(FOCUS_HEARTBEAT_MS * 1.5).toBeLessThan(60_000);
  });
});
