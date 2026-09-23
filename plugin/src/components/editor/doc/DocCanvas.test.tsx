/**
 * `DocCanvas` 组件测试（M3-T08）。
 *
 * ⭐ 断言目标（团队禁令：禁止假绿断言）：
 *  1. **区块流锚点序列恒等于模板 `blocks` 顺序** —— 每个模板区块有且仅有一个锚点，
 *     `pageBreak` 与「被 resolve 剔除的块」**也必须有锚点**（否则用户会看到区块凭空消失且无报错）。
 *  2. **插入槽 = N+1 个**（`0..N`），且顺序正确（少一个则「追加到末尾 / 首部插入」不可用）。
 *  3. 选中态视觉标识（`data-selected`）挂在正确的外壳上。
 *
 * ⚠️ 覆盖边界（诚实标注）：dnd-kit 的真实拖拽手势在 jsdom 下无法可靠模拟，
 * 本文件不伪造拖拽行为测试 —— 只验证锚点/槽位/选中这些**结构契约**。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { describe, expect, it, vi } from 'vitest';
import type { DocBlock, DocTemplate, ParagraphBlock } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { defaultBlockFor } from '@/doc/blockDefaults';
import { defaultDocTemplate } from '@/config/defaults';
import type { DocCanvasProps } from './DocCanvas';
import { DocCanvas } from './DocCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

/** 造一个 id 固定的区块（便于精确断言） */
function mk(kind: DocBlock['kind'], id: string): DocBlock {
  return defaultBlockFor(kind, FIELDS, { makeId: () => id });
}

/** 造一个绑定「不存在的字段」的段落 → `resolveBlocks` 会把它剔除（外壳仍须存在） */
function paragraphWithField(id: string, fieldId: string): ParagraphBlock {
  const block = defaultBlockFor('paragraph', FIELDS, { makeId: () => id }) as ParagraphBlock;
  return { ...block, fieldId };
}

const baseTemplate = defaultDocTemplate(FIELDS);

function makeTemplate(): DocTemplate {
  return {
    ...baseTemplate,
    templateId: 't08-test',
    blocks: [
      mk('heading', 'b1'),
      mk('divider', 'b2'),
      mk('pageBreak', 'b3'),
      mk('spacer', 'b4'),
      paragraphWithField('b5', '__missing__'),
      mk('metaFooter', 'b6'),
    ],
  };
}

function mount(props: DocCanvasProps): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(DndContext, null, createElement(DocCanvas, props)));
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

/** 区块流锚点 = `.cbv-editor__doc-flow` 的**直接子元素**中带 `data-block-id` 的节点 */
function flowAnchors(container: HTMLElement): HTMLElement[] {
  const flow = container.querySelector('.cbv-editor__doc-flow');
  if (!flow) return [];
  return [...flow.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-block-id'),
  );
}

/** 插入槽（按 DOM 顺序） */
function flowSlots(container: HTMLElement): HTMLElement[] {
  const flow = container.querySelector('.cbv-editor__doc-flow');
  if (!flow) return [];
  return [...flow.querySelectorAll<HTMLElement>('[data-docslot-index]')];
}

describe('DocCanvas · 区块流锚点序列 = 模板 blocks 顺序', () => {
  it('data-block-id 序列与模板顺序完全一致（含 pageBreak 与被剔除块）', () => {
    const template = makeTemplate();
    const { container, unmount } = mount({ template, fields: FIELDS });

    const ids = flowAnchors(container).map((el) => el.getAttribute('data-block-id'));
    // 变异验证：外壳用 resolved.blockId 而非 block.blockId（剔除块会丢锚点）→ 此断言立刻变红
    expect(ids).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(ids).toEqual(template.blocks.map((block) => block.blockId));

    // 每个锚点一个 kind 标记（pageBreak 也在）
    const kinds = flowAnchors(container).map((el) => el.getAttribute('data-block-kind'));
    expect(kinds).toEqual(['heading', 'divider', 'pageBreak', 'spacer', 'paragraph', 'metaFooter']);
    unmount();
  });

  it('pageBreak 在编辑器里可见；被 resolve 剔除的块显示空态提示', () => {
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS });

    expect(container.querySelectorAll('[data-editor-page-break="true"]').length).toBe(1);
    // b5 绑定不存在的字段 → 被剔除，但其外壳仍在且有显式提示（绝不静默留白）
    expect(container.querySelectorAll('[data-editor-block-empty="true"]').length).toBe(1);
    expect(flowAnchors(container).length).toBe(6);
    unmount();
  });

  it('真实可见块渲染出文档渲染管线的区块根（内层 data-block-id）', () => {
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS });
    // heading/divider/spacer/metaFooter 会经 BlockRenderer 渲染出 .cbv-doc-block 根
    expect(container.querySelectorAll('.cbv-doc-block').length).toBeGreaterThanOrEqual(1);
    unmount();
  });
});

describe('DocCanvas · 插入槽（N 个区块 → N+1 个槽）', () => {
  it('槽位数 = 锚点数 + 1，索引为 0..N 且顺序正确', () => {
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS });

    const anchors = flowAnchors(container);
    const slots = flowSlots(container);
    expect(anchors.length).toBe(6);
    // 变异验证：删掉末尾 `<DocDropSlot index={blocks.length}/>` → 6 !== 7，立刻变红
    expect(slots.length).toBe(anchors.length + 1);
    expect(slots.map((el) => el.getAttribute('data-docslot-index'))).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    unmount();
  });

  it('document 根自报 data-block-count / data-slot-count', () => {
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS });
    const canvas = container.querySelector('.cbv-editor__doc-canvas');
    expect(canvas?.getAttribute('data-block-count')).toBe('6');
    expect(canvas?.getAttribute('data-slot-count')).toBe('7');
    unmount();
  });

  it('默认模板（8 区块）→ 9 个槽', () => {
    const template = defaultDocTemplate(FIELDS);
    const { container, unmount } = mount({ template, fields: FIELDS });
    expect(template.blocks.length).toBe(8);
    expect(flowAnchors(container).length).toBe(8);
    expect(flowSlots(container).length).toBe(9);
    expect(flowAnchors(container).map((el) => el.getAttribute('data-block-id'))).toEqual(
      template.blocks.map((block) => block.blockId),
    );
    unmount();
  });
});

describe('DocCanvas · 选中态', () => {
  it('selectedBlockId 命中唯一外壳 → data-selected=true，其余为 false', () => {
    const { container, unmount } = mount({
      template: makeTemplate(),
      fields: FIELDS,
      selectedBlockId: 'b2',
    });

    const anchors = flowAnchors(container);
    expect(anchors.map((el) => el.getAttribute('data-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(container.querySelectorAll('[data-selected="true"]').length).toBe(1);
    expect(anchors[1].className).toContain('cbv-editor__doc-block--selected');
    unmount();
  });

  it('未传 selectedBlockId → 无选中', () => {
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS });
    expect(container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    unmount();
  });

  it('点击外壳 → onSelectBlock(blockId)', () => {
    const onSelectBlock = vi.fn();
    const { container, unmount } = mount({ template: makeTemplate(), fields: FIELDS, onSelectBlock });

    const anchors = flowAnchors(container);
    act(() => {
      anchors[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectBlock).toHaveBeenCalledTimes(1);
    expect(onSelectBlock).toHaveBeenCalledWith('b3');
    unmount();
  });
});
