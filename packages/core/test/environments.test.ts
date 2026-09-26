import { describe, expect, it } from 'vitest';
import {
  ENV_CACHE_TTL_MS,
  EnvironmentError,
  Environments,
  WSL_INTEROP_MARKER,
  WSL_OK_MARKER,
  WSL_PROBE_SCRIPT,
  decodeWslText,
  parseWslList,
  probeWslDistro,
  resolveEnvContext,
  shQuote,
  withSessionDir,
  wslPath,
} from '../src/environments.js';
import type { RunResult, Runner } from '../src/environments.js';

/**
 * Dor verificada #2 — a detecção de ambientes e a tradução de caminhos.
 *
 * NESTA MÁQUINA `wsl -l -q` não devolve distro nenhuma (conferido em
 * 06/09/2026), então TUDO aqui roda contra um `wsl.exe` de mentira: um `Runner`
 * que devolve `{ code, stdout }` sem spawnar nada. É o que deixa a montagem do
 * comando, o parsing UTF-16 e o fallback do node testáveis — e é por isso que
 * a execução real em WSL fica registrada como verificação MANUAL no README.
 */

/** Constrói a saída UTF-16LE (com BOM) que o `wsl.exe -l -q` de verdade escreve. */
function utf16(text: string, withBom = true): Buffer {
  const body = Buffer.from(text, 'utf16le');
  return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

interface Call {
  bin: string;
  args: string[];
}

/** `wsl.exe` de mentira: responde por prefixo de argumentos e grava as chamadas. */
function fakeWsl(handlers: {
  list?: string[];
  probe?: Record<string, string>;
  paths?: Record<string, string>;
  failList?: boolean;
}): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (bin, args) => {
    calls.push({ bin, args });
    const ok = (text: string): RunResult => ({ code: 0, stdout: Buffer.from(text, 'utf8') });
    if (args[0] === '-l' && args[1] === '-q') {
      if (handlers.failList) return { code: 1, stdout: Buffer.alloc(0) };
      return { code: 0, stdout: utf16(`${(handlers.list ?? []).join('\r\n')}\r\n`) };
    }
    const distro = args[0] === '-d' ? args[1]! : '';
    const rest = args.slice(args.indexOf('--') + 1);
    if (rest[0] === 'wslpath') {
      const requested = rest[2]!;
      const mapped = handlers.paths?.[requested];
      if (mapped === undefined) return { code: 1, stdout: Buffer.alloc(0) };
      return ok(`${mapped}\n`);
    }
    if (rest[0] === 'sh' && rest[1] === '-lc' && rest[2] === WSL_PROBE_SCRIPT) {
      const out = handlers.probe?.[distro];
      // Distro que não existe: o `wsl.exe` escreve o erro em stderr e NADA em
      // stdout — nem a sentinela.
      if (out === undefined) return { code: 1, stdout: Buffer.alloc(0) };
      return ok(out);
    }
    return { code: 1, stdout: Buffer.alloc(0) };
  };
  return { run, calls };
}

describe('parseWslList — a saída UTF-16LE do `wsl.exe -l -q`', () => {
  it('decodifica UTF-16LE com BOM e tira o \\r de cada linha', () => {
    expect(parseWslList(utf16('Ubuntu\r\ndocker-desktop\r\n'))).toEqual(['Ubuntu', 'docker-desktop']);
  });

  it('decodifica UTF-16LE SEM BOM (é o que algumas versões do wsl.exe escrevem)', () => {
    expect(parseWslList(utf16('Ubuntu-22.04\r\n', false))).toEqual(['Ubuntu-22.04']);
  });

  it('aceita também saída em UTF-8 (stub de teste, wsl de outra versão)', () => {
    expect(parseWslList(Buffer.from('Debian\nAlpine\n', 'utf8'))).toEqual(['Debian', 'Alpine']);
  });

  it('não deixa passar NUL residual — era o `-d "U\\0buntu"` que o wsl.exe recusava', () => {
    const names = parseWslList(utf16('Ubuntu\r\n'));
    expect(names[0]).toBe('Ubuntu');
    expect(names[0]!.includes('\0')).toBe(false);
  });

  it('descarta nome que não passa na regra de distro (começando com `-`) e linha vazia', () => {
    expect(parseWslList(utf16('Ubuntu\r\n\r\n-injetado\r\n'))).toEqual(['Ubuntu']);
  });

  it('lista vazia quando não há distro nenhuma — o caso desta máquina', () => {
    expect(parseWslList(utf16(''))).toEqual([]);
    expect(parseWslList(Buffer.alloc(0))).toEqual([]);
  });
});

