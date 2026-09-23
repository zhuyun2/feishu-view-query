/**
 * QA-t05 独立证伪用例：M3 文档排版「区块渲染层 + 测量契约」。
 *
 * 本文件**不改**实现方任何文件（含 `blocks.test.tsx` / `blocks.media.test.tsx`）。
 * 目的：对实现方 75 条用例做「假绿审查」之外的**第三方端到端复核** —— 用**真实** `BlockRenderer`
 * + **真实** `resolveBlocks` + **真实** `createDomMeasurer()` 独立验证三条硬契约：
 *
 *  契约 1：区块外间距**只能**在内层元素 margin，根节点 margin 必须为 0 且为 BFC。
 *  契约 2：`data-unit-index` 只给可切分块（paragraph / fieldList / table），且必须**顶层**。
 *  契约 3：`data-repeat-header` 是 `table` 专属（无 `showHeader` 时为 0）。
 *
 * ⚠️ jsdom 无布局引擎（`offsetHeight` 恒 0）：本文件对被测节点 **pin** 高度，
 * 并**断言测量器读到了 pin 的值**（否则就只是在测自己的 stub = 假绿）。
 *
 * 额外覆盖：`data-block-id` **全局唯一**（跨 12 类一次性渲染）；richText markdown 链接协议的
 * 混淆型 XSS 探针（制表符/换行/大小写/`data:`）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocBlock, DocTheme } from '@/config/types';
import { defaultDocTheme } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock } from '@/doc/resolve';
import { createDomMeasurer } from '@/pagination/measurer';
import type { BlockMetrics } from '@/pagination/types';
import type { BlockRendererProps } from './BlockRenderer';
import { BlockRenderer } from './BlockRenderer';
import { safeHref } from './TextBlocks';

const THEME: DocTheme = defaultDocTheme();
const CONTENT_WIDTH = 650;
const SPACING = THEME.blockSpacing;

const F_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const F_AMOUNT: FieldMetaLite = { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const F_NOTE: FieldMetaLite = { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false };
const F_TAGS: FieldMetaLite = { id: 'f_tags', name: '标签', type: FieldType.MultiSelect, isPrimary: false };
const F_ATTACH: FieldMetaLite = { id: 'f_attach', name: '附件', type: FieldType.Attachment, isPrimary: false };
const F_LINK: FieldMetaLite = { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false };
const F_CTIME: FieldMetaLite = { id: 'f_ctime', name: '创建时间', type: FieldType.CreatedTime, isPrimary: false };

const FIELDS: readonly FieldMetaLite[] = [F_TITLE, F_AMOUNT, F_NOTE, F_TAGS, F_ATTACH, F_LINK, F_CTIME];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = {
  f_title: F_TITLE,
  f_amount: F_AMOUNT,
  f_note: F_NOTE,
  f_tags: F_TAGS,
  f_attach: F_ATTACH,
  f_link: F_LINK,
  f_ctime: F_CTIME,
};

const RECORD = {
  recordId: 'rec_1',
  fields: {
    f_title: '张三',
    f_amount: 1234567,
    f_note: '第一行\n第二行\n第三行',
    f_tags: ['紧急', 'VIP', '续约'],
    f_attach: [
      { name: 'a.png', url: 'https://img.test/a.png' },
      { name: 'b.png', url: 'https://img.test/b.png' },
      { name: 'c.png', url: 'https://img.test/c.png' },
    ],
    f_link: [
      { recordId: 'rec_l1', title: '项目一期', fields: { f_title: '项目一期', f_amount: 100 } },
      { recordId: 'rec_l2', title: '项目二期', fields: { f_title: '项目二期', f_amount: 200 } },
      { recordId: 'rec_l3', title: '项目三期', fields: { f_title: '项目三期', f_amount: 300 } },
    ],
    f_ctime: 1700000000000,
  },
} as unknown as SdkRecord;

/** 12 类区块模板（每类一条，blockId 唯一），用于一次性全量渲染 */
function allTwelveBlocks(): DocBlock[] {
  return [
    { blockId: 'blk_h', kind: 'heading', breakInside: 'avoid', level: 2, source: { type: 'static', text: '标题' }, hideWhenEmpty: false },
    { blockId: 'blk_p', kind: 'paragraph', breakInside: 'auto', fieldId: 'f_note', preserveLineBreaks: true, hideWhenEmpty: false },
    { blockId: 'blk_rt', kind: 'richText', breakInside: 'auto', markdown: '**粗**文本' },
    {
      blockId: 'blk_kvg',
      kind: 'keyValueGrid',
      breakInside: 'avoid',
      columns: 2,
      rows: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }],
      labelWidthPx: 88,
      showColon: true,
      zebra: false,
      hideEmptyRows: false,
    } as DocBlock,
    { blockId: 'blk_fl', kind: 'fieldList', breakInside: 'auto', items: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }, { fieldId: 'f_note' }], showLabels: true, hideEmptyItems: false },
    { blockId: 'blk_br', kind: 'badgeRow', breakInside: 'avoid', fieldIds: ['f_tags'], maxItems: 3, showLabels: true },
    { blockId: 'blk_img', kind: 'image', breakInside: 'avoid', fieldId: 'f_attach', mode: 'all', index: 0, width: 240, height: 120, align: 'left', hideWhenEmpty: false } as DocBlock,
    { blockId: 'blk_tbl', kind: 'table', breakInside: 'auto', columns: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }], rowSource: { type: 'linkedRecords', fieldId: 'f_link' }, showHeader: true, zebra: false } as DocBlock,
    { blockId: 'blk_div', kind: 'divider', breakInside: 'avoid', thickness: 2, borderStyle: 'solid' } as DocBlock,
    { blockId: 'blk_sp', kind: 'spacer', breakInside: 'auto', height: 24 },
    { blockId: 'blk_pb', kind: 'pageBreak', breakInside: 'auto' },
    { blockId: 'blk_mf', kind: 'metaFooter', breakInside: 'avoid', fields: ['createdTime', 'recordId'], separator: ' · ', fontSize: 12, muted: true } as DocBlock,
  ];
}

