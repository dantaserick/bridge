/**
 * O portão do encerramento do core (0.12.1).
 *
 * O evento do sistema operacional (`session-end` da janela, desligamento do
 * Windows) não é testável aqui — ele só existe com o Electron de pé e o
 * Windows de fato encerrando a sessão do usuário. O que É testável é o modelo
 * que os três caminhos (`will-quit`, `before-quit`, `session-end`) dividem: um
 * `stopCore()` só, venha o pedido de onde vier.
 */
import { describe, expect, it, vi } from 'vitest';
import { createShutdownGate, SESSION_END_LOG } from '../src/shutdown.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createShutdownGate', () => {
  it('o stopCore roda UMA vez só, mesmo com três pedidos', async () => {
    const d = deferred();
    const stop = vi.fn(() => d.promise);
    const lines: string[] = [];
    const gate = createShutdownGate(stop, (line) => lines.push(line));

    const a = gate.request('primeiro');
    const b = gate.request('segundo');
    const c = gate.request();
    d.resolve();
    await Promise.all([a, b, c]);

    expect(stop).toHaveBeenCalledTimes(1);
    // Só o motivo de quem chegou primeiro vira log: os outros não aconteceram.
    expect(lines).toEqual(['primeiro']);
  });

  it('todos os pedidos esperam o MESMO encerramento (o `will-quit` não sai na frente)', async () => {
    const d = deferred();
    const gate = createShutdownGate(() => d.promise, () => {});

    let terminou = false;
    const espera = gate.request('before-quit').then(() => {
      terminou = true;
    });
    const segundo = gate.request();
    expect(terminou).toBe(false);

    d.resolve();
    await Promise.all([espera, segundo]);
    expect(terminou).toBe(true);
  });

  it('`claimed` diz se alguém já pediu o encerramento', () => {
    const gate = createShutdownGate(async () => {}, () => {});
    expect(gate.claimed).toBe(false);
    void gate.request();
    expect(gate.claimed).toBe(true);
  });

  it('encerramento que estoura vira linha de log, não rejeição solta', async () => {
    const lines: string[] = [];
    const gate = createShutdownGate(
      () => Promise.reject(new Error('core sumiu')),
      (line) => lines.push(line),
    );

    // Sem `catch` aqui de propósito: se o portão deixasse a rejeição passar,
    // o `.finally(() => app.quit())` do `will-quit` viraria unhandled rejection.
    await expect(gate.request()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('core sumiu'))).toBe(true);
  });

  /**
   * A forma do portão: o corpo é UM bloco, e o que estourar no meio dele leva
   * junto tudo o que vinha depois — inclusive o `stopCore()`. A fix wave de
   * 11/09/2026 aprendeu isso na marra (um `presentUnread` posto entre o
   * `takeWriter.close()` e o `stopCore()` batia num `Tray` já destruído, e o
   * core sobrevivia à saída do app). Este teste trava a regra: o portão NÃO
   * salva o resto do corpo — quem escreve o corpo é que não pode pôr nada
   * capaz de estourar antes do encerramento do core.
   */
  it('corpo que estoura no meio NÃO chega ao stopCore: o portão engole, não conserta', async () => {
    const passos: string[] = [];
    const stopCore = vi.fn(async () => {
      passos.push('stopCore');
    });
    // O `Tray` já destruído do `will-quit`: qualquer método dele lança.
    const tocaNaBandeja = (): void => {
      throw new Error('Object has been destroyed');
    };
    const lines: string[] = [];
    const gate = createShutdownGate(async () => {
      passos.push('fechaTake');
      tocaNaBandeja();
      await stopCore();
    }, (line) => lines.push(line));

    await expect(gate.request()).resolves.toBeUndefined();
    // O core FICOU DE PÉ: é exatamente o estrago que a linha removida causava.
    expect(stopCore).not.toHaveBeenCalled();
    expect(passos).toEqual(['fechaTake']);
    expect(lines.some((l) => l.includes('Object has been destroyed'))).toBe(true);
  });

  it('a linha do fim de sessão do Windows é a que o log do shell registra', () => {
    expect(SESSION_END_LOG).toBe('[shell] sessão do Windows encerrando: pedindo POST /api/shutdown');
  });
});
