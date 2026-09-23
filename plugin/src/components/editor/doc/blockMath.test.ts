/**
 * `blockMath` 纯逻辑单测（M3-T08 / 设计文档 §21.8 T08 完成标准）。
 *
 * 判据（团队禁令：禁止假绿断言）——**「把实现改坏，这条断言会变成红吗？」**
 * 每条断言都锁定**具体返回值 / 结构**（禁止 `toBeTruthy()`）；
 * 关键用例含「变异验证」注释，说明破坏哪一处会让它变红（见交付报告）。
 *
 * id 说明：`defaultBlockFor(kind, [], { makeId })` 用注入的确定性工厂产出 blockId；
 * 各用例独立 `createBlockIdFactory()`（seed 0），故 id 稳定为 `blk_{kind}_{1,2,3…}`。
 */
import { describe, expect, it } from 'vitest';
import type { DocBlock, DocTemplate } from '@/config/types';
import { createBlockIdFactory, defaultBlockFor } from '@/doc/blockDefaults';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import {
  appendBlock,
  blockCountOf,
  blockIds,
  clampInsertIndex,
  findBlock,
  hasBlock,
  insertBlock,
  insertIndexFromSlot,
  isNoopMove,
  moveBlock,
  moveIndexFromSlot,
  removeBlock,
  slotIndexes,
  updateBlock,
} from './blockMath';

/** 用确定性 id 工厂造模板（id 形如 `blk_heading_1`，可精确断言） */
function docTemplate(kinds: DocBlock['kind'][]): DocTemplate {
  const ids = createBlockIdFactory();
  return {
    templateId: 'test',
    pageSetup: defaultPageSetup(),
    theme: defaultDocTheme(),
    blocks: kinds.map((kind) => defaultBlockFor(kind, [], { makeId: ids.next })),
  };
}

/** 造一个独立的新块（每次调用递增 id，如 `blk_spacer_1`） */
function freshBlocks(seed = 0): (kind: DocBlock['kind']) => DocBlock {
  const ids = createBlockIdFactory(seed);
  return (kind) => defaultBlockFor(kind, [], { makeId: ids.next });
}

describe('blockMath · 只读视图（blockCountOf / blockIds / findBlock / hasBlock）', () => {
  it('blockCountOf / blockIds 保序', () => {
    const template = docTemplate(['heading', 'divider', 'metaFooter']);
    expect(blockCountOf(template)).toBe(3);
    expect(blockIds(template)).toEqual(['blk_heading_1', 'blk_divider_2', 'blk_meta_3']);
  });

  it('findBlock 命中返回块与索引；未命中返回 null', () => {
    const template = docTemplate(['heading', 'divider', 'metaFooter']);
    const found = findBlock(template, 'blk_divider_2');
    expect(found?.index).toBe(1);
    expect(found?.block.kind).toBe('divider');
    expect(findBlock(template, 'nope')).toBeNull();
    expect(hasBlock(template, 'blk_meta_3')).toBe(true);
    expect(hasBlock(template, 'nope')).toBe(false);
  });
});

describe('blockMath · clampInsertIndex（越界钳制的唯一判据）', () => {
  it('负数 → 0；越界 → length；非有限 → length；小数向下取整', () => {
    expect(clampInsertIndex(-5, 3)).toBe(0);
    expect(clampInsertIndex(99, 3)).toBe(3);
    expect(clampInsertIndex(Number.NaN, 3)).toBe(3);
    expect(clampInsertIndex(Number.POSITIVE_INFINITY, 3)).toBe(3);
    expect(clampInsertIndex(2.9, 3)).toBe(2);
    expect(clampInsertIndex(1, 3)).toBe(1);
    expect(clampInsertIndex(3, 3)).toBe(3);
  });
});

describe('blockMath · slotIndexes（N 个区块 → N+1 个槽）', () => {
  it('0 个区块 → [0]（仍有一个空槽）；3 个区块 → [0,1,2,3]', () => {
    expect(slotIndexes(0)).toEqual([0]);
    expect(slotIndexes(3)).toEqual([0, 1, 2, 3]);
    // 变异验证：把 `for (i <= count)` 改成 `i < count`（槽位少一个）→ 此断言立刻变红
    expect(slotIndexes(3).length).toBe(4);
  });
});

