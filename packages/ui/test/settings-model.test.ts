import { DEFAULT_KEYBINDINGS, DEFAULT_STORED_CONFIG, KEY_ACTIONS } from '@bridge/shared';
import type { BridgeConfig } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { tUi } from '../src/i18n.js';
import {
  canOpenProfileFolder,
  defaultsPatchFor,
  fieldValue,
  FONT_PREVIEW_FRAME_WIDTH,
  FONT_PREVIEW_LINES,
  GIT_POLL_SECONDS_MAX,
  GIT_POLL_SECONDS_MIN,
  keyActionLabel,
  keyIssueTitles,
  keybindingsHint,
  keybindingIssues,
  keybindingProblemNotices,
  keybindingsPath,
  keybindingsWarning,
  keyRows,
  loginItemLoading,
  loginItemNote,
  LOGIN_ITEM_RUN_KEY,
  loginItemView,
  makeFieldSeq,
  MONO_FONT_SUGGESTIONS,
  nextLoginItem,
  patchForField,
  PROFILE_DIR_HINT,
  profileFolderLabel,
  profileFolderPath,
  revertedDraft,
  MAX_CONCURRENT_AGENTS_MAX,
  MAX_CONCURRENT_AGENTS_MIN,
  scheduleLaunchesNote,
  SETTINGS_DEFAULTS,
  settingsSections,
  shellOptions,
  PRICING_EXAMPLE,
  PRICING_FILE_MAX,
  pricingAsOfLabel,
  terminalStatusLineNote,
} from '../src/settingsModel.js';
import type { SettingsField } from '../src/settingsModel.js';
import type { LoginItemState } from '../src/bridge.js';
import { TERMINAL_DEFAULTS, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../src/terminalPrefs.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 4560,
    shell: 'pwsh',
    claudeHome: 'C:\\perfil\\.claude',
    usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false },
    sessions: { maxConcurrentAgents: 4, scheduleLaunches: true, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
    profileDir: 'C:\\perfil\\bridge',
    gitPollSeconds: 15,
    toast: { enabled: true, quietWhenFocused: true },
    terminal: { fontFamily: 'Consolas', fontSize: 13 },
    restore: { resumeAgents: true },
    // Idioma (spec §13): o helper fixa `pt-BR` pra que as asserções de texto
    // deste arquivo continuem valendo palavra por palavra.
    ui: { language: 'system' },
    languageResolved: 'pt-BR',
    ...overrides,
  };
}

describe('sessions.mouseClicks (clique do mouse no Claude Code)', () => {
  it('patchForField grava o booleano e fieldValue nasce ligado', () => {
    expect(patchForField('sessions.mouseClicks', false, PT)).toEqual({ ok: true, patch: { sessions: { mouseClicks: false } } });
    expect(fieldValue(undefined, 'sessions.mouseClicks')).toBe(true);
    expect(fieldValue({ sessions: { mouseClicks: false } } as never, 'sessions.mouseClicks')).toBe(false);
  });
});

