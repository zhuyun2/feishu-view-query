/**
 * 媒体组区块渲染器：`image` / `table`（设计文档 §21.2-C / §21.5 / §21.8 M3-T05）。
 *
 * ⭐ 需求 2（关联字段只读表格化）在本文件新增 {@link LinkTableView}：与 {@link TableView}
 *    **共用**结构 / 样式 / 测量契约标记，但**只读**（无排序 / 编辑 / 添加 / 配置入口）。
 *    数据来自 `doc/linkTable.ts`（预取 → 纯输入注入 `resolveBlocks`）。
 *
 * ⭐ 铁律：单元格里的字段值**一律**走 `<DocFieldValue/>`（`registry.renderDoc()` 的唯一出口），
 *   本文件绝不自己格式化数字/日期/选项（§11「字段值出口」）。
 *
 * ⭐ 测量契约对照（`pagination/measurer.ts`，改错任一标记都会让分页**静默出错**）：
 *  - `image`：**不可切分**（§21.4 规则 3）→ **不输出** `data-unit-index`，
 *    也不输出 `data-repeat-header`。若误输出单元索引，装箱会以为可以把一张图撕成两半。
 *  - `table`：**可切分**（§21.3.1 units = 每数据行高）→ **每行 `<tr>` 输出
 *    `data-unit-index`**，取值是**块内绝对行号**（`slice.from + offset`），因为装箱的
 *    `PagedItem.slice` 是按块内单元序号寻址的。索引必须是**顶层**的（`<tr>` 的父链上
 *    再无 `data-unit-index`），否则测量器会重复计数。
 *  - `table` 的表头 `<thead>` 输出 **`data-repeat-header`** —— 测量器据此取表头高度，
 *    供「续页重复表头」扣除占位。**整个 12 类里只有 `table` 输出该标记。**
 *
 * ⭐ 跨页续片为什么不需要额外逻辑：`packPages` 会把同一 `blockId` 切成多个 `PagedItem`
 *   （各自带 `slice`），`DocPaper` 为每个片段各渲染一次本组件，**表头天然会在每个片段
 *   出现一次**——这正是「续页重复表头」的实现方式（不需要 JS 搬运 DOM）。
 */
