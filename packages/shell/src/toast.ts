/**
 * Política pura do toast nativo (spec §4). Nada de Electron, WS ou `setTimeout`
 * aqui — só decisões que dão pra testar sem subir janela nenhuma. Quem tem os
 * timers de verdade é o `main.ts`, chamando `coalesce` de novo com um evento
 * `flush` quando a janela de 2 s vence.
 */
import { t } from '@bridge/shared';
import type { BridgeEvent, Language, NotificationKind } from '@bridge/shared';

/** No máximo 1 toast por sessão a cada 2 s (spec §4). */
export const TOAST_WINDOW_MS = 2000;

export interface ToastPayload {
  sessionId: string;
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  body: string;
}

/**
 * Uma sessão com janela de coalescência aberta — o toast LÍDER dessa janela já
 * foi mostrado (é o que abriu a janela); `texts` guarda só as notificações
 * seguintes, que a janela está represando pra virar UM toast resumo.
 */
export interface PendingToast {
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  /** Uma notificação represada por entrada (a que abriu a janela NÃO entra aqui — já saiu na hora). */
  texts: string[];
  /** Instante (epoch ms) em que a janela fecha e o resumo represado (se houver) sai. */
  dueAt: number;
}

/** Uma entrada por sessão com toast pendente. Nunca mutado — `coalesce` sempre devolve uma cópia. */
export type ToastQueue = Map<string, PendingToast>;

export function emptyToastQueue(): ToastQueue {
  return new Map();
}

/**
 * Chegou uma notificação nova que passou pelo critério de toast (`shouldToast`),
 * já com o título resolvido (`Bridge · <workspace>`).
 */
export interface NotifyInput {
  type: 'notify';
  sessionId: string;
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  text: string;
}

/** A janela de 2 s de uma sessão venceu — quem dispara isso é o timer do `main.ts`. */
export interface FlushInput {
  type: 'flush';
  sessionId: string;
}

export type CoalesceInput = NotifyInput | FlushInput;

export interface CoalesceResult {
  /** Presente só numa entrada `flush` com algo pendente pra mostrar. */
  show?: ToastPayload;
  queue: ToastQueue;
}

/**
 * `notification.new` vira toast quando o core mandou `toast: true` — a regra
 * do foco (spec §4: não repetir toast da sessão que já está em foco) já foi
 * aplicada do lado do core (`Notifications.push`); aqui só se olha a flag.
 */
export function shouldToast(event: BridgeEvent): boolean {
  return event.type === 'notification.new' && event.toast === true;
}

/**
 * Política de coalescência (spec §4, ruling do fix round 1): a PRIMEIRA
 * notificação de uma sessão (nenhuma janela ativa, ou a janela anterior já
 * venceu) sai na hora — `show` já vem preenchido — e abre uma janela de 2 s.
 * Notificações seguintes da MESMA sessão que chegam DENTRO dessa janela não
 * mostram nada na hora: só se acumulam (a janela não estica). Quando o
 * `flush` da sessão chega (o `main.ts` agenda um timer real pra `dueAt` no
 * momento em que a janela abriu), sai UM toast resumo só se algo se
 * acumulou: `"<n> avisos · último: <texto>"`, `n` = quantas notificações
 * ficaram represadas (NÃO conta a líder, que já saiu na hora). Sem nada
 * represado, o `flush` não mostra nada — a líder já foi o toast da janela.
 *
 * Depende de `main.ts` sempre agendar o `flush` pra exatamente `dueAt` (um
 * `setTimeout` real): por isso, se uma notificação chegar por `notify` depois
 * de `dueAt` sem que o `flush` correspondente tenha rodado ainda (só possível
 * chamando `coalesce` fora de ordem, não no fluxo real de timers), ela abre
 * uma janela nova como líder — o que estivesse represado na janela vencida se
 * perde. No sistema de verdade isso não acontece: o `flush` sempre corre
 * exatamente em `dueAt`, antes de qualquer `notify` que chegue depois.
 *
 * Pura: nunca muta `queue` nem lê o relógio — `now` vem de fora.
 */
export function coalesce(queue: ToastQueue, input: CoalesceInput, now: number, lang: Language): CoalesceResult {
  const next = new Map(queue);

  if (input.type === 'notify') {
    const pending = next.get(input.sessionId);
    if (pending && now < pending.dueAt) {
      // Dentro da janela de uma líder já mostrada: só acumula.
      next.set(input.sessionId, { ...pending, texts: [...pending.texts, input.text] });
      return { queue: next };
    }
    // Sem janela ativa (ou a anterior já venceu): esta é a líder — sai na hora.
    next.set(input.sessionId, {
      workspaceId: input.workspaceId,
      kind: input.kind,
      title: input.title,
      texts: [],
      dueAt: now + TOAST_WINDOW_MS,
    });
    return {
      show: { sessionId: input.sessionId, workspaceId: input.workspaceId, kind: input.kind, title: input.title, body: input.text },
      queue: next,
    };
  }

  // flush
  const pending = next.get(input.sessionId);
  if (!pending) return { queue: next };
  next.delete(input.sessionId);

  const n = pending.texts.length;
  if (n === 0) return { queue: next }; // nada se acumulou depois da líder — ela já foi o toast.
  const lastText = pending.texts[n - 1] ?? '';
  // O `{texto}` é a notificação, que vem do core (ou de uma OSC do terminal):
  // texto de fora, que sai como está. O resumo em volta dele é copy do shell.
  const body = t(lang, 'shell.toast.resumo', { n, texto: lastText });

  return {
    show: { sessionId: input.sessionId, workspaceId: pending.workspaceId, kind: pending.kind, title: pending.title, body },
    queue: next,
  };
}

/**
 * Badge (spec §4): parte de `hello.state.unread.length`, soma 1 por
 * `notification.new` — a não ser que ela já chegue com `readAt` marcado (o
 * core nunca manda uma `notification.new` assim hoje, mas contar como não
 * lida uma notificação que já veio lida seria errado por definição; a UI
 * (`packages/ui/src/state.ts`) guarda em `unread` só o que ainda não tem
 * `readAt`, então isto espelha o MESMO invariante do lado do main) — e
 * subtrai o tamanho de `ids` por `notification.read`, inclusive quando `ids`
 * traz id desconhecido/repetido, que não pode empurrar a contagem pra
 * negativo (por isso o `Math.max(0, …)`).
 */
export function unreadAfter(count: number, event: BridgeEvent): number {
  if (event.type === 'notification.new') return event.notification.readAt !== undefined ? count : count + 1;
  if (event.type === 'notification.read') return Math.max(0, count - event.ids.length);
  return count;
}

/**
 * Segura uma referência a um toast nativo enquanto ele pode receber clique
 * (o Electron `Notification` não tem dono nenhum além da variável local que o
 * criou — sem isso o GC pode coletar antes do clique chegar). Devolve a
 * função de destravar, pra registrar em `'close'`/`'click'`/`'failed'`.
 */
export function trackToast<T>(live: Set<T>, item: T): () => void {
  live.add(item);
  return () => {
    live.delete(item);
  };
}

/**
 * Teto de texto do toast nativo (auditoria, item 7 da checklist de UI).
 *
 * `title`/`body` chegam de uma sequência OSC 9/777/99 impressa no terminal —
 * ou seja, do processo do painel (A2), não do dono. O Electron escapa os
 * campos ao montar o XML do toast do Windows; o que faltava era limite de
 * tamanho.
 */
export function truncateToastText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
