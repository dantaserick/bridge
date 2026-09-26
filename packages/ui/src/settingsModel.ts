/**
 * O miolo puro do diálogo de configurações (`SettingsDialog`).
 *
 * Por que existe: o diálogo é DOM e React, e o `vitest` deste pacote roda em
 * ambiente `node`. Tudo que dá pra decidir sem tela — quais seções existem,
 * qual corpo de `PATCH /api/config` cada campo produz, o que é valor aceitável
 * e o que "restaurar padrões" manda — mora aqui e é testado direto. O
 * componente vira casca: lê o `config`, chama estas funções e desenha.
 *
 * As faixas são um ESPELHO do que `packages/core/src/api/schemas.ts` valida.
 * Elas existem aqui pra mensagem de erro sair antes do round-trip (e em
 * português, com o nome do campo que o usuário está vendo), não pra substituir
 * a validação do core: o servidor continua sendo a autoridade, e um 400 dele é
 * exibido do mesmo jeito. Se as duas divergirem, quem ganha é o 400.
 */
import { DEFAULT_STORED_CONFIG, KEY_ACTIONS, LANGUAGE_SETTINGS } from '@bridge/shared';
import type {
  BridgeConfig,
  BridgeConfigPatch,
  KeyAction,
  KeybindingProblem,
  Language,
  LanguageSetting,
  MessageKey,
} from '@bridge/shared';
import { tUi } from './i18n.js';
import type { LoginItemInput, LoginItemState } from './bridge.js';
// O MESMO parser que decide se a tecla casa: o aviso da seção "Atalhos" só vale
// se ele enxergar a combinação exatamente como o `handleKeyDown` a enxerga.
import { isMatchableChord, parseChord } from './keys.js';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from './terminalPrefs.js';

// ------------------------------------------------------------------ seções

export type SettingsSectionId =
  | 'terminal'
  | 'sessions'
  | 'notifications'
  | 'usage'
  | 'git'
  | 'keys'
  | 'appearance'
  | 'system';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  /** Frase de uma linha abaixo do título da seção. */
  hint: string;
}

/** Que chaves cada seção usa, na ORDEM em que a coluna da esquerda a desenha. */
const SECTION_KEYS: ReadonlyArray<{ id: SettingsSectionId; label: MessageKey; hint: MessageKey }> = [
  { id: 'terminal', label: 'settings.secao.terminal', hint: 'settings.secao.terminal.nota' },
  { id: 'sessions', label: 'settings.secao.sessoes', hint: 'settings.secao.sessoes.nota' },
  { id: 'notifications', label: 'settings.secao.notificacoes', hint: 'settings.secao.notificacoes.nota' },
  { id: 'usage', label: 'settings.secao.uso', hint: 'settings.secao.uso.nota' },
  { id: 'git', label: 'settings.secao.git', hint: 'settings.secao.git.nota' },
  { id: 'keys', label: 'settings.secao.atalhos', hint: 'settings.secao.atalhos.nota' },
  { id: 'appearance', label: 'settings.secao.aparencia', hint: 'settings.secao.aparencia.nota' },
  { id: 'system', label: 'settings.secao.sistema', hint: 'settings.secao.sistema.nota' },
];

/** A coluna da esquerda, na ordem em que ela é desenhada. */
export function settingsSections(lang: Language): readonly SettingsSection[] {
  return SECTION_KEYS.map((section) => ({
    id: section.id,
    label: tUi(lang, section.label),
    hint: tUi(lang, section.hint),
  }));
}

// ------------------------------------------------------------------ campos

/** Um campo editável do diálogo. O nome é o CAMINHO dele no `BridgeConfig`. */
export type SettingsField =
  | 'terminal.fontFamily'
  | 'terminal.fontSize'
  | 'shell'
  | 'toast.enabled'
  | 'toast.quietWhenFocused'
  | 'gitPollSeconds'
  | 'restore.resumeAgents'
  | 'sessions.maxConcurrentAgents'
  | 'sessions.scheduleLaunches'
  | 'sessions.autoRecap'
  | 'sessions.scopeGuard'
  | 'sessions.hostedAgents'
  | 'sessions.mouseClicks'
  | 'usage.showCost'
  | 'usage.terminalStatusLine'
  | 'usage.pricingFile'
  /** Spec §13 — Configurações → Aparência → Idioma. */
  | 'ui.language';

/** Faixa do `gitPollSeconds` — espelho de `GIT_POLL_SECONDS_MIN/MAX` do core. */
export const GIT_POLL_SECONDS_MIN = 5;
export const GIT_POLL_SECONDS_MAX = 120;

/**
 * Faixa de `sessions.maxConcurrentAgents` — espelho de
 * `MAX_CONCURRENT_AGENTS_MIN/MAX` do core (`api/schemas.ts`).
 */
export const MAX_CONCURRENT_AGENTS_MIN = 1;
export const MAX_CONCURRENT_AGENTS_MAX = 16;

/** Frase de apoio do escalonador — é ela que separa os dois limites. */
export function scheduleLaunchesNote(lang: Language): string {
  return tUi(lang, 'settings.sessoes.escalonador.nota');
}

/**
 * Frase de apoio do "resume vazio" (dor verificada #3). Ela diz as duas coisas
 * que o dono precisa saber antes de LIGAR a opção: o resumo é montado do
 * transcript antigo (não é a conversa de volta) e ele é escrito no prompt do
 * agente, o que é escrever no terminal dele sem clique nenhum.
 */
export function autoRecapNote(lang: Language): string {
  return tUi(lang, 'settings.sessoes.autoRecap.nota');
}

