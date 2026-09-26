import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_KINDS,
  environmentBadge,
  environmentId,
  environmentLabel,
  environmentMissingLabel,
  environmentMissingTitle,
  environmentNoClaudeLabel,
  environmentNoClaudeTitle,
  environmentStatus,
  isValidDistro,
  parseEnvironmentId,
} from '../src/environment.js';
import type { EnvironmentInfo } from '../src/environment.js';

/** Dor verificada #2 — a FORMA que core, UI e CLI compartilham. */

describe('environmentId / parseEnvironmentId', () => {
  it('ida e volta pros quatro tipos', () => {
    expect(environmentId({ kind: 'pwsh' })).toBe('pwsh');
    expect(environmentId({ kind: 'gitbash' })).toBe('gitbash');
    expect(environmentId({ kind: 'wsl', distro: 'Ubuntu-22.04' })).toBe('wsl:Ubuntu-22.04');
    expect(parseEnvironmentId('wsl:Ubuntu-22.04')).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04' });
    expect(parseEnvironmentId('powershell')).toEqual({ kind: 'powershell' });
  });

  it('aceita distro com espaço e ignora espaço em volta', () => {
    expect(parseEnvironmentId('  wsl:Minha Distro  ')).toEqual({ kind: 'wsl', distro: 'Minha Distro' });
  });

  it('recusa o que não é ambiente', () => {
    for (const bad of ['', '   ', 'bash', 'wsl', 'wsl:', 'pwsh:Ubuntu', 'wsl:-injetado', 'zsh:x']) {
      expect(parseEnvironmentId(bad), bad).toBeUndefined();
    }
  });

  it('o schema da API (literal) e a lista ENVIRONMENT_KINDS não podem divergir', () => {
    expect([...ENVIRONMENT_KINDS]).toEqual(['pwsh', 'powershell', 'gitbash', 'wsl']);
  });
});

describe('isValidDistro', () => {
  it('nome começando com `-` é recusado — é injeção de argumento no parser do wsl.exe', () => {
    expect(isValidDistro('-d')).toBe(false);
    expect(isValidDistro('--exec')).toBe(false);
    expect(isValidDistro(' Ubuntu')).toBe(false);
  });

  it('nomes reais passam', () => {
    for (const name of ['Ubuntu', 'Ubuntu-22.04', 'docker-desktop', 'openSUSE-Leap-15.5', 'Debian_teste']) {
      expect(isValidDistro(name), name).toBe(true);
    }
  });

  // "`wsl` exige distro; os outros a proíbem" é do `parseEnvironmentId` — a
  // única porta de entrada de ambiente vindo de texto (CLI, `<select>`, API).
  // O predicado `isValidEnvironment` que dizia a mesma coisa saiu na 0.11.0:
  // ninguém o chamava fora do próprio teste.
  it('`wsl` sem distro e não-wsl com distro não passam pelo parser', () => {
    expect(parseEnvironmentId('wsl')).toBeUndefined();
    expect(parseEnvironmentId('pwsh:Ubuntu')).toBeUndefined();
    expect(parseEnvironmentId('wsl:Ubuntu')).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });
});

describe('environmentLabel', () => {
  it('rótulos em pt-BR, com a distro no nome do WSL', () => {
    expect(environmentLabel({ kind: 'pwsh' }, 'pt-BR')).toBe('PowerShell 7 (pwsh)');
    expect(environmentLabel({ kind: 'powershell' }, 'pt-BR')).toBe('Windows PowerShell');
    expect(environmentLabel({ kind: 'gitbash' }, 'pt-BR')).toBe('Git Bash');
    expect(environmentLabel({ kind: 'wsl', distro: 'Ubuntu' }, 'pt-BR')).toBe('WSL · Ubuntu');
  });

  /**
   * Nome de produto não se traduz (spec §13): `Git Bash` é `Git Bash` em
   * inglês. O idioma entra assim mesmo porque o rótulo passa pelo catálogo —
   * é lá que um idioma futuro escreveria outra coisa se precisasse.
   */
  it('em inglês, os mesmos nomes próprios', () => {
    expect(environmentLabel({ kind: 'pwsh' }, 'en')).toBe('PowerShell 7 (pwsh)');
    expect(environmentLabel({ kind: 'wsl', distro: 'Ubuntu' }, 'en')).toBe('WSL · Ubuntu');
  });
});

