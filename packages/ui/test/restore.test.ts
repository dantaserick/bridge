import type { LayoutSnapshot, Pane, Session, Tab } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import {
  restoreHintBanner,
  restoreResumeBanner,
  bannerFor,
  claimPendingHint,
  isPaneAlreadyBusy,
  isWorkspaceBeingCreated,
  makeCreatingWorkspaces,
  panesToRestore,
  pickRestoreMessage,
  restoreDecision,
  restoreFailureMessage,
  resumeFailureMessage,
  shouldSkipRestore,
} from '../src/restore.js';

/**
 * O idioma destes testes. É EXPLÍCITO em cada chamada desde a Task 3 do lote
 * de idioma: as asserções abaixo descrevem o pt-BR, e um default escondido
 * faria a suíte depender da máquina de quem a roda.
 */
const PT = 'pt-BR' as const;

// ------------------------------------------------------------- fixtures

function tab(id: string): Tab {
  return { id, workspaceId: 'ws-1', title: 'Terminal', kind: 'terminal', order: 0 };
}

function pane(id: string, tabId: string, overrides: Partial<Pane> = {}): Pane {
  return { id, tabId, cwd: 'C:\\projetos\\x', ...overrides };
}

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
    cwd: 'C:\\projetos\\x',
    ...overrides,
  };
}

function snapshot(tabs: Tab[], panes: Pane[]): LayoutSnapshot {
  return { repos: [], workspaces: [], tabs, panes, layouts: {} };
}

// ------------------------------------------------------------------ specs

