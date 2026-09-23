/**
 * 筛选求值引擎单测（设计文档 §22.4 / §22.9.1）。
 *
 * ⚠️ 团队禁令：**禁止假绿断言**。每条断言都必须满足「把实现改坏，这条会红」：
 * - 一律断言**具体 recordId 序列**（`toEqual([...])`），不只断言数量或 `toBeTruthy()`；
 * - 每条筛选都构造**命中对照组**（A 命中 / B 不命中），验证「未命中项被排除」；
 * - 关键语义（区分大小写、`isNot` 含空值、日期按天）各有一条**能证伪**的断言。
 *
 * 纯函数测试：无 jsdom / React / SDK 依赖。
 */
import { describe, expect, it } from 'vitest';
import { FieldType } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { getRecordId } from '@/data/RecordDataSource';
import type { FilterCondition, FilterConfig, FilterConjunction, FilterOperator } from './types';
import {
  applyFilterConditions,
  computeFilterScope,
  evaluateCondition,
  evaluateConditionState,
  evaluateFilter,
  isConditionValid,
  isFilterActive,
  isOperatorKnown,
} from './engine';
import type { FieldMetaMap } from './engine';

/* ===================== 测试脚手架 ===================== */

const METAS: FieldMetaMap = {
  fldText: { id: 'fldText', name: '客户名称', type: FieldType.Text, isPrimary: true },
  fldNumber: { id: 'fldNumber', name: '金额', type: FieldType.Number, isPrimary: false },
  fldStatus: { id: 'fldStatus', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  fldDate: { id: 'fldDate', name: '签约日期', type: FieldType.DateTime, isPrimary: false },
  fldCheck: { id: 'fldCheck', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
  fldMulti: { id: 'fldMulti', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  fldUser: { id: 'fldUser', name: '负责人', type: FieldType.User, isPrimary: false },
  fldAttach: { id: 'fldAttach', name: '附件', type: FieldType.Attachment, isPrimary: false },
};

function rec(recordId: string, fields: Record<string, unknown> = {}): SdkRecord {
  return { recordId, fields } as unknown as SdkRecord;
}

function ids(records: readonly SdkRecord[]): string[] {
  return records.map((record) => getRecordId(record));
}

function cond(fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  const condition: FilterCondition = {
    conditionId: `flt_${fieldId}_${operator}`,
    fieldId,
    operator,
  };
  if (value !== undefined) condition.value = value;
  return condition;
}

function cfg(
  conditions: FilterCondition[],
  conjunction: FilterConjunction = 'and',
  enabled = true,
): FilterConfig {
  return { enabled, conjunction, conditions };
}

/** 本地时间戳（测试与实现同用本地时区口径，与 `formatDate` 显示一致） */
function ts(dateTime: string): number {
  return new Date(dateTime).getTime();
}

/* ===================== 1. 文本：`is` / `contains` 区分大小写 ===================== */

const TEXT_RECORDS: SdkRecord[] = [
  rec('recA1', { fldText: 'ABC' }),
  rec('recA2', { fldText: 'abc' }),
  rec('recA3', { fldText: 'XBCY' }),
];

describe('filter/engine · 文本 is / contains（区分大小写，§22.10-②）', () => {
  it('is 区分大小写：is ABC 只命中 recA1；把目标改成 abc 则只命中 recA2', () => {
    expect(ids(applyFilterConditions(TEXT_RECORDS, cfg([cond('fldText', 'is', 'ABC')]), METAS))).toEqual([
      'recA1',
    ]);
    expect(ids(applyFilterConditions(TEXT_RECORDS, cfg([cond('fldText', 'is', 'abc')]), METAS))).toEqual([
      'recA2',
    ]);
  });

  it('contains ABC 命中 recA1，且**不**命中 recA2（小写）——能证伪「统一转小写」的实现', () => {
    expect(
      ids(applyFilterConditions(TEXT_RECORDS, cfg([cond('fldText', 'contains', 'ABC')]), METAS)),
    ).toEqual(['recA1']);
    expect(
      ids(applyFilterConditions(TEXT_RECORDS, cfg([cond('fldText', 'contains', 'abc')]), METAS)),
    ).toEqual(['recA2']);
  });

  it('contains 是子串匹配：BC 同时命中 recA1(ABC) 与 recA3(XBCY)，不含 recA2(abc)', () => {
    expect(
      ids(applyFilterConditions(TEXT_RECORDS, cfg([cond('fldText', 'contains', 'BC')]), METAS)),
    ).toEqual(['recA1', 'recA3']);
  });
});

/* ===================== 1b. 批次 A：真机分段数组（IOpenSegment[]）回归 ===================== */

/** 真机文本单元格的实际形态：`IOpenSegment[]` 分段数组（非纯字符串） */
const SEGMENT_RECORDS: SdkRecord[] = [
  rec('recS1', { fldText: [{ type: 'text', text: '长度字段测试：第一段' }] }),
  rec('recS2', { fldText: [{ type: 'text', text: '前半段-' }, { type: 'mention', text: '@张三', token: 'ou_x' }] }),
  rec('recS3', { fldText: [{ type: 'text', text: '' }] }), // 段数组但全空 text → empty 语义
  rec('recS4', { fldText: '普通字符串对照组' }),
];

describe('filter/engine · 批次A：分段数组文本（真机 IOpenSegment[]）is / contains / isNot', () => {
  it('contains 长度字段 命中分段数组记录 recS1，不命中 recS2 / recS4 —— 修复前段数组被判空、筛选整体失效', () => {
    expect(
      ids(applyFilterConditions(SEGMENT_RECORDS, cfg([cond('fldText', 'contains', '长度字段')]), METAS)),
    ).toEqual(['recS1']);
  });

  it('contains 跨段拼接后仍可命中（前半段- + @张三 拼成完整文本）：命中 recS2', () => {
    expect(
      ids(applyFilterConditions(SEGMENT_RECORDS, cfg([cond('fldText', 'contains', '前半段-@张三')]), METAS)),
    ).toEqual(['recS2']);
  });

  it('is 全文相等：只命中完整拼接文本等于目标值的记录', () => {
    expect(
      ids(
        applyFilterConditions(SEGMENT_RECORDS, cfg([cond('fldText', 'is', '长度字段测试：第一段')]), METAS),
      ),
    ).toEqual(['recS1']);
    expect(
      ids(applyFilterConditions(SEGMENT_RECORDS, cfg([cond('fldText', 'is', '普通字符串对照组')]), METAS)),
    ).toEqual(['recS4']);
  });

  it('isNot 含空值：isNot 普通字符串对照组 → recS1 + recS2 + recS3（全空段=空值，朴素否定命中）', () => {
    expect(
      ids(applyFilterConditions(SEGMENT_RECORDS, cfg([cond('fldText', 'isNot', '普通字符串对照组')]), METAS)),
    ).toEqual(['recS1', 'recS2', 'recS3']);
  });

  it('全空 text 的段数组（recS3）与空值同义：isEmpty 命中、contains 不命中', () => {
    const allEmptySegments = rec('recS3', { fldText: [{ type: 'text', text: '' }] });
    expect(evaluateConditionState(cond('fldText', 'isEmpty'), allEmptySegments, METAS)).toBe('match');
    expect(evaluateConditionState(cond('fldText', 'contains', '任意'), allEmptySegments, METAS)).toBe('noMatch');
  });

  it('自动编号 {value:string} 包装 → 数值算子仍可用（normalize 补充 number 语义）', () => {
    const metas: FieldMetaMap = {
      fldAutoNum: { id: 'fldAutoNum', name: '自动编号', type: FieldType.AutoNumber, isPrimary: false },
    };
    const records: SdkRecord[] = [
      rec('recN1', { fldAutoNum: { value: '0008', status: 'Completed' } }),
      rec('recN2', { fldAutoNum: { value: '0003', status: 'Completed' } }),
      rec('recN3', { fldAutoNum: { value: 'F-2024-0001', status: 'Completed' } }),
    ];
    // is 8 → 数值语义命中 '0008'（前导零不影响数值比较）
    expect(ids(applyFilterConditions(records, cfg([cond('fldAutoNum', 'is', 8)]), metas))).toEqual(['recN1']);
    // isGreater 5 → 仅 0008
    expect(ids(applyFilterConditions(records, cfg([cond('fldAutoNum', 'isGreater', 5)]), metas))).toEqual(['recN1']);
    // 非数字编号（F-2024-0001）不带 number 语义 → 数值比较诚实返回不命中，不假装
    expect(ids(applyFilterConditions(records, cfg([cond('fldAutoNum', 'is', 'F-2024-0001')]), metas))).toEqual([
      'recN3',
    ]);
  });
});

/* ===================== 2. isNot / doesNotContain 含空值 ===================== */

const NOT_RECORDS: SdkRecord[] = [
  rec('recB1', { fldText: '已完成' }),
  rec('recB2', { fldText: '待处理' }),
  rec('recB3', { fldText: null }),
  rec('recB4', { fldText: '' }),
];

describe('filter/engine · isNot / doesNotContain 含空值（§22.10-③）', () => {
  it('isNot 命中空值记录：isNot 已完成 → recB2 + recB3(null) + recB4(空串)', () => {
    const result = applyFilterConditions(NOT_RECORDS, cfg([cond('fldText', 'isNot', '已完成')]), METAS);
    expect(ids(result)).toEqual(['recB2', 'recB3', 'recB4']);
  });

  it('对照：is 已完成 只命中 recB1（空值记录不命中 is）——锁定 is / isNot 的互补差异', () => {
    expect(ids(applyFilterConditions(NOT_RECORDS, cfg([cond('fldText', 'is', '已完成')]), METAS))).toEqual([
      'recB1',
    ]);
  });

  it('⭐ 边界（D2）：空字段 → normalize 得 `empty` 语义值（**不是** null）：is 判 noMatch、isNot 判 match', () => {
    // 证明 `evaluateConditionState` 的 `!nv → 'invalid'` 兜底**未**踩坏已冻结的空值语义：
    // 空字段（null / 空串 / 键缺失）经 `normalize()` 得到的是 `isEmpty: true` 的 empty 对象，
    // **不是** `null`，所以它走的是**正常求值**（而非「无效 → 跳过」）：
    //   - `is`    → noMatch（记录被筛掉，因为确实不等于）
    //   - `isNot` → match  （记录**命中**——朴素否定含空值的正面证据）
    const empty = rec('rEmpty', { fldText: null });
    const blank = rec('rBlank', { fldText: '' });
    expect(evaluateConditionState(cond('fldText', 'is', '已完成'), empty, METAS)).toBe('noMatch');
    expect(evaluateConditionState(cond('fldText', 'isNot', '已完成'), empty, METAS)).toBe('match');
    expect(evaluateConditionState(cond('fldText', 'is', '已完成'), blank, METAS)).toBe('noMatch');
    expect(evaluateConditionState(cond('fldText', 'isNot', '已完成'), blank, METAS)).toBe('match');
  });

  it('doesNotContain 命中空值记录：doesNotContain 完成 → recB2 + recB3 + recB4', () => {
    expect(
      ids(applyFilterConditions(NOT_RECORDS, cfg([cond('fldText', 'doesNotContain', '完成')]), METAS)),
    ).toEqual(['recB2', 'recB3', 'recB4']);
  });

  it('对照：contains 完成 只命中 recB1', () => {
    expect(
      ids(applyFilterConditions(NOT_RECORDS, cfg([cond('fldText', 'contains', '完成')]), METAS)),
    ).toEqual(['recB1']);
  });
});

/* ===================== 3. isEmpty vs 空字符串 ===================== */

const EMPTY_RECORDS: SdkRecord[] = [
  rec('recC1', { fldText: '' }),
  rec('recC2', { fldText: '   ' }), // 纯空白：normalize 判定为空
  rec('recC3', { fldText: null }),
  rec('recC4', {}), // 字段键缺失
  rec('recC5', { fldText: '0' }), // 文本 '0' 是**有值**
  rec('recC6', { fldText: undefined }),
];

describe('filter/engine · isEmpty 与空字符串同义（§22.4.3）', () => {
  it('isEmpty 命中「空串 / 纯空白 / null / undefined / 键缺失」，且**不**命中文本 0', () => {
    expect(ids(applyFilterConditions(EMPTY_RECORDS, cfg([cond('fldText', 'isEmpty')]), METAS))).toEqual([
      'recC1',
      'recC2',
      'recC3',
      'recC4',
      'recC6',
    ]);
  });

  it('isNotEmpty 只命中 recC5（文本 0）——证明「空串 == 空值」且 0 不是空', () => {
    expect(ids(applyFilterConditions(EMPTY_RECORDS, cfg([cond('fldText', 'isNotEmpty')]), METAS))).toEqual([
      'recC5',
    ]);
  });

  it('数字 0 不是空值：isNotEmpty 命中，isEmpty 不命中（与「屏幕上有 0」一致）', () => {
    const nums: SdkRecord[] = [rec('recZ0', { fldNumber: 0 }), rec('recZ1', { fldNumber: null })];
    expect(ids(applyFilterConditions(nums, cfg([cond('fldNumber', 'isNotEmpty')]), METAS))).toEqual([
      'recZ0',
    ]);
    expect(ids(applyFilterConditions(nums, cfg([cond('fldNumber', 'isEmpty')]), METAS))).toEqual(['recZ1']);
  });
});

/* ===================== 4. 数字与文本混排 ===================== */

const NUM_RECORDS: SdkRecord[] = [
  rec('recN1', { fldNumber: 1234.5 }),
  rec('recN2', { fldNumber: 1234 }),
  rec('recN3', { fldNumber: 999 }),
  rec('recN4', { fldNumber: null }),
  rec('recN5', { fldNumber: 'abc' }), // 脏数据：normalize → empty
  rec('recN6', { fldNumber: 0 }),
  rec('recN7', { fldNumber: 0.1 + 0.2 }), // 0.30000000000000004
  rec('recN8', { fldNumber: 0.31 }),
];

describe('filter/engine · 数字比较（§22.4.3 / §22.4.4）', () => {
  it('is 1234 只命中 recN2（1234.5 / 999 / 脏数据 / 空值均不命中）', () => {
    expect(ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'is', 1234)]), METAS))).toEqual([
      'recN2',
    ]);
  });

  it('数字字段传字符串值：is "1234" 与 is 1234 等价（都只命中 recN2）', () => {
    expect(ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'is', '1234')]), METAS))).toEqual([
      'recN2',
    ]);
  });

  it('isGreater 1000 → recN1 + recN2；999 与脏数据/空值不命中（诚实优先）', () => {
    expect(
      ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'isGreater', 1000)]), METAS)),
    ).toEqual(['recN1', 'recN2']);
  });

  it('isGreaterEqual 1234 → recN1 + recN2（边界含等号）', () => {
    expect(
      ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'isGreaterEqual', 1234)]), METAS)),
    ).toEqual(['recN1', 'recN2']);
  });

  it('isLess 1234 → recN3(999) + recN6(0) + recN7(0.3) + recN8(0.31)；isLessEqual 1234 再多一个 recN2', () => {
    expect(
      ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'isLess', 1234)]), METAS)),
    ).toEqual(['recN3', 'recN6', 'recN7', 'recN8']);
    expect(
      ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'isLessEqual', 1234)]), METAS)),
    ).toEqual(['recN2', 'recN3', 'recN6', 'recN7', 'recN8']);
  });

  it('±1e-9 容差：is 0.3 命中 0.1+0.2，且**不**命中 0.31', () => {
    expect(ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'is', 0.3)]), METAS))).toEqual([
      'recN7',
    ]);
  });

  it('脏数据不假装命中：recN5("abc") 与 recN4(null) 在任何数字算子下都不出现', () => {
    for (const operator of ['is', 'isGreater', 'isLess'] as FilterOperator[]) {
      const hit = ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', operator, 0)]), METAS));
      expect(hit).not.toContain('recN4');
      expect(hit).not.toContain('recN5');
    }
    expect(ids(applyFilterConditions(NUM_RECORDS, cfg([cond('fldNumber', 'isEmpty')]), METAS))).toEqual([
      'recN4',
      'recN5',
    ]);
  });
});

