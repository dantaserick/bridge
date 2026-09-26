import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { DEFAULT_CONFIG, TERMINAL_DEFAULTS, currentUserForAcl, loadProfile, mergeConfig, newToken, readInstance, writeConfig, writeInstance, clearInstance, profileDir } from '../src/profile.js';
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const tmp = () => tmpDir('bridge-');
describe('profile', () => {
  it('DEFAULT_CONFIG É o DEFAULT_STORED_CONFIG do shared — não uma cópia', () => {
    // Carry-over do lote de 04/09/2026: o default do config.json vivia em
    // duplicata (aqui e no SETTINGS_DEFAULTS da UI). Agora tem uma fonte só, e
    // este teste é o que impede alguém de reintroduzir a cópia.
    expect(DEFAULT_CONFIG).toBe(DEFAULT_STORED_CONFIG);
    expect(TERMINAL_DEFAULTS).toEqual(DEFAULT_STORED_CONFIG.terminal);
  });
  it('cria pastas e usa defaults sem config.json', () => {
    const p = loadProfile(tmp());
    expect(p.config).toEqual(DEFAULT_CONFIG);
    expect(p.config.terminal).toEqual({ fontFamily: TERMINAL_DEFAULTS.fontFamily, fontSize: 12 });
    expect(existsSync(p.sessionsDir)).toBe(true); expect(existsSync(p.logsDir)).toBe(true);
  });
  it('mescla config.json e ignora campo inválido', () => {
    const d = tmp(); writeFileSync(join(d, 'config.json'), JSON.stringify({ port: 4999, shell: 'zsh' }));
    const p = loadProfile(d); expect(p.config.port).toBe(4999); expect(p.config.shell).toBe('pwsh');
  });
  /**
   * O `config.json` quebrado caía em `{}` calado (anotado no BACKLOG): a
   * configuração do dono "sumia" e não sobrava pista nenhuma de onde procurar.
   * Agora o motivo vem em `profile.configError`, e o `createCore` o loga assim
   * que o logger existe (o `loadProfile` roda ANTES dele — é o `loadProfile`
   * quem diz onde o `core.log` fica).
   */
  it('config.json quebrado: cai no padrão, mas com o motivo em configError', () => {
    const d = tmp();
    writeFileSync(join(d, 'config.json'), '{ "port": 4999,,, ');
    const p = loadProfile(d);
    expect(p.config).toEqual(DEFAULT_CONFIG);
    expect(p.configError).toContain('config.json');
    expect(p.configError).toContain('JSON inválido');
  });
  it('config.json com um topo que não é objeto também avisa', () => {
    // JSON válido, mas inútil: nenhuma exceção acontece e o `mergeConfig` o
    // ignora inteiro — o mesmo desfecho do arquivo quebrado, logo o mesmo aviso.
    for (const conteudo of ['[]', '"pwsh"', 'null', '42']) {
      const d = tmp();
      writeFileSync(join(d, 'config.json'), conteudo);
      const p = loadProfile(d);
      expect(p.config).toEqual(DEFAULT_CONFIG);
      expect(p.configError).toContain('não é um objeto JSON');
    }
  });
  it('config.json bom (ou ausente) não deixa configError', () => {
    expect(loadProfile(tmp()).configError).toBeUndefined();
    const d = tmp();
    writeFileSync(join(d, 'config.json'), JSON.stringify({ port: 4999 }));
    expect(loadProfile(d).configError).toBeUndefined();
  });
  it('mergeConfig é PROFUNDO em toast/terminal e aceita uma base que não é o default', () => {
    // Era o shallow copy do BACKLOG: só `enabled` voltava o `toast` inteiro ao padrão.
    expect(mergeConfig({ toast: { enabled: false } }).toast).toEqual({ enabled: false, quietWhenFocused: true });
    expect(mergeConfig({ terminal: { fontSize: 18 } }).terminal).toEqual({ ...TERMINAL_DEFAULTS, fontSize: 18 });

    const base = { ...DEFAULT_CONFIG, gitPollSeconds: 90, toast: { enabled: false, quietWhenFocused: false } };
    const merged = mergeConfig({ toast: { quietWhenFocused: true } }, base);
    expect(merged).toEqual({ ...base, toast: { enabled: false, quietWhenFocused: true } });
    // Não muta a base nem o DEFAULT_CONFIG.
    expect(base.toast).toEqual({ enabled: false, quietWhenFocused: false });
    expect(DEFAULT_CONFIG.terminal.fontSize).toBe(12);
  });
  it('mergeConfig trata restore como os outros aninhados: profundo, com default ligado', () => {
    expect(mergeConfig({}).restore).toEqual({ resumeAgents: true });
    expect(mergeConfig({ restore: { resumeAgents: false } }).restore).toEqual({ resumeAgents: false });
    // Valor de outro tipo é ignorado — `config.json` mal editado não pode
    // deixar o campo sem valor nenhum.
    expect(mergeConfig({ restore: { resumeAgents: 'sim' } }).restore).toEqual({ resumeAgents: true });

    const base = { ...DEFAULT_CONFIG, restore: { resumeAgents: false } };
    expect(mergeConfig({ gitPollSeconds: 30 }, base).restore).toEqual({ resumeAgents: false });
    expect(mergeConfig({ restore: { resumeAgents: true } }, base).restore).toEqual({ resumeAgents: true });
    expect(base.restore).toEqual({ resumeAgents: false });
    expect(DEFAULT_CONFIG.restore.resumeAgents).toBe(true);
  });
  /**
   * Um `config.json` escrito por outra edição do Bridge pode trazer blocos que
   * esta não conhece: eles são ignorados, e nem chegam ao objeto em memória.
   */
  it('mergeConfig ignora bloco desconhecido no config.json', () => {
    const merged = mergeConfig({ extra: { fps: 60 }, gitPollSeconds: 30 });
    expect(merged.gitPollSeconds).toBe(30);
    expect('extra' in merged).toBe(false);
  });
  it('mergeConfig ignora fontSize fora da faixa e fontFamily vazia', () => {
    expect(mergeConfig({ terminal: { fontSize: 99, fontFamily: '' } }).terminal).toEqual(DEFAULT_CONFIG.terminal);
  });
  it('writeConfig grava atômico (tmp + rename) e o loadProfile relê', () => {
    const d = tmp();
    writeConfig(d, { ...DEFAULT_CONFIG, gitPollSeconds: 42 });
    expect(existsSync(join(d, 'config.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, 'config.json'), 'utf8')).gitPollSeconds).toBe(42);
    expect(loadProfile(d).config.gitPollSeconds).toBe(42);
    // Regravar por cima de um arquivo que já existe também funciona (rename com replace).
    writeConfig(d, { ...DEFAULT_CONFIG, gitPollSeconds: 7 });
    expect(loadProfile(d).config.gitPollSeconds).toBe(7);
  });
  it('instance.json: escreve, lê, some com pid morto e no clear', () => {
    const p = loadProfile(tmp()); const tok = newToken(); expect(tok).toMatch(/^[0-9a-f]{64}$/);
    writeInstance(p, { port: 4560, token: tok, pid: process.pid, startedAt: 1 });
    expect(readInstance(p)?.token).toBe(tok);
    writeFileSync(p.instancePath, JSON.stringify({ port: 4560, token: tok, pid: 999999, startedAt: 1 }));
    expect(readInstance(p)).toBeNull();
    clearInstance(p); expect(existsSync(p.instancePath)).toBe(false);
  });
  it('profileDir respeita BRIDGE_PROFILE_DIR', () => { expect(profileDir({ BRIDGE_PROFILE_DIR: 'X:\\p' })).toBe('X:\\p'); });
});

/**
 * BR-07 (onda de segurança): no Windows o `mode: 0o600` do `writeFileSync` é
 * NO-OP — medido com `icacls`, o arquivo simplesmente HERDA a ACL da pasta. Em
 * `%APPDATA%\Roaming` o resultado é o desejado por acidente da herança; com
 * `BRIDGE_PROFILE_DIR` numa pasta de herança frouxa, o `instance.json` — que
 * carrega o TOKEN — vira legível por qualquer usuário local.
 */
describe('BR-07 — ACL real do instance.json no Windows', () => {
  const windows = process.platform === 'win32';

  it('currentUserForAcl monta DOMINIO\\usuario quando ha dominio', () => {
    expect(currentUserForAcl('ana', 'LAPTOP')).toBe('LAPTOP\\ana');
    expect(currentUserForAcl('ana', '')).toBe('ana');
    expect(currentUserForAcl('ana', '  ')).toBe('ana');
  });

  it.skipIf(!windows)('depois de writeInstance a ACL não dá acesso a Usuários/Todos', () => {
    // Perfil dentro de uma pasta com herança PERMISSIVA de propósito: é o caso
    // que o `0o600` não cobria.
    const base = tmpDir('bridge-acl-');
    execFileSync('icacls', [base, '/grant', '*S-1-5-32-545:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    const p = loadProfile(join(base, 'perfil'));

    // Antes: um arquivo qualquer da mesma pasta herda o BUILTIN\Usuários.
    const herdado = join(p.dir, 'herdado.txt');
    writeFileSync(herdado, 'x', { mode: 0o600 });
    const aclHerdada = execFileSync('icacls', [herdado], { encoding: 'utf8', windowsHide: true });
    expect(aclHerdada).toMatch(/S-1-5-32-545|Usuários|Users/);

    writeInstance(p, { port: 1, token: 'segredo', pid: process.pid, startedAt: 1 });
    const acl = execFileSync('icacls', [p.instancePath], { encoding: 'utf8', windowsHide: true });

    expect(acl).not.toMatch(/S-1-5-32-545/);
    expect(acl).not.toMatch(/\\bTodos\\b|\\bEveryone\\b/);
    expect(acl).toContain(currentUserForAcl());
    // E o arquivo continua legível PELO DONO (o fluxo do shell/CLI não quebra).
    expect(readInstance(p)?.token).toBe('segredo');
  });

  it.skipIf(windows)('fora do Windows a restrição é no-op e não quebra a escrita', () => {
    const p = loadProfile(tmp());
    writeInstance(p, { port: 1, token: 'segredo', pid: process.pid, startedAt: 1 });
    expect(readInstance(p)?.token).toBe('segredo');
  });
});
