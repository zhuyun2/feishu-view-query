/**
 * QA2 独立验证（任务 #13/#15）· T09：卡片四槽位 + 空槽位收合 + 密度属性行数 + cover 模板。
 *
 * 断言来源：
 *  - `03 §4.2`：`SlotConfig.collapsibleWhenEmpty` 收合空槽位；四槽位模型（无封面槽位）。
 *  - `04 §5.1.2 / UI-02`：空槽位自动收合不占位；内分隔线仅在需要时出现。
 *  - `04 §11 R3`：属性区默认 **3 行**（紧凑 2 / 标准 3 / 宽松 5），超出显示 `+n`。
 *  - `04 §11 R4`：卡片**不显示封面图**；cover「大图」= 属性区首图 64×64 + 张数。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRecord } from '@lark-base-open/js-sdk';
import { Card } from '@/components/card/Card';
import { defaultDensity, defaultTheme } from '@/config/defaults';
import {
  applyCardTemplate,
  attributesMaxRows,
  CARD_TEMPLATES,
  DENSITY_PRESETS,
  resolveDensityPreset,
} from '@/config/presets';
import type { CardLayoutConfig, FieldPlacement, SlotConfig, SlotId } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';

const THEME = defaultTheme();

const FIELD_TEXT: FieldMetaLite = { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_AMOUNT: FieldMetaLite = { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const FIELD_NOTE: FieldMetaLite = { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false };
const FIELD_IMG: FieldMetaLite = { id: 'f_img', name: '图片', type: FieldType.Attachment, isPrimary: false };
const FIELDS_BY_ID: Record<string, FieldMetaLite> = {
  f_text: FIELD_TEXT,
  f_amount: FIELD_AMOUNT,
  f_note: FIELD_NOTE,
  f_img: FIELD_IMG,
};

function placement(fieldId: string, order: number): FieldPlacement {
  return {
    placementId: `p_${fieldId}_${order}`,
    fieldId,
    order,
    labelVisible: false,
    display: { maxLines: 1, truncate: 'ellipsis', maxItems: 3, hideWhenEmpty: false },
  };
}

function slot(id: SlotId, placements: FieldPlacement[], overrides: Partial<SlotConfig> = {}): SlotConfig {
  return {
    id,
    visible: true,
    collapsibleWhenEmpty: true,
    direction: id === 'attributes' ? 'column' : 'row',
    separator: ' · ',
    maxItemsPerCard: 8,
    placements,
    ...overrides,
  };
}

function layout(overrides: Partial<Record<SlotId, SlotConfig>> = {}): CardLayoutConfig {
  return {
    templateId: 'standard',
    cardAspect: 'auto',
    slots: {
      title: overrides.title ?? slot('title', []),
      subtitle: overrides.subtitle ?? slot('subtitle', []),
      attributes: overrides.attributes ?? slot('attributes', []),
      footer: overrides.footer ?? slot('footer', []),
    },
  };
}

function record(fields: Record<string, unknown>): IRecord {
  return { recordId: 'r1', fields } as unknown as IRecord;
}

function render(l: CardLayoutConfig, r: IRecord, attributesRows = 3): string {
  return renderToStaticMarkup(
    createElement(Card, {
      record: r,
      layout: l,
      fieldsById: FIELDS_BY_ID,
      theme: THEME,
      locale: 'zh-CN',
      attributesMaxRows: attributesRows,
    }),
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/* ============================ 空槽位收合 ============================ */

describe('T09 · 空槽位按 collapsibleWhenEmpty 收合（不占位）', () => {
  it('collapsibleWhenEmpty=true + 字段为空 → 槽位不渲染', () => {
    const l = layout({ title: slot('title', [placement('f_text', 0)], { collapsibleWhenEmpty: true }) });
    const html = render(l, record({ f_text: '' }));
    expect(html).not.toContain('cbv-card__title');
  });

  it('collapsibleWhenEmpty=false + 字段为空 → 槽位保留（渲染空值占位）', () => {
    const l = layout({ title: slot('title', [placement('f_text', 0)], { collapsibleWhenEmpty: false }) });
    const html = render(l, record({ f_text: '' }));
    expect(html).toContain('cbv-card__title');
    expect(html).toContain('—');
  });

  it('visible=false → 槽位不渲染（即便有内容）', () => {
    const l = layout({ title: slot('title', [placement('f_text', 0)], { visible: false }) });
    const html = render(l, record({ f_text: '苹果' }));
    expect(html).not.toContain('cbv-card__title');
  });

  it('有空内容的槽位正常渲染', () => {
    const l = layout({ title: slot('title', [placement('f_text', 0)]) });
    expect(render(l, record({ f_text: '苹果' }))).toContain('苹果');
  });
});

