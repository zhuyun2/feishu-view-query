/**
 * QA-F2 独立复核用例（工程：`src/filter/` 的算子矩阵 + 求值引擎）。
 *
 * 本文件由 QA（software-qa-engineer-f2）**在不知道实现细节的前提下**按
 * `03-开发设计文档.md §22`（§22.3 算子矩阵 / §22.4 求值引擎 / §22.4.5 三态语义 / §22.0.1 裁定一览）
 * 独立编写，**不 import 工程师既有测试里的任何常量**，期望值全部**手写死值**。
 *
 * 断言纪律：
 * - 一律断言**具体 recordId 序列**（`toEqual([...])`），每条筛选都构造「命中组 + 不命中对照组」；
 * - 「条件无效」一律用 `evaluateConditionState()` 断言 `'invalid'` **或**断言 `applyFilterConditions` 保留记录，
 *   **绝不**只用布尔版 `.toBe(false)`（§22.4.5 明令：那会与 `noMatch` 混淆，属无法证伪的假绿）；
 * - 文末「回归守卫」组是 QA 复核发现的 4 处偏差（曾以 `it.skip` 冻结举证），实现方于 2026-09-21 20:01 修复后
 *   已取消 skip 转为常驻回归守卫。
 */
import { describe, expect, it } from 'vitest';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldTypeValue } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { getRecordId } from '@/data/RecordDataSource';
import { ALL_FILTER_OPERATORS as WHITELIST_IN_SANITIZE } from './sanitize';
import type { FilterCondition, FilterConfig, FilterConjunction, FilterOperator } from './types';
import {
  ALL_FILTER_OPERATORS,
  OPERATOR_MATRIX,
  defaultOperatorForType,
  getOperatorsForType,
  isFilterableFieldType,
  isKnownOperator,
  isOperatorAllowed,
  resolveOperatorForType,
} from './operatorMatrix';
import {
  applyFilterConditions,
  evaluateConditionState,
  evaluateFilter,
  isConditionValid,
  isOperatorKnown,
} from './engine';
import type { FieldMetaMap } from './engine';

/* ===================== 脚手架（QA 自有，不复用工程师 fixture） ===================== */

const M: FieldMetaMap = {
  fText: { id: 'fText', name: '文本', type: FieldType.Text, isPrimary: true },
  fPhone: { id: 'fPhone', name: '电话', type: FieldType.Phone, isPrimary: false },
  fUrl: { id: 'fUrl', name: '链接', type: FieldType.Url, isPrimary: false },
  fBarcode: { id: 'fBarcode', name: '条码', type: FieldType.Barcode, isPrimary: false },
  fNum: { id: 'fNum', name: '数字', type: FieldType.Number, isPrimary: false },
  fAutoNum: { id: 'fAutoNum', name: '自动编号', type: FieldType.AutoNumber, isPrimary: false },
  fCurrency: { id: 'fCurrency', name: '货币', type: FieldType.Currency, isPrimary: false },
  fRating: { id: 'fRating', name: '评分', type: FieldType.Rating, isPrimary: false },
  fProgress: { id: 'fProgress', name: '进度', type: FieldType.Progress, isPrimary: false },
  fSingle: { id: 'fSingle', name: '单选', type: FieldType.SingleSelect, isPrimary: false },
  fMulti: { id: 'fMulti', name: '多选', type: FieldType.MultiSelect, isPrimary: false },
  fDate: { id: 'fDate', name: '日期', type: FieldType.DateTime, isPrimary: false },
  fCreatedTime: { id: 'fCreatedTime', name: '创建时间', type: FieldType.CreatedTime, isPrimary: false },
  fModifiedTime: { id: 'fModifiedTime', name: '修改时间', type: FieldType.ModifiedTime, isPrimary: false },
  fCheck: { id: 'fCheck', name: '复选框', type: FieldType.Checkbox, isPrimary: false },
  fUser: { id: 'fUser', name: '成员', type: FieldType.User, isPrimary: false },
  fCreatedUser: { id: 'fCreatedUser', name: '创建人', type: FieldType.CreatedUser, isPrimary: false },
  fModifiedUser: { id: 'fModifiedUser', name: '修改人', type: FieldType.ModifiedUser, isPrimary: false },
  fGroupChat: { id: 'fGroupChat', name: '群聊', type: FieldType.GroupChat, isPrimary: false },
  fAttach: { id: 'fAttach', name: '附件', type: FieldType.Attachment, isPrimary: false },
  fLink: { id: 'fLink', name: '单向关联', type: FieldType.Link, isPrimary: false },
  fDuplexLink: { id: 'fDuplexLink', name: '双向关联', type: FieldType.DuplexLink, isPrimary: false },
  fLookup: { id: 'fLookup', name: '查找引用', type: FieldType.Lookup, isPrimary: false },
  fLocation: { id: 'fLocation', name: '地理位置', type: FieldType.Location, isPrimary: false },
  fFormula: { id: 'fFormula', name: '公式', type: FieldType.Formula, isPrimary: false },
};

function rec(recordId: string, fields: Record<string, unknown> = {}): SdkRecord {
  return { recordId, fields } as unknown as SdkRecord;
}

function ids(records: readonly SdkRecord[]): string[] {
  return records.map((item) => getRecordId(item));
}

