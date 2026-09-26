import { t, type Language } from '@bridge/shared';
import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Caminho canônico pra decidir QUEM autentica. Tem que ser feito antes de
 * qualquer comparação: `//api/state` e `/api%2Fstate` chegam em `req.raw.url`
 * exatamente assim, não casam com `startsWith('/api/')` e cairiam no estático
 * SEM bearer — a API inteira vazando por uma rota pública.
 *
 * Devolve null quando o percent-encoding é inválido: aí não dá pra saber o que
 * o caminho é, e o único desfecho seguro é 400.
 */
export function normalizePath(rawUrl: string): string | null {
  const noFragment = rawUrl.split('#', 1)[0] ?? '';
  const qIndex = noFragment.indexOf('?');
  const raw = qIndex === -1 ? noFragment : noFragment.slice(0, qIndex);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Barras repetidas primeiro: `posix.normalize` PRESERVA `//` no início.
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  const normalized = posix.normalize(collapsed === '' ? '/' : collapsed);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** Só o caminho de uma URL crua: sem query, sem fragmento, sem decodificar nada. */
export function rawPathOf(rawUrl: string): string {
  const noFragment = rawUrl.split('#', 1)[0] ?? '';
  const qIndex = noFragment.indexOf('?');
  return qIndex === -1 ? noFragment : noFragment.slice(0, qIndex);
}

/**
 * Separador de caminho ESCONDIDO dentro de um segmento (`%2F`, `%5C`) — e a
 * barra invertida crua, que nenhum caminho legítimo do Bridge usa.
 *
 * BR-01: o roteador do Fastify parte a URL CRUA em `/` e só depois decodifica
 * cada parâmetro; o hook de auth decidia sobre o caminho NORMALIZADO. Os dois
 * discordam sempre que um `%2F` aparece num parâmetro, e aí
 * `POST /hooks/<id>/x%2F..%2F..%2FStop` "sai" do prefixo `/hooks` pro hook de
 * auth (nenhuma autenticação roda) e continua casando a rota pro roteador (o
 * handler roda). Como nenhum caminho legítimo — nem da UI, nem do shim, nem da
 * CLI — carrega separador codificado, a resposta certa é 400 antes de tudo.
 */
const ENCODED_SEPARATOR = /%2f|%5c/i;

function hasHiddenSeparator(rawPath: string): boolean {
  return ENCODED_SEPARATOR.test(rawPath) || rawPath.includes('\\');
}

/**
 * O request-target tem que estar em ORIGIN-FORM (começar com `/`).
 *
 * BR-01, segunda metade (re-review): o HTTP/1.1 aceita quatro formas de
 * request-target, e a ABSOLUTE-FORM é legal numa requisição comum:
 *
 *   GET http://127.0.0.1:4560/api/state HTTP/1.1
 *
 * O Node entrega isso em `req.raw.url` **exatamente assim**, então a
 * classificação via prefixo lia `h` no começo e dizia `public` — enquanto o
 * find-my-way normaliza a absolute-form pro caminho e roteava `/api/state`
 * normalmente. Resultado medido pelo revisor: `GET /api/state` sem token e com
 * `Origin` hostil devolvia 200, e `POST /hooks/<sid>/Stop` e
 * `POST /api/sessions` chegavam ao handler.
 *
 * A normalização não salva: `posix.normalize('http://…/api/state')` vira
 * `/http:/127.0.0.1:4560/api/state`, que também não casa prefixo protegido —
 * as DUAS classificações concordavam em `public`, então nem o default-deny
 * pegava.
 *
 * Todo cliente do Bridge (a UI pelo `fetch`, o shim pelo `http.request` com
 * `path:`, a CLI e o main do Electron) emite origin-form. Absolute-form,
 * authority-form (`CONNECT host:port`) e asterisk-form (`OPTIONS *`) não têm
 * uso legítimo aqui — 400 antes de qualquer classificação.
 */
function isOriginForm(rawUrl: string): boolean {
  return rawUrl.startsWith('/');
}

/** Prefixo casado por segmento: `/apiece` não é `/api`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

type Zone = 'api' | 'ws' | 'hooks' | 'public';

function zoneOf(path: string): Zone {
  if (underPrefix(path, '/api')) return 'api';
  if (underPrefix(path, '/ws')) return 'ws';
  if (underPrefix(path, '/hooks')) return 'hooks';
  return 'public';
}

/**
 * Zona EFETIVA do pedido, default-deny (R1): o caminho é classificado duas
 * vezes — pelo que o roteador vê (cru) e pelo que a normalização diz — e basta
 * UM dos dois apontar pra uma zona protegida pra ela valer. Assim nenhuma
 * discordância entre os dois parsers vira rota sem autenticação; o preço é
 * `/estatico/../api/x` cair no ramo do `/api` (401), que é o desfecho certo.
 *
 * Quando os dois apontam pra zonas protegidas DIFERENTES não há desfecho
 * seguro: o chamador responde 400.
 */
export function effectiveZone(rawPath: string, normalized: string): Zone | 'ambiguo' {
  const raw = zoneOf(rawPath);
  const norm = zoneOf(normalized);
  if (raw === norm) return raw;
  if (raw === 'public') return norm;
  if (norm === 'public') return raw;
  return 'ambiguo';
}

function parseTokenParam(req: FastifyRequest): string | undefined {
  const url = req.raw.url ?? '';
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return undefined;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  return params.get('token') ?? undefined;
}

function bearerFrom(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * A UI do Bridge é servida de `http://127.0.0.1:<porta>` (Vite em dev, o
 * shell Electron depois). Qualquer outra origem batendo no `/ws` — ou em
 * `/api` (R12 da Fase 3) — é uma página de terceiro tentando usar o token
 * vazado. O WebSocket do browser não é barrado por CORS, e um `POST` de
 * formulário/`fetch` simples também sai antes do preflight, então a checagem
 * tem que ser explícita aqui. Cliente sem Origin (o `ws` do Node, a CLI, o
 * shim, o main do Electron) passa: quem não é browser não forja origem.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** `true` = tem `Origin` e ela NÃO é loopback (a única razão pra 403). */
function foreignOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && !LOOPBACK_ORIGIN.test(origin);
}

/**
 * Único ponto de autenticação do core. `/api/*` e `/ws` exigem o bearer (o
 * `/ws` também aceita `?token=` pois um cliente WebSocket de browser não
 * consegue mandar header custom no handshake) e recusam com 403 um `Origin`
 * fora do loopback; `/hooks/*` exige `?token=` e recusa qualquer chamada com
 * header Origin (só o shim local, nunca um browser, deve conseguir bater
 * nessa rota).
 *
 * A classificação é DEFAULT-DENY (`effectiveZone`): vale a união do que o
 * caminho cru (o que o roteador enxerga) e o normalizado dizem, e um prefixo
 * protegido sempre cai no ramo de autenticação — nunca no estático, com ou sem
 * `uiDir`. Separador de caminho codificado (`%2F`/`%5C`) e barra invertida são
 * 400 antes de qualquer classificação.
 *
 * Qualquer outro caminho é o renderer: quando o core serve a UI (`hasUi`) ele
 * passa direto pro estático, SEM bearer — a página precisa carregar antes de
 * ter o token, que só chega depois pelo preload do Electron (ou pela tela de
 * token na web). Arquivo inexistente vira 404 do próprio estático. Sem UI
 * (`dev:core`, testes), o comportamento é o de sempre: 404 aqui mesmo.
 */
export function registerAuth(
  app: FastifyInstance,
  token: string,
  hasUi: boolean,
  /**
   * O idioma em vigor (spec §13). É função, e não valor, porque o hook vive
   * enquanto o core vive e a resposta tem que sair no idioma de AGORA.
   */
  language: () => Language,
): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = req.raw.url ?? '';
    // BR-01 (re-review): request-target fora da origin-form é 400 antes de
    // tudo. A absolute-form (`GET http://127.0.0.1:<porta>/api/state`) era lida
    // como caminho público aqui e como `/api/state` pelo roteador.
    if (!isOriginForm(rawUrl)) {
      reply.code(400).send({ error: t(language(), 'core.erro.caminhoInvalido') });
      return;
    }
    const rawPath = rawPathOf(rawUrl);
    // BR-01: separador codificado é sempre 400 — antes de classificar, antes
    // do roteador. É o que impede o hook e o find-my-way de discordarem.
    if (hasHiddenSeparator(rawPath)) {
      reply.code(400).send({ error: t(language(), 'core.erro.caminhoInvalido') });
      return;
    }
    const path = normalizePath(rawUrl);
    if (path === null) {
      reply.code(400).send({ error: t(language(), 'core.erro.caminhoInvalido') });
      return;
    }
    const zone = effectiveZone(rawPath, path);
    if (zone === 'ambiguo') {
      reply.code(400).send({ error: t(language(), 'core.erro.caminhoInvalido') });
      return;
    }

    if (zone === 'api') {
      // MESMA regra do `/ws`: uma página de terceiro que descobriu o token
      // (log colado, extensão curiosa) não pode dirigir a API — e sem esta
      // linha o CORS não segura nada, porque a resposta ser ilegível pra ela
      // não desfaz o efeito colateral do `POST` que já rodou.
      if (foreignOrigin(req)) {
        reply.code(403).send({ error: t(language(), 'core.erro.originNaoPermitida') });
        return;
      }
      if (bearerFrom(req) !== token) {
        reply.code(401).send({ error: t(language(), 'core.erro.tokenInvalido') });
      }
      return;
    }

    if (zone === 'ws') {
      if (foreignOrigin(req)) {
        reply.code(403).send({ error: t(language(), 'core.erro.originNaoPermitida') });
        return;
      }
      const provided = bearerFrom(req) ?? parseTokenParam(req);
      if (provided !== token) {
        reply.code(401).send({ error: t(language(), 'core.erro.tokenInvalido') });
      }
      return;
    }

    if (zone === 'hooks') {
      if (req.headers.origin) {
        reply.code(403).send({ error: t(language(), 'core.erro.hooksSomenteLocal') });
        return;
      }
      if (parseTokenParam(req) !== token) {
        reply.code(401).send({ error: t(language(), 'core.erro.tokenInvalido') });
      }
      return;
    }

    if (!hasUi) reply.code(404).send();
  });
}