describe('filter/engine · 数字与文本混排（§22.4.3）', () => {
  const MIXED: SdkRecord[] = [
    rec('recX1', { fldText: '1234' }),
    rec('recX2', { fldText: '订单1234' }),
    rec('recX3', { fldText: '1234.5' }),
  ];

  it('文本字段传数字值：is 1234 只命中文本恰为 "1234" 的 recX1', () => {
    expect(ids(applyFilterConditions(MIXED, cfg([cond('fldText', 'is', 1234)]), METAS))).toEqual(['recX1']);
    expect(ids(applyFilterConditions(MIXED, cfg([cond('fldText', 'is', 1234.5)]), METAS))).toEqual([
      'recX3',
    ]);
  });

  it('文本字段 contains 数字：「1234」「订单1234」「1234.5」都含子串 1234，全部命中', () => {
    expect(ids(applyFilterConditions(MIXED, cfg([cond('fldText', 'contains', 1234)]), METAS))).toEqual([
      'recX1',
      'recX2',
      'recX3',
    ]);
  });

  it('对照：contains 12345 一条都不命中（证伪「永远放行」的实现）', () => {
    expect(ids(applyFilterConditions(MIXED, cfg([cond('fldText', 'contains', 12345)]), METAS))).toEqual([]);
  });
});

