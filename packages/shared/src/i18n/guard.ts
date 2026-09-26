/**
 * A TRAVA do idioma (spec §13): "um teste por pacote varre `src/` procurando
 * literal com acento ou palavra pt-BR comum fora do catálogo e falha listando
 * arquivo:linha".
 *
 * Esta é a parte PURA da trava — texto entra, achados saem. Quem lê o disco é
 * o teste de cada pacote (`i18n-guard-<pacote>.test.ts`), que sabe quais
 * pastas varrer e o que a sua allowlist tem direito de perdoar.
 *
 * **Por que uma heurística e não o compilador.** Uma string nova em pt-BR é
 * TypeScript perfeitamente válido: não existe tipo que a proíba. A única
 * defesa possível é olhar o texto — e olhar texto é heurística. Ela erra pra
 * mais (um falso positivo aqui e ali), nunca pra menos: a saída de um falso
 * positivo é explícita e assinada — `// i18n-ignore` na linha ou uma regex em
 * `allow` —, e "explícito" é justamente o que faltava quando toda string era
 * um literal solto.
 *
 * **O que ele olha:**
 * 1. literais (`'…'`, `"…"`, `` `…` ``) com acento português ou com uma
 *    palavra da lista curta abaixo;
 * 2. texto ACENTUADO fora de literal — que em `.tsx` quer dizer filho de
 *    elemento (`<span>Não foi retomada</span>`), a superfície com mais copy
 *    do app e a que um varredor de strings deixaria passar inteira.
 *
 * **O que ele ignora:** comentários (a documentação do repositório é pt-BR e
 * continua sendo), linhas de `log.*(`/`log(` (os logs em arquivo são do dono e
 * do suporte, spec §13), linhas com `// i18n-ignore` e o que casar com
 * `allow`.
 */

/** Um achado: a linha (1-based) e o texto que disparou. */
export interface UncataloguedLiteral {
  line: number;
  text: string;
}

export interface GuardOptions {
  /**
   * Perdões explícitos. Cada regex é testada contra o TEXTO do achado e
   * contra a LINHA inteira do fonte — a segunda forma é a que serve pra
   * perdoar uma chamada inteira (`/InternalError/`) sem listar cada texto.
   */
  allow?: RegExp[];
}

/** Os acentos do português. Um `é` num literal é copy até prova em contrário. */
const ACCENT_RE = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;

/**
 * Palavras pt-BR SEM acento — as com acento já caem na regra de cima. A lista
 * é curta de propósito: cada palavra aqui é uma chance de falso positivo em
 * texto inglês, e a rede fina custa mais do que pega.
 */
const PT_WORDS = [
  'voce',
  'nao',
  'sessao',
  'sessoes',
  'painel',
  'paineis',
  'aguardando',
  'arquivo',
  'arquivos',
  'pasta',
  'ambiente',
  'atalho',
  'janela',
  'tarefa',
];
const WORD_RE = new RegExp(`\\b(${PT_WORDS.join('|')})\\b`, 'i');

/**
 * Forma de IDENTIFICADOR: `ambiente.semClaude.rotulo` (uma chave do próprio
 * catálogo), `nao-e-objeto` (um código de problema), `wsl:Ubuntu` (um id de
 * ambiente). Nada disso é lido por gente — e todos casariam com a lista de
 * palavras acima, porque as chaves do catálogo são batizadas em português.
 *
 * Exige PELO MENOS um separador: `aguardando` sozinho continua sendo copy. E
 * só reconhece ASCII, então texto com acento nunca é silenciado por aqui.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9_]+([-_.:][A-Za-z0-9_]+)+$/;

/** `log('…')`, `log.warn('…')`, `this.log.info(\`…\`)`. */
const LOG_RE = /\blog\s*(\.\s*\w+\s*)?\(/;

const IGNORE_RE = /i18n-ignore/;

/**
 * Onde um `/` PODE começar uma expressão regular. Sem esta distinção, um
 * `/['"]/` do próprio código abriria uma string no varredor e o resto do
 * arquivo viraria texto — o tipo de erro que faz uma trava mentir em silêncio.
 */
const REGEX_ALLOWED_BEFORE = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
]);

type Frame =
  | { kind: 'code'; fromTemplate: boolean; depth: number }
  | { kind: 'sq' | 'dq' | 'tpl'; start: number; startLine: number };

interface Hit {
  at: number;
  line: number;
  text: string;
}

