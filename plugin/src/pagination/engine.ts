/**
 * 分页控制器（设计文档 §21.3.2 / §21.4.2 / §21.4.4）。
 *
 * 编排「测量 → 装箱」，把「有 DOM 的测量」与「无 DOM 的装箱」缝在一起，并保证：
 *  - **可注入**：`measurer` 由外部注入（生产走 `createDomMeasurer()`，测试走 `createStubMeasurer()`）；
 *  - **可缓存**：命中 `HeightCache` 就不再测，键含 `payloadHash`，内容变了必然重测；
 *  - **不崩溃**：任何测量/装箱异常都被兜住，回落估算高度 + `degraded:true`，
 *    最坏情况退化为「单页长文档」（§12），绝不让插件白屏。
 *
 * 分层约束：`pagination/` **不得** import `components/`；本文件亦**不** import `doc/`
 * （`doc/resolve.ts` 由 T03b 并行开发）。engine 只认识「blockId + kind + 切分属性 + payloadHash」，
 * 由上层（M3-T07 的 `usePagedDocument`）负责把 doc 层的区块映射进来。
 */
import type { DocBlockKind } from '@/config/types';
import { logError } from '@/utils/log';
import { createHeightCache, metricsKey, type HeightCache } from './heightCache';
import { packPages } from './pack';
import type {
  BlockMetrics,
  Measurer,
  PackBlock,
  PackOptions,
  PagedDocument,
  PagedItem,
  PagedPage,
} from './types';

/** 大文档保护阈值（§21.4.4）：区块数上限 */
export const LARGE_DOC_BLOCK_LIMIT = 200;
/** 大文档保护阈值（§21.4.4）：页数上限 */
export const LARGE_DOC_PAGE_LIMIT = 50;
/** 单次 `measureBlocks` 的区块数上限：限制一次同步 DOM 读的规模，且单批失败不拖垮全量 */
export const MEASURE_CHUNK_SIZE = 64;

/** 兜底估算高度（px）：测量不可用时按 kind 估一个非零值，避免整块塌陷 */
export const DEFAULT_ESTIMATED_HEIGHT = 32;
export const ESTIMATED_BLOCK_HEIGHT: Readonly<Record<DocBlockKind, number>> = {
  heading: 32,
  paragraph: 24,
  keyValueGrid: 64,
  fieldList: 96,
  badgeRow: 28,
  image: 160,
  table: 120,
  richText: 24,
  divider: 17,
  spacer: 16,
  pageBreak: 0,
  metaFooter: 32,
};

/** 控制器认识的区块（= `PackBlock` + 缓存所需的内容指纹） */
export interface EngineBlock extends PackBlock {
  /** 内容指纹（由 resolve 层产出）：变了必须重测，否则「改了内容高度不变」 */
  payloadHash: string;
}

export interface PaginateInput {
  blocks: ReadonlyArray<EngineBlock>;
  /** = ContentBox.width（缓存键的一部分，换行结果依赖它） */
  contentWidth: number;
  /** = ContentBox.height */
  contentHeight: number;
  /** 已渲染好区块的离屏宿主；缺省且无 `metrics` → 只能估算，标记 degraded */
  host?: HTMLElement | null;
  /** 调用方已测量好的尺寸表（与 blocks 同序等长）；优先于「缓存 → 测量」 */
  metrics?: ReadonlyArray<BlockMetrics> | null;
  /** 字体是否已就绪（默认 true）。false 时**不写缓存**——字体到位后高度会变 */
  fontReady?: boolean;
  options?: Partial<PackOptions>;
}

/** 上一次 `paginate` 的诊断报告：供降级提示与单测断言 */
export interface PaginateReport {
  blockCount: number;
  totalPages: number;
  degraded: boolean;
  fontReady: boolean;
  /** 本次真正调用测量器拿到的条数 */
  measuredCount: number;
  /** 命中高度缓存的条数 */
  cachedCount: number;
  /** 走估算兜底的条数 */
  estimatedCount: number;
  /** 触发的保护/降级策略标识 */
  protections: string[];
  /** 单块超一整页被裁剪的 blockId（§21.4 规则 4） */
  overflowBlockIds: string[];
  /** 失败原因（无则 undefined） */
  failure?: string;
}

export interface PaginationController {
  paginate(input: PaginateInput): PagedDocument;
  invalidate(blockIds?: string[]): void;
  /** 上一次 `paginate` 的诊断报告 */
  lastReport(): PaginateReport | null;
}

