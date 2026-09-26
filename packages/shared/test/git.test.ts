import { describe, expect, it } from 'vitest';
import { TASK_NAME_MAX, diffCommand, isSafeRef, normalizeTaskName } from '../src/index.js';

/**
 * A cobertura completa das regras está em `packages/core/test/git.test.ts`
 * (que importa esta mesma função pelo `@bridge/shared`). O que este teste
 * garante é o contrato do PACOTE: `normalizeTaskName` sai pelo índice, porque
 * é dali que a UI vai importar pra mostrar o branch antes de submeter a tarefa
 * — e uma cópia divergente no cliente é justamente o que ela existe pra evitar.
 */
describe('normalizeTaskName exportada pelo índice do shared', () => {
  it('normaliza igual dos dois lados', () => {
    expect(normalizeTaskName('Feat Mailbox!')).toBe('feat-mailbox');
    expect(normalizeTaskName('Corrige o Login')).toBe('corrige-o-login');
    expect(normalizeTaskName('a'.repeat(80))).toHaveLength(TASK_NAME_MAX);
    expect(() => normalizeTaskName('###')).toThrow(/inválido/);
  });
});

/**
 * Onda de correção final, item 13: um nome pode sobreviver à normalização e
 * ainda assim ser inválido como PASTA no Windows. `..` no meio sai de
 * `a../b` → `a..b` e viraria travessia de diretório em qualquer caminho
 * montado com ele; `con`, `nul`, `com1`… são nomes de DISPOSITIVO — criar uma
 * pasta com esse nome falha (ou pior, escreve no dispositivo).
 */
describe('normalizeTaskName recusa nome perigoso no Windows', () => {
  it('recusa `..` no meio do nome', () => {
    expect(() => normalizeTaskName('a../b')).toThrow(/inválido/);
    expect(() => normalizeTaskName('feat..mailbox')).toThrow(/inválido/);
    // Um ponto sozinho continua valendo: `v1.2.3` é nome legítimo de branch.
    expect(normalizeTaskName('v1.2.3')).toBe('v1.2.3');
  });

  it('recusa os nomes reservados do Windows, com ou sem extensão', () => {
    for (const reserved of ['con', 'PRN', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'lpt9']) {
      expect(() => normalizeTaskName(reserved), reserved).toThrow(/inválido/);
    }
    expect(() => normalizeTaskName('con.txt')).toThrow(/inválido/);
    // Prefixo só não basta: `console` é nome normal.
    expect(normalizeTaskName('console')).toBe('console');
    expect(normalizeTaskName('com10')).toBe('com10');
  });
});

describe('diffCommand exportada pelo índice do shared', () => {
  it('monta a linha que o painel do "Ver diff" recebe digitada', () => {
    expect(diffCommand('main')).toBe("git --no-pager diff 'main...HEAD'");
    expect(diffCommand('feature/x-1.2')).toBe("git --no-pager diff 'feature/x-1.2...HEAD'");
  });
});

/**
 * BR-04 (onda de segurança): a linha do "Ver diff" é escrita CRUA num pwsh. O
 * git aceita `;`, `&`, `|`, `$`, crase e aspas em nome de branch — provado na
 * auditoria com `git checkout -b 'main;whoami'` e `git branch 'a$(calc)b'`. Um
 * repositório hostil cuja branch principal tenha esse nome transformava o botão
 * "Ver diff" em execução de comando na máquina do dono.
 */
describe('isSafeRef / diffCommand recusam nome de branch que vira comando', () => {
  it.each([
    ['main;whoami', 'ponto e vírgula'],
    ['a$(calc)b', 'substituição de comando'],
    ['main&calc', 'e comercial'],
    ['main|calc', 'cano'],
    ['main`calc`', 'crase'],
    ["main';calc;'", 'aspa simples'],
    ['--upload-pack=calc.exe', 'começa com hífen'],
    ['../fora', 'travessia'],
    ['main..HEAD', '`..` no meio'],
    ['a'.repeat(300), 'acima do teto'],
    ['', 'vazio'],
    ['main\ncalc', 'quebra de linha'],
  ])('%s é recusado (%s)', (ref) => {
    expect(isSafeRef(ref)).toBe(false);
    expect(() => diffCommand(ref)).toThrow(/inválida/);
  });

  it.each(['main', 'master', 'develop', 'feature/login', 'release-1.2.3', 'v1.0', 'user_x/fix'])(
    '%s continua aceito',
    (ref) => {
      expect(isSafeRef(ref)).toBe(true);
      expect(diffCommand(ref)).toContain(ref);
    },
  );
});
