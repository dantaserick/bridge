import type { EnvironmentInfo, Language, Pane, QueuedLaunch, Session, Tab, Workspace } from '@bridge/shared';
import { parseEnvironmentId } from '@bridge/shared';
import { useEffect, useRef, useState } from 'react';
import { queuedMessage } from '../actions.js';
import { api, ApiError } from '../api.js';
import { getBridge } from '../bridge.js';
import { tUi, useT } from '../i18n.js';

interface Props {
  onClose: () => void;
  /** Workspace criado (e, se pedido, o Claude já subindo no primeiro painel). */
  onCreated: (created: { workspace: Workspace; tab: Tab; pane: Pane }) => void;
  /**
   * Marca UM pedido de criação como em voo; devolve a função que encerra
   * exatamente esse pedido, chamada num `finally`.
   *
   * Existe porque o diálogo pode SUMIR antes do pedido acabar: o `Escape` e o
   * "Cancelar" fecham a janela, mas o `POST /api/workspaces` (e o
   * `POST /api/sessions` do Claude depois dele, que leva segundos no
   * `available()` do adaptador) continuam correndo, e o workspace aparece
   * assim mesmo. Quem precisa saber disso é a restauração da §10 no `App` — um
   * workspace que nasce nessa janela é DESTE diálogo e não pode receber um
   * shell automático por cima. Por isso o dono da marca é o App, e o fim sai de
   * um `finally`, nunca do desmonte do componente.
   *
   * É uma função POR PEDIDO, e não um `onBusyChange(boolean)`, porque duas
   * criações se cruzam e podem terminar fora de ordem: um "acabou" anônimo
   * encerraria a marca da criação errada.
   */
  beginCreating?: () => () => void;

  /** Falha DEPOIS do workspace existir: o diálogo fecha e o erro vai pro rodapé. */
  onError: (message: string) => void;

  /**
   * Dor verificada #2 — os ambientes que o core detectou. Lista vazia (core de
   * versão anterior, ou a resposta ainda não chegou) esconde o campo inteiro:
   * um `<select>` com uma opção só não é escolha, é ruído.
   */
  environments?: readonly EnvironmentInfo[];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * O que a escolha de ambiente REALMENTE muda — e a frase tem que ser verdade
 * pros dois casos, porque eles são diferentes:
 *
 * - `pwsh`/`powershell`/`gitbash`: troca o shell das sessões de TERMINAL. O
 *   Claude Code continua sendo o do Windows, como sempre foi (o adaptador
 *   resolve o `claude.cmd` do PATH e o PTY sobe ele direto, sem passar pelo
 *   shell escolhido);
 * - `wsl`: aí sim os dois sobem dentro da distro, com os caminhos traduzidos.
 *
 * A primeira versão desta linha dizia "o shell E o Claude Code sobem aqui
 * dentro" pros quatro — verdade só no WSL.
 */
export function environmentNote(envId: string, lang: Language): string {
  if (envId === '') return tUi(lang, 'dialog.workspace.nota.padrao');
  if (envId.startsWith('wsl:')) return tUi(lang, 'dialog.workspace.nota.wsl');
  return tUi(lang, 'dialog.workspace.nota.shell');
}

/**
 * O sufixo do `<option>` de ambiente: o que ele NAO tem. A ordem é a do peso —
 * indisponível ganha de "sem claude", porque um ambiente que não sobe não
 * precisa dizer o que falta dentro dele.
 */
export function environmentOptionSuffix(env: EnvironmentInfo, lang: Language): string {
  if (!env.available) return tUi(lang, 'dialog.workspace.ambiente.indisponivel');
  return env.claude ? '' : tUi(lang, 'dialog.workspace.ambiente.semClaude');
}

/** Diálogo de `Ctrl+Shift+N`. Substitui o `window.prompt` da Fase 1. */
export function NewWorkspaceDialog({ onClose, onCreated, onError, beginCreating, environments = [] }: Props): JSX.Element {
  const { t, lang } = useT();
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [openClaude, setOpenClaude] = useState(true);
  /**
   * `''` = padrão do Bridge (o `shell` da configuração global) — o mesmo
   * comportamento de sempre, e por isso o valor inicial. Só quem escolhe uma
   * distro/shell aqui grava `environment` no workspace.
   */
  const [envId, setEnvId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const cwdRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    cwdRef.current?.focus();
  }, []);

  function updateCwd(value: string): void {
    setCwd(value);
    if (!nameTouched) setName(value ? basename(value) : '');
  }

  async function pick(): Promise<void> {
    const picked = await getBridge().pickFolder(t('dialog.workspace.pasta.prompt'));
    if (picked) updateCwd(picked);
  }

