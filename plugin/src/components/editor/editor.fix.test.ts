/**
 * 回归测试（工程师）——T11：卡片排版编辑器（**纯排布逻辑**，dnd-kit 仅负责手势与视觉）。
 *
 * 覆盖：槽位移动 / 字段池三分组 / 添加与移除 / 槽位属性 / 关闭语义 / 拖拽 id 解析 /
 * 样例记录合成 / 模板套用（保留字段、槽位形状差异、R4 封面图口径）。
 */
import { describe, expect, it } from 'vitest';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { defaultCardLayout } from '@/config/defaults';
import { applyCardTemplate } from '@/config/presets';
import {
  SLOT_ORDER,
  addFieldToSlot,
  findPlacement,
  groupFieldPool,
  movePlacement,
  removePlacement,
  renamePlacement,
  resolveEditorClose,
  setSlotDirection,
  setSlotVisible,
  usedFieldIds,
} from '@/components/editor/placementMath';
import { fieldDragId, parseDragId, placementDragId, slotDropId } from '@/components/editor/dragIds';
import { buildSampleRecord } from '@/components/editor/sampleRecord';

const fields: FieldMetaLite[] = [
  { id: 'f_title', name: '名称', type: FieldType.Text, isPrimary: true },
  { id: 'f_status', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f_loc', name: '位置', type: FieldType.Location, isPrimary: false },
  { id: 'f_unknown', name: '神秘', type: 99999, isPrimary: false },
];

function placementCount(layout: ReturnType<typeof defaultCardLayout>): number {
  return SLOT_ORDER.reduce((sum, slotId) => sum + layout.slots[slotId].placements.length, 0);
}

describe('T11 · placementMath：槽位移动与排布', () => {
  it('usedFieldIds / findPlacement', () => {
    const layout = defaultCardLayout(fields);
    expect([...usedFieldIds(layout)].sort()).toEqual(['f_amount', 'f_status', 'f_title']);
    const first = layout.slots.attributes.placements[0];
    const found = findPlacement(layout, first.placementId);
    expect(found?.slotId).toBe('attributes');
    expect(findPlacement(layout, 'nope')).toBeNull();
  });

  it('movePlacement：跨槽移动 + 目标 order 归一', () => {
    const layout = defaultCardLayout(fields);
    const target = layout.slots.attributes.placements[0];
    expect(target.fieldId).toBe('f_status');

    const moved = movePlacement(layout, target.placementId, 'footer', 0);
    expect(moved.slots.footer.placements.map((p) => p.fieldId)).toEqual(['f_status']);
    expect(moved.slots.attributes.placements.map((p) => p.fieldId)).toEqual(['f_amount']);
    // order 归一到 0..n-1
    moved.slots.footer.placements.forEach((p, index) => expect(p.order).toBe(index));
    // 入参不被修改
    expect(layout.slots.footer.placements).toHaveLength(0);
  });

  it('addFieldToSlot：已用字段 = 移动（不复制，字段不重复）', () => {
    const layout = defaultCardLayout(fields);
    const titleCount = layout.slots.title.placements.length;
    const next = addFieldToSlot(layout, 'f_amount', 'title', -1);

    expect(next.slots.title.placements.map((p) => p.fieldId)).toEqual(['f_title', 'f_amount']);
    expect(next.slots.attributes.placements.map((p) => p.fieldId)).toEqual(['f_status']);
    expect(next.slots.title.placements.length).toBe(titleCount + 1);
    // 全量字段数不变（移动而非复制）
    expect(placementCount(next)).toBe(placementCount(layout));
  });

  it('removePlacement：移除后 order 连续', () => {
    const layout = defaultCardLayout(fields);
    const first = layout.slots.attributes.placements[0];
    const next = removePlacement(layout, first.placementId);
    expect(next.slots.attributes.placements.map((p) => p.fieldId)).toEqual(['f_amount']);
    expect(next.slots.attributes.placements[0].order).toBe(0);
  });

  it('renamePlacement：写入 label 并打开 labelVisible', () => {
    const layout = defaultCardLayout(fields);
    const target = layout.slots.attributes.placements[0];
    const next = renamePlacement(layout, target.placementId, '当前状态');
    const after = findPlacement(next, target.placementId);
    expect(after?.placement.label).toBe('当前状态');
    expect(after?.placement.labelVisible).toBe(true);
  });

  it('槽位属性：可见性 / 方向（仅改目标槽位，不波及兄弟槽位）', () => {
    const layout = defaultCardLayout(fields);
    const hidden = setSlotVisible(layout, 'footer', true);
    expect(hidden.slots.footer.visible).toBe(true);
    expect(hidden.slots.title.visible).toBe(true);

    // 默认方向：title / subtitle / footer = row，attributes = column
    expect(layout.slots.subtitle.direction).toBe('row');
    expect(layout.slots.title.direction).toBe('row');
    // subtitle：row → column（目标改变）
    const odd = setSlotDirection(layout, 'subtitle', 'column');
    expect(odd.slots.subtitle.direction).toBe('column');
    // 判别性断言：兄弟槽位保持默认，未被一并改写（错改成「全槽位同向」会失败）
    expect(odd.slots.title.direction).toBe('row');
    expect(odd.slots.footer.direction).toBe('row');
    expect(odd.slots.attributes.direction).toBe('column');
    // 入参不被修改（纯函数）
    expect(layout.slots.subtitle.direction).toBe('row');
  });
});

describe('T11 · groupFieldPool：三组分类', () => {
  it('已使用 / 未使用 / 不支持类型', () => {
    const layout = defaultCardLayout(fields);
    const groups = groupFieldPool(fields, layout);
    expect(groups.used.map((f) => f.id)).toEqual(['f_title', 'f_status', 'f_amount']);
    expect(groups.unused.map((f) => f.id)).toEqual(['f_loc']);
    expect(groups.unsupported.map((f) => f.id)).toEqual(['f_unknown']);
  });
});

describe('T11 · 关闭语义', () => {
  it('有未保存改动 → 需二次确认', () => {
    expect(resolveEditorClose(true)).toBe('confirm');
    expect(resolveEditorClose(false)).toBe('close');
  });
});

describe('T11 · dnd-kit 拖拽 id 命名空间', () => {
  it('前缀解析正确', () => {
    expect(parseDragId(fieldDragId('f1'))).toEqual({ kind: 'field', value: 'f1' });
    expect(parseDragId(placementDragId('p1'))).toEqual({ kind: 'placement', value: 'p1' });
    expect(parseDragId(slotDropId('title'))).toEqual({ kind: 'slot', value: 'title' });
    expect(parseDragId('weird')).toEqual({ kind: 'unknown', value: 'weird' });
  });
});

describe('T11 · 样例记录合成（编辑器预览）', () => {
  it('为每类字段生成示例值，且不外泄原始 ID', () => {
    const record = buildSampleRecord(fields);
    const values = (record as unknown as { fields: Record<string, unknown> }).fields;
    for (const field of fields) expect(values[field.id]).toBeDefined();
    expect(JSON.stringify(record)).not.toContain('ou_');
    expect(JSON.stringify(record)).not.toContain('ftok');
  });
});

describe('T11 · 模板套用（保留字段 + 形状差异 + R4）', () => {
  it('compact：副标题与底部收合', () => {
    const layout = defaultCardLayout(fields);
    const compact = applyCardTemplate('compact', layout);
    expect(compact.templateId).toBe('compact');
    expect(compact.slots.subtitle.visible).toBe(false);
    expect(compact.slots.footer.visible).toBe(false);
    expect(placementCount(compact)).toBe(placementCount(layout));
  });

  it('list：副标题纵向排列', () => {
    const layout = defaultCardLayout(fields);
    const list = applyCardTemplate('list', layout);
    expect(list.slots.subtitle.direction).toBe('column');
    expect(list.slots.subtitle.visible).toBe(true);
  });

  it('cover：R4 冻结 → 不显示封面图', () => {
    const layout = defaultCardLayout(fields);
    const cover = applyCardTemplate('cover', layout);
    expect(cover.showCoverImage).toBe(false);
  });
});
