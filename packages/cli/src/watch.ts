/**
 * `bridge watch` — os eventos do `/ws` do core saindo no terminal, um por
 * linha, até `Ctrl+C`.
 *
 * Por que existe (BACKLOG, "Ideias"): o filtro `?events=` já existia no `/ws`
 * pro processo main do Electron, mas nada fora da UI conseguia olhar o
 * barramento. Um agente rodando dentro de um painel — ou o dono depurando um
 * hook que não dispara — não tinha como responder "o core está emitindo isso?"
 * sem abrir a janela.
 *
 * Zero dependência, como o resto da CLI: o `WebSocket` é global no Node 22+.
 * Ele não manda header custom no handshake, então o token vai por `?token=`,
 * que é o caminho que o `/ws` já aceita pelo mesmo motivo (ver `auth.ts` do
 * core). O token NÃO é impresso: a linha de status mostra só a porta.
 */
import { t, type Language } from '@bridge/shared';
import type { Flags } from './commands.js';
import { CliError, type Instance } from './client.js';

/** Prefixos de `type` aceitos pelo `?events=` — a mesma lista que o `/ws` filtra. */
function parseEvents(flags: Flags, lang: Language): string[] {
  // Mesma regra do resto da CLI: flag que o comando não declara é erro, não
  // silêncio — `--evets notification` não pode virar "assiste a tudo".
  for (const name of Object.keys(flags)) {
    if (name !== 'events') throw new CliError({ key: 'cli.erro.flagDesconhecida', params: { flag: name } });
  }
  const raw = flags.events;
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new CliError({ key: 'cli.uso.watch' });
  return raw
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== '');
}

/** `12:03:41` — carimbo local, que é o que serve pra casar com o que se viu na tela. */
function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Linha humana de um evento: hora, `type` e o identificador que ele carrega
 * (`id`, `sessionId` ou `workspaceId`), que é o suficiente pra saber de quem
 * ele fala. O corpo inteiro sai com `--json`.
 */
function humanLine(msg: Record<string, unknown>, lang: Language): string {
  const type = typeof msg.type === 'string' ? msg.type : t(lang, 'cli.watch.semType');
  const who = [msg.id, msg.sessionId, msg.workspaceId, msg.tabId].find((v) => typeof v === 'string');
  return `${stamp()}  ${type}${who ? `  ${String(who)}` : ''}`;
}

export interface WatchIo {
  out: (line: string) => void;
  status: (line: string) => void;
}

const DEFAULT_IO: WatchIo = { out: (line) => console.log(line), status: (line) => console.error(line) };

/**
 * Fica ligado até o socket fechar (o `Ctrl+C` fecha por `SIGINT`). Devolve o
 * código de saída: `0` quando o fim foi pedido daqui, `1` quando o core caiu
 * ou recusou a conexão — do mesmo jeito que os outros comandos.
 *
 * A linha de status vai pro STDERR de propósito: assim `bridge watch --json |
 * jq` recebe só os eventos, sem a saudação no meio.
 */
export function cmdWatch(
  instance: Instance,
  flags: Flags,
  json: boolean,
  lang: Language,
  io: WatchIo = DEFAULT_IO,
): Promise<number> {
  const events = parseEvents(flags, lang);
  const query = new URLSearchParams({ token: instance.token });
  if (events.length > 0) query.set('events', events.join(','));

  return new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${instance.port}/ws?${query.toString()}`);
    let closedByUs = false;

    /**
     * Tira os dois handlers de sinal. Roda no `close` (o caminho normal) E no
     * `catch` do `stop` — sem isso, um `socket.close()` que estourasse
     * resolvia a Promise mas deixava `SIGINT`/`SIGTERM` presos ao processo:
     * quem chamasse o `cmdWatch` de dentro de outro comando ficaria com um
     * listener morto por chamada, e o `Ctrl+C` seguinte cairia num socket que
     * já não existe.
     */
    const detach = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };

    const stop = (): void => {
      closedByUs = true;
      try {
        socket.close(1000, 'bridge watch');
      } catch {
        // O `close` estourou: o `onclose` não vem, então a limpeza é aqui.
        detach();
        resolve(0);
      }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    socket.onopen = () => {
      const filtro =
        events.length > 0
          ? t(lang, 'cli.watch.eventos', { eventos: events.join(', ') })
          : t(lang, 'cli.watch.todosEventos');
      io.status(t(lang, 'cli.watch.ligado', { porta: instance.port, filtro }));
    };
    socket.onmessage = (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: Record<string, unknown> | undefined;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        msg = undefined;
      }
      if (json) {
        io.out(text);
      } else if (msg) {
        io.out(humanLine(msg, lang));
      }
    };
    // O `error` do WebSocket não conta o motivo (o evento é anônimo por
    // especificação); quem sabe se foi fechamento pedido ou queda é o `close`.
    socket.onerror = () => undefined;
    socket.onclose = () => {
      detach();
      if (!closedByUs) io.status(t(lang, 'cli.watch.coreFechou'));
      resolve(closedByUs ? 0 : 1);
    };
  });
}
