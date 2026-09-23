/**
 * 确定性 stub 测量器（设计文档 §21.3.2 / §21.9）。
 *
 * 存在的唯一理由：**让分页能在没有真实布局引擎的环境（vitest + jsdom）下被验证**。
 * jsdom 没有布局引擎，`offsetHeight` 恒为 0；若测试走真实测量，所有区块高度都是 0，
 * 分页会退化成「全部塞进第一页」，测试依然"绿"却验证的是错场景 —— 这是被明令禁止的假象。
 *
 * 因此本实现：
 *  - **完全不触碰 DOM**（`host` 参数被显式忽略），高度只来自注入的尺寸表；
 *  - **惰性查表**：测量时刻才读 `table`，便于测试中改表模拟「内容变了」；
 *  - 记录每次 `measureBlocks` 收到的 blockId 序列，供「是否真的重新测量」的断言。
 */
import type { BlockMetrics, Measurer } from './types';

/** 表中未登记区块的兜底高度：刻意非 0，避免退化成「全塞第一页」的假绿 */
export const STUB_DEFAULT_OUTER_HEIGHT = 40;

export interface StubMeasurer extends Measurer {
  /** 每次 `measureBlocks` 调用收到的 blockId 序列（按调用顺序） */
  readonly calls: ReadonlyArray<ReadonlyArray<string>>;
  readonly callCount: number;
}

/**
 * @param table     blockId → 尺寸（可只给部分字段，缺失字段走 fallback / 默认值）
 * @param fallback  所有区块共用的兜底尺寸
 */
export function createStubMeasurer(
  table: Record<string, Partial<BlockMetrics>> = {},
  fallback: Partial<BlockMetrics> = {},
): StubMeasurer {
  const calls: string[][] = [];

  const measureBlocks: Measurer['measureBlocks'] = (host, blocks) => {
    // host 被刻意忽略：stub 与 DOM 零耦合。
    void host;
    calls.push(blocks.map((block) => block.blockId));
    return blocks.map((block): BlockMetrics => {
      const own = table[block.blockId];
      return {
        blockId: block.blockId,
        kind: own?.kind ?? fallback.kind ?? block.kind,
        outerHeight: own?.outerHeight ?? fallback.outerHeight ?? STUB_DEFAULT_OUTER_HEIGHT,
        units: own?.units ?? fallback.units,
        repeatHeaderHeight: own?.repeatHeaderHeight ?? fallback.repeatHeaderHeight,
      };
    });
  };

  return {
    measureBlocks,
    get callCount(): number {
      return calls.length;
    },
    get calls(): ReadonlyArray<ReadonlyArray<string>> {
      return calls.map((call) => call.slice());
    },
  };
}
