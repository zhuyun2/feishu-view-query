import { describe, expect, it } from 'vitest';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { migrate } from '@/config/migrations';
import { CURRENT_SCHEMA_VERSION } from '@/config/types';
import {
  ALL_FILTER_OPERATORS,
  defaultFilterConfig,
  sanitizeFilterConfig,
  sanitizeFilterConfigWithReport,
} from './sanitize';
import type { FilterConfig } from './types';

const fields: FieldMetaLite[] = [
  { id: 'fldA', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'fldB', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'fldC', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'fldD', name: '签约日期', type: FieldType.DateTime, isPrimary: false },
  { id: 'fldE', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
  { id: 'fldF', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  { id: 'fldG', name: '计算公式', type: FieldType.Formula, isPrimary: false },
];

/** 断言「结果里有哪些 fieldId」——锁定具体结构而非只数数量 */
function idsOf(config: FilterConfig): string[] {
  return config.conditions.map((condition) => condition.fieldId);
}

describe('filter/sanitize · 默认态与不可信输入', () => {
  it('defaultFilterConfig() = 空筛选（= 不筛）', () => {
    expect(defaultFilterConfig()).toEqual({ enabled: true, conjunction: 'and', conditions: [] });
  });

  it('算子白名单逐字等于 SDK FilterOperator 枚举的 10 个值（顺序锁定）', () => {
    expect(ALL_FILTER_OPERATORS).toEqual([
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
    ]);
  });

  it('filter 缺失 / null / 字符串 / 数字 / 数组 / 布尔 → 不抛异常且回落到默认空筛选', () => {
    const baseline = defaultFilterConfig();
    expect(sanitizeFilterConfig(undefined)).toEqual(baseline);
    expect(sanitizeFilterConfig(null)).toEqual(baseline);
    expect(sanitizeFilterConfig('oops')).toEqual(baseline);
    expect(sanitizeFilterConfig(42)).toEqual(baseline);
    expect(sanitizeFilterConfig([])).toEqual(baseline);
    expect(sanitizeFilterConfig(true)).toEqual(baseline);
  });

  it('conditions 非数组（字符串 / 对象）→ []，其余可解析分支照旧保留', () => {
    expect(
      sanitizeFilterConfig({
        enabled: false,
        conjunction: 'or',
        conditions: 'not-an-array',
      }),
    ).toEqual({ enabled: false, conjunction: 'or', conditions: [] });

    expect(
      sanitizeFilterConfig({
        enabled: true,
        conjunction: 'and',
        conditions: { 0: { fieldId: 'fldA', operator: 'is', value: 'x' } },
      }),
    ).toEqual({ enabled: true, conjunction: 'and', conditions: [] });
  });

  it('enabled 非布尔 → true；conjunction 非法 → and', () => {
    const result = sanitizeFilterConfig({ enabled: 'yes', conjunction: 'xor', conditions: [] });
    expect(result.enabled).toBe(true);
    expect(result.conjunction).toBe('and');
  });

  it('enabled:false 与 conjunction:or 属合法值 → 如实保留', () => {
    const result = sanitizeFilterConfig({ enabled: false, conjunction: 'or', conditions: [] });
    expect(result.enabled).toBe(false);
    expect(result.conjunction).toBe('or');
  });

  it('净化不修改入参（无副作用）', () => {
    const input = {
      enabled: true,
      conjunction: 'or',
      conditions: [{ conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 'x' }],
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    sanitizeFilterConfig(input, { fields });
    expect(input).toEqual(snapshot);
  });
});

describe('filter/sanitize · 丢弃规则', () => {
  it('字段已被删除 → 该条件丢弃，其余条件保序保留（断言保留的具体内容）', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: '张三' },
          { conditionId: 'flt_2', fieldId: 'fldGone', operator: 'isGreater', value: 10 },
          { conditionId: 'flt_3', fieldId: 'fldC', operator: 'contains', value: '进行' },
        ],
      },
      { fields },
    );

    expect(idsOf(result)).toEqual(['fldA', 'fldC']);
    expect(result.conditions).toEqual([
      { conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: '张三' },
      { conditionId: 'flt_3', fieldId: 'fldC', operator: 'contains', value: '进行' },
    ]);
  });

  it('算子不在白名单 → 该条件丢弃，其余保留', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldA', operator: 'like', value: '张' },
          { conditionId: 'flt_2', fieldId: 'fldA', operator: 'is', value: '李四' },
        ],
      },
      { fields },
    );

    expect(idsOf(result)).toEqual(['fldA']);
    expect(result.conditions[0]).toEqual({
      conditionId: 'flt_2',
      fieldId: 'fldA',
      operator: 'is',
      value: '李四',
    });
  });

  it('值类型与字段类型不匹配 → 丢弃（文本给数字 / 数字给字符串 / 复选框给字符串 / 日期给非法串）', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 5 },
          { conditionId: 'flt_2', fieldId: 'fldB', operator: 'isGreater', value: '100' },
          { conditionId: 'flt_3', fieldId: 'fldE', operator: 'is', value: 'true' },
          { conditionId: 'flt_4', fieldId: 'fldD', operator: 'is', value: 'not-a-date' },
          { conditionId: 'flt_5', fieldId: 'fldB', operator: 'isLess', value: 8 },
        ],
      },
      { fields },
    );

    expect(result.conditions).toEqual([
      { conditionId: 'flt_5', fieldId: 'fldB', operator: 'isLess', value: 8 },
    ]);
  });

  it('需要值的算子但值缺失 → 丢弃（空条件无意义）', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'fldA', operator: 'is' }],
      },
      { fields },
    );
    expect(result.conditions).toEqual([]);
  });

  it('条件元素非对象 / fieldId 为空 → 丢弃', () => {
    const result = sanitizeFilterConfigWithReport(
      {
        enabled: true,
        conjunction: 'and',
        conditions: ['nope', null, { conditionId: 'flt_x', fieldId: '', operator: 'is', value: 1 }],
      },
      { fields },
    );

    expect(result.config.conditions).toEqual([]);
    expect(result.dropped.map((item) => item.reason)).toEqual([
      'conditionNotObject',
      'conditionNotObject',
      'missingFieldId',
    ]);
  });

  it('被丢弃项的原因与原始下标可被诊断（dropped 只含被丢弃项）', () => {
    const result = sanitizeFilterConfigWithReport(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 'ok' },
          { conditionId: 'flt_2', fieldId: 'fldGone', operator: 'is', value: 'x' },
          { conditionId: 'flt_3', fieldId: 'fldB', operator: 'weird-op', value: 1 },
        ],
      },
      { fields },
    );

    expect(result.dropped).toEqual([
      { index: 1, fieldId: 'fldGone', operator: 'is', reason: 'unknownField' },
      { index: 2, fieldId: 'fldB', operator: 'weird-op', reason: 'unknownOperator' },
    ]);
    expect(result.config.conditions.map((condition) => condition.conditionId)).toEqual(['flt_1']);
  });
});

