/**
 * 回归测试（工程师）——F1（货币符号）+ F4（对象/数组输入不得被强转为 0）。
 * 与 QA 的「缺陷实证」测试互补：本文件断言**修复后**的正确行为。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultTheme } from '@/config/defaults';
import type { FieldDisplayOptions } from '@/config/types';
import { FieldType } from './fieldTypes';
import type { DocRenderContext, FieldMetaLite, RenderContext } from './fieldTypes';
import { normalize } from './normalize';
import { renderCard, renderDoc, getRenderer } from './registry';

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

const currencyMeta: FieldMetaLite = {
  id: 'f_cur',
  name: '金额',
  type: FieldType.Currency,
  isPrimary: false,
  property: { symbol: '$' },
};
const numberMeta: FieldMetaLite = { id: 'f_num', name: '数量', type: FieldType.Number, isPrimary: false };
const ratingMeta: FieldMetaLite = { id: 'f_r', name: '评分', type: FieldType.Rating, isPrimary: false };
const progressMeta: FieldMetaLite = { id: 'f_p', name: '进度', type: FieldType.Progress, isPrimary: false };
const dateMeta: FieldMetaLite = { id: 'f_d', name: '日期', type: FieldType.DateTime, isPrimary: false };

describe('F1 回归 · 货币渲染必须使用字段 symbol（卡片态 + 文档态）', () => {
  it('归一化结果携带 symbol', () => {
    expect(normalize(1234.5, currencyMeta).symbol).toBe('$');
  });

  it('卡片态与文档态均渲染为 $（不再硬编码 ¥）', () => {
    const nv = normalize(1234.5, currencyMeta);
    const card = html(renderCard(nv, rctx(currencyMeta)));
    const doc = html(renderDoc(nv, dctx(currencyMeta)));

    expect(card).toContain('$1,234.50');
    expect(card).not.toContain('¥');
    expect(doc).toContain('$1,234.50');
    expect(doc).not.toContain('¥');
  });

  it('字段无 symbol 时回退 ¥', () => {
    const meta: FieldMetaLite = { ...currencyMeta, property: undefined };
    const nv = normalize(1000, meta);
    expect(nv.symbol).toBe('¥');
    expect(html(renderCard(nv, rctx(meta)))).toContain('¥1,000.00');
  });
});

describe('F4 回归 · 非标量输入不得被强转为 0（应为 empty）', () => {
  it('对象 / 数组 → empty（数字、货币）', () => {
    expect(normalize({ obj_token: 'x' }, numberMeta).isEmpty).toBe(true);
    expect(normalize({ obj_token: 'x' }, currencyMeta).isEmpty).toBe(true);
    expect(normalize([1, 2, 3], numberMeta).isEmpty).toBe(true);
    expect(normalize([1, 2, 3], currencyMeta).isEmpty).toBe(true);
  });

  it('评分 / 进度 / 日期：对象输入 → empty', () => {
    expect(normalize({ x: 1 }, ratingMeta).isEmpty).toBe(true);
    expect(normalize({ x: 1 }, progressMeta).isEmpty).toBe(true);
    expect(normalize({ x: 1 }, dateMeta).isEmpty).toBe(true);
  });

  it('合法标量输入不受影响', () => {
    expect(normalize(0, numberMeta)).toMatchObject({ kind: 'number', number: 0, isEmpty: false });
    expect(normalize('42', numberMeta)).toMatchObject({ kind: 'number', number: 42 });
    expect(normalize(3, ratingMeta)).toMatchObject({ kind: 'rating', number: 3 });
    expect(normalize(50, progressMeta).display).toBe('50%');
    expect(normalize(1_700_000_000_000, dateMeta).kind).toBe('dateTime');
  });
});

/* ===================== 批次 A：自动编号渲染 + 文本分段数组端到端 ===================== */

describe('批次A回归 · 自动编号字符串编号按文本渲染（保留前导零/前缀）', () => {
  const autoNumberMeta: FieldMetaLite = {
    id: 'f_autonum',
    name: '自动编号',
    type: FieldType.AutoNumber,
    isPrimary: false,
  };

  it('注册表：AutoNumber → 文本渲染器（不再走数字千分位）', () => {
    expect(getRenderer(FieldType.AutoNumber).key).toBe('text');
  });

  it('卡片态：{value:"0008"} 包装 → 渲染为 0008（前导零不丢，不再显示 8）', () => {
    const nv = normalize({ value: '0008', status: 'Completed' }, autoNumberMeta);
    expect(html(renderCard(nv, rctx(autoNumberMeta)))).toContain('0008');
  });

  it('文档态：{value:"F-2024-0001"} → 渲染为 F-2024-0001', () => {
    const nv = normalize({ value: 'F-2024-0001', status: 'Completed' }, autoNumberMeta);
    expect(html(renderDoc(nv, dctx(autoNumberMeta)))).toContain('F-2024-0001');
  });
});

describe('批次A回归 · 文本分段数组（真机 IOpenSegment[]）双态渲染', () => {
  const segmentTextMeta: FieldMetaLite = {
    id: 'f_seg',
    name: '长度字段测试',
    type: FieldType.Text,
    isPrimary: false,
  };

  it('卡片态：分段数组 → 渲染拼接文本（修复前为空 → 整行被 hideEmptyRows 剔除）', () => {
    const nv = normalize(
      [{ type: 'text', text: '长度字段测试：多段' }, { type: 'text', text: '内容' }],
      segmentTextMeta,
    );
    expect(nv.isEmpty).toBe(false);
    expect(html(renderCard(nv, rctx(segmentTextMeta)))).toContain('长度字段测试：多段内容');
  });

  it('文档态：分段数组 → 渲染拼接文本', () => {
    const nv = normalize([{ type: 'text', text: '文档态分段内容' }], segmentTextMeta);
    expect(html(renderDoc(nv, dctx(segmentTextMeta)))).toContain('文档态分段内容');
  });
});
