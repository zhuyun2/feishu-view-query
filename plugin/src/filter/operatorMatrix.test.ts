/**
 * 算子矩阵单测（设计文档 §22.3 / §22.9.1）。
 *
 * 断言策略（禁止假绿）：
 * - 逐字段类型断言**完整算子集 + 顺序**（`toEqual`），而非「包含某算子」；
 * - 双向守卫：矩阵算子 ⊆ 白名单 **且** 白名单 ⊆ 矩阵并集（不遗漏算子）；
 * - 「白名单只有一份」用**引用相等**（`toBe`）守卫，直接从根上禁止复制第二份。
 */
import { describe, expect, it } from 'vitest';
import { FieldType, getFieldPriority } from '@/fields/fieldTypes';
import type { FieldTypeValue } from '@/fields/fieldTypes';
import { ALL_FILTER_OPERATORS as WHITELIST_FROM_SANITIZE } from './sanitize';
import type { FilterOperator } from './types';
import {
  ALL_FILTER_OPERATORS,
  FILTER_OPERATOR_LABEL,
  OPERATOR_MATRIX,
  defaultOperatorForType,
  getFieldFilterNote,
  getOperatorsForType,
  getOperatorLabel,
  getValueInputKind,
  isFilterableFieldType,
  isKnownOperator,
  isOperatorAllowed,
  operatorRequiresValue,
  resolveOperatorForType,
} from './operatorMatrix';

