/**
 * A CLI falando o idioma configurado (spec §13, Task 2).
 *
 * Três coisas, e só três:
 *
 * 1. **a resolução** — `languageResolved` do `GET /api/config` manda; sem core,
 *    manda `BRIDGE_LANG`; sem ela, a locale da máquina;
 * 2. **a saída humana** — `list`, `status`, `usage` e a ajuda saem no idioma
 *    resolvido, e o `--json` NÃO muda (é máquina lendo máquina);
 * 3. **a trava** — nenhum literal pt-BR novo entra em `packages/cli/src` por
 *    fora do catálogo.
 *
 * O idioma é sempre EXPLÍCITO aqui. O default do produto é `'system'`, e um
 * teste que espera português sem dizer isso falharia numa máquina em inglês
 * por um motivo que não tem nada a ver com o que ele afirma.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Ver a nota no guard de qualquer outro pacote: o `guard.ts` é ferramenta de
// teste e vem do arquivo, não da raiz de `@bridge/shared`.
import { findUncataloguedLiterals } from '../../shared/src/i18n/guard.js';
import type { HelloState, UsageReport } from '@bridge/shared';
import { cmdList, cmdStatus } from '../src/commands.js';
import type { Ctx } from '../src/commands.js';
import { CliError, cliMessage } from '../src/client.js';
import type { Client } from '../src/client.js';
import { envLanguage, offlineLanguage, resolveCliLanguage, resolveCliSettings } from '../src/lang.js';
import { cmdUsage, parseRange, renderUsage, resetText, shortDate } from '../src/usage.js';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'bridge.cjs');

const state: HelloState = {
  layout: {
    repos: [],
    workspaces: [{ id: 'ws_1', name: 'app', cwd: 'C:\\projetos\\app', createdAt: 1 }],
    tabs: [{ id: 'tab_1', workspaceId: 'ws_1', title: 'Terminal', kind: 'terminal', order: 0 }],
    panes: [{ id: 'pane_1', tabId: 'tab_1', cwd: 'C:\\projetos\\app' }],
    layouts: { tab_1: { type: 'leaf', paneId: 'pane_1' } },
  },
  sessions: [
    {
      id: 'sess_1',
      paneId: 'pane_1',
      workspaceId: 'ws_1',
      kind: 'shell',
      state: 'idle',
      startedAt: 0,
      stateSince: Date.now(),
      consecutiveBlockedStops: 0,
      cwd: 'C:\\projetos\\app',
    },
  ],
  unread: [],
};

function fakeCtx(lang: 'pt-BR' | 'en'): Ctx {
  const client = {
    get: async () => state as unknown,
    post: async () => ({}) as unknown,
    patch: async () => ({}) as unknown,
    del: async () => ({}) as unknown,
    port: 7317,
  } as unknown as Client;
  return { client, env: {}, lang, showCost: true };
}

const relatorio: UsageReport = {
  range: 'week',
  from: '2026-08-31',
  to: '2026-09-06',
  chartFrom: '2026-08-08',
  chartTo: '2026-09-06',
  tz: 'America/Sao_Paulo',
  totals: {
    input: 1000,
    output: 200,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    tokens: 1200,
    messages: 4,
    cost: 1.5,
    costPartial: false,
  },
  bySource: {
    main: { input: 900, output: 100, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 1000, messages: 3, cost: 1.2, costPartial: false },
    subagents: { input: 100, output: 100, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, tokens: 200, messages: 1, cost: 0.3, costPartial: false },
  },
  byDay: [],
  byModel: [],
  byProject: [],
  limits: [{ window: 'five_hour', label: '5h', usedPct: 23, resetsAt: undefined, seenAt: 1 }],
  pricingWarnings: [],
  pricingAsOf: '2026-09-01',
  claudeHome: 'C:\\Users\\x\\.claude',
  scannedFiles: 3,
  scanning: null,
};

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge ${args.join(' ')} não terminou em ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
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

describe('resolução de idioma da CLI', () => {
  it('o `languageResolved` do core manda, mesmo com `BRIDGE_LANG` dizendo outra coisa', async () => {
    const lang = await resolveCliLanguage({ BRIDGE_LANG: 'pt-BR' }, async () => ({ languageResolved: 'en' }));
    expect(lang).toBe('en');
  });

  it('core fora do ar cai pro `BRIDGE_LANG`', async () => {
    const lang = await resolveCliLanguage({ BRIDGE_LANG: 'en' }, () => Promise.reject(new Error('sem core')));
    expect(lang).toBe('en');
  });

  it('core sem o campo (versão mais velha) também cai pro `BRIDGE_LANG`', async () => {
    const lang = await resolveCliLanguage({ BRIDGE_LANG: 'en' }, async () => ({}));
    expect(lang).toBe('en');
  });

  it('`languageResolved` com valor que o Bridge não fala é ignorado', async () => {
    const lang = await resolveCliLanguage({ BRIDGE_LANG: 'pt-BR' }, async () => ({ languageResolved: 'klingon' }));
    expect(lang).toBe('pt-BR');
  });

  it('`BRIDGE_LANG` só vale com um idioma real; vazio e lixo caem na máquina', () => {
    expect(envLanguage({ BRIDGE_LANG: 'en' })).toBe('en');
    expect(envLanguage({ BRIDGE_LANG: 'pt-BR' })).toBe('pt-BR');
    expect(envLanguage({ BRIDGE_LANG: '' })).toBeUndefined();
    expect(envLanguage({ BRIDGE_LANG: 'pt' })).toBeUndefined();
    expect(envLanguage({})).toBeUndefined();
    // Sem `BRIDGE_LANG` a resposta vem da máquina — o que se fixa é que ela é
    // um dos dois idiomas, não qual (depende de quem roda a suíte).
    expect(['pt-BR', 'en']).toContain(offlineLanguage({}));
  });
});

  /**
   * Fix round 1: a MESMA chamada que traz o idioma traz o `usage.showCost`. O
   * `bridge usage` pedia `/api/config` de novo, no mesmo processo, pra ler um
   * booleano — duas requisições à mesma rota por comando.
   */
  it('a resolução devolve idioma E `showCost` numa chamada só', async () => {
    let chamadas = 0;
    const settings = await resolveCliSettings({ BRIDGE_LANG: 'pt-BR' }, async () => {
      chamadas += 1;
      return { languageResolved: 'en', usage: { showCost: false } };
    });
    expect(chamadas).toBe(1);
    expect(settings).toEqual({ lang: 'en', showCost: false });
  });

  it('core fora do ar: idioma do ambiente e `showCost` no default do produto', async () => {
    const settings = await resolveCliSettings({ BRIDGE_LANG: 'en' }, () => Promise.reject(new Error('sem core')));
    expect(settings).toEqual({ lang: 'en', showCost: true });
  });

  it('`bridge usage` NÃO pede `/api/config` de novo — o `showCost` vem do `Ctx`', async () => {
    const rotas: string[] = [];
    const client = {
      get: async (path: string) => {
        rotas.push(path);
        return relatorio as unknown;
      },
      post: async () => ({}) as unknown,
      patch: async () => ({}) as unknown,
      del: async () => ({}) as unknown,
      port: 7317,
    } as unknown as Client;

    const comCusto = await cmdUsage({ client, env: {}, lang: 'en', showCost: true }, {});
    expect(rotas).toEqual(['/api/usage?range=day']);
    expect(comCusto.human).toContain('US$');

    rotas.length = 0;
    const semCusto = await cmdUsage({ client, env: {}, lang: 'en', showCost: false }, {});
    expect(rotas).toEqual(['/api/usage?range=day']);
    expect(semCusto.human).not.toContain('US$');
  });

