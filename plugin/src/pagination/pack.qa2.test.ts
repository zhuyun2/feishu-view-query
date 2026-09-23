/**
 * `pagination/pack.ts` **独立复核**测试（QA-2 · 双盲复核，与实现方 `pack.test.ts` 无依赖关系）。
 *
 * 立场：本文件的每一条断言都**锁定具体数值 / 具体结构**（页序、每页装了哪些块、每个片段的
 * `fragmentIndex/fragmentsTotal/height/slice`），不使用 `toBeTruthy()` / `length > 0` 这类
 * 恒真断言充当规则验证。若把 `pack.ts` 的对应分支删掉或改坏，这里的断言必须变红。
 *
 * 覆盖：
 *  - §21.4.1 的 12 条装箱规则（逐条独立取证，不复用实现方的输入数据）
 *  - §21.4.1 的 5 条不变式（在随机语料上做性质测试）
 *  - 规则 12 / 不变式 3：确定性（同输入 N 次深比较、属性插入顺序无关、随机语料）
 *  - §21.4.3：页眉页脚不占 ContentBox（编译期证明 `PackInput` 无页眉/页脚/缩放字段）
 *  - 病态输入：0 / 负数 / NaN / Infinity 高度、极小内容盒、数百至千级区块（防崩溃与防死循环）
 *  - 已知缺陷复现：`it.fails` 标记的用例 = 设计期望 ≠ 实际行为，保留为回归探针
 */
import { describe, expect, it } from 'vitest';
import type { BreakInside, DocBlockKind } from '@/config/types';
import { packPages } from './pack';
import type {
  BlockMetrics,
  PackBlock,
  PackInput,
  PackOptions,
  PackResult,
  PagedItem,
} from './types';

/* ────────────────────────────── 夹具构造（独立于实现方 helper） ────────────────────────────── */

interface Spec {
  id: string;
  kind: DocBlockKind;
  /** 整块外高 */
  h: number;
  breakInside?: BreakInside;
  /** 原子单元高度序列（有值即代表该块「可被测量成可切分」） */
  units?: number[];
  /** 表格续页重复表头高度 */
  header?: number;
  kwn?: boolean;
}

function build(specs: readonly Spec[], cap: number, options?: Partial<PackOptions>): PackInput {
  const blocks: PackBlock[] = specs.map((s) => ({
    blockId: s.id,
    kind: s.kind,
    breakInside: s.breakInside ?? (s.units ? 'auto' : 'avoid'),
    keepWithNext: s.kwn === true ? true : undefined,
  }));
  const metrics: BlockMetrics[] = specs.map((s) => ({
    blockId: s.id,
    kind: s.kind,
    outerHeight: s.h,
    units: s.units,
    repeatHeaderHeight: s.header,
  }));
  return { blocks, metrics, contentHeight: cap, options };
}

/** 页 → 片段元组数组：`[blockId, height, slice.from(-1 表示无), slice.to]` */
type Shape = Array<Array<[string, number, number, number]>>;

function shape(result: PackResult): Shape {
  return result.pages.map((p) =>
    p.items.map(
      (it): [string, number, number, number] => [
        it.blockId,
        it.height,
        it.slice?.from ?? -1,
        it.slice?.to ?? -1,
      ],
    ),
  );
}

function used(result: PackResult): number[] {
  return result.pages.map((p) => p.usedHeight);
}

function ids(result: PackResult): string[][] {
  return result.pages.map((p) => p.items.map((it) => it.blockId));
}

function fragsOf(result: PackResult, id: string): PagedItem[] {
  const out: PagedItem[] = [];
  for (const p of result.pages) {
    for (const it of p.items) if (it.blockId === id) out.push(it);
  }
  return out;
}

/** 确定性伪随机（LCG），保证「随机语料」本身可复现 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ────────────────────────────── 规则 1：页容量 = contentHeight ────────────────────────────── */

describe('QA2 · 规则 1 页容量（y 从 0 累加，容量 = contentHeight）', () => {
  it('容量边界：y 累加不得超过 contentHeight，且 usedHeight = Σ item.height', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'heading', h: 250 },
          { id: 'P', kind: 'paragraph', h: 450, units: [90, 90, 90, 90, 90] },
          { id: 'B', kind: 'divider', h: 180 },
        ],
        600,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(used(result)).toEqual([520, 360]);
    expect(shape(result)).toEqual([
      [
        ['A', 250, -1, -1],
        ['P', 270, 0, 3],
      ],
      [
        ['P', 180, 3, 5],
        ['B', 180, -1, -1],
      ],
    ]);
    for (const p of result.pages) {
      expect(p.usedHeight).toBe(p.items.reduce((a, it) => a + it.height, 0));
      expect(p.usedHeight).toBeLessThanOrEqual(600);
    }
  });

  it('容量 = contentHeight（不多不少）：块高恰等于容量时仍单页（≤ 而非 <）', () => {
    const r1 = packPages(build([{ id: 'A', kind: 'image', h: 600 }], 600));
    expect(r1.totalPages).toBe(1);
    expect(used(r1)).toEqual([600]);
    expect(r1.overflowBlockIds).toEqual([]);
  });
});

