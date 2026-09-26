import { z } from 'zod';
import {
  LANGUAGE_SETTINGS,
  isSafeRef,
  isValidDistro,
  ptBR,
  t,
  type Language,
  type MessageKey,
} from '@bridge/shared';
import type { FastifyReply } from 'fastify';

/**
 * Nome de ref (`base` de tarefa, base do worktree). A FORMA mora no
 * `@bridge/shared` porque a UI precisa da mesma regra antes de montar a linha
 * do "Ver diff" (BR-04); aqui ela é a porta da API (BR-09), que também põe o
 * teto de tamanho — um `base` de 50 000 chars virava `spawn ENAMETOOLONG`, ou
 * seja, um 500 não tratado.
 */
const refSchema = z.string().min(1).max(255).refine(isSafeRef, {
  message: 'core.erro.refSimples' satisfies MessageKey,
});

/**
 * Comando escrito no PTY logo depois do primeiro byte. É texto que o dono
 * digitaria — mas o único produtor real é o `diffCommand` do "Ver diff", e um
 * `initialCommand` montado a partir de dado hostil (nome de branch) era
 * execução com um clique (BR-04). Caractere de controle e os separadores de
 * comando do shell ficam de fora: quem quiser rodar `a; b` digita no terminal,
 * que é o canal pra isso (`POST /api/sessions/:id/input`).
 */
