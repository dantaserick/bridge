/**
 * O idioma das superfícies da Task 4 — painel, diálogos, notificações,
 * painel "Uso" e restauração.
 *
 * O que este arquivo prova, e que nenhum outro prova: o MESMO estado, pelos
 * MESMOS modelos, sai em inglês. Os testes de modelo vizinhos
 * (`recap.test.ts`, `restore.test.ts`, `new-task.test.ts`,
 * `environment-ui.test.ts`, `usage-model.test.ts`) fixam `pt-BR` e conferem a
 * copy palavra por palavra — eles provam o TEXTO, não a troca.
 *
 * A divisão de arquivo é a mesma da Task 3: `i18n-ui.test.ts` cobre sidebar,
 * abas, configurações e uso; este cobre o que a Task 4 trouxe.
 */
import { readFileSync } from 'node:fs';
import { t } from '@bridge/shared';
import type { Language, UsageReport } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { environmentNote, environmentOptionSuffix } from '../src/components/NewWorkspaceDialog.js';
import { tableColumns } from '../src/components/usage/UsageTable.js';
import { LOGIN_ITEM_WEB_STATUS } from '../src/bridge.js';
import {
  branchPreview,
  canSubmitTask,
  repoDetectLine,
  taskErrorMessage,
  taskWarning,
} from '../src/newTask.js';
import { emptyPaneActions } from '../src/paneModel.js';
import {
  composeRecapPrompt,
  recapActionLabel,
  recapActionTitle,
  recapBannerText,
  recapDismissLabel,
  recapFailureMessage,
  recapInput,
  recapSentMessage,
} from '../src/recap.js';
import {
  pickRestoreMessage,
  restoreFailureMessage,
  restoreHintBanner,
  restoreResumeBanner,
  resumeFailureMessage,
} from '../src/restore.js';
import { loginItemView } from '../src/settingsModel.js';
import { emptyState, unpricedModels } from '../src/usageModel.js';

const PT = 'pt-BR' as const;
const EN = 'en' as const;
const IDIOMAS: Language[] = [PT, EN];

// ---------------------------------------------------------------- o painel

describe('painel — os dois idiomas', () => {
  it('os três botões do painel vazio', () => {
    expect(emptyPaneActions(EN).map((a) => a.label)).toEqual(['Open shell', 'Open Claude Code', 'Close pane']);
    expect(emptyPaneActions(PT).map((a) => a.label)).toEqual(['Abrir shell', 'Abrir Claude Code', 'Fechar painel']);
  });

  /**
   * O código de saída é NÚMERO — ele sai igual nos dois idiomas, e é a única
   * coisa da faixa que o usuário compara com o que o processo imprimiu.
   */
  it('a faixa de saída carrega o código sem traduzi-lo', () => {
    expect(t(PT, 'pane.encerrou.processo', { codigo: 137 })).toBe('processo encerrou · código 137');
    expect(t(EN, 'pane.encerrou.processo', { codigo: 137 })).toBe('process exited · code 137');
  });

  it('o ✕ do cabeçalho diz o atalho, e explica a espera quando está travado', () => {
    expect(t(EN, 'pane.fechar.titulo')).toContain('Ctrl+Shift+X');
    expect(t(PT, 'pane.fechar.titulo')).toContain('Ctrl+Shift+X');
    expect(t(EN, 'pane.fechar.nascendo')).toContain('session');
    expect(t(PT, 'pane.fechar.nascendo')).toContain('sessão');
  });
});

// ------------------------------------------------- reabrir com contexto (#3)