/* ===================== 5. 日期按天 ===================== */

const DATE_RECORDS: SdkRecord[] = [
  rec('recD1', { fldDate: ts('2024-05-01T09:30:00') }),
  rec('recD2', { fldDate: ts('2024-05-01T23:59:00') }),
  rec('recD3', { fldDate: ts('2024-05-02T00:00:00') }),
  rec('recD4', { fldDate: null }),
  rec('recD5', { fldDate: ts('2024-05-03T10:00:00') }),
  rec('recD6', { fldDate: ts('2024-04-30T23:59:00') }),
];

describe('filter/engine · 日期按天（§22.10-④ / §22.4.4）', () => {
  it('is 同一天：09:30 与 23:59 两条都命中，次日 00:00 与空值不命中', () => {
    const target = ts('2024-05-01T00:00:00');
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'is', target)]), METAS))).toEqual([
      'recD1',
      'recD2',
    ]);
  });

  it('is 可用「本地日期时间字符串」作目标值（与当天时间戳同义，不受时区影响）', () => {
    expect(
      ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'is', '2024-05-01T12:00:00')]), METAS)),
    ).toEqual(['recD1', 'recD2']);
  });

  it('isGreater（晚于）2024-05-01 = 次日 0 点及以后 → 只命中 recD3 + recD5', () => {
    const target = ts('2024-05-01T00:00:00');
    expect(
      ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'isGreater', target)]), METAS)),
    ).toEqual(['recD3', 'recD5']);
  });

  it('isLess（早于）2024-05-02 的边界：05-02T00:00 本身**不**命中', () => {
    const target = ts('2024-05-02T00:00:00');
    expect(evaluateCondition(cond('fldDate', 'isLess', target), rec('recD3', { fldDate: target }), METAS)).toBe(
      false,
    );
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'isLess', target)]), METAS))).toEqual([
      'recD1',
      'recD2',
      'recD6',
    ]);
  });

  /**
   * `isNot` 已按主理人裁定补进日期算子集（对齐原生「日期不等于某天」），
   * 故本条恢复为「按天取反 + 朴素否定含空值」的原语义断言。
   */
  it('日期 isNot 同样含空值：isNot 2024-05-01 → recD3 + recD4(null) + recD5 + recD6', () => {
    const target = ts('2024-05-01T00:00:00');
    expect(
      ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'isNot', target)]), METAS)),
    ).toEqual(['recD3', 'recD4', 'recD5', 'recD6']);
  });

  it('isNot 含空值的语义仍由**允许该算子**的类型锁定：单选 isNot 已完成 → recS2 + recS3(null)', () => {
    const selects: SdkRecord[] = [
      rec('recS1', { fldStatus: '已完成' }),
      rec('recS2', { fldStatus: '待处理' }),
      rec('recS3', { fldStatus: null }),
    ];
    expect(ids(applyFilterConditions(selects, cfg([cond('fldStatus', 'isNot', '已完成')]), METAS))).toEqual([
      'recS2',
      'recS3',
    ]);
  });

  it('日期 isEmpty 只命中 recD4', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fldDate', 'isEmpty')]), METAS))).toEqual([
      'recD4',
    ]);
  });
});

