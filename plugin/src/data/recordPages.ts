/**
 * 记录分页累积（T10，纯逻辑 —— 便于 12,000 行级别的「逻辑级」验证）。
 *
 * 设计文档 §13.1：增量加载「剩余 < 1 屏触发；100ms 节流」，分页取数复用 M1 的
 * `RecordDataSource`（页级 LRU 缓存 → 重复落点命中缓存零请求）。
 *
 * 本模块**不依赖 React / DOM**，因此可以在 jsdom 下逐条断言：
 *  - 分页触发次数（`PagedRecordController.requestCount`）；
 *  - 记录去重（`appendUniqueRecords` 按 recordId 去重 → 不重复请求也绝不重复渲染）；
 *  - 缓存命中（复用 `RecordCache`）。
 */
import type { SdkRecord } from '@/sdk/port';
import type { RecordCache } from './RecordCache';
import { getRecordId, type PageResult } from './RecordDataSource';

/**
 * 合并两批记录并按 `recordId` 去重（保持既有顺序在前）。
 * 去重可防止「重叠分页 / 缓存回填 / 拖动刷新」导致的重复卡片。
 */
export function appendUniqueRecords(existing: readonly SdkRecord[], incoming: readonly SdkRecord[]): SdkRecord[] {
  const seen = new Set<string>();
  const out: SdkRecord[] = [];
  for (const record of existing) {
    const id = getRecordId(record);
    if (id !== '' && seen.has(id)) continue;
    if (id !== '') seen.add(id);
    out.push(record);
  }
  for (const record of incoming) {
    const id = getRecordId(record);
    if (id !== '' && seen.has(id)) continue;
    if (id !== '') seen.add(id);
    out.push(record);
  }
  return out;
}

/** 取数器：给定游标（首页传 null）返回一页 */
export type PageLoader = (pageToken: string | null) => Promise<PageResult>;

export interface PagedRecordControllerOptions {
  first: PageResult;
  loader: PageLoader;
  /**
   * 页级缓存（可选）。传入时命中缓存返回零请求；不传则每次都走 loader。
   * 与 `SdkRecordDataSource` 内部缓存互补：此处按「本端已请求的游标序列」缓存。
   */
  cache?: RecordCache;
  cacheKeyPrefix?: string;
}

/**
 * 分页累积控制器（纯类）。
 *
 * - 首次以 `first` 初始化；
 * - `loadNext()` 串行执行，**并发调用只会有一个真实请求**（`pending` 抑制）；
 * - 到达末页（`hasMore=false`）后 `loadNext()` 直接返回 0，不再发请求；
 * - `requestCount` 统计**真实**发起的取数次数，供测试断言「分页触发次数 / 不重复请求」。
 */
export class PagedRecordController {
  private records: SdkRecord[];
  private pageToken: string | null;
  private hasMore: boolean;
  private pending = false;
  private requests = 0;
  private readonly loader: PageLoader;
  private readonly cache?: RecordCache;
  private readonly cacheKeyPrefix: string;

  constructor(options: PagedRecordControllerOptions) {
    this.records = [...options.first.records];
    this.pageToken = options.first.pageToken;
    this.hasMore = options.first.hasMore;
    this.loader = options.loader;
    this.cache = options.cache;
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? 'page';
  }

  get list(): readonly SdkRecord[] {
    return this.records;
  }

  get count(): number {
    return this.records.length;
  }

  get canLoadMore(): boolean {
    return this.hasMore && !this.pending;
  }

  get isLoading(): boolean {
    return this.pending;
  }

  /** 真实取数次数（含命中缓存也算一次「请求意图」，不含被 pending 抑制的重复调用） */
  get requestCount(): number {
    return this.requests;
  }

  /**
   * 取下一页。返回本次**新增**记录数（去重后）。
   * - 末页 / 并发中 → 返回 0（且不发请求）；
   * - 命中缓存 → 不发网络请求但计入 `cacheHits`。
   */
  async loadNext(): Promise<number> {
    if (!this.hasMore || this.pending) return 0;
    this.pending = true;
    this.requests += 1;
    try {
      const token = this.pageToken;
      const cacheKey = this.cache ? `${this.cacheKeyPrefix}|${token ?? 'first'}` : '';
      let page: PageResult | undefined;
      if (this.cache && cacheKey !== '') {
        page = this.cache.getPage(cacheKey);
      }
      if (!page) {
        page = await this.loader(token);
        if (this.cache && cacheKey !== '') this.cache.putPage(cacheKey, page);
      }
      const before = this.records.length;
      this.records = appendUniqueRecords(this.records, page.records);
      this.pageToken = page.pageToken;
      this.hasMore = page.hasMore;
      return this.records.length - before;
    } finally {
      this.pending = false;
    }
  }

  /** 重置为新的首页结果（手动刷新时调用） */
  reset(first: PageResult): void {
    this.records = [...first.records];
    this.pageToken = first.pageToken;
    this.hasMore = first.hasMore;
    this.pending = false;
  }
}
