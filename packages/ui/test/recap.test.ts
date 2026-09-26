/**
 * Dor verificada #3, lado da UI — quando a faixa aparece, o que o botão
 * escreve no PTY, e o reducer do `session.updated` que traz o veredito.
 */
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';
import type { BridgeConfig, Session } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import {
  composeRecapPrompt,
  recapActionLabel,
  recapBannerText,
  recapDismissLabel,
  recapFailureMessage,
  recapInput,
  recapSentMessage,
  shouldAutoInjectRecap,
  showsRecapBanner,
} from '../src/recap.js';
import { emptyUiState, reduce } from '../src/state.js';

/**
 * O idioma destes testes. É EXPLÍCITO em cada chamada desde a Task 3 do lote
 * de idioma: as asserções abaixo descrevem o pt-BR, e um default escondido
 * faria a suíte depender da máquina de quem a roda.
 */
const PT = 'pt-BR' as const;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_1',
    paneId: 'pane_1',
    workspaceId: 'ws_1',
    kind: 'agent',
    agent: 'claude',
    state: 'idle',
    startedAt: 0,
    stateSince: 0,
    consecutiveBlockedStops: 0,
    cwd: 'C:\\projetos\\x',
    ...overrides,
  };
}

function config(autoRecap: boolean): BridgeConfig {
  return {
    ...DEFAULT_STORED_CONFIG,
    profileDir: 'C:\\perfil',
    sessions: { ...DEFAULT_STORED_CONFIG.sessions, autoRecap },
  } as BridgeConfig;
}

const NADA: ReadonlySet<string> = new Set();

describe('showsRecapBanner — quando a faixa aparece', () => {
  it('aparece na sessão de agente cujo resume voltou vazio', () => {
    expect(showsRecapBanner(session({ resumeOutcome: 'fresh' }), NADA)).toBe(true);
  });

  it('não aparece quando o resume deu certo, nem sem veredito', () => {
    expect(showsRecapBanner(session({ resumeOutcome: 'ok' }), NADA)).toBe(false);
    expect(showsRecapBanner(session(), NADA)).toBe(false);
  });

  it('não aparece em shell, em painel vazio, nem em sessão encerrada', () => {
    expect(showsRecapBanner(session({ kind: 'shell', resumeOutcome: 'fresh' }), NADA)).toBe(false);
    expect(showsRecapBanner(undefined, NADA)).toBe(false);
    expect(showsRecapBanner(session({ resumeOutcome: 'fresh', state: 'exited' }), NADA)).toBe(false);
  });

  it('some depois do "Ignorar" — e a marca é por SESSÃO, não por painel', () => {
    const dismissed = new Set(['sess_1']);
    expect(showsRecapBanner(session({ resumeOutcome: 'fresh' }), dismissed)).toBe(false);
    // Outra sessão no MESMO painel volta a mostrar: é outro resume vazio.
    expect(showsRecapBanner(session({ id: 'sess_2', resumeOutcome: 'fresh' }), dismissed)).toBe(true);
  });
});

describe('shouldAutoInjectRecap — a opção desligada por padrão', () => {
  /** Veredito de resume vazio E terminal que já falou: o caso que injeta. */
  const alvo = session({ resumeOutcome: 'fresh', sawOutput: true });

  it('não roda com a configuração no default', () => {
    expect(shouldAutoInjectRecap(alvo, config(false), NADA, NADA)).toBe(false);
  });

  it('não roda sem configuração carregada (o GET ainda em voo)', () => {
    expect(shouldAutoInjectRecap(alvo, undefined, NADA, NADA)).toBe(false);
  });

  it('roda uma vez com a opção ligada, e não repete depois de injetada', () => {
    expect(shouldAutoInjectRecap(alvo, config(true), NADA, NADA)).toBe(true);
    expect(shouldAutoInjectRecap(alvo, config(true), NADA, new Set(['sess_1']))).toBe(false);
  });

  it('não roda numa sessão cujo resume deu certo, mesmo com a opção ligada', () => {
    expect(shouldAutoInjectRecap(session({ resumeOutcome: 'ok', sawOutput: true }), config(true), NADA, NADA)).toBe(
      false,
    );
  });
});

/**
 * Fix round 1 — a injeção automática esperava só o veredito, e o veredito
 * chega no `SessionStart`, que pode vir ANTES de a TUI do agente aceitar
 * texto: o resumo inteiro era engolido. O portão é o `sawOutput`, o mesmo
 * sinal (primeiro `pty.data`) que o core já usa pro comando inicial.
 */
