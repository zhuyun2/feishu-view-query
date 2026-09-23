/**
 * 字段组区块渲染器：`keyValueGrid` / `fieldList` / `badgeRow`（设计文档 §21.2-C / §21.5）。
 *
 * ⭐ 铁律：字段值**一律**走 `<DocFieldValue/>`（`registry.renderDoc()` 的唯一出口），
 *   本文件绝不自己格式化日期/数字/标签颜色 —— 那会出现第二套字段渲染实现（§11）。
 *
 * ⭐ 测量契约对照（`pagination/measurer.ts`）：
 *  - `fieldList`：**可切分** → 每个**条目**是一个原子单元（`data-unit-index` = 块内绝对序号）。
 *  - `keyValueGrid` / `badgeRow`：**不可切分**（§21.4 规则 3）→ **不输出** `data-unit-index`。
 *    ⚠️ 这两类若误输出单元索引，装箱会按单元把它们拆到两页，与「整块换页」的裁定冲突。
 *  - 三者都**不**输出 `data-repeat-header`（表格续页表头专用，属 T05）。
 *
 * 跨页片段：`fragmentIndex` / `fragmentsTotal` 透传给 `DocFieldValue` →
 * 渲染器在非首片省略「字段名：」前缀（`fieldTypes.docLabelPrefix`），防止续页重复标签。
 */
import type { CSSProperties, ReactElement } from 'react';
import type {
  ResolvedBadge,
  ResolvedBadgeRowPayload,
  ResolvedFieldListPayload,
  ResolvedKeyValueGridPayload,
} from '@/doc/resolve';
import type { NormalizedItem, NormalizedValue } from '@/fields/fieldTypes';
import type { DocBlockRenderProps } from './BlockRenderer';
import { DocFieldValue } from '../DocFieldValue';

/** 网格列间距 / 行间距 px（集中定义，避免散落 magic number，§21.9） */
const GRID_COLUMN_GAP = 12;
const GRID_ROW_GAP = 6;
/** 斑马纹底色（弱灰，不抢正文） */
const ZEBRA_BACKGROUND = 'rgba(31, 35, 41, 0.03)';

export interface KeyValueGridViewProps extends DocBlockRenderProps {
  payload: ResolvedKeyValueGridPayload;
}

export interface FieldListViewProps extends DocBlockRenderProps {
  payload: ResolvedFieldListPayload;
}

export interface BadgeRowViewProps extends DocBlockRenderProps {
  payload: ResolvedBadgeRowPayload;
}

/**
 * 切片区间归一（与 `TextBlocks` 同口径：缺省整块、越界裁剪）。
 * ⚠️ 刻意内联而非抽到 `BlockRenderer`：子组件反向 import 父组件会形成运行时循环依赖，
 * 为 8 行纯函数引入循环不值得。
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
 * 标签列宽钳制：窄列时标签不能把值挤没了。
 * 上限 = 单元格宽的 50%（下限 24px，保证标签至少能显示两个字）。
 */
export function clampLabelWidth(labelWidthPx: number, columns: number, contentWidth: number): number {
  const width = Number.isFinite(labelWidthPx) && labelWidthPx > 0 ? Math.round(labelWidthPx) : 0;
  if (width === 0) return 0;
  if (contentWidth > 0 && columns > 0) {
    const cellWidth = contentWidth / columns;
    return Math.min(width, Math.max(24, Math.floor(cellWidth * 0.5)));
  }
  return width;
}

/**
 * 3. 键值网格：N 列 × M 行，行内 = 「标签（定宽） + 值」。
 * 标签由本组件画（有独立列宽与 `showColon`），值走 `DocFieldValue`（`showLabel=false`）。
 */
