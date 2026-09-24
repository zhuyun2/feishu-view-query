/**
 * 算子矩阵：字段类型 × 可用算子（设计文档 §22.3 / §22.8）。
 *
 * 职责：
 * 1. 字段类型 → 该类型**允许**的算子有序列表（UI 下拉只列这些项）；
 * 2. 字段类型 → 该类型**是否可筛**（不可筛类型不列入字段下拉，从源头规避 §22.10-⑩）；
 * 3. 算子中文标签 / 值输入形态 / 对齐度提示（供 F4 面板使用）；
 * 4. 切换字段时的算子回落（`resolveOperatorForType`）。
 *
 * ⭐ 硬约束：**算子白名单只有一份**。
 *    `ALL_FILTER_OPERATORS` 定义在 `filter/sanitize.ts`（F1 落地，供配置净化使用），
 *    本模块**从该处 import 并原样再导出**，**绝不**复制第二份字面量数组。
 *    理由：两套白名单必然漂移——将来新增算子时改一处忘另一处，会出现
 *    「UI 允许选但落库被 sanitize 丢掉」的诡异 bug，且极难排查。
 *
 * 本模块为纯常量/纯函数模块（无 React / 无 DOM / 无 SDK 运行时依赖），可在 node 下裸跑。
 */
import { FieldType, getFieldPriority } from '@/fields/fieldTypes';
import type { FieldTypeValue } from '@/fields/fieldTypes';
import { ALL_FILTER_OPERATORS } from './sanitize';
import type { FilterOperator } from './types';

/** 再导出：让调用方统一从「算子矩阵」取白名单，而定义仍只有 sanitize 一处 */
export { ALL_FILTER_OPERATORS };

/* ===================== 算子组（按 §22.3 表格逐条取） ===================== */

/** 文本六件套：文本 / 电话 / 链接 / 条码 / 单选 / 多选 */
const TEXT_OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
];

/** 数值八件套：数字 / 自动编号 / 货币 / 评分 / 进度 */
const NUMBER_OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'isGreater',
  'isGreaterEqual',
  'isLess',
  'isLessEqual',
  'isEmpty',
  'isNotEmpty',
];

/**
 * 日期六件套：日期 / 创建时间 / 修改时间（`isGreater`=晚于，`isLess`=早于）
 *
 * ⚠️ `isNot`（不等于某天）为**主理人裁定补充**（2026-09-20），对齐原生「日期不等于」：
 *    §22.3 原表在做「本期仅支持某一天」的降级裁剪时把它一并省掉了（属遗漏而非有意排除），
 *    而用户需求原话是「与原表格的筛选一致」，原生存在该条件。
 *    语义：`isNot` = `is` 的朴素否定，**含空值记录**（§22.10-③）。
 *    `doesNotContain` **不补**——对日期无意义。
 */
const DATE_OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'isGreater',
  'isLess',
  'isEmpty',
  'isNotEmpty',
];

/** 仅空值判断：附件（原生亦仅支持空值判断） */
const EMPTINESS_OPERATORS: readonly FilterOperator[] = ['isEmpty', 'isNotEmpty'];

/** 复选框：原生仅 `is` */
const CHECKBOX_OPERATORS: readonly FilterOperator[] = ['is'];

/** 按「可见文本」匹配的包含组：成员 / 创建人 / 修改人 / 群聊 / 关联 / 查找引用 / 位置 */
const TEXT_CONTAINS_OPERATORS: readonly FilterOperator[] = [
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
];

/** 公式：结果类型不可知 → 降级为「空值 + 文本包含」（顺序同 §22.3 表） */
const FORMULA_OPERATORS: readonly FilterOperator[] = [
  'isEmpty',
  'isNotEmpty',
  'contains',
  'doesNotContain',
];

/** 未知 / 未收录类型：仅空值判断，且**不可筛**（不列入字段下拉） */
const UNKNOWN_TYPE_OPERATORS: readonly FilterOperator[] = EMPTINESS_OPERATORS;

/* ===================== 矩阵本体 ===================== */

/**
 * 字段类型 → 允许算子（有序；UI 下拉按此顺序渲染）。
 *
 * ⚠️ 与 §22.3 表格逐行对应。任何新增字段类型都必须在此登记，
 *    否则 `isFilterableFieldType` 返回 false（= 不列入可筛字段，安全默认）。
 */
