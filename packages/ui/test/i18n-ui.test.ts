import { readFileSync } from 'node:fs';
import type { BridgeConfig, Keybindings, LauncherStatus, Session, UsageReport, UsageTotals } from '@bridge/shared';
import { DEFAULT_KEYBINDINGS, t } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { browserLanguage, uiLanguage } from '../src/i18n.js';
import { emptyUiState, reduce } from '../src/state.js';
import {
  groupWorkspaces,
  launcherQueueLine,
  scopeBlockNote,
  serverLimitBadge,
  sessionDetail,
  sessionLabel,
  sessionRowLabel,
  sessionStateLabels,
  workspaceRowLabel,
} from '../src/sidebarModel.js';
import { menuItems } from '../src/components/sidebar/WorkspaceMenu.js';
import { emptyPaneActions } from '../src/paneModel.js';
import { hintGroups } from '../src/tabsModel.js';
import {
  keyActionLabel,
  keybindingsWarning,
  languageOptions,
  patchForField,
  scopeGuardNote,
  settingsSections,
} from '../src/settingsModel.js';
import { limitRows, rangeLabel, rescanStatus, resetText, totalCards, usageLimitBadge } from '../src/usageModel.js';
import { queuedMessage } from '../src/actions.js';

/**
 * O idioma da UI (spec §13, Task 3).
 *
 * O que este arquivo prova, e que nenhum outro prova: o MESMO estado, passado
 * pelos MESMOS modelos, sai em inglês quando o idioma é `en`. Os outros testes
 * de modelo fixam `pt-BR` e conferem a copy palavra por palavra — eles provam
 * o texto, não a troca.
 *
 * E prova as duas pontas da troca AO VIVO: a fonte do idioma é o
 * `languageResolved` do core (nunca uma resolução própria do renderer), o
 * `navigator.language` só vale antes da primeira config, e um `config.changed`
 * pelo WS basta para o idioma mudar — sem recarga e sem rota nova.
 */

const EN = 'en' as const;
const PT = 'pt-BR' as const;

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspaceId: 'ws-1',
    paneId: 'p1',
    kind: 'agent',
    agent: 'claude',
    cwd: 'C:\\projetos\\app',
    state: 'running',
    startedAt: 1,
    ...over,
  } as Session;
}

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 4560,
    shell: 'pwsh',
    claudeHome: 'C:\\perfil\\.claude',
    usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false },
    sessions: { maxConcurrentAgents: 4, scheduleLaunches: true, autoRecap: false, scopeGuard: true, hostedAgents: true, mouseClicks: true },
    profileDir: 'C:\\perfil\\bridge',
    gitPollSeconds: 15,
    toast: { enabled: true, quietWhenFocused: true },
    terminal: { fontFamily: 'Consolas', fontSize: 12 },
    restore: { resumeAgents: true },
    ui: { language: 'system' },
    languageResolved: 'pt-BR',
    ...over,
  };
}

// ------------------------------------------------- a fonte do idioma na UI

describe('de onde a UI tira o idioma', () => {
  /**
   * A preocupação nº 5 do report da Task 1, virada teste: o core resolve
   * `'system'` com a locale do PROCESSO dele, e uma segunda resolução no
   * renderer (`navigator.language`) poderia dar outro idioma na mesma máquina.
   */
  it('manda o languageResolved do core, não a escolha crua nem o navigator', () => {
    expect(uiLanguage(config({ ui: { language: 'system' }, languageResolved: 'en' }))).toBe('en');
    expect(uiLanguage(config({ ui: { language: 'en' }, languageResolved: 'pt-BR' }))).toBe('pt-BR');
  });

  it('sem config (o GET /api/config em voo) cai no idioma do browser', () => {
    expect(uiLanguage(undefined)).toBe(browserLanguage());
  });

  /**
   * Sem `navigator` (o `vitest` deste pacote roda em ambiente `node`, e o
   * ambiente sem ICU tem o mesmo efeito) a reserva é o inglês — a mesma regra
   * do `systemLanguage` do `@bridge/shared`.
   */
  it('a reserva do browser segue a regra pt* → pt-BR, resto → en', () => {
    const original = Reflect.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'pt-PT' }, configurable: true });
      expect(browserLanguage()).toBe('pt-BR');
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'ja-JP' }, configurable: true });
      expect(browserLanguage()).toBe('en');
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});

