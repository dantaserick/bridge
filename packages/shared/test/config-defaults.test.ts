import { describe, expect, it } from 'vitest';
import { DEFAULT_STORED_CONFIG } from '../src/index.js';
import type { StoredConfig } from '../src/index.js';

/**
 * `DEFAULT_STORED_CONFIG` é a FONTE ÚNICA dos defaults do `config.json`: o
 * `DEFAULT_CONFIG` do core e o `SETTINGS_DEFAULTS`/`TERMINAL_DEFAULTS` da UI
 * derivam dele (antes de 04/09/2026 eram três cópias escritas à mão). Os
 * valores são escritos à mão AQUI de propósito — é o lado dos dados, e uma
 * mudança silenciosa de default aparece como falha em vez de virar
 * "Restaurar padrões" repondo outro número.
 */
describe('DEFAULT_STORED_CONFIG', () => {
  it('tem exatamente os campos do StoredConfig, com os valores da v1', () => {
    const expected: StoredConfig = {
      port: 4560,
      shell: 'pwsh',
      gitPollSeconds: 15,
      usage: { dayBoundary: 'local', showCost: true, terminalStatusLine: false },
      toast: { enabled: true, quietWhenFocused: true },
      terminal: {
        fontFamily: "'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace",
        fontSize: 12,
      },
      restore: { resumeAgents: true },
      ui: { language: 'system' },
      sessions: {
        maxConcurrentAgents: 4,
        scheduleLaunches: true,
        autoRecap: false,
        scopeGuard: true,
        hostedAgents: true,
        mouseClicks: true,
      },
    };
    expect(DEFAULT_STORED_CONFIG).toEqual(expected);
    expect(Object.keys(DEFAULT_STORED_CONFIG).sort()).toEqual(Object.keys(expected).sort());
  });

  /**
   * O default do resume é LIGADO: o sintoma que abriu o lote de 04/09/2026 foi
   * o painel de Claude Code voltando como shell ao reabrir o Bridge. Quem não
   * quiser isso desliga na seção Sessões das configurações.
   */
  it('restore.resumeAgents nasce ligado', () => {
    expect(DEFAULT_STORED_CONFIG.restore.resumeAgents).toBe(true);
  });

  /**
   * 0.12.2 — a linha de status no terminal nasce DESLIGADA. A sidebar já
   * mostra contexto, modelo, custo e as janelas; o rodapé da TUI era a segunda
   * cópia dos mesmos números. Quem quiser a linha de volta liga em
   * Configurações → Uso.
   */
  it('usage.terminalStatusLine nasce desligada', () => {
    expect(DEFAULT_STORED_CONFIG.usage.terminalStatusLine).toBe(false);
  });

  /**
   * Dor verificada #3 — o oposto: `autoRecap` nasce DESLIGADO. Escrever no
   * prompt do agente sem alguém ter pedido é a única coisa aqui que mexe no
   * terminal do dono por conta própria, e o default tem que ser não fazer.
   */
  it('sessions.autoRecap nasce desligado', () => {
    expect(DEFAULT_STORED_CONFIG.sessions.autoRecap).toBe(false);
  });

  /**
   * Dor verificada #1 — o escalonador nasce LIGADO, com teto 4. O padrão
   * protege o caso que dói (várias sessões subindo juntas e o servidor
   * estrangulando todas); quem quiser lançar tudo de uma vez desliga na seção
   * Sessões.
   */
  it('o escalonador de lançamentos nasce ligado, com teto de 4 agentes', () => {
    expect(DEFAULT_STORED_CONFIG.sessions).toMatchObject({ maxConcurrentAgents: 4, scheduleLaunches: true });
  });

  /**
   * 0.12.0: o reconhecimento do Claude Code aberto dentro de um shell nasce
   * LIGADO. O sintoma que abriu o lote foi um agente inteiro trabalhando num
   * painel que a sidebar chamava de "shell"; o default tem que resolver isso
   * sem ninguém precisar achar a opção.
   */
  it('sessions.mouseClicks nasce ligado (clique no Claude Code)', () => {
    expect(DEFAULT_STORED_CONFIG.sessions.mouseClicks).toBe(true);
  });

  it('sessions.hostedAgents nasce ligado', () => {
    expect(DEFAULT_STORED_CONFIG.sessions.hostedAgents).toBe(true);
  });

  /**
   * Spec §13 — o idioma nasce `system`: o dono é pt-BR e quem instalar o
   * Bridge numa máquina em inglês lê inglês sem precisar achar a opção. É a
   * única resposta que não exige configuração de ninguém.
   */
  it('ui.language nasce em system', () => {
    expect(DEFAULT_STORED_CONFIG.ui.language).toBe('system');
  });

  it('não carrega o profileDir — ele é derivado, nunca gravado', () => {
    expect('profileDir' in DEFAULT_STORED_CONFIG).toBe(false);
  });

  /**
   * ADR-012: as decisões do dono sobre o monitor de uso estão AQUI, por
   * escrito — dia à meia-noite local e custo à mostra.
   */
  it('usage nasce com o dia local e o custo à mostra', () => {
    expect(DEFAULT_STORED_CONFIG.usage.dayBoundary).toBe('local');
    expect(DEFAULT_STORED_CONFIG.usage.showCost).toBe(true);
  });

  /**
   * Nenhum caminho de máquina de ninguém entra num default: ele iria pro
   * `config.json` de todo mundo que instalasse o Bridge, apontando pra uma
   * pasta que não existe na máquina da pessoa. `pricingFile` nasce AUSENTE, e
   * quem quiser um arquivo de preços preenche o `config.json`.
   */
  it('usage.pricingFile e usage.pricing nascem ausentes, sem caminho de máquina nenhuma', () => {
    expect('pricingFile' in DEFAULT_STORED_CONFIG.usage).toBe(false);
    expect('pricing' in DEFAULT_STORED_CONFIG.usage).toBe(false);
    expect(JSON.stringify(DEFAULT_STORED_CONFIG)).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('a pilha de fonte põe a Cascadia Mono na frente e termina em monospace', () => {
    const families = DEFAULT_STORED_CONFIG.terminal.fontFamily.split(',').map((f) => f.trim().replace(/^'|'$/g, ''));
    expect(families[0]).toBe('Cascadia Mono');
    expect(families).toContain('Consolas');
    expect(families.at(-1)).toBe('monospace');
  });

  it('o corpo default cabe na faixa 8–24 que o PATCH aceita', () => {
    expect(DEFAULT_STORED_CONFIG.terminal.fontSize).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_STORED_CONFIG.terminal.fontSize).toBeLessThanOrEqual(24);
  });

  it('o intervalo default do poll cabe na faixa 5–120 que o PATCH aceita', () => {
    expect(DEFAULT_STORED_CONFIG.gitPollSeconds).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_STORED_CONFIG.gitPollSeconds).toBeLessThanOrEqual(120);
  });
});
