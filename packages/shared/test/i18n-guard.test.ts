import { describe, expect, it } from 'vitest';
import { findUncataloguedLiterals } from '../src/i18n/guard.js';

/**
 * A TRAVA da spec §13: um teste por pacote varre `src/` atrás de texto em
 * pt-BR fora do catálogo. Esta função é a parte pura da trava — recebe o
 * fonte de um arquivo, devolve `{ line, text }` do que parece copy.
 *
 * A heurística é deliberadamente simples (acento + uma lista curta de
 * palavras): ela não entende TypeScript, ela lê caracteres. O preço é um
 * falso positivo de vez em quando, e a saída dele é a linha com
 * `// i18n-ignore` ou uma regex em `allow` — as duas escritas por quem
 * decidiu, não adivinhadas pela varredura.
 */
function linhas(source: string): string[] {
  return findUncataloguedLiterals(source).map((f) => f.text);
}

describe('findUncataloguedLiterals — o que ele PEGA', () => {
  it('literal com acento', () => {
    const achados = findUncataloguedLiterals("const a = 'Sessão encerrada';\n");
    expect(achados).toEqual([{ line: 1, text: 'Sessão encerrada' }]);
  });

  it('literal sem acento, mas com palavra pt-BR da lista', () => {
    expect(linhas('const b = "painel vazio";\n')).toEqual(['painel vazio']);
    expect(linhas("const c = 'aguardando';\n")).toEqual(['aguardando']);
  });

  it('template literal, com a linha em que ele COMEÇA', () => {
    const source = ['const x = 1;', 'const y = `total: ${x} sessões`;', ''].join('\n');
    expect(findUncataloguedLiterals(source)).toEqual([{ line: 2, text: 'total: ${x} sessões' }]);
  });

  it('template de várias linhas conta a linha da abertura', () => {
    const source = ['const y = `', 'não', '`;', ''].join('\n');
    expect(findUncataloguedLiterals(source)[0]?.line).toBe(1);
  });

  /**
   * Texto solto de JSX não é literal nenhum — é filho de elemento. Sem esta
   * varredura o guard da UI passaria batido justamente na superfície que
   * mais tem copy.
   */
  it('texto de JSX (fora de literal) quando tem acento', () => {
    const achados = findUncataloguedLiterals('<span>Não foi retomada</span>\n');
    expect(achados).toHaveLength(1);
    expect(achados[0]?.line).toBe(1);
    expect(achados[0]?.text).toContain('Não foi retomada');
  });

  it('acha mais de um por arquivo, na ordem do fonte', () => {
    const source = ["const a = 'não';", "const b = 'sessão';", ''].join('\n');
    expect(findUncataloguedLiterals(source)).toEqual([
      { line: 1, text: 'não' },
      { line: 2, text: 'sessão' },
    ]);
  });
});

describe('findUncataloguedLiterals — o que ele IGNORA', () => {
  it('comentário de linha e de bloco (a doc do repo é pt-BR e continua sendo)', () => {
    expect(linhas('// a sessão está aguardando você\n')).toEqual([]);
    expect(linhas('/**\n * Não traduzir: isto é documentação.\n */\n')).toEqual([]);
    expect(linhas("const a = 1; // painel não é isto\n")).toEqual([]);
  });

  it('linha de log — os logs em arquivo ficam em pt-BR (spec §13)', () => {
    expect(linhas("log.warn('sessão morreu sem aviso');\n")).toEqual([]);
    expect(linhas("this.log.info(`painel ${id} fechado`);\n")).toEqual([]);
    expect(linhas("log('não subiu');\n")).toEqual([]);
  });

  it('linha marcada com // i18n-ignore', () => {
    expect(linhas("const a = 'não'; // i18n-ignore: id do protocolo\n")).toEqual([]);
  });

  it('o que casa com uma regex de `allow`', () => {
    const source = "const a = 'sessão';\nconst b = 'painel';\n";
    const achados = findUncataloguedLiterals(source, { allow: [/^sess/] });
    expect(achados).toEqual([{ line: 2, text: 'painel' }]);
  });

  it('`allow` também vale pra LINHA inteira, não só pro literal', () => {
    const source = "throw new InternalError('não deu');\n";
    expect(findUncataloguedLiterals(source, { allow: [/InternalError/] })).toEqual([]);
  });

  /**
   * As chaves do catálogo são batizadas em português (`ambiente.sumiu.rotulo`)
   * e os códigos do protocolo também (`nao-e-objeto`). Sem esta regra, TODA
   * chamada de `t` seria um achado — a trava viraria ruído no primeiro dia.
   */
  it('literal com forma de identificador: chave do catálogo, código, id', () => {
    expect(linhas("return t(lang, 'ambiente.semClaude.rotulo');\n")).toEqual([]);
    expect(linhas("kind: 'nao-e-objeto' | 'atalho-invalido';\n")).toEqual([]);
    expect(linhas("const id = 'wsl:Ubuntu';\n")).toEqual([]);
  });

  it('mas uma palavra sozinha não é identificador — continua sendo copy', () => {
    expect(linhas("const a = 'aguardando';\n")).toEqual(['aguardando']);
  });

  it('texto em inglês, identificador e caminho', () => {
    expect(linhas("const a = 'Waiting for you';\n")).toEqual([]);
    expect(linhas("import { t } from './i18n/index.js';\n")).toEqual([]);
    expect(linhas("const p = 'C:\\Users\\bridge';\n")).toEqual([]);
  });

  /**
   * Regex com aspas dentro (`/['\"]/`) quebraria um varredor ingênuo: ele
   * abriria uma string ali e leria o resto do arquivo como texto.
   */
  it('literal de regex não vira string — e não desalinha o resto do arquivo', () => {
    const source = ["const q = /['\"]/g;", "const a = 'não';", ''].join('\n');
    expect(findUncataloguedLiterals(source)).toEqual([{ line: 2, text: 'não' }]);
  });

  it('aspas escapadas dentro do literal não terminam o literal', () => {
    // O fonte varrido é, literalmente: const a = 'o \\'painel\\' fechou';
    const source = ["const a = 'o \\'painel\\' fechou';", ''].join('\n');
    expect(findUncataloguedLiterals(source)).toEqual([{ line: 1, text: "o \\'painel\\' fechou" }]);
  });

  it('fonte vazio não acha nada', () => {
    expect(findUncataloguedLiterals('')).toEqual([]);
  });
});

describe('findUncataloguedLiterals — é PURA', () => {
  it('não muda o fonte nem guarda estado entre chamadas', () => {
    const source = "const a = 'não';\n";
    const um = findUncataloguedLiterals(source);
    const dois = findUncataloguedLiterals(source);
    expect(um).toEqual(dois);
  });
});
