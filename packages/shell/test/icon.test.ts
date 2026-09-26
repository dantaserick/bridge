import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_SIZES, buildIco, generateIconPngs, parseIco, validateIco } from '../src/makeIco.js';
import { readPngSize } from '../src/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const icoPath = join(here, '..', 'build', 'icon.ico');

describe('generateIconPngs + buildIco (puro, sem depender do arquivo gerado)', () => {
  it('gera um PNG por tamanho pedido, cada um com a assinatura e as dimensões certas', () => {
    const pngs = generateIconPngs([16, 32, 256]);
    expect(pngs.map((p) => p.size)).toEqual([16, 32, 256]);
    for (const { size, png } of pngs) {
      expect(readPngSize(png)).toEqual({ width: size, height: size });
    }
  });

  it('monta um .ico cuja assinatura ICONDIR e contagem de entradas batem', () => {
    const pngs = generateIconPngs([16, 32, 48]);
    const ico = buildIco(pngs);

    // ICONDIR: reserved=0, type=1 (ícone), count=N
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);

    const entries = parseIco(ico);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.width)).toEqual([16, 32, 48]);
    expect(entries.map((e) => e.height)).toEqual([16, 32, 48]);
  });

  it('normaliza 256 pro byte 0 na ICONDIRENTRY (convenção do formato .ico)', () => {
    const ico = buildIco(generateIconPngs([256]));
    const base = 6; // fim do ICONDIR
    expect(ico.readUInt8(base)).toBe(0); // largura declarada como byte: 256 -> 0
    expect(ico.readUInt8(base + 1)).toBe(0);
    // parseIco já devolve 256 de volta (não 0)
    expect(parseIco(ico)[0]?.width).toBe(256);
  });

  it('cada entrada aponta pra um PNG válido cujo IHDR bate com o tamanho declarado', () => {
    const ico = buildIco(generateIconPngs(ICON_SIZES));
    expect(() => validateIco(ico)).not.toThrow();

    for (const entry of parseIco(ico)) {
      expect(entry.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(readPngSize(entry.png)).toEqual({ width: entry.width, height: entry.height });
      expect(entry.bitCount).toBe(32);
    }
  });

  it('detecta uma entrada adulterada (PNG com tamanho diferente do declarado)', () => {
    // Entrada que se declara "32" mas carrega o PNG de 16: o validador tem
    // que reclamar, em vez de aceitar um .ico com bytes inconsistentes.
    const png16 = generateIconPngs([16])[0];
    if (!png16) throw new Error('setup do teste: faltou o PNG de 16px');
    const badIco = buildIco([{ size: 32, png: png16.png }]);
    expect(() => validateIco(badIco)).toThrow(/tamanho diferente/);
  });
});

describe('build/icon.ico (arquivo gerado por scripts/make-icon.mjs)', () => {
  const has = existsSync(icoPath);

  it.runIf(has)('existe, tem a assinatura certa e uma entrada por tamanho da spec', () => {
    const ico = readFileSync(icoPath);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(ICON_SIZES.length);

    const entries = parseIco(ico);
    expect(entries.map((e) => e.width)).toEqual([...ICON_SIZES]);
    expect(() => validateIco(ico)).not.toThrow();
  });

  it.runIf(has)('bate byte a byte com o que generateIconPngs produz agora (determinístico)', () => {
    const ico = readFileSync(icoPath);
    const rebuilt = buildIco(generateIconPngs(ICON_SIZES));
    expect(ico.equals(rebuilt)).toBe(true);
  });

  if (!has) {
    it.skip('build/icon.ico ainda não foi gerado (rode scripts/make-icon.mjs)', () => {});
  }
});
