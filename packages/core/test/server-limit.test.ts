import { describe, expect, it } from 'vitest';
import {
  detailServerLimited,
  SERVER_LIMIT_PHRASE_MAX,
  SERVER_LIMIT_TTL_MS,
  ServerLimitScanner,
  matchServerLimit,
  normalizeForMatch,
  serverLimitOf,
} from '../src/serverLimit.js';
import { EventBus } from '../src/events.js';
import { Sessions } from '../src/sessions.js';

/**
 * Dor verificada #1 — o detector do limite do SERVIDOR.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. as frases REAIS do Claude Code casam, inclusive quebradas na largura do
 *    terminal e com cor ANSI no meio (é assim que elas chegam de verdade);
 * 2. o que NÃO pode casar não casa — "rate limit" num comentário de código,
 *    `529` num `if`, a documentação do próprio Bridge sendo lida no terminal.
 *    Um falso positivo aqui pinta de laranja uma sessão que está bem, e é o
 *    tipo de erro que faz a pessoa parar de acreditar no indicador;
 * 3. a janela de 4 KB casa a frase partida entre dois chunks e NÃO redispara
 *    a cada byte novo depois do casamento.
 */
describe('matcher do limite do servidor', () => {
  it('casa a frase do banner do Claude Code', () => {
    const match = matchServerLimit('Server is temporarily limiting requests (not your usage limit)');
    expect(match?.pattern).toBe('limiting-requests');
    expect(match?.phrase).toContain('server is temporarily limiting requests');
  });

  it('é insensível a maiúsculas e casa a segunda metade sozinha', () => {
    expect(matchServerLimit('NOT YOUR USAGE LIMIT — try again')?.pattern).toBe('not-your-usage-limit');
  });

  it('casa o corpo do erro 529 da API', () => {
    const body = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    // O `overloaded_error` vem antes na lista, e é o padrão mais específico.
    expect(matchServerLimit(body)?.pattern).toBe('overloaded');
    expect(matchServerLimit('API Error (529) retrying…')?.pattern).toBe('api-529');
  });

  it('casa a frase QUEBRADA na largura do terminal', () => {
    // É assim que ela chega: o Claude Code quebra na coluna, e a quebra não
    // pode colar duas palavras nem impedir o casamento.
    const wrapped = 'Server is temporarily\r\nlimiting requests (not your\r\nusage limit)';
    expect(matchServerLimit(wrapped)?.pattern).toBe('limiting-requests');
  });

  it('casa mesmo com cor ANSI dentro da frase', () => {
    const colored = '\u001b[33mServer is temporarily limiting requests\u001b[0m (not your usage limit)';
    expect(matchServerLimit(colored)?.pattern).toBe('limiting-requests');
    // E a prova guardada não leva byte de controle nenhum (SECURITY.md: tudo
    // que veio do PTY passa por `sanitizeDisplay` antes de virar tela).
    expect(matchServerLimit(colored)?.phrase).not.toMatch(/\u001b/);
  });

  it('a prova é cortada no teto do tooltip', () => {
    const noise = 'x'.repeat(500);
    const match = matchServerLimit(`${noise} not your usage limit ${noise}`);
    expect(match?.phrase.length).toBeLessThanOrEqual(SERVER_LIMIT_PHRASE_MAX);
  });

  describe('falsos positivos que NÃO podem disparar', () => {
    const inocentes = [
      '// TODO: tratar rate limit do provedor',
      'if (err.status === 529) return retry(err);',
      'rate limit: 100 req/s',
      'const RATE_LIMIT_MS = 500;',
      'the server was overloaded with work today',
      'grep -rn "rate limit" src/',
      'HTTP 429 Too Many Requests',
    ];
    for (const linha of inocentes) {
      it(`ignora: ${linha}`, () => {
        expect(matchServerLimit(linha)).toBeUndefined();
      });
    }

    it('ignora o TRECHO DE CÓDIGO deste próprio repositório', () => {
      // O caso concreto: o dono abre o `serverLimit.ts` no terminal do Bridge.
      // O que casaria seria a frase inteira — e ela só existe aqui dentro de
      // uma string de teste, não no código.
      const codigo = "const RE = /overloaded/; // 529 é o código do servidor sobrecarregado";
      expect(matchServerLimit(codigo)).toBeUndefined();
    });
  });

  it('normalizeForMatch tira ANSI, colapsa espaço e rebaixa', () => {
    expect(normalizeForMatch('\u001b[1mABC\u001b[0m   D\nE')).toBe('abc d e');
  });
});

describe('janela rolante por sessão', () => {
  it('casa a frase partida entre dois chunks', () => {
    const scanner = new ServerLimitScanner();
    expect(scanner.push('s1', 'Server is temporarily limi')).toBeUndefined();
    expect(scanner.push('s1', 'ting requests\n')?.pattern).toBe('limiting-requests');
  });

  it('não redispara com o byte seguinte (a janela é esvaziada no casamento)', () => {
    const scanner = new ServerLimitScanner();
    expect(scanner.push('s1', 'not your usage limit')).toBeDefined();
    expect(scanner.push('s1', '\n')).toBeUndefined();
    expect(scanner.push('s1', 'tudo normal por aqui')).toBeUndefined();
  });

  it('cada sessão tem a janela dela', () => {
    const scanner = new ServerLimitScanner();
    scanner.push('s1', 'Server is temporarily limi');
    // O resto chegando na OUTRA sessão não pode completar a frase da primeira.
    expect(scanner.push('s2', 'ting requests')).toBeUndefined();
  });

  it('respeita o teto da janela: o que saiu dela não volta a casar', () => {
    const scanner = new ServerLimitScanner(64);
    scanner.push('s1', 'Server is temporarily limi');
    expect(scanner.push('s1', 'x'.repeat(100))).toBeUndefined();
    expect(scanner.push('s1', 'ting requests')).toBeUndefined();
  });

  it('`forget` zera a janela da sessão', () => {
    const scanner = new ServerLimitScanner();
    scanner.push('s1', 'Server is temporarily limi');
    scanner.forget('s1');
    expect(scanner.push('s1', 'ting requests')).toBeUndefined();
  });
});

