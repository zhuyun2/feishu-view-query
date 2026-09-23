/**
 * 文本组区块渲染器：`heading` / `paragraph` / `richText`（设计文档 §21.2-C / §21.5）。
 *
 * ⭐ 测量契约对照（`pagination/measurer.ts`）：
 *  - `heading`：**不可切分** → 不输出 `data-unit-index`（`units === undefined`）。
 *  - `paragraph`：**可切分** → 每个**行**是一个原子单元，行元素带 `data-unit-index`。
 *    索引取**块内绝对行号**（切片时 = `slice.from + offset`），因为装箱的
 *    `PagedItem.slice = {from,to}` 是以块内单元序号寻址的。
 *  - `richText`：静态说明文本，**不可切分**（§21.3.1 只给 paragraph/fieldList/table 定义
 *    units）→ 不输出 `data-unit-index`，整块换页。
 *  - 三者都**不**输出 `data-repeat-header`（那是表格续页表头的标记，属 T05）。
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { Fragment } from 'react';
import type { ResolvedHeadingPayload, ResolvedParagraphPayload, ResolvedRichTextPayload } from '@/doc/resolve';
import type { MarkdownNode } from '@/doc/markdown';
import type { DocBlockRenderProps } from './BlockRenderer';

/** 空行占位（保证空行也占一行高，测量不会拿到 0 高度的行） */
const BLANK_LINE = ' ';

export interface HeadingBlockViewProps extends DocBlockRenderProps {
  payload: ResolvedHeadingPayload;
}

export interface ParagraphBlockViewProps extends DocBlockRenderProps {
  payload: ResolvedParagraphPayload;
}

export interface RichTextViewProps extends DocBlockRenderProps {
  payload: ResolvedRichTextPayload;
}

/** 标题层级 → 语义标签（避免 `const Tag = 'h1'|'h2'|'h3'` 的 JSX 联合类型问题） */
function renderHeading(
  level: 1 | 2 | 3,
  text: string,
  style: CSSProperties,
): ReactElement {
  const className = `cbv-doc-heading cbv-doc-heading--${level}`;
  if (level === 1) {
    return (
      <h1 className={className} data-heading-level={1} style={style}>
        {text}
      </h1>
    );
  }
  if (level === 2) {
    return (
      <h2 className={className} data-heading-level={2} style={style}>
        {text}
      </h2>
    );
  }
  return (
    <h3 className={className} data-heading-level={3} style={style}>
      {text}
    </h3>
  );
}

/**
 * 1. 标题（静态文本 / 字段文本）。
 * 字号 = `baseFontSize × headingScale[level-1]`（§21 DocTheme.headingScale）。
 */
export function HeadingBlockView(props: HeadingBlockViewProps): ReactElement {
  const { payload, theme, innerStyle } = props;
  const scale = theme.headingScale[payload.level - 1] ?? 1;
  // ⚠️ 刻意**不**设 color：标题颜色继承区块根（`block.style.color ?? theme.textColor`），
  // 若在此硬编码主题色，用户在区块样式里配的颜色会被静默吞掉。
  const style: CSSProperties = {
    margin: 0,
    fontSize: Math.round(theme.baseFontSize * scale),
    lineHeight: theme.lineHeight,
    fontWeight: theme.headingWeight,
  };
  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      {renderHeading(payload.level, payload.text, style)}
    </div>
  );
}

/** 切片区间归一：缺省 = 整块；越界裁剪；`to <= from` 时退化为「到末尾」 */
function sliceRange(
  slice: { from: number; to: number } | undefined,
  length: number,
): { from: number; to: number } {
  const rawFrom = typeof slice?.from === 'number' ? Math.trunc(slice.from) : 0;
  const from = Math.min(Math.max(rawFrom, 0), length);
  const rawTo = typeof slice?.to === 'number' ? Math.trunc(slice.to) : length;
  const to = Math.min(Math.max(rawTo, from), length);
  return { from, to };
}

/**
 * 2. 段落：按行渲染，**每行 = 一个原子单元**（`data-unit-index` = 块内绝对行号）。
 * 段落是 §21.4 规则 5 的「可切分块」，跨页由 `slice` 决定本片展示哪些行。
 */