describe('filter/sanitize · 保真与归一化', () => {
  it('全部合法 → 原样返回（顺序与内容完全不变）', () => {
    const input: FilterConfig = {
      enabled: true,
      conjunction: 'or',
      conditions: [
        { conditionId: 'flt_1', fieldId: 'fldA', operator: 'contains', value: 'abc' },
        { conditionId: 'flt_2', fieldId: 'fldB', operator: 'isGreater', value: 10 },
        { conditionId: 'flt_3', fieldId: 'fldE', operator: 'is', value: true },
      ],
    };

    const result = sanitizeFilterConfig(input, { fields });

    expect(result).toEqual(input);
    expect(result.conditions.map((condition) => condition.conditionId)).toEqual([
      'flt_1',
      'flt_2',
      'flt_3',
    ]);
  });

  it('顺序跟随入参（倒序入参不得被重排）—— 证明实现是保序而非排序', () => {
    const reversed: FilterConfig = {
      enabled: true,
      conjunction: 'and',
      conditions: [
        { conditionId: 'flt_3', fieldId: 'fldE', operator: 'is', value: true },
        { conditionId: 'flt_2', fieldId: 'fldB', operator: 'is', value: 10 },
        { conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 'abc' },
      ],
    };

    const result = sanitizeFilterConfig(reversed, { fields });
    expect(result.conditions.map((condition) => condition.conditionId)).toEqual([
      'flt_3',
      'flt_2',
      'flt_1',
    ]);
  });

  it('缺失 conditionId → 按原始下标补 flt_auto_{index}（确定性，两次调用一致）', () => {
    const raw = {
      enabled: true,
      conjunction: 'and',
      conditions: [
        { fieldId: 'fldA', operator: 'is', value: 'x' },
        { conditionId: '', fieldId: 'fldB', operator: 'is', value: 1 },
      ],
    };

    const first = sanitizeFilterConfig(raw, { fields });
    const second = sanitizeFilterConfig(raw, { fields });

    expect(first.conditions.map((condition) => condition.conditionId)).toEqual([
      'flt_auto_0',
      'flt_auto_1',
    ]);
    expect(second).toEqual(first);
  });

  it('isEmpty / isNotEmpty 的值被剥离但条件保留', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldA', operator: 'isEmpty', value: 'garbage' },
          { conditionId: 'flt_2', fieldId: 'fldB', operator: 'isNotEmpty', value: 0 },
        ],
      },
      { fields },
    );

    expect(result.conditions).toEqual([
      { conditionId: 'flt_1', fieldId: 'fldA', operator: 'isEmpty' },
      { conditionId: 'flt_2', fieldId: 'fldB', operator: 'isNotEmpty' },
    ]);
    expect('value' in result.conditions[0]).toBe(false);
    expect('value' in result.conditions[1]).toBe(false);
  });

  it('多选 / 成员类字段接受 string 与 string[]；非字符串数组则丢弃', () => {
    const kept = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldF', operator: 'contains', value: 'VIP' },
          { conditionId: 'flt_2', fieldId: 'fldF', operator: 'contains', value: ['VIP', 'KA'] },
          { conditionId: 'flt_3', fieldId: 'fldF', operator: 'contains', value: [] },
        ],
      },
      { fields },
    );
    expect(kept.conditions.map((condition) => condition.conditionId)).toEqual([
      'flt_1',
      'flt_2',
      'flt_3',
    ]);

    const dropped = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_4', fieldId: 'fldF', operator: 'contains', value: [1, 2] }],
      },
      { fields },
    );
    expect(dropped.conditions).toEqual([]);
  });

  it('日期接受毫秒时间戳与可解析日期串；不可解析串被丢弃', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldD', operator: 'is', value: 1714521600000 },
          { conditionId: 'flt_2', fieldId: 'fldD', operator: 'is', value: '2024-05-01' },
          { conditionId: 'flt_3', fieldId: 'fldD', operator: 'is', value: '昨天' },
        ],
      },
      { fields },
    );
    expect(result.conditions.map((condition) => condition.conditionId)).toEqual([
      'flt_1',
      'flt_2',
    ]);
  });

  it('未知值域的字段类型（公式）不做值校验，避免误删', () => {
    const result = sanitizeFilterConfig(
      {
        enabled: true,
        conjunction: 'and',
        conditions: [
          { conditionId: 'flt_1', fieldId: 'fldG', operator: 'is', value: { weird: true } },
        ],
      },
      { fields },
    );
    expect(result.conditions).toEqual([
      { conditionId: 'flt_1', fieldId: 'fldG', operator: 'is', value: { weird: true } },
    ]);
  });

  it('未提供字段列表时不校验字段存在性（迁移期行为）', () => {
    const result = sanitizeFilterConfig({
      enabled: true,
      conjunction: 'and',
      conditions: [{ conditionId: 'flt_1', fieldId: 'fldGone', operator: 'is', value: 'x' }],
    });
    expect(result.conditions).toEqual([
      { conditionId: 'flt_1', fieldId: 'fldGone', operator: 'is', value: 'x' },
    ]);
  });
});