describe('seções', () => {
  it('são oito, com id único e na ordem do plano', () => {
    expect(settingsSections(PT).map((s) => s.id)).toEqual([
      'terminal',
      'sessions',
      'notifications',
      'usage',
      'git',
      'keys',
      'appearance',
      'system',
    ]);
    expect(new Set(settingsSections(PT).map((s) => s.id)).size).toBe(settingsSections(PT).length);
    for (const section of settingsSections(PT)) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('patchForField: corpo do PATCH', () => {
  it('aninha o campo do jeito que a rota espera, um campo por vez', () => {
    expect(patchForField('terminal.fontFamily', ' JetBrains Mono ', PT)).toEqual({
      ok: true,
      patch: { terminal: { fontFamily: 'JetBrains Mono' } },
    });
    expect(patchForField('terminal.fontSize', '14', PT)).toEqual({ ok: true, patch: { terminal: { fontSize: 14 } } });
    expect(patchForField('gitPollSeconds', 30, PT)).toEqual({ ok: true, patch: { gitPollSeconds: 30 } });
    expect(patchForField('shell', 'gitbash', PT)).toEqual({ ok: true, patch: { shell: 'gitbash' } });
    expect(patchForField('toast.enabled', false, PT)).toEqual({ ok: true, patch: { toast: { enabled: false } } });
    expect(patchForField('toast.quietWhenFocused', true, PT)).toEqual({
      ok: true,
      patch: { toast: { quietWhenFocused: true } },
    });
    expect(patchForField('restore.resumeAgents', false, PT)).toEqual({
      ok: true,
      patch: { restore: { resumeAgents: false } },
    });
  });

  it('nunca manda o irmão junto — é o merge profundo do core que preserva o outro', () => {
    const result = patchForField('toast.enabled', false, PT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.patch)).toEqual(['toast']);
    expect(Object.keys(result.patch.toast ?? {})).toEqual(['enabled']);
  });
});

describe('patchForField: faixas espelhadas da API', () => {
  it('aceita as bordas do corpo da fonte e recusa fora delas', () => {
    expect(patchForField('terminal.fontSize', TERMINAL_FONT_SIZE_MIN, PT).ok).toBe(true);
    expect(patchForField('terminal.fontSize', TERMINAL_FONT_SIZE_MAX, PT).ok).toBe(true);
    expect(patchForField('terminal.fontSize', TERMINAL_FONT_SIZE_MIN - 1, PT).ok).toBe(false);
    expect(patchForField('terminal.fontSize', TERMINAL_FONT_SIZE_MAX + 1, PT).ok).toBe(false);
  });

  it('aceita as bordas do poll de git e recusa fora delas', () => {
    expect(patchForField('gitPollSeconds', GIT_POLL_SECONDS_MIN, PT).ok).toBe(true);
    expect(patchForField('gitPollSeconds', GIT_POLL_SECONDS_MAX, PT).ok).toBe(true);
    expect(patchForField('gitPollSeconds', 4, PT).ok).toBe(false);
    expect(patchForField('gitPollSeconds', 121, PT).ok).toBe(false);
  });

  it('recusa não-inteiro e texto que não é número', () => {
    expect(patchForField('terminal.fontSize', 12.5, PT).ok).toBe(false);
    expect(patchForField('terminal.fontSize', '12,5', PT).ok).toBe(false);
    expect(patchForField('gitPollSeconds', 'trinta', PT).ok).toBe(false);
  });

  /**
   * Campo apagado no meio da digitação (`<input type=number>` devolve `''`)
   * não pode virar 0: seria um PATCH que o core recusa com 400 enquanto o
   * usuário ainda está escrevendo o número que ele quer.
   */
  it('campo vazio é recusado localmente, não vira zero', () => {
    expect(patchForField('terminal.fontSize', '', PT)).toEqual({
      ok: false,
      error: `O corpo da fonte é um inteiro entre ${TERMINAL_FONT_SIZE_MIN} e ${TERMINAL_FONT_SIZE_MAX}.`,
    });
    expect(patchForField('gitPollSeconds', '   ', PT).ok).toBe(false);
  });

  it('fonte vazia ou com mais de 200 caracteres é recusada', () => {
    expect(patchForField('terminal.fontFamily', '   ', PT)).toEqual({ ok: false, error: 'A fonte não pode ficar vazia.' });
    expect(patchForField('terminal.fontFamily', 'x'.repeat(200), PT).ok).toBe(true);
    expect(patchForField('terminal.fontFamily', 'x'.repeat(201), PT).ok).toBe(false);
  });

  it('shell fora dos três conhecidos é recusado', () => {
    expect(patchForField('shell', 'zsh', PT)).toEqual({ ok: false, error: 'Shell desconhecido: zsh.' });
    for (const option of shellOptions(PT)) expect(patchForField('shell', option.value, PT).ok).toBe(true);
  });
});

describe('SETTINGS_DEFAULTS', () => {
  it('deriva do DEFAULT_STORED_CONFIG do shared — o mesmo default do core', () => {
    // Concern da T5b fechado: era uma cópia literal do DEFAULT_CONFIG do core,
    // sem nada ligando os dois. Mudar um default lá agora quebra aqui.
    expect(SETTINGS_DEFAULTS).toEqual({
      shell: DEFAULT_STORED_CONFIG.shell,
      gitPollSeconds: DEFAULT_STORED_CONFIG.gitPollSeconds,
      toast: DEFAULT_STORED_CONFIG.toast,
      terminal: DEFAULT_STORED_CONFIG.terminal,
      restore: DEFAULT_STORED_CONFIG.restore,
      ui: DEFAULT_STORED_CONFIG.ui,
      usage: DEFAULT_STORED_CONFIG.usage,
      sessions: DEFAULT_STORED_CONFIG.sessions,
    });
  });

  it('só traz o que o PATCH aceita — port fica de fora', () => {
    expect(Object.keys(SETTINGS_DEFAULTS).sort()).toEqual([
      'gitPollSeconds',
      'restore',
      'sessions',
      'shell',
      'terminal',
      'toast',
      'ui',
      'usage',
    ]);
  });

  it('os objetos aninhados são cópias: o default do shared não é mutável por aqui', () => {
    expect(SETTINGS_DEFAULTS.toast).not.toBe(DEFAULT_STORED_CONFIG.toast);
    expect(SETTINGS_DEFAULTS.terminal).not.toBe(DEFAULT_STORED_CONFIG.terminal);
  });
});

describe('restaurar padrões', () => {
  it('terminal repõe fonte, corpo e shell — e a fonte é a mesma do TERMINAL_DEFAULTS', () => {
    expect(defaultsPatchFor('terminal')).toEqual({
      shell: 'pwsh',
      terminal: { fontFamily: TERMINAL_DEFAULTS.fontFamily, fontSize: TERMINAL_DEFAULTS.fontSize },
    });
  });

  it('notificações, sessões e git repõem só o que é deles', () => {
    expect(defaultsPatchFor('notifications')).toEqual({ toast: { enabled: true, quietWhenFocused: true } });
    expect(defaultsPatchFor('sessions')).toEqual({
      restore: { resumeAgents: true },
      sessions: { maxConcurrentAgents: 4, scheduleLaunches: true, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
    });
    expect(defaultsPatchFor('git')).toEqual({ gitPollSeconds: 15 });
  });

  it('atalhos e sistema não têm o que restaurar (o botão nem aparece)', () => {
    // "Atalhos" vive no `keybindings.json`, fora do `PATCH /api/config`; e
    // "Sistema" não passa pelo PATCH — o estado é do Windows, não do
    // config.json.
    expect(defaultsPatchFor('keys')).toBeUndefined();
    expect(defaultsPatchFor('system')).toBeUndefined();
  });

  /**
   * "Aparência" passou a ter o que restaurar na Task 3 do lote de idioma: até
   * ela a seção era só um tema fixo e desabilitado, e o botão não aparecia.
   * Agora ela tem o `ui.language`, e "Restaurar padrões" devolve o `system`.
   */
  it('aparência restaura o idioma para "do sistema"', () => {
    expect(defaultsPatchFor('appearance')).toEqual({ ui: { language: 'system' } });
  });

  it('o payload é uma CÓPIA: mexer nele não contamina o SETTINGS_DEFAULTS', () => {
    const patch = defaultsPatchFor('notifications');
    expect(patch?.toast).not.toBe(SETTINGS_DEFAULTS.toast);
    if (patch?.toast) patch.toast.enabled = false;
    expect(SETTINGS_DEFAULTS.toast.enabled).toBe(true);
  });

  it('tudo que "restaurar padrões" manda passa pela própria validação', () => {
    for (const section of settingsSections(PT)) {
      const patch = defaultsPatchFor(section.id);
      if (!patch) continue;
      if (patch.shell !== undefined) expect(patchForField('shell', patch.shell, PT).ok).toBe(true);
      if (patch.gitPollSeconds !== undefined) expect(patchForField('gitPollSeconds', patch.gitPollSeconds, PT).ok).toBe(true);
      if (patch.terminal?.fontSize !== undefined) {
        expect(patchForField('terminal.fontSize', patch.terminal.fontSize, PT).ok).toBe(true);
      }
      if (patch.terminal?.fontFamily !== undefined) {
        expect(patchForField('terminal.fontFamily', patch.terminal.fontFamily, PT).ok).toBe(true);
      }
    }
  });
});

describe('fieldValue', () => {
  const fields: SettingsField[] = [
    'terminal.fontFamily',
    'terminal.fontSize',
    'shell',
    'toast.enabled',
    'toast.quietWhenFocused',
    'gitPollSeconds',
    'restore.resumeAgents',
    'sessions.maxConcurrentAgents',
    'sessions.scheduleLaunches',
    'sessions.hostedAgents',
  ];

  it('lê a config em vigor', () => {
    const current = config({ shell: 'gitbash', gitPollSeconds: 90, toast: { enabled: false, quietWhenFocused: false } });
    expect(fieldValue(current, 'terminal.fontFamily')).toBe('Consolas');
    expect(fieldValue(current, 'terminal.fontSize')).toBe(13);
    expect(fieldValue(current, 'shell')).toBe('gitbash');
    expect(fieldValue(current, 'toast.enabled')).toBe(false);
    expect(fieldValue(current, 'toast.quietWhenFocused')).toBe(false);
    expect(fieldValue(current, 'gitPollSeconds')).toBe(90);
    expect(fieldValue(config({ restore: { resumeAgents: false } }), 'restore.resumeAgents')).toBe(false);
  });

  it('sem config (GET em voo, ou core velho) cai no default de cada campo', () => {
    expect(fieldValue(undefined, 'terminal.fontFamily')).toBe(TERMINAL_DEFAULTS.fontFamily);
    expect(fieldValue(undefined, 'terminal.fontSize')).toBe(TERMINAL_DEFAULTS.fontSize);
    expect(fieldValue(undefined, 'shell')).toBe('pwsh');
    expect(fieldValue(undefined, 'toast.enabled')).toBe(true);
    expect(fieldValue(undefined, 'gitPollSeconds')).toBe(15);
    expect(fieldValue(undefined, 'restore.resumeAgents')).toBe(true);
  });

  /** `false` é valor legítimo: um `??` no lugar errado o trocaria pelo default. */
  it('não confunde false com ausência', () => {
    const current = config({ toast: { enabled: false, quietWhenFocused: false } });
    expect(fieldValue(current, 'toast.enabled')).toBe(false);
    expect(fieldValue(current, 'toast.quietWhenFocused')).toBe(false);
    // O resume desligado é a razão de existir da seção Sessões: cair no
    // default aqui ligaria de volta o que o dono desligou.
    expect(fieldValue(config({ restore: { resumeAgents: false } }), 'restore.resumeAgents')).toBe(false);
  });

  it('todo campo do union tem valor e volta a ser aceito pela validação', () => {
    for (const field of fields) {
      const value = fieldValue(config(), field);
      expect(patchForField(field, value, PT).ok).toBe(true);
    }
  });
});

describe('tabela de atalhos', () => {
  it('tem uma linha por ação, na ordem de KEY_ACTIONS', () => {
    const rows = keyRows(DEFAULT_KEYBINDINGS, PT);
    expect(rows).toHaveLength(KEY_ACTIONS.length);
    expect(rows.map((r) => r.action)).toEqual(KEY_ACTIONS);
    expect(rows.find((r) => r.action === 'settings.open')?.chord).toBe('Ctrl+,');
  });

  /** Ação nova no shared sem rótulo aqui sairia com `undefined` na tabela. */
  it('toda ação tem rótulo próprio, e nenhuma repete o de outra', () => {
    const rotulos = KEY_ACTIONS.map((action) => keyActionLabel(action, PT));
    for (const [i, rotulo] of rotulos.entries()) {
      expect(rotulo, KEY_ACTIONS[i]).toBeTruthy();
      // Rótulo que "existe" mas é a chave crua é o defeito que este teste pega.
      expect(rotulo, KEY_ACTIONS[i]).not.toContain('settings.atalhos.');
    }
    expect(rotulos).toHaveLength(KEY_ACTIONS.length);
    expect(new Set(rotulos).size).toBe(KEY_ACTIONS.length);
  });

  it('ação sem combinação vira travessão em vez de sumir da tabela', () => {
    const rows = keyRows({ 'tab.new': 'Ctrl+T' }, PT);
    expect(rows.find((r) => r.action === 'tab.new')?.chord).toBe('Ctrl+T');
    expect(rows.find((r) => r.action === 'pane.close')?.chord).toBe('—');
    expect(rows).toHaveLength(KEY_ACTIONS.length);
  });

  it('a tabela de fábrica não tem nenhuma linha marcada', () => {
    expect(keyRows(DEFAULT_KEYBINDINGS, PT).some((r) => r.issue !== undefined)).toBe(false);
  });

  it('a linha problemática vem marcada pro diálogo desenhar o ⚠', () => {
    const rows = keyRows({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'Ctrl+' }, PT);
    expect(rows.find((r) => r.action === 'pane.close')?.issue).toBe('invalid');
    expect(rows.find((r) => r.action === 'tab.new')?.issue).toBeUndefined();
  });
});

/**
 * O aviso da seção "Atalhos". O core aceita QUALQUER string não vazia no
 * `keybindings.json` (ele só recusa o que não é string e a ação desconhecida),
 * então `"Ctrl+"` chegava na tabela como se fosse um atalho de verdade — e o
 * usuário ficava apertando uma tecla que nunca ia disparar. Aqui a UI olha a
 * tabela recebida com o MESMO parser do `handleKeyDown` e diz o que não vai
 * funcionar.
 */
describe('avisos do keybindings.json', () => {
  it('a tabela de fábrica não tem aviso nenhum', () => {
    expect(keybindingIssues(DEFAULT_KEYBINDINGS, PT)).toEqual([]);
    expect(keybindingsWarning([], PT)).toBeUndefined();
  });

  it('combinação que o Bridge não lê vira aviso, com o nome da ação em pt-BR', () => {
    const issues = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'Ctrl+Shift' }, PT);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ action: 'pane.close', kind: 'invalid' });
    expect(issues[0]?.detail).toContain(keyActionLabel('pane.close', PT));
    expect(issues[0]?.detail).toContain('Ctrl+Shift');
  });

  /**
   * `handleKeyDown` varre na ordem de `KEY_ACTIONS` e para no primeiro que
   * casa: a ação de baixo fica inalcançável pelo teclado, e nada dizia isso.
   */
  it('duas ações na mesma tecla: a de baixo é a marcada, apontando quem ficou com ela', () => {
    const issues = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': DEFAULT_KEYBINDINGS['tab.new'] }, PT);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ action: 'pane.close', kind: 'duplicate' });
    expect(issues[0]?.detail).toContain(keyActionLabel('tab.new', PT));
  });

  it('a mesma tecla escrita em outra ordem também colide', () => {
    const issues = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'shift+ctrl+t' }, PT);
    expect(issues.map((i) => i.kind)).toEqual(['duplicate']);
  });

  it('ação ausente na resposta não vira aviso — ela cai no default e some da conta', () => {
    expect(keybindingIssues({ 'tab.new': 'Ctrl+T' }, PT)).toEqual([]);
  });

  it('o título da faixa conta quantos problemas existem', () => {
    const um = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'Ctrl+' }, PT);
    expect(keybindingsWarning(um, PT)).toContain('um problema');
    const dois = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'Ctrl+', 'pane.splitH': 'nada' }, PT);
    expect(dois).toHaveLength(2);
    expect(keybindingsWarning(dois, PT)).toContain('2 problemas');
  });

  it('cada tipo de problema tem uma explicação pro ⚠ da linha', () => {
    expect(keyIssueTitles(PT).invalid).toBeTruthy();
    expect(keyIssueTitles(PT).duplicate).toBeTruthy();
  });
});