describe('troca AO VIVO pelo config.changed', () => {
  /**
   * Não há rota nova nem recarga: o `config.changed` do WS carrega a config
   * INTEIRA (o mesmo `configSnapshot()` do `GET`), o reducer a substitui, e o
   * `uiLanguage` do render seguinte já responde o idioma novo. É por isso que
   * o idioma não é lido uma vez e guardado.
   */
  it('o mesmo estado responde outro idioma depois do evento', () => {
    const antes = reduce(emptyUiState(), { type: 'setConfig', value: config({ languageResolved: 'pt-BR' }) });
    expect(uiLanguage(antes.config)).toBe('pt-BR');

    const depois = reduce(antes, {
      type: 'event',
      event: { type: 'config.changed', config: config({ ui: { language: 'en' }, languageResolved: 'en' }) },
    });
    expect(uiLanguage(depois.config)).toBe('en');
    // E o texto acompanha, sem nada mais acontecer entre um e outro.
    expect(sessionLabel(session({ kind: 'shell', agent: undefined }), uiLanguage(antes.config))).toBe('shell');
    expect(sessionDetail(session({ state: 'exited', exitCode: 1 }), uiLanguage(antes.config))).toBe('código 1');
    expect(sessionDetail(session({ state: 'exited', exitCode: 1 }), uiLanguage(depois.config))).toBe('exit 1');
  });
});

// ------------------------------------------------------- sidebar em inglês

describe('sidebar em en', () => {
  it('o grupo sem repositório, os estados e os rótulos de linha', () => {
    const groups = groupWorkspaces(
      { workspaces: [{ id: 'ws-1', name: 'app', cwd: 'C:\\app', createdAt: 1 }], repos: [], tabs: [], panes: [], layouts: {} } as never,
      EN,
    );
    expect(groups[0]?.name).toBe('No repository');

    expect(sessionStateLabels(EN)['needs-input']).toBe('waiting for you');
    expect(sessionStateLabels(PT)['needs-input']).toBe('esperando você');

    expect(workspaceRowLabel({ name: 'app', state: 'stuck', sessions: 2 }, EN)).toBe('Workspace app, 2 sessions, stuck');
    expect(workspaceRowLabel({ name: 'app', state: 'stuck', sessions: 2 }, PT)).toBe('Workspace app, 2 sessões, travada');
    expect(sessionRowLabel({ label: 'claude', state: 'done', detail: 'done', focused: true }, EN)).toBe(
      'Session claude, done, done, focused',
    );
  });

  it('a linha da fila do escalonador', () => {
    const status: LauncherStatus = { pending: [{ id: 'q1' }], active: 2, maxConcurrent: 4, serverLimited: 0 } as never;
    expect(launcherQueueLine(status, EN)?.text).toBe('1 session waiting for a slot');
    expect(launcherQueueLine(status, EN)?.title).toContain('2 of 4 agents up');
    expect(launcherQueueLine(status, PT)?.text).toBe('1 sessão aguardando slot');
  });

  it('o selo do limite do SERVIDOR (que não é o limite de uso)', () => {
    const limited = session({ state: 'server-limited', serverLimit: { phrase: 'temporarily limiting' } as never });
    expect(serverLimitBadge(limited, EN)?.text).toBe('⏳ server');
    expect(serverLimitBadge(limited, EN)?.title).toContain('SERVER limit (not your usage limit).');
  });

  /**
   * A razão do `deny` da guarda de escopo (Task 2) cita o item de menu PELO
   * NOME. Se o menu e o aviso da sidebar deixarem de usar a mesma chave, a
   * recusa manda o agente procurar um item que não existe — em qualquer
   * idioma.
   */
  it('o aviso 🛡 e o item de menu dizem a MESMA frase, nas DUAS cercas', () => {
    const ws = (worktree: boolean): never =>
      ({
        id: 'ws-1',
        name: 'app',
        cwd: 'C:\\app',
        createdAt: 1,
        ...(worktree ? { worktree: { base: 'main', path: 'C:\\wt' } } : {}),
      }) as never;

    for (const lang of [PT, EN] as const) {
      // Tarefa (a cerca é o worktree) E workspace de repositório (a cerca é o
      // repo inteiro): o item muda de nome nos dois casos, e o aviso tem que
      // acompanhar — senão ele manda procurar um item que não existe naquele
      // menu.
      for (const worktree of [true, false]) {
        const item = menuItems(ws(worktree), lang).find((i) => i.action === 'crossAccess');
        expect(item).toBeDefined();
        expect(scopeBlockNote(worktree, lang)).toContain(item?.label ?? '<sem item>');
      }
    }
  });

});

// ---------------------------------------------------------- abas e painel

