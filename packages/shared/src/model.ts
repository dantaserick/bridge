/**
 * Tipos do domínio do Bridge. Fonte única: core, ui e shell importam daqui —
 * nada de cópia manual (era o `packages/ui/src/types.ts` da Fase 1).
 */

import type { SessionEnvironment } from './environment.js';
import type { Language, LanguageSetting } from './i18n/index.js';

/**
 * `server-limited` (dor verificada #1) é o limite do SERVIDOR, não o seu:
 * o Claude Code imprime "Server is temporarily limiting requests (not your
 * usage limit)" — ou um 529 `overloaded_error` — quando a infraestrutura da
 * Anthropic está estrangulando as chamadas. Ele não escala com o plano e bate
 * justamente em quem roda várias sessões lado a lado, que é o caso de uso do
 * Bridge. Ficar junto de `running` esconderia o motivo da sessão ter parado de
 * andar; virar `stuck` culparia o agente por uma coisa que é do outro lado.
 */
export type SessionState = 'idle' | 'running' | 'needs-input' | 'done' | 'stuck' | 'exited' | 'server-limited';
export type AgentId = 'claude' | 'codex' | 'gemini';
export type NotificationKind = 'needs-input' | 'done' | 'stuck' | 'custom';

export interface Repo {
  id: string;
  path: string;
  name: string;
  /**
   * O dono declarou que confia nos drivers de `filter.*` deste repositório
   * (BR-03). Enquanto for `false` e o repo declarar algum driver, o Bridge não
   * roda comando de git que toque CONTEUDO nele — o `clean`/`smudge` do repo
   * seria executado a cada passada do poller, sem clique nenhum.
   *
   * Default `false`: repositório recem-adotado nao ganha confianca por
   * omissao. Repo sem driver nenhum nao e afetado por este campo.
   */
  trustFilters: boolean;
  /**
   * O repositório declara algum driver de `filter.*` AGORA (fix round 4).
   *
   * Não é persistido: o core mede na adoção do workspace e a cada passada do
   * poller, e emite `layout.changed` quando vira. É o que faz o item de menu
   * "Confiar nos filtros…" aparecer num workspace de RAIZ — antes só o
   * `GitStatus.error` denunciava, e o poller só calcula status de worktree,
   * então a pessoa não tinha por onde confiar antes de criar a primeira tarefa.
   *
   * Opcional no TIPO: um `Repo` montado à mão (teste, snapshot antigo) não
   * precisa inventar a resposta.
   */
  hasFilterDrivers?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  repoId?: string;
  branch?: string;
  worktree?: {
    base: string;
    path: string;
    /**
     * O `base` não foi escolhido por ninguém: o worktree foi ADOTADO (a pasta
     * já existia quando o Bridge abriu o workspace) e nem ele tinha upstream,
     * então o base é o palpite "branch corrente do worktree principal". A UI
     * marca "(base deduzida)" no tooltip e no confirm de merge/remoção, e o
     * menu oferece "Definir base…" pra trocar por um ref de verdade.
     */
    baseGuessed?: boolean;
  };
  /**
   * Onde as sessões deste workspace sobem (dor verificada #2). Ausente = o
   * `shell` da configuração global, que é o comportamento de sempre. Com
   * `{ kind: 'wsl', distro }` o shell E o agente sobem dentro da distro.
   */
  environment?: SessionEnvironment;
  /**
   * Dor verificada #4 — o dono liberou ESTE workspace da guarda de escopo.
   *
   * Com `true`, as sessões daqui voltam a poder ler e escrever em qualquer
   * lugar do disco: é o caso legítimo de quem trabalha numa tarefa e precisa
   * abrir um arquivo do worktree irmão (comparar duas implementações, copiar
   * um fixture). Ausente/`false` = a guarda vale, e o `PreToolUse` de um
   * caminho de fora volta com `permissionDecision: 'deny'`.
   *
   * Opcional no TIPO (e não `boolean` obrigatório) pelo mesmo motivo do
   * `worktree` e do `environment`: um `Workspace` montado à mão — o snapshot
   * de um perfil de versão anterior, uma fixture de teste — não precisa
   * inventar a resposta, e a ausência já quer dizer "restrito", que é o
   * default seguro.
   */
  crossAccess?: boolean;
  createdAt: number;
}

export interface Tab {
  id: string;
  workspaceId: string;
  title: string;
  kind: 'terminal';
  order: number;
}

export type LayoutNode =
  | { type: 'split'; dir: 'v' | 'h'; ratio: number; a: LayoutNode; b: LayoutNode }
  | { type: 'leaf'; paneId: string };

export interface Pane {
  id: string;
  tabId: string;
  cwd: string;
  /**
   * O que rodou por último neste painel. O layout volta ao reabrir mas a
   * sessão não (spec §10): o painel que era agente reabre como shell e usa
   * isto pra oferecer "a sessão anterior era Claude Code".
   */
  lastKind?: 'shell' | 'agent';
  lastAgent?: AgentId;
  /**
   * Id da sessão do AGENTE (o `session_id` que todo hook do Claude Code
   * carrega), não o id da sessão do Bridge. É ele que vira `claude --resume
   * <id>` quando o painel volta na próxima subida — sem ele o Bridge só
   * saberia QUE rodava um Claude aqui, não QUAL conversa era.
   */
  lastAgentSessionId?: string;
  /**
   * Quem encerrou a última sessão deste painel. `'app'` nasce junto com o
   * agente (0.12.1) e fica enquanto ninguém provar o contrário: fechar o
   * Bridge, core morto pelo Windows e — desde 13/09/2026 — processo do agente
   * que morreu sozinho (crash, auto-update) continuam `'app'`. `'user'` só vem
   * de intenção declarada: `SessionEnd` com motivo de saída (`/exit`, logout)
   * ou encerramento pelo próprio Bridge (✕, fechar aba/workspace).
   *
   * A restauração só retoma o agente no caso `'app'`: quem digitou `/exit`
   * encerrou a conversa de propósito e não quer ela de volta ao reabrir.
   */
  lastEndedBy?: 'user' | 'app';
}

