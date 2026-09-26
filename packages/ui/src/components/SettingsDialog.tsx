import type {
  BridgeConfig,
  BridgeConfigPatch,
  KeybindingProblem,
  Keybindings,
  UsageReport,
  UsageScanProgress,
} from '@bridge/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { getBridge, isElectron } from '../bridge.js';
import type { LoginItemState } from '../bridge.js';
import { useT } from '../i18n.js';
import {
  autoRecapNote,
  canOpenProfileFolder,
  defaultsPatchFor,
  fieldValue,
  FONT_PREVIEW_LINES,
  GIT_POLL_SECONDS_MAX,
  GIT_POLL_SECONDS_MIN,
  hostedAgentsNote,
  keyIssueTitle,
  keybindingsHint,
  keybindingIssues,
  keybindingProblemNotices,
  keybindingsPath,
  keybindingsWarning,
  keyRows,
  languageOptions,
  loginItemLabel,
  loginItemMinimizedLabel,
  loginItemView,
  makeFieldSeq,
  MAX_CONCURRENT_AGENTS_MAX,
  MAX_CONCURRENT_AGENTS_MIN,
  MONO_FONT_SUGGESTIONS,
  nextLoginItem,
  patchForField,
  PRICING_EXAMPLE,
  pricingFileHint,
  pricingAsOfLabel,
  profileFolderLabel,
  scheduleLaunchesNote,
  scopeGuardNote,
  profileFolderPath,
  revertedDraft,
  settingsSections,
  shellOptions,
  terminalStatusLineNote,
} from '../settingsModel.js';
import type { SettingsField, SettingsSectionId } from '../settingsModel.js';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../terminalPrefs.js';
import { rescanStatus, scanCaveat, unpricedModels } from '../usageModel.js';
import type { RescanResult } from '../usageModel.js';
import { CloseIcon } from './icons.js';

interface Props {
  /** Config em vigor (`GET /api/config`); ausente enquanto a resposta não chega. */
  config?: BridgeConfig;
  keybindings: Keybindings;
  /**
   * Progresso da varredura de transcrições (seção **Uso**). Vem do App porque
   * quem escuta o `usage.changed` é ele; aqui vira a linha de status do botão
   * "Reler transcrições", que numa árvore grande roda por minutos.
   */
  scanning?: UsageScanProgress | null;
  /**
   * O campo irmão `problems` do `GET /api/keybindings`: o que o core achou de
   * errado ao LER o arquivo. Vazio contra um core velho, que não manda o campo.
   */
  keybindingProblems?: readonly KeybindingProblem[];
  onClose: () => void;
  /** Config inteira que o `PATCH` devolveu — o App guarda no estado. */
  onSaved: (config: BridgeConfig) => void;
}

/**
 * Diálogo de configurações (`Ctrl+,`, a engrenagem da sidebar e o item do menu
 * "⋯"). Seções em coluna à esquerda, conteúdo à direita — o arranjo de
 * "settings" que todo mundo já sabe ler.
 *
 * **Não tem OK nem Cancelar de propósito.** Cada campo manda o seu próprio
 * `PATCH /api/config` (ao alterar, no caso de select/checkbox/número; ao
 * perder o foco, no caso do texto da fonte), e o core responde com a config
 * inteira já mesclada. Um botão "Salvar" implicaria poder desistir, e não dá:
 * o `gitPollSeconds` reagenda o poller na hora e a fonte já mudou o terminal
 * na tela atrás do diálogo. O que existe é "Restaurar padrões" por seção.
 *
 * O erro do core (400 `invalid-config`) aparece numa faixa dentro do diálogo,
 * não no rodapé do app: quem errou o valor está olhando pra cá.
 */