const CONTROL_CHAR = new RegExp('[\\u0000-\\u001f\\u007f]');
const SHELL_METACHAR = /[;&|`$<>()]/;

/**
 * Teto de entradas de `usage.pricing` (BU-10). A doc do campo já prometia 200;
 * o código não impunha nada, e 10 000 modelos passaram na auditoria — gravados
 * no `config.json` e reparseados em toda subida do core.
 */
export const MAX_PRICING_ENTRIES = 200;

/**
 * Faixa de `sessions.maxConcurrentAgents` (dor verificada #1).
 *
 * O piso é 1 — "nenhum agente ao mesmo tempo" não é uma configuração, é um
 * app quebrado. O teto de 16 não é um limite da conta nem da API: é o ponto a
 * partir do qual o número deixa de descrever uma pessoa trabalhando e vira
 * dedo escorregando no campo. Quem quiser mais desliga o escalonador.
 */
export const MAX_CONCURRENT_AGENTS_MIN = 1;
export const MAX_CONCURRENT_AGENTS_MAX = 16;

export function isSafeInitialCommand(command: string): boolean {
  return !CONTROL_CHAR.test(command) && !SHELL_METACHAR.test(command);
}

/**
 * O AMBIENTE de um workspace (dor verificada #2).
 *
 * `distro` só existe — e é obrigatória — em `wsl`: o valor vira o argumento de
 * `wsl.exe -d <distro>`. Vai como argv (nada de shell), mas o `isValidDistro`
 * do `@bridge/shared` continua barrando nome começando com `-`, que o parser
 * do PRÓPRIO `wsl.exe` leria como opção — é a mesma injeção de ARGUMENTO que o
 * `--resume` da sessão evita.
 */
export const environmentSchema = z
  .object({
    // Literal (e não `ENVIRONMENT_KINDS`) pra o zod INFERIR `EnvironmentKind`:
    // com um `string[]` genérico o corpo parseado sairia como `string` e o
    // core receberia um ambiente sem tipo. O teste em `shared` prende as duas
    // listas juntas.
    kind: z.enum(['pwsh', 'powershell', 'gitbash', 'wsl']),
    distro: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidDistro, { message: 'core.erro.distroInvalida' satisfies MessageKey })
      .optional(),
  })
  .strict()
  .refine((env) => (env.kind === 'wsl' ? env.distro !== undefined : env.distro === undefined), {
    path: ['distro'],
    message: 'core.erro.distroSoComWsl' satisfies MessageKey,
  });

export const workspaceSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().optional(),
  environment: environmentSchema.optional(),
});

/**
 * `PATCH /api/workspaces/:id` — o ambiente (dor #2) e o acesso cruzado (dor
 * #4). `environment: null` volta pro `shell` da configuração global; os dois
 * campos são opcionais mas o corpo VAZIO é 400 (um PATCH sem campo nenhum não
 * diz nada, e aceitar isso esconderia o typo de quem escreveu `env`).
 */
export const workspacePatchSchema = z
  .object({
    environment: environmentSchema.nullable().optional(),
    /**
     * Dor verificada #4 — libera ESTE workspace da guarda de escopo. Não tem
     * `null`: a pergunta é binária (restrito ou liberado) e a ausência do
     * campo já quer dizer "não estou falando disso".
     */
    crossAccess: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => patch.environment !== undefined || patch.crossAccess !== undefined, {
    message: 'core.erro.informeAmbienteOuCrossAccess' satisfies MessageKey,
  });

/** `POST /api/workspaces/:id/tabs`. Toda aba é de terminal. */
export const tabSchema = z.object({
  kind: z.literal('terminal').optional(),
});

export const splitSchema = z.object({
  dir: z.enum(['v', 'h']),
  /**
   * "Dividir com uma aba já aberta": em vez de um painel novo vazio, o lado b
   * do split recebe a árvore inteira desta aba (do mesmo workspace), e a aba
   * some. Sem o campo, é o split de sempre.
   */
  adoptTabId: z.string().min(1).max(200).optional(),
});

export const ratioSchema = z.object({
  ratio: z.number().min(0.1).max(0.9),
  /**
   * R1 — o painel do OUTRO lado do divisor arrastado. Com ele o core acha o
   * menor ancestral comum dos dois (o divisor de verdade); sem ele mantém o
   * comportamento antigo, o split pai imediato do painel da URL.
   */
  siblingPaneId: z.string().min(1).optional(),
});

export const sessionSchema = z
  .object({
    paneId: z.string().min(1),
    kind: z.enum(['shell', 'agent']),
    agent: z.enum(['claude', 'codex', 'gemini']).optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    /**
     * Escrito no PTY após o primeiro byte do PTY (piso 200 ms, teto 3 s) — R10
     * da onda da Fase 3; o "Ver diff" da spec §7. O teto de 2000 chars é o do
     * comando de diff com folga: o que passa disso não é comando, é alguém
     * tentando empurrar um script inteiro pro terminal.
     */
    initialCommand: z
      .string()
      .min(1)
      .max(2000)
      .refine(isSafeInitialCommand, { message: 'core.erro.comandoInicialInvalido' satisfies MessageKey })
      .optional(),
    /**
     * Retomar a conversa do agente: `claude --resume <id>`. O id é o
     * `session_id` do Claude Code (um UUID), que o painel guardou no
     * `lastAgentSessionId`.
     *
     * BR-06/R5: o id não pode começar com `-`. O argv vai em array (não há
     * injeção de shell), mas `--resume --dangerously-skip-permissions` é injeção
     * de ARGUMENTO no parser do agente — e o valor chega aqui de um payload de
     * hook, que é dado do agente, não do dono.
     */
    resume: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, { message: 'core.erro.conversaInvalida' satisfies MessageKey })
      .optional(),
    })
  // BU-15: campo desconhecido vira 400 em vez de sumir em silêncio. O
  // `replaceLiveShell` já era inalcançável por esta rota (a rota passa os
  // campos um a um); com o `.strict()` a recusa passa a ser explícita.
  .strict();

/** `POST /api/tasks` — nova tarefa em worktree (spec §7). */
export const taskSchema = z
  .object({
    repoId: z.string().min(1).optional(),
    repoPath: z.string().min(1).optional(),
    name: z.string().min(1),
    base: refSchema.optional(),
    agent: z.enum(['claude', 'codex', 'gemini']).optional(),
    /**
     * Dor #2 — ambiente da tarefa. Omitido, o core HERDA o dos workspaces do
     * mesmo repositório; informado, manda.
     */
    environment: environmentSchema.optional(),
  })
  .refine((body) => body.repoId !== undefined || body.repoPath !== undefined, {
    // A MESMA chave do `GitError` equivalente do core: a recusa é a mesma
    // regra, dita duas vezes (aqui e lá), e uma frase só é o que garante que
    // as duas continuem combinando.
    message: 'core.erro.git.informeRepo' satisfies MessageKey,
  });

/**
 * `PATCH /api/repos/:id` — BR-03, "Confiar nos filtros git deste repositório".
 * Um campo só: a decisão é binária e explícita.
 */
export const repoTrustSchema = z
  .object({
    trustFilters: z.boolean(),
  })
  // BU-15: `.strict()` pelo mesmo motivo escrito no `configPatchSchema` — um
  // campo desconhecido no corpo é 400, e não um 200 que engole a intenção de
  // quem escreveu.
  .strict();

export const mergeSchema = z.object({
  mode: z.enum(['ff-only', 'no-ff']),
});

/**
 * `PATCH /api/workspaces/:id/worktree` — R3, "Definir base…". Só o nome do
 * ref; quem confere se ele EXISTE é o core (`git rev-parse`), porque isso
 * depende do repo e não da forma do pedido.
 */
export const worktreeBaseSchema = z.object({
  base: refSchema,
});

export const inputSchema = z.object({
  data: z.string(),
});

/**
 * BR-15: teto em cols/rows. O número vai direto pro ConPTY via node-pty; um
 * `2147483648` é, na melhor hipótese, alocação enorme e, na pior, a queda do
 * PTY do dono. 1000×1000 é folga sobre qualquer monitor.
 */
export const PTY_DIM_MAX = 1000;

export const resizeSchema = z.object({
  cols: z.number().int().min(1).max(PTY_DIM_MAX),
  rows: z.number().int().min(1).max(PTY_DIM_MAX),
});

/** BR-12: teto do texto de notificação — o mesmo que o OSC trunca. */
export const NOTIFICATION_TEXT_MAX = 2000;

export const notifySchema = z.object({
  text: z.string().min(1).max(NOTIFICATION_TEXT_MAX),
});

export const focusSchema = z.object({
  sessionId: z.string().optional(),
  windowFocused: z.boolean(),
  /** `bridge focus`: além de marcar o foco, LEVAR a UI até a sessão (`session.reveal`). */
  reveal: z.boolean().optional(),
});

export const notificationsReadSchema = z.object({
  ids: z.array(z.string()),
});

/**
 * `PATCH /api/config` (spec §5). Tudo opcional (o diálogo manda UM campo por
 * vez, ao perder o foco), `toast`/`terminal` parciais (dá pra ligar só o
 * `quietWhenFocused`) e `.strict()` nos três níveis: campo desconhecido é
 * erro, não algo silenciosamente ignorado — quem digita `fontsize` em vez de
 * `fontSize` precisa ver o 400, senão fica achando que salvou.
 *
 * `port`, `profileDir` e `claudeHome` NÃO estão aqui de propósito: eles são
 * somente leitura pela API e a rota os intercepta ANTES desta validação, pra
 * devolver 403 `read-only` (o motivo certo) em vez de um 400 "campo
 * desconhecido".
 */
export const configPatchSchema = z
  .object({
    shell: z.enum(['pwsh', 'powershell', 'gitbash']).optional(),
    gitPollSeconds: z.number().int().min(5).max(120).optional(),
    toast: z.object({ enabled: z.boolean(), quietWhenFocused: z.boolean() }).partial().strict().optional(),
    terminal: z
      .object({ fontFamily: z.string().min(1).max(200), fontSize: z.number().int().min(8).max(24) })
      .partial()
      .strict()
      .optional(),
    restore: z.object({ resumeAgents: z.boolean() }).partial().strict().optional(),
    /**
     * Spec §13 — o idioma da interface (Configurações → Aparência).
     * `'system'` não é um idioma: é a instrução de perguntar à máquina, e
     * quem responde é o core (`languageResolved` no corpo do `GET`).
     */
    ui: z.object({ language: z.enum(LANGUAGE_SETTINGS) }).partial().strict().optional(),
    /** Escalonador de lançamentos — ver `MAX_CONCURRENT_AGENTS_MIN/MAX`. */
    sessions: z
      .object({
        maxConcurrentAgents: z.number().int().min(MAX_CONCURRENT_AGENTS_MIN).max(MAX_CONCURRENT_AGENTS_MAX),
        scheduleLaunches: z.boolean(),
        /** Dor verificada #3 — injetar o resumo sozinho quando o resume volta vazio. */
        autoRecap: z.boolean(),
        /** Dor verificada #4 — a guarda de escopo entre worktrees irmãs. */
        scopeGuard: z.boolean(),
        /** 0.12.0 — o wrapper `claude` na frente do PATH de cada shell. */
        hostedAgents: z.boolean(),
        /** 12/09/2026 — ver `StoredConfig.sessions.mouseClicks`. */
        mouseClicks: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    /**
     * ADR-012. `dayBoundary` aceita só `'local'` — o campo existe pra que o
     * `config.json` responda "qual é a borda do dia?" por escrito, não pra
     * abrir uma segunda borda que a agregação não sabe calcular.
     *
     * `pricing` é um mapa `modelo → preço` com os quatro valores em USD por
     * milhão. O teto de 200 entradas e o de 200 caracteres do id existem pelo
     * mesmo motivo do teto de `fontFamily`: o corpo vem pelo socket local, mas
     * ele é gravado no `config.json` e relido em toda subida.
     */
    usage: z
      .object({
        dayBoundary: z.literal('local'),
        showCost: z.boolean(),
        /** 0.12.2 — ver `UsageConfig.terminalStatusLine`. */
        terminalStatusLine: z.boolean(),
        pricingFile: z.string().max(1000),
        pricing: z
          .record(
            z.string().min(1).max(200),
            z.object({
              input: z.number().min(0).finite(),
              output: z.number().min(0).finite(),
              cacheWrite: z.number().min(0).finite(),
              // BU-15: `cacheWrite1h` é documentado e suportado por `isPrice`,
              // mas não estava declarado aqui — o zod o REMOVIA em silêncio, e
              // quem ajustasse o preço da escrita de 1 h pela API recebia 200
              // com nada acontecendo.
              cacheWrite1h: z.number().min(0).finite().optional(),
              cacheRead: z.number().min(0).finite(),
            }),
          )
          // BU-10: o teto de 200 que a doc acima promete, agora imposto. O
          // arquivo é relido em toda subida do core e em todo `reloadPricing`.
          .refine((table) => Object.keys(table).length <= MAX_PRICING_ENTRIES, {
            message: 'core.erro.usagePricingMax' satisfies MessageKey,
          }),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

/**
 * `POST /api/launcher/launch-now` — solta um lançamento da fila ignorando o
 * escalonador. Sem `id`, o PRIMEIRO da fila: é o caso do botão da sidebar,
 * onde a fila é uma linha só e "agora" quer dizer "o próximo".
 */
export const launchNowSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Recortes aceitos por `GET /api/usage?range=…`. O default é `day`. A lista
 * mora no `@bridge/shared` desde que a CLI e o painel passaram a montar a
 * query de período (anchor/custom) — este re-export só mantém o import antigo.
 */
export { USAGE_RANGES } from '@bridge/shared';

/**
 * Campos somente leitura pela API — 403. `port` só muda pelo `config.json`
 * editado à mão; `profileDir`, `claudeHome` e `languageResolved` não mudam nem
 * assim (são derivados — onde o perfil está, de onde os transcripts são lidos
 * e qual idioma o `ui.language` deu nesta máquina —, e o `GET` só os devolve
 * pra UI ter o que mostrar). Quem quer trocar de idioma manda `ui.language`.
 */
export const READ_ONLY_CONFIG_FIELDS = ['port', 'profileDir', 'claudeHome', 'languageResolved'] as const;

/**
 * Valida `body` contra `schema`; em falha manda `400 { error }` (com o
 * caminho + mensagem do primeiro issue do zod) e devolve `undefined` — o
 * chamador só precisa checar `if (!parsed) return;`. Em sucesso devolve o
 * valor já tipado/parseado.
 */
/**
 * Parâmetros dos issues que têm `{param}` no catálogo.
 *
 * O `message` de um `refine` do zod é fixado quando o schema é CONSTRUÍDO (na
 * importação do módulo), muito antes de existir um idioma; por isso ele guarda
 * a CHAVE, e o número — que é uma constante deste arquivo — entra aqui.
 */
const ISSUE_PARAMS: Partial<Record<MessageKey, Record<string, string | number>>> = {
  'core.erro.usagePricingMax': { max: MAX_PRICING_ENTRIES },
};

/**
 * O texto de um issue do zod no idioma em vigor.
 *
 * Mensagem que é chave do catálogo é traduzida; qualquer outra (as embutidas
 * do zod — `Required`, `Expected string, received number`) sai como veio: elas
 * já nascem em inglês, descrevem a FORMA do corpo e são lidas por quem está
 * escrevendo um cliente da API, não pelo dono do app.
 */
export function issueMessage(issue: { message?: string } | undefined, lang: Language): string {
  const message = issue?.message;
  if (message === undefined) return t(lang, 'core.erro.invalido');
  return message in ptBR ? t(lang, message as MessageKey, ISSUE_PARAMS[message as MessageKey]) : message;
}

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  reply: FastifyReply,
  lang: Language,
): T | undefined {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    // Sem caminho no issue, o corpo INTEIRO é que está errado. O marcador de
    // lugar passa pelo catálogo como o resto da frase: ele é lido dentro dela.
    const path = issue && issue.path.length > 0 ? issue.path.join('.') : t(lang, 'core.erro.corpoCaminho');
    reply.code(400).send({
      error: t(lang, 'core.erro.corpoInvalido', { caminho: path, motivo: issueMessage(issue, lang) }),
    });
    return undefined;
  }
  return result.data;
}
