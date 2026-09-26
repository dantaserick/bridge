/**
 * Funções puras da sidebar e do painel de notificações: agrupamento por
 * repositório, agregação de estado, corte de texto e tempo relativo. Nada aqui
 * toca DOM, React ou rede — é o que deixa a pele da Task 7 testável sem
 * navegador.
 *
 * A faixa de cota SAIU daqui na 0.10.0 (ADR-012): os limites viraram bloco
 * único da sidebar e a linha da sessão virou `sessionLine`, os dois no
 * `usageModel.ts` — junto com o resto do que o painel "Uso" formata, pra que
 * o degrau de cor e o rótulo de janela existam num lugar só.
 */
import { INTL_LOCALE, STATE_SEVERITY, sanitizeDisplay } from '@bridge/shared';
import type {
  GitStatus,
  Language,
  LauncherStatus,
  LayoutSnapshot,
  MessageKey,
  Notification,
  Session,
  SessionState,
  Workspace,
} from '@bridge/shared';
import { tUi } from './i18n.js';
import type { GroupPrefs } from './sidebarPrefs.js';

/** Grupo dos workspaces que não pertencem a repositório nenhum. */
export const LOOSE_GROUP_ID = '__loose__';
/**
 * O dono achou "Solto" opaco (04/09/2026): o nome agora diz o critério —
 * é o grupo de quem não tem repositório git por trás.
 */
export function looseGroupName(lang: Language): string {
  return tUi(lang, 'sidebar.grupo.semRepositorio');
}

export interface WorkspaceGroup {
  /** `repoId` ou `LOOSE_GROUP_ID`. */
  id: string;
  /** Nome do repositório ou "Sem repositório". É o que vai no cabeçalho. */
  name: string;
  workspaces: Workspace[];
}

/**
 * Workspaces agrupados por repositório: grupos por nome, "Sem repositório" por
 * último, workspaces por `createdAt`. Workspace sem `repoId` — e também o que
 * carrega um `repoId` sem repositório correspondente no snapshot — cai em
 * "Sem repositório".
 */
export function groupWorkspaces(snapshot: LayoutSnapshot, lang: Language): WorkspaceGroup[] {
  const byRepo = new Map<string, Workspace[]>();
  const loose: Workspace[] = [];
  const repoName = new Map(snapshot.repos.map((repo) => [repo.id, repo.name]));

  for (const workspace of snapshot.workspaces) {
    const repoId = workspace.repoId;
    if (repoId === undefined || !repoName.has(repoId)) {
      loose.push(workspace);
      continue;
    }
    const bucket = byRepo.get(repoId);
    if (bucket) bucket.push(workspace);
    else byRepo.set(repoId, [workspace]);
  }

  const byCreatedAt = (a: Workspace, b: Workspace): number => a.createdAt - b.createdAt;

  const groups: WorkspaceGroup[] = [...byRepo.entries()]
    .map(([id, workspaces]) => ({ id, name: repoName.get(id) ?? id, workspaces: [...workspaces].sort(byCreatedAt) }))
    // A ordem alfabética é dado de LOCALE, não copy: quem decide onde o `ç` e
    // o `á` entram é a locale do idioma em vigor, a mesma que os formatadores
    // do `@bridge/shared` usam.
    .sort((a, b) => a.name.localeCompare(b.name, INTL_LOCALE[lang]));

  if (loose.length > 0) {
    groups.push({ id: LOOSE_GROUP_ID, name: looseGroupName(lang), workspaces: [...loose].sort(byCreatedAt) });
  }
  return groups;
}

/** Pior estado entre as sessões, por `STATE_SEVERITY` (stuck vence tudo). */
export function aggregateState(sessions: Session[]): SessionState | undefined {
  let worst: SessionState | undefined;
  for (const session of sessions) {
    if (worst === undefined || STATE_SEVERITY[session.state] > STATE_SEVERITY[worst]) worst = session.state;
  }
  return worst;
}

// ------------------------------------------------------- grupos: fixar/recolher

/** Um grupo já com a preferência do usuário aplicada — o que a sidebar desenha. */
export interface SidebarGroup extends WorkspaceGroup {
  pinned: boolean;
  collapsed: boolean;
}

