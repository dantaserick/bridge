/**
 * As janelas de limite VIVAS — 5 h, semana, e o que mais o Claude Code
 * mandar.
 *
 * De onde vêm: o payload que o Claude Code entrega ao hook `StatusLine` traz
 * `rate_limits: { five_hour: { used_percentage, resets_at }, seven_day: {…} }`
 * pra quem é assinante. Em conta de API key a chave simplesmente não vem — e
 * "não vem" não é "0%": a UI mostra o estado "sem limites a exibir" em vez de
 * duas barras vazias que pareceriam cota intacta.
 *
 * Nada aqui é hardcoded por nome de janela. O payload pode ganhar
 * `seven_day_opus` amanhã, e o Bridge tem que mostrar a janela nova com um
 * rótulo legível em vez de sumir com ela — por isso `windowLabel` deriva o
 * texto da CHAVE e a ordenação só privilegia as duas conhecidas.
 */
import { sanitizeDisplay, t, type Language, type MessageKey, type RateLimitWindow, type UsageLimitWindow } from '@bridge/shared';

/**
 * Rótulo curto em pt-BR a partir da chave crua: `five_hour` → `5h`,
 * `seven_day` → `semana`. Qualquer outra janela sai com a CHAVE CRUA
 * (`seven_day_opus`), de propósito — traduzir por adivinhação daria um rótulo
 * bonito e possivelmente errado, enquanto a chave crua é sempre verdade e é o
 * que a pessoa vai encontrar se procurar a documentação do Claude Code.
 */
export function windowLabel(window: string, lang: Language): string {
  if (window === 'five_hour') return t(lang, 'core.uso.janela.cincoHoras');
  if (window === 'seven_day') return t(lang, 'core.uso.janela.semana');
  // A chave já chega limpa de `quotaFromPayload` (BU-04/BU-06); a limpeza aqui
  // é pra janela que veio do BANCO, gravada por uma versão anterior — este
  // rótulo vai pra statusline, pro `bridge usage` e pro `title` do painel.
  return sanitizeDisplay(window, 64);
}

/** 5 h primeiro, semana depois, o resto em ordem alfabética. */
export function windowRank(window: string): number {
  if (window === 'five_hour') return 0;
  if (window === 'seven_day') return 1;
  if (window.startsWith('five_hour')) return 2;
  if (window.startsWith('seven_day')) return 3;
  return 4;
}

export function sortWindows<T extends { window: string }>(windows: T[]): T[] {
  return [...windows].sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.window.localeCompare(b.window));
}

/**
 * As chaves de dia da semana na ordem de `Date.getDay()`.
 *
 * Vêm do catálogo, e não do `Intl`: a forma curta de três letras é decisão de
 * design (a statusline tem uma linha de terminal), e decisão de design é copy.
 */
export const WEEKDAY_KEYS: readonly MessageKey[] = [
  'core.uso.diaSemana.dom',
  'core.uso.diaSemana.seg',
  'core.uso.diaSemana.ter',
  'core.uso.diaSemana.qua',
  'core.uso.diaSemana.qui',
  'core.uso.diaSemana.sex',
  'core.uso.diaSemana.sab',
];

/** `dom`…`sáb` / `Sun`…`Sat`. `day` é o que `Date.getDay()` devolve. */
export function weekdayLabel(day: number, lang: Language): string {
  return t(lang, WEEKDAY_KEYS[day] ?? 'core.uso.diaSemana.dom');
}

/**
 * A frase de reset de uma janela, no formato do gate visual:
 *
 * - dentro de 24 h → `reseta em 43min` / `reseta em 2h15`. É a informação
 *   acionável: dá ou não dá pra esperar antes de continuar;
 * - a partir de 24 h → `reseta seg`. Contar "em 4d 17h" com essa precisão
 *   sugere um controle que ninguém exerce; o dia da semana é o que a pessoa
 *   usa pra se planejar.
 *
 * Reset ausente ou VENCIDO devolve `undefined`: "reseta em -2h" seria pior
 * que não escrever nada, e um `resets_at` no passado só quer dizer que a
 * janela ainda não foi renovada no payload que temos em mãos.
 */
/**
 * Janela de sanidade do `resets_at` (BU-12/R5): dez anos à frente.
 *
 * `Number.MAX_SAFE_INTEGER` como `resets_at` dava `at = 9,007e18 ms`, um
 * `Date` inválido, `getDay()` igual a `NaN` e `WEEKDAYS_PT[NaN]` — a
 * statusline imprimia literalmente `reseta undefined` no terminal do dono.
 * Fora da janela a frase SOME, que é o mesmo tratamento do reset já vencido: o
 * percentual continua sendo verdade, a data não.
 *
 * É a mesma janela que `quotaFromPayload` aplica na ENTRADA; ela é repetida
 * aqui porque `formatReset` também recebe janela vinda do BANCO, gravada por
 * uma versão anterior à trava.
 */
