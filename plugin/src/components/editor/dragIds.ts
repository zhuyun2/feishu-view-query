/**
 * dnd-kit 拖拽 id 命名空间（T11）。
 *
 * ⚠️ R1 冻结：**只用 dnd-kit 的 `PointerSensor`**（禁用 HTML5 原生 DnD —— iframe 沙箱下会失效）。
 * 通过「前缀」区分三类可拖/可放实体，`onDragEnd` 里解析即可，无需依赖组件树。
 */
export const FIELD_DRAG_PREFIX = 'field:';
export const PLACEMENT_DRAG_PREFIX = 'placement:';
export const SLOT_DROP_PREFIX = 'slot:';

export type DragKind = 'field' | 'placement' | 'slot' | 'unknown';

export function fieldDragId(fieldId: string): string {
  return `${FIELD_DRAG_PREFIX}${fieldId}`;
}

export function placementDragId(placementId: string): string {
  return `${PLACEMENT_DRAG_PREFIX}${placementId}`;
}

export function slotDropId(slotId: string): string {
  return `${SLOT_DROP_PREFIX}${slotId}`;
}

export function parseDragId(id: string): { kind: DragKind; value: string } {
  if (id.startsWith(FIELD_DRAG_PREFIX)) return { kind: 'field', value: id.slice(FIELD_DRAG_PREFIX.length) };
  if (id.startsWith(PLACEMENT_DRAG_PREFIX)) {
    return { kind: 'placement', value: id.slice(PLACEMENT_DRAG_PREFIX.length) };
  }
  if (id.startsWith(SLOT_DROP_PREFIX)) return { kind: 'slot', value: id.slice(SLOT_DROP_PREFIX.length) };
  return { kind: 'unknown', value: id };
}