describe('decodeWslText', () => {
  it('lê UTF-16LE com BOM, sem BOM e UTF-8 puro', () => {
    expect(decodeWslText(utf16('/mnt/c/x'))).toBe('/mnt/c/x');
    expect(decodeWslText(utf16('/mnt/c/x', false))).toBe('/mnt/c/x');
    expect(decodeWslText(Buffer.from('/mnt/c/x', 'utf8'))).toBe('/mnt/c/x');
  });
});

describe('probeWslDistro — claude, node, interop e a SENTINELA', () => {
  const full = `/home/u/.local/bin/claude\n/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n`;

  it('monta `wsl.exe -d <distro> -- sh -lc <script>`', async () => {
    const { run, calls } = fakeWsl({ probe: { Ubuntu: full } });
    const probe = await probeWslDistro('Ubuntu', run);
    expect(calls[0]).toEqual({ bin: 'wsl.exe', args: ['-d', 'Ubuntu', '--', 'sh', '-lc', WSL_PROBE_SCRIPT] });
    expect(probe).toEqual({ ok: true, interop: true, claude: true, node: true });
  });

  it('o script pergunta as três coisas e termina na sentinela', () => {
    expect(WSL_PROBE_SCRIPT).toContain('command -v claude');
    expect(WSL_PROBE_SCRIPT).toContain('command -v node');
    expect(WSL_PROBE_SCRIPT).toContain('/proc/sys/fs/binfmt_misc/WSLInterop');
    // Distro moderna registra `WSLInterop-late`; as duas grafias contam.
    expect(WSL_PROBE_SCRIPT).toContain('WSLInterop-late');
    expect(WSL_PROBE_SCRIPT.trim().endsWith(`echo ${WSL_OK_MARKER}`)).toBe(true);
  });

  it('distro com node e SEM claude', async () => {
    const { run } = fakeWsl({ probe: { Ubuntu: `/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` } });
    expect(await probeWslDistro('Ubuntu', run)).toEqual({ ok: true, interop: true, claude: false, node: true });
  });

  /**
   * O caso que a sentinela existe pra resolver: sem `claude` E sem `node` a
   * saída não tinha linha NENHUMA, e a distro — viva — era lida como "não
   * respondeu" e sumia da lista de ambientes.
   */
  it('distro VIVA sem claude e sem node continua `ok` (quem responde é a sentinela)', async () => {
    const { run } = fakeWsl({ probe: { Alpine: `${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` } });
    expect(await probeWslDistro('Alpine', run)).toEqual({ ok: true, interop: true, claude: false, node: false });
  });

  it('interop desligado: `interop:false` mesmo com a distro viva e com claude', async () => {
    const { run } = fakeWsl({ probe: { Ubuntu: `/usr/bin/claude\n${WSL_OK_MARKER}\n` } });
    expect(await probeWslDistro('Ubuntu', run)).toEqual({ ok: true, interop: false, claude: true, node: false });
  });

  it('distro que não responde (nem a sentinela sai) → ok:false', async () => {
    const { run } = fakeWsl({ probe: {} });
    expect(await probeWslDistro('Sumida', run)).toEqual({ ok: false, interop: false, claude: false, node: false });
  });

  it('não confunde um caminho que só CONTÉM "node" com o binário', async () => {
    const { run } = fakeWsl({ probe: { Ubuntu: `/opt/nodemon/bin/nodemon\n${WSL_OK_MARKER}\n` } });
    expect(await probeWslDistro('Ubuntu', run)).toMatchObject({ ok: true, claude: false, node: false });
  });
});

