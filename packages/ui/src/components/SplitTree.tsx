import type { LayoutNode } from '@bridge/shared';
import { useEffect, useRef, useState } from 'react';
import { ratioTargets } from '../state.js';

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

interface Props {
  node: LayoutNode;
  renderLeaf: (paneId: string) => JSX.Element;
  /**
   * Soltou o divisor: grava no core (`POST /api/panes/:id/ratio`). Os DOIS
   * painéis vão junto (R1) — o do lado `a` e o do lado `b` do divisor — pro
   * core achar o split certo mesmo com a árvore aninhada.
   */
  onRatio: (paneId: string, siblingPaneId: string, ratio: number) => void;
}

function clamp(value: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

/**
 * Um split. O `ratio` do core é a verdade, mas durante o arraste quem manda é
 * o valor local — o core só ouve no soltar (um POST por arraste, não por pixel).
 */
function Split({ node, renderLeaf, onRatio }: Props & { node: Extract<LayoutNode, { type: 'split' }> }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(node.ratio);
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  useEffect(() => {
    if (!dragging) setRatio(node.ratio);
  }, [node.ratio, dragging]);

  useEffect(() => {
    if (!dragging) return;
    const vertical = node.dir === 'v';

    function onMove(ev: MouseEvent): void {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const size = vertical ? box.width : box.height;
      if (size <= 0) return;
      const offset = vertical ? ev.clientX - box.left : ev.clientY - box.top;
      setRatio(clamp(offset / size));
    }

    function onUp(): void {
      setDragging(false);
      // Um leaf de cada lado do divisor: é esse par que identifica ESTE split
      // no core (menor ancestral comum), e não o pai imediato de um deles.
      const targets = ratioTargets(node);
      if (targets) onRatio(targets.paneId, targets.siblingPaneId, ratioRef.current);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, node, onRatio]);

  const vertical = node.dir === 'v';
  return (
    <div ref={containerRef} className={`split split-${node.dir}`}>
      <div className="split-side" style={{ flexGrow: ratio }}>
        <SplitTree node={node.a} renderLeaf={renderLeaf} onRatio={onRatio} />
      </div>
      <div
        className={`split-divider ${vertical ? 'vertical' : 'horizontal'}${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        onMouseDown={(ev) => {
          ev.preventDefault();
          setDragging(true);
        }}
      />
      <div className="split-side" style={{ flexGrow: 1 - ratio }}>
        <SplitTree node={node.b} renderLeaf={renderLeaf} onRatio={onRatio} />
      </div>
    </div>
  );
}

/** Renderiza a árvore de layout do core: `v` lado a lado, `h` empilhado. */
export function SplitTree({ node, renderLeaf, onRatio }: Props): JSX.Element {
  if (node.type === 'leaf') return renderLeaf(node.paneId);
  return <Split node={node} renderLeaf={renderLeaf} onRatio={onRatio} />;
}