/**
 * O outro lado do aviso: o que o core relatou da LEITURA do arquivo, no campo
 * irmão `problems` do `GET /api/keybindings`. A UI não tem como deduzir nada
 * disso da tabela — ela chega íntegra, com os defaults no lugar do que o core
 * descartou —, e até a 0.8.0 um `keybindings.json` com JSON quebrado sumia em
 * silêncio: o `warn` ia pro `core.log` e o diálogo mostrava os atalhos de
 * fábrica como se fossem a escolha do dono.
 */
describe('problems do GET /api/keybindings na faixa', () => {
  it('sem campo (arquivo impecável, ou core velho) não gera linha nenhuma', () => {
    expect(keybindingProblemNotices(undefined, PT)).toEqual([]);
    expect(keybindingProblemNotices([], PT)).toEqual([]);
    expect(keybindingsWarning([], PT, [])).toBeUndefined();
  });

  it('arquivo descartado inteiro diz que valem os padrões', () => {
    const quebrado = keybindingProblemNotices([{ kind: 'json-invalido' }], PT);
    expect(quebrado).toHaveLength(1);
    expect(quebrado[0]?.detail).toContain('padrão');
    const topo = keybindingProblemNotices([{ kind: 'nao-e-objeto' }], PT);
    expect(topo[0]?.detail).toContain('objeto no topo');
  });

  /**
   * `acao-desconhecida` traz uma chave que NÃO é `KeyAction` (é o typo), então
   * não há rótulo em pt-BR pra ela: a frase mostra a chave crua, entre aspas,
   * senão o dono não acha a linha do arquivo.
   */
  it('ação desconhecida mostra a chave crua do arquivo', () => {
    const [notice] = keybindingProblemNotices([{ kind: 'acao-desconhecida', action: 'pane.fechar' }], PT);
    expect(notice?.detail).toContain('"pane.fechar"');
    expect(notice?.detail).toContain('ignorada');
  });

  /** Já `atalho-invalido` é de uma ação REAL: o nome sai em pt-BR. */
  it('valor que não é texto usa o nome em pt-BR da ação', () => {
    const [notice] = keybindingProblemNotices([{ kind: 'atalho-invalido', action: 'pane.close' }], PT);
    expect(notice?.detail).toContain(keyActionLabel('pane.close', PT));
    expect(notice?.detail).not.toContain('pane.close"');
  });

  it('cada linha tem chave própria, mesmo com o mesmo kind repetido', () => {
    const ids = keybindingProblemNotices([
      { kind: 'acao-desconhecida', action: 'a' },
      { kind: 'acao-desconhecida', action: 'b' },
      { kind: 'acao-desconhecida', action: 'a' },
    ],PT).map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
  });

  /** A faixa é UMA: o título tem que contar os dois lados, ou mente no número. */
  it('o título soma os problemas do core com os que a UI deduziu', () => {
    const issues = keybindingIssues({ ...DEFAULT_KEYBINDINGS, 'pane.close': 'Ctrl+' }, PT);
    const notices = keybindingProblemNotices([{ kind: 'atalho-invalido', action: 'tab.new' }], PT);
    expect(keybindingsWarning(issues, PT, notices)).toContain('2 problemas');
    expect(keybindingsWarning([], PT, notices)).toContain('um problema');
  });
});

