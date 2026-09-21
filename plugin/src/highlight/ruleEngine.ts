/**
 * 条件高亮规则引擎（设计文档 §6.9，D5 边界）。
 *
 * - **单层 AND / OR，不做嵌套表达式树**（D5 冻结）；
 * - `RuleOperator` 覆盖：比较 / 包含 / 空值 / 日期先后；
 * - **复用同一引擎**：卡片边框着色、字段着色、标签着色、**文档区块 `visibleWhen`**。
 *
 * 取值一律经 `normalize()`（与渲染层同源），从而保证：
 *  ① 比较的是「人可见语义值」而非原始 SDK 结构；
 *  ② 引擎自身**绝不接触/输出原始 ID / JSON**。
 */
import type { HighlightRule, HighlightStyle, HighlightTarget, RuleCondition, RuleExpr } from './types';
import { normalize } from '@/fields/normalize';
import { getRecordFields } from '@/data/RecordDataSource';
import type { FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';

/** 字段元数据索引（fieldId → meta） */
export type FieldMetaMap = Record<string, FieldMetaLite>;

/** 记录的最小抽象（避免本模块直接依赖 SDK 的 IRecord 具体形态） */
export interface RuleRecordLike {
  recordId?: string;
  fields?: Record<string, unknown>;
}

/** 取一条记录在某个字段上的归一化值（无法取值 → empty） */
function valueOf(record: RuleRecordLike | null | undefined, fieldId: string, metas: FieldMetaMap): NormalizedValue | null {
  const meta = metas[fieldId];
  if (!meta || !record) return null;
  try {
    const raw = getRecordFields(record as never)[fieldId];
    return normalize(raw, meta);
  } catch {
    return null;
  }
}

function asNumber(nv: NormalizedValue): number | null {
  if (typeof nv.number === 'number' && Number.isFinite(nv.number)) return nv.number;
  if (typeof nv.timestamp === 'number' && Number.isFinite(nv.timestamp)) return nv.timestamp;
  if (nv.text.trim() !== '') {
    const parsed = Number(nv.text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compare(expected: unknown, actual: NormalizedValue): number | null {
  const actualNumber = asNumber(actual);
  const expectedNumber =
    typeof expected === 'number'
      ? expected
      : typeof expected === 'string' && expected.trim() !== '' && Number.isFinite(Number(expected))
        ? Number(expected)
        : null;
  if (actualNumber !== null && expectedNumber !== null) return actualNumber - expectedNumber;
  return null;
}

/** 单个条件表达式求值 */
export function evaluateExpr(expr: RuleExpr, record: RuleRecordLike | null | undefined, metas: FieldMetaMap): boolean {
  const nv = valueOf(record, expr.fieldId, metas);
  if (!nv) return false;

  switch (expr.operator) {
    case 'isEmpty':
      return nv.isEmpty;
    case 'isNotEmpty':
      return !nv.isEmpty;
    case 'eq':
      if (nv.isEmpty) return false;
      if (typeof expr.value === 'boolean') return nv.boolean === expr.value;
      return nv.text === String(expr.value ?? '');
    case 'neq':
      return nv.text !== String(expr.value ?? '');
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const diff = compare(expr.value, nv);
      if (diff === null) return false;
      if (expr.operator === 'gt') return diff > 0;
      if (expr.operator === 'gte') return diff >= 0;
      if (expr.operator === 'lt') return diff < 0;
      return diff <= 0;
    }
    case 'contains':
      if (nv.isEmpty) return false;
      return nv.text.includes(String(expr.value ?? ''));
    case 'notContains':
      return !nv.text.includes(String(expr.value ?? ''));
    case 'before':
    case 'after': {
      const diff = compare(expr.value, nv);
      if (diff === null) return false;
      return expr.operator === 'before' ? diff < 0 : diff > 0;
    }
    default:
      return false;
  }
}

/**
 * 条件求值（单层 AND / OR）。
 *
 * ⚠️ 空条件（`items.length === 0`）→ **恒为 false**（不命中），避免「未配置条件的规则」
 * 意外命中全部卡片 / 隐藏全部区块。需要「无条件生效」请显式配置一条空值判断之外的表达式。
 */
export function evaluate(
  condition: RuleCondition | null | undefined,
  record: RuleRecordLike | null | undefined,
  metas: FieldMetaMap,
): boolean {
  if (!condition || !Array.isArray(condition.items) || condition.items.length === 0) return false;
  const results = condition.items.map((item) => evaluateExpr(item, record, metas));
  return condition.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** 命中的规则（含其样式），按 `priority` 升序（数字小者优先） */
export interface MatchedHighlight {
  rule: HighlightRule;
  style: HighlightStyle;
}

/** 求出一条记录命中的全部高亮规则（enabled + 条件命中），按 priority 升序 */
export function matchRules(
  rules: readonly HighlightRule[] | null | undefined,
  record: RuleRecordLike | null | undefined,
  metas: FieldMetaMap,
): MatchedHighlight[] {
  if (!rules || rules.length === 0) return [];
  const matched: MatchedHighlight[] = [];
  for (const rule of rules) {
    if (!rule || rule.enabled !== true) continue;
    try {
      if (evaluate(rule.condition, record, metas)) matched.push({ rule, style: rule.style });
    } catch {
      /* 单条规则异常不影响其他规则 */
    }
  }
  return matched.sort((a, b) => a.rule.priority - b.rule.priority);
}

/** 取某目标的最高优先级样式（priority 最小且命中的那条） */
export function resolveTargetStyle(
  matched: readonly MatchedHighlight[],
  target: HighlightTarget['kind'],
  fieldId?: string,
): HighlightStyle | null {
  for (const item of matched) {
    const t = item.rule.target;
    if (t.kind !== target) continue;
    if ((t.kind === 'field' || t.kind === 'badge') && fieldId !== undefined && t.fieldId !== fieldId) continue;
    return item.style;
  }
  return null;
}

/** 合并后的卡片边框样式（用于卡片整体着色） */
export function resolveCardStyle(matched: readonly MatchedHighlight[]): HighlightStyle | null {
  return resolveTargetStyle(matched, 'cardBorder');
}

/** 供文档区块 `visibleWhen` 使用：null / 未配置 → 可见 */
export function isBlockVisible(
  visibleWhen: RuleCondition | null | undefined,
  record: RuleRecordLike | null | undefined,
  metas: FieldMetaMap,
): boolean {
  if (!visibleWhen) return true;
  return evaluate(visibleWhen, record, metas);
}
