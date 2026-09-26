/**
 * `bridge usage` de ponta a ponta: transcrições sintéticas no disco → core
 * real (em memória, porta efêmera) → o binário BUILDADO rodando como processo
 * filho, do jeito que o dono roda.
 *
 * A raiz das transcrições é sempre uma pasta temporária (`claudeHome`):
 * nenhum teste lê o `~/.claude` de quem roda a suíte.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore } from '../../core/src/core.js';
import type { Core } from '../../core/src/core.js';
import { parsePeriodFlags, parseRange, renderUsage, resetText, scanCaveatLine, shortDate, usagePath } from '../src/usage.js';
import type { UsageReport } from '@bridge/shared';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'bridge.cjs');

const trees: string[] = [];
function tmpTree(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trees.push(dir);
  return dir;
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** `spawn` assíncrono, nunca `spawnSync`: o core roda no MESMO worker do vitest. */
function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge ${args.join(' ')} não terminou em ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

interface LinhaOpts {
  id: string;
  at: string;
  model?: string;
  cwd?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
}

function linha(o: LinhaOpts): string {
  const write5m = o.cacheWrite ?? 0;
  const write1h = o.cacheWrite1h ?? 0;
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${o.id}`,
    timestamp: o.at,
    cwd: o.cwd ?? 'C:\\projetos\\a',
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-4-5',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_creation_input_tokens: write5m + write1h,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
        cache_read_input_tokens: o.cacheRead ?? 0,
      },
    },
  });
}

function escreve(home: string, relativo: string[], linhas: string[]): void {
  const dir = join(home, 'projects', ...relativo.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, relativo[relativo.length - 1] as string), `${linhas.join('\n')}\n`, 'utf8');
}

let core: Core;
let baseEnv: NodeJS.ProcessEnv;
/**
 * O instante de AGORA. O recorte default do comando é "hoje" no fuso da
 * máquina, e o carimbo do agora cai nele por construção — uma data fixa faria
 * o teste passar só no dia em que foi escrita, e um ISO deslocado à mão cairia
 * no dia anterior em qualquer fuso a oeste de Greenwich.
 */
const hojeIso = new Date().toISOString();

beforeAll(async () => {
  const home = tmpTree('bridge-cli-uso-home-');
  // Tudo com o carimbo de AGORA: o recorte default é "hoje", e amarrar o
  // fixture a uma data fixa faria o teste passar só naquele dia.
  escreve(home, ['proj-a', 's1.jsonl'], [
    linha({ id: 'm1', at: hojeIso, input: 100_000, output: 20_000, cacheWrite: 40_000, cacheWrite1h: 10_000, cacheRead: 300_000 }),
    linha({ id: 'm2', at: hojeIso, model: 'claude-haiku-4-5', input: 5_000, output: 1_000 }),
  ]);
  // Uma transcrição de SUBAGENTE: ela entra nos totais e na linha "inclui
  // subagentes" — na máquina do dono é a maior parte do consumo.
  escreve(home, ['proj-a', 's1', 'subagents', 'sub1.jsonl'], [
    linha({ id: 'm3', at: hojeIso, cwd: 'C:\\projetos\\b', input: 50_000, output: 4_000 }),
  ]);

  const profileDir = tmpTree('bridge-cli-uso-perfil-');
  core = createCore({ profileDir, dbPath: ':memory:', port: 0, claudeHome: home });
  // Idioma FIXO (spec §13): estes testes afirmam TEXTO, e o default do
  // produto é `'system'`. Sem fixar os dois lados — o do core, que a CLI
  // pergunta, e o `BRIDGE_LANG`, que vale com o core fechado — a suíte
  // falharia numa máquina em inglês por um motivo que não é o dela.
  core.updateConfig({ ui: { language: 'pt-BR' } });
  const started = await core.start();
  await core.deps.usagePoller?.initialScan;

  baseEnv = {
    ...process.env,
    BRIDGE_PORT: String(started.port),
    BRIDGE_TOKEN: started.token,
    BRIDGE_LANG: 'pt-BR',
  };
  delete baseEnv.BRIDGE_PROFILE_DIR;
  delete baseEnv.BRIDGE_SESSION;
});

afterAll(async () => {
  await core?.stop();
  for (const dir of trees) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Handle preso pelo antivírus do Windows: lixo em %TEMP%, não falha de teste.
    }
  }
});

describe('bridge usage', () => {
  it('--json devolve o corpo cru de GET /api/usage', async () => {
    const res = await runCli(['usage', '--json'], baseEnv);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as UsageReport;
    expect(report.range).toBe('day');
    // 100k + 20k + 40k + 10k + 300k + 6k + 54k
    expect(report.totals.tokens).toBe(530_000);
    expect(report.totals.messages).toBe(3);
    // A escrita de 1 h chega separada da de 5 min — os preços são diferentes.
    expect(report.totals.cacheWrite).toBe(40_000);
    expect(report.totals.cacheWrite1h).toBe(10_000);
    expect(report.bySource.subagents.tokens).toBe(54_000);
  });

  /**
   * O texto é a saída de verdade do comando. O que se cobra aqui é o que ele
   * PROMETE: totais, por modelo, por projeto, limites, a data da tabela de
   * preços e a nota dos subagentes.
   */
  it('a tabela de texto traz totais, modelos, projetos, limites e a nota dos subagentes', async () => {
    const res = await runCli(['usage'], baseEnv);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    const out = res.stdout;

    expect(out).toContain('Uso — dia');
    expect(out).toContain('Totais');
    expect(out).toContain('530k');
    expect(out).toContain('40k escrita · 10k escrita 1h · 300k leitura');
    expect(out).toContain('US$ ');
    expect(out).toMatch(/estimativa · tabela de \d{4}-\d{2}-\d{2}/);
    expect(out).toContain('inclui subagentes:');

    expect(out).toContain('Por modelo');
    expect(out).toContain('claude-sonnet-4-5');
    expect(out).toContain('claude-haiku-4-5');

    // O projeto é o `cwd` de cada LINHA: o subagente rodou noutra pasta.
    expect(out).toContain('Por projeto');
    expect(out).toContain('C:\\projetos\\a');
    expect(out).toContain('C:\\projetos\\b');

    // Conta sem `rate_limits` (é o caso do teste): a seção diz por quê.
    expect(out).toContain('Limites');
    expect(out).toContain('(nenhum)');
  });

  it('--range aceita os nomes em pt-BR', async () => {
    for (const [flag, esperado] of [
      ['dia', 'day'],
      ['semana', 'week'],
      ['mes', 'month'],
    ] as const) {
      const res = await runCli(['usage', '--range', flag, '--json'], baseEnv);
      expect(res.status, `--range ${flag}`).toBe(0);
      expect((JSON.parse(res.stdout) as UsageReport).range).toBe(esperado);
    }
  });

  it('range inválido e flag desconhecida saem 1 com a frase em pt-BR', async () => {
    const mau = await runCli(['usage', '--range', 'trimestre'], baseEnv);
    expect(mau.status).toBe(1);
    expect(mau.stderr).toContain('range inválido: trimestre');

    const flag = await runCli(['usage', '--turbo'], baseEnv);
    expect(flag.status).toBe(1);
    expect(flag.stderr).toContain('flag desconhecida: --turbo');
  });

  /**
   * `--rescan` relê o disco inteiro; combinar com `--range` seria dizer que
   * releu "o mês", o que não existe. Recusar é mais honesto que ignorar.
   */
  it('--rescan relê tudo e devolve arquivos, mensagens e dias', async () => {
    const res = await runCli(['usage', '--rescan', '--json'], baseEnv);
    expect(res.status).toBe(0);
    const body = JSON.parse(res.stdout) as { files: number; entries: number; days: number };
    expect(body.files).toBe(2);
    expect(body.entries).toBe(3);
    expect(body.days).toBe(1);

    // BU-07: o segundo `--rescan` em série cai na carência de 30 s do core
    // (429 `rescan-cooldown`). O custo de uma releitura é proporcional ao
    // histórico inteiro, não ao pedido — reler duas vezes no mesmo minuto não
    // muda número nenhum e trava o core enquanto isso.
    const seguido = await runCli(['usage', '--rescan'], baseEnv);
    expect(seguido.status).toBe(1);
    expect(seguido.stderr).toContain('releitura de transcrições no máximo a cada 30 s');

    const combinado = await runCli(['usage', '--rescan', '--range', 'mes'], baseEnv);
    expect(combinado.status).toBe(1);
    expect(combinado.stderr).toContain('não aceita --range');

    const comPeriodo = await runCli(['usage', '--rescan', '--de', '2021-01-01'], baseEnv);
    expect(comPeriodo.status).toBe(1);
    expect(comPeriodo.stderr).toContain('não aceita --range');
  });

  it('--range ano, --anchor e --de/--ate chegam à rota', async () => {
    const ano = await runCli(['usage', '--range', 'ano', '--json'], baseEnv);
    expect(ano.status).toBe(0);
    expect((JSON.parse(ano.stdout) as UsageReport).range).toBe('year');

    const maio = await runCli(['usage', '--range', 'mes', '--anchor', '2021-05-05', '--json'], baseEnv);
    expect(maio.status).toBe(0);
    expect(JSON.parse(maio.stdout) as UsageReport).toMatchObject({ range: 'month', from: '2021-05-01', to: '2021-05-31' });

    const livre = await runCli(['usage', '--de', '2021-01-01', '--ate', '2021-01-31'], baseEnv);
    expect(livre.status).toBe(0);
    expect(livre.stdout.split('\n')[0]).toContain('personalizado (01/01/2021 a 31/01/2021)');

    // A recusa semântica (anchor no futuro) é do core, já traduzida.
    const futuro = await runCli(['usage', '--anchor', '2999-01-01'], baseEnv);
    expect(futuro.status).toBe(1);
    expect(futuro.stderr).toContain('anchor inválida');
  });

  it('a ajuda lista o comando', async () => {
    const res = await runCli(['--help'], baseEnv);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('bridge usage');
    expect(res.stdout).toContain('--rescan');
  });
});

// ------------------------------------------------------------ partes puras

describe('parseRange', () => {
  it('os nomes em pt-BR e os da API caem no mesmo recorte', () => {
    expect(parseRange(undefined)).toBe('day');
    expect(parseRange('dia')).toBe('day');
    expect(parseRange('DIA')).toBe('day');
    expect(parseRange('semana')).toBe('week');
    expect(parseRange('mes')).toBe('month');
    expect(parseRange('mês')).toBe('month');
    expect(parseRange('month')).toBe('month');
  });

  it('recorte que não existe é erro, não um default silencioso', () => {
    expect(() => parseRange('trimestre')).toThrow(/range inválido/);
  });

  it('ano e personalizado também têm apelido nos dois idiomas', () => {
    expect(parseRange('ano')).toBe('year');
    expect(parseRange('year')).toBe('year');
    expect(parseRange('personalizado')).toBe('custom');
    expect(parseRange('custom')).toBe('custom');
  });
});

describe('parsePeriodFlags e usagePath', () => {
  it('sem flag é o dia de hoje; --anchor ancora o recorte', () => {
    expect(parsePeriodFlags({})).toEqual({ range: 'day' });
    expect(parsePeriodFlags({ range: 'mes', anchor: '2026-08-15' })).toEqual({ range: 'month', anchor: '2026-08-15' });
  });

  it('--de/--ate (ou --from/--to) implicam personalizado', () => {
    const livre = { range: 'custom', from: '2026-08-01', to: '2026-08-15' };
    expect(parsePeriodFlags({ de: '2026-08-01', ate: '2026-08-15' })).toEqual(livre);
    expect(parsePeriodFlags({ from: '2026-08-01', to: '2026-08-15' })).toEqual(livre);
    expect(parsePeriodFlags({ range: 'personalizado', de: '2026-08-01', ate: '2026-08-15' })).toEqual(livre);
  });

  it('as recusas saem em pt-BR antes de falar com o core', () => {
    expect(() => parsePeriodFlags({ de: '2026-08-01' })).toThrow(/precisa de --de e --ate/);
    expect(() => parsePeriodFlags({ range: 'personalizado' })).toThrow(/precisa de --de e --ate/);
    expect(() => parsePeriodFlags({ de: 'ontem', ate: '2026-08-01' })).toThrow(/data inválida em --de: ontem/);
    expect(() => parsePeriodFlags({ anchor: true })).toThrow(/--anchor precisa de uma data/);
    expect(() => parsePeriodFlags({ range: 'mes', de: '2026-08-01', ate: '2026-08-15' })).toThrow(/tire o --range/);
    expect(() => parsePeriodFlags({ anchor: '2026-08-01', de: '2026-08-01', ate: '2026-08-15' })).toThrow(/--anchor não combina/);
  });

  it('a rota recebe só o que foi pedido', () => {
    expect(usagePath({ range: 'day' })).toBe('/api/usage?range=day');
    expect(usagePath({ range: 'month', anchor: '2026-08-15' })).toBe('/api/usage?range=month&anchor=2026-08-15');
    expect(usagePath({ range: 'custom', from: '2026-08-01', to: '2026-08-15' })).toBe(
      '/api/usage?range=custom&from=2026-08-01&to=2026-08-15',
    );
  });
});

describe('brDate e resetText', () => {
  it('a data sai no formato do lugar', () => {
    expect(shortDate('2026-09-05', 'pt-BR')).toBe('05/09/2026');
    expect(shortDate('hoje', 'pt-BR')).toBe('hoje');
  });

  /**
   * Abaixo de 24 h vale a contagem regressiva; acima dela, a data — ninguém
   * converte "em 51h" de cabeça.
   */
  it('o reset vira contagem regressiva perto e data longe', () => {
    const agora = Date.parse('2026-09-06T12:00:00.000Z');
    const em = (ms: number): number => (agora + ms) / 1000;
    expect(resetText(em(43 * 60_000), 'pt-BR', agora)).toBe('em 43min');
    expect(resetText(em((2 * 60 + 15) * 60_000), 'pt-BR', agora)).toBe('em 2h15');
    expect(resetText(em(3 * 3600_000), 'pt-BR', agora)).toBe('em 3h');
    expect(resetText(em(-3600_000), 'pt-BR', agora)).toBe('');
    expect(resetText(undefined, 'pt-BR', agora)).toBe('');
    // Fix round 1: a data acima de 24 h passou a sair do `Intl` com a locale do
    // idioma — em pt-BR ele separa a data da hora com vírgula.
    expect(resetText(em(50 * 3600_000), 'pt-BR', agora)).toMatch(/^\d{2}\/\d{2},? \d{2}:\d{2}$/);
  });
});

describe('renderUsage', () => {
  const vazio: UsageReport = {
    range: 'week',
    from: '2026-08-31',
    to: '2026-09-06',
    chartFrom: '2026-08-08',
    chartTo: '2026-09-06',
    tz: 'America/Sao_Paulo',
    totals: {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      tokens: 0,
      messages: 0,
      cost: null,
      costPartial: false,
    },
    bySource: {
      main: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 0, messages: 0, cost: null, costPartial: false },
      subagents: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 0, messages: 0, cost: null, costPartial: false },
    },
    byDay: [],
    byModel: [],
    byProject: [],
    limits: [],
    pricingWarnings: [],
    pricingAsOf: '2026-09-06',
    claudeHome: 'D:\\fixture\\claude',
    scannedFiles: 0,
    scanning: null,
  };

  /** Custo desligado tira o dinheiro do terminal também — a CLI é tela. */
  it('com showCost desligado nenhuma linha escreve dinheiro', () => {
    const texto = renderUsage(vazio, { showCost: false, lang: 'pt-BR' });
    expect(texto).not.toContain('US$');
    expect(texto).not.toContain('custo');
  });

  /**
   * Um total baixo porque o core ainda está lendo parece um total baixo de
   * verdade — por isso a varredura em voo é a PRIMEIRA linha.
   */
  it('a varredura em voo é anunciada antes dos números', () => {
    const texto = renderUsage(
      { ...vazio, scanning: { active: true, filesDone: 1200, filesTotal: 8431, bytesDone: 1, bytesTotal: 2, skippedLines: 0 } },
      { showCost: true, lang: 'pt-BR' },
    );
    expect(texto.split('\n')[1]).toContain('varredura em andamento: 1.200 de 8.431 transcrições lidas');
  });

  it('custo nulo sai como travessão, não como zero', () => {
    const texto = renderUsage(vazio, { showCost: true, lang: 'pt-BR' });
    expect(texto).toContain('nenhum modelo do recorte tem preço na tabela');
    expect(texto).not.toContain('US$ 0,00');
  });

  /**
   * BU-09 — `bridge usage` escrevia `model`, `project`, o rótulo da janela e os
   * avisos CRUS no `stdout`. Um terminal interpreta o que recebe: OSC 0
   * sequestra o título da janela, CSI 2 J apaga a tela, e um `cwd` de 10 243
   * caracteres destrói o alinhamento que o `grid()` calcula por `.length`.
   */
  describe('BU-09 — nada de sequência de terminal na saída humana', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const zerado = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      tokens: 10,
      messages: 1,
      cost: null,
      costPartial: false,
    };

    const hostil: UsageReport = {
      ...vazio,
      byModel: [{ model: `${ESC}[2J${ESC}[H MODELO FALSO`, unpriced: true, ...zerado }],
      byProject: [
        { project: `${ESC}]0;JANELA SEQUESTRADA${BEL}${ESC}[31m` + String.fromCharCode(13, 10) + 'C:/x', ...zerado },
        { project: 'C:/' + 'A'.repeat(10_240), ...zerado },
      ],
      limits: [
        { window: 'w', label: `5h${ESC}[5m`, usedPct: 10, seenAt: 0 },
      ],
      pricingWarnings: [`modelo sem preço: ${ESC}[2J${ESC}[H MODELO FALSO — o consumo dele conta`],
    };

    it('a saída humana não tem byte de controle nenhum', () => {
      const texto = renderUsage(hostil, { showCost: true, lang: 'pt-BR' });
      expect(/[ -	-]/.test(texto)).toBe(false);
      expect(texto).not.toContain(ESC);
      expect(texto).toContain('MODELO FALSO');
    });

    it('um projeto de 10 kB sai com no máximo 80 caracteres na célula', () => {
      const texto = renderUsage(hostil, { showCost: true, lang: 'pt-BR' });
      for (const linha of texto.split(String.fromCharCode(10))) {
        expect(linha.length).toBeLessThan(200);
      }
    });

    it('o --json continua CRU: é dado, não tela', () => {
      // O contrato do `--json` é o corpo da rota, byte a byte — quem consome é
      // um script, não um terminal.
      expect(JSON.stringify(hostil)).toContain('MODELO FALSO');
    });
  });

  /**
   * Rodada 2 — Trojan Source. `U+202E` reordena a RENDERIZAÇÃO da linha sem
   * mudar um byte: um `cwd` de transcript com ele faz a tabela mostrar um
   * caminho que não é o caminho. `U+200B` some da tela e quebra a comparação
   * de olho entre dois ids de modelo.
   */
  describe('nada de bidi nem de largura zero na saída humana', () => {
    it('o RLO do cwd e o zero-width do model não chegam ao terminal', () => {
      const zerado = {
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        tokens: 10,
        messages: 1,
        cost: null,
        costPartial: false,
      };
      const texto = renderUsage(
        {
          ...vazio,
          byModel: [{ model: 'claude​sonnet', unpriced: true, ...zerado }],
          byProject: [{ project: 'C:/proj/gnp‮txt.exe', ...zerado }],
        },
        { showCost: true, lang: 'pt-BR' },
      );
      expect(texto).not.toContain('‮');
      expect(texto).not.toContain('​');
      expect(texto).toContain('claudesonnet');
    });
  });

  /** Rodada 2 — o que a varredura NÃO leu tem que aparecer, não só no log. */
  describe('ressalvas da varredura', () => {
    it('linhas puladas e lista cortada viram uma linha antes dos totais', () => {
      const texto = renderUsage(
        {
          ...vazio,
          scanning: { active: false, filesDone: 3, filesTotal: 3, bytesDone: 9, bytesTotal: 9, skippedLines: 7, capped: true },
        },
        { showCost: true, lang: 'pt-BR' },
      );
      const linha = texto.split('\n').find((l) => l.includes('ignoradas por tamanho'));
      expect(linha).toBeDefined();
      expect(linha).toContain('7 linhas ignoradas por tamanho');
      expect(linha).toContain('lista limitada a 50.000 arquivos');
      // Antes dos Totais, senão a pessoa lê a ressalva depois de já ter
      // acreditado no número.
      expect(texto.indexOf('ignoradas por tamanho')).toBeLessThan(texto.indexOf('Totais'));
    });

    it('sem nada pulado a linha SOME (não vira "0 linhas ignoradas")', () => {
      const texto = renderUsage(
        {
          ...vazio,
          scanning: { active: false, filesDone: 3, filesTotal: 3, bytesDone: 9, bytesTotal: 9, skippedLines: 0 },
        },
        { showCost: true, lang: 'pt-BR' },
      );
      expect(texto).not.toContain('ignorada');
      expect(scanCaveatLine(null, 'pt-BR')).toBeUndefined();
    });
  });
});