function cond(fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  const condition: FilterCondition = { conditionId: `q_${fieldId}_${operator}`, fieldId, operator };
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

/** 本地时间戳：`new Date(y, m-1, d, hh, mm, ss, ms)` —— 与「按本地天」口径一致 */
function at(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

/* ===================== A. contains / is 区分大小写（§22.10-②） ===================== */

const CASE_RECORDS: SdkRecord[] = [
  rec('a1', { fText: 'Alpha' }),
  rec('a2', { fText: 'alpha' }),
  rec('a3', { fText: 'AlPhaX' }),
  rec('a4', { fText: null }),
];

describe('QA-F2 · 文本 is / contains 区分大小写', () => {
  it("is 'Alpha' 只命中 a1；改成 'alpha' 只命中 a2（大小写敏感）", () => {
    expect(ids(applyFilterConditions(CASE_RECORDS, cfg([cond('fText', 'is', 'Alpha')]), M))).toEqual([
      'a1',
    ]);
    expect(ids(applyFilterConditions(CASE_RECORDS, cfg([cond('fText', 'is', 'alpha')]), M))).toEqual([
      'a2',
    ]);
  });

  it("contains 'A' → a1 + a3（小写 alpha 不含大写 A 故 a2 被排除；空值 a4 被排除）", () => {
    expect(ids(applyFilterConditions(CASE_RECORDS, cfg([cond('fText', 'contains', 'A')]), M))).toEqual([
      'a1',
      'a3',
    ]);
  });

  it("contains 'Pha' → 只 a3（AlPhaX 的大写 P；a1/a2 的 'lpha' 小写不命中）", () => {
    expect(ids(applyFilterConditions(CASE_RECORDS, cfg([cond('fText', 'contains', 'Pha')]), M))).toEqual([
      'a3',
    ]);
  });

  it('多选（走 items 分支）同样区分大小写：contains VIP 命中，contains vip 不命中', () => {
    const multi: SdkRecord[] = [
      rec('m1', { fMulti: ['VIP', 'New'] }),
      rec('m2', { fMulti: ['vip'] }),
      rec('m3', { fMulti: [] }),
    ];
    expect(ids(applyFilterConditions(multi, cfg([cond('fMulti', 'contains', 'VIP')]), M))).toEqual(['m1']);
    expect(ids(applyFilterConditions(multi, cfg([cond('fMulti', 'contains', 'vip')]), M))).toEqual(['m2']);
  });

  it('单选（items 分支）区分大小写：is/isNot 皆为严格相等', () => {
    const single: SdkRecord[] = [rec('s1', { fSingle: 'Done' }), rec('s2', { fSingle: 'done' })];
    expect(ids(applyFilterConditions(single, cfg([cond('fSingle', 'is', 'Done')]), M))).toEqual(['s1']);
    expect(ids(applyFilterConditions(single, cfg([cond('fSingle', 'isNot', 'Done')]), M))).toEqual(['s2']);
  });
});

/* ===================== B. isNot / doesNotContain 含空值（§22.10-③） ===================== */

const NULLISH_RECORDS: SdkRecord[] = [
  rec('n1', { fText: '甲' }),
  rec('n2', { fText: null }),
  rec('n3', { fText: '' }),
  rec('n4', {}), // 字段键缺失
  rec('n5', { fText: '   ' }), // 纯空白 = 空值
  rec('n6', { fText: '乙' }),
];

describe('QA-F2 · isNot / doesNotContain 含空值（朴素否定）', () => {
  it("isNot '甲' → n2/n3/n4/n5/n6（四类空值全命中），只排除 n1", () => {
    expect(ids(applyFilterConditions(NULLISH_RECORDS, cfg([cond('fText', 'isNot', '甲')]), M))).toEqual([
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
    ]);
  });

  it("doesNotContain '甲' → 与 isNot 同集合（n2/n3/n4/n5/n6）", () => {
    expect(
      ids(applyFilterConditions(NULLISH_RECORDS, cfg([cond('fText', 'doesNotContain', '甲')]), M)),
    ).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it("对照组：is '甲' 与 contains '甲' 都只命中 n1（空值记录绝不能被正向算子命中）", () => {
    expect(ids(applyFilterConditions(NULLISH_RECORDS, cfg([cond('fText', 'is', '甲')]), M))).toEqual([
      'n1',
    ]);
    expect(ids(applyFilterConditions(NULLISH_RECORDS, cfg([cond('fText', 'contains', '甲')]), M))).toEqual(
      ['n1'],
    );
  });

  it('多选空数组与键缺失同属空值：doesNotContain VIP → m2 + m3', () => {
    const multi: SdkRecord[] = [
      rec('m1', { fMulti: ['VIP'] }),
      rec('m2', { fMulti: [] }),
      rec('m3', {}),
    ];
    expect(ids(applyFilterConditions(multi, cfg([cond('fMulti', 'doesNotContain', 'VIP')]), M))).toEqual([
      'm2',
      'm3',
    ]);
  });
});

/* ===================== C. 日期按本地天（§22.10-④ / §22.4.4） ===================== */

const DATE_RECORDS: SdkRecord[] = [
  rec('d1', { fDate: at(2024, 5, 1, 0, 0, 0, 0) }),
  rec('d2', { fDate: at(2024, 5, 1, 9, 30, 0, 0) }),
  rec('d3', { fDate: at(2024, 5, 1, 23, 59, 59, 999) }),
  rec('d4', { fDate: at(2024, 5, 2, 0, 0, 0, 0) }), // 次日 0 点（边界）
  rec('d5', { fDate: at(2024, 4, 30, 23, 59, 59, 0) }), // 前一日末刻（边界）
  rec('d6', { fDate: null }),
  rec('d7', {}),
];

describe('QA-F2 · 日期「按天」粒度', () => {
  const noonday = at(2024, 5, 1, 12, 0, 0, 0);

  it('is 同一天：00:00 / 09:30 / 23:59:59.999 三条全命中；目标值带 12:00 也不影响', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'is', noonday)]), M))).toEqual([
      'd1',
      'd2',
      'd3',
    ]);
  });

  it('is 的目标值可写日期字符串 / 当日任意时刻，结果与时间戳同义', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'is', '2024-05-01')]), M))).toEqual([
      'd1',
      'd2',
      'd3',
    ]);
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'is', at(2024, 5, 1, 23, 0))]), M))).toEqual(
      ['d1', 'd2', 'd3'],
    );
  });

  it('is 不含次日 00:00（d4）与前一日 23:59:59（d5）——证伪「只按自然日字符串前缀」的实现', () => {
    const hit = ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'is', noonday)]), M));
    expect(hit).not.toContain('d4');
    expect(hit).not.toContain('d5');
  });

  it('isNot 是 is 的朴素否定且含空值：→ d4 + d5 + d6 + d7', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'isNot', noonday)]), M))).toEqual([
      'd4',
      'd5',
      'd6',
      'd7',
    ]);
  });

  it('isGreater（晚于）= 次日 0 点及以后 → 只 d4；d3（当日 23:59:59.999）不算晚于', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'isGreater', noonday)]), M))).toEqual([
      'd4',
    ]);
  });

  it('isLess（早于）= 当日 0 点之前 → 只 d5；d1（当日 00:00）不算早于', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'isLess', noonday)]), M))).toEqual([
      'd5',
    ]);
  });

  it('跨月边界：目标是 2024-01-31 时「次日 0 点」应为 2024-02-01（不能写成 +86400000 的简化实现）', () => {
    const boundary: SdkRecord[] = [
      rec('e1', { fDate: at(2024, 1, 31, 23, 0, 0, 0) }),
      rec('e2', { fDate: at(2024, 2, 1, 0, 0, 0, 0) }),
      rec('e3', { fDate: at(2024, 2, 1, 8, 0, 0, 0) }),
    ];
    const target = at(2024, 1, 31, 12, 0, 0, 0);
    expect(ids(applyFilterConditions(boundary, cfg([cond('fDate', 'is', target)]), M))).toEqual(['e1']);
    expect(ids(applyFilterConditions(boundary, cfg([cond('fDate', 'isGreater', target)]), M))).toEqual([
      'e2',
      'e3',
    ]);
    expect(ids(applyFilterConditions(boundary, cfg([cond('fDate', 'isLess', target)]), M))).toEqual([]);
  });

  it('创建时间 / 修改时间（1001 / 1002）与 DateTime 走同一按天语义', () => {
    const timeRows: SdkRecord[] = [
      rec('t1', { fCreatedTime: at(2024, 5, 1, 7, 0, 0, 0) }),
      rec('t2', { fCreatedTime: at(2024, 5, 2, 7, 0, 0, 0) }),
    ];
    expect(
      ids(applyFilterConditions(timeRows, cfg([cond('fCreatedTime', 'is', at(2024, 5, 1))]), M)),
    ).toEqual(['t1']);
    const modRows: SdkRecord[] = [
      rec('t3', { fModifiedTime: at(2024, 5, 1, 22, 0, 0, 0) }),
      rec('t4', { fModifiedTime: at(2024, 5, 2, 1, 0, 0, 0) }),
    ];
    expect(ids(applyFilterConditions(modRows, cfg([cond('fModifiedTime', 'is', at(2024, 5, 1))]), M))).toEqual(
      ['t3'],
    );
  });

  it('日期 isEmpty 只命中空值 d6 + d7', () => {
    expect(ids(applyFilterConditions(DATE_RECORDS, cfg([cond('fDate', 'isEmpty')]), M))).toEqual([
      'd6',
      'd7',
    ]);
  });
});

