// `Notification` NÃO entra aqui: o nome é o da API do browser usada nos toasts.
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';
import type {
  BridgeConfig,
  EnvironmentInfo,
  HelloState,
  KeybindingsResponse,
  LauncherStatus,
  QueuedLaunch,
  Session,
  UsageLimitWindow,
  UsageReport,
} from '@bridge/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  activateWorkspace,
  adoptTabIntoPane,
  closePane,
  closeTabById,
  closeWorkspace,
  createSessionInPane,
  focusPane,
  makeKeyHandlers,
  mergeWorkspace,
  newTabWithSession,
  openDiff,
  openShell,
  openWorkspaceFolder,
  removeWorktree,
  reopenWithRecap,
  revealSession,
  run,
  setWorkspaceEnvironment,
  setWorktreeBase,
  splitPaneById,
  toggleTrustFilters,
  toggleWorkspaceCrossAccess,
} from './actions.js';
import type { ActionDeps } from './actions.js';
import { api, ApiError, setToken } from './api.js';
import { getBridge, isElectron, NoTokenError, TOKEN_KEY } from './bridge.js';
import { NewTaskDialog } from './components/NewTaskDialog.js';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog.js';
import { NotificationsPanel } from './components/NotificationsPanel.js';
import { Pane } from './components/Pane.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, Sidebar } from './components/Sidebar.js';
import { SplitTree } from './components/SplitTree.js';
import { UsagePanel } from './components/UsagePanel.js';
import { environmentOfAction, isEnvironmentAction } from './components/sidebar/WorkspaceMenu.js';
import type { WorkspaceMenuAction } from './components/sidebar/WorkspaceMenu.js';
import { TabsBar } from './components/TabsBar.js';
import { FOCUS_HEARTBEAT_MS, shouldHeartbeat } from './focus.js';
import { LanguageProvider, tUi, uiLanguage, useT } from './i18n.js';
import { useKeybindings } from './keys.js';
import {
  restoreHintBanner,
  restoreResumeBanner,
  bannerFor,
  claimPendingHint,
  isPaneAlreadyBusy,
  makeCreatingWorkspaces,
  panesToRestore,
  pickRestoreMessage,
  restoreDecision,
  resumeFailureMessage,
} from './restore.js';
import { shouldAutoInjectRecap, showsRecapBanner } from './recap.js';
import { adoptableTabs, parseSplitAction, splitMenuItems } from './paneModel.js';
import type { SplitMenuAction } from './paneModel.js';
import { sessionLabel, stateCount } from './sidebarModel.js';
import { expandWorkspace, readGroupPrefs, writeGroupPrefs } from './sidebarPrefs.js';
import type { GroupPrefs } from './sidebarPrefs.js';
import { activeTabId, emptyUiState, leavesOf, reduce, sessionForPane, workspaceTabs } from './state.js';
import { DEFAULT_USAGE_PERIOD, touchesReport, usageQuery } from './usageModel.js';
import type { UsagePeriod } from './usageModel.js';
import type { UiAction, UiState } from './state.js';
import { bridgeWs } from './ws.js';

const STATUS_TIMEOUT_MS = 4000;
/** 401 no Electron: quantas vezes reler o token do preload antes de desistir. */
const TOKEN_RETRIES = 3;
const TOKEN_RETRY_MS = 500;
const SIDEBAR_WIDTH_KEY = 'bridgeSidebarWidth';

/** Largura guardada da sidebar, presa entre os limites do design (200–480). */
function storedSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }): JSX.Element {
  const { t } = useT();
  const [value, setValue] = useState('');
  return (
    <div className="token-screen">
      <form
        className="token-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="hint">{t('app.token.dica')}</div>
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          autoFocus
          placeholder="token"
        />
        <button type="submit" className="primary">
          {t('app.token.conectar')}
        </button>
      </form>
    </div>
  );
}

function StatusStrip({
  state,
  status,
  address,
}: {
  state: UiState;
  status?: string;
  address: string;
}): JSX.Element {
  const { t } = useT();
  const sessions = Object.values(state.sessions);
  // Por ESTADO, sem olhar `kind`: a sessão de shell que hospeda um Claude
  // Code entra nestes contadores como qualquer agente (`stateCount`).
  const count = (s: Session['state']): number => stateCount(sessions, s);
  return (
    <div className="status-strip mono">
      {status ? (
        <span className="status-message">{status}</span>
      ) : (
        <>
          <span>
            <span className="ring running strip" />
            {t('app.rodape.rodando', { n: count('running') })}
          </span>
          <span>
            <span className="ring needs-input strip static" />
            {t('app.rodape.pedemInput', { n: count('needs-input') })}
          </span>
          <span>
            <span className="ring stuck strip" />
            {t('app.rodape.travado', { n: count('stuck') })}
          </span>
          {/*
            Dor #1 — o contador do limite do SERVIDOR só aparece quando existe
            alguém nesse estado. Ele é raro e passa sozinho; um "0 no limite do
            servidor" permanente no rodapé seria ruído em 99 % do tempo.
          */}
          {count('server-limited') > 0 && (
            <span>
              <span className="ring server-limited strip" />
              {t('app.rodape.limiteServidor', { n: count('server-limited') })}
            </span>
          )}
        </>
      )}
      <span className="pane-spacer" />
      <span>
        {sessions.length === 1
          ? t('app.rodape.core.uma', { endereco: address })
          : t('app.rodape.core.varias', { endereco: address, n: sessions.length })}
      </span>
    </div>
  );
}

