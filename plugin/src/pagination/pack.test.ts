/**
 * `pagination/pack.ts` 纯函数单测（设计文档 §17.2 十条用例 + §21.4 规则 1~12 + 边界）。
 *
 * 断言语义（团队铁律 · 拒绝假绿）：每条规则都用**具体数值 / 具体结构**锁定，
 * 把 `packPages` 的实现改坏（例如删掉某个分支）必然变红，绝不用
 * `toBeTruthy` / `length > 0` 这类恒真断言充当规则验证。
 */
import { describe, expect, it } from 'vitest';
import type { DocBlockKind } from '@/config/types';
import { packPages } from './pack';
import {
  DEFAULT_PACK_OPTIONS,
  type BlockMetrics,
  type PackBlock,
  type PackInput,
  type PackResult,
  type PagedItem,
} from './types';

interface BlockSpec {
  id: string;
  /** 默认 'paragraph'（配合 units 的 auto 语义）；显式传 kind 覆盖 */
  kind?: DocBlockKind;
  /** 整块外高 px */
  h: number;
  breakInside?: 'auto' | 'avoid';
  /** 可切分块的原子单元高度序列（传入即隐含 breakInside='auto'） */
  units?: number[];
  /** 表格续页重复表头高度 */
  repeatHeaderHeight?: number;
  keepWithNext?: boolean;
}

/** 由紧凑规格构造 (PackBlock, BlockMetrics) 对 */
function pairOf(spec: BlockSpec): { block: PackBlock; metric: BlockMetrics } {
  const kind = spec.kind ?? 'paragraph';
  const breakInside = spec.breakInside ?? (spec.units ? 'auto' : 'avoid');
  return {
    block: { blockId: spec.id, kind, breakInside, keepWithNext: spec.keepWithNext },
    metric: {
      blockId: spec.id,
      kind,
      outerHeight: spec.h,
      units: spec.units,
      repeatHeaderHeight: spec.repeatHeaderHeight,
    },
  };
}

/** 由紧凑规格构造装箱输入 */
function inputOf(cap: number, specs: BlockSpec[], options?: PackInput['options']): PackInput {
  const pairs = specs.map(pairOf);
  return {
    blocks: pairs.map((p) => p.block),
    metrics: pairs.map((p) => p.metric),
    contentHeight: cap,
    options,
  };
}

/** 取某页的 blockId 顺序 */
function idsOn(result: PackResult, page: number): string[] {
  return result.pages[page].items.map((item) => item.blockId);
}

/** 收集某块在所有页上的片段（按页顺序） */
function fragmentsOf(result: PackResult, blockId: string): PagedItem[] {
  const out: PagedItem[] = [];
  for (const page of result.pages) {
    for (const item of page.items) {
      if (item.blockId === blockId) out.push(item);
    }
  }
  return out;
}

describe('pagination/pack —— 默认选项', () => {
  it('DEFAULT_PACK_OPTIONS 冻结口径：孤行/寡行本期关闭，下限均 1', () => {
    expect(DEFAULT_PACK_OPTIONS).toEqual({
      minUnitsAtBottom: 1,
      minUnitsAtTop: 1,
      enableWidowOrphan: false,
    });
  });
});

describe('pagination/pack —— 规则 1 页容量', () => {
  it('每页 usedHeight = Σ items.height，且除溢出页外均 ≤ contentHeight', () => {
    const result = packPages(
      inputOf(500, [
        { id: 'A', h: 300 },
        { id: 'P', h: 320, units: [80, 80, 80, 80] },
        { id: 'B', h: 200 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages.map((p) => p.usedHeight)).toEqual([460, 360]);
    for (const page of result.pages) {
      const sum = page.items.reduce((acc, item) => acc + item.height, 0);
      expect(page.usedHeight).toBe(sum);
      expect(page.usedHeight).toBeLessThanOrEqual(500);
    }
  });
});

describe('pagination/pack —— 规则 2 恰好填满 / 溢出 1px', () => {
  it('总高 = 内容高 → 单页（用 ≤ 而非 <）', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 600 },
        { id: 'B', h: 400 },
      ]),
    );
    expect(result.totalPages).toBe(1);
    expect(result.pages[0].usedHeight).toBe(1000);
    expect(idsOn(result, 0)).toEqual(['A', 'B']);
  });

  it('总高 = 内容高 + 1 → 换页且无截断（整块下移，不拆块）', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 600 },
        { id: 'B', h: 401 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages.map((p) => p.usedHeight)).toEqual([600, 401]);
    expect(idsOn(result, 0)).toEqual(['A']);
    expect(idsOn(result, 1)).toEqual(['B']);
    expect(result.overflowBlockIds).toEqual([]);
  });
});

