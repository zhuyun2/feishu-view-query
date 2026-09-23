/**
 * 筛选配置容错净化（设计文档 §22.2.3 / §22.6）。
 *
 * 背景：持久化在 bridge / localStorage 里的 `CardViewConfig.filter` 是**不可信输入**——
 * 字段可能已被删除、算子可能是更新前遗留的、值可能是被手工改写过的脏数据，
 * 甚至整个分支可能是字符串（旧端或异常写入）。配置损坏**绝不允许**导致插件崩溃。
 *
 * 设计约束：
 * 1. **纯函数、确定性**：无 DOM / React / SDK 运行时依赖，同样入参必得同样出参（不读时钟、不用随机数）；
 * 2. **不抛异常**：任何非法输入都收敛为「安全的空筛选」或丢弃单条条件；
 * 3. **可诊断**：`sanitizeFilterConfigWithReport()` 返回被丢弃项及其原因；
 * 4. **保序**：合法条件的相对顺序与内容保持不变（UI 顺序对用户有意义）。
 *
 * ⚠️ 值类型校验是**粗粒度**的（只保证「不至于让求值引擎拿到离谱类型」）；
 *    字段类型 × 算子的精确可用矩阵与取值形态归 `filter/operatorMatrix.ts`（F2）。
 */
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FilterCondition, FilterConfig, FilterConjunction, FilterOperator } from './types';

/* ===================== 常量 ===================== */

/**
 * 允许落库的算子白名单（与 `FilterOperator` 联合类型一一对应）。
 *
 * ⚠️ §22.8 约定「`ALL_FILTER_OPERATORS` 放 `filter/operatorMatrix.ts`」，而算子矩阵属 F2、
 * 本任务（F1）尚不存在该模块；为避免 F1/F2 互相阻塞，此处先落地同义常量并 `export`，
 * F2 落地 `operatorMatrix.ts` 时应 `import { ALL_FILTER_OPERATORS } from './sanitize'`（或反向搬迁），
 * **不要**复制出第二份白名单。
 */
export const ALL_FILTER_OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
  'isGreater',
  'isGreaterEqual',
  'isLess',
  'isLessEqual',
];

/** 不需要值的算子 */
const VALUELESS_OPERATORS: readonly FilterOperator[] = ['isEmpty', 'isNotEmpty'];

/** 值的语义种类（供「值类型 × 字段类型」粗校验） */
type FilterValueKind = 'none' | 'text' | 'number' | 'boolean' | 'date' | 'textList';

/**
 * 字段类型 → 期望的值种类。
 * 未收录的类型（Formula / Lookup / 未知类型）→ **不做值校验**（值域不可预知，宁可放过也不误删）。
 */
const VALUE_KIND_BY_FIELD_TYPE: Readonly<Record<number, FilterValueKind>> = {
  [FieldType.Text]: 'text',
  [FieldType.Number]: 'number',
  [FieldType.Currency]: 'number',
  [FieldType.Rating]: 'number',
  [FieldType.Progress]: 'number',
  [FieldType.AutoNumber]: 'number',
  [FieldType.SingleSelect]: 'text',
  [FieldType.MultiSelect]: 'textList',
  [FieldType.DateTime]: 'date',
  [FieldType.CreatedTime]: 'date',
  [FieldType.ModifiedTime]: 'date',
  [FieldType.Checkbox]: 'boolean',
  [FieldType.User]: 'textList',
  [FieldType.CreatedUser]: 'textList',
  [FieldType.ModifiedUser]: 'textList',
  [FieldType.Phone]: 'text',
  [FieldType.Url]: 'text',
  [FieldType.Attachment]: 'textList',
  [FieldType.Link]: 'textList',
  [FieldType.DuplexLink]: 'textList',
  [FieldType.Location]: 'text',
  [FieldType.GroupChat]: 'text',
  [FieldType.Barcode]: 'text',
};

/* ===================== 结果类型 ===================== */

/** 丢弃原因（诊断用，UI 可不展示） */
export type FilterDropReason =
  | 'conditionNotObject' // conditions 里的元素不是普通对象
  | 'missingFieldId' // fieldId 缺失或非非空字符串
  | 'unknownField' // fieldId 在当前字段列表中不存在（字段已被删除）
  | 'unknownOperator' // 算子不在 ALL_FILTER_OPERATORS 白名单内
  | 'invalidValueType'; // 值类型与字段类型不匹配