/**
 * O defeito da primeira rodada: o botão mandava o literal
 * `'%APPDATA%\bridge\keybindings.json'` pro `openPath`, e o handler do shell
 * (que só abre PASTA existente, e não expande variável de ambiente) descartava
 * em silêncio. Agora o caminho vem do `profileDir` do core.
 */
describe('pasta do perfil (seção Atalhos)', () => {
  it('usa o profileDir absoluto que o core mandou', () => {
    const current = config({ profileDir: 'C:\\projetos\\perfil\\bridge' });
    expect(profileFolderPath(current)).toBe('C:\\projetos\\perfil\\bridge');
    expect(keybindingsPath(current)).toBe('C:\\projetos\\perfil\\bridge\\keybindings.json');
    expect(canOpenProfileFolder(current)).toBe(true);
  });

  it('sem config, mostra o literal e NÃO oferece o botão', () => {
    expect(profileFolderPath(undefined)).toBe(PROFILE_DIR_HINT);
    expect(keybindingsPath(undefined)).toBe('%APPDATA%\\bridge\\keybindings.json');
    // O clique abriria nada: melhor mostrar o caminho pra copiar.
    expect(canOpenProfileFolder(undefined)).toBe(false);
  });

  it('recusa abrir qualquer caminho com variável de ambiente ou vazio', () => {
    expect(canOpenProfileFolder(config({ profileDir: '' }))).toBe(false);
    expect(canOpenProfileFolder(config({ profileDir: '   ' }))).toBe(false);
    expect(canOpenProfileFolder(config({ profileDir: PROFILE_DIR_HINT }))).toBe(false);
    expect(canOpenProfileFolder(config({ profileDir: '%LOCALAPPDATA%\\bridge' }))).toBe(false);
  });

  it('o rótulo fala de pasta, e a dica diz onde o arquivo está', () => {
    expect(profileFolderLabel(PT)).toBe('Abrir pasta do perfil');
    expect(keybindingsHint(PT)).toContain('keybindings.json');
  });
});