describe('panesToRestore', () => {
  it('painel de aba de terminal sem sessão nenhuma entra na lista, sem dica', () => {
    const snap = snapshot([tab('tab-1')], [pane('pane-1', 'tab-1')]);
    expect(panesToRestore(snap, [])).toEqual([{ paneId: 'pane-1', hint: false }]);
  });

  it('painel com sessão viva não entra na lista', () => {
    const snap = snapshot([tab('tab-1')], [pane('pane-1', 'tab-1')]);
    const sessions = [session({ paneId: 'pane-1', state: 'running' })];
    expect(panesToRestore(snap, sessions)).toEqual([]);
  });

  it('painel com sessão encerrada também não entra — ainda ocupa o painel', () => {
    const snap = snapshot([tab('tab-1')], [pane('pane-1', 'tab-1')]);
    const sessions = [session({ paneId: 'pane-1', state: 'exited' })];
    expect(panesToRestore(snap, sessions)).toEqual([]);
  });

  it('lastKind agent vira hint true; lastKind shell ou ausente vira hint false', () => {
    const snap = snapshot(
      [tab('tab-1')],
      [
        pane('pane-1', 'tab-1', { lastKind: 'agent', lastAgent: 'claude' }),
        pane('pane-2', 'tab-1', { lastKind: 'shell' }),
        pane('pane-3', 'tab-1'),
      ],
    );
    expect(panesToRestore(snap, [])).toEqual([
      { paneId: 'pane-1', hint: true },
      { paneId: 'pane-2', hint: false },
      { paneId: 'pane-3', hint: false },
    ]);
  });

  it('mistura painéis de mais de uma aba/workspace, respeitando cada regra', () => {
    const snap = snapshot(
      [tab('tab-1'), tab('tab-2')],
      [
        pane('pane-1', 'tab-1', { lastKind: 'agent' }),
        pane('pane-2', 'tab-1'),
        pane('pane-3', 'tab-2'),
      ],
    );
    const sessions = [session({ paneId: 'pane-2', state: 'idle' }), session({ id: 'sess-3', paneId: 'pane-3', state: 'exited' })];
    expect(panesToRestore(snap, sessions)).toEqual([{ paneId: 'pane-1', hint: true }]);
  });

  it('sem painéis nenhum devolve lista vazia', () => {
    expect(panesToRestore(snapshot([], []), [])).toEqual([]);
  });

  /**
   * R3 — só o workspace ATIVO monta terminal na subida, então só ele restaura.
   * Os outros restauram na primeira ativação.
   */
  it('com workspaceId, só os painéis das abas daquele workspace entram', () => {
    const snap = snapshot(
      [tab('tab-1'), { id: 'tab-2', workspaceId: 'ws-2', title: 'Terminal', kind: 'terminal', order: 0 }],
      [pane('pane-1', 'tab-1'), pane('pane-2', 'tab-2', { lastKind: 'agent' })],
    );

    expect(panesToRestore(snap, [], 'ws-1')).toEqual([{ paneId: 'pane-1', hint: false }]);
    expect(panesToRestore(snap, [], 'ws-2')).toEqual([{ paneId: 'pane-2', hint: true }]);
    expect(panesToRestore(snap, [], 'ws-inexistente')).toEqual([]);
  });

  /**
   * 0.6.0 — as QUATRO combinações da regra do resume. `hint` continua sendo
   * "o painel era Claude" (é ele que escolhe o texto do banner quando o
   * painel volta como shell); `resume` é "e volta como Claude".
   */
  describe('resume (0.6.0)', () => {
    const agentPane = (id: string, overrides: Partial<Pane> = {}): Pane =>
      pane(id, 'tab-1', { lastKind: 'agent', lastAgent: 'claude', ...overrides });

    it('agente + fechou com o app + opção ligada: retoma com o id gravado', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1', { lastEndedBy: 'app', lastAgentSessionId: 'sess-claude-1' })]);
      expect(panesToRestore(snap, [], undefined, true)).toEqual([
        { paneId: 'pane-1', hint: true, resume: { agent: 'claude', sessionId: 'sess-claude-1' } },
      ]);
    });

    it('agente + fechou com o app + opção DESLIGADA: shell com a dica', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1', { lastEndedBy: 'app', lastAgentSessionId: 'sess-claude-1' })]);
      expect(panesToRestore(snap, [], undefined, false)).toEqual([{ paneId: 'pane-1', hint: true }]);
    });

    it('agente encerrado pelo USUÁRIO (/exit, ✕): shell com a dica, mesmo com a opção ligada', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1', { lastEndedBy: 'user', lastAgentSessionId: 'sess-claude-1' })]);
      expect(panesToRestore(snap, [], undefined, true)).toEqual([{ paneId: 'pane-1', hint: true }]);
    });

    it('agente sem marca nenhuma (banco de uma 0.5.0): shell com a dica', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1')]);
      expect(panesToRestore(snap, [], undefined, true)).toEqual([{ paneId: 'pane-1', hint: true }]);
    });

    it('painel de SHELL marcado como fechado pelo app não vira agente', () => {
      const snap = snapshot([tab('tab-1')], [pane('pane-1', 'tab-1', { lastKind: 'shell', lastEndedBy: 'app' })]);
      expect(panesToRestore(snap, [], undefined, true)).toEqual([{ paneId: 'pane-1', hint: false }]);
    });

    /** Contrato da Task 1: sem id gravado o painel sobe um Claude LIMPO. */
    it('sem lastAgentSessionId, retoma sem id (Claude limpo, nunca shell)', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1', { lastEndedBy: 'app' })]);
      expect(panesToRestore(snap, [], undefined, true)).toEqual([
        { paneId: 'pane-1', hint: true, resume: { agent: 'claude' } },
      ]);
    });

    it('o agente do painel é respeitado; sem ele, claude', () => {
      const snap = snapshot(
        [tab('tab-1')],
        [
          pane('pane-1', 'tab-1', { lastKind: 'agent', lastAgent: 'codex', lastEndedBy: 'app' }),
          pane('pane-2', 'tab-1', { lastKind: 'agent', lastEndedBy: 'app' }),
        ],
      );
      expect(panesToRestore(snap, [], undefined, true).map((e) => e.resume?.agent)).toEqual(['codex', 'claude']);
    });

    it('sem o argumento, vale o default de @bridge/shared (ligado)', () => {
      const snap = snapshot([tab('tab-1')], [agentPane('pane-1', { lastEndedBy: 'app', lastAgentSessionId: 'sess-claude-1' })]);
      expect(panesToRestore(snap, [])[0]?.resume).toEqual({ agent: 'claude', sessionId: 'sess-claude-1' });
    });
  });

  it('sem workspaceId (undefined) continua pegando todos os workspaces', () => {
    const snap = snapshot(
      [tab('tab-1'), { id: 'tab-2', workspaceId: 'ws-2', title: 'Terminal', kind: 'terminal', order: 0 }],
      [pane('pane-1', 'tab-1'), pane('pane-2', 'tab-2')],
    );
    expect(panesToRestore(snap, [], undefined).map((e) => e.paneId)).toEqual(['pane-1', 'pane-2']);
  });
});

