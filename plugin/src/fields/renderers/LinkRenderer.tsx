/**
 * 链接字段渲染器（P1）：Url / Phone。
 *
 * 卡片态：可点；文档态：可点（打印时保留链接样式，由 print.css 处理）。
 *
 * ⚠️ 安全口径：`normalize()` 的 `NormalizedValue` **不保留原始 href**（只保留人可见文本），
 * 故本渲染器**仅在人可见文本本身就是合法 URL 时**生成 `<a href>`；否则退化为纯文本，
 * 避免把「链接显示名」误当作地址导致 404。电话字段生成 `tel:` 链接。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue, RenderContext } from '../fieldTypes';

function isHttpUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

function isPhoneLike(text: string): boolean {
  return /^[+]?[\d\s\-()]{5,}$/.test(text.trim());
}

function emptyNode(ctx: RenderContext): JSX.Element | null {
  return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
}

function renderLink(nv: NormalizedValue, doc: boolean, label: string | null): JSX.Element {
  const text = nv.display || nv.text;
  const className = doc ? 'cbv-doc-link' : 'cbv-field-link';
  if (nv.kind === 'phone' && isPhoneLike(text)) {
    return (
      <span className={className}>
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        <a className="cbv-link" href={`tel:${text.replace(/[\s()]/g, '')}`}>
          {text}
        </a>
      </span>
    );
  }
  if (isHttpUrl(text)) {
    return (
      <span className={className}>
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        <a className="cbv-link" href={text} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      </span>
    );
  }
  return (
    <span className={className} title={text}>
      {label ? <span className="cbv-doc-label">{label}</span> : null}
      {text}
    </span>
  );
}

export const LinkRenderer: FieldRenderer = {
  key: 'link',
  priority: 'P1',

  renderCard(nv, ctx) {
    if (nv.isEmpty || (nv.kind !== 'url' && nv.kind !== 'phone')) return emptyNode(ctx);
    return renderLink(nv, false, null);
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty || (nv.kind !== 'url' && nv.kind !== 'phone')) return emptyNode(ctx);
    return renderLink(nv, true, docLabelPrefix(ctx));
  },
};
