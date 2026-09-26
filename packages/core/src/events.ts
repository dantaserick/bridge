import type { BridgeEvent } from '@bridge/shared';

export type { BridgeEvent } from '@bridge/shared';

export type Listener = (e: BridgeEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  /** `onError` deixa o core mandar a falha pro log de arquivo; sem ele, console. */
  constructor(private onError: (err: unknown) => void = (err) => console.error('[bus] listener falhou', err)) {}
  on(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: BridgeEvent): void {
    for (const l of [...this.listeners]) {
      try { l(e); } catch (err) { this.onError(err); }
    }
  }
}