export interface PaginationControllerDeps {
  options?: Partial<PackOptions>;
  cache?: HeightCache;
  measurer?: Measurer;
  /** 错误出口（注入以便单测静默），默认 `logError` */
  onError?(scope: string, err: unknown, ctx?: Record<string, unknown>): void;
}

function finiteOr(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function estimateMetrics(block: EngineBlock): BlockMetrics {
  const height = ESTIMATED_BLOCK_HEIGHT[block.kind] ?? DEFAULT_ESTIMATED_HEIGHT;
  // 估算无法凭空造出「原子单元」序列，故不产 units → 装箱按不可切分处理。
  return { blockId: block.blockId, kind: block.kind, outerHeight: height };
}

function toPackBlock(block: EngineBlock): PackBlock {
  const out: PackBlock = {
    blockId: block.blockId,
    kind: block.kind,
    breakInside: block.breakInside,
  };
  if (block.keepWithNext !== undefined) out.keepWithNext = block.keepWithNext;
  return out;
}

interface MeasureOutcome {
  metrics: Map<string, BlockMetrics>;
  /** 失败批次的原因（空 = 全部成功） */
  errors: string[];
}

/**
 * 分块测量：每批 ≤ `MEASURE_CHUNK_SIZE`。
 * 单批抛异常只让**该批**回落估算，不中断其余批次。
 */
function measureMissing(
  measurer: Measurer,
  host: HTMLElement,
  blocks: ReadonlyArray<EngineBlock>,
  indices: readonly number[],
  onError: (scope: string, err: unknown, ctx?: Record<string, unknown>) => void,
): MeasureOutcome {
  const metrics = new Map<string, BlockMetrics>();
  const errors: string[] = [];
  for (let start = 0; start < indices.length; start += MEASURE_CHUNK_SIZE) {
    const chunk = indices.slice(start, start + MEASURE_CHUNK_SIZE);
    const chunkBlocks = chunk.map((i) => ({ blockId: blocks[i].blockId, kind: blocks[i].kind }));
    try {
      const got = measurer.measureBlocks(host, chunkBlocks);
      if (!Array.isArray(got)) continue;
      for (let k = 0; k < chunkBlocks.length; k += 1) {
        const metric = got[k];
        if (metric) metrics.set(chunkBlocks[k].blockId, metric);
      }
    } catch (err) {
      errors.push(describeError(err));
      onError('doc.measure', err, { chunkStart: start, chunkSize: chunk.length });
    }
  }
  return { metrics, errors };
}

/** 兜底产物：全部内容塞进一页的长文档（§12），丢弃分页语义但保证内容不丢 */
function singlePageFallback(
  blocks: ReadonlyArray<EngineBlock>,
  metrics: ReadonlyArray<BlockMetrics>,
): { pages: PagedPage[]; totalPages: number } {
  const items: PagedItem[] = [];
  let usedHeight = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].kind === 'pageBreak') continue;
    const height = Math.max(0, metrics[i] ? metrics[i].outerHeight : 0);
    items.push({
      blockId: blocks[i].blockId,
      fragmentIndex: 0,
      fragmentsTotal: 1,
      height,
    });
    usedHeight += height;
  }
  if (items.length === 0) return { pages: [], totalPages: 0 };
  return { pages: [{ pageIndex: 0, items, usedHeight }], totalPages: 1 };
}

function defaultOnError(scope: string, err: unknown, ctx?: Record<string, unknown>): void {
  logError(scope, err, ctx);
}

