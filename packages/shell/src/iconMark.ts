/**
 * Rasterização pura do `BridgeMark` (arco + base + dois pilares, mesmos paths
 * de `packages/ui/src/components/icons.tsx`, viewBox 16×16, stroke 1.5) —
 * usada tanto pelo ícone do app (`makeIco.ts`) quanto pelo tray (`tray.ts`),
 * pra garantir que os dois desenhem exatamente a mesma marca.
 *
 * Sem canvas nem SVG: distância analítica (SDF) por segmento + feather de
 * ~1px, em vez de supersample — determinístico, barato e sem serrilhado em
 * qualquer tamanho.
 */

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const ARC_STEPS = 32;

function quadraticBezierSegments(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  steps: number,
): Segment[] {
  const segs: Segment[] = [];
  let prevX = p0[0];
  let prevY = p0[1];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    segs.push({ x1: prevX, y1: prevY, x2: x, y2: y });
    prevX = x;
    prevY = y;
  }
  return segs;
}

/**
 * `M2 11 L2 6 Q8 1 14 6 L14 11` + `M2 11 L14 11` + `M5.5 11 L5.5 7.5 M10.5 11
 * L10.5 7.5` — os três paths de `BridgeMark`, em espaço de viewBox 16×16.
 */
export const MARK_SEGMENTS: readonly Segment[] = [
  { x1: 2, y1: 11, x2: 2, y2: 6 },
  ...quadraticBezierSegments([2, 6], [8, 1], [14, 6], ARC_STEPS),
  { x1: 14, y1: 6, x2: 14, y2: 11 },
  { x1: 2, y1: 11, x2: 14, y2: 11 },
  { x1: 5.5, y1: 11, x2: 5.5, y2: 7.5 },
  { x1: 10.5, y1: 11, x2: 10.5, y2: 7.5 },
];

function distToSegment(px: number, py: number, seg: Segment): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.x1 + t * dx;
  const cy = seg.y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToMark(mx: number, my: number): number {
  let best = Infinity;
  for (const seg of MARK_SEGMENTS) {
    const d = distToSegment(mx, my, seg);
    if (d < best) best = d;
  }
  return best;
}

/** SDF de um quadrado de cantos arredondados centrado em `(cx, cy)`. */
function sdRoundedBox(px: number, py: number, cx: number, cy: number, halfExtent: number, radius: number): number {
  const qx = Math.abs(px - cx) - (halfExtent - radius);
  const qy = Math.abs(py - cy) - (halfExtent - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** `#e4e4e7` — cor da marca (spec). */
export const MARK_COLOR: RgbColor = { r: 0xe4, g: 0xe4, b: 0xe7 };
/** `#27272a` — `--bg-elevated`/`--border` (spec). */
export const BACKGROUND_COLOR: RgbColor = { r: 0x27, g: 0x27, b: 0x2a };

export interface RenderMarkOptions {
  /** Cor de fundo do quadrado arredondado; `null` = sem fundo (tray, transparente). */
  background?: RgbColor | null;
  markColor?: RgbColor;
  /** Fração do lado ocupada pelo viewBox 16×16 inteiro da marca. Spec: 0.62. */
  markScale?: number;
  /** Fração do lado usada como raio dos cantos do fundo. Spec: 0.22. */
  cornerRadiusFraction?: number;
}

/**
 * Desenha o `BridgeMark` (+ fundo arredondado opcional) num buffer RGBA
 * `size×size`, reto (straight alpha), pronto pra `encodePng`.
 */
export function renderMarkRgba(size: number, opts: RenderMarkOptions = {}): Buffer {
  const background = opts.background === undefined ? BACKGROUND_COLOR : opts.background;
  const markColor = opts.markColor ?? MARK_COLOR;
  const markScale = opts.markScale ?? 0.62;
  const cornerRadiusFraction = opts.cornerRadiusFraction ?? 0.22;

  // A marca inteira vive no viewBox 0..16; `k` escala esse viewBox pra ocupar
  // `markScale` do lado do ícone, centrado.
  const k = (markScale * size) / 16;
  const halfStroke = (1.5 * k) / 2;
  const origin = (size - 16 * k) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const radius = cornerRadiusFraction * size;
  const halfExtent = size / 2;

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;

      let bgA = 0;
      if (background) {
        const d = sdRoundedBox(px, py, cx, cy, halfExtent, radius);
        bgA = clamp01(0.5 - d);
      }

      const mx = (px - origin) / k;
      const my = (py - origin) / k;
      const dMarkPixels = distToMark(mx, my) * k;
      const markA = clamp01(halfStroke - dMarkPixels + 0.5);

      const outA = markA + bgA * (1 - markA);
      let r = 0;
      let g = 0;
      let b = 0;
      if (outA > 0) {
        const bgColor = background ?? BACKGROUND_COLOR;
        const dstFactor = bgA * (1 - markA);
        r = (markColor.r * markA + bgColor.r * dstFactor) / outA;
        g = (markColor.g * markA + bgColor.g * dstFactor) / outA;
        b = (markColor.b * markA + bgColor.b * dstFactor) / outA;
      }

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(outA * 255);
    }
  }
  return rgba;
}
