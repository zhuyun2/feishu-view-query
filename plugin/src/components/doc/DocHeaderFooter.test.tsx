/**
 * T06 · `DocHeaderFooter` 单测。
 *
 * 断言：页码三种格式的**确切文本**、占位符解析出的**段序列与字段 id**、页眉/页脚落在
 * 页顶/页底 **margin 带**（`top:0`/`bottom:0` 且高 = 对应页边距）、`showBorder` 与
 * `showPageNumber` 的开关语义、以及字段占位符**真的**渲染成字段值（不是字面量 `{…}`）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocTheme, PageSetup } from '@/config/types';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import {
  DocHeaderFooter,
  formatPageNumber,
  parseHeaderFooterContent,
  type HeaderFooterSegment,
} from './DocHeaderFooter';

const THEME: DocTheme = defaultDocTheme();
const MARGIN = 72;

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_MTIME: FieldMetaLite = { id: 'f_mtime', name: '修改时间', type: FieldType.ModifiedTime, isPrimary: false };
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f_title: FIELD_TITLE, f_mtime: FIELD_MTIME };
const RECORD = {
  recordId: 'rec_1',
  fields: { f_title: '张三', f_mtime: 1735689600000 },
} as unknown as SdkRecord;

function renderToDom(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  return host;
}

function setup(overrides: Partial<PageSetup> = {}): PageSetup {
  const base = defaultPageSetup();
  return {
    ...base,
    header: { enabled: true, content: '', align: 'center', fontSize: 12, color: '#8F959E', showBorder: false },
    footer: { enabled: true, content: '', align: 'center', fontSize: 12, color: '#8F959E', showBorder: false },
    ...overrides,
  };
}

function node(
  variant: 'header' | 'footer',
  setupValue: PageSetup,
  pageIndex = 0,
  totalPages = 1,
): HTMLElement {
  return renderToDom(
    <DocHeaderFooter
      variant={variant}
      pageIndex={pageIndex}
      totalPages={totalPages}
      setup={setupValue}
      theme={THEME}
      record={RECORD}
      fieldsById={FIELDS_BY_ID}
      locale="zh-CN"
    />,
  );
}

/* ===================== 纯函数 ===================== */

describe('formatPageNumber（§21.3.4 pageNumberFormat）', () => {
  it('n / n÷total / 第n页 三种格式的确切文本', () => {
    expect(formatPageNumber('n', 0, 3)).toBe('1');
    expect(formatPageNumber('n/total', 0, 3)).toBe('1/3');
    expect(formatPageNumber('n/total', 2, 3)).toBe('3/3');
    expect(formatPageNumber('page-n', 1, 3)).toBe('第2页');
  });
});

describe('parseHeaderFooterContent（占位符解析）', () => {
  it('纯静态文本 → 单文本段', () => {
    expect(parseHeaderFooterContent('客户档案', FIELDS_BY_ID, 'rec_1')).toEqual([
      { kind: 'text', text: '客户档案' },
    ]);
  });

  it('{记录标题} → 主字段段（fieldId = isPrimary 字段）', () => {
    const segments: HeaderFooterSegment[] = parseHeaderFooterContent('{记录标题}', FIELDS_BY_ID, 'rec_1');
    expect(segments).toEqual([{ kind: 'field', fieldId: 'f_title', labelText: '客户名称' }]);
  });

  it('文本 + 占位符混排 → 保序的段序列，且 {修改时间} 命中 ModifiedTime 字段', () => {
    const segments = parseHeaderFooterContent('生成于 {修改时间}', FIELDS_BY_ID, 'rec_1');
    expect(segments).toEqual([
      { kind: 'text', text: '生成于 ' },
      { kind: 'field', fieldId: 'f_mtime', labelText: '修改时间' },
    ]);
  });

  it('{记录ID} 有记录 → 文本段；无记录 → 保留字面量', () => {
    expect(parseHeaderFooterContent('{记录ID}', FIELDS_BY_ID, 'rec_9')).toEqual([{ kind: 'text', text: 'rec_9' }]);
    expect(parseHeaderFooterContent('{记录ID}', FIELDS_BY_ID, '')).toEqual([{ kind: 'text', text: '{记录ID}' }]);
  });

  it('未知占位符 → 保留字面量（不静默丢弃，用户可自查拼写）', () => {
    expect(parseHeaderFooterContent('{未知}', FIELDS_BY_ID, 'rec_1')).toEqual([{ kind: 'text', text: '{未知}' }]);
  });
});