import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useState } from 'react';
import type { DocTheme, StyleTheme } from '@/config/types';
import type { FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type {
  ResolvedImagePayload,
  ResolvedTableColumn,
  ResolvedTablePayload,
} from '@/doc/resolve';
import type { LinkColumn, LinkTable } from '@/doc/linkTable';
import type { DocBlockRenderProps } from './BlockRenderer';
import { DocFieldValue } from '../DocFieldValue';

/** 图片之间的间距 px（§21.9 共享约定：magic number 集中定义） */
const IMAGE_GAP = 8;
/** 图片与说明文字之间的间距 px */
const CAPTION_GAP = 4;
/** 表格单元格内边距 px（纵向 / 横向） */
const CELL_PADDING_Y = 6;
const CELL_PADDING_X = 8;
/** 表头底色（弱灰，不抢正文） */
const HEADER_BACKGROUND = 'rgba(31, 35, 41, 0.04)';
/** 斑马纹底色（弱灰，不抢正文） */
const ZEBRA_BACKGROUND = 'rgba(31, 35, 41, 0.03)';

export interface ImageViewProps extends DocBlockRenderProps {
  payload: ResolvedImagePayload;
}

export interface TableViewProps extends DocBlockRenderProps {
  payload: ResolvedTablePayload;
}

/** 缺失单元格的统一占位（每次新造，避免共享引用被下游改写） */
function emptyValue(): NormalizedValue {
  return { kind: 'empty', text: '', display: '', isEmpty: true };
}

/**
 * 图片宽度换算：`width` 超过内容盒时**钳制**到内容盒（打印时绝不溢出纸外）；
 * 未配置宽度时占满内容盒。
 */
export function clampImageWidth(declaredWidth: number, contentWidth: number): number {
  const declared = Number.isFinite(declaredWidth) && declaredWidth > 0 ? Math.round(declaredWidth) : 0;
  if (declared === 0) return contentWidth > 0 ? Math.round(contentWidth) : 0;
  if (contentWidth > 0 && declared > contentWidth) return Math.round(contentWidth);
  return declared;
}

/** 对齐方式 → flex 主轴对齐（用 flex 而非 text-align，居中/右对齐才稳定） */
const ALIGN_TO_JUSTIFY: Readonly<Record<'left' | 'center' | 'right', CSSProperties['justifyContent']>> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

/**
 * 切片区间归一（与 T04 的 `TextBlocks` / `FieldBlocks` 同口径：缺省整块、越界裁剪）。
 * ⚠️ 刻意内联而非抽公共模块：三处完全相同的小函数若抽到 `BlockRenderer` 会形成
 * 子组件反向 import 父组件的循环依赖，为 8 行纯函数引入循环不值得。
 */
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
 * 6. 图片：附件字段多图（resolve 已按 `first` / `all` / `index` 选出 `images[]`）。
 *
 * ⚠️ `<img>` **同时**写 `width`/`height` HTML 属性与内联尺寸：
 * `pagination/measurer.estimateImageHeight()` 在图片尚未加载完时会读这两个属性按比例
 * 换算高度，缺了它们就只能兜底 160px，让分页高度失真。
 */
export function ImageView(props: ImageViewProps): ReactElement {
  const { payload, innerStyle, theme, contentWidth } = props;
  /** 加载失败的 URL 集合（组件局部状态；只影响本次渲染，不参与 payload） */
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set<string>());

  const markFailed = useCallback((url: string): void => {
    setFailedUrls((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const widthPx = clampImageWidth(payload.width, contentWidth);
  const heightPx =
    typeof payload.height === 'number' && Number.isFinite(payload.height) && payload.height > 0
      ? Math.round(payload.height)
      : 0;

  const listStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: `${IMAGE_GAP}px`,
    alignItems: ALIGN_TO_JUSTIFY[payload.align] ?? 'flex-start',
  };

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-image-list" style={listStyle}>
        {payload.images.length === 0 ? (
          <span
            className="cbv-doc-image-empty"
            data-image-empty="true"
            style={{ color: theme.mutedColor, fontSize: Math.max(10, theme.baseFontSize - 2) }}
          >
            暂无图片
          </span>
        ) : (
          payload.images.map((image) => (
            <div className="cbv-doc-image" key={`${image.index}-${image.url}`} data-image-index={image.index}>
              {failedUrls.has(image.url) ? (
                <span
                  className="cbv-doc-image__fallback"
                  data-image-fallback="true"
                  style={{ color: theme.mutedColor, fontSize: Math.max(10, theme.baseFontSize - 2) }}
                >
                  {image.name === '' ? '图片加载失败' : image.name}
                </span>
              ) : (
                <img
                  className="cbv-doc-image__img"
                  src={image.url}
                  alt={image.name}
                  width={widthPx > 0 ? widthPx : undefined}
                  height={heightPx > 0 ? heightPx : undefined}
                  loading="lazy"
                  decoding="async"
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    width: widthPx > 0 ? `${widthPx}px` : '100%',
                    height: heightPx > 0 ? `${heightPx}px` : 'auto',
                    objectFit: 'contain',
                  }}
                  onError={() => markFailed(image.url)}
                />
              )}
            </div>
          ))
        )}
      </div>
      {typeof payload.caption === 'string' && payload.caption !== '' ? (
        <div
          className="cbv-doc-image-caption"
          data-image-caption="true"
          style={{
            marginTop: `${CAPTION_GAP}px`,
            textAlign: payload.align,
            color: theme.mutedColor,
            fontSize: Math.max(10, theme.baseFontSize - 2),
            lineHeight: theme.lineHeight,
          }}
        >
          {payload.caption}
        </div>
      ) : null}
    </div>
  );
}

/** 单元格样式：列宽 / 对齐来自列配置，其余全表统一 */
function cellStyleOf(column: ResolvedTableColumn, theme: DocTheme): CSSProperties {
  const style: CSSProperties = {
    padding: `${CELL_PADDING_Y}px ${CELL_PADDING_X}px`,
    textAlign: column.align ?? 'left',
    verticalAlign: 'top',
    borderBottom: `1px solid ${theme.dividerColor}`,
    boxSizing: 'border-box',
  };
  if (typeof column.widthPx === 'number' && Number.isFinite(column.widthPx) && column.widthPx > 0) {
    style.width = `${column.widthPx}px`;
  }
  return style;
}

/**
 * 7. 表格：列标题 + 数据行。
 *
 * ⭐ 唯一需要「续页重复表头」的区块：`<thead data-repeat-header>` 在**每个片段**都会被
 * 渲染一次，测量器读它得到 `repeatHeaderHeight`，装箱据此扣除续页表头的占位。
 *
 * 行 <tr> = 原子单元（`data-unit-index` = 块内绝对行号），由 <tbody> 直接包裹，
 * 天然满足测量器的**顶层性**要求（父链上无第二个 `data-unit-index`）。
 */
