/**
 * 底部槽位（T09 · 04 §5.1.2 #11）：贴卡底，标签高 20px / `radius-tag` / 12px；
 * 无内容时整区收合（`collapsibleWhenEmpty`）。
 */
import { memo } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import type { FieldsById } from './slotContent';
import { slotHasContent, visiblePlacements } from './slotContent';
import { FieldValue } from './FieldValue';

export interface SlotFooterProps {
  record: IRecord;
  layout: CardLayoutConfig;
  fieldsById: FieldsById;
  theme: StyleTheme;
  locale: string;
}

function SlotFooterInner({ record, layout, fieldsById, theme, locale }: SlotFooterProps): JSX.Element | null {
  const slot = layout.slots.footer;
  if (!slot || slot.visible !== true) return null;
  if (!slotHasContent(slot, record, fieldsById) && slot.collapsibleWhenEmpty) return null;

  const placements = visiblePlacements(slot, slot.maxItemsPerCard);
  return (
    <div className="cbv-card__footer">
      {placements.map((placement) => (
        <FieldValue
          key={placement.placementId}
          placement={placement}
          record={record}
          fieldsById={fieldsById}
          theme={theme}
          locale={locale}
        />
      ))}
    </div>
  );
}

export const SlotFooter = memo(SlotFooterInner);
SlotFooter.displayName = 'SlotFooter';