/* ===================== 6. 多选 / 成员 / 附件 ===================== */

describe('filter/engine · 多选「任一命中」语义（§22.4.3）', () => {
  const MULTI: SdkRecord[] = [
    rec('recM1', { fldMulti: ['VIP', '新客'] }),
    rec('recM2', { fldMulti: ['新客'] }),
    rec('recM3', { fldMulti: ['普通'] }),
    rec('recM4', { fldMulti: [] }),
  ];

  it('contains VIP → 只 recM1；contains 新客 → recM1 + recM2（任一项命中即命中）', () => {
    expect(ids(applyFilterConditions(MULTI, cfg([cond('fldMulti', 'contains', 'VIP')]), METAS))).toEqual([
      'recM1',
    ]);
    expect(ids(applyFilterConditions(MULTI, cfg([cond('fldMulti', 'contains', '新客')]), METAS))).toEqual([
      'recM1',
      'recM2',
    ]);
  });

  it('contains 客 → recM1 + recM2；「普通」不含「客」故 recM3 被排除', () => {
    expect(ids(applyFilterConditions(MULTI, cfg([cond('fldMulti', 'contains', '客')]), METAS))).toEqual([
      'recM1',
      'recM2',
    ]);
  });

  it('多选 isEmpty 只命中空数组 recM4；doesNotContain VIP 含空数组项', () => {
    expect(ids(applyFilterConditions(MULTI, cfg([cond('fldMulti', 'isEmpty')]), METAS))).toEqual(['recM4']);
    expect(
      ids(applyFilterConditions(MULTI, cfg([cond('fldMulti', 'doesNotContain', 'VIP')]), METAS)),
    ).toEqual(['recM2', 'recM3', 'recM4']);
  });
});

