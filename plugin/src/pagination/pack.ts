/**
 * 确定性装箱纯函数 `packPages()`（设计文档 §21.4.1）。
 *
 * 本模块是分页领域的**最高风险点**，被刻意设计为纯函数，以便在 `vitest`（无真实浏览器布局）
 * 下 100% 覆盖。硬约束：
 *  - 不引用 `document` / `window` / `React` / 任何 SDK —— 必须能在 Node 下裸跑；
 *  - 相同输入 → 完全相同输出（无随机、无时间、无 DOM、不依赖对象遍历顺序）；
 *  - 装箱循环有明确终止条件：每轮至少消费 1 个原子单元或推进 1 个块，杜绝死循环。
 */
import type { DocBlockKind } from '@/config/types';
import {
  DEFAULT_PACK_OPTIONS,
  type BlockMetrics,
  type PackBlock,
  type PackInput,
  type PackOptions,
  type PackResult,
  type PagedItem,
  type PagedPage,
} from './types';

/** 无论 `breakInside` 为何，恒按「不可切分」处理的区块种类（§21.4 规则 3） */
const FORCE_ATOMIC_KINDS: ReadonlySet<DocBlockKind> = new Set<DocBlockKind>([
  'heading',
  'keyValueGrid',
  'image',
  'divider',
  'spacer',
  'metaFooter',
]);

/** 可切分区块的一个片段切片（`used` 为单元高度之和，不含续页表头占位） */
interface Slice {
  from: number;
  to: number;
  used: number;
}

/** 判定区块是否可切分（§21.4 规则 3/5）：仅 `auto` + `units` 非空 + 非强制原子类 */
function isSplittable(block: PackBlock, metric: BlockMetrics): boolean {
  if (block.breakInside !== 'auto') return false;
  if (FORCE_ATOMIC_KINDS.has(block.kind)) return false;
  return Array.isArray(metric.units) && metric.units.length > 0;
}

/** 取「首个原子单元」高度：可切分取 `units[0]`，否则取整块外高（§21.4 规则 8 前瞻用） */
function firstUnitHeight(block: PackBlock, metric: BlockMetrics): number {
  if (isSplittable(block, metric)) {
    const units = metric.units as number[];
    return units[0];
  }
  return metric.outerHeight;
}

/** 尺寸表取行：`metrics` 与 `blocks` 同序等长；容错缺失行（视为高度 0 的原子块） */
function metricAt(metrics: ReadonlyArray<BlockMetrics>, index: number, block: PackBlock): BlockMetrics {
  const metric = metrics[index];
  if (metric) return metric;
  return { blockId: block.blockId, kind: block.kind, outerHeight: 0 };
}

/** 累加 `units` 在 `[from, to)` 区间内的单元高度 */
function sumUnits(units: readonly number[], from: number, to: number): number {
  let sum = 0;
  for (let k = from; k < to; k += 1) sum += units[k];
  return sum;
}

/**
 * 将 `units` 贪心切成若干片段：首片段用 `firstRoom`，其余片段用 `contRoom`（§21.4 规则 5/6）。
 * 终止性：每轮迭代 `u` 严格递增（至少消费 1 个单元）→ 必然收敛。
 * 进度保证：连 1 个单元都放不进时**强行放入 1 个**（宁可溢出，绝不丢内容或卡死）。
 */
function splitUnits(units: readonly number[], firstRoom: number, contRoom: number): Slice[] {
  const slices: Slice[] = [];
  let u = 0;
  let isFirst = true;
  while (u < units.length) {
    const room = isFirst ? firstRoom : contRoom;
    const from = u;
    let used = 0;
    while (u < units.length && used + units[u] <= room) {
      used += units[u];
      u += 1;
    }
    if (u === from) {
      used = units[u];
      u += 1;
    }
    slices.push({ from, to: u, used });
    isFirst = false;
  }
  return slices;
}

/** 统计 `room` 空间内最多能放进多少个「从 `units[0]` 开始」的连续单元（孤行控制前瞻用） */
function countUnitsThatFit(units: readonly number[], room: number): number {
  let count = 0;
  let used = 0;
  while (count < units.length && used + units[count] <= room) {
    used += units[count];
    count += 1;
  }
  return count;
}

/** 孤行/寡行后处理（§21.4 规则 7，仅当 `enableWidowOrphan`）：修正末段「寡行」 */
function rebalanceWidow(
  units: readonly number[],
  slices: readonly Slice[],
  minTop: number,
  minBottom: number,
): Slice[] {
  if (slices.length < 2) return slices.map((slice) => ({ ...slice }));
  const out = slices.map((slice) => ({ ...slice }));
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  const lastCount = last.to - last.from;
  if (lastCount >= minTop) return out;
  const prevCount = prev.to - prev.from;
  const spare = prevCount - Math.max(1, minBottom);
  const move = Math.min(minTop - lastCount, spare, prevCount - 1);
  if (move <= 0) return out;
  prev.to -= move;
  prev.used = sumUnits(units, prev.from, prev.to);
  last.from -= move;
  last.used = sumUnits(units, last.from, last.to);
  return out;
}

