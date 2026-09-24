/**
 * 关联（`Link` / `DuplexLink`）字段的**只读**读取层（需求 2 · 第一阶段）。
 *
 * 数据流中的位置：
 * ```
 *   当前记录（已在内存，来自 getRecordsByPage）
 *     │  ① 零请求：record.fields[linkFieldId] 就是 SDK 的 IOpenLink，
 *     │            其 recordIds / tableId 直接可用（**关联 id 列表不需要额外请求**）
 *     ▼
 *   ② 单请求兜底：table.getCellValue(fieldId, recordId)（仅当内存记录里没有该字段）
 *     ▼
 *   LinkedRecordRef { recordIds, tableId }
 * ```
 *
 * ⭐ 硬约束（违反即功能性缺陷）：
 *  1. **只读**：本模块**只**调用读接口（`getTableById` / `getCellValue` / `getFieldMetaList` /
 *     `getRecordById`）。**严禁**出现 `setCellValue` / `setRecord(s)` / `addRecord(s)` /
 *     `deleteRecord(s)` / `setField` / `setView` 等写接口 —— 与 `sdk/base.ts` 的 D1 只读基线同源。
 *  2. **永不抛出**：任何异常一律降级为 `{ recordIds: [], tableId: '' }` + **一条**告警
 *     （带 fieldId 与错误文本）。理由：详情渲染绝不能因为一个坏关联字段整体失败。
 *  3. **不误读文本**：只有携带 `recordIds` / （deprecated）`record_ids` 的结构才算「关联引用」；
 *     `{ text: 'A、B' }` 这类**只有文本**的形态**不得**被按分隔符硬拆成 id（拆错 = 用户看到错记录）。
 *  4. **分层**：本文件属 `sdk/` 层，**只** `import type` 引 SDK 类型（编译期擦除），
 *     值导入 `./base` 一律走**动态 `import()`** —— 这样单测静态引用本模块时**不会**加载 SDK
 *     （jsdom 下加载 SDK 会产生未处理 rejection，见 `vitest.config.ts` 注释）。
 */
import type { ITable } from '@lark-opdev/block-bitable-api';
import type { SdkFieldMeta, SdkRecord } from './port';
import { formatError } from '@/utils/errorText';
import { logWarn } from '@/utils/log';

/** 关联引用：被关联记录 id 列表 + 目标表 id */
export interface LinkedRecordRef {
  /** 被关联记录 id（保序、去重、去空）；取不到 → `[]` */
  recordIds: string[];
  /** 目标表 id；取不到 → `''` */
  tableId: string;
}

/** 只读关联读取器（**可注入**；真实实现见 {@link resolveSdkLinkTableSource}） */
export type LinkedRecordsReader = (fieldId: string, recordId: string) => Promise<LinkedRecordRef>;

/** 关联记录的一行原始字段值（供行构造层归一化） */
export interface LinkRowRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

/** 空引用（**每次新建**，避免共享引用被下游改写） */
export function emptyLinkedRecordRef(): LinkedRecordRef {
  return { recordIds: [], tableId: '' };
}

const WARN_SCOPE = 'sdk.linkedRecords';

/** 把候选值收敛为「非空字符串 id 列表」（保序、去重） */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '' && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** 取第一个非空字符串属性 */
function firstNonEmptyString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * 从任意「关联单元格原始值」里抽取 {@link LinkedRecordRef}（**纯函数、永不抛出**）。
 *
 * 兼容形态：
 *  · SDK `IOpenLink`：`{ recordIds, tableId, record_ids?, table_id? }`（后者 deprecated）；
 *  · 关联项数组（异常 / 历史形态）：逐项抽取并**合并去重**；
 *  · 其余（字符串 / 数字 / `null` / 只带 `text` 的对象）→ 空引用（**绝不按分隔符硬拆**）。
 */