/**
 * Aplica as preferências de grupo: fixados primeiro, NA ORDEM EM QUE FORAM
 * FIXADOS (`prefs.pinned`), e o resto na ordem que o `groupWorkspaces` deu
 * (repos por nome, "Sem repositório" por último). Id fixado que não existe
 * mais — repositório removido — é ignorado sem ruído: a preferência sobrevive
 * caso o repo volte.
 */
export function applyGroupPrefs(groups: WorkspaceGroup[], prefs: GroupPrefs): SidebarGroup[] {
  const pinnedSet = new Set(prefs.pinned);
  const collapsedSet = new Set(prefs.collapsed);
  const decorate = (group: WorkspaceGroup): SidebarGroup => ({
    ...group,
    pinned: pinnedSet.has(group.id),
    collapsed: collapsedSet.has(group.id),
  });

  const byId = new Map(groups.map((group) => [group.id, group]));
  const pinned = prefs.pinned.map((id) => byId.get(id)).filter((group): group is WorkspaceGroup => group !== undefined);
  const rest = groups.filter((group) => !pinnedSet.has(group.id));
  return [...pinned, ...rest].map(decorate);
}

/**
 * O anel do cabeçalho quando o grupo está RECOLHIDO: o pior estado entre as
 * sessões de todos os workspaces dele. Sem isso, recolher um grupo esconderia
 * justamente o "essa aqui travou" que a sidebar existe pra mostrar.
 */
export function collapsedGroupState(group: WorkspaceGroup, sessions: Session[]): SessionState | undefined {
  const ids = new Set(group.workspaces.map((workspace) => workspace.id));
  return aggregateState(sessions.filter((session) => ids.has(session.workspaceId)));
}

// -------------------------------------------------------------------- git

export interface GitBadges {
  /** `+3` — commits que a tarefa tem a mais que o base. */
  ahead: string;
  /** `~5` — arquivos com alteração pendente no worktree. */
  dirty: string;
  /** `~M > 0` acende em âmbar: tem trabalho não commitado ali. */
  dirtyWarn: boolean;
  /** Tooltip da linha: qual é o base da tarefa. */
  title: string;
}

/**
 * Os badges `+N ~M` da linha de workspace (spec §6). `undefined` enquanto o
 * poller do core não mandou o primeiro status — a linha mostra só o branch,
 * em vez de um `+0 ~0` inventado pela UI.
 *
 * `base` é o do `workspace.worktree` e só entra como reserva: o status do core
 * é a fonte, mas o primeiro `GitStatus` pode chegar depois da linha aparecer.
 */
export function formatGitBadges(
  git: GitStatus | undefined,
  lang: Language,
  base?: string,
  baseGuessed?: boolean,
): GitBadges | undefined {
  if (!git) return undefined;
  // A pasta sumiu: os números não valem nada e mostrar `+0 ~0` seria mentira.
  if (git.error === 'missing') return undefined;
  // BR-03: o repo declara filtro e o dono não confiou — o core NÃO mediu
  // `dirty`/`ahead` (medir executaria o `clean` do repositório). Mostrar
  // `+0 ~0` aqui seria a mesma mentira do `missing`; quem fala é o aviso.
  if (git.error === 'filters-untrusted') return undefined;
  const known = git.base ?? base;
  const title = known
    ? tUi(lang, baseGuessed ? 'sidebar.git.tituloDeduzida' : 'sidebar.git.titulo', { base: known })
    : tUi(lang, 'sidebar.git.semBase');
  return {
    ahead: `+${git.ahead}`,
    dirty: `~${git.dirty}`,
    dirtyWarn: git.dirty > 0,
    title,
  };
}

/**
 * O que a linha do workspace mostra no lugar da branch quando o worktree
 * sumiu do disco (apagado por fora, unidade desconectada). Nada de git roda
 * nesse estado, e o menu fica só com "Fechar workspace".
 */
export function missingWorktreeLabel(lang: Language): string {
  return tUi(lang, 'sidebar.worktree.sumiu');
}

