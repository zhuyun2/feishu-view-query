/**
 * 评分字段渲染器（P1）。
 * 卡片态：星级（默认满分 5）；文档态：星级 + 数值。全部为文本星号，打印友好、无图片依赖。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue, RenderContext } from '../fieldTypes';

/** 默认满分（字段属性未提供时的兜底） */
const DEFAULT_MAX = 5;

function toMax(): number {
  return DEFAULT_MAX;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.round(value)), max);
}

function Stars({ value, max }: { value: number; max: number }): JSX.Element {
  const filled = clamp(value, max);
  let text = '';
  for (let index = 0; index < max; index += 1) text += index < filled ? '★' : '☆';
  return (
    <span className="cbv-rating" aria-label={`${filled} / ${max}`}>
      <span className="cbv-rating__stars" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

function emptyNode(ctx: RenderContext): JSX.Element | null {
  return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
}

export const RatingRenderer: FieldRenderer = {
  key: 'rating',
  priority: 'P1',

  renderCard(nv: NormalizedValue, ctx) {
    if (nv.isEmpty || nv.kind !== 'rating' || typeof nv.number !== 'number') return emptyNode(ctx);
    return <Stars value={nv.number} max={toMax()} />;
  },

  renderDoc(nv: NormalizedValue, ctx: DocRenderContext) {
    if (nv.isEmpty || nv.kind !== 'rating' || typeof nv.number !== 'number') return emptyNode(ctx);
    const label = docLabelPrefix(ctx);
    const max = toMax();
    return (
      <span className="cbv-doc-rating cbv-num">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        <Stars value={nv.number} max={max} />
        <span className="cbv-rating__value">{` ${clamp(nv.number, max)} / ${max}`}</span>
      </span>
    );
  },
};
