import type { EventBus } from './events.js';
import { newId } from './ids.js';
import { MAX_CONSECUTIVE_BLOCKED_STOPS } from './model.js';
import type { AgentId, LastNotification, QuotaSnapshot, ResumeOutcome, ServerLimit, Session, SessionState } from './model.js';

/**
 * Quantos caminhos barrados a sessão guarda pro tooltip do selo 🛡 (dor
 * verificada #4). O contador conta todos; a lista é só a ponta recente.
 */
export const SCOPE_BLOCK_PATHS_MAX = 5;

export interface StateChange {
  state?: SessionState;
  detail?: string | null;
  tool?: string | null;
  /**
   * A prova do limite do servidor (dor verificada #1). `null` APAGA o campo —
   * `undefined` seria "não falei disso", e é essa diferença que deixa a saída
   * do estado limpar a frase sem apagá-la por descuido em toda mudança de
   * estado normal.
   */
  serverLimit?: ServerLimit | null;
  /** Subagentes vivos (12/09/2026) — ver `Session.subagents`. */
  subagents?: number;
  awaitingSubagents?: boolean;
}

export class Sessions {
  private byId = new Map<string, Session>();
  /**
   * O estado de cada sessão ANTES de ela entrar em `server-limited`. Fica aqui
   * (e não no `Session`) porque é bookkeeping do detector, não fato do
   * domínio: nem a UI nem a API têm o que fazer com ele.
   */
  private stateBeforeLimit = new Map<string, SessionState>();
  /**
   * Sessões cujo `--resume` JÁ foi julgado (dor verificada #3). Fica aqui, e
   * não no `Session`, porque "já julguei" não é fato do domínio: o fato é o
   * `resumeOutcome`, e ele pode legitimamente não existir. Ver `judgeResume`.
   */
  private resumeJudged = new Set<string>();
  /** Sessões cujo PTY já imprimiu algum byte. Ver `noteOutput`. */
  private sawOutput = new Set<string>();

  constructor(private bus: EventBus) {}

