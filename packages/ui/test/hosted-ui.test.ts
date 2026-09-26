/**
 * "Estou rodando Claude Code e aparece shell" (0.12.0) na pele da UI: o rótulo
 * da linha e do cabeçalho do painel, o `detail` "no shell", o tooltip da linha
 * hospedeira, os contadores do rodapé e o campo `sessions.hostedAgents` do
 * diálogo. Funções puras — nada de DOM.
 */
import type { BridgeConfig, LauncherStatus, Session } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import {
  hostedDetail,
  hostedRowTitle,
  launcherQueueLine,
  runsAgent,
  sessionDetail,
  sessionLabel,
  sessionRowLabel,
  sessionRowTitle,
  stateCount,
} from '../src/sidebarModel.js';
import { paneDetail } from '../src/paneModel.js';
import { hostedAgentsNote, SETTINGS_DEFAULTS, defaultsPatchFor, fieldValue, patchForField } from '../src/settingsModel.js';


/**
 * O idioma destes testes. Ele e EXPLICITO em cada chamada de modelo desde a
 * Task 3 do lote de idioma: as assercoes abaixo descrevem o pt-BR, e um
 * default escondido faria a suite depender da maquina de quem a roda.
 */
const PT = 'pt-BR' as const;
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    kind: 'shell',
    state: 'idle',
    startedAt: 1,
    stateSince: 1,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\bridge',
    ...overrides,
  };
}

/** Uma sessão de shell com um Claude Code aberto dentro dela. */
function hosted(overrides: Partial<Session> = {}): Session {
  return session({ hosted: { agent: 'claude', since: 5000 }, ...overrides });
}

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

describe('sessionLabel — as três situações', () => {
  it('sessão de agente mostra o agente', () => {
    expect(sessionLabel(session({ kind: 'agent', agent: 'claude' }), PT)).toBe('claude');
  });

  it('sessão de agente sem `agent` gravado não vira "shell"', () => {
    expect(sessionLabel(session({ kind: 'agent' }), PT)).toBe('agente');
  });

  it('shell puro é "shell"', () => {
    expect(sessionLabel(session(), PT)).toBe('shell');
  });

  /** É a dor: o `kind` continua `'shell'`, e mesmo assim a linha diz `claude`. */
  it('shell hospedeiro mostra o agente de dentro, sem mudar de kind', () => {
    const s = hosted();
    expect(s.kind).toBe('shell');
    expect(s.agent).toBeUndefined();
    expect(sessionLabel(s, PT)).toBe('claude');
  });

  it('quando a hospedagem termina, volta a ser "shell"', () => {
    const durante = hosted();
    const depois: Session = { ...durante, hosted: undefined };
    expect(sessionLabel(durante, PT)).toBe('claude');
    expect(sessionLabel(depois, PT)).toBe('shell');
  });
});

describe('sessionDetail — o "no shell"', () => {
  it('hospedeira sem detalhe diz onde aquele Claude está', () => {
    expect(sessionDetail(hosted(), PT)).toBe(hostedDetail(PT));
    expect(hostedDetail(PT)).toBe('no shell');
  });

  it('o detalhe do agente ganha do "no shell"', () => {
    expect(sessionDetail(hosted({ state: 'running', detail: 'pensando…' }), PT)).toBe('pensando…');
  });

  it('hospedeira encerrada mostra o código de saída, não o "no shell"', () => {
    expect(sessionDetail(hosted({ state: 'exited', exitCode: 1 }), PT)).toBe('código 1');
  });

  it('shell puro continua mostrando o fim do cwd', () => {
    expect(sessionDetail(session({ cwd: 'C:\\projetos\\bridge' }), PT)).toBe('…\\projetos\\bridge');
  });

  it('agente sem detalhe também cai no cwd (nada mudou pra ele)', () => {
    expect(sessionDetail(session({ kind: 'agent', agent: 'claude', cwd: 'C:\\a' }), PT)).toBe('C:\\a');
  });
});

describe('sessionRowTitle — o tooltip da linha hospedeira', () => {
  it('a hospedeira explica por que uma linha de shell diz "claude"', () => {
    expect(sessionRowTitle(hosted(), PT)).toBe('Claude Code aberto dentro deste shell');
    expect(sessionRowTitle(hosted(), PT)).toBe(hostedRowTitle(PT));
  });

  it('shell puro e agente não têm tooltip', () => {
    expect(sessionRowTitle(session(), PT)).toBeUndefined();
    expect(sessionRowTitle(session({ kind: 'agent', agent: 'claude' }), PT)).toBeUndefined();
  });

  /** O anel segue `session.state`, e o leitor de tela lê o mesmo par. */
  it('o aria-label da linha carrega o rótulo e o detalhe da hospedeira', () => {
    const s = hosted({ state: 'needs-input' });
    const label = sessionRowLabel({ label: sessionLabel(s, PT), state: s.state, detail: sessionDetail(s, PT), focused: false }, PT);
    expect(label).toBe('Sessão claude, esperando você, no shell');
  });
});

