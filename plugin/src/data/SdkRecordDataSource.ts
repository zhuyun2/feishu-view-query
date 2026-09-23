/**
 * `getRecordsByPage` 实现（设计文档 §6.4，D7 对齐原生筛选/排序）。
 *
 * 传 `viewId` 时结果自动遵循该视图的原生筛选与排序（此时 sort/filter 入参失效，故不传）。
 * 页级缓存保证滚动增量加载 / 刷新时命中零请求。
 *
 * 已核对 `@lark-base-open/js-sdk@1.0.2`：
 *  - `SdkTable.getRecordsByPage(params)`，其中 `params.pageToken?: number`；
 *  - `SdkTable.getViewById(id): Promise<SdkView>`（无 `getView`）；
 *  - `SdkView.getVisibleRecordIdList(): Promise<string[]>`。
 * 本层对外使用「不透明字符串游标」，在边界处与 SDK 的数字游标互转。
 */
import type { SdkRecord, SdkTable } from '@/sdk/port';
import { MAX_PAGE_SIZE } from '@/constants';
import { logError } from '@/utils/log';
import { RecordCache } from './RecordCache';
import type { LoadPageQuery, PageResult, RecordDataSource } from './RecordDataSource';

interface RecordsByPageResponse {
  records?: unknown;
  pageToken?: unknown;
  hasMore?: unknown;
  total?: unknown;
}

/**
 * 内部不透明游标（string）→ SDK 数字游标。
 * 容错：空串 / 非数字一律视为「首页」（返回 undefined）。
 */
function toSdkPageToken(token: string | undefined): number | undefined {
  if (token === undefined || token === '') return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

/** SDK 游标（可能是 number）→ 内部不透明游标（string | null；null 表示没有更多） */
function fromSdkPageToken(token: unknown): string | null {
  if (typeof token === 'number' && Number.isFinite(token)) return String(token);
  if (typeof token === 'string' && token !== '') return token;
  return null;
}

export class SdkRecordDataSource implements RecordDataSource {
  private readonly table: SdkTable;
  private readonly viewId: string;
  private readonly cache: RecordCache;

  constructor(table: SdkTable, viewId: string, cache: RecordCache = new RecordCache()) {
    this.table = table;
    this.viewId = viewId;
    this.cache = cache;
  }

  async loadPage(query: LoadPageQuery): Promise<PageResult> {
    const pageSize = Math.min(Math.max(1, query.pageSize), MAX_PAGE_SIZE);
    const key = RecordCache.pageKey(query.viewId, query.pageToken);

    const cached = this.cache.getPage(key);
    if (cached) return cached;

    try {
      const response = (await this.table.getRecordsByPage({
        viewId: query.viewId,
        pageSize,
        pageToken: toSdkPageToken(query.pageToken),
      })) as unknown as RecordsByPageResponse;

      const records = Array.isArray(response.records) ? (response.records as SdkRecord[]) : [];
      const pageToken = fromSdkPageToken(response.pageToken);
      const hasMore = typeof response.hasMore === 'boolean' ? response.hasMore : pageToken !== null;

      const page: PageResult = { records, pageToken, hasMore };
      this.cache.putPage(key, page);
      return page;
    } catch (err) {
      logError('data.loadPage', err, { viewId: query.viewId, tableId: '' });
      throw err;
    }
  }

  async loadRecord(recordId: string): Promise<SdkRecord | null> {
    if (recordId === '') return null;
    const cached = this.cache.getRecord(recordId);
    if (cached) return cached;
    try {
      const record = (await this.table.getRecordById(recordId)) as unknown as SdkRecord | null;
      if (record) this.cache.putRecord(recordId, record);
      return record;
    } catch (err) {
      logError('data.loadRecord', err, { viewId: this.viewId });
      return null;
    }
  }

  async getVisibleRecordIds(): Promise<string[]> {
    try {
      // 已核对 @lark-base-open/js-sdk@1.0.2：SdkTable 提供 getViewById(id)（无 getView）
      const view = await this.table.getViewById(this.viewId);
      const ids = (await view.getVisibleRecordIdList()) as unknown;
      if (!Array.isArray(ids)) return [];
      return ids.filter((id): id is string => typeof id === 'string');
    } catch (err) {
      logError('data.getVisibleRecordIds', err, { viewId: this.viewId });
      return [];
    }
  }

  async count(): Promise<number> {
    const ids = await this.getVisibleRecordIds();
    return ids.length;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** 取缓存的当前 id（供 `resolveViewId` 校验） */
  getViewId(): string {
    return this.viewId;
  }
}
