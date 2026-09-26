import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  JITTER_MAX_MS,
  JITTER_MIN_MS,
  Launcher,
  LauncherPaneQueuedError,
  LauncherQueueFullError,
  PENDING_MAX,
} from '../src/launcher.js';
import type { LauncherStatus } from '../src/model.js';

/**
 * Dor verificada #1 — o escalonador de lançamentos.
 *
 * Tudo aqui roda com relógio, sorteio e agendador INJETADOS: o que está sob
 * teste é a decisão (quem sai, quando, em que ordem), não a pontualidade do
 * `setTimeout` do Node. Um teste que esperasse 5 s de verdade pro backoff
 * seria lento e instável, e não provaria nada além de que o timer existe.
 */

/** Relógio e agendador de mentira: o tempo só anda quando o teste manda. */
function fakeClock() {
  let now = 1_000;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    /** Avança o relógio e dispara o que venceu, na ordem. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => !t.cancelled && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.cancelled = true;
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
    },
  };
}

interface Harness {
  launcher: Launcher<{ tag: string }>;
  clock: ReturnType<typeof fakeClock>;
  launched: string[];
  statuses: LauncherStatus[];
  state: { active: number; limited: number; max: number; enabled: boolean };
  fail: { on: Set<string> };
  /** Lançamentos que ficam pendurados até o teste os soltar (`release`). */
  slow: { on: Set<string>; pending: Map<string, () => void> };
  release: (tag: string) => void;
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const clock = fakeClock();
  const launched: string[] = [];
  const statuses: LauncherStatus[] = [];
  const state = { active: 0, limited: 0, max: 4, enabled: true, ...overrides };
  const fail = { on: new Set<string>() };
  const slow = { on: new Set<string>(), pending: new Map<string, () => void>() };
  const launcher = new Launcher<{ tag: string }>({
    maxConcurrent: () => state.max,
    enabled: () => state.enabled,
    activeAgents: () => state.active,
    serverLimited: () => state.limited,
    launch: async (ticket) => {
      // O `available()` do adaptador leva segundos no mundo real; aqui o
      // teste segura o lançamento à mão pra observar a janela entre o
      // despacho e a sessão existir — que é onde a rajada furava o teto.
      launched.push(ticket.input.tag);
      if (slow.on.has(ticket.input.tag)) {
        await new Promise<void>((resolve) => slow.pending.set(ticket.input.tag, resolve));
      }
      if (fail.on.has(ticket.input.tag)) throw new Error(`falhou: ${ticket.input.tag}`);
      // A cedência importa: o `createSession` de verdade é assíncrono (mkdir,
      // `available()`, spawn), e a sessão só passa a contar como VIVA depois
      // dele. Sem ela o corpo `async` rodaria inteiro de forma síncrona e a
      // sessão contaria duas vezes — viva e reservada — no mesmo instante.
      await Promise.resolve();
      state.active += 1;
      return undefined;
    },
    onChanged: (status) => statuses.push(status),
    now: clock.now,
    // Sorteio fixo no MEIO da faixa: o jitter continua sendo o de produção
    // (300–900), só que previsível — 600 ms.
    random: () => 0.5,
    schedule: clock.schedule,
  });
  const release = (tag: string): void => {
    const resolve = slow.pending.get(tag);
    slow.pending.delete(tag);
    resolve?.();
  };
  return { launcher, clock, launched, statuses, state, fail, slow, release };
}