describe('blockMath · insertBlock / appendBlock（且不修改入参）', () => {
  it('插入到头部 / 中部 / 末尾，索引与顺序精确', () => {
    const template = docTemplate(['heading', 'divider']); // [heading_1, divider_2]
    const make = freshBlocks();

    expect(blockIds(insertBlock(template, make('spacer'), 0))).toEqual([
      'blk_spacer_1',
      'blk_heading_1',
      'blk_divider_2',
    ]);
    expect(blockIds(insertBlock(template, make('spacer'), 1))).toEqual([
      'blk_heading_1',
      'blk_spacer_2',
      'blk_divider_2',
    ]);
    expect(blockIds(insertBlock(template, make('spacer'), 2))).toEqual([
      'blk_heading_1',
      'blk_divider_2',
      'blk_spacer_3',
    ]);
  });

  it('越界索引：<0 → 头部；>n / 非有限 → 末尾（追加）', () => {
    const template = docTemplate(['heading', 'divider']);
    const make = freshBlocks();
    expect(blockIds(insertBlock(template, make('spacer'), -9))).toEqual([
      'blk_spacer_1',
      'blk_heading_1',
      'blk_divider_2',
    ]);
    expect(blockIds(insertBlock(template, make('spacer'), 99))).toEqual([
      'blk_heading_1',
      'blk_divider_2',
      'blk_spacer_2',
    ]);
    expect(blockIds(insertBlock(template, make('spacer'), Number.NaN))).toEqual([
      'blk_heading_1',
      'blk_divider_2',
      'blk_spacer_3',
    ]);
  });

  it('appendBlock 追加到末尾；入参 template 不被修改', () => {
    const template = docTemplate(['heading']);
    const make = freshBlocks();
    const next = appendBlock(template, make('divider'));
    expect(blockIds(next)).toEqual(['blk_heading_1', 'blk_divider_1']);
    expect(next).not.toBe(template);
    expect(blockIds(template)).toEqual(['blk_heading_1']); // 入参不变
  });
});

describe('blockMath · removeBlock', () => {
  it('删除中间块；不存在时原样返回（同一引用）', () => {
    const template = docTemplate(['heading', 'divider', 'metaFooter']);
    expect(blockIds(removeBlock(template, 'blk_divider_2'))).toEqual(['blk_heading_1', 'blk_meta_3']);
    expect(removeBlock(template, 'nope')).toBe(template);
    expect(blockIds(template)).toEqual(['blk_heading_1', 'blk_divider_2', 'blk_meta_3']); // 入参不变
  });
});

describe('blockMath · moveBlock（toIndex 基于「移除后」列表坐标）', () => {
  it('向后移动 / 向前移动 / 移到底部', () => {
    const template = docTemplate(['heading', 'divider', 'spacer', 'metaFooter']); // [h_1, d_2, s_3, m_4]

    // d_2 移到「移除后」列表 [h,s,m] 的索引 2
    expect(blockIds(moveBlock(template, 'blk_divider_2', 2))).toEqual([
      'blk_heading_1',
      'blk_spacer_3',
      'blk_divider_2',
      'blk_meta_4',
    ]);
    // m_4 移到头部
    expect(blockIds(moveBlock(template, 'blk_meta_4', 0))).toEqual([
      'blk_meta_4',
      'blk_heading_1',
      'blk_divider_2',
      'blk_spacer_3',
    ]);
    // h_1 移到底部（移除后列表 [d,s,m]，索引 3 = 末尾）
    expect(blockIds(moveBlock(template, 'blk_heading_1', 3))).toEqual([
      'blk_divider_2',
      'blk_spacer_3',
      'blk_meta_4',
      'blk_heading_1',
    ]);
  });

  it('越界索引钳到末尾；不存在时原样返回；入参不变', () => {
    const template = docTemplate(['heading', 'divider', 'spacer']);
    expect(blockIds(moveBlock(template, 'blk_heading_1', 99))).toEqual([
      'blk_divider_2',
      'blk_spacer_3',
      'blk_heading_1',
    ]);
    expect(moveBlock(template, 'nope', 0)).toBe(template);
    expect(blockIds(template)).toEqual(['blk_heading_1', 'blk_divider_2', 'blk_spacer_3']);
  });

  it('单块模板：移动到索引 0 保持原样且不抛错', () => {
    const template = docTemplate(['heading']);
    expect(blockIds(moveBlock(template, 'blk_heading_1', 0))).toEqual(['blk_heading_1']);
  });
});