describe('paneDetail — o detalhe do cabeçalho do painel', () => {
  it('painel vazio e shell puro não têm detalhe nenhum', () => {
    expect(paneDetail(undefined, PT)).toBeUndefined();
    expect(paneDetail(session(), PT)).toBeUndefined();
  });

  it('o painel hospedeiro ocioso diz "no shell" (spec §5)', () => {
    expect(paneDetail(hosted(), PT)).toBe(hostedDetail(PT));
  });

  it('o detalhe do agente ganha do "no shell"', () => {
    expect(paneDetail(hosted({ state: 'running', detail: 'pensando…' }), PT)).toBe('pensando…');
  });

  /** O painel encerrado já tem a faixa "encerrou · código N" ao lado. */
  it('painel encerrado não repete o "no shell"', () => {
    expect(paneDetail(hosted({ state: 'exited', exitCode: 0 }), PT)).toBeUndefined();
  });

  it('agente continua mostrando só o que o core mandou', () => {
    expect(paneDetail(session({ kind: 'agent', agent: 'claude', detail: 'Edit · src' }), PT)).toBe('Edit · src');
    expect(paneDetail(session({ kind: 'agent', agent: 'claude' }), PT)).toBeUndefined();
  });
});

describe('runsAgent — quem tem um Claude de verdade dentro', () => {
  it('agente sim, shell puro não, hospedeira sim', () => {
    expect(runsAgent(session({ kind: 'agent', agent: 'claude' }))).toBe(true);
    expect(runsAgent(session())).toBe(false);
    expect(runsAgent(hosted())).toBe(true);
  });
});

describe('contadores do rodapé e da fila com uma hospedeira', () => {
  /**
   * O rodapé conta por ESTADO, não por `kind`: a hospedeira entra em
   * "rodando" porque o core passou a mandar `running` pra ela.
   */
  it('a hospedeira em running entra no "rodando" do rodapé', () => {
    const sessions = [session({ id: 'a', kind: 'agent', agent: 'claude', state: 'running' }), hosted({ id: 'b', state: 'running' }), session({ id: 'c' })];
    expect(stateCount(sessions, 'running')).toBe(2);
    expect(stateCount(sessions, 'idle')).toBe(1);
    expect(stateCount(sessions, 'stuck')).toBe(0);
  });

  it('a hospedeira esperando você entra no "pedem input"', () => {
    expect(stateCount([hosted({ state: 'needs-input' })], 'needs-input')).toBe(1);
  });

  /**
   * O "N de M agentes de pé" vem do `active` do CORE (`liveAgentCount`, que
   * soma a hospedeira desde a Task 2) — a UI não recontaria isso sozinha.
   */
  it('a linha da fila repete o `active` do core, hospedeira inclusa', () => {
    const status: LauncherStatus = {
      enabled: true,
      active: 2,
      maxConcurrent: 4,
      serverLimited: 0,
      spacingMs: 500,
      pending: [{ id: 'lnch_1', paneId: 'pane-9', workspaceId: 'ws-1', agent: 'claude', requestedAt: 1, position: 1 }],
    };
    expect(launcherQueueLine(status, PT)?.title).toContain('2 de 4 agentes de pé');
  });
});

describe('sessions.hostedAgents no diálogo', () => {
  it('a chave é lida da config em vigor', () => {
    expect(fieldValue(config(), 'sessions.hostedAgents')).toBe(true);
    expect(fieldValue(config({ sessions: { ...config().sessions, hostedAgents: false } }), 'sessions.hostedAgents')).toBe(false);
  });

  it('sem config, cai no default (ligada)', () => {
    expect(fieldValue(undefined, 'sessions.hostedAgents')).toBe(SETTINGS_DEFAULTS.sessions.hostedAgents);
    expect(SETTINGS_DEFAULTS.sessions.hostedAgents).toBe(true);
  });

  it('o checkbox manda o patch da chave', () => {
    expect(patchForField('sessions.hostedAgents', false, PT)).toEqual({ ok: true, patch: { sessions: { hostedAgents: false } } });
    expect(patchForField('sessions.hostedAgents', true, PT)).toEqual({ ok: true, patch: { sessions: { hostedAgents: true } } });
  });

  it('"Restaurar padrões" da seção Sessões repõe a chave', () => {
    expect(defaultsPatchFor('sessions')?.sessions?.hostedAgents).toBe(true);
  });

  /**
   * A nota tem que dizer as duas coisas que o dono pergunta: quando passa a
   * valer, e se a sessão vira "agente" (não vira).
   */
  it('a nota fala do PRÓXIMO shell e de que o kind não muda', () => {
    expect(hostedAgentsNote(PT)).toContain('próximo shell');
    expect(hostedAgentsNote(PT)).toContain('continua sendo um shell');
    expect(hostedAgentsNote(PT)).toContain('claude');
  });
});