export function findUncataloguedLiterals(source: string, opts: GuardOptions = {}): UncataloguedLiteral[] {
  const lines = source.split('\n');
  const hits: Hit[] = [];
  /** Linhas em que texto acentuado apareceu FORA de literal (JSX). */
  const jsxLines = new Map<number, number>();

  const stack: Frame[] = [{ kind: 'code', fromTemplate: false, depth: 0 }];
  let i = 0;
  let line = 1;

  /** Último caractere significativo do código — decide `/` regex vs divisão. */
  let lastCode = '';

  while (i < source.length) {
    const frame = stack[stack.length - 1] as Frame;
    const ch = source[i] as string;

    if (frame.kind === 'code') {
      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        for (let k = i; k < stop; k += 1) if (source[k] === '\n') line += 1;
        i = stop;
        continue;
      }
      if (ch === '/' && canBeRegex(lastCode)) {
        const end = skipRegex(source, i);
        if (end > i) {
          lastCode = '/';
          i = end;
          continue;
        }
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        stack.push({ kind: ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tpl', start: i, startLine: line });
        i += 1;
        continue;
      }
      if (ch === '{') {
        frame.depth += 1;
        lastCode = ch;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (frame.fromTemplate && frame.depth === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        frame.depth = Math.max(0, frame.depth - 1);
        lastCode = ch;
        i += 1;
        continue;
      }
      if (ACCENT_RE.test(ch) && !jsxLines.has(line)) jsxLines.set(line, i);
      if (!/\s/.test(ch)) lastCode = /\w/.test(ch) ? wordBefore(source, i) : ch;
      i += 1;
      continue;
    }

    // Dentro de um literal.
    if (ch === '\\') {
      if (source[i + 1] === '\n') line += 1;
      i += 2;
      continue;
    }
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (frame.kind === 'tpl' && ch === '$' && source[i + 1] === '{') {
      stack.push({ kind: 'code', fromTemplate: true, depth: 0 });
      i += 2;
      continue;
    }
    const closer = frame.kind === 'sq' ? "'" : frame.kind === 'dq' ? '"' : '`';
    if (ch === closer) {
      const text = source.slice(frame.start + 1, i);
      if (looksPortuguese(text)) hits.push({ at: frame.start, line: frame.startLine, text });
      stack.pop();
      lastCode = 'x';
      i += 1;
      continue;
    }
    i += 1;
  }

  for (const [jsxLine, at] of jsxLines) {
    hits.push({ at, line: jsxLine, text: (lines[jsxLine - 1] ?? '').trim() });
  }
  hits.sort((a, b) => a.at - b.at);

  /**
   * O `g` sai de cada perdão antes do primeiro `test`. Uma regex global carrega
   * `lastIndex` entre chamadas, e aqui cada uma é testada duas vezes por achado
   * (texto e linha) e uma vez por arquivo: com o `g`, o segundo `test` começa de
   * onde o primeiro parou e um perdão legítimo passa a valer só de vez em
   * quando — uma trava que depende da ORDEM dos achados. Reconstruir sem a
   * flag custa uma alocação por varredura e tira a armadilha do caminho de
   * quem escreve a allowlist.
   */
  const allow = (opts.allow ?? []).map((re) =>
    re.flags.includes('g') ? new RegExp(re.source, re.flags.replace(/g/g, '')) : re,
  );
  const out: UncataloguedLiteral[] = [];
  for (const hit of hits) {
    const sourceLine = lines[hit.line - 1] ?? '';
    if (IGNORE_RE.test(sourceLine)) continue;
    if (LOG_RE.test(sourceLine)) continue;
    if (allow.some((re) => re.test(hit.text) || re.test(sourceLine))) continue;
    out.push({ line: hit.line, text: hit.text });
  }
  return out;
}

function looksPortuguese(text: string): boolean {
  if (IDENTIFIER_RE.test(text)) return false;
  return ACCENT_RE.test(text) || WORD_RE.test(text);
}

/** A palavra que termina em `i` — pra distinguir `return /re/` de `a / b`. */
function wordBefore(source: string, i: number): string {
  let start = i;
  while (start > 0 && /\w/.test(source[start - 1] as string)) start -= 1;
  return source.slice(start, i + 1);
}

function canBeRegex(lastCode: string): boolean {
  return lastCode === '' || REGEX_ALLOWED_BEFORE.has(lastCode);
}

/**
 * Consome uma regex a partir de `start` (`/`). Devolve o índice depois das
 * flags, ou `start` quando não fecha na mesma linha — aí o `/` era divisão.
 */
function skipRegex(source: string, start: number): number {
  // `/>` é fechamento de tag em JSX, não regex; `/ ` e `/=` também não abrem
  // uma no código deste repositório. Sem esta porta, um `<Foo />` faria o
  // varredor engolir o resto da linha atrás de uma barra que nunca vem.
  const next = source[start + 1];
  if (next === undefined || next === '>' || next === '=' || /\s/.test(next)) return start;
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '\n') return start;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/.test(source[i] as string)) i += 1;
      return i;
    }
    i += 1;
  }
  return start;
}
