/**
 * 页级 + 记录级 LRU 缓存（设计文档 §6.4 / §13.1）。
 * 仅存内存，不落地数据副本（PRD 安全边界）。
 */
import type { IRecord } from '@lark-base-open/js-sdk';
import type { PageResult } from './RecordDataSource';

/** 页缓存条目（含游标信息，避免命中缓存后无法续页） */
export interface CachedPage extends PageResult {}

/** 泛型 LRU（Map 保序：最早插入的在头部，命中/写入时移到尾部） */
export class LruCache<K, V> {
  private readonly capacity: number;
  private readonly map = new Map<K, V>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // 命中后移到尾部（最近使用）
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export interface RecordCacheStats {
  pageCount: number;
  recordCount: number;
}

export class RecordCache {
  private readonly pageCache: LruCache<string, CachedPage>;
  private readonly recordCache: LruCache<string, IRecord>;

  constructor(pageCapacity = 32, recordCapacity = 2000) {
    this.pageCache = new LruCache<string, CachedPage>(pageCapacity);
    this.recordCache = new LruCache<string, IRecord>(recordCapacity);
  }

  /** 页 key = `${viewId}|${pageToken ?? 'first'}` */
  static pageKey(viewId: string, pageToken?: string): string {
    return `${viewId}|${pageToken ?? 'first'}`;
  }

  getPage(key: string): CachedPage | undefined {
    return this.pageCache.get(key);
  }

  putPage(key: string, page: CachedPage): void {
    this.pageCache.set(key, page);
    // 同步落记录级缓存，便于单条详情零请求打开
    for (const record of page.records) {
      const id = (record as unknown as { recordId?: string }).recordId;
      if (typeof id === 'string' && id !== '') this.recordCache.set(id, record);
    }
  }

  getRecord(recordId: string): IRecord | undefined {
    return this.recordCache.get(recordId);
  }

  putRecord(recordId: string, record: IRecord): void {
    this.recordCache.set(recordId, record);
  }

  clear(): void {
    this.pageCache.clear();
    this.recordCache.clear();
  }

  stats(): RecordCacheStats {
    return { pageCount: this.pageCache.size, recordCount: this.recordCache.size };
  }
}
