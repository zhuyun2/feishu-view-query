/**
 * 卡片排版编辑器的**纯排布逻辑**（T11，便于单测；dnd-kit 只负责手势与视觉反馈）。
 *
 * 约定：
 *  - 一个字段**至多出现在一个槽位**（拖入已用字段 = 移动，而非复制）；
 *  - 每次变更后对受影响槽位的 `order` 重新归一（0..n-1），保证渲染顺序稳定；
 *  - 不修改入参（返回新对象），便于 DraftStore 做 dirty 判定与快照回滚。
 */
import type { CardLayoutConfig, FieldPlacement, SlotConfig, SlotId } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { getFieldPriority } from '@/fields/fieldTypes';
import { createPlacement } from '@/config/defaults';

export const SLOT_ORDER: readonly SlotId[] = ['title', 'subtitle', 'attributes', 'footer'];

export const SLOT_LABEL: Readonly<Record<SlotId, string>> = {
  title: '标题',
  subtitle: '副标题',
  attributes: '属性',
  footer: '底部',
};

function reindex(slot: SlotConfig): SlotConfig {
  return { ...slot, placements: slot.placements.map((placement, index) => ({ ...placement, order: index })) };
}

/** 全部槽位按顺序展平（保持 order 稳定） */
export function flattenPlacements(layout: CardLayoutConfig): Array<{ slotId: SlotId; placement: FieldPlacement }> {
  const out: Array<{ slotId: SlotId; placement: FieldPlacement }> = [];
  for (const slotId of SLOT_ORDER) {
    const slot = layout.slots[slotId];
    if (!slot) continue;
    for (const placement of [...slot.placements].sort((a, b) => a.order - b.order)) {
      out.push({ slotId, placement });
    }
  }
  return out;
}

/** 已使用字段 id 集合 */
export function usedFieldIds(layout: CardLayoutConfig): Set<string> {
  const set = new Set<string>();
  for (const slotId of SLOT_ORDER) {
    for (const placement of layout.slots[slotId]?.placements ?? []) set.add(placement.fieldId);
  }
  return set;
}

/** 定位某落位 */
export function findPlacement(
  layout: CardLayoutConfig,
  placementId: string,
): { slotId: SlotId; placement: FieldPlacement; index: number } | null {
  for (const slotId of SLOT_ORDER) {
    const slot = layout.slots[slotId];
    if (!slot) continue;
    const index = slot.placements.findIndex((placement) => placement.placementId === placementId);
    if (index >= 0) return { slotId, placement: slot.placements[index], index };
  }
  return null;
}

/** 移除某落位 */
export function removePlacement(layout: CardLayoutConfig, placementId: string): CardLayoutConfig {
  const slots: Record<SlotId, SlotConfig> = { ...layout.slots };
  for (const slotId of SLOT_ORDER) {
    const slot = slots[slotId];
    if (!slot) continue;
    if (slot.placements.some((placement) => placement.placementId === placementId)) {
      slots[slotId] = reindex({ ...slot, placements: slot.placements.filter((p) => p.placementId !== placementId) });
    }
  }
  return { ...layout, slots };
}

/**
 * 移动落位到 `toSlotId` 的第 `toIndex` 位（跨槽 / 同槽均支持）。
 * `toIndex < 0` 或超出 → 追加到末尾。
 */
export function movePlacement(
  layout: CardLayoutConfig,
  placementId: string,
  toSlotId: SlotId,
  toIndex: number,
): CardLayoutConfig {
  const found = findPlacement(layout, placementId);
  if (!found) return layout;

  const slots: Record<SlotId, SlotConfig> = { ...layout.slots };
  const from = slots[found.slotId];
  const moved = { ...found.placement, order: 0 };
  slots[found.slotId] = reindex({ ...from, placements: from.placements.filter((p) => p.placementId !== placementId) });

  const target = slots[toSlotId];
  const list = [...target.placements];
  const insertAt = toIndex < 0 || toIndex > list.length ? list.length : toIndex;
  list.splice(insertAt, 0, moved);
  slots[toSlotId] = reindex({ ...target, placements: list });

  return { ...layout, slots };
}

