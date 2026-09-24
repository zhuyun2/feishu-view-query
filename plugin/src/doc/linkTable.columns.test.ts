/**
 * 需求 2 · 第二阶段：**关联表格列可配置** —— 列解析 / 配置收集 / 预取接线 单测。
 *
 * 断言原则（团队禁令）：每条断言都必须能被「把实现改坏」证伪。
 *  ⇒ 列断言一律配**内容锚点**（具体字段名 / 具体顺序），以杀死「恒返回默认列」这类假绿实现。
 *
 * 本文件锁定：
 *  ① `resolveLinkTableColumns`：**用户配置即权威**（顺序即列顺序、**不强制保留主字段**）；
 *     非法列 → 跳过并记入 `droppedColumns`；**全失效 → 回退默认列**并置 `columnsFallback`；
 *     未配置 / 空数组 / 非数组 → 默认列规则；
 *  ② `buildLinkTable({ columns })`：输出列序 = 配置序；`droppedColumns` / `columnsFallback` 正确；
 *     不泄漏 recordId；
 *  ③ `collectLinkFieldConfigs`：三处落点收集、冲突取首个并记录、非法值归一为「未配置」；
 *  ④ `prefetchLinkTables`：把区块里的配置落到预取结果（列序 / 行上限），并对
 *     「跳过列 / 回退默认列 / 行上限越界 / 冲突」各发**一条**告警（绝不静默）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocBlock, FieldListBlock, KeyValueGridBlock, TableBlock } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import {
  DEFAULT_LINK_TABLE_ROWS,
  MAX_LINK_TABLE_ROWS,
  buildLinkTable,
  collectLinkFieldConfigs,
  prefetchLinkTables,
  resolveLinkTableColumns,
} from './linkTable';
import type { LinkRowRecord, LinkTablePrefetchAccess } from './linkTable';

/* ===================== 夹具 ===================== */

const FIELD_LINK_A: FieldMetaLite = { id: 'f_link_a', name: '关联项目', type: FieldType.Link, isPrimary: false };
const FIELD_LINK_B: FieldMetaLite = { id: 'f_link_b', name: '双向关联', type: FieldType.DuplexLink, isPrimary: false };
const FIELD_TEXT: FieldMetaLite = { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true };
const MAIN_FIELDS: FieldMetaLite[] = [FIELD_TEXT, FIELD_LINK_A, FIELD_LINK_B];