  create(input: {
    paneId: string;
    workspaceId: string;
    kind: 'shell' | 'agent';
    agent?: AgentId;
    cwd: string;
    pid?: number;
    /**
     * Dor verificada #3 — o id que esta sessão pediu pra retomar. Fica na
     * sessão (e não só no `LaunchCtx`) porque quem julga o desfecho é o hook,
     * que chega minutos depois e só tem o id do Bridge na mão.
     */
    resumeRequested?: string;
  }): Session {
    const now = Date.now();
    const session: Session = {
      id: newId('sess'),
      paneId: input.paneId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      agent: input.agent,
      resumeRequested: input.kind === 'agent' ? input.resumeRequested : undefined,
      state: 'idle',
      pid: input.pid,
      startedAt: now,
      stateSince: now,
      consecutiveBlockedStops: 0,
      cwd: input.cwd,
    };
    this.byId.set(session.id, session);
    this.bus.emit({ type: 'session.created', session });
    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  list(): Session[] {
    return [...this.byId.values()];
  }

  byPane(paneId: string): Session | undefined {
    for (const session of this.byId.values()) {
      if (session.paneId === paneId) return session;
    }
    return undefined;
  }

  apply(id: string, change: StateChange): Session | undefined {
    const session = this.byId.get(id);
    if (!session) return undefined;

    const nextState = change.state ?? session.state;
    const nextDetail = 'detail' in change ? (change.detail === null ? undefined : change.detail) : session.detail;
    const nextTool = 'tool' in change ? (change.tool === null ? undefined : change.tool) : session.tool;

    const nextServerLimit =
      'serverLimit' in change ? (change.serverLimit === null ? undefined : change.serverLimit) : session.serverLimit;

    const nextSubagents = change.subagents ?? session.subagents;
    const nextAwaiting = change.awaitingSubagents ?? session.awaitingSubagents;

    const stateChanged = nextState !== session.state;
    const changed =
      stateChanged ||
      nextDetail !== session.detail ||
      nextTool !== session.tool ||
      nextServerLimit !== session.serverLimit ||
      nextSubagents !== session.subagents ||
      nextAwaiting !== session.awaitingSubagents;
    if (!changed) return session;

    const updated: Session = {
      ...session,
      state: nextState,
      detail: nextDetail,
      tool: nextTool,
      serverLimit: nextServerLimit,
      subagents: nextSubagents,
      awaitingSubagents: nextAwaiting,
      stateSince: stateChanged ? Date.now() : session.stateSince,
    };
    this.byId.set(id, updated);
    this.bus.emit({
      type: 'session.state',
      id,
      state: updated.state,
      detail: updated.detail,
      tool: updated.tool,
      stateSince: updated.stateSince,
      serverLimit: updated.serverLimit,
    });
    return updated;
  }

  /**
   * Marca a sessão como estrangulada pelo SERVIDOR e guarda o estado anterior
   * pra devolvê-lo quando a detecção sair de cena.
   *
   * Devolve `false` (e não faz nada) quando a sessão já está `server-limited`:
   * a mesma frase pode voltar a aparecer no terminal, e reentrar no estado
   * empurraria o `since` pra frente — o "há 3 min" da sidebar viraria um
   * "agora" eterno.
   */
  markServerLimited(id: string, limit: ServerLimit, detail: string): boolean {
    const session = this.byId.get(id);
    if (!session || session.state === 'exited' || session.state === 'server-limited') return false;
    this.stateBeforeLimit.set(id, session.state);
    this.apply(id, { state: 'server-limited', detail, tool: null, serverLimit: limit });
    return true;
  }

  /**
   * Sai do estado, voltando ao que a sessão fazia antes.
   *
   * Voltar pro estado ANTERIOR (e não pra `idle`) é o que impede a saída do
   * limite de apagar um `needs-input` que já existia quando o servidor
   * estrangulou. O hook seguinte (`Stop`, `UserPromptSubmit`) sobrescreve isso
   * logo em seguida com a verdade do agente.
   */
  clearServerLimited(id: string): boolean {
    const session = this.byId.get(id);
    if (!session || session.state !== 'server-limited') {
      this.stateBeforeLimit.delete(id);
      return false;
    }
    const previous = this.stateBeforeLimit.get(id) ?? 'idle';
    this.stateBeforeLimit.delete(id);
    this.apply(id, { state: previous, detail: null, serverLimit: null });
    return true;
  }

  /** Quantas sessões estão estranguladas agora — o escalonador consulta. */
  serverLimitedCount(): number {
    let count = 0;
    for (const session of this.byId.values()) if (session.state === 'server-limited') count += 1;
    return count;
  }

  /**
   * Sessões de AGENTE vivas (tudo que não é `exited`) — o teto do escalonador
   * é medido aqui, e não num contador à parte que pode divergir do estado.
   */
  liveAgentCount(): number {
    let count = 0;
    for (const session of this.byId.values()) {
      // A hospedeira (spec §5) entra aqui: é um Claude Code de verdade
      // consumindo o mesmo servidor que os agentes do Bridge, e ignorá-la faria
      // o teto lançar N+1. Ela nunca passa pela FILA (não foi o Bridge que a
      // lançou), só pela conta.
      if ((session.kind === 'agent' || session.hosted !== undefined) && session.state !== 'exited') count += 1;
    }
    return count;
  }

  /**
   * Spec §5 — o primeiro hook de uma sessão de SHELL: ela passa a hospedar um
   * agente. Devolve a sessão ATUALIZADA só quando a marca é NOVA; quem chama (o
   * core) usa isso pra emitir UM `session.updated` por hospedagem, e não um por
   * hook — todo hook seguinte volta a passar por aqui.
   *
   * Idempotente de propósito: uma sessão já hospedada mantém o `since` da
   * promoção. Só o `clearHosted` abre caminho pra um `since` novo. Nada lê esse
   * campo hoje — ele está reservado pra um futuro "hospedando há N min" na
   * sidebar, que a 0.12.0 não desenha.
   */
  setHosted(id: string, agent: AgentId): Session | undefined {
    const session = this.byId.get(id);
    if (!session || session.hosted) return undefined;
    const updated: Session = { ...session, hosted: { agent, since: Date.now() } };
    this.byId.set(id, updated);
    return updated;
  }

  /**
   * Fim da hospedagem (`SessionEnd` com motivo de saída): a marca some e a
   * sessão volta ao repouso de um shell — `idle`, sem `detail` e sem `tool`,
   * que são o que o adaptador do agente escreveu ali.
   *
   * O que NÃO acontece aqui: a sessão não vira `exited` (o PTY do shell nunca
   * morreu — quem morreu foi o Claude que rodava dentro dele) e o
   * `agentSessionId` fica onde está (a conversa aconteceu; mostrá-la é da UI,
   * retomá-la é BACKLOG).
   *
   * `apply` é chamado DEPOIS da troca do mapa pra que o `session.state` que ele
   * emite já saia sem a marca. Devolve `undefined` quando não havia hospedagem
   * — quem chama não emite evento nenhum nesse caso.
   */
  clearHosted(id: string): Session | undefined {
    const session = this.byId.get(id);
    if (!session || !session.hosted) return undefined;
    const { hosted: _hosted, ...rest } = session;
    this.byId.set(id, rest);
    return this.apply(id, { state: 'idle', detail: null, tool: null }) ?? this.byId.get(id);
  }

  setPid(id: string, pid: number): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.set(id, { ...session, pid });
  }

