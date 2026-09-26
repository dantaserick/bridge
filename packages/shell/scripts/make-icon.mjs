#!/usr/bin/env node
/**
 * Gera `build/icon.ico` (16, 24, 32, 48, 64, 128, 256 px, PNG-in-ICO) e
 * `build/icon.png` (256×256) a partir do `BridgeMark` — a mesma marca do
 * tray (`src/tray.ts`) e do favicon da UI (`packages/ui/index.html`).
 *
 * Sem dependência nova, sem canvas e sem abrir uma janela do Electron: a
 * rasterização é distância-a-segmento pura (`src/iconMark.ts`) e o PNG sai de
 * `zlib.deflateSync` (`src/png.ts`) — determinístico, então o script é
 * idempotente (roda de novo e escreve os mesmos bytes).
 *
 * Precisa do bundle compilado:
 *
 *   npm run build -w @bridge/shell
 *   node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    [
      'Uso: node scripts/make-icon.mjs',
      '',
      'Gera packages/shell/build/icon.ico (PNG-in-ICO, 16/24/32/48/64/128/256 px)',
      'e packages/shell/build/icon.png (256×256) a partir do BridgeMark.',
      '',
      'Idempotente: a rasterização é determinística, então rodar de novo produz',
      'exatamente os mesmos bytes.',
      '',
      'Requer "npm run build -w @bridge/shell" antes — lê o bundle compilado em',
      'dist/makeIco.mjs.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const distUrl = pathToFileURL(join(here, '..', 'dist', 'makeIco.mjs')).href;
let mod;
try {
  mod = await import(distUrl);
} catch (err) {
  process.stderr.write(
    `não consegui importar dist/makeIco.mjs — rode "npm run build -w @bridge/shell" antes.\n${String(err)}\n`,
  );
  process.exit(1);
}
const { ICON_SIZES, generateIconPngs, buildIco, validateIco } = mod;

const buildDir = join(here, '..', 'build');
mkdirSync(buildDir, { recursive: true });

const pngs = generateIconPngs(ICON_SIZES);
const ico = buildIco(pngs);
validateIco(ico); // confere que cada entrada bate com o PNG dela antes de gravar

const largest = pngs.reduce((best, entry) => (entry.size > best.size ? entry : best), pngs[0]);

const icoPath = join(buildDir, 'icon.ico');
const pngPath = join(buildDir, 'icon.png');
writeFileSync(icoPath, ico);
writeFileSync(pngPath, largest.png);

process.stdout.write(
  `${icoPath}: ${ico.length} bytes, ${pngs.length} entradas (${pngs.map((p) => p.size).join(', ')})\n`,
);
process.stdout.write(`${pngPath}: ${largest.png.length} bytes (${largest.size}×${largest.size})\n`);
