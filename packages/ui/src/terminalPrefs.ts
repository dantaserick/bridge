/**
 * Preferências de render do terminal (xterm).
 *
 * Por que este arquivo existe: a fonte do terminal deixou de ser detalhe do
 * `Terminal.tsx` quando virou configuração (Task 5 do lote de 04/09/2026 liga
 * `config.terminal` do core nestas props). O default mora aqui, em função pura
 * e testável, e o core copia os MESMOS valores (ele não importa da UI).
 *
 * ## Por que o `Geist Mono` saiu da frente
 *
 * O `geist-mono-variable.woff2` embutido em `public/fonts/` é um subset de
 * 225 codepoints: Latin-1 e pouco mais. Ele NÃO tem box-drawing (U+2500–257F),
 * blocos (U+2580–259F), braille (U+2800–28FF), setas nem símbolo nenhum —
 * exatamente o que o logo do Claude Code (feito de `▐▛███▛█` / `▝▜██████▀`) e
 * a statusline do Claude Code imprimem.
 *
 * O browser resolve fonte POR GLIFO. Com o Geist Mono na frente, as letras
 * saíam dele (avanço 7,20 px em 12 px) e todo símbolo caía na fonte seguinte
 * da lista, com avanço próprio. O xterm mede a célula com um 'W' — ou seja,
 * pelo Geist —, então cada símbolo era desenhado numa largura que não é a da
 * célula. Medido no renderer do Electron, com a lista antiga
 * (`'Geist Mono','Cascadia Mono',Consolas,…`): 'W' = 7,20 px e ─ █ ▛ ▝ ⣿ →
 * = 7,03 px. Meio por cento de erro por coluna vira ~27 px de deriva numa
 * linha de 160 colunas: é o logo esmigalhado e a régua `────` que não fecha.
 *
 * ## Por que `Cascadia Mono` na frente
 *
 * Cobertura medida no `cmap`: box-drawing 128/128, blocos 32/32, formas
 * geométricas 96/96, braille 256/256, ─ ╭ █ ░ ⣿ → ● ◐ ▸ ✓ todos presentes. E,
 * o que importa mais: TODOS no mesmo avanço do 'W' (7,03 px em 12 px), então
 * a célula que o xterm mede é a largura real de cada glifo.
 *
 * Ela NÃO está em `C:\Windows\Fonts` nem em
 * `%LOCALAPPDATA%\Microsoft\Windows\Fonts` — vem no pacote MSIX do Windows
 * Terminal (`…\WindowsApps\Microsoft.WindowsTerminal_…\CascadiaMono.ttf`),
 * que a registra na coleção de fontes do DirectWrite. Nada foi baixado: o
 * Chromium do Electron a enxerga (medida de controle: família inexistente
 * devolve o Segoe UI, 'W' = 11,33 px; `'Cascadia Mono'` devolve 7,03 px
 * uniforme).
 *
 * O `Consolas` (sempre presente no Windows) fica em segundo como rede de
 * segurança se o Windows Terminal for desinstalado: ele tem box-drawing
 * 128/128, mas só 8/32 dos blocos — falta justamente o quadrante
 * (U+2596–259F) do logo do Claude, que sem a Cascadia cai no Segoe UI Symbol
 * a 11,26 px numa célula de 6,60 px. O Geist Mono fica atrás como escolha
 * "bonita" pra quem preferir, e `ui-monospace`/`monospace` fecham a lista.
 *
 * O que continua caindo em fallback (nenhuma mono da máquina tem): ✻ U+273B,
 * ❄ U+2744, ⛔ U+26D4 e os emoji que o agente imprime. Ver a nota
 * "Terminal: fonte" do README.
 */
import { DEFAULT_STORED_CONFIG } from '@bridge/shared';

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
}

/**
 * Default do terminal — o nome que a UI usa pro `DEFAULT_STORED_CONFIG.terminal`
 * do `@bridge/shared`. Desde o lote de 04/09/2026 é um alias derivado, não uma
 * cópia à mão: o core lê o MESMO objeto (`packages/core/src/profile.ts`), então
 * não existe mais o par que podia divergir em silêncio. Um teste amarra os dois.
 */
export const TERMINAL_DEFAULTS: TerminalPrefs = { ...DEFAULT_STORED_CONFIG.terminal };

/** Menor e maior tamanho aceitos (o mesmo intervalo que a API vai validar). */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 24;

/**
 * Resolve o que o `Terminal` vai passar pro xterm: prop ausente, vazia ou
 * fora do intervalo cai no default em vez de virar um terminal ilegível.
 */
export function resolveTerminalPrefs(prefs: Partial<TerminalPrefs> | undefined): TerminalPrefs {
  const family = prefs?.fontFamily?.trim();
  const size = prefs?.fontSize;
  const sizeOk =
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= TERMINAL_FONT_SIZE_MIN &&
    size <= TERMINAL_FONT_SIZE_MAX;
  return {
    fontFamily: family ? family : TERMINAL_DEFAULTS.fontFamily,
    fontSize: sizeOk ? size : TERMINAL_DEFAULTS.fontSize,
  };
}