describe('restoreResumeBanner (0.6.0)', () => {
  it('com id, mostra os 8 primeiros caracteres depois do ponto medio', () => {
    expect(restoreResumeBanner(PT, '9f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8')).toBe(
      'retomando a sessão anterior do Claude Code · 9f1a2b3c',
    );
  });

  it('sem id (Claude que morreu antes do primeiro hook), a frase vai sozinha', () => {
    expect(restoreResumeBanner(PT)).toBe('retomando a sessão anterior do Claude Code');
    expect(restoreResumeBanner(PT, '')).toBe(restoreResumeBanner(PT));
  });

  it('id mais curto que 8 nao e preenchido nem cortado', () => {
    expect(restoreResumeBanner(PT, 'abc').endsWith('· abc')).toBe(true);
  });

  /**
   * 13/09/2026 — a faixa mora no `Pane`, fora do xterm: texto com escape ANSI
   * apareceria literal na tela.
   */
  it('as duas faixas são texto puro, sem escape de terminal', () => {
    for (const faixa of [restoreHintBanner(PT), restoreResumeBanner(PT, '9f1a2b3c')]) {
      expect(faixa).not.toMatch(/\x1b|\r|\n/);
    }
  });
});

describe('bannerFor', () => {
  it('sessão restaurada (id no mapa) do painel certo: banner', () => {
    const p = pane('pane-1', 'tab-1');
    const s = session({ id: 'sess-restored', paneId: 'pane-1' });
    expect(bannerFor(p, s, new Map([['sess-restored', restoreHintBanner(PT)]]))).toBe(restoreHintBanner(PT));
  });

  it('0.6.0 — o texto vem do MAPA: painel retomado mostra "retomando…"', () => {
    const p = pane('pane-1', 'tab-1', { lastKind: 'agent', lastEndedBy: 'app' });
    const s = session({ id: 'sess-claude', paneId: 'pane-1', kind: 'agent', agent: 'claude' });
    const resume = restoreResumeBanner(PT, '9f1a2b3c-4d5e');
    expect(bannerFor(p, s, new Map([['sess-claude', resume]]))).toBe(resume);
  });

  it('sessão mais nova no MESMO painel, que não é a restaurada: sem banner', () => {
    // Reproduz o bug do fix round 1: a sessão restaurada morreu e o usuário
    // abriu um Claude Code de verdade no mesmo painel — a dica não pode migrar.
    const p = pane('pane-1', 'tab-1');
    const s = session({ id: 'sess-new-claude', paneId: 'pane-1', kind: 'agent', agent: 'claude' });
    expect(bannerFor(p, s, new Map([['sess-restored', restoreHintBanner(PT)]]))).toBeUndefined();
  });

  it('sem sessão nenhuma no painel: sem banner', () => {
    const p = pane('pane-1', 'tab-1');
    expect(bannerFor(p, undefined, new Map([['sess-restored', restoreHintBanner(PT)]]))).toBeUndefined();
  });

  it('sessão restaurada mas de OUTRO painel (defensivo): sem banner', () => {
    const p = pane('pane-1', 'tab-1');
    const s = session({ id: 'sess-restored', paneId: 'pane-2' });
    expect(bannerFor(p, s, new Map([['sess-restored', restoreHintBanner(PT)]]))).toBeUndefined();
  });

  it('mapa vazio: sem banner mesmo com sessão no painel certo', () => {
    const p = pane('pane-1', 'tab-1');
    const s = session({ id: 'sess-1', paneId: 'pane-1' });
    expect(bannerFor(p, s, new Map())).toBeUndefined();
  });

  it('13/09 — o dono abriu o Claude dentro do shell restaurado: a dica sai', () => {
    const p = pane('pane-1', 'tab-1');
    const s = session({ id: 'sess-restored', paneId: 'pane-1', hosted: { agent: 'claude' } as Session['hosted'] });
    expect(bannerFor(p, s, new Map([['sess-restored', restoreHintBanner(PT)]]))).toBeUndefined();
  });

  it.each(['ok', 'fresh'] as const)('13/09 — resume julgado (%s): o "retomando…" sai', (outcome) => {
    const p = pane('pane-1', 'tab-1', { lastKind: 'agent', lastEndedBy: 'app' });
    const s = session({ id: 'sess-claude', paneId: 'pane-1', kind: 'agent', agent: 'claude', resumeOutcome: outcome });
    expect(bannerFor(p, s, new Map([['sess-claude', restoreResumeBanner(PT, '9f1a2b3c')]]))).toBeUndefined();
  });
});