export const MAX_RESET_AHEAD_MS = 10 * 365 * 24 * 3600 * 1000;

export function formatReset(resetsAt: number | undefined, now: number, lang: Language): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
  const at = resetsAt * 1000;
  const ms = at - now;
  if (ms <= 0 || ms > MAX_RESET_AHEAD_MS) return undefined;

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t(lang, 'core.uso.reseta.minutos', { n: Math.max(1, minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? t(lang, 'core.uso.reseta.horas', { n: hours })
      : t(lang, 'core.uso.reseta.horasMinutos', { h: hours, m: String(rest).padStart(2, '0') });
  }
  // Dia da semana no fuso do PROCESSO: é o relógio de parede de quem lê.
  return t(lang, 'core.uso.reseta.dia', { dia: weekdayLabel(new Date(at).getDay(), lang) });
}

/**
 * Percentual dentro de [0, 100].
 *
 * O payload é dado de fora: um `used_percentage` de 120 (que já apareceu
 * quando a janela estoura) viraria uma barra transbordando o cartão, e um
 * negativo viraria uma barra de largura negativa. O número é preso ANTES de
 * chegar ao banco, pra que nenhuma ponta precise se defender de novo.
 */
export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** As janelas do `QuotaSnapshot` viradas em janelas de uso, já ordenadas. */
/**
 * Estrangulamento do evento `usage.changed { limits }` (BU-14).
 *
 * O progresso de varredura já tinha o teto de 1/s por decisão explícita; o de
 * limites não tinha nenhum, e a statusline é redesenhada várias vezes por
 * segundo durante um turno — 4 000 chamadas de `noteLimits` em 107 ms na
 * medição da auditoria, cada uma uma escrita no SQLite e uma difusão pra todos
 * os clientes WS.
 *
 * A regra é a mesma do `progress.ts`, com uma diferença que importa: a ÚLTIMA
 * foto sempre é entregue, com atraso, em vez de descartada. Um percentual que
 * parasse de subir porque o último evento foi engolido seria pior que um
 * evento tardio.
 */
export const LIMITS_EMIT_MS = 1000;

export function limitsFromRateLimits(
  rateLimits: RateLimitWindow[],
  seenAt: number,
  lang: Language,
): UsageLimitWindow[] {
  return sortWindows(
    rateLimits.map((r) => ({
      window: r.window,
      label: windowLabel(r.window, lang),
      usedPct: clampPct(r.usedPct),
      resetsAt: r.resetsAt,
      seenAt,
    })),
  );
}

/**
 * Mudou o bastante pra avisar? Só `usedPct` e `resetsAt` contam — o `seenAt`
 * muda a cada statusline (várias vezes por segundo enquanto o turno roda), e
 * emitir `usage.changed` por causa dele faria a UI redesenhar à toa.
 */
export function limitsChanged(previous: UsageLimitWindow[], next: UsageLimitWindow[]): boolean {
  if (previous.length !== next.length) return true;
  const byWindow = new Map(previous.map((l) => [l.window, l]));
  for (const limit of next) {
    const old = byWindow.get(limit.window);
    if (!old) return true;
    if (old.usedPct !== limit.usedPct || old.resetsAt !== limit.resetsAt) return true;
  }
  return false;
}

// ------------------------------------------- limite de USO atingido (100 %)

/**
 * O limite de USO em 100 % ganha um selo próprio — VERMELHO, com o horário do
 * reset — pra não ser confundido com o laranja do limite do SERVIDOR (dor
 * verificada #1: um é seu e reseta; o outro é da infraestrutura e passa
 * sozinho).
 *
 * A implementação mora na UI (`usageLimitBadge`, em `packages/ui/src/
 * usageModel.ts`), que é quem desenha o selo e já tem o formatador de reset
 * dela. Aqui ficou só este bilhete: o fix round 1 apontou que a versão do core
 * era uma SEGUNDA implementação do mesmo texto — com o mesmo destino de toda
 * duplicata, divergir na primeira mudança de redação. O limiar
 * (`USAGE_LIMIT_REACHED_PCT`) é a política, e por isso vive no
 * `@bridge/shared`, citável pelos dois lados.
 */