describe('prévia e sugestões', () => {
  /**
   * A prévia existe pra responder "essa fonte tem os glifos?". Se ela deixar
   * de imprimir box-drawing e blocos, vira decoração — por isso o teste olha
   * os codepoints, não o texto.
   */
  it('as três linhas trazem box-drawing, blocos e o ✻ do Claude', () => {
    expect(FONT_PREVIEW_LINES).toHaveLength(3);
    const all = FONT_PREVIEW_LINES.join('');
    expect(/[\u2500-\u257F]/u.test(all)).toBe(true);
    expect(/[\u2580-\u259F]/u.test(all)).toBe(true);
    expect(all).toContain('✻');
  });

  /**
   * A moldura só fecha se as três linhas tiverem as MESMAS colunas de
   * moldura. A primeira versão errava por um caractere (42/41/41) e a segunda
   * punha o ✻ dentro da caixa — nos dois casos o screenshot mostrava um `│`
   * solto pra fora, com a fonte certa instalada.
   */
  it('as três linhas fecham na mesma coluna', () => {
    const [top, middle, bottom] = FONT_PREVIEW_LINES as [string, string, string];
    expect(top).toHaveLength(FONT_PREVIEW_FRAME_WIDTH);
    expect(middle).toHaveLength(FONT_PREVIEW_FRAME_WIDTH);
    expect(bottom.length).toBeGreaterThanOrEqual(FONT_PREVIEW_FRAME_WIDTH);
    expect([top[0], middle[0], bottom[0]]).toEqual(['╭', '│', '╰']);
    const last = FONT_PREVIEW_FRAME_WIDTH - 1;
    expect([top[last], middle[last], bottom[last]]).toEqual(['╮', '│', '╯']);
  });

  /** Os três que nenhuma mono da máquina tem ficam DEPOIS do canto de baixo. */
  it('o ✻ e os símbolos de fallback ficam fora da moldura', () => {
    const [top, middle, bottom] = FONT_PREVIEW_LINES as [string, string, string];
    expect(top).not.toContain('✻');
    expect(middle).not.toContain('✻');
    expect(bottom.slice(0, FONT_PREVIEW_FRAME_WIDTH)).not.toContain('✻');
    expect(bottom.slice(FONT_PREVIEW_FRAME_WIDTH)).toContain('✻');
  });

  it('as sugestões de fonte são monoespaçadas conhecidas, sem repetição', () => {
    expect(MONO_FONT_SUGGESTIONS).toContain('Cascadia Mono');
    expect(MONO_FONT_SUGGESTIONS).toContain('Consolas');
    expect(MONO_FONT_SUGGESTIONS).toContain('Geist Mono');
    expect(new Set(MONO_FONT_SUGGESTIONS).size).toBe(MONO_FONT_SUGGESTIONS.length);
  });
});