describe('filter/engine · 成员按显示名 / 附件仅空值', () => {
  const USERS: SdkRecord[] = [
    rec('recU1', { fldUser: [{ id: 'ou_1', name: '张三' }] }),
    rec('recU2', { fldUser: [{ id: 'ou_2', name: '李四' }] }),
    rec('recU3', { fldUser: [] }),
  ];

  it('成员 contains 按显示名匹配：命中 recU1，且不会把 id(ou_1) 暴露为可匹配文本', () => {
    expect(ids(applyFilterConditions(USERS, cfg([cond('fldUser', 'contains', '张三')]), METAS))).toEqual([
      'recU1',
    ]);
    expect(ids(applyFilterConditions(USERS, cfg([cond('fldUser', 'contains', 'ou_1')]), METAS))).toEqual([]);
  });

  it('成员 isEmpty 只命中空数组 recU3', () => {
    expect(ids(applyFilterConditions(USERS, cfg([cond('fldUser', 'isEmpty')]), METAS))).toEqual(['recU3']);
  });

  it('附件：isNotEmpty 命中 recF1，isEmpty 命中 recF2（附件只做空值判断）', () => {
    const files: SdkRecord[] = [
      rec('recF1', { fldAttach: [{ name: 'a.pdf', tmpUrl: 'https://x' }] }),
      rec('recF2', { fldAttach: [] }),
    ];
    expect(ids(applyFilterConditions(files, cfg([cond('fldAttach', 'isNotEmpty')]), METAS))).toEqual([
      'recF1',
    ]);
    expect(ids(applyFilterConditions(files, cfg([cond('fldAttach', 'isEmpty')]), METAS))).toEqual(['recF2']);
  });
});

/* ===================== 7. 复选框 ===================== */

describe('filter/engine · 复选框（§22.3 仅 is）', () => {
  const CHECKS: SdkRecord[] = [
    rec('recK1', { fldCheck: true }),
    rec('recK2', { fldCheck: false }),
    rec('recK3', {}), // 未填 → normalize 判为空
  ];

  it('is true → 只 recK1；is false → 只 recK2（未填的 recK3 两者都不命中）', () => {
    expect(ids(applyFilterConditions(CHECKS, cfg([cond('fldCheck', 'is', true)]), METAS))).toEqual([
      'recK1',
    ]);
    expect(ids(applyFilterConditions(CHECKS, cfg([cond('fldCheck', 'is', false)]), METAS))).toEqual([
      'recK2',
    ]);
  });

  it('复选框未填 = 为空：isEmpty 命中 recK3，isNotEmpty 命中 recK1 + recK2', () => {
    expect(ids(applyFilterConditions(CHECKS, cfg([cond('fldCheck', 'isEmpty')]), METAS))).toEqual(['recK3']);
    expect(ids(applyFilterConditions(CHECKS, cfg([cond('fldCheck', 'isNotEmpty')]), METAS))).toEqual([
      'recK1',
      'recK2',
    ]);
  });
});

/* ===================== 8. and / or ===================== */

