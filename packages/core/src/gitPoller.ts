/**
 * Poller de status git dos workspaces de worktree (spec §6/§7).
 *
 * O que ele resolve: a sidebar mostra `+N ~M` por tarefa, e esses números só
 * existem rodando `git` de verdade. Rodar a cada render seria um processo por
 * segundo por tarefa; rodar sempre, mesmo sem janela aberta, seria pior — o
 * core vive em background enquanto o Electron está fechado.
 *
 * Por isso três regras:
 * - só roda enquanto `hasClients()` — R5: um cliente WS que RECEBE
 *   `workspace.git` e uma janela que disse estar em foco há pouco. Sem os
 *   dois, nenhum `git` é lançado;
 * - só EMITE quando `ahead`/`dirty`/`branch`/`error` mudaram (o `at` muda
 *   sempre, e emitir por causa dele faria a UI redesenhar a cada intervalo à
 *   toa);
 * - `refresh(id)` é imediato e ignora o `hasClients` — é o que o hook `Stop`
 *   chama pra atualizar o indicador no instante em que o agente termina.
 */
import { existsSync } from 'node:fs';
import { status } from './git.js';
import type { Core } from './core.js';
import type { GitStatus } from './model.js';

export interface GitPollerOptions {
  core: Core;
  /** Normalmente `profile.config.gitPollSeconds * 1000`. */
  intervalMs: number;
  hasClients: () => boolean;
  /**
   * Leitura de status. Existe pro teste dirigir a corrida do R6 (encadear um
   * `refresh` que chega no meio de uma leitura) sem depender do tempo de um
   * `git` de verdade. Em produção é sempre o `status` do `git.ts`.
   */
  readStatus?: (worktreePath: string, base: string, opts?: { trustFilters?: boolean }) => Promise<GitStatus>;
}

export interface GitPoller {
  /** Recalcula um workspace agora (hook `Stop`, rota de refresh). */
  refresh(workspaceId: string): Promise<GitStatus | undefined>;
  /** Uma passada por todos os workspaces de worktree. Exposto pro teste dirigir a mão. */
  tick(): Promise<void>;
  /**
   * Troca o intervalo em voo (`PATCH /api/config` com `gitPollSeconds`). O
   * timer pendente é cancelado e reagendado com o valor novo — sem isto, a
   * mudança só valeria no próximo tick, o que num intervalo de 120 s significa
   * até dois minutos de espera pra ver o efeito de uma configuração.
   */
  setIntervalMs(ms: number): void;
  /** O intervalo em uso agora — pro teste e pra quem quiser conferir sem reler o perfil. */
  readonly intervalMs: number;
  stop(): void;
}

/** Só `ahead`/`dirty`/`branch`/`error` contam como mudança — `at` muda em toda leitura. */
export function changed(previous: GitStatus | undefined, next: GitStatus): boolean {
  if (!previous) return true;
  return (
    previous.ahead !== next.ahead ||
    previous.dirty !== next.dirty ||
    previous.branch !== next.branch ||
    previous.error !== next.error
  );
}