describe('filter/sanitize · 配置层接线（config/migrations）', () => {
  it('旧配置（无 filter 字段）→ filter 为默认空筛选，其余字段不受影响', () => {
    const migrated = migrate(
      {
        schemaVersion: 1,
        meta: { configId: 'view_1', tableId: 'tbl_1' },
        layout: { templateId: 'compact', cardAspect: 'square', slots: {} },
        highlightRules: [],
      },
      1,
    );

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.filter).toEqual(defaultFilterConfig());
    expect(migrated.card.templateId).toBe('compact');
  });

  it('合法 filter 经迁移后原样保留；损坏 filter 被净化为空', () => {
    const withValid = migrate(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        meta: { configId: 'view_1', tableId: 'tbl_1' },
        filter: {
          enabled: true,
          conjunction: 'or',
          conditions: [{ conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 'ok' }],
        },
      },
      CURRENT_SCHEMA_VERSION,
    );
    expect(withValid.filter).toEqual({
      enabled: true,
      conjunction: 'or',
      conditions: [{ conditionId: 'flt_1', fieldId: 'fldA', operator: 'is', value: 'ok' }],
    });

    const withBroken = migrate(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        meta: { configId: 'view_1', tableId: 'tbl_1' },
        filter: 'corrupted-by-old-client',
      },
      CURRENT_SCHEMA_VERSION,
    );
    expect(withBroken.filter).toEqual(defaultFilterConfig());
  });

  it('不升版：CURRENT_SCHEMA_VERSION 仍为 2', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
});