/**
 * 从字段池拖入槽位（新字段）：若该字段已在其他槽位，视为**移动**；
 * `toIndex < 0` → 追加到末尾。
 */
export function addFieldToSlot(
  layout: CardLayoutConfig,
  fieldId: string,
  toSlotId: SlotId,
  toIndex = -1,
): CardLayoutConfig {
  const existing = flattenPlacements(layout).find((entry) => entry.placement.fieldId === fieldId);
  if (existing) return movePlacement(layout, existing.placement.placementId, toSlotId, toIndex);

  const slots: Record<SlotId, SlotConfig> = { ...layout.slots };
  const target = slots[toSlotId];
  const placement = createPlacement(fieldId, target.placements.length);
  const list = [...target.placements];
  const insertAt = toIndex < 0 || toIndex > list.length ? list.length : toIndex;
  list.splice(insertAt, 0, placement);
  slots[toSlotId] = reindex({ ...target, placements: list });
  return { ...layout, slots };
}

/** 重命名某落位的显示标签（labelVisible 一并打开） */
export function renamePlacement(layout: CardLayoutConfig, placementId: string, label: string): CardLayoutConfig {
  const slots: Record<SlotId, SlotConfig> = { ...layout.slots };
  for (const slotId of SLOT_ORDER) {
    const slot = slots[slotId];
    if (!slot) continue;
    if (slot.placements.some((p) => p.placementId === placementId)) {
      slots[slotId] = {
        ...slot,
        placements: slot.placements.map((p) =>
          p.placementId === placementId ? { ...p, label, labelVisible: label.trim() !== '' } : p,
        ),
      };
    }
  }
  return { ...layout, slots };
}

/** 切换槽位可见性 */
export function setSlotVisible(layout: CardLayoutConfig, slotId: SlotId, visible: boolean): CardLayoutConfig {
  const slot = layout.slots[slotId];
  if (!slot) return layout;
  return { ...layout, slots: { ...layout.slots, [slotId]: { ...slot, visible } } };
}

/** 切换槽位方向（row / column） */
export function setSlotDirection(
  layout: CardLayoutConfig,
  slotId: SlotId,
  direction: SlotConfig['direction'],
): CardLayoutConfig {
  const slot = layout.slots[slotId];
  if (!slot) return layout;
  return { ...layout, slots: { ...layout.slots, [slotId]: { ...slot, direction } } };
}

export interface FieldPoolGroups {
  used: FieldMetaLite[];
  unused: FieldMetaLite[];
  unsupported: FieldMetaLite[];
}

/**
 * 字段池三分组（R1）：
 *  - `used`：排版中已引用的字段；
 *  - `unused`：支持类型但尚未引用；
 *  - `unsupported`：不支持类型（`getFieldPriority === 'unsupported'`）。
 * 保持进入顺序（稳定），便于列表不跳动。
 */
export function groupFieldPool(fields: readonly FieldMetaLite[], layout: CardLayoutConfig): FieldPoolGroups {
  const used = usedFieldIds(layout);
  const groups: FieldPoolGroups = { used: [], unused: [], unsupported: [] };
  for (const field of fields) {
    if (used.has(field.id)) {
      groups.used.push(field);
    } else if (getFieldPriority(field.type) === 'unsupported') {
      groups.unsupported.push(field);
    } else {
      groups.unused.push(field);
    }
  }
  return groups;
}

/** 关闭编辑器的语义：有未保存改动 → 需二次确认 */
export type EditorCloseAction = 'close' | 'confirm';

export function resolveEditorClose(dirty: boolean): EditorCloseAction {
  return dirty ? 'confirm' : 'close';
}