/** O worktree do workspace existe? `false` só quando o core disse que sumiu. */
export function worktreeMissing(git: GitStatus | undefined): boolean {
  return git?.error === 'missing';
}
/**
 * BR-03 — o selo que substitui o `+N ~M` quando o repositório declara driver
 * de `filter.*` e o dono ainda não confiou. O core não mediu nada nesse
 * estado; a linha diz por quê, e o menu do workspace tem a saída.
 */
export function filtersUntrustedLabel(lang: Language): string {
  return tUi(lang, 'sidebar.filtros.rotulo');
}
export function filtersUntrustedTitle(lang: Language): string {
  return tUi(lang, 'sidebar.filtros.titulo');
}

/** O status veio marcado como "filtros não confiados"? */
export function filtersUntrusted(git: GitStatus | undefined): boolean {
  return git?.error === 'filters-untrusted';
}

// --------------------------------------- rótulo e detalhe da linha de sessão

/**
 * O tooltip da linha quando um Claude Code está aberto DENTRO do shell
 * (0.12.0). Ele existe porque a linha diz `claude` numa sessão que continua
 * sendo `kind: 'shell'` — sem a frase, "por que este shell virou claude?" não
 * tem resposta em lugar nenhum da tela.
 */
export function hostedRowTitle(lang: Language): string {
  return tUi(lang, 'sidebar.hospedada.titulo');
}

/**
 * O `detail` da hospedeira enquanto o agente não disse o que está fazendo
 * (spec §5). É o que separa, na varredura vertical, o Claude que o Bridge
 * subiu do Claude que a pessoa digitou num shell — o resto da linha é igual.
 */
export function hostedDetail(lang: Language): string {
  return tUi(lang, 'sidebar.hospedada.detalhe');
}

/**
 * Tem um agente de verdade rodando aqui? Vale pra sessão que NASCEU agente e
 * pra sessão de shell hospedeira — o mesmo critério do `liveAgentCount()` do
 * core. `kind` sozinho não responde isso desde a 0.12.0.
 */
export function runsAgent(session: Session): boolean {
  return session.kind === 'agent' || session.hosted !== undefined;
}

/**
 * O rótulo da sessão, num lugar só: a linha da sidebar, o cabeçalho do painel,
 * o painel de notificações e as confirmações de encerrar.
 *
 * Quem manda é `hosted?.agent ?? agent`, NUNCA o `kind`: a hospedeira nasce e
 * morre `'shell'`, e era exatamente isso que fazia a sidebar dizer "shell" com
 * um Claude Code trabalhando dentro dela.
 */
export function sessionLabel(session: Session, lang: Language): string {
  if (session.kind === 'agent') return session.agent ?? tUi(lang, 'sidebar.sessao.agente');
  if (session.hosted) return session.hosted.agent;
  // `shell` é o nome do que está rodando ali, como `claude`: nome próprio não se
  // traduz (spec §13).
  return 'shell';
}

/**
 * Detalhe à direita: o que o agente está fazendo, o código de saída, o
 * "no shell" da hospedeira ociosa, ou o fim do cwd num shell puro — nessa
 * ordem. O `detail` do agente ganha do "no shell" porque "pensando…" é a
 * notícia; sessão encerrada ganha dos dois, porque aí não há mais Claude
 * nenhum lá dentro pra descrever.
 */
export function sessionDetail(session: Session, lang: Language): string {
  // O `detail` vem do core JÁ traduzido (`adapter.onHook(…, lang)`): a UI o
  // repassa como está — retraduzir por cima é o defeito que o report da Task 2
  // pediu explicitamente para não repetir aqui.
  if (session.detail) return session.detail;
  if (session.state === 'exited') return tUi(lang, 'sidebar.sessao.saida', { codigo: session.exitCode ?? '?' });
  if (session.hosted) return hostedDetail(lang);
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? session.cwd : `…\\${parts.slice(-2).join('\\')}`;
}

/** O `title` da linha da sessão. Só a hospedeira tem um. */
export function sessionRowTitle(session: Session, lang: Language): string | undefined {
  return session.hosted ? hostedRowTitle(lang) : undefined;
}

