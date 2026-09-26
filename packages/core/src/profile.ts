import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_STORED_CONFIG,
  LANGUAGE_SETTINGS,
  type StoredConfig,
} from '@bridge/shared';
import { MAX_CONCURRENT_AGENTS_MAX, MAX_CONCURRENT_AGENTS_MIN, MAX_PRICING_ENTRIES } from './api/schemas.js';

export type { BridgeConfig, BridgeConfigPatch, StoredConfig } from '@bridge/shared';
export { DEFAULT_STORED_CONFIG } from '@bridge/shared';

/**
 * O default do terminal, DERIVADO do `DEFAULT_STORED_CONFIG` do
 * `@bridge/shared` — não mais uma cópia à mão dos valores da UI. Continua
 * exportado daqui porque o core e os testes dele já o liam por este nome.
 */
export const TERMINAL_DEFAULTS: StoredConfig['terminal'] = DEFAULT_STORED_CONFIG.terminal;

/** Faixas aceitas pelo `PATCH /api/config` (as mesmas do diálogo de configurações). */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const GIT_POLL_SECONDS_MIN = 5;
export const GIT_POLL_SECONDS_MAX = 120;

/**
 * O default do core É o do `@bridge/shared` (mesmo objeto, não uma cópia): a
 * UI deriva do mesmo lugar, então os dois não têm como divergir. Ninguém muta
 * este objeto — `mergeConfig` sempre devolve cópias novas de `toast`/`terminal`.
 */
export const DEFAULT_CONFIG: StoredConfig = DEFAULT_STORED_CONFIG;

export interface Profile {
  dir: string;
  config: StoredConfig;
  sessionsDir: string;
  logsDir: string;
  logPath: string;
  dbPath: string;
  instancePath: string;
  /**
   * Por que o `config.json` foi ignorado, quando foi.
   *
   * `undefined` no caso normal (arquivo ausente ou lido sem problema). Com
   * texto, o arquivo EXISTE e não deu pra usá-lo — JSON quebrado por uma
   * edição à mão, ou um topo que não é objeto (`[]`, `"x"`, `null`) — e a
   * configuração em uso é a padrão.
   *
   * Existe como CAMPO, e não como um `console.warn` aqui dentro, porque
   * `loadProfile` roda ANTES do logger (é ele quem diz onde o `core.log`
   * fica): quem loga é o `createCore`, assim que o logger existe. Sem isso o
   * arquivo caía em `{}` calado e o dono via a configuração dele "sumir" sem
   * nenhuma pista de onde procurar (anotado no BACKLOG).
   */
  configError?: string;
}

/**
 * Cada campo separado, e os aninhados PARCIAIS: o `config.json` do usuário
 * (e o corpo do `PATCH /api/config`) pode trazer só `toast.enabled`, e exigir
 * o objeto inteiro faria o campo todo cair fora — era o "shallow copy de
 * `toast`" anotado no BACKLOG: `{ toast: { enabled: false } }` voltava com o
 * `toast` padrão INTEIRO, desligando nada.
 */
const configSchema = z.object({
  port: z.number(),
  shell: z.enum(['pwsh', 'powershell', 'gitbash']),
  gitPollSeconds: z.number(),
  /** ADR-012. Ver `configPatchSchema` em `api/schemas.ts` — as faixas são as mesmas. */
  usage: z
    .object({
      dayBoundary: z.literal('local'),
      showCost: z.boolean(),
      /** 0.12.2 — ver `UsageConfig.terminalStatusLine`. */
      terminalStatusLine: z.boolean(),
      pricingFile: z.string().max(1000),
      pricing: z
        .record(
          // BU-10: as MESMAS faixas e os MESMOS tetos do `configPatchSchema`.
          // Ter só `min(1)` aqui deixava o `config.json` aceitar à mão o que a
          // API recusa — e é o arquivo que o core relê em toda subida.
          z.string().min(1).max(200),
          z.object({
            input: z.number().min(0).finite(),
            output: z.number().min(0).finite(),
            cacheWrite: z.number().min(0).finite(),
            cacheWrite1h: z.number().min(0).finite().optional(),
            cacheRead: z.number().min(0).finite(),
          }),
        )
        .refine((table) => Object.keys(table).length <= MAX_PRICING_ENTRIES, {
          // i18n-ignore: este schema valida o `config.json` DO DISCO, na subida
          // do core; a recusa vira `core.log`, não resposta de API (a rota tem
          // o `configPatchSchema`, esse sim com chave de catálogo).
          message: `no máximo ${MAX_PRICING_ENTRIES} modelos em usage.pricing`, // i18n-ignore
        }),
    })
    .partial(),
  toast: z.object({ enabled: z.boolean(), quietWhenFocused: z.boolean() }).partial(),
  terminal: z
    .object({
      fontFamily: z.string().min(1),
      fontSize: z.number().int().min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX),
    })
    .partial(),
  restore: z.object({ resumeAgents: z.boolean() }).partial(),
  /**
   * Spec §13 — o idioma da interface. As opções são as MESMAS do
   * `configPatchSchema`, e agora por CONSTRUÇÃO: as duas saem do
   * `LANGUAGE_SETTINGS` do `@bridge/shared`, que é também a lista que o
   * diálogo de configurações desenha.
   */
  ui: z.object({ language: z.enum(LANGUAGE_SETTINGS) }).partial(),
  /**
   * Dor verificada #1 — o escalonador de lançamentos. As faixas são as MESMAS
   * do `configPatchSchema` (`api/schemas.ts`): o `config.json` editado à mão
   * não pode aceitar o que a API recusa, e é este arquivo que o core relê em
   * toda subida.
   */
  sessions: z
    .object({
      maxConcurrentAgents: z.number().int().min(MAX_CONCURRENT_AGENTS_MIN).max(MAX_CONCURRENT_AGENTS_MAX),
      scheduleLaunches: z.boolean(),
      /** Dor verificada #3 — ver `StoredConfig.sessions.autoRecap`. */
      autoRecap: z.boolean(),
      /** Dor verificada #4 — ver `StoredConfig.sessions.scopeGuard`. */
      scopeGuard: z.boolean(),
      /** 0.12.0 — ver `StoredConfig.sessions.hostedAgents`. */
      hostedAgents: z.boolean(),
      /** 12/09/2026 — ver `StoredConfig.sessions.mouseClicks`. */
      mouseClicks: z.boolean(),
    })
    .partial(),
});

