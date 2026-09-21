/**
 * 进度字段渲染器（P1）。
 * 卡片态：进度条；文档态：进度条 + 百分比。值为 0~100 的百分比数字。
 */
import type { CSSProperties } from 'react';
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue, RenderContext } from '../fieldTypes';

const TRACK_STYLE: CSSProperties = {
  display: 'inline-block',
  width: 96,
  height: 6,
  borderRadius: 999,
  background: 'var(--color-bg-app)',
  overflow: 'hidden',
  verticalAlign: 'middle',
};

const TRACK_DOC_STYLE: CSSProperties = { ...TRACK_STYLE, width: 160 };

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), 100);
}

function Bar({ percent, doc }: { percent: number; doc: boolean }): JSX.Element {
  const style: CSSProperties = {
    display: 'block',
    height: '100%',
    width: `${percent}%`,
    background: 'var(--color-primary)',
    borderRadius: 999,
    transition: 'none',
  };
  return (
    <span className="cbv-progress__track" style={doc ? TRACK_DOC_STYLE : TRACK_STYLE}>
      <span className="cbv-progress__fill" style={style} />
    </span>
  );
}

function emptyNode(ctx: RenderContext): JSX.Element | null {
  return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
}

export const ProgressRenderer: FieldRenderer = {
  key: 'progress',
  priority: 'P1',

  renderCard(nv: NormalizedValue, ctx) {
    if (nv.isEmpty || nv.kind !== 'progress' || typeof nv.number !== 'number') return emptyNode(ctx);
    const percent = clampPercent(nv.number);
    return (
      <span className="cbv-progress cbv-num">
        <Bar percent={percent} doc={false} />
        <span className="cbv-progress__value">{` ${Math.round(percent)}%`}</span>
      </span>
    );
  },

  renderDoc(nv: NormalizedValue, ctx: DocRenderContext) {
    if (nv.isEmpty || nv.kind !== 'progress' || typeof nv.number !== 'number') return emptyNode(ctx);
    const label = docLabelPrefix(ctx);
    const percent = clampPercent(nv.number);
    return (
      <span className="cbv-progress cbv-num">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        <Bar percent={percent} doc />
        <span className="cbv-progress__value">{` ${Math.round(percent)}%`}</span>
      </span>
    );
  },
};