describe('claimPendingHint', () => {
  it('sessão nasceu num painel pendente: devolve o session.id e o banner dele', () => {
    const s = session({ id: 'sess-restored', paneId: 'pane-1' });
    expect(claimPendingHint(new Map([['pane-1', restoreHintBanner(PT)]]), s)).toEqual({
      sessionId: 'sess-restored',
      banner: restoreHintBanner(PT),
    });
  });

  it('0.6.0 — cada painel pendente carrega o SEU banner', () => {
    const resume = restoreResumeBanner(PT, '9f1a2b3c-4d5e');
    const pending = new Map([
      ['pane-1', resume],
      ['pane-2', restoreHintBanner(PT)],
    ]);
    expect(claimPendingHint(pending, session({ id: 'sess-a', paneId: 'pane-1' }))?.banner).toBe(resume);
    expect(claimPendingHint(pending, session({ id: 'sess-b', paneId: 'pane-2' }))?.banner).toBe(restoreHintBanner(PT));
  });

  it('sessão nasceu num painel que não estava esperando: undefined', () => {
    const s = session({ id: 'sess-2', paneId: 'pane-2' });
    expect(claimPendingHint(new Map([['pane-1', restoreHintBanner(PT)]]), s)).toBeUndefined();
  });

  it('mapa de pendentes vazio: undefined', () => {
    const s = session({ id: 'sess-1', paneId: 'pane-1' });
    expect(claimPendingHint(new Map(), s)).toBeUndefined();
  });
});

/**
 * R9 — o restore reabre os paineis em PARALELO (`Promise.allSettled`), com uma
 * trava por painel. Duas consequencias que estas funcoes seguram: 409 do
 * painel que este mesmo restore ja esta reabrindo e silencio (o painel acabou
 * com shell, que era o objetivo), e o resto vira UMA linha de status.
 */