export function extractLinkedRecordRef(raw: unknown): LinkedRecordRef {
  if (raw === null || raw === undefined) return emptyLinkedRecordRef();

  if (Array.isArray(raw)) {
    const ids: string[] = [];
    let tableId = '';
    for (const entry of raw) {
      const ref = extractLinkedRecordRef(entry);
      for (const id of ref.recordIds) {
        if (!ids.includes(id)) ids.push(id);
      }
      if (tableId === '' && ref.tableId !== '') tableId = ref.tableId;
    }
    return { recordIds: ids, tableId };
  }

  if (typeof raw !== 'object') return emptyLinkedRecordRef();

  const record = raw as Record<string, unknown>;
  const ids = toIdList(record.recordIds);
  const recordIds = ids.length > 0 ? ids : toIdList(record.record_ids);
  const tableId = firstNonEmptyString(record, ['tableId', 'table_id']);
  return { recordIds, tableId };
}

/* ===================== 读取器（可注入） ===================== */

/** 本地记录字段读取（**不**复用 `data/RecordDataSource`：`sdk/` 层不得 import 上层模块） */
function readRecordFields(record: SdkRecord | null | undefined): Record<string, unknown> {
  if (!record) return {};
  const raw = record as unknown as { fields?: unknown };
  return raw.fields && typeof raw.fields === 'object' ? (raw.fields as Record<string, unknown>) : {};
}

/** 本地记录 id 读取（同上，保持 `sdk/` 层零上层依赖） */
function readRecordId(record: SdkRecord | null | undefined): string {
  if (!record) return '';
  const raw = record as unknown as { recordId?: unknown; id?: unknown };
  if (typeof raw.recordId === 'string') return raw.recordId;
  if (typeof raw.id === 'string') return raw.id;
  return '';
}

export interface LinkedRecordsReaderOptions {
  /**
   * 当前记录（**已在内存**）：字段值命中它即**零请求**返回。
   * 只在「内存记录里确实存在该 fieldId 键」时走内存 —— 键不存在（未随页load下来）才回退单请求。
   */
  record?: SdkRecord | null;
  /** 单请求兜底：SDK `table.getCellValue(fieldId, recordId)` */
  getCellValue?: (fieldId: string, recordId: string) => Promise<unknown>;
  /** 告警出口（缺省 `logWarn`；测试可注入以断言「不静默」） */
  onWarn?: (scope: string, message: string, ctx?: Record<string, unknown>) => void;
}

/**
 * 构造只读关联读取器。
 *
 * 读取顺序：
 *  ① 内存记录命中（`recordId` 等于内存记录 id，或未给 `recordId`）**且**该 fieldId 键存在 → 零请求；
 *  ② 否则用注入的 `getCellValue` 走**一次**请求；
 *  ③ 无可用通道（无 `getCellValue` / 无有效 recordId）→ 空引用（**不**报错，属于正常降级）。
 *
 * 任何异常 → 空引用 + 一条告警（带 fieldId 与错误文本），**永不抛出**。
 */
export function createLinkedRecordsReader(options: LinkedRecordsReaderOptions = {}): LinkedRecordsReader {
  const warn = options.onWarn ?? logWarn;
  const memoryRecord = options.record ?? null;
  const memoryRecordId = readRecordId(memoryRecord);
  const memoryFields = readRecordFields(memoryRecord);
  const getCellValue = options.getCellValue;

  return async (fieldId: string, recordId: string): Promise<LinkedRecordRef> => {
    try {
      if (typeof fieldId !== 'string' || fieldId === '') return emptyLinkedRecordRef();

      // ① 零请求：内存记录里**确实存在**该字段键（存在但为空 = 真的没有关联，不该再打请求）
      const wantsMemory = memoryRecord !== null && (recordId === '' || recordId === memoryRecordId);
      if (wantsMemory && Object.prototype.hasOwnProperty.call(memoryFields, fieldId)) {
        return extractLinkedRecordRef(memoryFields[fieldId]);
      }

      // ② 单请求兜底
      if (typeof getCellValue !== 'function') return emptyLinkedRecordRef();
      const targetRecordId = recordId !== '' ? recordId : memoryRecordId;
      if (targetRecordId === '') return emptyLinkedRecordRef();
      const raw = await getCellValue(fieldId, targetRecordId);
      return extractLinkedRecordRef(raw);
    } catch (err) {
      warn(WARN_SCOPE, '读取关联字段失败（已降级为空引用，不中断渲染）', {
        fieldId,
        recordId,
        error: formatError(err),
      });
      return emptyLinkedRecordRef();
    }
  };
}