/* ===================== 渲染 ===================== */

describe('DocHeaderFooter · 落在页边距带内', () => {
  it('页眉：top=0、高=页边距；页脚：bottom=0、高=页边距', () => {
    const header = node('header', setup(), 0, 5).querySelector<HTMLElement>('[data-header-footer="header"]');
    const footer = node('footer', setup(), 0, 5).querySelector<HTMLElement>('[data-header-footer="footer"]');

    expect(header?.style.top).toBe('0px');
    expect(header?.style.height).toBe(`${MARGIN}px`);
    expect(header?.dataset.pageIndex).toBe('0');
    expect(footer?.style.bottom).toBe('0px');
    expect(footer?.style.height).toBe(`${MARGIN}px`);
  });

  it('对齐与字号来自配置（center → 居中；left → flex-start）', () => {
    const centered = node('header', setup({ header: { enabled: true, content: '', align: 'center', fontSize: 14, color: '#333', showBorder: false } }));
    const left = node('header', setup({ header: { enabled: true, content: '', align: 'left', fontSize: 14, color: '#333', showBorder: false } }));

    expect(centered.querySelector<HTMLElement>('[data-header-footer="header"]')?.style.justifyContent).toBe('center');
    expect(left.querySelector<HTMLElement>('[data-header-footer="header"]')?.style.justifyContent).toBe('flex-start');
  });
});

describe('DocHeaderFooter · 字段占位符渲染为字段值', () => {
  it('{记录标题} 渲染出主字段值「张三」，不残留花括号', () => {
    const host = node('header', setup({ header: { enabled: true, content: '{记录标题}', align: 'left', fontSize: 12, color: '#333', showBorder: false } }));
    const content = host.querySelector<HTMLElement>('[data-header-footer-content="header"]');
    expect(content?.textContent).toContain('张三');
    expect(content?.textContent ?? '').not.toContain('{');
  });

  it('混排文本 + {修改时间} → 均被渲染，无字面量占位符', () => {
    const host = node('header', setup({ header: { enabled: true, content: '生成于 {修改时间}', align: 'left', fontSize: 12, color: '#333', showBorder: false } }));
    const content = host.querySelector<HTMLElement>('[data-header-footer-content="header"]');
    expect(content?.textContent).toContain('生成于');
    expect(content?.textContent ?? '').not.toContain('{');
    expect((content?.querySelector('[data-field-id="f_mtime"]') as HTMLElement | null)?.textContent ?? '').not.toBe('');
  });
});

describe('DocHeaderFooter · 页码与分隔线开关', () => {
  it('showPageNumber=false → 无页码节点', () => {
    const host = node('footer', setup({ showPageNumber: false }));
    expect(host.querySelectorAll('[data-page-number]').length).toBe(0);
  });

  it('showPageNumber=true → 页脚页码按格式呈现；页眉不含页码', () => {
    const footer = node('footer', setup({ pageNumberFormat: 'n/total', showPageNumber: true }), 2, 5);
    expect(footer.querySelector('[data-page-number="footer"]')?.textContent).toBe('3/5');

    const header = node('header', setup({ pageNumberFormat: 'n/total', showPageNumber: true }), 2, 5);
    expect(header.querySelectorAll('[data-page-number]').length).toBe(0);
  });

  it('showBorder：true → 渲染分隔线；false → 不渲染', () => {
    const withBorder = node('header', setup({ header: { enabled: true, content: '', align: 'center', fontSize: 12, color: '#333', showBorder: true } }));
    expect(withBorder.querySelector('[data-header-footer-border="header"]')).not.toBeNull();

    const withoutBorder = node('header', setup());
    expect(withoutBorder.querySelectorAll('[data-header-footer-border]').length).toBe(0);
  });
});