/**
 * Cede o event loop de verdade (macrotarefa): o `launch` do harness é `async`,
 * e a cadeia "promessa termina → solta a reserva → rearma a fila" leva
 * algumas microtarefas. Contar `Promise.resolve()` na mão dava teste frágil.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function request(h: Harness, tag: string) {
  return h.launcher.request({ paneId: `pane_${tag}`, workspaceId: 'ws_1', agent: 'claude', input: { tag } });
}

describe('escalonador: o primeiro lançamento não espera', () => {
  it('sem ninguém de pé e sem fila, o pedido sai na hora (201, não 202)', () => {
    const h = harness();
    // `launched` é a promessa do lançamento — quem chama responde 201 com ela.
    expect(request(h, 'a')).toMatchObject({ queued: false });
    expect(h.launcher.pending()).toEqual([]);
  });

  it('com o escalonador DESLIGADO nada é segurado — nem além do teto', () => {
    const h = harness({ enabled: false, active: 99 });
    expect(request(h, 'a')).toMatchObject({ queued: false });
    expect(h.launcher.hold()).toBeUndefined();
  });
});

describe('escalonador: jitter da rajada', () => {
  it('o segundo pedido da rajada entra na fila e sai depois do jitter', () => {
    const h = harness();
    request(h, 'a');
    const second = request(h, 'b');
    expect(second).toMatchObject({ queued: true, reason: 'jitter' });
    if (second.queued) expect(second.ticket.position).toBe(1);
    // O `a` saiu na hora (pelo próprio escalonador, que é quem reserva o
    // slot); o `b` é o que está esperando.
    expect(h.launched).toEqual(['a']);

    // 600 ms = o meio da faixa 300–900 com o sorteio fixo do harness.
    h.clock.advance(599);
    expect(h.launched).toEqual(['a']);
    h.clock.advance(2);
    expect(h.launched).toEqual(['a', 'b']);
  });

  it('o jitter fica na faixa declarada', () => {
    const h = harness();
    request(h, 'a');
    expect(h.launcher.spacingMs()).toBeGreaterThanOrEqual(JITTER_MIN_MS);
    expect(h.launcher.spacingMs()).toBeLessThanOrEqual(JITTER_MAX_MS);
  });

  it('a fila sai na ORDEM em que entrou, um por jitter', () => {
    const h = harness();
    request(h, 'a');
    request(h, 'b');
    request(h, 'c');
    request(h, 'd');
    expect(h.launcher.pending().map((p) => p.position)).toEqual([1, 2, 3]);
    h.clock.advance(600);
    expect(h.launched).toEqual(['a', 'b']);
    h.clock.advance(600);
    expect(h.launched).toEqual(['a', 'b', 'c']);
    h.clock.advance(600);
    expect(h.launched).toEqual(['a', 'b', 'c', 'd']);
  });

  it('com fila formada, o pedido novo vai pro FIM mesmo com slot livre', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'a');
    request(h, 'b');
    // Um slot vagou, mas há gente esperando: o recém-chegado NÃO passa na
    // frente de quem já estava na fila.
    h.state.active = 1;
    const c = request(h, 'c');
    expect(c).toMatchObject({ queued: true });
    if (c.queued) expect(c.ticket.position).toBe(3);
  });
});

describe('escalonador: teto de concorrência', () => {
  it('além do teto o pedido espera SLOT, sem previsão de horário', () => {
    const h = harness({ active: 4, max: 4 });
    const queued = request(h, 'e');
    expect(queued).toMatchObject({ queued: true, reason: 'slots' });
    h.clock.advance(60_000);
    // Nenhum timer resolve "falta slot": o que solta é uma sessão morrer.
    expect(h.launched).toEqual([]);
    expect(h.launcher.status().nextAt).toBeUndefined();

    h.state.active = 3;
    h.launcher.poke();
    expect(h.launched).toEqual(['e']);
  });

  it('subir o teto pela configuração solta a fila na hora', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'e');
    h.state.max = 8;
    h.launcher.poke();
    expect(h.launched).toEqual(['e']);
  });
});

describe('escalonador: backoff com o servidor estrangulando', () => {
  it('o espaçamento vira 5 s e DOBRA a cada lançamento, até 60 s', () => {
    const h = harness();
    h.state.limited = 1;
    expect(h.launcher.spacingMs()).toBe(BACKOFF_MIN_MS);

    request(h, 'a');
    expect(h.launcher.spacingMs()).toBe(2 * BACKOFF_MIN_MS);
    const queued = request(h, 'b');
    expect(queued).toMatchObject({ queued: true, reason: 'backoff' });

    h.clock.advance(9_000);
    expect(h.launched).toEqual(['a']);
    h.clock.advance(2_000);
    expect(h.launched).toEqual(['a', 'b']);

    for (let i = 0; i < 10; i += 1) h.launcher.noteLaunched();
    expect(h.launcher.spacingMs()).toBe(BACKOFF_MAX_MS);
  });

  it('sem ninguém estrangulado o degrau volta ao piso e o jitter reassume', () => {
    const h = harness();
    h.state.limited = 1;
    request(h, 'a');
    h.state.limited = 0;
    h.launcher.noteServerLimitCleared();
    expect(h.launcher.spacingMs()).toBeLessThanOrEqual(JITTER_MAX_MS);
  });
});

describe('escalonador: "Lançar agora", cancelar e falha', () => {
  it('lança o primeiro da fila ignorando o teto', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'e');
    request(h, 'f');
    const launched = h.launcher.launchNow();
    expect(launched?.paneId).toBe('pane_e');
    expect(h.launched).toEqual(['e']);
    expect(h.launcher.pending().map((p) => p.paneId)).toEqual(['pane_f']);
  });

  it('lança um id específico do meio da fila', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'e');
    const second = request(h, 'f');
    const id = second.queued ? second.ticket.id : '';
    expect(h.launcher.launchNow(id)?.id).toBe(id);
    expect(h.launched).toEqual(['f']);
  });

  it('id que não está na fila devolve undefined (a rota vira 404)', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'e');
    expect(h.launcher.launchNow('lnch_inexistente')).toBeUndefined();
  });

  it('cancelar tira da fila sem lançar', () => {
    const h = harness({ active: 4, max: 4 });
    const queued = request(h, 'e');
    const id = queued.queued ? queued.ticket.id : '';
    expect(h.launcher.cancel(id)).toBe(true);
    expect(h.launcher.pending()).toEqual([]);
    expect(h.launched).toEqual([]);
    expect(h.launcher.cancel(id)).toBe(false);
  });

  it('lançamento que FALHA vira `lastError` e não trava a fila', async () => {
    const h = harness();
    h.fail.on.add('b');
    request(h, 'a');
    request(h, 'b');
    request(h, 'c');
    h.clock.advance(600);
    // O `catch` do lançamento cai numa microtarefa: sem esta cedência o
    // `lastError` ainda não foi gravado quando a asserção roda.
    await flush();
    expect(h.launcher.status().lastError?.paneId).toBe('pane_b');
    expect(h.launcher.status().lastError?.message).toContain('falhou: b');
    // O `c` continua andando: o painel que sumiu não pode segurar a fila.
    h.clock.advance(600);
    expect(h.launched).toEqual(['a', 'b', 'c']);
  });

  it('a fila tem teto: passou dele, o pedido é RECUSADO em vez de acumular', () => {
    const h = harness({ active: 4, max: 4 });
    for (let i = 0; i < PENDING_MAX; i += 1) request(h, `t${i}`);
    expect(() => request(h, 'demais')).toThrow(LauncherQueueFullError);
  });
});

describe('escalonador: status e evento', () => {
  it('o status conta o que a sidebar mostra', () => {
    const h = harness({ active: 4, max: 4, limited: 1 });
    request(h, 'a');
    const status = h.launcher.status();
    expect(status).toMatchObject({
      enabled: true,
      maxConcurrent: 4,
      // `active` e `serverLimited` são medidos em `Sessions` pelo core, não
      // contados aqui: um contador próprio divergiria do estado real.
      active: 4,
      serverLimited: 1,
      spacingMs: BACKOFF_MIN_MS,
    });
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).toMatchObject({ paneId: 'pane_a', agent: 'claude', position: 1 });
  });

  it('cada mudança da fila emite um status novo', () => {
    const h = harness();
    request(h, 'a');
    const antes = h.statuses.length;
    request(h, 'b');
    expect(h.statuses.length).toBeGreaterThan(antes);
    expect(h.statuses[h.statuses.length - 1]?.pending).toHaveLength(1);
  });

  it('`stop` cala o escalonador: nem timer, nem evento', () => {
    const h = harness();
    request(h, 'a');
    request(h, 'b');
    h.launcher.stop();
    const antes = h.statuses.length;
    h.clock.advance(10_000);
    // O `a` saiu antes do `stop`; o `b`, que estava na fila, não sai mais.
    expect(h.launched).toEqual(['a']);
    expect(h.statuses.length).toBe(antes);
  });
});

// ------------------- fix round 1: reserva de slot e um painel por vez

/**
 * O buraco que o review pegou: `activeAgents()` conta sessão VIVA, e entre o
 * despacho e a sessão existir corre o `adapter.available()` (segundos). Sem
 * reservar o slot no despacho, uma rajada passava inteira pelo `hold()` antes
 * de o primeiro agente virar sessão — o teto de 4 deixava subir 8.
 */
