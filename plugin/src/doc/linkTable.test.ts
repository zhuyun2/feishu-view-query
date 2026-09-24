/**
 * `doc/linkTable`（关联字段 → 只读表格：列选择 / 行构造 / 预取编排）单测。
 *
 * 断言原则（团队禁令）：每条断言都必须能被「把实现改坏」证伪。
 *  ⇒ 行/列断言一律配**内容锚点**（具体字段名、具体单元格文本、具体行数），
 *    以杀死「恒返回空对象 / 恒返回常量」这类假绿实现。
 * 本文件锁定：
 *  ① **默认列规则**：目标表「主字段（必排第一）+ 前 3 个**可用**字段」，不可用类型（无渲染器）跳过；
 *  ② **`+N` 截断**：行上限默认 20，溢出记 `truncated`（不静默丢行）；
 *  ③ **行失败占位**：单行读取失败 → **保留该行**（空单元格），行数不少；
 *  ④ **确定性**：同输入两次 → 深等价 + 内容锚点；不同输入 → 不同输出；
 *  ⑤ **不泄漏 recordId**：`recordId` 只进结构，绝不进 `text` / `display` / `title`；
 *  ⑥ **预取**：并发受信号量约束、失败一律降级（不抛）、`isActive()` 可中途叫停。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocBlock, FieldListBlock, TableBlock } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import {
  DEFAULT_LINK_TABLE_EXTRA_COLUMNS,
  DEFAULT_LINK_TABLE_ROWS,
  buildLinkTable,
  collectLinkFieldIds,
  isUsableLinkColumnField,
  pickLinkTableColumns,
  prefetchLinkTables,
} from './linkTable';
import type { LinkRowRecord, LinkTablePrefetchAccess } from './linkTable';

/* ===================== 夹具 ===================== */

/** 当前（主）表字段：含两个关联字段 */
const FIELD_LINK_A: FieldMetaLite = { id: 'f_link_a', name: '关联项目', type: FieldType.Link, isPrimary: false };
const FIELD_LINK_B: FieldMetaLite = {
  id: 'f_link_b',
  name: '双向关联',
  type: FieldType.DuplexLink,
  isPrimary: false,
};
const FIELD_TEXT: FieldMetaLite = { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true };
const MAIN_FIELDS: FieldMetaLite[] = [FIELD_TEXT, FIELD_LINK_A, FIELD_LINK_B];