describe('filter/engine · and 与 or 的差别（§22.4.1）', () => {
  const RECORDS: SdkRecord[] = [
    rec('recL1', { fldStatus: '已完成', fldNumber: 2000 }),
    rec('recL2', { fldStatus: '已完成', fldNumber: 500 }),
    rec('recL3', { fldStatus: '待处理', fldNumber: 3000 }),
    rec('recL4', { fldStatus: '待处理', fldNumber: 100 }),
  ];
  const conditions: FilterCondition[] = [
    cond('fldStatus', 'is', '已完成'),
    cond('fldNumber', 'isGreater', 1000),
  ];

  it("and → 只 recL1（两条都满足）", () => {
    expect(ids(applyFilterConditions(RECORDS, cfg(conditions, 'and'), METAS))).toEqual(['recL1']);
  });

  it('or → recL1 + recL2 + recL3；recL4 两条都不满足，必须被排除', () => {
    expect(ids(applyFilterConditions(RECORDS, cfg(conditions, 'or'), METAS))).toEqual([
      'recL1',
      'recL2',
      'recL3',
    ]);
  });

  it('同一组条件在 and / or 下结果不同（证伪「忽略 conjunction」的实现）', () => {
    const andResult = ids(applyFilterConditions(RECORDS, cfg(conditions, 'and'), METAS));
    const orResult = ids(applyFilterConditions(RECORDS, cfg(conditions, 'or'), METAS));
    expect(andResult).not.toEqual(orResult);
    expect(orResult.length).toBeGreaterThan(andResult.length);
  });

  it('evaluateFilter 单条：命中/不命中各自锁定', () => {
    expect(evaluateFilter(cfg(conditions, 'and'), RECORDS[0], METAS)).toBe(true);
    expect(evaluateFilter(cfg(conditions, 'and'), RECORDS[1], METAS)).toBe(false);
    expect(evaluateFilter(cfg(conditions, 'or'), RECORDS[1], METAS)).toBe(true);
    expect(evaluateFilter(cfg(conditions, 'or'), RECORDS[3], METAS)).toBe(false);
  });

  it('空条件列表 → evaluateFilter 返回 true（无可求值条件 = 不筛选，D4 新口径）', () => {
    // D4：`conditions` 为空 = 没有任何可求值条件 → 不筛选 → 保留记录（旧「空 → false」口径已作废）
    expect(evaluateFilter(cfg([]), RECORDS[0], METAS)).toBe(true);
    expect(evaluateFilter(cfg([], 'or'), RECORDS[0], METAS)).toBe(true);
  });

  it('字段已删除的坏条件被跳过，其余 or / and 条件照常求值（用例名此前与 fixture 不符，已重建）', () => {
    // 坏条件：fldGone 不在 METAS → invalid（应被**跳过**，绝不参与 and / or）
    const bad: FilterCondition = cond('fldGone', 'is', 'x');
    // 有效但**不命中**：RECORDS[0].fldStatus === '已完成'，候选 '待处理' → noMatch
    const noMatch: FilterCondition = cond('fldStatus', 'is', '待处理');
    // 有效且命中：'已完成' → match
    const match: FilterCondition = cond('fldStatus', 'is', '已完成');

    // ① or：有效条件数为 1 且为 noMatch → some(match) = false
    expect(evaluateFilter(cfg([bad, noMatch], 'or'), RECORDS[0], METAS)).toBe(false);
    // ② 对照 or：换成命中条件 → true（证明坏条件被跳过、其余条件照常参与求值）
    expect(evaluateFilter(cfg([bad, match], 'or'), RECORDS[0], METAS)).toBe(true);
    // ③ ⭐「跳过」与「当 noMatch」的关键区分：若坏条件被误判成 noMatch，and 会得 false；
    //    只有真正**被跳过**，`and` 在仅剩的 match 上才得 true。
    expect(evaluateFilter(cfg([bad, match], 'and'), RECORDS[0], METAS)).toBe(true);
  });
});

/* ===================== 9. 主入口与防御 ===================== */

describe('filter/engine · applyFilterConditions 契约', () => {
  const RECORDS: SdkRecord[] = [
    rec('rec1', { fldStatus: '已完成' }),
    rec('rec2', { fldStatus: '待处理' }),
  ];

  it('无条件 → 返回**入参原引用**（便于 React memo）', () => {
    expect(applyFilterConditions(RECORDS, cfg([]), METAS)).toBe(RECORDS);
    expect(applyFilterConditions(RECORDS, null, METAS)).toBe(RECORDS);
    expect(applyFilterConditions(RECORDS, undefined, METAS)).toBe(RECORDS);
  });

  it('enabled === false → 同样视为不筛，返回原引用', () => {
    expect(applyFilterConditions(RECORDS, cfg([cond('fldStatus', 'is', '已完成')], 'and', false), METAS)).toBe(
      RECORDS,
    );
  });

  it('有条件 → 返回**新数组**，且命中保留 / 未命中排除（双向断言）', () => {
    const result = applyFilterConditions(RECORDS, cfg([cond('fldStatus', 'is', '已完成')]), METAS);
    expect(result).not.toBe(RECORDS);
    expect(ids(result)).toEqual(['rec1']);
    expect(ids(RECORDS)).toEqual(['rec1', 'rec2']); // 入参不被修改
  });

  it('records 非数组 / null → 返回空数组，不抛异常', () => {
    expect(applyFilterConditions(null as unknown as SdkRecord[], cfg([cond('fldStatus', 'is', 'x')]), METAS)).toEqual(
      [],
    );
    expect(applyFilterConditions(undefined as unknown as SdkRecord[], cfg([]), METAS)).toEqual([]);
  });

  it('isFilterActive：有条件且 enabled 非显式 false → true；空条件 / null / enabled=false → false', () => {
    expect(isFilterActive(cfg([cond('fldStatus', 'is', 'x')]))).toBe(true);
    expect(isFilterActive(cfg([]))).toBe(false);
    expect(isFilterActive(null)).toBe(false);
    expect(isFilterActive(cfg([cond('fldStatus', 'is', 'x')], 'and', false))).toBe(false);
  });
});