  /**
   * Guarda o `session_id` que o AGENTE usa pra si (o do payload de hook), não
   * o id do Bridge. Devolve `true` só quando o valor mudou de fato: quem
   * chama (o core) usa isso pra emitir UM evento por sessão em vez de um por
   * hook — todo hook do Claude Code carrega o mesmo id.
   */
  setAgentSessionId(id: string, agentSessionId: string): boolean {
    const session = this.byId.get(id);
    // Sessão de shell HOSPEDANDO um Claude também tem conversa (spec §5); shell
    // pura continua sem — ali não há hook nenhum pra trazer id.
    if (!session || (session.kind !== 'agent' && !session.hosted)) return false;
    if (session.agentSessionId === agentSessionId) return false;
    this.byId.set(id, { ...session, agentSessionId });
    return true;
  }

  /**
   * Julga o `--resume` desta sessão UMA vez (dor verificada #3). Devolve a
   * sessão ATUALIZADA só quando saiu veredito novo — quem chama usa isso pra
   * emitir um `session.updated` por sessão, e não um por hook.
   *
   * O que fecha a janela é o PRIMEIRO `SessionStart`, não o primeiro veredito.
   * A diferença é a que a fix round 1 consertou: um `SessionStart` sem
   * `session_id` E sem `source` não vira veredito nenhum (ver
   * `resumeOutcomeOf`), e com a trava presa ao `resumeOutcome` a sessão ficava
   * com a janela ABERTA — o `SessionStart` seguinte, o de um `/clear` que o
   * próprio dono digitou (`source: 'clear'`), virava `'fresh'` e acendia
   * exatamente o alarme falso que a regra do "sem id e sem source" existe pra
   * evitar. Por isso a marca é um `Set` à parte: ela é gravada mesmo quando o
   * veredito é `undefined`.
   *
   * O veredito também nunca é reescrito: ele é sobre a SUBIDA da sessão.
   */
  judgeResume(id: string, outcome: ResumeOutcome | undefined): Session | undefined {
    const session = this.byId.get(id);
    if (!session || session.kind !== 'agent') return undefined;
    if (this.resumeJudged.has(id)) return undefined;
    this.resumeJudged.add(id);
    if (!outcome) return undefined;
    const updated: Session = { ...session, resumeOutcome: outcome };
    this.byId.set(id, updated);
    return updated;
  }

  /**
   * Dor verificada #3 — o primeiro byte que o terminal desta sessão imprimiu.
   *
   * É o mesmo sinal que o `writeInitialCommand` do core usa há tempos como
   * prova de que "o processo já está falando": escrever no PTY antes disso é
   * ter a linha engolida pela metade. Aqui ele existe pra segurar a injeção
   * AUTOMÁTICA do resumo (`sessions.autoRecap`), que dispararia no
   * `session.updated` do `SessionStart` — e o `SessionStart` pode chegar antes
   * de a TUI do agente estar aceitando texto.
   *
   * Chamada a CADA chunk de PTY: o `Set.has` é a primeira linha de propósito,
   * e só a primeira vez clona a sessão. Devolve a sessão atualizada apenas
   * nessa primeira vez, pra o core emitir um `session.updated` por sessão.
   */
  noteOutput(id: string): Session | undefined {
    if (this.sawOutput.has(id)) return undefined;
    const session = this.byId.get(id);
    if (!session) return undefined;
    this.sawOutput.add(id);
    const updated: Session = { ...session, sawOutput: true };
    this.byId.set(id, updated);
    return updated;
  }

