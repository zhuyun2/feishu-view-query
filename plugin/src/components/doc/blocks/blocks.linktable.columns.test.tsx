/**
 * 需求 2 · 第二阶段：**配置列**的只读表格渲染单测。
 *
 * 断言原则（团队禁令）：负面断言（无操作控件 / 无 id 泄漏）**必须配正面锚点**（表头 / 单元格文本确在）。
 *
 * 本文件锁定：
 *  ① 表头顺序 = **配置顺序**；单元格列数与表头列数**同步**（列数变化时不失配）；
 *  ② 配置列**不受可用性过滤**（用户显式选的字段照常保留，即便无专属渲染器）；
 *  ③ 仍然**只读**（无任何交互控件）且**不泄漏 recordId**；
 *  ④ 区块级 `table(rowSource=linkedRecords)` 同样吃配置列（与 fieldList 共用列解析）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocBlock, DocTheme, FieldListBlock, TableBlock } from '@/config/types';
import { defaultDocTheme } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { buildLinkTable } from '@/doc/linkTable';
import type { LinkTable } from '@/doc/linkTable';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock } from '@/doc/resolve';
import type { BlockRendererProps } from './BlockRenderer';
import { BlockRenderer } from './BlockRenderer';

const THEME: DocTheme = defaultDocTheme();
const CONTENT_WIDTH = 650;

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_LINK: FieldMetaLite = { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false };
const FIELDS: readonly FieldMetaLite[] = [FIELD_TITLE, FIELD_LINK];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f_title: FIELD_TITLE, f_link: FIELD_LINK };

const RECORD = {
  recordId: 'rec_main',
  fields: { f_title: '张三', f_link: { text: '一期工程', recordIds: ['rec_l1', 'rec_l2'], tableId: 'tbl_t' } },
} as unknown as SdkRecord;

const TF_NAME: FieldMetaLite = { id: 'tf_name', name: '项目名称', type: FieldType.Text, isPrimary: true };
const TF_AMOUNT: FieldMetaLite = { id: 'tf_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const TF_OWNER: FieldMetaLite = { id: 'tf_owner', name: '负责人', type: FieldType.User, isPrimary: false };
const TF_NOTE: FieldMetaLite = { id: 'tf_note', name: '备注', type: FieldType.Text, isPrimary: false };
/** 无专属渲染器（Location）—— 用于验证「配置列不受可用性过滤」 */
const TF_LOCATION: FieldMetaLite = { id: 'tf_location', name: '位置', type: FieldType.Location, isPrimary: false };
const TARGET_FIELDS: FieldMetaLite[] = [TF_NAME, TF_AMOUNT, TF_OWNER, TF_NOTE, TF_LOCATION];

const LINK_REF = { recordIds: ['rec_l1', 'rec_l2', 'rec_l3'], tableId: 'tbl_t' };
const ROW_RECORDS = [
  { recordId: 'rec_l1', fields: { tf_name: '一期工程', tf_amount: 1234567, tf_owner: [{ name: '张三' }], tf_note: '备注一' } },
  { recordId: 'rec_l2', fields: { tf_name: '二期工程', tf_amount: 200, tf_owner: [{ name: '李四' }], tf_note: '备注二' } },
  { recordId: 'rec_l3', fields: { tf_name: '三期工程', tf_amount: 300, tf_owner: [{ name: '王五' }], tf_note: '备注三' } },
];

function fieldListBlock(): FieldListBlock {
  return {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: [{ fieldId: 'f_title' }, { fieldId: 'f_link' }],
    showLabels: true,
    hideEmptyItems: false,
  };
}

function tableBlock(): TableBlock {
  return {
    blockId: 'blk_tbl',
    kind: 'table',
    breakInside: 'auto',
    columns: [{ fieldId: 'f_title' }],
    rowSource: { type: 'linkedRecords', fieldId: 'f_link' },
    showHeader: true,
    zebra: true,
  };
}

function renderToDom(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  return host;
}

