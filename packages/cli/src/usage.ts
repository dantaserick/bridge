/**
 * `bridge usage` — o painel "Uso" em texto (ADR-012).
 *
 * Por que existe: o dashboard do app responde "quanto gastei" com o Bridge
 * aberto na frente; um agente rodando dentro de um painel — ou o dono num
 * terminal — precisa da mesma resposta sem tirar a mão do teclado. E como o
 * comando fala com a MESMA rota (`GET /api/usage`), não há chance de o número
 * do terminal divergir do número da tela: não há segunda conta aqui.
 *
 * O dinheiro e os tokens saem de `@bridge/shared` (`formatUsd`,
 * `formatTokens`), pelo mesmo motivo — `$48.70` no terminal e `US$ 48,70` na
 * tela seriam duas convenções pro mesmo dado.
 *
 * Idioma (spec §13): tudo aqui — rótulo de coluna, unidade, ressalva — passa
 * pelo catálogo, com o `lang` que a borda resolveu (`languageResolved` do
 * `GET /api/config`, senão `BRIDGE_LANG`, senão a locale da máquina). O
 * `--json` não passa por nada disto: é o corpo da rota, cru.
 */
import { INTL_LOCALE, formatCount, formatTokens, formatUsd, sanitizeDisplay, t, type Language } from '@bridge/shared';
import type { UsagePeriodQuery, UsageRange, UsageReport, UsageTotals } from '@bridge/shared';
import type { CommandResult, Ctx, Flags } from './commands.js';
import { CliError } from './client.js';

/**
 * Os recortes com o nome em pt-BR, que é o que a pessoa digita, mais os nomes
 * da API — quem leu o README da rota não precisa traduzir de volta.
 */
export const RANGE_ALIASES: Record<string, UsageRange> = {
  dia: 'day',
  day: 'day',
  hoje: 'day',
  semana: 'week',
  week: 'week',
  mes: 'month',
  'mês': 'month',
  month: 'month',
  ano: 'year',
  year: 'year',
  // `--range personalizado` sozinho não basta — as datas vêm de `--de/--ate`.
  // O apelido existe pra que escrever o recorte por extenso não seja erro.
  personalizado: 'custom',
  custom: 'custom',
};

/**
 * O nome do recorte NA TELA. Os apelidos de ENTRADA (acima) continuam sendo os
 * pt-BR: `--range semana` é o que está no README e no `--help`, e mudar a
 * palavra que se digita conforme o idioma quebraria script de quem já usa.
 */
export function rangeName(range: UsageRange, lang: Language): string {
  if (range === 'week') return t(lang, 'cli.uso.range.semana');
  if (range === 'month') return t(lang, 'cli.uso.range.mes');
  if (range === 'year') return t(lang, 'cli.uso.range.ano');
  if (range === 'custom') return t(lang, 'cli.uso.range.personalizado');
  return t(lang, 'cli.uso.range.dia');
}

export function parseRange(raw: string | undefined): UsageRange {
  if (raw === undefined) return 'day';
  const found = RANGE_ALIASES[raw.trim().toLowerCase()];
  if (!found) throw new CliError({ key: 'cli.uso.rangeInvalido', params: { valor: raw } });
  return found;
}

/** As flags que escolhem PERÍODO — as que o `--rescan` recusa. */
const PERIOD_FLAGS = ['range', 'anchor', 'de', 'ate', 'from', 'to'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Teto do eco de uma data digitada errada na mensagem de erro. */
const DATE_ECHO_MAX = 40;

/**
 * Uma flag de data, pelo primeiro nome presente (`de` antes do apelido
 * `from`). Só a FORMA é cobrada aqui — dia que o calendário não tem, data no
 * futuro, período longo demais são do core, que responde já traduzido e com
 * a mesma regra da tela.
 */
function dateFlag(flags: Flags, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = flags[name];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') throw new CliError({ key: 'cli.uso.dataSemValor', params: { flag: name } });
    const value = raw.trim();
    if (!DATE_RE.test(value)) {
      // O valor volta ECOADO no terminal: limpo e cortado, como tudo que vem de fora.
      throw new CliError({ key: 'cli.uso.dataInvalida', params: { flag: name, valor: sanitizeDisplay(raw, DATE_ECHO_MAX) } });
    }
    return value;
  }
  return undefined;
}

