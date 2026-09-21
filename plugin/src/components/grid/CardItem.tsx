/**
 * 网格单元（T10）：一张卡片的定位容器 + 条件高亮计算。
 *
 * 高亮在**本组件内**按记录计算（`useMemo`），避免父层为每张卡新建样式对象
 * （命中「render 内禁止新建对象」的红线优化）。
 */
import { memo, useMemo } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, HighlightRule, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { matchRules, resolveCardStyle } from '@/highlight/ruleEngine';
import { Card } from '@/components/card/Card';

export interface CardItemProps {
  record: IRecord;
  layout: CardLayoutConfig;
  fieldsById: Record<string, FieldMetaLite>;
  theme: StyleTheme;
  locale: string;
  attributesMaxRows: number;
  highlightRules: HighlightRule[];
  interactive?: boolean;
}

function CardItemInner({
  record,
  layout,
  fieldsById,
  theme,
  locale,
  attributesMaxRows,
  highlightRules,
  interactive = true,
}: CardItemProps): JSX.Element {
  const highlightStyle = useMemo(() => {
    if (!highlightRules || highlightRules.length === 0) return null;
    try {
      return resolveCardStyle(matchRules(highlightRules, record, fieldsById));
    } catch {
      return null;
    }
  }, [highlightRules, record, fieldsById]);

  return (
    <div className="cbv-grid__cell">
      <Card
        record={record}
        layout={layout}
        fieldsById={fieldsById}
        theme={theme}
        locale={locale}
        attributesMaxRows={attributesMaxRows}
        highlightStyle={highlightStyle}
        interactive={interactive}
      />
    </div>
  );
}

export const CardItem = memo(CardItemInner);
CardItem.displayName = 'CardItem';