/**
 * Quantas sessões estão naquele estado — os contadores do rodapé
 * ("N rodando", "N pedem input", "N travado").
 *
 * A conta é por ESTADO e sobre TODAS as sessões, sem olhar `kind`: até a
 * 0.11.x isso dava no mesmo, porque um shell só ficava `idle`/`exited`; da
 * 0.12.0 em diante a hospedeira recebe `running`/`needs-input`/`stuck` do
 * adaptador do Claude e entra nos contadores sozinha — que é o certo, já que
 * quem "pede input" ali é um Claude Code de verdade.
 */
export function stateCount(sessions: Session[], state: SessionState): number {
  return sessions.filter((session) => session.state === state).length;
}

// ------------------------------------------------------ a11y das linhas

/**
 * Cada estado de sessão em pt-BR. É o que o leitor de tela fala no lugar do
 * anel colorido: o anel é a única marca de "esta sessão está esperando você"
 * na varredura visual, e sem isto ele não existe pra quem não vê a tela.
 */
const STATE_KEYS: Record<SessionState, MessageKey> = {
  idle: 'sidebar.estado.idle',
  running: 'sidebar.estado.running',
  'needs-input': 'sidebar.estado.needsInput',
  done: 'sidebar.estado.done',
  stuck: 'sidebar.estado.stuck',
  exited: 'sidebar.estado.exited',
  // "do servidor" com todas as letras: o rótulo é lido do lado do de USO, e a
  // confusão entre os dois é a dor que este estado existe pra desfazer.
  'server-limited': 'sidebar.estado.serverLimited',
};

export function sessionStateLabel(state: SessionState, lang: Language): string {
  return tUi(lang, STATE_KEYS[state]);
}

/** O mapa inteiro — é o que o anel (`StateRing`) desenha, num idioma só. */
export function sessionStateLabels(lang: Language): Record<SessionState, string> {
  return {
    idle: sessionStateLabel('idle', lang),
    running: sessionStateLabel('running', lang),
    'needs-input': sessionStateLabel('needs-input', lang),
    done: sessionStateLabel('done', lang),
    stuck: sessionStateLabel('stuck', lang),
    exited: sessionStateLabel('exited', lang),
    'server-limited': sessionStateLabel('server-limited', lang),
  };
}

/**
 * O `aria-label` da linha de um workspace — o que o leitor de tela anuncia no
 * lugar de "botão" e nada mais.
 *
 * Junta, nesta ordem: o nome, o estado agregado das sessões, quantas sessões
 * há, e o aviso que a linha estiver mostrando (worktree sumido ou filtros não
 * confiados). O `+N ~M` fica de fora de propósito: ele já tem `title` próprio
 * na linha, e repeti-lo aqui faria toda linha de tarefa começar com dois
 * números antes do nome.
 */
export function workspaceRowLabel(input: {
  name: string;
  state: SessionState | 'empty';
  sessions: number;
  missing?: boolean;
  untrusted?: boolean;
  /** Dor #2 — o id do ambiente (`wsl:Ubuntu`), quando o workspace escolheu um. */
  environment?: string;
  /** O ambiente escolhido está sem `claude` (ou sumiu da máquina). */
  environmentProblem?: boolean;
}, lang: Language): string {
  const parts = [tUi(lang, 'sidebar.linha.workspace', { nome: input.name })];
  if (input.sessions === 0) parts.push(tUi(lang, 'sidebar.linha.semSessoes'));
  else {
    parts.push(
      input.sessions === 1
        ? tUi(lang, 'sidebar.linha.umaSessao')
        : tUi(lang, 'sidebar.linha.variasSessoes', { n: input.sessions }),
    );
    if (input.state !== 'empty') parts.push(sessionStateLabel(input.state, lang));
  }
  if (input.missing) parts.push(tUi(lang, 'sidebar.linha.worktreeSumiu'));
  if (input.untrusted) parts.push(tUi(lang, 'sidebar.linha.filtrosNaoConfiados'));
  if (input.environment) {
    parts.push(tUi(lang, 'sidebar.linha.ambiente', { id: input.environment }));
    if (input.environmentProblem) parts.push(tUi(lang, 'sidebar.linha.ambienteProblema'));
  }
  return parts.join(', ');
}

