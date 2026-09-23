/**
 * T06 · `DocPaper` 单测（2026-09-21 设计变更：详情改为「**单张连续长页**」后更新）。
 *
 * ⭐ 本文件随设计变更同步更新的断言（旧行为 = A4 分页预览，已按用户拍板移除）：
 *  - 纸张**不再固定高 1123**：高度随内容增长 → 断言 `style.height === ''`（不设内联高）；
 *  - 内容盒**不再固定高 979**：改为只约束**宽** `getContentBox().width`；
 *  - 区块**不再绝对定位**（旧 `top` = 前缀高度累加）→ 改为断言文档流（无 `top` / 无 `absolute`）；
 *  - **页眉 / 页脚 / 页码 / 分页边界** 一律不再渲染（即使 `PageSetup` 里启用）。
 *
 * 断言原则（团队禁令）：每条断言都必须能被「把实现改坏」证伪。因此仍断言：纸张**确切像素**、
 * 页边距 = `pageSetup.margin`、内容盒**确切宽度**、区块按 `blockIds` 顺序渲染且 `data-block-id`
 * 一一对应、跨页片段信息**确实透传**、以及契约 1 的 DOM 证据。
 *
 * 渲染方式沿用本仓现状：`renderToStaticMarkup()` → `innerHTML` 注入真实 DOM（无 @testing-library）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocBlock, DocTheme, PageSetup } from '@/config/types';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock } from '@/doc/resolve';
import type { PagedItem } from '@/pagination/types';
import { DocPaper } from './DocPaper';

const THEME: DocTheme = defaultDocTheme();

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_MTIME: FieldMetaLite = { id: 'f_mtime', name: '修改时间', type: FieldType.ModifiedTime, isPrimary: false };
const FIELD_NOTE: FieldMetaLite = { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false };
const FIELDS: readonly FieldMetaLite[] = [FIELD_TITLE, FIELD_MTIME, FIELD_NOTE];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = {
  f_title: FIELD_TITLE,
  f_mtime: FIELD_MTIME,
  f_note: FIELD_NOTE,
};
const RECORD = {
  recordId: 'rec_1',
  fields: { f_title: '张三', f_note: 'L1\nL2\nL3\nL4\nL5', f_mtime: 1735689600000 },
} as unknown as SdkRecord;

/** 纸页内容盒确切值（A4 纵向，默认页边距 72px）：宽度仍是冻结不变式 */
const PAPER = { w: 794, h: 1123 };
const MARGIN = 72;
const CONTENT = { w: PAPER.w - MARGIN * 2, h: PAPER.h - MARGIN * 2 };

function renderToDom(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  return host;
}

function resolve(list: DocBlock[]): ResolvedBlock[] {
  return resolveBlocks({ blocks: list, record: RECORD, fields: FIELDS as FieldMetaLite[] });
}

const HEADING: DocBlock = {
  blockId: 'blk_h',
  kind: 'heading',
  breakInside: 'avoid',
  level: 1,
  source: { type: 'static', text: '客户档案' },
  hideWhenEmpty: false,
};
const PARAGRAPH: DocBlock = {
  blockId: 'blk_p',
  kind: 'paragraph',
  breakInside: 'auto',
  fieldId: 'f_note',
  preserveLineBreaks: true,
  hideWhenEmpty: false,
};
const DIVIDER: DocBlock = { blockId: 'blk_d', kind: 'divider', breakInside: 'avoid', thickness: 1, borderStyle: 'solid' };
const SPACER: DocBlock = { blockId: 'blk_s', kind: 'spacer', breakInside: 'avoid', height: 12 };
const META: DocBlock = { blockId: 'blk_m', kind: 'metaFooter', breakInside: 'avoid', fields: ['recordId'], separator: ' · ', fontSize: 12, muted: true };

const ALL_RESOLVED = resolve([HEADING, PARAGRAPH, DIVIDER, SPACER, META]);
const BLOCKS_BY_ID: Record<string, ResolvedBlock> = Object.fromEntries(
  ALL_RESOLVED.map((block) => [block.blockId, block]),
);

function item(blockId: string, height: number, extra: Partial<PagedItem> = {}): PagedItem {
  return { blockId, fragmentIndex: 0, fragmentsTotal: 1, height, ...extra };
}

