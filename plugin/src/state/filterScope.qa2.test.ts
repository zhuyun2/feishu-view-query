/**
 * QA-F2 终验补充：**「无效条件不得短路整条数据链」反证用例**（独立于 F3 既有断言）。
 *
 * ## 为什么必须另开一份
 * `filterScope.f3.test.ts` 中「字段已被删除 → 记录全部保留」那条断言期望值恰为
 * `['r1','r2','r3']` = **入参全集**——这正是 §22.9.3 的「假绿 1」形状：
 * 一个 `return input.records` 的**恒等实现**也能让它通过；若 `selectVisibleRecords`
 * 存在「遇到无效条件就整条短路返回全部（连搜索也不做）」的缺陷，该断言同样为绿。
 * 换言之：**它能证明"没有把记录筛光"，但无法证明"链路仍然在收窄"**。
 *
 * 本文件补的正是后者：每条用例都让**有效层的收窄必须发生**，
 * 因此任何形式的短路 / 恒等实现都会变红。夹具与 F3 保持一致（同一 `fieldsById` / `layout` / 记录集）。
 *
 * ⚠️ 本文件为 **QA 权属新增**，不修改 F3 或主理人的任何既有文件。
 */
import { describe, expect, it } from 'vitest';
import type { SdkRecord } from '@/sdk/port';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';
import { defaultCardLayout } from '@/config/defaults';
import type { FilterCondition, FilterConfig, FilterConjunction } from '@/filter/types';
import {
  countInvalidConditions,
  isFilterConditionEffective,
  selectVisibleRecords,
} from '@/state/selectors';

/* ===================== 夹具（与 F3 同源，保证结论可对照） ===================== */

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];
const fieldsById: Record<string, FieldMetaLite> = { f_title: metas[0], f_amount: metas[1] };
const layout = defaultCardLayout(metas);

/** r1/r3 标题含「甲」，r2 不含；金额分别为 100 / 200 / 300 */
const r1 = { recordId: 'r1', fields: { f_title: '甲方案', f_amount: 100 } } as unknown as SdkRecord;
const r2 = { recordId: 'r2', fields: { f_title: '乙方案', f_amount: 200 } } as unknown as SdkRecord;
const r3 = { recordId: 'r3', fields: { f_title: '甲二期', f_amount: 300 } } as unknown as SdkRecord;
const all: SdkRecord[] = [r1, r2, r3];

const ids = (records: readonly SdkRecord[]): string[] => records.map((record) => record.recordId);

/** 指向**不存在**字段的条件 → 引擎判 `invalid`（meta 缺失） */
const GONE: FilterCondition = {
  conditionId: 'flt_gone',
  fieldId: 'f_deleted',
  operator: 'contains',
  value: '甲',
};
/** 指向**类型不匹配**的条件 → 引擎判 `invalid`（数字字段 × contains） */
const TYPE_MISMATCH: FilterCondition = {
  conditionId: 'flt_mismatch',
  fieldId: 'f_amount',
  operator: 'contains',
  value: '1',
};

const titleContains = (keyword: string): FilterCondition => ({
  conditionId: 'flt_title',
  fieldId: 'f_title',
  operator: 'contains',
  value: keyword,
});
const amountIs = (value: number): FilterCondition => ({
  conditionId: 'flt_amount',
  fieldId: 'f_amount',
  operator: 'is',
  value,
});

function cfg(conditions: FilterCondition[], conjunction: FilterConjunction = 'and'): FilterConfig {
  return { enabled: true, conjunction, conditions };
}

function vis(filter: FilterConfig, searchQuery = '') {
  return selectVisibleRecords({ records: all, filter, fieldsById, layout, searchQuery });
}

/* ===================== 反证用例 ===================== */

