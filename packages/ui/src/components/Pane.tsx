import type { Pane as PaneModel, Session } from '@bridge/shared';
import { useEffect, useRef } from 'react';
import { useLang, useT } from '../i18n.js';
import { emptyPaneActions, paneDetail } from '../paneModel.js';
import type { SplitMenuAction } from '../paneModel.js';
import {
  recapActionLabel,
  recapActionTitle,
  recapBannerText,
  recapDismissLabel,
  recapDismissTitle,
} from '../recap.js';
import { sessionLabel, sessionRowTitle } from '../sidebarModel.js';
import { CloseIcon } from './icons.js';
import { PopoverMenu } from './sidebar/PopoverMenu.js';
import type { PopoverItem } from './sidebar/PopoverMenu.js';
import { Terminal } from './Terminal.js';

interface Props {
  pane: PaneModel;
  session?: Session;
  focused: boolean;
  /** Painel de aba/workspace escondido continua montado, só sai da tela. */
  visible: boolean;
  /**
   * A faixa do painel restaurado (Task 9b; texto puro de `restore.ts`). Até
   * 13/09/2026 ela era escrita dentro do xterm e o `ESC[2J` com que o ConPTY
   * abre a sessão a apagava; agora é uma linha logo abaixo do cabeçalho.
   */
  banner?: string;
  /** "✕" da faixa acima — some com ela nesta sessão. */
  onDismissBanner?: () => void;
  onFocus: () => void;
  onOpenShell: () => void;
  /** Botão "Abrir Claude Code" do painel vazio — sobe o agente AQUI. */
  onOpenClaude: () => void;
  /** ✕ do cabeçalho e botão "Fechar painel" (`Ctrl+Shift+X`). */
  onClose: () => void;
  /**
   * Menu "Dividir" do cabeçalho: os dois splits vazios e, por aba de terminal
   * do workspace, trazê-la pra dentro deste split. As entradas vêm prontas do
   * `splitMenuItems` (o App sabe as abas e as sessões; o painel só desenha).
   */
  splitItems?: PopoverItem<SplitMenuAction>[];
  onSplit?: (action: SplitMenuAction) => void;
  /**
   * Sessão nascendo neste painel (`POST /api/sessions` em voo). O painel ainda
   * está vazio na tela, mas já não é "sem nada a perder": os botões saem do ar
   * até a sessão aparecer, e o `closePane` recusa fechar nessa janela.
   */
  creating?: boolean;
  /**
   * Fonte do terminal, vinda de `config.terminal` (diálogo de configurações).
   * Repassada crua pro `Terminal`, que resolve ausência/valor fora da faixa em
   * `resolveTerminalPrefs` — o `Pane` não tem opinião sobre fonte.
   */
  terminalFontFamily?: string;
  terminalFontSize?: number;
  /** `sessions.mouseClicks`, repassado cru ao `Terminal` (ver `mouseReporting` lá). */
  terminalMouseReporting?: boolean;
  /**
   * Dor verificada #3 — o `--resume` deste painel voltou VAZIO (o core marcou
   * `resumeOutcome: 'fresh'`) e o dono ainda não dispensou o aviso. Quem
   * decide é o `showsRecapBanner` do `recap.ts`; o painel só desenha.
   */
  resumeFresh?: boolean;
  /** "Reabrir com contexto" — monta o resumo e escreve no prompt do agente. */
  onRecap?: () => void;
  /** "Ignorar" — some com a faixa desta sessão, sem escrever nada. */
  onDismissRecap?: () => void;
  /** O "Reabrir com contexto" deste painel está em voo (dois pedidos ao core). */
  recapBusy?: boolean;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…\\${parts.slice(-2).join('\\')}`;
}

interface EmptyPaneProps {
  onOpenShell: () => void;
  onOpenClaude: () => void;
  onClose: () => void;
  creating: boolean;
}

/**
 * O painel vazio: ícone e os botões do que dá pra fazer aqui. As duas linhas de
 * `<kbd>` ("Enter abre um shell", "Ctrl Shift C abre o Claude Code") saíram na
 * 0.11.2: elas repetiam, em tecla, o que os botões logo abaixo já diziam por
 * nome. A combinação continua no `title` de cada botão (`emptyPaneActions`) e
 * em Configurações → Atalhos.
 */
function EmptyPaneHint({ onOpenShell, onOpenClaude, onClose, creating }: EmptyPaneProps): JSX.Element {
  const lang = useLang();
  const run: Record<string, () => void> = { shell: onOpenShell, claude: onOpenClaude, close: onClose };
  return (
    <div className="pane-hint">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9 L10 12 L7 15" />
        <path d="M12 15 L17 15" />
      </svg>
      <div className="pane-hint-actions">
        {emptyPaneActions(lang).map((action) => (
          <button
            key={action.id}
            type="button"
            title={action.title}
            disabled={creating}
            // O painel escuta `Enter` na captura pra abrir shell; o clique é
            // do botão e não pode subir pra lá como se fosse o painel.
            onClick={(ev) => {
              ev.stopPropagation();
              run[action.id]?.();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Um painel da árvore de splits: cabeçalho de 26px + corpo. Com sessão o corpo
 * é o xterm (sempre montado); sem sessão, a dica de atalho; encerrada, o xterm
 * com a saída congelada mais a faixa de reabrir.
 */
export function Pane({
  pane,
  session,
  focused,
  visible,
  banner,
  onDismissBanner,
  onFocus,
  onOpenShell,
  onOpenClaude,
  onClose,
  splitItems,
  onSplit,
  creating = false,
  terminalFontFamily,
  terminalFontSize,
  terminalMouseReporting,
  resumeFresh = false,
  onRecap,
  onDismissRecap,
  recapBusy = false,
}: Props): JSX.Element {
  const { t, lang } = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const live = session !== undefined && session.state !== 'exited';

  // Sem terminal pra pegar o teclado, quem escuta o Enter é o próprio painel.
  useEffect(() => {
    if (focused && visible && !live) ref.current?.focus();
  }, [focused, visible, live]);

  const state = session?.state ?? 'empty';
  // O MESMO rótulo da linha da sidebar (`hosted?.agent ?? agent`, nunca o
  // `kind`): o painel que hospeda um Claude Code diz `claude` no cabeçalho, e
  // o tooltip explica que a sessão continua sendo um shell.
  const label = session ? sessionLabel(session, lang) : t('pane.vazio.rotulo');
  const hostedTitle = session ? sessionRowTitle(session, lang) : undefined;
  // Spec §5 — a hospedeira parada mostra "no shell" aqui, igual à sidebar.
  const detail = paneDetail(session, lang);
  const classes = ['pane', `pane-${state}`];
  if (focused) classes.push('focused');
  if (session?.state === 'needs-input') classes.push('needs-input');

  return (
    <div
      ref={ref}
      className={classes.join(' ')}
      style={visible ? undefined : { display: 'none' }}
      tabIndex={0}
      data-pane-id={pane.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      // Captura: no painel encerrado o xterm ainda está montado e engole o
      // Enter no bubble (`stopPropagation`). Aqui a gente pega antes.
      // A repetição do autorepeat é consumida do mesmo jeito (senão o Enter
      // vazaria pro terminal), mas não abre um segundo shell.
      onKeyDownCapture={(ev) => {
        if (live) return;
        if (ev.key !== 'Enter') return;
        // Enter com um botão da dica focado é o clique DELE ("Fechar painel"
        // não pode virar "abre um shell" só porque o painel escuta na captura).
        if ((ev.target as HTMLElement | null)?.closest?.('button')) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.repeat) return;
        onOpenShell();
      }}
    >
      <div className="pane-header">
        <span className={`ring ${session ? session.state : 'empty'}`} title={state} />
        <span className="pane-label" data-hosted={session?.hosted ? 'true' : undefined} title={hostedTitle}>
          {label}
        </span>
        {detail && <span className={`pane-detail mono ${state}`}>{detail}</span>}
        {session?.state === 'exited' && (
          <span className="pane-detail mono">{t('pane.encerrou', { codigo: session.exitCode ?? '?' })}</span>
        )}
        <span className="pane-spacer" />
        <span className="pane-cwd mono">{shortCwd(pane.cwd)}</span>
        {splitItems && onSplit && (
          <PopoverMenu items={splitItems} onPick={onSplit} variant="pane-menu" label={t('pane.dividir.rotulo')} />
        )}
        <button
          type="button"
          className="pane-close"
          // Desabilitado, o ✕ precisa dizer POR QUE: um botão apagado sem
          // explicação lê como bug do app, não como "espera a sessão nascer".
          title={creating ? t('pane.fechar.nascendo') : t('pane.fechar.titulo')}
          aria-label={t('pane.fechar.rotulo')}
          // Mesma regra do botão "Fechar painel" da dica: com uma sessão
          // nascendo, o `closePane` recusa — o ✕ não pode continuar clicável
          // oferecendo uma ação que a camada de ação vai negar.
          disabled={creating}
          onClick={(ev) => {
            ev.stopPropagation();
            onClose();
          }}
        >
          <CloseIcon size={9} />
        </button>
      </div>

      {session && banner && (
        <div className="pane-restore-strip">
          <span className="mono">{banner}</span>
          <span className="pane-spacer" />
          {onDismissBanner && (
            <button
              type="button"
              className="pane-restore-dismiss"
              title={t('restore.faixa.dispensar.titulo')}
              aria-label={t('restore.faixa.dispensar')}
              onClick={(ev) => {
                ev.stopPropagation();
                onDismissBanner();
              }}
            >
              <CloseIcon size={8} />
            </button>
          )}
        </div>
      )}

      {session ? (
        <Terminal
          sessionId={session.id}
          focused={focused && visible && live}
          fontFamily={terminalFontFamily}
          fontSize={terminalFontSize}
          mouseReporting={terminalMouseReporting}
        />
      ) : (
        <EmptyPaneHint onOpenShell={onOpenShell} onOpenClaude={onOpenClaude} onClose={onClose} creating={creating} />
      )}

      {/*
        Dor verificada #3. A faixa fica ENTRE o terminal e a barra de saída, e
        os dois botões são os únicos caminhos: nada acontece sozinho aqui (a
        injeção automática é uma opção desligada por padrão, e ela dispensa a
        faixa em vez de deixá-la piscando).
      */}
      {resumeFresh && (
        <div className="pane-recap-strip">
          <span>{recapBannerText(lang)}</span>
          <span className="pane-spacer" />
          <button
            type="button"
            disabled={recapBusy}
            title={recapActionTitle(lang)}
            onClick={(ev) => {
              ev.stopPropagation();
              onRecap?.();
            }}
          >
            {recapActionLabel(lang)}
          </button>
          <button
            type="button"
            title={recapDismissTitle(lang)}
            onClick={(ev) => {
              ev.stopPropagation();
              onDismissRecap?.();
            }}
          >
            {recapDismissLabel(lang)}
          </button>
        </div>
      )}

      {session?.state === 'exited' && (
        <div className="pane-exit-strip">
          <span>{t('pane.encerrou.processo', { codigo: session.exitCode ?? '?' })}</span>
          <span className="pane-spacer" />
          <span>
            <kbd>Enter</kbd> {t('pane.saida.enter')}
          </span>
          <span>
            <kbd>Ctrl</kbd>
            <kbd>Shift</kbd>
            <kbd>C</kbd> {t('pane.saida.claude')}
          </span>
        </div>
      )}
    </div>
  );
}