/* ===================== D. 复选框：算子集恰为 ['is']（§22.3 / §22.0.1-④） ===================== */

const CHECK_RECORDS: SdkRecord[] = [
  rec('k1', { fCheck: true }),
  rec('k2', { fCheck: false }),
  rec('k3', {}),
];

describe('QA-F2 · 复选框', () => {
  it('is true → 只 k1；is false → 只 k2；未填 k3 两者都不命中', () => {
    expect(ids(applyFilterConditions(CHECK_RECORDS, cfg([cond('fCheck', 'is', true)]), M))).toEqual(['k1']);
    expect(ids(applyFilterConditions(CHECK_RECORDS, cfg([cond('fCheck', 'is', false)]), M))).toEqual(['k2']);
  });

  it("矩阵层面：复选框算子集恰为 ['is']，不含 isEmpty / isNotEmpty（唯一例外）", () => {
    expect([...getOperatorsForType(FieldType.Checkbox)]).toEqual(['is']);
    expect(isOperatorAllowed(FieldType.Checkbox, 'isEmpty')).toBe(false);
    expect(isOperatorAllowed(FieldType.Checkbox, 'isNotEmpty')).toBe(false);
    expect(isOperatorAllowed(FieldType.Checkbox, 'isNot')).toBe(false);
    expect(defaultOperatorForType(FieldType.Checkbox)).toBe('is');
  });

  it('复选框 + isNot（矩阵不允许）→ invalid 被跳过，三条记录**全部保留**（绝不静默消失）', () => {
    const bad = cond('fCheck', 'isNot', true);
    expect(evaluateConditionState(bad, CHECK_RECORDS[0], M)).toBe('invalid');
    expect(ids(applyFilterConditions(CHECK_RECORDS, cfg([bad]), M))).toEqual(['k1', 'k2', 'k3']);
  });

  it('复选框 + contains（矩阵不允许）→ invalid 被跳过，记录全部保留', () => {
    const bad = cond('fCheck', 'contains', 'true');
    expect(evaluateConditionState(bad, CHECK_RECORDS[0], M)).toBe('invalid');
    expect(ids(applyFilterConditions(CHECK_RECORDS, cfg([bad]), M))).toEqual(['k1', 'k2', 'k3']);
  });

  it('豁免：isEmpty/isNotEmpty 对复选框仍按语义求值 → isEmpty 只命中 k3', () => {
    expect(evaluateConditionState(cond('fCheck', 'isEmpty'), CHECK_RECORDS[2], M)).toBe('match');
    expect(evaluateConditionState(cond('fCheck', 'isEmpty'), CHECK_RECORDS[0], M)).toBe('noMatch');
    expect(ids(applyFilterConditions(CHECK_RECORDS, cfg([cond('fCheck', 'isEmpty')]), M))).toEqual(['k3']);
  });
});