describe('blockMath · updateBlock（浅合并 patch）', () => {
  it('合并 patch；不命中时原样返回；入参不变', () => {
    const template = docTemplate(['heading', 'divider']);
    const next = updateBlock(template, 'blk_divider_2', { thickness: 3, borderStyle: 'dashed' });

    expect(findBlock(next, 'blk_divider_2')?.block).toMatchObject({
      kind: 'divider',
      thickness: 3,
      borderStyle: 'dashed',
    });
    // 其他块未被顺手改写
    expect(findBlock(next, 'blk_heading_1')?.block).toMatchObject({ kind: 'heading', level: 1 });
    // 未命中 → 同一引用
    expect(updateBlock(template, 'nope', { thickness: 9 })).toBe(template);
    // 入参不变
    expect(findBlock(template, 'blk_divider_2')?.block).toMatchObject({ thickness: 1, borderStyle: 'solid' });
  });
});

describe('blockMath · 落点解析（insertIndexFromSlot / moveIndexFromSlot / isNoopMove）', () => {
  it('insertIndexFromSlot 即（钳制后的）槽位序号', () => {
    expect(insertIndexFromSlot(0, 3)).toBe(0);
    expect(insertIndexFromSlot(2, 3)).toBe(2);
    expect(insertIndexFromSlot(3, 3)).toBe(3); // 末尾槽 → 追加
    expect(insertIndexFromSlot(8, 3)).toBe(3); // 越界 → 追加
  });

  it('moveIndexFromSlot：落在自身之后的偏移修正（「拖错一格」的高发点）', () => {
    const template = docTemplate(['heading', 'divider', 'spacer', 'metaFooter']); // d_2 在 index 1

    expect(moveIndexFromSlot(template, 'blk_divider_2', 0)).toBe(0); // 拖到最前
    expect(moveIndexFromSlot(template, 'blk_divider_2', 1)).toBe(1); // 原位
    expect(moveIndexFromSlot(template, 'blk_divider_2', 2)).toBe(1); // 原位之后 → 目标不变
    expect(moveIndexFromSlot(template, 'blk_divider_2', 3)).toBe(2); // 后移一格
    expect(moveIndexFromSlot(template, 'blk_divider_2', 4)).toBe(3); // 末尾槽
    // 变异验证：把 `raw > found.index ? raw - 1 : raw` 的 `-1` 去掉 → 上两条变红（2→3 / 3→4）
  });

  it('moveIndexFromSlot + moveBlock 组合后顺序正确（端到端）', () => {
    const template = docTemplate(['heading', 'divider', 'spacer', 'metaFooter']);
    const target = moveIndexFromSlot(template, 'blk_divider_2', 4);
    expect(target).toBe(3);
    expect(blockIds(moveBlock(template, 'blk_divider_2', target))).toEqual([
      'blk_heading_1',
      'blk_spacer_3',
      'blk_meta_4',
      'blk_divider_2',
    ]);
  });

  it('moveIndexFromSlot：块不存在 / 空模板 → -1', () => {
    const template = docTemplate(['heading']);
    expect(moveIndexFromSlot(template, 'nope', 0)).toBe(-1);
    const empty: DocTemplate = { ...template, blocks: [] };
    expect(moveIndexFromSlot(empty, 'blk_heading_1', 0)).toBe(-1);
  });

  it('isNoopMove：落点在原位或原位之后的第一格 → 空操作', () => {
    const template = docTemplate(['heading', 'divider', 'spacer']); // d_2 在 index 1
    expect(isNoopMove(template, 'blk_divider_2', 1)).toBe(true);
    expect(isNoopMove(template, 'blk_divider_2', 2)).toBe(true);
    expect(isNoopMove(template, 'blk_divider_2', 0)).toBe(false);
    expect(isNoopMove(template, 'blk_divider_2', 3)).toBe(false);
    expect(isNoopMove(template, 'nope', 0)).toBe(false);
  });
});
