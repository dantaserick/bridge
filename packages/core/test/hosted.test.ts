/**
 * O wrapper `claude` de cada sessão de SHELL (0.12.0, spec §5 — "Claude Code
 * aberto DENTRO de um shell").
 *
 * O que se prova aqui é o CONTEÚDO exato dos três wrappers e o efeito no
 * `PATH`. Nada spawna: a prova de que o shell realmente resolve o wrapper está
 * registrada no report da task (pwsh e Git Bash de verdade, com o `env` deste
 * mesmo `shellLaunch`).
 *
 * Os caminhos das fixtures têm ESPAÇO e ACENTO de propósito — é o cenário real
 * de `C:\Meus Projetos` e o que quebra quem esquece as aspas.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDECODE_ENV,
  HOSTED_BIN_ENV,
  WSL_HOSTED_SHELL_COMMAND,
  hostedBinDir,
  hostedFiles,
  hostedTargetFrom,
  prependPath,
  resolveHostedTarget,
} from '../src/adapters/hosted.js';
import type { HostedTarget } from '../src/adapters/hosted.js';
import { buildClaudeSettings } from '../src/adapters/claude.js';
import { WSL_SHELL_COMMAND, baseEnv, shellLaunch } from '../src/adapters/shell.js';
import { shQuote } from '../src/environments.js';
import type { EnvContext } from '../src/environments.js';
import type { LaunchCtx } from '../src/adapters/types.js';
import { tmpDir } from './tmp.js';

const SESSION_DIR = 'C:\\Meus Projetos\\sessões\\sess_ab12';
const BIN_DIR = 'C:\\Meus Projetos\\sessões\\sess_ab12\\bin';
const SETTINGS = 'C:\\Meus Projetos\\sessões\\sess_ab12\\settings.json';

const target: HostedTarget = {
  cmd: 'C:\\Ferramentas\\npm ação\\claude.cmd',
  sh: 'C:\\Ferramentas\\npm ação\\claude',
};

function ctxWith(environment: EnvContext | undefined, hosted = true): LaunchCtx {
  return {
    sessionId: 'sess_ab12',
    cwd: 'C:\\Meus Projetos\\app',
    sessionDir: SESSION_DIR,
    port: 4560,
    token: 'tok123',
    shimPath: 'C:\\Bridge\\core\\bin\\bridge-hook.cjs',
    cols: 80,
    rows: 24,
    environment,
    hosted: hosted ? { target } : undefined,
  };
}

const wslEnv: EnvContext = {
  kind: 'wsl',
  distro: 'Ubuntu-22.04',
  cwdUnix: '/mnt/c/Meus Projetos/app',
  sessionDirUnix: '/mnt/c/Meus Projetos/sessões/sess_ab12',
  nodeCommand: '/mnt/c/Program Files/nodejs/node.exe',
};

/**
 * O ambiente dos spawns deste arquivo, montado à mão em vez de herdado.
 *
 * Um PTY do Bridge NUNCA tem `CLAUDECODE` (o `shell.ts` o tira — `STRIPPED_ENV`),
 * mas esta suíte pode estar rodando dentro de um Claude Code, e aí a variável
 * chegaria por herança e desligaria a injeção do wrapper: o teste do caminho
 * normal falharia por causa do ambiente de quem rodou a suíte, não do código.
 */
function envSemClaudecode(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k.toUpperCase() !== CLAUDECODE_ENV) env[k] = v;
  }
  return { ...env, ...extra };
}

describe('hostedBinDir', () => {
  it('é sempre `<sessionDir>/bin` — a pasta que entra na frente do PATH', () => {
    expect(hostedBinDir(SESSION_DIR)).toBe(BIN_DIR);
  });
});

