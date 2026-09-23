/**
 * 「算子需值但值为空 → 条件未生效（invalid）」闸门单测（本轮真机缺陷修复）。
 *
 * 背景（真机 Bug）：新建的筛选条件行**尚未填值**（`{operator:'is', value:''}`）时，
 * 旧实现把 `is ''` 当作**合法条件**，`matchIs(nv, '')` 对**每条记录**都算出 `noMatch`
 * → `and` 下把**所有记录筛光**：卡片区变空态「当前筛选无结果」、计数变「命中 0 条」，
 * 而用户还没填值、也没点应用——**静默的数据隐藏**，无从察觉。
 *
 * ⭐ 修复口径：需值算子缺值 = **语义未定义（无可比目标）** → `invalid`（**跳过该条件**），
 *    与「未知算子 / 类型 × 算子不匹配」同属一类；**绝不是**「合法但不匹配（noMatch）」。
 *
 * ⚠️ 断言纪律（禁止假绿）：一律锁定**具体 recordId 序列**；并含一条**判别式**——
 *    `[空条件, 命中条件]` and → 记录**保留**；`[空条件, 不命中条件]` and → **仍收窄为 []**。
 *    只测「记录没消失」证明不了闸门没开过头（可能把整个筛选放行了）。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { getRecordId } from '@/data/RecordDataSource';
import { countInvalidConditions } from '@/state/selectors';
import {
  FilterConditionRow,
  INCOMPLETE_VALUE_TEXT,
  INVALID_TYPE_OPERATOR_TEXT,
  createDefaultCondition,
} from '@/components/filter/FilterConditionRow';
import type { FilterCondition, FilterConfig, FilterConjunction, FilterOperator } from './types';
import { applyFilterConditions, evaluateConditionState, evaluateFilter, isConditionValid } from './engine';
import type { FieldMetaMap } from './engine';

/* ===================== 夹具 ===================== */

