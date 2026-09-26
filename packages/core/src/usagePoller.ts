/**
 * Poller do monitor de uso (ADR-012) — o irmão do `gitPoller` do lado dos
 * transcripts.
 *
 * O que ele resolve: os números do painel "Uso" vêm de arquivos que o Claude
 * Code escreve o tempo todo. Reler tudo a cada pedido da UI seria varrer
 * centenas de MB por clique; reler sempre, mesmo sem ninguém olhando, seria
 * pior — o core vive em background enquanto o Electron está fechado.
 *
 * Por isso as mesmas três regras do poller de git, com uma a mais:
 *
 * - só roda enquanto `hasClients()` — cliente WS que RECEBE `usage.changed` e
 *   janela em foco há pouco;
 * - só emite `usage.changed` quando algum dia mudou de verdade;
 * - `refresh()` é imediato e ignora o `hasClients` — é o que a rota de rescan
 *   e o hook `Stop` usariam pra atualizar na hora;
 * - a PRIMEIRA varredura (a cara, que lê o histórico inteiro) roda uma vez na
 *   subida, em segundo plano e sem esperar por cliente nenhum: sem ela o
 *   painel abriria vazio na primeira vez que alguém o abrisse.
 */
import type { Core } from './core.js';
import type { Usage } from './usage/index.js';

/** Intervalo padrão entre passadas (a spec pede 60 s). */
export const USAGE_POLL_MS = 60_000;

/** Quantas voltas a varredura da subida dá antes de deixar o resto pro poller. */
export const INITIAL_SCAN_ROUNDS = 50;

export interface UsagePollerOptions {
  core: Core;
  usage: Usage;
  intervalMs?: number;
  hasClients: () => boolean;
}

export interface UsagePoller {
  /** Uma passada agora, mesmo sem cliente. Devolve os dias que mudaram. */
  refresh(): Promise<string[]>;
  /** Uma passada sujeita ao `hasClients` — o que o timer chama. */
  tick(): Promise<void>;
  /** A varredura completa da subida (em voo ou já concluída). */
  readonly initialScan: Promise<void>;
  stop(): void;
}

export function startUsagePoller({
  core,
  usage,
  intervalMs = USAGE_POLL_MS,
  hasClients,
}: UsagePollerOptions): UsagePoller {
  const { bus, log } = core.deps;
  const pollerLog = log.child('usage');
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  /**
   * Uma passada. O guarda de concorrência de verdade mora no `usage.scan()`
   * (uma varredura em voo devolve a própria promessa dela, em vez de começar
   * outra que somaria os mesmos deltas de novo); aqui em cima o `running` só
   * evita empilhar `await` à toa.
   */
  async function pass(): Promise<{ dailyTouched: string[]; more: boolean }> {
    running = true;
    try {
      const result = await usage.scan();
      if (result.dailyTouched.length > 0) {
        bus.emit({ type: 'usage.changed', dailyTouched: result.dailyTouched });
      }
      // `more` = algum transcript bateu no teto de bytes da passada. A próxima
      // passada continua de onde parou.
      return { dailyTouched: result.dailyTouched, more: result.more };
    } catch (err) {
      // Varredura é pano de fundo: disco de rede fora do ar não derruba o core.
      pollerLog.warn('varredura de transcripts falhou', { err });
      return { dailyTouched: [], more: false };
    } finally {
      running = false;
    }
  }

  async function tick(): Promise<void> {
    if (!hasClients()) return;
    if (running) return;
    await pass();
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        await tick();
        schedule();
      })();
    }, intervalMs);
    // O timer nunca segura o processo vivo — o core sai quando o resto sai.
    timer.unref?.();
  }

  /**
   * A varredura da subida vai até o fim: `scan` corta cada arquivo num teto de
   * bytes por passada, então um histórico grande precisa de várias voltas.
   *
   * O teto de voltas existe pra que um transcript que cresce mais rápido do
   * que a leitura não prenda a subida num laço. Estourar o teto NÃO é desistir
   * da contagem: o offset de cada arquivo está gravado, o poller de 60 s
   * continua exatamente de onde esta parou, e o aviso no log diz isso — a
   * primeira versão saía calada, e um histórico enorme parecia ter sido lido
   * inteiro quando não tinha.
   */
  const initialScan = (async () => {
    const before = Date.now();
    for (let round = 0; round < INITIAL_SCAN_ROUNDS && !stopped; round++) {
      const result = await pass();
      if (!result.more) {
        pollerLog.info('varredura inicial de transcripts concluída', { ms: Date.now() - before });
        return;
      }
    }
    if (!stopped) {
      pollerLog.warn(
        // i18n-ignore: linha de log em duas partes — ver `usage/index.ts`.
        `varredura inicial parou no teto de ${INITIAL_SCAN_ROUNDS} voltas com transcript ainda por ler; ` +
          'o poller continua de onde ela parou na próxima passada', // i18n-ignore
        { ms: Date.now() - before, intervaloMs: intervalMs },
      );
    }
  })().catch((err: unknown) => {
    pollerLog.warn('varredura inicial de transcripts falhou', { err });
  });

  schedule();

  return {
    refresh: async () => (await pass()).dailyTouched,
    tick,
    initialScan,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