describe('restoreFailureMessage / isPaneAlreadyBusy (R9)', () => {
  it('409 e silencio: o painel acabou com shell do mesmo jeito', () => {
    expect(isPaneAlreadyBusy(new ApiError('painel já tem uma sessão ativa', 409, 'pane-busy'))).toBe(true);
    expect(restoreFailureMessage([new ApiError('painel já tem uma sessão ativa', 409, 'pane-busy')], PT)).toBeUndefined();
    expect(restoreFailureMessage([], PT)).toBeUndefined();
  });

  it('erro de verdade vira uma linha so, com o motivo', () => {
    const msg = restoreFailureMessage([new ApiError('painel não encontrado', 404, 'pane-not-found')], PT);
    expect(msg).toBe('Não consegui reabrir o shell em um painel: painel não encontrado');
  });

  it('varios erros: conta quantos e mostra o primeiro motivo', () => {
    const msg = restoreFailureMessage([
      new ApiError('painel já tem uma sessão ativa', 409, 'pane-busy'),
      new Error('core caiu'),
      new Error('outro'),
    ], PT);
    expect(msg).toBe('Não consegui reabrir 2 painéis: core caiu');
  });

  it('nao-Error tambem vira texto (nunca `[object Object]` solto na faixa)', () => {
    expect(restoreFailureMessage(['deu ruim'], PT)).toContain('deu ruim');
  });
});

describe('resumeFailureMessage (0.6.0)', () => {
  it('conta o motivo do resume que nao subiu', () => {
    const msg = resumeFailureMessage(new ApiError('claude não está no PATH', 422, 'agent-unavailable'), PT);
    expect(msg).toBe('Não deu pra retomar o Claude Code: claude não está no PATH');
  });

  it('nao-Error tambem vira texto', () => {
    expect(resumeFailureMessage('sumiu', PT)).toBe('Não deu pra retomar o Claude Code: sumiu');
  });
});

/**
 * A decisão do efeito de restauração por workspace (R3), extraída pra cá — no
 * `App` ela é um `if` dentro de um `useEffect`, e este pacote roda em `node`.
 */
describe('shouldSkipRestore (fix round 1)', () => {
  it('workspace virgem, sem criação em voo: restaura', () => {
    expect(shouldSkipRestore({ creating: false, restored: false })).toBe(false);
  });

  it('workspace já restaurado nesta execução: não repete', () => {
    expect(shouldSkipRestore({ creating: false, restored: true })).toBe(true);
  });

  it('criação em voo: não restaura, nem que o workspace seja virgem', () => {
    expect(shouldSkipRestore({ creating: true, restored: false })).toBe(true);
    expect(shouldSkipRestore({ creating: true, restored: true })).toBe(true);
  });
});

/**
 * O roteiro do bug, com os mesmos passos do efeito no `App`: marca-se o
 * workspace NOS DOIS casos, restaura-se só quando `shouldSkipRestore` deixa.
 *
 * O `layout.changed` que o core emite ao criar o workspace chega ANTES da
 * resposta do `POST /api/workspaces` — e o `POST /api/sessions` do Claude, que
 * vem depois dela, leva segundos. Nessa janela o workspace novo já é o ativo.
 */
