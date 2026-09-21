/**
 * QA2 独立验证（任务 #13/#15）· T11：沉浸式三栏卡片排版编辑器。
 *
 * 断言来源：
 *  - `03 §10` / `04 §5.3` / R1：**沉浸式三栏**（左 220 / 中弹性 / 右 300），顶栏 h=48，
 *    含「卡片排版 | 文档排版」切换 + 取消/保存；**不是抽屉**（口径 #2）。
 *  - `03 §10` 交互约束：保存为唯一出口；未保存关闭需**二次确认**；编辑态点卡片不展开（R6）。
 *  - `04 §5.3.2`：字段池三组（已使用 / 未使用 / 不支持）；**2px 插入指示线** `#3370FF`。
 *  - T11 完成标准：三栏 ≡ R1；字段池三组；密度三档 + 属性 3 行 ≡ R3。
 *
 * ⚠️ 覆盖边界（诚实标注）：
 *  - **dnd-kit 的真实拖拽手势**（PointerSensor 长按阈值、幽灵跟随、跨容器落位）在 jsdom 下
 *    **无法可靠模拟**，本文件只验证：① 纯排布逻辑（`placementMath`）；② 拖拽**反馈元素/样式**
 *    的静态存在；③ 顶点结构。**不伪造拖拽行为测试**。
 *
 *  - 2px 指示线 DOM 仅在 dnd `isOver` 为真时出现，jsdom 无法触发 → 本文件改为断言其
 *    **CSS 尺寸契约（height:2px）** 与代码路径，并在此显式标注为「静态验证」。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardLayoutConfig, FieldPlacement, SlotConfig, SlotId } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { ConfigDrawer } from './ConfigDrawer';
import { PreviewSampleCard } from './PreviewSampleCard';
import {
  addFieldToSlot,
  findPlacement,
  flattenPlacements,
  groupFieldPool,
  movePlacement,
  removePlacement,
  renamePlacement,
  resolveEditorClose,
  setSlotDirection,
  setSlotVisible,
  usedFieldIds,
} from './placementMath';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 布局 / 排布纯逻辑 ============================ */

function pl(fieldId: string, order: number): FieldPlacement {
  return {
    placementId: `p_${fieldId}_${order}`,
    fieldId,
    order,
    labelVisible: false,
    display: { maxLines: 1, truncate: 'ellipsis', maxItems: 3, hideWhenEmpty: true },
  };
}

function sl(id: SlotId, placements: FieldPlacement[]): SlotConfig {
  return {
    id,
    visible: true,
    collapsibleWhenEmpty: true,
    direction: id === 'attributes' ? 'column' : 'row',
    separator: ' · ',
    maxItemsPerCard: 8,
    placements,
  };
}

const BASE: CardLayoutConfig = {
  templateId: 'custom',
  cardAspect: 'auto',
  slots: {
    title: sl('title', [pl('f1', 0)]),
    subtitle: sl('subtitle', []),
    attributes: sl('attributes', [pl('f2', 0), pl('f3', 1)]),
    footer: sl('footer', []),
  },
};

const fieldIdsOf = (l: CardLayoutConfig, slot: SlotId): string[] =>
  [...l.slots[slot].placements].sort((a, b) => a.order - b.order).map((p) => p.fieldId);

