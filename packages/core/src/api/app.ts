import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core.js';
import { registerAuth } from './auth.js';
import { registerHooks } from './hooks.js';
import { registerRoutes } from './routes.js';
import { registerWs } from './ws.js';

/**
 * Parser de `application/json` que aceita CORPO VAZIO.
 *
 * O parser default do Fastify recusa `content-type: application/json` com body
 * `''` (400 `FST_ERR_CTP_EMPTY_JSON_BODY`), e várias rotas do Bridge não
 * recebem corpo nenhum (`POST /api/workspaces/:id/git/refresh`,
 * `POST /api/shutdown`). Qualquer cliente honesto — `fetch` com
 * `headers: { 'Content-Type': 'application/json' }`, a CLI da Fase 4, um
 * `curl -X POST -H` — mandava o header e levava 400 numa rota sem parâmetro.
 * Corpo vazio vira `{}`; JSON quebrado continua sendo 400.
 */
export function registerJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });
}

/**
 * Cabeçalhos de segurança da UI (BR-10). A página roda no renderer que tem o
 * `preload` com `bridge.token()`: qualquer script que execute nessa origem pega
 * o token do core, ou seja, execução de comando. Hoje não há sink de HTML na UI
 * (nenhum `dangerouslySetInnerHTML`/`innerHTML` no repo), então isto é defesa em
 * profundidade contra um bug futuro de renderização.
 *
 * `'unsafe-inline'` em `style-src` e NÃO em `script-src`: o xterm injeta estilo
 * inline (é como ele posiciona o cursor e pinta as células), mas nenhum script
 * inline é necessário — o bundle do Vite sai em arquivo.
 *
 * `connect-src` precisa de `ws:`/`http:` de loopback: é a própria API e o `/ws`.
 */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const UI_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': UI_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Teto da mensagem de ENTRADA do WebSocket (BR-11). O default do `ws` é 100 MB:
 * um cliente com token mandava um frame único desse tamanho, o `ws` acumulava e
 * o `JSON.parse` duplicava. A maior mensagem legítima é `input` de um colar
 * grande no terminal — 1 MB é folga de sobra.
 */
export const WS_MAX_PAYLOAD = 1024 * 1024;

/** Monta o Fastify: plugin de websocket, auth, as três famílias de rota e, quando há build da UI, o estático. */
export function registerApp(app: FastifyInstance, core: Core): void {
  const uiDir = core.deps.uiDir;
  registerJsonParser(app);
  app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  registerAuth(app, core.deps.token, uiDir !== undefined, core.language);
  registerRoutes(app, core);
  registerHooks(app, core);
  registerWs(app, core);
  if (uiDir !== undefined) {
    // `decorateReply: false` porque nada nas rotas usa `reply.sendFile()` — o
    // estático é só o renderer, servido em `/` com `index.html` no diretório.
    app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      decorateReply: false,
      setHeaders: (reply) => {
        for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) reply.header(name, value);
      },
    });
  }
}