describe('barra de abas e painel vazio em en', () => {
  it('as dicas e os botões do painel vazio', () => {
    const grupos = hintGroups(DEFAULT_KEYBINDINGS as Keybindings, EN);
    expect(grupos.map((g) => g.label)).toEqual(['split', 'move', 'usage', 'close pane']);
    expect(grupos[0]?.buttons[0]?.title).toBe(`${keyActionLabel('pane.splitV', EN)} (Ctrl+Shift+D)`);

    expect(emptyPaneActions(EN).map((a) => a.label)).toEqual(['Open shell', 'Open Claude Code', 'Close pane']);
    expect(emptyPaneActions(PT).map((a) => a.label)).toEqual(['Abrir shell', 'Abrir Claude Code', 'Fechar painel']);
  });

  it('a ação sem atalho diz isso no idioma certo', () => {
    const sem = { ...DEFAULT_KEYBINDINGS, 'pane.splitV': 'Ctrl+' } as Keybindings;
    expect(hintGroups(sem, EN)[0]?.buttons[0]?.title).toContain('(no shortcut)');
    expect(hintGroups(sem, PT)[0]?.buttons[0]?.title).toContain('(sem atalho)');
  });
});

// -------------------------------------------------------- configurações

describe('configurações em en', () => {
  it('as oito seções, com as mesmas ids e outra copy', () => {
    expect(settingsSections(EN).map((s) => s.id)).toEqual(settingsSections(PT).map((s) => s.id));
    expect(settingsSections(EN).map((s) => s.label)).toEqual([
      'Terminal',
      'Sessions',
      'Notifications',
      'Usage',
      'Git',
      'Shortcuts',
      'Appearance',
      'System',
    ]);
  });

  it('as notas longas e os erros de validação local', () => {
    expect(scopeGuardNote(EN)).toContain('Allow access outside the worktree');
    expect(scopeGuardNote(PT)).toContain('Permitir acesso fora do worktree');

    const erro = patchForField('terminal.fontFamily', '   ', EN);
    expect(erro).toEqual({ ok: false, error: 'The font cannot be empty.' });
    expect(patchForField('terminal.fontFamily', '   ', PT)).toEqual({ ok: false, error: 'A fonte não pode ficar vazia.' });

    expect(keybindingsWarning([{ action: 'tab.new', kind: 'invalid', detail: '' }], EN)).toBe(
      'Careful: one problem in keybindings.json.',
    );
  });

  /**
   * O seletor de idioma. Os dois NOMES de idioma ficam na própria língua nos
   * dois catálogos — quem procura inglês procura "English", inclusive numa
   * tela em português —; só "Do sistema" é frase e se traduz.
   */
  it('o seletor de Aparência → Idioma tem as três opções, e só uma delas traduz', () => {
    expect(languageOptions(PT)).toEqual([
      { value: 'pt-BR', label: 'Português (Brasil)' },
      { value: 'en', label: 'English' },
      { value: 'system', label: 'Do sistema' },
    ]);
    expect(languageOptions(EN)).toEqual([
      { value: 'pt-BR', label: 'Português (Brasil)' },
      { value: 'en', label: 'English' },
      { value: 'system', label: 'System' },
    ]);
  });

  it('escolher no seletor manda o PATCH que o core valida', () => {
    expect(patchForField('ui.language', 'en', PT)).toEqual({ ok: true, patch: { ui: { language: 'en' } } });
    expect(patchForField('ui.language', 'system', PT)).toEqual({ ok: true, patch: { ui: { language: 'system' } } });
    // Valor fora do enum nem sai da UI — o core devolveria 400 `invalid-config`.
    expect(patchForField('ui.language', 'de', EN)).toEqual({ ok: false, error: 'Unknown language: de.' });
  });
});

// ------------------------------------------------------------ painel Uso