/* ===================== E. 类型 × 算子不匹配 → invalid → 记录保留（§22.3.2 / §22.4.5） ===================== */

describe('QA-F2 · 类型 × 算子不匹配 → invalid（跳过而非筛掉）', () => {
  it('矩阵否决的组合逐条判 invalid（不是 noMatch）', () => {
    const cases: Array<[string, FilterOperator]> = [
      ['fNum', 'contains'],
      ['fNum', 'doesNotContain'],
      ['fText', 'isGreater'],
      ['fText', 'isLessEqual'],
      ['fSingle', 'isGreaterEqual'],
      ['fDate', 'contains'],
      ['fDate', 'doesNotContain'],
      ['fDate', 'isGreaterEqual'],
      ['fCheck', 'isNot'],
      ['fAttach', 'is'],
      ['fAttach', 'contains'],
      ['fUser', 'is'],
      ['fUser', 'isNot'],
      ['fUser', 'isGreater'],
      ['fFormula', 'is'],
      ['fFormula', 'isGreater'],
      ['fLink', 'is'],
      ['fLocation', 'isNot'],
    ];
    for (const [fieldId, operator] of cases) {
      expect(
        evaluateConditionState(cond(fieldId, operator, 1), rec('probe', { [fieldId]: 'x' }), M),
        `${fieldId} + ${operator} 应被判 invalid`,
      ).toBe('invalid');
    }
  });

  it('对照：同一批字段换成矩阵允许的算子，立刻变为可求值（match/noMatch 二选一，绝不是 invalid）', () => {
    const cases: Array<[string, FilterOperator]> = [
      ['fNum', 'isGreater'],
      ['fText', 'contains'],
      ['fSingle', 'is'],
      ['fDate', 'is'],
      ['fCheck', 'is'],
      ['fAttach', 'isEmpty'],
      ['fUser', 'contains'],
      ['fFormula', 'contains'],
      ['fLink', 'contains'],
      ['fLocation', 'doesNotContain'],
    ];
    for (const [fieldId, operator] of cases) {
      const state = evaluateConditionState(cond(fieldId, operator, 'x'), rec('probe', { [fieldId]: 'x' }), M);
      expect(['match', 'noMatch'], `${fieldId} + ${operator} 应可求值`).toContain(state);
    }
  });

  it('类型不匹配的条件在 and 组里不会清空结果：有效条件照常生效', () => {
    const rows: SdkRecord[] = [
      rec('v1', { fText: 'Alpha', fNum: 10 }),
      rec('v2', { fText: 'Beta', fNum: 20 }),
    ];
    expect(
      ids(
        applyFilterConditions(
          rows,
          cfg([cond('fText', 'is', 'Alpha'), cond('fNum', 'contains', '1')], 'and'),
          M,
        ),
      ),
    ).toEqual(['v1']);
  });

  it('整组条件全部类型不匹配 → 记录**全部保留**（且返回入参原引用，见 [D3]）', () => {
    const rows: SdkRecord[] = [rec('v1', { fText: 'Alpha' }), rec('v2', { fText: 'Beta' })];
    expect(ids(applyFilterConditions(rows, cfg([cond('fNum', 'contains', '1')]), M))).toEqual(['v1', 'v2']);
  });

  it(' contrast：把同一条件换成矩阵允许的算子 → 结果必须真的收窄（证伪「一律放行」的实现）', () => {
    const rows: SdkRecord[] = [
      rec('v1', { fNum: 10 }),
      rec('v2', { fNum: 20 }),
    ];
    expect(ids(applyFilterConditions(rows, cfg([cond('fNum', 'is', 10)]), M))).toEqual(['v1']);
  });
});

/* ===================== F. 三态语义 + 数据可见性优先（§22.4.5） ===================== */