export function ParagraphBlockView(props: ParagraphBlockViewProps): ReactElement {
  const { payload, innerStyle, slice } = props;
  const lines = payload.lines;
  const { from, to } = sliceRange(slice, lines.length);
  const visible = lines.slice(from, to);

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-paragraph">
        {visible.map((line, offset) => {
          const index = from + offset;
          return (
            <div className="cbv-doc-paragraph__line" key={index} data-unit-index={index}>
              {line === '' ? BLANK_LINE : line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===================== richText：markdown 子集 → 安全 DOM ===================== */

/** 协议白名单：阻断 `javascript:` / `data:` 等可执行协议（`parseMarkdown` 不校验协议） */
const SAFE_SCHEME_RE = /^(https?|mailto):/i;
/** 含协议的串（如 `foo:` / `javascript:`）需要先过白名单 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * URL 归一化：**必须**在协议判定之前做。
 *
 * ⚠️ 不变量：本函数剥掉的字符集，必须与**浏览器 / URL 规范在解析 URL 前剥掉的字符集一致**。
 * 若我们剥得比浏览器少，就会出现「我们判为非协议、浏览器执行成 javascript:」的缺口。
 *
 * 反例（修复前的 XSS 缺口）：`java\tscript:alert(1)`
 *  - `HAS_SCHEME_RE` 要求 `^[a-z]` 之后紧跟 `[a-z0-9+.-]*` 再到 `:`；`\t` 不在字符类里 → **匹配失败**
 *  - 于是被当作"相对路径"原样放行 → 产出 `<a href="java\tscript:alert(1)">`
 *  - 浏览器随后剥掉 `\t`，归一化成 `javascript:` → 执行
 * 根因：我们在**原始串**上判协议，而浏览器在**归一化后的串**上执行协议。两者的输入不是同一个。
 *
 * 归一化规则（对齐 URL 规范）：
 *  1) 去掉 【任意位置】 的 ASCII tab / 换行 —— `trim()` 只去首尾，管不到字符串内部的 `\t`
 *  2) 去掉首尾的 C0 控制符与空格 —— `trim()` 管不到 `\u0000` 这类 C0 控制符
 */
function normalizeUrl(value: string): string {
  // 1) 去掉【任意位置】的 ASCII tab / 换行（`trim()` 只去首尾，管不到字符串内部的 `\t`）
  const withoutLineBreaks = value.replace(/[\t\n\r]/g, '');

  // 2) 去掉首尾的 C0 控制符与空格。
  //    ⚠️ 这里用码点比较而非正则字符类：`[\u0000-\u0020]` 会触发 eslint `no-control-regex`，
  //    而该类是本函数**有意**匹配的对象（安全归一化），不应靠禁用规则绕过。
  //    判定范围 `charCode <= 0x20` 与 URL 规范「去除首尾 C0 控制符或空格」一致。
  let start = 0;
  let end = withoutLineBreaks.length;
  while (start < end && withoutLineBreaks.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && withoutLineBreaks.charCodeAt(end - 1) <= 0x20) end -= 1;

  return withoutLineBreaks.slice(start, end);
}

/**
 * URL 安全化：不安全返回 null（调用方退化为纯文本）。
 * 目的：`[点我](javascript:...)` 这类输入**不得**产出可执行 `href`（XSS）。
 *
 * ⚠️ 顺序不可调换：**先归一化，再判协议**。反过来就会被空白/控制字符绕过（见 `normalizeUrl`）。
 */
export function safeHref(href: string): string | null {
  const value = normalizeUrl(href);
  if (value === '') return null;
  if (HAS_SCHEME_RE.test(value)) return SAFE_SCHEME_RE.test(value) ? value : null;
  return value; // 相对路径 / 锚点
}

/** 单个内联节点 → ReactNode（bold 最外 → italic → code 最内） */
function renderInlineNode(node: MarkdownNode, key: number): ReactNode {
  if (node.kind === 'break') return <br key={key} />;
  if (node.kind === 'listItem') return null; // 列表项由 renderNodes 单独成组

  if (node.kind === 'link') {
    const href = safeHref(node.href);
    if (href === null) return <Fragment key={key}>{node.text}</Fragment>;
    return (
      <a key={key} className="cbv-doc-link" href={href} target="_blank" rel="noopener noreferrer">
        {node.text}
      </a>
    );
  }

  let content: ReactNode = node.text;
  if (node.code === true) content = <code className="cbv-doc-code">{content}</code>;
  if (node.italic === true) content = <em>{content}</em>;
  if (node.bold === true) content = <strong>{content}</strong>;
  return <Fragment key={key}>{content}</Fragment>;
}

/**
 * markdown 节点序列 → 块级结构：
 *  - 连续内联节点 → 一个 `<p class="cbv-doc-rich-line">`；
 *  - 连续列表项 → 一个 `<ul class="cbv-doc-rich-list">`（每项 `<li>`）；
 *  - `break` → 分段；空行补一个占位段落，保留 markdown 的段落分隔语义。
 */
export function renderMarkdownNodes(nodes: readonly MarkdownNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  let inline: MarkdownNode[] = [];
  let list: MarkdownNode[] = [];
  let seq = 0;

  const flushInline = (): void => {
    if (inline.length === 0) return;
    const snapshot = inline;
    inline = [];
    out.push(
      <p className="cbv-doc-rich-line" key={`line-${seq}`}>
        {snapshot.map((node, index) => renderInlineNode(node, index))}
      </p>,
    );
    seq += 1;
  };

  const flushList = (): void => {
    if (list.length === 0) return;
    const snapshot = list;
    list = [];
    out.push(
      <ul className="cbv-doc-rich-list" key={`list-${seq}`}>
        {snapshot.map((node, index) =>
          node.kind === 'listItem' ? (
            <li className="cbv-doc-rich-list__item" key={index}>
              {node.nodes.map((child, childIndex) => renderInlineNode(child, childIndex))}
            </li>
          ) : null,
        )}
      </ul>,
    );
    seq += 1;
  };

  for (const node of nodes) {
    if (node.kind === 'break') {
      if (inline.length > 0 || list.length > 0) {
        flushInline();
        flushList();
      } else if (out.length > 0) {
        // 空行：补一个占位段落，保留段落间距（首个元素之前不补，避免头部空白）
        out.push(
          <p className="cbv-doc-rich-line cbv-doc-rich-line--blank" key={`blank-${seq}`}>
            {BLANK_LINE}
          </p>,
        );
        seq += 1;
      }
      continue;
    }
    if (node.kind === 'listItem') {
      flushInline();
      list.push(node);
      continue;
    }
    flushList();
    inline.push(node);
  }

  flushInline();
  flushList();
  return out;
}

/**
 * 3. 静态富文本：markdown 子集解析结果 → 安全 DOM。
 * **绝不**用 `dangerouslySetInnerHTML`（§21.3.3：`parseMarkdown` 产出的是结构化节点）。
 */
export function RichTextView(props: RichTextViewProps): ReactElement {
  const { payload, innerStyle } = props;
  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-rich">{renderMarkdownNodes(payload.nodes)}</div>
    </div>
  );
}
