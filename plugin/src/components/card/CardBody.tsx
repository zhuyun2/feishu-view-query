/**
 * 卡片内容体（T09）：按 `CardLayoutConfig` 的四槽位（title / subtitle / attributes / footer）渲染。
 *
 * 结构约定（04 §5.1.2）：
 *  - 空槽位按 `collapsibleWhenEmpty` 收合，不占位；
 *  - 内分隔线 1px 仅在「上方有内容 且 下方非空」时渲染（上下 margin 10px）。
 *
 * 卡片墙（浏览态）与编辑器预览卡（S3 中栏）**共用**本组件，保证「所见即所得」。
 */
import { memo } from 'react';
import type { SdkRecord } from '@/sdk/port';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import { SlotAttributes } from './SlotAttributes';
import { SlotFooter } from './SlotFooter';
import { SlotSubtitle } from './SlotSubtitle';
import { SlotTitle } from './SlotTitle';
import type { FieldsById } from './slotContent';
import { slotHasContent } from './slotContent';

export interface CardBodyProps {
  record: SdkRecord;
  layout: CardLayoutConfig;
  fieldsById: FieldsById;
  theme: StyleTheme;
  locale: string;
  /** R3：属性区最大行数（默认标准档 3） */
  attributesMaxRows?: number;
}

function CardBodyInner({
  record,
  layout,
  fieldsById,
  theme,
  locale,
  attributesMaxRows = 3,
}: CardBodyProps): JSX.Element {
  const titleVisible = slotHasContent(layout.slots.title, record, fieldsById);
  const subtitleVisible = slotHasContent(layout.slots.subtitle, record, fieldsById);
  const attributesVisible = slotHasContent(layout.slots.attributes, record, fieldsById);
  const footerVisible = slotHasContent(layout.slots.footer, record, fieldsById);

  const headVisible = titleVisible || subtitleVisible;
  const dividerBeforeAttributes = headVisible && attributesVisible;
  const dividerBeforeFooter = (headVisible || attributesVisible) && footerVisible;

  return (
    <>
      <SlotTitle record={record} layout={layout} fieldsById={fieldsById} theme={theme} locale={locale} />
      <SlotSubtitle record={record} layout={layout} fieldsById={fieldsById} theme={theme} locale={locale} />
      {dividerBeforeAttributes ? <div className="cbv-card__divider" role="presentation" /> : null}
      <SlotAttributes
        record={record}
        layout={layout}
        fieldsById={fieldsById}
        theme={theme}
        locale={locale}
        attributesMaxRows={attributesMaxRows}
      />
      {dividerBeforeFooter ? <div className="cbv-card__divider" role="presentation" /> : null}
      <SlotFooter record={record} layout={layout} fieldsById={fieldsById} theme={theme} locale={locale} />
    </>
  );
}

export const CardBody = memo(CardBodyInner);
CardBody.displayName = 'CardBody';