describe('QA-F2 反证 · 无效条件不得短路整条数据链（先筛后搜）', () => {
  it('底座：有效条件 contains「甲」→ r1+r3（证明夹具本身能收窄，先证伪「恒等实现」）', () => {
    const result = vis(cfg([titleContains('甲')]));
    expect(ids(result.records)).toEqual(['r1', 'r3']);
    expect(result.filterMatched).toBe(2);
    expect(result.visible).toBe(2);
  });

  it('⭐ 无效条件 + 非空搜索词：筛选层保留全部（3），**搜索层必须仍然收窄**（→ r1+r3）', () => {
    // 若实现「遇无效条件就短路返回 input.records」，records 会是 r1+r2+r3 → 本条变红。
    const result = vis(cfg([GONE]), '甲');
    expect(ids(result.records)).toEqual(['r1', 'r3']);
    expect(result.filterMatched).toBe(3); // 筛选层：无效条件被跳过 → 未收窄
    expect(result.visible).toBe(2); // 搜索层：确实收窄了
    expect(result.hasSearch).toBe(true);
  });

  it('⭐ 无效条件 + 一条有效 **noMatch**（and）→ 必须为空（证伪「遇无效即返回全部」）', () => {
    const result = vis(cfg([GONE, titleContains('丙')]));
    expect(ids(result.records)).toEqual([]);
    expect(result.filterMatched).toBe(0);
  });

  it('⭐ 无效条件 + 一条有效 **match**（and）→ 只剩命中项 r1+r3（证伪「短路返回全部」）', () => {
    const result = vis(cfg([GONE, titleContains('甲')]));
    expect(ids(result.records)).toEqual(['r1', 'r3']);
    expect(result.filterMatched).toBe(2);
  });

  it('⭐ or 下无效条件被**跳过**（不是当 noMatch、也不是全放行）：无效 + 金额=200 → 只 r2', () => {
    const result = vis(cfg([GONE, amountIs(200)], 'or'));
    expect(ids(result.records)).toEqual(['r2']);
    expect(result.filterMatched).toBe(1);
  });

  it('⭐ 全部条件无效 → 不筛选（全部保留），且该行为是**条件性**的（对照：有效条件必须收窄）', () => {
    const skipped = vis(cfg([GONE, TYPE_MISMATCH]));
    expect(ids(skipped.records)).toEqual(['r1', 'r2', 'r3']);
    expect(skipped.filterMatched).toBe(3);
    // 对照：把同一位置换成存在的字段 + 合法算子 → 必须真的收窄
    expect(ids(vis(cfg([titleContains('甲')])).records)).toEqual(['r1', 'r3']);
  });

  it('⭐ 无效条件不得污染搜索层：同一搜索词在「有无效条件」与「完全无筛选」下结果必须一致', () => {
    const withInvalid = ids(vis(cfg([GONE]), '甲').records);
    const noFilter = ids(vis(cfg([]), '甲').records);
    expect(withInvalid).toEqual(['r1', 'r3']);
    expect(withInvalid).toEqual(noFilter);
  });
});

describe('QA-F2 · §22.5.6 UI 判据接线（与引擎同源，非第二套判定）', () => {
  it('countInvalidConditions 是**动态计数**：0 / 1 / 2 三档都对（能证伪「写死成常数」）', () => {
    expect(countInvalidConditions(cfg([]), fieldsById)).toBe(0);
    expect(countInvalidConditions(cfg([titleContains('甲')]), fieldsById)).toBe(0);
    expect(countInvalidConditions(cfg([GONE]), fieldsById)).toBe(1);
    expect(countInvalidConditions(cfg([GONE, titleContains('甲')]), fieldsById)).toBe(1);
    expect(countInvalidConditions(cfg([GONE, TYPE_MISMATCH]), fieldsById)).toBe(2);
    // 未知算子同样是"未生效"（与引擎 isConditionValid 同源）
    expect(
      countInvalidConditions(
        cfg([
          {
            conditionId: 'flt_unknown',
            fieldId: 'f_title',
            operator: 'startsWith' as FilterCondition['operator'],
            value: 'y',
          },
        ]),
        fieldsById,
      ),
    ).toBe(1);
  });

  it('isEmpty / isNotEmpty 的豁免在 UI 判据同样生效：合法字段上的空值条件**不得**被判无效', () => {
    expect(
      isFilterConditionEffective({ conditionId: 'e1', fieldId: 'f_amount', operator: 'isEmpty' }, fieldsById),
    ).toBe(true);
    expect(
      isFilterConditionEffective({ conditionId: 'e2', fieldId: 'f_title', operator: 'isNotEmpty' }, fieldsById),
    ).toBe(true);
    // 对照：字段已删除时连空值条件也无法确定语义 → 判无效（豁免只豁免"类型×算子"，不豁免"字段不存在"）
    expect(
      isFilterConditionEffective({ conditionId: 'e3', fieldId: 'f_deleted', operator: 'isEmpty' }, fieldsById),
    ).toBe(false);
    // 对照：值比较类算子仍受类型校验
    expect(
      isFilterConditionEffective(
        { conditionId: 'e4', fieldId: 'f_amount', operator: 'contains', value: '1' },
        fieldsById,
      ),
    ).toBe(false);
  });

  it('UI 判据与「引擎实际是否用它」一致：判无效的条件，确实不参与筛选', () => {
    const invalid = cfg([TYPE_MISMATCH]);
    expect(countInvalidConditions(invalid, fieldsById)).toBe(1);
    // 判为无效 → 引擎跳过 → 不筛选 → 全部保留（两处结论必须一致）
    expect(ids(vis(invalid).records)).toEqual(['r1', 'r2', 'r3']);
  });
});