/** 目标表字段：主字段 + 3 个可用 + 1 个**不可用**（Location 无渲染器）+ 1 个可用（用于验证只取前 3） */
const TARGET_NAME: FieldMetaLite = { id: 'tf_name', name: '项目名称', type: FieldType.Text, isPrimary: true };
const TARGET_AMOUNT: FieldMetaLite = { id: 'tf_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const TARGET_OWNER: FieldMetaLite = { id: 'tf_owner', name: '负责人', type: FieldType.User, isPrimary: false };
const TARGET_LOCATION: FieldMetaLite = {
  id: 'tf_location',
  name: '位置',
  type: FieldType.Location,
  isPrimary: false,
};
const TARGET_NOTE: FieldMetaLite = { id: 'tf_note', name: '备注', type: FieldType.Text, isPrimary: false };
const TARGET_EXTRA: FieldMetaLite = { id: 'tf_extra', name: '额外', type: FieldType.Text, isPrimary: false };
const TARGET_FIELDS: FieldMetaLite[] = [
  TARGET_NAME,
  TARGET_AMOUNT,
  TARGET_OWNER,
  TARGET_LOCATION,
  TARGET_NOTE,
  TARGET_EXTRA,
];

const LINK_REF = { recordIds: ['rec_l1', 'rec_l2', 'rec_l3'], tableId: 'tbl_target' };

const ROW_1: LinkRowRecord = {
  recordId: 'rec_l1',
  fields: { tf_name: '一期工程', tf_amount: 1234567, tf_owner: [{ name: '张三' }], tf_note: '备注一' },
};
const ROW_2: LinkRowRecord = {
  recordId: 'rec_l2',
  fields: { tf_name: '二期工程', tf_amount: 200, tf_owner: [{ name: '李四' }], tf_note: '备注二' },
};
const ROW_3: LinkRowRecord = {
  recordId: 'rec_l3',
  fields: { tf_name: '三期工程', tf_amount: 300, tf_owner: [{ name: '王五' }], tf_note: '备注三' },
};

/* ===================== ① 列选择 ===================== */

describe('doc/linkTable · pickLinkTableColumns（默认列规则）', () => {
  it('可用性判定：有真实渲染器才算可用（Location 等无渲染器类型不可用）', () => {
    expect(isUsableLinkColumnField(TARGET_NAME)).toBe(true);
    expect(isUsableLinkColumnField(TARGET_OWNER)).toBe(true);
    expect(isUsableLinkColumnField(TARGET_LOCATION)).toBe(false);
    expect(isUsableLinkColumnField({ id: '', name: 'x', type: FieldType.Text, isPrimary: false })).toBe(false);
  });

  it('⭐ 主字段必排第一 + 前 3 个可用字段（跳过不可用；不含第 4 个可用）', () => {
    const columns = pickLinkTableColumns(TARGET_FIELDS);
    expect(columns.map((column) => column.fieldId)).toEqual([
      'tf_name', // 主字段
      'tf_amount',
      'tf_owner',
      'tf_note', // tf_location 被跳过 → 顺位补上；tf_extra 超出 3 个额外列
    ]);
    expect(columns.map((column) => column.label)).toEqual(['项目名称', '金额', '负责人', '备注']);
    expect(columns.length).toBe(DEFAULT_LINK_TABLE_EXTRA_COLUMNS + 1);
  });

  it('主字段不在数组首位也会被提到第一列', () => {
    const columns = pickLinkTableColumns([TARGET_AMOUNT, TARGET_NAME, TARGET_OWNER]);
    expect(columns[0]?.fieldId).toBe('tf_name');
  });

  it('无主字段 → 取前 N+1 个可用字段（不臆造空列）', () => {
    const columns = pickLinkTableColumns([TARGET_AMOUNT, TARGET_OWNER, TARGET_NOTE]);
    expect(columns.map((column) => column.fieldId)).toEqual(['tf_amount', 'tf_owner', 'tf_note']);
  });

  it('全部不可用 / 空数组 → 空列（渲染层据此回退文本呈现）', () => {
    expect(pickLinkTableColumns([TARGET_LOCATION])).toEqual([]);
    expect(pickLinkTableColumns([])).toEqual([]);
  });
});

/* ===================== ② 行构造 ===================== */

describe('doc/linkTable · buildLinkTable（纯函数）', () => {
  it('三行记录 → 单元格值经 normalize 归一化（含千分位 display 与成员文本）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROW_1, ROW_2, ROW_3]);
    expect(table.rows.length).toBe(3);
    expect(table.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);

    const first = table.rows[0];
    expect(first?.recordId).toBe('rec_l1');
    expect(first?.title).toBe('一期工程');
    expect(first?.cells.tf_name?.text).toBe('一期工程');
    // 内容锚点：数字展示确实过了 `formatNumber`（恒返回常量 / 空对象的假绿实现过不了）
    expect(first?.cells.tf_amount?.display).toBe('1,234,567');
    expect(first?.cells.tf_owner?.text).toBe('张三');
    expect(first?.cells.tf_note?.text).toBe('备注一');
    expect(table.rows[2]?.cells.tf_name?.text).toBe('三期工程');
    expect(table.truncated).toBeUndefined();
  });

  it('⭐ recordId **绝不**进入展示文本（text / display / title 三处逐一证伪）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROW_1, ROW_2, ROW_3]);
    for (const row of table.rows) {
      expect(row.title).not.toContain(row.recordId);
      for (const cell of Object.values(row.cells)) {
        expect(cell.text).not.toContain(row.recordId);
        expect(cell.display).not.toContain(row.recordId);
      }
    }
    // 结构里仍保留 recordId（供 React key），但展示面整体序列化不得出现 id 文本
    const displaySurface = table.rows
      .map((row) => [row.title, ...Object.values(row.cells).map((cell) => `${cell.text}|${cell.display}`)].join('|'))
      .join('~');
    expect(displaySurface).not.toContain('rec_l1');
    expect(displaySurface).not.toContain('rec_l2');
    expect(displaySurface).not.toContain('rec_l3');
  });

  it('⭐ 行上限默认 20：25 条关联 → 20 行 + `truncated = 5`（含首/末行内容锚点）', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rec_${i}`);
    const rows: LinkRowRecord[] = ids.map((id, i) => ({
      recordId: id,
      fields: { tf_name: `项目${i}`, tf_amount: i },
    }));
    const table = buildLinkTable({ recordIds: ids, tableId: 'tbl_target' }, TARGET_FIELDS, rows);

    expect(table.rows.length).toBe(DEFAULT_LINK_TABLE_ROWS);
    expect(table.truncated).toBe(5);
    expect(table.rows[0]?.title).toBe('项目0');
    expect(table.rows[19]?.title).toBe('项目19');
    // 第 21 条（index 20）必须**不出现**（否则截断未生效）
    expect(table.rows.some((row) => row.title === '项目20')).toBe(false);
  });

  it('`maxRows` 可覆盖；`maxRows` 非法（0 / 负数 / 非有限）→ 回退默认 20', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rec_${i}`);
    const rows: LinkRowRecord[] = ids.map((id, i) => ({ recordId: id, fields: { tf_name: `项目${i}` } }));

    const small = buildLinkTable({ recordIds: ids, tableId: 't' }, TARGET_FIELDS, rows, { maxRows: 2 });
    expect(small.rows.length).toBe(2);
    expect(small.truncated).toBe(23);

    const fallback = buildLinkTable({ recordIds: ids, tableId: 't' }, TARGET_FIELDS, rows, { maxRows: 0 });
    expect(fallback.rows.length).toBe(DEFAULT_LINK_TABLE_ROWS);
  });

  it('⭐ 单行读取失败（rowRecords[i] = null）→ **保留占位行**（行数不减，单元格全空）', () => {
    const table = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROW_1, null, ROW_3]);
    expect(table.rows.length).toBe(3);
    expect(table.rows.map((row) => row.recordId)).toEqual(['rec_l1', 'rec_l2', 'rec_l3']);
    const placeholder = table.rows[1];
    expect(placeholder?.title).toBe('');
    for (const column of table.columns) {
      expect(placeholder?.cells[column.fieldId]?.isEmpty).toBe(true);
    }
    // 后续行不受影响（证明不是「遇到失败就截断」）
    expect(table.rows[2]?.cells.tf_name?.text).toBe('三期工程');
  });

  it('空 recordIds / null 引用 → 0 行、无 truncated、列仍可选', () => {
    expect(buildLinkTable({ recordIds: [], tableId: 't' }, TARGET_FIELDS, []).rows).toEqual([]);
    const nullRef = buildLinkTable(null, TARGET_FIELDS, []);
    expect(nullRef.rows).toEqual([]);
    expect(nullRef.truncated).toBeUndefined();
    expect(nullRef.columns.length).toBe(4);
  });

  it('目标表全不可用 → 列为空、行内无单元格（渲染层据此回退，不画空表）', () => {
    const table = buildLinkTable(LINK_REF, [TARGET_LOCATION], [ROW_1, ROW_2, ROW_3]);
    expect(table.columns).toEqual([]);
    expect(table.rows[0]?.cells).toEqual({});
    expect(table.rows[0]?.title).toBe('');
  });

  it('⭐ 确定性：同输入两次深等价（且不是恒返回常量）；不同输入结果不同', () => {
    const first = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROW_1, ROW_2, ROW_3]);
    const second = buildLinkTable(LINK_REF, TARGET_FIELDS, [ROW_1, ROW_2, ROW_3]);
    expect(second).toEqual(first);
    // 内容锚点：防「恒返回 {columns:[],rows:[]}」也过
    expect(first.rows[0]?.title).toBe('一期工程');
    expect(first.columns.length).toBe(4);

    const different = buildLinkTable(
      { recordIds: ['rec_l9'], tableId: 'tbl_target' },
      TARGET_FIELDS,
      [{ recordId: 'rec_l9', fields: { tf_name: '九期工程' } }],
    );
    expect(different).not.toEqual(first);
    expect(different.rows[0]?.title).toBe('九期工程');
  });
});