export function TableView(props: TableViewProps): ReactElement {
  const {
    payload,
    innerStyle,
    slice,
    theme,
    styleTheme,
    record,
    fieldsById,
    locale,
    fragmentIndex,
    fragmentsTotal,
    contentWidth,
  } = props;

  const { from, to } = sliceRange(slice, payload.rows.length);
  const visible = payload.rows.slice(from, to);
  const hasFixedWidth = payload.columns.some(
    (column) => typeof column.widthPx === 'number' && Number.isFinite(column.widthPx) && column.widthPx > 0,
  );

  /**
   * 单元格渲染用的字段元数据：以 `fieldsById`（本表字段）为底，再叠加**列自带**的 `meta`。
   * 需求 2 的 `rowSource = linkedRecords` 注入表格时，列来自**目标表**（`fieldsById` 里没有），
   * 必须用列自带 `meta` 才能把单元格交给正确的渲染器（否则只能显示缺 meta 占位「—」）。
   * 常规 `table` 块的列不带 `meta`，此处与历史行为**完全一致**（不改变既有渲染）。
   */
  const cellFieldsById: Record<string, FieldMetaLite> = { ...fieldsById };
  for (const column of payload.columns) {
    if (column.meta) cellFieldsById[column.fieldId] = column.meta;
  }

  const tableStyle: CSSProperties = {
    width: contentWidth > 0 ? '100%' : undefined,
    borderCollapse: 'collapse',
    tableLayout: hasFixedWidth ? 'fixed' : 'auto',
  };

  const headerRow: ReactElement | null =
    payload.showHeader === true ? (
      <thead className="cbv-doc-table__head" data-repeat-header="true">
        <tr>
          {payload.columns.map((column) => (
            <th
              className="cbv-doc-table__th"
              key={column.fieldId}
              data-col-field={column.fieldId}
              scope="col"
              style={{
                ...cellStyleOf(column, theme),
                backgroundColor: HEADER_BACKGROUND,
                color: theme.textColor,
                fontWeight: theme.headingWeight,
              }}
            >
              {column.title}
            </th>
          ))}
        </tr>
      </thead>
    ) : null;

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <table className="cbv-doc-table" data-table-col-count={payload.columns.length} style={tableStyle}>
        {headerRow}
        <tbody className="cbv-doc-table__body">
          {visible.map((row, offset) => {
            const index = from + offset;
            const zebraRow = payload.zebra === true && index % 2 === 1;
            return (
              <tr
                className="cbv-doc-table__row"
                key={`${row.recordId}-${index}`}
                data-unit-index={index}
                data-row-index={index}
                style={{ backgroundColor: zebraRow ? ZEBRA_BACKGROUND : undefined }}
              >
                {payload.columns.map((column) => (
                  <td
                    className="cbv-doc-table__td"
                    key={column.fieldId}
                    data-cell-field={column.fieldId}
                    style={cellStyleOf(column, theme)}
                  >
                    <DocFieldValue
                      fieldId={column.fieldId}
                      value={row.cells[column.fieldId] ?? emptyValue()}
                      record={record}
                      fieldsById={cellFieldsById}
                      theme={styleTheme}
                      locale={locale}
                      showLabel={false}
                      fragmentIndex={fragmentIndex}
                      fragmentsTotal={fragmentsTotal}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {typeof payload.truncated === 'number' && payload.truncated > 0 ? (
        <div
          className="cbv-doc-table__more"
          data-table-more={payload.truncated}
          style={{
            color: theme.mutedColor,
            fontSize: Math.max(10, theme.baseFontSize - 2),
            lineHeight: theme.lineHeight,
            paddingTop: CAPTION_GAP,
          }}
        >
          {`+${payload.truncated}`}
        </div>
      ) : null}
    </div>
  );
}

/* ===================== 关联字段的只读表格（需求 2 · 第一阶段） ===================== */

/** `LinkTableView` 入参（字段级渲染：由 `FieldBlocks` 在字段绑定到关联字段且已有数据时调用） */
export interface LinkTableViewProps {
  /** 关联表格数据（列 = 目标表「主字段 + 前几个可用字段」；行 = 被关联记录） */
  table: LinkTable;
  theme: DocTheme;
  /** `DocTheme` → `StyleTheme` 桥接结果（交 `DocFieldValue` 用） */
  styleTheme: StyleTheme;
  locale: string;
  /** 当前记录（单元格走 `row.cells`，此处仅作 `DocFieldValue` 的兜底入参） */
  record: SdkRecord | null;
  /** 内容盒宽度 px（表格宽度**不得超过**它） */
  contentWidth: number;
  fragmentIndex: number;
  fragmentsTotal: number;
  /** 是否显示「字段名：」前缀（`fieldList` 的 `showLabels`） */
  showLabel?: boolean;
  /** 前缀文本（缺省不显示） */
  labelText?: string;
}

/**
 * ⭐ 关联字段的**只读**表格（与多维表格详情一致的呈现方式，但**不可编辑**）。
 *
 * 结构 / 样式**刻意复用** {@link TableView}（同一批 `cbv-doc-table*` 类名 + 内距常量）：
 *  - 表头 `<thead data-repeat-header>`、数据行 `<tr data-unit-index>` —— **测量契约标记保留**
 *    （与 `pagination/measurer.ts` 对应；改错会让分页静默出错）；
 *  - **只读**：没有排序箭头、没有单元格悬停/编辑、没有「+ 添加记录」、没有字段配置入口、
 *    没有末尾「+」占位行 —— 整棵子树里没有任何交互控件。
 *  - 宽度：外层 `maxWidth = contentWidth` + 表格 `width:100%` ⇒ **绝不超出内容盒**。
 *  - 行上限溢出：以「+N」告知（不静默丢行，沿用既有 `+n` 约定）。
 */
export function LinkTableView(props: LinkTableViewProps): ReactElement {
  const {
    table,
    theme,
    styleTheme,
    locale,
    record,
    contentWidth,
    fragmentIndex,
    fragmentsTotal,
    showLabel,
    labelText,
  } = props;

  const columns = table.columns;
  /** 单元格渲染需要**目标表**字段元数据（`fieldsById` 里没有目标表字段） */
  const cellFieldsById: Record<string, FieldMetaLite> = {};
  for (const column of columns) {
    if (column.meta) cellFieldsById[column.fieldId] = column.meta;
  }

  const tableStyle: CSSProperties = {
    width: contentWidth > 0 ? '100%' : undefined,
    borderCollapse: 'collapse',
    tableLayout: 'auto',
  };

  // 与 `docLabelPrefix()` 同口径：仅在「显示标签 + 未切分或为首片」时画前缀
  const prefix =
    showLabel === true && typeof labelText === 'string' && labelText !== ''
      ? fragmentsTotal > 1 && fragmentIndex > 0
        ? ''
        : `${labelText}：`
      : '';

  /** 列 → 单元格样式（无显式列宽/对齐：关联表格列宽自适应，但不超内容盒） */
  function cellStyle(column: LinkColumn): CSSProperties {
    const columnLike: ResolvedTableColumn = { fieldId: column.fieldId, title: column.label };
    return cellStyleOf(columnLike, theme);
  }

  return (
    <div
      className="cbv-doc-linktable"
      data-doc-linktable="true"
      style={{
        maxWidth: contentWidth > 0 ? contentWidth : undefined,
        width: contentWidth > 0 ? '100%' : undefined,
        boxSizing: 'border-box',
      }}
    >
      {prefix !== '' ? (
        <div
          className="cbv-doc-linktable__label"
          data-link-table-label="true"
          style={{ color: theme.mutedColor, lineHeight: theme.lineHeight }}
        >
          {prefix}
        </div>
      ) : null}
      <table
        className="cbv-doc-table cbv-doc-table--link"
        data-table-col-count={columns.length}
        data-link-table="true"
        style={tableStyle}
      >
        <thead className="cbv-doc-table__head" data-repeat-header="true">
          <tr>
            {columns.map((column) => (
              <th
                className="cbv-doc-table__th"
                key={column.fieldId}
                data-col-field={column.fieldId}
                scope="col"
                style={{
                  ...cellStyle(column),
                  backgroundColor: HEADER_BACKGROUND,
                  color: theme.textColor,
                  fontWeight: theme.headingWeight,
                }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="cbv-doc-table__body">
          {table.rows.map((row, index) => (
            <tr
              className="cbv-doc-table__row"
              key={`${row.recordId}-${index}`}
              data-unit-index={index}
              data-row-index={index}
              style={{ backgroundColor: index % 2 === 1 ? ZEBRA_BACKGROUND : undefined }}
            >
              {columns.map((column) => (
                <td
                  className="cbv-doc-table__td"
                  key={column.fieldId}
                  data-cell-field={column.fieldId}
                  style={cellStyle(column)}
                >
                  <DocFieldValue
                    fieldId={column.fieldId}
                    value={row.cells[column.fieldId] ?? emptyValue()}
                    record={record}
                    fieldsById={cellFieldsById}
                    theme={styleTheme}
                    locale={locale}
                    showLabel={false}
                    fragmentIndex={fragmentIndex}
                    fragmentsTotal={fragmentsTotal}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {typeof table.truncated === 'number' && table.truncated > 0 ? (
        <div
          className="cbv-doc-linktable__more"
          data-link-table-more={table.truncated}
          style={{
            color: theme.mutedColor,
            fontSize: Math.max(10, theme.baseFontSize - 2),
            lineHeight: theme.lineHeight,
            paddingTop: CAPTION_GAP,
          }}
        >
          {`+${table.truncated}`}
        </div>
      ) : null}
    </div>
  );
}