/**
 * Frase de apoio da guarda de escopo (dor verificada #4). Ela precisa dizer as
 * três coisas que a pessoa vai perguntar: o que é barrado, o que NÃO é, e
 * contra quem a guarda existe.
 */
export function scopeGuardNote(lang: Language): string {
  return tUi(lang, 'settings.sessoes.escopo.nota');
}

/**
 * Frase de apoio do "Claude Code aberto dentro de um shell" (0.12.0). Ela
 * precisa responder às três perguntas que a opção levanta: o que o Bridge faz
 * com o shell, quando a mudança passa a valer, e se a sessão deixa de ser um
 * shell (não deixa).
 */
export function hostedAgentsNote(lang: Language): string {
  return tUi(lang, 'settings.sessoes.hospedados.nota');
}

/**
 * Frase de apoio da linha de status no terminal (0.12.2). Ela precisa deixar
 * claro o que NÃO muda: desligar a linha não desliga a medição, e a sidebar
 * continua com os mesmos números — sem isso a opção pareceria "parar de
 * acompanhar o uso".
 */
export function terminalStatusLineNote(lang: Language): string {
  return tUi(lang, 'settings.uso.linhaTerminal.nota');
}

/** Teto do `usage.pricingFile` — espelho do `z.string().max(1000)` do core. */
export const PRICING_FILE_MAX = 1000;

/**
 * O formato que a seção "Uso" mostra ao lado da lista de modelos sem preço.
 *
 * Ele é literal de propósito: a tabela embutida cobre o que dá pra afirmar de
 * preço de lista público, e os modelos mais novos (justamente os que a pessoa
 * está usando) chegam sem preço. Sem o exemplo à vista, "preencha
 * `usage.pricing`" é uma instrução que exige ler o código.
 *
 * Os quatro valores são USD por MILHÃO de tokens — a unidade em que a tabela
 * pública é publicada, então a unidade em que ela é escrita aqui.
 */
export const PRICING_EXAMPLE = `{
  "claude-modelo-novo": {
    "input": 3,
    "output": 15,
    "cacheWrite": 3.75,
    "cacheRead": 0.3
  }
}`;

/** Frase de apoio do campo de arquivo. */
export function pricingFileHint(lang: Language): string {
  return tUi(lang, 'settings.uso.arquivoPrecos.nota');
}

/** `tabela de preços de 2026-08-01` — de quando é a estimativa. */
export function pricingAsOfLabel(asOf: string | undefined, lang: Language): string | undefined {
  return asOf ? tUi(lang, 'settings.uso.precosDe', { data: asOf }) : undefined;
}

/**
 * Os três shells que o core sabe subir (`shellLaunch`). Os rótulos são nome de
 * produto e valem nos dois idiomas — vêm das MESMAS chaves que o rótulo de
 * ambiente da sidebar usa, pra que "Git Bash" seja escrito num lugar só.
 */
const SHELL_VALUES: readonly string[] = ['pwsh', 'powershell', 'gitbash'];

export function shellOptions(lang: Language): ReadonlyArray<{ value: BridgeConfig['shell']; label: string }> {
  return [
    { value: 'pwsh', label: tUi(lang, 'ambiente.pwsh') },
    { value: 'powershell', label: tUi(lang, 'ambiente.powershell') },
    { value: 'gitbash', label: tUi(lang, 'ambiente.gitbash') },
  ];
}

/**
 * O seletor de Configurações → Aparência → Idioma (spec §6/§13).
 *
 * A ordem é a do `LANGUAGE_SETTINGS` do `@bridge/shared`, que é a mesma lista
 * que o enum do `PATCH /api/config` valida: um idioma novo entra lá e aparece
 * aqui, sem uma segunda lista pra esquecer de atualizar. Os dois NOMES de
 * idioma ficam na própria língua nos dois catálogos (quem procura inglês
 * procura "English"); só "Do sistema" é frase e se traduz.
 */
const LANGUAGE_KEYS: Record<LanguageSetting, MessageKey> = {
  'pt-BR': 'idioma.ptBR',
  en: 'idioma.en',
  system: 'idioma.sistema',
};

export function languageOptions(lang: Language): ReadonlyArray<{ value: LanguageSetting; label: string }> {
  return LANGUAGE_SETTINGS.map((value) => ({ value, label: tUi(lang, LANGUAGE_KEYS[value]) }));
}

/**
 * O `datalist` do campo de fonte. Sugestão, não trava: qualquer família que o
 * Chromium do Electron resolva serve, e o campo aceita uma lista com fallback
 * (é assim que o default vem). Nada aqui é baixado — são as monoespaçadas que
 * costumam existir num Windows de dev.
 */
export const MONO_FONT_SUGGESTIONS: readonly string[] = [
  'Cascadia Mono',
  'Consolas',
  'Geist Mono',
  'JetBrains Mono',
  'Fira Code',
];

/**
 * Defaults que o "Restaurar padrões" repõe — DERIVADOS do
 * `DEFAULT_STORED_CONFIG` do `@bridge/shared`, o mesmo objeto que o
 * `DEFAULT_CONFIG` do core. Até 04/09/2026 isto era uma cópia literal do core,
 * sem nada que ligasse os dois: mudar o default do `gitPollSeconds` lá deixava
 * este botão repondo o número velho, calado. Só o que o `PATCH` aceita entra —
 * `port` é somente leitura pela API.
 */