describe('hostedFiles — Windows (pwsh, PowerShell, Git Bash)', () => {
  const files = hostedFiles(ctxWith({ kind: 'pwsh' }), target);

  it('grava o settings.json da sessão com o MESMO conteúdo das sessões de agente', () => {
    const settings = files.find((f) => f.path === SETTINGS);
    expect(settings).toBeDefined();
    expect(settings!.content).toBe(JSON.stringify(buildClaudeSettings(ctxWith({ kind: 'pwsh' })), null, 2));
    // O que faz a sessão virar hospedeira é o hook chegar: sem os hooks aqui,
    // o wrapper seria só um alias.
    expect(JSON.parse(settings!.content).hooks.SessionStart).toBeDefined();
  });

  /**
   * O .cmd é 100% ASCII de propósito, e isso NÃO é preciosismo: o cmd.exe lê
   * arquivo de lote na codepage OEM do console (437/850), não em UTF-8. Com o
   * caminho literal, um `sess ação` gravado em UTF-8 chegava ao claude como
   * `sess a├º├úo` — "Settings file not found" (medido na prova real da task).
   * Por isso o alvo vem do ambiente e o settings vem do `%~dp0`.
   */
  it('claude.cmd: CRLF, ASCII puro, alvo pelo ambiente e settings pelo `%~dp0`', () => {
    const cmd = files.find((f) => f.path === join(BIN_DIR, 'claude.cmd'));
    expect(cmd).toBeDefined();
    expect(cmd!.content).toBe(
      '@echo off\r\n' +
        'if defined CLAUDECODE "%BRIDGE_CLAUDE_BIN%" %*\r\n' +
        'if defined CLAUDECODE exit /b\r\n' +
        '"%BRIDGE_CLAUDE_BIN%" --settings "%~dp0..\\settings.json" %*\r\n',
    );
    expect(cmd!.content).toBe(
      '@echo off\r\n' +
        `if defined ${CLAUDECODE_ENV} "%${HOSTED_BIN_ENV}%" %*\r\n` +
        `if defined ${CLAUDECODE_ENV} exit /b\r\n` +
        `"%${HOSTED_BIN_ENV}%" --settings "%~dp0..\\settings.json" %*\r\n`,
    );
    // Duas linhas em vez de um bloco `( … & exit /b %ERRORLEVEL% )`: dentro de
    // parênteses o cmd.exe expande o `%ERRORLEVEL%` na LEITURA do bloco, antes
    // de o claude rodar, e o wrapper devolveria o código de saída anterior.
    expect(cmd!.content).not.toContain('%ERRORLEVEL%');
    // Nem acento, nem qualquer byte fora do ASCII: não há codepage pra errar.
    expect(/^[\x20-\x7e\r\n]*$/.test(cmd!.content)).toBe(true);
    // TODA quebra é CRLF: um `\n` solo num .cmd é lido como parte do comando.
    expect(cmd!.content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('o alvo REAL viaja no ambiente da sessão, não no corpo do .cmd', () => {
    const spec = shellLaunch('pwsh', ctxWith({ kind: 'pwsh' }));
    expect(spec.env[HOSTED_BIN_ENV]).toBe(target.cmd);
    // Nunca `claude` pelo PATH: com o bin da sessão na frente, o wrapper
    // acharia a si mesmo.
    expect(spec.env[HOSTED_BIN_ENV]).not.toBe('claude');
  });

  it('claude (sh): LF, sem BOM, caminhos em barra normal e `"$@"`', () => {
    const sh = files.find((f) => f.path === join(BIN_DIR, 'claude'));
    expect(sh).toBeDefined();
    expect(sh!.content).toBe(
      '#!/bin/sh\n' +
        'if [ -n "$CLAUDECODE" ]; then exec \'C:/Ferramentas/npm ação/claude\' "$@"; fi\n' +
        "exec 'C:/Ferramentas/npm ação/claude' --settings 'C:/Meus Projetos/sessões/sess_ab12/settings.json' \"$@\"\n",
    );
    expect(sh!.content).not.toContain('\r');
    expect(sh!.content.charCodeAt(0)).toBe('#'.charCodeAt(0));
  });

  it('sem o shim POSIX ao lado, o wrapper sh chama o próprio .cmd', () => {
    const semSh = hostedFiles(ctxWith({ kind: 'gitbash' }), { cmd: target.cmd });
    const sh = semSh.find((f) => f.path === join(BIN_DIR, 'claude'))!;
    expect(sh.content).toBe(
      '#!/bin/sh\n' +
        'if [ -n "$CLAUDECODE" ]; then exec \'C:/Ferramentas/npm ação/claude.cmd\' "$@"; fi\n' +
        "exec 'C:/Ferramentas/npm ação/claude.cmd' --settings 'C:/Meus Projetos/sessões/sess_ab12/settings.json' \"$@\"\n",
    );
  });

  /**
   * O mesmo perigo que o wrapper do WSL já cobria, do lado do Windows: entre
   * aspas DUPLAS, um `$` ou uma crase no caminho do perfil (ou da instalação do
   * npm) expandem, e uma aspa simples/dupla fecha a citação. O caminho de
   * sessão vem do `BRIDGE_PROFILE_DIR`, que é escolha do dono.
   */
  it('cita os dois caminhos com aspas simples: `$` e aspas no caminho não expandem nem injetam', () => {
    const sujo: LaunchCtx = {
      ...ctxWith({ kind: 'gitbash' }),
      sessionDir: "C:\\perfil $HOME\\sess 'q'",
    };
    const alvo: HostedTarget = { cmd: "C:\\npm $x\\claude.cmd", sh: "C:\\npm $x\\claude" };
    const sh = hostedFiles(sujo, alvo).find((f) => f.path === join("C:\\perfil $HOME\\sess 'q'", 'bin', 'claude'))!;
    expect(sh.content).toBe(
      '#!/bin/sh\n' +
        'if [ -n "$CLAUDECODE" ]; then exec \'C:/npm $x/claude\' "$@"; fi\n' +
        "exec 'C:/npm $x/claude' --settings 'C:/perfil $HOME/sess '\\''q'\\''/settings.json' \"$@\"\n",
    );
    // Nenhum pedaço do caminho ficou solto dentro de aspas DUPLAS: os únicos
    // trechos entre aspas duplas são o teste da variável de aninhamento e os
    // dois repasses de argumento.
    expect(sh.content.match(/"[^"]*"/g)).toEqual(['"$CLAUDECODE"', '"$@"', '"$@"']);
  });

  it('são exatamente três arquivos: settings + os dois wrappers', () => {
    expect(files.map((f) => f.path).sort()).toEqual(
      [SETTINGS, join(BIN_DIR, 'claude.cmd'), join(BIN_DIR, 'claude')].sort(),
    );
  });
});

describe('hostedFiles — WSL', () => {
  const files = hostedFiles(ctxWith(wslEnv), target);

  it('o wrapper tira TODAS as ocorrências do próprio bin do PATH e chama o `claude` DA DISTRO', () => {
    expect(files.map((f) => f.path).sort()).toEqual([SETTINGS, join(BIN_DIR, 'claude')].sort());
    const sh = files.find((f) => f.path === join(BIN_DIR, 'claude'))!;
    expect(sh.content).toBe(
      '#!/bin/sh\n' +
        "BIN='/mnt/c/Meus Projetos/sessões/sess_ab12/bin'\n" +
        "NEW=''\n" +
        'set -f\n' +
        'IFS=:\n' +
        'for p in $PATH; do\n' +
        '  [ "$p" = "$BIN" ] || NEW="${NEW:+$NEW:}$p"\n' +
        'done\n' +
        'unset IFS\n' +
        'set +f\n' +
        'PATH=$NEW\n' +
        'export PATH\n' +
        // A guarda de aninhamento vem DEPOIS do corte do PATH: o `claude` que
        // ela executa é o da distro, não o próprio wrapper.
        'if [ -n "$CLAUDECODE" ]; then exec claude "$@"; fi\n' +
        'exec claude --settings \'/mnt/c/Meus Projetos/sessões/sess_ab12/settings.json\' "$@"\n',
    );
    // O caminho do Windows não serve dentro da distro — nem o do alvo, nem o
    // do settings.
    expect(sh.content).not.toContain('C:\\');
    expect(sh.content).not.toContain('C:/');
    // O corte por PREFIXO da primeira versão não pode voltar: ele só pegava o
    // bin quando ele era o primeiro da lista, e o `~/.profile` do Ubuntu põe
    // `$HOME/.local/bin` na frente antes de o wrapper rodar.
    expect(sh.content).not.toContain('${PATH#');
  });

  /**
   * Round 1 de correção: caminho da distro com metacaractere de shell. O
   * `BRIDGE_PROFILE_DIR` é escolhido pelo dono, então `$`, crase, aspas e
   * contrabarra chegam aqui — e um deles em aspas DUPLAS viraria expansão ou
   * comando dentro do wrapper.
   */
  it('cita o caminho com aspas simples: `$`, crase e aspas não expandem nem injetam', () => {
    const perigoso = "/mnt/c/perfil $HOME `id`/sess 'x' \\ \"y\"";
    const ctx = ctxWith({ ...wslEnv, sessionDirUnix: perigoso });
    const sh = hostedFiles(ctx, target).find((f) => f.path === join(BIN_DIR, 'claude'))!;
    // `'\''` é o único escape de aspas simples que não tem exceção.
    expect(sh.content).toContain("BIN='/mnt/c/perfil $HOME `id`/sess '\\''x'\\'' \\ \"y\"/bin'\n");
    expect(sh.content).toContain(
      "exec claude --settings '/mnt/c/perfil $HOME `id`/sess '\\''x'\\'' \\ \"y\"/settings.json' \"$@\"\n",
    );
    // Nada do caminho ficou solto dentro de aspas duplas.
    expect(sh.content).not.toContain('"/mnt/c/perfil');
  });

  it('WSL_HOSTED_SHELL_COMMAND também cita o bin, e a atribuição não sofre split', () => {
    expect(WSL_HOSTED_SHELL_COMMAND("/mnt/c/a b $X 'q'")).toBe(
      "PATH='/mnt/c/a b $X '\\''q'\\''':$PATH exec \"${SHELL:-/bin/sh}\" -l",
    );
  });

  it('o settings.json continua sendo ESCRITO no caminho do Windows (quem escreve é o core)', () => {
    expect(files.some((f) => f.path === SETTINGS)).toBe(true);
  });

  it('sem caminho traduzido da sessão, recusa em vez de gravar um wrapper que não resolve', () => {
    expect(() => hostedFiles(ctxWith({ kind: 'wsl', distro: 'Ubuntu' }), target)).toThrow(/traduzido/);
  });
});

/**
 * Round 1 de correção, a prova que o teste de texto não dá: o wrapper gerado
 * RODANDO num `sh` de verdade (o do Git), com o próprio bin no PATH duas vezes
 * e o claude "real" DEPOIS dele. Se o corte do PATH falhar, o `exec claude`
 * acha o wrapper de novo e o processo entra em recursão — daí o `timeout` do
 * `spawnSync`: a regressão vira falha, não uma suíte pendurada.
 */
describe('o wrapper WSL executado de verdade', () => {
  const sh = 'C:\\Program Files\\Git\\bin\\sh.exe';
  const runner = existsSync(sh) ? it : it.skip;

  /** `C:\x\y` → `/c/x/y`, que é como o `sh` do Git enxerga o disco. */
  function toMsys(p: string): string {
    return p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
  }

  runner(
    'com o bin duplicado no PATH e o claude real atrás dele, o real roda UMA vez e recebe o argv certo',
    () => {
      const root = tmpDir('bridge-hosted-run-');
      // Metacaracteres legais no Windows e venenosos no shell: colchete (glob),
      // cifrão (expansão), aspas simples (fim de citação) e espaço.
      const sessionDir = join(root, "sess [a] $x 'q'");
      const binDir = join(sessionDir, 'bin');
      const realDir = join(root, 'real');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });

      const argvFile = join(root, 'argv.txt');
      const wrapper = hostedFiles(
        {
          ...ctxWith({ ...wslEnv, sessionDirUnix: toMsys(sessionDir) }),
          sessionDir,
        },
        target,
      ).find((f) => f.path === join(binDir, 'claude'))!;
      writeFileSync(wrapper.path, wrapper.content);
      writeFileSync(
        join(realDir, 'claude'),
        `#!/bin/sh\nprintf 'RUN\\n' >> '${toMsys(argvFile)}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${toMsys(argvFile)}'; done\n`,
      );

      const binMsys = toMsys(binDir);
      const path = [binMsys, toMsys(root), binMsys, toMsys(realDir)].map(shQuote).join(':');
      const cmd = `PATH=${path}; export PATH; exec ${shQuote(toMsys(wrapper.path))} --version`;
      const res = spawnSync(sh, ['-c', cmd], {
        encoding: 'utf8',
        timeout: 20000,
        env: envSemClaudecode(),
      });

      expect(res.error, `stderr: ${res.stderr}`).toBeUndefined();
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      const linhas = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
      expect(linhas).toEqual(['RUN', '--settings', `${toMsys(sessionDir)}/settings.json`, '--version']);
    },
    30000,
  );

  /**
   * O wrapper de FORA do WSL (o que o Git Bash executa) com os dois caminhos
   * cheios de metacaractere: aqui não há corte de PATH, o alvo é literal — o
   * que está sob prova é a CITAÇÃO. Com aspas duplas (como era antes), o `$x`
   * do caminho expandiria pra vazio e o `exec` procuraria outro arquivo.
   */
  runner(
    'o wrapper de fora do WSL chama o alvo literal mesmo com `$` e aspas simples nos dois caminhos',
    () => {
      const root = tmpDir('bridge-hosted-gitbash-');
      const sessionDir = join(root, "sess $x 'q'");
      const binDir = join(sessionDir, 'bin');
      const realDir = join(root, "npm $y");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });

      const argvFile = join(root, 'argv.txt');
      const alvo: HostedTarget = { cmd: join(realDir, 'claude.cmd'), sh: join(realDir, 'claude') };
      writeFileSync(
        alvo.sh!,
        `#!/bin/sh\nprintf 'RUN\\n' >> '${toMsys(argvFile)}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${toMsys(argvFile)}'; done\n`,
      );

      const wrapper = hostedFiles({ ...ctxWith({ kind: 'gitbash' }), sessionDir }, alvo).find(
        (f) => f.path === join(binDir, 'claude'),
      )!;
      writeFileSync(wrapper.path, wrapper.content);

      const res = spawnSync(sh, ['-c', `exec ${shQuote(toMsys(wrapper.path))} --version`], {
        encoding: 'utf8',
        timeout: 20000,
        env: envSemClaudecode(),
      });

      expect(res.error, `stderr: ${res.stderr}`).toBeUndefined();
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      // Fora do WSL o caminho que o wrapper cita é o do WINDOWS em barra
      // normal (`C:/…`) — o `sh` do Git executa esse caminho como nativo. O
      // `$x` e as aspas simples chegam ao alvo INTACTOS, que é o ponto.
      const linhas = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
      expect(linhas).toEqual([
        'RUN',
        '--settings',
        `${sessionDir.replace(/\\/g, '/')}/settings.json`,
        '--version',
      ]);
      expect(linhas[2]).toContain("$x 'q'");
    },
    30000,
  );
});