const TF_NAME: FieldMetaLite = { id: 'tf_name', name: '项目名称', type: FieldType.Text, isPrimary: true };
const TF_AMOUNT: FieldMetaLite = { id: 'tf_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const TF_OWNER: FieldMetaLite = { id: 'tf_owner', name: '负责人', type: FieldType.User, isPrimary: false };
const TF_NOTE: FieldMetaLite = { id: 'tf_note', name: '备注', type: FieldType.Text, isPrimary: false };
const TARGET_FIELDS: FieldMetaLite[] = [TF_NAME, TF_AMOUNT, TF_OWNER, TF_NOTE];

const LINK_REF = { recordIds: ['rec_l1', 'rec_l2', 'rec_l3'], tableId: 'tbl_target' };
const ROWS: LinkRowRecord[] = [
  { recordId: 'rec_l1', fields: { tf_name: '一期工程', tf_amount: 1234567, tf_owner: [{ name: '张三' }], tf_note: '备注一' } },
  { recordId: 'rec_l2', fields: { tf_name: '二期工程', tf_amount: 200, tf_owner: [{ name: '李四' }], tf_note: '备注二' } },
  { recordId: 'rec_l3', fields: { tf_name: '三期工程', tf_amount: 300, tf_owner: [{ name: '王五' }], tf_note: '备注三' } },
];

function fieldList(items: Array<Record<string, unknown>>): FieldListBlock {
  return {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: items as unknown as FieldListBlock['items'],
    showLabels: true,
    hideEmptyItems: false,
  };
}

function kvGrid(rows: Array<Record<string, unknown>>): KeyValueGridBlock {
  return {
    blockId: 'blk_kv',
    kind: 'keyValueGrid',
    breakInside: 'auto',
    columns: 1,
    rows: rows as unknown as KeyValueGridBlock['rows'],
    labelWidthPx: 88,
    showColon: true,
    zebra: false,
    hideEmptyRows: false,
  };
}

function tableBlock(patch: Partial<TableBlock> = {}): TableBlock {
  return {
    blockId: 'blk_tbl',
    kind: 'table',
    breakInside: 'auto',
    columns: [{ fieldId: 'f_text' }],
    rowSource: { type: 'linkedRecords', fieldId: 'f_link_a' },
    showHeader: true,
    zebra: true,
    ...patch,
  };
}

function accessWith(overrides: Partial<LinkTablePrefetchAccess> = {}): LinkTablePrefetchAccess {
  return {
    reader: async () => ({ recordIds: ['rec_l1', 'rec_l2', 'rec_l3'], tableId: 'tbl_target' }),
    getTargetFieldMetas: async () => TARGET_FIELDS,
    getTargetRow: async (_tableId, recordId) => ({ recordId, fields: { tf_name: `行 ${recordId}`, tf_amount: 7 } }),
    ...overrides,
  };
}

/* ===================== ① 列解析 ===================== */

describe('resolveLinkTableColumns · 用户配置即权威', () => {
  it('⭐ 按用户给出的顺序输出（主字段不强制第一；未选的字段不出现）', () => {
    const res = resolveLinkTableColumns(TARGET_FIELDS, ['tf_owner', 'tf_amount']);
    expect(res.columns.map((c) => c.fieldId)).toEqual(['tf_owner', 'tf_amount']);
    // 主字段 tf_name 未选 → **不出现**（尊重用户；不替他加回来）
    expect(res.columns.map((c) => c.fieldId)).not.toContain('tf_name');
    expect(res.droppedColumns).toEqual([]);
    expect(res.usedFallbackDefault).toBe(false);
    // 内容锚点：列标题取自目标表字段名
    expect(res.columns.map((c) => c.label)).toEqual(['负责人', '金额']);
  });

  it('⭐ 非法列（目标表找不到）→ 跳过该列 + 记入 droppedColumns；其余照常按序输出', () => {
    const res = resolveLinkTableColumns(TARGET_FIELDS, ['tf_ghost', 'tf_note', 'tf_name']);
    expect(res.columns.map((c) => c.fieldId)).toEqual(['tf_note', 'tf_name']);
    expect(res.droppedColumns).toEqual(['tf_ghost']);
    expect(res.usedFallbackDefault).toBe(false);
  });

  it('⭐ 配置列**全部失效** → 回退默认列（主字段 + 前 3 可用）+ usedFallbackDefault', () => {
    const res = resolveLinkTableColumns(TARGET_FIELDS, ['tf_ghost', 'tf_ghost2']);
    expect(res.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);
    expect(res.usedFallbackDefault).toBe(true);
    expect(res.droppedColumns).toEqual(['tf_ghost', 'tf_ghost2']);
  });

  it('未配置 / 空数组 / 空串项 → 默认列规则（零回归）', () => {
    const base = ['tf_name', 'tf_amount', 'tf_owner', 'tf_note'];
    expect(resolveLinkTableColumns(TARGET_FIELDS, undefined).columns.map((c) => c.fieldId)).toEqual(base);
    expect(resolveLinkTableColumns(TARGET_FIELDS, []).columns.map((c) => c.fieldId)).toEqual(base);
    expect(resolveLinkTableColumns(TARGET_FIELDS, ['', '']).columns.map((c) => c.fieldId)).toEqual(base);
  });

  it('配置里去重保序（重复 id 只出一列）', () => {
    const res = resolveLinkTableColumns(TARGET_FIELDS, ['tf_amount', 'tf_amount', 'tf_name']);
    expect(res.columns.map((c) => c.fieldId)).toEqual(['tf_amount', 'tf_name']);
  });
});

/* ===================== ② buildLinkTable（带配置） ===================== */

describe('buildLinkTable · 传入配置列', () => {
  it('⭐ 输出列序 = 配置序；单元格按列取值；首列成为行标题', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROWS, { columns: ['tf_note', 'tf_amount'] });
    expect(table.columns.map((c) => c.fieldId)).toEqual(['tf_note', 'tf_amount']);
    expect(table.rows[0]?.cells.tf_note?.text).toBe('备注一');
    expect(table.rows[0]?.cells.tf_amount?.display).toBe('1,234,567');
    expect(table.rows[0]?.title).toBe('备注一'); // 首列 = 标题来源
    expect(table.droppedColumns).toBeUndefined();
    expect(table.columnsFallback).toBeUndefined();
  });

  it('⭐ 单列读取失败仍保留占位行（配置不影响「不丢行」铁律）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROWS[0], null, ROWS[2]], { columns: ['tf_name'] });
    expect(table.rows.length).toBe(3);
    expect(table.rows[1]?.cells.tf_name?.isEmpty).toBe(true);
    expect(table.rows[2]?.cells.tf_name?.text).toBe('三期工程');
  });

  it('⭐ recordId 绝不进入展示文本（配置路径同样成立）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROWS, { columns: ['tf_name', 'tf_note'] });
    const surface = table.rows
      .map((row) => [row.title, ...Object.values(row.cells).map((cell) => `${cell.text}|${cell.display}`)].join('|'))
      .join('~');
    for (const id of ['rec_l1', 'rec_l2', 'rec_l3']) expect(surface).not.toContain(id);
  });

  it('全失效 → columnsFallback=true 且列 = 默认列；droppedColumns 全量', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, ROWS, { columns: ['ghost'] });
    expect(table.columnsFallback).toBe(true);
    expect(table.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);
    expect(table.droppedColumns).toEqual(['ghost']);
  });
});