/** O `aria-label` de uma sessão dentro do workspace expandido. */
export function sessionRowLabel(
  input: { label: string; state: SessionState; detail: string; focused: boolean },
  lang: Language,
): string {
  const parts = [
    tUi(lang, 'sidebar.linha.sessao', { rotulo: input.label }),
    sessionStateLabel(input.state, lang),
    input.detail,
  ];
  if (input.focused) parts.push(tUi(lang, 'sidebar.linha.emFoco'));
  return parts.join(', ');
}

/**
 * O `aria-label` do cabeçalho de grupo. Recolhido ele carrega o contador e o
 * pior estado do grupo — que é justamente quando a informação some da tela e
 * o cabeçalho vira o único lugar onde ela existe.
 */
export function groupHeaderLabel(input: {
  name: string;
  count: number;
  collapsed: boolean;
  ringState?: SessionState;
}, lang: Language): string {
  const parts = [tUi(lang, 'sidebar.grupo.rotulo', { nome: input.name }), groupCountLabel(input.count, lang)];
  if (input.collapsed && input.ringState) parts.push(sessionStateLabel(input.ringState, lang));
  parts.push(tUi(lang, input.collapsed ? 'sidebar.grupo.recolhido' : 'sidebar.grupo.expandido'));
  return parts.join(', ');
}

/** `1 workspace` / `3 workspaces` — o rótulo e o `title` do contador do grupo. */
export function groupCountLabel(count: number, lang: Language): string {
  return count === 1
    ? tUi(lang, 'sidebar.grupo.umWorkspace')
    : tUi(lang, 'sidebar.grupo.variosWorkspaces', { n: count });
}

/**
 * Pra onde ↑/↓ levam o foco dentro da sidebar.
 *
 * `current` é o índice da linha focada. `-1` (foco em algo que não é linha: o
 * "⋯" de uma linha, um item de menu aberto) devolve `undefined` — a seta ali
 * pertence a quem tem o foco, não à lista; quem entra na lista entra pelo Tab,
 * que já cai na primeira linha.
 *
 * Nas pontas também devolve `undefined`: **não** dá a volta. A sidebar é uma
 * lista com começo e fim visíveis, e dar a volta em cima do ↓ faz quem não vê a
 * tela perder a noção de onde está. `undefined` é sempre o sinal pra quem chama
 * NÃO dar `preventDefault` — a tecla volta a ser da página (e rola a lista).
 */
export function nextRowIndex(count: number, current: number, delta: -1 | 1): number | undefined {
  if (count <= 0 || current < 0 || current >= count) return undefined;
  const next = current + delta;
  if (next < 0 || next >= count) return undefined;
  return next;
}




// ------------------------------------------------------------------ texto

/** Corta preservando o limite: o resultado nunca passa de `max` caracteres. */
export function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// O tempo relativo saiu daqui: ele é o `formatRelativeTime(at, now, lang)` do
// `@bridge/shared`, a MESMA função que a CLI usa. Havia duas implementações da
// mesma frase, e esta só falava português.

// ---------------------------------------------------------- notificações

/**
 * Junta o histórico buscado em `GET /api/notifications` com a fila de não
 * lidas do reducer: o que chegou pelo WS entra na lista, e o que saiu da fila
 * (foi lido) ganha `readAt` — o core só manda os ids em `notification.read`.
 */
export function mergeNotifications(items: Notification[], unread: Notification[], now: number): Notification[] {
  const unreadIds = new Set(unread.map((n) => n.id));
  const seen = new Set<string>();
  const merged: Notification[] = [];

  for (const item of items) {
    // A mesma notificação chega pelo histórico e pelo WS: o primeiro vence.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const stillUnread = unreadIds.has(item.id);
    if (!stillUnread && item.readAt === undefined) merged.push({ ...item, readAt: now });
    else merged.push(item);
  }
  for (const item of unread) {
    if (!seen.has(item.id)) merged.push(item);
  }
  return merged.sort((a, b) => b.at - a.at);
}

/**
 * Cabeçalho da linha do painel, por `kind`. O `text` da notificação vem do
 * core (ou do agente, ou do terminal) e diz o QUE aconteceu; este rótulo diz
 * de que TIPO é, na língua da UI — é a resposta curta a "o que foi que alertou".
 */
