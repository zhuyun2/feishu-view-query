/**
 * 关联字段 → **目标表字段候选**（编辑器「关联记录显示列」配置用；需求 2 · 第二阶段）。
 *
 * 数据流中的位置：
 * ```
 *   当前视图字段（含关联字段 meta，property.tableId = 目标表 id）
 *     │  ① ensure(fieldId)：按需解析（懒加载，未用到的关联字段不发请求）
 *     ▼
 *   目标表字段列表（getFieldMetaList）—— 供 SearchableMultiSelect 作候选
 *     ▼
 *   editor/doc/LinkColumnsSection：用户勾选/排序 → 写回区块的 linkColumns / linkRowLimit
 * ```
 *
 * ⭐ 三条硬约束：
 *  1. **只读 + 按需**：仅在 `ensure(fieldId)` 被调用（= 某个区块确实绑定了该关联字段）时
 *     才发请求；同一字段同一目标表**只请求一次**。
 *  2. **失败一律降级**：无关联类型 / 无 `property.tableId` / SDK 不可用 / 请求失败 / 空结果 →
 *     `status = 'unavailable'`（UI 显式文案「无法读取关联表的字段，将使用默认列」），**绝不抛出/白屏**。
 *  3. **过期响应守卫**：目标字段变化（记录/字段切换）时，在途结果**不得**覆盖新状态
 *     （每字段独立序号 + 卸载标记，双守卫）。
 *
 * ⚠️ 与 `usePagedDocument` 同款理由：缺省解析器**动态 import** `@/sdk/linkedRecords`，
 *    单测注入 `resolveTargetFields` 后**完全不会加载 SDK**（jsdom 下加载 SDK 会产生未处理 rejection）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FieldType, toFieldMetaLite } from '@/fields/fieldTypes';
import type { FieldMetaLite, FieldTypeValue } from '@/fields/fieldTypes';
import { readLinkTargetTableId } from '@/doc/linkTable';
import { formatError } from '@/utils/errorText';
import { logWarn } from '@/utils/log';

/** 目标表字段的解析状态 */
export type LinkTargetFieldsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface LinkTargetFieldsState {
  status: LinkTargetFieldsStatus;
  /** 目标表字段（`status === 'ready'` 时非空；否则 `[]`） */
  fields: FieldMetaLite[];
  /** 目标表 id（取不到 / 非关联字段 → `''`） */
  tableId: string;
}

export interface UseLinkTargetFieldsDeps {
  /** 目标表字段解析器（缺省走生产 SDK 实现；测试注入后不加载 SDK） */
  resolveTargetFields?: (tableId: string) => Promise<ReadonlyArray<FieldMetaLite>>;
  /** 告警出口（缺省 `logWarn`） */
  onWarn?: (scope: string, message: string, ctx?: Record<string, unknown>) => void;
}

export interface UseLinkTargetFieldsResult {
  /** 关联字段 id → 目标表字段状态 */
  states: Readonly<Record<string, LinkTargetFieldsState>>;
  /** 按需解析某关联字段的目标表字段（幂等；已就绪/在途则不重复请求） */
  ensure: (fieldId: string) => void;
}

/** 关联字段类型（`Link` / `DuplexLink`） */
const LINK_TYPES: readonly FieldTypeValue[] = [FieldType.Link, FieldType.DuplexLink];

const WARN_SCOPE = 'editor.linkColumns';

/** 不可用状态（共享常量；调用方只读，绝不改写） */
const UNAVAILABLE: LinkTargetFieldsState = { status: 'unavailable', fields: [], tableId: '' };

/**
 * 生产缺省的解析器：动态 import `@/sdk/linkedRecords`，按目标 `tableId` 取字段元数据。
 * 解析器返回空数组 → 调用方判为 `unavailable`（优雅降级）。
 */
