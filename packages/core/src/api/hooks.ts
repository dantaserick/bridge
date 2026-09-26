import { t } from '@bridge/shared';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { detailStuck, isDeliberateSessionEnd, isSessionEndExit } from '../adapters/claude.js';
import { asRecord, asString } from '../adapters/payload.js';
import type { Core } from '../core.js';
import { resumeOutcomeOf } from '../recap.js';

interface HookParams {
  sessionId: string;
  event: string;
}

/**
 * Forma dos parâmetros da rota de hook (R2). O id de sessão do Bridge é
 * `sess_<12 hex>` e os eventos do Claude Code são identificadores simples
 * (`Stop`, `PreToolUse`, `StatusLine`). Nada legítimo sai disso — e é
 * exatamente esse "cru" que virava nome de arquivo (BR-02).
 */
export const HOOK_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const HOOK_EVENT = /^[A-Za-z]{1,40}$/;

/**
 * Id de conversa do AGENTE (`session_id` do payload), que vira
 * `claude --resume <id>` na próxima subida (BR-06). Não pode começar com `-`:
 * o argv é array (não há injeção de shell), mas um valor que começa com hífen
 * é injeção de ARGUMENTO no parser do agente.
 */
export const AGENT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Teto do dump de debug por sessão: passou disso, para de gravar (BR-02b). */
export const HOOK_DUMP_MAX_BYTES = 8 * 1024 * 1024;

function debugLog(core: Core, sessionId: string, event: string, payload: unknown): void {
  if (process.env.BRIDGE_DEBUG_HOOKS !== '1') return;
  try {
    const logsDir = core.deps.profile.logsDir;
    mkdirSync(logsDir, { recursive: true });
    // Cinto e suspensório: o `sessionId` já passou pelo regex da rota, mas o
    // caminho ainda é conferido contra o `logsDir` antes de qualquer escrita —
    // uma rota futura que esqueça a validação não vira escrita de arquivo
    // arbitrário de novo.
    const file = resolve(logsDir, `hooks-${basename(sessionId)}.jsonl`);
    if (!file.startsWith(resolve(logsDir) + sep)) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size >= HOOK_DUMP_MAX_BYTES) return;
    const line = `${JSON.stringify({ at: Date.now(), sessionId, event, payload })}\n`;
    appendFileSync(file, line);
  } catch (err) {
    // um log que falha não pode derrubar o hook do agente.
    core.deps.log.child('hooks').warn('falhou ao gravar o dump de hook', { sessionId, event, err });
  }
}

/**
 * Rota que o shim (`bridge-hook.cjs`) bate a cada evento de hook do Claude
 * Code. Nunca some com o processo do agente: qualquer sessão desconhecida ou
 * adaptador ausente responde `{}` em vez de erro.
 */
