/**
 * Protocolo entre core e cliente (UI web / renderer do Electron): os eventos
 * que descem pelo WS, as mensagens que sobem, e os atalhos de teclado.
 */
import type {
  BridgeConfig,
  GitStatus,
  LauncherStatus,
  LayoutSnapshot,
  Notification,
  QuotaSnapshot,
  ServerLimit,
  Session,
  SessionState,
  UsageLimitWindow,
  UsageScanProgress,
} from './model.js';

export type BridgeEvent =
  | { type: 'session.created'; session: Session }
  /**
   * `serverLimit` viaja JUNTO do estado (e não num evento próprio) porque o
   * campo só muda quando o estado muda: ele nasce com `server-limited` e sai
   * com ele. Ausente = a sessão não está estrangulada — quem recebe substitui,
   * nunca mescla, senão a prova de uma detecção velha sobreviveria à saída do
   * estado.
   */
  | {
      type: 'session.state';
      id: string;
      state: SessionState;
      detail?: string;
      tool?: string;
      stateSince: number;
      serverLimit?: ServerLimit;
    }
  /**
   * Um campo da sessão que NÃO é estado nem cota mudou — hoje só o desfecho do
   * resume (dor verificada #3), que nasce no primeiro `SessionStart`.
   *
   * Vai a sessão INTEIRA, e não o campo: quem recebe substitui o registro, do
   * mesmo jeito que já faz no `session.created`. Um evento com um delta
   * obrigaria cada cliente a saber mesclar por campo — e um cliente que
   * perdeu o evento anterior ficaria com meia sessão.
   */
  | { type: 'session.updated'; session: Session }
  | { type: 'session.quota'; id: string; quota: QuotaSnapshot }
  | { type: 'session.exited'; id: string; exitCode: number | null }
  | { type: 'session.removed'; id: string }
  /**
   * Alguém de FORA da janela pediu pra VER uma sessão: `bridge focus`, que
   * manda `reveal: true` no `POST /api/focus`. Só marcar o foco no core não
   * muda nada na tela — a UI nunca ficava sabendo. A janela
   * principal responde como ao clique num toast: workspace, aba, painel e
   * janela. A UI não manda `reveal` nos próprios `POST /api/focus`, senão o
   * clique dela voltaria pra ela como evento.
   */
  | { type: 'session.reveal'; id: string }
  | { type: 'notification.new'; notification: Notification; toast: boolean }
  | { type: 'notification.read'; ids: string[] }
  | { type: 'layout.changed' }
  /**
   * O escalonador de lançamentos mudou (dor verificada #1): alguém entrou ou
   * saiu da fila, um slot vagou, o backoff mudou de degrau, a configuração
   * mexeu no teto. Vai o status INTEIRO pelo mesmo motivo do `config.changed`
   * — quem perdeu um evento não fica com meia fila na tela.
   */
  | { type: 'launcher.changed'; status: LauncherStatus }
  /** `+N ~M` de um workspace de worktree mudou (poller do core, spec §7). */
  | { type: 'workspace.git'; workspaceId: string; git: GitStatus }
  /**
   * A configuração mudou (`PATCH /api/config`). Vai o objeto INTEIRO, não o
   * campo alterado: quem escuta (UI e, se um dia precisar, o shell) aplica o
   * estado novo sem ter que remontar o anterior — e um cliente que perdeu um
   * evento anterior não fica com uma versão pela metade.
   */
  | { type: 'config.changed'; config: BridgeConfig }
  /**
   * O monitor de uso tem novidade (ADR-012). Dois disparos, e um evento pode
   * carregar os dois:
   *
   * - `limits`: chegou `rate_limits` novo no payload da statusline de alguma
   *   sessão e alguma janela MUDOU (percentual ou reset). Vai a lista
   *   inteira, não o delta — quem escuta redesenha a faixa sem ter que
   *   remontar o estado anterior, e um cliente que perdeu um evento não fica
   *   com metade das janelas;
   * - `dailyTouched`: dias LOCAIS (`AAAA-MM-DD`) cujo consumo mudou na última
   *   varredura de transcripts. Vai só a lista de dias, e não os números: o
   *   painel decide se o recorte que ele está mostrando foi afetado e, se
   *   foi, relê `GET /api/usage`. Mandar os agregados aqui obrigaria o core a
   *   calcular os três recortes a cada linha nova de transcript.
   * - `scanning`: o progresso da varredura em voo (arquivos e bytes). Sai no
   *   começo e no fim de cada passada e, no meio dela, no máximo UMA VEZ POR
   *   SEGUNDO — uma varredura de 8.431 arquivos emitiria oito mil eventos e o
   *   que a barra de progresso precisa é do número, não de cada passo dele.
   */
  | {
      type: 'usage.changed';
      limits?: UsageLimitWindow[];
      dailyTouched?: string[];
      scanning?: UsageScanProgress | null;
      /**
       * A contagem foi RECONSTRUÍDA do zero (`POST /api/usage/rescan`). Sai
       * mesmo com `dailyTouched` vazio, e é por isso que existe: uma
       * reconstrução que só REMOVE dias — transcrição apagada, tabela de
       * preços corrigida pra menos — não toca dia nenhum, e sem este sinal o
       * painel continuaria mostrando os números velhos até o próximo evento.
       */
      rescanned?: boolean;
    }
  | { type: 'pty.data'; sessionId: string; data: string }
  /**
   * O processo do painel morreu. **Sobrevive de propósito**, apesar de
   * `session.exited` carregar a mesma notícia (o BACKLOG chamava isto de
   * "superfície morta" e a Task 2 do polimento conferiu):
   *
   * - a UI o reconhece no reducer (`state.ts`) pra que ele NÃO caia no
   *   `default` — e o `switch` sobre a união é exaustivo, então tirá-lo daqui
   *   quebraria o `tsc` do renderer;
   * - os dois eventos não são redundantes na borda do PTY: `session.exited`
   *   é estado de SESSÃO (a `Sessions` decide, e uma sessão já removida não
   *   emite nada), enquanto este é o fato cru do processo, com o `exitCode`,
   *   que é o que um cliente de linha de comando (`bridge watch --events
   *   pty`) e o `pty.test.ts` observam;
   * - o filtro `?events=` do `/ws` trata `pty` como um prefixo só: quem não
   *   quer o volume de `pty.data` já não recebe este aqui junto.
   *
   * Quem quiser reagir a "a sessão acabou" na UI deve usar `session.exited`.
   */
  | { type: 'pty.exit'; sessionId: string; exitCode: number | null };

