/**
 * 查找引用 / 关联字段渲染器（P1）：Lookup / Link / DuplexLink。
 *
 * 卡片态：前 N 项 + 「+n」；文档态：**多值展开为纵向列表**（可跨页）。
 * `normalize()` 已保证只输出关联记录的人可见文本（如「客户 A」），**绝不输出关联记录 ID**。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedItem, RenderContext } from '../fieldTypes';
import { MULTI_SELECT_PREVIEW_LIMIT } from '@/constants';

function emptyNode(ctx: RenderContext): JSX.Element | null {
  return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
}

function Key(item: NormalizedItem, index: number): JSX.Element {
  return (
    <span className="cbv-lookup__item" key={`${item.text}-${index}`} title={item.text}>
      {item.text}
    </span>
  );
}

export const LookupRenderer: FieldRenderer = {
  key: 'lookup',
  priority: 'P1',

  renderCard(nv, ctx) {
    if (nv.isEmpty || !nv.items || nv.items.length === 0) return emptyNode(ctx);
    const limit = ctx.display.maxItems > 0 ? ctx.display.maxItems : MULTI_SELECT_PREVIEW_LIMIT;
    const visible = nv.items.slice(0, limit);
    const rest = nv.items.length - visible.length;
    // tooltip 仅反映**可见**项；被截断项不进入 title，避免卡片实际未展示的值外泄
    const visibleText = visible.map((item) => item.text).join('、');
    return (
      <span className="cbv-lookup" title={visibleText}>
        {visible.map((item, index) => (
          <span key={`${item.text}-${index}`}>
            {index > 0 ? <span aria-hidden="true">、</span> : null}
            {item.text}
          </span>
        ))}
        {rest > 0 ? <span className="cbv-tag cbv-tag--more">{`+${rest}`}</span> : null}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty || !nv.items || nv.items.length === 0) return emptyNode(ctx);
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-lookup cbv-lookup--doc">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {nv.items.map((item, index) => Key(item, index))}
      </span>
    );
  },
};
