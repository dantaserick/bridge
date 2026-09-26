import { describe, expect, it } from 'vitest';
import { LANGUAGES, en, ptBR, resolveLanguage, systemLanguage, t } from '../src/i18n/index.js';
import type { Language, LanguageSetting, MessageKey } from '../src/i18n/index.js';

/**
 * O catálogo de mensagens (spec §13). O que estes testes protegem: as duas
 * tabelas com as MESMAS chaves (o `satisfies` do `en.ts` pega isso no tipo,
 * e este teste pega em runtime — uma chave só existe de verdade quando os
 * dois arquivos a têm), a interpolação de `{param}`, a recusa em dev de
 * chave e de parâmetro que não existem, e a resolução do idioma do sistema.
 */

/**
 * A prova de TIPO: se `en.ts` perder uma chave, esta linha não compila. Ela
 * mora no teste — e não só no `satisfies` do arquivo — porque o `typecheck`
 * do pacote inclui `test/`, então a falha aparece nas duas portas.
 */
const _mesmasChaves: Record<MessageKey, string> = en;
void _mesmasChaves;

describe('catálogo', () => {
  it('pt-BR e en têm exatamente as mesmas chaves', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort());
  });

  it('nenhuma mensagem é vazia nos dois idiomas', () => {
    for (const [key, text] of Object.entries(ptBR)) {
      expect(text, `pt-BR ${key}`).not.toBe('');
    }
    for (const [key, text] of Object.entries(en)) {
      expect(text, `en ${key}`).not.toBe('');
    }
  });

  /**
   * Os `{param}` de uma chave têm que ser os MESMOS nos dois idiomas: uma
   * tradução que troca `{n}` por `{count}` compila (é string) e explode só na
   * hora de interpolar, no idioma que quase ninguém roda em teste.
   */
  it('as duas traduções pedem os mesmos parâmetros', () => {
    const params = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
    for (const key of Object.keys(ptBR) as MessageKey[]) {
      expect(params(en[key]), key).toEqual(params(ptBR[key]));
    }
  });

  it('LANGUAGES lista os dois idiomas', () => {
    expect(LANGUAGES).toEqual(['pt-BR', 'en']);
  });
});

describe('t', () => {
  it('devolve a mensagem do idioma pedido', () => {
    expect(t('pt-BR', 'ambiente.gitbash')).toBe('Git Bash');
    expect(t('pt-BR', 'formato.tempo.agora')).toBe('agora');
    expect(t('en', 'formato.tempo.agora')).toBe('now');
  });

  it('interpola {param} — inclusive o mesmo parâmetro duas vezes', () => {
    expect(t('pt-BR', 'ambiente.wsl', { distro: 'Ubuntu' })).toBe('WSL · Ubuntu');
    expect(t('en', 'formato.tempo.minutos', { n: 4 })).toBe('4 min ago');
    expect(t('pt-BR', 'formato.tempo.minutos', { n: 4 })).toBe('há 4 min');
  });

  /**
   * Número entra como número: quem chama não precisa lembrar de `String(n)`,
   * e um `0` não pode virar string vazia por causa de um `||` no caminho.
   */
  it('aceita número como parâmetro', () => {
    expect(t('pt-BR', 'formato.tempo.dias', { n: 0 })).toBe('há 0 dias');
  });

  it('em dev, parâmetro faltando é erro — e não um `{n}` cru na tela', () => {
    expect(() => t('pt-BR', 'formato.tempo.minutos')).toThrow(/formato\.tempo\.minutos/);
    expect(() => t('pt-BR', 'formato.tempo.minutos', {})).toThrow(/\bn\b/);
  });

  it('em dev, chave desconhecida é erro', () => {
    expect(() => t('pt-BR', 'nao.existe' as MessageKey)).toThrow(/nao\.existe/);
  });

  /**
   * Em produção nada disso derruba a tela: chave desconhecida sai como a
   * própria chave e parâmetro faltando fica como veio. Um texto errado é
   * ruim; uma janela em branco por causa de um texto errado é pior.
   *
   * "Produção" aqui é qualquer coisa que não seja `test`/`development` — o
   * `.exe` empacotado não define `NODE_ENV` nenhum, e é ele o ambiente que
   * não pode explodir.
   */
  it('em produção degrada em vez de lançar', () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(t('pt-BR', 'nao.existe' as MessageKey)).toBe('nao.existe');
      expect(t('pt-BR', 'formato.tempo.minutos')).toBe('há {n} min');
    } finally {
      if (antes === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = antes;
    }
  });

  /** Sem `NODE_ENV` nenhum — o caso do app instalado — também degrada. */
  it('sem NODE_ENV, degrada', () => {
    const antes = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(t('pt-BR', 'formato.tempo.minutos')).toBe('há {n} min');
    } finally {
      if (antes !== undefined) process.env.NODE_ENV = antes;
    }
  });

  it('parâmetro sobrando é ignorado', () => {
    expect(t('pt-BR', 'formato.tempo.agora', { n: 3 })).toBe('agora');
  });
});

describe('resolveLanguage', () => {
  const casos: Array<[LanguageSetting, string | undefined, Language]> = [
    ['pt-BR', 'en-US', 'pt-BR'],
    ['en', 'pt-BR', 'en'],
    ['system', 'pt-BR', 'pt-BR'],
    ['system', 'en-US', 'en'],
    ['system', undefined, 'en'],
    ['system', 'pt-PT', 'pt-BR'],
  ];

  it.each(casos)('%s + %s → %s', (setting, locale, esperado) => {
    expect(resolveLanguage(setting, locale)).toBe(esperado);
  });
});

describe('systemLanguage', () => {
  it('qualquer português vira pt-BR', () => {
    expect(systemLanguage('pt')).toBe('pt-BR');
    expect(systemLanguage('pt-PT')).toBe('pt-BR');
    expect(systemLanguage('pt_BR')).toBe('pt-BR');
    expect(systemLanguage('PT-br')).toBe('pt-BR');
  });

  it('o resto do mundo cai em inglês — inclusive espanhol', () => {
    expect(systemLanguage('es')).toBe('en');
    expect(systemLanguage('es-AR')).toBe('en');
    expect(systemLanguage('en-GB')).toBe('en');
    expect(systemLanguage('ja-JP')).toBe('en');
  });

  /**
   * Sem locale (ambiente sem ICU, `navigator.language` vazio) o idioma é
   * inglês: é o que um usuário de fora do Brasil consegue ler, e o dono
   * troca no seletor em dois cliques.
   */
  it('locale ausente ou vazia cai em inglês', () => {
    expect(systemLanguage(undefined)).toBe('en');
    expect(systemLanguage('')).toBe('en');
    expect(systemLanguage('   ')).toBe('en');
  });
});