export interface RateLimitWindow {
  window: string;
  usedPct: number;
  resetsAt?: number;
  pacingPct?: number;
}

export interface QuotaSnapshot {
  model: string;
  contextTokens: number;
  contextPct?: number;
  costUsd?: number;
  rateLimits: RateLimitWindow[];
  line: string;
  at: number;
  /**
   * Quantas janelas do payload foram DESCARTADAS por passarem do teto de 16 ou
   * por terem nome vazio depois da limpeza (BU-06). Ausente no caso normal; o
   * monitor de uso avisa uma vez quando aparece.
   */
  windowsDropped?: number;
}

export interface LastNotification {
  kind: NotificationKind;
  text: string;
  at: number;
}

/**
 * Por que o Bridge acha que esta sessão está no limite do SERVIDOR.
 *
 * `phrase` é o trecho da saída do PTY que casou, já limpo de ANSI e passado
 * por `sanitizeDisplay` — é ele que vai no tooltip, porque "o Bridge decidiu"
 * sem mostrar a frase seria um veredito sem prova. `pattern` é o id do padrão
 * que casou (não a frase), que é o que teste e log comparam sem depender da
 * redação exata do Claude Code.
 */
export interface ServerLimit {
  /** Quando o primeiro casamento aconteceu (epoch ms). */
  since: number;
  /** Trecho sanitizado da saída que disparou a detecção. */
  phrase: string;
  /** Id do padrão: ver `SERVER_LIMIT_PATTERNS` no core. */
  pattern: string;
}

/**
 * Como terminou o `claude --resume <id>` desta sessão (dor verificada #3).
 *
 * - `'ok'` — o `SessionStart` voltou com o MESMO `session_id` que foi pedido
 *   (ou, na falta dele, com `source: 'resume'`): a conversa é a de antes;
 * - `'fresh'` — o agente abriu uma conversa NOVA. Ou o `session_id` do payload
 *   é outro, ou o `source` do payload diz `startup`/`clear`/`compact`. É a dor
 *   verificada: o `--resume` "funciona" (o processo sobe, ninguém erra) e o
 *   contexto acumulado simplesmente não está lá.
 *
 * Ausente quer dizer duas coisas diferentes, e as duas são "não há veredito":
 * a sessão não pediu resume nenhum, ou o `SessionStart` ainda não chegou.
 */
export type ResumeOutcome = 'ok' | 'fresh';

/**
 * Quantas vezes a guarda de escopo barrou esta sessão, e onde (dor verificada
 * #4).
 *
 * Existe pra que a recusa não seja invisível: o `deny` é respondido pro agente,
 * que segue em frente sozinho — sem o selo 🛡 na linha da sessão o dono só
 * descobriria a guarda pelo comportamento estranho do Claude. O contador conta
 * TODAS as recusas; `paths` guarda só as cinco últimas, do mais recente pro
 * mais antigo, porque um agente teimoso repete a mesma tentativa em rajada e a
 * lista inteira não caberia num tooltip.
 */
export interface ScopeBlocks {
  count: number;
  /** Os caminhos barrados mais recentes (no máximo 5), já sanitizados. */
  paths: string[];
}

/**
 * Um agente aberto DENTRO de uma sessão de shell (spec §5, 0.12.0).
 *
 * A pessoa digitou `claude` num painel de shell do Bridge; o wrapper da sessão
 * fez esse Claude subir com os hooks do Bridge, e o PRIMEIRO hook que chega
 * promove a sessão a hospedeira. Dali em diante os hooks passam pelo adaptador
 * como numa sessão de agente — anel de estado, notificações, statusline,
 * `agentSessionId`, limite do servidor e guarda de escopo.
 *
 * `since` é o instante da promoção, e não muda enquanto a hospedagem durar: o
 * hook seguinte não regrava a marca. O `SessionEnd` com motivo de saída a
 * apaga, e o shell (que nunca morreu) volta a ser só um shell.
 */
export interface HostedAgent {
  agent: AgentId;
  /**
   * Quando o primeiro hook chegou (epoch ms). Ninguém consome hoje: está
   * reservado pra um futuro "hospedando há N min" na linha da sidebar — a UI da
   * 0.12.0 não desenha tempo nenhum.
   */
  since: number;
}