function paperNode(overrides: {
  items?: PagedItem[];
  pageIndex?: number;
  totalPages?: number;
  setup?: PageSetup;
  showHeaderFooter?: boolean;
  showBoundary?: boolean;
  blocksById?: Record<string, ResolvedBlock>;
}): HTMLElement {
  return renderToDom(
    <DocPaper
      pageIndex={overrides.pageIndex ?? 0}
      totalPages={overrides.totalPages ?? 1}
      items={overrides.items ?? [item('blk_h', 30), item('blk_p', 60), item('blk_d', 5), item('blk_m', 20)]}
      pageSetup={overrides.setup ?? defaultPageSetup()}
      theme={THEME}
      blocksById={overrides.blocksById ?? BLOCKS_BY_ID}
      record={RECORD}
      fieldsById={FIELDS_BY_ID}
      locale="zh-CN"
      showHeaderFooter={overrides.showHeaderFooter ?? false}
      showBoundary={overrides.showBoundary}
    />,
  );
}

/** 开启页眉页脚的页面设置（单页长页下**不应**被渲染 —— 用于「移除项」负断言） */
function setupWithHeaderFooter(scope: PageSetup['headerFooterScope'] = 'all'): PageSetup {
  const base = defaultPageSetup();
  return {
    ...base,
    header: { enabled: true, content: '客户档案', align: 'center', fontSize: 12, color: '#8F959E', showBorder: true },
    footer: { enabled: true, content: '', align: 'center', fontSize: 12, color: '#8F959E', showBorder: false },
    showPageNumber: true,
    pageNumberFormat: 'n/total',
    headerFooterScope: scope,
  };
}

/* ===================== 纸张与内容盒尺寸 ===================== */

describe('DocPaper · 纸张与内容盒尺寸', () => {
  it('纸张宽 = A4 794；padding = 页边距 72；内容盒宽 = 650；**高度不设**（随内容增长）', () => {
    const host = paperNode({});
    const root = host.querySelector<HTMLElement>('.cbv-paper');
    const body = host.querySelector<HTMLElement>('.cbv-paper__body');

    expect(root).not.toBeNull();
    expect(root?.style.width).toBe(`${PAPER.w}px`);
    // ⭐ 单页长页：**不设内联高度**（高度由内容撑开）；旧实现此处是 1123px
    expect(root?.style.height).toBe('');
    // 页边距（长手属性）：上/右/下/左 = 72
    expect(root?.style.paddingTop).toBe(`${MARGIN}px`);
    expect(root?.style.paddingRight).toBe(`${MARGIN}px`);
    expect(root?.style.paddingBottom).toBe(`${MARGIN}px`);
    expect(root?.style.paddingLeft).toBe(`${MARGIN}px`);
    expect(root?.dataset.pageIndex).toBe('0');

    expect(body?.style.width).toBe(`${CONTENT.w}px`);
    // ⭐ 内容盒**不再固定高**（旧实现 979px）；仅约束宽（决定换行位置）
    expect(body?.style.height).toBe('');
    // 纸张宽 = 内容盒宽 + 左右页边距（几何同源不变式）
    expect(CONTENT.w + MARGIN * 2).toBe(PAPER.w);
  });

  it('纸张尺寸随 pageSetup 变化（landscape 时宽高互换；宽度可被改坏证伪）', () => {
    const setup: PageSetup = { ...defaultPageSetup(), orientation: 'landscape' };
    const root = paperNode({ setup }).querySelector<HTMLElement>('.cbv-paper');
    expect(root?.style.width).toBe('1123px');
    expect(root?.style.width).not.toBe(`${PAPER.w}px`); // 宽确实被朝向改变
    // ⭐ 高度仍不设（自适应），与朝向无关
    expect(root?.style.height).toBe('');
    expect(root?.dataset.orientation).toBe('landscape');
  });
});

/* ===================== 契约 1：内容区不得叠加 blockSpacing ===================== */

describe('DocPaper · 契约 1（内容区不叠加间距）', () => {
  const items = [item('blk_h', 30), item('blk_p', 60), item('blk_d', 5), item('blk_m', 20)];

  it('内容盒**不设** gap / flex / grid（间距已在块内自洽）', () => {
    const body = paperNode({ items }).querySelector<HTMLElement>('.cbv-paper__body');
    expect(body?.style.gap).toBe('');
    // 未设 display：默认 block 流；一旦改成 flex/grid 并加 gap，间距会被二次叠加
    expect(body?.style.display).toBe('');
  });

  it('内容区不渲染额外 spacer 元素：子元素数 = items 数，且无占位间距节点', () => {
    const body = paperNode({ items }).querySelector<HTMLElement>('.cbv-paper__body');
    expect(body?.children.length).toBe(items.length);
    expect(body?.querySelectorAll('[data-paper-spacer]').length).toBe(0);
  });

  it('区块走**文档流**：不再绝对定位（无 top / position:absolute），根节点无 margin', () => {
    const body = paperNode({ items }).querySelector<HTMLElement>('.cbv-paper__body');
    const roots = Array.from(body?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []);

    // 正面锚点：4 个区块确实渲染在内容盒内
    expect(roots.length).toBe(items.length);
    // 旧实现把区块按 `top` 前缀高度绝对定位；单页长页改为顺序流 → 不得再设 top / absolute
    expect(roots.map((root) => root.style.top)).toEqual(['', '', '', '']);
    expect(roots.every((root) => root.style.position !== 'absolute')).toBe(true);
    // 区块根自身不带 margin（外间距在块内层，见 T04）；带 margin 会与流式排版分叉
    expect(roots[0]?.style.marginBottom).toBe('');
  });
});

