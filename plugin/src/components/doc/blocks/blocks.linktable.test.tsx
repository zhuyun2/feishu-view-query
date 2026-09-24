/**
 * 关联字段**只读表格**渲染单测（需求 2 · 第一阶段 · 文档态）。
 *
 * 断言原则（团队禁令）：每条断言都必须能被「把实现改坏」证伪。
 *  ⚠️ 负面断言（「没有操作控件」/「没有 id 泄漏」）**必须配正面锚点**（表格确实渲染出来了、
 *     具体单元格文本确实在），否则「整块没渲染」也会让负面断言假绿。
 *
 * 本文件锁定：
 *  ① 字段级：`fieldList` / `keyValueGrid` 绑定的关联字段（`Link`/`DuplexLink`）在有预取数据时
 *     渲染为**只读表格**；**无数据则完好回退**到既有文本呈现（优雅降级）；
 *  ② 表格结构：表头列名（目标表字段名）/ 行数 / 单元格文本 / 宽度不超内容盒；
 *  ③ **只读**：子树内没有任何交互控件（按钮/输入/可编辑/链接/排序箭头）；
 *  ④ **测量契约**：`data-repeat-header` 恰好一个（在 `<thead>`）、行带 `data-unit-index`；
 *  ⑤ **不泄漏 recordId**：`innerHTML` 里不得出现被关联记录 id；
 *  ⑥ 跨页片段：`fragmentsTotal > 1` 时续片**省略**「字段名：」前缀（与 `docLabelPrefix` 同口径）；
 *  ⑦ 区块级：`table` 块 `rowSource = linkedRecords` 用注入的**目标表列**且溢出显示「+N」。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocBlock, DocTheme, FieldListBlock, KeyValueGridBlock, TableBlock } from '@/config/types';
import { defaultDocTheme } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock } from '@/doc/resolve';
import { buildLinkTable } from '@/doc/linkTable';
import type { LinkTable } from '@/doc/linkTable';
import type { BlockRendererProps } from './BlockRenderer';
import { BlockRenderer } from './BlockRenderer';

const THEME: DocTheme = defaultDocTheme();
const CONTENT_WIDTH = 650;

/* ---------- 当前（主）表 ---------- */
const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_LINK: FieldMetaLite = { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false };
const FIELDS: readonly FieldMetaLite[] = [FIELD_TITLE, FIELD_LINK];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f_title: FIELD_TITLE, f_link: FIELD_LINK };

const RECORD = {
  recordId: 'rec_main',
  fields: { f_title: '张三', f_link: { text: '一期工程', recordIds: ['rec_l1', 'rec_l2'], tableId: 'tbl_t' } },
} as unknown as SdkRecord;