/**
 * A guarda de aninhamento (review final da 0.12.0), executada de verdade.
 *
 * A dor: o bin da sessão fica na frente do PATH do PTY e de TODO descendente —
 * inclusive da Bash tool do Claude hospedado. Um `claude -p …` disparado lá de
 * dentro resolvia o wrapper, subia com o MESMO `settings.json` (e o mesmo
 * `BRIDGE_SESSION`) e reportava na sessão do hospedeiro: `Stop` do filho
 * marcava "done" com o pai ainda trabalhando, e o `SessionEnd` do filho
 * desospedava o painel.
 *
 * O discriminador é o `CLAUDECODE`, que só existe dentro de um Claude Code
 * (o `shell.ts` o remove do env do PTY exatamente por ser marca de aninhamento).
 */
describe('a guarda de aninhamento executada de verdade', () => {
  const sh = 'C:\\Program Files\\Git\\bin\\sh.exe';
  const runner = existsSync(sh) ? it : it.skip;

  function toMsys(p: string): string {
    return p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
  }

  runner(
    'wrapper do Git Bash com CLAUDECODE=1: o alvo roda, e SEM `--settings`',
    () => {
      const root = tmpDir('bridge-hosted-nested-');
      const sessionDir = join(root, 'sess');
      const binDir = join(sessionDir, 'bin');
      const realDir = join(root, 'npm');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });

      const argvFile = join(root, 'argv.txt');
      const alvo: HostedTarget = { cmd: join(realDir, 'claude.cmd'), sh: join(realDir, 'claude') };
      writeFileSync(
        alvo.sh!,
        `#!/bin/sh\nprintf 'RUN\\n' >> '${toMsys(argvFile)}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${toMsys(argvFile)}'; done\n`,
      );
      const wrapper = hostedFiles({ ...ctxWith({ kind: 'gitbash' }), sessionDir }, alvo).find(
        (f) => f.path === join(binDir, 'claude'),
      )!;
      writeFileSync(wrapper.path, wrapper.content);

      const cmd = `exec ${shQuote(toMsys(wrapper.path))} --version`;
      const res = spawnSync(sh, ['-c', cmd], {
        encoding: 'utf8',
        timeout: 20000,
        env: envSemClaudecode({ [CLAUDECODE_ENV]: '1' }),
      });

      expect(res.error, `stderr: ${res.stderr}`).toBeUndefined();
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      // O claude real rodou UMA vez, com o argv intacto e sem `--settings`: a
      // hospedagem é do Claude de cima, e o de baixo não pode reportar nela.
      const linhas = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
      expect(linhas).toEqual(['RUN', '--version']);
      expect(linhas).not.toContain('--settings');
    },
    30000,
  );

  /**
   * O `.cmd` é o wrapper que o pwsh/PowerShell (e a Bash tool do Claude, via
   * `cmd.exe`) resolvem. Aqui ele roda de verdade nos DOIS estados da variável,
   * contra um `claude.cmd` falso que imprime o argv e sai com um código
   * conhecido — o código de saída do claude tem que continuar sendo o do
   * wrapper (é o contrato de "sem `call`, de propósito").
   */
  it(
    'claude.cmd no cmd.exe: `--settings` só sem CLAUDECODE, e o código de saída atravessa nos dois',
    () => {
      const root = tmpDir('bridge-hosted-nested-cmd-');
      const sessionDir = join(root, 'sess');
      const binDir = join(sessionDir, 'bin');
      const realDir = join(root, 'npm');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });

      const fake = join(realDir, 'claude.cmd');
      // `exit /b 7`: um código de saída que não é 0 nem 1, pra que "atravessou"
      // não possa ser confundido com sucesso nem com erro do cmd.exe.
      writeFileSync(fake, '@echo off\r\necho ARGV %*\r\nexit /b 7\r\n');
      const wrapper = hostedFiles({ ...ctxWith({ kind: 'pwsh' }), sessionDir }, { cmd: fake }).find(
        (f) => f.path === join(binDir, 'claude.cmd'),
      )!;
      writeFileSync(wrapper.path, wrapper.content);

      const comspec = process.env.ComSpec ?? 'cmd.exe';
      const run = (nested: boolean): { status: number | null; stdout: string; stderr: string } =>
        spawnSync(comspec, ['/c', wrapper.path, '--version'], {
          encoding: 'utf8',
          timeout: 20000,
          env: envSemClaudecode(nested ? { [HOSTED_BIN_ENV]: fake, [CLAUDECODE_ENV]: '1' } : { [HOSTED_BIN_ENV]: fake }),
        });

      const normal = run(false);
      expect(normal.stdout, `stderr: ${normal.stderr}`).toContain('--settings');
      expect(normal.stdout).toContain('settings.json');
      expect(normal.stdout).toContain('--version');
      expect(normal.status).toBe(7);

      const aninhado = run(true);
      expect(aninhado.stdout, `stderr: ${aninhado.stderr}`).not.toContain('--settings');
      expect(aninhado.stdout).toContain('--version');
      // Sem `%ERRORLEVEL%` expandido cedo: o 7 do claude falso é o 7 do wrapper.
      expect(aninhado.status).toBe(7);
    },
    30000,
  );
});