/* ===================== ③ 关联字段收集 ===================== */

describe('doc/linkTable · collectLinkFieldIds', () => {
  function fieldList(fieldIds: string[]): FieldListBlock {
    return {
      blockId: 'blk_fl',
      kind: 'fieldList',
      breakInside: 'auto',
      items: fieldIds.map((fieldId) => ({ fieldId })),
      showLabels: true,
      hideEmptyItems: false,
    };
  }
  function linkTableBlock(fieldId: string): TableBlock {
    return {
      blockId: 'blk_tbl',
      kind: 'table',
      breakInside: 'auto',
      columns: [{ fieldId: 'f_text' }],
      rowSource: { type: 'linkedRecords', fieldId },
      showHeader: true,
      zebra: true,
    };
  }

  it('从 fieldList / table(rowSource) 收集关联字段（去重保序、剔除普通字段）', () => {
    const blocks: DocBlock[] = [
      fieldList(['f_text', 'f_link_a', 'f_link_b', 'f_link_a']),
      linkTableBlock('f_link_b'),
    ];
    expect(collectLinkFieldIds(blocks, MAIN_FIELDS)).toEqual(['f_link_a', 'f_link_b']);
  });

  it('无关联字段引用 → 空数组', () => {
    expect(collectLinkFieldIds([fieldList(['f_text'])], MAIN_FIELDS)).toEqual([]);
    expect(collectLinkFieldIds([], MAIN_FIELDS)).toEqual([]);
  });

  it('块引用**不在字段表里**的 id → 不收集（失效引用不预取）', () => {
    expect(collectLinkFieldIds([fieldList(['f_ghost'])], MAIN_FIELDS)).toEqual([]);
  });
});