/* ===================== ③ 配置收集 ===================== */

describe('collectLinkFieldConfigs · 从区块收集', () => {
  it('fieldList / keyValueGrid / table 三处落点均可收集', () => {
    const blocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_name', 'tf_amount'] }, { fieldId: 'f_text' }]),
      kvGrid([{ fieldId: 'f_link_b', linkColumns: ['tf_owner'], linkRowLimit: 5 }]),
      tableBlock({ linkColumns: ['tf_note'], linkRowLimit: 3 }),
    ];
    const { byField, conflicts } = collectLinkFieldConfigs(blocks, MAIN_FIELDS);
    expect(byField.get('f_link_a')).toEqual({ columns: ['tf_name', 'tf_amount'] });
    expect(byField.get('f_link_b')).toEqual({ columns: ['tf_owner'], rowLimit: 5 });
    // table 与 fieldList 都绑了 f_link_a？不 —— table 绑的是 f_link_a，fieldList 也是 f_link_a → 冲突
    expect(conflicts).toContain('f_link_a');
  });

  it('普通字段 / 非关联字段 → 不收集；无配置的关联绑定 → 不产生条目', () => {
    const blocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_text', linkColumns: ['tf_name'] }, { fieldId: 'f_link_a' }]),
    ];
    const { byField, conflicts } = collectLinkFieldConfigs(blocks, MAIN_FIELDS);
    expect(byField.size).toBe(0);
    expect(conflicts).toEqual([]);
  });

  it('⭐ 非法值归一为「未配置」：非数组 linkColumns / 非有限 linkRowLimit → 不记录', () => {
    const blocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_link_a', linkColumns: 'nope', linkRowLimit: 'NaN' }]),
    ];
    const { byField } = collectLinkFieldConfigs(blocks, MAIN_FIELDS);
    expect(byField.size).toBe(0);
  });

  it('同一字段同配置出现两次 → 不算冲突；不同配置 → 记入 conflicts（首个生效）', () => {
    const sameBlocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_name'] }]),
      kvGrid([{ fieldId: 'f_link_a', linkColumns: ['tf_name'] }]),
    ];
    expect(collectLinkFieldConfigs(sameBlocks, MAIN_FIELDS).conflicts).toEqual([]);

    const diffBlocks: DocBlock[] = [
      kvGrid([{ fieldId: 'f_link_a', linkColumns: ['tf_amount'] }]),
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_name'] }]),
    ];
    const { byField, conflicts } = collectLinkFieldConfigs(diffBlocks, MAIN_FIELDS);
    expect(conflicts).toEqual(['f_link_a']);
    // 首个出现者生效（kvGrid 在 fieldList 之前）
    expect(byField.get('f_link_a')).toEqual({ columns: ['tf_amount'] });
  });
});

/* ===================== ④ 预取接线 ===================== */