export const SETTINGS_DEFAULTS = {
  shell: DEFAULT_STORED_CONFIG.shell,
  gitPollSeconds: DEFAULT_STORED_CONFIG.gitPollSeconds,
  toast: { ...DEFAULT_STORED_CONFIG.toast },
  terminal: { ...DEFAULT_STORED_CONFIG.terminal },
  restore: { ...DEFAULT_STORED_CONFIG.restore },
  // Dor verificada #1 — o escalonador de lançamentos.
  sessions: { ...DEFAULT_STORED_CONFIG.sessions },
  // ADR-012. A seção "Uso" do diálogo é da Task 2b; o default já entra aqui
  // porque o `satisfies Required<BridgeConfigPatch>` é justamente o que
  // impede um campo novo do PATCH de ficar de fora do "Restaurar padrões"
  // sem ninguém perceber.
  usage: { ...DEFAULT_STORED_CONFIG.usage },
  // Spec §13. A seção "Aparência" do diálogo é da Task 3 do lote de idioma; o
  // default entra aqui na Task 1 porque o `satisfies Required<BridgeConfigPatch>`
  // é justamente o que impede um campo novo do PATCH de ficar de fora do
  // "Restaurar padrões" sem ninguém perceber.
  ui: { ...DEFAULT_STORED_CONFIG.ui },
} satisfies Required<BridgeConfigPatch>;

export interface PatchOk {
  ok: true;
  patch: BridgeConfigPatch;
}

export interface PatchError {
  ok: false;
  error: string;
}

export type PatchResult = PatchOk | PatchError;

function invalid(error: string): PatchError {
  return { ok: false, error };
}