/* ────────────────────────────── 规则 2：恰好填满 / 溢出 1px ────────────────────────────── */

describe('QA2 · 规则 2 恰好填满 / 溢出 1px', () => {
  it('总高 = 内容高 → 单页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 250, breakInside: 'avoid' },
          { id: 'B', kind: 'paragraph', h: 350, breakInside: 'avoid' },
        ],
        600,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(used(result)).toEqual([600]);
    expect(ids(result)).toEqual([['A', 'B']]);
  });

  it('总高 = 内容高 + 1 → 整块换页（不拆块、不截断、不登记 overflow）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 250, breakInside: 'avoid' },
          { id: 'B', kind: 'paragraph', h: 351, breakInside: 'avoid' },
        ],
        600,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(used(result)).toEqual([250, 351]);
    expect(ids(result)).toEqual([['A'], ['B']]);
    expect(result.overflowBlockIds).toEqual([]);
    expect(result.pages[1].items[0].height).toBe(351); // 未被裁剪
  });
});

/* ────────────────────────────── 规则 3：不可切分块整块换页 ────────────────────────────── */

describe('QA2 · 规则 3 不可切分块（跨页 → 整块换页，不拆）', () => {
  it('breakInside=avoid 放不下剩余空间 → 整块下移，且不产生片段', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 700, breakInside: 'avoid' },
          { id: 'G', kind: 'keyValueGrid', h: 400, breakInside: 'avoid' },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['A', 700, -1, -1]],
      [['G', 400, -1, -1]],
    ]);
    expect(result.pages[1].items[0].fragmentsTotal).toBe(1);
    expect(result.pages[1].items[0].slice).toBeUndefined();
    expect(result.overflowBlockIds).toEqual([]);
  });

  it('kind ∈ 强制原子集合 优先于 units：keyValueGrid 即使带 units 也不切分', () => {
    // cap=100 < outerHeight=120 → 走规则 4（独占一页并登记），证明它没被当成可切分块
    const result = packPages(
      build([{ id: 'G', kind: 'keyValueGrid', h: 120, breakInside: 'auto', units: [60, 60] }], 100),
    );
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['G', 100, -1, -1]]]);
    expect(result.overflowBlockIds).toEqual(['G']);
  });

  it('breakInside=avoid 优先于 units：带 units 的 paragraph 也不切分（只出 1 段、无 slice）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 120, breakInside: 'avoid', units: [60, 60] },
          { id: 'B', kind: 'paragraph', h: 150, breakInside: 'avoid' },
        ],
        250,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['A', 120, -1, -1]],
      [['B', 150, -1, -1]],
    ]);
    expect(fragsOf(result, 'A')).toHaveLength(1);
    expect(fragsOf(result, 'A')[0].slice).toBeUndefined();
  });
});

/* ────────────────────────────── 规则 4：超高不可切分块（防死循环核心） ────────────────────────────── */

describe('QA2 · 规则 4 超高不可切分块：独占一页 + 裁剪 + 登记 overflow（绝不死循环）', () => {
  it('外高 = 内容盒 25 倍 → 恰好 1 页、裁剪到容量、登记 overflow', () => {
    const result = packPages(build([{ id: 'H', kind: 'image', h: 5000 }], 200));
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['H', 200, -1, -1]]]);
    expect(used(result)).toEqual([200]);
    expect(result.pages[0].items[0].fragmentsTotal).toBe(1);
    expect(result.overflowBlockIds).toEqual(['H']);
  });

  it('外高 = Infinity → 不死循环，仍然 1 页、裁剪到容量、登记 overflow', () => {
    const result = packPages(build([{ id: 'H', kind: 'image', h: Number.POSITIVE_INFINITY }], 100));
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['H', 100, -1, -1]]]);
    expect(result.overflowBlockIds).toEqual(['H']);
  });

  it('超高块夹在普通块之间：前后各成页，超高块独占且被裁剪', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 50, breakInside: 'avoid' },
          { id: 'H', kind: 'spacer', h: 5000 },
          { id: 'B', kind: 'paragraph', h: 60, breakInside: 'avoid' },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(3);
    expect(ids(result)).toEqual([['A'], ['H'], ['B']]);
    expect(used(result)).toEqual([50, 200, 60]);
    expect(result.overflowBlockIds).toEqual(['H']);
  });

  it('连续 5 个超高块 → 各自独占一页，全部登记，总页数 = 5（不是无限开页）', () => {
    const specs: Spec[] = Array.from({ length: 5 }, (_, k) => ({
      id: `H${k}`,
      kind: 'image',
      h: 300 + k * 137,
    }));
    const result = packPages(build(specs, 100));
    expect(result.totalPages).toBe(5);
    expect(ids(result)).toEqual([['H0'], ['H1'], ['H2'], ['H3'], ['H4']]);
    expect(used(result)).toEqual([100, 100, 100, 100, 100]);
    expect(result.overflowBlockIds).toEqual(['H0', 'H1', 'H2', 'H3', 'H4']);
  });

  it('超高块位于文档末尾：不产生尾随空白页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 40, breakInside: 'avoid' },
          { id: 'H', kind: 'image', h: 900 },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['A'], ['H']]);
    expect(result.overflowBlockIds).toEqual(['H']);
  });

  it('超高块前后紧贴 pageBreak：仍只占 1 页，不因空 flush 多开页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 40, breakInside: 'avoid' },
          { id: 'PB1', kind: 'pageBreak', h: 0 },
          { id: 'H', kind: 'image', h: 900 },
          { id: 'PB2', kind: 'pageBreak', h: 0 },
          { id: 'B', kind: 'paragraph', h: 30, breakInside: 'avoid' },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(3);
    expect(ids(result)).toEqual([['A'], ['H'], ['B']]);
    expect(result.overflowBlockIds).toEqual(['H']);
  });
});