/* ===================== ④ 预取编排 ===================== */

describe('doc/linkTable · prefetchLinkTables（并发 / 降级 / 中途叫停）', () => {
  const BLOCKS: DocBlock[] = [
    {
      blockId: 'blk_fl',
      kind: 'fieldList',
      breakInside: 'auto',
      items: [{ fieldId: 'f_link_a' }, { fieldId: 'f_link_b' }],
      showLabels: true,
      hideEmptyItems: false,
    },
  ];

  function accessWith(overrides: Partial<LinkTablePrefetchAccess> = {}): LinkTablePrefetchAccess {
    return {
      reader: async () => ({ recordIds: ['rec_l1', 'rec_l2'], tableId: 'tbl_target' }),
      getTargetFieldMetas: async () => TARGET_FIELDS,
      getTargetRow: async (_tableId, recordId) => ({
        recordId,
        fields: { tf_name: `行 ${recordId}`, tf_amount: 7 },
      }),
      ...overrides,
    };
  }

  it('happy path：按 fieldId 落到 Map，列出目标表列、行数与内容', async () => {
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith(),
    });

    expect(Array.from(tables.keys())).toEqual(['f_link_a', 'f_link_b']);
    const table = tables.get('f_link_a');
    expect(table?.columns.map((c) => c.fieldId)).toEqual(['tf_name', 'tf_amount', 'tf_owner', 'tf_note']);
    expect(table?.rows.length).toBe(2);
    expect(table?.rows[0]?.title).toBe('行 rec_l1');
  });

  it('⭐ 并发受信号量约束：concurrency=1 时「同时在飞」恒 ≤ 1（删掉闸门即变红）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const access = accessWith({
      reader: async () => ({ recordIds: ['r1', 'r2', 'r3', 'r4'], tableId: 'T' }),
      getTargetRow: async (_tableId, recordId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { recordId, fields: { tf_name: recordId } };
      },
    });

    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access,
      concurrency: 1,
    });

    expect(maxInFlight).toBe(1);
    expect(tables.get('f_link_a')?.rows.length).toBe(4);
  });

  it('reader 抛错 → 该关联**不落表**、整体不抛（降级）', async () => {
    const onWarn = vi.fn();
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({
        reader: async (fieldId) => {
          if (fieldId === 'f_link_a') throw new Error('reader-down');
          return { recordIds: ['r1'], tableId: 'T' };
        },
      }),
      onWarn,
    });

    expect(tables.has('f_link_a')).toBe(false);
    expect(tables.get('f_link_b')?.rows.length).toBe(1);
    expect(onWarn).toHaveBeenCalled();
  });

  it('目标表元数据取不到（空列）→ 不落表（渲染层回退文本呈现，不画空表）', async () => {
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({ getTargetFieldMetas: async () => [] }),
    });
    expect(tables.size).toBe(0);
  });

  it('目标表元数据请求抛错 → 捕获并降级（不落表、不抛）', async () => {
    const onWarn = vi.fn();
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({
        getTargetFieldMetas: async () => {
          throw new Error('meta-down');
        },
      }),
      onWarn,
    });
    expect(tables.size).toBe(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('⭐ 单行读取抛错 → 该行降级为占位行（行数不减）', async () => {
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({
        getTargetRow: async (_tableId, recordId) => {
          if (recordId === 'rec_l2') throw new Error('row-down');
          return { recordId, fields: { tf_name: `行 ${recordId}` } };
        },
      }),
    });
    const table = tables.get('f_link_a');
    expect(table?.rows.length).toBe(2);
    expect(table?.rows[1]?.title).toBe('');
    expect(table?.rows[1]?.cells.tf_name?.isEmpty).toBe(true);
  });

  it('无关联字段引用 → 空 Map，且**不接触** access（零请求）', async () => {
    const reader = vi.fn(async () => ({ recordIds: ['r1'], tableId: 'T' }));
    const tables = await prefetchLinkTables({
      blocks: [{ ...BLOCKS[0], items: [{ fieldId: 'f_text' }] } as DocBlock],
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({ reader }),
    });
    expect(tables.size).toBe(0);
    expect(reader).not.toHaveBeenCalled();
  });

  it('⭐ `isActive()` 中途变 false → 立即停止（后续关联字段不落表）', async () => {
    let readerCalls = 0;
    let active = true;
    const access = accessWith({
      reader: async () => {
        readerCalls += 1;
        if (readerCalls >= 2) active = false;
        return { recordIds: ['r1'], tableId: 'T' };
      },
    });

    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access,
      isActive: () => active,
    });

    expect(readerCalls).toBe(2);
    expect(tables.has('f_link_a')).toBe(true);
    expect(tables.has('f_link_b')).toBe(false);
  });

  it('字段为空关联（recordIds 为空）→ 该关联不落表', async () => {
    const tables = await prefetchLinkTables({
      blocks: BLOCKS,
      fields: MAIN_FIELDS,
      recordId: 'rec_main',
      access: accessWith({ reader: async () => ({ recordIds: [], tableId: 'T' }) }),
    });
    expect(tables.size).toBe(0);
  });
});
