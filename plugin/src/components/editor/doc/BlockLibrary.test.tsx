/**
 * `BlockLibrary` 组件测试（M3-T08）。
 *
 * ⭐ 断言目标（团队禁令：禁止假绿断言）：
 *  1. **恰好呈现 12 类 / 5 个分组** —— 逐组断言 kind 集合，而不是「渲染出了东西」。
 *     这条能抓出「漏了一类区块」：漏一类的后果是**该类区块根本拖不进文档**且**无任何报错**。
 *  2. 拖拽载荷含正确的 `kind`（`blockLibDragData` 是组件的载荷来源，直接断言其结构）。
 *  3. 拖拽 id 命名空间正确（`data-drag-id = blocklib:{kind}`）。
 *
 * ⚠️ 覆盖边界（诚实标注）：dnd-kit 的真实拖拽手势在 jsdom 下无法可靠模拟，
 * 本文件不伪造拖拽行为测试 —— 只验证「呈现了什么」与「载荷结构」。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import type { BlockGroup } from '@/doc/blockCatalog';
import { BLOCK_CATALOG, BLOCK_GROUP_ORDER } from '@/doc/blockCatalog';
import { blockLibDragId } from '../dragIds';
import { BlockLibrary, blockLibDragData } from './BlockLibrary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(DndContext, null, createElement(BlockLibrary)));
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

const kindsOfGroup = (container: HTMLElement, group: BlockGroup): (string | null)[] =>
  [...container.querySelectorAll(`[data-block-group="${group}"] [data-block-kind]`)].map((el) =>
    el.getAttribute('data-block-kind'),
  );

describe('BlockLibrary · 5 个分组 / 12 类区块', () => {
  it('分组数恰好 5，且顺序 = blockCatalog 的 BLOCK_GROUP_ORDER', () => {
    const { container, unmount } = mount();
    const groups = [...container.querySelectorAll('[data-block-group]')].map((el) =>
      el.getAttribute('data-block-group'),
    );
    // 变异验证：删掉任一 <LibraryGroup>（如 meta 组）→ 此处立刻变红
    expect(groups).toEqual([...BLOCK_GROUP_ORDER]);
    expect(groups.length).toBe(5);
    unmount();
  });

  it('区块项恰好 12 个，且逐组 kind 集合精确', () => {
    const { container, unmount } = mount();

    // ⭐ 逐组断言（漏一类 → 对应数组不再相等，立刻变红）
    expect(kindsOfGroup(container, 'text')).toEqual(['heading', 'paragraph', 'richText']);
    expect(kindsOfGroup(container, 'field')).toEqual(['keyValueGrid', 'fieldList', 'badgeRow']);
    expect(kindsOfGroup(container, 'media')).toEqual(['image', 'table']);
    expect(kindsOfGroup(container, 'structure')).toEqual(['divider', 'spacer', 'pageBreak']);
    expect(kindsOfGroup(container, 'meta')).toEqual(['metaFooter']);

    // 全部区块项的 kind 序列 = 目录顺序（12 个，去重后仍 12）
    const allKinds = [...container.querySelectorAll('[data-block-kind]')].map((el) =>
      el.getAttribute('data-block-kind'),
    );
    expect(allKinds).toEqual(BLOCK_CATALOG.map((entry) => entry.kind));
    expect(allKinds.length).toBe(12);
    expect(new Set(allKinds).size).toBe(12);

    // 容器自报总数（供 T09 的底栏「已用 N 块」参考）
    expect(container.querySelector('.cbv-blocklib')?.getAttribute('data-block-total')).toBe('12');
    unmount();
  });

  it('每项带正确的拖拽 id 命名空间 blocklib:{kind}', () => {
    const { container, unmount } = mount();
    const dragIds = [...container.querySelectorAll('[data-drag-kind="blocklib"]')].map((el) =>
      el.getAttribute('data-drag-id'),
    );
    expect(dragIds).toEqual(BLOCK_CATALOG.map((entry) => blockLibDragId(entry.kind)));
    expect(dragIds[0]).toBe('blocklib:heading');
    unmount();
  });

  it('分组标题为 5 个中文名', () => {
    const { container, unmount } = mount();
    const titles = [...container.querySelectorAll('.cbv-blocklib__group-name')].map((el) => el.textContent);
    expect(titles).toEqual(['文本', '字段', '媒体', '结构', '元信息']);
    unmount();
  });
});

describe('BlockLibrary · 拖拽载荷 blockLibDragData', () => {
  it('每类载荷的 kind / blockKind / group / defaultBreakInside 与目录一致', () => {
    for (const entry of BLOCK_CATALOG) {
      const data = blockLibDragData(entry);
      expect(data.kind).toBe('blocklib'); // 判据：拖拽来源可被 parseDragId 识别
      expect(data.blockKind).toBe(entry.kind); // ⭐ 载荷含正确 kind（漏 kind → 拖入造不出块）
      expect(data.group).toBe(entry.group);
      expect(data.defaultBreakInside).toBe(entry.defaultBreakInside);
    }
  });

  it('具体结构锁定（标题）与 defaultSize 透传（图片 240px）', () => {
    const heading = BLOCK_CATALOG.find((entry) => entry.kind === 'heading');
    expect(heading).toBeDefined();
    expect(blockLibDragData(heading!)).toEqual({
      kind: 'blocklib',
      blockKind: 'heading',
      group: 'text',
      label: '标题',
      defaultBreakInside: 'avoid',
    });

    const image = BLOCK_CATALOG.find((entry) => entry.kind === 'image');
    expect(blockLibDragData(image!).defaultSize).toEqual({ width: 240 });
  });

  it('defaultSize 是拷贝（改载荷不污染目录常量）', () => {
    const image = BLOCK_CATALOG.find((entry) => entry.kind === 'image');
    const data = blockLibDragData(image!);
    expect(data.defaultSize).not.toBe(image!.defaultSize);
    if (data.defaultSize) data.defaultSize.width = 999;
    expect(image!.defaultSize).toEqual({ width: 240 });
  });
});