describe('WSL_HOSTED_SHELL_COMMAND', () => {
  it('põe o bin da sessão na frente do PATH da distro e mantém o `$SHELL` de login', () => {
    expect(WSL_HOSTED_SHELL_COMMAND('/mnt/c/Meus Projetos/sessões/sess_ab12/bin')).toBe(
      'PATH=\'/mnt/c/Meus Projetos/sessões/sess_ab12/bin\':$PATH exec "${SHELL:-/bin/sh}" -l',
    );
  });
});

describe('prependPath', () => {
  it('reaproveita a chave `Path` que o Windows entrega (não cria uma segunda)', () => {
    const env: Record<string, string> = { Path: 'C:\\Windows;C:\\Windows\\System32', TERM: 'xterm-256color' };
    prependPath(env, BIN_DIR);
    expect(env.Path).toBe(`${BIN_DIR};C:\\Windows;C:\\Windows\\System32`);
    expect(env.PATH).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toHaveLength(1);
  });

  it('reaproveita a chave `PATH` quando é essa que existe', () => {
    const env: Record<string, string> = { PATH: 'C:\\Windows' };
    prependPath(env, BIN_DIR);
    expect(env.PATH).toBe(`${BIN_DIR};C:\\Windows`);
    expect(env.Path).toBeUndefined();
  });

  it('qualquer capitalização serve — a comparação é case-insensitive', () => {
    const env: Record<string, string> = { pAtH: 'C:\\Windows' };
    prependPath(env, BIN_DIR);
    expect(env.pAtH).toBe(`${BIN_DIR};C:\\Windows`);
    expect(Object.keys(env)).toEqual(['pAtH']);
  });

  it('sem nenhuma das duas, cria `Path` com o dir sozinho', () => {
    const env: Record<string, string> = {};
    prependPath(env, BIN_DIR);
    expect(env).toEqual({ Path: BIN_DIR });
  });
});

