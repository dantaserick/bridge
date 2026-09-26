/**
 * Dor verificada #3, lado da UI — a faixa "a conversa anterior não foi
 * retomada" e o texto que o botão escreve no prompt do agente.
 *
 * O core faz o diagnóstico (`session.resumeOutcome === 'fresh'`) e produz o
 * resumo (`POST /api/sessions/:id/recap`). Aqui mora o que é decisão de
 * INTERFACE: quando a faixa aparece, o que ela diz, e como o resumo vira uma
 * frase que faz sentido pro agente novo ler.
 */
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';
import type { BridgeConfig, Language, Session } from '@bridge/shared';
import { tUi } from './i18n.js';

/**
 * O que a faixa diz. Uma frase, sem jargão: o dono acabou de perder contexto.
 *
 * É FUNÇÃO, e não constante, pela mesma razão que matou as `ENVIRONMENT_*` na
 * Task 1: constante é avaliada uma vez, na importação, e a troca de idioma é
 * ao vivo.
 */
export function recapBannerText(lang: Language): string {
  return tUi(lang, 'recap.faixa');
}

export function recapActionLabel(lang: Language): string {
  return tUi(lang, 'recap.reabrir');
}

export function recapActionTitle(lang: Language): string {
  return tUi(lang, 'recap.reabrir.titulo');
}

export function recapDismissLabel(lang: Language): string {
  return tUi(lang, 'recap.ignorar');
}

export function recapDismissTitle(lang: Language): string {
  return tUi(lang, 'recap.ignorar.titulo');
}

/**
 * O que o botão escreve no prompt do agente, em volta do resumo.
 *
 * UMA LINHA, e isto não é estilo: o texto vai pro PTY por
 * `POST /api/sessions/:id/input`, sem bracketed paste. Um `\n` no meio dele
 * seria um Enter, e o agente receberia o cabeçalho sozinho como se fosse o
 * pedido inteiro. O core já devolve o resumo em linha única (`sanitizeDisplay`
 * colapsa controle em espaço); aqui a mesma disciplina vale pros rótulos.
 *
 * O `\r` do fim é o Enter deliberado — é o único, e vem depois do texto todo.
 *
 * O RESUMO no meio (`text`) vem do CORE, já no idioma configurado — a UI não o
 * retraduz. O prefixo e o sufixo são copy da UI, e caem no mesmo idioma porque
 * os dois lados resolvem do mesmo `languageResolved`.
 */
export function composeRecapPrompt(text: string, lang: Language): string {
  return `${tUi(lang, 'recap.prompt.prefixo')}${text}${tUi(lang, 'recap.prompt.sufixo')}`;
}

/** O prompt MAIS o Enter — o que vai literalmente pro PTY. */
export function recapInput(text: string, lang: Language): string {
  return `${composeRecapPrompt(text, lang)}\r`;
}

/**
 * A faixa aparece neste painel?
 *
 * Três condições, e a terceira é o "Ignorar": a sessão é de agente, o core
 * disse `'fresh'`, e o dono ainda não dispensou a faixa DESTA sessão. Sessão
 * encerrada não mostra nada — não há prompt onde escrever.
 *
 * `dismissed` é por `session.id` (não por painel): o painel sobrevive à
 * sessão, e um resume vazio no MESMO painel meia hora depois é outro aviso,
 * que merece aparecer de novo.
 */
export function showsRecapBanner(session: Session | undefined, dismissed: ReadonlySet<string>): boolean {
  if (!session || session.kind !== 'agent') return false;
  if (session.state === 'exited') return false;
  if (session.resumeOutcome !== 'fresh') return false;
  return !dismissed.has(session.id);
}

/**
 * A injeção automática (`sessions.autoRecap`) deve rodar agora?
 *
 * Mesma regra da faixa MAIS três coisas: a configuração ligada, a sessão ainda
 * não atendida (`injected`) e o terminal dela já ter falado (`sawOutput`).
 *
 * Config ausente — o `GET /api/config` que ainda não voltou — cai no default de
 * `@bridge/shared`, que é desligado: na dúvida, o Bridge não escreve no
 * terminal de ninguém.
 *
 * O `sawOutput` é a correção da fix round 1. O gatilho desta injeção é o
 * `session.updated` do `SessionStart`, e o `SessionStart` do Claude Code pode
 * chegar ANTES de a TUI dele estar aceitando texto: o resumo escrito nessa
 * janela é engolido pela metade, exatamente como acontecia com o comando
 * inicial de painel antes de o core passar a esperar o primeiro `pty.data`
 * (`writeInitialCommand`). O core marca `Session.sawOutput` no primeiro byte
 * do PTY e emite `session.updated`; este efeito roda de novo aí.
 *
 * O BOTÃO não passa por aqui (`showsRecapBanner` não olha `sawOutput`): quem
 * clicou está vendo a tela, e a faixa não pode sumir esperando um byte.
 */
export function shouldAutoInjectRecap(
  session: Session | undefined,
  config: BridgeConfig | undefined,
  dismissed: ReadonlySet<string>,
  injected: ReadonlySet<string>,
): boolean {
  const on = config?.sessions?.autoRecap ?? DEFAULT_STORED_CONFIG.sessions.autoRecap;
  if (!on) return false;
  if (!showsRecapBanner(session, dismissed)) return false;
  if (session?.sawOutput !== true) return false;
  return !injected.has(session.id);
}

/**
 * A linha de status quando o resumo não deu. O `{detalhe}` é o `error.message`
 * do core, que já vem traduzido — a UI só o embrulha.
 */
export function recapFailureMessage(err: unknown, lang: Language): string {
  const detail = err instanceof Error ? err.message : String(err);
  return tUi(lang, 'recap.erro', { detalhe: detail });
}

/** A linha de status do caminho feliz. */
export function recapSentMessage(chars: number, lang: Language): string {
  return tUi(lang, 'recap.enviado', { n: chars });
}