async function resolveProductionTargetFields(tableId: string): Promise<ReadonlyArray<FieldMetaLite>> {
  const { resolveSdkLinkTableSource } = await import('@/sdk/linkedRecords');
  const source = await resolveSdkLinkTableSource(tableId, null);
  if (!source) return [];
  const raws = await source.getTargetFieldMetas(tableId);
  return (Array.isArray(raws) ? raws : []).map((raw) => toFieldMetaLite(raw));
}

/**
 * 按需解析关联字段的目标表字段候选。
 *
 * @param fields 当前视图字段元数据（关联字段须带 `property.tableId`）
 * @param deps   可注入依赖（解析器 / 告警出口）
 */
export function useLinkTargetFields(
  fields: readonly FieldMetaLite[],
  deps: UseLinkTargetFieldsDeps = {},
): UseLinkTargetFieldsResult {
  const [states, setStates] = useState<Record<string, LinkTargetFieldsState>>({});

  const fieldsById = useMemo(() => {
    const map: Record<string, FieldMetaLite> = {};
    for (const field of fields) {
      if (field && typeof field.id === 'string' && field.id !== '') map[field.id] = field;
    }
    return map;
  }, [fields]);

  /** 每字段独立序号（过期响应守卫 ①） */
  const seqRef = useRef<Record<string, number>>({});
  /** 卸载标记（过期响应守卫 ②） */
  const mountedRef = useRef(true);
  /** 最新 deps（ref 持有，避免因 deps 对象身份变化反复重跑） */
  const depsRef = useRef(deps);
  /** 最新 states 镜像（供 `ensure` 去重判定；滞后一帧仅致至多多一次请求，无正确性问题） */
  const statesRef = useRef(states);

  useEffect(() => {
    depsRef.current = deps;
  });

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ensure = useCallback(
    (fieldId: string): void => {
      const meta = fieldsById[fieldId];
      // 非关联字段 / 无该字段 → 明确不可用（不请求）
      if (!meta || !LINK_TYPES.includes(meta.type)) {
        setStates((prev) =>
          prev[fieldId]?.status === 'unavailable' ? prev : { ...prev, [fieldId]: UNAVAILABLE },
        );
        return;
      }
      const tableId = readLinkTargetTableId(meta);
      // 拿不到目标表 id（无 property.tableId / 非 SDK 字段）→ 不可用（不请求）
      if (tableId === '') {
        setStates((prev) =>
          prev[fieldId]?.status === 'unavailable' ? prev : { ...prev, [fieldId]: UNAVAILABLE },
        );
        return;
      }
      // 已就绪 / 在途（同一目标表）→ 幂等返回，不重复请求
      const existing = statesRef.current[fieldId];
      if (existing && existing.tableId === tableId && (existing.status === 'ready' || existing.status === 'loading')) {
        return;
      }

      const seq = (seqRef.current[fieldId] ?? 0) + 1;
      seqRef.current[fieldId] = seq;
      setStates((prev) => ({ ...prev, [fieldId]: { status: 'loading', fields: [], tableId } }));

      const resolve = depsRef.current.resolveTargetFields ?? resolveProductionTargetFields;
      const warn = depsRef.current.onWarn ?? logWarn;

      void (async () => {
        let next: LinkTargetFieldsState;
        try {
          const resolved = await resolve(tableId);
          const list = (Array.isArray(resolved) ? resolved : []).filter(
            (field) => field && typeof field.id === 'string' && field.id !== '',
          );
          next =
            list.length > 0
              ? { status: 'ready', fields: list, tableId }
              : { status: 'unavailable', fields: [], tableId };
        } catch (err) {
          warn(WARN_SCOPE, '读取关联表字段失败（将使用默认列）', { tableId, error: formatError(err) });
          next = { status: 'unavailable', fields: [], tableId };
        }
        // 过期响应守卫：卸载 / 被更新的解析取代 → 丢弃
        if (!mountedRef.current || seqRef.current[fieldId] !== seq) return;
        setStates((prev) => ({ ...prev, [fieldId]: next }));
      })();
    },
    [fieldsById],
  );

  return { states, ensure };
}

export default useLinkTargetFields;