  /**
   * Dor verificada #4 — registra que a guarda de escopo barrou um caminho.
   *
   * Devolve a sessão ATUALIZADA (o core emite `session.updated` com ela) ou
   * `undefined` quando a sessão não existe mais. Ao contrário do
   * `judgeResume`, aqui SEMPRE há novidade: cada recusa é um evento por
   * si, e o contador é justamente o que a UI mostra.
   *
   * O caminho repetido sobe pro topo em vez de duplicar: um agente que insiste
   * três vezes no mesmo arquivo encheria o tooltip com a mesma linha e
   * esconderia os outros quatro lugares que ele tentou.
   */
  noteScopeBlock(id: string, path: string): Session | undefined {
    const session = this.byId.get(id);
    if (!session) return undefined;
    const previous = session.scopeBlocks;
    const paths = [path, ...(previous?.paths ?? []).filter((p) => p !== path)].slice(0, SCOPE_BLOCK_PATHS_MAX);
    const updated: Session = { ...session, scopeBlocks: { count: (previous?.count ?? 0) + 1, paths } };
    this.byId.set(id, updated);
    return updated;
  }

  /**
   * 0.12.2 — apaga o contador de recusas das sessões vivas de UM workspace.
   *
   * Chamado quando o dono liga "Permitir acesso fora do worktree": a partir
   * dali a guarda não opina mais sobre este workspace, e um `🛡 2` pendurado
   * na linha descreveria uma cerca que não existe. Devolve só as sessões que
   * TINHAM contador (o core emite um `session.updated` por sessão devolvida) —
   * um workspace inteiro sem recusa nenhuma não gera evento nenhum.
   *
   * Restringir de novo não repõe o histórico: o contador recomeça do zero na
   * próxima recusa. É informação de tela, não registro de auditoria (o log do
   * core guarda cada recusa).
   */
  clearScopeBlocks(workspaceId: string): Session[] {
    const cleared: Session[] = [];
    for (const session of this.byId.values()) {
      if (session.workspaceId !== workspaceId || session.scopeBlocks === undefined) continue;
      const { scopeBlocks: _dropped, ...rest } = session;
      this.byId.set(session.id, rest);
      cleared.push(rest);
    }
    return cleared;
  }

  setQuota(id: string, q: QuotaSnapshot): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.set(id, { ...session, quota: q });
    this.bus.emit({ type: 'session.quota', id, quota: q });
  }

  noteNotification(id: string, n: LastNotification): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.set(id, { ...session, lastNotification: n });
  }

  focus(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    if (session.state === 'done') this.apply(id, { state: 'idle' });
  }

  exited(id: string, exitCode: number | null): void {
    const session = this.byId.get(id);
    if (!session) return;
    // O `serverLimit` sai JUNTO (fix round 1): o contrato do campo é "presente
    // só enquanto `state === 'server-limited'`", e uma sessão encerrada com a
    // prova pendurada deixava o selo laranja no `GET /api/state` de um painel
    // que já morreu. O bookkeeping do detector some pelo mesmo motivo.
    this.stateBeforeLimit.delete(id);
    this.byId.set(id, { ...session, state: 'exited', exitCode, serverLimit: undefined, stateSince: Date.now() });
    this.bus.emit({ type: 'session.exited', id, exitCode });
  }

  remove(id: string): void {
    if (!this.byId.has(id)) return;
    this.byId.delete(id);
    this.stateBeforeLimit.delete(id);
    this.resumeJudged.delete(id);
    this.sawOutput.delete(id);
    this.bus.emit({ type: 'session.removed', id });
  }

  blockedStop(id: string): boolean {
    const session = this.byId.get(id);
    if (!session) return false;
    const count = session.consecutiveBlockedStops + 1;
    if (count >= MAX_CONSECUTIVE_BLOCKED_STOPS) {
      this.byId.set(id, { ...session, consecutiveBlockedStops: 0 });
      return true;
    }
    this.byId.set(id, { ...session, consecutiveBlockedStops: count });
    return false;
  }

  resetBlockedStops(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.set(id, { ...session, consecutiveBlockedStops: 0 });
  }
}
