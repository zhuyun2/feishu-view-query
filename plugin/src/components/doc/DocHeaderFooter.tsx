/**
 * 页眉 / 页脚渲染（设计文档 §21.3.4 / §21.4.3 / §21.5 / M3-T06）。
 *
 * ⭐ 契约 2（页眉页脚**不占** ContentBox）：
 *   页眉落在**页顶 margin 带**（`top:0; height:margin.top`），页脚落在**页底 margin 带**
 *   （`bottom:0; height:margin.bottom`）。两者都是纸页上的**独立区域**，**绝不**挤占内容盒。
 *   内容盒的高度 = `getContentBox().height` = 装箱时用的高度，二者必须**严格一致**
 *   ——否则「测量时按 A 高装箱、渲染时可用 B 高」会静默错页。
 *
 * ⭐ 页脚 ≠ metaFooter 区块（§21.4.3 / §21.10-④）：
 *   `metaFooter` 是**文档流内的普通区块**（由 T05 的 `MetaFooterView` 渲染，随流分页），
 *   而本组件的 `variant='footer'` 是**每页固定页脚**（含页码）。二者独立、互不替代。
 *
 * 字段占位符（`{记录标题}` / `{修改时间}` 等）经本文件解析为「文本段 + 字段段」，
 * 字段段一律交给 `<DocFieldValue>` 渲染 —— 遵守「字段值唯一出口」铁律，**不**直接调
 * `renderDoc`，避免出现第二套字段格式化。
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { DocTheme, HeaderFooterConfig, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { getRecordId } from '@/data/RecordDataSource';
import { DocFieldValue, styleThemeOf } from './DocFieldValue';

/** `DocHeaderFooter` 入参（§21.3.4） */
export interface DocHeaderFooterProps {
  /** 页眉 / 页脚；决定取 `setup.header` 还是 `setup.footer` */
  variant: 'header' | 'footer';
  /** 0 起的页序号（页码按 `pageIndex + 1` 呈现） */
  pageIndex: number;
  totalPages: number;
  setup: PageSetup;
  theme: DocTheme;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  locale: string;
}

/** 页眉/页脚内容的一段：静态文本 或 一个字段占位符 */
export type HeaderFooterSegment =
  | { kind: 'text'; text: string }
  | { kind: 'field'; fieldId: string; labelText: string };

/** 元信息占位符 → 对应字段类型（与 `doc/resolve` 的 `META_FOOTER_FIELD_TYPES` 同口径） */
const META_TOKEN_TYPES: Readonly<Record<string, readonly FieldType[]>> = {
  创建时间: [FieldType.CreatedTime],
  修改时间: [FieldType.ModifiedTime],
  创建人: [FieldType.CreatedUser],
  修改人: [FieldType.ModifiedUser],
};

/** 记录 ID 占位符的若干写法（无对应字段，直接渲染记录 id 文本） */
const RECORD_ID_TOKENS: ReadonlySet<string> = new Set(['记录ID', '记录 ID', 'recordId', '记录id', '记录 Id']);

/** 页眉/页脚文本内的占位符语法：`{...}`（花括号内不含花括号） */
const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g;

/**
 * 解析单个占位符 token。
 * @returns 字段段 / 文本段；无法识别 → `null`（调用方保留字面量，让用户看见拼写错误）
 */
function resolveToken(
  token: string,
  fieldsById: Record<string, FieldMetaLite>,
  recordId: string,
): HeaderFooterSegment | null {
  if (token === '记录标题') {
    const primary = Object.values(fieldsById).find((field) => field.isPrimary === true);
    if (primary) return { kind: 'field', fieldId: primary.id, labelText: primary.name };
    return null;
  }
  if (RECORD_ID_TOKENS.has(token)) {
    return recordId !== '' ? { kind: 'text', text: recordId } : null;
  }
  const types = META_TOKEN_TYPES[token];
  if (types) {
    const meta = Object.values(fieldsById).find((field) => types.includes(field.type as FieldType));
    if (meta) return { kind: 'field', fieldId: meta.id, labelText: meta.name };
    return null; // 表里没有该类型字段 → 不臆造（与 resolve 同口径）
  }
  return null;
}

/**
 * 把页眉/页脚内容串解析为「文本段 + 字段段」序列（**纯函数**，便于单测）。
 *
 * 语义：
 *  - `{记录标题}` → 主字段（`isPrimary`）的值；
 *  - `{创建/修改时间|人}` → 表中对应类型字段的值；
 *  - `{记录ID}` → 记录 id 文本；
 *  - 未识别的 `{xxx}` → **保留字面量**（不静默丢弃，用户可自查拼写）。
 */