describe('pagination/pack —— 规则 3 不可切分块换页', () => {
  it('keyValueGrid 放不下剩余空间 → 整块换页，不拆开', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', kind: 'paragraph', h: 700, breakInside: 'avoid' },
        { id: 'G', kind: 'keyValueGrid', h: 400 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items.map((it) => it.blockId)).toEqual(['A']);
    expect(result.pages[1].items.map((it) => it.blockId)).toEqual(['G']);
    // 不可切分块必须只有 0 段、共 1 段
    expect(result.pages[1].items[0]).toMatchObject({ fragmentIndex: 0, fragmentsTotal: 1 });
    expect(result.overflowBlockIds).toEqual([]);
  });
});

describe('pagination/pack —— 规则 4 超高不可切分块（防死循环核心）', () => {
  it('outerHeight > 一整页 → 独占一页、按容量裁剪、登记 overflowBlockIds', () => {
    const result = packPages(inputOf(1000, [{ id: 'H', kind: 'image', h: 2500 }]));
    // 结构锁定：恰好 1 页、该页恰好 1 个片段
    expect(result.totalPages).toBe(1);
    expect(result.pages[0].items).toHaveLength(1);
    // 数值锁定：片段高度被裁剪到容量，页高 = 容量
    expect(result.pages[0].items[0]).toMatchObject({
      blockId: 'H',
      fragmentIndex: 0,
      fragmentsTotal: 1,
      height: 1000,
    });
    expect(result.pages[0].usedHeight).toBe(1000);
    // 登记锁定
    expect(result.overflowBlockIds).toEqual(['H']);
  });

  it('超高块夹在普通块之间：前后各成页，超高块不被挤压', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 200 },
        { id: 'H', kind: 'spacer', h: 5000 },
        { id: 'B', h: 200 },
      ]),
    );
    expect(result.totalPages).toBe(3);
    expect(idsOn(result, 0)).toEqual(['A']);
    expect(idsOn(result, 1)).toEqual(['H']);
    expect(idsOn(result, 2)).toEqual(['B']);
    expect(result.pages[1].usedHeight).toBe(1000);
    expect(result.overflowBlockIds).toEqual(['H']);
  });
});

describe('pagination/pack —— 规则 5 可切分块按行贪心切分', () => {
  it('长段落 = 3 页 → 切成 3 段，切片无缝无重叠、无丢字', () => {
    const result = packPages(inputOf(100, [{ id: 'P', h: 300, units: [100, 100, 100] }]));
    expect(result.totalPages).toBe(3);
    const frags = fragmentsOf(result, 'P');
    expect(frags).toHaveLength(3);
    expect(frags.map((f) => [f.fragmentIndex, f.fragmentsTotal, f.height, f.slice])).toEqual([
      [0, 3, 100, { from: 0, to: 1 }],
      [1, 3, 100, { from: 1, to: 2 }],
      [2, 3, 100, { from: 2, to: 3 }],
    ]);
    // 切片覆盖完整区间、无空洞/重叠
    expect(frags.map((f) => f.slice?.from)).toEqual([0, 1, 2]);
    expect(frags.map((f) => f.slice?.to)).toEqual([1, 2, 3]);
  });

  it('段落从半页开始 → 首片段只用剩余空间，续片段另起整页', () => {
    const result = packPages(
      inputOf(250, [
        { id: 'A', h: 150 },
        { id: 'P', h: 200, units: [100, 100] },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['A', 150, undefined],
      ['P', 100, { from: 0, to: 1 }],
    ]);
    expect(result.pages[1].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['P', 100, { from: 1, to: 2 }],
    ]);
  });
});

describe('pagination/pack —— 规则 6 表格续页重复表头', () => {
  it('50 行表格按行切分，续页顶部扣减 repeatHeaderHeight', () => {
    const result = packPages(
      inputOf(250, [
        { id: 'T', kind: 'table', h: 500, units: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50], repeatHeaderHeight: 50 },
      ]),
    );
    expect(result.totalPages).toBe(3);
    const frags = fragmentsOf(result, 'T');
    // 首片段不含表头；续片段高度含表头占位（used + 表头）
    expect(frags.map((f) => [f.fragmentIndex, f.fragmentsTotal, f.height, f.slice])).toEqual([
      [0, 3, 250, { from: 0, to: 5 }],
      [1, 3, 250, { from: 5, to: 9 }],
      [2, 3, 100, { from: 9, to: 10 }],
    ]);
    expect(result.pages.map((p) => p.usedHeight)).toEqual([250, 250, 100]);
  });
});

