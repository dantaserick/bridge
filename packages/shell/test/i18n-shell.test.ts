/**
 * O idioma do PROCESSO MAIN (spec §13, Task 4 do lote de idioma).
 *
 * O que este arquivo prova, e que nenhum outro prova: o shell tem duas fases
 * de resolução (a locale do Electron antes do core, o `languageResolved` do
 * core depois dele) e um texto que fica NA TELA entre um evento e outro (o
 * menu da bandeja), que precisa ser remontado quando o idioma muda.
 *
 * Nada aqui importa `electron`: o vitest deste pacote roda em ambiente node, e
 * é por isso que a decisão de texto da bandeja mora em `trayMenu.ts` e não em
 * `tray.ts` — o mesmo corte de `windowPolicy.ts` × `main.ts`.
 */
import { t } from '@bridge/shared';
import type { BridgeConfig } from '@bridge/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FETCH_TIMEOUT_MS,
  bootLanguage,
  languageFromConfig,
  readCoreLanguage,
  setShellLanguage,
  shellLanguage,
  tShell,
} from '../src/language.js';
import type { FetchLike } from '../src/language.js';
import { coalesce, emptyToastQueue } from '../src/toast.js';
import { trayMenuItems, trayTooltip } from '../src/trayMenu.js';

/** O módulo guarda o idioma; cada caso começa do zero. */
beforeEach(() => {
  setShellLanguage('en');
});

describe('a bandeja, nos dois idiomas', () => {
  it('os dois itens do menu, na mesma ordem e com as mesmas ids', () => {
    expect(trayMenuItems('pt-BR')).toEqual([
      { id: 'show', label: 'Mostrar' },
      { id: 'quit', label: 'Sair' },
    ]);
    expect(trayMenuItems('en')).toEqual([
      { id: 'show', label: 'Show' },
      { id: 'quit', label: 'Quit' },
    ]);
  });

  it('sem nada por ler, o tooltip é só a MARCA — e marca não se traduz', () => {
    expect(trayTooltip(0, 'pt-BR')).toBe('Bridge');
    expect(trayTooltip(0, 'en')).toBe('Bridge');
  });

  it('com não lidas, a contagem sai no idioma em vigor', () => {
    expect(trayTooltip(3, 'pt-BR')).toBe('Bridge · 3 não lidas');
    expect(trayTooltip(3, 'en')).toBe('Bridge · 3 unread');
  });
});

describe('o toast represado, nos dois idiomas', () => {
  /** Uma líder + duas represadas: o `flush` devolve o resumo. */
  function resumo(lang: 'pt-BR' | 'en'): string | undefined {
    const notify = (queue: ReturnType<typeof emptyToastQueue>, text: string, now: number) =>
      coalesce(queue, { type: 'notify', sessionId: 'ses-1', workspaceId: 'ws-1', kind: 'custom', title: 'Bridge · ws', text }, now, lang);
    let { queue } = notify(emptyToastQueue(), 'primeira', 0);
    ({ queue } = notify(queue, 'segunda', 10));
    ({ queue } = notify(queue, 'terceira', 20));
    return coalesce(queue, { type: 'flush', sessionId: 'ses-1' }, 2000, lang).show?.body;
  }

  it('o resumo é copy do shell; o texto da última notificação é de fora e sai igual', () => {
    expect(resumo('pt-BR')).toBe('2 avisos · último: terceira');
    expect(resumo('en')).toBe('2 notices · last: terceira');
  });
});