describe('makeFieldSeq: resposta atrasada não ganha', () => {
  /**
   * O caso real: digitar "1" e depois "4" na caixa do tamanho dispara dois
   * PATCH. Se o do "1" voltar por último e for aplicado, a config do app volta
   * pra 1 com o campo na tela mostrando 14.
   */
  it('só o último envio de um campo é o vencedor', () => {
    const seq = makeFieldSeq();
    const first = seq.bump('terminal.fontSize');
    const second = seq.bump('terminal.fontSize');

    expect(seq.isLatest('terminal.fontSize', second)).toBe(true);
    expect(seq.isLatest('terminal.fontSize', first)).toBe(false);
  });

  /** Um envio só: ele é o último, obviamente — e a resposta tem que passar. */
  it('envio único é sempre o último', () => {
    const seq = makeFieldSeq();
    expect(seq.isLatest('gitPollSeconds', seq.bump('gitPollSeconds'))).toBe(true);
  });

  /** Por campo, não global: mexer na fonte não pode anular um toast em voo. */
  it('campos diferentes não invalidam um ao outro', () => {
    const seq = makeFieldSeq();
    const font = seq.bump('terminal.fontFamily');
    seq.bump('toast.enabled');
    seq.bump('gitPollSeconds');

    expect(seq.isLatest('terminal.fontFamily', font)).toBe(true);
  });

  it('campo nunca enviado não reconhece número nenhum', () => {
    const seq = makeFieldSeq();
    seq.bump('terminal.fontSize');
    expect(seq.isLatest('shell', 1)).toBe(false);
  });

  it('cada instância tem a própria contagem (um diálogo não fala com o outro)', () => {
    const a = makeFieldSeq();
    const b = makeFieldSeq();
    const fromA = a.bump('shell');
    b.bump('shell');
    expect(a.isLatest('shell', fromA)).toBe(true);
    expect(b.isLatest('shell', fromA)).toBe(true);
  });
});

describe('revertedDraft: o campo volta ao valor confirmado', () => {
  /**
   * PATCH recusado (400 do core, 500, rede caída) não salvou nada. Deixar o
   * valor recusado na caixa faria a faixa de erro dizer "não salvou" e o campo
   * dizer o contrário.
   */
  it('devolve o valor do servidor, como string pro input', () => {
    const current = config({ gitPollSeconds: 30, terminal: { fontFamily: 'Consolas', fontSize: 13 } });
    expect(revertedDraft(current, 'gitPollSeconds')).toBe('30');
    expect(revertedDraft(current, 'terminal.fontSize')).toBe('13');
    expect(revertedDraft(current, 'terminal.fontFamily')).toBe('Consolas');
  });

  it('sem config carregada, volta pro default do campo', () => {
    expect(revertedDraft(undefined, 'terminal.fontSize')).toBe(String(TERMINAL_DEFAULTS.fontSize));
    expect(revertedDraft(undefined, 'gitPollSeconds')).toBe('15');
  });

  /** O que volta pro campo tem que ser aceito por ele — senão o erro se repete. */
  it('o valor devolvido passa pela própria validação', () => {
    const current = config({ gitPollSeconds: 120 });
    for (const field of ['terminal.fontFamily', 'terminal.fontSize', 'gitPollSeconds'] as const) {
      expect(patchForField(field, revertedDraft(current, field), PT).ok).toBe(true);
    }
  });
});