export function startGitPoller({ core, intervalMs, hasClients, readStatus = status }: GitPollerOptions): GitPoller {
  const { db, bus, log, layout } = core.deps;
  const cache = core.deps.gitStatus;
  const pollerLog = log.child('git');
  /** Leitura em curso por workspace, com o instante em que ela COMEÇOU (R6). */
  const inFlight = new Map<string, { startedAt: number; promise: Promise<GitStatus | undefined> }>();
  /** Segunda leitura já encadeada por workspace (R6) — no máximo uma. */
  const chained = new Map<string, Promise<GitStatus | undefined>>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  /** Mutável: `setIntervalMs` troca o valor e reagenda (`PATCH /api/config`). */
  let currentIntervalMs = intervalMs;

  /**
   * Relógio estritamente crescente. `Date.now()` no Windows anda de 1 em 15 ms:
   * um `refresh` que chega logo depois do começo de uma leitura teria o MESMO
   * carimbo dela e passaria por "chegou antes", que é justamente o caso que o
   * R6 existe pra pegar.
   */
  let clock = 0;
  function stamp(): number {
    const now = Date.now();
    clock = now > clock ? now : clock + 1;
    return clock;
  }

  async function read(workspaceId: string): Promise<GitStatus | undefined> {
    const workspace = db.workspaces.get(workspaceId);
    if (!workspace?.worktree) return undefined;
    const { base, path } = workspace.worktree;

    // Pasta apagada por fora (`git worktree remove` no terminal, unidade
    // desconectada): os números não existem, e insistir num `git` que vai
    // falhar a cada 15 s só enche o log. A UI mostra "(pasta sumiu)".
    // BR-03: a confianca nos filtros e do REPOSITORIO. Sem ela, `status` nao
    // roda comando que toque conteudo e devolve `error: 'filters-untrusted'`
    // — o poller continua rodando (o branch sai do HEAD, que e barato).
    const trustFilters = workspace.repoId ? db.repos.get(workspace.repoId)?.trustFilters === true : false;
    const next: GitStatus = existsSync(path)
      ? await readStatus(path, base, { trustFilters })
      : { branch: workspace.branch ?? 'HEAD', base, ahead: 0, dirty: 0, at: Date.now(), error: 'missing' };

    const previous = cache.get(workspaceId);
    cache.set(workspaceId, next);

    // R4 — o branch do DISCO é a verdade. O usuário troca de branch dentro do
    // worktree pelo terminal, e o valor gravado na criação vira mentira: é
    // esse campo que a sidebar mostra e que merge/remoção usariam.
    if (next.error === undefined && next.branch !== 'HEAD' && workspace.branch !== next.branch) {
      layout.setWorkspaceGit(workspaceId, {
        repoId: workspace.repoId,
        branch: next.branch,
        worktree: workspace.worktree,
      });
    }

    if (changed(previous, next)) bus.emit({ type: 'workspace.git', workspaceId, git: next });
    return next;
  }

  function start(workspaceId: string): Promise<GitStatus | undefined> {
    const startedAt = stamp();
    const promise = (async () => {
      try {
        return await read(workspaceId);
      } finally {
        inFlight.delete(workspaceId);
      }
    })();
    inFlight.set(workspaceId, { startedAt, promise });
    return promise;
  }

  /**
   * Uma leitura por workspace de cada vez. `refresh` (hook `Stop`, rota) e o
   * `tick` do timer chegam do nada um em cima do outro: sem isto, dois
   * `status()` do MESMO worktree correm em paralelo, o mais lento grava por
   * último e a sidebar pode acabar com o número antigo — e ainda dá pra emitir
   * `workspace.git` duas vezes pela mesma mudança.
   *
   * `chain: false` (o `tick`) só espera a leitura em curso: o timer não tem
   * pressa nenhuma. `chain: true` (o `refresh`) ENCADEIA uma segunda leitura
   * quando o pedido é mais novo que a leitura em voo (R6) — o hook `Stop`
   * chega depois do commit do agente, e devolver o resultado de uma leitura
   * que começou ANTES dele mostraria na sidebar o estado de antes do commit.
   * No máximo uma leitura encadeada por workspace: dez `Stop` seguidos viram
   * uma releitura, não dez.
   */
  function compute(workspaceId: string, chain: boolean): Promise<GitStatus | undefined> {
    const current = inFlight.get(workspaceId);
    if (!current) return start(workspaceId);
    if (!chain) return current.promise;

    const requestedAt = stamp();
    if (requestedAt <= current.startedAt) return current.promise;

    const pending = chained.get(workspaceId);
    if (pending) return pending;

    const next = current.promise
      .catch(() => undefined)
      .then(() => {
        chained.delete(workspaceId);
        return start(workspaceId);
      });
    chained.set(workspaceId, next);
    return next;
  }

  async function refresh(workspaceId: string): Promise<GitStatus | undefined> {
    return compute(workspaceId, true);
  }

  async function tick(): Promise<void> {
    // Sem cliente conectado não roda `git` nenhum — nem pra encher o cache.
    if (!hasClients()) return;
    const todos = db.workspaces.list();
    /*
     * Fix round 5: passada LEVE de filtros em TODO workspace — inclusive os de
     * raiz, que não têm status pra calcular. Sem isto, um repo aberto só na
     * raiz nunca era remedido depois da adoção, e um filtro adicionado ao
     * `.git/config` depois disso não acendia o aviso. Não roda `status`: só o
     * `git config` da detecção, que ainda por cima é cacheado por 10 s.
     */
    // Task 3: `refreshAllRepoFilters` em vez de um `void` por repo — é a MESMA
    // lista, mas com o pool de 4 do `start()` em vez de N `git config` de uma
    // vez (um monorepo com dezenas de workspaces abria um processo por repo a
    // cada tick). O `catch` é obrigatório: sem `await`, uma rejeição aqui
    // viraria `unhandledRejection` e derrubaria o processo do core.
    void core.refreshAllRepoFilters().catch(() => undefined);

    const workspaces = todos.filter((w) => w.worktree);
    const ids = new Set(workspaces.map((w) => w.id));
    // Workspace fechado/removido não pode ficar no snapshot pra sempre.
    for (const id of [...cache.keys()]) if (!ids.has(id)) cache.delete(id);

    for (const workspace of workspaces) {
      try {
        await compute(workspace.id, false);
      } catch (err) {
        // Worktree apagado por fora, disco de rede fora do ar: o poller é
        // pano de fundo, não pode derrubar o core nem parar nos outros.
        pollerLog.warn('falhou ao ler o status do worktree', { workspaceId: workspace.id, err });
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        // Um `git` lento (disco de rede) não pode empilhar ticks em cima dele.
        if (!running) {
          running = true;
          try {
            await tick();
          } finally {
            running = false;
          }
        }
        schedule();
      })();
    }, currentIntervalMs);
    // Timer do poller nunca segura o processo vivo: o core sai quando o resto sai.
    timer.unref?.();
  }

  schedule();

  return {
    refresh,
    tick,
    get intervalMs(): number {
      return currentIntervalMs;
    },
    setIntervalMs(ms: number): void {
      const next = Math.max(1, Math.floor(ms));
      if (next === currentIntervalMs) return;
      currentIntervalMs = next;
      // Reagenda do zero: o timer em voo ainda carrega o intervalo antigo.
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
