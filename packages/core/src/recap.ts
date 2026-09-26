/**
 * Dor verificada #3 — o `--resume` que volta VAZIO, e o resumo que devolve o
 * contexto.
 *
 * O sintoma que os usuários do Claude Code relatam: `claude --resume <id>`
 * (ou `--continue`) sobe sem erro nenhum, o painel acende, e a conversa lá
 * dentro está zerada. Ninguém digitou errado — o agente simplesmente abriu uma
 * sessão nova. Do lado do Bridge isso é observável: o painel PEDIU um id e o
 * primeiro `SessionStart` volta com outro (ou com `source` diferente de
 * `resume`). É o que `resumeOutcomeOf` decide.
 *
 * O conserto não pode ser mágico. O Bridge não tem como injetar o contexto
 * real da conversa anterior — ele não é dono do estado do agente. O que ele
 * TEM é o transcript daquela conversa no disco, e daí sai um resumo
 * **determinístico** (nada de modelo resumindo modelo): o último pedido do
 * dono mais as últimas respostas de texto do assistente, truncados e
 * sanitizados. É pouco, e é honesto sobre ser pouco — a faixa da UI diz que é
 * um resumo automático, e quem aperta o botão sabe o que está mandando.
 *
 * Três decisões que valem a leitura:
 *
 * - **uma linha só.** O texto vai pro PROMPT do agente por `pty.write`, sem
 *   bracketed paste. Um `\n` ali dentro não é quebra de linha: é Enter, e
 *   metade do resumo viraria um turno submetido pela metade. Por isso cada
 *   trecho passa por `sanitizeDisplay`, que já colapsa controle em espaço, e
 *   os trechos são unidos por um separador visível (`SEP`);
 * - **leitura pela CAUDA.** O que interessa é o fim da conversa, e transcripts
 *   passam de dezenas de MB. Ler `RECAP_TAIL_BYTES` do fim custa o mesmo num
 *   arquivo de 1 MB e num de 800 MB;
 * - **teto duplo.** `RECAP_ITEM_MAX` por trecho e `RECAP_MAX_CHARS` no total.
 *   O que passa é cortado, nunca resumido: um corte é previsível, uma
 *   compressão feita à mão não é.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { sanitizeDisplay, t, type Language } from '@bridge/shared';
import { asRecord, asString } from './adapters/payload.js';
import { projectsDir } from './usage/transcripts.js';

/** Teto do resumo INTEIRO, em caracteres (o plano do lote fixa 2 500). */
export const RECAP_MAX_CHARS = 2500;

/** Teto de cada trecho (o pedido do dono, cada resposta do assistente). */
export const RECAP_ITEM_MAX = 600;

/** Quantas respostas do assistente entram, da mais antiga pra mais nova. */
export const RECAP_ASSISTANT_COUNT = 3;

/**
 * Quanto do FIM do transcript é lido. 2 MiB cobre com folga um punhado de
 * turnos com ferramentas no meio — e é o que separa "ler o fim da conversa"
 * de "ler oitocentos megabytes pra pegar as quatro últimas falas".
 */
export const RECAP_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Quantas pastas de projeto a busca de fallback olha antes de desistir. O
 * caminho normal é o primeiro palpite (a pasta codificada a partir do `cwd`);
 * isto existe só pro caso de o Claude Code ter gravado a conversa sob outro
 * `cwd` (o dono rodou `cd` antes do `/exit`), e não pode virar uma varredura
 * proporcional ao que alguém plantou em `projects/`.
 */
export const RECAP_MAX_PROJECT_DIRS = 2000;

/** O que separa os trechos na linha única que vai pro prompt. */
const SEP = ' · ';

/**
 * Os rótulos do resumo injetado (spec §13). O texto vai pro PROMPT do agente,
 * que o lê e o repete pro dono — logo, idioma do dono, resolvido no instante
 * em que o resumo é montado.
 */
const labelUser = (lang: Language): string => t(lang, 'core.recap.pedido');
const labelAssistant = (lang: Language): string => t(lang, 'core.recap.respostas');