/* ────────────────────────────── 规则 5：可切分块按 units 贪心切分 ────────────────────────────── */

describe('QA2 · 规则 5 可切分块按原子单元贪心切分', () => {
  it('贪心用 ≤ 而非 <：70+30 恰好填满 → 首片段 2 个单元', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 130, units: [70, 30, 30] }], 100));
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['P', 100, 0, 2]],
      [['P', 30, 2, 3]],
    ]);
  });

  it('每单元都放不进剩余空间 → 逐段换页，切片无缝无重叠', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 180, units: [60, 60, 60] }], 100));
    expect(result.totalPages).toBe(3);
    expect(shape(result)).toEqual([
      [['P', 60, 0, 1]],
      [['P', 60, 1, 2]],
      [['P', 60, 2, 3]],
    ]);
    const frags = fragsOf(result, 'P');
    expect(frags.map((f) => f.fragmentIndex)).toEqual([0, 1, 2]);
    expect(frags.every((f) => f.fragmentsTotal === 3)).toBe(true);
  });

  it('单元恰等于容量 → 每页 1 单元，不合并', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 200, units: [100, 100] }], 100));
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['P', 100, 0, 1]],
      [['P', 100, 1, 2]],
    ]);
  });

  it('进度保证：单单元高于整页 → 强行放入（宁可溢出也绝不丢内容/卡死）', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 200, units: [150, 50] }], 100));
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['P', 150, 0, 1]],
      [['P', 50, 1, 2]],
    ]);
  });

  it('units 为空数组 → 视为不可切分，按 outerHeight 整块放置', () => {
    const result = packPages(
      build([{ id: 'P', kind: 'paragraph', h: 80, breakInside: 'auto', units: [] }], 100),
    );
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['P', 80, -1, -1]]]);
  });
});

/* ────────────────────────────── 规则 6：表格续页重复表头 ────────────────────────────── */

describe('QA2 · 规则 6 表格续页重复表头（续页顶部先扣减 repeatHeaderHeight）', () => {
  it('12 行 × 50 / 表头 40 / cap 300 → 首段 6 行、续段 5 行、末段 1 行', () => {
    const units = Array.from({ length: 12 }, () => 50);
    const result = packPages(
      build([{ id: 'T', kind: 'table', h: 640, units, header: 40 }], 300),
    );
    expect(result.totalPages).toBe(3);
    expect(shape(result)).toEqual([
      [['T', 300, 0, 6]],
      [['T', 290, 6, 11]], // 250 行高 + 40 表头占位
      [['T', 90, 11, 12]], // 末段同属续页，同样要预留 40 表头
    ]);
    expect(used(result)).toEqual([300, 290, 90]);
    expect(fragsOf(result, 'T').map((f) => f.fragmentsTotal)).toEqual([3, 3, 3]);
  });

  it('repeatHeaderHeight 未给（不重复表头）→ 续段不受扣减，页面填满容量', () => {
    const units = Array.from({ length: 12 }, () => 50);
    const result = packPages(build([{ id: 'T', kind: 'table', h: 600, units }], 300));
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['T', 300, 0, 6]],
      [['T', 300, 6, 12]],
    ]);
  });

  it('repeatHeaderHeight = 0 等价于不重复表头', () => {
    const units = Array.from({ length: 12 }, () => 50);
    const result = packPages(build([{ id: 'T', kind: 'table', h: 600, units, header: 0 }], 300));
    expect(shape(result)).toEqual([
      [['T', 300, 0, 6]],
      [['T', 300, 6, 12]],
    ]);
  });
});

/* ────────────────────────────── 规则 7：孤行 / 寡行 ────────────────────────────── */