export interface FilterDropRecord {
  /** 该条件在**原始** conditions 数组中的下标（便于人工定位） */
  index: number;
  /** 尽力还原的 fieldId（缺失时为 ''） */
  fieldId: string;
  /** 尽力还原的 operator（缺失时为 ''） */
  operator: string;
  reason: FilterDropReason;
}

export interface SanitizeFilterOptions {
  /**
   * 当前字段列表。**提供**时校验 `fieldId` 是否仍存在（字段被删除 → 丢弃该条件）；
   * **不提供**时跳过该校验（迁移期拿不到字段元数据，此时只做结构/算子/值校验，
   * 字段存在性由上层在装载后二次净化）。
   */
  fields?: readonly FieldMetaLite[];
}

export interface SanitizeFilterResult {
  /** 净化后的安全配置（可直接落库 / 直接求值） */
  config: FilterConfig;
  /** 被丢弃的条件及原因（顺序 = 原始顺序） */
  dropped: FilterDropRecord[];
}

/* ===================== 默认值 ===================== */

/** 空筛选配置（= 不筛）：`enabled` 恒 true，`conditions` 为空即等价「不筛」 */
export function defaultFilterConfig(): FilterConfig {
  return { enabled: true, conjunction: 'and', conditions: [] };
}

/* ===================== 内部工具 ===================== */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (ALL_FILTER_OPERATORS as readonly string[]).includes(value);
}

function isFilterConjunction(value: unknown): value is FilterConjunction {
  return value === 'and' || value === 'or';
}

/** 值是否匹配「文本列表」形态：string 或 string[]（空数组视为合法「未选」） */
function matchesTextList(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === 'string');
}

/** 值是否可解释为日期：毫秒时间戳 number，或能被 `Date.parse` 解析的非空字符串 */
function matchesDate(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length > 0 && Number.isFinite(Date.parse(value));
  return false;
}

/** 按字段类型校验值；返回 false 表示该条件应被丢弃 */
function matchesValueKind(value: unknown, kind: FilterValueKind): boolean {
  switch (kind) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return matchesDate(value);
    case 'textList':
      return matchesTextList(value);
    case 'none':
      // isEmpty / isNotEmpty 不取值：值一律剥离，不因此丢弃条件
      return true;
    default:
      return true;
  }
}

/** 字段类型 → 期望值种类；未知类型返回 undefined（= 跳过值校验） */
function resolveValueKind(
  fieldId: string,
  operator: FilterOperator,
  fields: readonly FieldMetaLite[] | undefined,
): FilterValueKind | undefined {
  if ((VALUELESS_OPERATORS as readonly FilterOperator[]).includes(operator)) return 'none';
  if (!fields) return undefined; // 无字段元数据 → 值类型无从判定 → 放过
  const meta = fields.find((field) => field.id === fieldId);
  if (!meta) return undefined;
  return VALUE_KIND_BY_FIELD_TYPE[meta.type as number];
}