describe('filter/engine · 非法输入不上抛', () => {
  const record = rec('rec1', { fldText: 'ABC' });

  it('条件为 null / 记录为空 / 字段缺失 → false', () => {
    expect(evaluateCondition(null, record, METAS)).toBe(false);
    expect(evaluateCondition(cond('fldText', 'is', 'ABC'), null, METAS)).toBe(false);
    expect(evaluateCondition(cond('fldText', 'is', 'ABC'), undefined, METAS)).toBe(false);
    expect(evaluateCondition(cond('fldNope', 'is', 'ABC'), record, METAS)).toBe(false);
  });

  it('未知算子（未净化输入）→ 条件判为 invalid 被跳过，记录保留，不抛异常', () => {
    const bogus = cond('fldText', 'startsWith' as FilterOperator, 'A');
    expect(evaluateCondition(bogus, record, METAS)).toBe(false); // 布尔版：invalid 亦为 false
    expect(evaluateConditionState(bogus, record, METAS)).toBe('invalid');
    // ⭐ 全表只剩这一条无效条件 → 不筛选，记录必须保留（绝不能返回空数组）
    expect(ids(applyFilterConditions([record], cfg([bogus]), METAS))).toEqual(['rec1']);
  });
});

/* ===================== 10. computeFilterScope ===================== */

describe('filter/engine · computeFilterScope（§22.11 不假绿）', () => {
  const active = cfg([cond('fldStatus', 'is', '已完成')]);

  it('hasMore=true → fullCoverage=false（绝不允许声称全量）', () => {
    expect(computeFilterScope(active, 200, 37, 12480, true)).toEqual({
      active: true,
      loaded: 200,
      matched: 37,
      total: 12480,
      hasMore: true,
      fullCoverage: false,
    });
  });

  it('hasMore=false → fullCoverage=true（此时才可称全量）', () => {
    const scope = computeFilterScope(active, 12480, 37, 12480, false);
    expect(scope.fullCoverage).toBe(true);
    expect(scope.hasMore).toBe(false);
  });

  it('未筛（空条件）→ active=false，计数照实回填', () => {
    expect(computeFilterScope(cfg([]), 200, 200, 12480, true)).toEqual({
      active: false,
      loaded: 200,
      matched: 200,
      total: 12480,
      hasMore: true,
      fullCoverage: false,
    });
  });

  it('脏计数（NaN / 负数 / 小数）→ 收敛为非负整数', () => {
    const scope = computeFilterScope(active, Number.NaN, -5, 12.7, true);
    expect(scope.loaded).toBe(0);
    expect(scope.matched).toBe(0);
    expect(scope.total).toBe(12);
  });
});

/* ===================== 11. 无效条件：数据可见性优先（主理人裁定） ===================== */

const INVALID_RECORDS: SdkRecord[] = [
  rec('recY1', { fldStatus: '已完成', fldText: 'ABC' }),
  rec('recY2', { fldStatus: '待处理', fldText: 'ABC' }),
  rec('recY3', { fldStatus: '已完成', fldText: 'ZZZ' }),
];

/** 未知算子（模拟未来新增算子 / 未净化配置） */
const BOGUS: FilterCondition = cond('fldText', 'startsWith' as FilterOperator, 'A');