describe('pagination/pack —— 规则 7 孤行/寡行（本期默认关闭）', () => {
  it('默认关闭时等价「每页 ≥1 单元」，与规则 5 结果完全一致', () => {
    const result = packPages(inputOf(100, [{ id: 'P', h: 300, units: [100, 100, 100] }]),);
    expect(result.totalPages).toBe(3);
    expect(fragmentsOf(result, 'P').map((f) => f.slice)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });

  it('启用孤行控制：页底只剩 1 行（< minUnitsAtBottom）→ 整块换页', () => {
    const result = packPages(
      inputOf(
        300,
        [
          { id: 'A', h: 250 },
          { id: 'P', h: 200, units: [40, 40, 40, 40, 40] },
        ],
        { enableWidowOrphan: true, minUnitsAtBottom: 2, minUnitsAtTop: 2 },
      ),
    );
    // 关闭时会是 page0=[A, P片段[0,1)]、page1=[P片段[1,5)]；启用后 P 整块移到第 2 页
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items.map((it) => it.blockId)).toEqual(['A']);
    expect(result.pages[1].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['P', 200, { from: 0, to: 5 }],
    ]);
  });

  it('启用寡行控制：末段只有 1 单元（< minUnitsAtTop）→ 从上一段回补', () => {
    const result = packPages(
      inputOf(300, [{ id: 'P', h: 700, units: [100, 100, 100, 100, 100, 100, 100] }], {
        enableWidowOrphan: true,
        minUnitsAtBottom: 2,
        minUnitsAtTop: 2,
      }),
    );
    expect(result.totalPages).toBe(3);
    // 未回补时末段为 [6,7)（仅 1 单元）；回补后：[0,3) / [3,5) / [5,7)
    expect(fragmentsOf(result, 'P').map((f) => [f.height, f.slice])).toEqual([
      [300, { from: 0, to: 3 }],
      [200, { from: 3, to: 5 }],
      [200, { from: 5, to: 7 }],
    ]);
  });
});

describe('pagination/pack —— 规则 8 标题孤行 keepWithNext', () => {
  it('标题后跟大块且放不下 → 标题随内容一起换页', () => {
    const result = packPages(
      inputOf(300, [
        { id: 'A', h: 230 },
        { id: 'H', kind: 'heading', h: 50, keepWithNext: true },
        { id: 'B', h: 250 },
      ]),
    );
    // 若无 keepWithNext：page0=[A, H]、page1=[B]；有则 H 下移到 page1 与 B 同页
    expect(result.totalPages).toBe(2);
    expect(idsOn(result, 0)).toEqual(['A']);
    expect(idsOn(result, 1)).toEqual(['H', 'B']);
    expect(result.pages[1].usedHeight).toBe(300);
  });

  it('下一块首单元放得下 → 标题保持本页，不回退', () => {
    const result = packPages(
      inputOf(300, [
        { id: 'A', h: 100 },
        { id: 'H', kind: 'heading', h: 50, keepWithNext: true },
        { id: 'B', h: 100 },
      ]),
    );
    expect(result.totalPages).toBe(1);
    expect(idsOn(result, 0)).toEqual(['A', 'H', 'B']);
  });
});

describe('pagination/pack —— 规则 9 pageBreak 语义', () => {
  it('中间 pageBreak：精确断页，前后无空白残留，pageBreak 不产生 item', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 400 },
        { id: 'PB', kind: 'pageBreak', h: 0 },
        { id: 'B', h: 400 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(idsOn(result, 0)).toEqual(['A']);
    expect(idsOn(result, 1)).toEqual(['B']);
    expect(result.pages.every((p) => p.items.every((it) => it.blockId !== 'PB'))).toBe(true);
  });

  it('首部连续 pageBreak 忽略 → 不产生空白首页', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'PB1', kind: 'pageBreak', h: 0 },
        { id: 'PB2', kind: 'pageBreak', h: 0 },
        { id: 'A', h: 400 },
      ]),
    );
    expect(result.totalPages).toBe(1);
    expect(idsOn(result, 0)).toEqual(['A']);
  });

  it('连续多个 pageBreak 折叠为一 → 不产生连续空白页', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 400 },
        { id: 'PB1', kind: 'pageBreak', h: 0 },
        { id: 'PB2', kind: 'pageBreak', h: 0 },
        { id: 'B', h: 400 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(idsOn(result, 0)).toEqual(['A']);
    expect(idsOn(result, 1)).toEqual(['B']);
  });

  it('末尾 pageBreak 忽略 → 不产生尾随空白页', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'A', h: 400 },
        { id: 'PB', kind: 'pageBreak', h: 0 },
      ]),
    );
    expect(result.totalPages).toBe(1);
    expect(idsOn(result, 0)).toEqual(['A']);
  });
});

