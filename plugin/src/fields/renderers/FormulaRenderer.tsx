/**
 * 公式字段渲染器（P1）。
 *
 * 公式结果类型不确定：`normalize()` 已把结果**保守解包**为 `number` / `checkbox` / `text`
 * （无法解包则折叠为 `unsupported`）。本渲染器按结果类型**分发**到既有渲染器，
 * 保证「公式与源字段呈现一致」，且绝不输出原始 JSON。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue } from '../fieldTypes';
import { CheckboxRenderer } from './CheckboxRenderer';
import { NumberRenderer } from './NumberRenderer';
import { TextRenderer } from './TextRenderer';

function dispatch(nv: NormalizedValue): FieldRenderer {
  if (nv.kind === 'number' || nv.kind === 'currency') return NumberRenderer;
  if (nv.kind === 'checkbox') return CheckboxRenderer;
  if (nv.kind === 'dateTime') return TextRenderer;
  return TextRenderer;
}

export const FormulaRenderer: FieldRenderer = {
  key: 'formula',
  priority: 'P1',

  renderCard(nv, ctx) {
    return dispatch(nv).renderCard(nv, ctx);
  },

  renderDoc(nv, ctx: DocRenderContext) {
    // 文档态：标签由本层统一处理，避免分发后重复画标签
    const label = docLabelPrefix(ctx);
    const child = dispatch(nv).renderDoc(nv, { ...ctx, showLabel: false, labelText: undefined });
    if (label === null) return child;
    return (
      <span className="cbv-doc-formula">
        <span className="cbv-doc-label">{label}</span>
        {child}
      </span>
    );
  },
};
