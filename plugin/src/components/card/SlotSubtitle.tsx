/**
 * 副标题槽位（T09 · 04 §5.1.2 #8）：12px `text-2`，多字段以 `separator`（默认 ' · '）相连，单行省略。
 * `direction='column'` 时纵向排列（清单模板）。
 */
import { memo } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import type { FieldsById } from './slotContent';
import { slotHasContent, visiblePlacements } from './slotContent';
import { FieldValue } from './FieldValue';

export interface SlotSubtitleProps {
  record: IRecord;
  layout: CardLayoutConfig;
  fieldsById: FieldsById;
  theme: StyleTheme;
  locale: string;
}

function SlotSubtitleInner({ record, layout, fieldsById, theme, locale }: SlotSubtitleProps): JSX.Element | null {
  const slot = layout.slots.subtitle;
  if (!slot || slot.visible !== true) return null;
  if (!slotHasContent(slot, record, fieldsById) && slot.collapsibleWhenEmpty) return null;

  const placements = visiblePlacements(slot, slot.maxItemsPerCard);
  const column = slot.direction === 'column';
  return (
    <div className={column ? 'cbv-card__subtitle cbv-card__subtitle--column' : 'cbv-card__subtitle'}>
      {placements.map((placement, index) => (
        <span className="cbv-inline" key={placement.placementId}>
          {!column && index > 0 ? <span aria-hidden="true">{slot.separator}</span> : null}
          <FieldValue placement={placement} record={record} fieldsById={fieldsById} theme={theme} locale={locale} />
        </span>
      ))}
    </div>
  );
}

export const SlotSubtitle = memo(SlotSubtitleInner);
SlotSubtitle.displayName = 'SlotSubtitle';