describe('QA-F2 · 三态语义：invalid ≠ noMatch', () => {
  it('三态各自锁定：match / noMatch / invalid（未知算子）', () => {
    const good = cond('fText', 'is', 'Alpha');
    expect(evaluateConditionState(good, rec('r1', { fText: 'Alpha' }), M)).toBe('match');
    expect(evaluateConditionState(good, rec('r2', { fText: 'Beta' }), M)).toBe('noMatch');
    expect(
      evaluateConditionState(cond('fText', 'startsWith' as FilterOperator, 'A'), rec('r3', { fText: 'Alpha' }), M),
    ).toBe('invalid');
    expect(evaluateConditionState(null, rec('r4', { fText: 'Alpha' }), M)).toBe('invalid');
    expect(evaluateConditionState(undefined, rec('r5', { fText: 'Alpha' }), M)).toBe('invalid');
  });

  it('conditions 里的 null / undefined 元素 → invalid 被跳过，不影响其它条件', () => {
    const rows: SdkRecord[] = [rec('r1', { fText: 'Alpha' }), rec('r2', { fText: 'Beta' })];
    expect(
      ids(
        applyFilterConditions(
          rows,
          cfg([null as unknown as FilterCondition, cond('fText', 'is', 'Alpha')], 'and'),
          M,
        ),
      ),
    ).toEqual(['r1']);
    expect(
      ids(
        applyFilterConditions(
          rows,
          cfg([undefined as unknown as FilterCondition, cond('fText', 'is', 'Alpha')], 'or'),
          M,
        ),
      ),
    ).toEqual(['r1']);
  });

  it('全部条件都是未知算子 → applyFilterConditions 返回**入参原引用**（= 不筛选）', () => {
    const rows: SdkRecord[] = [rec('r1', { fText: 'Alpha' }), rec('r2', { fText: 'Beta' })];
    const bogus = cfg([
      cond('fText', 'regex' as FilterOperator, 'A'),
      cond('fNum', 'fuzzy' as FilterOperator, 1),
    ]);
    expect(applyFilterConditions(rows, bogus, M)).toBe(rows);
    expect(ids(applyFilterConditions(rows, bogus, M))).toEqual(['r1', 'r2']);
  });

  it('字段访问抛异常的记录 → 仍出现在结果中（不凭空消失）', () => {
    const poisoned = {
      recordId: 'p1',
      get fields(): Record<string, unknown> {
        throw new Error('boom');
      },
    } as unknown as SdkRecord;
    const rows: SdkRecord[] = [rec('g1', { fText: 'Alpha' }), poisoned, rec('g2', { fText: 'Beta' })];
    expect(evaluateConditionState(cond('fText', 'is', 'Alpha'), poisoned, M)).toBe('invalid');
    expect(ids(applyFilterConditions(rows, cfg([cond('fText', 'is', 'Alpha')]), M))).toEqual(['g1', 'p1']);
  });

  it('normalize 抛异常（脏类型）也应收敛为 invalid，而不是让记录消失', () => {
    // 让 normalize 内部 throw：用一个会炸的 getter 字段值
    const dirty = {
      recordId: 'p2',
      fields: {
        get fNum(): number {
          throw new Error('normalize boom');
        },
      },
    } as unknown as SdkRecord;
    const rows: SdkRecord[] = [rec('g1', { fNum: 10 }), dirty];
    expect(evaluateConditionState(cond('fNum', 'is', 10), dirty, M)).toBe('invalid');
    expect(ids(applyFilterConditions(rows, cfg([cond('fNum', 'is', 10)]), M))).toEqual(['g1', 'p2']);
  });

  it('isOperatorKnown：**仅**校验算子是否已知（与 isConditionValid 是两件事）', () => {
    expect(isOperatorKnown(cond('fText', 'is', 'Alpha'))).toBe(true);
    expect(isOperatorKnown(cond('fText', 'regex' as FilterOperator, 'A'))).toBe(false);
    expect(isOperatorKnown(null)).toBe(false);
    expect(isOperatorKnown(undefined)).toBe(false);
    // 对照：同一条「数字字段 × contains」条件，完整判定说"不可求值"，算子判定说"名字合法"
    expect(isConditionValid(cond('fNum', 'contains', '1'), M)).toBe(false);
    expect(isOperatorKnown(cond('fNum', 'contains', '1'))).toBe(true);
  });
});

/* ===================== G. and / or 语义差异 ===================== */

describe('QA-F2 · conjunction and / or', () => {
  const rows: SdkRecord[] = [
    rec('w1', { fSingle: 'Done', fNum: 200 }),
    rec('w2', { fSingle: 'Done', fNum: 50 }),
    rec('w3', { fSingle: 'Todo', fNum: 300 }),
    rec('w4', { fSingle: 'Todo', fNum: 5 }),
  ];
  const two: FilterCondition[] = [cond('fSingle', 'is', 'Done'), cond('fNum', 'isGreater', 100)];

  it('and → 只 w1；or → w1 + w2 + w3（w4 两条都不满足必须被排除）', () => {
    expect(ids(applyFilterConditions(rows, cfg(two, 'and'), M))).toEqual(['w1']);
    expect(ids(applyFilterConditions(rows, cfg(two, 'or'), M))).toEqual(['w1', 'w2', 'w3']);
  });

  it('同一组条件 and 与 or 结果不同 —— 证伪「忽略 conjunction」的实现', () => {
    const andIds = ids(applyFilterConditions(rows, cfg(two, 'and'), M));
    const orIds = ids(applyFilterConditions(rows, cfg(two, 'or'), M));
    expect(orIds).not.toEqual(andIds);
    expect(orIds.length).toBeGreaterThan(andIds.length);
  });

  it('or 组里混入一条类型不匹配的条件 → 该条件被丢弃，不等于「全放行」', () => {
    const mixed = cfg([cond('fSingle', 'is', 'Done'), cond('fNum', 'contains', '2')], 'or');
    expect(ids(applyFilterConditions(rows, mixed, M))).toEqual(['w1', 'w2']);
  });
});

/* ===================== H. 边界与病态输入 ===================== */

