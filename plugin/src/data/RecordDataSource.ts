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
}

export interface RecordDataSource {
  /** 分页取数（结果按视图原生筛选/排序） */
  loadPage(query: LoadPageQuery): Promise<PageResult>;
  /** 单条记录（走记录级缓存） */
  loadRecord(recordId: string): Promise<SdkRecord | null>;
  /** 记录总数（基于视图可见记录） */
  count(): Promise<number>;
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
