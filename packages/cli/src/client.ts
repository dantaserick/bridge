/**
 * Descoberta da instância (`instance.json`) e cliente HTTP fino do core —
 * spec §8. Zero dependências: `fetch` é global no Node 22+.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t, type Language, type MessageKey } from '@bridge/shared';

/**
 * Erro que vira mensagem pt-BR + código de saída na borda (`index.ts`).
 *
 * `code` é o `code` do corpo de erro da API (`{ error, code, detail? }` —
 * README "Rotas de tarefa e git") quando o erro veio de lá; comandos que
 * precisam decidir por código (`bridge task merge` oferecendo `--no-ff` em
 * `not-ff`) usam isto em vez de tentar reconhecer o texto da mensagem.
 */
export interface CliMessage {
  key: MessageKey;
  params?: Record<string, string | number>;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly code?: string;
  /**
   * A CHAVE do catálogo, quando a frase é do Bridge (spec §13). A borda
   * (`index.ts`) é que a escreve, porque é lá que o idioma já foi resolvido —
   * `resolveInstance` e `findWorkspace` não têm como saber qual é.
   *
   * Ausente quando a mensagem VEIO DE FORA: o corpo de erro do core já chega
   * traduzido (é ele que resolve o idioma), e repassá-lo é o certo.
   */
  readonly i18n?: CliMessage;
  constructor(message: string | CliMessage, exitCode = 1, code?: string) {
    super(typeof message === 'string' ? message : t('pt-BR', message.key, message.params));
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    if (typeof message !== 'string') this.i18n = message;
  }
}

/** A mensagem de um `CliError` no idioma do comando. */
export function cliMessage(err: CliError, lang: Language): string {
  return err.i18n ? t(lang, err.i18n.key, err.i18n.params) : err.message;
}

export interface Instance {
  port: number;
  token: string;
}

const NO_CORE: CliMessage = { key: 'cli.erro.semCore' };

/** Mesma regra do `profile.ts` do core — não importamos de lá (zero deps entre os dois em runtime). */
export function profileDir(env: NodeJS.ProcessEnv): string {
  return env.BRIDGE_PROFILE_DIR ?? join(env.APPDATA ?? '', 'bridge');
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `BRIDGE_PORT`/`BRIDGE_TOKEN` do ambiente primeiro — é o que todo painel do
 * Bridge já tem (spec §3: `baseEnv` do shell); sem eles, cai pro
 * `instance.json` do perfil. Qualquer forma de "não tem core" (arquivo
 * ausente, JSON quebrado, campo faltando, pid morto) vira a MESMA mensagem —
 * o usuário não precisa saber qual foi.
 */
export function resolveInstance(env: NodeJS.ProcessEnv = process.env): Instance {
  const envPort = env.BRIDGE_PORT;
  const envToken = env.BRIDGE_TOKEN;
  if (envPort && envToken) {
    const port = Number(envPort);
    if (Number.isFinite(port) && port > 0) return { port, token: envToken };
  }

  const instancePath = join(profileDir(env), 'instance.json');
  if (!existsSync(instancePath)) throw new CliError(NO_CORE, 1);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(instancePath, 'utf8'));
  } catch {
    throw new CliError(NO_CORE, 1);
  }
  const obj = raw as Record<string, unknown>;
  const port = obj.port;
  const token = obj.token;
  const pid = obj.pid;
  if (typeof port !== 'number' || typeof token !== 'string' || typeof pid !== 'number') {
    throw new CliError(NO_CORE, 1);
  }
  if (!isRunning(pid)) throw new CliError(NO_CORE, 1);
  return { port, token };
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  detail?: string;
}

/** Cliente HTTP do core — um método por verbo, autenticação sempre pelo bearer. */
export class Client {
  /**
   * `sessionId` é o `BRIDGE_SESSION` do ambiente — a sessão de dentro da qual
   * o comando está rodando. Vai em TODA chamada como `X-Bridge-Session`
   * porque é contexto de origem, não argumento de rota: o core usa ele pra
   * resolver o painel "atual" do `bridge resume` (`POST /api/panes/current/resume`),
   * e ignora em quem não liga.
   * Sessão inexistente/morta não é erro: o core cai no próximo critério.
   */
  constructor(
    private readonly instance: Instance,
    private readonly sessionId?: string,
  ) {}

  get port(): number {
    return this.instance.port;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `http://127.0.0.1:${this.instance.port}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.instance.token}`,
          ...(this.sessionId ? { 'x-bridge-session': this.sessionId } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CliError(NO_CORE, 1);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const body = (json ?? {}) as ApiErrorBody;
      const base = body.error ?? res.statusText ?? `HTTP ${res.status}`;
      // `detail` só é texto humano garantido no código de transição
      // (`git-failed`, ainda sem `code` específico); os códigos novos
      // (`not-ff`, `conflict`, `base-not-checked-out`, `base-in-use`,
      // `no-commits`, `invalid-name`, …) já vêm com `error` pt-BR completo —
      // `detail` neles é ruído de stderr, não mensagem pro usuário.
      const message = body.code === 'git-failed' && body.detail ? `${base} · ${body.detail}` : base;
      throw new CliError(message, 1, body.code);
    }

    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }

  /** `PATCH` — hoje só o ambiente do workspace (`bridge new --env`). */
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body ?? {});
  }

  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

}
