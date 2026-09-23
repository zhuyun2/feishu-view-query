/**
 * 回归测试（工程师）——F3：组件路径下 `normalize()` 抛错必须被兜住，不影响整卡。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SdkRecord } from '@/sdk/port';
import { Card } from '@/components/card/Card';
import { defaultTheme } from '@/config/defaults';
import type { CardLayoutConfig, FieldPlacement, SlotConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';

const theme = defaultTheme();

const textMeta: FieldMetaLite = { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true };
const selectMeta: FieldMetaLite = { id: 'f_sel', name: '状态', type: FieldType.SingleSelect, isPrimary: false };

function slot(id: SlotConfig['id'], placements: FieldPlacement[]): SlotConfig {
  return {
    id,
    visible: true,
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
    display: { maxLines: 1, truncate: 'ellipsis', maxItems: 3, hideWhenEmpty: false },
  };
}

const layout: CardLayoutConfig = {
  templateId: 'standard',
  cardAspect: 'auto',
  slots: {
    title: slot('title', []),
    subtitle: slot('subtitle', []),
    attributes: slot('attributes', [placement('f_text', 0), placement('f_sel', 1)]),
    footer: slot('footer', []),
  },
};

/** 「访问任一属性即抛」的恶意值：能通过 Object.keys，但读取属性时抛错 */
function evilValue(): unknown {
  return new Proxy(
    { text: 'x' },
    {
      get(): never {
        throw new Error('value property boom');
      },
      ownKeys: () => ['text'],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'x' }),
    },
  );
}

describe('F3 回归 · normalize 抛错时字段级兜底（不崩卡）', () => {
  it('恶意字段值 → 卡片仍渲染；异常字段回落 FallbackRenderer，其他字段照常', () => {
    const record = {
      recordId: 'rec_1',
      fields: { f_text: '正常值', f_sel: evilValue() },
    } as unknown as SdkRecord;

    let markup = '';
    expect(() => {
      markup = renderToStaticMarkup(
        createElement(Card, {
          record,
          layout,
          fieldsById: { f_text: textMeta, f_sel: selectMeta },
          theme,
          locale: 'zh-CN',
        }),
      );
    }).not.toThrow();

    expect(markup).toContain('正常值'); // 正常字段不受影响
    expect(markup).toContain('该字段类型暂不支持'); // 异常字段降级
  });
});