describe('saída humana no idioma resolvido', () => {
  it('`bridge list` traduz o cabeçalho da tabela e o `--json` fica intacto', async () => {
    const pt = await cmdList(fakeCtx('pt-BR'), {});
    const en = await cmdList(fakeCtx('en'), {});
    expect(pt.human.split('\n')[0]).toContain('estado');
    expect(en.human.split('\n')[0]).toContain('state');
    expect(en.human.split('\n')[0]).toContain('age');
    // O corpo de máquina é o MESMO objeto nos dois idiomas.
    expect(en.json).toEqual(pt.json);
    expect(en.json).toEqual(state.sessions);
  });

  it('`bridge status` traduz a frase e não mexe no JSON', async () => {
    const pt = await cmdStatus(fakeCtx('pt-BR'), {});
    const en = await cmdStatus(fakeCtx('en'), {});
    expect(pt.human).toMatch(/^Bridge ativo — porta 7317, 1 sessão\(ões\)/);
    expect(en.human).toMatch(/^Bridge is up — port 7317, 1 session\(s\)/);
    expect(en.json).toEqual(pt.json);
  });

  it('`bridge usage` traduz cabeçalho, colunas e unidades — e a data segue a locale', () => {
    const pt = renderUsage(relatorio, { showCost: true, lang: 'pt-BR' });
    const en = renderUsage(relatorio, { showCost: true, lang: 'en' });

    expect(pt).toContain('Uso — semana (31/08/2026 a 06/09/2026)');
    expect(en).toContain('Usage — week (08/31/2026 to 09/06/2026)');
    expect(pt).toContain('Totais');
    expect(en).toContain('Totals');
    expect(pt).toContain('entrada');
    expect(en).toContain('input');
    expect(pt).toContain('US$ 1,50');
    expect(en).toContain('US$ 1.50');
    expect(pt).toContain('Limites');
    expect(en).toContain('Limits');
  });

  it('a contagem regressiva do reset também é copy', () => {
    const agora = Date.parse('2026-09-06T12:00:00.000Z');
    const em = (ms: number): number => (agora + ms) / 1000;
    expect(resetText(em(43 * 60_000), 'pt-BR', agora)).toBe('em 43min');
    expect(resetText(em(43 * 60_000), 'en', agora)).toBe('in 43min');
    expect(resetText(em((2 * 60 + 15) * 60_000), 'en', agora)).toBe('in 2h15');
  });

  it('a recusa em inglês nomeia os apelidos EM INGLÊS, que a CLI aceita', () => {
    // `--range day` e `--env default` são aceitos pelo parser (`RANGE_ALIASES`,
    // a lista do `--env`); mandar quem lê inglês digitar `mes` era pedir uma
    // palavra que ele não tem como adivinhar.
    expect(parseRange('day')).toBe('day');
    expect(parseRange('week')).toBe('week');
    expect(parseRange('month')).toBe('month');

    let mensagem = '';
    try {
      parseRange('bimestre');
    } catch (err) {
      mensagem = cliMessage(err as CliError, 'en');
    }
    expect(mensagem).toBe('invalid range: bimestre — use day, week, month or year (custom period: --from and --to)');
  });

  it('a data do reset acima de 24 h também segue a locale, não um formato fixo', () => {
    const agora = Date.parse('2026-09-06T12:00:00.000Z');
    const daqui = (agora + 50 * 3600_000) / 1000;
    const pt = resetText(daqui, 'pt-BR', agora);
    const en = resetText(daqui, 'en', agora);
    // pt-BR escreve dia/mês; en-US escreve mês/dia — e o dia e o mês são os
    // MESMOS números, só trocados de lugar.
    expect(pt).toMatch(/^\d{2}\/\d{2}[,]? \d{2}:\d{2}$/);
    expect(en).not.toBe(pt);
    const [ptData] = pt.split(' ');
    const [enData] = en.split(' ');
    expect(enData?.replace(',', '').split('/').reverse().join('/')).toBe(ptData?.replace(',', ''));
  });

  it('a data curta troca a ORDEM dos campos, que é dado de locale e não copy', () => {
    expect(shortDate('2026-09-05', 'pt-BR')).toBe('05/09/2026');
    expect(shortDate('2026-09-05', 'en')).toBe('09/05/2026');
    expect(shortDate('não é data', 'pt-BR')).toBe('não é data');
  });

  it('o `CliError` do Bridge guarda a chave; o que veio do core passa como está', () => {
    const meu = new CliError({ key: 'cli.notify.semSessao' });
    expect(cliMessage(meu, 'pt-BR')).toBe('sem sessão: use --session ou rode de dentro de um painel do Bridge');
    expect(cliMessage(meu, 'en')).toBe('no session: use --session or run from inside a Bridge pane');

    // Mensagem crua (a que o core já traduziu): a CLI não retraduz nada.
    const doCore = new CliError('workspace not found: ws_9', 1, 'workspace-not-found');
    expect(cliMessage(doCore, 'pt-BR')).toBe('workspace not found: ws_9');
    expect(doCore.code).toBe('workspace-not-found');
  });
});

