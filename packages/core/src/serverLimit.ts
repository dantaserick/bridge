/**
 * Detector do limite do SERVIDOR na saída do PTY (dor verificada #1).
 *
 * Mora ao lado do `osc.ts` porque é o mesmo tipo de bicho: um scanner que
 * corre em cima do fluxo cru do terminal e levanta a mão quando reconhece uma
 * forma. A diferença é o que ele procura — não uma sequência de controle, mas
 * as frases que o Claude Code imprime quando a infraestrutura da Anthropic
 * está estrangulando as chamadas:
 *
 *     Server is temporarily limiting requests (not your usage limit)
 *     API Error: 529 {"type":"error","error":{"type":"overloaded_error",…}}
 *
 * Esse limite **não é o seu limite de uso** e **não escala com o plano**: ele
 * bate em quem roda várias sessões lado a lado, que é exatamente o caso de uso
 * do Bridge. Sem distinguir os dois, a pessoa lê "limite" na tela e conclui
 * que gastou a cota — e mexe no plano por um problema que não é dela.
 *
 * ## O que NÃO é gatilho
 *
 * O plano listava "rate limit" e "overloaded" entre as pistas. Sozinhas elas
 * são falso positivo garantido: `// TODO: tratar rate limit` num diff,
 * `if (err.status === 529)` num arquivo aberto no terminal, a documentação do
 * próprio Bridge sendo lida com `cat`. Todo padrão daqui exige a frase INTEIRA
 * do Claude Code ou o token que só existe no corpo do erro da API
 * (`overloaded_error`, `API Error: 529`). Um `529` solto não casa; um "rate
 * limit" solto não casa.
 *
 * ## Janela
 *
 * A saída chega picada em chunks arbitrários — a frase pode nascer partida no
 * meio ("Server is temporarily limi" | "ting requests"). Por isso o scanner
 * guarda uma janela ROLANTE de 4 KB por sessão (o mesmo teto do `OscScanner`)
 * e casa sobre ela, não sobre o chunk. Casou, a janela é esvaziada: sem isso o
 * mesmo texto voltaria a casar a cada byte novo que chegasse depois dele.
 */
import { sanitizeDisplay, t, type Language } from '@bridge/shared';
import type { ServerLimit } from '@bridge/shared';

/** Teto da janela por sessão — o mesmo do scanner de OSC. */
export const SERVER_LIMIT_WINDOW_BYTES = 4 * 1024;

/**
 * Quanto tempo a sessão fica `server-limited` sem nenhuma outra notícia.
 *
 * Cinco minutos: o estrangulamento do servidor é medido em segundos a poucos
 * minutos, e a saída normal do estado é o próximo turno do agente
 * (`Stop`/`UserPromptSubmit`). O prazo existe pro caso em que esse turno nunca
 * chega — o agente desistiu, o usuário saiu pra almoçar, a sessão é um shell
 * (que não tem hook nenhum) — porque um anel laranja eterno mente sobre o
 * presente.
 */
export const SERVER_LIMIT_TTL_MS = 5 * 60 * 1000;

/** Teto do trecho guardado em `ServerLimit.phrase` (tooltip, não parágrafo). */
export const SERVER_LIMIT_PHRASE_MAX = 160;

interface Pattern {
  id: string;
  re: RegExp;
}

/**
 * Os padrões, na ordem em que são testados. Todos em minúsculas — o casamento
 * roda sobre a janela já rebaixada, e não com a flag `i`, pra que o `lastIndex`
 * e a busca sejam previsíveis.
 *
 * - `limiting-requests`: a frase do banner do Claude Code, a mais específica;
 * - `not-your-usage-limit`: a segunda metade dela, que aparece sozinha em
 *   algumas versões da mensagem;
 * - `overloaded`: o `type` do corpo de erro 529 da API (`overloaded_error`),
 *   que só existe no JSON do erro;
 * - `api-529`: a linha `API Error: 529` (com ou sem parêntese/ponto), que é
 *   como o Claude Code carimba o erro antes de repetir a chamada.
 */
export const SERVER_LIMIT_PATTERNS: readonly Pattern[] = [
  { id: 'limiting-requests', re: /server is temporarily limiting requests/ },
  { id: 'not-your-usage-limit', re: /not your usage limit/ },
  { id: 'overloaded', re: /overloaded_error/ },
  { id: 'api-529', re: /api error[^\n]{0,24}\b529\b/ },
];

/** OSC/CSI/ESC solto — o mesmo alcance do `sanitizeDisplay`, sem cortar nada. */
const ANSI =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u001b/g;