describe('QA-F2 · 边界与病态输入', () => {
  const rows: SdkRecord[] = [rec('h1', { fText: 'Alpha' }), rec('h2', { fText: null })];

  it('conditions 非数组 → 视为未配置筛选，返回入参原引用且不抛异常', () => {
    const broken = { enabled: true, conjunction: 'and', conditions: 'oops' } as unknown as FilterConfig;
    expect(applyFilterConditions(rows, broken, M)).toBe(rows);
    expect(ids(applyFilterConditions(rows, broken, M))).toEqual(['h1', 'h2']);
  });

  it('enabled === false → 返回入参原引用；filter 为 null / undefined 亦然', () => {
    expect(applyFilterConditions(rows, cfg([cond('fText', 'is', 'Alpha')], 'and', false), M)).toBe(rows);
    expect(applyFilterConditions(rows, null, M)).toBe(rows);
    expect(applyFilterConditions(rows, undefined, M)).toBe(rows);
  });

  it('records 非数组 / null / undefined → 返回空数组，不抛异常', () => {
    expect(applyFilterConditions(null as unknown as SdkRecord[], cfg([cond('fText', 'is', 'A')]), M)).toEqual(
      [],
    );
    expect(applyFilterConditions(undefined as unknown as SdkRecord[], cfg([cond('fText', 'is', 'A')]), M)).toEqual(
      [],
    );
    expect(applyFilterConditions('x' as unknown as SdkRecord[], cfg([cond('fText', 'is', 'A')]), M)).toEqual(
      [],
    );
  });

  it('记录值为 NaN / Infinity → normalize 判为空 → isEmpty 命中，isNotEmpty 不命中', () => {
    const dirty: SdkRecord[] = [
      rec('z1', { fNum: Number.NaN }),
      rec('z2', { fNum: Number.POSITIVE_INFINITY }),
      rec('z3', { fNum: 0 }),
    ];
    expect(ids(applyFilterConditions(dirty, cfg([cond('fNum', 'isEmpty')]), M))).toEqual(['z1', 'z2']);
    expect(ids(applyFilterConditions(dirty, cfg([cond('fNum', 'isNotEmpty')]), M))).toEqual(['z3']);
  });

  it('目标值为 NaN 的字符串 → 不命中任何记录（诚实优先，不假装命中）', () => {
    const dirty: SdkRecord[] = [rec('z1', { fNum: 0 }), rec('z2', { fNum: 5 })];
    expect(ids(applyFilterConditions(dirty, cfg([cond('fNum', 'is', 'NaN')]), M))).toEqual([]);
    expect(ids(applyFilterConditions(dirty, cfg([cond('fNum', 'isGreater', 'NaN')]), M))).toEqual([]);
  });

  it('超长文本：1000 字符包含长关键字仍然命中；关键字更长则不命中', () => {
    const tail = 'x'.repeat(90);
    const long = `${'a'.repeat(900)}${tail}`;
    const big: SdkRecord[] = [rec('L1', { fText: long }), rec('L2', { fText: 'short' })];
    expect(ids(applyFilterConditions(big, cfg([cond('fText', 'contains', tail)]), M))).toEqual(['L1']);
    expect(ids(applyFilterConditions(big, cfg([cond('fText', 'contains', `${tail}y`)]), M))).toEqual([]);
  });

  it('多选项含空/null 脏项 → 被丢弃后按有效项匹配；全为脏项则为空值', () => {
    const dirty: SdkRecord[] = [
      rec('q1', { fMulti: ['VIP', '', null] }),
      rec('q2', { fMulti: [null, ''] }),
      rec('q3', { fMulti: ['VIP'] }),
    ];
    expect(ids(applyFilterConditions(dirty, cfg([cond('fMulti', 'contains', 'VIP')]), M))).toEqual([
      'q1',
      'q3',
    ]);
    expect(ids(applyFilterConditions(dirty, cfg([cond('fMulti', 'isEmpty')]), M))).toEqual(['q2']);
  });

  it('成员按显示名匹配，且不把 userId 泄漏为可匹配文本', () => {
    const users: SdkRecord[] = [
      rec('u1', { fUser: [{ id: 'ou_vip', name: '张三' }] }),
      rec('u2', { fUser: [{ id: 'ou_2', name: '李四' }] }),
    ];
    expect(ids(applyFilterConditions(users, cfg([cond('fUser', 'contains', '张三')]), M))).toEqual(['u1']);
    expect(ids(applyFilterConditions(users, cfg([cond('fUser', 'contains', 'ou_vip')]), M))).toEqual([]);
  });

  it('货币 / 评分 / 进度按数值比较（不看千分位 display）', () => {
    const money: SdkRecord[] = [
      rec('c1', { fCurrency: 1234.5 }),
      rec('c2', { fCurrency: 1234 }),
      rec('c3', { fCurrency: 999 }),
    ];
    expect(ids(applyFilterConditions(money, cfg([cond('fCurrency', 'is', 1234.5)]), M))).toEqual(['c1']);
    expect(ids(applyFilterConditions(money, cfg([cond('fCurrency', 'isGreater', 1234)]), M))).toEqual(['c1']);
    expect(ids(applyFilterConditions(money, cfg([cond('fCurrency', 'isLess', 1234)]), M))).toEqual(['c3']);
  });

  it('空 conditions → applyFilterConditions 返回原引用（= 不筛选）', () => {
    expect(applyFilterConditions(rows, cfg([]), M)).toBe(rows);
    expect(ids(applyFilterConditions(rows, cfg([]), M))).toEqual(['h1', 'h2']);
  });
});

/* ===================== I. 算子矩阵完整性（25 种类型逐条核对 §22.3 表） ===================== */

const TEXT_SIX = ['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'];
const NUMBER_EIGHT = [
  'is',
  'isNot',
  'isGreater',
  'isGreaterEqual',
  'isLess',
  'isLessEqual',
  'isEmpty',
  'isNotEmpty',
];
const DATE_SIX = ['is', 'isNot', 'isGreater', 'isLess', 'isEmpty', 'isNotEmpty'];
const CONTAINS_FOUR = ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'];
const EMPTINESS_TWO = ['isEmpty', 'isNotEmpty'];
const CHECKBOX_ONE = ['is'];
const FORMULA_FOUR = ['isEmpty', 'isNotEmpty', 'contains', 'doesNotContain'];