describe('wslPath — tradução por `wslpath -a`', () => {
  it('traduz um caminho com ESPAÇO no nome, passando o argumento como argv', async () => {
    const win = 'C:\\Meus Projetos\\bridge';
    const { run, calls } = fakeWsl({ paths: { [win]: '/mnt/c/Meus Projetos/bridge' } });
    expect(await wslPath('Ubuntu', win, run)).toBe('/mnt/c/Meus Projetos/bridge');
    // O caminho é UM argumento — nada de aspas, nada de shell.
    expect(calls[0]!.args).toEqual(['-d', 'Ubuntu', '--', 'wslpath', '-a', win]);
  });

  it('traduz caminho com ACENTO', async () => {
    const win = 'D:\\Projetos\\ação & café';
    const { run } = fakeWsl({ paths: { [win]: '/mnt/d/Projetos/ação & café' } });
    expect(await wslPath('Ubuntu', win, run)).toBe('/mnt/d/Projetos/ação & café');
  });

  it('undefined quando o wslpath falha', async () => {
    const { run } = fakeWsl({ paths: {} });
    expect(await wslPath('Ubuntu', 'C:\\x', run)).toBeUndefined();
  });
});

describe('Environments.list', () => {
  it('sem distro nenhuma (esta máquina) devolve só os três ambientes do Windows', async () => {
    const { run } = fakeWsl({ list: [] });
    const list = await new Environments(run).list('pt-BR');
    expect(list.map((e) => e.id)).toEqual(['pwsh', 'powershell', 'gitbash']);
    expect(list[0]).toMatchObject({ kind: 'pwsh', available: true, claude: true });
  });

  it('`wsl.exe` ausente/falhando não derruba a lista', async () => {
    const run: Runner = async () => {
      throw new Error('ENOENT');
    };
    const list = await new Environments(run).list('pt-BR');
    expect(list.map((e) => e.id)).toEqual(['pwsh', 'powershell', 'gitbash']);
  });

  it('ambiente do Windows nasce com `interop: true` — não há fronteira a cruzar', async () => {
    const { run } = fakeWsl({ list: [] });
    const list = await new Environments(run).list('pt-BR');
    for (const env of list) expect(env.interop, env.id).toBe(true);
  });

  /**
   * Regressão do fix round 2: a entrada de WSL saía SEM `label`, e o
   * `toMatchObject` do teste vizinho não pega campo ausente. O `<select>` do
   * diálogo de novo workspace e o menu "⋯" do workspace mostram esse texto —
   * sem ele a distro aparecia como uma linha em branco. Aqui a asserção é
   * EXATA, campo a campo, e cobre também o `id` textual (`wsl:Ubuntu`) que a
   * CLI aceita em `bridge new --env`.
   */
  it('a entrada de WSL vem com `id` e `label` exatos (o rótulo do @bridge/shared)', async () => {
    const { run } = fakeWsl({
      list: ['Ubuntu'],
      probe: { Ubuntu: `/usr/bin/claude\n/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` },
    });
    const list = await new Environments(run).list('pt-BR');
    const ubuntu = list.find((e) => e.kind === 'wsl')!;
    expect(ubuntu.id).toBe('wsl:Ubuntu');
    expect(ubuntu.label).toBe('WSL · Ubuntu');
    // Nenhum ambiente pode sair da lista sem rótulo — é o que o diálogo mostra.
    for (const env of list) expect(env.label, env.id).toBeTruthy();
  });

  /**
   * `reason` é opcional de verdade: numa distro sadia a propriedade não existe
   * no objeto (não é `undefined` presente). É o que o `exactOptionalPropertyTypes`
   * espera e o que impede o JSON de `GET /api/environments` de carregar `null`.
   */
  it('distro sadia não carrega a propriedade `reason` nem como `undefined`', async () => {
    const { run } = fakeWsl({
      list: ['Ubuntu'],
      probe: { Ubuntu: `/usr/bin/claude\n/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` },
    });
    const ubuntu = (await new Environments(run).list('pt-BR')).find((e) => e.kind === 'wsl')!;
    expect(Object.prototype.hasOwnProperty.call(ubuntu, 'reason')).toBe(false);
  });

  it('uma distro com claude e uma sem: a segunda vem com `claude:false` e motivo em pt-BR', async () => {
    const { run } = fakeWsl({
      list: ['Ubuntu', 'Alpine'],
      probe: {
        Ubuntu: `/usr/bin/claude\n/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n`,
        Alpine: `/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n`,
      },
    });
    const list = await new Environments(run).list('pt-BR');
    expect(list.map((e) => e.id)).toEqual(['pwsh', 'powershell', 'gitbash', 'wsl:Ubuntu', 'wsl:Alpine']);
    const ubuntu = list.find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu).toMatchObject({ kind: 'wsl', distro: 'Ubuntu', available: true, claude: true, interop: true });
    expect(ubuntu.reason).toBeUndefined();
    const alpine = list.find((e) => e.id === 'wsl:Alpine')!;
    // `available` é a DISTRO, não o claude: dá pra querer só um shell ali.
    expect(alpine).toMatchObject({ available: true, claude: false, node: true });
    expect(alpine.reason).toContain('sem claude');
  });

  /**
   * O caso que a sentinela conserta, agora pela porta da lista: distro viva e
   * pelada (sem claude, sem node) tem que continuar DISPONÍVEL — o diálogo a
   * oferece, e o aviso diz o que falta.
   */
  it('distro viva sem claude e sem node segue `available`, com o aviso certo', async () => {
    const { run } = fakeWsl({
      list: ['Pelada'],
      probe: { Pelada: `${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` },
    });
    const pelada = (await new Environments(run).list('pt-BR')).find((e) => e.id === 'wsl:Pelada')!;
    expect(pelada).toMatchObject({ available: true, claude: false, node: false, interop: true });
    expect(pelada.reason).toContain('sem claude');
  });

  it('interop desligado vira o aviso mais importante — os hooks não rodam', async () => {
    const { run } = fakeWsl({
      list: ['SemInterop'],
      probe: { SemInterop: `/usr/bin/claude\n/usr/bin/node\n${WSL_OK_MARKER}\n` },
    });
    const env = (await new Environments(run).list('pt-BR')).find((e) => e.id === 'wsl:SemInterop')!;
    expect(env).toMatchObject({ available: true, claude: true, interop: false });
    expect(env.reason).toContain('interop');
    expect(env.reason).toContain('WSLInterop');
  });

  it('cacheia por 60 s e volta a medir depois disso', async () => {
    const { run, calls } = fakeWsl({ list: ['Ubuntu'], probe: { Ubuntu: `/usr/bin/claude\n${WSL_OK_MARKER}\n` } });
    let now = 1_000;
    const envs = new Environments(run, () => now);
    await envs.list('pt-BR');
    const first = calls.length;
    await envs.list('pt-BR');
    expect(calls.length).toBe(first);
    now += ENV_CACHE_TTL_MS + 1;
    await envs.list('pt-BR');
    expect(calls.length).toBeGreaterThan(first);
  });

  it('duas chamadas simultâneas viram UMA medição', async () => {
    const { run, calls } = fakeWsl({ list: ['Ubuntu'], probe: { Ubuntu: `/usr/bin/claude\n${WSL_OK_MARKER}\n` } });
    const envs = new Environments(run);
    const [a, b] = await Promise.all([envs.list('pt-BR'), envs.list('pt-BR')]);
    expect(a).toEqual(b);
    expect(calls.filter((c) => c.args[0] === '-l').length).toBe(1);
  });
});