/** 单条条件净化：成功返回条件，失败返回 null（并给出原因） */
function sanitizeCondition(
  raw: unknown,
  index: number,
  fields: readonly FieldMetaLite[] | undefined,
): { condition: FilterCondition } | { drop: FilterDropRecord } {
  if (!isPlainObject(raw)) {
    return { drop: { index, fieldId: '', operator: '', reason: 'conditionNotObject' } };
  }

  const rawFieldId = typeof raw.fieldId === 'string' ? raw.fieldId.trim() : '';
  if (rawFieldId.length === 0) {
    return { drop: { index, fieldId: '', operator: '', reason: 'missingFieldId' } };
  }

  if (fields && !fields.some((field) => field.id === rawFieldId)) {
    return {
      drop: {
        index,
        fieldId: rawFieldId,
        operator: typeof raw.operator === 'string' ? raw.operator : '',
        reason: 'unknownField',
      },
    };
  }

  if (!isFilterOperator(raw.operator)) {
    return {
      drop: {
        index,
        fieldId: rawFieldId,
        operator: typeof raw.operator === 'string' ? raw.operator : '',
        reason: 'unknownOperator',
      },
    };
  }

  const kind = resolveValueKind(rawFieldId, raw.operator, fields);
  /**
   * ⚠️ 这里与 `filter/engine.ts` 的 `isValidConditionValue` 存在**故意的「不对称」，不是 bug，请勿"修"成一致**：
   *  - **引擎**（`engine.ts`）：把「需值算子但值为空（`undefined` / `null` / 纯空白 / 空数组）」
   *    判为 **`invalid`（未生效）**——**跳过该条件**、记录保留（数据可见性优先于筛选精确性）；
   *  - **本处 sanitize**：只对 **`undefined` / `null`**（值**完全缺失**、无从回填）判 `invalidValueType` 丢弃；
   *    对 **`''` / 纯空白**（`hasValue` 为 true，且 `matchesValueKind` 通过）**保留**。
   *
   *  为什么不对称：`''` 是用户**填了一半**的**草稿**。若 sanitize 也丢弃它，用户半行输入会被**静默删掉**
   *  （回到面板发现自己填的值没了，却不知为何）——那才是真的破坏用户输入。
   *  正确语义：**引擎视其「暂不生效」，配置层保留草稿**。两边职责不同——
   *  引擎对「能否求值」负责，sanitize 对「是否丢用户输入」负责。
   */
  const hasValue = raw.value !== undefined && raw.value !== null;
  if (kind && kind !== 'none') {
    // 需要值的算子：值**完全缺失** → 条件无意义（等价于永远不命中），丢弃；
    // （注意：`''` / 纯空白不在此列，见上方注释——引擎会把它判为「未生效」而非在此删除）
    if (!hasValue || !matchesValueKind(raw.value, kind)) {
      return {
        drop: {
          index,
          fieldId: rawFieldId,
          operator: raw.operator,
          reason: 'invalidValueType',
        },
      };
    }
  }

  const conditionId = typeof raw.conditionId === 'string' && raw.conditionId.length > 0
    ? raw.conditionId
    : `flt_auto_${index}`;

  const condition: FilterCondition = {
    conditionId,
    fieldId: rawFieldId,
    operator: raw.operator,
  };
  // 仅当值「存在且被该算子接受」时写入；isEmpty/isNotEmpty 一律不带 value 键
  if (hasValue && kind !== 'none') {
    condition.value = raw.value;
  }
  return { condition };
}

/* ===================== 对外 API ===================== */

/**
 * 净化筛选配置（带诊断报告）。
 *
 * 规则（逐条，对应 §22.2.3）：
 * - `raw` 非普通对象（含 null / 字符串 / 数字 / 数组）→ `defaultFilterConfig()`；
 * - `enabled` 非布尔 → `true`；
 * - `conjunction` 非 `'and' | 'or'` → `'and'`；
 * - `conditions` 非数组 → `[]`；
 * - 逐条：非对象 / `fieldId` 空 / 字段已删除 / 算子越白名单 / 值类型不匹配 → **丢弃**；
 * - `conditionId` 缺失 → 补 `flt_auto_{index}`（确定性，不用随机数以保证可重放）。
 *
 * @param raw 不可信输入（通常来自 `CardViewConfig.filter`）
 * @param options.fields 可选字段列表；提供时才校验字段存在性
 */
export function sanitizeFilterConfigWithReport(
  raw: unknown,
  options: SanitizeFilterOptions = {},
): SanitizeFilterResult {
  if (!isPlainObject(raw)) {
    return { config: defaultFilterConfig(), dropped: [] };
  }

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
  const conjunction = isFilterConjunction(raw.conjunction) ? raw.conjunction : 'and';
  const rawConditions = Array.isArray(raw.conditions) ? raw.conditions : [];

  const conditions: FilterCondition[] = [];
  const dropped: FilterDropRecord[] = [];

  rawConditions.forEach((item, index) => {
    const outcome = sanitizeCondition(item, index, options.fields);
    if ('condition' in outcome) {
      conditions.push(outcome.condition);
    } else {
      dropped.push(outcome.drop);
    }
  });

  return { config: { enabled, conjunction, conditions }, dropped };
}

/**
 * 净化筛选配置（只要结果，不要报告）。
 * 签名与设计文档 §22.2.3 一致：`sanitizeFilterConfig(raw.filter)`。
 */
export function sanitizeFilterConfig(
  raw: unknown,
  options: SanitizeFilterOptions = {},
): FilterConfig {
  return sanitizeFilterConfigWithReport(raw, options).config;
}
