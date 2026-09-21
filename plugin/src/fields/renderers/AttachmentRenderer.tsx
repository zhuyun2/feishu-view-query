/**
 * 附件字段渲染器（P1）。
 *
 * R4 冻结：**卡片不显示封面图**；附件在卡片属性区渲染为「首图缩略 64×64 + 张数」。
 * 文档态：缩略图 + 文件名列表（图片类附件展示缩略，其余展示文件名）。
 * 统一 `loading="lazy"`；`onError` 回落占位（灰底 + 文件名首字），**绝不输出原始 token/JSON**。
 */
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedItem } from '../fieldTypes';

/** 卡片态缩略图尺寸（R4：属性区首图 64×64） */
const THUMB_SIZE = 64;
/** 文档态缩略图尺寸 */
const DOC_THUMB_SIZE = 72;

const CARD_THUMB_STYLE: CSSProperties = {
  width: THUMB_SIZE,
  height: THUMB_SIZE,
  borderRadius: 4,
  objectFit: 'cover',
  background: 'var(--color-bg-app)',
};

const DOC_THUMB_STYLE: CSSProperties = {
  width: DOC_THUMB_SIZE,
  height: DOC_THUMB_SIZE,
  borderRadius: 4,
  objectFit: 'cover',
  background: 'var(--color-bg-app)',
};

const PLACEHOLDER_STYLE: CSSProperties = {
  width: THUMB_SIZE,
  height: THUMB_SIZE,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg-app)',
  color: 'var(--color-text-3)',
  fontSize: 12,
};

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(name.trim());
}

function Thumb({ item, size }: { item: NormalizedItem; size: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const style = size === THUMB_SIZE ? CARD_THUMB_STYLE : DOC_THUMB_STYLE;
  const showImg = typeof item.imageUrl === 'string' && item.imageUrl !== '' && !failed;
  if (failed || !showImg) {
    return (
      <span
        className="cbv-attachment__placeholder"
        style={{ ...PLACEHOLDER_STYLE, width: size, height: size }}
        title={item.text}
        aria-hidden="true"
      >
        {failed ? '图片加载失败' : '📎'}
      </span>
    );
  }
  return (
    <img
      className="cbv-attachment__thumb"
      style={style}
      src={item.imageUrl}
      alt={item.text}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 卡片态：首图缩略 + 张数（R4 口径：不是封面图，是属性区首图） */
export const AttachmentRenderer: FieldRenderer = {
  key: 'attachment',
  priority: 'P1',

  renderCard(nv, ctx) {
    if (nv.isEmpty || nv.kind !== 'attachment' || !nv.items || nv.items.length === 0) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const total = nv.items.length;
    const first = nv.items[0];
    const rest = total - 1;
    return (
      <span className="cbv-attachment cbv-attachment--card" title={nv.display}>
        <Thumb item={first} size={THUMB_SIZE} />
        <span className="cbv-attachment__count">{rest > 0 ? `共 ${total} 个` : first.text}</span>
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty || nv.kind !== 'attachment' || !nv.items || nv.items.length === 0) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-attachment cbv-attachment--doc">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        <span className="cbv-attachment__grid">
          {nv.items.map((item) =>
            isImageName(item.text) || item.imageUrl ? (
              <span className="cbv-attachment__item" key={item.text}>
                <Thumb item={item} size={DOC_THUMB_SIZE} />
                <span className="cbv-attachment__name" title={item.text}>
                  {item.text}
                </span>
              </span>
            ) : (
              <span className="cbv-attachment__file" key={item.text} title={item.text}>
                📎 {item.text}
              </span>
            ),
          )}
        </span>
      </span>
    );
  },
};
