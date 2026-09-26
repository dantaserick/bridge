import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';
describe('newId', () => {
  it('prefixa e gera 12 hex únicos', () => {
    const a = newId('ws'); const b = newId('ws');
    expect(a).toMatch(/^ws_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