/* ---------- 目标表 ---------- */
const TF_NAME: FieldMetaLite = { id: 'tf_name', name: '项目名称', type: FieldType.Text, isPrimary: true };
const TF_AMOUNT: FieldMetaLite = { id: 'tf_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const TF_OWNER: FieldMetaLite = { id: 'tf_owner', name: '负责人', type: FieldType.User, isPrimary: false };
const TF_NOTE: FieldMetaLite = { id: 'tf_note', name: '备注', type: FieldType.Text, isPrimary: false };
const TARGET_FIELDS: FieldMetaLite[] = [TF_NAME, TF_AMOUNT, TF_OWNER, TF_NOTE];

const LINK_REF = { recordIds: ['rec_l1', 'rec_l2', 'rec_l3'], tableId: 'tbl_t' };
const ROW_RECORDS = [
  { recordId: 'rec_l1', fields: { tf_name: '一期工程', tf_amount: 1234567, tf_owner: [{ name: '张三' }], tf_note: '备注一' } },
  { recordId: 'rec_l2', fields: { tf_name: '二期工程', tf_amount: 200, tf_owner: [{ name: '李四' }], tf_note: '备注二' } },
  { recordId: 'rec_l3', fields: { tf_name: '三期工程', tf_amount: 300, tf_owner: [{ name: '王五' }], tf_note: '备注三' } },
];

function linkTableFixture(): LinkTable {
  return buildLinkTable(LINK_REF, TARGET_FIELDS, ROW_RECORDS);
}

/* ---------- 夹具构造 / 渲染 ---------- */

function fieldListBlock(showLabels = true): FieldListBlock {
  return {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: [{ fieldId: 'f_title' }, { fieldId: 'f_link' }],
    showLabels,
    hideEmptyItems: false,
  };
}

function kvGridBlock(): KeyValueGridBlock {
  return {
    blockId: 'blk_kv',
    kind: 'keyValueGrid',
    breakInside: 'avoid',
    columns: 1,
    rows: [{ fieldId: 'f_title' }, { fieldId: 'f_link' }],
    labelWidthPx: 88,
    showColon: true,
    zebra: false,
    hideEmptyRows: false,
  };
}

function tableBlock(rowSourceFieldId = 'f_link'): TableBlock {
  return {
    blockId: 'blk_tbl',
    kind: 'table',
    breakInside: 'auto',
    columns: [{ fieldId: 'f_title' }],
    rowSource: { type: 'linkedRecords', fieldId: rowSourceFieldId },
    showHeader: true,
    zebra: true,
  };
}

function renderToDom(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  return host;
}

function resolveWith(block: DocBlock, linkedRecords?: Map<string, LinkTable>): ResolvedBlock {
  const resolved = resolveBlocks({
    blocks: [block],
    record: RECORD,
    fields: FIELDS as FieldMetaLite[],
    ...(linkedRecords ? { linkedRecords } : {}),
  });
  expect(resolved.length).toBe(1);
  return resolved[0] as ResolvedBlock;
}

function renderBlock(
  block: DocBlock,
  linkedRecords?: Map<string, LinkTable>,
  overrides: Partial<BlockRendererProps> = {},
): HTMLElement {
  return renderToDom(
    <BlockRenderer
      resolved={resolveWith(block, linkedRecords)}
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

function linkMap(table: LinkTable, fieldId = 'f_link'): Map<string, LinkTable> {
  return new Map([[fieldId, table]]);
}

/* ===================== ① fieldList：文本 → 只读表格 ===================== */

describe('需求2 · fieldList 里的关联字段 → 只读表格', () => {
  it('⭐ 有预取数据 → 渲染只读表格（正面锚点：行/列/单元格文本都在）', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()));

    const table = host.querySelector<HTMLElement>('table[data-link-table="true"]');
    expect(table).not.toBeNull();

    // 表头 = 目标表「主字段 + 前 3 可用字段」的确切列名
    const headers = Array.from(table?.querySelectorAll('thead th') ?? []).map((th) => th.textContent);
    expect(headers).toEqual(['项目名称', '金额', '负责人', '备注']);

    // 行数 + 首/末行内容锚点（防「恒返回空表」假绿）
    const rows = Array.from(table?.querySelectorAll('tbody tr') ?? []);
    expect(rows.length).toBe(3);
    expect(rows[0]?.textContent).toContain('一期工程');
    expect(rows[0]?.textContent).toContain('1,234,567');
    expect(rows[0]?.textContent).toContain('张三');
    expect(rows[2]?.textContent).toContain('三期工程');

    // 标签（`showLabels=true`）由表格自己按 `docLabelPrefix` 同口径画出
    const label = host.querySelector<HTMLElement>('[data-link-table-label="true"]');
    expect(label?.textContent).toBe('关联项目：');

    // 原文本呈现**不再出现**（否则等于两张都画）
    expect(host.querySelectorAll('.cbv-lookup__item').length).toBe(0);
  });

  it('⭐ 无预取数据（编辑器无 SDK / 取数失败）→ **完好回退**文本呈现，且不画空表', () => {
    const host = renderBlock(fieldListBlock());

    // 正面锚点：既有文本列表确实渲染（不能是「整块没渲染」）
    const items = Array.from(host.querySelectorAll('.cbv-lookup__item')).map((node) => node.textContent);
    expect(items).toEqual(['一期工程']);
    // 反面锚点：没有任何只读表格
    expect(host.querySelectorAll('[data-doc-linktable]').length).toBe(0);
    expect(host.querySelectorAll('table[data-link-table="true"]').length).toBe(0);
  });

  it('关联为空（预取表列不可用）→ 回退文本呈现（不画无列空表）', () => {
    const empty = buildLinkTable(LINK_REF, [], ROW_RECORDS);
    const host = renderBlock(fieldListBlock(), linkMap(empty));
    expect(host.querySelectorAll('table[data-link-table="true"]').length).toBe(0);
    expect(host.querySelectorAll('.cbv-lookup__item').length).toBe(1);
  });

  it('showLabels=false → 不画标签前缀（表格仍渲染）', () => {
    const host = renderBlock(fieldListBlock(false), linkMap(linkTableFixture()));
    expect(host.querySelectorAll('table[data-link-table="true"]').length).toBe(1);
    expect(host.querySelectorAll('[data-link-table-label="true"]').length).toBe(0);
  });

  it('⭐ 跨页续片（fragmentsTotal=2, fragmentIndex=1）→ 省略「字段名：」前缀，表格仍在', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()), {
      fragmentIndex: 1,
      fragmentsTotal: 2,
    });
    expect(host.querySelectorAll('table[data-link-table="true"]').length).toBe(1);
    expect(host.querySelectorAll('[data-link-table-label="true"]').length).toBe(0);
  });
});

