/**
 * 标题槽位（T09 · 04 §5.1.2 #7）：15px/600 `text-1`，单行省略；
 * 空槽位按 `collapsibleWhenEmpty` 收合（不占位）。
 */
import { memo } from 'react';
import type { SdkRecord } from '@/sdk/port';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import type { FieldsById } from './slotContent';
import { slotHasContent, visiblePlacements } from './slotContent';
import { FieldValue } from './FieldValue';

export interface SlotTitleProps {
  record: SdkRecord;
  layout: CardLayoutConfig;
  fieldsById: FieldsById;
  theme: StyleTheme;
  locale: string;
}

function SlotTitleInner({ record, layout, fieldsById, theme, locale }: SlotTitleProps): JSX.Element | null {
  const slot = layout.slots.title;
  if (!slot || slot.visible !== true) return null;
  if (!slotHasContent(slot, record, fieldsById) && slot.collapsibleWhenEmpty) return null;

  const placements = visiblePlacements(slot, slot.maxItemsPerCard);
  return (
    <div className="cbv-card__title">
      {placements.map((placement, index) => (
        <span className="cbv-inline" key={placement.placementId}>
          {index > 0 ? <span aria-hidden="true">{slot.separator}</span> : null}
          <FieldValue placement={placement} record={record} fieldsById={fieldsById} theme={theme} locale={locale} />
        </span>
      ))}
    </div>
  );
}

export const SlotTitle = memo(SlotTitleInner);
SlotTitle.displayName = 'SlotTitle';