describe('estado da sessão', () => {
  function make(): { sessions: Sessions; id: string; events: string[] } {
    const events: string[] = [];
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'session.state') events.push(`${e.state}`);
    });
    const sessions = new Sessions(bus);
    const session = sessions.create({ paneId: 'p1', workspaceId: 'ws_1', kind: 'agent', agent: 'claude', cwd: 'C:\\x' });
    return { sessions, id: session.id, events };
  }

  it('marca `server-limited` com a prova e volta ao estado anterior ao limpar', () => {
    const { sessions, id, events } = make();
    sessions.apply(id, { state: 'running', detail: 'pensando' });
    const limit = serverLimitOf({ pattern: 'overloaded', phrase: 'overloaded_error' }, 1000);

    expect(sessions.markServerLimited(id, limit, detailServerLimited('pt-BR'))).toBe(true);
    const limited = sessions.get(id)!;
    expect(limited.state).toBe('server-limited');
    expect(limited.detail).toBe(detailServerLimited('pt-BR'));
    expect(limited.serverLimit).toEqual({ since: 1000, phrase: 'overloaded_error', pattern: 'overloaded' });

    expect(sessions.clearServerLimited(id)).toBe(true);
    const back = sessions.get(id)!;
    // Volta pro que ela fazia antes — não pra `idle`, que apagaria um
    // `needs-input` que já existia quando o servidor estrangulou.
    expect(back.state).toBe('running');
    expect(back.serverLimit).toBeUndefined();
    expect(events).toEqual(['running', 'server-limited', 'running']);
  });

  it('não reentra no estado (o `since` não anda sozinho)', () => {
    const { sessions, id } = make();
    sessions.markServerLimited(id, serverLimitOf({ pattern: 'overloaded', phrase: 'a' }, 1000), detailServerLimited('pt-BR'));
    expect(
      sessions.markServerLimited(id, serverLimitOf({ pattern: 'overloaded', phrase: 'b' }, 5000), detailServerLimited('pt-BR')),
    ).toBe(false);
    expect(sessions.get(id)?.serverLimit?.since).toBe(1000);
  });

  it('sessão encerrada não entra no estado', () => {
    const { sessions, id } = make();
    sessions.exited(id, 0);
    expect(sessions.markServerLimited(id, serverLimitOf({ pattern: 'overloaded', phrase: 'a' }, 1), 'x')).toBe(false);
  });

  it('conta as estranguladas e os agentes vivos', () => {
    const bus = new EventBus();
    const sessions = new Sessions(bus);
    const a = sessions.create({ paneId: 'p1', workspaceId: 'w', kind: 'agent', agent: 'claude', cwd: 'C:\\x' });
    const b = sessions.create({ paneId: 'p2', workspaceId: 'w', kind: 'agent', agent: 'claude', cwd: 'C:\\x' });
    sessions.create({ paneId: 'p3', workspaceId: 'w', kind: 'shell', cwd: 'C:\\x' });
    expect(sessions.liveAgentCount()).toBe(2);
    sessions.markServerLimited(a.id, serverLimitOf({ pattern: 'overloaded', phrase: 'a' }, 1), 'x');
    expect(sessions.serverLimitedCount()).toBe(1);
    sessions.exited(b.id, 0);
    // Encerrada não conta pro teto: o slot dela vagou.
    expect(sessions.liveAgentCount()).toBe(1);
  });

  /**
   * A sessão estrangulada pode MORRER em vez de sair do estado (o dono fecha o
   * painel, o `claude` cai). Sem isto o `serverLimit` ficava pendurado num
   * painel que já não existe: o `GET /api/state` continuava servindo o selo
   * laranja, e — pior — o `serverLimitedCount()` continuava > 0, o que segura o
   * escalonador no degrau do backoff (até 60 s entre lançamentos) sem ninguém
   * estrangulado na tela. É o contrato que o `core` lê pra chamar
   * `launcher.noteServerLimitCleared()`.
   */
  it('sessão ESTRANGULADA que morre zera a contagem e devolve a prova', () => {
    const { sessions, id } = make();
    sessions.apply(id, { state: 'running', detail: 'pensando' });
    sessions.markServerLimited(id, serverLimitOf({ pattern: 'overloaded', phrase: 'a' }, 1000), detailServerLimited('pt-BR'));
    expect(sessions.serverLimitedCount()).toBe(1);

    sessions.exited(id, 1);

    expect(sessions.serverLimitedCount()).toBe(0);
    const dead = sessions.get(id)!;
    expect(dead.state).toBe('exited');
    expect(dead.serverLimit).toBeUndefined();
    // E o bookkeeping do detector foi junto: nada de a sessão morta
    // "desestrangular" pro estado que ela tinha antes.
    expect(sessions.clearServerLimited(id)).toBe(false);
    expect(sessions.get(id)?.state).toBe('exited');
  });

  it('o prazo de saída é de cinco minutos', () => {
    expect(SERVER_LIMIT_TTL_MS).toBe(5 * 60 * 1000);
  });
});