/**
 * O nome da pasta que o Claude Code usa pra um `cwd`: todo caractere que não é
 * letra nem dígito vira `-`. `D:\Projetos\meu-app` → `D--Projetos-meu-app`
 * (conferido contra a árvore real de uma máquina, sem ler o conteúdo de
 * transcript nenhum).
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** O palpite direto: `<home>/projects/<cwd codificado>/<id>.jsonl`. */
export function transcriptPathFor(home: string, cwd: string, agentSessionId: string): string {
  return join(projectsDir(home), projectDirName(cwd), `${agentSessionId}.jsonl`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Onde mora o transcript de `agentSessionId`, ou `undefined`.
 *
 * O `agentSessionId` já passou pelo `AGENT_SESSION_ID` do hook antes de ser
 * gravado, mas o caminho montado com ele é conferido de novo contra a raiz de
 * `projects/`: esta função também é chamada com o que veio do SQLite, e um
 * banco adulterado não pode virar leitura de arquivo arbitrário (a mesma
 * disciplina do dump de hooks).
 */
export async function findTranscript(home: string, cwd: string, agentSessionId: string): Promise<string | undefined> {
  const root = resolve(projectsDir(home));
  const direct = resolve(transcriptPathFor(home, cwd, agentSessionId));
  if (!direct.startsWith(root + sep)) return undefined;
  if (await isFile(direct)) return direct;

  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const dir of dirs.slice(0, RECAP_MAX_PROJECT_DIRS)) {
    const candidate = resolve(join(root, dir, `${agentSessionId}.jsonl`));
    if (!candidate.startsWith(root + sep)) continue;
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Um trecho aproveitável de uma linha do transcript. */
export interface RecapTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Blocos `{ type: 'text' }` de um `message.content` que é array, concatenados.
 * `tool_use` e `tool_result` ficam de fora: o resumo é da CONVERSA, e um
 * `tool_use` é o agente falando com o Bridge, não com o dono.
 */
function textOfBlocks(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (asString(record.type) !== 'text') continue;
    const text = asString(record.text);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/**
 * Uma linha crua do transcript → o trecho que entra no resumo, ou `undefined`.
 *
 * O que fica de fora, e por quê:
 *
 * - o que não é `type: "user"`/`"assistant"` (as linhas de metadado do Claude
 *   Code: `mode`, `cost-state`, `attachment`, `file-history-snapshot`…);
 * - `isSidechain: true` — é subagente, não a conversa deste painel;
 * - `isMeta: true` — texto que o próprio Claude Code injetou, não o dono;
 * - `user` cujo conteúdo é `tool_result`: é a resposta de uma ferramenta
 *   voltando pro modelo, e ela chega no transcript com `type: "user"`;
 * - `user` cujo texto começa com `<` — os envelopes de comando
 *   (`<command-name>`, `<local-command-stdout>`) e os lembretes de sistema.
 *   Nenhum deles é um pedido que faça sentido repetir pro agente novo.
 */
export function parseRecapLine(line: string): RecapTurn | undefined {
  if (line.length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  const type = asString(record.type);
  if (type !== 'user' && type !== 'assistant') return undefined;
  if (record.isSidechain === true || record.isMeta === true) return undefined;

  const message = asRecord(record.message);
  const content = message.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (type === 'user' && content.some((block) => asString(asRecord(block).type) === 'tool_result')) return undefined;
    text = textOfBlocks(content);
  } else {
    return undefined;
  }

  const clean = sanitizeDisplay(text, RECAP_ITEM_MAX);
  if (clean.length === 0) return undefined;
  if (type === 'user' && clean.startsWith('<')) return undefined;
  return { role: type, text: clean };
}

/**
 * O resumo em si, a partir das linhas do transcript NA ORDEM do arquivo.
 *
 * A escolha é deliberadamente burra e reprodutível: o ÚLTIMO pedido do dono
 * mais as ÚLTIMAS `RECAP_ASSISTANT_COUNT` respostas do agente, na ordem em que
 * aconteceram. Duas execuções sobre o mesmo arquivo dão exatamente a mesma
 * string — é o que separa isto de "pedir pro modelo resumir".
 *
 * Devolve `''` quando não sobrou nada aproveitável (transcript só de
 * ferramentas, arquivo vazio, cauda que pegou só metadado).
 */
export function buildRecap(lines: Iterable<string>, lang: Language): string {
  let lastUser: string | undefined;
  const assistants: string[] = [];
  for (const line of lines) {
    const turn = parseRecapLine(line);
    if (!turn) continue;
    if (turn.role === 'user') lastUser = turn.text;
    else {
      assistants.push(turn.text);
      if (assistants.length > RECAP_ASSISTANT_COUNT) assistants.shift();
    }
  }

  const parts: string[] = [];
  if (lastUser) parts.push(`${labelUser(lang)} ${lastUser}`);
  if (assistants.length > 0) parts.push(`${labelAssistant(lang)} ${assistants.join(SEP)}`);
  if (parts.length === 0) return '';
  // Teto FINAL em cima do texto já montado. `sanitizeDisplay` de novo (e não
  // um `slice`) porque é ele que garante o corte sem meio par substituto e a
  // linha única — os rótulos entraram depois da primeira limpeza.
  return sanitizeDisplay(parts.join(SEP), RECAP_MAX_CHARS);
}

/** Por que não houve resumo. Cada um vira um código de erro da rota. */
export type RecapFailure = 'no-resume' | 'transcript-not-found' | 'recap-empty';

export interface RecapResult {
  text?: string;
  reason?: RecapFailure;
  /** O arquivo lido — diagnóstico do relatório e do teste, não vai pra UI. */
  path?: string;
}

/**
 * Lê a CAUDA do arquivo e devolve as linhas completas dela.
 *
 * A primeira linha da fatia quase nunca começa num `\n`, então ela é
 * descartada: meia linha de JSON não parseia, e tentar recuperá-la exigiria
 * ler o arquivo inteiro — que é justamente o que a leitura por cauda evita.
 * Arquivo menor que a janela é lido do começo, e aí nada é descartado.
 */
export async function tailLines(path: string, tailBytes = RECAP_TAIL_BYTES): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const from = Math.max(0, size - tailBytes);
    const length = Math.min(size, tailBytes);
    if (length <= 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (from > 0) lines.shift();
    return lines.filter((line) => line.length > 0);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface RecapRequest {
  /** Raiz do Claude Code (`claudeHome()` do módulo de transcripts). */
  home: string;
  /** `cwd` da sessão — é ele que dá o nome da pasta do projeto. */
  cwd: string;
  /** O id que o `--resume` PEDIU. Ausente = não há o que resumir. */
  agentSessionId?: string;
  /** O idioma dos rótulos injetados (spec §13) — `core.language()` de agora. */
  lang: Language;
}

/**
 * O resumo da conversa que o `--resume` não trouxe de volta.
 *
 * Nunca lança: toda falha vira um `reason`, porque quem chama é uma rota que
 * precisa transformar isso num código de erro pro usuário ler — "o transcript
 * daquela conversa não está mais no disco" é uma resposta legítima, não um bug.
 */
export async function readRecap(req: RecapRequest): Promise<RecapResult> {
  const id = req.agentSessionId?.trim();
  if (!id) return { reason: 'no-resume' };
  const path = await findTranscript(req.home, req.cwd, id);
  if (!path) return { reason: 'transcript-not-found' };
  const text = buildRecap(await tailLines(path), req.lang);
  if (text.length === 0) return { reason: 'recap-empty', path };
  return { text, path };
}

/**
 * O veredito do `--resume` a partir do payload do primeiro `SessionStart`
 * (dor verificada #3).
 *
 * `undefined` quer dizer "não há o que julgar", e ele sai em dois casos
 * diferentes de propósito:
 *
 * - a sessão não pediu resume nenhum;
 * - o payload não trouxe NEM `session_id` NEM `source`. Chutar `'fresh'` aqui
 *   acenderia a faixa de "o resume falhou" contra um agente que talvez tenha
 *   retomado a conversa perfeitamente — e um alarme falso nesse aviso ensina o
 *   dono a ignorá-lo.
 *
 * O `source` ganha do id quando existe e não é `'resume'`: um `SessionStart`
 * com `source: 'startup'` é o próprio agente dizendo que começou do zero,
 * mesmo que por algum motivo o id coincidisse.
 */
export function resumeOutcomeOf(
  requested: string | undefined,
  payload: { sessionId?: string; source?: string },
): 'ok' | 'fresh' | undefined {
  if (!requested) return undefined;
  const source = payload.source?.trim();
  const sessionId = payload.sessionId?.trim();
  if (source) return source === 'resume' && (!sessionId || sessionId === requested) ? 'ok' : 'fresh';
  if (!sessionId) return undefined;
  return sessionId === requested ? 'ok' : 'fresh';
}