/** Corpo de `GET /api/state` e do `hello` inicial do WS. */
export interface HelloState {
  layout: LayoutSnapshot;
  sessions: Session[];
  unread: Notification[];
  /**
   * Último `GitStatus` conhecido por workspace de worktree. Opcional no TIPO
   * (o core sempre manda; um snapshot montado à mão pela UI/shell não precisa
   * inventar o mapa), e só tem chave pra workspace com worktree.
   */
  git?: Record<string, GitStatus>;
  /**
   * A ACL restritiva do `instance.json` foi aplicada? (BR-07.)
   *
   * `false` quer dizer que o `icacls` não rodou — política de grupo, binário
   * ausente, sistema de arquivos sem ACL — e que o arquivo com o TOKEN ficou
   * com a permissão HERDADA da pasta do perfil. Em `%APPDATA%` isso costuma
   * dar no mesmo, mas num `BRIDGE_PROFILE_DIR` de herança frouxa significa que
   * outro usuário da máquina consegue ler o token. A UI mostra uma faixa.
   *
   * Opcional no TIPO: fora do Windows a pergunta não se aplica, e um snapshot
   * montado à mão não precisa inventar a resposta.
   */
  instanceAclApplied?: boolean;
}

/** O que o cliente manda pelo WS — os dois atalhos que evitam HTTP por tecla. */
export type ClientMessage =
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number };

/** O que o cliente recebe pelo WS: o `hello` de abertura e depois os eventos. */
export type ServerMessage = { type: 'hello'; state: HelloState } | BridgeEvent;