export interface Session {
  id: string;
  paneId: string;
  workspaceId: string;
  kind: 'shell' | 'agent';
  agent?: AgentId;
  /**
   * Presente enquanto esta sessão de SHELL hospeda um agente (ver
   * `HostedAgent`). `kind` NÃO muda junto: a sessão nasceu shell, é shell na
   * restauração e volta a mostrar "shell" quando a hospedagem acaba — o que
   * muda é o que a linha da sidebar desenha enquanto o Claude está aberto lá
   * dentro. Nunca aparece em sessão de agente.
   */
  hosted?: HostedAgent;
  /**
   * Subagentes VIVOS desta sessão (12/09/2026), contados pelos hooks
   * `SubagentStart`/`SubagentStop`. Só memória: é fato sobre o processo. É o
   * que impede a sidebar de dizer "terminou" quando a conversa principal só
   * está esperando um subagente — o `Stop` dela com `subagents > 0` vira
   * `running` ("esperando N subagentes") e `awaitingSubagents` lembra que o
   * `done` de verdade ficou pra quando o último terminar.
   */
  subagents?: number;
  awaitingSubagents?: boolean;
  /**
   * O id de conversa que ESTA sessão pediu pra retomar (`claude --resume
   * <id>`). Só existe em sessão de agente criada com `resume`, e é ele que o
   * primeiro `SessionStart` contradiz ou confirma.
   */
  resumeRequested?: string;
  /** O veredito do `resumeRequested`. Ver `ResumeOutcome`. */
  resumeOutcome?: ResumeOutcome;
  /**
   * `true` depois do PRIMEIRO byte que o PTY desta sessão imprimiu — a prova
   * de que o processo já está falando, o mesmo sinal que o core usa pra soltar
   * o comando inicial de um painel.
   *
   * Quem lê é a injeção AUTOMÁTICA do resumo (`sessions.autoRecap`, dor
   * verificada #3): ela é disparada pelo `session.updated` do `SessionStart`,
   * que pode chegar antes de a TUI do agente aceitar texto — e aí o resumo
   * inteiro seria engolido. O BOTÃO "Reabrir com contexto" não olha este
   * campo: quem clicou está vendo a tela.
   */
  sawOutput?: boolean;
  /**
   * O `session_id` que o agente usa pra si mesmo (vem em todo hook do Claude
   * Code). Só aparece depois do primeiro hook: entre o spawn e o `SessionStart`
   * a sessão existe pro Bridge mas ainda não tem id do lado do agente.
   */
  agentSessionId?: string;
  state: SessionState;
  detail?: string;
  tool?: string;
  /**
   * Presente enquanto `state === 'server-limited'` (e só então): a prova da
   * detecção. Sai junto com o estado — no primeiro turno normal seguinte
   * (`Stop`/`UserPromptSubmit`) ou no prazo de `SERVER_LIMIT_TTL_MS`.
   */
  serverLimit?: ServerLimit;
  /**
   * Dor verificada #4 — o que a guarda de escopo barrou nesta sessão. Ausente
   * enquanto nada foi barrado (o caso normal); nunca volta a ficar ausente
   * depois do primeiro bloqueio, porque o contador é da SESSÃO inteira.
   */
  scopeBlocks?: ScopeBlocks;
  lastNotification?: LastNotification;
  quota?: QuotaSnapshot;
  pid?: number;
  exitCode?: number | null;
  startedAt: number;
  stateSince: number;
  consecutiveBlockedStops: number;
  cwd: string;
}

export interface Notification {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: NotificationKind;
  text: string;
  at: number;
  readAt?: number;
}

/**
 * Estado agregado de um workspace = o pior estado das sessões dele.
 *
 * `server-limited` entra ACIMA de `done` e ABAIXO de `needs-input`: uma sessão
 * estrangulada pelo servidor parou de andar e a pessoa pode querer agir
 * (esperar, reduzir a concorrência), o que vence "já terminou"; mas ela não
 * está esperando NINGUÉM digitar, então não pode encobrir um `needs-input` de
 * outra sessão do mesmo workspace.
 */
export const STATE_SEVERITY: Record<SessionState, number> = {
  stuck: 6,
  'needs-input': 5,
  'server-limited': 4,
  done: 3,
  running: 2,
  idle: 1,
  exited: 0,
};

export const MAX_CONSECUTIVE_BLOCKED_STOPS = 5;

/** Tudo que o layout persiste: o que volta quando o Bridge reabre (spec §10). */
export interface LayoutSnapshot {
  repos: Repo[];
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  layouts: Record<string, LayoutNode>;
}

/**
 * `+N ~M` da sidebar (spec §6/§7) pra um workspace de worktree. Calculado
 * pelo poller do core e mandado pelo evento `workspace.git`.
 *
 * A MESMA forma que `packages/core/src/git.ts` devolve — está aqui porque a
 * UI também precisa do tipo, e o core não é dependência dela.
 */
export interface GitStatus {
  branch: string;
  /** Branch base da tarefa (o branch do worktree principal). */
  base?: string;
  /** `git rev-list --count <base>..HEAD` — commits que a tarefa tem a mais. */
  ahead: number;
  /** Linhas de `git status --porcelain` — arquivos com alteração pendente. */
  dirty: number;
  at: number;
  /**
   * A pasta do worktree sumiu do disco (apagada por fora, `git worktree remove`
   * no terminal, unidade desconectada). Os números não valem nada nesse estado
   * — a UI mostra "(pasta sumiu)" na linha e o menu fica só com "Fechar
   * workspace", porque diff/merge/remoção não têm onde rodar.
   */
  error?:
    | 'missing'
    /**
     * O repositorio declara driver de `filter.*` e o dono ainda nao confirmou
     * que confia. `dirty`/`ahead` NAO foram medidos (medir executaria o
     * `clean` do repo) — a UI mostra o aviso em vez de um zero que seria
     * mentira. Ver `Repo.trustFilters`.
     */
    | 'filters-untrusted';
}

// ------------------------------------------------- escalonador de lançamentos

/** Um lançamento de agente que está na fila esperando slot (dor verificada #1). */
export interface PendingLaunch {
  /** Id da ENTRADA na fila (`lnch_…`), não da sessão — ela ainda não existe. */
  id: string;
  paneId: string;
  workspaceId: string;
  agent: AgentId;
  /** Quando o `POST /api/sessions` chegou (epoch ms). */
  requestedAt: number;
  /** Posição na fila, 1 = o próximo a sair. */
  position: number;
}

