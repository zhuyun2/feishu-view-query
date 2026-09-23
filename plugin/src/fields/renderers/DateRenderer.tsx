/**
 * 日期渲染器（P0，同时服务 CreatedTime / ModifiedTime 等 P1 类型）。
 * 卡片态：YYYY-MM-DD；文档态：YYYY-MM-DD HH:mm。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue } from '../fieldTypes';
import { formatDate } from '@/utils/format';

function render(timestamp: number | undefined, fallback: string, pattern: string): string {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const text = formatDate(timestamp, pattern);
    if (text !== '') return text;
  }
  return fallback;
}

function patternOf(dateFormat: string | undefined, fallback: string): string {
  return dateFormat && dateFormat.trim() !== '' ? dateFormat : fallback;
}

/**
 * 解析最终展示 pattern：**字段自身格式优先**（`nv.dateFormat`，目前仅公式字段会带），
 * 其次回退到视图级配置 `ctx.display.dateFormat`，最后用形态默认值。
 * 普通日期字段不设 `nv.dateFormat`，行为与既往完全一致。
 */
function resolvePattern(nv: NormalizedValue, viewFormat: string | undefined, fallback: string): string {
  if (typeof nv.dateFormat === 'string' && nv.dateFormat.trim() !== '') return nv.dateFormat;
  return patternOf(viewFormat, fallback);
}

export const DateRenderer: FieldRenderer = {
  key: 'dateTime',
  priority: 'P0',

  renderCard(nv: NormalizedValue, ctx) {
    if (nv.isEmpty) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const text = render(nv.timestamp, nv.display, resolvePattern(nv, ctx.display.dateFormat, 'YYYY-MM-DD'));
    return (
      <span className="cbv-field-date cbv-num" title={text}>
        {text}
      </span>
    );
  },

  renderDoc(nv: NormalizedValue, ctx: DocRenderContext) {
    if (nv.isEmpty) return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    const text = render(nv.timestamp, nv.display, resolvePattern(nv, ctx.display.dateFormat, 'YYYY-MM-DD HH:mm'));
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-doc-date cbv-num">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {text}
      </span>
    );
  },
};
