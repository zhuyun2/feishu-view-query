/**
 * QA 独立复核（M1 / T06）：P0 八类字段「双态」渲染 + 字段级异常隔离（不崩卡）。
 * 通过 react-dom/server 将渲染结果转为 HTML 后断言，逼近真实渲染输出。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRecord } from '@lark-base-open/js-sdk';
import { Card } from '@/components/card/Card';
import { defaultTheme } from '@/config/defaults';
import type { CardLayoutConfig, FieldDisplayOptions, FieldPlacement, SlotConfig } from '@/config/types';
import { FieldType } from './fieldTypes';
import type { DocRenderContext, FieldMetaLite, NormalizedValue, RenderContext } from './fieldTypes';
import { normalize } from './normalize';
import { getRenderer, renderCard, renderDoc } from './registry';

const theme = defaultTheme();
const baseDisplay: FieldDisplayOptions = {
  maxLines: 1,
  truncate: 'ellipsis',
  maxItems: 3,
  hideWhenEmpty: false,
};

function rctx(meta: FieldMetaLite, over: Partial<FieldDisplayOptions> = {}): RenderContext {
  return { fieldMeta: meta, display: { ...baseDisplay, ...over }, theme, locale: 'zh-CN' };
}

function dctx(meta: FieldMetaLite, over: Partial<FieldDisplayOptions> = {}): DocRenderContext {
  return { ...rctx(meta, over), fragmentIndex: 0, fragmentsTotal: 1, showLabel: true, labelText: meta.name };
}

function html(node: ReactNode): string {
  if (node === null || node === undefined || node === false) return '';
  return renderToStaticMarkup(node as ReactElement);
}

const M: Record<string, FieldMetaLite> = {
  text: { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true },
  number: { id: 'f_num', name: '数量', type: FieldType.Number, isPrimary: false },
  currency: { id: 'f_cur', name: '金额', type: FieldType.Currency, isPrimary: false, property: { symbol: '$' } },
  select: {
    id: 'f_sel',
    name: '状态',
    type: FieldType.SingleSelect,
    isPrimary: false,
    property: { options: [{ name: '进行中', color: 1 }] },
  },
  multi: { id: 'f_multi', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  date: { id: 'f_date', name: '签约日期', type: FieldType.DateTime, isPrimary: false },
  checkbox: { id: 'f_ck', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
};

describe('QA · P0 八类字段双态渲染（独立复核）', () => {
  it('卡片态：八类字段均可渲染且内容正确', () => {
    expect(html(renderCard(normalize('客户A', M.text), rctx(M.text)))).toContain('客户A');
    expect(html(renderCard(normalize(1234567, M.number), rctx(M.number)))).toContain('1,234,567');
    expect(html(renderCard(normalize(1234.5, M.currency), rctx(M.currency)))).toContain('1,234.50');
    expect(html(renderCard(normalize('进行中', M.select), rctx(M.select)))).toContain('进行中');
    expect(html(renderCard(normalize(1_700_000_000_000, M.date), rctx(M.date)))).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html(renderCard(normalize(true, M.checkbox), rctx(M.checkbox)))).toContain('✓');
    expect(html(renderCard(normalize(false, M.checkbox), rctx(M.checkbox)))).toContain('✕');

    const multiCard = html(renderCard(normalize(['A', 'B', 'C', 'D'], M.multi), rctx(M.multi, { maxItems: 3 })));
    expect(multiCard).toContain('A');
    expect(multiCard).toContain('+1'); // 超出预览上限折叠
    expect(multiCard).not.toContain('D');
  });

  it('文档态：八类字段均可渲染且内容正确（含字段名标签）', () => {
    expect(html(renderDoc(normalize('客户A', M.text), dctx(M.text)))).toContain('客户名称：');
    expect(html(renderDoc(normalize(1234567, M.number), dctx(M.number)))).toContain('1,234,567');
    expect(html(renderDoc(normalize(1234.5, M.currency), dctx(M.currency)))).toContain('1,234.50');
    expect(html(renderDoc(normalize('进行中', M.select), dctx(M.select)))).toContain('进行中');
    expect(html(renderDoc(normalize(1_700_000_000_000, M.date), dctx(M.date)))).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html(renderDoc(normalize(true, M.checkbox), dctx(M.checkbox)))).toContain('是');
    expect(html(renderDoc(normalize(false, M.checkbox), dctx(M.checkbox)))).toContain('否');

    const multiDoc = html(renderDoc(normalize(['A', 'B', 'C', 'D'], M.multi), dctx(M.multi, { maxItems: 3 })));
    expect(multiDoc).toContain('D'); // 文档态展示全部标签，不折叠
  });

  it('多行文本：卡片态截断（省略号），文档态不截断', () => {
    const longRun = 'x'.repeat(200);
    const raw = `第一行\n第二行\n${longRun}`;
    const multiTextMeta: FieldMetaLite = { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false };

    const card = html(renderCard(normalize(raw, multiTextMeta), rctx(multiTextMeta, { maxLines: 5 })));
    const doc = html(renderDoc(normalize(raw, multiTextMeta), dctx(multiTextMeta, { maxLines: 5 })));

    expect(card).toContain('第一行');
    expect(card).toContain('…'); // 卡片态截断
    expect(doc).toContain(longRun); // 文档态完整呈现
    expect(doc).not.toContain('…');
  });

  it('未注册字段类型 → 走 FallbackRenderer', () => {
    expect(getRenderer(99999).key).toBe('fallback');
  });

  it('[回归] F1：货币渲染尊重字段 symbol —— 卡片态与文档态均输出 $，不再硬编码 ¥', () => {
    const nv = normalize(1234.5, M.currency);
    expect(nv.display).toBe('$1,234.50'); // normalize 尊重字段 symbol
    expect(nv.symbol).toBe('$');

    const card = html(renderCard(nv, rctx(M.currency)));
    const doc = html(renderDoc(nv, dctx(M.currency)));
    expect(card).toContain('$1,234.50'); // 卡片态取字段 symbol
    expect(card).not.toContain('¥');
    expect(doc).toContain('$1,234.50'); // 文档态同样取字段 symbol
    expect(doc).not.toContain('¥');
  });
});

describe('QA · 字段级异常隔离（不崩卡，独立实证）', () => {
  const throwingNv = new Proxy({} as NormalizedValue, {
    get(): never {
      throw new Error('normalized value access boom');
    },
  });

  it('renderCard：NormalizedValue 访问即抛 → 被 try/catch 兜住并回落 FallbackRenderer', () => {
    const node = renderCard(throwingNv, rctx(M.text));
    expect(html(node)).toContain('该字段类型暂不支持');
  });

  it('renderDoc：NormalizedValue 访问即抛 → 被 try/catch 兜住并回落 FallbackRenderer', () => {
    const node = renderDoc(throwingNv, dctx(M.text));
    expect(html(node)).toContain('该字段类型暂不支持');
  });

  it('同一卡片内：单字段异常不影响其他字段正常渲染（不崩卡实证）', () => {
    const good = renderCard(normalize('正常客户', M.text), rctx(M.text));
    const bad = renderCard(throwingNv, rctx(M.number));
    const markup = renderToStaticMarkup(createElement('div', { className: 'cbv-card' }, bad, good));
    expect(markup).toContain('该字段类型暂不支持'); // 异常字段降级
    expect(markup).toContain('正常客户'); // 其他字段照常
  });

  it('[回归] F3：组件路径 normalize 抛错被兜住 —— 异常字段落兜底、同卡其他字段照常（不再白屏）', () => {
    // Object.keys 可用（keys=['text']），但访问任一属性即抛 —— 使 normalize 内部读取属性时抛错
    const evilValue = new Proxy(
      { text: 'x' },
      {
        get(): never {
          throw new Error('value property boom');
        },
        ownKeys: () => ['text'],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'x' }),
      },
    );

    const layout: CardLayoutConfig = {
      templateId: 'standard',
      cardAspect: 'auto',
      slots: {
        title: slot('title', [], false),
        subtitle: slot('subtitle', [], false),
        attributes: slot('attributes', [placement('f_text', 0), placement('f_sel', 1)]),
        footer: slot('footer', [], false),
      },
    };
    const record = { recordId: 'rec_1', fields: { f_text: '正常值', f_sel: evilValue } } as unknown as IRecord;

    const render = (): string =>
      renderToStaticMarkup(
        createElement(Card, {
          record,
          layout,
          fieldsById: { f_text: M.text, f_sel: M.select },
          theme,
          locale: 'zh-CN',
        }),
      );

    // 期望（PRD §12「单字段失败不至白屏」）：normalize 抛错被 try/catch 兜住 → 卡片仍渲染；
    // 异常字段 f_sel 落 FallbackRenderer，同卡 f_text 照常渲染。
    let markup = '';
    expect(() => {
      markup = render();
    }).not.toThrow();
    expect(markup).toContain('该字段类型暂不支持'); // 异常字段降级到兜底文案
    expect(markup).toContain('正常值'); // 同卡其他字段不受影响
  });
});

function slot(id: SlotConfig['id'], placements: FieldPlacement[], visible = true): SlotConfig {
  return {
    id,
    visible,
    collapsibleWhenEmpty: true,
    direction: id === 'attributes' ? 'column' : 'row',
    separator: ' · ',
    maxItemsPerCard: 8,
    placements,
  };
}

function placement(fieldId: string, order: number): FieldPlacement {
  return {
    placementId: `p_${fieldId}`,
    fieldId,
    order,
    labelVisible: false,
    display: { ...baseDisplay },
  };
}