/** Por que um lançamento não pôde sair na hora. */
export type LaunchHold =
  /** Já há `maxConcurrentAgents` sessões de agente vivas. */
  | 'slots'
  /** Rajada: o lançamento anterior foi há menos que o jitter sorteado. */
  | 'jitter'
  /** Alguma sessão está `server-limited` — o espaçamento virou backoff. */
  | 'backoff';

/** Corpo de `GET /api/launcher` e do evento `launcher.changed`. */
export interface LauncherStatus {
  /** `sessions.scheduleLaunches`: desligado, nada é enfileirado. */
  enabled: boolean;
  maxConcurrent: number;
  /** Sessões de agente vivas (tudo que não é `exited`). */
  active: number;
  /** Quantas sessões estão `server-limited` agora. */
  serverLimited: number;
  /**
   * Espaçamento em vigor entre dois lançamentos, em ms: o jitter sorteado no
   * caso normal, o backoff (5 s → 60 s) enquanto houver sessão estrangulada.
   */
  spacingMs: number;
  /** Quando o próximo da fila sai, quando dá pra prever (epoch ms). */
  nextAt?: number;
  pending: PendingLaunch[];
  /**
   * O último lançamento da FILA que falhou. Um pedido enfileirado já respondeu
   * 202 e não tem mais pra onde devolver erro — sem isto, um painel que sumiu
   * (ou um agente que saiu do PATH) faria a fila andar em silêncio.
   */
  lastError?: { at: number; paneId: string; message: string };
}

/** Resposta `202` de `POST /api/sessions` quando o escalonador segurou. */
export interface QueuedLaunch {
  queued: true;
  /** Id da entrada na fila — o que `POST /api/launcher/launch-now` aceita. */
  id: string;
  position: number;
  reason: LaunchHold;
}

// ------------------------------------------------------------------- uso

/**
 * Preço de um modelo em **dólares por milhão de tokens**, uma entrada por
 * tipo de token que a API cobra separado. É a unidade em que a tabela pública
 * é publicada, então é a unidade em que ela é escrita aqui — converter na
 * entrada só criaria um número que ninguém consegue conferir de olho.
 */
export interface UsagePrice {
  input: number;
  output: number;
  /** Escrita de cache com TTL de 5 minutos — o default do Claude Code. */
  cacheWrite: number;
  /**
   * Escrita de cache com TTL de 1 hora. É opcional porque uma tabela escrita
   * à mão antes desta versão não a tem — e nesse caso o custo cai na regra
   * oficial, `2 × input`, em vez de sumir. Deixá-la fora silenciosamente
   * cobraria a escrita de 1 h ao preço da de 5 min (1,25 × input), que numa
   * amostra da máquina do autor era 22,8 % dos tokens de escrita.
   */
  cacheWrite1h?: number;
  /** Leitura de cache (`cache_read_input_tokens`). */
  cacheRead: number;
}

/**
 * O que o dono pode ajustar no monitor de uso.
 *
 * `dayBoundary` existe como CAMPO mas só aceita `'local'`: a decisão do dono
 * é que o dia começa à meia-noite do fuso da máquina. O campo fica porque a
 * pergunta "qual é a borda do dia?" precisa de uma resposta explícita no
 * arquivo — quem lê o `config.json` não deveria ter que deduzir isso do código.
 */
export interface UsageConfig {
  dayBoundary: 'local';
  /** Mostrar custo estimado (faixa, painel e statusline). */
  showCost: boolean;
  /**
   * Desenhar a linha de status DENTRO do terminal do Claude Code (0.12.2).
   *
   * Desligada por padrão: a sidebar já mostra contexto, modelo, custo e as
   * janelas de 5 h e semana, e repetir tudo no rodapé da TUI é a mesma
   * informação duas vezes na mesma tela. O HOOK continua valendo ligado ou
   * desligado — é ele que alimenta esses números —; o que muda é só o texto
   * devolvido ao terminal, que fica vazio.
   */
  terminalStatusLine: boolean;
  /**
   * Caminho de um JSON com a MESMA forma de `pricing`, lido na subida e a
   * cada `POST /api/usage/rescan`. Arquivo ausente ou malformado vira aviso
   * em `pricingWarnings`, nunca erro fatal: o monitor continua com a tabela
   * embutida.
   */
  pricingFile?: string;
  /**
   * Override PARCIAL da tabela embutida, por id de modelo. Vence o arquivo,
   * que vence o embutido. Modelo que não está em lugar nenhum tem custo
   * `null` e entra em `pricingWarnings`.
   */
  pricing?: Record<string, UsagePrice>;
}

/** Contagem de tokens de um recorte — a base de todo agregado de uso. */
export interface UsageTotals {
  input: number;
  output: number;
  /** Escrita de cache de 5 minutos. */
  cacheWrite: number;
  /** Escrita de cache de 1 hora — cobrada ao dobro do input, por isso separada. */
  cacheWrite1h: number;
  cacheRead: number;
  /** `input + output + cacheWrite + cacheWrite1h + cacheRead`. */
  tokens: number;
  /** Mensagens de assistente distintas (já deduplicadas). */
  messages: number;
  /**
   * Custo estimado em USD, ou `null` quando NENHUM modelo do recorte tem
   * preço. Sempre estimativa: vem da tabela, não da fatura.
   */
  cost: number | null;
  /**
   * Parte do recorte ficou de fora do `cost` por falta de preço. É o que
   * separa "custou 0" de "não dá pra saber" — ver `pricingWarnings`.
   */
  costPartial: boolean;
}