describe('o binário, com o Bridge fechado', () => {
  const semCore: NodeJS.ProcessEnv = { ...process.env, BRIDGE_PROFILE_DIR: join(here, 'perfil-que-nao-existe-9f3a') };
  delete semCore.BRIDGE_PORT;
  delete semCore.BRIDGE_TOKEN;
  delete semCore.BRIDGE_SESSION;

  it('`--help` sai em inglês com `BRIDGE_LANG=en`, sem falar com o core', async () => {
    const res = await runCli(['--help'], { ...semCore, BRIDGE_LANG: 'en' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('bridge — the Bridge CLI (version');
    expect(res.stdout).toContain('core alive? port, version, sessions');
  });

  it('`--help` sai em português com `BRIDGE_LANG=pt-BR`', async () => {
    const res = await runCli(['--help'], { ...semCore, BRIDGE_LANG: 'pt-BR' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('bridge — CLI do Bridge (versão');
    expect(res.stdout).toContain('core vivo? porta, versão, sessões');
  });

  it('o erro de "Bridge fechado" respeita o `BRIDGE_LANG`, e o exit code não muda', async () => {
    const en = await runCli(['status'], { ...semCore, BRIDGE_LANG: 'en' });
    expect(en.status).toBe(1);
    expect(en.stderr).toContain('Bridge is not open (instance.json missing or core dead)');

    const pt = await runCli(['status'], { ...semCore, BRIDGE_LANG: 'pt-BR' });
    expect(pt.status).toBe(1);
    expect(pt.stderr).toContain('Bridge não está aberto (instance.json não encontrado ou core morto)');
  });

  it('`--json` do erro continua sendo JSON, com a mesma chave `error`', async () => {
    const res = await runCli(['status', '--json'], { ...semCore, BRIDGE_LANG: 'en' });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stderr) as { error: string }).toEqual({
      error: 'Bridge is not open (instance.json missing or core dead)',
    });
  });
});

/**
 * A trava de idioma DESTE pacote (spec §13) — o mesmo modelo de `shared` e de
 * `core`, com a allowlist da CLI.
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

const ALLOW: RegExp[] = [
  // Os APELIDOS de entrada de `--range`: é o que a pessoa DIGITA, e está no
  // README e no `--help`. Traduzir a palavra digitada conforme o idioma
  // quebraria todo script que já usa `--range semana`.
  /'mês': 'month'/,
  /\['padrao', 'padrão', 'default', ''\]/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('guarda de idioma — @bridge/cli', () => {
  it('nenhum literal pt-BR fora do catálogo', () => {
    const achados: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      for (const hit of findUncataloguedLiterals(readFileSync(file, 'utf8'), { allow: ALLOW })) {
        achados.push(`${rel}:${hit.line}: ${hit.text}`);
      }
    }
    expect(achados).toEqual([]);
  });
});
