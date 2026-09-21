/**
 * 预览样例卡（T11 / R1 中栏）：用一个合成记录 + 当前草稿排版渲染，实现「所见即所得」。
 *
 * ⚠️ 编辑态传 `interactive={false}`：**点击卡片不展开详情**（R6）。
 * 预览随草稿变化在 ≤300ms 内刷新（`useMemo` 依草稿引用重算，React 提交即刷新）。
 */
import { memo, useMemo } from 'react';
import type { CardLayoutConfig, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { CardBody } from '@/components/card/CardBody';
import { buildSampleRecord } from './sampleRecord';

export interface PreviewSampleCardProps {
  layout: CardLayoutConfig;
  fields: FieldMetaLite[];
  theme: StyleTheme;
  locale: string;
  attributesMaxRows: number;
}

function PreviewSampleCardInner({
  layout,
  fields,
  theme,
  locale,
  attributesMaxRows,
}: PreviewSampleCardProps): JSX.Element {
  const record = useMemo(() => buildSampleRecord(fields), [fields]);
  const fieldsById = useMemo(() => {
    const map: Record<string, FieldMetaLite> = {};
    for (const field of fields) map[field.id] = field;
    return map;
  }, [fields]);

  return (
    <div className="cbv-editor__preview" aria-label="预览样例卡">
      <div className="cbv-editor__panel-title">预览</div>
      <article className={`cbv-card cbv-card--${layout.templateId} cbv-card--static cbv-card--preview`} data-template={layout.templateId}>
        <CardBody
          record={record}
          layout={layout}
          fieldsById={fieldsById}
          theme={theme}
          locale={locale}
          attributesMaxRows={attributesMaxRows}
        />
      </article>
      <p className="cbv-editor__preview-hint">预览使用样例数据；实际卡片内容以你的记录为准。</p>
    </div>
  );
}

export const PreviewSampleCard = memo(PreviewSampleCardInner);
PreviewSampleCard.displayName = 'PreviewSampleCard';