export interface UsageDay extends UsageTotals {
  /** Dia LOCAL no formato `AAAA-MM-DD`. */
  day: string;
}

export interface UsageByModel extends UsageTotals {
  /** Id do modelo como o transcript escreveu (`claude-sonnet-4-5`, …). */
  model: string;
  /** O modelo não tem preço na tabela em vigor. */
  unpriced: boolean;
}

export interface UsageByProject extends UsageTotals {
  /** O `cwd` da sessão — é o que o Claude Code grava em cada linha. */
  project: string;
}

/**
 * O consumo separado por ORIGEM.
 *
 * `main` é a conversa que a pessoa digitou; `subagents` é tudo que os
 * subagentes lançados por ela gastaram — que na prática costuma ser a maior
 * parte. Os dois SEMPRE entram nos `totals`: a separação existe pra o painel
 * poder dizer "inclui subagentes" e mostrar a divisão, nunca pra esconder
 * metade do consumo atrás de um filtro.
 */
export interface UsageBySource {
  main: UsageTotals;
  subagents: UsageTotals;
}

/**
 * Uma janela de limite viva, como o payload da statusline do Claude Code a
 * entrega. Genérica de propósito: além de `five_hour`/`seven_day` podem
 * aparecer outras (`seven_day_opus`, …), e o Bridge não pode sumir com uma
 * janela só porque não conhecia o nome dela.
 */
export interface UsageLimitWindow {
  /** A chave crua do payload (`five_hour`). */
  window: string;
  /** Rótulo curto em pt-BR derivado da chave (`5h`, `semana`, `semana opus`). */
  label: string;
  usedPct: number;
  /** Epoch em SEGUNDOS, como vem do payload. Ausente quando o payload omitiu. */
  resetsAt?: number;
  /** Quando o Bridge viu esta janela pela última vez (epoch ms). */
  seenAt: number;
}

/**
 * A partir de quanto a janela de USO conta como ATINGIDA (dor verificada #1).
 *
 * Mora aqui, e não no core nem na UI, porque é POLÍTICA — a linha que separa
 * "ainda dá pra trabalhar" de "acabou" — e as duas pontas precisam citar o
 * mesmo número. Quem FORMATA o selo é só a UI (`usageLimitBadge` no
 * `usageModel.ts`): o texto é um elemento de tela, e ter duas versões dele
 * (uma no core, outra na UI) era duplicação com prazo de validade.
 *
 * Cem por cento, e não 95: abaixo disso a pessoa ainda trabalha, e um aviso de
 * "limite atingido" com 3 % de cota sobrando é alarme falso.
 */
export const USAGE_LIMIT_REACHED_PCT = 100;

/**
 * A janela como ela está AGORA, a partir da última foto (16/09/2026).
 *
 * As barras de 5 h e semana são FIXAS na sidebar: o Claude Code só manda
 * `rate_limits` enquanto tem resposta recente da API, então um payload sem a
 * chave não significa "a conta deixou de ter limites" — significa que ninguém
 * falou com a API nos últimos minutos. Guardar a última foto é o certo; o que
 * NÃO pode é apresentá-la como atual depois que a janela renovou. É isso que
 * esta função corrige: `resets_at` vencido vira 0 % sem hora de reset — por
 * definição a janela recomeçou do zero, e a próxima statusline com dado real
 * substitui o número. Janela sem `resets_at` fica como está.
 *
 * Mora no `@bridge/shared` porque a sidebar, o painel de uso, a statusline do
 * terminal e o `bridge usage` mostram a MESMA janela e têm que concordar.
 */
export function settleLimit<T extends { usedPct: number; resetsAt?: number }>(limit: T, nowMs: number): T {
  if (limit.resetsAt === undefined || !Number.isFinite(limit.resetsAt)) return limit;
  if (limit.resetsAt * 1000 > nowMs) return limit;
  return { ...limit, usedPct: 0, resetsAt: undefined };
}

export function settleLimits<T extends { usedPct: number; resetsAt?: number }>(limits: readonly T[], nowMs: number): T[] {
  return limits.map((limit) => settleLimit(limit, nowMs));
}

/**
 * Recortes aceitos por `GET /api/usage?range=…` (o default é `day`). Moram
 * aqui, e não só no schema do core, porque a CLI e o painel montam a MESMA
 * query e o core valida contra a MESMA lista.
 *
 * - `day`/`week`/`month`/`year` são ANCORADOS: o período é o que contém a
 *   `anchor` (`AAAA-MM-DD`, default hoje). Semana é segunda a domingo, mês e
 *   ano são os civis, tudo no fuso local;
 * - `custom` é o intervalo livre `from`..`to`, inclusive nas duas pontas.
 */
export const USAGE_RANGES = ['day', 'week', 'month', 'year', 'custom'] as const;

export type UsageRange = (typeof USAGE_RANGES)[number];

/** Os recortes que andam por âncora (tudo menos o intervalo livre). */
export type UsageAnchoredRange = Exclude<UsageRange, 'custom'>;

/**
 * A query de `GET /api/usage` como dado: o que a CLI e o painel mandam e o
 * que o core valida. `anchor` só com recorte ancorado; `from`/`to` só com
 * `custom` — a combinação cruzada é 400, e não ignorada, pra ninguém achar
 * que filtrou o que não filtrou.
 */
export interface UsagePeriodQuery {
  range: UsageRange;
  anchor?: string;
  from?: string;
  to?: string;
}