function renderBlock(block: DocBlock, table: LinkTable, overrides: Partial<BlockRendererProps> = {}): HTMLElement {
  const linked = new Map<string, LinkTable>([['f_link', table]]);
  const resolved = resolveBlocks({ blocks: [block], record: RECORD, fields: FIELDS as FieldMetaLite[], linkedRecords: linked });
  expect(resolved.length).toBe(1);
  return renderToDom(
    <BlockRenderer
      resolved={resolved[0] as ResolvedBlock}
      fragmentIndex={0}
      fragmentsTotal={1}
      theme={THEME}
      locale="zh-CN"
      record={RECORD}
      fieldsById={FIELDS_BY_ID}
      contentWidth={CONTENT_WIDTH}
      {...overrides}
    />,
  );
}

function headersOf(host: HTMLElement): string[] {
  const table = host.querySelector<HTMLElement>('table[data-link-table="true"]') ?? host.querySelector<HTMLElement>('table.cbv-doc-table');
  return Array.from(table?.querySelectorAll('thead th') ?? []).map((th) => th.textContent ?? '');
}

/* ===================== ① 表头顺序 = 配置顺序 ===================== */

describe('需求2-2 · 配置列的顺序即显示顺序', () => {
  it('⭐ 配置 [备注, 金额] → 表头就是 [备注, 金额]（顺序敏感）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_note', 'tf_amount'] });
    const host = renderBlock(fieldListBlock(), table);
    expect(headersOf(host)).toEqual(['备注', '金额']);

    // 正面锚点：单元格文本确实按列渲染
    const firstRow = host.querySelector<HTMLElement>('tbody tr');
    expect(firstRow?.textContent).toContain('备注一');
    expect(firstRow?.textContent).toContain('1,234,567');
  });

  it('⭐ 列数变化时表头与单元格**同步**（2 列 vs 4 列不失配）', () => {
    const two = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_note', 'tf_amount'] });
    const four = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_name', 'tf_amount', 'tf_owner', 'tf_note'] });

    const hostTwo = renderBlock(fieldListBlock(), two);
    const hostFour = renderBlock(fieldListBlock(), four);

    expect(headersOf(hostTwo).length).toBe(2);
    expect(headersOf(hostFour).length).toBe(4);

    for (const host of [hostTwo, hostFour]) {
      const headerCount = host.querySelectorAll('thead th').length;
      for (const row of Array.from(host.querySelectorAll('tbody tr'))) {
        expect(row.querySelectorAll('td').length).toBe(headerCount);
      }
    }
    // 两渲染确实不同（防「恒返回同一份」假绿）
    expect(headersOf(hostTwo)).not.toEqual(headersOf(hostFour));
  });

  it('⭐ 配置列不受可用性过滤：无专属渲染器的字段（Location）也照常保留', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_location', 'tf_name'] });
    const host = renderBlock(fieldListBlock(), table);
    expect(headersOf(host)).toEqual(['位置', '项目名称']);
  });

  it('区块级 table(rowSource=linkedRecords) 同样按配置顺序出列', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_owner', 'tf_name'] });
    const host = renderBlock(tableBlock(), table);
    expect(headersOf(host)).toEqual(['负责人', '项目名称']);
    expect(host.querySelectorAll('tbody tr').length).toBe(3);
  });
});

/* ===================== ② 只读 + 不泄漏 ===================== */

describe('需求2-2 · 配置列下仍只读且不泄漏 recordId', () => {
  it('⭐ 无任何交互控件（负面断言 + 正面锚点配对）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_name', 'tf_note'] });
    const host = renderBlock(fieldListBlock(), table);
    const wrapper = host.querySelector<HTMLElement>('[data-doc-linktable]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelectorAll('tbody tr').length).toBe(3);

    const interactive = wrapper?.querySelectorAll(
      'button, input, select, textarea, a[href], [contenteditable="true"], [role="button"], [role="textbox"], [data-sort], [data-edit], [data-add-record]',
    );
    expect(interactive?.length).toBe(0);
    expect(wrapper?.textContent ?? '').not.toContain('添加记录');
  });

  it('⭐ recordId 不出现在 innerHTML（配置列路径同样成立）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS, { columns: ['tf_name', 'tf_note'] });
    const host = renderBlock(fieldListBlock(), table);
    for (const id of ['rec_l1', 'rec_l2', 'rec_l3']) expect(host.innerHTML).not.toContain(id);
    // 测量契约仍在
    expect(host.querySelectorAll('[data-repeat-header]').length).toBe(1);
  });
});