/**
 * As flags de período viradas na query da rota.
 *
 * - `--range dia|semana|mes|ano` (default `dia`) com `--anchor AAAA-MM-DD`
 *   opcional: o período que contém a data;
 * - `--de AAAA-MM-DD --ate AAAA-MM-DD` (ou `--from`/`--to`): intervalo livre.
 *   Elas IMPLICAM personalizado; um `--range` diferente junto é recusado em
 *   vez de um dos dois vencer calado — "o mês de 01/08 a 15/08" não existe.
 */
export function parsePeriodFlags(flags: Flags): UsagePeriodQuery {
  if (flags.range === true) throw new CliError({ key: 'cli.uso.rangeSemValor' });
  const rangeFlag = typeof flags.range === 'string' ? flags.range : undefined;
  const range = rangeFlag === undefined ? undefined : parseRange(rangeFlag);
  const anchor = dateFlag(flags, ['anchor']);
  const from = dateFlag(flags, ['de', 'from']);
  const to = dateFlag(flags, ['ate', 'to']);

  if (from !== undefined || to !== undefined || range === 'custom') {
    if (range !== undefined && range !== 'custom') {
      throw new CliError({ key: 'cli.uso.rangeComPeriodo', params: { range: sanitizeDisplay(rangeFlag ?? '', DATE_ECHO_MAX) } });
    }
    if (anchor !== undefined) throw new CliError({ key: 'cli.uso.anchorComPeriodo' });
    if (from === undefined || to === undefined) throw new CliError({ key: 'cli.uso.periodoIncompleto' });
    return { range: 'custom', from, to };
  }
  return anchor === undefined ? { range: range ?? 'day' } : { range: range ?? 'day', anchor };
}

/** O caminho de `GET /api/usage` com só o que foi pedido — sem `anchor` vazio. */
export function usagePath(query: UsagePeriodQuery): string {
  const params = new URLSearchParams({ range: query.range });
  if (query.anchor !== undefined) params.set('anchor', query.anchor);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  return `/api/usage?${params.toString()}`;
}

/**
 * `2026-09-05` → `05/09/2026` em pt-BR, `09/05/2026` em inglês. A ORDEM dos
 * campos é dado de locale, não copy: quem escreve isso é o `Intl`. Data que
 * não tem a forma ISO volta como veio.
 */