/** Os campos aninhados — o merge deles é por CHAVE, não por objeto. */
const NESTED_KEYS = ['toast', 'terminal', 'restore', 'ui', 'usage', 'sessions'] as const;

/**
 * `base` com `raw` por cima, campo a campo: o que não parseia é ignorado (um
 * `config.json` mal editado nunca deixa o app sem configuração) e `toast`/
 * `terminal` são mesclados CHAVE A CHAVE, não substituídos.
 *
 * `base` existe pro `PATCH /api/config`: lá o "padrão" é a configuração que
 * está valendo agora, não o `DEFAULT_CONFIG`.
 */
export function mergeConfig(raw: unknown, base: StoredConfig = DEFAULT_CONFIG): StoredConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const shape = configSchema.partial().shape;
  const merged: StoredConfig = {
    ...base,
    toast: { ...base.toast },
    terminal: { ...base.terminal },
    restore: { ...base.restore },
    ui: { ...base.ui },
    usage: { ...base.usage },
    sessions: { ...base.sessions },
  };
  for (const key of Object.keys(shape) as (keyof StoredConfig)[]) {
    if (!(key in obj)) continue;
    const fieldResult = shape[key].safeParse(obj[key]);
    if (!fieldResult.success) continue;
    if ((NESTED_KEYS as readonly string[]).includes(key)) {
      Object.assign(merged[key as (typeof NESTED_KEYS)[number]], fieldResult.data);
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = fieldResult.data;
  }
  return merged;
}

/**
 * Grava `config.json` de forma atômica: escreve num `.tmp` ao lado e renomeia
 * por cima. O `rename` dentro da mesma pasta é atômico pro leitor — sem ele,
 * um crash no meio do `writeFileSync` deixaria um JSON truncado, e a próxima
 * subida cairia inteira nos defaults (a configuração do usuário sumiria).
 */
export function writeConfig(dir: string, config: StoredConfig): void {
  // `StoredConfig`, não `BridgeConfig`, de propósito: o `profileDir` que a API
  // devolve é derivado de `dir` — gravá-lo aqui seria escrever no arquivo a
  // resposta pra "onde este arquivo está", que vira mentira assim que a pasta
  // muda de lugar. O tipo é a trava; não há nada a "lembrar de tirar".
  const target = join(dir, 'config.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  // No Windows o rename por cima de um arquivo aberto por outro processo
  // (antivírus, editor) falha com EPERM/EBUSY transitório: três tentativas
  // com 25 ms entre elas antes de desistir — o `.tmp` fica pra diagnóstico.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw lastErr;
}

export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_PROFILE_DIR ?? join(env.APPDATA ?? '', 'bridge');
}