/* ===================== ② 只读：无任何操作控件 ===================== */

describe('需求2 · 只读保证（无排序 / 无编辑 / 无新增 / 无配置入口）', () => {
  it('⭐ 表格子树内没有任何交互控件（负面断言 + 正面锚点配对）', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()));
    const wrapper = host.querySelector<HTMLElement>('[data-doc-linktable]');
    // 正面锚点：表格确实渲染了（否则下面的负面断言是假绿）
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelectorAll('tbody tr').length).toBe(3);

    const interactive = wrapper?.querySelectorAll(
      'button, input, select, textarea, a[href], [contenteditable="true"], [role="button"], [role="textbox"], [data-sort], [data-edit], [data-add-record]',
    );
    expect(interactive?.length).toBe(0);
    // 表格内容里不得出现「+ 添加记录」之类入口文案
    expect(wrapper?.textContent ?? '').not.toContain('添加记录');
    expect(wrapper?.textContent ?? '').not.toContain('+');
  });

  it('⭐ 不泄漏被关联记录 id（`innerHTML` 全面扫一遍）', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()));
    const html = host.innerHTML;
    for (const leaked of ['rec_l1', 'rec_l2', 'rec_l3']) {
      expect(html).not.toContain(leaked);
    }
    // 双保险：字段 id 也不该被当成展示文本（表头必须是**字段名**）
    const headers = Array.from(host.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).not.toContain('tf_name');
  });
});

/* ===================== ③ 测量契约 ===================== */

