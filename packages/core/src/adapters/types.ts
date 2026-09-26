import type { Language } from '@bridge/shared';
import type { AgentId, NotificationKind, QuotaSnapshot, Session } from '../model.js';
import type { EnvContext } from '../environments.js';
import type { HostedTarget } from './hosted.js';
import type { StateChange } from '../sessions.js';
import type { BridgeConfig } from '../profile.js';

export interface LaunchCtx {
  sessionId: string;
  cwd: string;
  sessionDir: string;
  port: number;
  token: string;
  shimPath: string;
  model?: string;
  /**
   * Id da sessão do agente a retomar (`claude --resume <id>`). Só chega aqui
   * quando o pedido pediu explicitamente: a restauração do painel manda o id
   * que o painel guardou. Adaptador que não sabe retomar simplesmente ignora.
   */
  resume?: string;
  cols: number;
  rows: number;
  /**
   * `sessions.mouseClicks` (12/09/2026). `true` põe `CLAUDE_CODE_NO_FLICKER=true`
   * no ambiente (se o dono não definiu a variável); `false` põe
   * `CLAUDE_CODE_DISABLE_MOUSE=1`; ausente não toca em nada (testes antigos).
   */
  mouseClicks?: boolean;
  /**
   * O ambiente do WORKSPACE já resolvido (dor verificada #2): fora do WSL é só
   * `{ kind }`; em `wsl` traz os caminhos traduzidos por `wslpath` e o comando
   * de `node` que o shim de hooks usa dentro da distro.
   *
   * Ausente = o comportamento de sempre (o `shell` da configuração global no
   * Windows, `claude` do PATH do Windows no agente).
   */
  environment?: EnvContext;
  /**
   * Hospedagem do Claude Code numa sessão de SHELL (0.12.0, spec §5): o
   * `claude` REAL que o wrapper da sessão vai chamar.
   *
   * O core só preenche quando `sessions.hostedAgents` está ligado, a sessão é
   * de shell e o claude existe nesta máquina. AUSENTE = o comportamento de
   * sempre: nenhum arquivo gravado, PATH intocado.
   */
  hosted?: { target: HostedTarget };
}

export interface LaunchSpec {
  bin: string;
  args: string[];
  env: Record<string, string>;
  files: Array<{ path: string; content: string }>;
}

export interface HookOutcome {
  change?: StateChange;
  notification?: { kind: NotificationKind; text: string };
  reply?: unknown;
  blockedStop?: boolean;
}

export interface StatusLineResult {
  line: string;
  quota?: QuotaSnapshot;
}

/**
 * Idioma (spec §13): `available`, `onHook` e `statusLine` recebem o `lang`
 * porque TODOS os três produzem texto que uma pessoa lê — o motivo da recusa,
 * a notificação, a linha do terminal. Ele vem como argumento, e não de um
 * estado do módulo, pra que o texto nasça no idioma do INSTANTE: um
 * `PATCH /api/config` vale já na próxima notificação, sem restart.
 */
export interface AgentAdapter {
  id: AgentId;
  label: string;
  available(lang: Language): Promise<{ ok: boolean; version?: string; reason?: string }>;
  launch(ctx: LaunchCtx): LaunchSpec;
  onHook(event: string, payload: unknown, session: Session, lang: Language): HookOutcome;
  statusLine?(payload: unknown, session: Session, lang: Language): Promise<StatusLineResult>;
}

export type ShellKind = BridgeConfig['shell'];
