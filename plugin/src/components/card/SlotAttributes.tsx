/**
 * 属性槽位（T09 · 04 §5.1.2 #10 / R3）：每行「字段名 13px text-2」左对齐 +「值 13px text-1」右对齐
 * （`tabular-nums`），行高 24px。
 *
 * R3 冻结：属性区默认**行数**由 `attributesMaxRows`（紧凑 2 / 标准 3 / 宽松 5）控制；
 * 超出部分按 `SlotConfig.maxItemsPerCard` 一起截断，并在末尾显示 `+n`。
 */
import { memo } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import type { FieldsById } from './slotContent';
import { labelOf, placementHasContent, visiblePlacements } from './slotContent';
import { FieldValue } from './FieldValue';

export interface SlotAttributesProps {
  record: IRecord;
  layout: CardLayoutConfig;
  fieldsById: FieldsById;
  theme: StyleTheme;
  locale: string;
  /** R3：属性区最大行数 */
  attributesMaxRows: number;
}

function positiveMin(a: number, b: number): number {
  const valid = [a, b].filter((value) => typeof value === 'number' && value > 0);
  if (valid.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...valid);
}

function SlotAttributesInner({
  record,
  layout,
  fieldsById,
  theme,
  locale,
  attributesMaxRows,
}: SlotAttributesProps): JSX.Element | null {
  const slot = layout.slots.attributes;
  if (!slot || slot.visible !== true) return null;

  const ordered = visiblePlacements(slot, slot.maxItemsPerCard);
  // 只统计「有内容」的行（hideWhenEmpty 语义），保证 +n 反映被折叠的真实字段数
  const withContent = ordered.filter((placement) => placementHasContent(placement, record, fieldsById));
  if (withContent.length === 0) return null;

  const limit = positiveMin(slot.maxItemsPerCard, attributesMaxRows);
  const shown = Number.isFinite(limit) ? withContent.slice(0, limit) : withContent;
  const hidden = withContent.length - shown.length;

  return (
    <div className="cbv-card__attributes">
      {shown.map((placement) => (
        <div className="cbv-attr-row" key={placement.placementId}>
          <span className="cbv-attr-row__label">{labelOf(placement, fieldsById)}</span>
          <span className="cbv-attr-row__value cbv-num">
            <FieldValue placement={placement} record={record} fieldsById={fieldsById} theme={theme} locale={locale} />
          </span>
        </div>
      ))}
      {hidden > 0 ? <div className="cbv-attr-row cbv-attr-row--more">{`+${hidden}`}</div> : null}
    </div>
  );
}

export const SlotAttributes = memo(SlotAttributesInner);
SlotAttributes.displayName = 'SlotAttributes';