export function loadProfile(dir?: string): Profile {
  const dirPath = dir ?? profileDir(process.env);
  mkdirSync(dirPath, { recursive: true });
  const sessionsDir = join(dirPath, 'sessions');
  const logsDir = join(dirPath, 'logs');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const configPath = join(dirPath, 'config.json');
  let raw: unknown = {};
  let configError: string | undefined;
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      // Um JSON válido que não é objeto (`[]`, `"pwsh"`, `null`, `42`) chega
      // aqui sem exceção nenhuma e o `mergeConfig` o ignora inteiro — o mesmo
      // desfecho do arquivo quebrado, e o dono merece o mesmo aviso.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // i18n-ignore: `configError` só vira `log.warn` na subida do core.
        configError = `${configPath}: o conteúdo não é um objeto JSON; usando a configuração padrão`; // i18n-ignore
      } else {
        raw = parsed;
      }
    } catch (err) {
      // i18n-ignore: idem — linha de log, não texto de tela.
      configError = `${configPath}: JSON inválido (${err instanceof Error ? err.message : String(err)}); usando a configuração padrão`; // i18n-ignore
    }
  }

  return {
    dir: dirPath,
    config: mergeConfig(raw),
    sessionsDir,
    logsDir,
    logPath: join(logsDir, 'core.log'),
    dbPath: join(dirPath, 'bridge.db'),
    instancePath: join(dirPath, 'instance.json'),
    configError,
  };
}

export interface Instance { port: number; token: string; pid: number; startedAt: number }

const instanceSchema = z.object({
  port: z.number(),
  token: z.string(),
  pid: z.number(),
  startedAt: z.number(),
});

/**
 * Nome do usuário corrente no formato que o `icacls` entende: `DOMÍNIO\usuário`
 * quando há domínio, senão só o usuário (o `icacls` resolve pela máquina).
 */
export function currentUserForAcl(
  username: string = os.userInfo().username,
  domain: string | undefined = process.env.USERDOMAIN,
): string {
  const user = username.trim();
  const dom = domain?.trim();
  return dom ? `${dom}\\${user}` : user;
}

/**
 * Restringe a ACL de um arquivo ao usuário corrente (BR-07, R6).
 *
 * No Windows o `mode: 0o600` do `writeFileSync` é NO-OP: medido com `icacls`,
 * o arquivo simplesmente herda a ACL da pasta. Em `%APPDATA%\Roaming` o
 * resultado até é o desejado, mas por acidente da herança — com
 * `BRIDGE_PROFILE_DIR` apontando pra uma pasta de herança frouxa (`C:\bridge`,
 * a raiz de uma unidade, pasta compartilhada), o `instance.json` (que carrega o TOKEN) fica
 * legível por qualquer usuário local.
 *
 * `/inheritance:r` corta a herança e `/grant:r` deixa só o dono.
 *
 * **Falha NÃO é silenciosa** (re-review do BR-07): um `icacls` bloqueado por
 * política de grupo, ausente do PATH ou recusado pelo sistema de arquivos não
 * pode impedir o Bridge de subir — mas também não pode passar como se o
 * arquivo estivesse protegido. O desfecho volta pro chamador, que loga em
 * `error` e leva o aviso até a UI.
 *
 * `BRIDGE_ICACLS` troca o executável — existe pro teste conseguir simular
 * "icacls indisponível" sem mexer no PATH da máquina. Só é lido com
 * `BRIDGE_TEST_HOOKS=1`: sem esse gate, uma variável de ambiente qualquer
 * mandaria o app rodar outro binário no lugar do `icacls` (e o teste de
 * segurança viraria a porta de entrada que ele existe pra fechar).
 */
export type AclOutcome = 'aplicada' | 'nao-se-aplica' | 'falhou';

export function restrictToCurrentUser(path: string, onError?: (message: string, data?: object) => void): AclOutcome {
  if (process.platform !== 'win32') return 'nao-se-aplica';
  const bin = (process.env.BRIDGE_TEST_HOOKS === '1' ? process.env.BRIDGE_ICACLS : undefined) ?? 'icacls';
  try {
    execFileSync(bin, [path, '/inheritance:r', '/grant:r', `${currentUserForAcl()}:(R,W)`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return 'aplicada';
  } catch (err) {
    onError?.(
      // i18n-ignore: `onError` é o logger do perfil (`log.warn`), não a API.
      'não consegui restringir a ACL do instance.json: outro usuário desta máquina pode ler o token', // i18n-ignore
      { path, bin, err },
    );
    return 'falhou';
  }
}

export function writeInstance(
  p: Profile,
  inst: Instance,
  onError?: (message: string, data?: object) => void,
): AclOutcome {
  // O arquivo carrega o token da instância: quem lê, controla as sessões.
  // 0600 = só o dono (no Windows o mode é conselho, mas o contrato fica claro
  // e vale de verdade quando o perfil viver num volume POSIX); no Windows quem
  // faz valer é o `icacls` logo abaixo (BR-07).
  writeFileSync(p.instancePath, JSON.stringify(inst), { mode: 0o600 });
  return restrictToCurrentUser(p.instancePath, onError);
}

export function readInstance(p: Profile): Instance | null {
  if (!existsSync(p.instancePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p.instancePath, 'utf8'));
  } catch {
    return null;
  }
  const parsed = instanceSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    process.kill(parsed.data.pid, 0);
  } catch {
    return null;
  }
  return parsed.data;
}

export function clearInstance(p: Profile): void {
  if (existsSync(p.instancePath)) rmSync(p.instancePath);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}
