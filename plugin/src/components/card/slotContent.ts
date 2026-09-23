/**
 * 卡片槽位内容判定（T09）：判断某字段落位 / 某槽位「是否有内容」，
 * 用于 `collapsibleWhenEmpty` 收合与「空槽位不占位」。
 *
 * 与渲染层同源：同样经 `normalize()`，保证「判定为空」与「渲染为空」一致。
 * 字段元数据缺失（字段被删除）→ 视为无内容（自动隐藏，03 §12）。
 */
import type { SdkRecord } from '@/sdk/port';
import type { FieldPlacement, SlotConfig } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { getRecordFields } from '@/data/RecordDataSource';

export type FieldsById = Record<string, FieldMetaLite>;

/** 单个字段落位是否有内容 */
export function placementHasContent(
  placement: FieldPlacement,
  record: SdkRecord,
  fieldsById: FieldsById,
): boolean {
  const meta = fieldsById[placement.fieldId];
  if (!meta) return false;
  try {
    const raw = getRecordFields(record)[placement.fieldId];
    const nv = normalize(raw, meta);
    return !nv.isEmpty;
  } catch {
    // F3：读取 / 归一化异常**不隐藏字段**——视为「有内容」，交由 `FieldValue`
    // 渲染 `FallbackRenderer`（可见降级，而非静默消失）。仅「元数据缺失」才隐藏。
    return true;
  }
}

/** 槽位内是否有任意一个有内容的落位（按 order 排序后判定） */
export function slotHasContent(slot: SlotConfig, record: SdkRecord, fieldsById: FieldsById): boolean {
  if (!slot.visible || slot.placements.length === 0) return false;
  return slot.placements.some((placement) => placementHasContent(placement, record, fieldsById));
}

/** 槽位内字段名（label 覆盖优先） */
export function labelOf(placement: FieldPlacement, fieldsById: FieldsById): string {
  if (placement.label && placement.label.trim() !== '') return placement.label;
  return fieldsById[placement.fieldId]?.name ?? '';
}

/** 取卡片 aria-label 用的标题文本（找不到则回落 recordId 之外的通用文案，不外泄 id） */
export function recordTitleText(layout: { slots: Record<string, SlotConfig> }, record: SdkRecord, fieldsById: FieldsById): string {
  const titleSlot = layout.slots.title;
  if (titleSlot) {
    const sorted = [...titleSlot.placements].sort((a, b) => a.order - b.order);
    for (const placement of sorted) {
      const meta = fieldsById[placement.fieldId];
      if (!meta) continue;
      try {
        const raw = getRecordFields(record)[placement.fieldId];
        const nv = normalize(raw, meta);
        if (!nv.isEmpty && nv.text.trim() !== '') return nv.text;
      } catch {
        /* 继续尝试下一个字段 */
      }
    }
  }
  return '记录';
}

/** 按 order 排序并截断到槽位/密度允许的条数 */
export function visiblePlacements(slot: SlotConfig, limit: number): FieldPlacement[] {
  const sorted = [...slot.placements].sort((a, b) => a.order - b.order);
  const cap = limit > 0 ? limit : sorted.length;
  return sorted.slice(0, cap);
}