/**
 * ⭐ 分页纯函数：输入「区块序列 + 尺寸表 + 内容盒高度」，输出「页列表」。
 * 语义全部由 §21.4 的 12 条规则定义；确定性、无副作用。
 */
export function packPages(input: PackInput): PackResult {
  const options: PackOptions = { ...DEFAULT_PACK_OPTIONS, ...input.options };
  const minBottom = Math.max(1, Math.floor(options.minUnitsAtBottom));
  const minTop = Math.max(1, Math.floor(options.minUnitsAtTop));
  const widowOrphan = options.enableWidowOrphan === true;

  const cap = input.contentHeight;
  const blocks = input.blocks;
  const metrics = input.metrics;
  const pages: PagedPage[] = [];
  const overflowBlockIds: string[] = [];

  let items: PagedItem[] = [];
  let y = 0;

  /** 规则 9（③/④）：仅当本页有内容才产出，天然忽略首部/连续/末尾 pageBreak 造成的空页 */
  function flush(): void {
    if (items.length > 0) {
      pages.push({ pageIndex: pages.length, items, usedHeight: y });
      items = [];
      y = 0;
    }
  }

  /** 当前页剩余容量 */
  function capacityLeft(): number {
    return cap - y;
  }

  /** 返回 `[start, blocks.length)` 内第一个非 pageBreak 块的索引；无则 -1 */
  function nextContentIndex(start: number): number {
    for (let k = start; k < blocks.length; k += 1) {
      if (blocks[k].kind !== 'pageBreak') return k;
    }
    return -1;
  }

  /** 规则 8：`keepWithNext` 前瞻 1 块（跳过 pageBreak）——放不下则标题随内容换页 */
  function applyKeepWithNext(block: PackBlock, height: number, index: number): void {
    const nextIndex = nextContentIndex(index + 1);
    if (nextIndex === -1) return;
    const nextBlock = blocks[nextIndex];
    const nextMetric = metricAt(metrics, nextIndex, nextBlock);
    const need = firstUnitHeight(nextBlock, nextMetric);
    if (need <= capacityLeft()) return;
    items.pop();
    y -= height;
    if (items.length > 0) flush();
    items.push({ blockId: block.blockId, fragmentIndex: 0, fragmentsTotal: 1, height });
    y += height;
  }

  /** 规则 3/4：不可切分块的整块放置 */
  function placeAtomic(block: PackBlock, metric: BlockMetrics, index: number): void {
    const height = metric.outerHeight;
    if (height > cap) {
      // 规则 4：连一整页都放不下 → 独占一页、按容量裁剪、登记 overflow，确保进度。
      flush();
      items.push({ blockId: block.blockId, fragmentIndex: 0, fragmentsTotal: 1, height: cap });
      y = cap;
      overflowBlockIds.push(block.blockId);
      flush();
      return;
    }
    if (height > capacityLeft()) flush(); // 规则 3：整块换页（不拆）
    items.push({ blockId: block.blockId, fragmentIndex: 0, fragmentsTotal: 1, height });
    y += height;
    if (block.keepWithNext === true) applyKeepWithNext(block, height, index);
  }

  /** 规则 5/6/7：可切分块按 `units` 贪心切片并按页摆放 */
  function placeSplittable(block: PackBlock, metric: BlockMetrics): void {
    const units = metric.units as number[];
    const header = metric.repeatHeaderHeight ?? 0;

    // 是否先换页：① 首单元放不进当前剩余空间；②（启用孤行控制）首片段单元数 < minUnitsAtBottom → 整块换页
    if (items.length > 0) {
      let needFlush = units[0] > capacityLeft();
      if (!needFlush && widowOrphan) {
        const fit = countUnitsThatFit(units, capacityLeft());
        if (fit > 0 && fit < units.length && fit < minBottom) needFlush = true;
      }
      if (needFlush) flush();
    }

    const firstRoom = capacityLeft();
    const contRoom = cap - header;
    let slices = splitUnits(units, firstRoom, contRoom);
    if (widowOrphan) slices = rebalanceWidow(units, slices, minTop, minBottom);

    const total = slices.length;
    for (let s = 0; s < total; s += 1) {
      const slice = slices[s];
      const headerReserve = s > 0 ? header : 0; // 规则 6：续页顶部先扣减重复表头
      if (s > 0) flush(); // 续片段总是另起一页
      const item: PagedItem = {
        blockId: block.blockId,
        fragmentIndex: s,
        fragmentsTotal: total,
        height: slice.used + headerReserve,
        slice: { from: slice.from, to: slice.to },
      };
      items.push(item);
      y += item.height;
    }
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    // 规则 9：pageBreak 永不渲染；语义 = 在此处强制结束当前页。
    // 首部连续（①）/ 连续多个（②）/ 末尾（③）均被 flush 的「空页不产出」自然吸收。
    if (block.kind === 'pageBreak') {
      flush();
      continue;
    }

    const metric = metricAt(metrics, i, block);
    if (isSplittable(block, metric)) {
      placeSplittable(block, metric);
    } else {
      placeAtomic(block, metric, i);
    }
  }

  flush(); // 规则 10：空输入 → pages = []
  return { pages, totalPages: pages.length, overflowBlockIds };
}