describe('T11 · placementMath 纯排布逻辑', () => {
  it('flattenPlacements / usedFieldIds / findPlacement', () => {
    expect(flattenPlacements(BASE).map((e) => e.placement.fieldId)).toEqual(['f1', 'f2', 'f3']);
    expect([...usedFieldIds(BASE)].sort()).toEqual(['f1', 'f2', 'f3']);
    expect(findPlacement(BASE, 'p_f3_1')?.slotId).toBe('attributes');
    expect(findPlacement(BASE, 'nope')).toBeNull();
  });

  it('movePlacement 跨槽位并重排 order', () => {
    const next = movePlacement(BASE, 'p_f2_0', 'title', 0);
    expect(fieldIdsOf(next, 'title')).toEqual(['f2', 'f1']);
    expect(fieldIdsOf(next, 'attributes')).toEqual(['f3']);
    expect(next.slots.title.placements.map((p) => p.order)).toEqual([0, 1]);
    // 不修改入参
    expect(fieldIdsOf(BASE, 'title')).toEqual(['f1']);
  });

  it('removePlacement / renamePlacement / setSlotVisible / setSlotDirection', () => {
    expect(fieldIdsOf(removePlacement(BASE, 'p_f1_0'), 'title')).toEqual([]);
    const renamed = renamePlacement(BASE, 'p_f1_0', '客户');
    const renamedPlacement = findPlacement(renamed, 'p_f1_0')?.placement;
    expect(renamedPlacement?.label).toBe('客户');
    expect(renamedPlacement?.labelVisible).toBe(true);
    expect(setSlotVisible(BASE, 'subtitle', true).slots.subtitle.visible).toBe(true);
    expect(setSlotDirection(BASE, 'subtitle', 'column').slots.subtitle.direction).toBe('column');
  });

  it('addFieldToSlot：新字段追加；已在其他槽位的字段 → 视为移动（不复制）', () => {
    const added = addFieldToSlot(BASE, 'f9', 'subtitle', 0);
    expect(fieldIdsOf(added, 'subtitle')).toEqual(['f9']);
    const moved = addFieldToSlot(BASE, 'f1', 'attributes', 0);
    expect(fieldIdsOf(moved, 'title')).toEqual([]);
    expect(fieldIdsOf(moved, 'attributes')).toEqual(['f1', 'f2', 'f3']);
  });

  it('groupFieldPool：已使用 / 未使用 / 不支持 三组', () => {
    const fields: FieldMetaLite[] = [
      { id: 'f1', name: 'A', type: FieldType.Text, isPrimary: true },
      { id: 'f2', name: 'B', type: FieldType.Number, isPrimary: false },
      { id: 'f3', name: 'C', type: FieldType.Text, isPrimary: false },
      { id: 'f4', name: 'D', type: 99999, isPrimary: false }, // 不支持
      { id: 'f5', name: 'E', type: FieldType.Text, isPrimary: false }, // 未使用
    ];
    const groups = groupFieldPool(fields, BASE);
    expect(groups.used.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(groups.unused.map((f) => f.id)).toEqual(['f5']);
    expect(groups.unsupported.map((f) => f.id)).toEqual(['f4']);
  });

  it('resolveEditorClose：脏值 → 二次确认', () => {
    expect(resolveEditorClose(false)).toBe('close');
    expect(resolveEditorClose(true)).toBe('confirm');
  });
});

/* ============================ 静态契约：三栏尺寸 / 顶栏 / 2px 指示线 ============================ */

describe('T11 · 静态契约（token / CSS 占位）', () => {
  const read = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

  it('token：左 220 / 右 300(card) / 右 320(doc) / 顶栏 48 / 抽屉 860', () => {
    const tokens = read('src/styles/tokens.css');
    expect(tokens).toContain('--layout-panel-left: 220px');
    expect(tokens).toContain('--layout-panel-right-card: 300px');
    expect(tokens).toContain('--layout-panel-right-doc: 320px');
    expect(tokens).toContain('--layout-toolbar-height: 48px');
    expect(tokens).toContain('--layout-drawer-default: 860px');
  });

  it('编辑器三栏由 CSS grid 承载（220 / 1fr / 300）', () => {
    const globals = read('src/styles/globals.css');
    expect(globals).toMatch(
      /grid-template-columns:\s*var\(--layout-panel-left\)\s+1fr\s+var\(--layout-panel-right-card\)/,
    );
  });

  it('插入指示线为 2px（`#3370FF` = --color-primary）', () => {
    const globals = read('src/styles/globals.css');
    const block = /\.cbv-slot__insert-line\s*\{([^}]*)\}/.exec(globals)?.[1] ?? '';
    expect(block).toMatch(/height:\s*2px/);
    expect(block).toMatch(/background:\s*var\(--color-primary\)/);
  });
});

/* ============================ ConfigDrawer 渲染 ============================ */

function mount(node: ReturnType<typeof createElement>): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findByText(container: HTMLElement, selector: string, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) => (el.textContent ?? '').includes(text));
}

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '备注', type: 99999, isPrimary: false }, // 不支持类型
];

function openEditor(): void {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
  useViewStore.setState({ config, fields: FIELDS, canEditConfig: true, unsupportedNewer: false });
  useDraftStore.getState().close();
  useDraftStore.getState().open(config, 'card');
  useUiStore.setState({ editorOpen: true, editMode: 'card' });
}

describe('T11 · ConfigDrawer（沉浸式三栏，非抽屉）', () => {
  beforeEach(() => {
    useDraftStore.getState().close();
    useUiStore.setState({ editorOpen: false, editMode: 'card', toast: null });
    openEditor();
  });

  it('渲染三栏容器 + 顶栏模式切换 + 字段池三组 + 取消/保存；不是抽屉', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    const html = container.innerHTML;

    expect(container.querySelector('.cbv-editor')).not.toBeNull();
    expect(container.querySelector('.cbv-drawer')).toBeNull(); // 口径 #2：不是抽屉
    expect(html).toContain('卡片排版');
    expect(html).toContain('文档排版');
    expect(html).toContain('已使用');
    expect(html).toContain('未使用');
    expect(html).toContain('不支持类型');
    expect(findByText(container, 'button', '取消')).toBeDefined();
    expect(findByText(container, 'button', '保存')).toBeDefined();
    // 编辑态无卡片墙 → 无 data-record-id（点卡片不展开，R6）
    expect(container.querySelectorAll('[data-record-id]').length).toBe(0);
    unmount();
  });

  it('切「文档排版」→ M2 仅入口占位（不假装已实现 A4 分页）', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    const docTab = findByText(container, 'button', '文档排版') as HTMLElement;
    act(() => {
      docTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const html = container.innerHTML;
    expect(html).toContain('文档排版即将上线');
    expect(html).not.toContain('A4');
    unmount();
  });

  it('有未保存修改 → 关闭需二次确认', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    act(() => {
      useDraftStore.getState().updateCard((l) => ({ ...l, templateId: 'compact' }));
    });
    expect(container.innerHTML).toContain('未保存');

    const cancel = findByText(container, 'button', '取消') as HTMLElement;
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.innerHTML).toContain('放弃未保存的修改');
    unmount();
  });
});

describe('T11 · PreviewSampleCard：编辑态预览卡不可交互（R6）', () => {
  it('预览卡为 static（不可点击展开详情）', () => {
    const html = renderToStaticMarkup(
      createElement(PreviewSampleCard, {
        layout: BASE,
        fields: FIELDS,
        theme: createDefaultConfig({ viewId: 'v', tableId: 't' }).theme,
        locale: 'zh-CN',
        attributesMaxRows: 3,
      }),
    );
    expect(html).toContain('cbv-card--static');
    expect(html).not.toContain('data-record-id');
  });
});