describe('escalonador: reserva de slot (o teto vale durante o `available()`)', () => {
  it('oito pedidos com teto 4 e lançamento lento: nunca mais de 4 despachados ao mesmo tempo', async () => {
    const h = harness({ max: 4 });
    for (let i = 0; i < 8; i += 1) h.slow.on.add(`t${i}`);
    for (let i = 0; i < 8; i += 1) request(h, `t${i}`);

    // Tempo de sobra: se o teto dependesse só de sessão viva (que aqui NUNCA
    // aparece, porque nenhum lançamento terminou), os oito teriam saído.
    h.clock.advance(60_000);
    await flush();
    expect(h.launched).toHaveLength(4);
    expect(h.launcher.pending()).toHaveLength(4);
    expect(h.launcher.status().active).toBe(4);
    expect(h.launcher.hold()).toBe('slots');

    // O `t0` TERMINA de subir: a reserva vira sessão viva, e o total continua
    // 4 — soltar o lançamento não libera slot nenhum, e é isso que impede a
    // fila de furar o teto por dentro.
    h.release('t0');
    await flush();
    h.clock.advance(1_000);
    await flush();
    expect(h.launched).toHaveLength(4);
    expect(h.launcher.status().active).toBe(4);

    // Agora sim: a sessão ENCERRA e o slot vaga.
    h.state.active -= 1;
    h.launcher.poke();
    await flush();
    expect(h.launched).toHaveLength(5);
    expect(h.launcher.status().active).toBe(4);
  });

  it('a reserva é solta mesmo quando o lançamento FALHA', async () => {
    const h = harness({ max: 1 });
    h.slow.on.add('a');
    h.fail.on.add('a');
    request(h, 'a');
    request(h, 'b');
    expect(h.launcher.status().active).toBe(1);

    h.release('a');
    await flush();
    // O `a` falhou: nenhuma sessão viva, nenhuma reserva — o `b` pode sair.
    expect(h.launcher.status().active).toBe(0);
    h.clock.advance(1_000);
    expect(h.launched).toContain('b');
  });

  it('o pedido imediato também reserva: o segundo já vê o teto cheio', () => {
    const h = harness({ max: 1 });
    h.slow.on.add('a');
    const primeiro = request(h, 'a');
    expect(primeiro.queued).toBe(false);
    const segundo = request(h, 'b');
    expect(segundo).toMatchObject({ queued: true, reason: 'slots' });
  });
});