export const OPERATOR_MATRIX: Readonly<Record<number, readonly FilterOperator[]>> = {
  // —— 文本类 ——
  [FieldType.Text]: TEXT_OPERATORS,
  [FieldType.Phone]: TEXT_OPERATORS,
  [FieldType.Url]: TEXT_OPERATORS,
  [FieldType.Barcode]: TEXT_OPERATORS,
  // —— 数值类 ——
  [FieldType.Number]: NUMBER_OPERATORS,
  [FieldType.AutoNumber]: NUMBER_OPERATORS,
  [FieldType.Currency]: NUMBER_OPERATORS,
  [FieldType.Rating]: NUMBER_OPERATORS,
  [FieldType.Progress]: NUMBER_OPERATORS,
  // —— 选择类 ——
  [FieldType.SingleSelect]: TEXT_OPERATORS,
  [FieldType.MultiSelect]: TEXT_OPERATORS,
  // —— 日期类 ——
  [FieldType.DateTime]: DATE_OPERATORS,
  [FieldType.CreatedTime]: DATE_OPERATORS,
  [FieldType.ModifiedTime]: DATE_OPERATORS,
  // —— 布尔 ——
  [FieldType.Checkbox]: CHECKBOX_OPERATORS,
  // —— 成员类（按显示名匹配，近似）——
  [FieldType.User]: TEXT_CONTAINS_OPERATORS,
  [FieldType.CreatedUser]: TEXT_CONTAINS_OPERATORS,
  [FieldType.ModifiedUser]: TEXT_CONTAINS_OPERATORS,
  [FieldType.GroupChat]: TEXT_CONTAINS_OPERATORS,
  // —— 附件（仅空值）——
  [FieldType.Attachment]: EMPTINESS_OPERATORS,
  // —— 关联 / 查找 / 位置（按标题或地址文本匹配，近似）——
  [FieldType.Link]: TEXT_CONTAINS_OPERATORS,
  [FieldType.DuplexLink]: TEXT_CONTAINS_OPERATORS,
  [FieldType.Lookup]: TEXT_CONTAINS_OPERATORS,
  [FieldType.Location]: TEXT_CONTAINS_OPERATORS,
  // —— 公式（降级）——
  [FieldType.Formula]: FORMULA_OPERATORS,
};

/* ===================== 查询 API ===================== */

/**
 * 某字段类型允许的算子列表（未知类型 → 仅空值判断）。
 *
 * @param type 字段类型数值（SDK `FieldType`）
 */
export function getOperatorsForType(type: FieldTypeValue): readonly FilterOperator[] {
  const list = OPERATOR_MATRIX[type as number];
  return list ?? UNKNOWN_TYPE_OPERATORS;
}

/** 该算子是否可用于该字段类型 */
export function isOperatorAllowed(type: FieldTypeValue, operator: FilterOperator): boolean {
  return getOperatorsForType(type).includes(operator);
}

/**
 * 该字段类型**是否可筛**（不可筛 → 不列入字段下拉）。
 *
 * 判定：矩阵中显式登记 **且** 字段优先级不是 `unsupported`（§22.10-⑩）。
 * 未知类型一律不可筛——宁可不给筛，也不给一个语义不明的筛。
 */
export function isFilterableFieldType(type: FieldTypeValue): boolean {
  const list = OPERATOR_MATRIX[type as number];
  if (!list) return false;
  return getFieldPriority(type) !== 'unsupported';
}

/**
 * 切换字段时的算子回落（§22.3 UI 降级规则 1）：
 * 当前算子在新字段允许集内 → 保留；否则回落到该字段**第一个**可用算子。
 */
export function resolveOperatorForType(
  type: FieldTypeValue,
  current: FilterOperator | undefined,
): FilterOperator {
  const allowed = getOperatorsForType(type);
  if (current && allowed.includes(current)) return current;
  return allowed[0] ?? 'isEmpty';
}

/** 该类型的默认算子（= 第一个可用算子） */
export function defaultOperatorForType(type: FieldTypeValue): FilterOperator {
  return getOperatorsForType(type)[0] ?? 'isEmpty';
}

/** 该算子是否需要值输入（`isEmpty` / `isNotEmpty` 隐藏值输入框，§22.3 UI 降级规则 2） */
export function operatorRequiresValue(operator: FilterOperator): boolean {
  return operator !== 'isEmpty' && operator !== 'isNotEmpty';
}

/** 是否为已知算子（复用 sanitize 的唯一白名单，不另建集合） */
export function isKnownOperator(operator: unknown): operator is FilterOperator {
  return typeof operator === 'string' && (ALL_FILTER_OPERATORS as readonly string[]).includes(operator);
}

/* ===================== UI 辅助：标签 / 值形态 / 提示 ===================== */

/** 算子中文标签（§22.5.2） */
export const FILTER_OPERATOR_LABEL: Readonly<Record<FilterOperator, string>> = {
  is: '等于',
  isNot: '不等于',
  contains: '包含',
  doesNotContain: '不包含',
  isEmpty: '为空',
  isNotEmpty: '不为空',
  isGreater: '大于',
  isGreaterEqual: '大于或等于',
  isLess: '小于',
  isLessEqual: '小于或等于',
};

