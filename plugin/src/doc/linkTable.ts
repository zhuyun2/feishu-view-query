/**
 * 关联字段 → **只读表格**的行构造与预取编排（需求 2 · 第一阶段）。
 *
 * 数据流中的位置：
 * ```
 *   LinkedRecordRef { recordIds, tableId }   ← sdk/linkedRecords（零请求优先）
 *     │  + 目标表字段元数据（getFieldMetaList）        ┐
 *     │  + 目标表行记录（getRecordById × N，信号量限流） ┘ 【本模块】prefetchLinkTables
 *     ▼
 *   Map<linkFieldId, LinkTable>              ← 纯数据，作为**纯输入**注入 resolveBlocks
 *     ▼
 *   ResolvedBlock.linkTables / ResolvedTablePayload ──→ components/doc/blocks（只读表格）
 * ```
 *
 * ⭐ 四条硬约束（违反即功能性缺陷）：
 *  1. **纯函数 `buildLinkTable`**：同输入恒同输出；不读时间 / 随机 / 全局可变状态。
 *  2. **绝不把 recordId 写进展示文本**（`normalize.ts` 铁律 / US-5 AC1）：`recordId` 只在
 *     结构里保留（供 React key），**不得**进入 `text` / `display` / DOM 属性。
 *  3. **默认列规则**：目标表「**主字段 + 前 3 个可用字段**」（可用 = 有真实渲染器、
 *     不是 FallbackRenderer）。不可用类型**跳过**（否则单元格会显示「该字段类型暂不支持」）。
 *  4. **行上限**：默认 **20** 行；溢出不静默丢弃 —— 记入 `truncated`，由渲染层以「+N」告知。
 *     单行读取失败 → **保留占位行**（空单元格），**绝不**静默丢行。
 */
import type { DocBlock } from '@/config/types';
import type { FieldMetaLite, FieldTypeValue, NormalizedValue } from '@/fields/fieldTypes';
import { FieldType, toFieldMetaLite } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { FallbackRenderer, getRenderer } from '@/fields/registry';
import type { LinkedRecordRef, LinkedRecordsReader, LinkRowRecord } from '@/sdk/linkedRecords';
import type { SdkRecord } from '@/sdk/port';
import { formatError } from '@/utils/errorText';
import { logWarn } from '@/utils/log';
import { Semaphore } from '@/utils/semaphore';

/**
 * 关联记录行原始值（**转出**：`buildLinkTable` 的入参 & `LinkTablePrefetchAccess.getTargetRow`
 * 的返回值都用到它，调用方/测试无需再直接依赖 `@/sdk/linkedRecords`）。
 */
export type { LinkRowRecord, LinkedRecordRef, LinkedRecordsReader };

/* ===================== 常量（默认值集中定义，§21.9） ===================== */

/** 关联表格默认展示的最大行数（溢出 → `truncated` → 渲染「+N」） */
export const DEFAULT_LINK_TABLE_ROWS = 20;

/** 目标表默认额外展示的列数（**不含**主字段）= 前 3 个可用字段 */
export const DEFAULT_LINK_TABLE_EXTRA_COLUMNS = 3;

/** 预取并发上限（与 `buildData.DEFAULT_CONCURRENCY` 同口径） */
export const LINK_TABLE_CONCURRENCY = 6;

/** 单次预取最多处理的关联字段数（防止模板里挂一堆关联字段把请求打爆） */
export const MAX_LINK_FIELDS_PER_PREFETCH = 4;

/** 关联字段类型（`Link` / `DuplexLink`） */
const LINK_FIELD_TYPES: readonly FieldTypeValue[] = [FieldType.Link, FieldType.DuplexLink];

/* ===================== 类型 ===================== */

/** 关联表格的一列（= 目标表的一个字段） */
export interface LinkColumn {
  /** 目标表字段 id */
  fieldId: string;
  /** 列标题（= 目标表字段中文名） */
  label: string;
  /**
   * 目标表字段元数据。
   *
   * ⚠️ 渲染单元格必须经 `<DocFieldValue/>`，它需要**目标表**的 `FieldMetaLite`
   * （当前视图的 `fieldsById` 里没有目标表字段）。缺省时该列不可渲染（渲染层应跳过）。
   */
  meta?: FieldMetaLite;
}

/** 关联表格的一行（= 一条被关联记录） */
export interface LinkRow {
  /** 被关联记录 id（**仅供结构定位 / React key，绝不进入展示文本或 DOM 属性**） */
  recordId: string;
  /** 行首兜底文本（= 主字段展示文本；取不到 → `''`） */
  title: string;
  /** 列 fieldId → 归一化值（只含有效列；读取失败的行**全为空单元格占位**） */
  cells: Record<string, NormalizedValue>;
}