describe('QA2 · 规则 7 孤行/寡行（默认关闭；开启时的两种修正）', () => {
  it('默认关闭：页底只剩 1 个单元也照放（等价「每页 ≥1 单元」）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 250, breakInside: 'avoid' },
          { id: 'P', kind: 'paragraph', h: 200, units: [40, 40, 40, 40, 40] },
        ],
        300,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [
        ['A', 250, -1, -1],
        ['P', 40, 0, 1],
      ],
      [['P', 160, 1, 5]],
    ]);
  });

  it('开启：页底不足 minUnitsAtBottom → 整块换页（页 0 只留 A）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 250, breakInside: 'avoid' },
          { id: 'P', kind: 'paragraph', h: 200, units: [40, 40, 40, 40, 40] },
        ],
        300,
        { enableWidowOrphan: true, minUnitsAtBottom: 2, minUnitsAtTop: 2 },
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [['A', 250, -1, -1]],
      [['P', 200, 0, 5]],
    ]);
  });

  it('开启：末段寡行（< minUnitsAtTop）→ 从上一段回补单元', () => {
    const units = Array.from({ length: 10 }, () => 60);
    const result = packPages(
      build([{ id: 'P', kind: 'paragraph', h: 600, units }], 200, {
        enableWidowOrphan: true,
        minUnitsAtBottom: 2,
        minUnitsAtTop: 3,
      }),
    );
    expect(result.totalPages).toBe(4);
    expect(shape(result)).toEqual([
      [['P', 180, 0, 3]],
      [['P', 180, 3, 6]],
      [['P', 120, 6, 8]],
      [['P', 120, 8, 10]],
    ]);
  });
});

/* ────────────────────────────── 规则 8：keepWithNext 标题孤行 ────────────────────────────── */

describe('QA2 · 规则 8 keepWithNext 前瞻 1 块', () => {
  it('下一块首单元放不下 → 标题回退并与下一块同页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 120, breakInside: 'avoid' },
          { id: 'H', kind: 'heading', h: 50, kwn: true },
          { id: 'B', kind: 'paragraph', h: 100, breakInside: 'avoid' },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['A'], ['H', 'B']]);
    expect(used(result)).toEqual([120, 150]);
  });

  it('下一块放得下 → 标题留在原页（不误伤）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 20, breakInside: 'avoid' },
          { id: 'H', kind: 'heading', h: 50, kwn: true },
          { id: 'B', kind: 'paragraph', h: 100, breakInside: 'avoid' },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(ids(result)).toEqual([['A', 'H', 'B']]);
    expect(used(result)).toEqual([170]);
  });

  it('keepWithNext 块是最后一块 → 无前瞻，留在原页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 60, breakInside: 'avoid' },
          { id: 'H', kind: 'heading', h: 30, kwn: true },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(ids(result)).toEqual([['A', 'H']]);
  });

  it('下一块是可切分块且首单元放得下 → 标题留原页，段落照常切分', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 100, breakInside: 'avoid' },
          { id: 'H', kind: 'heading', h: 50, kwn: true },
          { id: 'P', kind: 'paragraph', h: 160, units: [40, 40, 40, 40] },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(shape(result)).toEqual([
      [
        ['A', 100, -1, -1],
        ['H', 50, -1, -1],
        ['P', 40, 0, 1],
      ],
      [['P', 120, 1, 4]],
    ]);
  });

  it('前瞻跳过 pageBreak（§21.4 规则 8 明文）→ 标题留在本页，pageBreak 后另起页', () => {
    const result = packPages(
      build(
        [
          { id: 'H', kind: 'heading', h: 30, kwn: true },
          { id: 'PB', kind: 'pageBreak', h: 0 },
          { id: 'B', kind: 'paragraph', h: 80, breakInside: 'avoid' },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['H'], ['B']]);
  });

  it('下一块是超高块 → 标题回退后独占一页，超高块另起一页并登记 overflow', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 100, breakInside: 'avoid' },
          { id: 'H', kind: 'heading', h: 50, kwn: true },
          { id: 'I', kind: 'image', h: 900 },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(3);
    expect(ids(result)).toEqual([['A'], ['H'], ['I']]);
    expect(used(result)).toEqual([100, 50, 200]);
    expect(result.overflowBlockIds).toEqual(['I']);
  });

  it('【观察项 P-1】可切分块上的 keepWithNext 不触发前瞻（与设计伪代码一致，与规则 8 字面不完全一致）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 60, breakInside: 'avoid' },
          { id: 'P', kind: 'paragraph', h: 90, units: [30, 30, 30], kwn: true },
          { id: 'B', kind: 'paragraph', h: 100, breakInside: 'avoid' },
        ],
        100,
      ),
    );
    // 实际：P 切分后末段独占页 1，B 落到页 2 —— keepWithNext 未在可切分分支生效
    expect(result.totalPages).toBe(3);
    expect(ids(result)).toEqual([['A', 'P'], ['P'], ['B']]);
  });
});

/* ────────────────────────────── 规则 9：pageBreak 语义 ────────────────────────────── */