/**
 * Os dois avisos da linha do workspace (dor verificada #2). Eram constantes
 * de módulo até a 0.12.2; viraram FUNÇÃO na 0.13.0 porque uma constante não
 * tem como perguntar em que idioma a janela está.
 */
describe('avisos de ambiente', () => {
  it('sem claude, nos dois idiomas', () => {
    expect(environmentNoClaudeLabel('pt-BR')).toBe('⚠ sem claude');
    expect(environmentNoClaudeLabel('en')).toBe('⚠ no claude');
    expect(environmentNoClaudeTitle('pt-BR')).toContain('claude não encontrado');
    expect(environmentNoClaudeTitle('en')).toContain('claude was not found');
  });

  it('ambiente sumiu, nos dois idiomas', () => {
    expect(environmentMissingLabel('pt-BR')).toBe('⚠ ambiente sumiu');
    expect(environmentMissingLabel('en')).toBe('⚠ environment gone');
    expect(environmentMissingTitle('pt-BR')).toContain('não responde');
    expect(environmentMissingTitle('en')).toContain('does not respond');
  });

  /** O menu que o texto manda procurar é o mesmo dos dois lados. */
  it('os dois títulos apontam pro menu "⋯" do workspace', () => {
    for (const texto of [
      environmentNoClaudeTitle('pt-BR'),
      environmentNoClaudeTitle('en'),
      environmentMissingTitle('pt-BR'),
      environmentMissingTitle('en'),
    ]) {
      expect(texto).toContain('⋯');
    }
  });
});

describe('environmentStatus — o aviso da linha do workspace', () => {
  const list: EnvironmentInfo[] = [
    // `interop` é sempre `true` fora do WSL (não há fronteira a cruzar) e
    // acompanha a distro dentro dele: a que nem respondeu (`Parada`) também
    // não tem interop pra oferecer.
    { id: 'gitbash', kind: 'gitbash', label: 'Git Bash', available: true, claude: true, node: true, interop: true },
    {
      id: 'wsl:Ubuntu',
      kind: 'wsl',
      distro: 'Ubuntu',
      label: 'WSL · Ubuntu',
      available: true,
      claude: true,
      node: true,
      interop: true,
    },
    {
      id: 'wsl:Alpine',
      kind: 'wsl',
      distro: 'Alpine',
      label: 'WSL · Alpine',
      available: true,
      claude: false,
      node: true,
      interop: true,
    },
    {
      id: 'wsl:Parada',
      kind: 'wsl',
      distro: 'Parada',
      label: 'WSL · Parada',
      available: false,
      claude: false,
      node: false,
      interop: false,
    },
  ];

  it('workspace sem ambiente não mostra nada', () => {
    expect(environmentStatus(undefined, list)).toBe('unknown');
    expect(environmentBadge(undefined)).toBeUndefined();
  });

  it('lista ainda não carregada não inventa aviso', () => {
    expect(environmentStatus({ kind: 'wsl', distro: 'Ubuntu' }, undefined)).toBe('unknown');
    expect(environmentStatus({ kind: 'wsl', distro: 'Ubuntu' }, [])).toBe('unknown');
  });

  it('ambiente detectado e com claude → ok', () => {
    expect(environmentStatus({ kind: 'wsl', distro: 'Ubuntu' }, list)).toBe('ok');
    expect(environmentStatus({ kind: 'gitbash' }, list)).toBe('ok');
  });

  it('distro sem claude → no-claude; distro que não responde ou sumiu → missing', () => {
    expect(environmentStatus({ kind: 'wsl', distro: 'Alpine' }, list)).toBe('no-claude');
    expect(environmentStatus({ kind: 'wsl', distro: 'Parada' }, list)).toBe('missing');
    expect(environmentStatus({ kind: 'wsl', distro: 'Removida' }, list)).toBe('missing');
  });

  it('o selo é o id textual', () => {
    expect(environmentBadge({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu');
    expect(environmentBadge({ kind: 'gitbash' })).toBe('gitbash');
  });
});