function renderOne(resolved: ResolvedBlock, overrides: Partial<BlockRendererProps> = {}): ReactElement {
  const props: BlockRendererProps = {
    resolved,
    fragmentIndex: 0,
    fragmentsTotal: 1,
    theme: THEME,
    locale: 'zh-CN',
    record: RECORD,
    fieldsById: FIELDS_BY_ID,
    contentWidth: CONTENT_WIDTH,
    ...overrides,
  };
  return <BlockRenderer {...props} />;
}

/** 渲染一段 markdown 富文本（`richText` 区块）到真实 DOM 宿主，返回宿主（C2/C3 共用） */
function renderRich(markdown: string): HTMLElement {
  const block: DocBlock = { blockId: 'blk_rich2', kind: 'richText', breakInside: 'auto', markdown };
  const resolved = resolveBlocks({ blocks: [block], record: RECORD, fields: FIELDS });
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(renderOne(resolved[0] as ResolvedBlock));
  return host;
}

/** resolve 全部 12 类，断言恰好 12 条（任一类被 resolve 误剔除都会红） */
function resolveAllTwelve(): ResolvedBlock[] {
  const resolved = resolveBlocks({ blocks: allTwelveBlocks(), record: RECORD, fields: FIELDS });
  expect(resolved.map((r) => r.kind)).toEqual([
    'heading',
    'paragraph',
    'richText',
    'keyValueGrid',
    'fieldList',
    'badgeRow',
    'image',
    'table',
    'divider',
    'spacer',
    'pageBreak',
    'metaFooter',
  ]);
  return resolved;
}

/** 全量渲染进单一宿主（模拟 DocPaper/离屏宿主里同时存在全部区块） */
function renderAllTwelve(): { host: HTMLElement; resolved: ResolvedBlock[] } {
  const resolved = resolveAllTwelve();
  const host = document.createElement('div');
  host.innerHTML = resolved.map((r) => renderToStaticMarkup(renderOne(r))).join('');
  return { host, resolved };
}

/** 产 DOM 的 11 类（pageBreak 不产 DOM） */
const RENDERED: readonly string[] = [
  'blk_h',
  'blk_p',
  'blk_rt',
  'blk_kvg',
  'blk_fl',
  'blk_br',
  'blk_img',
  'blk_tbl',
  'blk_div',
  'blk_sp',
  'blk_mf',
];
/** 不可切分的 8 类 blockId（units 必须 undefined） */
const ATOMIC: readonly string[] = ['blk_h', 'blk_rt', 'blk_kvg', 'blk_br', 'blk_img', 'blk_div', 'blk_sp', 'blk_mf'];