export function shortDate(iso: string, lang: Language): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Intl.DateTimeFormat(INTL_LOCALE[lang], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** Milhar agrupado pela locale — `1.284` em pt-BR, `1,284` em inglês. */
export function count(value: number, lang: Language): string {
  return formatCount(Math.round(value), lang);
}

/** `US$ 48,70`, ou `—` quando nenhum modelo do recorte tem preço. */
function money(value: number | null, lang: Language): string {
  return value === null ? '—' : formatUsd(value, lang);
}

/**
 * Tabela alinhada por coluna, com as colunas numéricas à DIREITA: uma coluna
 * de tokens alinhada à esquerda obriga a ler dígito a dígito pra comparar duas
 * linhas.
 */
function grid(headers: string[], rows: string[][], rightFrom = 1): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cols: string[]): string =>
    cols
      .map((c, i) => (i >= rightFrom ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** Quantos projetos a tabela por projeto mostra antes de agrupar em "outros". */
export const PROJECT_TOP = 5;

/**
 * Teto de uma célula de texto da tabela (BU-09).
 *
 * `model`, `project` e o rótulo de janela vêm do disco (`message.model` e
 * `cwd` de uma linha de transcript) ou de um payload de hook. Isto aqui é
 * `console.log` num TERMINAL, que interpreta o que receber: um `cwd` com
 * `OSC 0` sequestra o título da janela, um com CSI 2 J apaga a tela, e um de
 * 10 243 caracteres destrói o alinhamento que o `grid()` calcula por
 * `.length`. Só o caminho HUMANO passa por aqui — `--json` sai cru de
 * propósito, porque é JSON e não tela.
 */
export const CELL_MAX = 80;

/** Teto de uma linha de aviso — elas também são impressas cruas. */
export const WARNING_MAX = 300;

/** Texto de fora pronto pra virar célula de tabela no terminal. */
function cell(value: string): string {
  return sanitizeDisplay(value, CELL_MAX);
}

/** O teto de arquivos por listagem do core — só pra escrever o número na frase. */
const MAX_SCAN_FILES = 50_000;

/**
 * O que a varredura NÃO leu, em uma linha — ou `undefined` quando leu tudo.
 *
 * As duas travas da fase de segurança fazem a contagem ficar MENOR que o
 * consumo real (linha de transcrição acima de 4 MiB é pulada; árvore acima de
 * 50 000 arquivos é cortada), e um número menor apresentado como total é
 * justamente o defeito silencioso que o BU-01 tinha. No terminal a ressalva
 * vem junto do relatório, e não no log.
 */
export function scanCaveatLine(scanning: UsageReport['scanning'], lang: Language): string | undefined {
  if (!scanning) return undefined;
  const partes: string[] = [];
  if (scanning.skippedLines > 0) {
    // Plural é chave explícita (Task 1, §1.3), nunca um `s` colado no fim.
    partes.push(
      scanning.skippedLines === 1
        ? t(lang, 'cli.uso.linhasIgnoradas.uma')
        : t(lang, 'cli.uso.linhasIgnoradas.varias', { n: count(scanning.skippedLines, lang) }),
    );
  }
  if (scanning.capped) partes.push(t(lang, 'cli.uso.listaLimitada', { n: count(MAX_SCAN_FILES, lang) }));
  if (partes.length === 0) return undefined;
  return t(lang, 'cli.uso.ressalva', { partes: partes.join(' · ') });
}

function cacheLine(totals: UsageTotals, lang: Language): string {
  const partes = [t(lang, 'cli.uso.cache.escrita', { tokens: formatTokens(totals.cacheWrite, lang) })];
  // A escrita de 1 h custa o dobro do input; ela só aparece quando existe,
  // pra a linha não gastar espaço dizendo "não houve".
  if (totals.cacheWrite1h > 0) {
    partes.push(t(lang, 'cli.uso.cache.escrita1h', { tokens: formatTokens(totals.cacheWrite1h, lang) }));
  }
  partes.push(t(lang, 'cli.uso.cache.leitura', { tokens: formatTokens(totals.cacheRead, lang) }));
  return partes.join(' · ');
}

/** `62,8%` / `62.8%` — a fatia dos subagentes, com uma casa. */
function pctText(part: number, whole: number, lang: Language): string {
  if (whole <= 0) return '0%';
  return `${new Intl.NumberFormat(INTL_LOCALE[lang], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format((part / whole) * 100)}%`;
}

/**
 * O relatório inteiro em texto. Puro: recebe o corpo da rota e devolve a
 * saída, o que deixa o teste comparar a tela sem subir processo nenhum.
 */
export function renderUsage(report: UsageReport, opts: { showCost: boolean; lang: Language }): string {
  const lang = opts.lang;
  const out: string[] = [];
  const periodo =
    report.from === report.to
      ? shortDate(report.from, lang)
      : t(lang, 'cli.uso.periodoIntervalo', { de: shortDate(report.from, lang), ate: shortDate(report.to, lang) });
  out.push(t(lang, 'cli.uso.cabecalho', { range: rangeName(report.range, lang), periodo, tz: report.tz }));

  // A varredura em voo é a primeira coisa a dizer: sem isso um total baixo
  // porque o core ainda está lendo parece um total baixo de verdade.
  if (report.scanning?.active) {
    out.push(
      t(lang, 'cli.uso.varredura', {
        feitos: count(report.scanning.filesDone, lang),
        total: count(report.scanning.filesTotal, lang),
      }),
    );
  }
  // A ressalva vem ANTES dos totais, pelo mesmo motivo da linha acima: lê-la
  // depois de já ter acreditado no número não serve pra nada.
  const ressalva = scanCaveatLine(report.scanning, lang);
  if (ressalva !== undefined) out.push(ressalva);
  out.push('');

  const totals = report.totals;
  const totais: string[][] = [
    [t(lang, 'cli.uso.linha.entrada'), formatTokens(totals.input, lang), ''],
    [t(lang, 'cli.uso.linha.saida'), formatTokens(totals.output, lang), ''],
    [
      t(lang, 'cli.uso.linha.cache'),
      formatTokens(totals.cacheWrite + totals.cacheWrite1h + totals.cacheRead, lang),
      cacheLine(totals, lang),
    ],
    [t(lang, 'cli.uso.linha.mensagens'), count(totals.messages, lang), ''],
  ];
  if (opts.showCost) {
    totais.push([
      t(lang, 'cli.uso.linha.custo'),
      money(totals.cost, lang),
      totals.cost === null
        ? t(lang, 'cli.uso.semPrecoNaTabela')
        : t(lang, totals.costPartial ? 'cli.uso.estimativaParcial' : 'cli.uso.estimativa', {
            data: report.pricingAsOf,
          }),
    ]);
  }
  out.push(t(lang, 'cli.uso.totais'));
  for (const line of grid(['', t(lang, 'cli.uso.coluna.valor'), ''], totais, 1)) out.push(`  ${line}`);

  // "Inclui subagentes" não é uma opção de filtro: os dois lados JÁ estão nos
  // totais acima, e a linha existe pra a pessoa não achar que gastou tudo
  // aquilo digitando.
  const sub = report.bySource.subagents;
  out.push('');
  out.push(
    t(lang, 'cli.uso.incluiSubagentes', {
      pct: pctText(sub.tokens, totals.tokens, lang),
      parte: formatTokens(sub.tokens, lang),
      total: formatTokens(totals.tokens, lang),
    }),
  );

  if (report.byModel.length > 0) {
    out.push('');
    out.push(t(lang, 'cli.uso.porModelo'));
    const rows = report.byModel.map((m) => [
      cell(m.model),
      formatTokens(m.tokens, lang),
      count(m.messages, lang),
      ...(opts.showCost ? [m.unpriced ? t(lang, 'cli.uso.semPreco') : money(m.cost, lang)] : []),
    ]);
    const headers = [
      t(lang, 'cli.uso.coluna.modelo'),
      t(lang, 'cli.uso.coluna.tokens'),
      t(lang, 'cli.uso.coluna.mensagens'),
      ...(opts.showCost ? [t(lang, 'cli.uso.coluna.custo')] : []),
    ];
    for (const line of grid(headers, rows)) out.push(`  ${line}`);
  }

  if (report.byProject.length > 0) {
    out.push('');
    const cortados = report.byProject.slice(0, PROJECT_TOP);
    const resto = report.byProject.slice(PROJECT_TOP);
    out.push(
      resto.length > 0
        ? t(lang, 'cli.uso.porProjetoTop', { top: PROJECT_TOP, total: report.byProject.length })
        : t(lang, 'cli.uso.porProjeto'),
    );
    const rows = cortados.map((p) => [
      cell(p.project),
      formatTokens(p.tokens, lang),
      count(p.messages, lang),
      ...(opts.showCost ? [money(p.cost, lang)] : []),
    ]);
    if (resto.length > 0) {
      // O "outros" é somado, não escondido: um total por projeto que não fecha
      // com o total geral faria a pessoa procurar o consumo que sumiu.
      const tokens = resto.reduce((a, p) => a + p.tokens, 0);
      const messages = resto.reduce((a, p) => a + p.messages, 0);
      const comPreco = resto.filter((p) => p.cost !== null);
      const cost = comPreco.length > 0 ? comPreco.reduce((a, p) => a + (p.cost ?? 0), 0) : null;
      rows.push([
        t(lang, 'cli.uso.outrosProjetos', { n: resto.length }),
        formatTokens(tokens, lang),
        count(messages, lang),
        ...(opts.showCost ? [money(cost, lang)] : []),
      ]);
    }
    const headers = [
      t(lang, 'cli.uso.coluna.projeto'),
      t(lang, 'cli.uso.coluna.tokens'),
      t(lang, 'cli.uso.coluna.mensagens'),
      ...(opts.showCost ? [t(lang, 'cli.uso.coluna.custo')] : []),
    ];
    for (const line of grid(headers, rows)) out.push(`  ${line}`);
  }

  out.push('');
  out.push(t(lang, 'cli.uso.limites'));
  if (report.limits.length === 0) {
    out.push(t(lang, 'cli.uso.semLimites'));
  } else {
    // O `label` da janela chega PRONTO do core, no idioma dele — a UI e a CLI
    // não retraduzem o que o core já escreveu (spec §13).
    const rows = report.limits.map((l) => [
      cell(l.label),
      `${Math.round(l.usedPct)}%`,
      resetText(l.resetsAt, lang),
    ]);
    const headers = [
      t(lang, 'cli.uso.coluna.janela'),
      t(lang, 'cli.uso.coluna.usado'),
      t(lang, 'cli.uso.coluna.reseta'),
    ];
    for (const line of grid(headers, rows, 1)) out.push(`  ${line}`);
  }

  if (opts.showCost && report.pricingWarnings.length > 0) {
    out.push('');
    out.push(t(lang, 'cli.uso.avisos'));
    // O aviso carrega o ID DO MODELO, que veio do transcript — mesmo vetor.
    for (const w of report.pricingWarnings) out.push(`  ${sanitizeDisplay(w, WARNING_MAX)}`);
  }

  return out.join('\n');
}

/**
 * `reseta em 2h15` / `reseta 06/09 14:00`. Abaixo de 24 h a contagem regressiva
 * é o que a pessoa usa; acima dela, a data — "reseta em 51h" ninguém converte
 * de cabeça.
 */
export function resetText(resetsAt: number | undefined, lang: Language, now: number = Date.now()): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return '';
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return '';
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return t(lang, 'cli.uso.reseta.minutos', { n: min });
  if (ms < 24 * 3600_000) {
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest === 0
      ? t(lang, 'cli.uso.reseta.horas', { n: h })
      : t(lang, 'cli.uso.reseta.horasMinutos', { h, m: String(rest).padStart(2, '0') });
  }
  // Dia/mês e hora pela locale, como o `shortDate`: a ORDEM dos campos e o
  // relógio de 12/24 h são dado de locale, não decisão de copy. Sem ano de
  // propósito — a data só aparece dentro da janela de poucos dias do reset.
  return new Intl.DateTimeFormat(INTL_LOCALE[lang], {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetsAt * 1000));
}

interface RescanBody {
  files: number;
  entries: number;
  days: number;
}

/**
 * `bridge usage [--range dia|semana|mes|ano] [--anchor AAAA-MM-DD] [--json]`,
 * `bridge usage --de AAAA-MM-DD --ate AAAA-MM-DD` e `bridge usage --rescan`.
 *
 * O `--rescan` não aceita flag de período: ele não lê recorte nenhum, relê o
 * disco. Recusar a combinação (em vez de ignorá-la) é o que impede alguém de
 * achar que releu "o mês".
 */
export async function cmdUsage(ctx: Ctx, flags: Flags): Promise<CommandResult> {
  const known: readonly string[] = [...PERIOD_FLAGS, 'rescan'];
  for (const name of Object.keys(flags)) {
    if (!known.includes(name)) throw new CliError({ key: 'cli.erro.flagDesconhecida', params: { flag: name } });
  }

  if (flags.rescan !== undefined) {
    if (PERIOD_FLAGS.some((name) => flags[name] !== undefined)) throw new CliError({ key: 'cli.uso.rescanComRange' });
    const body = await ctx.client.post<RescanBody>('/api/usage/rescan');
    const dias =
      body.days === 1
        ? t(ctx.lang, 'cli.uso.dias.um')
        : t(ctx.lang, 'cli.uso.dias.varios', { n: count(body.days, ctx.lang) });
    return {
      human: t(ctx.lang, 'cli.uso.releituraConcluida', {
        arquivos: count(body.files, ctx.lang),
        mensagens: count(body.entries, ctx.lang),
        dias,
      }),
      json: body,
    };
  }

  const report = await ctx.client.get<UsageReport>(usagePath(parsePeriodFlags(flags)));

  // `showCost` desligado tira o dinheiro do terminal também: quem desligou não
  // quer o número na tela, e a CLI é tela. Ele vem do MESMO `GET /api/config`
  // que resolveu o idioma, na borda — fix round 1: este comando fazia a
  // segunda chamada à mesma rota, no mesmo processo, pra ler um booleano.
  return { human: renderUsage(report, { showCost: ctx.showCost, lang: ctx.lang }), json: report };
}