/**
 * Primeiro dia que o monitor aceita (BU-17): de carimbo de transcript, de
 * `anchor` e de começo de período. O Claude Code não existia antes disso; um
 * dia anterior é carimbo inventado ou digitação errada.
 */
export const MIN_USAGE_DAY = '2020-01-01';

/**
 * Teto do intervalo livre, em dias (inclusive). Um ano bissexto inteiro cabe;
 * mais que isso vira um gráfico de barras de um pixel e uma agregação que o
 * core não precisa fazer no processo que hospeda os PTYs.
 */
export const MAX_USAGE_RANGE_DAYS = 366;

/**
 * Progresso da varredura de transcrições.
 *
 * Existe porque a primeira leitura de um histórico grande é uma tarefa longa —
 * na máquina do autor são 8.431 arquivos e 12,8 GB — e sem isto o painel
 * mostrava "nenhuma transcrição encontrada" durante minutos, que é uma
 * afirmação falsa: elas existem, o Bridge é que ainda não chegou nelas.
 *
 * `filesDone`/`filesTotal` contam os arquivos da passada (inclusive os que ela
 * pulou por já estarem lidos); `bytesDone`/`bytesTotal` são o tamanho deles, e
 * servem pra barra de progresso — um arquivo de 200 MB e um de 4 KB pesam o
 * mesmo na contagem de arquivos e não no tempo.
 */
export interface UsageScanProgress {
  /** Há uma varredura em voo agora. `false` = os números são os da última. */
  active: boolean;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /**
   * Linhas de transcript descartadas por serem maiores que o teto de linha
   * (BU-01/R1). Zero é o caso normal; qualquer número acima disso quer dizer
   * que a contagem daquela passada é MENOR que o consumo real, e é por isso
   * que ele sobe até aqui em vez de ficar só no log.
   */
  skippedLines: number;
  /**
   * A árvore tem mais transcripts que o teto da listagem e o resto ficou de
   * fora desta passada (BU-05/R5). Ausente no caso normal.
   */
  capped?: boolean;
}

/** Corpo de `GET /api/usage`. */
export interface UsageReport {
  range: UsageRange;
  /**
   * A âncora em vigor nos recortes ancorados (`day`/`week`/`month`/`year`):
   * a pedida, ou HOJE quando o pedido não trouxe nenhuma. Ausente em
   * `custom`, que não anda por âncora.
   */
  anchor?: string;
  /**
   * O dia LOCAL de hoje no instante da resposta, no fuso do relatório. É o
   * que deixa a UI dizer "hoje" × "10/09/2026" e travar o "próximo" sem
   * confiar no relógio do browser. Opcional só por compatibilidade com core
   * anterior ao campo.
   */
  today?: string;
  /** Primeiro dia LOCAL do recorte, `AAAA-MM-DD` (inclusive). */
  from: string;
  /**
   * Último dia LOCAL do recorte, `AAAA-MM-DD` (inclusive). Num recorte
   * ancorado que contém hoje ele pode estar no futuro (fim do mês civil); no
   * `custom` ele já vem preso em hoje.
   */
  to: string;
  /** Fuso usado pra fatiar os dias (o do processo, salvo `?tz=`). */
  tz: string;
  totals: UsageTotals;
  /**
   * O mesmo recorte partido entre a conversa PRINCIPAL e os subagentes que ela
   * lançou. Existe porque um mês que parece caro pode ser só um lote de
   * subagentes, e o total sozinho não distingue as duas coisas.
   *
   * Os dois lados SEMPRE entram nos `totals` — a separação é pra o painel
   * poder dizer "inclui subagentes", nunca pra esconder metade do consumo.
   */
  bySource: UsageBySource;
  /**
   * Série pro gráfico. Dia sem consumo entra ZERADO — buraco na série viraria
   * um gráfico que mente sobre o eixo do tempo.
   *
   * A janela termina em `min(to, hoje)` — nunca uma cauda de dias FUTUROS
   * zerados, que qualquer pessoa lê como "o consumo caiu". Até esse fim: com
   * 30 dias ou mais no período, a série é o próprio período (um mês passado
   * de 31 dias, um ano, um intervalo livre longo); com menos, são os 30 dias
   * terminando nele, e o recorte é a parte DESTACADA da série. No período de
   * hoje isso dá exatamente os últimos 30 dias até hoje, como sempre deu.
   */
  byDay: UsageDay[];
  /**
   * Primeiro e último dia LOCAL da série acima (`AAAA-MM-DD`) — ver `byDay`.
   *
   * Existem separados de `from`/`to` porque os dois pares divergem de
   * propósito: no recorte de mês, `to` é o último dia do mês CIVIL, que ainda
   * não chegou. A UI não precisa deduzir a janela do próprio `byDay`.
   */
  chartFrom: string;
  chartTo: string;
  byModel: UsageByModel[];
  byProject: UsageByProject[];
  /** As janelas vivas conhecidas. Vazio = nunca chegou `rate_limits` (API key). */
  limits: UsageLimitWindow[];
  /** Modelos sem preço NO RECORTE e problemas da tabela de preços, em pt-BR. */
  pricingWarnings: string[];
  /**
   * Data em que os preços em vigor foram conferidos contra a fonte oficial
   * (`AAAA-MM-DD`), com `(com ajustes locais)` quando `usage.pricing` ou
   * `usage.pricingFile` mexeram na tabela. É o que deixa o rodapé "estimativa"
   * dizer de QUANDO é a estimativa.
   */
  pricingAsOf: string;
  /** Pasta de onde os transcripts são lidos — é o que o estado vazio mostra. */
  claudeHome: string;
  /** Transcripts já varridos (linha do estado vazio: "0 arquivo em …"). */
  scannedFiles: number;
  /**
   * A varredura em voo (ou a última que rodou), `null` enquanto nenhuma
   * começou. É o que deixa o estado vazio dizer "ainda lendo as transcrições
   * (N de M arquivos)" em vez de "não encontrei nada".
   */
  scanning: UsageScanProgress | null;
}

