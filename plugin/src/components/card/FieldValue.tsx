/**
 * 字段值渲染的**单点入口**（卡片态，设计文档 §11）。
 * 所有字段渲染必须经本组件 → 内部查注册表 `registry.renderCard`。
 * 字段被删除（元数据缺失）→ 自动隐藏；
 * 单字段异常（含 `normalize()` 阶段抛错，F3）→ 回落 FallbackRenderer，不影响整卡。
 */
import { memo, useMemo } from 'react';
import type { SdkRecord } from '@/sdk/port';
import type { FieldPlacement, StyleTheme } from '@/config/types';
import type { FieldMetaLite, NormalizedValue, RenderContext } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { FALLBACK_VALUE, renderCard, renderFallbackCard } from '@/fields/registry';
import { getRecordFields } from '@/data/RecordDataSource';
import { logError } from '@/utils/log';

export interface FieldValueProps {
  placement: FieldPlacement;
  record: SdkRecord;
  fieldsById: Record<string, FieldMetaLite>;
  theme: StyleTheme;
  locale: string;
}

interface ResolvedValue {
  normalized: NormalizedValue;
  /** 归一化阶段是否发生异常（发生则走 FallbackRenderer） */
  failed: boolean;
}

function FieldValueInner({ placement, record, fieldsById, theme, locale }: FieldValueProps): JSX.Element | null {
  const meta = fieldsById[placement.fieldId];

  // F3：字段值可能在「读取」或 `normalize()` 阶段抛错（getter / Proxy）。
  // 必须在此兜住，保证「单字段异常不影响整卡」在组件路径上同样成立。
  const resolved = useMemo<ResolvedValue | null>(() => {
    if (!meta) return null;
    try {
      const rawValue = getRecordFields(record)[placement.fieldId];
      return { normalized: normalize(rawValue, meta), failed: false };
    } catch (err) {
      logError('components.FieldValue.normalize', err, { fieldId: placement.fieldId });
      return { normalized: FALLBACK_VALUE, failed: true };
    }
  }, [meta, record, placement.fieldId]);

  const context = useMemo<RenderContext | null>(
    () => (meta ? { fieldMeta: meta, display: placement.display, theme, locale } : null),
    [meta, placement.display, theme, locale],
  );

  if (!meta || !resolved || !context) return null;

  return <>{resolved.failed ? renderFallbackCard(context) : renderCard(resolved.normalized, context)}</>;
}

export const FieldValue = memo(FieldValueInner);
FieldValue.displayName = 'FieldValue';