describe('QA2 · 规则 9 pageBreak 语义（永不渲染 / 首部忽略 / 连续折叠 / 末尾忽略）', () => {
  it('中间 pageBreak：精确断页，且不产生任何 item', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 400, breakInside: 'avoid' },
          { id: 'PB', kind: 'pageBreak', h: 0 },
          { id: 'B', kind: 'paragraph', h: 400, breakInside: 'avoid' },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['A'], ['B']]);
    expect(fragsOf(result, 'PB')).toHaveLength(0);
  });

  it('首部连续 pageBreak 忽略 → 无空白首页', () => {
    const result = packPages(
      build(
        [
          { id: 'PB1', kind: 'pageBreak', h: 0 },
          { id: 'PB2', kind: 'pageBreak', h: 0 },
          { id: 'PB3', kind: 'pageBreak', h: 0 },
          { id: 'A', kind: 'paragraph', h: 400, breakInside: 'avoid' },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(ids(result)).toEqual([['A']]);
  });

  it('连续多个 pageBreak 折叠为一 → 无连续空白页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 400, breakInside: 'avoid' },
          { id: 'PB1', kind: 'pageBreak', h: 0 },
          { id: 'PB2', kind: 'pageBreak', h: 0 },
          { id: 'PB3', kind: 'pageBreak', h: 0 },
          { id: 'B', kind: 'paragraph', h: 400, breakInside: 'avoid' },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['A'], ['B']]);
  });

  it('末尾 pageBreak 忽略 → 无尾随空白页', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 400, breakInside: 'avoid' },
          { id: 'PB1', kind: 'pageBreak', h: 0 },
          { id: 'PB2', kind: 'pageBreak', h: 0 },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(ids(result)).toEqual([['A']]);
  });

  it('pageBreak 自身高度不参与容量计算（h=40 也不产生空白或位移）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'paragraph', h: 100, breakInside: 'avoid' },
          { id: 'PB', kind: 'pageBreak', h: 40 },
          { id: 'B', kind: 'paragraph', h: 100, breakInside: 'avoid' },
        ],
        200,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(used(result)).toEqual([100, 100]);
  });
});

/* ────────────────────────────── 规则 10：空文档 ────────────────────────────── */

describe('QA2 · 规则 10 空文档', () => {
  it('blocks 为空 → pages=[]、totalPages=0、overflow=[]（不崩溃）', () => {
    const result = packPages(build([], 1000));
    expect(result.pages).toEqual([]);
    expect(result.totalPages).toBe(0);
    expect(result.overflowBlockIds).toEqual([]);
  });

  it('全为 pageBreak → 同样 0 页', () => {
    const result = packPages(
      build(
        [
          { id: 'PB1', kind: 'pageBreak', h: 0 },
          { id: 'PB2', kind: 'pageBreak', h: 0 },
        ],
        1000,
      ),
    );
    expect(result.totalPages).toBe(0);
    expect(result.overflowBlockIds).toEqual([]);
  });

  it('metrics 缺失（长度 0）→ 容错为高度 0 的原子块，全部落在 1 页', () => {
    const blocks: PackBlock[] = [
      { blockId: 'A', kind: 'paragraph', breakInside: 'avoid' },
      { blockId: 'B', kind: 'heading', breakInside: 'avoid' },
    ];
    const result = packPages({ blocks, metrics: [], contentHeight: 100 });
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([
      [
        ['A', 0, -1, -1],
        ['B', 0, -1, -1],
      ],
    ]);
    expect(used(result)).toEqual([0]);
  });
});

/* ────────────────────────────── 规则 11：超长文档（无硬上限） ────────────────────────────── */

describe('QA2 · 规则 11 超长文档：不崩溃、不超时、页数可预期', () => {
  it('500 块 × 10px / cap 100 → 恰好 50 页，每页 10 块、页高 100', () => {
    const specs: Spec[] = Array.from({ length: 500 }, (_, k) => ({
      id: `B${k}`,
      kind: 'paragraph',
      h: 10,
      breakInside: 'avoid',
    }));
    const t0 = Date.now();
    const result = packPages(build(specs, 100));
    const cost = Date.now() - t0;
    expect(result.totalPages).toBe(50);
    expect(result.pages.every((p) => p.items.length === 10)).toBe(true);
    expect(used(result).every((u) => u === 100)).toBe(true);
    expect(cost).toBeLessThan(5000);
  });

  it('1000 个原子单元 / cap 100 → 100 页，切片完整覆盖 [0,1000)', () => {
    const units = Array.from({ length: 1000 }, () => 10);
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 10000, units }], 100));
    expect(result.totalPages).toBe(100);
    const frags = fragsOf(result, 'P');
    expect(frags).toHaveLength(100);
    expect(frags[0].slice).toEqual({ from: 0, to: 10 });
    expect(frags[99].slice).toEqual({ from: 990, to: 1000 });
    expect(frags.every((f) => f.fragmentsTotal === 100)).toBe(true);
  });

  it('混合 400 块（含 pageBreak / 超高块 / 表格）→ 终止且不变式成立', () => {
    const specs: Spec[] = [];
    for (let k = 0; k < 400; k += 1) {
      if (k % 40 === 39) specs.push({ id: `PB${k}`, kind: 'pageBreak', h: 0 });
      else if (k % 25 === 0) specs.push({ id: `H${k}`, kind: 'image', h: 700 });
      else if (k % 5 === 0)
        specs.push({ id: `T${k}`, kind: 'table', h: 120, units: [30, 30, 30, 30], header: 30 });
      else specs.push({ id: `A${k}`, kind: 'paragraph', h: 40, breakInside: 'avoid' });
    }
    const result = packPages(build(specs, 300));
    expect(result.totalPages).toBeGreaterThan(0);
    expect(result.totalPages).toBe(result.pages.length);
    expect(result.pages.every((p) => p.items.length >= 1)).toBe(true);
    for (const p of result.pages) {
      expect(p.usedHeight).toBe(p.items.reduce((a, it) => a + it.height, 0));
    }
  });
});

