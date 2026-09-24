/**
 * 筛选条件的**值输入控件**（设计文档 §22.3 UI 降级规则 4 / §22.5.2）。
 *
 * 职责：
 * 1. 按「字段类型」分派控件形态（文本 / 数字 / 日期 / 单多选选项 / 布尔 / 无值）；
 * 2. 保证写入 `FilterCondition.value` 的**值的形态**与该字段类型一致
 *    —— 绝不把文本值灌进数字字段（§22.4.4「所见即所筛」的前置条件）；
 * 3. `isEmpty` / `isNotEmpty`（以及附件这类无值形态）**不渲染**值输入（§22.3 规则 2）。
 *
 * ⭐ 形态的唯一真源是 `operatorMatrix.getValueInputKind()`：本组件**不自建**第二份
 *    「类型 → 控件」映射表（两套映射必然漂移：将来新增字段类型时改一处忘另一处，
 *    会出现「UI 让输入文本、引擎按数字比」的诡异 bug）。
 *
 * ⭐ 本组件是**受控**的：值一律由 `FilterConditionRow` 持有，本组件只负责把
 *    控件事件翻译成「与该字段类型相符的值」后回调，不做任何内部 state 缓存，
 *    避免类型切换时出现「UI 显示 A、store 里存 B」的双真相。
 */
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldSelect } from '@/components/common/FieldSelect';
import type { FieldSelectOption } from '@/components/common/FieldSelect';
import { SearchableMultiSelect } from '@/components/common/SearchableMultiSelect';
import {
  getValueInputKind,
  operatorRequiresValue,
  type FilterValueInputKind,
} from '@/filter/operatorMatrix';
import type { FilterOperator } from '@/filter/types';

export interface FilterValueInputProps {
  /** 目标字段元数据；字段已被删除时为 undefined（此时不渲染任何输入） */
  meta: FieldMetaLite | undefined;
  /** 当前算子（决定是否需要值） */
  operator: FilterOperator;
  /** 当前值（形态由字段类型决定） */
  value: unknown;
  /** 值变更回调；传入的形态已与该字段类型对齐 */
  onChange: (value: unknown) => void;
}

/* ===================== 纯函数：选项 / 日期 / 默认值 ===================== */

/** 从字段属性里读单/多选的选项名（与 `normalize.resolveColorIndex` 同口径读取 property.options） */
export function readOptionNames(meta: FieldMetaLite | undefined): string[] {
  if (!meta) return [];
  const property = meta.property as { options?: Array<{ name?: unknown }> } | null | undefined;
  const options = property?.options;
  if (!Array.isArray(options)) return [];
  const names: string[] = [];
  for (const option of options) {
    if (option && typeof option.name === 'string' && option.name !== '') names.push(option.name);
  }
  return names;
}

/** 时间戳 / 日期字符串 → `<input type="date">` 的 `YYYY-MM-DD`（本地时区） */
export function toDateInputValue(value: unknown): string {
  const timestamp =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` → 该日本地 0 点的毫秒时间戳；格式不符 → undefined（绝不产出 NaN） */
export function fromDateInputValue(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 该控件形态的**默认值**（字段/算子切换后写入，保证值的形态与类型相符）。
 * number / date 用 `undefined`（不臆造 0 或今天，避免「没填却被当成筛 0」）。
 */
export function defaultValueForKind(kind: FilterValueInputKind): unknown {
  switch (kind) {
    case 'text':
    case 'select':
      return '';
    case 'multiSelect':
      // 多选值形态 = 选项名数组；空数组在引擎侧判「未填写」→ 条件未生效、不隐藏数据
      return [];
    case 'boolean':
      return true;
    case 'none':
    case 'number':
    case 'date':
    default:
      return undefined;
  }
}

/**
 * 当前条件下**实际**要渲染的控件形态。
 * 两处会收成 `none`：① 算子本身不需要值（isEmpty/isNotEmpty）；② 该字段类型无值输入（附件/不可筛）。
 */
export function resolveValueInputKind(
  meta: FieldMetaLite | undefined,
  operator: FilterOperator,
): FilterValueInputKind {
  if (!operatorRequiresValue(operator)) return 'none';
  if (!meta) return 'none';
  return getValueInputKind(meta.type);
}

/* ===================== 组件 ===================== */

/**
 * 值输入控件。
 *
 * ⚠️ 返回 `null` 时调用方**不得**再渲染占位元素——「没有值输入」本身就是
 *    `isEmpty` / `isNotEmpty` / 附件这类条件的正确 UI 表达（§22.3 规则 2）。
 */
export function FilterValueInput({
  meta,
  operator,
  value,
  onChange,
}: FilterValueInputProps): JSX.Element | null {
  const kind = resolveValueInputKind(meta, operator);
  if (kind === 'none') return null;

  const testId = 'filter-value-input';

  if (kind === 'boolean') {
    const raw = value === true ? 'true' : value === false ? 'false' : '';
    // ⭐ req1：布尔值控件换成共享的可搜下拉（`FieldSelect`）；`''|'true'|'false'` 映射与原生 select 等价。
    const options: FieldSelectOption[] = [
      { value: '', label: '请选择' },
      { value: 'true', label: '是' },
      { value: 'false', label: '否' },
    ];
    return (
      <FieldSelect
        options={options}
        value={raw}
        onChange={(next) => {
          onChange(next === '' ? undefined : next === 'true');
        }}
        testId={testId}
        ariaLabel="筛选值"
      />
    );
  }

  if (kind === 'select') {
    const names = readOptionNames(meta);
    const current = typeof value === 'string' ? value : '';
    // ⭐ req1：单选值控件由原生 `<select>` 换成可搜下拉（选项多时中文可关键字定位）；写回仍是选项 name。
    const options: FieldSelectOption[] = [
      { value: '', label: '请选择' },
      ...names.map((name) => ({ value: name, label: name })),
    ];
    return (
      <FieldSelect
        options={options}
        value={current}
        onChange={(next) => onChange(next)}
        searchable
        searchableHint
        testId={testId}
        ariaLabel="筛选值"
        placeholder="请选择"
        emptyText="无匹配选项"
      />
    );
  }

  if (kind === 'multiSelect') {
    const names = readOptionNames(meta);
    // 兼容：历史 / 外部配置可能把多选值写成单个 string（旧 UI 只产出单值），此处归一化为数组
    const selected = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : typeof value === 'string' && value !== ''
        ? [value]
        : [];
    const options: FieldSelectOption[] = names.map((name) => ({ value: name, label: name }));
    return (
      <SearchableMultiSelect
        options={options}
        value={selected}
        onChange={(next) => onChange(next)}
        searchable
        searchableHint
        testId={testId}
        ariaLabel="筛选值"
        placeholder="请选择"
        emptyText="无匹配选项"
      />
    );
  }

  if (kind === 'date') {
    return (
      <input
        type="date"
        className="cbv-input"
        data-testid={testId}
        aria-label="筛选值"
        value={toDateInputValue(value)}
        onChange={(event) => onChange(fromDateInputValue(event.target.value))}
      />
    );
  }

  if (kind === 'number') {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return (
      <input
        type="number"
        className="cbv-input cbv-input--num"
        data-testid={testId}
        aria-label="筛选值"
        value={text}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === '') {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
    );
  }

  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return (
    <input
      type="text"
      className="cbv-input"
      data-testid={testId}
      aria-label="筛选值"
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
