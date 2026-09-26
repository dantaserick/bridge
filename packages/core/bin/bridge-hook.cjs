#!/usr/bin/env node
'use strict';

// Shim invocado pelo Claude Code a cada hook/statusline. Roda dentro do
// processo do agente: NUNCA pode travar, nunca pode escrever lixo em stderr
// que confunda o agente, e nunca pode sair com código != 0 — por contrato,
// qualquer falha (rede, porta fechada, timeout, JSON quebrado) vira um
// `{}` silencioso (ou linha vazia no StatusLine) e `exit(0)`.

const http = require('node:http');

const MAX_STDIN_BYTES = 1024 * 1024;
// Orçamento de hook: o Claude Code fica bloqueado neste processo enquanto ele
// não sai, então o teto tem que ser curto — mas grande o bastante pra o core
// responder. Desde a ADR-012 não há processo externo nesse caminho (a
// statusline é montada em memória, em `src/quota.ts`), então 5 s é folga; se o
// shim desistisse antes do core, toda statusline lenta sairia vazia.
const TIMEOUT_MS = 5000;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    process.stdin.on('data', (chunk) => {
      if (total >= MAX_STDIN_BYTES) return;
      const remaining = MAX_STDIN_BYTES - total;
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(piece);
      total += piece.length;
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

function main() {
  const sessionId = process.argv[2];
  const event = process.argv[3];
  const isStatusLine = event === 'StatusLine';

  const exitOk = (out) => {
    if (out) process.stdout.write(out);
    process.exit(0);
  };
  const exitFail = () => exitOk(isStatusLine ? '' : '{}');

  const port = process.env.BRIDGE_PORT;
  const token = process.env.BRIDGE_TOKEN;
  if (!port || !token || !sessionId || !event) {
    exitFail();
    return;
  }

  readStdin()
    .then((stdin) => {
      const body = stdin && stdin.length > 0 ? stdin : '{}';
      const path = `/hooks/${encodeURIComponent(sessionId)}/${encodeURIComponent(event)}?token=${encodeURIComponent(token)}`;

      let settled = false;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(port),
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body, 'utf8'),
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            // 4xx/5xx (token errado, rota fora do ar): o corpo é um JSON de
            // erro do core, nunca a resposta que o hook espera. Ecoar isso
            // faria o agente ler `{"error":...}` como diretiva de hook —
            // trata como falha e devolve o `{}`/linha vazia do contrato.
            if (res.statusCode >= 400) {
              exitFail();
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (isStatusLine) {
              exitOk(text);
              return;
            }
            if (text) {
              try {
                JSON.parse(text);
                exitOk(text);
                return;
              } catch {
                // corpo não é JSON válido — cai no {} abaixo.
              }
            }
            exitOk('{}');
          });
        },
      );

      req.on('timeout', () => {
        if (settled) return;
        settled = true;
        req.destroy();
        exitFail();
      });
      req.on('error', () => {
        if (settled) return;
        settled = true;
        exitFail();
      });

      req.write(body);
      req.end();
    })
    .catch(() => exitFail());
}

try {
  main();
} catch {
  process.stdout.write(process.argv[3] === 'StatusLine' ? '' : '{}');
  process.exit(0);
}