/** §22.3 表格逐行转写（QA 手抄，独立于实现） */
const EXPECTED_MATRIX: ReadonlyArray<[string, FieldTypeValue, readonly string[]]> = [
  ['文本 Text(1)', FieldType.Text, TEXT_SIX],
  ['电话 Phone(13)', FieldType.Phone, TEXT_SIX],
  ['链接 Url(15)', FieldType.Url, TEXT_SIX],
  ['条码 Barcode(99001)', FieldType.Barcode, TEXT_SIX],
  ['数字 Number(2)', FieldType.Number, NUMBER_EIGHT],
  ['自动编号 AutoNumber(1005)', FieldType.AutoNumber, NUMBER_EIGHT],
  ['货币 Currency(99003)', FieldType.Currency, NUMBER_EIGHT],
  ['评分 Rating(99004)', FieldType.Rating, NUMBER_EIGHT],
  ['进度 Progress(99002)', FieldType.Progress, NUMBER_EIGHT],
  ['单选 SingleSelect(3)', FieldType.SingleSelect, TEXT_SIX],
  ['多选 MultiSelect(4)', FieldType.MultiSelect, TEXT_SIX],
  ['日期 DateTime(5)', FieldType.DateTime, DATE_SIX],
  ['创建时间 CreatedTime(1001)', FieldType.CreatedTime, DATE_SIX],
  ['修改时间 ModifiedTime(1002)', FieldType.ModifiedTime, DATE_SIX],
  ['复选框 Checkbox(7)', FieldType.Checkbox, CHECKBOX_ONE],
  ['成员 User(11)', FieldType.User, CONTAINS_FOUR],
  ['创建人 CreatedUser(1003)', FieldType.CreatedUser, CONTAINS_FOUR],
  ['修改人 ModifiedUser(1004)', FieldType.ModifiedUser, CONTAINS_FOUR],
  ['群聊 GroupChat(23)', FieldType.GroupChat, CONTAINS_FOUR],
  ['附件 Attachment(17)', FieldType.Attachment, EMPTINESS_TWO],
  ['单向关联 Link(18)', FieldType.Link, CONTAINS_FOUR],
  ['双向关联 DuplexLink(21)', FieldType.DuplexLink, CONTAINS_FOUR],
  ['查找引用 Lookup(19)', FieldType.Lookup, CONTAINS_FOUR],
  ['地理位置 Location(22)', FieldType.Location, CONTAINS_FOUR],
  ['公式 Formula(20)', FieldType.Formula, FORMULA_FOUR],
];

describe('QA-F2 · 算子矩阵逐条核对 §22.3 表（25 种类型）', () => {
  it('矩阵登记的类型数量恰为 25（不多不少）', () => {
    expect(Object.keys(OPERATOR_MATRIX)).toHaveLength(25);
    expect(EXPECTED_MATRIX).toHaveLength(25);
  });

  it('每种类型的算子集（含顺序）与 §22.3 表逐条一致', () => {
    for (const [label, type, expected] of EXPECTED_MATRIX) {
      expect([...getOperatorsForType(type)], label).toEqual([...expected]);
    }
  });

  it('这 25 种类型全部可筛；未登记类型不可筛且只给空值判断', () => {
    for (const [, type] of EXPECTED_MATRIX) {
      expect(isFilterableFieldType(type), `${type} 应可筛`).toBe(true);
    }
    expect(isFilterableFieldType(99999 as FieldTypeValue)).toBe(false);
    expect([...getOperatorsForType(99999 as FieldTypeValue)]).toEqual([...EMPTINESS_TWO]);
  });

  it('25 种类型的类型号两两不同（保证上面的表没有重复登记掩盖缺项）', () => {
    const values = EXPECTED_MATRIX.map(([, type]) => type as number);
    expect(new Set(values).size).toBe(values.length);
  });
});

/* ===================== J. 白名单唯一源 ===================== */