/** 关联字段的只读表格数据（注入 `resolveBlocks` 的纯输入） */
export interface LinkTable {
  columns: LinkColumn[];
  rows: LinkRow[];
  /** 因行上限被隐藏的行数（> 0 才有；渲染层据此显示「+N」） */
  truncated?: number;
}

/* ===================== 小工具 ===================== */

/** 空单元格（每次新建，避免共享引用被下游改写） */
function emptyCell(): NormalizedValue {
  return { kind: 'empty', text: '', display: '', isEmpty: true };
}

/** 展示文本优先取 `display`，缺失回退 `text`（与 `doc/resolve.ts` 同口径） */
function displayOf(nv: NormalizedValue | undefined): string {
  if (!nv) return '';
  return nv.display !== '' ? nv.display : nv.text;
}

/** 归一化行数上限：非法 / < 1 → 默认值（向下取整） */
function resolveMaxRows(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINK_TABLE_ROWS;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : DEFAULT_LINK_TABLE_ROWS;
}

/** 归一化并发上限：非法 / < 1 → 默认值 */
function resolveConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LINK_TABLE_CONCURRENCY;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : LINK_TABLE_CONCURRENCY;
}

/** 该字段类型是否有**真实渲染器**（FallbackRenderer 视为不可用 → 不进默认列） */
export function isUsableLinkColumnField(meta: FieldMetaLite | null | undefined): boolean {
  if (!meta || typeof meta.id !== 'string' || meta.id === '') return false;
  return getRenderer(meta.type) !== FallbackRenderer;
}

/* ===================== 列选择 ===================== */

/**
 * 目标表 → 默认列：**主字段 + 前 N 个可用字段**（N = {@link DEFAULT_LINK_TABLE_EXTRA_COLUMNS}）。
 *
 * - 主字段（`isPrimary`）**始终排第一列**（与多维表格详情/表格视图一致）；
 * - 不可用类型（无渲染器）**跳过**；
 * - 无主字段时退化为「前 N+1 个可用字段」；
 * - 可用字段不足 → 有几列给几列（不臆造空列）。
 */
export function pickLinkTableColumns(targetFieldMetas: ReadonlyArray<FieldMetaLite>): LinkColumn[] {
  const list = Array.isArray(targetFieldMetas) ? targetFieldMetas : [];
  const usable = list.filter(isUsableLinkColumnField);

  const primary = usable.find((meta) => meta.isPrimary === true);
  const seen = new Set<string>();
  const ordered: FieldMetaLite[] = [];
  if (primary) {
    ordered.push(primary);
    seen.add(primary.id);
  }
  const cap = DEFAULT_LINK_TABLE_EXTRA_COLUMNS + 1;
  for (const meta of usable) {
    if (ordered.length >= cap) break;
    if (seen.has(meta.id)) continue;
    seen.add(meta.id);
    ordered.push(meta);
  }
  return ordered.map((meta) => ({ fieldId: meta.id, label: meta.name, meta }));
}

/* ===================== 行构造（纯函数） ===================== */

export interface BuildLinkTableOptions {
  /** 行上限（正整数）；缺省 {@link DEFAULT_LINK_TABLE_ROWS} */
  maxRows?: number;
}

/**
 * ⭐ **纯函数**：关联引用 + 目标表字段元数据 + 目标表行记录 → 只读表格数据。
 *
 * - `rowRecords[i]` 与 `linkRef.recordIds[i]` **同序**；`null` / `undefined` = 该行读取失败
 *   → **保留占位行**（全空单元格），**绝不**静默丢行（`resolve/markdown` 一贯原则：
 *   静默消失比留空更糟 —— 用户不会怀疑「少了一行」）。
 * - 值一律经 `normalize()` 归一化（本节不另写字段格式化）。
 * - `recordId` **只**进结构，不进任何展示文本。
 */