/**
 * Configuração do Bridge (`%APPDATA%\bridge\config.json`). Mora aqui, e não
 * no core, porque `GET /api/config` e o evento `config.changed` entregam esse
 * objeto pra UI e pro shell — os três precisam da MESMA definição.
 *
 * `port` é somente leitura pela API: mudar a porta com o servidor no ar não
 * reabre o socket (e derrubaria o token gravado no `instance.json`).
 */
/**
 * O que o `config.json` do perfil guarda — e SÓ isso. Todo campo aqui é
 * gravável; `writeConfig` recebe este tipo, então nada que não esteja neste
 * shape pode ir parar no arquivo por descuido.
 */
export interface StoredConfig {
  /** Somente leitura pela API (`PATCH /api/config` → 403 `read-only`). */
  port: number;
  shell: 'pwsh' | 'powershell' | 'gitbash';
  gitPollSeconds: number;
  /** Monitor de uso (ADR-012). Ver `UsageConfig`. */
  usage: UsageConfig;
  toast: { enabled: boolean; quietWhenFocused: boolean };
  /** Fonte do xterm (spec §5). Ver `DEFAULT_STORED_CONFIG.terminal`. */
  terminal: { fontFamily: string; fontSize: number };
  /**
   * O que a restauração faz ao reabrir o Bridge (spec §10).
   *
   * `resumeAgents` ligado: painel que estava com um Claude Code quando o app
   * fechou volta com `claude --resume <id>`. Desligado: ele volta como shell
   * com a dica "a sessão anterior era Claude Code", que é como a v0.5.0 fazia.
   */
  restore: { resumeAgents: boolean };
  /**
   * O IDIOMA da interface (spec §13, 0.13.0). `'system'` — o default — quer
   * dizer "pergunte à máquina": `pt*` vira `pt-BR`, qualquer outra locale vira
   * `en`. É UM idioma pra tudo: sidebar, erros da API, notificações,
   * statusline, CLI, bandeja e diálogos nativos.
   *
   * Fica em `ui` e não solto na raiz porque a pergunta é sobre a INTERFACE, e
   * não sobre a máquina: a saída dos agentes, os logs em arquivo e o
   * instalador continuam onde estavam (spec §13).
   */
  ui: { language: LanguageSetting };
  /**
   * O escalonador de lançamentos de agente (dor verificada #1).
   *
   * `maxConcurrentAgents` é o teto de sessões de AGENTE vivas ao mesmo tempo;
   * pedido além dele entra na fila em vez de subir. `scheduleLaunches`
   * desligado tira o escalonador inteiro do caminho (nem jitter, nem backoff,
   * nem teto) — quem prefere lançar tudo de uma vez continua podendo.
   *
   * `autoRecap` (dor verificada #3) é o que acontece quando o `--resume` volta
   * VAZIO: desligado (o default), o painel mostra a faixa com "Reabrir com
   * contexto" e o dono decide; ligado, o resumo da conversa anterior é
   * escrito no prompt do agente sozinho. Nasce desligado de propósito —
   * escrever no terminal de alguém sem pedir é a última coisa que um app de
   * terminal deve fazer por conta própria.
   *
   * `scopeGuard` (dor verificada #4) é a guarda de escopo entre worktrees
   * irmãs: com ela ligada — o default —, o `PreToolUse` de um `Read`/`Edit`
   * cujo caminho cai FORA da raiz da sessão (o worktree, quando o workspace é
   * uma tarefa; o repositório inteiro, quando não é) volta com
   * `permissionDecision: 'deny'`. Desligada, o Bridge não opina sobre caminho
   * nenhum. A liberação pontual de UM workspace é o `crossAccess` dele, no
   * menu "⋯" — este campo é o interruptor geral.
   *
   * `hostedAgents` (0.12.0) é o reconhecimento do Claude Code aberto DENTRO de
   * um shell: ligado — o default —, toda sessão de shell leva um wrapper
   * `claude` na frente do PATH que chama o claude real com o `--settings` da
   * sessão, e é por isso que a sidebar consegue mostrar o agente que a pessoa
   * abriu à mão. Desligado, nada é gravado e o PATH da sessão fica intocado.
   */
  sessions: {
    maxConcurrentAgents: number;
    scheduleLaunches: boolean;
    autoRecap: boolean;
    scopeGuard: boolean;
    hostedAgents: boolean;
    /**
     * Clique do mouse no Claude Code (12/09/2026). LIGADO: as sessões nascem
     * com `CLAUDE_CODE_NO_FLICKER=true` (a interface fullscreen do Claude
     * Code, a única que aceita clique) e o terminal repassa o mouse ao
     * programa que pedir. DESLIGADO: `CLAUDE_CODE_DISABLE_MOUSE=1` e o terminal
     * ignora pedidos de mouse — arrastar sempre seleciona texto.
     */
    mouseClicks: boolean;
  };
}