/* ===================== 生产实现（SDK 只读访问） ===================== */

/**
 * 关联表格数据源（只读）：读取器 + 目标表字段元数据 + 单行记录。
 *
 * 三者构成「关联字段 → 只读表格」所需的全部读取能力，**全部只读**。
 */
export interface SdkLinkTableSource {
  /** 关联引用读取器（零请求优先 / 单请求兜底） */
  reader: LinkedRecordsReader;
  /** 目标表字段元数据（按 tableId 记忆化，避免同一表重复请求） */
  getTargetFieldMetas(tableId: string): Promise<ReadonlyArray<SdkFieldMeta>>;
  /** 目标表单行记录（取不到 → null，由行构造层降级为占位行） */
  getTargetRow(tableId: string, recordId: string): Promise<LinkRowRecord | null>;
}

/**
 * 用当前表格句柄解析生产数据源。
 *
 * @param tableId 当前表 id（生产 = `env.tableId`）；缺失 → `null`（调用方据此不做预取）
 * @param record  当前内存记录（零请求快路径用；可为 null）
 */
export async function resolveSdkLinkTableSource(
  tableId: string | null,
  record?: SdkRecord | null,
): Promise<SdkLinkTableSource | null> {
  if (typeof tableId !== 'string' || tableId === '') return null;

  // ⚠️ 动态 import：单测注入 stub 时根本不会走到这里，也就不会加载 SDK。
  const { getTable } = await import('./base');

  /** tableId → 表句柄（记忆化；失败不缓存，允许后续重试） */
  const handles = new Map<string, Promise<ITable>>();
  const tableOf = (targetTableId: string): Promise<ITable> => {
    const cached = handles.get(targetTableId);
    if (cached) return cached;
    const task = getTable(targetTableId);
    handles.set(targetTableId, task);
    task.catch(() => handles.delete(targetTableId));
    return task;
  };

  const metaCache = new Map<string, Promise<ReadonlyArray<SdkFieldMeta>>>();

  const reader = createLinkedRecordsReader({
    record: record ?? null,
    getCellValue: async (fieldId, recordId) => {
      const table = await tableOf(tableId);
      return table.getCellValue(fieldId, recordId);
    },
  });

  return {
    reader,

    getTargetFieldMetas(targetTableId: string): Promise<ReadonlyArray<SdkFieldMeta>> {
      const cached = metaCache.get(targetTableId);
      if (cached) return cached;
      const task = (async (): Promise<ReadonlyArray<SdkFieldMeta>> => {
        try {
          const table = await tableOf(targetTableId);
          const metas = await table.getFieldMetaList();
          return Array.isArray(metas) ? metas : [];
        } catch (err) {
          logWarn(WARN_SCOPE, '读取关联表字段元数据失败（该关联不展示表格）', {
            tableId: targetTableId,
            error: formatError(err),
          });
          return [];
        }
      })();
      metaCache.set(targetTableId, task);
      return task;
    },

    async getTargetRow(targetTableId: string, recordId: string): Promise<LinkRowRecord | null> {
      try {
        const table = await tableOf(targetTableId);
        const value = await table.getRecordById(recordId);
        if (!value || typeof value !== 'object') return null;
        const raw = value as unknown as { fields?: unknown };
        const fields =
          raw.fields && typeof raw.fields === 'object' ? (raw.fields as Record<string, unknown>) : {};
        return { recordId, fields };
      } catch (err) {
        // 单行失败 → 该行降级为占位（**绝不**静默丢行）
        logWarn(WARN_SCOPE, '读取关联记录失败（该行降级为占位行）', {
          tableId: targetTableId,
          recordId,
          error: formatError(err),
        });
        return null;
      }
    },
  };
}

export default resolveSdkLinkTableSource;
