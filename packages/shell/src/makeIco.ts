/**
 * Monta um `.ico` no formato PNG-in-ICO (Windows Vista+): cabeçalho ICONDIR +
 * uma ICONDIRENTRY por imagem, payload = PNG bruto (sem BMP/DIB). Usado pelo
 * script `scripts/make-icon.mjs` (que só grava os arquivos) e testado direto
 * em `test/icon.test.ts`.
 */
import { renderMarkRgba } from './iconMark.js';
import { encodePng, readPngSize } from './png.js';

/** 16, 24, 32, 48, 64, 128, 256 — os tamanhos pedidos na spec. */
export const ICON_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256];

export interface IconPngEntry {
  size: number;
  png: Buffer;
}

/** Gera um PNG (fundo arredondado + `BridgeMark`) por tamanho pedido. */
export function generateIconPngs(sizes: readonly number[] = ICON_SIZES): IconPngEntry[] {
  return sizes.map((size) => ({ size, png: encodePng(size, size, renderMarkRgba(size)) }));
}

const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;

/** `.ico`: `width`/`height` de um byte só — 256 vira 0 por convenção. */
function iconByteDimension(size: number): number {
  return size >= 256 ? 0 : size;
}

/** Monta o `.ico` PNG-in-ICO a partir das entradas de `generateIconPngs`. */
export function buildIco(entries: readonly IconPngEntry[]): Buffer {
  // i18n-ignore: invariante de BUILD (roda no `scripts/`, nunca numa tela).
  if (entries.length === 0) throw new Error('buildIco precisa de pelo menos uma imagem');

  const header = Buffer.alloc(ICONDIR_SIZE);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ícone
  header.writeUInt16LE(entries.length, 4);

  const dirEntries: Buffer[] = [];
  const payloads: Buffer[] = [];
  let offset = ICONDIR_SIZE + entries.length * ICONDIRENTRY_SIZE;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(ICONDIRENTRY_SIZE);
    entry.writeUInt8(iconByteDimension(size), 0);
    entry.writeUInt8(iconByteDimension(size), 1);
    entry.writeUInt8(0, 2); // colorCount (0 = sem paleta)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bitCount (RGBA)
    entry.writeUInt32LE(png.length, 8); // bytesInRes
    entry.writeUInt32LE(offset, 12); // imageOffset
    dirEntries.push(entry);
    payloads.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...payloads]);
}

export interface ParsedIcoEntry {
  /** Dimensão declarada na `ICONDIRENTRY` (256 já normalizado, não 0). */
  width: number;
  height: number;
  bitCount: number;
  png: Buffer;
}

/** Lê um `.ico` PNG-in-ICO de volta — usado pelo teste pra validar bytes reais. */
export function parseIco(buf: Buffer): ParsedIcoEntry[] {
  if (buf.length < ICONDIR_SIZE || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    // i18n-ignore: invariante de parser binário, lida por quem gera o ícone —
    // nunca chega a uma tela.
    throw new Error('assinatura de .ico inválida (ICONDIR)'); // i18n-ignore
  }
  const count = buf.readUInt16LE(4);
  const entries: ParsedIcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = ICONDIR_SIZE + i * ICONDIRENTRY_SIZE;
    const widthByte = buf.readUInt8(base);
    const heightByte = buf.readUInt8(base + 1);
    const bitCount = buf.readUInt16LE(base + 6);
    const bytesInRes = buf.readUInt32LE(base + 8);
    const imageOffset = buf.readUInt32LE(base + 12);
    const png = buf.subarray(imageOffset, imageOffset + bytesInRes);
    entries.push({
      width: widthByte === 0 ? 256 : widthByte,
      height: heightByte === 0 ? 256 : heightByte,
      bitCount,
      png,
    });
  }
  return entries;
}

/** Confere que cada entrada aponta pra um PNG válido do tamanho declarado. */
export function validateIco(buf: Buffer): void {
  for (const entry of parseIco(buf)) {
    const { width, height } = readPngSize(entry.png);
    if (width !== entry.width || height !== entry.height) {
      // i18n-ignore: invariante de BUILD (roda no `scripts/`, nunca numa tela).
      throw new Error(
        `entrada ${entry.width}×${entry.height} do .ico tem PNG de tamanho diferente (${width}×${height})`,
      );
    }
  }
}