describe('prefetchLinkTables · 配置落到预取结果', () => {
  it('⭐ 列序 = 配置序、行上限生效（fieldList 绑定）', async () => {
    const blocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_owner', 'tf_name'], linkRowLimit: 2 }]),
    ];
    const tables = await prefetchLinkTables({
      blocks,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith(),
    });
    const table = tables.get('f_link_a');
    expect(table?.columns.map((c) => c.fieldId)).toEqual(['tf_owner', 'tf_name']);
    expect(table?.rows.length).toBe(2); // linkRowLimit = 2
  });

  it('⭐ 被跳过的列 → 一条告警（含被跳过的 fieldId）', async () => {
    const onWarn = vi.fn();
    const blocks: DocBlock[] = [
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_ghost', 'tf_name'] }]),
    ];
    const tables = await prefetchLinkTables({ blocks, fields: MAIN_FIELDS, recordId: 'rec_main', access: accessWith(), onWarn });
    expect(tables.get('f_link_a')?.columns.map((c) => c.fieldId)).toEqual(['tf_name']);
    expect(onWarn).toHaveBeenCalledWith(
      'doc.linkTable',
      expect.stringContaining('不存在'),
      expect.objectContaining({ fieldId: 'f_link_a', dropped: ['tf_ghost'] }),
    );
  });

  it('⭐ 配置列全失效 → 回退默认列 + 一条告警（诚实告知）', async () => {
    const onWarn = vi.fn();
    const blocks: DocBlock[] = [fieldList([{ fieldId: 'f_link_a', linkColumns: ['ghost1', 'ghost2'] }])];
    const tables = await prefetchLinkTables({ blocks, fields: MAIN_FIELDS, recordId: 'rec_main', access: accessWith(), onWarn });
    expect(tables.get('f_link_a')?.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);
    expect(onWarn).toHaveBeenCalledWith(
      'doc.linkTable',
      expect.stringContaining('已回退默认列'),
      expect.objectContaining({ fieldId: 'f_link_a' }),
    );
  });

  it('⭐ 行上限越界（>50）→ 回退默认 20 + 一条告警；行数确实为 20', async () => {
    const onWarn = vi.fn();
    const ids = Array.from({ length: 25 }, (_, i) => `rec_${i}`);
    const blocks: DocBlock[] = [fieldList([{ fieldId: 'f_link_a', linkRowLimit: MAX_LINK_TABLE_ROWS + 1 }])];
    const tables = await prefetchLinkTables({
      blocks,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({
        reader: async () => ({ recordIds: ids, tableId: 'tbl_target' }),
        getTargetRow: async (_t, recordId) => ({ recordId, fields: { tf_name: `行${recordId}` } }),
      }),
      onWarn,
    });
    expect(tables.get('f_link_a')?.rows.length).toBe(DEFAULT_LINK_TABLE_ROWS);
    expect(onWarn).toHaveBeenCalledWith(
      'doc.linkTable',
      expect.stringContaining('1~50'),
      expect.objectContaining({ fieldId: 'f_link_a', value: MAX_LINK_TABLE_ROWS + 1 }),
    );
  });

  it('⭐ 同一字段多处不同配置 → 一条冲突告警（首个生效）', async () => {
    const onWarn = vi.fn();
    const blocks: DocBlock[] = [
      kvGrid([{ fieldId: 'f_link_a', linkColumns: ['tf_amount'] }]),
      fieldList([{ fieldId: 'f_link_a', linkColumns: ['tf_name'] }]),
    ];
    const tables = await prefetchLinkTables({ blocks, fields: MAIN_FIELDS, recordId: 'rec_main', access: accessWith(), onWarn });
    expect(tables.get('f_link_a')?.columns.map((c) => c.fieldId)).toEqual(['tf_amount']);
    expect(onWarn).toHaveBeenCalledWith(
      'doc.linkTable',
      expect.stringContaining('多处不同'),
      expect.objectContaining({ fieldId: 'f_link_a' }),
    );
  });

  it('⭐ table(rowSource=linkedRecords) 的 linkColumns 生效（与 fieldList 共用同一套列解析）', async () => {
    const blocks: DocBlock[] = [tableBlock({ linkColumns: ['tf_note', 'tf_owner'], linkRowLimit: 1 })];
    const tables = await prefetchLinkTables({ blocks, fields: MAIN_FIELDS, recordId: 'rec_main', access: accessWith() });
    const table = tables.get('f_link_a');
    expect(table?.columns.map((c) => c.fieldId)).toEqual(['tf_note', 'tf_owner']);
    expect(table?.rows.length).toBe(1);
  });

  it('未配置 → 与既有默认行为逐字一致（默认列 + 默认 20 行上限 + 无告警）', async () => {
    const onWarn = vi.fn();
    const blocks: DocBlock[] = [fieldList([{ fieldId: 'f_link_a' }])];
    const tables = await prefetchLinkTables({ blocks, fields: MAIN_FIELDS, recordId: 'rec_main', access: accessWith(), onWarn });
    expect(tables.get('f_link_a')?.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);
    expect(onWarn).not.toHaveBeenCalled();
  });
});