export function createPaginationController(
  deps: PaginationControllerDeps = {},
): PaginationController {
  const cache: HeightCache = deps.cache ?? createHeightCache();
  const measurer: Measurer | null = deps.measurer ?? null;
  const onError = deps.onError ?? defaultOnError;
  let report: PaginateReport | null = null;

  function paginate(input: PaginateInput): PagedDocument {
    const blocks: ReadonlyArray<EngineBlock> = Array.isArray(input.blocks) ? input.blocks : [];
    const contentHeight = finiteOr(input.contentHeight, 0);
    const contentWidth = finiteOr(input.contentWidth, 0);
    const fontReady = input.fontReady !== false;

    const metrics: BlockMetrics[] = new Array<BlockMetrics>(blocks.length);
    /** 尚未拿到度量的下标 */
    const missing: number[] = [];
    /** 来自缓存的下标（无需回写） */
    const fromCache = new Set<number>();
    const protections: string[] = [];
    let measuredCount = 0;
    let cachedCount = 0;
    let estimatedCount = 0;
    let degraded = false;
    let failure: string | undefined;

    // ── 阶段 1：取度量。优先级：调用方 metrics > 高度缓存 > 测量器 > 估算兜底 ──
    const provided = input.metrics;
    if (provided && provided.length > 0) {
      for (let i = 0; i < blocks.length; i += 1) {
        const metric = provided[i];
        if (metric) metrics[i] = metric;
        else missing.push(i);
      }
    } else {
      for (let i = 0; i < blocks.length; i += 1) {
        const hit = cache.get(metricsKey(blocks[i].blockId, contentWidth, blocks[i].payloadHash));
        if (hit) {
          metrics[i] = hit;
          cachedCount += 1;
          fromCache.add(i);
        } else {
          missing.push(i);
        }
      }
    }

    const host = input.host ?? null;
    if (missing.length > 0) {
      if (host && measurer) {
        const outcome = measureMissing(measurer, host, blocks, missing, onError);
        for (let i = 0; i < missing.length; i += 1) {
          const idx = missing[i];
          const metric = outcome.metrics.get(blocks[idx].blockId);
          if (metric) {
            metrics[idx] = metric;
            measuredCount += 1;
          }
        }
        if (outcome.errors.length > 0) {
          degraded = true;
          failure = outcome.errors[0];
        }
        if (missing.length > MEASURE_CHUNK_SIZE) protections.push('chunked-measure');
      } else {
        degraded = true;
        failure = 'no-measure-source';
      }

      // 仍缺度量 → 估算兜底（结果不可信，标记 degraded）
      for (let i = 0; i < missing.length; i += 1) {
        const idx = missing[i];
        if (metrics[idx]) continue;
        metrics[idx] = estimateMetrics(blocks[idx]);
        estimatedCount += 1;
      }
      if (estimatedCount > 0) {
        degraded = true;
        if (failure === undefined) failure = 'estimated-height';
      }
    }

    // ── 阶段 2：大文档保护（§21.4.4）—— 只影响「是否写缓存 / 是否分块」，不改变装箱正确性 ──
    let heightSum = 0;
    for (let i = 0; i < metrics.length; i += 1) {
      heightSum += metrics[i] ? Math.max(0, metrics[i].outerHeight) : 0;
    }
    const estimatedPages = contentHeight > 0 ? Math.ceil(heightSum / contentHeight) : 0;
    const isLargeDoc =
      blocks.length > LARGE_DOC_BLOCK_LIMIT || estimatedPages > LARGE_DOC_PAGE_LIMIT;
    if (blocks.length > LARGE_DOC_BLOCK_LIMIT) protections.push('block-limit');
    if (estimatedPages > LARGE_DOC_PAGE_LIMIT) protections.push('page-limit');

    // 回写缓存：字体未就绪（高度会变）或大文档（避免一次冲刷掉常用小文档条目）时不写
    if (fontReady && !isLargeDoc) {
      for (let i = 0; i < blocks.length; i += 1) {
        if (!metrics[i] || fromCache.has(i)) continue;
        cache.set(metricsKey(blocks[i].blockId, contentWidth, blocks[i].payloadHash), metrics[i]);
      }
    }

    // ── 阶段 3：装箱（纯函数）。异常 → 单页长文档降级，绝不向上抛 ──
    const packBlocks: PackBlock[] = blocks.map(toPackBlock);
    let pages: PagedPage[] = [];
    let totalPages = 0;
    let overflowBlockIds: string[] = [];
    try {
      const mergedOptions: Partial<PackOptions> = { ...(deps.options ?? {}), ...(input.options ?? {}) };
      const result = packPages({
        blocks: packBlocks,
        metrics,
        contentHeight,
        options: mergedOptions,
      });
      pages = result.pages;
      totalPages = result.totalPages;
      overflowBlockIds = result.overflowBlockIds;
    } catch (err) {
      degraded = true;
      if (failure === undefined) failure = describeError(err);
      onError('doc.paginate', err, { blockCount: blocks.length, contentHeight });
      const fallback = singlePageFallback(blocks, metrics);
      pages = fallback.pages;
      totalPages = fallback.totalPages;
    }

    report = {
      blockCount: blocks.length,
      totalPages,
      degraded,
      fontReady,
      measuredCount,
      cachedCount,
      estimatedCount,
      protections,
      overflowBlockIds,
      failure,
    };
    return { pages, totalPages, fontReady, degraded };
  }

  return {
    paginate,
    invalidate(blockIds?: string[]): void {
      cache.invalidate(blockIds);
    },
    lastReport(): PaginateReport | null {
      return report;
    },
  };
}