function rootOf(host: HTMLElement, blockId: string): HTMLElement {
  const root = host.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  expect(root, `区块根 ${blockId} 必须存在`).not.toBeNull();
  return root as HTMLElement;
}

function pin(node: Element | null | undefined, value: number): void {
  expect(node, 'pin() 目标节点必须存在').toBeTruthy();
  Object.defineProperty(node as HTMLElement, 'offsetHeight', { value, configurable: true });
}

/* ===================== A. 全量渲染 + 全局唯一 ===================== */

describe('A. 12 类一次性渲染（真实 resolve + 真实 BlockRenderer）', () => {
  it('恰好 11 个 DOM 根（pageBreak 无根），且 data-block-id 全局唯一、kind 与 resolve 一致', () => {
    const { host, resolved } = renderAllTwelve();

    const roots = Array.from(host.querySelectorAll<HTMLElement>('[data-block-id]'));
    expect(roots.length).toBe(11);

    const ids = roots.map((node) => node.getAttribute('data-block-id'));
    // ⭐ 全局唯一：重复 id 会让 measurer 的 indexRoots 静默只保留首个 → 测量索引串位
    expect(ids).toEqual([...RENDERED]);
    expect(new Set(ids).size).toBe(11);

    for (const block of resolved) {
      const root = host.querySelector<HTMLElement>(`[data-block-id="${block.blockId}"]`);
      if (block.kind === 'pageBreak') {
        expect(root, 'pageBreak 不得产出 DOM 根').toBeNull();
        continue;
      }
      expect(root).not.toBeNull();
      expect(root?.getAttribute('data-block-kind')).toBe(block.kind);
    }
  });
});

/* ===================== B. 真实测量器端到端 ===================== */

describe('B. 真实 createDomMeasurer().measureBlocks() 端到端', () => {
  const OUTER: Record<string, number> = {
    blk_h: 40,
    blk_p: 90,
    blk_rt: 30,
    blk_kvg: 60,
    blk_fl: 90,
    blk_br: 30,
    blk_img: 180,
    blk_tbl: 260,
    blk_div: 25,
    blk_sp: 36,
    blk_mf: 20,
  };
  const PARA_UNITS = [28, 29, 30];
  const FL_UNITS = [31, 32, 33];
  const TBL_UNITS = [100, 101, 102];
  const TBL_HEADER = 33;

  /** pin 全部根 / 单元 / 表头，返回测量结果 */
  function measureAll(): Map<string, BlockMetrics> {
    const { host, resolved } = renderAllTwelve();

    for (const blockId of RENDERED) pin(rootOf(host, blockId), OUTER[blockId] as number);

    const paraLines = Array.from(rootOf(host, 'blk_p').querySelectorAll<HTMLElement>('[data-unit-index]'));
    expect(paraLines.length).toBe(3);
    paraLines.forEach((node, i) => pin(node, PARA_UNITS[i] as number));

    const flItems = Array.from(rootOf(host, 'blk_fl').querySelectorAll<HTMLElement>('[data-unit-index]'));
    expect(flItems.length).toBe(3);
    flItems.forEach((node, i) => pin(node, FL_UNITS[i] as number));

    const tableRoot = rootOf(host, 'blk_tbl');
    pin(tableRoot.querySelector('[data-repeat-header]'), TBL_HEADER);
    const tableRows = Array.from(tableRoot.querySelectorAll<HTMLElement>('[data-unit-index]'));
    expect(tableRows.length).toBe(3);
    tableRows.forEach((node, i) => pin(node, TBL_UNITS[i] as number));

    const metrics = createDomMeasurer().measureBlocks(
      host,
      resolved.map((r) => ({ blockId: r.blockId, kind: r.kind })),
    );
    expect(metrics.length).toBe(12);
    return new Map(metrics.map((m) => [m.blockId, m]));
  }

  it('12 个区块根全部按 data-block-id 索引到；outerHeight 等于我 pin 的值（证明读数来自 DOM 而非 stub）', () => {
    const byId = measureAll();
    for (const blockId of RENDERED) {
      const metric = byId.get(blockId);
      expect(metric, `${blockId} 未被测量到`).toBeDefined();
      expect(metric?.outerHeight).toBe(OUTER[blockId]);
    }
    // pageBreak：无根 → 走「根不存在」快路径
    expect(byId.get('blk_pb')?.outerHeight).toBe(0);
  });

  it('可切分类 units = 我 pin 的单元高度序列（paragraph 按行 / fieldList 按项 / table 按行）', () => {
    const byId = measureAll();
    expect(byId.get('blk_p')?.units).toEqual(PARA_UNITS);
    expect(byId.get('blk_fl')?.units).toEqual(FL_UNITS);
    expect(byId.get('blk_tbl')?.units).toEqual(TBL_UNITS);
  });

  it('不可切分类 units 必须 undefined（否则装箱会把这些块撕成两半跨页）', () => {
    const byId = measureAll();
    for (const blockId of ATOMIC) {
      expect(byId.get(blockId)?.units, `${blockId} 不得有 units`).toBeUndefined();
    }
    expect(byId.get('blk_pb')?.units).toBeUndefined();
  });

  it('repeatHeaderHeight：table 等于表头实际高度；其余 11 类为 0 / undefined', () => {
    const byId = measureAll();
    expect(byId.get('blk_tbl')?.repeatHeaderHeight).toBe(TBL_HEADER);
    for (const blockId of RENDERED) {
      if (blockId === 'blk_tbl') continue;
      expect(byId.get(blockId)?.repeatHeaderHeight, `${blockId} 不得有表头`).toBe(0);
    }
    expect(byId.get('blk_pb')?.repeatHeaderHeight).toBeUndefined();
  });
});

