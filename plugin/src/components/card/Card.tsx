/**
 * 卡片（T09）：四槽位按配置渲染（委托 `CardBody`）。
 *
 * - **性能红线**：`memo` 生效；render 内不新建对象/函数（动态高亮样式经 `useMemo` 缓存）；
 * - **事件委托**：点击 / hover 由卡片墙（`CardGrid`）在容器层统一处理，卡片自身不挂 handler；
 * - 编辑态（卡片墙隐藏 R6）与编辑器预览卡传 `interactive={false}`，不参与交互。
 */
import { memo, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, HighlightStyle, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { CardBody } from './CardBody';
import { recordTitleText } from './slotContent';

export interface CardProps {
  record: IRecord;
  layout: CardLayoutConfig;
  fieldsById: Record<string, FieldMetaLite>;
  theme: StyleTheme;
  locale: string;
  /** R3：属性区最大行数 */
  attributesMaxRows?: number;
  /** 条件高亮合并样式（卡片边框，04 §5.1.5） */
  highlightStyle?: HighlightStyle | null;
  /** 是否可交互（hover / focus / 打开详情） */
  interactive?: boolean;
}

function CardInner({
  record,
  layout,
  fieldsById,
  theme,
  locale,
  attributesMaxRows = 3,
  highlightStyle = null,
  interactive = true,
}: CardProps): JSX.Element {
  const ariaLabel = useMemo(
    () => `记录：${recordTitleText(layout, record, fieldsById)}`,
    [layout, record, fieldsById],
  );

  const styleVars = useMemo<CSSProperties | undefined>(() => {
    if (!highlightStyle) return undefined;
    const vars: Record<string, string> = {};
    if (typeof highlightStyle.borderColor === 'string' && highlightStyle.borderColor !== '') {
      vars['--cbv-card-border-color'] = highlightStyle.borderColor;
    }
    if (typeof highlightStyle.borderWidth === 'number' && highlightStyle.borderWidth > 0) {
      vars['--cbv-card-border-width'] = `${highlightStyle.borderWidth}px`;
    }
    return Object.keys(vars).length > 0 ? (vars as CSSProperties) : undefined;
  }, [highlightStyle]);

  const className = interactive
    ? `cbv-card cbv-card--${layout.templateId}`
    : `cbv-card cbv-card--${layout.templateId} cbv-card--static`;

  return (
    <article
      className={className}
      data-record-id={record.recordId}
      data-template={layout.templateId}
      role="article"
      aria-label={ariaLabel}
      tabIndex={interactive ? 0 : -1}
      style={styleVars}
    >
      <CardBody
        record={record}
        layout={layout}
        fieldsById={fieldsById}
        theme={theme}
        locale={locale}
        attributesMaxRows={attributesMaxRows}
      />
    </article>
  );
}

export const Card = memo(CardInner);
Card.displayName = 'Card';