describe('restauração × criação em voo (fix round 1 + escopo de 0.9.0)', () => {
  /**
   * O efeito do `App`, com os mesmos passos: cada criação em voo tem
   * IDENTIDADE e guarda os workspaces que já existiam quando começou; a marca
   * de "restaurado" só é gravada quando a restauração ROLA; e o fim de uma
   * criação reexamina o workspace ATIVO (é o `creationEpoch` nas dependências
   * do efeito).
   */
  function makeEffect(existing: string[] = []) {
    const restored = new Set<string>();
    const known = new Set(existing);
    const restoredLog: string[] = [];
    let active: string | undefined;

    /** O corpo do efeito de restauração por workspace. */
    function runEffect(): boolean {
      if (active === undefined) return false;
      const decision = restoreDecision({
        creating: creating.isCreating(active),
        restored: restored.has(active),
      });
      if (decision !== 'restore') return false;
      restored.add(active);
      restoredLog.push(active);
      return true;
    }

    // `onEnd` = o `setCreationEpoch` do App, que faz o efeito rodar de novo.
    const creating = makeCreatingWorkspaces(() => {
      runEffect();
    });

    return {
      restoredLog,
      /** Um workspace passou a existir no layout (criado aqui, pela CLI, por outra janela). */
      appear: (id: string) => known.add(id),
      /** O `submit()` de um diálogo começou; devolve o fim DAQUELE pedido. */
      startCreating: () => creating.begin(known),
      /** O `onCreated` do diálogo: o workspace novo nasce como o usuário pediu. */
      created: (id: string) => {
        known.add(id);
        restored.add(id);
        active = id;
      },
      /** Um workspace virou o ativo; devolve se a restauração rodou. */
      activate: (workspaceId: string): boolean => {
        active = workspaceId;
        return runEffect();
      },
    };
  }

  it('layout.changed no meio da criação não restaura, e o workspace novo nunca restaura depois', () => {
    const effect = makeEffect();
    const end = effect.startCreating();
    // `layout.changed` -> `GET /api/state` -> o workspace novo vira o ativo,
    // com o painel ainda vazio (o Claude está no `available()`).
    expect(effect.activate('ws-novo')).toBe(false);
    effect.created('ws-novo');
    end();
    // Depois que a criação termina, uma reativação não pode "recuperar" o
    // restore: o painel já é do diálogo.
    expect(effect.activate('ws-novo')).toBe(false);
    expect(effect.restoredLog).toEqual([]);
  });

  it('Esc no meio do pedido não solta o restore: quem manda é o pedido, não a janela', () => {
    const effect = makeEffect();
    const end = effect.startCreating(); // submit() começou
    // (o usuário aperta Esc aqui: o diálogo some, o POST continua)
    expect(effect.activate('ws-novo')).toBe(false);
    end();
  });

  it('workspace de uma subida anterior (nada em voo) restaura normalmente, uma vez só', () => {
    const effect = makeEffect(['ws-antigo']);
    expect(effect.activate('ws-antigo')).toBe(true);
    expect(effect.activate('ws-antigo')).toBe(false);
  });

  /**
   * O bug de 0.8.0 (re-review do resume, 04/09/2026): a marca era global.
   * Trocar pra um workspace nunca restaurado enquanto o diálogo ainda esperava
   * o POST perdia a restauração DELE — e, como a marca era gravada mesmo no
   * pulo, ele nunca mais restaurava naquela execução.
   */
  it('criação em voo NÃO sequestra o restore de um workspace que já existia', () => {
    const effect = makeEffect(['ws-antigo']);
    const end = effect.startCreating();
    // O usuário troca pro workspace velho enquanto o POST corre.
    expect(effect.activate('ws-antigo')).toBe(true);
    end();
  });

  it('workspace desconhecido ativado durante a criação restaura na PRÓXIMA ativação', () => {
    const effect = makeEffect();
    const end = effect.startCreating();
    // Ele pode ser o que está nascendo: nesta ativação, silêncio.
    expect(effect.activate('ws-outro')).toBe(false);
    effect.created('ws-novo');
    end();
    // Não era: com a criação encerrada, ele restaura — e uma só vez.
    expect(effect.activate('ws-outro')).toBe(true);
    expect(effect.activate('ws-outro')).toBe(false);
  });

  /**
   * Fix round 1, item 2: o workspace que fica ativo a criação INTEIRA. O efeito
   * só roda de novo quando o workspace ativo muda — e no fim quem muda é o
   * recém-criado. Sem o `creationEpoch` nas dependências, este workspace ficava
   * eternamente em `'wait'`, sem ninguém pra reexaminá-lo.
   */
  it('workspace ativo a criação inteira restaura quando ela termina, sem o usuário fazer nada', () => {
    const effect = makeEffect();
    const end = effect.startCreating();
    // A CLI cria o workspace C DURANTE a criação do diálogo, e o usuário está
    // nele. Ele é desconhecido do pedido em voo, então espera.
    effect.appear('ws-cli');
    expect(effect.activate('ws-cli')).toBe(false);
    expect(effect.restoredLog).toEqual([]);
    // A criação do diálogo termina. Nenhuma ativação nova acontece.
    end();
    expect(effect.restoredLog).toEqual(['ws-cli']);
  });

  it('o fim de uma criação não repete o restore de quem já restaurou', () => {
    const effect = makeEffect(['ws-antigo']);
    expect(effect.activate('ws-antigo')).toBe(true);
    const end = effect.startCreating();
    end();
    expect(effect.restoredLog).toEqual(['ws-antigo']);
  });
});