export function buildLinkTable(
  linkRef: LinkedRecordRef | null | undefined,
  targetFieldMetas: ReadonlyArray<FieldMetaLite>,
  rowRecords: ReadonlyArray<LinkRowRecord | null | undefined>,
  options: BuildLinkTableOptions = {},
): LinkTable {
  const columns = pickLinkTableColumns(targetFieldMetas);

  const metasById: Record<string, FieldMetaLite> = {};
  for (const meta of Array.isArray(targetFieldMetas) ? targetFieldMetas : []) {
    if (meta && typeof meta.id === 'string' && meta.id !== '') metasById[meta.id] = meta;
  }

  const ids = Array.isArray(linkRef?.recordIds)
    ? linkRef.recordIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  const records = Array.isArray(rowRecords) ? rowRecords : [];
  const maxRows = resolveMaxRows(options.maxRows);
  const primaryColumnId = columns.length > 0 ? columns[0].fieldId : '';

  const rows: LinkRow[] = [];
  for (let index = 0; index < ids.length && rows.length < maxRows; index += 1) {
    const recordId = ids[index];
    const source = records[index] ?? null;
    const fields = source && source.fields && typeof source.fields === 'object' ? source.fields : null;

    const cells: Record<string, NormalizedValue> = {};
    for (const column of columns) {
      const meta = metasById[column.fieldId];
      if (!meta || !fields) {
        cells[column.fieldId] = emptyCell();
        continue;
      }
      try {
        cells[column.fieldId] = normalize(fields[column.fieldId], meta);
      } catch {
        // 单字段归一化异常不得拖垮整行（与 registry 的字段级隔离同口径）
        cells[column.fieldId] = emptyCell();
      }
    }

    rows.push({
      recordId,
      title: primaryColumnId !== '' ? displayOf(cells[primaryColumnId]) : '',
      cells,
    });
  }

  const table: LinkTable = { columns, rows };
  const hidden = ids.length - rows.length;
  if (hidden > 0) table.truncated = hidden;
  return table;
}

/* ===================== 关联字段收集 ===================== */

/**
 * 从模板区块里收集「被引用的**关联字段** id」（去重、保序）。
 *
 * 覆盖：heading(字段源) / paragraph / image / keyValueGrid / fieldList / badgeRow /
 * table(rowSource=linkedRecords)。这些是关联字段能落地的全部区块类型。
 */
export function collectLinkFieldIds(
  blocks: ReadonlyArray<DocBlock>,
  fields: ReadonlyArray<FieldMetaLite>,
): string[] {
  const metaById: Record<string, FieldMetaLite> = {};
  for (const meta of Array.isArray(fields) ? fields : []) {
    if (meta && typeof meta.id === 'string' && meta.id !== '') metaById[meta.id] = meta;
  }
  const isLinkField = (fieldId: unknown): boolean => {
    if (typeof fieldId !== 'string' || fieldId === '') return false;
    const meta = metaById[fieldId];
    return !!meta && LINK_FIELD_TYPES.includes(meta.type);
  };

  const out: string[] = [];
  const push = (fieldId: unknown): void => {
    if (!isLinkField(fieldId)) return;
    const id = fieldId as string;
    if (!out.includes(id)) out.push(id);
  };

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    switch (block.kind) {
      case 'heading':
        if (block.source.type === 'field') push(block.source.fieldId);
        break;
      case 'paragraph':
      case 'image':
        push(block.fieldId);
        break;
      case 'keyValueGrid':
        for (const row of block.rows ?? []) push(row.fieldId);
        break;
      case 'fieldList':
        for (const item of block.items ?? []) push(item.fieldId);
        break;
      case 'badgeRow':
        for (const fieldId of block.fieldIds ?? []) push(fieldId);
        break;
      case 'table':
        if (block.rowSource.type === 'linkedRecords') push(block.rowSource.fieldId);
        break;
      default:
        break;
    }
  }
  return out;
}

/* ===================== 预取编排 ===================== */

/** 预取所需的三项**只读**访问能力（生产由 `sdk/linkedRecords` 提供；测试注入 stub） */
export interface LinkTablePrefetchAccess {
  /** 关联引用读取器（`(fieldId, recordId) => { recordIds, tableId }`） */
  reader: LinkedRecordsReader;
  /** 目标表字段元数据（原始 SDK 形态；本层经 `toFieldMetaLite` 映射） */
  getTargetFieldMetas(tableId: string): Promise<ReadonlyArray<unknown>>;
  /** 目标表单行记录（失败 → `null` → 占位行） */
  getTargetRow(tableId: string, recordId: string): Promise<LinkRowRecord | null>;
}

/**
 * 关联表格预取的**可注入依赖**（`usePagedDocument` 消费；缺省走生产实现）。
 *
 * ⚠️ 缺省（不注入 `resolveAccess`）时，`usePagedDocument` 会**动态 import** `@/sdk/linkedRecords`
 *   并按 `tableId` 解析真实访问能力 —— 单测注入本项后**完全不会加载 SDK**。
 */
export interface LinkTablePrefetchDeps {
  /** 解析只读访问能力；返回 `null`（无 tableId / SDK 不可用）→ 不预取（优雅降级） */
  resolveAccess?: (
    tableId: string | null,
    record: SdkRecord | null,
  ) => Promise<LinkTablePrefetchAccess | null>;
  /** 行上限（缺省 {@link DEFAULT_LINK_TABLE_ROWS}） */
  maxRows?: number;
  /** 并发上限（缺省 {@link LINK_TABLE_CONCURRENCY}） */
  concurrency?: number;
  /** 最多处理的关联字段数（缺省 {@link MAX_LINK_FIELDS_PER_PREFETCH}） */
  maxLinkFields?: number;
}

