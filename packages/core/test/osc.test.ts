import { describe, expect, it } from 'vitest';
import { OscScanner } from '../src/osc.js';

describe('OscScanner', () => {
  it('OSC 9 com BEL', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]9;oi\x07');
    expect(result).toEqual([{ body: 'oi' }]);
  });

  it('OSC 9 com ST', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]9;oi\x1b\\');
    expect(result).toEqual([{ body: 'oi' }]);
  });

  it('OSC 777 com título e corpo', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]777;notify;T;B\x07');
    expect(result).toEqual([{ title: 'T', body: 'B' }]);
  });

  it('OSC 99 kitty com p=body', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]99;i=1:p=body;texto\x07');
    expect(result).toEqual([{ body: 'texto' }]);
  });

  it('OSC 99 kitty sem p= é corpo', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]99;i=1;texto\x07');
    expect(result).toEqual([{ body: 'texto' }]);
  });

  it('OSC 99 kitty com p=title é ignorado', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]99;i=1:p=title;titulo\x07');
    expect(result).toEqual([]);
  });

  it('sequência partida em dois chunks', () => {
    const scanner = new OscScanner();
    expect(scanner.push('\x1b]9;me')).toEqual([]);
    expect(scanner.push('io\x07')).toEqual([{ body: 'meio' }]);
  });

  it('texto sem OSC devolve []', () => {
    const scanner = new OscScanner();
    expect(scanner.push('hello world\r\n')).toEqual([]);
  });

  it('OSC de outro tipo devolve []', () => {
    const scanner = new OscScanner();
    expect(scanner.push('\x1b]0;title\x07')).toEqual([]);
  });

  it('lixo de 5 KB sem terminador devolve [] e zera o buffer', () => {
    const scanner = new OscScanner();
    const junk = '\x1b]9;' + 'x'.repeat(5 * 1024);
    expect(scanner.push(junk)).toEqual([]);
    // depois de zerado, uma sequência nova ainda deve funcionar
    expect(scanner.push('\x1b]9;oi\x07')).toEqual([{ body: 'oi' }]);
  });

  it('múltiplas notificações no mesmo chunk', () => {
    const scanner = new OscScanner();
    const result = scanner.push('\x1b]9;um\x07texto no meio\x1b]9;dois\x07');
    expect(result).toEqual([{ body: 'um' }, { body: 'dois' }]);
  });
});