export function SettingsDialog({ config, scanning, keybindings, keybindingProblems, onClose, onSaved }: Props): JSX.Element {
  const { t, lang } = useT();
  const [section, setSection] = useState<SettingsSectionId>('terminal');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  /**
   * Início automático (seção "Sistema"). NÃO vem da `config`: o estado é do
   * Windows, e o shell o lê do registro a cada `get()`. `undefined` = a
   * resposta ainda não chegou, e os checkboxes ficam travados e desmarcados
   * (ver `loginItemView`).
   */
  const [loginItem, setLoginItem] = useState<LoginItemState | undefined>();

  /**
   * O que a seção "Atalhos" tem a reclamar da tabela em vigor. Sai do
   * `keybindings` recebido (o `GET /api/keybindings`, já com o
   * `keybindings.json` do perfil por cima dos defaults), não de um arquivo lido
   * aqui — a UI não tem acesso ao disco.
   */
  const keysIssues = keybindingIssues(keybindings, lang);
  /**
   * E o que o CORE achou de errado na leitura do arquivo — JSON quebrado, topo
   * que não é objeto, ação desconhecida, valor que não é texto. A UI não tem
   * como deduzir nada disso da tabela recebida (ela chega íntegra, com os
   * defaults no lugar do que foi descartado); é o `problems` da rota que conta.
   */
  const keysNotices = keybindingProblemNotices(keybindingProblems, lang);
  const keysWarning = keybindingsWarning(keysIssues, lang, keysNotices);

  /**
   * Rascunho dos campos de digitar. Eles não podem escrever direto na config:
   * apagar o "1" de "12" pra digitar "14" passaria por "1", que é fora da
   * faixa e viraria um 400 no meio da digitação. O rascunho é o que está na
   * tela; o `commit` é o que vira PATCH.
   */
  const [fontFamilyDraft, setFontFamilyDraft] = useState(() => String(fieldValue(config, 'terminal.fontFamily')));
  const [fontSizeDraft, setFontSizeDraft] = useState(() => String(fieldValue(config, 'terminal.fontSize')));
  const [pollDraft, setPollDraft] = useState(() => String(fieldValue(config, 'gitPollSeconds')));
  const [pricingFileDraft, setPricingFileDraft] = useState(() => String(fieldValue(config, 'usage.pricingFile')));
  const [maxAgentsDraft, setMaxAgentsDraft] = useState(() => String(fieldValue(config, 'sessions.maxConcurrentAgents')));
  /**
   * O relatório de uso, só pra listar os modelos SEM PREÇO — a lista mora no
   * `GET /api/usage`, não na config. Buscado quando a seção "Uso" é aberta (e
   * não ao abrir o diálogo): quem foi mexer na fonte do terminal não precisa
   * fazer o core agregar um mês de consumo.
   */
  const [usage, setUsage] = useState<UsageReport | undefined>();
  /** O `{ files, entries, days }` da ultima releitura — a linha de status do botao. */
  const [rescan, setRescan] = useState<RescanResult | undefined>();

  const configFontFamily = String(fieldValue(config, 'terminal.fontFamily'));
  const configFontSize = Number(fieldValue(config, 'terminal.fontSize'));
  const configPoll = Number(fieldValue(config, 'gitPollSeconds'));
  const configPricingFile = String(fieldValue(config, 'usage.pricingFile'));
  const configMaxAgents = Number(fieldValue(config, 'sessions.maxConcurrentAgents'));

  /**
   * A config de AGORA, pro `catch` do `send`: a `config` capturada na closure
   * é a do render que criou o envio, e o rascunho tem que voltar pro valor que
   * o servidor confirmou por último, não pro que estava na tela quando o
   * usuário começou a digitar.
   */
  const configRef = useRef(config);
  configRef.current = config;

  /** Sequência por campo — descarta resposta de um envio já superado. */
  const seqRef = useRef(makeFieldSeq()).current;

  /** Qual rascunho cada campo de digitar controla (usado no desfazer do erro). */
  const draftSetters: Partial<Record<SettingsField, (value: string) => void>> = {
    'terminal.fontFamily': setFontFamilyDraft,
    'terminal.fontSize': setFontSizeDraft,
    gitPollSeconds: setPollDraft,
    'usage.pricingFile': setPricingFileDraft,
    'sessions.maxConcurrentAgents': setMaxAgentsDraft,
  };

  // Ressincroniza quando a config muda por fora (o `GET` inicial chegando
  // depois do diálogo abrir, um `config.changed` de outra janela, ou o
  // "Restaurar padrões"). Sem isto o rascunho ficaria mostrando o valor velho.
  useEffect(() => {
    setFontFamilyDraft(configFontFamily);
  }, [configFontFamily]);
  useEffect(() => {
    setFontSizeDraft(String(configFontSize));
  }, [configFontSize]);
  useEffect(() => {
    setPollDraft(String(configPoll));
  }, [configPoll]);
  useEffect(() => {
    setPricingFileDraft(configPricingFile);
  }, [configPricingFile]);
  useEffect(() => {
    setMaxAgentsDraft(String(configMaxAgents));
  }, [configMaxAgents]);

  // A lista de modelos sem preço muda com a tabela: reler depois de um PATCH
  // em `usage` (ou de um rescan) é o que faz o modelo recém-precificado sumir
  // da lista sem fechar e reabrir o diálogo.
  const loadUsage = useCallback(() => {
    void api<UsageReport>('/api/usage?range=month')
      .then(setUsage)
      .catch(() => {
        // Core velho (sem a rota) ou erro: a seção fica sem a lista, com o
        // resto dos campos funcionando.
      });
  }, []);

  useEffect(() => {
    if (section !== 'usage') return;
    loadUsage();
  }, [section, loadUsage, config?.usage]);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // Uma leitura só, ao abrir o diálogo: é o registro do Windows, não muda
  // sozinho enquanto ele está aberto (e se mudar por fora, reabrir relê).
  useEffect(() => {
    let alive = true;
    void getBridge()
      .loginItem.get()
      .then((state) => {
        if (alive) setLoginItem(state);
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Um `PATCH`. `key` é o que a sequência ordena (o campo, ou `restore` pro
   * botão de padrões); `field`, quando existe, é o rascunho que volta atrás
   * se o core recusar.
   */
  async function send(patch: BridgeConfigPatch, key: string, field?: SettingsField): Promise<void> {
    const seq = seqRef.bump(key);
    setBusy(true);
    try {
      const next = await api<BridgeConfig>('/api/config', { method: 'PATCH', body: patch });
      // Resposta de um envio já superado: some sem tocar em nada. Aplicá-la
      // faria a config do app voltar pro valor antigo com a tela mostrando o
      // novo.
      if (!seqRef.isLatest(key, seq)) return;
      setError(undefined);
      setBusy(false);
      onSaved(next);
    } catch (err) {
      if (!seqRef.isLatest(key, seq)) return;
      // 400 `invalid-config` e 403 `read-only` já vêm com a frase do core NO
      // IDIOMA CONFIGURADO (a borda a escreve com o `core.language()` do
      // instante da resposta): ela é exibida como veio, sem retraduzir. O
      // resto (rede, 500) cai na mensagem do `ApiError`.
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
      // Nada foi salvo: o campo não pode continuar exibindo o valor recusado,
      // senão a faixa diz "não salvou" e a caixa diz o contrário.
      if (field) draftSetters[field]?.(revertedDraft(configRef.current, field));
    }
  }

  const loginView = loginItemView(loginItem, lang);

  /**
   * Os dois checkboxes da seção "Sistema". O par INTEIRO vai junto (a entrada
   * do registro é reescrita por completo), e o que volta é o estado RELIDO do
   * Windows — não o que foi pedido: em dev o shell devolve o estado de antes,
   * com o motivo, e o checkbox volta sozinho pro lugar em vez de mentir.
   */
  function commitLoginItem(change: { enabled?: boolean; startMinimized?: boolean }): void {
    setBusy(true);
    void getBridge()
      .loginItem.set(nextLoginItem(loginView, change))
      .then((state) => {
        setLoginItem(state);
        setError(undefined);
        setBusy(false);
      })
      .catch((err: unknown) => {
        setError((err as Error).message);
        setBusy(false);
      });
  }

  /** Valor de um campo → validação local → PATCH. Recusa local nem sai da UI. */
  function commit(field: SettingsField, raw: string | number | boolean): void {
    const result = patchForField(field, raw, lang);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    void send(result.patch, field, field);
  }

  const restore = defaultsPatchFor(section);
  const sections = settingsSections(lang);
  const active = sections.find((s) => s.id === section);

  /**
   * A prévia usa o RASCUNHO, não a config: o objetivo dela é responder
   * "essa fonte tem os glifos?" enquanto você digita o nome, antes de salvar.
   * Rascunho vazio cai no token `--font-mono-terminal` do tema.
   */
  const previewFamily = fontFamilyDraft.trim() || 'var(--font-mono-terminal)';
  const previewSize = Number(fontSizeDraft) >= TERMINAL_FONT_SIZE_MIN && Number(fontSizeDraft) <= TERMINAL_FONT_SIZE_MAX
    ? Number(fontSizeDraft)
    : configFontSize;

  return (
    <div
      className="dialog-veil"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.titulo')}
        onKeyDown={(ev) => {
          if (ev.key !== 'Escape') return;
          ev.preventDefault();
          ev.stopPropagation();
          onClose();
        }}
      >
        <div className="dialog-title">
          <span>{t('settings.titulo')}</span>
          <span className="dim">{active?.hint}</span>
          <span className="pane-spacer" />
          <button
            type="button"
            className="icon-button"
            aria-label={t('settings.fechar.rotulo')}
            title={t('settings.fechar.titulo')}
            onClick={onClose}
          >
            <CloseIcon size={10} />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label={t('settings.secoes')}>
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === section ? 'settings-nav-item active' : 'settings-nav-item'}
                aria-current={item.id === section}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === 'terminal' && (
              <>
                <div className="dialog-field">
                  <label htmlFor="set-font">{t('settings.terminal.fonte')}</label>
                  <input
                    id="set-font"
                    ref={firstFieldRef}
                    className="field mono"
                    list="set-font-list"
                    autoComplete="off"
                    spellCheck={false}
                    value={fontFamilyDraft}
                    onChange={(ev) => setFontFamilyDraft(ev.target.value)}
                    onBlur={() => {
                      if (fontFamilyDraft === configFontFamily) return;
                      commit('terminal.fontFamily', fontFamilyDraft);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'Enter') return;
                      ev.preventDefault();
                      commit('terminal.fontFamily', fontFamilyDraft);
                    }}
                  />
                  <datalist id="set-font-list">
                    {MONO_FONT_SUGGESTIONS.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <p className="settings-note dim">{t('settings.terminal.fonte.nota')}</p>
                </div>

                <div className="dialog-field">
                  <label htmlFor="set-size">{t('settings.terminal.tamanho')}</label>
                  <input
                    id="set-size"
                    className="field mono settings-number"
                    type="number"
                    min={TERMINAL_FONT_SIZE_MIN}
                    max={TERMINAL_FONT_SIZE_MAX}
                    step={1}
                    value={fontSizeDraft}
                    onChange={(ev) => {
                      setFontSizeDraft(ev.target.value);
                      // Número válido vira PATCH na hora: é o que faz o
                      // terminal atrás do diálogo mudar de corpo enquanto você
                      // mexe na setinha. Inválido só é reclamado no blur.
                      const result = patchForField('terminal.fontSize', ev.target.value, lang);
                      if (result.ok) void send(result.patch, 'terminal.fontSize', 'terminal.fontSize');
                    }}
                    onBlur={() => {
                      const result = patchForField('terminal.fontSize', fontSizeDraft, lang);
                      if (result.ok) return;
                      setError(result.error);
                      setFontSizeDraft(String(configFontSize));
                    }}
                  />
                </div>

                <div className="dialog-field">
                  <label htmlFor="set-shell">{t('settings.terminal.shell')}</label>
                  <select
                    id="set-shell"
                    className="field"
                    value={String(fieldValue(config, 'shell'))}
                    onChange={(ev) => commit('shell', ev.target.value)}
                  >
                    {shellOptions(lang).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="settings-note dim">{t('settings.terminal.shell.nota')}</p>
                </div>

                <div>
                  <div className="settings-preview" style={{ fontFamily: previewFamily, fontSize: previewSize }}>
                    {FONT_PREVIEW_LINES.map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                  <p className="settings-note dim">{t('settings.terminal.previa.nota')}</p>
                </div>
              </>
            )}

            {section === 'sessions' && (
              <>
                <label className="dialog-check">
                  <input
                    id="set-resume-agents"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'restore.resumeAgents'))}
                    onChange={(ev) => commit('restore.resumeAgents', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.retomar')}</span>
                </label>
                <p className="settings-note dim">
                  {t('settings.sessoes.retomar.nota.parte1')}
                  <code>/exit</code>
                  {t('settings.sessoes.retomar.nota.parte2')}{' '}
                  <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>C</kbd>
                  {t('settings.sessoes.retomar.nota.parte3')}
                </p>

                <label className="dialog-check">
                  <input
                    id="set-schedule-launches"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'sessions.scheduleLaunches'))}
                    onChange={(ev) => commit('sessions.scheduleLaunches', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.escalonar')}</span>
                </label>

                <div className="dialog-field">
                  <label htmlFor="set-max-agents">{t('settings.sessoes.maxAgentes')}</label>
                  <input
                    id="set-max-agents"
                    className="field"
                    type="number"
                    min={MAX_CONCURRENT_AGENTS_MIN}
                    max={MAX_CONCURRENT_AGENTS_MAX}
                    value={maxAgentsDraft}
                    onChange={(ev) => {
                      setMaxAgentsDraft(ev.target.value);
                      const result = patchForField('sessions.maxConcurrentAgents', ev.target.value, lang);
                      if (result.ok) void send(result.patch, 'sessions.maxConcurrentAgents', 'sessions.maxConcurrentAgents');
                    }}
                    onBlur={() => {
                      const result = patchForField('sessions.maxConcurrentAgents', maxAgentsDraft, lang);
                      if (result.ok) return;
                      setError(result.error);
                      setMaxAgentsDraft(String(configMaxAgents));
                    }}
                  />
                  <p className="settings-note dim">{scheduleLaunchesNote(lang)}</p>
                </div>

                <label className="dialog-check">
                  <input
                    id="set-auto-recap"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'sessions.autoRecap'))}
                    onChange={(ev) => commit('sessions.autoRecap', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.autoRecap')}</span>
                </label>
                <p className="settings-note dim">{autoRecapNote(lang)}</p>

                <label className="dialog-check">
                  <input
                    id="set-scope-guard"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'sessions.scopeGuard'))}
                    onChange={(ev) => commit('sessions.scopeGuard', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.escopo')}</span>
                </label>
                <p className="settings-note dim">{scopeGuardNote(lang)}</p>

                <label className="dialog-check">
                  <input
                    id="set-hosted-agents"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'sessions.hostedAgents'))}
                    onChange={(ev) => commit('sessions.hostedAgents', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.hospedados')}</span>
                </label>
                <p className="settings-note dim">{hostedAgentsNote(lang)}</p>

                <label className="dialog-check">
                  <input
                    id="set-mouse-clicks"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'sessions.mouseClicks'))}
                    onChange={(ev) => commit('sessions.mouseClicks', ev.target.checked)}
                  />
                  <span>{t('settings.sessoes.mouse')}</span>
                </label>
                <p className="settings-note dim">{t('settings.sessoes.mouse.nota')}</p>
              </>
            )}

            {section === 'notifications' && (
              <>
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'toast.enabled'))}
                    onChange={(ev) => commit('toast.enabled', ev.target.checked)}
                  />
                  <span>{t('settings.notificacoes.toasts')}</span>
                </label>
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'toast.quietWhenFocused'))}
                    onChange={(ev) => commit('toast.quietWhenFocused', ev.target.checked)}
                  />
                  <span>{t('settings.notificacoes.silenciar')}</span>
                </label>
                <p className="settings-note dim">
                  {t('settings.notificacoes.nota.parte1')}
                  <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd>
                  {t('settings.notificacoes.nota.parte2')}
                </p>
              </>
            )}

            {section === 'usage' && (
              <>
                <label className="dialog-check">
                  <input
                    id="set-show-cost"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'usage.showCost'))}
                    onChange={(ev) => commit('usage.showCost', ev.target.checked)}
                  />
                  <span>{t('settings.uso.mostrarCusto')}</span>
                </label>
                <p className="settings-note dim">
                  {t('settings.uso.mostrarCusto.nota.parte1')} <strong>{t('settings.secao.uso')}</strong> (
                  <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Y</kbd>)
                  {t('settings.uso.mostrarCusto.nota.parte2')}
                  {pricingAsOfLabel(usage?.pricingAsOf, lang) && (
                    <> {t('settings.uso.mostrarCusto.nota.parte3', { tabela: pricingAsOfLabel(usage?.pricingAsOf, lang) ?? '' })}</>
                  )}
                </p>

                <label className="dialog-check">
                  <input
                    id="set-terminal-status-line"
                    type="checkbox"
                    checked={Boolean(fieldValue(config, 'usage.terminalStatusLine'))}
                    onChange={(ev) => commit('usage.terminalStatusLine', ev.target.checked)}
                  />
                  <span>{t('settings.uso.linhaTerminal')}</span>
                </label>
                <p className="settings-note dim">{terminalStatusLineNote(lang)}</p>

                <div className="dialog-field">
                  <label htmlFor="set-pricing-file">{t('settings.uso.arquivoPrecos')}</label>
                  <input
                    id="set-pricing-file"
                    className="field mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('settings.uso.arquivoPrecos.placeholder')}
                    value={pricingFileDraft}
                    onChange={(ev) => setPricingFileDraft(ev.target.value)}
                    onBlur={() => {
                      if (pricingFileDraft === configPricingFile) return;
                      commit('usage.pricingFile', pricingFileDraft);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'Enter') return;
                      ev.preventDefault();
                      commit('usage.pricingFile', pricingFileDraft);
                    }}
                  />
                  <p className="settings-note dim">{pricingFileHint(lang)}</p>
                </div>

                {/*
                  O botão fica AQUI e não só no estado vazio do painel: o rescan
                  é o conserto de duas coisas que não têm outra saída — um
                  transcript reescrito por fora e uma tabela de preços corrigida
                  depois do fato (o custo GRAVADO por dia é retrato da tabela de
                  quando a varredura passou).
                */}
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setRescan(undefined);
                      void api<RescanResult>('/api/usage/rescan', { method: 'POST' })
                        .then((result) => {
                          setError(undefined);
                          setRescan(result);
                          loadUsage();
                        })
                        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : (err as Error).message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {t('settings.uso.reler')}
                  </button>
                  <p className="settings-note dim">{t('settings.uso.reler.nota')}</p>
                  {/*
                    A linha de status é o que faz o botão parar de parecer
                    travado: sem ela, um rescan de 12 GB era um botão cinza por
                    minutos e nenhum sinal de que alguma coisa acontecia. No
                    fim ela vira o resultado — arquivos, mensagens e dias — que
                    é a prova de que releu MESMO.
                  */}
                  {rescanStatus(scanning, rescan, lang) !== undefined && (
                    <p className="settings-note" role="status">
                      {rescanStatus(scanning, rescan, lang)}
                    </p>
                  )}
                  {/* O que a última varredura não leu — ver `scanCaveat`. */}
                  {scanCaveat(scanning, lang) !== undefined && (
                    <p className="settings-note warn" role="status">
                      {scanCaveat(scanning, lang)}
                    </p>
                  )}
                </div>

                {/*
                  A tabela embutida só tem preço de lista público que dá pra
                  afirmar, e os modelos mais novos — justamente os que estão em
                  uso — chegam sem preço. Sem esta lista e sem o exemplo à
                  vista, "preencha usage.pricing" seria uma instrução que exige
                  ler o código.
                */}
                {usage && unpricedModels(usage, lang).length > 0 && (
                  <div className="settings-warn" role="status">
                    <strong>{t('settings.uso.semPreco.titulo')}</strong>
                    <ul>
                      {unpricedModels(usage, lang).map((model) => (
                        <li key={model} className="mono">
                          {model}
                        </li>
                      ))}
                    </ul>
                    <p>
                      {t('settings.uso.semPreco.nota.parte1')} <span className="mono">usage.pricing</span>{' '}
                      {t('settings.uso.semPreco.nota.parte2')} <span className="mono">config.json</span>
                      {t('settings.uso.semPreco.nota.parte3')}
                    </p>
                  </div>
                )}
                <pre className="settings-preview mono settings-pricing-example">{PRICING_EXAMPLE}</pre>
              </>
            )}

            {section === 'git' && (
              <div className="dialog-field">
                <label htmlFor="set-poll">{t('settings.git.intervalo')}</label>
                <input
                  id="set-poll"
                  className="field mono settings-number"
                  type="number"
                  min={GIT_POLL_SECONDS_MIN}
                  max={GIT_POLL_SECONDS_MAX}
                  step={1}
                  value={pollDraft}
                  onChange={(ev) => {
                    setPollDraft(ev.target.value);
                    const result = patchForField('gitPollSeconds', ev.target.value, lang);
                    if (result.ok) void send(result.patch, 'gitPollSeconds', 'gitPollSeconds');
                  }}
                  onBlur={() => {
                    const result = patchForField('gitPollSeconds', pollDraft, lang);
                    if (result.ok) return;
                    setError(result.error);
                    setPollDraft(String(configPoll));
                  }}
                />
                <p className="settings-note dim">{t('settings.git.intervalo.nota')}</p>
              </div>
            )}

            {section === 'keys' && (
              <>
                <div className="settings-note dim">
                  {/*
                    O botão abre a PASTA, não o arquivo: o canal `openPath` do
                    preload só aceita diretório existente (abrir um arquivo
                    qualquer no Windows é executá-lo com o programa associado).
                    E o caminho vem do `profileDir` do core, absoluto — o
                    `%APPDATA%\bridge` literal da primeira versão não abria
                    nada, porque `shell.openPath` não expande variável de
                    ambiente.
                  */}
                  {isElectron() && canOpenProfileFolder(config) ? (
                    <>
                      <button type="button" onClick={() => getBridge().openPath(profileFolderPath(config))}>
                        {profileFolderLabel(lang)}
                      </button>
                      <p>
                        {keybindingsHint(lang)} — <span className="mono settings-path">{profileFolderPath(config)}</span>
                      </p>
                    </>
                  ) : (
                    <p>
                      {t('settings.atalhos.editarEm')}{' '}
                      <span className="mono settings-path">{keybindingsPath(config)}</span>
                    </p>
                  )}
                  <p>{t('settings.atalhos.releitura')}</p>
                </div>
                {/*
                  A tabela mostra o que o core mandou — inclusive combinação que
                  o Bridge não sabe ler e ação com a tecla tomada por outra.
                  Antes as duas apareciam como atalho normal, e o usuário ficava
                  apertando uma tecla que nunca ia disparar.
                */}
                {keysWarning && (
                  <div className="settings-warn" role="status">
                    <strong>{keysWarning}</strong>
                    <ul>
                      {/*
                        Os do core vêm PRIMEIRO: "o arquivo inteiro foi
                        descartado" explica por que a tabela abaixo mostra os
                        atalhos de fábrica, e ler isso depois de três linhas
                        sobre teclas específicas inverte a causa e o efeito.
                      */}
                      {keysNotices.map((notice) => (
                        <li key={notice.id}>{notice.detail}</li>
                      ))}
                      {keysIssues.map((issue) => (
                        <li key={issue.action}>{issue.detail}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <table className="settings-keys">
                  <thead>
                    <tr>
                      <th>{t('settings.atalhos.colunaAcao')}</th>
                      <th>{t('settings.atalhos.colunaAtalho')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keyRows(keybindings, lang).map((row) => (
                      <tr key={row.action} className={row.issue ? 'settings-key-broken' : undefined}>
                        <td>{row.label}</td>
                        <td className="mono">
                          {row.chord}
                          {row.issue && (
                            <span
                              className="settings-key-flag"
                              title={keyIssueTitle(row.issue, lang)}
                              aria-label={keyIssueTitle(row.issue, lang)}
                            >
                              ⚠
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {section === 'system' && (
              <>
                <label className="dialog-check">
                  <input
                    id="set-login-item"
                    type="checkbox"
                    checked={loginView.enabled}
                    disabled={loginView.disabled || busy}
                    onChange={(ev) => commitLoginItem({ enabled: ev.target.checked })}
                  />
                  <span>{loginItemLabel(lang)}</span>
                </label>
                <label className="dialog-check settings-subcheck">
                  <input
                    id="set-login-item-hidden"
                    type="checkbox"
                    checked={loginView.startMinimized}
                    disabled={loginView.minimizedDisabled || busy}
                    onChange={(ev) => commitLoginItem({ startMinimized: ev.target.checked })}
                  />
                  <span>{loginItemMinimizedLabel(lang)}</span>
                </label>
                <p className="settings-note dim">{loginView.note}</p>
                <p className="settings-note dim">
                  {t('settings.sistema.nota.parte1')} <strong>{t('settings.sistema.mostrar')}</strong>{' '}
                  {t('settings.sistema.nota.parte2')}
                </p>
              </>
            )}

            {section === 'appearance' && (
              <>
                {/*
                  Spec §13 — o idioma. Mesmo padrão de commit de todo campo do
                  diálogo: o `select` manda o `PATCH /api/config` na hora, o core
                  responde com a config inteira, e o `config.changed` do WS troca
                  o idioma da janela ANTES mesmo do `onSaved` — não há botão de
                  salvar nem recarga.
                */}
                <div className="dialog-field">
                  <label htmlFor="set-language">{t('settings.aparencia.idioma')}</label>
                  <select
                    id="set-language"
                    className="field"
                    value={String(fieldValue(config, 'ui.language'))}
                    onChange={(ev) => commit('ui.language', ev.target.value)}
                  >
                    {languageOptions(lang).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="settings-note dim">{t('settings.aparencia.idioma.nota')}</p>
                </div>

                <div className="dialog-field">
                  <label htmlFor="set-theme">{t('settings.aparencia.tema')}</label>
                  <select id="set-theme" className="field" value="dark" disabled>
                    <option value="dark">{t('settings.aparencia.tema.escuro')}</option>
                  </select>
                  <p className="settings-note dim">{t('settings.aparencia.tema.nota')}</p>
                </div>
              </>
            )}
          </div>
        </div>

        {error && <div className="error-line">{error}</div>}

        <div className="dialog-actions">
          <span className="dim">
            <kbd>Esc</kbd> {t('settings.rodape.parte1')}
          </span>
          <span className="pane-spacer" />
          {restore && (
            <button type="button" disabled={busy} onClick={() => void send(restore, 'restore')}>
              {t('settings.restaurar')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
