import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
describe('EventBus', () => {
  it('entrega pra todos e o cancelador remove', () => {
    const bus = new EventBus(); const got: string[] = [];
    const off = bus.on((e) => got.push('a:' + e.type));
    bus.on((e) => got.push('b:' + e.type));
    bus.emit({ type: 'layout.changed' }); off(); bus.emit({ type: 'layout.changed' });
    expect(got).toEqual(['a:layout.changed', 'b:layout.changed', 'b:layout.changed']);
  });
  it('listener que lança não derruba os outros', () => {
    const bus = new EventBus(); let ok = false;
    bus.on(() => { throw new Error('x'); }); bus.on(() => { ok = true; });
    bus.emit({ type: 'layout.changed' }); expect(ok).toBe(true);
  });
});
