/**
 * Testes de ataque da onda de segurança no lado do shell (BR-13, BR-16, BR-17).
 *
 * Tudo aqui é função pura ou leitura de arquivo do repo: o comportamento real
 * só existe com Electron rodando.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOpenablePath, menuPolicy } from '../src/windowPolicy.js';
import { escapeForPowerShellSingleQuoted } from '../src/installerPath.js';

const shellDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `lstat` de mentira: descreve o que o disco devolveria, sem criar junction. */
function fs(kind: 'dir' | 'file' | 'link' | 'missing') {
  return {
    lstat(): { isDirectory(): boolean; isSymbolicLink(): boolean } {
      if (kind === 'missing') throw new Error('ENOENT');
      return {
        isDirectory: () => kind === 'dir' || kind === 'link',
        // Junction e symlink do Windows são os dois reparse point que o
        // `lstatSync` marca como link.
        isSymbolicLink: () => kind === 'link',
      };
    },
  };
}

describe('BR-16 — openPath não segue junction/symlink', () => {
  it('junction/symlink apontando pra fora é recusada mesmo parecendo pasta', () => {
    expect(isOpenablePath('C:\\projetos\\repo\\docs', fs('link'))).toBe(false);
  });

  it('arquivo e caminho inexistente continuam recusados (era a regra do R12)', () => {
    expect(isOpenablePath('C:\\projetos\\repo\\script.cmd', fs('file'))).toBe(false);
    expect(isOpenablePath('C:\\projetos\\nao\\existe', fs('missing'))).toBe(false);
    expect(isOpenablePath('', fs('dir'))).toBe(false);
    expect(isOpenablePath(42, fs('dir'))).toBe(false);
    expect(isOpenablePath(null, fs('dir'))).toBe(false);
  });

  it('CONTROLE: pasta real continua abrindo', () => {
    expect(isOpenablePath('C:\\projetos\\repo', fs('dir'))).toBe(true);
  });
});

describe('BR-13 — $INSTDIR interpolado em string do PowerShell', () => {
  it('a aspa simples é dobrada (o escape do PowerShell)', () => {
    expect(escapeForPowerShellSingleQuoted("C:\\Programas\\O'Brien\\Bridge")).toBe("C:\\Programas\\O''Brien\\Bridge");
    expect(escapeForPowerShellSingleQuoted("C:\\x'; calc; '")).toBe("C:\\x''; calc; ''");
    expect(escapeForPowerShellSingleQuoted('C:\\Program Files\\Bridge')).toBe('C:\\Program Files\\Bridge');
  });

  it('o installer.nsh aplica a mesma regra e não interpola $INSTDIR na linha do PowerShell', () => {
    const nsh = readFileSync(join(shellDir, 'installer.nsh'), 'utf8');

    // A troca acontece nas DUAS macros (instalação e desinstalação).
    const escapes = nsh.split('${WordReplace} "$INSTDIR" "\'" "\'\'" "+" $R0').length - 1;
    expect(escapes).toBe(2);
    expect(nsh).toContain('!include "WordFunc.nsh"');
    expect(nsh).toContain('!insertmacro WordReplace');

    // E nenhuma linha executada ainda mete `$INSTDIR` cru dentro da string.
    const linhasPowerShell = nsh.split('\n').filter((l) => l.includes('nsExec::ExecToLog'));
    expect(linhasPowerShell.length).toBeGreaterThan(0);
    for (const linha of linhasPowerShell) {
      expect(linha).not.toContain("'$INSTDIR");
    }
  });
});

describe('BR-17 — sandbox global do Electron', () => {
  it('o main chama app.enableSandbox() antes do whenReady', () => {
    const src = readFileSync(join(shellDir, 'src', 'main.ts'), 'utf8');
    const sandbox = src.indexOf('app.enableSandbox()');
    const ready = src.indexOf('app.whenReady()');
    expect(sandbox).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(sandbox).toBeLessThan(ready);
  });
});

describe('menuPolicy', () => {
  it('não instala menu nenhum — nem em dev', () => {
    expect(menuPolicy(false).menu).toBeNull();
    expect(menuPolicy(true).menu).toBeNull();
  });

  it('libera o atalho de devtools só com BRIDGE_DEV=1', () => {
    expect(menuPolicy(false).devtoolsShortcut).toBe(false);
    expect(menuPolicy(true).devtoolsShortcut).toBe(true);
  });
});
