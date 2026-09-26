export interface OscNotification {
  title?: string;
  body: string;
}

const MAX_PENDING_BYTES = 4 * 1024;
const ESC = '\x1b';
const BEL = '\x07';
const OSC_START = ESC + ']';
const ST = ESC + '\\';

function parseOsc(payload: string): OscNotification | undefined {
  const sep = payload.indexOf(';');
  if (sep === -1) return undefined;
  const code = payload.slice(0, sep);
  const rest = payload.slice(sep + 1);

  if (code === '9') {
    return { body: rest };
  }

  if (code === '777') {
    // notify;<título>;<corpo>
    const parts = rest.split(';');
    if (parts[0] !== 'notify') return undefined;
    const title = parts[1] ?? '';
    const body = parts.slice(2).join(';');
    return { title, body };
  }

  if (code === '99') {
    // <params>;<corpo> — params é k=v:k=v, separado por ':'
    const paramsSep = rest.indexOf(';');
    if (paramsSep === -1) return undefined;
    const params = rest.slice(0, paramsSep);
    const body = rest.slice(paramsSep + 1);
    const kv = Object.fromEntries(
      params
        .split(':')
        .map((pair) => pair.split('='))
        .filter((pair) => pair.length === 2)
        .map(([k, v]) => [k, v]),
    );
    const p = kv.p;
    if (p !== undefined && p !== 'body') return undefined;
    return { body };
  }

  return undefined;
}

export class OscScanner {
  private pending = '';

  /** Alimenta um chunk; devolve as notificações completas encontradas. Guarda resto parcial entre chunks (máx 4 KB; acima disso descarta). */
  push(chunk: string): OscNotification[] {
    this.pending += chunk;
    const results: OscNotification[] = [];

    for (;;) {
      const start = this.pending.indexOf(OSC_START);
      if (start === -1) {
        // sem início de OSC pendente — descarta texto acumulado, mantendo
        // apenas o suficiente para o caso de um ESC solitário no fim do chunk.
        if (this.pending.length > 0 && this.pending[this.pending.length - 1] === ESC) {
          this.pending = ESC;
        } else {
          this.pending = '';
        }
        break;
      }

      // descarta texto antes do início do OSC
      if (start > 0) {
        this.pending = this.pending.slice(start);
      }

      const belIdx = this.pending.indexOf(BEL, OSC_START.length);
      const stIdx = this.pending.indexOf(ST, OSC_START.length);
      let termIdx = -1;
      let termLen = 0;
      if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
        termIdx = belIdx;
        termLen = 1;
      } else if (stIdx !== -1) {
        termIdx = stIdx;
        termLen = 2;
      }

      if (termIdx === -1) {
        // sequência ainda incompleta — espera mais dados, mas respeita o cap
        if (this.pending.length > MAX_PENDING_BYTES) {
          this.pending = '';
        }
        break;
      }

      const payload = this.pending.slice(OSC_START.length, termIdx);
      const notification = parseOsc(payload);
      if (notification) results.push(notification);
      this.pending = this.pending.slice(termIdx + termLen);
    }

    return results;
  }
}