/* ────────────────────────────── 规则 12 / §21.4.3：缩放无关 + 页眉页脚不占 ContentBox ────────────────────────────── */

describe('QA2 · 规则 12 与 §21.4.3：分页只依赖 px 内容盒，与缩放/页眉页脚无关', () => {
  it('PackInput 编译期不含 zoom 字段（分页与缩放解耦）', () => {
    // @ts-expect-error 规则 12：zoom 不得进入 packPages 的输入（缩放只改 transform: scale）
    const bad: PackInput = { blocks: [], metrics: [], contentHeight: 100, zoom: 1.25 };
    expect(bad.contentHeight).toBe(100);
  });

  it('PackInput 编译期不含页眉/页脚高度字段（§21.4.3 页眉页脚不占 ContentBox）', () => {
    // @ts-expect-error §21.4.3：页眉/页脚落在页边距带内，不参与容量计算
    const bad: PackInput = { blocks: [], metrics: [], contentHeight: 100, headerHeight: 40 };
    expect(bad.contentHeight).toBe(100);
  });

  it('改 options 中的无关项不影响装箱；容量严格 = contentHeight', () => {
    const a = packPages(build([{ id: 'A', kind: 'image', h: 1000 }], 1000));
    const b = packPages(build([{ id: 'A', kind: 'image', h: 1000 }], 1000, { minUnitsAtTop: 5 }));
    expect(b).toEqual(a);
    expect(a.totalPages).toBe(1);
    expect(a.overflowBlockIds).toEqual([]); // 恰好等于容量 → 不算溢出
  });
});

/* ────────────────────────────── 不变式 3：确定性 ────────────────────────────── */

describe('QA2 · 不变式 3 确定性（无随机 / 无时间 / 不依赖对象遍历顺序）', () => {
  it('相同输入重复 8 次 → 结构深度相等', () => {
    const input = build(
      [
        { id: 'A', kind: 'heading', h: 90 },
        { id: 'P', kind: 'paragraph', h: 260, units: [70, 70, 70, 70] },
        { id: 'PB', kind: 'pageBreak', h: 0 },
        { id: 'T', kind: 'table', h: 180, units: [60, 60, 60], header: 20 },
        { id: 'H', kind: 'image', h: 900 },
      ],
      400,
    );
    const first = packPages(input);
    for (let k = 0; k < 8; k += 1) {
      expect(packPages(input)).toEqual(first);
    }
  });

  it('对象属性插入顺序不同 → 结果深度相等（不依赖 key 遍历顺序）', () => {
    const forward: PackBlock[] = [
      { blockId: 'A', kind: 'heading', breakInside: 'avoid', keepWithNext: true },
      { blockId: 'B', kind: 'paragraph', breakInside: 'auto' },
    ];
    const reversed: PackBlock[] = [
      { keepWithNext: true, breakInside: 'avoid', kind: 'heading', blockId: 'A' },
      { breakInside: 'auto', kind: 'paragraph', blockId: 'B' },
    ];
    const metrics: BlockMetrics[] = [
      { blockId: 'A', kind: 'heading', outerHeight: 50 },
      { blockId: 'B', kind: 'paragraph', outerHeight: 120, units: [60, 60] },
    ];
    const a = packPages({ blocks: forward, metrics, contentHeight: 150 });
    const b = packPages({ blocks: reversed, metrics, contentHeight: 150 });
    expect(b).toEqual(a);
  });

  it('50 组伪随机语料 × 每组跑 5 次 → 输出完全一致', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const rnd = lcg(seed * 7919);
      const cap = 200 + Math.floor(rnd() * 600);
      const specs = randomSpecs(rnd, cap, false);
      const input = build(specs, cap);
      const base = packPages(input);
      for (let k = 0; k < 4; k += 1) {
        expect(packPages(input)).toEqual(base);
      }
    }
  });
});

/* ────────────────────────────── 不变式 1/2/5：随机语料性质测试 ────────────────────────────── */

describe('QA2 · 不变式 1/2/5 性质测试（随机语料）', () => {
  it('语料族 A（无超高块）：50 组随机输入全部满足 5 条不变式且 usedHeight ≤ cap', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const rnd = lcg(seed * 104729);
      const cap = 200 + Math.floor(rnd() * 600);
      const specs = randomSpecs(rnd, cap, false);
      const result = packPages(build(specs, cap));
      checkInvariants(result, cap, specs);
      expect(result.pages.every((p) => p.usedHeight <= cap)).toBe(true);
      expect(result.overflowBlockIds).toEqual([]);
    }
  });

  it('语料族 B（含超高不可切分块）：超高块必被登记且独占一页，其余页仍 ≤ cap', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const rnd = lcg(seed * 15485863);
      const cap = 200 + Math.floor(rnd() * 600);
      const specs = randomSpecs(rnd, cap, true);
      const result = packPages(build(specs, cap));
      checkInvariants(result, cap, specs);
      expect(result.pages.every((p) => p.usedHeight <= cap)).toBe(true);

      const oversized = specs.filter(
        (s) => s.kind !== 'pageBreak' && !isSplittableByContract(s) && s.h > cap,
      );
      for (const s of oversized) {
        expect(result.overflowBlockIds).toContain(s.id);
        const frags = fragsOf(result, s.id);
        expect(frags).toHaveLength(1);
        const page = result.pages.find((p) => p.items.some((it) => it.blockId === s.id));
        expect(page).toBeDefined();
        expect(page?.items).toHaveLength(1);
        expect(page?.usedHeight).toBe(cap);
      }
    }
  });
});