/** O valor digitado é uma das três opções do seletor de idioma? */
function isLanguageSetting(value: string): value is LanguageSetting {
  return (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/**
 * Aceita o número escrito no campo. `<input type="number">` devolve string, e
 * string vazia (campo apagado) NÃO é zero: é "ainda não digitei", e virar 0
 * mandaria um PATCH que o core recusa com 400 no meio da digitação.
 */
function toInteger(raw: string | number): number | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return parsed;
}

/**
 * Valor de um campo → corpo do `PATCH /api/config`, ou o motivo da recusa.
 *
 * O corpo sai SEMPRE com um campo só, aninhado do jeito que a rota espera
 * (`{ terminal: { fontSize: 14 } }`): o merge do core é profundo, então mandar
 * `terminal.fontSize` sozinho não repõe o `fontFamily` padrão.
 */
export function patchForField(field: SettingsField, raw: string | number | boolean, lang: Language): PatchResult {
  switch (field) {
    case 'terminal.fontFamily': {
      const value = String(raw).trim();
      if (value.length === 0) return invalid(tUi(lang, 'settings.erro.fonteVazia'));
      if (value.length > 200) return invalid(tUi(lang, 'settings.erro.fonteLonga'));
      return { ok: true, patch: { terminal: { fontFamily: value } } };
    }
    case 'terminal.fontSize': {
      const value = toInteger(raw as string | number);
      if (value === undefined || value < TERMINAL_FONT_SIZE_MIN || value > TERMINAL_FONT_SIZE_MAX) {
        return invalid(tUi(lang, 'settings.erro.corpoFonte', { min: TERMINAL_FONT_SIZE_MIN, max: TERMINAL_FONT_SIZE_MAX }));
      }
      return { ok: true, patch: { terminal: { fontSize: value } } };
    }
    case 'gitPollSeconds': {
      const value = toInteger(raw as string | number);
      if (value === undefined || value < GIT_POLL_SECONDS_MIN || value > GIT_POLL_SECONDS_MAX) {
        return invalid(tUi(lang, 'settings.erro.poll', { min: GIT_POLL_SECONDS_MIN, max: GIT_POLL_SECONDS_MAX }));
      }
      return { ok: true, patch: { gitPollSeconds: value } };
    }
    case 'shell': {
      const value = String(raw);
      if (!SHELL_VALUES.includes(value)) return invalid(tUi(lang, 'settings.erro.shell', { valor: value }));
      return { ok: true, patch: { shell: value as BridgeConfig['shell'] } };
    }
    case 'ui.language': {
      const value = String(raw);
      if (!isLanguageSetting(value)) return invalid(tUi(lang, 'settings.erro.idioma', { valor: value }));
      return { ok: true, patch: { ui: { language: value } } };
    }
    case 'toast.enabled':
      return { ok: true, patch: { toast: { enabled: Boolean(raw) } } };
    case 'toast.quietWhenFocused':
      return { ok: true, patch: { toast: { quietWhenFocused: Boolean(raw) } } };
    case 'restore.resumeAgents':
      return { ok: true, patch: { restore: { resumeAgents: Boolean(raw) } } };
    case 'sessions.maxConcurrentAgents': {
      const value = toInteger(raw as string | number);
      if (value === undefined || value < MAX_CONCURRENT_AGENTS_MIN || value > MAX_CONCURRENT_AGENTS_MAX) {
        return invalid(
          tUi(lang, 'settings.erro.maxAgentes', { min: MAX_CONCURRENT_AGENTS_MIN, max: MAX_CONCURRENT_AGENTS_MAX }),
        );
      }
      return { ok: true, patch: { sessions: { maxConcurrentAgents: value } } };
    }
    case 'sessions.scheduleLaunches':
      return { ok: true, patch: { sessions: { scheduleLaunches: Boolean(raw) } } };
    case 'sessions.autoRecap':
      return { ok: true, patch: { sessions: { autoRecap: Boolean(raw) } } };
    case 'sessions.scopeGuard':
      return { ok: true, patch: { sessions: { scopeGuard: Boolean(raw) } } };
    case 'sessions.hostedAgents':
      return { ok: true, patch: { sessions: { hostedAgents: Boolean(raw) } } };
    case 'sessions.mouseClicks':
      return { ok: true, patch: { sessions: { mouseClicks: Boolean(raw) } } };
    case 'usage.showCost':
      return { ok: true, patch: { usage: { showCost: Boolean(raw) } } };
    case 'usage.terminalStatusLine':
      return { ok: true, patch: { usage: { terminalStatusLine: Boolean(raw) } } };
    case 'usage.pricingFile': {
      const value = String(raw).trim();
      // Espelho do `z.string().max(1000)` do core. Vazio é LEGÍTIMO: é como se
      // apaga o arquivo e se volta pra tabela embutida, e recusar aqui deixaria
      // o campo sem saída depois de um caminho digitado errado.
      if (value.length > PRICING_FILE_MAX) return invalid(tUi(lang, 'settings.erro.arquivoPrecos', { max: PRICING_FILE_MAX }));
      return { ok: true, patch: { usage: { pricingFile: value } } };
    }
    default: {
      // Exaustividade: um campo novo no union sem ramo aqui não compila.
      const never: never = field;
      return invalid(tUi(lang, 'settings.erro.campoDesconhecido', { campo: String(never) }));
    }
  }
}

/**
 * O que "Restaurar padrões" daquela seção manda. `undefined` = a seção não
 * tem nada que o `PATCH` mexa (Atalhos vive no `keybindings.json`, Sistema vive
 * no registro do Windows), e o botão não aparece.
 */
export function defaultsPatchFor(section: SettingsSectionId): BridgeConfigPatch | undefined {
  switch (section) {
    case 'terminal':
      return { shell: SETTINGS_DEFAULTS.shell, terminal: { ...SETTINGS_DEFAULTS.terminal } };
    case 'notifications':
      return { toast: { ...SETTINGS_DEFAULTS.toast } };
    case 'sessions':
      return { restore: { ...SETTINGS_DEFAULTS.restore }, sessions: { ...SETTINGS_DEFAULTS.sessions } };
    case 'git':
      return { gitPollSeconds: SETTINGS_DEFAULTS.gitPollSeconds };
    case 'usage':
      // `pricingFile` e `pricing` NÃO estão no default (`DEFAULT_STORED_CONFIG`
      // não os traz), então "Restaurar padrões" aqui religa o custo e devolve a
      // borda do dia — sem apagar a tabela que o dono escreveu à mão. Apagar
      // seria uma perda silenciosa atrás de um botão que diz "padrões".
      return { usage: { ...SETTINGS_DEFAULTS.usage } };
    case 'appearance':
      // Spec §13 — a seção deixou de ter só o tema fixo: "Restaurar padrões"
      // devolve o idioma pro `system`, que é o único campo dela que o `PATCH`
      // mexe (o tema continua sendo um único valor desabilitado).
      return { ui: { ...SETTINGS_DEFAULTS.ui } };
    default:
      return undefined;
  }
}

/**
 * Valor que o campo mostra, tirado da config em vigor. Sem config carregada
 * (o `GET /api/config` ainda em voo, ou um core velho sem a rota) devolve o
 * default — o diálogo abre preenchido em vez de piscar vazio.
 */
export function fieldValue(config: BridgeConfig | undefined, field: SettingsField): string | number | boolean {
  switch (field) {
    case 'terminal.fontFamily':
      return config?.terminal.fontFamily ?? SETTINGS_DEFAULTS.terminal.fontFamily;
    case 'terminal.fontSize':
      return config?.terminal.fontSize ?? SETTINGS_DEFAULTS.terminal.fontSize;
    case 'shell':
      return config?.shell ?? SETTINGS_DEFAULTS.shell;
    case 'toast.enabled':
      return config?.toast.enabled ?? SETTINGS_DEFAULTS.toast.enabled;
    case 'toast.quietWhenFocused':
      return config?.toast.quietWhenFocused ?? SETTINGS_DEFAULTS.toast.quietWhenFocused;
    case 'gitPollSeconds':
      return config?.gitPollSeconds ?? SETTINGS_DEFAULTS.gitPollSeconds;
    case 'usage.showCost':
      // `??` pelo mesmo motivo do `resumeAgents`: um `false` do core é uma
      // escolha, não um campo ausente.
      return config?.usage?.showCost ?? SETTINGS_DEFAULTS.usage.showCost;
    case 'usage.terminalStatusLine':
      // Aqui o default é DESLIGADA, e o `??` continua sendo o operador certo:
      // com `||`, um core que devolvesse `true` (o dono religou a linha) e um
      // core velho sem o campo dariam a mesma resposta por acidente de valor.
      return config?.usage?.terminalStatusLine ?? SETTINGS_DEFAULTS.usage.terminalStatusLine;
    case 'usage.pricingFile':
      return config?.usage?.pricingFile ?? '';
    case 'ui.language':
      // O valor do SELETOR é a escolha (`'system'` inclusive), não o
      // `languageResolved`: mostrar "Português (Brasil)" em quem escolheu "Do
      // sistema" faria o campo mentir sobre o que está gravado.
      return config?.ui?.language ?? SETTINGS_DEFAULTS.ui.language;
    case 'restore.resumeAgents':
      // `??` e não `||`: um core que devolve `false` aqui está DESLIGANDO o
      // resume, e cair no default (ligado) ressuscitaria os Claudes de quem
      // pediu pra não retomar.
      return config?.restore?.resumeAgents ?? SETTINGS_DEFAULTS.restore.resumeAgents;
    case 'sessions.maxConcurrentAgents':
      return config?.sessions?.maxConcurrentAgents ?? SETTINGS_DEFAULTS.sessions.maxConcurrentAgents;
    case 'sessions.scheduleLaunches':
      // `??` pelo mesmo motivo do `resumeAgents`: `false` aqui é uma escolha.
      return config?.sessions?.scheduleLaunches ?? SETTINGS_DEFAULTS.sessions.scheduleLaunches;
    case 'sessions.autoRecap':
      // Aqui o default JÁ é `false`, mas o `??` continua sendo o operador
      // certo: com `||`, um core que devolvesse `true` e um que não devolvesse
      // nada dariam a mesma resposta só por acidente de valor.
      return config?.sessions?.autoRecap ?? SETTINGS_DEFAULTS.sessions.autoRecap;
    case 'sessions.scopeGuard':
      // `??` de novo: aqui o default é LIGADA, então um `||` faria um core que
      // devolve `false` (guarda desligada de propósito) desenhar o checkbox
      // marcado — a pior mentira possível numa opção de segurança.
      return config?.sessions?.scopeGuard ?? SETTINGS_DEFAULTS.sessions.scopeGuard;
    case 'sessions.hostedAgents':
      // `??` pela mesma razão do `scopeGuard`: o default aqui é LIGADA, então
      // um `||` desenharia marcado o checkbox de quem desligou o recurso de
      // propósito — e a pessoa concluiria que o wrapper continua no PATH.
      return config?.sessions?.hostedAgents ?? SETTINGS_DEFAULTS.sessions.hostedAgents;
    case 'sessions.mouseClicks':
      // Default LIGADO: `??` pelo mesmo motivo do `hostedAgents`.
      return config?.sessions?.mouseClicks ?? SETTINGS_DEFAULTS.sessions.mouseClicks;
    default: {
      // Invariante interna, nunca texto de tela: um campo do union sem ramo
      // aqui é defeito de programação, e o `never` já o pega em compilação.
      const never: never = field; // i18n-ignore
      throw new Error(`campo desconhecido: ${String(never)}`); // i18n-ignore
    }
  }
}

// ------------------------------------------------------- sistema (Fase 5)

/**
 * A seção "Sistema" é a ÚNICA que não passa pelo `PATCH /api/config`: o estado
 * do início automático mora no registro do Windows, e quem lê e escreve é o
 * main do Electron (`window.bridge.loginItem`). Por isso ela não tem
 * "Restaurar padrões" — não há default do Bridge a repor; o padrão é o que o
 * Windows já tem, e ele começa sem entrada nenhuma.
 */
export function loginItemLabel(lang: Language): string {
  return tUi(lang, 'settings.sistema.inicio');
}

/** Sub-opção: só faz sentido com a de cima ligada (vira o `--hidden`). */
export function loginItemMinimizedLabel(lang: Language): string {
  return tUi(lang, 'settings.sistema.minimizado');
}

/** Onde a entrada é criada — o dono confere aqui à mão. */
export const LOGIN_ITEM_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Frase de apoio quando dá pra mexer (app instalado). */
export function loginItemNote(lang: Language): string {
  return tUi(lang, 'settings.sistema.nota', { chave: LOGIN_ITEM_RUN_KEY });
}

/** Enquanto o `loginItem.get()` não voltou: os checkboxes ficam travados. */
export function loginItemLoading(lang: Language): string {
  return tUi(lang, 'settings.sistema.consultando');
}

/** O que a seção "Sistema" desenha, decidido sem tocar em DOM. */
export interface LoginItemView {
  /** Estado do checkbox principal. */
  enabled: boolean;
  /** Estado da sub-opção. */
  startMinimized: boolean;
  /** O checkbox principal está travado (web, dev, ou resposta em voo). */
  disabled: boolean;
  /** A sub-opção está travada — inclusive com o principal desligado. */
  minimizedDisabled: boolean;
  /** Frase abaixo dos dois: o motivo da trava, ou onde a entrada é criada. */
  note: string;
}

/**
 * Estado vindo do shell → o que a seção mostra.
 *
 * Sem estado (`undefined`) é a resposta do `loginItem.get()` ainda em voo: os
 * checkboxes aparecem desmarcados e travados, nunca marcados por chute — um
 * checkbox que muda sozinho depois que a resposta chega parece que o app ligou
 * o auto-start sem pedir.
 *
 * Com `supported: false` (UI num navegador comum, ou app rodando em dev) o que o
 * Windows tem HOJE continua sendo mostrado — o dono pode ter a entrada ligada
 * pelo app instalado enquanto roda o `npm run dev:app` — mas travado, com o
 * `status` explicando por quê.
 *
 * O `status` é uma CHAVE de catálogo, não uma frase (Task 4): ele atravessa o
 * IPC vindo do processo main, que resolve o idioma na hora dele. Quem traduz é
 * esta função, com o idioma da JANELA — assim a seção "Sistema" nunca fica
 * numa língua e o resto do diálogo em outra.
 */
export function loginItemView(state: LoginItemState | undefined, lang: Language): LoginItemView {
  if (!state) {
    return { enabled: false, startMinimized: false, disabled: true, minimizedDisabled: true, note: loginItemLoading(lang) };
  }
  if (!state.supported) {
    return {
      enabled: state.enabled,
      startMinimized: state.startMinimized,
      disabled: true,
      minimizedDisabled: true,
      note: state.status === '' ? '' : tUi(lang, state.status),
    };
  }
  return {
    enabled: state.enabled,
    startMinimized: state.startMinimized,
    // Sem início automático, "começar minimizado" não tem o que qualificar.
    minimizedDisabled: !state.enabled,
    disabled: false,
    note: loginItemNote(lang),
  };
}

/**
 * Clique num dos dois checkboxes → o par inteiro que o `loginItem.set()`
 * recebe. É sempre o par: `setLoginItemSettings` reescreve a entrada do
 * registro por completo, então mandar só o que mudou apagaria o `--hidden`
 * de quem só desmarcou e remarcou o principal.
 *
 * Desligar o principal PRESERVA o "minimizado" escolhido: a entrada some do
 * registro de qualquer jeito, e quem religar na mesma sessão não perde a
 * escolha.
 */
export function nextLoginItem(view: LoginItemView, change: Partial<LoginItemInput>): LoginItemInput {
  return {
    enabled: change.enabled ?? view.enabled,
    startMinimized: change.startMinimized ?? view.startMinimized,
  };
}

// ----------------------------------------------------------------- atalhos

/** Nome por extenso de cada ação de atalho — a primeira coluna da tabela. */
const KEY_ACTION_KEYS: Record<KeyAction, MessageKey> = {
  'workspace.new': 'settings.atalhos.acao.workspaceNovo',
  'task.new': 'settings.atalhos.acao.tarefaNova',
  'tab.new': 'settings.atalhos.acao.abaNova',
  'tab.close': 'settings.atalhos.acao.abaFechar',
  'pane.splitV': 'settings.atalhos.acao.painelDividirV',
  'pane.splitH': 'settings.atalhos.acao.painelDividirH',
  'pane.close': 'settings.atalhos.acao.painelFechar',
  'pane.left': 'settings.atalhos.acao.painelEsquerda',
  'pane.right': 'settings.atalhos.acao.painelDireita',
  'pane.up': 'settings.atalhos.acao.painelAcima',
  'pane.down': 'settings.atalhos.acao.painelAbaixo',
  'workspace.prev': 'settings.atalhos.acao.workspaceAnterior',
  'workspace.next': 'settings.atalhos.acao.workspaceProximo',
  'notifications.jump': 'settings.atalhos.acao.notificacoesPular',
  'notifications.panel': 'settings.atalhos.acao.notificacoesPainel',
  'agent.claude': 'settings.atalhos.acao.agenteClaude',
  'sidebar.toggle': 'settings.atalhos.acao.sidebarAlternar',
  'settings.open': 'settings.atalhos.acao.configuracoesAbrir',
  'usage.open': 'settings.atalhos.acao.usoAbrir',
};

/** O nome de UMA ação — a tabela e o tooltip das dicas da barra de abas. */
export function keyActionLabel(action: KeyAction, lang: Language): string {
  return tUi(lang, KEY_ACTION_KEYS[action]);
}

/**
 * O que há de errado com a combinação de uma ação — o que a seção "Atalhos"
 * marca na linha e resume no aviso de cima.
 *
 * - `'invalid'` — o Bridge não consegue ler a combinação (só modificadores,
 *   `"Ctrl+"`, texto solto). O atalho **nunca dispara**, e nada avisava: o core
 *   aceita qualquer string não vazia no `keybindings.json` e só rejeita o que
 *   não é string, então a tabela mostrava `Ctrl+` como se fosse um atalho.
 * - `'duplicate'` — outra ação, mais acima na tabela, tem a MESMA combinação.
 *   Quem casa primeiro (`handleKeyDown` varre na ordem de `KEY_ACTIONS`) come a
 *   tecla, e esta ação fica inalcançável pelo teclado.
 */
export type KeyIssueKind = 'invalid' | 'duplicate';

export interface KeyIssue {
  action: KeyAction;
  kind: KeyIssueKind;
  /** Frase pronta, com o nome da ação em pt-BR — é o que a faixa lista. */
  detail: string;
}

export interface KeyRow {
  action: KeyAction;
  label: string;
  chord: string;
  /** Presente = esta linha entra no aviso; a tabela a marca. */
  issue?: KeyIssueKind;
}

/**
 * A forma canônica de uma combinação, pra comparar duas: `Shift+Ctrl+D` e
 * `Ctrl+Shift+D` são a MESMA tecla, e um `keybindings.json` escrito à mão
 * mistura as duas ordens sem querer.
 */
function chordKey(spec: string): string | undefined {
  const chord = parseChord(spec);
  // `isMatchableChord` e não `chord.key`: `"Ctrl+nada"` tem tecla, mas nenhum
  // `event.key` é `'nada'` — o atalho é letra morta do mesmo jeito que
  // `"Ctrl+"`, e o aviso trata os dois como o mesmo problema.
  if (!isMatchableChord(chord)) return undefined;
  return [chord.ctrl ? 'ctrl' : '', chord.shift ? 'shift' : '', chord.alt ? 'alt' : '', chord.meta ? 'meta' : '', chord.key].join('+');
}

/**
 * Os problemas do `keybindings.json` que a UI consegue enxergar sozinha,
 * na ordem da tabela.
 *
 * O que ela NÃO enxerga é o que aconteceu na LEITURA do arquivo: JSON
 * quebrado, topo que não é objeto, ação escrita errada, valor que não é
 * string. Isso o core resolve antes de responder (cai no default e escreve um
 * `warn` no `core.log`), e a tabela chega indistinguível de um arquivo
 * perfeito — por isso o `GET /api/keybindings` traz o campo irmão `problems`,
 * que `keybindingProblemNotices` traduz e a faixa mostra ao lado destes.
 */
export function keybindingIssues(bindings: Partial<Record<KeyAction, string>>, lang: Language): KeyIssue[] {
  const issues: KeyIssue[] = [];
  const seen = new Map<string, KeyAction>();
  for (const action of KEY_ACTIONS) {
    const spec = bindings[action];
    if (spec === undefined) continue;
    const key = chordKey(spec);
    if (key === undefined) {
      issues.push({
        action,
        kind: 'invalid',
        detail: tUi(lang, 'settings.atalhos.problema.invalido', {
          acao: keyActionLabel(action, lang),
          combinacao: spec,
        }),
      });
      continue;
    }
    const owner = seen.get(key);
    if (owner) {
      issues.push({
        action,
        kind: 'duplicate',
        detail: tUi(lang, 'settings.atalhos.problema.duplicado', {
          acao: keyActionLabel(action, lang),
          outra: keyActionLabel(owner, lang),
          combinacao: spec,
        }),
      });
      continue;
    }
    seen.set(key, action);
  }
  return issues;
}

/** O `title` do ⚠ na linha — uma frase por tipo de problema. */
export function keyIssueTitle(kind: KeyIssueKind, lang: Language): string {
  return tUi(lang, kind === 'invalid' ? 'settings.atalhos.titulo.invalido' : 'settings.atalhos.titulo.duplicado');
}

/** As duas frases de uma vez, num idioma só. */
export function keyIssueTitles(lang: Language): Record<KeyIssueKind, string> {
  return { invalid: keyIssueTitle('invalid', lang), duplicate: keyIssueTitle('duplicate', lang) };
}

// ------------------------------- o que o CORE achou de errado no arquivo

/**
 * Uma linha da faixa vinda do campo `problems` do `GET /api/keybindings`.
 *
 * Existe separada de `KeyIssue` porque estes problemas nem sempre pertencem a
 * uma ação: `json-invalido` e `nao-e-objeto` são do arquivo inteiro, e
 * `acao-desconhecida` traz uma chave que NÃO é `KeyAction` (é justamente o
 * typo). Marcar a linha da tabela, como o `KeyIssue` faz, aqui não caberia.
 */
export interface KeyProblemNotice {
  /** Chave estável pra lista da faixa (o core pode repetir o mesmo `kind`). */
  id: string;
  /** Frase pronta, em pt-BR, dizendo o que o core fez com aquilo. */
  detail: string;
}

/** Nome legível de uma chave do arquivo: traduzido se for ação conhecida, cru se não. */
function actionLabel(action: string | undefined, lang: Language): string {
  if (action === undefined) return tUi(lang, 'settings.atalhos.acaoGenerica');
  const key = (KEY_ACTION_KEYS as Record<string, MessageKey | undefined>)[action];
  return key ? tUi(lang, key) : `"${action}"`;
}

/**
 * `problems` do core → as frases da faixa de aviso.
 *
 * Ausente (ou vazio) é o caminho normal: o core só manda o campo quando achou
 * algo, então arquivo impecável — ou perfil sem `keybindings.json` nenhum —
 * não gera linha nenhuma aqui.
 *
 * Cada frase diz o que o core FEZ, não só o que ele viu: quem abre o diálogo
 * quer saber se ainda vale o que escreveu no arquivo. Arquivo descartado
 * inteiro (`json-invalido`, `nao-e-objeto`) e linha ignorada são desfechos
 * diferentes.
 */
export function keybindingProblemNotices(
  problems: readonly KeybindingProblem[] | undefined,
  lang: Language,
): KeyProblemNotice[] {
  if (!problems || problems.length === 0) return [];
  return problems.map((problem, index) => {
    const id = `${index}:${problem.kind}:${problem.action ?? ''}`;
    switch (problem.kind) {
      case 'json-invalido':
        return { id, detail: tUi(lang, 'settings.atalhos.arquivo.jsonInvalido') };
      case 'nao-e-objeto':
        return { id, detail: tUi(lang, 'settings.atalhos.arquivo.naoEObjeto') };
      case 'acao-desconhecida':
        return {
          id,
          detail: tUi(lang, 'settings.atalhos.arquivo.acaoDesconhecida', { acao: actionLabel(problem.action, lang) }),
        };
      case 'atalho-invalido':
        return {
          id,
          detail: tUi(lang, 'settings.atalhos.arquivo.atalhoInvalido', { acao: actionLabel(problem.action, lang) }),
        };
      default: {
        // Kind novo no core contra uma UI velha: melhor uma linha genérica na
        // faixa do que sumir com o aviso. O `kind` é código, não texto — ele
        // entra cru, como o core o escreveu.
        const kind: string = (problem as KeybindingProblem).kind;
        return { id, detail: tUi(lang, 'settings.atalhos.arquivo.generico', { kind }) };
      }
    }
  });
}

/**
 * O título da faixa de aviso; `undefined` = nada a dizer.
 *
 * Conta os DOIS lados — o que a UI deduziu da tabela (`issues`) e o que o core
 * relatou da leitura do arquivo (`notices`) —, porque a faixa é uma só e um
 * título que ignorasse metade mentiria no número.
 */
export function keybindingsWarning(
  issues: readonly KeyIssue[],
  lang: Language,
  notices: readonly KeyProblemNotice[] = [],
): string | undefined {
  const total = issues.length + notices.length;
  if (total === 0) return undefined;
  return total === 1
    ? tUi(lang, 'settings.atalhos.aviso.um')
    : tUi(lang, 'settings.atalhos.aviso.varios', { n: total });
}

/**
 * A tabela read-only da seção "Atalhos", na ordem de `KEY_ACTIONS` (que é a
 * ordem da spec §6). Ação que o core mandou sem combinação aparece com um
 * travessão em vez de sumir da tabela, e a que tem problema vem marcada.
 */
export function keyRows(bindings: Partial<Record<KeyAction, string>>, lang: Language): KeyRow[] {
  const byAction = new Map(keybindingIssues(bindings, lang).map((issue) => [issue.action, issue.kind]));
  return KEY_ACTIONS.map((action) => {
    const issue = byAction.get(action);
    return {
      action,
      label: keyActionLabel(action, lang),
      chord: bindings[action] ?? '—',
      ...(issue ? { issue } : {}),
    };
  });
}

/**
 * Onde o perfil mora quando a config ainda não chegou. É um LITERAL com
 * variável de ambiente: serve pra ler, nunca pra abrir — o `shell.openPath`
 * do Electron não expande `%APPDATA%`, e o handler do preload só abre pasta
 * que existe. Enquanto for este valor, o botão não aparece.
 */
export const PROFILE_DIR_HINT = '%APPDATA%\\bridge';

/** Rótulo do botão da seção "Atalhos" — o que ele abre é a PASTA, não o arquivo. */
export function profileFolderLabel(lang: Language): string {
  return tUi(lang, 'settings.atalhos.abrirPasta');
}

/** Frase de apoio: sem ela, "pasta do perfil" não diz onde o arquivo está. */
export function keybindingsHint(lang: Language): string {
  return tUi(lang, 'settings.atalhos.dica');
}

/** Pasta do perfil, absoluta, vinda do core; o literal só como último recurso. */
export function profileFolderPath(config: BridgeConfig | undefined): string {
  const dir = config?.profileDir?.trim();
  return dir ? dir : PROFILE_DIR_HINT;
}

/** Caminho cheio do `keybindings.json` — é o que o modo web mostra em texto. */
export function keybindingsPath(config: BridgeConfig | undefined): string {
  return `${profileFolderPath(config)}\\keybindings.json`;
}

/**
 * Só dá pra oferecer "Abrir pasta do perfil" com um caminho ABSOLUTO em mãos.
 * Sem config carregada (GET em voo, core velho sem `profileDir`) o botão
 * seria um clique que não faz nada — e foi exatamente esse o defeito da
 * primeira versão, que mandava `'%APPDATA%\\bridge\\keybindings.json'` pro
 * `openPath` e via o handler do shell descartar em silêncio.
 */
export function canOpenProfileFolder(config: BridgeConfig | undefined): boolean {
  const dir = config?.profileDir?.trim();
  return dir !== undefined && dir !== '' && dir !== PROFILE_DIR_HINT && !dir.includes('%');
}

// ------------------------------------------- envio: ordem e volta do rascunho

export interface FieldSeq {
  /** Marca um envio novo daquele campo e devolve o número dele. */
  bump(field: string): number;
  /** A resposta de número `seq` ainda é a do ÚLTIMO envio daquele campo? */
  isLatest(field: string, seq: number): boolean;
}

/**
 * Sequência de envio POR CAMPO — o mesmo remédio do `fetchSeqRef` do
 * `Terminal.tsx`, pela mesma razão.
 *
 * O campo de número manda um `PATCH` a cada tecla válida: digitar `1`, `4` na
 * caixa do tamanho dispara dois pedidos, e nada garante que o do `14` volte
 * depois do `1`. Sem esta guarda, a resposta atrasada do `1` chamaria
 * `onSaved` por último e a config do app voltaria pro valor antigo — com o
 * campo na tela mostrando 14. É por campo (não global) porque mexer no
 * tamanho da fonte não tem por que invalidar um `toast` enviado no mesmo
 * segundo.
 */
export function makeFieldSeq(): FieldSeq {
  const latest = new Map<string, number>();
  let counter = 0;
  return {
    bump(field) {
      counter += 1;
      latest.set(field, counter);
      return counter;
    },
    isLatest(field, seq) {
      return latest.get(field) === seq;
    },
  };
}

/**
 * Pra onde o rascunho volta quando o `PATCH` daquele campo falha: o valor
 * CONFIRMADO pelo servidor. Sem isto, o 400/500 deixava a caixa mostrando o
 * número recusado — a faixa dizia "não salvou" e o campo dizia o contrário.
 */
export function revertedDraft(config: BridgeConfig | undefined, field: SettingsField): string {
  return String(fieldValue(config, field));
}

/**
 * Largura da moldura da prévia, em células. As três linhas têm exatamente
 * estas colunas de moldura, então ela só fecha na tela se a fonte escolhida
 * desenhar box-drawing, blocos e letras todos no MESMO avanço — que é
 * precisamente o defeito que quebrou o logo do Claude Code no lote de 04/09.
 */
export const FONT_PREVIEW_FRAME_WIDTH = 40;

/**
 * As três linhas da prévia da fonte: régua de box-drawing, um pedaço do logo
 * do Claude Code (blocos de quadrante) e uma linha de statusline.
 *
 * O ✻ (e o ❄ ⛔ ao lado dele) fica FORA da moldura, depois do canto de baixo,
 * de propósito: nenhuma mono da máquina do dono tem esses três, então eles
 * sempre vêm de uma fonte de fallback com avanço próprio — dentro da moldura
 * eles empurravam a linha do meio uma fração de célula pra direita e a caixa
 * NUNCA fechava, nem com a fonte certa. Fora dela, eles continuam sendo a
 * amostra que o plano pediu (dá pra ver se a máquina desenha o ✻ do Claude)
 * sem transformar o acerto em erro aparente.
 */
export const FONT_PREVIEW_LINES: readonly string[] = [
  '╭─────────────── bridge ───────────────╮',
  '│  ▐▛███▜▌  Claude Code  ▝▜██████▛▘    │',
  '╰─ Fable · 87k ctx · $3.42 · 5h 23% ───╯  ✻ ❄ ⛔',
];