describe('escalonador: um lançamento por painel', () => {
  it('segundo pedido no mesmo painel enfileirado → recusa (vira 409 na rota)', () => {
    const h = harness({ active: 4, max: 4 });
    request(h, 'a');
    expect(() => request(h, 'a')).toThrow(LauncherPaneQueuedError);
    expect(h.launcher.pending()).toHaveLength(1);
  });

  it('segundo pedido no mesmo painel EM VOO também é recusado', () => {
    const h = harness({ max: 4 });
    h.slow.on.add('a');
    request(h, 'a');
    expect(h.launcher.holdsPane('pane_a')).toBe(true);
    expect(() => request(h, 'a')).toThrow(LauncherPaneQueuedError);
  });

  it('painel liberado depois do lançamento aceita um pedido novo', async () => {
    const h = harness({ max: 4 });
    h.slow.on.add('a');
    request(h, 'a');
    h.release('a');
    await flush();
    expect(h.launcher.holdsPane('pane_a')).toBe(false);
    expect(() => request(h, 'a')).not.toThrow();
  });

  it('cancelar tira o painel da fila e libera pedido novo', () => {
    const h = harness({ active: 4, max: 4 });
    const queued = request(h, 'a');
    const id = queued.queued ? queued.ticket.id : '';
    h.launcher.cancel(id);
    expect(h.launcher.holdsPane('pane_a')).toBe(false);
  });
});