/* ===================== 三条硬契约（DOM 结构层，独立于实现方用例） ===================== */

describe('契约 1：外间距在内层，根 margin 为 0 且为 BFC（逐 11 类）', () => {
  it('每个区块根：display=flow-root、四向 margin 为空；内层 marginBottom = 主题 blockSpacing', () => {
    const { host } = renderAllTwelve();
    for (const blockId of RENDERED) {
      const root = rootOf(host, blockId);
      expect(root.style.display, `${blockId} 必须是 BFC`).toBe('flow-root');
      // 根 margin 必须为空（若间距挪到根上，offsetHeight 会漏掉间距 → 分页静默错位）
      expect(root.style.marginTop, `${blockId} 根 marginTop 必须为空`).toBe('');
      expect(root.style.marginRight, `${blockId} 根 marginRight 必须为空`).toBe('');
      expect(root.style.marginBottom, `${blockId} 根 marginBottom 必须为空`).toBe('');
      expect(root.style.marginLeft, `${blockId} 根 marginLeft 必须为空`).toBe('');
      expect(root.getAttribute('style') ?? '').not.toMatch(/\bmargin(-top|-right|-bottom|-left)?\s*:/);

      const inner = root.querySelector<HTMLElement>('.cbv-doc-block__inner');
      expect(inner, `${blockId} 必须有内层`).not.toBeNull();
      expect(inner?.style.marginBottom, `${blockId} 间距必须落在内层`).toBe(`${SPACING}px`);
    }
  });
});

describe('契约 2：data-unit-index 只给可切分块，且必须顶层', () => {
  it('逐类计数：paragraph/fieldList/table 有单元，其余 9 类为 0', () => {
    const { host } = renderAllTwelve();
    const counts: Record<string, number> = {};
    for (const blockId of RENDERED) {
      counts[blockId] = rootOf(host, blockId).querySelectorAll('[data-unit-index]').length;
    }
    expect(counts.blk_p).toBe(3);
    expect(counts.blk_fl).toBe(3);
    expect(counts.blk_tbl).toBe(3);
    for (const blockId of ['blk_h', 'blk_rt', 'blk_kvg', 'blk_br', 'blk_img', 'blk_div', 'blk_sp', 'blk_mf']) {
      expect(counts[blockId], `${blockId} 不得输出 data-unit-index`).toBe(0);
    }
    // pageBreak 整个宿主里没有根，自然也没有单元
    expect(host.querySelector('[data-block-id="blk_pb"]')).toBeNull();
  });

  it('顶层性：全量宿主内不存在「父链上还有第二个 data-unit-index」的单元', () => {
    const { host } = renderAllTwelve();
    const units = Array.from(host.querySelectorAll<HTMLElement>('[data-unit-index]'));
    expect(units.length).toBe(9); // 3 + 3 + 3
    for (const unit of units) {
      const parent = unit.parentElement;
      expect(parent).not.toBeNull();
      expect(parent?.closest('[data-unit-index]') ?? null).toBeNull();
    }
  });
});