export function notificationKindLabel(kind: Notification['kind'], lang: Language): string {
  return tUi(lang, `notifications.tipo.${kind}`);
}

/** `aria-label` do sino, que agora fica sempre no cabeçalho da sidebar. */
export function unreadBellLabel(count: number, lang: Language): string {
  return count > 0 ? tUi(lang, 'sidebar.notificacoes.rotulo', { n: count }) : tUi(lang, 'sidebar.notificacoes.nenhuma');
}

// ------------------------------------------- limite do servidor e fila

/** O selo laranja da linha da sessão — texto curto, e a prova no `title`. */
export interface ServerLimitBadge {
  text: string;
  title: string;
}

/** Texto fixo do selo. Curto porque a coluna é estreita. */
export function serverLimitLabel(lang: Language): string {
  return tUi(lang, 'sidebar.servidor.rotulo');
}

/**
 * A frase que separa os dois limites. Ela é a razão de ser da dor verificada
 * #1: quem lê "limite" no terminal conclui que gastou a cota e vai mexer no
 * plano — quando o que aconteceu foi o servidor estrangular as chamadas de
 * todo mundo, por alguns minutos, sem relação nenhuma com o que a pessoa
 * consumiu.
 */
export function serverLimitNote(lang: Language): string {
  return tUi(lang, 'sidebar.servidor.nota');
}

/**
 * O selo da sessão estrangulada, ou `undefined` quando ela não está.
 *
 * O `title` carrega a frase que o Bridge leu no terminal — sem ela o selo
 * seria um veredito sem prova, e a pessoa não teria como conferir se o
 * detector se enganou.
 */
export function serverLimitBadge(session: Session, lang: Language): ServerLimitBadge | undefined {
  if (session.state !== 'server-limited') return undefined;
  const phrase = session.serverLimit?.phrase;
  const note = serverLimitNote(lang);
  return {
    text: serverLimitLabel(lang),
    title: phrase ? tUi(lang, 'sidebar.servidor.titulo', { nota: note, frase: phrase }) : note,
  };
}

// ------------------------------------------- guarda de escopo (dor #4)

/** Texto fixo do selo 🛡. O número é o contador de recusas da sessão. */
export const SCOPE_BLOCK_LABEL = '🛡';

/**
 * A primeira linha do tooltip do selo. Ela existe pra que a recusa não pareça
 * um erro do Claude: o agente pediu um arquivo, o BRIDGE disse não, e quem
 * lê a sidebar precisa saber que foi o app — e por onde se libera.
 */
export function scopeBlockNote(worktree: boolean, lang: Language): string {
  // O `{menu}` sai das MESMAS chaves que a razão do `deny` do core cita
  // (`core.escopo.menu.*`) e que o item do menu "⋯" usa: as três frases mandam
  // procurar o mesmo item, e ele muda de nome com a CERCA. Num workspace de
  // repositório o item se chama "Permitir acesso fora do repositório", e este
  // aviso dizendo "worktree" mandaria a pessoa procurar um item que não existe
  // naquele menu.
  const menu = tUi(lang, worktree ? 'core.escopo.menu.worktree' : 'core.escopo.menu.repo');
  return tUi(lang, 'sidebar.escopo.nota', { menu });
}

/**
 * O selo 🛡 da linha da sessão, ou `undefined` quando nada foi barrado.
 *
 * Os caminhos vão no `title` pelo mesmo motivo do selo do limite do servidor:
 * um contador sem os lugares seria um veredito sem prova, e a pessoa não
 * teria como julgar se a guarda pegou um acesso indevido ou um falso
 * positivo dela mesma.
 *
 * `crossAccess` (0.12.2) some com o selo: liberado o workspace, o selo
 * descreveria uma cerca que não existe mais, e era ele que o dono continuava
 * vendo depois de autorizar. Quem zera o contador de verdade é o core, no
 * `setWorkspaceCrossAccess`; esta linha é a rede — ela cobre o instante entre
 * o `PATCH` e o `session.updated`, e o snapshot que volta do banco ao reabrir
 * o app.
 */
