/**
 * 复选框渲染器（P0）。
 * 卡片态：勾 / 叉；文档态：是 / 否。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer } from '../fieldTypes';

export const CheckboxRenderer: FieldRenderer = {
  key: 'checkbox',
  priority: 'P0',

  renderCard(nv, ctx) {
    if (nv.isEmpty) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const on = nv.boolean === true;
    return (
      <span className={on ? 'cbv-checkbox-on' : 'cbv-checkbox-off'} aria-label={on ? '是' : '否'}>
        {on ? '✓' : '✕'}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty) return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    const label = docLabelPrefix(ctx);
    return (
      <span style={{ fontSize: '14px' }}>
        {label ? <span className="cbv-attr-row__label">{label}</span> : null}
        {nv.boolean === true ? '是' : '否'}
      </span>
    );
  },
};