describe('recap — os dois idiomas', () => {
  it('a faixa e os dois botões', () => {
    expect(recapBannerText(EN)).toBe('The previous conversation was not resumed (Claude opened a new session).');
    expect(recapActionLabel(EN)).toBe('Reopen with context');
    expect(recapDismissLabel(EN)).toBe('Dismiss');
    expect(recapActionTitle(EN)).toContain('Claude Code prompt');
  });

  /**
   * O RESUMO vem do core, já traduzido: aqui ele entra como um texto qualquer
   * e sai INTACTO dos dois lados — o que muda é só a moldura da UI.
   */
  it('o prompt cerca o resumo do core sem mexer nele', () => {
    const resumo = 'Your last request: fix the poller';
    for (const lang of IDIOMAS) {
      expect(composeRecapPrompt(resumo, lang)).toContain(resumo);
    }
    expect(composeRecapPrompt(resumo, EN)).toBe(
      `Context from the previous session (automatic Bridge summary): ${resumo} — Pick up where you left off.`,
    );
  });

  /** A regra que não pode mudar com o idioma: UM Enter, no fim, e só. */
  it('em inglês continua sendo uma linha só, com o Enter no fim', () => {
    const data = recapInput('a b c', EN);
    expect(data.endsWith('\r')).toBe(true);
    expect(data.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('as linhas de status embrulham o motivo do core sem retraduzi-lo', () => {
    expect(recapSentMessage(120, EN)).toBe('Summary of the previous conversation sent to Claude Code (120 characters).');
    expect(recapFailureMessage(new Error('transcript gone'), EN)).toContain('transcript gone');
    expect(recapFailureMessage(new Error('transcript gone'), PT)).toContain('transcript gone');
  });
});

// ------------------------------------------------------------- restauração

describe('restauração — os dois idiomas', () => {
  /**
   * 13/09/2026 — as faixas moram no `Pane`, fora do xterm: texto puro nos dois
   * idiomas, só a frase muda.
   */
  it('as duas faixas são texto puro e trocam só a frase', () => {
    for (const lang of IDIOMAS) {
      for (const faixa of [restoreHintBanner(lang), restoreResumeBanner(lang), restoreResumeBanner(lang, 'abcdef1234')]) {
        expect(faixa).not.toMatch(/\x1b|\r|\n/);
      }
    }
    expect(restoreHintBanner(EN)).toContain('previous session was Claude Code');
    expect(restoreResumeBanner(EN, 'abcdef1234')).toContain('resuming the previous Claude Code session · abcdef12');
  });

  it('o id é cortado em 8 caracteres nos dois idiomas', () => {
    expect(restoreResumeBanner(PT, 'abcdef1234').endsWith('· abcdef12')).toBe(true);
    expect(restoreResumeBanner(EN, 'abcdef1234').endsWith('· abcdef12')).toBe(true);
  });

  it('o singular e o plural do agregado são chaves diferentes', () => {
    const um = [new Error('core down')];
    const dois = [new Error('core down'), new Error('other')];
    expect(restoreFailureMessage(um, EN)).toBe("Couldn't reopen the shell in one pane: core down");
    expect(restoreFailureMessage(dois, EN)).toBe("Couldn't reopen 2 panes: core down");
    expect(restoreFailureMessage(dois, PT)).toBe('Não consegui reabrir 2 painéis: core down');
  });

  /** 409 continua sendo silêncio nos dois idiomas — não é erro, é corrida. */
  it('o 409 do painel ocupado não vira frase em idioma nenhum', () => {
    const busy = [new ApiError('pane busy', 409, 'pane-busy')];
    for (const lang of IDIOMAS) {
      expect(restoreFailureMessage(busy, lang)).toBeUndefined();
      expect(pickRestoreMessage(undefined, busy, lang)).toBeUndefined();
    }
  });

  it('o resume que falhou embrulha o motivo do core', () => {
    expect(resumeFailureMessage(new ApiError('claude not on PATH', 422, 'agent-unavailable'), EN)).toBe(
      "Couldn't resume Claude Code: claude not on PATH",
    );
  });
});

// ---------------------------------------------------------------- diálogos

describe('diálogo "Nova tarefa" — os dois idiomas', () => {
  it('o preview do branch normaliza igual e só a mensagem de erro muda', () => {
    for (const lang of IDIOMAS) {
      expect(branchPreview('Feat Mailbox!', lang)).toEqual({ branch: 'feat-mailbox' });
      expect(branchPreview('   ', lang)).toEqual({});
    }
    expect(branchPreview('!!!', EN)).toEqual({ error: 'invalid name: nothing is left after normalizing' });
    expect(branchPreview('!!!', PT)).toEqual({ error: 'nome inválido: sobra vazio depois de normalizar' });
  });

  /** O que pode ser submetido é a MESMA decisão nos dois idiomas. */
  it('o `canSubmitTask` não muda de resposta com o idioma', () => {
    const draft = { repoId: 'repo-1', name: 'Feat Mailbox', base: 'main', agent: true };
    for (const lang of IDIOMAS) {
      expect(canSubmitTask(draft, lang)).toBe(true);
      expect(canSubmitTask({ ...draft, name: '???' }, lang)).toBe(false);
    }
  });

  it('os erros por CÓDIGO viram frase; o resto passa o texto do core', () => {
    expect(taskErrorMessage(new ApiError('worktree exists', 409, 'exists'), EN)).toBe(
      'A task with that name already exists',
    );
    expect(taskErrorMessage(new ApiError('not a repo', 422, 'not-a-repo'), EN)).toBe(
      'The chosen folder is not a git repository',
    );
    // Sem código conhecido, o `message` do core sai como veio — ele já chegou
    // traduzido, e a UI não o retraduz.
    for (const lang of IDIOMAS) {
      expect(taskErrorMessage(new ApiError('git failed hard', 422, 'git-failed'), lang)).toBe('git failed hard');
    }
  });

  it('o aviso de "criou mas o Claude não subiu" e a linha de detecção', () => {
    const draft = { repoId: 'r', name: 'x', base: 'main', agent: true };
    const created = { workspace: {}, tab: {}, pane: {} } as never;
    expect(taskWarning(draft, created, EN)).toBe("Task created, but Claude didn't start — open it with Ctrl+Shift+C");
    expect(repoDetectLine(null, EN)).toEqual({ ok: false, text: 'not a git repository' });
  });

  /** O caminho e o branch da detecção vêm do DISCO: saem iguais nos dois. */
  it('a linha de detecção positiva não traduz caminho nem branch', () => {
    const info = { root: 'C:\\p\\r', branch: 'main', isWorktree: false, mainPath: 'C:\\p\\r' };
    for (const lang of IDIOMAS) {
      expect(repoDetectLine(info, lang)).toEqual({ ok: true, text: 'C:\\p\\r · main' });
    }
  });

  /**
   * O título da janela de seleção de pasta do Windows. Este diálogo escolhe o
   * REPOSITÓRIO da tarefa; quem escolhe pasta de workspace é o outro. Até a
   * revisão final os dois mandavam a MESMA frase ("Pasta do workspace"), e
   * quem clicava "Escolher pasta…" na nova tarefa via a palavra errada.
   */
  it('o seletor de pasta da nova tarefa pede o REPOSITÓRIO, não o workspace', () => {
    expect(t(PT, 'dialog.task.pasta.prompt')).toBe('Pasta do repositório');
    expect(t(EN, 'dialog.task.pasta.prompt')).toBe('Repository folder');
    expect(t(PT, 'dialog.task.pasta.prompt')).not.toBe(t(PT, 'dialog.workspace.pasta.prompt'));

    // O componente não monta em teste (nenhum teste da UI monta React): o que
    // se prende aqui é a CHAVE que ele passa pro `pickFolder`.
    const dialogo = readFileSync(new URL('../src/components/NewTaskDialog.tsx', import.meta.url), 'utf8');
    expect(dialogo).toContain("pickFolder(t('dialog.task.pasta.prompt'))");
    expect(dialogo).not.toContain('dialog.workspace.pasta.prompt');
    const workspace = readFileSync(new URL('../src/components/NewWorkspaceDialog.tsx', import.meta.url), 'utf8');
    expect(workspace).toContain("pickFolder(t('dialog.workspace.pasta.prompt'))");
  });
});

describe('diálogo "Novo workspace" — os dois idiomas', () => {
  it('a nota do ambiente diz coisas DIFERENTES pro WSL e pro resto', () => {
    expect(environmentNote('wsl:Ubuntu', EN)).toContain('inside the distro');
    expect(environmentNote('pwsh', EN)).toContain('keeps running on Windows');
    expect(environmentNote('', EN)).toContain('Bridge settings');
    // A separação é a mesma em pt-BR (é o defeito que a nota conserta: só no
    // WSL o Claude sobe dentro do ambiente escolhido).
    expect(environmentNote('wsl:Ubuntu', PT)).not.toBe(environmentNote('pwsh', PT));
  });

  it('o sufixo do `<option>` diz o que falta, e ausência de problema é vazio', () => {
    const env = { id: 'wsl:Ubuntu', label: 'WSL · Ubuntu', available: true, claude: true } as never;
    for (const lang of IDIOMAS) {
      expect(environmentOptionSuffix(env, lang)).toBe('');
    }
    expect(environmentOptionSuffix({ ...(env as object), claude: false } as never, EN)).toBe(' — no claude');
    expect(environmentOptionSuffix({ ...(env as object), available: false } as never, EN)).toBe(' — unavailable');
    // Indisponível GANHA de "sem claude": um ambiente que não sobe não precisa
    // dizer o que falta dentro dele.
    expect(environmentOptionSuffix({ ...(env as object), available: false, claude: false } as never, PT)).toBe(
      ' — indisponível',
    );
  });
});

// ------------------------------------------------------------ notificações

describe('painel de avisos — os dois idiomas', () => {
  it('o título, a pílula de não lidas e o estado vazio', () => {
    expect(t(EN, 'notifications.titulo')).toBe('Notifications');
    expect(t(EN, 'notifications.naoLidas', { n: 4 })).toBe('4 unread');
    expect(t(PT, 'notifications.naoLidas', { n: 4 })).toBe('4 não lidas');
    expect(t(EN, 'notifications.vazio')).toBe('Nothing here.');
  });
});

// ------------------------------------------------------------- painel "Uso"

describe('painel "Uso" — os dois idiomas', () => {
  function report(over: Partial<UsageReport> = {}): UsageReport {
    return {
      range: 'mes',
      from: '2026-09-01',
      to: '2026-09-09',
      timezone: 'America/Sao_Paulo',
      totals: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, messages: 0, cost: 0 },
      byModel: [],
      byProject: [],
      byDay: [],
      limits: [],
      pricingAsOf: '2026-09-01',
      pricingWarnings: [],
      claudeHome: 'C:\\Users\\dono\\.claude',
      ...over,
    } as UsageReport;
  }

  it('as colunas da tabela trocam de cabeçalho e mantêm as MESMAS ids', () => {
    const pt = tableColumns('model', true, PT);
    const en = tableColumns('model', true, EN);
    expect(pt.map((c) => c.id)).toEqual(en.map((c) => c.id));
    expect(pt.map((c) => c.header)).toEqual(['Msg', 'Tokens', 'Custo']);
    expect(en.map((c) => c.header)).toEqual(['Msg', 'Tokens', 'Cost']);
    expect(en[1]?.headerTitle).toBe('input + output + cache');
  });

  /** Sem custo, a coluna de dinheiro some — nos dois idiomas, do mesmo jeito. */
  it('com `showCost` desligado o painel não escreve dinheiro em idioma nenhum', () => {
    for (const lang of IDIOMAS) {
      expect(tableColumns('model', false, lang).map((c) => c.id)).toEqual(['msg', 'tok']);
      expect(tableColumns('project', false, lang).map((c) => c.id)).toEqual(['share', 'msg', 'tok']);
    }
  });

  it('o estado vazio aponta a MESMA pasta e traduz só a frase em volta', () => {
    const vazio = report();
    for (const lang of IDIOMAS) {
      // O `home` do estado vazio é a pasta de TRANSCRIÇÕES (`<claudeHome>\projects`):
      // caminho de disco, e caminho não se traduz.
      expect(emptyState(vazio, lang).home).toBe('C:\\Users\\dono\\.claude\\projects');
    }
    expect(emptyState(vazio, EN).title).toBe('No transcripts found in');
    expect(emptyState(vazio, PT).title).toBe('Nenhuma transcrição encontrada em');
  });

  /** O NOME do modelo sem preço é identificador: sai igual nos dois. */
  it('a lista de modelos sem preço não traduz o nome do modelo', () => {
    const semPreco = report({
      byModel: [{ model: 'claude-modelo-novo', messages: 2, input: 1, output: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0, unpriced: true }],
    } as Partial<UsageReport>);
    for (const lang of IDIOMAS) {
      expect(unpricedModels(semPreco, lang)).toContain('claude-modelo-novo');
    }
  });

  it('o rodapé e o aviso citam o MESMO caminho de navegação', () => {
    expect(t(EN, 'uso.painel.configuracoesUso')).toBe('Settings → Usage');
    expect(t(PT, 'uso.painel.configuracoesUso')).toBe('Configurações → Uso');
    // O rótulo em negrito do rodapé é o MESMO do cartão de total: uma frase só,
    // porque a ordem das palavras muda entre os idiomas.
    expect(t(EN, 'uso.cartao.custo')).toBe('Estimated cost');
    expect(t(PT, 'uso.cartao.custo')).toBe('Custo estimado');
  });
});

// ------------------------------------------- a seção "Sistema" (chave × frase)

describe('início automático — a chave do shell vira frase no idioma da JANELA', () => {
  /**
   * O `status` do `LoginItemState` é uma CHAVE de catálogo desde a Task 4: ela
   * atravessa o IPC vinda do processo main, que resolve o idioma na hora dele.
   * É esta função que a traduz, com o idioma da janela — e é isso que impede a
   * seção "Sistema" de ficar numa língua e o resto do diálogo em outra.
   */
  it('traduz a chave que veio do shell', () => {
    const state = { enabled: true, startMinimized: false, supported: false, status: 'shell.loginItem.dev' } as const;
    expect(loginItemView(state, PT).note).toContain('app instalado');
    expect(loginItemView(state, EN).note).toContain('installed app');
  });

  it('a UI fora do app tem a chave dela, e ela existe nos dois catálogos', () => {
    const web = { enabled: false, startMinimized: false, supported: false, status: LOGIN_ITEM_WEB_STATUS } as const;
    expect(loginItemView(web, PT).note).toBe('O início automático com o Windows está disponível só no app instalado.');
    expect(loginItemView(web, EN).note).toBe('Starting with Windows is only available in the installed app.');
  });

  /** Com suporte, não há motivo nenhum a mostrar — e vazio não vira chave. */
  it('status vazio não vira chave', () => {
    const ok = { enabled: true, startMinimized: false, supported: false, status: '' } as const;
    for (const lang of IDIOMAS) {
      expect(loginItemView(ok, lang).note).toBe('');
    }
  });
});