  async function submit(): Promise<void> {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    // Acende ANTES do primeiro pedido e apaga no `finally` — nem o `Escape` nem
    // um erro no meio podem deixar a marca acesa (ou apagá-la cedo demais). O
    // fim é DESTA criação: `endCreating` é a função que o `beginCreating`
    // devolveu pra este pedido, não um "acabou" genérico.
    const endCreating = beginCreating?.();
    try {
      let created: { workspace: Workspace; tab: Tab; pane: Pane };
      try {
        created = await api<{ workspace: Workspace; tab: Tab; pane: Pane }>('/api/workspaces', {
          method: 'POST',
          body: {
            cwd: cwd.trim(),
            name: name.trim() || undefined,
            // Dor #2: o ambiente vai JUNTO da criação — o Claude do checkbox
            // abaixo sobe na mesma chamada seguinte, e ele precisa já nascer
            // dentro da distro escolhida.
            environment: envId ? parseEnvironmentId(envId) : undefined,
          },
        });
      } catch (err) {
        // Nada foi criado: o diálogo continua aberto pro usuário corrigir a pasta.
        setError(err instanceof ApiError ? err.message : (err as Error).message);
        setBusy(false);
        return;
      }

      // Daqui pra frente o workspace EXISTE. Se o Claude não subir, o diálogo
      // fecha do mesmo jeito (reabrir criaria um workspace duplicado) e o erro
      // vai pra linha de status.
      if (openClaude) {
        try {
          const launched = await api<Session | QueuedLaunch>('/api/sessions', {
            method: 'POST',
            body: { paneId: created.pane.id, kind: 'agent', agent: 'claude' },
          });
          // Dor #1 — o escalonador pode ter segurado este lançamento (202).
          // Sem esta linha o diálogo fechava com um painel VAZIO e nenhuma
          // explicação: quem marcou "abrir um Claude" ficava esperando um
          // terminal que ainda estava na fila.
          if ('queued' in launched) onError(queuedMessage(launched.position, lang));
        } catch (err) {
          // O `message` vem do core, já traduzido — a UI só o embrulha.
          onError(
            t('dialog.workspace.claudeNaoSubiu', {
              detalhe: err instanceof ApiError ? err.message : (err as Error).message,
            }),
          );
        }
      }
      onCreated(created);
    } finally {
      endCreating?.();
    }
  }

  return (
    <div
      className="dialog-veil"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="dialog-title">
          <span>{t('dialog.workspace.titulo')}</span>
          <span className="dim">{t('dialog.workspace.subtitulo')}</span>
        </div>

        <div className="dialog-field">
          <label htmlFor="ws-cwd">{t('dialog.workspace.pasta')}</label>
          <div className="dialog-row">
            <input
              id="ws-cwd"
              ref={cwdRef}
              className="field mono"
              value={cwd}
              autoComplete="off"
              placeholder={t('dialog.workspace.pasta.placeholder')}
              onChange={(ev) => updateCwd(ev.target.value)}
            />
            <button type="button" onClick={() => void pick()}>
              {t('dialog.escolher')}
            </button>
          </div>
        </div>

        <div className="dialog-field">
          <label htmlFor="ws-name">{t('dialog.workspace.nome')}</label>
          <input
            id="ws-name"
            className="field mono"
            value={name}
            autoComplete="off"
            onChange={(ev) => {
              setNameTouched(true);
              setName(ev.target.value);
            }}
          />
        </div>

        {environments.length > 0 && (
          <div className="dialog-field">
            <label htmlFor="ws-env">{t('dialog.workspace.ambiente')}</label>
            <select
              id="ws-env"
              className="field"
              data-testid="ws-env"
              value={envId}
              onChange={(ev) => setEnvId(ev.target.value)}
            >
              <option value="">{t('dialog.workspace.ambiente.padrao')}</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id} disabled={!env.available}>
                  {/* `env.label` vem do CORE, já traduzido — a UI não o retraduz. */}
                  {env.label}
                  {environmentOptionSuffix(env, lang)}
                </option>
              ))}
            </select>
            <span className="dim">{environmentNote(envId, lang)}</span>
          </div>
        )}

        <label className="dialog-check">
          <input type="checkbox" checked={openClaude} onChange={(ev) => setOpenClaude(ev.target.checked)} />
          <span>{t('dialog.workspace.abrirClaude')}</span>
        </label>

        {error && <div className="error-line">{error}</div>}

        <div className="dialog-actions">
          <span className="dim">
            <kbd>Esc</kbd> {t('dialog.dica.esc')} · <kbd>Enter</kbd> {t('dialog.dica.enter')}
          </span>
          <span className="pane-spacer" />
          <button type="button" onClick={onClose}>
            {t('dialog.cancelar')}
          </button>
          <button type="submit" className="primary" disabled={busy || !cwd.trim()}>
            {busy ? t('dialog.criando') : t('dialog.workspace.criar')}
          </button>
        </div>
      </form>
    </div>
  );
}