/**
 * O registro das criações em voo. O que ele resolve, e que uma pilha não
 * resolvia: duas criações se cruzam e terminam FORA DE ORDEM.
 */
describe('makeCreatingWorkspaces (identidade de cada criação)', () => {
  it('sem nada em voo, ninguém está nascendo', () => {
    const creating = makeCreatingWorkspaces();
    expect(creating.size()).toBe(0);
    expect(creating.isCreating('ws-1')).toBe(false);
  });

  it('workspace conhecido no começo do pedido não é o que está nascendo', () => {
    const creating = makeCreatingWorkspaces();
    creating.begin(['ws-1', 'ws-2']);
    expect(creating.isCreating('ws-1')).toBe(false);
    expect(creating.isCreating('ws-novo')).toBe(true);
  });

  /**
   * O defeito do fix anterior: descartava a entrada mais ANTIGA a cada fim. Com
   * A e B em voo e B terminando primeiro, sobrava o conjunto de B — que conhece
   * `ws-w` — e o workspace que A ainda podia estar criando passava a receber um
   * shell por cima do painel do diálogo.
   */
  it('terminar FORA DE ORDEM remove a criação certa', () => {
    const creating = makeCreatingWorkspaces();
    const endA = creating.begin([]); // A começou com o layout vazio
    const endB = creating.begin(['ws-w']); // `ws-w` apareceu antes de B começar
    expect(creating.size()).toBe(2);

    endB(); // o SEGUNDO pedido responde primeiro
    expect(creating.size()).toBe(1);
    // Sobrou A, que NÃO conhece `ws-w`: ele continua suspeito.
    expect(creating.isCreating('ws-w')).toBe(true);

    endA();
    expect(creating.size()).toBe(0);
    expect(creating.isCreating('ws-w')).toBe(false);
  });

  it('a função de fim é idempotente: chamar duas vezes não derruba outra criação', () => {
    const ends: string[] = [];
    const creating = makeCreatingWorkspaces(() => ends.push('fim'));
    const endA = creating.begin([]);
    creating.begin([]);
    endA();
    endA();
    endA();
    expect(creating.size()).toBe(1);
    expect(ends).toEqual(['fim']);
  });

  it('avisa o fim de CADA criação uma vez — é o que reexamina o workspace ativo', () => {
    let epoch = 0;
    const creating = makeCreatingWorkspaces(() => {
      epoch += 1;
    });
    const endA = creating.begin([]);
    const endB = creating.begin([]);
    endA();
    endB();
    expect(epoch).toBe(2);
  });
});

describe('pickRestoreMessage (fix round 1)', () => {
  const shellError = new Error('core caiu');
  const resume = 'Não deu pra retomar o Claude Code: claude não está no PATH';

  it('resume que falhou ganha do agregado, mesmo com o shell de queda falhando junto', () => {
    expect(pickRestoreMessage(resume, [shellError], PT)).toBe(resume);
  });

  it('sem falha de resume, vale o agregado de sempre', () => {
    expect(pickRestoreMessage(undefined, [shellError], PT)).toBe(restoreFailureMessage([shellError], PT));
  });

  it('sem falha nenhuma, não há faixa', () => {
    expect(pickRestoreMessage(undefined, [], PT)).toBeUndefined();
    // 409 do próprio restore continua sendo silêncio (R9).
    expect(pickRestoreMessage(undefined, [new ApiError('painel já tem uma sessão ativa', 409, 'pane-busy')], PT)).toBeUndefined();
  });

  it('resume que falhou aparece mesmo quando o shell de queda deu certo (nenhum erro no agregado)', () => {
    expect(pickRestoreMessage(resume, [], PT)).toBe(resume);
  });
});