export function App(): JSX.Element {
  const [token, setTokenState] = useState<string | undefined>();
  const [needsToken, setNeedsToken] = useState(false);
  const [state, dispatchRaw] = useReducer(reduce, undefined, emptyUiState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [lastError, setLastError] = useState<string | undefined>();
  const [status, setStatusRaw] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  /**
   * Sobe a cada criação de workspace/tarefa ENCERRADA. Ele existe só pra entrar
   * nas dependências do efeito de restauração: sem isto, um workspace que ficou
   * ativo durante a criação inteira de outro nunca seria reexaminado — o efeito
   * só roda de novo quando o workspace ativo MUDA, e no fim quem muda é o
   * recém-criado (o `onCreated` ativa ele), não o que ficou esperando.
   *
   * O roteiro que isto conserta: a CLI cria o workspace C e o usuário está nele;
   * o diálogo começa a criar A; C vira `'wait'` e não restaura; A termina. Sem o
   * epoch, C só restauraria quando o usuário saísse dele e voltasse.
   */
  const [creationEpoch, setCreationEpoch] = useState(0);

  /**
   * Criações de workspace/tarefa **em voo** (não "diálogo aberto na tela": o
   * `Escape` e o "Cancelar" fecham o diálogo com o `POST` ainda correndo, e o
   * workspace aparece assim mesmo). Lido pelo efeito de restauração, via
   * `restoreDecision` — a explicação inteira está em `makeCreatingWorkspaces` e
   * `restoreDecision`.
   *
   * Cada criação é uma ENTRADA COM IDENTIDADE que carrega os ids de workspace
   * já existentes quando aquele pedido começou: é isso que escopa o pulo do
   * restore ao workspace que está nascendo, em vez de suprimir o de qualquer um
   * que vire ativo na janela. Identidade (e não uma pilha) porque duas criações
   * se cruzam e terminam fora de ordem.
   */
  const creatingWorkspaces = useRef(makeCreatingWorkspaces(() => setCreationEpoch((n) => n + 1))).current;

  /**
   * O que os diálogos chamam ao começar um pedido: devolve a função que encerra
   * ESTA criação, que eles chamam num `finally`. A marca nunca sai do desmonte
   * do componente — quem manda é o pedido, não a janela.
   */
  const beginCreating = useCallback(
    (): (() => void) => creatingWorkspaces.begin(stateRef.current.layout.workspaces.map((w) => w.id)),
    [creatingWorkspaces],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Painel "Uso" (ADR-012). O período vive AQUI e não no reducer porque ele é
   * escolha de quem está olhando a tela agora, como a seção do diálogo de
   * configurações — o relatório em si vai pro estado (`state.usage`), que é o
   * que o `usage.changed` precisa reler.
   *
   * É um objeto pequeno (`UsagePeriod`: recorte + âncora, ou de/até), e o
   * default é o mês corrente SEM âncora — que continua sendo "o mês de hoje"
   * se o painel ficar aberto na virada. Fechar o painel não o zera: reabrir
   * volta pro período que se estava olhando, como o recorte sempre fez.
   */
  const [usageOpen, setUsageOpen] = useState(false);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>(DEFAULT_USAGE_PERIOD);
  const [usageBusy, setUsageBusy] = useState(false);
  /**
   * O `{ files, entries, days }` da última releitura. Fica aqui (e não no
   * estado do core) porque é o retorno de UMA ação do dono: ele merece ver o
   * que o botão fez, e o número não descreve o estado do app.
   */
  const [usageRescanResult, setUsageRescanResult] = useState<{ files: number; entries: number; days: number } | undefined>();
  /**
   * Dor verificada #2 — os ambientes de sessão detectados pelo core. Estado
   * LOCAL do App: nada no reducer o altera (não há evento de ambiente), e o
   * core já responde com cache de 60 s.
   */
  const [environments, setEnvironments] = useState<readonly EnvironmentInfo[]>([]);
  // Lidos DENTRO do `dispatch`, que é criado uma vez e não pode capturar o
  // valor de um render antigo — o mesmo motivo do `stateRef`.
  const usageOpenRef = useRef(usageOpen);
  usageOpenRef.current = usageOpen;
  const usagePeriodRef = useRef(usagePeriod);
  usagePeriodRef.current = usagePeriod;
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [address, setAddress] = useState(() => (typeof location === 'undefined' ? '' : location.host));

  /**
   * O idioma em vigor: o `languageResolved` que o CORE resolveu, e o do browser
   * só enquanto o `GET /api/config` não voltou. Ele desce por duas vias — o
   * `LanguageProvider` (componentes) e as `deps` de `actions.ts` (frases de
   * status e confirmação) —, as duas recalculadas a cada render, o que faz a
   * troca valer ao vivo no `config.changed`.
   */
  const lang = uiLanguage(state.config);
  /** Pros callbacks estáveis (`clearToken`), que capturariam um idioma velho. */
  const langRef = useRef(lang);
  langRef.current = lang;

  const onSidebarWidth = useCallback((width: number) => {
    setSidebarWidth(width);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, []);

  /**
   * Fixado/recolhido da sidebar (grupos e, desde a 0.12.2, workspaces). Mora
   * AQUI e não na `Sidebar` porque o `revealSession` também mexe nisso: quando
   * o app leva você até uma sessão, a linha do workspace dela precisa estar
   * aberta, e essa ação nasce fora da sidebar (toast, painel de notificações,
   * `Ctrl+Shift+U`). Continua sendo preferência de quem olha a tela — o
   * `sidebarPrefs` segue puro, e é ele que decide o que gravar.
   */
  const [groupPrefs, setGroupPrefs] = useState<GroupPrefs>(readGroupPrefs);
  const onGroupPrefs = useCallback((next: GroupPrefs) => {
    setGroupPrefs(next);
    writeGroupPrefs(next);
  }, []);
  /**
   * Abre a linha do workspace, se ela estiver recolhida. A forma funcional do
   * `setState` é obrigatória: este callback é estável (vai pro `deps`, que o
   * `depsRef` guarda) e capturaria uma preferência velha. `expandWorkspace`
   * devolve o MESMO objeto quando não há nada a abrir — daí a comparação por
   * identidade, que evita gravação e re-render no caso comum.
   */
  const expandWorkspaceRow = useCallback((workspaceId: string) => {
    setGroupPrefs((prev) => {
      const next = expandWorkspace(prev, workspaceId);
      if (next !== prev) writeGroupPrefs(next);
      return next;
    });
  }, []);

  // No Electron a UI é servida pelo próprio core; no web ela vive no Vite e o
  // endereço que importa é o do host (o proxy é que fala com 4560).
  useEffect(() => {
    if (!isElectron()) return;
    void getBridge()
      .port()
      .then((port) => setAddress(`127.0.0.1:${port}`))
      .catch(() => {
        // Sem porta: fica o host mesmo.
      });
  }, []);

  /** Linha do rodapé: some sozinha (é aviso, não erro persistente). */
  const setStatus = useCallback((message: string | undefined) => {
    setStatusRaw(message);
  }, []);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatusRaw(undefined), STATUS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const clearToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(undefined);
    bridgeWs.disconnect();
    setTokenState(undefined);
    if (!isElectron()) {
      setNeedsToken(true);
      return;
    }
    /**
     * No Electron não existe formulário de token: o 401 quase sempre quer
     * dizer que o core reiniciou e o main já tem o token NOVO no preload — o
     * `main.ts` recarrega a janela nesse caso, mas o IPC pode responder antes
     * disso. Sem esta releitura a UI ficaria sem token nenhum e sem tela pra
     * pedir um: janela viva, morta por dentro. Três tentativas com 500 ms
     * cobrem a janela do restart do sidecar.
     */
    void (async () => {
      for (let attempt = 1; attempt <= TOKEN_RETRIES; attempt++) {
        await new Promise((res) => setTimeout(res, TOKEN_RETRY_MS));
        try {
          const value = await getBridge().token();
          if (value) {
            setTokenState(value);
            return;
          }
        } catch {
          // preload ainda sem instância: tenta de novo.
        }
      }
      setLastError(tUi(langRef.current, 'app.erro.semToken'));
    })();
  }, []);

  // Token: preload no Electron, localStorage no web. Sem token guardado no
  // web, cai no formulário; no Electron, nunca.
  useEffect(() => {
    let cancelled = false;
    void getBridge()
      .token()
      .then((value) => {
        if (!cancelled) setTokenState(value);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof NoTokenError) setNeedsToken(true);
        else setLastError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Sequência dos `GET /api/state` em voo. O snapshot SUBSTITUI as sessões do
   * estado (é a fonte da verdade), então uma resposta ATRASADA apaga o que
   * chegou depois dela pelo WS: na relançada, o `fetchState` da subida podia
   * ser atendido pelo core no meio da restauração — snapshot com um painel só
   * — e voltar depois dos dois `session.created`, deixando a sidebar com uma
   * linha e o core com duas sessões (o flake do 2º e2e). Só a resposta do
   * pedido MAIS NOVO é aplicada.
   */
  const fetchSeqRef = useRef(0);

  /**
   * O `GET /api/config` da subida, em voo. O `restorePanes` espera por ele
   * antes de decidir entre retomar o Claude e cair pro shell — ver o comentário
   * lá. Resolve com `undefined` quando a rota falha (core velho, rede): o
   * restore segue com o default de `@bridge/shared`, que é retomar.
   */
  const configReadyRef = useRef<Promise<BridgeConfig | undefined> | undefined>(undefined);

  const fetchState = useCallback(async (): Promise<void> => {
    const seq = ++fetchSeqRef.current;
    try {
      const s = await api<HelloState>('/api/state');
      if (seq !== fetchSeqRef.current) return;
      dispatchRaw({ type: 'hello', state: s });
      setLastError(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        return;
      }
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [clearToken]);

  /**
   * `GET /api/usage` do período que o painel está mostrando (ADR-012).
   *
   * Tem sequência própria, como o `fetchState`: trocar de recorte duas vezes
   * rápido dispara dois pedidos, e o "mês" chegando depois do "dia" deixaria a
   * cápsula marcando "dia" com os números do mês na tela. Com a navegação
   * (‹ ›) isso ficou mais provável, não menos — três cliques em "anterior" são
   * três pedidos em voo, e só o último pode chegar na tela.
   */
  const usageSeqRef = useRef(0);
  const fetchUsage = useCallback(async (period: UsagePeriod): Promise<void> => {
    const seq = ++usageSeqRef.current;
    try {
      const report = await api<UsageReport>(`/api/usage?${usageQuery(period)}`);
      if (seq !== usageSeqRef.current) return;
      dispatchRaw({ type: 'setUsage', value: report });
    } catch {
      // Core velho (sem a rota) ou erro de rede: o painel fica no "Somando…"
      // em vez de derrubar a janela. O rodapé do app não é o lugar disso —
      // quem abriu o painel está olhando pra ele.
    }
  }, []);

  /**
   * Só as janelas vivas — a faixa da sidebar precisa DELAS e de mais nada.
   * Pedir o relatório inteiro pra desenhar duas barras faria o core agregar um
   * mês de consumo a cada abertura de janela (contrato §4.2 da Task 1).
   *
   * Lista vazia é resposta legítima (conta de API key): a sidebar não desenha
   * nada, e o painel mostra o cartão "sem limites".
   */
  const fetchUsageLimits = useCallback(async (): Promise<void> => {
    try {
      const body = await api<{ limits: UsageLimitWindow[] }>('/api/usage/limits');
      dispatchRaw({ type: 'setUsageLimits', value: body.limits ?? [] });
    } catch {
      // Core sem a rota: fica sem limites, que é o mesmo estado de quem usa
      // chave de API.
    }
  }, []);

  /**
   * Dor verificada #1 — o estado do escalonador de lançamentos, buscado uma
   * vez por conexão (como as janelas de limite). Daí em diante quem atualiza é
   * o evento `launcher.changed`.
   */
  const fetchLauncher = useCallback(async (): Promise<void> => {
    try {
      const status = await api<LauncherStatus>('/api/launcher');
      dispatchRaw({ type: 'setLauncher', value: status });
    } catch {
      // Core sem a rota: a sidebar não desenha fila nenhuma, que é o mesmo
      // efeito de uma fila vazia.
    }
  }, []);

  /** "Lançar agora": solta o próximo da fila ignorando o escalonador. */
  const onLaunchNow = useCallback(() => {
    void api('/api/launcher/launch-now', { method: 'POST', body: {} }).catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : String(err));
    });
  }, [setStatus]);

  /**
   * Último `POST /api/focus`. O gate do poller de git do core (`shouldPollGit`)
   * descarta foco com mais de 60 s, então este instante é o que o batimento
   * abaixo consulta pra saber se precisa reafirmar.
   */
  const lastFocusPostRef = useRef(0);

  const postFocus = useCallback((windowFocused: boolean): void => {
    lastFocusPostRef.current = Date.now();
    const sessionId = stateRef.current.focusedSessionId;
    void api('/api/focus', { method: 'POST', body: { sessionId, windowFocused } }).catch(() => {
      // Foco é telemetria de janela: falhar aqui não merece faixa de erro.
    });
  }, []);

  /** Primeiro `hello` da vida do app — o gatilho do foco inicial. */
  const focusPrimedRef = useRef(false);
  /** BR-07: o dono fechou o banner da ACL nesta execução (✕). */
  const [aclBannerDismissed, setAclBannerDismissed] = useState(false);

  // Restauração da Task 9b: painéis de aba de terminal que reabrem sem
  // sessão viram um shell automático; o que era Claude Code ganha uma dica no
  // topo do terminal novo. `restoreRanRef` garante que só o PRIMEIRO `hello`
  // da vida do app dispara isto — nem o StrictMode (o ref sobrevive ao
  // remount de desenvolvimento) nem uma reconexão de WS repetem a restauração.
  const restoreRanRef = useRef(false);
  /**
   * Sessões (não painéis!) que o restore criou pra um painel que tinha
   * hospedado Claude Code, e o banner de cada uma. Chavear pelo `paneId`
   * faria a dica migrar pra qualquer sessão futura naquele painel — inclusive
   * um Claude Code de verdade aberto depois que a sessão restaurada morreu.
   * `useState` (não `ref`) porque `bannerFor` roda durante o render em
   * `renderLeaf`. O VALOR é o texto do banner porque a 0.6.0 tem dois: o
   * painel que voltou como Claude diz "retomando…", o que voltou como shell
   * continua com a dica do `Ctrl+Shift+C`.
   */
  const [restoredBanners, setRestoredBanners] = useState<Map<string, string>>(() => new Map());
  /**
   * PaneIds de restore com `hint:true` cuja sessão ainda não foi confirmada.
   * Existe porque o core emite `session.created` pelo WS de dentro de
   * `Sessions.create()` — SÍNCRONO, antes de responder o `POST /api/sessions`
   * que o disparou — então o evento pode chegar antes da Promise do `api()`
   * resolver. Sem isto, o `Terminal` da sessão restaurada monta (via o
   * `session.created` recebido primeiro) com `restoredBanners` ainda vazio,
   * e o efeito de montagem (só depende de `sessionId`) nunca mais escreve a
   * dica depois. É `ref`, não `state`: só é lido dentro do `dispatch`, nunca
   * durante o render.
   */
  const pendingHintPanesRef = useRef<Map<string, string>>(new Map());

  const promoteRestoredSession = useCallback((sessionId: string, banner: string) => {
    setRestoredBanners((prev) => {
      if (prev.get(sessionId) === banner) return prev;
      const next = new Map(prev);
      next.set(sessionId, banner);
      return next;
    });
  }, []);

  /** O "✕" da faixa do painel restaurado: some com ela, e só nesta sessão. */
  const dismissRestoredBanner = useCallback((sessionId: string) => {
    setRestoredBanners((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  /**
   * R3 — workspaces já restaurados. O restore roda uma vez por workspace: na
   * subida só pro ativo (é o único com terminal montado) e depois na primeira
   * vez que cada um dos outros é ativado. É `ref` porque só é lido dentro de
   * callbacks/efeitos, nunca durante o render.
   */
  const restoredWorkspacesRef = useRef<Set<string>>(new Set());

  /**
   * R9 — painéis cujo shell de restauração está EM VOO. Sem esta trava, o
   * mesmo painel podia receber dois `POST /api/sessions`: o `hello` dispara o
   * restore do workspace inicial e a ativação daquele mesmo workspace (o
   * efeito abaixo) chega logo em seguida — o segundo pedido levava 409
   * "painel já tem uma sessão ativa" e virava faixa de status pro usuário, por
   * uma corrida interna da UI.
   */
  const restoringPanesRef = useRef<Set<string>>(new Set());

  const restorePanes = useCallback(async (state: HelloState, workspaceId: string): Promise<void> => {
    /**
     * 0.6.0 — a config decide se o painel de agente volta como Claude ou como
     * shell, e ela NÃO vem no `hello` (é uma rota própria, buscada em paralelo
     * na subida). Sem esta espera, o restore da primeira subida corria a favor
     * do relógio: com a resposta do `GET /api/config` atrasada, um dono que
     * tinha DESLIGADO o resume veria os Claudes subirem do mesmo jeito. O
     * `await` é antes de qualquer trava porque o filtro e a marcação abaixo
     * continuam num bloco síncrono só — duas chamadas concorrentes ainda se
     * excluem pelo `restoringPanesRef`.
     */
    const config = stateRef.current.config ?? (await configReadyRef.current);
    const entries = panesToRestore(state.layout, state.sessions, workspaceId, config?.restore.resumeAgents).filter(
      (entry) => !restoringPanesRef.current.has(entry.paneId),
    );
    if (entries.length === 0) return;

    for (const entry of entries) {
      restoringPanesRef.current.add(entry.paneId);
      if (entry.resume)
        pendingHintPanesRef.current.set(entry.paneId, restoreResumeBanner(langRef.current, entry.resume.sessionId));
      else if (entry.hint) pendingHintPanesRef.current.set(entry.paneId, restoreHintBanner(langRef.current));
    }

    /** Primeiro resume que falhou — ver `pickRestoreMessage`. */
    let resumeMessage: string | undefined;

    /** Painéis cujo agente entrou na FILA do escalonador (202) — ver abaixo. */
    const queuedPanes = new Set<string>();

    /**
     * Em PARALELO (`allSettled`), não em série: cada painel é um `pwsh` que
     * leva o seu tempo pra subir, e em série o segundo painel do split só
     * começava a existir depois do primeiro estar de pé — no e2e da
     * relançada isso batia no timeout de vez em quando. `allSettled` porque um
     * painel que falha não pode impedir os outros de voltarem.
     */
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          if (entry.resume) {
            const banner = restoreResumeBanner(langRef.current, entry.resume.sessionId);
            try {
              const created = await api<Session | QueuedLaunch>('/api/sessions', {
                method: 'POST',
                body: {
                  paneId: entry.paneId,
                  kind: 'agent',
                  agent: entry.resume.agent,
                  // Sem id o campo é OMITIDO, nunca mandado vazio: o schema do
                  // core recusa string vazia com 400. O painel sobe um Claude
                  // limpo — que é a regra do plano (nada de `--continue`).
                  ...(entry.resume.sessionId ? { resume: entry.resume.sessionId } : {}),
                },
              });
              /**
               * Dor verificada #1 — o escalonador segurou este lançamento
               * (202). A restauração de um workspace com vários painéis é
               * JUSTAMENTE a rajada que provoca o limite do servidor, então
               * ela é o caso mais comum daqui.
               *
               * A dica do painel fica PENDENTE em vez de ser descartada: quem
               * a reivindica é o `session.created` que vai chegar quando a
               * fila andar (`claimPendingHint`, por painel). Sem isto o
               * terminal restaurado apareceria sem a faixa "sessão retomada".
               */
              if ('queued' in created) {
                queuedPanes.add(entry.paneId);
                return;
              }
              promoteRestoredSession(created.id, banner);
              return;
            } catch (err) {
              // 409 é o painel que alguém já ocupou (R9): silêncio, e quem
              // decide é o agregado lá embaixo — não vale tentar shell por cima.
              if (isPaneAlreadyBusy(err)) throw err;
              // O Claude não subiu (sumiu do PATH, cwd que não existe mais, 500
              // do core). O painel não pode ficar vazio: cai pro shell com a
              // dica antiga, e a faixa conta o motivo. A mensagem é guardada em
              // vez de exibida na hora porque o shell de queda pode falhar
              // logo em seguida, e aí o agregado passaria por cima dela.
              resumeMessage ??= resumeFailureMessage(err, langRef.current);
              pendingHintPanesRef.current.set(entry.paneId, restoreHintBanner(langRef.current));
            }
          }

          const session = await api<Session>('/api/sessions', {
            method: 'POST',
            body: { paneId: entry.paneId, kind: 'shell' },
          });
          // Marcação de resposta HTTP: cai fora se o `session.created` do WS já
          // promoveu essa sessão (idempotente — `promoteRestoredSession` já
          // ignora id repetido); é o caminho de fallback quando o evento chega
          // depois da resposta em vez de antes (ordem não é garantida).
          if (entry.hint) promoteRestoredSession(session.id, restoreHintBanner(langRef.current));
        } finally {
          // Painel na fila mantém a dica pendente: ela é reivindicada pelo
          // `session.created` que chega quando o lançamento sair da fila.
          if (!queuedPanes.has(entry.paneId)) pendingHintPanesRef.current.delete(entry.paneId);
          restoringPanesRef.current.delete(entry.paneId);
        }
      }),
    );

    const message = pickRestoreMessage(
      resumeMessage,
      results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason),
      // `restorePanes` é um callback ESTÁVEL: um `lang` capturado aqui
      // congelaria o idioma da faixa de status na primeira montagem.
      langRef.current,
    );
    if (message) setStatus(message);

    // Convergência: um snapshot pedido ANTES daqui pode ter sido montado no
    // meio da restauração. Este pedido sai depois de todas as sessões
    // existirem, e o guard de sequência descarta os anteriores.
    void fetchState();
  }, [fetchState, promoteRestoredSession, setStatus]);

  const dispatch = useCallback(
    (action: UiAction) => {
      dispatchRaw(action);

      if (action.type === 'hello') {
        /**
         * Resíduo da revisão da Fase 3: o poller de git do core só roda com
         * foco de janela fresco. Sem este primeiro POST, quem abria o Bridge e
         * ficava lendo o terminal — sem trocar de painel e sem tirar/devolver
         * o foco da janela — nunca abria o gate, e os `+N ~M` das tarefas
         * nasciam congelados.
         */
        if (!focusPrimedRef.current) {
          focusPrimedRef.current = true;
          postFocus(typeof document === 'undefined' ? true : document.hasFocus());
        }
      }

      if (action.type === 'hello' && !restoreRanRef.current) {
        restoreRanRef.current = true;
        // R3: só o workspace que a UI vai montar de fato. O reducer escolhe o
        // ativo do mesmo jeito (`pickActiveWorkspace`: o primeiro da lista).
        const first = action.state.layout.workspaces[0]?.id;
        if (first) {
          restoredWorkspacesRef.current.add(first);
          void restorePanes(action.state, first);
        }
      }

      // Ponta do fix da corrida: o `session.created` pode ser a PRIMEIRA
      // notícia da sessão restaurada, antes da Promise do POST resolver.
      if (action.type === 'event' && action.event.type === 'session.created') {
        const claimed = claimPendingHint(pendingHintPanesRef.current, action.event.session);
        if (claimed) {
          pendingHintPanesRef.current.delete(action.event.session.paneId);
          promoteRestoredSession(claimed.sessionId, claimed.banner);
        }
      }

      // A sessão restaurada morreu de vez (não só "exited" — removida) — a
      // dica não pertence a mais nada, tira do conjunto pra não acumular.
      if (action.type === 'event' && action.event.type === 'session.removed') {
        const removedId = action.event.id;
        setRestoredBanners((prev) => {
          if (!prev.has(removedId)) return prev;
          const next = new Map(prev);
          next.delete(removedId);
          return next;
        });
      }

      if (action.type === 'event' && action.event.type === 'layout.changed') {
        void fetchState();
      }

      /**
       * ADR-012 — o evento manda só os DIAS que a varredura tocou, não os
       * números: o painel decide se o recorte que ele mostra foi afetado e, se
       * foi, relê. Um dia de agosto tocado por um transcript antigo não muda o
       * "hoje" na tela, e reler à toa a cada passada do poller (60 s) faria o
       * core agregar um mês inteiro por nada.
       *
       * As janelas de limite vêm no MESMO evento e não dependem do painel
       * estar aberto: elas alimentam a faixa da sidebar, e o reducer já as
       * guardou.
       */
      if (action.type === 'event' && action.event.type === 'usage.changed') {
        const touched = action.event.dailyTouched;
        if (usageOpenRef.current && touchesReport(stateRef.current.usage, touched)) {
          void fetchUsage(usagePeriodRef.current);
        }
      }

      if (action.type === 'event' && action.event.type === 'notification.new' && action.event.toast) {
        const n = action.event.notification;
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const workspace = stateRef.current.layout.workspaces.find((w) => w.id === n.workspaceId);
          const toast = new Notification(`Bridge · ${workspace?.name ?? n.workspaceId}`, { body: n.text });
          // `depsRef` já está preenchido quando o clique acontece (o toast só
          // existe depois do primeiro render).
          toast.onclick = () => run(depsRef.current, 'session.reveal', () => revealSession(depsRef.current, n.sessionId));
        }
      }

      /**
       * `bridge focus <sessão>`: o core avisa que alguém de FORA pediu pra ver
       * a sessão. O mesmo caminho do clique no toast — workspace, aba, painel
       * e janela.
       */
      if (action.type === 'event' && action.event.type === 'session.reveal') {
        const revealId = action.event.id;
        run(depsRef.current, 'session.reveal', () => revealSession(depsRef.current, revealId));
      }
    },
    [fetchState, restorePanes, promoteRestoredSession, postFocus, fetchUsage],
  );

  useEffect(() => {
    if (!token) return;
    setToken(token);
    setNeedsToken(false);
    if (!isElectron()) localStorage.setItem(TOKEN_KEY, token);

    void fetchState();
    // `KeybindingsResponse` e não `Keybindings`: o corpo traz, junto das
    // ações, o campo irmão `problems` com o que o core achou de errado ao ler
    // o `keybindings.json` (JSON quebrado, ação desconhecida, valor que não é
    // texto). O reducer separa os dois; o diálogo mostra os problemas na mesma
    // faixa dos que a própria UI deduz da tabela.
    void api<KeybindingsResponse>('/api/keybindings')
      .then((value) => dispatchRaw({ type: 'setKeybindings', value }))
      .catch(() => {
        // Sem a rota (core velho) ou com erro: seguem os defaults de @bridge/shared.
      });
    // A config não vem no `hello` (ela não é layout nem sessão): é uma rota
    // própria, buscada uma vez por conexão. Daí em diante quem atualiza é o
    // evento `config.changed` do `/ws` — inclusive quando quem mexeu foi
    // OUTRA janela do Bridge ou um PATCH feito na mão pela API.
    configReadyRef.current = api<BridgeConfig>('/api/config')
      .then((value) => {
        dispatchRaw({ type: 'setConfig', value });
        // Devolvido, e não lido do `stateRef`, porque o `dispatchRaw` só chega
        // ao `stateRef` no próximo render — e quem espera esta Promise (o
        // `restorePanes`) roda antes disso.
        return value;
      })
      .catch(() => {
        // Sem a rota (core velho) ou com erro: o terminal usa `TERMINAL_DEFAULTS`,
        // o diálogo abre mostrando os defaults e o restore segue no default.
        return undefined;
      });
    // ADR-012: as janelas de limite não vêm no `hello` (elas não são layout
    // nem sessão) — é uma rota própria, buscada uma vez por conexão. Daí em
    // diante quem atualiza é o `usage.changed` do `/ws`.
    void fetchUsageLimits();
    // Mesma disciplina do `usage/limits`: uma busca por conexão, e o resto
    // chega pelo evento `launcher.changed`.
    void fetchLauncher();
    bridgeWs.connect(token, dispatch);
    return () => {
      bridgeWs.disconnect();
    };
  }, [token, dispatch, fetchState, fetchUsageLimits, fetchLauncher]);

  /**
   * R3 — workspace ativado pela primeira vez: agora ele vai montar terminal,
   * então agora é a hora de reabrir os shells dos painéis dele (spec §10). Na
   * subida isto não dispara pro workspace inicial (o `dispatch` do `hello` já
   * marcou ele como restaurado) nem pros criados nesta sessão (marcados no
   * `onCreated` do diálogo — workspace novo nasce como o usuário pediu, não
   * com um shell automático por cima).
   */
  useEffect(() => {
    const workspaceId = state.activeWorkspaceId;
    if (!token || !workspaceId) return;
    // A regra (e o porquê de cada saída) está em `restoreDecision`. A marca só
    // é gravada quando o restore ROLA: `'wait'` (criação em voo que pode ser
    // este workspace) volta a valer na próxima ativação, e o workspace que a
    // criação criou de fato já foi marcado pelo `onCreated` do diálogo.
    const decision = restoreDecision({
      creating: creatingWorkspaces.isCreating(workspaceId),
      restored: restoredWorkspacesRef.current.has(workspaceId),
    });
    if (decision !== 'restore') return;
    restoredWorkspacesRef.current.add(workspaceId);
    const snapshot: HelloState = {
      layout: stateRef.current.layout,
      sessions: Object.values(stateRef.current.sessions),
      unread: stateRef.current.unread,
    };
    void restorePanes(snapshot, workspaceId);
    // `creationEpoch` nas dependências: quando uma criação termina, o workspace
    // que estava esperando (`'wait'`) é reexaminado sem depender de o usuário
    // trocar de workspace e voltar.
  }, [token, state.activeWorkspaceId, creationEpoch, creatingWorkspaces, restorePanes]);

  /**
   * Dor verificada #2 — os ambientes de sessão desta máquina, uma vez por
   * conexão. Fica num `useState` local (e não no reducer) porque é uma lista
   * QUE NÃO MUDA sozinha: nenhum evento do core a atualiza, e o core já a
   * guarda em cache por 60 s. Lista vazia enquanto não chega — o selo e o menu
   * tratam a ausência sem inventar aviso nenhum.
   */
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void api<{ environments: EnvironmentInfo[] }>('/api/environments')
      .then((res) => {
        if (alive) setEnvironments(res.environments);
      })
      // Core de versão anterior não tem a rota: sem ambiente detectado a UI
      // continua funcionando com o `shell` da configuração global.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [token, state.connected]);

  /**
   * Painel aberto (ou período trocado) → um `GET /api/usage`. Fechar LIMPA o
   * relatório: ele é o retrato de um período, e reabrir três horas depois com
   * os números de antes na tela — antes do GET novo voltar — mostraria custo
   * velho como se fosse o de agora.
   *
   * A dependência é o OBJETO do período: as funções do `usageModel` devolvem
   * o mesmo objeto quando nada muda (seta desligada, mesmo recorte), então um
   * clique que não mexe no período não dispara GET.
   */
  useEffect(() => {
    if (!token) return;
    if (!usageOpen) {
      dispatchRaw({ type: 'setUsage', value: undefined });
      return;
    }
    void fetchUsage(usagePeriod);
  }, [token, usageOpen, usagePeriod, fetchUsage]);

  /** `POST /api/usage/rescan` — o CTA do estado vazio e o botão das configurações. */
  const onUsageRescan = useCallback(() => {
    setUsageBusy(true);
    setUsageRescanResult(undefined);
    void api<{ files: number; entries: number; days: number }>('/api/usage/rescan', { method: 'POST' })
      .then(async (result) => {
        setUsageRescanResult(result);
        await fetchUsage(usagePeriodRef.current);
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
      .finally(() => setUsageBusy(false));
  }, [fetchUsage, setStatus]);

  // Foco/blur da janela alimentam a política de toast do core.
  useEffect(() => {
    if (!token) return;
    const onFocus = (): void => postFocus(true);
    const onBlur = (): void => postFocus(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [token, postFocus]);

  /**
   * Batimento do foco (resíduo da Fase 3): a janela pode ficar horas em foco
   * sem nenhum `focus`/`blur` e sem troca de painel — e o gate do poller de
   * git do core vence em 60 s. O tique é metade do intervalo pra que um tique
   * perdido ainda caiba no prazo.
   */
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      if (!shouldHeartbeat(document.visibilityState, lastFocusPostRef.current, Date.now())) return;
      postFocus(document.hasFocus());
    }, FOCUS_HEARTBEAT_MS / 2);
    return () => clearInterval(timer);
  }, [token, postFocus]);

  /** Contagem de não lidas: bandeja no Electron, título da aba no web. */
  useEffect(() => {
    getBridge().setBadge(state.unread.length);
  }, [state.unread.length]);

  // Trava de ação em voo: vive fora do render, senão cada `dispatch` a zeraria.
  const inflight = useRef(new Set<string>()).current;
  const deps: ActionDeps = useMemo(
    () => ({
      state,
      lang,
      // O `stateRef` acompanha cada render; `state` aqui é o snapshot deste.
      latestState: () => stateRef.current,
      dispatch,
      api,
      setStatus,
      openWorkspaceDialog: () => setDialogOpen(true),
      openTaskDialog: () => setTaskDialogOpen(true),
      openSettingsDialog: () => setSettingsOpen(true),
      openUsagePanel: () => setUsageOpen(true),
      inflight,
      confirm: (m: string) => window.confirm(m),
      windowFocused: () => document.hasFocus(),
      focusWindow: () => getBridge().focusWindow(),
      openPath: (p: string) => getBridge().openPath(p),
      prompt: (m: string, initial?: string) => window.prompt(m, initial),
      expandWorkspaceRow,
    }),
    [state, lang, dispatch, setStatus, inflight, expandWorkspaceRow],
  );
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // Clique no toast nativo (Electron) → foca sessão, workspace e aba.
  useEffect(() => {
    return getBridge().onFocusSession(({ sessionId }) => {
      const current = depsRef.current;
      run(current, 'session.reveal', () => revealSession(current, sessionId));
    });
  }, []);

  // Diálogo aberto engole os atalhos: o `Enter` do formulário não pode virar
  // "nova aba" nem o `Esc` fechar o que não é o diálogo.
  /**
   * `usage.showCost` (ADR-012). O default é MOSTRAR: enquanto o
   * `GET /api/config` não volta — e contra um core velho sem o campo — o
   * painel e a sidebar já escrevem o custo, que é a decisão do dono. Cair no
   * "não mostrar" faria o dinheiro piscar na tela quando a config chegasse.
   */
  const showCost = state.config?.usage?.showCost ?? true;
  // Dor #4 — o interruptor geral da guarda de escopo. `?? true` porque o
  // default é LIGADA: enquanto o `GET /api/config` está em voo, o menu já
  // oferece o item que a configuração vai confirmar.
  const scopeGuard = state.config?.sessions?.scopeGuard ?? true;

  const anyDialogOpen = dialogOpen || taskDialogOpen || settingsOpen || usageOpen;
  const handlers = useMemo(() => (anyDialogOpen ? {} : makeKeyHandlers(deps)), [deps, anyDialogOpen]);
  useKeybindings(state.keybindings, handlers);

  /**
   * Clique/foco num painel. O `dispatch` é dispensável quando o painel JÁ é o
   * focado, mas o `POST /api/focus` não: ele é o que mantém aceso o gate do
   * poller de git do core (spec §7) enquanto o usuário só trabalha dentro do
   * mesmo painel.
   */
  const onFocusPane = useCallback(
    (paneId: string) => {
      const current = depsRef.current;
      if (current.state.focusedPaneId === paneId) {
        postFocus(current.windowFocused());
        return;
      }
      run(current, undefined, () => focusPane(current, paneId));
    },
    [postFocus],
  );

  const onRatio = useCallback((paneId: string, siblingPaneId: string, ratio: number) => {
    const current = depsRef.current;
    run(current, undefined, async () => {
      await current.api(`/api/panes/${paneId}/ratio`, { method: 'POST', body: { ratio, siblingPaneId } });
    });
  }, []);

  const onRevealSession = useCallback((sessionId: string) => {
    const current = depsRef.current;
    run(current, 'session.reveal', () => revealSession(current, sessionId));
  }, []);

  const onActivateWorkspace = useCallback((workspaceId: string) => {
    const current = depsRef.current;
    if (current.state.activeWorkspaceId === workspaceId) return;
    run(current, undefined, () => activateWorkspace(current, workspaceId));
  }, []);

  // Confirmação só quando a sessão está viva: encerrar uma já morta não perde nada.
  const onKillSession = useCallback((session: Session) => {
    const current = depsRef.current;
    const label = sessionLabel(session, current.lang);
    if (session.state !== 'exited' && !current.confirm(tUi(current.lang, 'actions.sessao.encerrar', { rotulo: label })))
      return;
    run(current, `session.kill:${session.id}`, async () => {
      await current.api(`/api/sessions/${session.id}`, { method: 'DELETE' });
    });
  }, []);

  /**
   * Menu "⋯" da linha do workspace. Cada entrada é uma ação de `actions.ts`;
   * a trava é por workspace, então dois menus diferentes não se atrapalham.
   */
  const onWorkspaceMenu = useCallback((workspaceId: string, action: WorkspaceMenuAction) => {
    const current = depsRef.current;
    const lock = `workspace.menu:${workspaceId}` as const;
    if (action === 'explorer') {
      openWorkspaceFolder(current, workspaceId);
      return;
    }
    if (action === 'newClaude' || action === 'newShell') {
      run(current, lock, () => newTabWithSession(current, workspaceId, action === 'newClaude' ? 'agent' : 'shell'));
      return;
    }
    if (action === 'diff') {
      run(current, lock, () => openDiff(current, workspaceId));
      return;
    }
    if (action === 'merge') {
      run(current, lock, () => mergeWorkspace(current, workspaceId));
      return;
    }
    if (action === 'removeWorktree') {
      run(current, lock, () => removeWorktree(current, workspaceId));
      return;
    }
    if (action === 'setBase') {
      run(current, lock, () => setWorktreeBase(current, workspaceId));
      return;
    }
    if (action === 'trustFilters') {
      run(current, lock, () => toggleTrustFilters(current, workspaceId));
      return;
    }
    // Dor #4: "Permitir acesso fora do worktree" / "Restringir". Vale na hora
    // — a guarda é consultada a cada `PreToolUse`.
    if (action === 'crossAccess') {
      run(current, lock, () => toggleWorkspaceCrossAccess(current, workspaceId));
      return;
    }
    // Dor #2: "Ambiente: …". O id vem no sufixo da ação (`environment:wsl:Ubuntu`);
    // sufixo vazio volta pro padrão do Bridge.
    if (isEnvironmentAction(action)) {
      const envId = environmentOfAction(action);
      run(current, lock, () => setWorkspaceEnvironment(current, workspaceId, envId));
      return;
    }
    run(current, lock, () => closeWorkspace(current, workspaceId));
  }, []);

  /**
   * Painéis com um `POST /api/sessions` em voo. A trava `inflight` do
   * `ActionDeps` já basta pra lógica (ela vive num `ref` e é o que o
   * `closePane` consulta), mas ela NÃO redesenha: sem este estado os botões do
   * painel vazio continuariam clicáveis enquanto a sessão nasce, oferecendo um
   * "Fechar painel" que a ação vai recusar.
   */
  const [creatingPanes, setCreatingPanes] = useState<ReadonlySet<string>>(() => new Set());
  const markCreating = useCallback((paneId: string, on: boolean) => {
    setCreatingPanes((prev) => {
      if (prev.has(paneId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(paneId);
      else next.delete(paneId);
      return next;
    });
  }, []);

  /**
   * Dor verificada #3 — as três marcas do "resume voltou vazio", todas por
   * `session.id` (não por painel: o painel sobrevive à sessão, e um resume
   * vazio meia hora depois no mesmo lugar é outro aviso).
   *
   * - `dismissedRecap`: o dono apertou "Ignorar". Estado, porque a faixa é
   *   desenhada no render;
   * - `injectedRecap`: a injeção AUTOMÁTICA já rodou pra esta sessão. Também
   *   estado, porque ela dispensa a faixa junto — sem isso o efeito abaixo
   *   dispararia de novo a cada render;
   * - `recapBusy`: os dois pedidos do botão estão em voo (o botão apaga).
   */
  const [dismissedRecap, setDismissedRecap] = useState<ReadonlySet<string>>(() => new Set());
  const [injectedRecap, setInjectedRecap] = useState<ReadonlySet<string>>(() => new Set());
  const [recapBusy, setRecapBusy] = useState<ReadonlySet<string>>(() => new Set());

  const markRecapBusy = useCallback((sessionId: string, on: boolean) => {
    setRecapBusy((prev) => {
      if (prev.has(sessionId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const onDismissRecap = useCallback((sessionId: string) => {
    setDismissedRecap((prev) => (prev.has(sessionId) ? prev : new Set(prev).add(sessionId)));
  }, []);

  /**
   * "Reabrir com contexto" — e o mesmo caminho da injeção automática.
   *
   * A faixa some SEMPRE que o pedido termina, dando certo ou errado: quem
   * apertou já sabe o que aconteceu (a linha de status diz), e deixar a faixa
   * de pé convidaria a apertar de novo um botão cuja falha é do transcript que
   * não existe mais, não do clique.
   */
  const onRecap = useCallback(
    (sessionId: string) => {
      const current = depsRef.current;
      const lock = `session.recap:${sessionId}` as const;
      if (current.inflight.has(lock)) return;
      markRecapBusy(sessionId, true);
      run(current, lock, async () => {
        try {
          await reopenWithRecap(current, sessionId);
        } finally {
          markRecapBusy(sessionId, false);
          onDismissRecap(sessionId);
        }
      });
    },
    [markRecapBusy, onDismissRecap],
  );

  /**
   * `sessions.autoRecap` ligado: o resumo entra sozinho no primeiro resume que
   * voltar vazio. O efeito olha as sessões a cada render porque o veredito
   * chega por evento (`session.updated`), não por resposta de pedido; a marca
   * `injectedRecap` é o que o mantém uma vez por sessão.
   *
   * Quem decide é `shouldAutoInjectRecap`, e ele exige `session.sawOutput` —
   * o primeiro byte do PTY. São DOIS `session.updated` possíveis (o do
   * veredito e o do primeiro byte), em qualquer ordem: o efeito roda nos dois
   * e injeta quando o segundo chegar.
   */
  useEffect(() => {
    for (const session of Object.values(state.sessions)) {
      if (!shouldAutoInjectRecap(session, state.config, dismissedRecap, injectedRecap)) continue;
      setInjectedRecap((prev) => (prev.has(session.id) ? prev : new Set(prev).add(session.id)));
      onRecap(session.id);
    }
  }, [state.sessions, state.config, dismissedRecap, injectedRecap, onRecap]);

  /**
   * Abrir shell (Enter e botão) ou Claude Code (botão) NESTE painel. O botão do
   * Claude não passa pelo `agent.claude`: aquele mira o painel focado e
   * dividiria se ele estivesse ocupado, o que não é o que o botão de um painel
   * vazio promete.
   */
  /**
   * Menu "Dividir" do cabeçalho do painel: split vazio ou adoção de uma aba
   * (pedido do dono, 10/09/2026). Trava por painel, como o ✕.
   */
  const onPaneSplit = useCallback((paneId: string, action: SplitMenuAction) => {
    const current = depsRef.current;
    const { dir, tabId } = parseSplitAction(action);
    run(current, `pane.split:${paneId}`, () =>
      tabId ? adoptTabIntoPane(current, paneId, dir, tabId) : splitPaneById(current, paneId, dir),
    );
  }, []);

  const onCreateInPane = useCallback(
    (paneId: string, kind: 'shell' | 'agent') => {
      const current = depsRef.current;
      const lock = kind === 'agent' ? (`pane.openClaude:${paneId}` as const) : (`pane.openShell:${paneId}` as const);
      if (current.inflight.has(lock)) return;
      markCreating(paneId, true);
      run(current, lock, async () => {
        try {
          if (kind === 'agent') await createSessionInPane(current, paneId, 'agent', 'claude');
          else await openShell(current, paneId);
        } finally {
          // Também no erro: o painel continua vazio e os botões voltam.
          markCreating(paneId, false);
        }
      });
    },
    [markCreating],
  );

  /**
   * ✕ do cabeçalho do painel e o botão "Fechar painel" do painel vazio. A
   * trava é por painel: fechar dois painéis diferentes ao mesmo tempo é
   * legítimo, clicar duas vezes no mesmo ✕ não.
   */
  const onClosePane = useCallback((paneId: string) => {
    const current = depsRef.current;
    run(current, `pane.close:${paneId}`, () => closePane(current, paneId));
  }, []);

  /** ✕ / botão do meio na barra de abas. */
  const onCloseTab = useCallback((tabId: string) => {
    const current = depsRef.current;
    run(current, `tab.close:${tabId}`, () => closeTabById(current, tabId));
  }, []);

  const onMarkRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const current = depsRef.current;
    run(current, undefined, async () => {
      await current.api('/api/notifications/read', { method: 'POST', body: { ids } });
    });
  }, []);

  if (needsToken) {
    return (
      <LanguageProvider config={state.config}>
        <TokenForm onSubmit={setTokenState} />
      </LanguageProvider>
    );
  }

  const activeWorkspace = state.layout.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tabsOfActive = activeWorkspace ? workspaceTabs(state.layout, activeWorkspace.id) : [];
  const activeTab = activeTabId(state, state.activeWorkspaceId);
  const panesByTab: Record<string, string[]> = {};
  for (const tab of state.layout.tabs) {
    const fromTree = leavesOf(state.layout.layouts[tab.id]);
    panesByTab[tab.id] = fromTree.length > 0 ? fromTree : state.layout.panes.filter((p) => p.tabId === tab.id).map((p) => p.id);
  }
  const sessions = Object.values(state.sessions);

  function renderLeaf(paneId: string, visible: boolean): JSX.Element {
    const pane = state.layout.panes.find((p) => p.id === paneId);
    if (!pane) return <div className="pane pane-missing" key={paneId} />;
    const session = sessionForPane(state.sessions, pane.id);
    const banner = bannerFor(pane, session, restoredBanners);
    // As abas que este painel pode trazer pro split: as outras de terminal do
    // MESMO workspace, com a sessão do primeiro painel delas no rótulo.
    const paneTab = state.layout.tabs.find((t) => t.id === pane.tabId);
    const adoptable = paneTab
      ? adoptableTabs(
          workspaceTabs(state.layout, paneTab.workspaceId),
          pane.tabId,
          (tabId) => {
            const first = sessionForPane(state.sessions, panesByTab[tabId]?.[0]);
            return first ? sessionLabel(first, lang) : undefined;
          },
          lang,
        )
      : [];
    return (
      <Pane
        key={pane.id}
        pane={pane}
        session={session}
        focused={state.focusedPaneId === pane.id}
        visible={visible}
        banner={banner}
        onDismissBanner={session ? () => dismissRestoredBanner(session.id) : undefined}
        splitItems={splitMenuItems(adoptable, lang)}
        onSplit={(action) => onPaneSplit(pane.id, action)}
        onFocus={() => onFocusPane(pane.id)}
        onOpenShell={() => onCreateInPane(pane.id, 'shell')}
        onOpenClaude={() => onCreateInPane(pane.id, 'agent')}
        onClose={() => onClosePane(pane.id)}
        creating={creatingPanes.has(pane.id)}
        // Dor verificada #3: quem decide se a faixa aparece é o `recap.ts`.
        resumeFresh={showsRecapBanner(session, dismissedRecap)}
        recapBusy={session ? recapBusy.has(session.id) : false}
        onRecap={session ? () => onRecap(session.id) : undefined}
        onDismissRecap={session ? () => onDismissRecap(session.id) : undefined}
        // Fonte do terminal ao vivo: mudar no diálogo troca `state.config` e
        // TODO xterm montado redesenha (o `Terminal` mexe em `term.options` e
        // remede a grade). Ausente até o `GET /api/config` responder — o
        // `resolveTerminalPrefs` cobre com o default.
        terminalFontFamily={state.config?.terminal.fontFamily}
        terminalFontSize={state.config?.terminal.fontSize}
        terminalMouseReporting={state.config?.sessions.mouseClicks ?? DEFAULT_STORED_CONFIG.sessions.mouseClicks}
      />
    );
  }

  return (
    <LanguageProvider config={state.config}>
      <div className="root">
        {!state.connected && <div className="connection-banner">{tUi(lang, 'app.reconectando')}</div>}
        {/*
          BR-07: banner PERSISTENTE (nao a linha de status, que some em 4 s). O
          `instance.json` carrega o token do core; sem a ACL restritiva ele fica
          com a permissao herdada da pasta do perfil, e num `BRIDGE_PROFILE_DIR`
          de heranca frouxa isso e outro usuario da maquina lendo o token. Segue o
          ESTADO: some sozinho se um core seguinte conseguir aplicar a ACL.
        */}
        {state.instanceAclApplied === false && !aclBannerDismissed && (
          <div className="connection-banner warn">
            <span>{tUi(lang, 'app.acl.aviso')}</span>
            <button type="button" title={tUi(lang, 'app.acl.fechar')} onClick={() => setAclBannerDismissed(true)}>
              ✕
            </button>
          </div>
        )}
        {lastError && (
          <div className="connection-banner">
            <span>{tUi(lang, 'app.erro.core', { motivo: lastError })}</span>
            <button type="button" onClick={() => void fetchState()}>
              {tUi(lang, 'app.erro.tentarDeNovo')}
            </button>
            <button type="button" onClick={() => setLastError(undefined)}>
              ✕
            </button>
          </div>
        )}
        <div className="app">
          {state.sidebarOpen && (
            <Sidebar
              state={state}
              width={sidebarWidth}
              onWidthChange={onSidebarWidth}
              groupPrefs={groupPrefs}
              onGroupPrefs={onGroupPrefs}
              onNewWorkspace={() => setDialogOpen(true)}
              onNewTask={() => setTaskDialogOpen(true)}
              onActivateWorkspace={onActivateWorkspace}
              onWorkspaceMenu={onWorkspaceMenu}
              onRevealSession={onRevealSession}
              onKillSession={onKillSession}
              onToggleNotifications={() => dispatch({ type: 'toggleNotifications' })}
              onToggleSidebar={() => dispatch({ type: 'toggleSidebar' })}
              onMarkAllRead={() => onMarkRead(state.unread.map((n) => n.id))}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenUsage={() => setUsageOpen(true)}
              onLaunchNow={onLaunchNow}
              showCost={showCost}
              environments={environments}
              scopeGuard={scopeGuard}
              onEnableToasts={isElectron() ? undefined : () => void Notification.requestPermission()}
            />
          )}
          <main className="main">
            <TabsBar
              tabs={tabsOfActive}
              activeTabId={activeTab}
              sessions={sessions}
              panesByTab={panesByTab}
              onActivate={(tabId) => {
                if (!activeWorkspace) return;
                dispatch({ type: 'activateTab', workspaceId: activeWorkspace.id, tabId });
                const first = panesByTab[tabId]?.[0];
                if (first) onFocusPane(first);
              }}
              onNewTab={() => handlers['tab.new']?.()}
              onClose={onCloseTab}
              // A dica clicada é a MESMA ação do atalho — inclusive o desarme
              // enquanto um diálogo está aberto (`handlers` vazio).
              onHint={(action) => handlers[action]?.()}
              // As teclas escritas nas dicas saem daqui, não de literais: o que a
              // barra anuncia é o que o `keybindings.json` está mandando.
              keybindings={state.keybindings}
              onShowSidebar={state.sidebarOpen ? undefined : () => dispatch({ type: 'toggleSidebar' })}
            />
            <div className="panes-area">
              {state.layout.workspaces.length === 0 && (
                <div className="empty-state">
                  {tUi(lang, 'app.vazio.parte1')} <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd>{' '}
                  {tUi(lang, 'app.vazio.parte2')}
                </div>
              )}
              {/*
                R3 — monta só as abas do workspace ATIVO. Todas as abas dele
                ficam montadas (o scrollback do xterm é a única cópia do que
                rolou na tela, e trocar de aba não pode apagar isso); as dos
                outros workspaces não existem no DOM até serem ativadas — antes
                disso era um xterm por painel de TODO workspace, cada um com
                WebSocket, ResizeObserver e buffer próprios.
              */}
              {tabsOfActive.map((tab) => {
                const visible = tab.id === activeTab;
                const node = state.layout.layouts[tab.id];
                if (!node) return null;
                return (
                  <div key={tab.id} className="tab-surface" style={visible ? undefined : { display: 'none' }}>
                    <SplitTree node={node} renderLeaf={(paneId) => renderLeaf(paneId, visible)} onRatio={onRatio} />
                  </div>
                );
              })}
            </div>
            <StatusStrip
              state={state}
              status={status}
              address={address}
            />
          </main>
          {state.notificationsOpen && (
            <NotificationsPanel
              unread={state.unread}
              sessions={state.sessions}
              workspaceName={(id) => state.layout.workspaces.find((w) => w.id === id)?.name ?? id}
              left={state.sidebarOpen ? sidebarWidth + 8 : 8}
              onPick={(n) => onRevealSession(n.sessionId)}
              onMarkRead={onMarkRead}
              onClose={() => dispatch({ type: 'toggleNotifications' })}
            />
          )}
        </div>
        {dialogOpen && (
          <NewWorkspaceDialog
            onClose={() => setDialogOpen(false)}
            onError={setStatus}
            environments={environments}
            // Enquanto o pedido corre, workspace novo que aparecer é DESTE
            // diálogo — mesmo que o usuário já tenha apertado Esc.
            beginCreating={beginCreating}
            onCreated={(created) => {
              setDialogOpen(false);
              // Workspace novo já nasce do jeito que o usuário pediu (com ou sem
              // Claude no primeiro painel): o restore do R3 não tem o que fazer
              // aqui, e sem esta marca ele abriria um shell por cima.
              restoredWorkspacesRef.current.add(created.workspace.id);
              dispatch({ type: 'activateTab', workspaceId: created.workspace.id, tabId: created.tab.id });
              onFocusPane(created.pane.id);
              void fetchState();
            }}
          />
        )}
        {taskDialogOpen && (
          <NewTaskDialog
            onClose={() => setTaskDialogOpen(false)}
            onWarn={setStatus}
            beginCreating={beginCreating}
            onCreated={(created) => {
              setTaskDialogOpen(false);
              // Igual ao workspace novo: a tarefa já nasce como o usuário pediu
              // (com ou sem Claude no painel), então o restore do R3 não tem o
              // que reabrir — sem esta marca ele subiria um shell por cima.
              restoredWorkspacesRef.current.add(created.workspace.id);
              dispatch({ type: 'activateTab', workspaceId: created.workspace.id, tabId: created.tab.id });
              onFocusPane(created.pane.id);
              void fetchState();
            }}
          />
        )}
        {usageOpen && (
          <UsagePanel
            report={state.usage}
            period={usagePeriod}
            onPeriodChange={setUsagePeriod}
            showCost={showCost}
            onRescan={onUsageRescan}
            busy={usageBusy}
            scanning={state.usageScanning}
            rescanResult={usageRescanResult}
            onClose={() => setUsageOpen(false)}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            config={state.config}
            scanning={state.usageScanning}
            keybindings={state.keybindings}
            keybindingProblems={state.keybindingProblems}
            onClose={() => setSettingsOpen(false)}
            // O `config.changed` do `/ws` chega logo em seguida com o mesmo
            // objeto; guardar aqui também é o que faz o terminal mudar de fonte
            // no MESMO frame do PATCH, sem esperar a volta do socket.
            onSaved={(value) => dispatchRaw({ type: 'setConfig', value })}
          />
        )}
      </div>
    </LanguageProvider>
  );
}