/* ===================== 移除项：页眉 / 页脚 / 页码 / 分页边界 ===================== */

describe('DocPaper · 页眉/页脚/页码/边界 已移除', () => {
  it('即使 PageSetup 启用了页眉页脚页码、且 showHeaderFooter/showBoundary=true → 一律不渲染', () => {
    const host = paperNode({
      setup: setupWithHeaderFooter('all'),
      showHeaderFooter: true,
      showBoundary: true,
      pageIndex: 2,
    });

    // 正面锚点：纸页与内容盒确实渲染（否则「没有页眉」可能是整页都没渲染）
    const root = host.querySelector<HTMLElement>('.cbv-paper');
    expect(root).not.toBeNull();
    expect(host.querySelectorAll('[data-block-id]').length).toBeGreaterThan(0);

    // 移除项：页眉 / 页脚 / 页码 / 分页边界 全不存在
    expect(host.querySelectorAll('[data-header-footer]').length).toBe(0);
    expect(host.querySelectorAll('[data-page-number]').length).toBe(0);
    expect(host.querySelectorAll('.cbv-paper__boundary').length).toBe(0);
    // 内容盒之外也没有其它直接子元素（纸页只有内容盒一个子节点）
    const paperChildren = Array.from(root?.children ?? []);
    expect(paperChildren.length).toBe(1);
    expect(paperChildren[0]?.classList.contains('cbv-paper__body')).toBe(true);
  });

  it('pageNumberFormat / headerFooterScope 不再影响 DOM（无页码节点可断言）', () => {
    const first = paperNode({ setup: setupWithHeaderFooter('first'), showHeaderFooter: true, pageIndex: 5 });
    expect(first.querySelectorAll('[data-page-number]').length).toBe(0);
    expect(first.querySelectorAll('[data-header-footer]').length).toBe(0);
  });
});

/* ===================== 契约 3：按 blockId 取区块 + 跨页片段透传 ===================== */

describe('DocPaper · 契约 3（按 blockId 取区块 / 片段透传）', () => {
  it('区块按 items 顺序渲染，data-block-id 与 blockIds 一一对应', () => {
    const items = [item('blk_h', 30), item('blk_p', 60), item('blk_d', 5), item('blk_m', 20)];
    const body = paperNode({ items }).querySelector<HTMLElement>('.cbv-paper__body');
    const ids = Array.from(body?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []).map((root) =>
      root.getAttribute('data-block-id'),
    );

    expect(ids).toEqual(['blk_h', 'blk_p', 'blk_d', 'blk_m']);
  });

  it('跨页片段 fragmentIndex/fragmentsTotal/slice 透传给渲染器（续页只渲染切片行）', () => {
    const items = [item('blk_p', 40, { fragmentIndex: 1, fragmentsTotal: 3, slice: { from: 2, to: 5 } })];
    const body = paperNode({ items }).querySelector<HTMLElement>('.cbv-paper__body');
    const root = body?.querySelector<HTMLElement>('[data-block-id="blk_p"]');

    expect(root?.dataset.fragmentIndex).toBe('1');
    expect(root?.dataset.fragmentsTotal).toBe('3');
    // 切片 [2,5) → 只渲染绝对行号 2/3/4（L3/L4/L5）
    const units = Array.from(root?.querySelectorAll<HTMLElement>('[data-unit-index]') ?? []);
    expect(units.map((unit) => unit.getAttribute('data-unit-index'))).toEqual(['2', '3', '4']);
    expect(units.map((unit) => unit.textContent)).toEqual(['L3', 'L4', 'L5']);
  });

  it('分页产物引用不存在的 blockId → 显式占位（绝不静默丢块）', () => {
    const items = [item('blk_ghost', 20)];
    const body = paperNode({ items, blocksById: {} }).querySelector<HTMLElement>('.cbv-paper__body');
    const missing = body?.querySelector<HTMLElement>('[data-block-missing="true"]');

    expect(missing).not.toBeNull();
    expect(missing?.textContent).toContain('blk_ghost');
  });
});
