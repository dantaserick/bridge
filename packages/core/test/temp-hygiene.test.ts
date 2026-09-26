/**
 * Higiene de temporários (Task 3): as duas varreduras do `globalSetup`/
 * `globalTeardown` rodam contra uma raiz FALSA, nunca contra o `%TEMP%` de
 * verdade — um teste que apaga pasta do sistema é o tipo de coisa que estraga a
 * máquina de quem roda a suíte.
 */
import { mkdirSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_MS, sweepRunTempDirs, sweepTempDirs } from './setup.js';
import { removeRegisteredTmpDirs, tmpDir } from './tmp.js';

afterEach(removeRegisteredTmpDirs);

/** Cria `nome` dentro da raiz falsa com o `mtime` pedido. */
function dirComIdade(root: string, nome: string, mtimeMs: number): string {
  const path = join(root, nome);
  mkdirSync(path, { recursive: true });
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

describe('sweepTempDirs — corte de 1 hora', () => {
  it('apaga a pasta velha com prefixo e preserva a recente e a de outro prefixo', () => {
    const root = tmpDir('bridge-hygiene-');
    const now = Date.now();
    const velha = dirComIdade(root, 'bridge-antiga', now - STALE_MS - 60_000);
    const velhaComEspaco = dirComIdade(root, 'bridge git antiga', now - STALE_MS - 60_000);
    const velhaT5 = dirComIdade(root, 't5-antiga', now - STALE_MS - 60_000);
    const recente = dirComIdade(root, 'bridge-recente', now - 1_000);
    const alheia = dirComIdade(root, 'vscode-algo', now - STALE_MS - 60_000);

    expect(sweepTempDirs(root, now)).toBe(3);

    expect(existsSync(velha)).toBe(false);
    expect(existsSync(velhaComEspaco)).toBe(false);
    expect(existsSync(velhaT5)).toBe(false);
    expect(existsSync(recente)).toBe(true);
    expect(existsSync(alheia)).toBe(true);
  });

  it('raiz inexistente não lança', () => {
    expect(sweepTempDirs(join(tmpDir('bridge-hygiene-'), 'nao-existe'))).toBe(0);
  });
});

describe('sweepRunTempDirs — o que ESTA execução criou', () => {
  it('apaga só o que tem mtime posterior ao início da rodada', () => {
    const root = tmpDir('bridge-hygiene-');
    const inicio = Date.now();
    const daRodada = dirComIdade(root, 'bridge-desta-rodada', inicio + 5_000);
    const daRodadaE2e = dirComIdade(root, 'bridge-e2e-desta-rodada', inicio + 5_000);
    const anterior = dirComIdade(root, 'bridge-de-antes', inicio - 5_000);
    const alheia = dirComIdade(root, 'outra-coisa', inicio + 5_000);

    expect(sweepRunTempDirs(inicio, root)).toBe(2);

    expect(existsSync(daRodada)).toBe(false);
    expect(existsSync(daRodadaE2e)).toBe(false);
    expect(existsSync(anterior)).toBe(true);
    expect(existsSync(alheia)).toBe(true);
  });

  it('não confunde arquivo com pasta', () => {
    const root = tmpDir('bridge-hygiene-');
    const inicio = Date.now() - 1_000;
    const arquivo = join(root, 'bridge-arquivo');
    writeFileSync(arquivo, 'nao sou pasta\n', 'utf8');

    expect(sweepRunTempDirs(inicio, root)).toBe(0);
    expect(existsSync(arquivo)).toBe(true);
  });
});
