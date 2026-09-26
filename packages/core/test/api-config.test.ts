import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import WebSocket from 'ws';
import { createCore } from '../src/core.js';
import type { Core } from '../src/core.js';
import type { BridgeEvent } from '../src/events.js';
import { DEFAULT_CONFIG, TERMINAL_DEFAULTS, loadProfile } from '../src/profile.js';
import { LANGUAGE_SETTINGS, currentSystemLocale, resolveLanguage } from '@bridge/shared';

/**
 * `GET /api/config` e `PATCH /api/config` (spec §5) — o menu de configurações
 * do dono. O que estes testes protegem: a faixa de cada campo, o 403 dos dois
 * campos somente leitura, o merge PROFUNDO de `toast`/`terminal` (mandar
 * `toast.enabled` não pode ressuscitar o `quietWhenFocused` padrão), a
 * gravação atômica e as três reações — `toast` na hora, `gitPollSeconds`
 * reagendando o poller, `shell` valendo pras sessões novas.
 */
const AUTH = { authorization: 'Bearer T' };

function tmp(): string {
  return tmpDir('bridge-config-');
}

function makeCore(profileDir = tmp()): Core {
  return createCore({ profileDir, dbPath: ':memory:', port: 0, token: 'T' });
}

function readConfigFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

function waitFor(check: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout esperando condição'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('API de configuração', () => {
  let core: Core | undefined;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = undefined;
    }
  });

  it('GET /api/config devolve os defaults, com o terminal', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });

    expect(res.statusCode).toBe(200);
    // `claudeHome` é derivado como o `profileDir` — de onde os transcripts são
    // lidos. O teste não fixa o caminho (ele depende do ambiente), só que o
    // campo existe e é uma string, senão passaria ou falharia conforme quem roda.
    const body = res.json();
    expect(typeof body.claudeHome).toBe('string');
    // `languageResolved` é derivado como o `claudeHome` — depende da locale de
    // quem roda o teste, então o que se fixa é que ele existe e é um dos dois.
    expect(['pt-BR', 'en']).toContain(body.languageResolved);
    expect(body).toEqual({
      ...DEFAULT_CONFIG,
      profileDir: dir,
      claudeHome: body.claudeHome,
      languageResolved: body.languageResolved,
    });
    expect(body.terminal).toEqual({ fontFamily: TERMINAL_DEFAULTS.fontFamily, fontSize: 12 });
  });

  /**
   * O `profileDir` é o caminho ABSOLUTO da pasta do perfil, e existe por um
   * motivo concreto: o botão "Abrir pasta do perfil" do diálogo chama o
   * `shell.openPath` do Electron, que não expande `%APPDATA%` — o literal que
   * a UI mostrava antes não abria nada.
   */
  it('GET /api/config traz o profileDir absoluto da instância', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });

    expect(res.json().profileDir).toBe(dir);
    expect(isAbsolute(res.json().profileDir)).toBe(true);
    expect(res.json().profileDir).not.toContain('%APPDATA%');
  });

  /**
   * Derivado de ONDE o arquivo está: gravá-lo dentro dele seria guardar uma
   * resposta que já se sabe, e que vira mentira se a pasta mudar de lugar. O
   * tipo (`writeConfig` só aceita `StoredConfig`) é a trava; este teste é a
   * prova de que a trava vale no disco de verdade.
   */
  it('o config.json gravado NÃO tem profileDir', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { gitPollSeconds: 42 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().profileDir).toBe(dir);
    const onDisk = readConfigFile(dir);
    expect(onDisk).not.toHaveProperty('profileDir');
    expect(onDisk.gitPollSeconds).toBe(42);
  });

  it('PATCH com profileDir → 403 read-only, sem efeito colateral', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { profileDir: 'C:\\projetos\\outra\\pasta', gitPollSeconds: 30 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('read-only');
    expect(res.json().fields).toEqual(['profileDir']);
    // Tudo ou nada: o `gitPollSeconds` que veio junto não foi aplicado.
    const after = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(after.json().gitPollSeconds).toBe(DEFAULT_CONFIG.gitPollSeconds);
    expect(after.json().profileDir).toBe(dir);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });

  /**
   * `profileDir` escrito à mão no `config.json` é ignorado como qualquer campo
   * desconhecido: quem manda é a pasta onde o arquivo foi encontrado.
   */
  it('profileDir no config.json do disco é ignorado', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ profileDir: 'C:\\projetos\\mentira', gitPollSeconds: 20 }), 'utf8');
    core = makeCore(dir);

    const res = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });

    expect(res.json().profileDir).toBe(dir);
    expect(res.json().gitPollSeconds).toBe(20);
  });

  it('GET /api/config sem bearer → 401', async () => {
    core = makeCore();
    const res = await core.app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH aplica, devolve a config inteira e grava o config.json sem deixar .tmp', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { terminal: { fontSize: 16 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().terminal).toEqual({ fontFamily: TERMINAL_DEFAULTS.fontFamily, fontSize: 16 });
    expect(core.deps.profile.config.terminal.fontSize).toBe(16);

    // Gravação atômica: o `.tmp` é renomeado por cima, nunca fica pra trás.
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false);
    expect(readConfigFile(dir)).toEqual({ ...DEFAULT_CONFIG, terminal: { ...TERMINAL_DEFAULTS, fontSize: 16 } });
  });

  it('PATCH mescla toast/terminal CHAVE A CHAVE (o BACKLOG do shallow copy)', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { toast: { enabled: false } },
    });

    expect(res.statusCode).toBe(200);
    // O campo NÃO enviado sobrevive: mandar só `enabled` não repõe o default do outro.
    expect(res.json().toast).toEqual({ enabled: false, quietWhenFocused: true });
    expect(readConfigFile(dir).toast).toEqual({ enabled: false, quietWhenFocused: true });
  });

  /**
   * `restore.resumeAgents` (0.6.0): o interruptor do "ao reabrir, retomar as
   * sessões do Claude Code". Mesmo contrato dos outros aninhados — faixa
   * boolean, merge profundo, gravado no `config.json`.
   */
  it('restore.resumeAgents: default true no GET, PATCH desliga e o config.json guarda', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const get = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(get.json().restore).toEqual({ resumeAgents: true });

    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { restore: { resumeAgents: false } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().restore).toEqual({ resumeAgents: false });
    expect(readConfigFile(dir).restore).toEqual({ resumeAgents: false });
    expect(core.deps.profile.config.restore.resumeAgents).toBe(false);

    // E os outros campos não foram tocados pelo caminho novo.
    expect(patch.json().terminal).toEqual(DEFAULT_CONFIG.terminal);
  });

  it('config.json com restore parcial/ausente carrega com o default ligado', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ gitPollSeconds: 30 }), 'utf8');

    core = makeCore(dir);

    expect(core.deps.profile.config.restore).toEqual({ resumeAgents: true });
  });

  it('config.json com toast parcial carrega mesclado (não cai no default inteiro)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ toast: { quietWhenFocused: false } }), 'utf8');

    core = makeCore(dir);

    expect(core.deps.profile.config.toast).toEqual({ enabled: true, quietWhenFocused: false });
  });

  /**
   * `sessions.hostedAgents` (0.12.0) — o interruptor do wrapper `claude` na
   * frente do PATH de cada shell. Mesmo contrato dos outros aninhados: default
   * ligado, boolean, merge profundo (desligar o wrapper não pode ressuscitar o
   * teto de agentes padrão de quem mudou o teto antes).
   */
  it('sessions.mouseClicks: default ligado, PATCH desliga e GET reflete; valor não booleano → 400', async () => {
    core = createCore({ profileDir: tmp(), dbPath: ':memory:', port: 0, token: 'T' });
    const get = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(get.json().sessions.mouseClicks).toBe(true);
    const patch = await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { sessions: { mouseClicks: false } } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().sessions.mouseClicks).toBe(false);
    const bad = await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { sessions: { mouseClicks: 'sim' } } });
    expect(bad.statusCode).toBe(400);
  });

  it('sessions.hostedAgents: default ligado, PATCH desliga sem tocar no resto de sessions', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const get = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(get.json().sessions.hostedAgents).toBe(true);

    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { maxConcurrentAgents: 2 } },
    });
    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { sessions: { hostedAgents: false } },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().sessions).toEqual({ ...DEFAULT_CONFIG.sessions, maxConcurrentAgents: 2, hostedAgents: false });
    expect(readConfigFile(dir).sessions).toMatchObject({ maxConcurrentAgents: 2, hostedAgents: false });
    expect(core.deps.profile.config.sessions.hostedAgents).toBe(false);
  });

  /**
   * 0.12.2 — `usage.terminalStatusLine`. O default é DESLIGADA (a sidebar já
   * mostra os mesmos números; o rodapé da TUI era a segunda cópia deles), e o
   * PATCH liga sem levar embora o resto do bloco `usage` — o merge de `usage`
   * é CHAVE A CHAVE, como o de `toast`/`terminal`.
   */
  it('usage.terminalStatusLine: default desligada, PATCH liga sem tocar no resto de usage', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const get = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(get.json().usage.terminalStatusLine).toBe(false);
    expect(get.json().usage.showCost).toBe(true);

    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { terminalStatusLine: true } },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().usage).toEqual({ ...DEFAULT_CONFIG.usage, terminalStatusLine: true });
    expect(readConfigFile(dir).usage).toMatchObject({ showCost: true, terminalStatusLine: true });
    expect(core.deps.profile.config.usage.terminalStatusLine).toBe(true);

    // E desliga de volta pela mesma porta.
    const volta = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { usage: { terminalStatusLine: false } },
    });
    expect(volta.json().usage.terminalStatusLine).toBe(false);
  });

  it('config.json com usage.terminalStatusLine ligada à mão sobe ligada', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ usage: { terminalStatusLine: true } }), 'utf8');
    const profile = loadProfile(dir);
    expect(profile.config.usage.terminalStatusLine).toBe(true);
    // …e o resto do bloco continua no default (merge chave a chave).
    expect(profile.config.usage.showCost).toBe(true);
    expect(profile.config.usage.dayBoundary).toBe('local');
  });

  it('PATCH recusa valor fora da faixa, tipo errado e campo desconhecido com 400 invalid-config', async () => {
    core = makeCore();

    const casos: Record<string, unknown>[] = [
      { terminal: { fontSize: 7 } },
      { terminal: { fontSize: 25 } },
      { terminal: { fontSize: 12.5 } },
      { terminal: { fontFamily: '' } },
      { terminal: { fontsize: 12 } },
      { gitPollSeconds: 4 },
      { gitPollSeconds: 121 },
      { shell: 'zsh' },
      { toast: { enabled: 'sim' } },
      { restore: { resumeAgents: 'sim' } },
      { restore: { resumeagents: true } },
      { sessions: { hostedAgents: 'sim' } },
      { sessions: { hostedagents: true } },
      { tema: 'claro' },
    ];

    for (const payload of casos) {
      const res = await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code, JSON.stringify(payload)).toBe('invalid-config');
    }

    // Nada recusado pode ter vazado pra configuração em vigor.
    expect(core.deps.profile.config).toEqual(DEFAULT_CONFIG);
  });

  it('PATCH com port/profileDir/claudeHome → 403 read-only e nada é gravado', async () => {
    const dir = tmp();
    core = makeCore(dir);

    for (const payload of [
      { port: 5000 },
      { profileDir: 'C:\\outro' },
      { claudeHome: 'C:\\outro' },
      { port: 5000, shell: 'powershell' },
    ]) {
      const res = await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('read-only');
    }

    // Nem o campo válido que vinha junto do proibido é aplicado (tudo ou nada).
    expect(core.deps.profile.config.shell).toBe('pwsh');
    expect(core.deps.profile.config.port).toBe(DEFAULT_CONFIG.port);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });

  it('PATCH emite config.changed no bus e no WS', async () => {
    core = makeCore();
    const { port } = await core.start();

    const seen: BridgeEvent[] = [];
    core.deps.bus.on((e) => seen.push(e));

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=T`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await waitFor(() => messages.some((m) => m.type === 'hello'));

    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { terminal: { fontFamily: 'Consolas' } },
    });

    const changed = seen.filter((e) => e.type === 'config.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ config: { terminal: { fontFamily: 'Consolas', fontSize: 12 } } });
    /*
     * Spec §13 — o evento carrega o `languageResolved`, e não só o
     * `ui.language`. É desse campo que o processo main do shell (bandeja,
     * toasts, diálogos nativos) tira o idioma sem falar com a rota de novo, e
     * é dele que o renderer tira o idioma da janela. Um `config.changed` que
     * trouxesse só o `ui.language` obrigaria os dois a resolver `system` por
     * conta própria — que é justamente o que a spec proíbe (a locale do
     * processo do CORE é a que manda).
     */
    expect((changed[0] as { config: { languageResolved?: string } }).config.languageResolved).toBe(core.language());

    await waitFor(() => messages.some((m) => m.type === 'config.changed'));
    const fromWs = messages.find((m) => m.type === 'config.changed') as {
      config: { terminal: { fontFamily: string }; languageResolved?: string; ui?: { language?: string } };
    };
    expect(fromWs.config.terminal.fontFamily).toBe('Consolas');
    // A MESMA config vai pro bus e pro WS: quem só ouve o socket enxerga o
    // idioma resolvido igual a quem ouve o bus.
    expect(fromWs.config.languageResolved).toBe(core.language());
    expect(fromWs.config.ui?.language).toBe('system');

    socket.close();
  });

  it('PATCH sem mudança ({} ou valor igual) responde 200 sem gravar nem emitir', async () => {
    const dir = tmp();
    core = makeCore(dir);
    await core.start();
    const seen: BridgeEvent[] = [];
    core.deps.bus.on((e) => seen.push(e));

    const empty = await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: {} });
    expect(empty.statusCode).toBe(200);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);

    const same = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { terminal: { fontSize: DEFAULT_CONFIG.terminal.fontSize } },
    });
    expect(same.statusCode).toBe(200);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(seen.filter((e) => e.type === 'config.changed')).toHaveLength(0);
  });

  it('toast vale na hora: a política de notificação lê a config já mudada', async () => {
    core = makeCore();
    const cwd = tmp();
    const { workspace, pane } = core.deps.layout.createWorkspace({ cwd });
    const session = core.deps.sessions.create({
      paneId: pane.id,
      workspaceId: workspace.id,
      kind: 'agent',
      agent: 'claude',
      cwd,
    });

    const seen: BridgeEvent[] = [];
    core.deps.bus.on((e) => seen.push(e));

    core.deps.notifications.push(session.id, 'done', 'antes');
    expect(seen.filter((e) => e.type === 'notification.new').at(-1)).toMatchObject({ toast: true });

    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { toast: { enabled: false } },
    });

    core.deps.notifications.push(session.id, 'done', 'depois');
    expect(seen.filter((e) => e.type === 'notification.new').at(-1)).toMatchObject({ toast: false });
  });

  it('gitPollSeconds reagenda o poller em voo', async () => {
    core = makeCore();
    expect(core.deps.gitPoller?.intervalMs).toBe(DEFAULT_CONFIG.gitPollSeconds * 1000);

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { gitPollSeconds: 60 },
    });

    expect(res.statusCode).toBe(200);
    expect(core.deps.gitPoller?.intervalMs).toBe(60_000);
  });

  it('shell vale pras sessões novas: a config viva que o spawn lê é a mesma que o PATCH muda', async () => {
    core = makeCore();
    // `createSession` lê `profile.config.shell` NA HORA do spawn; o PATCH
    // muta esse mesmo objeto em vez de trocá-lo, então a próxima sessão nasce
    // no shell novo (as vivas continuam no que já tinham).
    const vivo = core.deps.profile.config;

    await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { shell: 'powershell' } });

    expect(core.deps.profile.config).toBe(vivo);
    expect(vivo.shell).toBe('powershell');
  });

  /**
   * Spec §13 — o idioma da interface. O default é `system`, e o corpo do
   * `GET` traz o idioma JÁ RESOLVIDO pra que UI, CLI e shell não repitam a
   * resolução (nem cheguem a respostas diferentes na mesma máquina).
   */
  it('ui.language nasce em system e o GET traz o languageResolved', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const res = await core.app.inject({ method: 'GET', url: '/api/config', headers: AUTH });

    expect(res.json().ui).toEqual({ language: 'system' });
    expect(res.json().languageResolved).toBe(resolveLanguage('system', currentSystemLocale()));
    expect(core.language()).toBe(res.json().languageResolved);
  });

  it('PATCH troca o idioma, grava, resolve na hora e vale pro core inteiro', async () => {
    const dir = tmp();
    core = makeCore(dir);

    const patch = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { ui: { language: 'en' } },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().ui).toEqual({ language: 'en' });
    expect(patch.json().languageResolved).toBe('en');
    // A resolução é AO VIVO: quem perguntar depois do PATCH já ouve o idioma
    // novo, sem esperar o próximo pedido nem o restart.
    expect(core.language()).toBe('en');
    expect(readConfigFile(dir).ui).toEqual({ language: 'en' });

    const volta = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { ui: { language: 'pt-BR' } },
    });
    expect(volta.json().languageResolved).toBe('pt-BR');
    expect(core.language()).toBe('pt-BR');
  });

  it('idioma fora do enum é 400 invalid-config', async () => {
    core = makeCore();

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { ui: { language: 'klingon' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid-config');
    expect(core.config().ui.language).toBe('system');
  });

  /**
   * A lista de opções de idioma existia escrita à MÃO em três lugares: o
   * `LANGUAGE_SETTINGS` do `@bridge/shared` (que é o que o diálogo de
   * configurações desenha) e os dois `z.enum` que validam o campo — o da API
   * e o do `config.json`. Um idioma novo tinha que entrar nos três, e nada
   * avisava quando entrasse em dois.
   *
   * Os dois schemas passaram a DERIVAR da lista do shared; o que se prova aqui
   * é que a derivação chegou aos dois CAMINHOS — o `PATCH` da API e o
   * `config.json` lido na subida — e que a lista é exatamente essa.
   */
  it('a API e o config.json aceitam exatamente o LANGUAGE_SETTINGS do shared', async () => {
    expect([...LANGUAGE_SETTINGS]).toEqual(['pt-BR', 'en', 'system']);

    for (const language of LANGUAGE_SETTINGS) {
      const dir = tmp();
      core = makeCore(dir);
      const res = await core.app.inject({
        method: 'PATCH',
        url: '/api/config',
        headers: AUTH,
        payload: { ui: { language } },
      });
      expect(res.statusCode, language).toBe(200);
      await core.stop();
      core = undefined;

      // O MESMO valor, agora pelo outro caminho: o `config.json` lido na subida.
      const outro = tmpDir('bridge-config-');
      writeFileSync(join(outro, 'config.json'), JSON.stringify({ ui: { language } }));
      expect(loadProfile(outro).config.ui.language, language).toBe(language);
    }

    for (const language of ['klingon', 'pt', 'en-US', 'PT-BR', '']) {
      core = makeCore();
      const res = await core.app.inject({
        method: 'PATCH',
        url: '/api/config',
        headers: AUTH,
        payload: { ui: { language } },
      });
      expect(res.statusCode, language).toBe(400);
      expect(res.json().code, language).toBe('invalid-config');
      await core.stop();
      core = undefined;

      // No `config.json` o campo inválido é IGNORADO (o core sobe com o
      // default), que é a regra do arquivo — nunca "aceita o que a API recusa".
      const outro = tmpDir('bridge-config-');
      writeFileSync(join(outro, 'config.json'), JSON.stringify({ ui: { language } }));
      expect(loadProfile(outro).config.ui.language, language).toBe('system');
    }
  });

  /**
   * `languageResolved` é DERIVADO (`ui.language` cruzado com a locale da
   * máquina), como o `profileDir` e o `claudeHome`: escrevê-lo seria guardar
   * uma resposta que já se sabe. 403, não 400 — o pedido é bem formado.
   */
  it('languageResolved é somente leitura pela API', async () => {
    core = makeCore();

    const res = await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { languageResolved: 'en' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('read-only');
    expect(res.json().fields).toEqual(['languageResolved']);
  });

  it('o idioma escolhido sobrevive ao restart do core', async () => {
    const dir = tmp();
    core = makeCore(dir);
    await core.app.inject({ method: 'PATCH', url: '/api/config', headers: AUTH, payload: { ui: { language: 'en' } } });
    await core.stop();
    core = undefined;

    const outro = makeCore(dir);
    try {
      expect(outro.config().ui.language).toBe('en');
      expect(outro.language()).toBe('en');
    } finally {
      await outro.stop();
    }
  });

  it('a config sobrevive ao restart do core (é o config.json que manda)', async () => {
    const dir = tmp();
    core = makeCore(dir);
    await core.app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: AUTH,
      payload: { gitPollSeconds: 30, terminal: { fontSize: 20 } },
    });
    await core.stop();
    core = undefined;

    const outro = makeCore(dir);
    try {
      expect(outro.deps.profile.config.gitPollSeconds).toBe(30);
      expect(outro.deps.profile.config.terminal).toEqual({ ...TERMINAL_DEFAULTS, fontSize: 20 });
    } finally {
      await outro.stop();
    }
  });
});
