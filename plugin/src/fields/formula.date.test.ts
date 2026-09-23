/**
 * 回归测试（工程师）——公式字段按「字段自身日期格式」展示。
 *
 * 真机缺陷：公式字段（结果=日期，公式内容=`[发货时间]`，日期格式=`2026/01/30`）
 * 在文档详情里显示成原始毫秒时间戳（`1753942260000`），而非 `2025/07/31`。
 *
 * 根因：`normalize()` 未读公式的 `property.dataType`，把日期结果当普通数字
 *      （`kind:'number'` → NumberRenderer 直接打印数字）。
 * 修复：按 `dataType.type` 解包为 `dateTime`，并带上 `dataType.property.dateFormat`
 *      （经 `mapDateFormatterPattern` 把 SDK 小写 `yyyy` 映射为本模块大写 `YYYY`）。
 *
 * 反启发式：`dataType` 缺失时**维持原值**（绝不把大数字静默当日期）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultTheme } from '@/config/defaults';
import type { FieldDisplayOptions } from '@/config/types';
import { formatDate, mapDateFormatterPattern } from '@/utils/format';
import { evaluateCondition } from '@/filter/engine';
import type { SdkRecord } from '@/sdk/port';
import { FieldType } from './fieldTypes';
import type { DocRenderContext, FieldMetaLite, RenderContext } from './fieldTypes';
import { normalize } from './normalize';
import { renderCard, renderDoc } from './registry';

const theme = defaultTheme();
const display: FieldDisplayOptions = {
  maxLines: 1,
  truncate: 'ellipsis',
  maxItems: 3,
  hideWhenEmpty: false,
};

function rctx(meta: FieldMetaLite): RenderContext {
  return { fieldMeta: meta, display, theme, locale: 'zh-CN' };
}

function dctx(meta: FieldMetaLite): DocRenderContext {
  return { ...rctx(meta), fragmentIndex: 0, fragmentsTotal: 1, showLabel: true, labelText: meta.name };
}

function html(node: ReactNode): string {
  if (node === null || node === undefined || node === false) return '';
  return renderToStaticMarkup(node as ReactElement);
}

/** 本地 2026-01-30 12:00 的毫秒时间戳（按本地分量构造，结果与时区无关） */
const TS = new Date(2026, 0, 30, 12, 0, 0).getTime();
/** 与真机截图同量级的原始时间戳（绝不应被当日期） */
const RAW_MS = 1_753_942_260_000;

/** 日期结果公式：`dataType.type = DateTime`，字段自身格式 `yyyy/MM/dd` */
const dateFormulaMeta: FieldMetaLite = {
  id: 'f_ship_sync',
  name: '发货时间-同步',
  type: FieldType.Formula,
  isPrimary: false,
  property: {
    formula: '[发货时间]',
    dataType: { type: FieldType.DateTime, property: { dateFormat: 'yyyy/MM/dd', displayTimeZone: false } },
  },
};

describe('公式字段 · token 映射（SDK 小写 yyyy → formatDate 大写 YYYY）', () => {
  it('yyyy/MM/dd → YYYY/MM/DD（用户截图格式）', () => {
    expect(mapDateFormatterPattern('yyyy/MM/dd')).toBe('YYYY/MM/DD');
  });

  it('yyyy-MM-dd HH:mm → YYYY-MM-DD HH:mm', () => {
    expect(mapDateFormatterPattern('yyyy-MM-dd HH:mm')).toBe('YYYY-MM-DD HH:mm');
  });

  it('MM/dd/yyyy → MM/DD/YYYY（日/年同时纠正）', () => {
    expect(mapDateFormatterPattern('MM/dd/yyyy')).toBe('MM/DD/YYYY');
  });

  it('已是大写方言的输入幂等（不被二次替换）', () => {
    expect(mapDateFormatterPattern('YYYY-MM-DD')).toBe('YYYY-MM-DD');
  });

  it('映射后的 pattern 经 formatDate 产出具体字符串（不残留字面量 yyyy）', () => {
    const out = formatDate(TS, mapDateFormatterPattern('yyyy/MM/dd'));
    expect(out).toBe('2026/01/30');
    expect(out).not.toContain('yyyy');
  });
});