export interface PrefetchLinkTablesArgs {
  blocks: ReadonlyArray<DocBlock>;
  fields: ReadonlyArray<FieldMetaLite>;
  /** 当前记录 id（传给读取器） */
  recordId: string;
  access: LinkTablePrefetchAccess;
  /** 行上限（缺省 {@link DEFAULT_LINK_TABLE_ROWS}） */
  maxRows?: number;
  /** 并发上限（缺省 {@link LINK_TABLE_CONCURRENCY}） */
  concurrency?: number;
  /** 最多处理的关联字段数（缺省 {@link MAX_LINK_FIELDS_PER_PREFETCH}） */
  maxLinkFields?: number;
  /**
   * 「本链路仍有效」判定。**过期响应守卫的接入点**：
   * 记录切换 / 重跑后旧链路必须自我作废，否则会把**上一个记录**的关联表格落到新记录上（且不报错）。
   * 返回 false → 立即停止，返回**已完成的空/部分**结果（调用方因 `isActive()` 为 false 不会落 state）。
   */
  isActive?: () => boolean;
  /** 告警出口（缺省 `logWarn`） */
  onWarn?: (scope: string, message: string, ctx?: Record<string, unknown>) => void;
}

const PREFETCH_WARN_SCOPE = 'doc.linkTable';

/**
 * 预取「模板中被引用的关联字段」的只读表格数据。
 *
 * 只读、并发受信号量约束、任一步失败都**降级**（该关联不展示表格）而非抛出。
 * 结果作为**纯输入**交给 `resolveBlocks`（`resolve.ts` 保持纯函数语义）。
 */
export async function prefetchLinkTables(args: PrefetchLinkTablesArgs): Promise<Map<string, LinkTable>> {
  const out = new Map<string, LinkTable>();
  const active = args.isActive ?? ((): boolean => true);
  const warn = args.onWarn ?? logWarn;
  const sem = new Semaphore(resolveConcurrency(args.concurrency));

  const maxLinkFields =
    typeof args.maxLinkFields === 'number' && Number.isFinite(args.maxLinkFields) && args.maxLinkFields >= 1
      ? Math.floor(args.maxLinkFields)
      : MAX_LINK_FIELDS_PER_PREFETCH;

  const fieldIds = collectLinkFieldIds(args.blocks, args.fields).slice(0, maxLinkFields);
  if (fieldIds.length === 0) return out;

  /** tableId → 目标表字段元数据（同一表只请求一次） */
  const metaCache = new Map<string, FieldMetaLite[]>();
  const metasOf = async (tableId: string): Promise<FieldMetaLite[]> => {
    const cached = metaCache.get(tableId);
    if (cached) return cached;
    let metas: FieldMetaLite[] = [];
    try {
      const raws = await sem.run(() => args.access.getTargetFieldMetas(tableId));
      metas = (Array.isArray(raws) ? raws : []).map((raw) => toFieldMetaLite(raw));
    } catch (err) {
      warn(PREFETCH_WARN_SCOPE, '读取关联表字段元数据失败（该关联不展示表格）', {
        tableId,
        error: formatError(err),
      });
      metas = [];
    }
    metaCache.set(tableId, metas);
    return metas;
  };

  const maxRows = resolveMaxRows(args.maxRows);

  for (const fieldId of fieldIds) {
    if (!active()) return out;

    let ref: LinkedRecordRef;
    try {
      ref = await sem.run(() => args.access.reader(fieldId, args.recordId));
    } catch (err) {
      warn(PREFETCH_WARN_SCOPE, '读取关联字段失败（该关联不展示表格）', {
        fieldId,
        error: formatError(err),
      });
      continue;
    }
    if (!active()) return out;

    const ids = Array.isArray(ref?.recordIds) ? ref.recordIds.filter((id) => typeof id === 'string' && id !== '') : [];
    if (ids.length === 0) continue;

    const targetMetas = await metasOf(ref.tableId);
    if (!active()) return out;

    const wanted = ids.slice(0, maxRows);
    const rowRecords = await Promise.all(
      wanted.map((id) =>
        sem.run(async (): Promise<LinkRowRecord | null> => {
          try {
            return await args.access.getTargetRow(ref.tableId, id);
          } catch (err) {
            warn(PREFETCH_WARN_SCOPE, '读取关联记录失败（该行降级为占位行）', {
              tableId: ref.tableId,
              recordId: id,
              error: formatError(err),
            });
            return null;
          }
        }),
      ),
    );
    if (!active()) return out;

    const table = buildLinkTable(ref, targetMetas, rowRecords, { maxRows });
    // 无可用列（目标表元数据取不到）→ 不落表，渲染层回退到原有文本呈现（优雅降级）
    if (table.columns.length === 0) continue;
    out.set(fieldId, table);
  }

  return out;
}
