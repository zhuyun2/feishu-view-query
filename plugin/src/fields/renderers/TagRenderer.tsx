/**
 * 标签渲染器：单选 / 多选（P0）。
 * 卡片态：最多 N 个 + 「+n」；文档态：**全部**标签（可换行）。
 */
import type { CSSProperties } from 'react';
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedItem } from '../fieldTypes';
import { MULTI_SELECT_PREVIEW_LIMIT } from '@/constants';

/** 选项色板（浅底 + 深字）；索引来自字段选项的 color 序号 */
const TAG_PALETTE: readonly { bg: string; fg: string }[] = [
  { bg: '#EFF4FF', fg: '#245BDB' },
  { bg: '#E8F8E6', fg: '#1F7A1F' },
  { bg: '#FFF4E6', fg: '#B35B00' },
  { bg: '#FEECEB', fg: '#C0392B' },
  { bg: '#F3E8FF', fg: '#7B3FBF' },
  { bg: '#E6F8F8', fg: '#0B7285' },
  { bg: '#FFF0F6', fg: '#C2255C' },
  { bg: '#F5F6F7', fg: '#646A73' },
];

/** 预计算样式表（模块级，避免 render 内新建对象） */
const TAG_STYLES: readonly CSSProperties[] = TAG_PALETTE.map((color) => ({
  backgroundColor: color.bg,
  color: color.fg,
}));

function colorStyleOf(item: NormalizedItem): CSSProperties {
  const index = typeof item.colorIndex === 'number' ? item.colorIndex : TAG_PALETTE.length - 1;
  const normalized = ((index % TAG_PALETTE.length) + TAG_PALETTE.length) % TAG_PALETTE.length;
  return TAG_STYLES[normalized] as CSSProperties;
}

function Tag({ item }: { item: NormalizedItem }): JSX.Element {
  return (
    <span className="cbv-tag" style={colorStyleOf(item)} title={item.text}>
      {item.text}
    </span>
  );
}

export const TagRenderer: FieldRenderer = {
  key: 'tag',
  priority: 'P0',

  renderCard(nv, ctx) {
    if (nv.isEmpty || !nv.items || nv.items.length === 0) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const limit = ctx.display.maxItems > 0 ? ctx.display.maxItems : MULTI_SELECT_PREVIEW_LIMIT;
    const visible = nv.items.slice(0, limit);
    const rest = nv.items.length - visible.length;
    return (
      <span className="cbv-tags">
        {visible.map((item) => (
          <Tag key={item.text} item={item} />
        ))}
        {rest > 0 ? <span className="cbv-tag cbv-tag--more">{`+${rest}`}</span> : null}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty || !nv.items || nv.items.length === 0) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-tags">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {nv.items.map((item) => (
          <Tag key={item.text} item={item} />
        ))}
      </span>
    );
  },
};
