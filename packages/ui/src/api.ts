/** Wrapper fino de fetch: adiciona o bearer e lança no primeiro erro não-2xx. */

/**
 * Erro de rota. Além do status, carrega o `code`/`detail` que o core manda no
 * corpo (`{ error, code, detail }`): as recusas de git da spec §7 só são
 * tratáveis por código — `not-ff` faz o menu oferecer o merge com commit,
 * `exists` vira a frase do diálogo de tarefa — e a mensagem em pt-BR do core
 * não é contrato pra `if`.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let currentToken: string | undefined;

export function setToken(token: string | undefined): void {
  currentToken = token;
}

export function getToken(): string | undefined {
  return currentToken;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let message = `Erro ${res.status}`;
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string; detail?: string };
      if (data.error) message = data.error;
      code = data.code;
      detail = data.detail;
    } catch {
      // corpo não era JSON — mantém a mensagem genérica.
    }
    throw new ApiError(message, res.status, code, detail);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