describe('hostedTargetFrom', () => {
  it('o fallback literal do resolveClaudeBin() não é alvo: sem claude, sem wrapper', () => {
    expect(hostedTargetFrom('claude.cmd')).toBeUndefined();
  });

  it('caminho absoluto que não existe também não é alvo', () => {
    expect(hostedTargetFrom(join(tmpDir('bridge-hosted-'), 'não existe', 'claude.cmd'))).toBeUndefined();
  });

  it('acha o shim POSIX ao lado do .cmd quando o npm instalou os dois', () => {
    const dir = tmpDir('bridge-hosted-');
    const npm = join(dir, 'npm ação');
    mkdirSync(npm, { recursive: true });
    writeFileSync(join(npm, 'claude.cmd'), '@echo off\r\n');
    expect(hostedTargetFrom(join(npm, 'claude.cmd'))).toEqual({ cmd: join(npm, 'claude.cmd') });

    writeFileSync(join(npm, 'claude'), '#!/bin/sh\n');
    expect(hostedTargetFrom(join(npm, 'claude.cmd'))).toEqual({
      cmd: join(npm, 'claude.cmd'),
      sh: join(npm, 'claude'),
    });
  });
});

describe('resolveHostedTarget', () => {
  it('devolve um caminho absoluto de .cmd, ou nada (máquina sem claude)', () => {
    const found = resolveHostedTarget();
    if (found === undefined) return;
    expect(isAbsolute(found.cmd)).toBe(true);
    expect(found.cmd.toLowerCase().endsWith('.cmd')).toBe(true);
  });
});