describe('filter/engine · 无效条件被跳过，记录绝不凭空消失', () => {
  it('未知算子 + and：其余有效条件仍生效 → recY1 + recY3，且结果**不是空数组**', () => {
    const result = applyFilterConditions(
      INVALID_RECORDS,
      cfg([cond('fldStatus', 'is', '已完成'), BOGUS], 'and'),
      METAS,
    );
    expect(ids(result)).toEqual(['recY1', 'recY3']);
    // 反证：若坏条件被当成 false，and 的结果会是 []（数据集体消失）
    expect(ids(result)).not.toEqual([]);
  });

  it('未知算子 + or：其余有效条件仍生效 → recY1 + recY3，且**没有全放行**（recY2 仍被排除）', () => {
    const result = applyFilterConditions(
      INVALID_RECORDS,
      cfg([cond('fldStatus', 'is', '已完成'), BOGUS], 'or'),
      METAS,
    );
    expect(ids(result)).toEqual(['recY1', 'recY3']);
    expect(ids(result)).not.toContain('recY2');
  });

  it('全部条件都无效 → 不筛选：返回**入参原引用**，顺序与内容都不变', () => {
    const secondBogus = cond('fldStatus', 'regex' as FilterOperator, 'X');
    const result = applyFilterConditions(INVALID_RECORDS, cfg([BOGUS, secondBogus]), METAS);
    expect(result).toBe(INVALID_RECORDS);
    expect(ids(result)).toEqual(['recY1', 'recY2', 'recY3']);
  });

  it('某条记录的字段访问抛异常 → 该记录仍在结果中（数据不凭空消失）', () => {
    const poisoned = {
      recordId: 'recP1',
      get fields(): Record<string, unknown> {
        throw new Error('字段访问异常（模拟脏数据）');
      },
    } as unknown as SdkRecord;
    const records: SdkRecord[] = [
      rec('recG1', { fldStatus: '已完成' }),
      poisoned,
      rec('recG2', { fldStatus: '待处理' }),
    ];

    // 该条件对 poisoned 记录无法求值 → 判定为 invalid → 跳过 → 记录保留
    expect(evaluateConditionState(cond('fldStatus', 'is', '已完成'), poisoned, METAS)).toBe('invalid');
    expect(ids(applyFilterConditions(records, cfg([cond('fldStatus', 'is', '已完成')]), METAS))).toEqual([
      'recG1',
      'recP1',
    ]);
    expect(ids(records)).toEqual(['recG1', 'recP1', 'recG2']); // 入参未被修改
  });

  it('三态区分：命中 / 不命中 / 无效 三种结果各自锁定', () => {
    const valid = cond('fldText', 'is', 'ABC');
    expect(evaluateConditionState(valid, rec('r1', { fldText: 'ABC' }), METAS)).toBe('match');
    expect(evaluateConditionState(valid, rec('r2', { fldText: 'abc' }), METAS)).toBe('noMatch');
    expect(evaluateConditionState(BOGUS, rec('r3', { fldText: 'ABC' }), METAS)).toBe('invalid');
    expect(evaluateConditionState(null, rec('r4', { fldText: 'ABC' }), METAS)).toBe('invalid');
  });

  it('布尔版 evaluateCondition 对 invalid 返回 false（仅 evaluateFilter 会跳过它）', () => {
    expect(evaluateCondition(BOGUS, rec('r5', { fldText: 'ABC' }), METAS)).toBe(false);
    // `metas` 必填后：完整判定用 `isConditionValid(cond, metas)`，仅算子校验用 `isOperatorKnown(cond)`
    expect(isConditionValid(BOGUS, METAS)).toBe(false);
    expect(isConditionValid(cond('fldText', 'is', 'ABC'), METAS)).toBe(true);
    expect(isOperatorKnown(BOGUS)).toBe(false);
    expect(isOperatorKnown(cond('fldText', 'is', 'ABC'))).toBe(true);
    expect(isOperatorKnown(null)).toBe(false);
  });
});

describe('filter/engine · 算子已知但类型不匹配 → 判为 invalid（跳过，绝不筛掉记录）', () => {
  const TYPED: SdkRecord[] = [
    rec('recT1', { fldNumber: 1234 }),
    rec('recT2', { fldNumber: 999 }),
  ];

  it('数字字段 + contains（矩阵不允许）→ invalid 被跳过，两条记录**全部保留**', () => {
    const mismatched = cond('fldNumber', 'contains', 123);
    expect(evaluateConditionState(mismatched, TYPED[0], METAS)).toBe('invalid');
    expect(ids(applyFilterConditions(TYPED, cfg([mismatched]), METAS))).toEqual(['recT1', 'recT2']);
  });

  it('对照：数字字段 + is（矩阵允许）→ 正常求值，只保留 recT1', () => {
    expect(ids(applyFilterConditions(TYPED, cfg([cond('fldNumber', 'is', 1234)]), METAS))).toEqual([
      'recT1',
    ]);
  });

  it('文本字段 + isGreater（矩阵不允许）→ invalid；与有效条件 and 时不影响有效条件生效', () => {
    const mixed: SdkRecord[] = [
      rec('recV1', { fldStatus: '已完成', fldText: 'ABC' }),
      rec('recV2', { fldStatus: '待处理', fldText: 'ABC' }),
    ];
    const result = applyFilterConditions(
      mixed,
      cfg([cond('fldStatus', 'is', '已完成'), cond('fldText', 'isGreater', 1)], 'and'),
      METAS,
    );
    expect(ids(result)).toEqual(['recV1']);
  });

  it('豁免：isEmpty / isNotEmpty 与类型无关，复选框上的空值判断仍按语义求值（只 recK3）', () => {
    const checks: SdkRecord[] = [
      rec('recK1', { fldCheck: true }),
      rec('recK2', { fldCheck: false }),
      rec('recK3', {}),
    ];
    expect(evaluateConditionState(cond('fldCheck', 'isEmpty'), checks[2], METAS)).toBe('match');
    expect(ids(applyFilterConditions(checks, cfg([cond('fldCheck', 'isEmpty')]), METAS))).toEqual([
      'recK3',
    ]);
  });
});
