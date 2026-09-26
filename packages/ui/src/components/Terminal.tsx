import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { terminalKeyAction } from '../terminalClipboard.js';
import { focusResyncNeeded } from '../terminalFocus.js';
import { isMouseOnlyDecset, modeSequences, nextMouseEncoding, snapshotModes } from '../terminalModes.js';
import type { MouseEncoding } from '../terminalModes.js';
import { resolveTerminalPrefs } from '../terminalPrefs.js';
import { bridgeWs } from '../ws.js';
import { gridAfterSync } from '../terminalGrid.js';
import type { Grid } from '../terminalGrid.js';

interface Props {
  sessionId: string;
  focused: boolean;
  /** Fonte do terminal; ausente = `TERMINAL_DEFAULTS.fontFamily` (ver `terminalPrefs.ts`). */
  fontFamily?: string;
  /** Corpo da fonte em px (8–24); ausente ou fora do intervalo = 12. */
  fontSize?: number;
  /**
   * `sessions.mouseClicks` (12/09/2026). `false` = o terminal ENGOLE os
   * pedidos de rastreio de mouse do programa (DECSET 9/1000/1002/1003/1005/
   * 1006/1015): arrastar sempre seleciona texto e clique nenhum vai ao PTY.
   * `true` (default) = comportamento normal do xterm — o programa que pediu o
   * mouse recebe os cliques.
   */
  mouseReporting?: boolean;
}

/** Janela do debounce do `ResizeObserver` (arraste de divisor dispara por frame). */
const RESIZE_DEBOUNCE_MS = 50;

/** Tokens de `design/tokens.json`: bgTerminal, textTerminal, accent. */
const XTERM_THEME = {
  background: '#111114',
  foreground: '#D4D4D8',
  cursor: '#5B8DEF',
};

/**
 * O que a API assíncrona de clipboard respondeu até agora.
 *
 * Medido no Electron 44 do Bridge (07/09/2026): a UI é servida em
 * `http://127.0.0.1:<porta>`, que o Chromium trata como contexto seguro, e a
 * sessão padrão da janela principal (que não tem `setPermissionRequestHandler`
 * nenhum) devolve
 * `clipboard-read: granted`. Então o caminho normal é o `navigator.clipboard`.
 *
 * `'blocked'` só existe pro dia em que um Electron novo apertar esse default:
 * a partir da primeira leitura recusada a colagem para de chamar
 * `preventDefault()` e deixa o Chromium colar sozinho (o `keydown` não
 * cancelado vira um evento `paste` na textarea auxiliar, que o próprio xterm
 * escuta). Custa uma tecla — a primeira recusa — e depois volta a funcionar.
 */
let clipboardReadState: 'unknown' | 'ok' | 'blocked' = 'unknown';

/**
 * Escreve `text` no clipboard sem depender de permissão: textarea fora da tela
 * + `execCommand('copy')`. É o plano B do `navigator.clipboard.writeText`.
 *
 * Não dá pra usar o listener de `copy` que o xterm registra no container: ele
 * responde a um evento `copy` do navegador, e o xterm não cria seleção de DOM
 * nenhuma (a seleção dele é desenhada, não é `document.getSelection()`), então
 * um `execCommand('copy')` seco não teria o que copiar.
 */
function copyByExecCommand(text: string): void {
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.top = '-1000px';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    document.execCommand('copy');
  } catch {
    // Sem clipboard nenhum: não há mais o que tentar.
  } finally {
    helper.remove();
  }
}

/** Copia a seleção do terminal e desmarca (convenção do Windows Terminal). */
function copySelection(term: XTerm): void {
  const text = term.getSelection();
  if (!text) return;
  // Desmarca JÁ, e não quando a escrita resolver: nenhum dos dois caminhos
  // precisa da seleção do xterm (o plano B leva o texto numa textarea própria),
  // e assim o retorno visual é imediato — e não sobra `clearSelection` pendente
  // pra rodar depois de um `term.dispose()`.
  term.clearSelection();
  void navigator.clipboard.writeText(text).catch(() => copyByExecCommand(text));
}

