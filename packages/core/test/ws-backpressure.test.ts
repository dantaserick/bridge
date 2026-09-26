import { describe, expect, it } from 'vitest';
import {
  PtyDataPump,
  WS_COALESCE_BYTES,
  WS_DROP_BYTES,
  WS_RETRY_MS,
  coalescePending,
  shouldWarn,
} from '../src/api/ws.js';
import type { PendingChunk } from '../src/api/ws.js';

function chunk(sessionId: string, data: string): PendingChunk {
  return { sessionId, data };
}

/** Só os campos que importam pro assert, pra o `toEqual` não virar ruído. */
function merged(result: ReturnType<typeof coalescePending>): PendingChunk[] {
  return result.sessions.map((s) => ({ sessionId: s.sessionId, data: s.data }));
}

describe('coalescePending (backpressure do WS)', () => {
  it('agrupa os chunks pendentes de cada sessão num só, preservando ordem de chegada da sessão', () => {
    const pending = [chunk('b', '1'), chunk('a', 'x'), chunk('a', 'y'), chunk('b', '2'), chunk('a', 'z')];
    const result = coalescePending(pending, WS_DROP_BYTES);

    expect(merged(result)).toEqual([chunk('b', '12'), chunk('a', 'xyz')]);
    expect(result.coalesced).toBe(3);
    expect(result.droppedBytes).toBe(0);
  });

  it('lista vazia → nada a mandar, nada contado', () => {
    expect(coalescePending([], WS_DROP_BYTES)).toEqual({ sessions: [], coalesced: 0, droppedBytes: 0 });
  });

  it('um único chunk por sessão não conta como coalescido', () => {
    const result = coalescePending([chunk('a', 'oi')], WS_DROP_BYTES);
    expect(merged(result)).toEqual([chunk('a', 'oi')]);
    expect(result.coalesced).toBe(0);
  });

  it('acima do teto de descarte, joga fora os chunks MAIS ANTIGOS daquela sessão e conta os bytes', () => {
    const pending = [chunk('a', 'AAAA'), chunk('a', 'BBBB'), chunk('a', 'CC')];
    const result = coalescePending(pending, 6);

    expect(merged(result)).toEqual([chunk('a', 'BBBBCC')]);
    expect(result.droppedBytes).toBe(4);
    expect(result.sessions[0]!.droppedChunks).toBe(1);
  });

  it('chunk descartado NÃO conta como agrupado (atribuição do warn)', () => {
    // 3 chunks, 1 descartado, 2 sobreviventes fundidos → 1 fusão, não 2.
    const result = coalescePending([chunk('a', 'AAAA'), chunk('a', 'BBBB'), chunk('a', 'CC')], 6);
    expect(result.coalesced).toBe(1);
    expect(result.sessions[0]!.coalesced).toBe(1);
    expect(result.sessions[0]!.droppedChunks).toBe(1);
  });

  it('as contagens são por sessão, não só o total', () => {
    const result = coalescePending([chunk('a', 'AAAA'), chunk('a', 'BBBB'), chunk('b', 'o'), chunk('b', 'k')], 6);
    const byId = Object.fromEntries(result.sessions.map((s) => [s.sessionId, s]));

    expect(byId.a).toMatchObject({ data: 'BBBB', coalesced: 0, droppedChunks: 1, droppedBytes: 4 });
    expect(byId.b).toMatchObject({ data: 'ok', coalesced: 1, droppedChunks: 0, droppedBytes: 0 });
  });

  it('o teto é por sessão: uma sessão barulhenta não descarta a saída da outra', () => {
    const result = coalescePending([chunk('a', 'AAAA'), chunk('a', 'BBBB'), chunk('b', 'ok')], 6);
    expect(merged(result)).toEqual([chunk('a', 'BBBB'), chunk('b', 'ok')]);
    expect(result.droppedBytes).toBe(4);
  });

  it('nunca descarta o último chunk de uma sessão, mesmo se ele sozinho passa do teto', () => {
    const result = coalescePending([chunk('a', 'AAAAAAAAAA')], 4);
    expect(merged(result)).toEqual([chunk('a', 'AAAAAAAAAA')]);
    expect(result.droppedBytes).toBe(0);
  });

  it('os limiares são os da onda: 1 MB pra coalescer, 8 MB pra descartar', () => {
    expect(WS_COALESCE_BYTES).toBe(1024 * 1024);
    expect(WS_DROP_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('shouldWarn (R2: no máximo um warn por sessão por minuto)', () => {
  it('deixa passar o primeiro, segura os seguintes dentro da janela e libera depois', () => {
    const last = new Map<string, number>();
    expect(shouldWarn(last, 'a', 0, 60000)).toBe(true);
    expect(shouldWarn(last, 'a', 100, 60000)).toBe(false);
    expect(shouldWarn(last, 'a', 59999, 60000)).toBe(false);
    expect(shouldWarn(last, 'a', 60000, 60000)).toBe(true);
  });

  it('a janela é por sessão', () => {
    const last = new Map<string, number>();
    expect(shouldWarn(last, 'a', 0, 60000)).toBe(true);
    expect(shouldWarn(last, 'b', 0, 60000)).toBe(true);
  });
});

/**
 * Socket falso com `bufferedAmount` sob controle do teste, e `schedule` que
 * guarda o callback em vez de agendar — o teste roda o flush na mão e
 * consegue exercitar MÚLTIPLOS ticks com o socket entupido, que é o caso em
 * que o teto de 8 MB precisa valer.
 */
function makePump(bufferedAmount = 0) {
  const socket = { bufferedAmount };
  const sent: PendingChunk[] = [];
  const warns: string[] = [];
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];

  const pump = new PtyDataPump({
    socket,
    send: (chunk) => sent.push(chunk),
    schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    warn: (message) => warns.push(message),
    now: () => 0,
  });

  /** Roda o flush agendado (um só por vez, como o `armed` do pump garante). */
  const tick = (): number | undefined => {
    const next = scheduled.shift();
    next?.fn();
    return next?.delayMs;
  };

  return { pump, socket, sent, warns, scheduled, tick };
}

describe('PtyDataPump (fila de pty.data por socket)', () => {
  it('socket folgado: manda direto, sem fila nem agendamento', () => {
    const { pump, sent, scheduled } = makePump(0);
    pump.push('a', 'oi');
    expect(sent).toEqual([chunk('a', 'oi')]);
    expect(scheduled).toHaveLength(0);
    expect(pump.queued).toBe(0);
  });

  it('socket entupido: NÃO manda nada e os chunks se acumulam ao longo de vários ticks', () => {
    const { pump, sent, tick } = makePump(WS_COALESCE_BYTES + 1);

    pump.push('a', 'um');
    pump.push('a', 'dois');
    expect(sent).toEqual([]);
    expect(pump.queued).toBe(2);

    // Primeiro flush: continua entupido → segura (já fundido) e reagenda.
    expect(tick()).toBe(0);
    expect(sent).toEqual([]);
    expect(pump.queued).toBe(1);

    pump.push('a', 'tres');
    expect(sent).toEqual([]);

    // Segundo flush, ainda entupido: reagenda com o retry, sem mandar nada.
    expect(tick()).toBe(WS_RETRY_MS);
    expect(sent).toEqual([]);
    expect(pump.queued).toBe(1);
  });

  it('quando o socket desafoga, sai um chunk fundido por sessão, na ordem em que entraram', () => {
    const { pump, socket, sent, tick } = makePump(WS_COALESCE_BYTES + 1);

    pump.push('b', '1');
    pump.push('a', 'x');
    pump.push('b', '2');
    pump.push('a', 'y');
    tick();
    expect(sent).toEqual([]);

    socket.bufferedAmount = 0;
    tick();

    expect(sent).toEqual([chunk('b', '12'), chunk('a', 'xy')]);
    expect(pump.queued).toBe(0);
  });

  it('com o socket entupido, passar de 8 MB numa sessão descarta o mais antigo e guarda o mais novo', () => {
    const { pump, socket, sent, tick } = makePump(WS_COALESCE_BYTES + 1);
    const mb = 'A'.repeat(1024 * 1024);

    // 10 MB numa sessão só, sem o socket nunca desafogar.
    for (let i = 0; i < 9; i++) pump.push('a', mb);
    pump.push('a', 'FIM-NOVO');
    tick();

    expect(sent).toEqual([]);
    expect(pump.queued).toBe(1);

    socket.bufferedAmount = 0;
    tick();

    expect(sent).toHaveLength(1);
    const data = sent[0]!.data;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(WS_DROP_BYTES);
    expect(data.endsWith('FIM-NOVO')).toBe(true);
  });

  it('o teto vale ACUMULADO entre ticks, não só dentro de um', () => {
    const { pump, socket, sent, tick } = makePump(WS_COALESCE_BYTES + 1);
    const mb = 'A'.repeat(1024 * 1024);

    // 3 MB por tick, 4 ticks: sozinho nenhum tick estoura, somados sim.
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 3; i++) pump.push('a', mb);
      tick();
      expect(sent).toEqual([]);
    }
    pump.push('a', 'FIM-NOVO');

    socket.bufferedAmount = 0;
    tick();

    expect(Buffer.byteLength(sent[0]!.data, 'utf8')).toBeLessThanOrEqual(WS_DROP_BYTES);
    expect(sent[0]!.data.endsWith('FIM-NOVO')).toBe(true);
  });

  it('avisa no log uma vez por sessão, com fusão e descarte atribuídos àquela sessão', () => {
    const { pump, warns, tick } = makePump(WS_COALESCE_BYTES + 1);

    pump.push('a', 'um');
    pump.push('a', 'dois');
    pump.push('b', 'x');
    pump.push('b', 'y');
    tick();

    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain('[ws] socket lento na sessão a');
    expect(warns[1]).toContain('[ws] socket lento na sessão b');

    // Segunda passada dentro do minuto não repete o aviso.
    pump.push('a', 'tres');
    tick();
    expect(warns).toHaveLength(2);
  });

  it('clear() joga a fila fora (socket fechou)', () => {
    const { pump, sent, socket, tick } = makePump(WS_COALESCE_BYTES + 1);
    pump.push('a', 'oi');
    pump.clear();
    socket.bufferedAmount = 0;
    tick();
    expect(sent).toEqual([]);
  });
});