describe('需求2 · 表格结构与测量契约标记', () => {
  it('⭐ 表头恰好一个 `data-repeat-header`（就是 `<thead>`），行 `data-unit-index` 为 0..n-1', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()));
    const wrapper = host.querySelector<HTMLElement>('[data-doc-linktable]') as HTMLElement;

    const headers = wrapper.querySelectorAll('[data-repeat-header]');
    expect(headers.length).toBe(1);
    expect(headers[0]?.tagName).toBe('THEAD');

    const rows = Array.from(wrapper.querySelectorAll<HTMLElement>('tbody tr[data-unit-index]'));
    expect(rows.map((row) => row.getAttribute('data-unit-index'))).toEqual(['0', '1', '2']);
    // 每行列数 = 表头列数（结构自洽）
    expect(rows[0]?.querySelectorAll('td').length).toBe(4);
  });

  it('⭐ 表格宽度不超过内容盒（外层 `maxWidth` = contentWidth；表 `width:100%`）', () => {
    const host = renderBlock(fieldListBlock(), linkMap(linkTableFixture()));
    const wrapper = host.querySelector<HTMLElement>('[data-doc-linktable]') as HTMLElement;
    const table = wrapper.querySelector<HTMLElement>('table') as HTMLElement;
    expect(wrapper.style.maxWidth).toBe(`${CONTENT_WIDTH}px`);
    expect(table.style.width).toBe('100%');
    expect(table.style.borderCollapse).toBe('collapse');
  });

  it('溢出（25 条 / 上限 20）→ 行 20 条 + 「+5」告知（不静默丢行）', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rec_${i}`);
    const records = ids.map((id, i) => ({ recordId: id, fields: { tf_name: `项目${i}`, tf_amount: i } }));
    const big = buildLinkTable({ recordIds: ids, tableId: 'tbl_t' }, TARGET_FIELDS, records);

    const host = renderBlock(fieldListBlock(), linkMap(big));
    const wrapper = host.querySelector<HTMLElement>('[data-doc-linktable]') as HTMLElement;
    expect(wrapper.querySelectorAll('tbody tr').length).toBe(20);
    const more = wrapper.querySelector<HTMLElement>('[data-link-table-more]');
    expect(more?.textContent).toBe('+5');
  });

  it('单元格缺 meta（目标表字段元数据缺失）→ 该格回退为「—」占位而非崩溃', () => {
    const table = linkTableFixture();
    const withoutMeta: LinkTable = {
      columns: table.columns.map((column) => ({ fieldId: column.fieldId, label: column.label })),
      rows: table.rows,
    };
    const host = renderBlock(fieldListBlock(), linkMap(withoutMeta));
    // 列仍在（表头由 label 画），单元格走 `DocFieldValue` 的缺 meta 占位分支
    const headers = Array.from(host.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['项目名称', '金额', '负责人', '备注']);
    expect(host.querySelectorAll('.cbv-doc-field--missing').length).toBeGreaterThan(0);
  });
});

/* ===================== ④ keyValueGrid ===================== */

describe('需求2 · keyValueGrid 里的关联字段 → 只读表格', () => {
  it('值位换成只读表格；其它行仍是普通文本（不误伤）', () => {
    const host = renderBlock(kvGridBlock(), linkMap(linkTableFixture()));

    const cells = Array.from(host.querySelectorAll('.cbv-doc-kv-cell'));
    expect(cells.length).toBe(2);
    // 第 1 行（客户名称）保持文本
    expect(cells[0]?.textContent).toContain('张三');
    expect(cells[0]?.querySelector('table[data-link-table="true"]')).toBeNull();
    // 第 2 行（关联项目）换成表格
    const table = cells[1]?.querySelector<HTMLElement>('table[data-link-table="true"]');
    expect(table).not.toBeNull();
    expect(Array.from(table?.querySelectorAll('thead th') ?? []).map((th) => th.textContent)).toEqual([
      '项目名称',
      '金额',
      '负责人',
      '备注',
    ]);
    // keyValueGrid 的标签由本组件画，表格不重复画标签
    expect(cells[1]?.querySelector('[data-link-table-label="true"]')).toBeNull();
  });

  it('无预取数据 → keyValueGrid 值位保持文本（优雅降级）', () => {
    const host = renderBlock(kvGridBlock());
    expect(host.querySelectorAll('table[data-link-table="true"]').length).toBe(0);
    expect(host.querySelectorAll('.cbv-lookup__item').length).toBe(1);
  });
});

/* ===================== ⑤ 区块级 table（对齐多维表格默认呈现） ===================== */

describe('需求2 · table 块 rowSource=linkedRecords 使用**目标表列**', () => {
  it('⭐ 列来自注入的**目标表**（不是本表 block.columns），行来自被关联记录', () => {
    const host = renderBlock(tableBlock(), linkMap(linkTableFixture()));
    const table = host.querySelector<HTMLElement>('table.cbv-doc-table') as HTMLElement;
    expect(table).not.toBeNull();

    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['项目名称', '金额', '负责人', '备注']); // 目标表列，而非「客户名称」
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(3);
    expect(rows[1]?.textContent).toContain('二期工程');

    // 区块级 table 的测量契约仍在
    expect(table.querySelectorAll('[data-repeat-header]').length).toBe(1);
    expect(rows.map((row) => row.getAttribute('data-unit-index'))).toEqual(['0', '1', '2']);
  });

  it('溢出 → 「+N」；且不泄漏 recordId', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rec_${i}`);
    const records = ids.map((id, i) => ({ recordId: id, fields: { tf_name: `项目${i}` } }));
    const big = buildLinkTable({ recordIds: ids, tableId: 'tbl_t' }, TARGET_FIELDS, records);

    const host = renderBlock(tableBlock(), linkMap(big));
    expect(host.querySelector('[data-table-more]')?.textContent).toBe('+5');
    for (const id of ['rec_0', 'rec_19', 'rec_24']) expect(host.innerHTML).not.toContain(id);
  });
});

/* ===================== ⑥ 源码级：只读 + 复用 TableView 结构 ===================== */

describe('需求2 · 源码级断言（MediaBlocks.LinkTableView）', () => {
  it('LinkTableView 保留测量契约标记，且不含任何写/编辑接口', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const strip = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const source = strip(readFileSync(resolve(process.cwd(), 'src/components/doc/blocks/MediaBlocks.tsx'), 'utf8'));

    // 正面锚点：确实复用了表格标记
    expect(source).toMatch(/data-repeat-header="true"/);
    expect(source).toMatch(/data-unit-index=\{index\}/);
    expect(source).toMatch(/export function LinkTableView/);
    // 负面锚点：不得出现任何编辑入口 / 写接口
    for (const forbidden of ['onClick', 'contentEditable', 'addRecord', 'setCellValue', 'onChange']) {
      expect(source, `不得出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
