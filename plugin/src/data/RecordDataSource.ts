/**
 * 取数抽象（设计文档 §6.4）。
 *
 * ⚠️ 性能红线：**禁止** `table.getRecordList()`（官方标注不再维护、性能差）。
 * 主路径统一为 `table.getRecordsByPage({ viewId, pageSize ≤ 200, pageToken })`；
 * 有序 id 用 `view.getVisibleRecordIdList()`。
 *
 * 接口刻意设计为「页 + 游标」形态，允许 M2 接虚拟滚动增量加载（M1 只取首批 1 页）。
 */
import type { SdkRecord } from '@/sdk/port';

export interface LoadPageQuery {
  /** 传入 viewId 时结果自动遵循该视图的原生筛选与排序（D7） */
  viewId: string;
  /** 页大小，官方上限 200 */
  pageSize: number;
  /** 游标；首页不传 */
  pageToken?: string;
}

export interface PageResult {
  records: SdkRecord[];
  /** 下一页游标；null 表示没有更多 */
  pageToken: string | null;
  hasMore: boolean;
  /**
   * 视图可见记录总数。
   *
   * ⭐ 真源来自 `table.getRecordsByPage({ viewId, ... })` 响应体自带的 `total`
   * （SDK `IGetRecordsByPageResponse`），**无需额外请求**，且天然尊重视图可见范围。
   * 旧实现只用了 records/pageToken/hasMore，丢弃了它 —— 这是「总数恒为 0」的可疑根因。
   * 可能缺失（旧桩 / 异常响应）→ 用 `undefined` 表示「本次未取到」。
   */
  total?: number;
}

/** 总数 + 「是否已知」（区分「真的是 0」与「取不到」） */
export interface TotalInfo {
  /** 总数（`totalKnown === false` 时该值不可信，调用方不得据此断言全量） */
  total: number;
  /** 总数是否可信（true = 来自页响应 total 或成功的 id 列表；false = 取不到） */
  totalKnown: boolean;
}

export interface RecordDataSource {
  /** 分页取数（结果按视图原生筛选/排序） */
  loadPage(query: LoadPageQuery): Promise<PageResult>;
  /** 单条记录（走记录级缓存） */
  loadRecord(recordId: string): Promise<SdkRecord | null>;
  /** 记录总数（基于视图可见记录） */
  count(): Promise<number>;
  /**
   * 记录总数 + 已知性（**可选**：旧实现 / 测试桩可不提供，调用方必须兜底）。
   * 与 `count()` 的区别：能把「取不到（失败/不可得）」与「真的是 0」区分开，
   * 供文案层在分母未知时退化为「已加载 L 条」而非谎报「共 0 条」。
   */
  countSafe?(): Promise<TotalInfo>;
  /** 视图内有序记录 id（`view.getVisibleRecordIdList()`） */
  getVisibleRecordIds(): Promise<string[]>;
  /** 清空缓存（手动刷新时调用） */
  clearCache(): void;
}

/** 单条记录字段值（`SdkRecord.fields` 的宽松映射） */
export type RecordFields = Record<string, unknown>;

/** 从 SdkRecord 取字段值（容错：fields 可能缺失） */
export function getRecordFields(record: SdkRecord | null | undefined): RecordFields {
  if (!record) return {};
  const raw = record as unknown as { fields?: unknown };
  if (raw.fields && typeof raw.fields === 'object') {
    return raw.fields as RecordFields;
  }
  return {};
}

/** 从 SdkRecord 取 recordId */
export function getRecordId(record: SdkRecord | null | undefined): string {
  if (!record) return '';
  const raw = record as unknown as { recordId?: unknown; id?: unknown };
  if (typeof raw.recordId === 'string') return raw.recordId;
  if (typeof raw.id === 'string') return raw.id;
  return '';
}

/**
 * 解析「总数 + 已知性」，供初始化与刷新共用（**唯一来源**，避免两处各写一套）。
 *
 * 优先级：
 * 1. 页响应自带的 `total`（最可靠，零额外请求）→ `totalKnown: true`；
 * 2. `countSafe()`（能把「取不到」与「真的是 0」分开）→ 取其结果；
 * 3. 回退 `count()`（旧实现 / 测试桩可能只实现它）→ `totalKnown: false`
 *    （因为 `count()` 无法区分 0 与取不到，只能保守判为「未知」）。
 *
 * 用 `try/catch` 包裹可选能力调用：桩缺 `countSafe` 时不抛错，平稳回退。
 */
export async function resolveTotalInfo(source: RecordDataSource, page: PageResult): Promise<TotalInfo> {
  if (typeof page.total === 'number' && Number.isFinite(page.total)) {
    return { total: Math.max(0, Math.trunc(page.total)), totalKnown: true };
  }
  if (typeof source.countSafe === 'function') {
    try {
      const info = await source.countSafe();
      if (info && typeof info.total === 'number' && Number.isFinite(info.total)) {
        return { total: Math.max(0, Math.trunc(info.total)), totalKnown: info.totalKnown !== false };
      }
    } catch {
      /* 可选能力失败 → 回退 count()，不抛出 */
    }
  }
  const total = await source.count();
  return { total: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0, totalKnown: false };
}