const LIST: FieldMetaLite[] = [
  { id: 'fText', name: '备注', type: FieldType.Text, isPrimary: true },
  { id: 'fNum', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'fFlag', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
];

const METAS: FieldMetaMap = {};
for (const meta of LIST) METAS[meta.id] = meta;

const RECORDS: SdkRecord[] = [
  { recordId: 'r1', fields: { fText: '甲', fNum: 100, fFlag: true } } as unknown as SdkRecord,
  { recordId: 'r2', fields: { fText: '乙', fNum: 200, fFlag: false } } as unknown as SdkRecord,
  { recordId: 'r3', fields: { fText: '', fNum: null } } as unknown as SdkRecord,
];

function ids(records: readonly SdkRecord[]): string[] {
  return records.map((record) => getRecordId(record));
}

function cond(fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  const condition: FilterCondition = { conditionId: `c_${fieldId}_${operator}`, fieldId, operator };
  if (value !== undefined) condition.value = value;
  return condition;
}

function cfg(conditions: FilterCondition[], conjunction: FilterConjunction = 'and'): FilterConfig {
  return { enabled: true, conjunction, conditions };
}

/* ===================== 1. 空值条件 → invalid（不再筛空数据） ===================== */

describe('需值算子缺值 → invalid（数据可见性优先，绝不筛空）', () => {
  it('is "" → invalid；isConditionValid=false；evaluateFilter=true；applyFilterConditions 返回**入参原引用**', () => {
    const blank = cond('fText', 'is', '');
    expect(evaluateConditionState(blank, RECORDS[0], METAS)).toBe('invalid');
    expect(isConditionValid(blank, METAS)).toBe(false);
    expect(evaluateFilter(cfg([blank]), RECORDS[0], METAS)).toBe(true);
    const result = applyFilterConditions(RECORDS, cfg([blank]), METAS);
    expect(result).toBe(RECORDS); // 原引用 → 未筛选
    expect(ids(result)).toEqual(['r1', 'r2', 'r3']);
  });

  it('纯空白 "   " 同样视为未填写 → invalid（不是「等于空白字符串」）', () => {
    const ws = cond('fText', 'is', '   ');
    expect(evaluateConditionState(ws, RECORDS[0], METAS)).toBe('invalid');
    expect(isConditionValid(ws, METAS)).toBe(false);
    expect(applyFilterConditions(RECORDS, cfg([ws]), METAS)).toBe(RECORDS);
  });

  it('值**完全缺失**（无 value 键）→ invalid', () => {
    const noVal = cond('fText', 'is');
    expect('value' in noVal).toBe(false);
    expect(evaluateConditionState(noVal, RECORDS[0], METAS)).toBe('invalid');
    expect(applyFilterConditions(RECORDS, cfg([noVal]), METAS)).toBe(RECORDS);
  });

  it('不止 is：contains / doesNotContain 空值、数字字段 is 空串 → 一律 invalid', () => {
    for (const operator of ['contains', 'doesNotContain'] as FilterOperator[]) {
      expect(evaluateConditionState(cond('fText', operator, ''), RECORDS[0], METAS), operator).toBe('invalid');
    }
    expect(evaluateConditionState(cond('fNum', 'is', ''), RECORDS[0], METAS)).toBe('invalid');
  });
});

/* ===================== 2. 不误伤：空值算子 / 真实值 / 0 与 false ===================== */

describe('闸门不得开过头：豁免与真实值照常', () => {
  it('isEmpty / isNotEmpty（不需值）不受影响：合法且照常求值', () => {
    expect(evaluateConditionState(cond('fText', 'isEmpty'), RECORDS[2], METAS)).toBe('match');
    expect(evaluateConditionState(cond('fText', 'isNotEmpty'), RECORDS[0], METAS)).toBe('match');
    expect(isConditionValid(cond('fText', 'isEmpty'), METAS)).toBe(true);
    expect(isConditionValid(cond('fNum', 'isNotEmpty'), METAS)).toBe(true);
    expect(ids(applyFilterConditions(RECORDS, cfg([cond('fText', 'isEmpty')]), METAS))).toEqual(['r3']);
  });

  it('0 / false / "0" **不是**空值：合法且正常筛选（证伪「把 0/false 当没填」）', () => {
    expect(isConditionValid(cond('fNum', 'is', 0), METAS)).toBe(true);
    expect(isConditionValid(cond('fFlag', 'is', false), METAS)).toBe(true);
    expect(isConditionValid(cond('fText', 'is', '0'), METAS)).toBe(true);
    expect(ids(applyFilterConditions(RECORDS, cfg([cond('fText', 'is', '甲')]), METAS))).toEqual(['r1']);
    expect(ids(applyFilterConditions(RECORDS, cfg([cond('fFlag', 'is', true)]), METAS))).toEqual(['r1']);
  });
});

/* ===================== 3. ⭐ 判别式：跳过 ≠ 放行 ===================== */

describe('⭐ 判别式：「跳过该条件」而不是「整个筛选放行」', () => {
  it('[空条件, 命中条件] and → 记录**保留**（空条件被跳过，仅命中条件生效）', () => {
    const result = applyFilterConditions(
      RECORDS,
      cfg([cond('fText', 'is', ''), cond('fFlag', 'is', true)], 'and'),
      METAS,
    );
    expect(ids(result)).toEqual(['r1']);
    expect(ids(result)).not.toEqual([]);
  });

  it('[空条件, 不命中条件] and → **仍收窄为 []**（若闸门被误开成「放行一切」，本条会变红）', () => {
    const result = applyFilterConditions(
      RECORDS,
      cfg([cond('fText', 'is', ''), cond('fText', 'is', 'ZZZ')], 'and'),
      METAS,
    );
    expect(ids(result)).toEqual([]);
  });

  it('对照：仅空条件 → 无可求值条件 → 返回原引用（不筛）', () => {
    expect(applyFilterConditions(RECORDS, cfg([cond('fText', 'is', '')]), METAS)).toBe(RECORDS);
  });
});

/* ===================== 4. §22.5.6：计为「未生效」+ UI 文案准确 ===================== */

describe('§22.5.6：空值条件计入「N 个条件未生效」且文案说准原因', () => {
  it('countInvalidConditions 把「值未填」计为未生效（1 / 0 两档，能证伪写死）', () => {
    expect(countInvalidConditions(cfg([cond('fText', 'is', '')]), METAS)).toBe(1);
    expect(countInvalidConditions(cfg([cond('fText', 'is', '甲')]), METAS)).toBe(0);
    expect(countInvalidConditions(cfg([cond('fText', 'is', ''), cond('fNum', 'is', 0)]), METAS)).toBe(1);
  });

  it('createDefaultCondition 新行：需值算子**不预填值**（无 value 键）→ 判定未生效', () => {
    const created = createDefaultCondition(LIST, METAS, 'flt_new');
    expect(created).not.toBeNull();
    expect(created?.operator).toBe('is');
    expect('value' in (created as FilterCondition)).toBe(false);
    expect(isConditionValid(created as FilterCondition, METAS)).toBe(false);
  });

  it('UI 行内文案：值未填写 → 「尚未填写筛选值」，**不是**「算子不适用于此字段类型」', () => {
    const markup = renderToStaticMarkup(
      <FilterConditionRow
        condition={cond('fText', 'is', '')}
        fields={LIST}
        fieldsById={METAS}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(markup).toContain('cbv-filter-row--invalid');
    expect(markup).toContain(INCOMPLETE_VALUE_TEXT);
    expect(markup).not.toContain(INVALID_TYPE_OPERATOR_TEXT);
  });
});
