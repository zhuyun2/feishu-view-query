/**
 * 兜底渲染器：不支持类型 / 渲染异常回落。
 * 铁律：**永不输出原始 ID / JSON**；异常只表现为一个中性提示徽标，不影响整卡。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer } from '../fieldTypes';

const FALLBACK_TEXT = '该字段类型暂不支持';

export const FallbackRenderer: FieldRenderer = {
  key: 'fallback',
  priority: 'unsupported',

  renderCard(nv, ctx) {
    if (nv.isEmpty) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const text = nv.kind === 'unsupported' ? FALLBACK_TEXT : nv.display || FALLBACK_TEXT;
    return <span className="cbv-unsupported">{text}</span>;
  },

  renderDoc(nv, ctx: DocRenderContext) {
    const label = docLabelPrefix(ctx);
    const text = nv.kind === 'unsupported' ? FALLBACK_TEXT : nv.display || FALLBACK_TEXT;
    return (
      <span className="cbv-unsupported">
        {label ? <span className="cbv-attr-row__label">{label}</span> : null}
        {text}
      </span>
    );
  },
};
