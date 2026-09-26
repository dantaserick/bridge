import { describe, expect, it } from 'vitest';
import { IPC } from '../src/ipc.js';
import { isFromUi, resolveUiOrigin, resolveUiUrl } from '../src/resolveUi.js';

describe('isFromUi', () => {
  const origin = resolveUiOrigin({ dev: false, port: 5266 });

  it('aceita o frame da própria UI, com ou sem caminho', () => {
    expect(isFromUi('http://127.0.0.1:5266/', origin)).toBe(true);
    expect(isFromUi('http://127.0.0.1:5266/index.html?x=1#y', origin)).toBe(true);
    expect(isFromUi(resolveUiUrl({ dev: false, port: 5266 }), origin)).toBe(true);
  });

  it('recusa uma porta que só COMEÇA igual — o bug do startsWith', () => {
    expect(isFromUi('http://127.0.0.1:52660/', origin)).toBe(false);
    expect(isFromUi('http://127.0.0.1:52661/pagina.html', origin)).toBe(false);
    // E o inverso: origem esperada longa, frame curto.
    expect(isFromUi('http://127.0.0.1:5266/', resolveUiOrigin({ dev: false, port: 52660 }))).toBe(false);
  });

  it('recusa host, esquema e origens forjadas', () => {
    expect(isFromUi('http://127.0.0.1.evil.com:5266/', origin)).toBe(false);
    expect(isFromUi('https://127.0.0.1:5266/', origin)).toBe(false);
    expect(isFromUi('http://localhost:5266/', origin)).toBe(false);
    expect(isFromUi('file:///C:/evil.html', origin)).toBe(false);
    expect(isFromUi('http://evil.com/#http://127.0.0.1:5266/', origin)).toBe(false);
  });

  it('recusa frame ausente, URL inválida e origem esperada vazia', () => {
    expect(isFromUi(undefined, origin)).toBe(false);
    expect(isFromUi(null, origin)).toBe(false);
    expect(isFromUi('', origin)).toBe(false);
    expect(isFromUi('não é uma url', origin)).toBe(false);
    // Antes do core subir não existe origem: nada pode ser aceito.
    expect(isFromUi('http://127.0.0.1:5266/', '')).toBe(false);
  });

  it('em dev, só a origem do Vite passa', () => {
    const devOrigin = resolveUiOrigin({ dev: true, port: 4560 });
    expect(isFromUi('http://127.0.0.1:5173/', devOrigin)).toBe(true);
    expect(isFromUi('http://127.0.0.1:4560/', devOrigin)).toBe(false);
  });
});

/**
 * A tabela de canais é a fonte ÚNICA dos dois lados da ponte (preload e main).
 * Um canal renomeado de um lado só some do outro em tempo de execução — este
 * teste é o que transforma isso em falha de suíte.
 */
describe('IPC — canais', () => {
  it('nenhum nome de canal se repete', () => {
    const nomes = Object.values(IPC);
    expect(new Set(nomes).size).toBe(nomes.length);
  });
});