describe('公式字段 · 归一化（日期结果带日期语义 + 字段格式）', () => {
  it('日期结果 + 字段格式 → kind=dateTime、display=字段格式', () => {
    const nv = normalize(TS, dateFormulaMeta);
    expect(nv.kind).toBe('dateTime');
    expect(nv.timestamp).toBe(TS);
    expect(nv.display).toBe('2026/01/30');
    expect(nv.text).toBe('2026/01/30');
    expect(nv.dateFormat).toBe('YYYY/MM/DD');
  });

  it('日期结果 + 带时分格式 → 展示时分', () => {
    const meta: FieldMetaLite = {
      ...dateFormulaMeta,
      property: {
        formula: '[发货时间]',
        dataType: { type: FieldType.DateTime, property: { dateFormat: 'yyyy-MM-dd HH:mm' } },
      },
    };
    expect(normalize(TS, meta).display).toBe('2026-01-30 12:00');
  });

  it('日期结果但缺 dateFormat → 仍为 dateTime（回退默认格式，不残留 yyyy）', () => {
    const meta: FieldMetaLite = {
      ...dateFormulaMeta,
      property: { formula: '[发货时间]', dataType: { type: FieldType.DateTime, property: {} } },
    };
    const nv = normalize(TS, meta);
    expect(nv.kind).toBe('dateTime');
    expect(nv.dateFormat).toBeUndefined();
    expect(nv.display).toBe('2026-01-30');
  });

  it('非日期结果的公式（dataType=Number）→ 维持数字语义', () => {
    const meta: FieldMetaLite = {
      ...dateFormulaMeta,
      property: { formula: '[数量]', dataType: { type: FieldType.Number, property: { formatter: '0.00' } } },
    };
    const nv = normalize(1234, meta);
    expect(nv.kind).toBe('number');
    expect(nv.dateFormat).toBeUndefined();
  });

  it('日期结果但原始值非数字 → 交回保守解包（不隐藏数据）', () => {
    const nv = normalize('abc', dateFormulaMeta);
    expect(nv.kind).toBe('text');
    expect(nv.display).toBe('abc');
  });
});

describe('公式字段 · dataType 缺失时行为不变（反启发式回归）', () => {
  const plainFormula: FieldMetaLite = {
    id: 'f_plain',
    name: '公式',
    type: FieldType.Formula,
    isPrimary: false,
  };

  it('大毫秒数 → 仍为数字，绝不被猜成日期', () => {
    const nv = normalize(RAW_MS, plainFormula);
    expect(nv.kind).toBe('number');
    expect(nv.kind).not.toBe('dateTime');
    expect(nv.dateFormat).toBeUndefined();
    expect(nv.display).toBe('1,753,942,260,000');
  });

  it('保留既有 {value} 解包行为（数字 / 文本 / 布尔）', () => {
    expect(normalize({ value: 1234 }, plainFormula)).toMatchObject({ kind: 'number', number: 1234 });
    expect(normalize({ value: '已完成' }, plainFormula).display).toBe('已完成');
    expect(normalize({ value: true }, plainFormula)).toMatchObject({ kind: 'checkbox', boolean: true });
  });
});

describe('公式字段 · 渲染层（文档态展示字段自身格式）', () => {
  it('文档态：渲染格式化日期串，且不含原始时间戳', () => {
    const markup = html(renderDoc(normalize(TS, dateFormulaMeta), dctx(dateFormulaMeta)));
    expect(markup).toContain('2026/01/30');
    expect(markup).toContain('发货时间-同步：');
    expect(markup).not.toContain(String(TS));
  });

  it('卡片态：同样按字段格式展示', () => {
    const markup = html(renderCard(normalize(TS, dateFormulaMeta), rctx(dateFormulaMeta)));
    expect(markup).toContain('2026/01/30');
    expect(markup).not.toContain(String(TS));
  });
});

describe('公式字段 · contains 匹配源 = 格式化文本（所见即所筛）', () => {
  it('命中格式化片段（2026/01），不命中原始毫秒前缀——锁定匹配源', () => {
    const metas = { [dateFormulaMeta.id]: dateFormulaMeta };
    const record = {
      recordId: 'r_ship',
      fields: { [dateFormulaMeta.id]: TS },
    } as unknown as SdkRecord;
    const rawPrefix = String(TS).slice(0, 4);

    // 前置不变量：格式化文本确实不含原始毫秒前缀（否则本条断言无判别力）
    expect(normalize(TS, dateFormulaMeta).display).not.toContain(rawPrefix);

    const hitFormatted = evaluateCondition(
      { conditionId: 'c1', fieldId: dateFormulaMeta.id, operator: 'contains', value: '2026/01' },
      record,
      metas,
    );
    const hitRawPrefix = evaluateCondition(
      { conditionId: 'c2', fieldId: dateFormulaMeta.id, operator: 'contains', value: rawPrefix },
      record,
      metas,
    );

    expect(hitFormatted).toBe(true);
    expect(hitRawPrefix).toBe(false);
  });
});