// ------------------------------------------------- sistema: início automático

function loginState(overrides: Partial<LoginItemState> = {}): LoginItemState {
  return { enabled: false, startMinimized: false, supported: true, status: '', ...overrides };
}

describe('loginItemView', () => {
  it('sem resposta ainda: desmarcado e travado, nunca marcado por chute', () => {
    expect(loginItemView(undefined, PT)).toEqual({
      enabled: false,
      startMinimized: false,
      disabled: true,
      minimizedDisabled: true,
      note: loginItemLoading(PT),
    });
  });

  it('desligado trava a sub-opção — "minimizado" sem auto-start não qualifica nada', () => {
    const view = loginItemView(loginState({ enabled: false }), PT);
    expect(view.disabled).toBe(false);
    expect(view.minimizedDisabled).toBe(true);
    expect(view.note).toBe(loginItemNote(PT));
  });

  it('ligado libera a sub-opção e mostra onde a entrada é criada', () => {
    const view = loginItemView(loginState({ enabled: true, startMinimized: true }), PT);
    expect(view).toEqual({
      enabled: true,
      startMinimized: true,
      disabled: false,
      minimizedDisabled: false,
      note: loginItemNote(PT),
    });
    expect(view.note).toContain(LOGIN_ITEM_RUN_KEY);
    // A chave do registro sai com a barra invertida de verdade — é o que o
    // dono cola no `reg query`.
    expect(LOGIN_ITEM_RUN_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  });

  it('sem suporte (web ou dev): trava os dois e traduz a CHAVE que veio do shell', () => {
    // O `status` é chave de catálogo desde a Task 4 — o shell não manda frase
    // pronta, justamente pra que a seção não fique num idioma e o resto do
    // diálogo em outro.
    const status = 'shell.loginItem.dev' as const;
    const view = loginItemView(loginState({ enabled: true, startMinimized: true, supported: false, status }), PT);
    // O que o Windows tem HOJE continua visível — o dono pode ter ligado pelo
    // app instalado e estar olhando isto no `npm run dev:app`.
    expect(view.enabled).toBe(true);
    expect(view.startMinimized).toBe(true);
    expect(view.disabled).toBe(true);
    expect(view.minimizedDisabled).toBe(true);
    expect(view.note).toBe(tUi(PT, status));
    expect(view.note).toContain('app instalado');
  });
});

describe('nextLoginItem', () => {
  it('manda sempre o PAR — a entrada do registro é reescrita inteira', () => {
    const view = loginItemView(loginState({ enabled: true, startMinimized: true }), PT);
    expect(nextLoginItem(view, { enabled: false })).toEqual({ enabled: false, startMinimized: true });
    expect(nextLoginItem(view, { startMinimized: false })).toEqual({ enabled: true, startMinimized: false });
  });

  it('desligar preserva o "minimizado" escolhido: religar na mesma sessão não perde', () => {
    const desligado = loginItemView(loginState({ enabled: false, startMinimized: true }), PT);
    expect(nextLoginItem(desligado, { enabled: true })).toEqual({ enabled: true, startMinimized: true });
  });

  it('sem mudança nenhuma, devolve o que já está na tela', () => {
    const view = loginItemView(loginState({ enabled: true, startMinimized: false }), PT);
    expect(nextLoginItem(view, {})).toEqual({ enabled: true, startMinimized: false });
  });
});

// ---------------------------------------------------------- Uso (ADR-012)

describe('seção Uso', () => {
  it('o toggle de custo vira um PATCH aninhado em usage', () => {
    expect(patchForField('usage.showCost', false, PT)).toEqual({ ok: true, patch: { usage: { showCost: false } } });
    expect(patchForField('usage.showCost', true, PT)).toEqual({ ok: true, patch: { usage: { showCost: true } } });
  });

  /**
   * Vazio é LEGÍTIMO: é como se apaga o arquivo e se volta pra tabela
   * embutida. Recusar aqui deixaria o campo sem saída depois de um caminho
   * digitado errado.
   */
  it('o arquivo de preços aceita vazio e recusa o que passa do teto do core', () => {
    expect(patchForField('usage.pricingFile', '  ', PT)).toEqual({ ok: true, patch: { usage: { pricingFile: '' } } });
    expect(patchForField('usage.pricingFile', 'D:\precos.json', PT)).toEqual({
      ok: true,
      patch: { usage: { pricingFile: 'D:\precos.json' } },
    });
    const tooLong = patchForField('usage.pricingFile', 'a'.repeat(PRICING_FILE_MAX + 1), PT);
    expect(tooLong.ok).toBe(false);
  });

  it('o valor exibido cai no default enquanto a config não chega', () => {
    expect(fieldValue(undefined, 'usage.showCost')).toBe(true);
    expect(fieldValue(undefined, 'usage.pricingFile')).toBe('');
    // `??` e não `||`: um `false` do core é escolha, não campo ausente.
    expect(
      fieldValue(config({ usage: { dayBoundary: 'local', showCost: false, terminalStatusLine: false } }), 'usage.showCost'),
    ).toBe(false);
  });

  /**
   * "Restaurar padrões" religa o custo e devolve a borda do dia, mas NÃO apaga
   * a tabela de preços escrita à mão: apagar seria uma perda silenciosa atrás
   * de um botão que diz "padrões".
   */
  it('restaurar padrões não apaga a tabela de preços do dono', () => {
    const patch = defaultsPatchFor('usage');
    expect(patch).toEqual({ usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false } });
    expect(patch?.usage).not.toHaveProperty('pricingFile');
    expect(patch?.usage).not.toHaveProperty('pricing');
  });

  /**
   * 0.12.2 — o interruptor da linha de status no terminal. O default é
   * DESLIGADA, e é ele que "Restaurar padrões" repõe (a asserção acima é a
   * trava: um campo novo no PATCH que ficasse de fora do default quebraria o
   * `satisfies Required<BridgeConfigPatch>` do `SETTINGS_DEFAULTS`).
   */
  it('usage.terminalStatusLine vira um PATCH aninhado com o booleano', () => {
    expect(patchForField('usage.terminalStatusLine', true, PT)).toEqual({
      ok: true,
      patch: { usage: { terminalStatusLine: true } },
    });
    expect(patchForField('usage.terminalStatusLine', false, PT)).toEqual({
      ok: true,
      patch: { usage: { terminalStatusLine: false } },
    });
  });

  it('o checkbox nasce desmarcado, e um core que diz `true` marca', () => {
    expect(fieldValue(undefined, 'usage.terminalStatusLine')).toBe(false);
    expect(
      fieldValue(
        config({ usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: true } }),
        'usage.terminalStatusLine',
      ),
    ).toBe(true);
  });

  /** A frase precisa prometer o que NÃO muda: a sidebar segue com os números. */
  it('a frase de apoio diz que a sidebar continua mostrando os mesmos números', () => {
    expect(terminalStatusLineNote(PT)).toContain('sidebar');
    expect(terminalStatusLineNote(PT)).toContain('você');
    expect(terminalStatusLineNote(PT)).not.toContain('tu ');
  });

  it('a data da tabela vira frase, e a ausência dela não vira nada', () => {
    expect(pricingAsOfLabel('2026-08-01', PT)).toBe('tabela de preços de 2026-08-01');
    expect(pricingAsOfLabel(undefined, PT)).toBeUndefined();
  });

  /** O exemplo é o que transforma "preencha usage.pricing" em algo copiável. */
  it('o exemplo de preços tem os quatro tipos de token', () => {
    for (const key of ['input', 'output', 'cacheWrite', 'cacheRead']) {
      expect(PRICING_EXAMPLE).toContain(`"${key}"`);
    }
    expect(() => JSON.parse(PRICING_EXAMPLE)).not.toThrow();
  });
});