describe('pagination/pack —— 规则 10 空文档', () => {
  it('blocks 为空 → pages=[]、totalPages=0（渲染层据此出空态，不崩溃）', () => {
    const result = packPages(inputOf(1000, []));
    expect(result.pages).toEqual([]);
    expect(result.totalPages).toBe(0);
    expect(result.overflowBlockIds).toEqual([]);
  });

  it('全为 pageBreak 的文档同样产出 0 页', () => {
    const result = packPages(
      inputOf(1000, [
        { id: 'PB1', kind: 'pageBreak', h: 0 },
        { id: 'PB2', kind: 'pageBreak', h: 0 },
      ]),
    );
    expect(result.totalPages).toBe(0);
  });
});

describe('pagination/pack —— 规则 11 超长文档（纯函数不设硬上限）', () => {
  it('200 块 × 10px / 容量 100 → 恰好 20 页，每页 10 块', () => {
    const specs: BlockSpec[] = Array.from({ length: 200 }, (_, k) => ({ id: `B${k}`, h: 10 }));
    const result = packPages(inputOf(100, specs));
    expect(result.totalPages).toBe(20);
    expect(result.pages).toHaveLength(20);
    expect(result.pages[0].items).toHaveLength(10);
    expect(result.pages[19].items).toHaveLength(10);
    expect(result.pages.every((p) => p.usedHeight === 100)).toBe(true);
  });
});

describe('pagination/pack —— 规则 12 缩放无关 / 确定性', () => {
  it('相同输入两次调用产出深度相等结果（无随机/时间/遍历顺序依赖）', () => {
    const specs: BlockSpec[] = [
      { id: 'A', h: 300 },
      { id: 'P', h: 260, units: [60, 60, 60, 60] },
      { id: 'PB', kind: 'pageBreak', h: 0 },
      { id: 'T', kind: 'table', h: 120, units: [40, 40, 40], repeatHeaderHeight: 20 },
    ];
    const first = packPages(inputOf(400, specs));
    const second = packPages(inputOf(400, specs));
    expect(second).toEqual(first);
  });

  it('分页只由 px 内容盒决定：改变无关外部量不改变结果（结构锁定）', () => {
    const result = packPages(
      inputOf(200, [
        { id: 'A', h: 100 },
        { id: 'P', h: 200, units: [100, 100] },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['A', 100, undefined],
      ['P', 100, { from: 0, to: 1 }],
    ]);
    expect(result.pages[1].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['P', 100, { from: 1, to: 2 }],
    ]);
    expect(result.pages.map((p) => p.usedHeight)).toEqual([200, 100]);
  });
});

describe('pagination/pack —— 不变式 2：每个非 pageBreak 块至少出现一次且片段连续', () => {
  it('混合文档中所有内容块的 fragmentIndex 连续、fragmentsTotal 一致', () => {
    const specs: BlockSpec[] = [
      { id: 'A', kind: 'heading', h: 60 },
      { id: 'P', h: 400, units: [100, 100, 100, 100] },
      { id: 'G', kind: 'keyValueGrid', h: 200 },
      { id: 'PB', kind: 'pageBreak', h: 0 },
      { id: 'T', kind: 'table', h: 180, units: [60, 60, 60], repeatHeaderHeight: 40 },
    ];
    const result = packPages(inputOf(300, specs));
    for (const spec of specs) {
      if (spec.kind === 'pageBreak') continue;
      const frags = fragmentsOf(result, spec.id);
      expect(frags.length).toBeGreaterThanOrEqual(1);
      expect(frags.map((f) => f.fragmentIndex)).toEqual(frags.map((_, k) => k));
      expect(new Set(frags.map((f) => f.fragmentsTotal)).size).toBe(1);
    }
  });
});

describe('pagination/pack —— 进度保证（防死循环）', () => {
  it('单个原子单元本身高于一整页 → 强行放入（页高溢出但必须终止、不丢内容）', () => {
    const result = packPages(inputOf(100, [{ id: 'P', h: 200, units: [150, 50] }]));
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['P', 150, { from: 0, to: 1 }],
    ]);
    expect(result.pages[1].items.map((it) => [it.blockId, it.height, it.slice])).toEqual([
      ['P', 50, { from: 1, to: 2 }],
    ]);
  });

  it('连续多个超高不可切分块 → 各自独占一页，全部登记且终止', () => {
    const result = packPages(
      inputOf(100, [
        { id: 'H1', kind: 'image', h: 300 },
        { id: 'H2', kind: 'image', h: 300 },
      ]),
    );
    expect(result.totalPages).toBe(2);
    expect(idsOn(result, 0)).toEqual(['H1']);
    expect(idsOn(result, 1)).toEqual(['H2']);
    expect(result.overflowBlockIds).toEqual(['H1', 'H2']);
  });
});