/* ============================ 内分隔线 ============================ */

describe('T09 · 内分隔线仅在「上方有内容且下方非空」时出现', () => {
  it('标题有内容 + 属性为空 → 0 条分隔线', () => {
    const l = layout({
      title: slot('title', [placement('f_text', 0)]),
      attributes: slot('attributes', [placement('f_note', 0)]),
    });
    const html = render(l, record({ f_text: '苹果', f_note: '' }));
    expect(count(html, 'cbv-card__divider')).toBe(0);
    expect(html).not.toContain('cbv-card__attributes');
  });

  it('标题 + 属性均有内容 → 1 条分隔线', () => {
    const l = layout({
      title: slot('title', [placement('f_text', 0)]),
      attributes: slot('attributes', [placement('f_amount', 0)]),
    });
    const html = render(l, record({ f_text: '苹果', f_amount: 100 }));
    expect(count(html, 'cbv-card__divider')).toBe(1);
  });

  it('标题 + 属性 + 底部均有内容 → 2 条分隔线', () => {
    const l = layout({
      title: slot('title', [placement('f_text', 0)]),
      attributes: slot('attributes', [placement('f_amount', 0)]),
      footer: slot('footer', [placement('f_note', 0)]),
    });
    const html = render(l, record({ f_text: '苹果', f_amount: 100, f_note: '备注内容' }));
    expect(count(html, 'cbv-card__divider')).toBe(2);
  });
});

/* ============================ R3：属性区行数 ============================ */

describe('T09/R3 · 属性区行数（默认 3）+ 超出显示 +n', () => {
  it('密度三档 attributesMaxRows = 2 / 3 / 5', () => {
    expect(DENSITY_PRESETS.compact.attributesMaxRows).toBe(2);
    expect(DENSITY_PRESETS.standard.attributesMaxRows).toBe(3);
    expect(DENSITY_PRESETS.comfortable.attributesMaxRows).toBe(5);
    expect(attributesMaxRows(defaultDensity())).toBe(3); // 标准档默认
    expect(resolveDensityPreset(defaultDensity())).toBe('standard');
  });

  it('5 个有值字段 + attributesMaxRows=3 → 渲染 3 行 + 「+2」', () => {
    const placements = [
      placement('f_text', 0),
      placement('f_amount', 1),
      placement('f_note', 2),
      { ...placement('f_text', 3), placementId: 'p_dup_3' },
      { ...placement('f_amount', 4), placementId: 'p_dup_4' },
    ];
    const l = layout({ attributes: slot('attributes', placements, { maxItemsPerCard: 8 }) });
    const html = render(l, record({ f_text: '苹果', f_amount: 100, f_note: '备注' }), 3);
    expect(count(html, 'cbv-attr-row__label')).toBe(3);
    expect(html).toContain('+2');
  });

  it('attributesMaxRows=0（未配置）→ 取密度档默认', () => {
    expect(attributesMaxRows({ ...defaultDensity(), attributesMaxRows: undefined })).toBe(3);
  });
});

/* ============================ cover 模板 vs R4 ============================ */

describe('T09/R4 · cover「大图」模板不绕过 R4（卡片不显示封面图）', () => {
  it('applyCardTemplate("cover") → showCoverImage=false（扩展位恒 false）', () => {
    const l = applyCardTemplate('cover', layout({ attributes: slot('attributes', [placement('f_img', 0)]) }));
    expect(l.showCoverImage).toBe(false);
    expect(l.templateId).toBe('cover');
  });

  it('cover 卡片：无封面槽位/封面元素，仅属性区 64×64 首图', () => {
    // 保持附件落在「属性区」，验证 cover 的“大图”确由属性区首图体现（而非封面槽位）
    const l: CardLayoutConfig = {
      ...layout({ attributes: slot('attributes', [placement('f_img', 0)]) }),
      templateId: 'cover',
      showCoverImage: false,
    };
    const html = render(
      l,
      record({ f_img: [{ file_token: 'TOKEN_X', name: 'cover.png', tmpUrl: 'https://cdn.example/c.png' }] }),
    );
    expect(html).toContain('cbv-card--cover');
    expect(html).toContain('cbv-card__attributes');
    expect(html).not.toContain('封面');
    expect(html).not.toContain('cbv-card__cover');
    // 卡片内唯一的 <img> 是属性区 64px 首图（不是封面图）
    expect(count(html, '<img')).toBe(1);
    expect(html).toContain('width:64px');
  });

  it('模板画廊四档存在且 cover 描述明确「不显示封面图」', () => {
    const ids = CARD_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['compact', 'standard', 'cover', 'list']));
    const cover = CARD_TEMPLATES.find((t) => t.id === 'cover');
    expect(cover?.description).toContain('不显示封面图');
  });
});