export function parseHeaderFooterContent(
  content: string,
  fieldsById: Record<string, FieldMetaLite>,
  recordId: string,
): HeaderFooterSegment[] {
  const src = typeof content === 'string' ? content : '';
  const segments: HeaderFooterSegment[] = [];
  PLACEHOLDER_PATTERN.lastIndex = 0;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(src)) !== null) {
    if (match.index > cursor) segments.push({ kind: 'text', text: src.slice(cursor, match.index) });
    const resolved = resolveToken(match[1].trim(), fieldsById, recordId);
    segments.push(resolved ?? { kind: 'text', text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < src.length) segments.push({ kind: 'text', text: src.slice(cursor) });

  return segments;
}

/**
 * 页码文本（§21.3.4 `pageNumberFormat`）。
 *  - `'n'` → `1`
 *  - `'n/total'` → `1/3`
 *  - `'page-n'` → `第1页`
 * `pageIndex` 为 0 起，呈现时 +1。
 */
export function formatPageNumber(
  format: PageSetup['pageNumberFormat'],
  pageIndex: number,
  totalPages: number,
): string {
  const n = Math.max(1, Math.trunc(Number.isFinite(pageIndex) ? pageIndex : 0) + 1);
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  if (format === 'n/total') return `${n}/${total}`;
  if (format === 'page-n') return `第${n}页`;
  return `${n}`;
}

/** 对齐值 → flex `justify-content` */
function justifyOf(align: HeaderFooterConfig['align']): CSSProperties['justifyContent'] {
  if (align === 'left') return 'flex-start';
  if (align === 'right') return 'flex-end';
  return 'center';
}

/**
 * 页眉/页脚组件。渲染在纸页的 margin 带内（绝对定位），**不**进入内容盒。
 */
export function DocHeaderFooter(props: DocHeaderFooterProps): ReactElement {
  const { variant, pageIndex, totalPages, setup, theme, record, fieldsById, locale } = props;
  const isHeader = variant === 'header';

  const config: HeaderFooterConfig | undefined = isHeader ? setup.header : setup.footer;
  const margin = setup.margin;
  const bandHeight = isHeader ? margin.top : margin.bottom;
  const align = config?.align ?? 'center';
  const fontSize = config?.fontSize ?? theme.baseFontSize;
  const color = config?.color ?? theme.mutedColor;

  const segments = parseHeaderFooterContent(config?.content ?? '', fieldsById, getRecordId(record));
  const styleTheme = styleThemeOf(theme);
  const showPageNumber = !isHeader && setup.showPageNumber === true;

  const containerStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    height: bandHeight,
    display: 'flex',
    alignItems: 'center',
    justifyContent: justifyOf(align),
    boxSizing: 'border-box',
    padding: `0 ${margin.left}px`,
    fontFamily: theme.fontFamily,
    fontSize,
    lineHeight: theme.lineHeight,
    color,
    pointerEvents: 'none',
    overflow: 'hidden',
    ...(isHeader ? { top: 0 } : { bottom: 0 }),
  };

  const contentNodes: ReactNode[] = segments.map((segment, index) => {
    if (segment.kind === 'text') {
      return (
        <span className="cbv-doc-head__text" key={`t${index}`}>
          {segment.text}
        </span>
      );
    }
    return (
      <DocFieldValue
        key={`f${index}`}
        fieldId={segment.fieldId}
        record={record}
        fieldsById={fieldsById}
        theme={styleTheme}
        locale={locale}
        showLabel={false}
        labelText={segment.labelText}
        fragmentIndex={0}
        fragmentsTotal={1}
      />
    );
  });

  const borderStyle: CSSProperties = {
    position: 'absolute',
    left: margin.left,
    right: margin.right,
    borderTop: `1px solid ${theme.dividerColor}`,
    ...(isHeader ? { bottom: 0 } : { top: 0 }),
  };

  const pageNumberStyle: CSSProperties = {
    position: 'absolute',
    right: margin.right,
    top: '50%',
    transform: 'translateY(-50%)',
  };

  return (
    <div
      className={`cbv-doc-header-footer cbv-doc-${isHeader ? 'head' : 'foot'}`}
      data-header-footer={variant}
      data-page-index={pageIndex}
      style={containerStyle}
    >
      <span className="cbv-doc-head__content" data-header-footer-content={variant}>
        {contentNodes}
      </span>
      {showPageNumber ? (
        <span
          className="cbv-doc-foot__pages cbv-page-number"
          data-page-number={variant}
          style={pageNumberStyle}
        >
          {formatPageNumber(setup.pageNumberFormat, pageIndex, totalPages)}
        </span>
      ) : null}
      {config?.showBorder === true ? (
        <span className="cbv-doc-head__border" data-header-footer-border={variant} aria-hidden="true" style={borderStyle} />
      ) : null}
    </div>
  );
}

export default DocHeaderFooter;
