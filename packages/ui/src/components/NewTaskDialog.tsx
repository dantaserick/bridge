import type { Repo } from '@bridge/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getBridge } from '../bridge.js';
import { useT } from '../i18n.js';
import {
  branchPreview,
  canSubmitTask,
  repoDetectLine,
  repoFromDetect,
  submitTask,
  taskErrorMessage,
} from '../newTask.js';
import type { CreatedTask, DetectedRepo, TaskDraft } from '../newTask.js';

interface Props {
  onClose: () => void;
  onCreated: (created: CreatedTask) => void;
  /**
   * Aviso DEPOIS de a tarefa existir (o Claude não subiu): vai pra faixa de
   * status, como no diálogo de workspace — o diálogo fecha do mesmo jeito.
   */
  onWarn: (message: string) => void;
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
}

/** Valores sentinela do `<select>` de repositório. */
const PICK = '__pick__';
const PICKED = '__picked__';

/**
 * Diálogo de `Ctrl+Shift+Alt+N` e do botão "Nova tarefa" (spec §7): repo,
 * nome (com preview do branch que vai nascer), base e "Subir Claude Code".
 * Quem cria worktree, branch e workspace é o core — aqui só se monta o pedido.
 */
export function NewTaskDialog({ onClose, onCreated, onWarn, beginCreating }: Props): JSX.Element {
  const { t, lang } = useT();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [detect, setDetect] = useState<{ ok: boolean; text: string } | undefined>();
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [agent, setAgent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement | null>(null);

  const draft: TaskDraft = {
    repoId: repoId || undefined,
    repoPath: repoPath || undefined,
    name,
    base,
    agent,
  };
  const preview = branchPreview(name, lang);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Repos conhecidos: o primeiro já vem escolhido (o caso comum é criar a
  // tarefa no repo onde você estava), e a detecção preenche a base.
  useEffect(() => {
    let cancelled = false;
    void api<Repo[]>('/api/repos')
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        const first = list[0];
        if (first) {
          setRepoId(first.id);
          void detectAt(first.path);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(taskErrorMessage(err, lang));
      });
    return () => {
      cancelled = true;
    };
    // Roda uma vez: `detectAt` só usa `api` e setters, que são estáveis.
  }, []);

  /**
   * `GET /api/git/detect?cwd=` — rota barata só pra dizer se a pasta é repo,
   * qual o branch e onde fica o worktree principal. Evita descobrir que a
   * pasta não serve só no 422 da criação.
   */
  async function detectAt(cwd: string, fromPick = false): Promise<void> {
    try {
      const info = await api<DetectedRepo | null>(`/api/git/detect?cwd=${encodeURIComponent(cwd)}`);
      setDetect(repoDetectLine(info, lang));
      if (info) {
        const resolved = repoFromDetect(info);
        setBase(resolved.base);
        if (fromPick) {
          setRepoPath(resolved.repoPath);
          setRepoId('');
        }
      } else if (fromPick) {
        setRepoPath('');
      }
    } catch (err) {
      setDetect({ ok: false, text: taskErrorMessage(err, lang) });
    }
  }

  async function pick(): Promise<void> {
    // O que este diálogo escolhe é o REPOSITÓRIO da tarefa, não a pasta de um
    // workspace: o título da janela do Windows tem que dizer isso.
    const picked = await getBridge().pickFolder(t('dialog.task.pasta.prompt'));
    if (!picked) return;
    await detectAt(picked, true);
  }

  function onSelect(value: string): void {
    if (value === PICK) {
      void pick();
      return;
    }
    if (value === PICKED || value === '') return;
    const repo = repos.find((r) => r.id === value);
    setRepoId(value);
    setRepoPath('');
    if (repo) void detectAt(repo.path);
  }

  async function submit(): Promise<void> {
    if (busy || !canSubmitTask(draft, lang)) return;
    setBusy(true);
    setError(undefined);
    // Mesma marca do diálogo de workspace, pela mesma razão (ver `beginCreating`).
    const endCreating = beginCreating?.();
    try {
      const { created, warning } = await submitTask(api, draft, lang);
      // A tarefa EXISTE mesmo sem o agente: o core devolve 201 sem `session`
      // quando o Claude não sobe, e não desfaz o worktree. Reabrir o diálogo
      // criaria uma segunda tarefa — então fecha e o aviso vai pro rodapé.
      if (warning) onWarn(warning);
      onCreated(created);
    } catch (err) {
      // Aqui a chamada falhou: nada foi criado, o diálogo fica aberto com o
      // erro do lado do campo pro usuário corrigir e tentar de novo.
      setError(taskErrorMessage(err, lang));
      setBusy(false);
    } finally {
      endCreating?.();
    }
  }

  const selectValue = repoId !== '' ? repoId : repoPath !== '' ? PICKED : '';

  return (
    <div
      className="dialog-veil"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        data-testid="task-dialog"
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
          <span>{t('dialog.task.titulo')}</span>
          <span className="dim">{t('dialog.task.subtitulo')}</span>
        </div>

        <div className="dialog-field">
          <label htmlFor="task-repo">{t('dialog.task.repositorio')}</label>
          <div className="dialog-row">
            <select
              id="task-repo"
              className="field mono"
              value={selectValue}
              onChange={(ev) => onSelect(ev.target.value)}
            >
              {selectValue === '' && <option value="">{t('dialog.task.escolhaRepo')}</option>}
              {repoPath !== '' && <option value={PICKED}>{repoPath}</option>}
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name} — {repo.path}
                </option>
              ))}
              <option value={PICK}>{t('dialog.task.escolherPasta')}</option>
            </select>
            <button type="button" onClick={() => void pick()}>
              {t('dialog.escolher')}
            </button>
          </div>
          {detect && (
            <div data-testid="task-detect" className={detect.ok ? 'detect-line mono dim' : 'detect-line mono bad'}>
              {detect.text}
            </div>
          )}
        </div>

        <div className="dialog-field">
          <label htmlFor="task-name">{t('dialog.task.nome')}</label>
          <input
            id="task-name"
            ref={nameRef}
            className="field"
            value={name}
            autoComplete="off"
            placeholder={t('dialog.task.nome.placeholder')}
            onChange={(ev) => setName(ev.target.value)}
          />
          <div data-testid="task-branch" className={preview.error ? 'detect-line mono bad' : 'detect-line mono dim'}>
            {preview.error ?? (preview.branch ? t('dialog.task.branch', { branch: preview.branch }) : t('dialog.task.branch.vazio'))}
          </div>
        </div>

        <div className="dialog-field">
          <label htmlFor="task-base">{t('dialog.task.base')}</label>
          <input
            id="task-base"
            className="field mono"
            value={base}
            autoComplete="off"
            placeholder="main"
            onChange={(ev) => setBase(ev.target.value)}
          />
        </div>

        <label className="dialog-check">
          <input type="checkbox" checked={agent} onChange={(ev) => setAgent(ev.target.checked)} />
          <span>{t('dialog.task.subirClaude')}</span>
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
          <button type="submit" className="primary" disabled={busy || !canSubmitTask(draft, lang)}>
            {busy ? t('dialog.criando') : t('dialog.task.criar')}
          </button>
        </div>
      </form>
    </div>
  );
}