describe('shouldAutoInjectRecap — o portão do primeiro byte do PTY', () => {
  const on = config(true);

  it('veredito fresh SEM saída do terminal ainda → não injeta', () => {
    expect(shouldAutoInjectRecap(session({ resumeOutcome: 'fresh' }), on, NADA, NADA)).toBe(false);
    // `false` explícito é a mesma coisa que ausente: o campo é opt-in.
    expect(shouldAutoInjectRecap(session({ resumeOutcome: 'fresh', sawOutput: false }), on, NADA, NADA)).toBe(false);
  });

  it('a sequência real: veredito → (nada) → primeiro byte → injeta UMA vez', () => {
    // 1. `session.updated` do SessionStart: o veredito chegou, o PTY não falou.
    const noVeredito = session({ resumeOutcome: 'fresh' });
    expect(shouldAutoInjectRecap(noVeredito, on, NADA, NADA)).toBe(false);

    // 2. `session.updated` do primeiro `pty.data`: agora sim.
    const comSaida = session({ resumeOutcome: 'fresh', sawOutput: true });
    expect(shouldAutoInjectRecap(comSaida, on, NADA, NADA)).toBe(true);

    // 3. injetada: a marca por sessão impede a segunda.
    const injetada: ReadonlySet<string> = new Set([comSaida.id]);
    expect(shouldAutoInjectRecap(comSaida, on, NADA, injetada)).toBe(false);
  });

  it('a ordem inversa também serve (o byte chega antes do veredito)', () => {
    // Só `sawOutput`, sem veredito: não há o que injetar.
    expect(shouldAutoInjectRecap(session({ sawOutput: true }), on, NADA, NADA)).toBe(false);
    // O veredito chega depois, na mesma sessão.
    expect(shouldAutoInjectRecap(session({ sawOutput: true, resumeOutcome: 'fresh' }), on, NADA, NADA)).toBe(true);
  });

  it('o portão NÃO vale pro botão: a faixa aparece antes do primeiro byte', () => {
    expect(showsRecapBanner(session({ resumeOutcome: 'fresh' }), NADA)).toBe(true);
  });
});

describe('o que vai pro PTY', () => {
  it('cerca o resumo com o cabeçalho e o pedido de continuar', () => {
    const prompt = composeRecapPrompt('último pedido: conserta o poller', PT);
    expect(prompt).toContain('resumo automático do Bridge');
    expect(prompt).toContain('último pedido: conserta o poller');
    expect(prompt).toContain('Continue de onde parou.');
  });

  it('tem UM Enter, no fim, e nenhuma quebra de linha no meio', () => {
    const data = recapInput('a b c', PT);
    expect(data.endsWith('\r')).toBe(true);
    expect(data.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('as frases da faixa não são placeholders', () => {
    expect(recapBannerText(PT)).toContain('não foi retomada');
    expect(recapActionLabel(PT)).toBe('Reabrir com contexto');
    expect(recapDismissLabel(PT)).toBe('Ignorar');
  });

  it('as linhas de status dizem o que aconteceu', () => {
    expect(recapSentMessage(120, PT)).toContain('120');
    expect(recapFailureMessage(new Error('transcript sumiu'), PT)).toContain('transcript sumiu');
  });
});

describe('reducer — session.updated', () => {
  it('substitui a sessão conhecida pelo registro novo', () => {
    const base = { ...emptyUiState(), sessions: { sess_1: session() } };
    const next = reduce(base, {
      type: 'event',
      event: { type: 'session.updated', session: session({ resumeOutcome: 'fresh' }) },
    });
    expect(next.sessions.sess_1?.resumeOutcome).toBe('fresh');
  });

  it('ignora sessão desconhecida (evento fora de ordem não inventa painel)', () => {
    const base = emptyUiState();
    const next = reduce(base, {
      type: 'event',
      event: { type: 'session.updated', session: session({ id: 'sess_fantasma' }) },
    });
    expect(next.sessions.sess_fantasma).toBeUndefined();
    expect(next).toBe(base);
  });

  it('não mexe no foco', () => {
    const base = { ...emptyUiState(), sessions: { sess_1: session() }, focusedSessionId: 'sess_outra' };
    const next = reduce(base, {
      type: 'event',
      event: { type: 'session.updated', session: session({ resumeOutcome: 'fresh' }) },
    });
    expect(next.focusedSessionId).toBe('sess_outra');
  });
});