describe('a resolução do idioma, antes e depois do core', () => {
  it('fase 1 — a locale do Electron decide enquanto o core não respondeu', () => {
    expect(bootLanguage('pt-BR')).toBe('pt-BR');
    expect(bootLanguage('pt')).toBe('pt-BR');
    expect(bootLanguage('en-US')).toBe('en');
    expect(bootLanguage('de-DE')).toBe('en');
    // Ambiente sem ICU: a mesma regra do `systemLanguage` do `@bridge/shared`.
    expect(bootLanguage(undefined)).toBe('en');
    expect(bootLanguage('')).toBe('en');
  });

  it('fase 2 — o `languageResolved` do core ganha da locale do boot', () => {
    setShellLanguage(bootLanguage('en-US'));
    expect(shellLanguage()).toBe('en');
    setShellLanguage(languageFromConfig({ languageResolved: 'pt-BR' } as Partial<BridgeConfig>) ?? 'en');
    expect(shellLanguage()).toBe('pt-BR');
    expect(tShell('shell.bandeja.sair')).toBe('Sair');
  });

  /**
   * Core de versão anterior ao lote de idioma (ou um JSON que não é a config):
   * o main FICA com o que tinha. Cair pra inglês em cima de quem já estava
   * lendo português seria pior do que não saber a resposta.
   */
  it('config sem o campo não derruba o idioma que já valia', () => {
    setShellLanguage('pt-BR');
    expect(languageFromConfig(undefined)).toBeUndefined();
    expect(languageFromConfig({} as Partial<BridgeConfig>)).toBeUndefined();
    expect(languageFromConfig({ languageResolved: 'klingon' } as unknown as Partial<BridgeConfig>)).toBeUndefined();
    expect(shellLanguage()).toBe('pt-BR');
  });

  it('`readCoreLanguage` lê o `GET /api/config` com o token, e devolve o idioma', async () => {
    const chamadas: string[] = [];
    const fake: FetchLike = async (url, init) => {
      chamadas.push(`${url} ${init?.headers?.authorization ?? ''}`);
      return { ok: true, json: async () => ({ languageResolved: 'pt-BR' }) };
    };
    expect(await readCoreLanguage(4560, 'tok', fake)).toBe('pt-BR');
    expect(chamadas).toEqual(['http://127.0.0.1:4560/api/config Bearer tok']);
  });

  /**
   * O mesmo `GET`, agora com TETO DE ESPERA. Sem ele, um core que aceita a
   * conexão e não responde (porta reciclada, processo travado) deixava a
   * promessa — e com ela a terceira fase do idioma — pendurada pra sempre.
   */
  it('`readCoreLanguage` manda um `signal` com prazo', async () => {
    let visto: AbortSignal | undefined;
    const fake: FetchLike = async (_url, init) => {
      visto = init?.signal;
      return { ok: true, json: async () => ({ languageResolved: 'en' }) };
    };
    await readCoreLanguage(4560, 'tok', fake);
    expect(visto).toBeInstanceOf(AbortSignal);
    expect(visto?.aborted).toBe(false);
    expect(CONFIG_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONFIG_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  /**
   * Estourado o prazo, o `fetch` REJEITA — e uma rejeição aqui é só mais um
   * `undefined`, pelo mesmo `catch` da conexão recusada (o caso abaixo).
   */
  it('o estouro do prazo não derruba a subida', async () => {
    const estourou: FetchLike = async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    };
    expect(await readCoreLanguage(4560, 'tok', estourou)).toBeUndefined();
  });

  /**
   * O idioma é o último motivo aceitável pra derrubar a subida do app: um core
   * que ainda não respondeu, um 401 ou uma porta trocada no meio de um restart
   * devolvem `undefined` e o main segue com a locale do boot.
   */
  it('`readCoreLanguage` nunca lança — nem no 401, nem na conexão recusada', async () => {
    const recusa: FetchLike = async () => ({ ok: false, json: async () => ({}) });
    expect(await readCoreLanguage(4560, 'tok', recusa)).toBeUndefined();
    const explode: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await readCoreLanguage(4560, 'tok', explode)).toBeUndefined();
  });
});

describe('a retradução no `config.changed`', () => {
  /**
   * `setShellLanguage` devolve `true` só quando o idioma MUDOU de verdade — é
   * esse booleano que o `main.ts` usa pra decidir se remonta o menu da
   * bandeja. Sem ele, todo `config.changed` (troca de fonte do terminal, de
   * teto do escalonador, do arquivo de preços) reconstruiria o menu à toa.
   */
  it('só reporta mudança quando o idioma realmente mudou', () => {
    setShellLanguage('pt-BR');
    expect(setShellLanguage('pt-BR')).toBe(false);
    expect(setShellLanguage('en')).toBe(true);
    expect(setShellLanguage('en')).toBe(false);
  });

  it('depois da troca, o menu remontado sai no idioma novo', () => {
    setShellLanguage('pt-BR');
    expect(trayMenuItems(shellLanguage()).map((i) => i.label)).toEqual(['Mostrar', 'Sair']);
    setShellLanguage(languageFromConfig({ languageResolved: 'en' } as Partial<BridgeConfig>) ?? 'pt-BR');
    expect(trayMenuItems(shellLanguage()).map((i) => i.label)).toEqual(['Show', 'Quit']);
    expect(trayTooltip(2, shellLanguage())).toBe('Bridge · 2 unread');
  });
});

describe('os diálogos de erro do boot', () => {
  /**
   * As três frases do `dialog.showErrorBox` viajam do `sidecar.ts` como CHAVE
   * (`CoreExit.fatal`, `CoreStartError.key`): aquele módulo não fala com o core
   * e não importa `electron`, então ele não tem idioma. Quem traduz é o
   * `main.ts`, no instante de mostrar.
   */
  it('existem nos dois catálogos e apontam pro log do shell', () => {
    for (const chave of ['shell.fatal.coreNaoSubiu', 'shell.fatal.coreEncerrou'] as const) {
      expect(t('pt-BR', chave)).toContain('logs/shell.log');
      expect(t('en', chave)).toContain('logs/shell.log');
    }
    expect(t('pt-BR', 'shell.fatal.semNode')).toContain('Node.js 22+');
    expect(t('en', 'shell.fatal.semNode')).toContain('Node.js 22+');
  });

  it('o erro inesperado carrega o motivo cru e manda pro log', () => {
    setShellLanguage('pt-BR');
    expect(tShell('shell.fatal.inesperado', { detalhe: 'boom' })).toBe('Erro inesperado: boom\nVeja logs/shell.log');
    setShellLanguage('en');
    expect(tShell('shell.fatal.inesperado', { detalhe: 'boom' })).toBe('Unexpected error: boom\nSee logs/shell.log');
  });
});
