/**
 * dnd-kit 拖拽 id 命名空间（T11）。
 *
 * ⚠️ R1 冻结：**只用 dnd-kit 的 `PointerSensor`**（禁用 HTML5 原生 DnD —— iframe 沙箱下会失效）。
 * 通过「前缀」区分三类可拖/可放实体，`onDragEnd` 里解析即可，无需依赖组件树。
 */
export const FIELD_DRAG_PREFIX = 'field:';
export const PLACEMENT_DRAG_PREFIX = 'placement:';
export const SLOT_DROP_PREFIX = 'slot:';

/**
 * ── M3-T08 新增（文档排版编辑器）──────────────────────────────────────────────
 * ⚠️ **纯增**：上面 3 个前缀的解析逻辑一字未动，避免回归卡片排版。
 *  - `blocklib:`  从区块库拖出（新块，载荷 = kind）；
 *  - `docblock:`  画布内已放置区块（排序 / 移动）；
 *  - `docslot:`   文档流插入槽（`useDroppable` 目标，值是槽位序号）。
 * 三者与既有前缀**互不为前缀**（`docslot:` 不以 `slot:` 开头），故解析顺序无关。
 */
export const BLOCK_LIB_DRAG_PREFIX = 'blocklib:';
export const DOC_BLOCK_DRAG_PREFIX = 'docblock:';
export const DOC_SLOT_DROP_PREFIX = 'docslot:';

export type DragKind =
  | 'field'
  | 'placement'
  | 'slot'
  | 'blocklib'
  | 'docblock'
  | 'docslot'
  | 'unknown';

export function fieldDragId(fieldId: string): string {
  return `${FIELD_DRAG_PREFIX}${fieldId}`;
}

export function placementDragId(placementId: string): string {
  return `${PLACEMENT_DRAG_PREFIX}${placementId}`;
}

export function slotDropId(slotId: string): string {
  return `${SLOT_DROP_PREFIX}${slotId}`;
}

/** 区块库项 → 拖拽 id（值 = `DocBlockKind`） */
export function blockLibDragId(kind: string): string {
  return `${BLOCK_LIB_DRAG_PREFIX}${kind}`;
}

/** 画布内已放置区块 → 拖拽 id（值 = `blockId`） */
export function docBlockDragId(blockId: string): string {
  return `${DOC_BLOCK_DRAG_PREFIX}${blockId}`;
}

/** 文档流插入槽 → 放置目标 id（值 = 槽位序号，字符串化） */
export function docSlotDropId(index: number | string): string {
  return `${DOC_SLOT_DROP_PREFIX}${index}`;
}

export function parseDragId(id: string): { kind: DragKind; value: string } {
  if (id.startsWith(FIELD_DRAG_PREFIX)) return { kind: 'field', value: id.slice(FIELD_DRAG_PREFIX.length) };
  if (id.startsWith(PLACEMENT_DRAG_PREFIX)) {
    return { kind: 'placement', value: id.slice(PLACEMENT_DRAG_PREFIX.length) };
  }
  if (id.startsWith(SLOT_DROP_PREFIX)) return { kind: 'slot', value: id.slice(SLOT_DROP_PREFIX.length) };
  // ── M3-T08 文档排版前缀（纯增分支，顺序在既有 3 前缀之后、兜底之前）──
  if (id.startsWith(BLOCK_LIB_DRAG_PREFIX)) {
    return { kind: 'blocklib', value: id.slice(BLOCK_LIB_DRAG_PREFIX.length) };
  }
  if (id.startsWith(DOC_BLOCK_DRAG_PREFIX)) {
    return { kind: 'docblock', value: id.slice(DOC_BLOCK_DRAG_PREFIX.length) };
  }
  if (id.startsWith(DOC_SLOT_DROP_PREFIX)) {
    return { kind: 'docslot', value: id.slice(DOC_SLOT_DROP_PREFIX.length) };
  }
  return { kind: 'unknown', value: id };
}