/* ────────────────────────────── 病态 / 边界输入 ────────────────────────────── */

describe('QA2 · 病态输入：必须终止、不抛异常、行为明确', () => {
  it('contentHeight = 0 + 正高块 → 登记 overflow，1 页，裁剪到 0', () => {
    const result = packPages(build([{ id: 'A', kind: 'image', h: 10 }], 0));
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['A', 0, -1, -1]]]);
    expect(result.overflowBlockIds).toEqual(['A']);
  });

  it('contentHeight = 0 + 高度 0 的块 → 1 页、页高 0、不算溢出', () => {
    const result = packPages(build([{ id: 'A', kind: 'image', h: 0 }], 0));
    expect(result.totalPages).toBe(1);
    expect(used(result)).toEqual([0]);
    expect(result.overflowBlockIds).toEqual([]);
  });

  it('contentHeight = 0 + 全 0 单元的可切分块 → 单页单段，不空转', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 0, units: [0, 0, 0] }], 0));
    expect(result.totalPages).toBe(1);
    expect(shape(result)).toEqual([[['P', 0, 0, 3]]]);
  });

  it('contentHeight 为负 → 不抛异常、不死循环，超高块仍登记 overflow', () => {
    const result = packPages(build([{ id: 'A', kind: 'image', h: 50 }], -100));
    expect(result.totalPages).toBe(1);
    expect(result.overflowBlockIds).toEqual(['A']);
    expect(result.pages[0].items[0].height).toBe(-100); // 裁剪到「容量」= -100（病态但确定）
  });

  it('outerHeight = NaN → 不抛异常、不死循环（整份文档落 1 页）', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'image', h: Number.NaN },
          { id: 'B', kind: 'image', h: 10 },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(1);
    expect(ids(result)).toEqual([['A', 'B']]);
    expect(Number.isNaN(result.pages[0].usedHeight)).toBe(true);
  });

  it('units 含 NaN → 不丢单元、不死循环（NaN 单元被强行独占一段）', () => {
    const result = packPages(build([{ id: 'P', kind: 'paragraph', h: 200, units: [Number.NaN, 10] }], 100));
    expect(result.totalPages).toBe(2);
    expect(shape(result)[0][0][0]).toBe('P');
    expect(Number.isNaN(result.pages[0].items[0].height)).toBe(true);
    expect(result.pages[1].items[0].height).toBe(10);
    expect(fragsOf(result, 'P').map((f) => f.slice)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ]);
  });

  it('units 含 Infinity → 不丢单元、不死循环', () => {
    const result = packPages(
      build([{ id: 'P', kind: 'paragraph', h: 200, units: [Number.POSITIVE_INFINITY, 10] }], 100),
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].items[0].height).toBe(Number.POSITIVE_INFINITY);
    expect(result.pages[1].items[0].height).toBe(10);
  });

  it('内容盒小于任何区块（cap=10，块高 100）→ 逐段强行推进，不死循环', () => {
    const result = packPages(
      build(
        [
          { id: 'A', kind: 'image', h: 100 },
          { id: 'P', kind: 'paragraph', h: 100, units: [50, 50] },
        ],
        10,
      ),
    );
    expect(result.totalPages).toBe(3);
    expect(shape(result)).toEqual([
      [['A', 10, -1, -1]],
      [['P', 50, 0, 1]],
      [['P', 50, 1, 2]],
    ]);
    expect(result.overflowBlockIds).toEqual(['A']);
  });

  it('重复 blockId → 正常装箱（不因 id 冲突丢块）', () => {
    const result = packPages(
      build(
        [
          { id: 'X', kind: 'image', h: 80 },
          { id: 'X', kind: 'image', h: 80 },
        ],
        100,
      ),
    );
    expect(result.totalPages).toBe(2);
    expect(ids(result)).toEqual([['X'], ['X']]);
    expect(fragsOf(result, 'X')).toHaveLength(2);
  });
});

/* ────────────────────────────── 已知缺陷复现（it.fails = 设计期望 ≠ 当前行为） ────────────────────────────── */