/**
 * Texto do terminal pronto pra casar: sem ANSI, sem quebra de linha dura e em
 * minúsculas.
 *
 * As quebras viram espaço (e não somem) porque o Claude Code quebra a frase do
 * banner na largura do terminal: `Server is temporarily\nlimiting requests`
 * tem que casar, e `a\nb` não pode virar `ab` — isso criaria palavra onde não
 * havia. Espaço repetido colapsa pelo mesmo motivo: a moldura do banner mete
 * espaço entre as palavras.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(ANSI, '')
    .replace(/[\r\n\t\v\f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .toLowerCase();
}

export interface ServerLimitMatch {
  pattern: string;
  /** O trecho em volta do casamento, sanitizado — vira `ServerLimit.phrase`. */
  phrase: string;
}

/**
 * Peneira barata, rodada no texto CRU antes da normalização.
 *
 * Ela existe por causa do volume: este matcher é chamado a cada chunk de cada
 * PTY, e um `npm run build` cuspindo milhares de linhas pagaria, por chunk, um
 * `toLowerCase` de 4 KB mais três `replace` mais quatro casamentos. Nenhuma
 * dessas três palavras aparece na saída normal de um terminal, então o caminho
 * comum sai daqui com UMA passada nativa.
 *
 * O que ela custa: um ESC no MEIO de uma dessas palavras (`limi<ESC>ting`)
 * escaparia da peneira. Isso não acontece na prática — a cor do Claude Code
 * envolve o segmento inteiro, nunca parte uma palavra — e os testes de frase
 * colorida guardam essa suposição.
 */
const CHEAP_NEEDLES = /limit|overload|529/i;

/**
 * A saída acumulada denuncia limite do servidor?
 *
 * `text` é a janela CRUA (ANSI e tudo); a normalização acontece aqui dentro
 * pra que quem chama não precise lembrar de fazê-la. Devolve o primeiro padrão
 * que casar, com o trecho em volta pra prova.
 */
export function matchServerLimit(text: string): ServerLimitMatch | undefined {
  if (!CHEAP_NEEDLES.test(text)) return undefined;
  const haystack = normalizeForMatch(text);
  for (const pattern of SERVER_LIMIT_PATTERNS) {
    const found = pattern.re.exec(haystack);
    if (!found) continue;
    // Um pedaço em volta do casamento, não a janela inteira: o tooltip mostra
    // a frase, não 4 KB de terminal.
    const from = Math.max(0, found.index - 40);
    const raw = haystack.slice(from, found.index + found[0].length + 60);
    return { pattern: pattern.id, phrase: sanitizeDisplay(raw, SERVER_LIMIT_PHRASE_MAX) };
  }
  return undefined;
}

/**
 * Uma janela rolante por sessão. `push` devolve o casamento na primeira vez
 * que ele aparece e esvazia a janela — a mesma frase não dispara duas vezes
 * por causa do byte seguinte.
 */
export class ServerLimitScanner {
  private windows = new Map<string, string>();

  constructor(private readonly cap: number = SERVER_LIMIT_WINDOW_BYTES) {}

  push(sessionId: string, chunk: string): ServerLimitMatch | undefined {
    if (!chunk) return undefined;
    const merged = (this.windows.get(sessionId) ?? '') + chunk;
    const window = merged.length > this.cap ? merged.slice(merged.length - this.cap) : merged;
    const match = matchServerLimit(window);
    // Casou: a janela some inteira. Guardar o rastro faria o próximo chunk
    // casar de novo com a MESMA frase, e o `since` da sessão andaria sozinho.
    this.windows.set(sessionId, match ? '' : window);
    return match;
  }

  /** Esquece a janela — sessão encerrada, ou saída do estado `server-limited`. */
  forget(sessionId: string): void {
    this.windows.delete(sessionId);
  }
}

/** O `ServerLimit` que vai pra sessão, montado do casamento. */
export function serverLimitOf(match: ServerLimitMatch, now: number): ServerLimit {
  return { since: now, phrase: match.phrase, pattern: match.pattern };
}

/**
 * Texto de `detail` da sessão estrangulada. Curto porque a linha da sidebar
 * tem uma coluna estreita; a frase ORIGINAL do Claude Code (em inglês, do
 * tamanho que ele quiser) vai no tooltip, junto do "não é o seu limite de
 * uso" — ela é saída de agente e não passa pelo catálogo (spec §13).
 */
export const detailServerLimited = (lang: Language): string => t(lang, 'core.sessao.detalhe.limiteServidor');