// --------------------------- dor #1: escalonador de lançamentos

/**
 * Os dois campos novos da seção **Sessões**. A faixa do teto é um ESPELHO da
 * do core (`MAX_CONCURRENT_AGENTS_MIN/MAX` em `api/schemas.ts`): ela existe
 * aqui pra a mensagem sair em pt-BR antes do round-trip, não pra substituir a
 * validação do servidor.
 */
describe('escalonador de lançamentos', () => {
  it('aceita o teto dentro da faixa e recusa fora dela', () => {
    expect(patchForField('sessions.maxConcurrentAgents', 4, PT)).toEqual({
      ok: true,
      patch: { sessions: { maxConcurrentAgents: 4 } },
    });
    expect(patchForField('sessions.maxConcurrentAgents', MAX_CONCURRENT_AGENTS_MIN - 1, PT).ok).toBe(false);
    expect(patchForField('sessions.maxConcurrentAgents', MAX_CONCURRENT_AGENTS_MAX + 1, PT).ok).toBe(false);
    expect(patchForField('sessions.maxConcurrentAgents', '2.5', PT).ok).toBe(false);
    // Campo apagado no meio da digitação não vira um PATCH de zero.
    expect(patchForField('sessions.maxConcurrentAgents', '', PT).ok).toBe(false);
  });

  it('o liga-desliga vira um patch booleano', () => {
    expect(patchForField('sessions.scheduleLaunches', false, PT)).toEqual({
      ok: true,
      patch: { sessions: { scheduleLaunches: false } },
    });
  });

  it('lê a config em vigor e não confunde `false` com ausência', () => {
    const current = config({
      sessions: { maxConcurrentAgents: 8, scheduleLaunches: false, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
    });
    expect(fieldValue(current, 'sessions.maxConcurrentAgents')).toBe(8);
    expect(fieldValue(current, 'sessions.scheduleLaunches')).toBe(false);
    expect(fieldValue(undefined, 'sessions.maxConcurrentAgents')).toBe(4);
    expect(fieldValue(undefined, 'sessions.scheduleLaunches')).toBe(true);
  });

  /** A nota é o texto que separa os dois limites — sem ela a seção não explica nada. */
  it('a frase de apoio distingue o limite do servidor do de uso', () => {
    expect(scheduleLaunchesNote(PT)).toContain('limite do SERVIDOR');
    expect(scheduleLaunchesNote(PT)).toContain('não é o seu limite de uso');
  });
});
