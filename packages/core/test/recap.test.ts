/**
 * Dor verificada #3 — o detector do resume vazio e o extrator do resumo.
 *
 * Nada aqui lê o `~/.claude` de ninguém: os transcripts são fixtures escritas
 * num `tmpDir()`, com a MESMA forma de linha que o Claude Code grava (`type`,
 * `message.content` string ou array, `isSidechain`, `isMeta`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import { Sessions } from '../src/sessions.js';
import { tmpDir } from './tmp.js';
import {
  RECAP_ASSISTANT_COUNT,
  RECAP_ITEM_MAX,
  RECAP_MAX_CHARS,
  buildRecap,
  findTranscript,
  parseRecapLine,
  projectDirName,
  readRecap,
  resumeOutcomeOf,
  tailLines,
  transcriptPathFor,
} from '../src/recap.js';

const REQUESTED = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-5555-6666-7777-888888888888';

function userLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra });
}

function assistantLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  });
}

/** Escreve um transcript na árvore que o Claude Code usaria pra `cwd`. */
function writeTranscript(home: string, cwd: string, id: string, lines: string[]): string {
  const path = transcriptPathFor(home, cwd, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

describe('resumeOutcomeOf — o veredito do --resume', () => {
  it('id igual ao pedido → ok', () => {
    expect(resumeOutcomeOf(REQUESTED, { sessionId: REQUESTED })).toBe('ok');
  });

  it('id DIFERENTE do pedido → fresh (a dor verificada)', () => {
    expect(resumeOutcomeOf(REQUESTED, { sessionId: OTHER })).toBe('fresh');
  });

  it('source startup vence o id: o agente disse que começou do zero', () => {
    expect(resumeOutcomeOf(REQUESTED, { sessionId: REQUESTED, source: 'startup' })).toBe('fresh');
  });

  it('source resume com o mesmo id → ok', () => {
    expect(resumeOutcomeOf(REQUESTED, { sessionId: REQUESTED, source: 'resume' })).toBe('ok');
  });

  it('source resume com OUTRO id ainda é fresh', () => {
    expect(resumeOutcomeOf(REQUESTED, { sessionId: OTHER, source: 'resume' })).toBe('fresh');
  });

  it('sem id, mas com source resume → ok', () => {
    expect(resumeOutcomeOf(REQUESTED, { source: 'resume' })).toBe('ok');
  });

  it('sem id e sem source → sem veredito (não inventa alarme)', () => {
    expect(resumeOutcomeOf(REQUESTED, {})).toBeUndefined();
  });

  it('sessão que não pediu resume nenhum → sem veredito', () => {
    expect(resumeOutcomeOf(undefined, { sessionId: OTHER, source: 'startup' })).toBeUndefined();
  });
});

describe('projectDirName / transcriptPathFor', () => {
  it('codifica o cwd do jeito que o Claude Code codifica', () => {
    expect(projectDirName('D:\\Projetos\\meu-app')).toBe('D--Projetos-meu-app');
    expect(projectDirName('/home/alguem/projeto.x')).toBe('-home-alguem-projeto-x');
  });

  it('monta `<home>/projects/<cwd>/<id>.jsonl`', () => {
    const path = transcriptPathFor('/raiz', 'D:\\App', REQUESTED);
    expect(path.replace(/\\/g, '/')).toBe(`/raiz/projects/D--App/${REQUESTED}.jsonl`);
  });
});

describe('parseRecapLine — o que entra no resumo', () => {
  it('user com conteúdo string entra', () => {
    expect(parseRecapLine(userLine('conserta o poller de git'))).toEqual({
      role: 'user',
      text: 'conserta o poller de git',
    });
  });

  it('assistant com blocos de texto entra, sem os tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'achei o problema' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'x.ts', new_string: 'segredo' } },
          { type: 'text', text: 'e consertei' },
        ],
      },
    });
    const turn = parseRecapLine(line);
    expect(turn?.role).toBe('assistant');
    expect(turn?.text).toBe('achei o problema e consertei');
    expect(turn?.text).not.toContain('segredo');
  });

  it('user carregando tool_result fica de fora (é ferramenta, não pedido)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'saída do comando' }] },
    });
    expect(parseRecapLine(line)).toBeUndefined();
  });

  it('subagente (isSidechain) e meta (isMeta) ficam de fora', () => {
    expect(parseRecapLine(userLine('do subagente', { isSidechain: true }))).toBeUndefined();
    expect(parseRecapLine(assistantLine('meta', { isMeta: true }))).toBeUndefined();
  });

  it('envelope de comando do Claude Code fica de fora', () => {
    expect(parseRecapLine(userLine('<command-name>/clear</command-name>'))).toBeUndefined();
  });

  it('metadado, JSON quebrado e linha vazia ficam de fora', () => {
    expect(parseRecapLine(JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }))).toBeUndefined();
    expect(parseRecapLine('{isso nao e json')).toBeUndefined();
    expect(parseRecapLine('')).toBeUndefined();
  });

  it('trecho gigante é truncado em RECAP_ITEM_MAX', () => {
    const turn = parseRecapLine(userLine('x'.repeat(5000)));
    expect(turn?.text.length).toBe(RECAP_ITEM_MAX);
  });

  it('ANSI e controle da conversa não sobrevivem (o texto vai pro terminal)', () => {
    const turn = parseRecapLine(userLine('antes \u001b[31mvermelho\u001b[0m\ndepois'));
    expect(turn?.text).toBe('antes vermelho depois');
    expect(turn?.text).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('buildRecap — o resumo determinístico', () => {
  const lines = [
    userLine('pedido antigo'),
    assistantLine('resposta 1'),
    assistantLine('resposta 2'),
    userLine('último pedido'),
    assistantLine('resposta 3'),
    assistantLine('resposta 4'),
    assistantLine('resposta 5'),
  ];

  it('pega o ÚLTIMO pedido do usuário e as últimas três respostas', () => {
    const recap = buildRecap(lines, 'pt-BR');
    expect(recap).toContain('último pedido');
    expect(recap).not.toContain('pedido antigo');
    expect(recap).toContain('resposta 3');
    expect(recap).toContain('resposta 5');
    expect(recap).not.toContain('resposta 2');
  });

  it('três respostas é o teto declarado', () => {
    const many = Array.from({ length: 10 }, (_, i) => assistantLine(`r${i}`));
    const recap = buildRecap(many, 'pt-BR');
    const kept = [...recap.matchAll(/r\d/g)].length;
    expect(kept).toBe(RECAP_ASSISTANT_COUNT);
  });

  it('é DETERMINÍSTICO: duas passadas dão a mesma string', () => {
    expect(buildRecap(lines, 'pt-BR')).toBe(buildRecap(lines, 'pt-BR'));
  });

  it('cabe em RECAP_MAX_CHARS mesmo com quatro trechos no teto', () => {
    const gordo = [
      userLine('u'.repeat(4000)),
      assistantLine('a'.repeat(4000)),
      assistantLine('b'.repeat(4000)),
      assistantLine('c'.repeat(4000)),
    ];
    expect(buildRecap(gordo, 'pt-BR').length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
  });

  it('sai em UMA linha (um \\n viraria Enter no prompt do agente)', () => {
    expect(buildRecap([userLine('a\nb\nc'), assistantLine('d\ne')], 'pt-BR')).not.toContain('\n');
  });

  it('transcript só de ferramenta devolve vazio', () => {
    const so = [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })];
    expect(buildRecap(so, 'pt-BR')).toBe('');
  });
});

describe('tailLines — leitura pela cauda', () => {
  it('descarta a primeira linha PARCIAL quando a janela não pega o começo', async () => {
    const dir = tmpDir('bridge-recap-');
    const path = join(dir, 'x.jsonl');
    writeFileSync(path, ['linha-um', 'linha-dois', 'linha-tres'].join('\n'), 'utf8');
    // Janela pequena: a fatia começa no meio de `linha-dois`.
    const lines = await tailLines(path, 15);
    expect(lines).not.toContain('linha-um');
    expect(lines.at(-1)).toBe('linha-tres');
  });

  it('arquivo menor que a janela vem inteiro', async () => {
    const dir = tmpDir('bridge-recap-');
    const path = join(dir, 'y.jsonl');
    writeFileSync(path, 'a\nb\n', 'utf8');
    expect(await tailLines(path)).toEqual(['a', 'b']);
  });

  it('arquivo inexistente devolve lista vazia, sem lançar', async () => {
    expect(await tailLines(join(tmpDir('bridge-recap-'), 'nao-existe.jsonl'))).toEqual([]);
  });
});

describe('findTranscript / readRecap — do disco ao texto', () => {
  it('acha pelo cwd codificado e resume', async () => {
    const home = tmpDir('bridge-recap-');
    const cwd = tmpDir('bridge-recap-cwd-');
    writeTranscript(home, cwd, REQUESTED, [userLine('mexe no launcher'), assistantLine('mexi')]);
    const result = await readRecap({ home, cwd, agentSessionId: REQUESTED, lang: 'pt-BR' });
    expect(result.reason).toBeUndefined();
    expect(result.text).toContain('mexe no launcher');
    expect(result.text).toContain('mexi');
  });

  it('acha o transcript mesmo quando ele foi gravado sob OUTRO cwd', async () => {
    const home = tmpDir('bridge-recap-');
    const cwdReal = tmpDir('bridge-recap-cwd-');
    const cwdPedido = tmpDir('bridge-recap-outro-');
    writeTranscript(home, cwdReal, REQUESTED, [userLine('ainda acha')]);
    expect(await findTranscript(home, cwdPedido, REQUESTED)).toBeDefined();
  });

  it('sem id pedido → no-resume', async () => {
    const home = tmpDir('bridge-recap-');
    expect(await readRecap({ home, cwd: home, agentSessionId: undefined, lang: 'pt-BR' })).toEqual({ reason: 'no-resume' });
  });

  it('transcript que não existe → transcript-not-found', async () => {
    const home = tmpDir('bridge-recap-');
    mkdirSync(join(home, 'projects'), { recursive: true });
    const result = await readRecap({ home, cwd: home, agentSessionId: REQUESTED, lang: 'pt-BR' });
    expect(result.reason).toBe('transcript-not-found');
  });

  it('transcript sem texto aproveitável → recap-empty', async () => {
    const home = tmpDir('bridge-recap-');
    const cwd = tmpDir('bridge-recap-cwd-');
    writeTranscript(home, cwd, REQUESTED, [JSON.stringify({ type: 'cost-state', totalCostUSD: 2 })]);
    const result = await readRecap({ home, cwd, agentSessionId: REQUESTED, lang: 'pt-BR' });
    expect(result.reason).toBe('recap-empty');
  });

  it('id com travessia de caminho não sai da raiz de projects', async () => {
    const home = tmpDir('bridge-recap-');
    mkdirSync(join(home, 'projects'), { recursive: true });
    writeFileSync(join(home, 'segredo.jsonl'), userLine('nao devia sair'), 'utf8');
    expect(await findTranscript(home, home, '..\\..\\segredo')).toBeUndefined();
    expect(await findTranscript(home, home, '../../segredo')).toBeUndefined();
  });
});

/**
 * Fix round 1 — a janela do julgamento é o PRIMEIRO `SessionStart`, e não o
 * primeiro veredito; e o primeiro byte do PTY é o que libera a injeção
 * automática. As duas marcas moram na `Sessions`, fora do `Session`, porque
 * nenhuma delas é fato do domínio.
 */
describe('Sessions — as duas marcas da dor #3', () => {
  const CWD = ['C:', 'projetos', 'x'].join('\\');

  function agente() {
    const bus = new EventBus();
    const sessions = new Sessions(bus);
    const session = sessions.create({
      paneId: 'pane_1',
      workspaceId: 'ws_1',
      kind: 'agent',
      agent: 'claude',
      cwd: CWD,
      resumeRequested: REQUESTED,
    });
    return { sessions, id: session.id };
  }

  it('judgeResume grava o veredito e devolve a sessão UMA vez', () => {
    const { sessions, id } = agente();
    expect(sessions.judgeResume(id, 'fresh')?.resumeOutcome).toBe('fresh');
    expect(sessions.judgeResume(id, 'ok')).toBeUndefined();
    expect(sessions.get(id)?.resumeOutcome).toBe('fresh');
  });

  it('SessionStart MUDO fecha a janela: o veredito seguinte não entra', () => {
    const { sessions, id } = agente();
    // Payload sem id e sem source: `resumeOutcomeOf` devolve `undefined`.
    expect(sessions.judgeResume(id, undefined)).toBeUndefined();
    expect(sessions.get(id)?.resumeOutcome).toBeUndefined();
    // O `/clear` do dono, depois. Antes da fix round 1 isto virava 'fresh'.
    expect(sessions.judgeResume(id, 'fresh')).toBeUndefined();
    expect(sessions.get(id)?.resumeOutcome).toBeUndefined();
  });

  it('sessão de shell nunca é julgada', () => {
    const bus = new EventBus();
    const sessions = new Sessions(bus);
    const shell = sessions.create({ paneId: 'pane_1', workspaceId: 'ws_1', kind: 'shell', cwd: CWD });
    expect(sessions.judgeResume(shell.id, 'fresh')).toBeUndefined();
    expect(sessions.get(shell.id)?.resumeOutcome).toBeUndefined();
  });

  it('noteOutput marca sawOutput e devolve a sessão só no PRIMEIRO byte', () => {
    const { sessions, id } = agente();
    expect(sessions.get(id)?.sawOutput).toBeUndefined();
    expect(sessions.noteOutput(id)?.sawOutput).toBe(true);
    expect(sessions.get(id)?.sawOutput).toBe(true);
    // Chamada a cada chunk de PTY: da segunda em diante não há evento.
    expect(sessions.noteOutput(id)).toBeUndefined();
    expect(sessions.noteOutput(id)).toBeUndefined();
  });

  it('noteOutput em sessão que não existe é no-op', () => {
    const { sessions } = agente();
    expect(sessions.noteOutput('sess_fantasma')).toBeUndefined();
  });

  it('remove esquece as duas marcas (id novo nasce sem herança)', () => {
    const { sessions, id } = agente();
    sessions.judgeResume(id, 'fresh');
    sessions.noteOutput(id);
    sessions.remove(id);
    expect(sessions.get(id)).toBeUndefined();
    expect(sessions.noteOutput(id)).toBeUndefined();
    expect(sessions.judgeResume(id, 'fresh')).toBeUndefined();
  });
});