describe('QA-F2 · ALL_FILTER_OPERATORS 唯一源', () => {
  it('operatorMatrix 再导出的白名单与 sanitize 的是**同一个引用**（禁止复制第二份）', () => {
    expect(ALL_FILTER_OPERATORS).toBe(WHITELIST_IN_SANITIZE);
  });

  it('白名单恰为 §22.2.1 的 10 个算子，且顺序防止误改', () => {
    expect([...ALL_FILTER_OPERATORS]).toEqual([
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

  it('isKnownOperator 走同一份白名单：只认这 10 个', () => {
    for (const operator of ALL_FILTER_OPERATORS) {
      expect(isKnownOperator(operator)).toBe(true);
    }
    expect(isKnownOperator('startsWith')).toBe(false);
    expect(isKnownOperator('Is')).toBe(false);
    expect(isKnownOperator('')).toBe(false);
    expect(isKnownOperator(42)).toBe(false);
    expect(isKnownOperator(null)).toBe(false);
  });

  it('矩阵用到的一切算子都在白名单内；白名单没用到 0 个（双向守卫）', () => {
    const used = new Set<string>();
    for (const list of Object.values(OPERATOR_MATRIX)) {
      for (const operator of list) used.add(operator);
    }
    expect([...used].sort()).toEqual([...ALL_FILTER_OPERATORS].sort());
  });
});

/* ===================== K. 算子回落（§22.3 UI 降级规则 1） ===================== */

describe('QA-F2 · 切换字段时的算子回落', () => {
  it('允许的算子被保留', () => {
    expect(resolveOperatorForType(FieldType.Number, 'isLessEqual')).toBe('isLessEqual');
    expect(resolveOperatorForType(FieldType.DateTime, 'isNot')).toBe('isNot');
    expect(resolveOperatorForType(FieldType.Checkbox, 'is')).toBe('is');
  });

  it('不允许的算子回落到该类型第一个可用算子', () => {
    expect(resolveOperatorForType(FieldType.Checkbox, 'contains')).toBe('is');
    expect(resolveOperatorForType(FieldType.Attachment, 'is')).toBe('isEmpty');
    expect(resolveOperatorForType(FieldType.Formula, 'is')).toBe('isEmpty');
    expect(resolveOperatorForType(FieldType.User, 'is')).toBe('contains');
    expect(resolveOperatorForType(FieldType.DateTime, 'isGreaterEqual')).toBe('is');
  });

  it('当前算子为空/未知 → 回落到默认算子', () => {
    expect(resolveOperatorForType(FieldType.Text, undefined)).toBe('is');
    expect(resolveOperatorForType(FieldType.Text, 'bogus' as FilterOperator)).toBe('is');
    expect(resolveOperatorForType(FieldType.Attachment, undefined)).toBe('isEmpty');
  });
});

/* ===================== L. 回归守卫（原 QA 复核发现的 D1~D4 偏差） ===================== */

/**
 * 以下 4 条原为 QA 复核发现的偏差，曾以 `it.skip` 冻结举证。
 * **2026-09-21 20:01 实现方已修复**（`engine.ts`：`isTypeOperatorMatch` 缺 meta → false；
 * `isConditionValid(cond, metas)` 的 metas 改**必填**并补齐类型×算子校验；
 * `applyFilterConditions` 传 metas 做早退判定；`evaluateFilter` 空/关闭/损坏条件一律返回 true）。
 * 故已**取消 skip，转为常驻回归守卫**：一旦有人把其中任何一条改回去，本组立刻变红。
 */
describe('QA-F2 · 回归守卫（原 D1~D4 偏差，已修复）', () => {
  it('[D1] §22.4.1/§22.4.5：`isConditionValid(cond, metas)` 必须做「类型 × 算子」校验', () => {
    // 直接调用**真实签名**（`metas` 必填）——刻意**不用** `as unknown as` 强转：
    // 强转会把「签名被改回可选 / 少一个参数」的回归掩盖成"测试通过"，正是本轮消灭的缺陷模式。
    // 类型不匹配（数字字段 × contains）→ 不可求值
    expect(isConditionValid(cond('fNum', 'contains', '1'), M)).toBe(false);
    // 字段已删除（不在 metas 里）→ 不可求值
    expect(isConditionValid(cond('fldGone', 'is', 'x'), M)).toBe(false);
    // 算子未知 → 不可求值
    expect(isConditionValid(cond('fNum', 'regex' as FilterOperator, '1'), M)).toBe(false);
    // 条件非对象 → 不可求值
    expect(isConditionValid(null, M)).toBe(false);
    // isEmpty / isNotEmpty 是唯一豁免：复选框 + isEmpty 仍应视为可求值
    expect(isConditionValid(cond('fCheck', 'isEmpty'), M)).toBe(true);
    // 矩阵允许的组合照常可求值
    expect(isConditionValid(cond('fNum', 'is', 1), M)).toBe(true);
    // ⭐「算子是否已知」是**另一件事**，由名字明确的 `isOperatorKnown` 承担（无字段上下文）。
    //    下面两条与上面的 `isConditionValid(..., M) === false` **同时成立**，
    //    正是二者语义不同的证据：'contains' 算子名合法，但在数字字段上不可求值。
    expect(isOperatorKnown(cond('fNum', 'contains', '1'))).toBe(true);
    expect(isOperatorKnown(cond('fNum', 'regex' as FilterOperator, '1'))).toBe(false);
    expect(isOperatorKnown(null)).toBe(false);
  });

  it('[D2] §22.4.1-L3220 / §22.4.5：「字段缺失（已删除）」应为 invalid，记录必须保留', () => {
    const rows: SdkRecord[] = [rec('r1', { fText: 'Alpha' }), rec('r2', { fText: 'Beta' })];
    expect(evaluateConditionState(cond('fldGone', 'is', 'Alpha'), rows[0], M)).toBe('invalid');
    expect(ids(applyFilterConditions(rows, cfg([cond('fldGone', 'is', 'Alpha')]), M))).toEqual(['r1', 'r2']);
    // metas 尚未加载完成（空对象）同样不得把记录筛光
    expect(ids(applyFilterConditions(rows, cfg([cond('fText', 'is', 'Alpha')]), {}))).toEqual(['r1', 'r2']);
  });

  it('[D3] 全部条件「类型不匹配」时也应返回入参原引用（不筛选）', () => {
    const rows: SdkRecord[] = [rec('r1', { fText: 'Alpha' }), rec('r2', { fText: 'Beta' })];
    expect(applyFilterConditions(rows, cfg([cond('fNum', 'contains', '1')]), M)).toBe(rows);
  });

  it('[D4] §22.4.1-L3253：「空 conditions → false」已作废，evaluateFilter 应返回 true（不筛选）', () => {
    expect(evaluateFilter(cfg([]), rec('r1', { fText: 'Alpha' }), M)).toBe(true);
    expect(evaluateFilter(cfg([], 'or'), rec('r1', { fText: 'Alpha' }), M)).toBe(true);
    expect(evaluateFilter(cfg([cond('fText', 'is', 'Alpha')], 'and', false), rec('r1', { fText: 'Alpha' }), M)).toBe(
      true,
    );
    expect(evaluateFilter(null, rec('r1', { fText: 'Alpha' }), M)).toBe(true);
  });
});