describe('契约 3：data-repeat-header 是 table 专属', () => {
  it('全量宿主内恰好 1 个，且其祖先 data-block-id = blk_tbl', () => {
    const { host } = renderAllTwelve();
    const headers = Array.from(host.querySelectorAll<HTMLElement>('[data-repeat-header]'));
    expect(headers.length).toBe(1);
    expect(headers[0]?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('blk_tbl');
  });

  it('table.showHeader=false → 0 个（不能骗测量器重复表头）', () => {
    const block = allTwelveBlocks().find((b) => b.blockId === 'blk_tbl') as DocBlock;
    const resolved = resolveBlocks({
      blocks: [{ ...block, showHeader: false } as DocBlock],
      record: RECORD,
      fields: FIELDS,
    });
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(renderOne(resolved[0] as ResolvedBlock));
    expect(host.querySelectorAll('[data-repeat-header]').length).toBe(0);
    expect(host.querySelectorAll('tbody tr[data-unit-index]').length).toBe(3);
  });
});

/* ===================== C. 字段值出口 & XSS ===================== */

describe('C1. 字段值一律经 DocFieldValue（.cbv-doc-field 标记）', () => {
  it('fieldList / keyValueGrid / table 单元格的字段值都带 .cbv-doc-field 且 data-field-id 正确', () => {
    const { host } = renderAllTwelve();

    const flFields = Array.from(rootOf(host, 'blk_fl').querySelectorAll<HTMLElement>('.cbv-doc-field'));
    expect(flFields.map((n) => n.getAttribute('data-field-id'))).toEqual(['f_title', 'f_amount', 'f_note']);

    const kvgFields = Array.from(rootOf(host, 'blk_kvg').querySelectorAll<HTMLElement>('.cbv-doc-field'));
    expect(kvgFields.map((n) => n.getAttribute('data-field-id'))).toEqual(['f_title', 'f_amount']);

    const cells = Array.from(rootOf(host, 'blk_tbl').querySelectorAll<HTMLElement>('td .cbv-doc-field'));
    expect(cells.length).toBe(6); // 3 行 × 2 列
  });
});

describe('C2. richText markdown 链接协议白名单', () => {
  it('放行白名单协议（http/https/mailto/相对/锚点），拦截直白型危险协议', () => {
    const allow = ['https://a.com', 'http://a.com', 'HTTPS://A.COM', 'mailto:a@b.com', '/rel/path', '#anchor'];
    for (const href of allow) {
      expect(safeHref(href), `应放行: ${JSON.stringify(href)}`).toBe(href);
    }
    const blocked = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'JavaScript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    ];
    for (const href of blocked) {
      expect(safeHref(href), `应拦截: ${JSON.stringify(href)}`).toBeNull();
    }
    // 直白 javascript: 链接必须被降级为纯文本（不产出 <a>）
    expect(renderRich('[点我](javascript:alert(1))').querySelectorAll('a').length).toBe(0);
  });

  /**
   * ✅ 缺陷已修复（team-lead 2026-09-21 修复；QA-t05 反转 `it.fails` 探针为**正式回归断言**）。
   *   `TextBlocks.normalizeUrl()` 现在**先归一化（剥任意位置 tab/换行 + 首尾 C0/空格）再判协议**，
   *   与浏览器 URL 解析一致，故以下混淆串必须一律被拒。
   *
   * 正面锚点：同组断言白名单协议被原样放行 —— 否则「safeHref 恒返回 null」会让本用例恒真。
   */
  it('safeHref 归一化后判协议：java<TAB>script: 等混淆型危险协议一律被拒', () => {
    const obfuscated = [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      '\tjavascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript\n:alert(1)',
      '\u0000javascript:alert(1)',
    ];
    for (const href of obfuscated) {
      expect(safeHref(href), `应拦截: ${JSON.stringify(href)}`).toBeNull();
    }
    // 正面锚点：白名单协议 / 相对路径必须原样放行
    expect(safeHref('https://a.com')).toBe('https://a.com');
    expect(safeHref('/rel/path')).toBe('/rel/path');
  });

  /**
   * 渲染级双向断言：混淆型 `javascript:` 链接降级为纯文本；**同时合法链接确实产出 `<a href>`**。
   * ⚠️ 正面锚点不可省 —— 否则「渲染器压根不产出任何 `<a>`」会让否定式断言恒真。
   */
  it('richText：java<TAB>script: 链接降级为纯文本，且合法链接仍产出 <a href>', () => {
    // ① 否定式：混淆型 javascript: 不得产出任何 <a>，且文本保留（降级而非整块消失）
    const dirty = renderRich('[点我](java\tscript:alert(document.cookie))');
    expect(dirty.querySelectorAll('a').length).toBe(0);
    expect(dirty.textContent ?? '').toContain('点我');

    // ② 正面锚点：合法协议与相对路径必须产出带 href 的 <a>
    const cleanHttps = renderRich('[站点](https://example.com)');
    expect(cleanHttps.querySelectorAll('a').length).toBe(1);
    expect(cleanHttps.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(renderRich('[文档](/docs/a)').querySelector('a')?.getAttribute('href')).toBe('/docs/a');
  });
});

/* ===================== D. 对抗性绕过探针（抢在修复者之前找缺口） ===================== */

describe('D. 对抗性探针：尝试绕过 normalizeUrl（当前应全部不可利用）', () => {
  it('首尾 C0 控制符（NUL/VT/FF 等 trim() 剥不掉的）被剥离后才判协议', () => {
    const danger = [
      '\u0000javascript:alert(1)',
      '\u000Bjavascript:alert(1)',
      '\u000Cjavascript:alert(1)',
      ' \u0000\tjavascript:alert(1)',
    ];
    for (const raw of danger) {
      expect(safeHref(raw), `应拦截: ${JSON.stringify(raw)}`).toBeNull();
    }
    expect(safeHref('https://ok.com')).toBe('https://ok.com'); // 正面锚点
  });

  it('大小写/内部 tab 换行混合：JAVASCRIPT\\t: / java\\tscript\\n: 均被拒', () => {
    expect(safeHref('JAVASCRIPT\t:alert(1)')).toBeNull();
    expect(safeHref('java\tscript\n:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('内部 NUL / 垂直制表 / 空格使 scheme 非法 → 浏览器与实现一致按相对路径（不可执行）', () => {
    for (const raw of ['javascript\u0000:alert(1)', 'java\u000Bscript:alert(1)', 'java script:alert(1)']) {
      const out = safeHref(raw);
      // 非协议 → 原样放行；但**不得**是 javascript: 协议（浏览器同样不会当协议执行）
      expect(out, `${JSON.stringify(raw)} 原样放行`).toBe(raw);
      expect(out ?? '').not.toMatch(/^\s*javascript:/i);
    }
  });

  it('百分号编码的 tab（%09）不被浏览器当协议分隔 → 不构成绕过', () => {
    expect(safeHref('java%09script:alert(1)')).toBe('java%09script:alert(1)');
    const href = renderRich('[x](java%09script:alert(1))').querySelector('a')?.getAttribute('href') ?? '';
    expect(href).not.toMatch(/^javascript:/i);
  });

  it('HTML 实体编码不构成绕过（React 转义 & → 不二次解码为 javascript:）', () => {
    for (const raw of ['&#106;avascript:alert(1)', 'javascript&colon;alert(1)']) {
      const href = renderRich(`[x](${raw})`).querySelector('a')?.getAttribute('href') ?? '';
      expect(href, `${raw} 不得产出 javascript: href`).not.toMatch(/^\s*javascript:/i);
    }
  });

  it('Unicode 同类空白（NBSP/全角空格）不在 URL 规范剥离集 → 两边一致按相对路径', () => {
    expect(safeHref('java\u00A0script:alert(1)')).toBe('java\u00A0script:alert(1)');
    expect(safeHref('java\u3000script:alert(1)')).toBe('java\u3000script:alert(1)');
  });
});