/** 日期类字段的算子标签覆盖（§22.5.2：日期显示「晚于 / 早于」） */
const DATE_OPERATOR_LABEL: Readonly<Partial<Record<FilterOperator, string>>> = {
  isGreater: '晚于',
  isLess: '早于',
};

/** 日期类字段类型集合（供标签覆盖判定） */
const DATE_FIELD_TYPES: readonly number[] = [
  FieldType.DateTime,
  FieldType.CreatedTime,
  FieldType.ModifiedTime,
];

/** 算子中文标签（可带字段类型以取得日期专用措辞） */
export function getOperatorLabel(operator: FilterOperator, type?: FieldTypeValue): string {
  if (type !== undefined && DATE_FIELD_TYPES.includes(type as number)) {
    const override = DATE_OPERATOR_LABEL[operator];
    if (override) return override;
  }
  return FILTER_OPERATOR_LABEL[operator] ?? operator;
}

/**
 * 值输入控件形态（§22.3 UI 降级规则 4）。
 *
 * ⚠️ `'select'`（单选）与 `'multiSelect'`（多选）**刻意分开**：
 *    二者值形态不同——单选写回单个**选项名文本**（`string`），多选写回**选项名数组**（`string[]`）。
 *    早先版本把 MultiSelect 也映射成 `'select'`，导致多选字段在 UI 上退化为「只能选一个值」，
 *    与原生多选「可多选」语义不符。此处区分后由 `FilterValueInput` 分派到不同控件。
 */
export type FilterValueInputKind =
  | 'none' // 无值输入（附件 / 未知类型 / 不可筛）
  | 'text' // 单行文本
  | 'number' // 数字输入
  | 'date' // 日期选择器
  | 'boolean' // 是 / 否
  | 'select' // 单选下拉（来自 meta.property.options[].name，值为单个 name）
  | 'multiSelect'; // 多选下拉（值为 name 数组，可多选）

const VALUE_INPUT_KIND_BY_TYPE: Readonly<Record<number, FilterValueInputKind>> = {
  [FieldType.Text]: 'text',
  [FieldType.Phone]: 'text',
  [FieldType.Url]: 'text',
  [FieldType.Barcode]: 'text',
  [FieldType.Number]: 'number',
  [FieldType.AutoNumber]: 'number',
  [FieldType.Currency]: 'number',
  [FieldType.Rating]: 'number',
  [FieldType.Progress]: 'number',
  [FieldType.SingleSelect]: 'select',
  [FieldType.MultiSelect]: 'multiSelect',
  [FieldType.DateTime]: 'date',
  [FieldType.CreatedTime]: 'date',
  [FieldType.ModifiedTime]: 'date',
  [FieldType.Checkbox]: 'boolean',
  [FieldType.User]: 'text',
  [FieldType.CreatedUser]: 'text',
  [FieldType.ModifiedUser]: 'text',
  [FieldType.GroupChat]: 'text',
  [FieldType.Attachment]: 'none',
  [FieldType.Link]: 'text',
  [FieldType.DuplexLink]: 'text',
  [FieldType.Lookup]: 'text',
  [FieldType.Location]: 'text',
  [FieldType.Formula]: 'text',
};

/** 字段类型 → 值输入形态；不可筛类型一律 `none` */
export function getValueInputKind(type: FieldTypeValue): FilterValueInputKind {
  if (!isFilterableFieldType(type)) return 'none';
  return VALUE_INPUT_KIND_BY_TYPE[type as number] ?? 'none';
}

/**
 * 字段类型的筛选提示文案（≈ 近似 / ⬇ 降级行的 `title` 提示，§22.3 UI 降级规则 3）。
 * 完全一致的类型返回 null（无需提示）。
 */
export function getFieldFilterNote(type: FieldTypeValue): string | null {
  switch (type as FieldType) {
    case FieldType.DateTime:
    case FieldType.CreatedTime:
    case FieldType.ModifiedTime:
      return '仅支持按「某一天」筛选；「晚于」= 次日 0 点及以后，「早于」= 当日 0 点之前';
    case FieldType.User:
    case FieldType.CreatedUser:
    case FieldType.ModifiedUser:
    case FieldType.GroupChat:
      return '按成员显示名匹配，同名成员可能误命中';
    case FieldType.Link:
    case FieldType.DuplexLink:
    case FieldType.Lookup:
      return '按关联记录标题文本匹配';
    case FieldType.Location:
      return '按地址文本匹配';
    case FieldType.Formula:
      return '公式字段结果类型不可知，仅支持空值与文本包含判断';
    default:
      return isFilterableFieldType(type) ? null : '该字段类型不支持筛选';
  }
}