const TEXT_SIX: FilterOperator[] = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
];
const NUMBER_EIGHT: FilterOperator[] = [
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
 * 日期六件套（含 `isNot`）。
 * ⚠️ `isNot` 是主理人裁定补充：对齐原生「日期不等于某天」，语义为朴素否定（含空值）。
 */
const DATE_SIX: FilterOperator[] = ['is', 'isNot', 'isGreater', 'isLess', 'isEmpty', 'isNotEmpty'];
const CONTAINS_FOUR: FilterOperator[] = ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'];

describe('filter/operatorMatrix · 白名单唯一性（硬约束）', () => {
  it('从 operatorMatrix 导出的 ALL_FILTER_OPERATORS 与 sanitize 的是**同一个引用**（禁止复制第二份）', () => {
    expect(ALL_FILTER_OPERATORS).toBe(WHITELIST_FROM_SANITIZE);
    expect(ALL_FILTER_OPERATORS).toHaveLength(10);
  });

  it('矩阵中出现的所有算子都 ∈ 白名单', () => {
    const inMatrix = new Set<string>();
    for (const list of Object.values(OPERATOR_MATRIX)) {
      for (const operator of list) inMatrix.add(operator);
    }
    for (const operator of inMatrix) {
      expect(WHITELIST_FROM_SANITIZE).toContain(operator);
    }
  });

  it('反向守卫：白名单里的 10 个算子都能在矩阵中找到（不遗漏算子）', () => {
    const inMatrix = new Set<string>();
    for (const list of Object.values(OPERATOR_MATRIX)) {
      for (const operator of list) inMatrix.add(operator);
    }
    expect([...inMatrix].sort()).toEqual([...WHITELIST_FROM_SANITIZE].sort());
  });
});

describe('filter/operatorMatrix · 逐类型算子集 = §22.3 表', () => {
  it('文本类（Text / Phone / Url / Barcode）→ 文本六件套', () => {
    for (const type of [FieldType.Text, FieldType.Phone, FieldType.Url, FieldType.Barcode]) {
      expect(getOperatorsForType(type)).toEqual(TEXT_SIX);
    }
  });

  it('数值类（Number / AutoNumber / Currency / Rating / Progress）→ 数值八件套', () => {
    for (const type of [
      FieldType.Number,
      FieldType.AutoNumber,
      FieldType.Currency,
      FieldType.Rating,
      FieldType.Progress,
    ]) {
      expect(getOperatorsForType(type)).toEqual(NUMBER_EIGHT);
    }
  });

  it('单选 / 多选 → 文本六件套', () => {
    expect(getOperatorsForType(FieldType.SingleSelect)).toEqual(TEXT_SIX);
    expect(getOperatorsForType(FieldType.MultiSelect)).toEqual(TEXT_SIX);
  });

  it('日期类（DateTime / CreatedTime / ModifiedTime）→ 日期六件套（含 isNot，无 isGreaterEqual/isLessEqual）', () => {
    for (const type of [FieldType.DateTime, FieldType.CreatedTime, FieldType.ModifiedTime]) {
      expect(getOperatorsForType(type)).toEqual(DATE_SIX);
      expect(getOperatorsForType(type)).not.toContain('isGreaterEqual');
      expect(getOperatorsForType(type)).not.toContain('isLessEqual');
    }
  });

  it('日期类含 isNot（对齐原生「不等于某天」），且**不含** doesNotContain', () => {
    for (const type of [FieldType.DateTime, FieldType.CreatedTime, FieldType.ModifiedTime]) {
      expect(isOperatorAllowed(type, 'isNot')).toBe(true);
      expect(isOperatorAllowed(type, 'doesNotContain')).toBe(false);
    }
  });

  it('复选框 → 仅 is；附件 → 仅 isEmpty / isNotEmpty', () => {
    expect(getOperatorsForType(FieldType.Checkbox)).toEqual(['is']);
    expect(getOperatorsForType(FieldType.Attachment)).toEqual(['isEmpty', 'isNotEmpty']);
  });

  it('成员类（User / CreatedUser / ModifiedUser / GroupChat）→ 包含四件套（无 is / isNot）', () => {
    for (const type of [
      FieldType.User,
      FieldType.CreatedUser,
      FieldType.ModifiedUser,
      FieldType.GroupChat,
    ]) {
      expect(getOperatorsForType(type)).toEqual(CONTAINS_FOUR);
    }
  });

  it('关联 / 查找 / 位置（Link / DuplexLink / Lookup / Location）→ 包含四件套', () => {
    for (const type of [FieldType.Link, FieldType.DuplexLink, FieldType.Lookup, FieldType.Location]) {
      expect(getOperatorsForType(type)).toEqual(CONTAINS_FOUR);
    }
  });

  it('公式（降级）→ isEmpty / isNotEmpty / contains / doesNotContain（顺序锁定）', () => {
    expect(getOperatorsForType(FieldType.Formula)).toEqual([
      'isEmpty',
      'isNotEmpty',
      'contains',
      'doesNotContain',
    ]);
  });

  it('未知类型 → 仅空值判断（不抛异常）', () => {
    expect(getOperatorsForType(99999 as FieldTypeValue)).toEqual(['isEmpty', 'isNotEmpty']);
  });

  it('除复选框外，每个已登记类型都含 isEmpty / isNotEmpty', () => {
    for (const [type, list] of Object.entries(OPERATOR_MATRIX)) {
      if (Number(type) === FieldType.Checkbox) {
        expect(list).toEqual(['is']); // 复选框是唯一例外（原生亦仅 is）
        continue;
      }
      expect(list).toContain('isEmpty');
      expect(list).toContain('isNotEmpty');
    }
  });
});

describe('filter/operatorMatrix · 可筛性判定（§22.10-⑩）', () => {
  it('已登记类型可筛；未知 / 不可识别类型不可筛', () => {
    expect(isFilterableFieldType(FieldType.Text)).toBe(true);
    expect(isFilterableFieldType(FieldType.Formula)).toBe(true);
    expect(isFilterableFieldType(99999 as FieldTypeValue)).toBe(false);
  });

  it('不可筛类型一律不在字段下拉里：所有可筛类型的优先级都不是 unsupported', () => {
    for (const type of Object.keys(OPERATOR_MATRIX)) {
      expect(getFieldPriority(Number(type))).not.toBe('unsupported');
    }
  });
});

describe('filter/operatorMatrix · 算子回落（§22.3 UI 降级规则 1）', () => {
  it('允许的算子保留：Number + isGreater → isGreater', () => {
    expect(resolveOperatorForType(FieldType.Number, 'isGreater')).toBe('isGreater');
  });

  it('不允许的算子回落到该类型第一个可用算子：MultiSelect + isGreater → is', () => {
    expect(isOperatorAllowed(FieldType.MultiSelect, 'isGreater')).toBe(false);
    expect(resolveOperatorForType(FieldType.MultiSelect, 'isGreater')).toBe('is');
  });

  it('切到附件 / 未知类型 → 回落 isEmpty；默认算子 = 第一个可用算子', () => {
    expect(resolveOperatorForType(FieldType.Attachment, 'contains')).toBe('isEmpty');
    expect(defaultOperatorForType(FieldType.Checkbox)).toBe('is');
    expect(defaultOperatorForType(FieldType.DateTime)).toBe('is');
    expect(resolveOperatorForType(FieldType.Text, undefined)).toBe('is');
  });
});

describe('filter/operatorMatrix · 值输入 / 标签 / 提示（供 F4）', () => {
  it('isEmpty / isNotEmpty 不需要值输入，其余需要', () => {
    expect(operatorRequiresValue('isEmpty')).toBe(false);
    expect(operatorRequiresValue('isNotEmpty')).toBe(false);
    for (const operator of ['is', 'isNot', 'contains', 'doesNotContain'] as FilterOperator[]) {
      expect(operatorRequiresValue(operator)).toBe(true);
    }
  });

  it('值输入形态按字段类型分派', () => {
    expect(getValueInputKind(FieldType.Text)).toBe('text');
    expect(getValueInputKind(FieldType.Number)).toBe('number');
    expect(getValueInputKind(FieldType.DateTime)).toBe('date');
    expect(getValueInputKind(FieldType.Checkbox)).toBe('boolean');
    expect(getValueInputKind(FieldType.SingleSelect)).toBe('select');
    expect(getValueInputKind(FieldType.MultiSelect)).toBe('select');
    expect(getValueInputKind(FieldType.Attachment)).toBe('none');
    expect(getValueInputKind(99999 as FieldTypeValue)).toBe('none');
  });

  it('算子中文标签；日期字段的 isGreater / isLess 显示「晚于 / 早于」', () => {
    expect(getOperatorLabel('is')).toBe('等于');
    expect(getOperatorLabel('doesNotContain')).toBe('不包含');
    expect(getOperatorLabel('isGreater')).toBe('大于');
    expect(getOperatorLabel('isGreater', FieldType.DateTime)).toBe('晚于');
    expect(getOperatorLabel('isLess', FieldType.DateTime)).toBe('早于');
    expect(getOperatorLabel('is', FieldType.DateTime)).toBe('等于');
    expect(Object.keys(FILTER_OPERATOR_LABEL)).toHaveLength(10);
  });

  it('近似 / 降级类型给出提示文案；完全一致类型无提示', () => {
    expect(getFieldFilterNote(FieldType.User)).toContain('显示名');
    expect(getFieldFilterNote(FieldType.Formula)).toContain('公式');
    expect(getFieldFilterNote(FieldType.DateTime)).toContain('某一天');
    expect(getFieldFilterNote(FieldType.Lookup)).toContain('标题');
    expect(getFieldFilterNote(FieldType.Text)).toBeNull();
    expect(getFieldFilterNote(99999 as FieldTypeValue)).toContain('不支持筛选');
  });

  it('isKnownOperator 复用 sanitize 白名单：未知算子一律 false', () => {
    expect(isKnownOperator('contains')).toBe(true);
    expect(isKnownOperator('startsWith')).toBe(false);
    expect(isKnownOperator(42)).toBe(false);
  });
});
