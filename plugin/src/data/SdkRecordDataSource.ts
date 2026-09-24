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
import { logError, logWarn } from '@/utils/log';
import { formatError } from '@/utils/errorText';
import { RecordCache } from './RecordCache';
import type { LoadPageQuery, PageResult, RecordDataSource, TotalInfo } from './RecordDataSource';

interface RecordsByPageResponse {
  records?: unknown;
  pageToken?: unknown;
  hasMore?: unknown;
  total?: unknown;
}

/** 有限非负整数收敛；非数字 / NaN / 负数 → undefined（视为「未取到」） */
function toPageTotal(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
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
  /** 最近一次页响应携带的 total（`null` = 尚未取到）；供 count()/countSafe() 复用，免再发请求 */
  private lastPageTotal: number | null = null;

  constructor(table: SdkTable, viewId: string, cache: RecordCache = new RecordCache()) {
    this.table = table;
    this.viewId = viewId;
    this.cache = cache;
  }

  /** 记录页响应携带的 total（缺失时不覆盖既有已知值） */
  private rememberTotal(total: number | undefined): void {
    if (total !== undefined) this.lastPageTotal = total;
  }

  async loadPage(query: LoadPageQuery): Promise<PageResult> {
    const pageSize = Math.min(Math.max(1, query.pageSize), MAX_PAGE_SIZE);
    const key = RecordCache.pageKey(query.viewId, query.pageToken);

    const cached = this.cache.getPage(key);
    if (cached) {
      this.rememberTotal(cached.total);
      return cached;
    }

    try {
      const response = (await this.table.getRecordsByPage({
        viewId: query.viewId,
        pageSize,
        pageToken: toSdkPageToken(query.pageToken),
      })) as unknown as RecordsByPageResponse;

      const records = Array.isArray(response.records) ? (response.records as SdkRecord[]) : [];
      const pageToken = fromSdkPageToken(response.pageToken);
      const hasMore = typeof response.hasMore === 'boolean' ? response.hasMore : pageToken !== null;
      const total = toPageTotal(response.total);

      const page: PageResult = { records, pageToken, hasMore, total };
      this.rememberTotal(total);
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

  /**
   * 取视图可见记录 id 列表；**失败时抛错**（由调用方决定兜底策略）。
   * 已核对 @lark-base-open/js-sdk@1.0.2：SdkTable 提供 getViewById(id)（无 getView）。
   */
  private async fetchVisibleRecordIds(): Promise<string[]> {
    const view = await this.table.getViewById(this.viewId);
    const ids = (await view.getVisibleRecordIdList()) as unknown;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string');
  }

  /**
   * 视图可见记录 id 列表（容错：失败 → `[]`）。
   *
   * ⚠️ 失败与「真的是空表」都会得到 `[]`，故**不可**用它区分「0」与「取不到」；
   * 需要区分时请用 {@link countSafe}。此处失败会打一条 **warn**（别再无声无息）——
   * 真机上正是这条静默失败导致「总数恒为 0」长期不可见。
   */
  async getVisibleRecordIds(): Promise<string[]> {
    try {
      return await this.fetchVisibleRecordIds();
    } catch (err) {
      logWarn('data.getVisibleRecordIds', `getVisibleRecordIdList 失败，返回空列表：${formatError(err)}`, {
        viewId: this.viewId,
      });
      return [];
    }
  }

  /** 记录总数：优先用最近一次页响应的 total；缺失时回退 id 列表长度（失败 → 0） */
  async count(): Promise<number> {
    if (this.lastPageTotal !== null) return this.lastPageTotal;
    const ids = await this.getVisibleRecordIds();
    return ids.length;
  }

  /**
   * 记录总数 + 已知性。
   *
   * - 有页响应 total → `{ total, totalKnown: true }`（最可靠，无需额外请求）；
   * - 否则取 id 列表：成功（含真正的空表）→ `{ total: ids.length, totalKnown: true }`；
   * - id 列表失败 → `{ total: 0, totalKnown: false }` 并打 warn（把「取不到」如实上报，
   *   让文案层退化为「已加载 L 条」而非谎报「共 0 条」）。
   */
  async countSafe(): Promise<TotalInfo> {
    if (this.lastPageTotal !== null) return { total: this.lastPageTotal, totalKnown: true };
    try {
      const ids = await this.fetchVisibleRecordIds();
      return { total: ids.length, totalKnown: true };
    } catch (err) {
      logWarn('data.countSafe', `无法获取视图可见记录总数：${formatError(err)}`, { viewId: this.viewId });
      return { total: 0, totalKnown: false };
    }
  }

  clearCache(): void {
    this.cache.clear();
    // 缓存清空后旧的 total 可能已陈旧（例如视图筛选被改动）→ 一并作废，等下一次页响应回填
    this.lastPageTotal = null;
  }

  /** 取缓存的当前 id（供 `resolveViewId` 校验） */
  getViewId(): string {
    return this.viewId;
  }
}