export function registerHooks(app: FastifyInstance, core: Core): void {
  app.post('/hooks/:sessionId/:event', async (req: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) => {
    const { sessionId, event } = req.params;
    // R2: forma dos parâmetros ANTES de qualquer uso (log, `join`, banco).
    if (!HOOK_SESSION_ID.test(sessionId) || !HOOK_EVENT.test(event)) {
      reply.code(400).send({ error: t(core.language(), 'core.erro.hookParametroInvalido') });
      return;
    }
    const payload = req.body;
    debugLog(core, sessionId, event, payload);

    const found = core.deps.sessions.get(sessionId);
    if (!found) {
      reply.send({});
      return;
    }

    /**
     * Spec §5 — o hook que chega numa sessão de SHELL.
     *
     * Ele só existe porque o wrapper da sessão (Task 1) fez o `claude` que a
     * pessoa digitou subir com o `--settings` do Bridge. A chegada dele É a
     * promoção: a sessão vira hospedeira e, daqui pra baixo, o evento segue o
     * MESMO caminho de uma sessão de agente.
     *
     * Com `sessions.hostedAgents` desligada nada disso acontece e a rota volta
     * ao que era antes da 0.12.0 — `{}` e nenhum efeito.
     */
    let session = found;
    // Shell já `exited` não é promovido: o PTY morreu, e um hook atrasado (o
    // shim do Claude que estava lá dentro chegando depois do fim) marcaria como
    // hospedeira uma sessão que não existe mais — ocupando um slot do teto e
    // pintando a linha da sidebar de `claude` até o app reiniciar.
    if (session.kind === 'shell' && !session.hosted && session.state !== 'exited') {
      /**
       * O interruptor só decide PROMOÇÃO, não interrompe hospedagem em curso
       * (fix round 1). Desligar `sessions.hostedAgents` no diálogo com um
       * Claude aberto dentro do shell e barrar a rota aqui prenderia a marca
       * para sempre: o `SessionEnd` nunca chegaria ao `noteHostedEnd`, e o
       * painel ficaria dizendo "claude" — e ocupando um slot do teto — até o
       * PTY morrer. Hospedagem em curso termina sozinha, pelo caminho normal.
       */
      if (!core.deps.profile.config.sessions.hostedAgents) {
        reply.send({});
        return;
      }
      core.noteHosted(sessionId, 'claude');
      // Relido: a promoção acabou de trocar o objeto no mapa, e o resto da rota
      // (adaptador, guarda, estado) tem que enxergar a sessão com a marca.
      session = core.deps.sessions.get(sessionId) ?? session;
      if (!session.hosted) {
        reply.send({});
        return;
      }
    }

    // Numa hospedeira quem manda é o agente HOSPEDADO (`session.agent` é
    // `undefined`: a sessão continua sendo um shell).
    const agentId = session.hosted?.agent ?? session.agent;
    const adapter = agentId ? core.deps.adapters[agentId] : undefined;
    if (!adapter) {
      reply.send({});
      return;
    }

    // Todo hook do Claude Code (inclusive a statusline) carrega o `session_id`
    // DELE. É a única forma de o Bridge saber qual conversa mora neste painel
    // — e o que vira `claude --resume <id>` quando o app reabre. Fica ANTES do
    // desvio da statusline, que responde e sai; e antes de qualquer decisão de
    // estado, porque o id vale mesmo num evento que o adaptador ignora.
    //
    // BR-06: só grava id com FORMA de id. Um `session_id` hostil
    // (`--dangerously-skip-permissions`) ficaria no SQLite e voltaria como
    // argumento do agente no próximo `--resume`.
    const agentSessionId = asString(asRecord(payload).session_id)?.trim();
    if (agentSessionId && AGENT_SESSION_ID.test(agentSessionId)) core.noteAgentSessionId(sessionId, agentSessionId);

    /**
     * Dor verificada #3 — o `--resume` que volta VAZIO.
     *
     * O `SessionStart` é o único momento em que dá pra saber: ele traz o
     * `session_id` que o agente adotou e o `source` (`resume`, `startup`,
     * `clear`, `compact`). Se o painel pediu uma conversa e o agente abriu
     * outra, isso vira `resumeOutcome: 'fresh'` — e é a faixa "a conversa
     * anterior não foi retomada" do painel.
     *
     * Fica ANTES do `onHook`: o veredito é sobre a subida, e não pode depender
     * de o adaptador ter opinião sobre este evento.
     *
     * O `noteResumeOutcome` é chamado MESMO com veredito `undefined` (payload
     * sem `session_id` e sem `source`). É a chegada do primeiro `SessionStart`
     * que fecha a janela do julgamento: antes da fix round 1 a trava era o
     * `resumeOutcome` já gravado, e um primeiro `SessionStart` mudo deixava o
     * `/clear` seguinte (`source: 'clear'`) virar `'fresh'` — o alarme falso
     * que a regra do "sem id e sem source" existe justamente pra evitar.
     */
    if (event === 'SessionStart') {
      core.noteResumeOutcome(
        sessionId,
        resumeOutcomeOf(session.resumeRequested, {
          sessionId: agentSessionId,
          source: asString(asRecord(payload).source),
        }),
      );
    }

    if (event === 'StatusLine') {
      if (!adapter.statusLine) {
        reply.send({});
        return;
      }
      const result = await adapter.statusLine(payload, session, core.language());
      if (result.quota) {
        core.deps.sessions.setQuota(sessionId, result.quota);
        core.deps.db.quota.set(sessionId, result.quota);
        // ADR-012: as janelas de cota do payload são do USUÁRIO, não da
        // sessão — a mesma assinatura vale pros cinco painéis abertos. Elas
        // saem do snapshot por sessão e viram o estado global do monitor de
        // uso, e o `usage.changed` só é emitido quando alguma janela MUDOU
        // (a statusline é redesenhada várias vezes por segundo).
        const limits = core.deps.usage.noteLimits(result.quota);
        if (limits) core.deps.bus.emit({ type: 'usage.changed', limits });
      }
      reply.type('text/plain').send(result.line);
      return;
    }

    /**
     * Dor verificada #1 — a saída NORMAL do estado `server-limited`.
     *
     * `UserPromptSubmit` e `Stop` são a prova de que o turno voltou a andar:
     * um é o usuário mandando texto novo, o outro é o agente terminando. Fica
     * ANTES do `onHook` porque o adaptador já devolve o estado certo desses
     * dois eventos — limpar depois desfaria o que ele acabou de decidir.
     */
    if (event === 'Stop' || event === 'UserPromptSubmit') core.clearServerLimit(sessionId);

    // ─── início: guarda de escopo entre worktrees (dor verificada #4) ───────
    /**
     * O `PreToolUse` é o ÚNICO hook do Claude Code que aceita uma decisão de
     * permissão na resposta — e é por isso que a guarda mora aqui e não no
     * adaptador: ela depende do workspace da sessão (a raiz permitida) e do
     * `config`, coisas que `claudeAdapter.onHook` não enxerga.
     *
     * O `return` é ANTES do `onHook` de propósito. A ferramenta recusada não
     * vai rodar, então marcar a sessão como "running · Read arquivo.ts"
     * mostraria na sidebar um trabalho que não aconteceu; e o corpo da
     * resposta é o `deny` inteiro, sem mistura com o `reply` do adaptador
     * (que é `{}` neste evento).
     */
    if (event === 'PreToolUse') {
      const deny = core.checkScope(sessionId, payload);
      if (deny) {
        reply.send(deny);
        return;
      }
    }
    // ─── fim: guarda de escopo ──────────────────────────────────────────────

    /**
     * Spec §5 — o fim da hospedagem.
     *
     * Numa sessão de agente este mesmo evento vira `exited` (o adaptador
     * decide). Numa hospedeira isso seria mentira: quem saiu foi o Claude, e o
     * PTY do shell continua ali, com o prompt de volta. Por isso o desvio é
     * ANTES do `onHook` — a única saída correta é desfazer a hospedagem, e não
     * há nada do adaptador a aproveitar num evento cujo veredito já está dado.
     */
    if (event === 'SessionEnd' && session.hosted && isSessionEndExit(payload)) {
      core.noteHostedEnd(sessionId);
      reply.send({});
      return;
    }

    // 13/09/2026 — a única prova de que o dono fechou a conversa de dentro do
    // agente (`/exit`, logout). A morte do PTY sozinha não prova nada: crash e
    // saída de auto-update chegam ali do mesmo jeito, e o painel tem que voltar.
    if (event === 'SessionEnd' && isDeliberateSessionEnd(payload)) core.noteAgentEndedByUser(sessionId);

    // O idioma é perguntado AGORA, no evento: um `PATCH /api/config` entre
    // dois hooks faz a próxima notificação já sair no idioma novo.
    const lang = core.language();
    const outcome = adapter.onHook(event, payload, session, lang);
    if (outcome.blockedStop && core.deps.sessions.blockedStop(sessionId)) {
      core.deps.sessions.apply(sessionId, { state: 'stuck', detail: detailStuck(lang) });
      core.deps.notifications.push(sessionId, 'stuck', t(lang, 'core.notificacao.loopStop'));
    } else if (outcome.change) {
      core.deps.sessions.apply(sessionId, outcome.change);
    }
    // O contador de Stops bloqueados mede UM turno travado em loop. Zera no
    // Stop limpo e também quando o user manda um prompt novo: o turno anterior
    // acabou, e herdar a contagem faria a sessão nova nascer perto do `stuck`.
    if ((event === 'Stop' && !outcome.blockedStop) || event === 'UserPromptSubmit') {
      core.deps.sessions.resetBlockedStops(sessionId);
    }
    // Spec §6: o `+N ~M` do worktree é atualizado NA HORA quando o agente
    // para — é o instante em que o commit dele acabou de acontecer. Sem
    // `await`: a resposta do hook não pode esperar dois processos de git.
    if (event === 'Stop') {
      void core.refreshGit(session.workspaceId).catch((err: unknown) => {
        core.deps.log.child('git').warn('refresh após Stop falhou', { workspaceId: session.workspaceId, err });
      });
    }
    if (outcome.notification) {
      core.deps.notifications.push(sessionId, outcome.notification.kind, outcome.notification.text);
    }
    reply.send(outcome.reply ?? {});
  });
}
