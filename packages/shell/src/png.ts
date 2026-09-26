/**
 * Codificador/leitor de PNG mínimo, sem lib de imagem nenhuma — só
 * `zlib.deflateSync` (que já vem no Node) pro `IDAT`. Extraído de `tray.ts`
 * pra ser reusado também pelo ícone do app (`iconMark.ts` / `makeIco.ts`),
 * garantindo que os dois passem pelo mesmo codificador.
 */
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const entry = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = entry ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Codifica um PNG RGBA de 8 bits sem depender de nenhuma lib de imagem — só
 * `zlib.deflateSync` pro `IDAT`. `rgba` tem que ter exatamente `width*height*4`
 * bytes, um filtro "none" (0) por linha.
 */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filtro "none"
    rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

export interface PngSize {
  width: number;
  height: number;
}

/** Confere a assinatura e lê `width`/`height` do `IHDR` (sempre o 1º chunk). */
export function readPngSize(png: Buffer): PngSize {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // i18n-ignore: invariante de parser binário (ver `makeIco.ts`).
    throw new Error('assinatura PNG inválida'); // i18n-ignore
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function isPngSignature(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}
