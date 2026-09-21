/**
 * 人员字段渲染器（P1）：User / CreatedUser / ModifiedUser。
 *
 * R4 冻结：人员字段渲染 **20px 圆形头像 + 姓名**；头像尺寸为**渲染常量**
 * （`radius-pill`，固定 20px，**不随 density 变**）。
 * 无头像 URL 时回落「姓名首字」占位（灰底），**绝不输出成员 ID**。
 */
import type { CSSProperties } from 'react';
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedItem, RenderContext } from '../fieldTypes';
import { MULTI_SELECT_PREVIEW_LIMIT } from '@/constants';

const AVATAR_IMG_STYLE: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 999,
  objectFit: 'cover',
  flex: '0 0 auto',
};

const AVATAR_FALLBACK_STYLE: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 999,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  lineHeight: 1,
  flex: '0 0 auto',
  background: 'var(--color-bg-app)',
  color: 'var(--color-text-2)',
};

function Avatar({ item }: { item: NormalizedItem }): JSX.Element {
  if (item.imageUrl) {
    return <img className="cbv-avatar" style={AVATAR_IMG_STYLE} src={item.imageUrl} alt="" loading="lazy" />;
  }
  const initial = item.text.trim().slice(0, 1) || '?';
  return (
    <span className="cbv-avatar cbv-avatar--initial" style={AVATAR_FALLBACK_STYLE} aria-hidden="true">
      {initial}
    </span>
  );
}

function UserItem({ item }: { item: NormalizedItem }): JSX.Element {
  return (
    <span className="cbv-user" title={item.text}>
      <Avatar item={item} />
      <span className="cbv-user__name">{item.text}</span>
    </span>
  );
}

function emptyNode(ctx: RenderContext): JSX.Element | null {
  return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
}

export const UserRenderer: FieldRenderer = {
  key: 'user',
  priority: 'P1',

  renderCard(nv, ctx) {
    if (nv.isEmpty || nv.kind !== 'user' || !nv.items || nv.items.length === 0) {
      if (nv.kind === 'text' && nv.display !== '') return <span className="cbv-field-text">{nv.display}</span>;
      return emptyNode(ctx);
    }
    const limit = ctx.display.maxItems > 0 ? ctx.display.maxItems : MULTI_SELECT_PREVIEW_LIMIT;
    const visible = nv.items.slice(0, limit);
    const rest = nv.items.length - visible.length;
    return (
      <span className="cbv-users">
        {visible.map((item) => (
          <UserItem key={item.text} item={item} />
        ))}
        {rest > 0 ? <span className="cbv-tag cbv-tag--more">{`+${rest}`}</span> : null}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty || nv.kind !== 'user' || !nv.items || nv.items.length === 0) {
      if (nv.kind === 'text' && nv.display !== '') return <span className="cbv-doc-text">{nv.display}</span>;
      return emptyNode(ctx);
    }
    const label = docLabelPrefix(ctx);
    return (
      <span className="cbv-users cbv-users--doc">
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {nv.items.map((item) => (
          <UserItem key={item.text} item={item} />
        ))}
      </span>
    );
  },
};