export function scopeBlockBadge(
  session: Session,
  lang: Language,
  opts: { crossAccess?: boolean; worktree?: boolean } = {},
): ServerLimitBadge | undefined {
  if (opts.crossAccess === true) return undefined;
  const blocks = session.scopeBlocks;
  if (!blocks || blocks.count === 0) return undefined;
  const lines = blocks.paths.length > 0 ? `\n${blocks.paths.join('\n')}` : '';
  return {
    text: `${SCOPE_BLOCK_LABEL} ${blocks.count}`,
    title: `${scopeBlockNote(opts.worktree === true, lang)}${lines}`,
  };
}

/** O que a linha da fila mostra na sidebar. `undefined` = nada a mostrar. */
export interface LauncherQueueLine {
  text: string;
  title: string;
}

/**
 * A linha "2 sessões aguardando slot" da sidebar.
 *
 * `undefined` quando não há ninguém na fila: uma linha dizendo "0 na fila"
 * ocuparia espaço permanente pra informar a ausência de notícia. O motivo da
 * espera entra no `title`, porque "aguardando slot" e "aguardando o servidor
 * desafogar" pedem paciências diferentes.
 */
export function launcherQueueLine(status: LauncherStatus | undefined, lang: Language): LauncherQueueLine | undefined {
  if (!status || status.pending.length === 0) return undefined;
  const count = status.pending.length;
  const text = count === 1 ? tUi(lang, 'sidebar.fila.uma') : tUi(lang, 'sidebar.fila.varias', { n: count });
  const parts = [tUi(lang, 'sidebar.fila.ativos', { ativos: status.active, maximo: status.maxConcurrent })];
  if (status.serverLimited > 0) {
    parts.push(
      status.serverLimited === 1
        ? tUi(lang, 'sidebar.fila.limiteServidor.uma')
        : tUi(lang, 'sidebar.fila.limiteServidor.varias', { n: status.serverLimited }),
    );
  }
  // O último lançamento que falhou entra no tooltip da fila (fix round 1):
  // enquanto há gente esperando, é aqui que a pessoa olha, e um pendente que
  // morreu no caminho não pode sumir sem deixar recado.
  if (status.lastError) parts.push(launchErrorText(status.lastError, lang));
  return { text, title: [text, ...parts].join(' · ') };
}

/**
 * `o último lançamento falhou: <motivo>` — o texto do erro, num lugar só.
 *
 * `sanitizeDisplay` e não `truncate`: a mensagem nasce de um lançamento que
 * falhou (spawn do shell, `claude` que não subiu) e chega pela API, então é
 * texto de fora — a mesma disciplina de todo eco de erro do Bridge. O
 * `sanitizeDisplay` já trunca em 120 além de tirar sequência de terminal e
 * quebra de linha, que num tooltip de uma linha vira lixo visual.
 */
export function launchErrorText(error: NonNullable<LauncherStatus['lastError']>, lang: Language): string {
  return tUi(lang, 'sidebar.fila.erro', { motivo: sanitizeDisplay(error.message, 120) });
}

/**
 * A faixa que conta um lançamento que morreu na fila DEPOIS que a fila
 * esvaziou (fix round 1).
 *
 * Com pendentes na tela, o recado vai no tooltip da linha da fila — a linha já
 * está lá. Sem pendentes, a linha some, e sem esta faixa o erro sumia junto:
 * quem pediu um agente ficava com um painel vazio e nenhuma notícia. O 202 já
 * foi respondido lá atrás, então não há requisição pra devolver o erro.
 *
 * `undefined` quando não há erro, quando a fila ainda tem gente (o tooltip
 * cobre), ou quando o erro é mais velho que `maxAgeMs` — um recado de meia
 * hora atrás descreve um painel que a pessoa já resolveu.
 */
export const LAUNCH_ERROR_MAX_AGE_MS = 5 * 60 * 1000;

export function launcherErrorLine(
  status: LauncherStatus | undefined,
  now: number,
  lang: Language,
  maxAgeMs: number = LAUNCH_ERROR_MAX_AGE_MS,
): string | undefined {
  if (!status?.lastError || status.pending.length > 0) return undefined;
  if (now - status.lastError.at > maxAgeMs) return undefined;
  return launchErrorText(status.lastError, lang);
}