describe('resolveEnvContext', () => {
  const paths = {
    cwd: 'C:\\Meus Projetos\\app',
    // A RAIZ das sessões do perfil: o `resolveEnvContext` roda ANTES de a
    // sessão existir (quem desce pro `<raiz>/<id>` é o `withSessionDir`).
    sessionsDir: 'C:\\perfil\\sessions',
    shimPath: 'C:\\Bridge\\core\\bin\\bridge-hook.cjs',
    windowsNode: 'C:\\Program Files\\nodejs\\node.exe',
  };
  // O `shimPath` NÃO entra aqui de propósito: ele nunca é traduzido.
  const translated = {
    [paths.cwd]: '/mnt/c/Meus Projetos/app',
    [paths.sessionsDir]: '/mnt/c/perfil/sessions',
    [paths.windowsNode]: '/mnt/c/Program Files/nodejs/node.exe',
  };
  const withClaude = { Ubuntu: `/usr/bin/claude\n/usr/bin/node\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` };

  it('fora do WSL não roda nada e devolve só o kind', async () => {
    const { run, calls } = fakeWsl({});
    expect(await resolveEnvContext({ kind: 'gitbash' }, paths, run)).toEqual({ kind: 'gitbash' });
    expect(calls).toHaveLength(0);
  });

  /**
   * A regra do fix round 1: o shim SEMPRE roda pelo Node do Windows por
   * interop, com a DISTRO TENDO NODE OU NÃO. O `127.0.0.1` do WSL2 em modo NAT
   * é o da própria distro; só um processo do Windows alcança o core.
   */
  it('o comando de hook é o node.exe do WINDOWS mesmo com node na distro', async () => {
    const { run } = fakeWsl({ probe: withClaude, paths: translated });
    const ctx = await resolveEnvContext({ kind: 'wsl', distro: 'Ubuntu' }, paths, run);
    expect(ctx).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      cwdUnix: '/mnt/c/Meus Projetos/app',
      sessionDirUnix: '/mnt/c/perfil/sessions',
      nodeCommand: '/mnt/c/Program Files/nodejs/node.exe',
    });
    // O caminho do shim não é traduzido — nem existe no contexto.
    expect(ctx).not.toHaveProperty('shimUnix');
  });

  it('sem node na distro o resultado é EXATAMENTE o mesmo', async () => {
    const { run } = fakeWsl({
      probe: { Ubuntu: `/usr/bin/claude\n${WSL_INTEROP_MARKER}\n${WSL_OK_MARKER}\n` },
      paths: translated,
    });
    const ctx = await resolveEnvContext({ kind: 'wsl', distro: 'Ubuntu' }, paths, run);
    expect(ctx.nodeCommand).toBe('/mnt/c/Program Files/nodejs/node.exe');
  });

  it('o shim NUNCA é passado pro wslpath (o interop não traduz argv)', async () => {
    const { run, calls } = fakeWsl({ probe: withClaude, paths: translated });
    await resolveEnvContext({ kind: 'wsl', distro: 'Ubuntu' }, paths, run);
    const traduzidos = calls.filter((c) => c.args.includes('wslpath')).map((c) => c.args[c.args.length - 1]);
    expect(traduzidos).not.toContain(paths.shimPath);
    expect(traduzidos.sort()).toEqual([paths.cwd, paths.sessionsDir, paths.windowsNode].sort());
  });

  it('distro que não traduz o cwd vira EnvironmentError (a sessão não pode cair no $HOME)', async () => {
    const { run } = fakeWsl({ probe: withClaude, paths: {} });
    await expect(resolveEnvContext({ kind: 'wsl', distro: 'Ubuntu' }, paths, run)).rejects.toBeInstanceOf(
      EnvironmentError,
    );
  });

  it('sem alcançar o node.exe do Windows, recusa — sem ele não há hook nenhum', async () => {
    const semNode = { ...translated };
    delete (semNode as Record<string, string>)[paths.windowsNode];
    const { run } = fakeWsl({ probe: withClaude, paths: semNode });
    await expect(resolveEnvContext({ kind: 'wsl', distro: 'Ubuntu' }, paths, run)).rejects.toThrow(/interop/);
  });

  it('recusa distro inválida antes de rodar qualquer coisa', async () => {
    const { run, calls } = fakeWsl({});
    await expect(resolveEnvContext({ kind: 'wsl', distro: '-x' }, paths, run)).rejects.toBeInstanceOf(EnvironmentError);
    await expect(resolveEnvContext({ kind: 'wsl' }, paths, run)).rejects.toBeInstanceOf(EnvironmentError);
    expect(calls).toHaveLength(0);
  });
});

describe('withSessionDir', () => {
  it('desce a raiz das sessões pra pasta de UMA sessão', () => {
    const ctx = withSessionDir(
      { kind: 'wsl', distro: 'Ubuntu', cwdUnix: '/mnt/c/x', sessionDirUnix: '/mnt/c/perfil/sessions' },
      'sess_abc',
    );
    expect(ctx.sessionDirUnix).toBe('/mnt/c/perfil/sessions/sess_abc');
  });

  it('fora do WSL não mexe em nada', () => {
    const ctx = { kind: 'gitbash' as const };
    expect(withSessionDir(ctx, 'sess_abc')).toBe(ctx);
  });
});

describe('shQuote', () => {
  it('aspas simples POSIX, com o escape de aspa simples', () => {
    expect(shQuote('/mnt/c/Program Files/nodejs/node.exe')).toBe(`'/mnt/c/Program Files/nodejs/node.exe'`);
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shQuote('rm -rf /; echo $HOME')).toBe(`'rm -rf /; echo $HOME'`);
  });
});