export type KeyAction =
  | 'workspace.new'
  | 'task.new'
  | 'tab.new'
  | 'tab.close'
  | 'pane.splitV'
  | 'pane.splitH'
  | 'pane.close'
  | 'pane.left'
  | 'pane.right'
  | 'pane.up'
  | 'pane.down'
  | 'workspace.prev'
  | 'workspace.next'
  | 'notifications.jump'
  | 'notifications.panel'
  | 'agent.claude'
  | 'sidebar.toggle'
  | 'settings.open'
  /** ADR-012 — abre o painel "Uso" (limites vivos + consumo do recorte). */
  | 'usage.open';

/** Combinação por ação, no formato `Ctrl+Shift+D` / `Alt+ArrowLeft`. */
export type Keybindings = Record<KeyAction, string>;

/** Defaults da spec §6; `keybindings.json` no perfil sobrescreve por ação. */
export const DEFAULT_KEYBINDINGS = {
  'workspace.new': 'Ctrl+Shift+N',
  'task.new': 'Ctrl+Shift+Alt+N',
  'tab.new': 'Ctrl+Shift+T',
  'tab.close': 'Ctrl+Shift+W',
  'pane.splitV': 'Ctrl+Shift+D',
  'pane.splitH': 'Ctrl+Shift+E',
  'pane.close': 'Ctrl+Shift+X',
  'pane.left': 'Alt+ArrowLeft',
  'pane.right': 'Alt+ArrowRight',
  'pane.up': 'Alt+ArrowUp',
  'pane.down': 'Alt+ArrowDown',
  'workspace.prev': 'Ctrl+Shift+[',
  'workspace.next': 'Ctrl+Shift+]',
  'notifications.jump': 'Ctrl+Shift+U',
  'notifications.panel': 'Ctrl+Shift+I',
  'agent.claude': 'Ctrl+Shift+C',
  'sidebar.toggle': 'Ctrl+Shift+S',
  'settings.open': 'Ctrl+,',
  'usage.open': 'Ctrl+Shift+Y',
} satisfies Keybindings;

/** Todas as ações, na ordem da spec — pra iterar sem repetir a lista. */
export const KEY_ACTIONS = Object.keys(DEFAULT_KEYBINDINGS) as KeyAction[];

/**
 * O que o core achou de errado no `keybindings.json` do perfil.
 *
 * - `json-invalido` / `nao-e-objeto`: o arquivo INTEIRO foi descartado e valem
 *   os defaults da spec §6. `action` não se aplica.
 * - `acao-desconhecida`: uma chave que não é `KeyAction` (typo). Ignorada.
 * - `atalho-invalido`: o valor não é uma string não vazia. O default daquela
 *   ação continua valendo.
 */
export interface KeybindingProblem {
  kind: 'json-invalido' | 'nao-e-objeto' | 'acao-desconhecida' | 'atalho-invalido';
  /** A chave do arquivo, quando o problema é de uma ação só. */
  action?: string;
}

/**
 * Corpo de `GET /api/keybindings`: os atalhos em vigor MAIS o que deu errado
 * ao ler o arquivo.
 *
 * `problems` é um campo IRMÃO das ações, e não um envelope
 * (`{ keybindings, problems }`), de propósito: a rota já devolvia a tabela
 * crua, e um envelope quebraria todo cliente que a lê hoje. `problems` não é
 * um `KeyAction` válido, então quem itera `KEY_ACTIONS` (a UI) nunca o vê.
 *
 * Por que existe: sem isto, um `keybindings.json` com JSON quebrado (ou uma
 * ação escrita errada) caía nos defaults em silêncio — o `warn` ia pro
 * `core.log`, mas a resposta da rota chegava íntegra e indistinguível de um
 * arquivo perfeito, e o diálogo de configurações não tinha como avisar.
 * Ausente ou vazio = o arquivo estava impecável (ou nem existia).
 */
export type KeybindingsResponse = Keybindings & { problems?: KeybindingProblem[] };