/**
 * Os valores default do `config.json` — FONTE ÚNICA.
 *
 * Até o lote de 04/09/2026 eles existiam em duplicata: `DEFAULT_CONFIG` no
 * core (`packages/core/src/profile.ts`) e `SETTINGS_DEFAULTS` na UI
 * (`packages/ui/src/settingsModel.ts`), cada um copiado à mão do outro porque
 * a UI não importa do core (puxaria `node:fs` pro bundle do browser) e o core
 * não importa da UI. As duas pontas dependem de `@bridge/shared`, então é aqui
 * que o default mora: mudar o `gitPollSeconds` num lugar só deixava o
 * "Restaurar padrões" do diálogo repondo o número velho, calado.
 *
 * A pilha de `terminal.fontFamily` é explicada em
 * `packages/ui/src/terminalPrefs.ts` (medição de avanço por glifo): a
 * `Cascadia Mono` vai na frente porque é a única mono da máquina com
 * box-drawing, blocos e braille NA MESMA largura de célula.
 */
export const DEFAULT_STORED_CONFIG: StoredConfig = {
  port: 4560,
  shell: 'pwsh',
  gitPollSeconds: 15,
  // Decisão do dono: dia à meia-noite local e custo à mostra. `pricingFile` e
  // `pricing` nascem AUSENTES — nenhum caminho de máquina nenhuma entra num
  // default que vai pro `config.json` de todo mundo que instalar o Bridge.
  // A linha de status no terminal nasce DESLIGADA (0.12.2): a sidebar já diz
  // os mesmos números, e o rodapé da TUI era a segunda cópia deles.
  usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false },
  toast: { enabled: true, quietWhenFocused: true },
  terminal: {
    fontFamily: "'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace",
    fontSize: 12,
  },
  restore: { resumeAgents: true },
  // O idioma nasce `system`: o dono é pt-BR e quem baixar o Bridge numa
  // máquina em inglês lê inglês sem precisar achar a opção. Numa máquina em
  // inglês o dono troca no seletor de Configurações → Aparência.
  ui: { language: 'system' },
  // Quatro: é a concorrência em que a máquina do autor ainda respondia sem
  // encostar no estrangulamento do servidor. Não é um limite de conta — é o
  // ritmo com que os lançamentos saem.
  // A guarda de escopo nasce LIGADA: o custo de um falso positivo é uma
  // recusa que o dono libera em dois cliques, e o custo do contrário é um
  // agente reescrevendo o worktree da tarefa do lado sem ninguém ver.
  // O reconhecimento do Claude Code aberto dentro de um shell nasce LIGADO: o
  // sintoma que abriu o lote de 07/09/2026 foi o dono rodando um agente inteiro
  // num painel que a sidebar insistia em chamar de "shell".
  sessions: { maxConcurrentAgents: 4, scheduleLaunches: true, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
};

/**
 * A configuração como a API entrega (`GET /api/config` e o evento
 * `config.changed`): o que está no disco MAIS o `profileDir`.
 *
 * A separação entre este tipo e o `StoredConfig` não é preciosismo: ela é o
 * que impede o `profileDir` de ser gravado. Ele é DERIVADO de onde o
 * `config.json` está (`BRIDGE_PROFILE_DIR`, ou `%APPDATA%\bridge`), então
 * escrevê-lo dentro do próprio arquivo seria guardar uma resposta que já se
 * sabe — e que passa a mentir no instante em que a pasta muda de lugar.
 * `writeConfig` só aceita `StoredConfig`, então o compilador recusa; não é
 * uma regra que alguém precisa lembrar de seguir.
 */
export interface BridgeConfig extends StoredConfig {
  /**
   * Pasta do perfil, caminho ABSOLUTO. Somente leitura pela API
   * (`PATCH /api/config` → 403 `read-only`, como `port`). Existe porque a UI
   * precisa de um caminho real pra abrir no Explorer: o
   * `%APPDATA%\bridge\keybindings.json` que o diálogo mostrava era literal e
   * o `shell.openPath` do Electron não expande variável de ambiente.
   */
  profileDir: string;
  /**
   * De onde o monitor de uso lê os transcripts, caminho ABSOLUTO. Derivado
   * como o `profileDir` (`BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` →
   * `~/.claude`), então não vai pro `config.json` e é somente leitura pela
   * API. O painel "Uso" mostra este caminho no estado vazio — sem ele,
   * "nenhum transcript encontrado" não diz ONDE o Bridge procurou.
   */
  claudeHome: string;
  /**
   * O idioma JÁ RESOLVIDO (spec §13). Derivado como o `profileDir`: é
   * `ui.language` cruzado com a locale da máquina onde o core roda, então não
   * vai pro `config.json` e é somente leitura pela API.
   *
   * Existe pra que UI, CLI e shell não repitam a resolução — e, principalmente,
   * pra que não CHEGUEM a respostas diferentes: com `'system'`, o core resolve
   * pela locale do processo dele, e uma segunda resolução no renderer
   * (`navigator.language`) poderia dar outro idioma na mesma máquina. Quem
   * manda é este campo.
   */
  languageResolved: Language;
}

/** Campos que `PATCH /api/config` aceita — subconjunto, com os aninhados parciais. */
export interface BridgeConfigPatch {
  shell?: BridgeConfig['shell'];
  gitPollSeconds?: number;
  toast?: Partial<BridgeConfig['toast']>;
  terminal?: Partial<BridgeConfig['terminal']>;
  restore?: Partial<BridgeConfig['restore']>;
  ui?: Partial<BridgeConfig['ui']>;
  usage?: Partial<BridgeConfig['usage']>;
  sessions?: Partial<BridgeConfig['sessions']>;
}
