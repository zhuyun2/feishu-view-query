import { describe, expect, it } from 'vitest';
import { FieldType, docLabelPrefix } from '@/fields/fieldTypes';
import type { FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';
import type {
  BadgeRowBlock,
  DividerBlock,
  DocBlock,
  FieldDisplayOptions,
  FieldListBlock,
  HeadingBlock,
  ImageBlock,
  KeyValueGridBlock,
  MetaFooterBlock,
  PageBreakBlock,
  ParagraphBlock,
  RichTextBlock,
  SpacerBlock,
  StyleTheme,
  TableBlock,
} from '@/config/types';
import {
  buildDocRenderContext,
  isEmptyDocValue,
  resolveBlocks,
} from './resolve';
import type { DocRecordLike, ResolvedBlock } from './resolve';

/**
 * `doc/resolve` 单测（设计文档 §21.2 / §21.3.3）。
 *
 * 断言策略（团队铁律：**禁止假绿断言**）：
 *  - 一律**锁定具体结构**（blockId 序列 / payload 全等 / 归一化值全等），不用
 *    `length > 0` / `toBeTruthy()` 之类恒真断言充当某条语义的验证；
 *  - `hideWhenEmpty` 用「**空值块恰好不在结果里，其余 blockId 按顺序原样保留**」来锁定，
 *    并配一条反向用例（`hideWhenEmpty=false` 时该块回到序列里）证明断言非恒真；
 *  - 「0 / false 不算空」各一条专项用例（实现若写成 `if (!value)` 必红）。
 */

/* ===================== 夹具 ===================== */

const FIELDS: FieldMetaLite[] = [
  { id: 'fld_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'fld_desc', name: '描述', type: FieldType.Text, isPrimary: false },
  { id: 'fld_num', name: '数量', type: FieldType.Number, isPrimary: false },
  { id: 'fld_done', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
  {
    id: 'fld_tags',
    name: '标签',
    type: FieldType.MultiSelect,
    isPrimary: false,
    property: { options: [{ name: 'A', color: 1 }, { name: 'B', color: 2 }, { name: 'C', color: 3 }] },
  },
  { id: 'fld_att', name: '附件', type: FieldType.Attachment, isPrimary: false },
  { id: 'fld_link', name: '关联', type: FieldType.Link, isPrimary: false },
  { id: 'fld_ct', name: '创建时间', type: FieldType.CreatedTime, isPrimary: false },
  { id: 'fld_cu', name: '创建人', type: FieldType.CreatedUser, isPrimary: false },
];

const RECORD: DocRecordLike = {
  recordId: 'rec_1',
  fields: {
    fld_title: '客户 A',
    fld_desc: '',
    fld_num: 0,
    fld_done: false,
    fld_tags: ['A', 'B', 'C'],
    fld_att: [
      { name: 'a.png', tmpUrl: 'https://x/a.png' },
      { name: 'b.png', tmpUrl: 'https://x/b.png' },
    ],
    fld_link: [
      { recordId: 'rec_x', text: '关联一' },
      { recordId: 'rec_y', text: '关联二' },
    ],
    fld_ct: 1700000000000,
    fld_cu: [{ name: '张三' }],
  },
};

/** 以 `RECORD` 为底，覆盖若干字段值 */
function recordWith(patch: Record<string, unknown>): DocRecordLike {
  return { recordId: RECORD.recordId, fields: { ...RECORD.fields, ...patch } };
}

const DISPLAY: FieldDisplayOptions = {
  maxLines: 0,
  truncate: 'none',
  maxItems: 0,
  hideWhenEmpty: false,
};

const THEME: StyleTheme = {
  preset: 'default',
  primaryColor: '#3370FF',
  backgroundColor: '#FFFFFF',
  borderColor: '#E5E6EB',
  borderRadius: 8,
  shadowLevel: 1,
  fontScale: 1,
  titleWeight: 600,
};

/* ---- 区块构造器（显式必填，避免隐式默认掩盖问题） ---- */

function mkHeading(
  blockId: string,
  source: HeadingBlock['source'],
  hideWhenEmpty = false,
): HeadingBlock {
  return { blockId, kind: 'heading', breakInside: 'avoid', level: 1, source, hideWhenEmpty };
}

function mkParagraph(blockId: string, fieldId: string, hideWhenEmpty = true): ParagraphBlock {
  return { blockId, kind: 'paragraph', breakInside: 'auto', fieldId, preserveLineBreaks: true, hideWhenEmpty };
}

function mkRichText(blockId: string, markdown: string): RichTextBlock {
  return { blockId, kind: 'richText', breakInside: 'auto', markdown };
}

function mkKvg(
  blockId: string,
  rows: KeyValueGridBlock['rows'],
  hideEmptyRows = true,
): KeyValueGridBlock {
  return {
    blockId,
    kind: 'keyValueGrid',
    breakInside: 'avoid',
    columns: 2,
    rows,
    labelWidthPx: 88,
    showColon: true,
    zebra: false,
    hideEmptyRows,
  };
}

function mkFieldList(blockId: string, items: FieldListBlock['items'], hideEmptyItems = true): FieldListBlock {
  return { blockId, kind: 'fieldList', breakInside: 'auto', items, showLabels: true, hideEmptyItems };
}

function mkBadgeRow(blockId: string, fieldIds: string[], maxItems = 3): BadgeRowBlock {
  return { blockId, kind: 'badgeRow', breakInside: 'avoid', fieldIds, maxItems, showLabels: true };
}

function mkImage(
  blockId: string,
  fieldId: string,
  mode: ImageBlock['mode'],
  index = 0,
  hideWhenEmpty = true,
): ImageBlock {
  return {
    blockId,
    kind: 'image',
    breakInside: 'avoid',
    fieldId,
    mode,
    index,
    width: 240,
    align: 'left',
    hideWhenEmpty,
  };
}

function mkTable(
  blockId: string,
  columns: TableBlock['columns'],
  rowSource: TableBlock['rowSource'],
  maxRows?: number,
): TableBlock {
  const block: TableBlock = {
    blockId,
    kind: 'table',
    breakInside: 'auto',
    columns,
    rowSource,
    showHeader: true,
    zebra: true,
  };
  if (maxRows !== undefined) block.maxRows = maxRows;
  return block;
}

function mkDivider(blockId: string): DividerBlock {
  return { blockId, kind: 'divider', breakInside: 'avoid', thickness: 2, borderStyle: 'dashed' };
}

function mkSpacer(blockId: string, height = 24): SpacerBlock {
  return { blockId, kind: 'spacer', breakInside: 'auto', height };
}

function mkPageBreak(blockId: string): PageBreakBlock {
  return { blockId, kind: 'pageBreak', breakInside: 'auto' };
}

function mkMetaFooter(blockId: string, fields: MetaFooterBlock['fields']): MetaFooterBlock {
  return {
    blockId,
    kind: 'metaFooter',
    breakInside: 'avoid',
    fields,
    separator: ' · ',
    fontSize: 12,
    muted: true,
  };
}

/** 跑一次解析 */
function run(
  blocks: DocBlock[],
  record: DocRecordLike | null = RECORD,
  fields: FieldMetaLite[] = FIELDS,
): ResolvedBlock[] {
  return resolveBlocks({ blocks, record, fields });
}

/** 结果里的 blockId 序列（锁定顺序用） */
function ids(blocks: ResolvedBlock[]): string[] {
  return blocks.map((block) => block.blockId);
}

/** 取首个区块，并断言「恰好只有一个」 */
function only(blocks: ResolvedBlock[]): ResolvedBlock {
  expect(blocks.length).toBe(1);
  return blocks[0];
}

/* ===================== 判空口径（主理人裁定） ===================== */

describe('doc/resolve · 判空口径 isEmptyDocValue', () => {
  it('null / undefined / 空串 / 空白串 / 空数组 一律算空', () => {
    expect(isEmptyDocValue(null)).toBe(true);
    expect(isEmptyDocValue(undefined)).toBe(true);
    expect(isEmptyDocValue('')).toBe(true);
    expect(isEmptyDocValue('   ')).toBe(true);
    expect(isEmptyDocValue([])).toBe(true);
  });

  it('0 与 false 不算空（写成 `!value` 的实现必红）', () => {
    expect(isEmptyDocValue(0)).toBe(false);
    expect(isEmptyDocValue(false)).toBe(false);
  });

  it('非空值（字符串 / 数字 / 非空数组）不算空', () => {
    expect(isEmptyDocValue('abc')).toBe(false);
    expect(isEmptyDocValue(42)).toBe(false);
    expect(isEmptyDocValue(['a'])).toBe(false);
  });
});

/* ===================== 12 类区块逐类解析 ===================== */

describe('doc/resolve · 12 类区块解析', () => {
  it('① heading（静态文本）→ 原样保留文本，不带 fieldId', () => {
    const out = run([mkHeading('h1', { type: 'static', text: '客户档案' })]);
    const block = only(out);
    expect(block.blockId).toBe('h1');
    expect(block.fieldIds).toEqual([]);
    expect(block.payload).toStrictEqual({ kind: 'heading', level: 1, text: '客户档案' });
  });

  it('① heading（绑定字段）→ 取归一化展示文本，并记录 fieldId / 标签', () => {
    const out = run([mkHeading('h1', { type: 'field', fieldId: 'fld_title' }, true)]);
    const block = only(out);
    expect(block.payload).toStrictEqual({
      kind: 'heading',
      level: 1,
      text: '客户 A',
      fieldId: 'fld_title',
    });
    expect(block.fieldIds).toEqual(['fld_title']);
    expect(block.labels).toEqual({ fld_title: '标题' });
    expect(block.values.fld_title).toStrictEqual({
      kind: 'text',
      text: '客户 A',
      display: '客户 A',
      isEmpty: false,
    });
  });

  it('② paragraph（保留换行）→ 按 \\n 拆成行序列', () => {
    const record = recordWith({ fld_desc: '第一行\n第二行\n第三行' });
    const out = run([mkParagraph('p1', 'fld_desc')], record);
    const block = only(out);
    expect(block.payload).toStrictEqual({
      kind: 'paragraph',
      fieldId: 'fld_desc',
      text: '第一行\n第二行\n第三行',
      lines: ['第一行', '第二行', '第三行'],
      preserveLineBreaks: true,
    });
  });

  it('② paragraph（preserveLineBreaks=false）→ 折叠为单行', () => {
    const record = recordWith({ fld_desc: '第一行\n第二行' });
    const block = mkParagraph('p1', 'fld_desc');
    block.preserveLineBreaks = false;
    const out = run([block], record);
    expect(only(out).payload).toStrictEqual({
      kind: 'paragraph',
      fieldId: 'fld_desc',
      text: '第一行\n第二行',
      lines: ['第一行 第二行'],
      preserveLineBreaks: false,
    });
  });

  it('② paragraph（maxLines）→ 行序列被截断', () => {
    const record = recordWith({ fld_desc: '一\n二\n三\n四' });
    const block = mkParagraph('p1', 'fld_desc');
    block.maxLines = 2;
    const out = run([block], record);
    expect((only(out).payload as { lines: string[] }).lines).toEqual(['一', '二']);
  });

  it('③ richText → markdown 子集解析为安全节点', () => {
    const out = run([mkRichText('r1', '**粗**')]);
    expect(only(out).payload).toStrictEqual({
      kind: 'richText',
      nodes: [{ kind: 'text', text: '粗', bold: true }],
    });
  });

  it('④ keyValueGrid → 逐行求值；空行被剔除，空数组/0 值行保留', () => {
    const out = run([mkKvg('k1', [{ fieldId: 'fld_title' }, { fieldId: 'fld_desc' }, { fieldId: 'fld_num' }])]);
    const payload = only(out).payload as {
      kind: 'keyValueGrid';
      rows: Array<{ fieldId: string; label: string; value: NormalizedValue }>;
    };
    expect(payload.kind).toBe('keyValueGrid');
    expect(payload.rows.map((row) => row.fieldId)).toEqual(['fld_title', 'fld_num']);
    expect(payload.rows.map((row) => row.label)).toEqual(['标题', '数量']);
    // 数字 0 是有效值：行保留，且归一化值为 0（不是 empty）
    expect(payload.rows[1].value).toStrictEqual({
      kind: 'number',
      text: '0',
      display: '0',
      number: 0,
      isEmpty: false,
    });
  });

  it('④ keyValueGrid（hideEmptyRows=false）→ 空行照样保留', () => {
    const out = run([mkKvg('k1', [{ fieldId: 'fld_desc' }], false)]);
    const payload = only(out).payload as { rows: Array<{ fieldId: string }> };
    expect(payload.rows.map((row) => row.fieldId)).toEqual(['fld_desc']);
  });

  it('⑤ fieldList → 逐项求值；空项剔除，labelOverride 覆盖字段中文名', () => {
    const out = run([
      mkFieldList('fl1', [{ fieldId: 'fld_desc' }, { fieldId: 'fld_num', labelOverride: '件数' }]),
    ]);
    const payload = only(out).payload as {
      items: Array<{ fieldId: string; label: string }>;
      showLabels: boolean;
    };
    expect(payload.items).toStrictEqual([{ fieldId: 'fld_num', label: '件数', value: {
      kind: 'number',
      text: '0',
      display: '0',
      number: 0,
      isEmpty: false,
    } }]);
    expect(payload.showLabels).toBe(true);
  });

  it('⑥ badgeRow → 展开为标签组，maxItems 截断每字段标签数', () => {
    const out = run([mkBadgeRow('b1', ['fld_tags'], 2)]);
    const payload = only(out).payload as {
      badges: Array<{ fieldId: string; label: string; texts: string[]; colorIndexes: Array<number | undefined> }>;
    };
    expect(payload.badges.length).toBe(1);
    expect(payload.badges[0].fieldId).toBe('fld_tags');
    expect(payload.badges[0].label).toBe('标签');
    expect(payload.badges[0].texts).toEqual(['A', 'B']);
    expect(payload.badges[0].colorIndexes).toEqual([1, 2]);
  });

  it('⑥ badgeRow（maxItems=0 视为不限）→ 三个标签全出', () => {
    const out = run([mkBadgeRow('b1', ['fld_tags'], 0)]);
    const payload = only(out).payload as { badges: Array<{ texts: string[] }> };
    expect(payload.badges[0].texts).toEqual(['A', 'B', 'C']);
  });

  it('⑦ image（mode=all）→ 解析出全部附件 URL', () => {
    const out = run([mkImage('i1', 'fld_att', 'all')]);
    const block = only(out);
    const payload = block.payload as { images: Array<{ name: string; url: string; index: number }> };
    expect(payload.images).toStrictEqual([
      { name: 'a.png', url: 'https://x/a.png', index: 0 },
      { name: 'b.png', url: 'https://x/b.png', index: 1 },
    ]);
    expect(block.imageUrls).toEqual(['https://x/a.png', 'https://x/b.png']);
  });

  it('⑦ image（mode=first）→ 只取第一张', () => {
    const out = run([mkImage('i1', 'fld_att', 'first')]);
    expect(only(out).imageUrls).toEqual(['https://x/a.png']);
  });

  it('⑦ image（mode=index）→ 按下标取图；越界则 hideWhenEmpty 时整块隐藏', () => {
    expect(only(run([mkImage('i1', 'fld_att', 'index', 1)])).imageUrls).toEqual(['https://x/b.png']);
    expect(run([mkImage('i2', 'fld_att', 'index', 9)])).toEqual([]);
  });

  it('⑦ image（无可用地址 / 空附件）→ hideWhenEmpty 时整块隐藏', () => {
    const record = recordWith({ fld_att: [] });
    expect(run([mkImage('i1', 'fld_att', 'all')], record)).toEqual([]);
    // 附件存在但没有 URL → 无法渲染为图 → 同样视为空
    const noUrl = recordWith({ fld_att: [{ name: 'a.png' }] });
    expect(run([mkImage('i2', 'fld_att', 'all')], noUrl)).toEqual([]);
  });

  it('⑧ table（rowSource=currentRecord）→ 单行，单元格按列求值', () => {
    const out = run([
      mkTable('t1', [{ fieldId: 'fld_title' }, { fieldId: 'fld_num' }], { type: 'currentRecord' }),
    ]);
    const block = only(out);
    const payload = block.payload as {
      columns: Array<{ fieldId: string; title: string }>;
      rows: Array<{ recordId: string; title: string; cells: Record<string, NormalizedValue> }>;
      showHeader: boolean;
    };
    expect(payload.columns).toStrictEqual([
      { fieldId: 'fld_title', title: '标题' },
      { fieldId: 'fld_num', title: '数量' },
    ]);
    expect(payload.rows.length).toBe(1);
    expect(payload.rows[0].recordId).toBe('rec_1');
    expect(payload.rows[0].title).toBe('客户 A');
    expect(payload.rows[0].cells.fld_num.display).toBe('0');
    expect(payload.showHeader).toBe(true);
    expect(block.rows).toBe(payload.rows);
  });

  it('⑧ table（rowSource=linkedRecords）→ 每个关联项一行', () => {
    const out = run([mkTable('t1', [{ fieldId: 'fld_link' }], { type: 'linkedRecords', fieldId: 'fld_link' })]);
    const payload = only(out).payload as {
      rows: Array<{ recordId: string; title: string; cells: Record<string, NormalizedValue> }>;
    };
    expect(payload.rows.map((row) => row.recordId)).toEqual(['rec_x', 'rec_y']);
    expect(payload.rows.map((row) => row.title)).toEqual(['关联一', '关联二']);
    expect(payload.rows[0].cells.fld_link.display).toBe('关联一');
  });

  it('⑧ table（maxRows）→ 行数被截断', () => {
    const out = run([
      mkTable('t1', [{ fieldId: 'fld_link' }], { type: 'linkedRecords', fieldId: 'fld_link' }, 1),
    ]);
    const payload = only(out).payload as { rows: unknown[] };
    expect(payload.rows.length).toBe(1);
  });

  it('⑨ divider → 线宽与线型原样透传', () => {
    expect(only(run([mkDivider('d1')])).payload).toStrictEqual({
      kind: 'divider',
      thickness: 2,
      borderStyle: 'dashed',
    });
  });

  it('⑩ spacer → 高度原样透传', () => {
    expect(only(run([mkSpacer('s1', 24)])).payload).toStrictEqual({ kind: 'spacer', height: 24 });
  });

  it('⑪ pageBreak → 产出纯换页指令 payload（不渲染 DOM）', () => {
    const block = only(run([mkPageBreak('pb1')]));
    expect(block.payload).toStrictEqual({ kind: 'pageBreak' });
    expect(block.fieldIds).toEqual([]);
    expect(block.imageUrls).toEqual([]);
    expect(block.rows).toEqual([]);
  });

  it('⑫ metaFooter → 创建人 / 创建时间 / 记录 ID 三项正确解析并拼接', () => {
    const out = run([mkMetaFooter('m1', ['createdUser', 'createdTime', 'recordId'])]);
    const payload = only(out).payload as {
      entries: Array<{ key: string; label: string; text: string }>;
      text: string;
      separator: string;
    };
    expect(payload.entries.map((entry) => entry.key)).toEqual(['createdUser', 'createdTime', 'recordId']);
    expect(payload.entries[0]).toStrictEqual({ key: 'createdUser', label: '创建人', text: '张三' });
    expect(payload.entries[1].label).toBe('创建时间');
    // 日期格式化受时区影响，只锁定形态而非具体值
    expect(payload.entries[1].text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.entries[2]).toStrictEqual({ key: 'recordId', label: '记录 ID', text: 'rec_1' });
    expect(payload.separator).toBe(' · ');
    expect(payload.text).toBe(`张三 · ${payload.entries[1].text} · rec_1`);
  });

  it('⑫ metaFooter（表内无对应元信息字段）→ 该项跳过，不臆造值', () => {
    const fields = FIELDS.filter((field) => field.id !== 'fld_ct');
    const out = run([mkMetaFooter('m1', ['createdTime', 'recordId'])], RECORD, fields);
    const payload = only(out).payload as { entries: Array<{ key: string }> };
    expect(payload.entries.map((entry) => entry.key)).toEqual(['recordId']);
  });
});

/* ===================== hideWhenEmpty ===================== */

describe('doc/resolve · hideWhenEmpty', () => {
  it('空值字段的区块恰好不在结果里，其余区块按原顺序保留', () => {
    const blocks: DocBlock[] = [
      mkHeading('b1', { type: 'static', text: '标题' }),
      mkParagraph('b2', 'fld_desc', true), // fld_desc = '' → 空
      mkDivider('b3'),
      mkParagraph('b4', 'fld_title', true), // fld_title = '客户 A' → 非空
    ];
    expect(ids(run(blocks))).toEqual(['b1', 'b3', 'b4']);
  });

  it('反向验证：同一组区块把 hideWhenEmpty 关掉后 b2 回到序列原位', () => {
    const blocks: DocBlock[] = [
      mkHeading('b1', { type: 'static', text: '标题' }),
      mkParagraph('b2', 'fld_desc', false),
      mkDivider('b3'),
      mkParagraph('b4', 'fld_title', true),
    ];
    expect(ids(run(blocks))).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('hideWhenEmpty：数字 0 不算空（块保留且文本为 "0"）', () => {
    const out = run([mkParagraph('p_zero', 'fld_num', true)]);
    const block = only(out);
    expect(block.blockId).toBe('p_zero');
    expect(block.payload).toStrictEqual({
      kind: 'paragraph',
      fieldId: 'fld_num',
      text: '0',
      lines: ['0'],
      preserveLineBreaks: true,
    });
    expect(block.values.fld_num.number).toBe(0);
    expect(block.values.fld_num.isEmpty).toBe(false);
  });

  it('hideWhenEmpty：复选框 false 不算空（块保留且文本为 "否"）', () => {
    const out = run([mkParagraph('p_false', 'fld_done', true)]);
    const block = only(out);
    expect(block.blockId).toBe('p_false');
    expect(block.payload).toStrictEqual({
      kind: 'paragraph',
      fieldId: 'fld_done',
      text: '否',
      lines: ['否'],
      preserveLineBreaks: true,
    });
    expect(block.values.fld_done.boolean).toBe(false);
    expect(block.values.fld_done.isEmpty).toBe(false);
  });

  it('hideWhenEmpty：null 值算空 → 整块隐藏', () => {
    const record = recordWith({ fld_desc: null });
    expect(run([mkParagraph('p1', 'fld_desc', true)], record)).toEqual([]);
  });

  it('hideWhenEmpty：空数组（多选未选）算空 → 整块隐藏', () => {
    const record = recordWith({ fld_tags: [] });
    const block = mkImage('i1', 'fld_tags', 'all');
    expect(run([block], record)).toEqual([]);
  });

  it('record 为 null → 全部字段按空处理，hideWhenEmpty 块隐藏', () => {
    const blocks: DocBlock[] = [
      mkHeading('b1', { type: 'static', text: '标题' }),
      mkParagraph('b2', 'fld_title', true),
    ];
    expect(ids(run(blocks, null))).toEqual(['b1']);
  });
});

/* ===================== visibleWhen 条件显隐 ===================== */

describe('doc/resolve · visibleWhen 条件显隐', () => {
  it('未配置 visibleWhen → 恒可见', () => {
    const out = run([mkDivider('d1')]);
    expect(ids(out)).toEqual(['d1']);
  });

  it('条件命中（数量 >= 0，0 参与比较成立）→ 区块保留', () => {
    // 用非空字段（fld_title）承载，确保本用例只验证 visibleWhen、不受 hideWhenEmpty 干扰
    const block = mkParagraph('p1', 'fld_title', true);
    block.visibleWhen = { logic: 'and', items: [{ fieldId: 'fld_num', operator: 'gte', value: 0 }] };
    expect(ids(run([block]))).toEqual(['p1']);
  });

  it('条件未命中（数量 > 0，实际为 0）→ 区块恰好不在结果里', () => {
    const blocks: DocBlock[] = [
      mkDivider('keep1'),
      (() => {
        const block = mkParagraph('hide_me', 'fld_title', true);
        block.visibleWhen = { logic: 'and', items: [{ fieldId: 'fld_num', operator: 'gt', value: 0 }] };
        return block;
      })(),
      mkDivider('keep2'),
    ];
    expect(ids(run(blocks))).toEqual(['keep1', 'keep2']);
  });

  it('条件显隐可注入（isVisible 恒 false → 全部区块隐藏）', () => {
    const blocks: DocBlock[] = [mkDivider('d1'), mkSpacer('s1')];
    const out = resolveBlocks({ blocks, record: RECORD, fields: FIELDS, isVisible: () => false });
    expect(out).toEqual([]);
  });

  it('条件显隐可注入（isVisible 恒 true → 全部区块保留且顺序不变）', () => {
    const blocks: DocBlock[] = [mkDivider('d1'), mkSpacer('s1'), mkPageBreak('pb1')];
    const out = resolveBlocks({ blocks, record: RECORD, fields: FIELDS, isVisible: () => true });
    expect(ids(out)).toEqual(['d1', 's1', 'pb1']);
  });
});

/* ===================== 失效字段引用 ===================== */

describe('doc/resolve · 失效字段引用隐藏', () => {
  it('单字段区块（heading/paragraph/image）引用已删除字段 → 整块隐藏', () => {
    const blocks: DocBlock[] = [
      mkHeading('gone1', { type: 'field', fieldId: 'fld_deleted' }, false),
      mkParagraph('gone2', 'fld_deleted', false),
      mkImage('gone3', 'fld_deleted', 'all', 0, false),
      mkDivider('kept'),
    ];
    expect(ids(run(blocks))).toEqual(['kept']);
  });

  it('键值网格引用已删除字段 → 剔除该行，其余行与块本身保留', () => {
    const out = run([mkKvg('k1', [{ fieldId: 'fld_title' }, { fieldId: 'fld_deleted' }, { fieldId: 'fld_num' }])]);
    const payload = only(out).payload as { rows: Array<{ fieldId: string }> };
    expect(payload.rows.map((row) => row.fieldId)).toEqual(['fld_title', 'fld_num']);
    expect(only(out).fieldIds).toEqual(['fld_title', 'fld_num']);
  });

  it('表格列全部失效（无列可渲染）→ 整块隐藏', () => {
    const blocks: DocBlock[] = [
      mkTable('t_gone', [{ fieldId: 'fld_deleted' }], { type: 'currentRecord' }),
      mkDivider('kept'),
    ];
    expect(ids(run(blocks))).toEqual(['kept']);
  });

  it('标签行引用已删除字段 → 剔除该字段，其余标签保留', () => {
    const out = run([mkBadgeRow('b1', ['fld_deleted', 'fld_tags'], 3)]);
    const payload = only(out).payload as { badges: Array<{ fieldId: string }> };
    expect(payload.badges.map((badge) => badge.fieldId)).toEqual(['fld_tags']);
  });
});

/* ===================== blockId 确定性 ===================== */

describe('doc/resolve · blockId 确定性生成与去重', () => {
  it('模板缺失 blockId → 由确定性工厂按前缀补齐', () => {
    const blocks: DocBlock[] = [
      mkDivider(''),
      mkDivider(''),
      mkSpacer('', 12),
    ];
    expect(ids(run(blocks))).toEqual(['blk_divider_1', 'blk_divider_2', 'blk_spacer_3']);
  });

  it('模板 blockId 重复 → 自动去重，不让分页层 blocksById 丢块', () => {
    const blocks: DocBlock[] = [mkDivider('dup'), mkDivider('dup'), mkSpacer('dup', 8)];
    const out = ids(run(blocks));
    expect(out).toEqual(['dup', 'dup~1', 'dup~2']);
    expect(new Set(out).size).toBe(3);
  });

  it('可注入自定义 id 生成器（常量生成器也不得死循环）', () => {
    const blocks: DocBlock[] = [mkDivider(''), mkDivider('')];
    const out = resolveBlocks({
      blocks,
      record: RECORD,
      fields: FIELDS,
      makeId: (prefix) => `${prefix}#custom`,
    });
    expect(ids(out)).toEqual(['blk_divider#custom', 'blk_divider#custom~1']);
  });
});

/* ===================== 纯函数 / 缓存键 ===================== */

describe('doc/resolve · 纯函数与 payloadHash', () => {
  it('同一输入两次调用 → 结构完全一致（纯函数，无时间/随机依赖）', () => {
    const blocks: DocBlock[] = [
      mkHeading('h1', { type: 'field', fieldId: 'fld_title' }, true),
      mkKvg('k1', [{ fieldId: 'fld_num' }]),
      mkImage('i1', 'fld_att', 'all'),
    ];
    const first = run(blocks);
    const second = run(blocks);
    expect(second).toEqual(first);
  });

  it('区块内容变化 → payloadHash 变化（高度缓存能正确失效）', () => {
    const block = mkParagraph('p1', 'fld_desc', false);
    const before = only(run([block], recordWith({ fld_desc: '甲' })));
    const after = only(run([block], recordWith({ fld_desc: '乙' })));
    expect(before.payloadHash).not.toBe(after.payloadHash);
    // 同内容两次 → hash 稳定
    expect(only(run([block], recordWith({ fld_desc: '甲' }))).payloadHash).toBe(before.payloadHash);
  });

  it('空模板 / 空记录 → 空结果，不抛错', () => {
    expect(run([])).toEqual([]);
    expect(ids(run([mkDivider('d1')], null))).toEqual(['d1']);
  });

  it('未知 kind（配置损坏）→ 跳过该块，不污染版式', () => {
    const broken = { blockId: 'x1', kind: 'notABlock', breakInside: 'auto' } as unknown as DocBlock;
    const blocks: DocBlock[] = [broken, mkDivider('kept')];
    expect(ids(run(blocks))).toEqual(['kept']);
  });
});

/* ===================== 跨页片段透传 ===================== */

describe('doc/resolve · 跨页片段 → DocRenderContext', () => {
  it('片段信息透传给渲染器：非首片不带标签前缀，首片带', () => {
    const base = { fieldMeta: FIELDS[0], display: DISPLAY, theme: THEME, showLabel: true, labelText: '标题' };
    const first = buildDocRenderContext({ ...base, fragmentIndex: 0, fragmentsTotal: 3 });
    const tail = buildDocRenderContext({ ...base, fragmentIndex: 2, fragmentsTotal: 3 });

    expect(first.fragmentIndex).toBe(0);
    expect(first.fragmentsTotal).toBe(3);
    expect(docLabelPrefix(first)).toBe('标题：');
    // 续页不再重复画「标题：」——这正是 fragmentIndex 透传的目的
    expect(tail.fragmentIndex).toBe(2);
    expect(docLabelPrefix(tail)).toBeNull();
  });

  it('缺省片段参数 → 视为未切分（0 / 1）', () => {
    const ctx = buildDocRenderContext({ fieldMeta: FIELDS[0], display: DISPLAY, theme: THEME });
    expect(ctx.fragmentIndex).toBe(0);
    expect(ctx.fragmentsTotal).toBe(1);
    expect(ctx.showLabel).toBe(false);
    expect(ctx.locale).toBe('zh-CN');
  });

  it('非法片段参数被夹紧到合法区间', () => {
    const ctx = buildDocRenderContext({
      fieldMeta: FIELDS[0],
      display: DISPLAY,
      theme: THEME,
      fragmentIndex: 9,
      fragmentsTotal: 2,
    });
    expect(ctx.fragmentsTotal).toBe(2);
    expect(ctx.fragmentIndex).toBe(1);
  });
});