describe('painel "Uso" em en', () => {
  function totals(over: Partial<UsageTotals> = {}): UsageTotals {
    return {
      input: 1000,
      output: 2000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      tokens: 3000,
      messages: 12,
      cost: 1.5,
      costPartial: false,
      ...over,
    };
  }

  function report(): UsageReport {
    return {
      range: 'month',
      from: '2026-09-01',
      to: '2026-09-30',
      chartFrom: '2026-08-11',
      chartTo: '2026-09-09',
      claudeHome: 'C:\\perfil\\.claude',
      scannedFiles: 3,
      totals: totals(),
      byModel: [],
      byProject: [],
      byDay: [],
      limits: [],
      pricingWarnings: [],
    } as never;
  }

  it('recorte, cartões e a frase de reset', () => {
    expect(rangeLabel('month', '2026-09-01', '2026-09-30', EN)).toBe('September 2026');
    expect(rangeLabel('month', '2026-09-01', '2026-09-30', PT)).toBe('setembro de 2026');
    expect(rangeLabel('day', '2026-09-09', '2026-09-09', EN)).toBe('today');

    const cards = totalCards(report(), { showCost: true }, EN);
    expect(cards.map((c) => c.label)).toEqual(['Input', 'Output', 'Cache', 'Estimated cost', 'Messages']);

    // 43 min à frente: a forma curta é a mesma; o prefixo é que muda.
    const agora = 1_700_000_000_000;
    expect(resetText(agora / 1000 + 43 * 60, EN, agora)).toBe('resets in 43min');
    expect(resetText(agora / 1000 + 43 * 60, PT, agora)).toBe('reseta em 43min');
  });

  it('os limites da sidebar e o selo de limite ATINGIDO', () => {
    const limits = [{ window: 'five_hour', usedPct: 100 }];
    expect(limitRows(limits, EN)[0]?.label).toBe('5h');
    expect(limitRows(limits, EN)[0]?.title).toContain('5-hour limit');
    expect(limitRows(limits, PT)[0]?.title).toContain('Limite de 5 horas');

    expect(usageLimitBadge(limits, EN)?.text).toBe('usage limit reached (5h)');
    expect(usageLimitBadge(limits, EN)?.title).toContain('YOUR usage limit');
  });

  /**
   * `tableWarnings` separa os avisos "sem preço" (que a caixa do painel já
   * mostra com a lista de modelos) dos avisos de TABELA comparando o COMEÇO do
   * texto — e o texto vem do core, já traduzido. As duas chaves precisam
   * começar igual nos dois idiomas, e é só este teste que garante: mudar uma
   * sem a outra faz o painel duplicar o aviso (ou sumir com ele) em silêncio.
   */
  it('o prefixo do painel é o começo do aviso que o CORE escreve', () => {
    for (const lang of [PT, EN] as const) {
      const aviso = t(lang, 'core.uso.aviso.modeloSemPreco', { modelo: 'claude-modelo-novo' });
      expect(aviso.startsWith(t(lang, 'uso.aviso.prefixoSemPreco'))).toBe(true);
    }
  });

  /**
   * O agrupamento de milhar é dado de LOCALE (`Intl.NumberFormat`), não copy:
   * `1.284` em português e `1,284` em inglês, com o resto da frase traduzido.
   */
  it('a contagem de arquivos usa a pontuação do idioma', () => {
    const feito = { files: 1284, entries: 20000, days: 3 };
    expect(rescanStatus(null, feito, PT)).toBe('Pronto: 1.284 arquivos, 20.000 mensagens, 3 dias com consumo.');
    expect(rescanStatus(null, feito, EN)).toBe('Done: 1,284 files, 20,000 messages, 3 days with usage.');
  });
});

// -------------------------------------------------------- ações e status

describe('frases de status em en', () => {
  it('a fila do escalonador', () => {
    expect(queuedMessage(3, EN)).toContain('Queued by the scheduler (position 3)');
    expect(queuedMessage(3, PT)).toContain('Na fila do escalonador (posição 3)');
  });

  /**
   * O rodapé tem singular próprio desde a onda de conserto: com uma chave só e
   * `{n}`, quem tinha UMA sessão aberta lia "1 sessões" / "1 sessions".
   */
  it('o rodapé do core conta sessão no singular e no plural', () => {
    const addr = '127.0.0.1:8787';
    expect(t(PT, 'app.rodape.core.uma', { endereco: addr })).toBe('core 127.0.0.1:8787 · 1 sessão');
    expect(t(EN, 'app.rodape.core.uma', { endereco: addr })).toBe('core 127.0.0.1:8787 · 1 session');
    expect(t(PT, 'app.rodape.core.varias', { endereco: addr, n: 3 })).toBe('core 127.0.0.1:8787 · 3 sessões');
    expect(t(EN, 'app.rodape.core.varias', { endereco: addr, n: 3 })).toBe('core 127.0.0.1:8787 · 3 sessions');
    // Zero é plural nos dois idiomas.
    expect(t(PT, 'app.rodape.core.varias', { endereco: addr, n: 0 })).toContain('0 sessões');
    expect(t(EN, 'app.rodape.core.varias', { endereco: addr, n: 0 })).toContain('0 sessions');
  });

  /** O `App.tsx` não monta em teste: o que se prende é a ESCOLHA entre as duas. */
  it('o App escolhe a chave pela contagem', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("sessions.length === 1");
    expect(app).toContain("'app.rodape.core.uma'");
    expect(app).toContain("'app.rodape.core.varias'");
  });
});
