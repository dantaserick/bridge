import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn as ptySpawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { LaunchSpec } from './adapters/types.js';
import type { EventBus } from './events.js';
import { OscScanner } from './osc.js';
import type { OscNotification } from './osc.js';
import type { Sessions } from './sessions.js';

export const SCROLLBACK_BYTES = 512 * 1024;

const KILL_TIMEOUT_MS = 3000;

/**
 * node-pty não consegue rodar um `.cmd`/`.bat` diretamente no Windows — precisa
 * do cmd.exe pra interpretar. Isola essa decisão pra poder testar sem spawnar nada.
 */
export function resolveSpawn(spec: LaunchSpec): { file: string; args: string[] } {
  const lower = spec.bin.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { file: 'cmd.exe', args: ['/c', spec.bin, ...spec.args] };
  }
  return { file: spec.bin, args: spec.args };
}

/**
 * Buffer de scrollback como fila de chunks. Concatenar string a cada `onData`
 * era O(n) por chunk (e o corte por bytes partia caracteres multibyte no meio);
 * aqui cada chunk entra inteiro, o custo por chunk é O(1) amortizado e o
 * descarte é por chunk inteiro — nunca no meio de um code point UTF-8.
 */
export class Scrollback {
  private chunks: string[] = [];
  private byteCount = 0;

  constructor(readonly cap: number = SCROLLBACK_BYTES) {}

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.byteCount += Buffer.byteLength(data, 'utf8');
    // Guarda o último chunk mesmo que sozinho passe do teto: melhor estourar
    // um pouco que devolver scrollback vazio pro terminal que acabou de abrir.
    while (this.byteCount > this.cap && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.byteCount -= Buffer.byteLength(removed, 'utf8');
    }
  }

  get bytes(): number {
    return this.byteCount;
  }

  text(): string {
    return this.chunks.join('');
  }
}

interface PtyEntry {
  child: IPty;
  scanner: OscScanner;
  scrollback: Scrollback;
}

export class PtyHost {
  private ptys = new Map<string, PtyEntry>();

  /**
   * Scrollback das sessões cujo PTY já morreu. R1 mantém o painel aberto pro
   * user ler a saída — então `GET /api/sessions/:id/scrollback` tem que
   * continuar respondendo depois do `exited`, senão a UI redesenha em cima de
   * nada na primeira reconexão do WS. Some junto com a sessão.
   */
  private exitedScrollback = new Map<string, Scrollback>();

  /**
   * PTYs que o `kill()` desistiu de esperar (prazo estourado) mas que ainda
   * podem cuspir o `exit` depois. Eles já saíram de `ptys` — `alive()` tem que
   * dizer a verdade na hora — mas o `onExit` deles continua valendo: é ele
   * quem marca a sessão como `exited` e emite `pty.exit` quando o processo
   * finalmente morre. Um respawn no mesmo id limpa a entrada, e aí o exit
   * atrasado do PTY velho é ignorado (senão mataria a sessão nova).
   */
  private detached = new Map<string, PtyEntry>();

  /** Configurável pelo core — o próprio PtyHost não sabe nada de Notifications. */
  onOsc: (sessionId: string, n: OscNotification) => void = () => {};

  constructor(
    private bus: EventBus,
    private sessions: Sessions,
  ) {
    // `sessions.remove` é o fim da vida da sessão (DELETE, substituição de
    // painel, `stop()`): aí sim a saída pode ser esquecida.
    this.bus.on((e) => {
      if (e.type !== 'session.removed') return;
      this.exitedScrollback.delete(e.id);
      // Sessão apagada: o PTY largado por timeout de kill (se ainda existir)
      // não tem mais nada pra marcar quando sair — solta a referência.
      this.detached.delete(e.id);
    });
  }

  spawn(sessionId: string, spec: LaunchSpec, opts: { cwd: string; cols: number; rows: number }): { pid: number } {
    // Painel reaproveitado por uma sessão nova não herda a saída da anterior.
    this.exitedScrollback.delete(sessionId);
    // Sessão nova no mesmo id: o PTY velho que ficou pendurado no `kill()`
    // perde o direito de mexer nela quando (e se) finalmente sair.
    this.detached.delete(sessionId);
    for (const f of spec.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }

    const { file, args } = resolveSpawn(spec);
    const child = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: spec.env,
      useConpty: true,
    });

    const entry: PtyEntry = { child, scanner: new OscScanner(), scrollback: new Scrollback() };
    this.ptys.set(sessionId, entry);

    child.onData((data) => {
      entry.scrollback.push(data);
      this.bus.emit({ type: 'pty.data', sessionId, data });
      const notifications = entry.scanner.push(data);
      for (const n of notifications) this.onOsc(sessionId, n);
    });

    child.onExit(({ exitCode }) => {
      const live = this.ptys.get(sessionId);
      const detached = this.detached.get(sessionId);
      // Só o PTY que ainda É desta sessão (vivo ou largado pelo kill) fecha o
      // ciclo dela; um respawn já assumiu o id e o exit velho não vale nada.
      if (live?.child !== child && detached?.child !== child) return;
      if (live?.child === child) this.ptys.delete(sessionId);
      this.detached.delete(sessionId);
      this.exitedScrollback.set(sessionId, entry.scrollback);
      this.sessions.exited(sessionId, exitCode ?? null);
      this.bus.emit({ type: 'pty.exit', sessionId, exitCode: exitCode ?? null });
    });

    return { pid: child.pid };
  }

  write(sessionId: string, data: string): void {
    const entry = this.ptys.get(sessionId);
    if (!entry) return;
    entry.child.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(sessionId);
    if (!entry) return;
    entry.child.resize(cols, rows);
  }

  scrollback(sessionId: string): string {
    const live = this.ptys.get(sessionId);
    if (live) return live.scrollback.text();
    return this.exitedScrollback.get(sessionId)?.text() ?? '';
  }

  alive(sessionId: string): boolean {
    return this.ptys.has(sessionId);
  }

  /**
   * Mata o PTY e espera o `exit`, desistindo em `timeoutMs` (3 s).
   *
   * Estourado o prazo, a entrada SAI de `ptys` e o scrollback dela vai pro
   * `exitedScrollback`: senão `alive()` continuaria dizendo que a sessão está
   * de pé pra sempre — e quem chamou o kill já seguiu a vida (o core apaga a
   * sessão logo em seguida). O `onExit` do PTY largado continua armado via
   * `detached`, então um exit atrasado ainda marca a sessão e emite `pty.exit`.
   *
   * `timeoutMs` é parametrizável só pra testar esse caminho sem esperar 3 s.
   */
  kill(sessionId: string, timeoutMs = KILL_TIMEOUT_MS): Promise<void> {
    const entry = this.ptys.get(sessionId);
    if (!entry) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const giveUp = () => {
        // Só desiste do PTY que ainda é o desta sessão (um respawn no meio do
        // caminho já teria trocado a entrada).
        if (this.ptys.get(sessionId) === entry) {
          this.ptys.delete(sessionId);
          this.detached.set(sessionId, entry);
          this.exitedScrollback.set(sessionId, entry.scrollback);
        }
        finish();
      };
      const timer = setTimeout(giveUp, timeoutMs);
      entry.child.onExit(() => {
        clearTimeout(timer);
        finish();
      });
      try {
        entry.child.kill();
      } catch {
        // kill em processo já morto/inexistente — ignora, resolve pelo timeout/onExit.
      }
    });
  }
}
