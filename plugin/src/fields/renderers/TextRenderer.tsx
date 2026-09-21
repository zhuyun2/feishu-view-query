/**
 * 文本 / 多行文本渲染器（P0）。
 * 卡片态：单行截断；文档态：完整呈现并保留换行（可跨页）。
 * 样式走 CSS 类 + CSS 变量，避免 render 内新建样式对象。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue, RenderContext } from '../fieldTypes';
import { truncate } from '@/utils/format';

const CARD_TRUNCATE = 60;
const CARD_TRUNCATE_MULTILINE = 140;

function cardText(nv: NormalizedValue, ctx: RenderContext): string {
  const max = ctx.display.maxLines > 1 ? CARD_TRUNCATE_MULTILINE : CARD_TRUNCATE;
  return truncate(nv.display, max);
}

export const TextRenderer: FieldRenderer = {
  key: 'text',
  priority: 'P0',

  renderCard(nv, ctx) {
    if (nv.isEmpty) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    return (
      <span className="cbv-field-text cbv-text" title={nv.text}>
        {ctx.display.prefix ?? ''}
        {cardText(nv, ctx)}
        {ctx.display.suffix ?? ''}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty) return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-doc-text">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {ctx.display.prefix ?? ''}
        {nv.display}
        {ctx.display.suffix ?? ''}
      </span>
    );
  },
};
