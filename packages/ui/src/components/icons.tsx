/**
 * Ícones da UI: SVG traçado 1.5-1.6px, `currentColor`, sem emoji (DESIGN.md).
 * Todos herdam tamanho pelo prop `size` e são decorativos (`aria-hidden`) —
 * quem precisa de nome acessível põe `aria-label` no botão que os embrulha.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string): Record<string, unknown> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
}

/** Wordmark: a ponte do Bridge. */
export function BridgeMark({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} strokeWidth={1.5}>
      <path d="M2 11 L2 6 Q8 1 14 6 L14 11" />
      <path d="M2 11 L14 11" />
      <path d="M5.5 11 L5.5 7.5 M10.5 11 L10.5 7.5" />
    </svg>
  );
}

export function BellIcon({ size = 10, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 11 L3 7 A5 5 0 0 1 13 7 L13 11 L14 12 L2 12 Z" />
      <path d="M6.5 14 L9.5 14" />
    </svg>
  );
}

export function MenuIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} strokeWidth={1.5}>
      <path d="M2 4 L14 4 M2 8 L14 8 M2 12 L14 12" />
    </svg>
  );
}

/** Chevron do cabeçalho de grupo: aponta pra baixo quando aberto. */
export function ChevronIcon({ size = 10, className, open = false }: IconProps & { open?: boolean }): JSX.Element {
  return (
    <svg {...svgProps(size, className)} style={{ transform: open ? 'rotate(90deg)' : undefined }}>
      <path d="M4 2 L12 8 L4 14" />
    </svg>
  );
}

export function TaskIcon({ size = 12, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 4 L8 4 M3 8 L13 8 M3 12 L10 12" />
      <path d="M11 2 L13 4 L11 6" />
    </svg>
  );
}

export function PlusIcon({ size = 12, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M8 3 L8 13 M3 8 L13 8" />
    </svg>
  );
}

/** "⋯" do menu do workspace: três pontos (traço de comprimento zero, cap redondo). */
export function MoreIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} strokeWidth={2}>
      <path d="M3.5 8 L3.51 8" />
      <path d="M8 8 L8.01 8" />
      <path d="M12.5 8 L12.51 8" />
    </svg>
  );
}

/** Grupo fixado no topo da sidebar: um alfinete inclinado. */
export function PinIcon({ size = 10, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} strokeWidth={1.4}>
      <path d="M9.5 1.5 L14.5 6.5" />
      <path d="M11 3 L8 6 L4 7.5 L8.5 12 L10 8 L13 5 Z" />
      <path d="M6.5 9.5 L2 14" />
    </svg>
  );
}

export function CloseIcon({ size = 10, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 4 L12 12 M12 4 L4 12" />
    </svg>
  );
}

/**
 * Configurações (`Ctrl+,`): engrenagem. Corpo + cubo + oito dentes radiais,
 * traçado fino porque ela mora do lado do "⋯" no cabeçalho da sidebar e não
 * pode pesar mais que ele.
 */
export function GearIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} strokeWidth={1.3}>
      <circle cx="8" cy="8" r="4.4" />
      <circle cx="8" cy="8" r="1.9" />
      <path d="M12.4 8 L14.1 8 M3.6 8 L1.9 8 M8 12.4 L8 14.1 M8 3.6 L8 1.9" />
      <path d="M11.11 11.11 L12.31 12.31 M4.89 4.89 L3.69 3.69 M4.89 11.11 L3.69 12.31 M11.11 4.89 L12.31 3.69" />
    </svg>
  );
}

/** Setas de voltar/avançar (o avançar é o mesmo, espelhado). */
export function ArrowLeftIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M13 8 L3 8" />
      <path d="M7 4 L3 8 L7 12" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 8 L13 8" />
      <path d="M9 4 L13 8 L9 12" />
    </svg>
  );
}