describe('shellLaunch — com e sem hospedagem', () => {
  it('sem `ctx.hosted`: nenhum arquivo e o PATH intacto (o comportamento de sempre)', () => {
    const ctx = ctxWith({ kind: 'pwsh' }, false);
    const spec = shellLaunch('pwsh', ctx);
    expect(spec.files).toEqual([]);
    const plain = baseEnv(ctx);
    for (const key of Object.keys(plain)) expect(spec.env[key]).toBe(plain[key]);
    expect(Object.keys(spec.env).sort()).toEqual(Object.keys(plain).sort());
  });

  it('com `ctx.hosted`: grava os arquivos e põe o bin da sessão na FRENTE do PATH', () => {
    const ctx = ctxWith({ kind: 'pwsh' });
    const spec = shellLaunch('pwsh', ctx);
    expect(spec.bin).toBe('pwsh.exe');
    expect(spec.files).toEqual(hostedFiles(ctx, target));
    const key = Object.keys(spec.env).find((k) => k.toLowerCase() === 'path')!;
    expect(spec.env[key]!.startsWith(`${BIN_DIR};`)).toBe(true);
  });

  it('gitbash hospedado: mesmo PATH prependado, mesmos arquivos', () => {
    const ctx = ctxWith({ kind: 'gitbash' });
    const spec = shellLaunch('gitbash', ctx);
    expect(spec.args).toEqual(['--login', '-i']);
    expect(spec.files.some((f) => f.path === join(BIN_DIR, 'claude'))).toBe(true);
    const key = Object.keys(spec.env).find((k) => k.toLowerCase() === 'path')!;
    expect(spec.env[key]!.startsWith(`${BIN_DIR};`)).toBe(true);
  });

  it('WSL hospedado: o PATH entra na LINHA do login shell, não no env do Windows', () => {
    const ctx = ctxWith(wslEnv);
    const spec = shellLaunch('wsl', ctx);
    expect(spec.args).toEqual([
      '-d',
      'Ubuntu-22.04',
      '--cd',
      '/mnt/c/Meus Projetos/app',
      '--',
      'sh',
      '-lc',
      WSL_HOSTED_SHELL_COMMAND('/mnt/c/Meus Projetos/sessões/sess_ab12/bin'),
    ]);
    // O `Path` do Windows fica como veio: o interop do WSL reinjeta o PATH do
    // Windows TRADUZIDO no fim do PATH da distro, então prependá-lo aqui só
    // faria o MESMO bin aparecer duas vezes lá dentro — uma pela linha do login
    // shell, outra pelo interop. Não daria recursão (o wrapper tira TODAS as
    // ocorrências do próprio bin antes do `exec`), mas um wrapper `.cmd` que a
    // distro nunca executa não tem o que fazer no PATH dela.
    const key = Object.keys(spec.env).find((k) => k.toLowerCase() === 'path')!;
    expect(spec.env[key]).toBe(baseEnv(ctx)[key]);
    expect(spec.files.some((f) => f.path === join(BIN_DIR, 'claude'))).toBe(true);
  });

  /**
   * A guarda `hosted && wsl.sessionDirUnix` do comando era MORTA: quem exige o
   * caminho traduzido é o `hostedFiles`, que roda antes, e sem ele a sessão
   * nem chega ao `switch`. O que a hospedagem sem caminho produz é a exceção —
   * nunca um shell silenciosamente sem wrapper.
   */
  it('WSL hospedado sem caminho traduzido: exceção, não um shell sem wrapper', () => {
    const ctx = ctxWith({ kind: 'wsl', distro: 'Ubuntu-22.04', cwdUnix: '/mnt/c/app' });
    expect(() => shellLaunch('wsl', ctx)).toThrow(/traduzido/);
  });

  it('WSL sem hospedagem: o comando volta a ser o `WSL_SHELL_COMMAND` de sempre', () => {
    const spec = shellLaunch('wsl', ctxWith(wslEnv, false));
    expect(spec.args.at(-1)).toBe(WSL_SHELL_COMMAND);
    expect(spec.files).toEqual([]);
  });
});