/**
 * Lê o clipboard e entrega ao terminal. `term.paste` embrulha em bracketed
 * paste quando a aplicação ligou o modo 2004 — o Claude Code liga, e é isso que
 * faz uma URL de várias linhas chegar como UMA entrada em vez de virar N Enters.
 */
function pasteFromClipboard(term: XTerm): void {
  void navigator.clipboard.readText().then(
    (text) => {
      clipboardReadState = 'ok';
      if (!text) return;
      try {
        term.paste(text);
      } catch {
        // O painel foi fechado entre a tecla e a leitura do clipboard: o
        // terminal já foi descartado e não há onde colar.
      }
    },
    () => {
      clipboardReadState = 'blocked';
    },
  );
}

/**
 * `fit()` lança quando o container tem dimensão zero (painel escondido) —
 * ignora. O `fit()` do addon sai calado quando o container não tem layout
 * (`proposeDimensions` volta `undefined`).
 */
function safeFit(fit: FitAddon): void {
  try {
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) return;
    fit.fit();
  } catch {
    // container ainda escondido (display:none) ou sem layout — tenta de novo no próximo resize/foco.
  }
}

export function Terminal({
  sessionId,
  focused,
  fontFamily,
  fontSize,
  mouseReporting = true,
}: Props): JSX.Element {
  const prefs = resolveTerminalPrefs({ fontFamily, fontSize });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Ordena os fetches de scrollback: o da montagem e o da reconexão podem
   *  cruzar, e o que chega atrasado não pode escrever por cima do mais novo. */
  const fetchSeqRef = useRef(0);
  /** Falso enquanto o terminal atual ainda não passou pelo efeito de fonte. */
  const mountedPrefsRef = useRef(false);
  /**
   * Última grade que o core soube (`cols`/`rows`). O `ResizeObserver` já
   * guardava a dele em variáveis locais do efeito de montagem; a troca de
   * fonte precisa de um ref porque roda em OUTRO efeito, e sem ela um PATCH
   * de `fontFamily` que não muda a grade (trocar Consolas por Cascadia no
   * mesmo corpo, por exemplo) mandava um `resize` inútil pro ConPTY.
   */
  const gridRef = useRef<Grid | undefined>(undefined);
  /**
   * `mouseReporting` lido de DENTRO dos listeners da montagem (o efeito só
   * refaz na troca de `sessionId`, e uma prop capturada ali congelaria no
   * valor do primeiro render): o handler de DECSET é registrado uma vez.
   */
  const mouseReportingRef = useRef(mouseReporting);
  mouseReportingRef.current = mouseReporting;
  /** Encoding do mouse que o programa pediu (1005/1006/1015) — o xterm não o expõe. */
  const mouseEncodingRef = useRef<MouseEncoding>('default');

  /**
   * O único lugar que conta a grade pro core. `fit()` primeiro, `resize` só se
   * `cols`/`rows` mudaram de verdade (arrastar poucos pixels não muda a grade
   * de caracteres).
   *
   * Lê os refs, nunca props: ele é chamado de listeners registrados na
   * montagem.
   */
  function fitAndSync(): void {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    safeFit(fit);
    syncGrid(term);
  }

  /**
   * Conta a grade pro core, se e quando ela mudou.
   *
   * `gridRef` é "o que o core JÁ SABE", e por isso ele só é escrito quando a
   * mensagem de fato SAIU: o `bridgeWs.send` descarta em silêncio o que é
   * mandado com o socket fora do ar (não há fila), e a UI manda o
   * `GET /api/state` ANTES de abrir o WS — então o primeiro `fit()` de um
   * terminal pode muito bem acontecer com o handshake em voo. Gravando a grade
   * assim mesmo, todo `fit()` seguinte deduplicaria em cima de um tamanho que
   * o core nunca recebeu, e o PTY ficaria com as colunas erradas até alguém
   * redimensionar o painel na mão.
   *
   * Quem repara o caso é o `onConnected` da montagem: com a grade ainda por
   * confirmar, o primeiro socket aberto dispara outro `fitAndSync`, e aí o
   * dedupe vê a diferença e manda de novo.
   */
  function syncGrid(term: XTerm): void {
    const last = gridRef.current;
    const next: Grid = { cols: term.cols, rows: term.rows };
    // As duas perguntas do `gridAfterSync`, na ordem: mandar? e, depois da
    // tentativa, o core passou a saber?
    if (!gridAfterSync(last, next, false).send) return;
    const sent = bridgeWs.send({ type: 'resize', sessionId, cols: next.cols, rows: next.rows });
    gridRef.current = gridAfterSync(last, next, sent).grid;
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    mountedPrefsRef.current = false;

    const term = new XTerm({
      // Exigido pelo Unicode11Addon (API proposta); sem isso o xterm lança na
      // montagem e o renderer inteiro fica em branco.
      allowProposedApi: true,
      convertEol: false,
      theme: XTERM_THEME,
      fontSize: prefs.fontSize,
      // `design/tokens.json → font.lineTerminal`. Era 1.5 e quebrava o logo do
      // Claude em fileiras soltas (blocos de célula inteira nunca se tocavam);
      // 1.0 é o padrão do xterm e o que todo terminal usa — ruling do controller
      // no lote de 04/09/2026, token atualizado junto.
      lineHeight: 1,
      fontFamily: prefs.fontFamily,
      // Explícito (já é o default do xterm 5.x) pra deixar registrado o que
      // ele NÃO resolve aqui: box-drawing e blocos desenhados pelo próprio
      // xterm só existem nos renderers de canvas/WebGL, que são addons
      // (`@xterm/addon-canvas`, `@xterm/addon-webgl`) e não estão instalados.
      // O Bridge roda o renderer DOM, onde todo glifo vem da fonte — por isso
      // a correção do logo é a ordem da `fontFamily`, não esta flag.
      customGlyphs: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Largura de emoji/símbolos wide pela tabela Unicode 11 (a embutida no
    // xterm é a 6, que conta 🟢 🧭 como 1 célula e encavala a saída do
    // agente). Instalado com autorização do dono em 04/09/2026.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(container);

    /**
     * Clique desligado (`sessions.mouseClicks: false`): o programa pede o
     * mouse (`CSI ? 1000 h`, `?1006h`…) e o xterm finge que não ouviu — sem
     * o modo ligado ele nunca manda clique pro PTY, e arrastar segue
     * selecionando. Só o pedido SÓ de mouse é engolido (`isMouseOnlyDecset`);
     * um misto passa inteiro pra não perder o resto. Lido do ref porque o
     * handler vive a montagem inteira e a preferência pode mudar no meio.
     */
    const decset = (enabled: boolean) => (params: (number | number[])[]): boolean => {
      const flat = params.map((p) => (Array.isArray(p) ? p[0] ?? 0 : p));
      if (!mouseReportingRef.current && isMouseOnlyDecset(flat)) return true;
      // O xterm não expõe o encoding do mouse em `term.modes`: rastreado aqui
      // pra reaplicar depois do `reset()` da reconexão (`terminalModes.ts`).
      mouseEncodingRef.current = nextMouseEncoding(mouseEncodingRef.current, flat, enabled);
      return false;
    };
    const mouseSet = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
    const mouseReset = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));
    termRef.current = term;
    fitRef.current = fit;

    /**
     * Foco "de mentira" (14/09/2026) — ver `terminalFocus.ts`. Roda na captura
     * do `keydown` do container (antes do listener do xterm na textarea) e
     * quando a janela recupera o foco. Se a textarea é o elemento ativo mas o
     * xterm se acha desfocado, `blur()` + `focus()` reemitem o par de eventos:
     * o programa recebe `ESC[O` `ESC[I` na ordem certa, o cursor volta a
     * encher, e a tecla que disparou o conserto segue o caminho normal.
     */
    const resyncFocus = (): void => {
      const textarea = term.textarea;
      const element = term.element;
      if (!textarea || !element) return;
      const needed = focusResyncNeeded({
        textareaIsActive: document.activeElement === textarea,
        documentHasFocus: document.hasFocus(),
        xtermBelievesFocused: element.classList.contains('focus'),
      });
      if (!needed) return;
      textarea.blur();
      textarea.focus({ preventScroll: true });
      // Fica no console de propósito: é a prova, na próxima vez que o cursor
      // vazar, de que o estado era este e não outro.
      console.warn('[bridge] xterm achava que estava sem foco com a textarea ativa; foco ressincronizado', { sessionId });
    };
    const onWindowFocus = (): void => {
      // Depois do `focus` que o Chromium (normalmente) reemite no elemento ativo.
      setTimeout(resyncFocus, 0);
    };
    container.addEventListener('keydown', resyncFocus, true);
    window.addEventListener('focus', onWindowFocus);

    // A faixa do painel restaurado não mora mais aqui (13/09/2026): o ConPTY
    // abre toda sessão com `ESC[2J ESC[H` e o prompt era desenhado por cima
    // dela. Ela é uma linha do `Pane` agora — ver `restoreHintBanner`.

    /**
     * Busca o scrollback do core e escreve — só se ainda for o pedido mais
     * recente (`seq`). `reset` limpa a tela antes; com corpo vazio (sessão que
     * o core já esqueceu) não mexe em nada, pra não apagar o que está na tela.
     */
    function loadScrollback(reset: boolean): void {
      fetchSeqRef.current += 1;
      const seq = fetchSeqRef.current;
      let restoreModes = '';
      void api<{ data: string }>(`/api/sessions/${sessionId}/scrollback`).then((res) => {
        if (seq !== fetchSeqRef.current) return;
        if (reset) {
          if (!res.data) return;
          // O `reset()` zera os modos privados que o programa ligou (mouse,
          // colar entre chaves, setas de aplicação) e o scrollback não os
          // traz de volta: guarda antes, reaplica depois (`terminalModes.ts`).
          const modes = snapshotModes(term.modes, mouseEncodingRef.current, term.buffer.active.type === 'alternate');
          term.reset();
          restoreModes = modeSequences(modes);
        }
        term.write(res.data);
        if (restoreModes) term.write(restoreModes);
        // O scrollback pode ser o primeiro conteúdo a dar altura ao terminal.
        fitAndSync();
      });
    }

    loadScrollback(false);

    const unsubscribeData = bridgeWs.onPtyData(sessionId, (data) => term.write(data));

    // Reconexão: o que o PTY cuspiu enquanto o socket estava fora nunca chega
    // por evento. Redesenha do scrollback do core em vez de continuar
    // escrevendo por cima de uma tela com buraco no meio.
    const unsubscribeReconnect = bridgeWs.onReconnected(() => loadScrollback(true));

    /**
     * Socket aberto (o primeiro inclusive): se a grade ainda estiver por
     * confirmar — o `fit()` da montagem correu com o handshake em voo e o
     * `resize` foi descartado —, este `fitAndSync` a manda de novo. Com a
     * grade já confirmada ele dedupe e não custa nada.
     */
    const unsubscribeConnected = bridgeWs.onConnected(() => fitAndSync());

    const onData = term.onData((data) => {
      bridgeWs.send({ type: 'input', sessionId, data });
    });

    /**
     * Copiar e colar (0.11.1). Sem isto, o xterm 5.5 transforma Ctrl+letra em
     * byte de controle e cancela o `keydown`: Ctrl+V ia como `^V` (0x16) pro
     * PTY e a colagem nativa nunca acontecia; Ctrl+C ia como `^C` e nunca
     * copiava. A regra de quem faz o quê está em `terminalClipboard.ts`.
     *
     * `return false` faz o xterm sair ANTES de gerar o byte — e, de propósito,
     * sem `preventDefault()` do lado dele. Quem cancela o evento é este handler,
     * e só quando vai fazer o trabalho por conta própria: com `preventDefault()`
     * a colagem nativa do Chromium não dispara, o que evita colar duas vezes.
     */
    term.attachCustomKeyEventHandler((ev) => {
      const action = terminalKeyAction(ev, term.hasSelection());
      if (action === 'passthrough') return true;
      if (action === 'copy') {
        ev.preventDefault();
        copySelection(term);
        return false;
      }
      // Leitura recusada antes (ver `clipboardReadState`): sai sem cancelar o
      // evento e deixa o Chromium colar sozinho pelo caminho nativo. Não tenta
      // ler de novo aqui — se as duas colagens funcionassem, colaria em dobro.
      if (clipboardReadState === 'blocked') return false;
      ev.preventDefault();
      pasteFromClipboard(term);
      return false;
    });

    /**
     * Botão direito: com seleção copia (e desmarca), sem seleção cola. É o que
     * o Windows Terminal faz, e evita ter que inventar um menu de contexto —
     * o app não tem menu de aplicação nenhum (`Menu.setApplicationMenu(null)`).
     */
    const onContextMenu = (ev: MouseEvent): void => {
      ev.preventDefault();
      if (term.hasSelection()) copySelection(term);
      else pasteFromClipboard(term);
    };
    container.addEventListener('contextmenu', onContextMenu);

    /**
     * Arrastar o divisor de um split dispara `ResizeObserver` a cada frame, e
     * cada disparo era um `fit()` (que remede o DOM inteiro) mais um `resize`
     * pelo WS — que no core vira `ConPTY.resize`. Duas defesas: 50 ms de
     * debounce e, no fim, só manda se `cols`/`rows` mudaram de verdade
     * (arrastar poucos pixels não muda a grade de caracteres).
     */
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * A grade nasce POR CONFIRMAR, e não com a do xterm recém-criado.
     *
     * O `term.cols`/`term.rows` daqui são os 80×24 do construtor — o `fit()`
     * ainda não rodou. Semeando o ref com eles, um painel cuja primeira
     * medição desse exatamente 80×24 deduplicaria o PRIMEIRO `resize` e nunca
     * contaria a grade pro core: o PTY ficaria com os `DEFAULT_COLS` (120) e o
     * terminal desenharia 80 colunas, com quebra de linha errada, até alguém
     * arrastar o divisor. `undefined` = "o core não sabe de nada ainda", que é
     * a verdade — e o `syncGrid` só passa a deduplicar depois que um `resize`
     * de fato SAIU (ver o comentário dele).
     *
     * O ref (e não uma variável local) porque o efeito de fonte, lá embaixo,
     * aplica a MESMA regra e tem que ver a mesma grade.
     */
    gridRef.current = undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        fitAndSync();
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    return () => {
      unsubscribeData();
      unsubscribeReconnect();
      unsubscribeConnected();
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('keydown', resyncFocus, true);
      window.removeEventListener('focus', onWindowFocus);
      mouseSet.dispose();
      mouseReset.dispose();
      onData.dispose();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /**
   * Troca de fonte ao vivo (as configurações da Task 5 mexem nisto com
   * terminais já abertos): muda as opções do xterm, remede a grade e avisa o
   * core — corpo de fonte diferente muda `cols`/`rows`, e o ConPTY do outro
   * lado precisa saber. Não roda na montagem porque o efeito de cima já
   * criou o terminal com estes valores.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!mountedPrefsRef.current) {
      mountedPrefsRef.current = true;
      return;
    }
    term.options.fontFamily = prefs.fontFamily;
    term.options.fontSize = prefs.fontSize;
    // Mesmo dedupe do `ResizeObserver`:
    // trocar a família de fonte sem mudar a largura da célula mantém
    // `cols`/`rows`, e o ConPTY não tem o que saber.
    fitAndSync();
  }, [prefs.fontFamily, prefs.fontSize, sessionId]);

  useEffect(() => {
    if (!focused) return;
    fitAndSync();
    termRef.current?.focus();
  }, [focused]);

  // Quem esconde é o `Pane`: o terminal fica montado mesmo fora da aba ativa
  // (o scrollback do xterm é a única cópia do que rolou na tela).
  return (
    <div className="terminal-body">
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