export function KeyValueGridView(props: KeyValueGridViewProps): ReactElement {
  const { payload, innerStyle, theme, styleTheme, record, fieldsById, locale, fragmentIndex, fragmentsTotal, contentWidth } =
    props;
  const { columns, rows, showColon, zebra } = payload;
  const labelWidth = clampLabelWidth(payload.labelWidthPx, columns, contentWidth);

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    columnGap: GRID_COLUMN_GAP,
    rowGap: GRID_ROW_GAP,
  };

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-kv-grid" style={gridStyle}>
        {rows.map((row, index) => {
          const zebraRow = zebra === true && Math.floor(index / columns) % 2 === 1;
          return (
            <div
              className="cbv-doc-kv-cell"
              key={`${row.fieldId}-${index}`}
              data-kv-index={index}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                minWidth: 0,
                backgroundColor: zebraRow ? ZEBRA_BACKGROUND : undefined,
              }}
            >
              <span
                className="cbv-doc-kv-label"
                data-kv-label={row.label}
                style={{
                  flex: `0 0 ${labelWidth}px`,
                  width: labelWidth,
                  color: theme.mutedColor,
                  flexShrink: 0,
                }}
              >
                {showColon ? `${row.label}：` : row.label}
              </span>
              <span className="cbv-doc-kv-value" style={{ flex: '1 1 auto', minWidth: 0 }}>
                <DocFieldValue
                  fieldId={row.fieldId}
                  value={row.value}
                  record={record}
                  fieldsById={fieldsById}
                  theme={styleTheme}
                  locale={locale}
                  showLabel={false}
                  fragmentIndex={fragmentIndex}
                  fragmentsTotal={fragmentsTotal}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 4. 字段清单（纵向，可切分）：每项 = 一个原子单元。
 * 标签**交给渲染器**：`showLabels` 时把 `labelText` 传给 `DocFieldValue`，
 * 由 `docLabelPrefix()` 统一决定「是否画标签」（含续页抑制），避免两套标签逻辑。
 */
export function FieldListView(props: FieldListViewProps): ReactElement {
  const { payload, innerStyle, slice, styleTheme, record, fieldsById, locale, fragmentIndex, fragmentsTotal } = props;
  const { from, to } = sliceRange(slice, payload.items.length);
  const visible = payload.items.slice(from, to);

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-field-list">
        {visible.map((item, offset) => {
          const index = from + offset;
          return (
            <div className="cbv-doc-field-list__item" key={`${item.fieldId}-${index}`} data-unit-index={index}>
              <DocFieldValue
                fieldId={item.fieldId}
                value={item.value}
                record={record}
                fieldsById={fieldsById}
                theme={styleTheme}
                locale={locale}
                showLabel={payload.showLabels}
                labelText={item.label}
                fragmentIndex={fragmentIndex}
                fragmentsTotal={fragmentsTotal}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 标签行的一个字段 → 归一化值。
 *
 * `resolve` 已按 `maxItems` 截断出 `texts` / `colorIndexes`，这里把它们**还原成 items**
 * 交给渲染器：色板映射只有 `TagRenderer` 一份实现，本组件绝不复制色板。
 * 非标签型字段（文本/数字）的渲染器忽略 `items`，仍按自身规则呈现，行为不变。
 */
export function badgeValueOf(badge: ResolvedBadge): NormalizedValue {
  const items: NormalizedItem[] = badge.texts.map((text, index) => {
    const item: NormalizedItem = { text };
    const colorIndex = badge.colorIndexes[index];
    if (typeof colorIndex === 'number') item.colorIndex = colorIndex;
    return item;
  });
  return { ...badge.value, items, isEmpty: false };
}

/**
 * 5. 标签行：一个字段 → 一组标签（chips）。
 * 不可切分 → 不输出 `data-unit-index`。
 */
export function BadgeRowView(props: BadgeRowViewProps): ReactElement {
  const { payload, innerStyle, theme, styleTheme, record, fieldsById, locale, fragmentIndex, fragmentsTotal } = props;

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-badge-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        {payload.badges.map((badge) => (
          <span
            className="cbv-doc-badge-group"
            key={badge.fieldId}
            data-badge-field={badge.fieldId}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}
          >
            {payload.showLabels ? (
              <span className="cbv-doc-badge-label" style={{ color: theme.mutedColor }}>
                {badge.label}
              </span>
            ) : null}
            <DocFieldValue
              fieldId={badge.fieldId}
              value={badgeValueOf(badge)}
              record={record}
              fieldsById={fieldsById}
              theme={styleTheme}
              locale={locale}
              showLabel={false}
              fragmentIndex={fragmentIndex}
              fragmentsTotal={fragmentsTotal}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