describe('QA2 · 已知缺陷复现探针（当前必然失败；修复后本组会自动转红提示更新）', () => {
  it.fails(
    '【缺陷 D-1】单原子单元高于整页的可切分块：应登记 overflowBlockIds 且 usedHeight ≤ cap（不变式 1）',
    () => {
      const result = packPages(build([{ id: 'T', kind: 'table', h: 500, units: [500] }], 100));
      // 实际：totalPages=1、usedHeight=500 > cap=100、overflowBlockIds=[]
      expect(result.overflowBlockIds).toEqual(['T']);
      expect(result.pages.every((p) => p.usedHeight <= 100)).toBe(true);
    },
  );

  it.fails(
    '【缺陷 D-2】repeatHeaderHeight 挤压续页：续页 usedHeight 超 cap 且未登记 overflow（不变式 1）',
    () => {
      const result = packPages(
        build([{ id: 'T', kind: 'table', h: 140, units: [70, 70], header: 40 }], 100),
      );
      // 实际：page0=70、page1=70+40=110 > cap=100、overflowBlockIds=[]
      expect(result.pages.every((p) => p.usedHeight <= 100)).toBe(true);
      expect(result.overflowBlockIds).toEqual(['T']);
    },
  );
});

/* ────────────────────────────── 辅助：随机语料与不变式校验 ────────────────────────────── */

/** 契约上的「可切分」判定（与 pack.ts 的 isSplittable 同口径，独立重写用于生成合法语料） */
const ATOMIC_KINDS: ReadonlySet<DocBlockKind> = new Set<DocBlockKind>([
  'heading',
  'keyValueGrid',
  'image',
  'divider',
  'spacer',
  'metaFooter',
]);

function isSplittableByContract(s: Spec): boolean {
  const bi: BreakInside = s.breakInside ?? (s.units ? 'auto' : 'avoid');
  if (bi !== 'auto') return false;
  if (ATOMIC_KINDS.has(s.kind)) return false;
  return Array.isArray(s.units) && s.units.length > 0;
}

function randomSpecs(rnd: () => number, cap: number, allowOversized: boolean): Spec[] {
  const n = 3 + Math.floor(rnd() * 22);
  const specs: Spec[] = [];
  for (let k = 0; k < n; k += 1) {
    const roll = rnd();
    if (roll < 0.08) {
      specs.push({ id: `PB${k}`, kind: 'pageBreak', h: 0 });
      continue;
    }
    if (roll < 0.4) {
      // 可切分块：单元高度 ≤ cap/4，保证不会触发「强行放 1 个」
      const unit = 10 + Math.floor((rnd() * cap) / 4);
      const count = 1 + Math.floor(rnd() * 8);
      const units = Array.from({ length: count }, () => unit);
      const header = rnd() < 0.5 ? Math.floor(cap / 8) : 0;
      specs.push({
        id: `S${k}`,
        kind: 'table',
        h: unit * count,
        units,
        header,
      });
      continue;
    }
    if (roll < 0.6) {
      // 可切分段落
      const unit = 10 + Math.floor((rnd() * cap) / 4);
      const count = 1 + Math.floor(rnd() * 6);
      specs.push({
        id: `P${k}`,
        kind: 'paragraph',
        h: unit * count,
        units: Array.from({ length: count }, () => unit),
      });
      continue;
    }
    // 不可切分块
    const kind: DocBlockKind = rnd() < 0.5 ? 'image' : 'keyValueGrid';
    const h =
      allowOversized && rnd() < 0.35
        ? cap * (2 + Math.floor(rnd() * 3))
        : 10 + Math.floor(rnd() * (cap / 2));
    specs.push({ id: `A${k}`, kind, h, kwn: rnd() < 0.2 });
  }
  return specs;
}

function checkInvariants(result: PackResult, cap: number, specs: readonly Spec[]): void {
  // 不变式 3/5 + 结构一致性
  expect(result.totalPages).toBe(result.pages.length);
  result.pages.forEach((p, i) => expect(p.pageIndex).toBe(i));
  for (const p of result.pages) {
    expect(p.items.length).toBeGreaterThanOrEqual(1); // 不变式 5
    const sum = p.items.reduce((a, it) => a + it.height, 0);
    expect(p.usedHeight).toBe(sum); // 不变式 1（前半）
  }
  // 不变式 2：每块至少出现一次、片段连续、fragmentsTotal 一致
  for (const s of specs) {
    const frags = fragsOf(result, s.id);
    if (s.kind === 'pageBreak') {
      expect(frags).toHaveLength(0);
      continue;
    }
    expect(frags.length).toBeGreaterThanOrEqual(1);
    expect(frags.map((f) => f.fragmentIndex)).toEqual(frags.map((_, k) => k));
    expect(new Set(frags.map((f) => f.fragmentsTotal)).size).toBe(1);
    expect(frags[0].fragmentIndex).toBe(0);
    // 切片连续覆盖 [0, units.length)
    if (frags.length > 1 || frags[0].slice !== undefined) {
      const totalUnits = s.units?.length ?? 0;
      expect(frags[0].slice?.from).toBe(0);
      expect(frags[frags.length - 1].slice?.to).toBe(totalUnits);
      for (let k = 1; k < frags.length; k += 1) {
        expect(frags[k].slice?.from).toBe(frags[k - 1].slice?.to);
      }
    }
  }
  // 文档为空时不得产页
  if (specs.every((s) => s.kind === 'pageBreak')) {
    expect(result.totalPages).toBe(0);
  }
  expect(cap).toBeGreaterThan(0);
}
