/**
 * 高度缓存（设计文档 §21.3.2 / §21.4.4 / §21.9）。
 *
 * 缓存键 = `metricsKey(blockId, contentWidth, payloadHash)`：
 *  - `blockId`   —— 定位区块；
 *  - `contentWidth` —— 同一区块在不同内容宽度下换行结果不同，宽度变了必须重测；
 *  - `payloadHash`  —— **内容指纹**，内容变了必须失效。
 *    少了它，用户改了区块内容而高度仍命中旧值 —— 这是最难排查的一类 bug。
 *
 * 淘汰策略：**LRU + 条目上限**（默认 `DEFAULT_CACHE_MAX_ENTRIES`）。
 * 万级区块下若无限增长会拖垮内存，故命中时刷新热度、超限时淘汰最久未用者。
 * 另提供 `invalidate(blockIds?)` 按 blockId 精确失效（支持同一 blockId 的多个宽度/版本条目），
 * 不传参则全清。
 */
import type { BlockMetrics } from './types';

/** 默认条目上限：典型文档 20~40 块，2000 条足以覆盖「同记录重复打开 + 编辑态增量重算」 */
export const DEFAULT_CACHE_MAX_ENTRIES = 2000;

export interface HeightCache {
  /** 命中返回值副本（防调用方改写缓存内部对象） */
  get(key: string): BlockMetrics | undefined;
  set(key: string, value: BlockMetrics): void;
  /** 传 blockIds → 精确失效这些区块的全部条目；不传 → 全清 */
  invalidate(blockIds?: string[]): void;
  readonly size: number;
  readonly maxEntries: number;
}

export interface HeightCacheOptions {
  /** 条目上限，<1 视为 1 */
  maxEntries?: number;
}

/**
 * 缓存键：三段式 `blockId|width|payloadHash`。
 * `blockId` 允许含 `|`（不参与解析，仅做去重索引），因此键本身始终唯一。
 */
export function metricsKey(blockId: string, contentWidth: number, payloadHash: string): string {
  const width = Number.isFinite(contentWidth) ? Math.round(contentWidth) : 0;
  return `${blockId}|w${width}|h${payloadHash}`;
}

/** 值副本：避免调用方改写缓存内的 `units` 数组造成串扰 */
function cloneMetrics(value: BlockMetrics): BlockMetrics {
  return {
    blockId: value.blockId,
    kind: value.kind,
    outerHeight: value.outerHeight,
    units: value.units ? value.units.slice() : undefined,
    repeatHeaderHeight: value.repeatHeaderHeight,
  };
}

export function createHeightCache(options: HeightCacheOptions = {}): HeightCache {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES));
  /** 插入顺序即 LRU 顺序：尾部最新，头部最旧 */
  const entries = new Map<string, BlockMetrics>();
  /** key → blockId，供按 blockId 精确失效（避免反解键字符串） */
  const keyToBlockId = new Map<string, string>();
  /** blockId → key 集合 */
  const keysByBlockId = new Map<string, Set<string>>();

  function forget(key: string): void {
    const blockId = keyToBlockId.get(key);
    if (blockId !== undefined) {
      const keys = keysByBlockId.get(blockId);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) keysByBlockId.delete(blockId);
      }
      keyToBlockId.delete(key);
    }
    entries.delete(key);
  }

  function admit(key: string, blockId: string): void {
    const keys = keysByBlockId.get(blockId);
    if (keys) keys.add(key);
    else keysByBlockId.set(blockId, new Set<string>([key]));
    keyToBlockId.set(key, blockId);
  }

  /** 淘汰最久未用者，直到条目数回到上限内 */
  function evictUntilFit(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) return;
      forget(oldest.value);
    }
  }

  return {
    get(key: string): BlockMetrics | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      // LRU：命中后移到尾部
      entries.delete(key);
      entries.set(key, hit);
      return cloneMetrics(hit);
    },
    set(key: string, value: BlockMetrics): void {
      // 覆盖写：先摘掉旧索引再重新登记，保证 LRU 与 blockId 索引一致
      if (entries.has(key)) forget(key);
      entries.set(key, cloneMetrics(value));
      admit(key, value.blockId);
      evictUntilFit();
    },
    invalidate(blockIds?: string[]): void {
      if (!blockIds || blockIds.length === 0) {
        entries.clear();
        keyToBlockId.clear();
        keysByBlockId.clear();
        return;
      }
      for (let i = 0; i < blockIds.length; i += 1) {
        const keys = keysByBlockId.get(blockIds[i]);
        if (!keys) continue;
        // 复制一份再删：forget 会改动原集合
        Array.from(keys).forEach(forget);
      }
    },
    get size(): number {
      return entries.size;
    },
    get maxEntries(): number {
      return maxEntries;
    },
  };
}
