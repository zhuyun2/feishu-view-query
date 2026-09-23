/**
 * T05 区块渲染器单测（`image` / `table` · `divider` / `spacer` / `pageBreak` / `metaFooter`）。
 *
 * 断言原则（团队禁令，与 `blocks.test.tsx` 同口径）：**每条断言都必须能被「把实现改坏」
 * 证伪** —— 只断言「渲染出了东西」（`toBeTruthy()` / `children.length > 0`）的用例一律不写。
 * 因此这里断言的是：具体标签名、具体单元格文本、具体图片 URL 与数量、具体样式数值、
 * metaFooter 拼接出的**确切文本**，以及**测量契约的 DOM 标记**
 * （`data-block-id` 唯一 / `data-unit-index` 顶层性 / `data-repeat-header` 恰好一个）。
 *
 * ⭐ 三条硬契约（违反会让分页**静默**出错，故每一条都有专门断言）：
 *  - 契约 1：外间距**只能**落在内层元素（`.cbv-doc-block__inner`），根节点 margin 必须为 0，
 *    且根是 BFC（`display:flow-root`）——否则 `measurer` 读到的 `offsetHeight` 不含间距，
 *    测量值比实际占位少 N px，分页越挤越错且不报任何错。
 *  - 契约 2：`data-unit-index` **只给可切分**的区块。6 类里只有 `table`（按 `<tr>`）输出，
 *    `image`/`divider`/`spacer`/`pageBreak`/`metaFooter` 必须为 0
 *    ——误输出会让装箱把它们撕成两半跨页。
 *  - 契约 3：`data-repeat-header` 是 `table` 专属，**恰好 1 个**；其余 5 类为 0。
 *
 * 渲染方式：`renderToStaticMarkup()` → `innerHTML` 注入真实 DOM（与 T04 一致，
 * 既能查结构，也能走真实父子链做顶层性断言；本仓未引入 @testing-library）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocBlock, DocBlockKind, DocTheme } from '@/config/types';
import { defaultDocTheme } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock, ResolvedMetaFooterPayload, ResolvedPayload } from '@/doc/resolve';
import { createDomMeasurer } from '@/pagination/measurer';
import type { BlockMetrics } from '@/pagination/types';
import type { BlockRendererProps } from './BlockRenderer';
import { BlockRenderer } from './BlockRenderer';
import { clampImageWidth } from './MediaBlocks';

const THEME: DocTheme = defaultDocTheme();
const CONTENT_WIDTH = 650;
/** 主题默认区块间距（契约 1 的断言基准） */
const BLOCK_SPACING = THEME.blockSpacing;

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_AMOUNT: FieldMetaLite = { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const FIELD_ATTACH: FieldMetaLite = { id: 'f_attach', name: '附件', type: FieldType.Attachment, isPrimary: false };
const FIELD_EMPTY_ATTACH: FieldMetaLite = {
  id: 'f_attach_empty',
  name: '空附件',
  type: FieldType.Attachment,
  isPrimary: false,
};
const FIELD_CTIME: FieldMetaLite = {
  id: 'f_ctime',
  name: '创建时间',
  type: FieldType.CreatedTime,
  isPrimary: false,
};
const FIELD_LINK: FieldMetaLite = { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false };

const FIELDS: readonly FieldMetaLite[] = [
  FIELD_TITLE,
  FIELD_AMOUNT,
  FIELD_ATTACH,
  FIELD_EMPTY_ATTACH,
  FIELD_CTIME,
  FIELD_LINK,
];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = {
  f_title: FIELD_TITLE,
  f_amount: FIELD_AMOUNT,
  f_attach: FIELD_ATTACH,
  f_attach_empty: FIELD_EMPTY_ATTACH,
  f_ctime: FIELD_CTIME,
  f_link: FIELD_LINK,
};

const RECORD = {
  recordId: 'rec_1',
  fields: {
    f_title: '张三',
    f_amount: 1234567,
    f_attach: [
      { name: 'a.png', url: 'https://img.test/a.png' },
      { name: 'b.png', url: 'https://img.test/b.png' },
      { name: 'c.png', url: 'https://img.test/c.png' },
    ],
    f_attach_empty: [],
    f_ctime: 1700000000000,
    f_link: [
      { recordId: 'rec_l1', title: '项目一期', fields: { f_title: '项目一期', f_amount: 100 } },
      { recordId: 'rec_l2', title: '项目二期', fields: { f_title: '项目二期', f_amount: 200 } },
      { recordId: 'rec_l3', title: '项目三期', fields: { f_title: '项目三期', f_amount: 300 } },
    ],
  },
} as unknown as SdkRecord;

/** 静态渲染到真实 DOM 节点树（便于查结构与父链） */
function renderToDom(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  return host;
}

/** 解析单个区块模板 */
function resolveOne(block: DocBlock): ResolvedBlock {
  const resolved = resolveBlocks({ blocks: [block], record: RECORD, fields: FIELDS as FieldMetaLite[] });
  expect(resolved.length).toBe(1);
  return resolved[0] as ResolvedBlock;
}

function renderResolved(resolved: ResolvedBlock, overrides: Partial<BlockRendererProps> = {}): HTMLElement {
  return renderToDom(
    <BlockRenderer
      resolved={resolved}
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

/** 按 §21.3.4 的默认入参渲染一个区块（模板 → resolve → render） */
function renderBlock(block: DocBlock, overrides: Partial<BlockRendererProps> = {}): HTMLElement {
  return renderResolved(resolveOne(block), overrides);
}

/** 取区块根节点（测量契约的 `data-block-id` 宿主） */
function blockRoot(host: HTMLElement, blockId: string): HTMLElement {
  const root = host.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  expect(root).not.toBeNull();
  return root as HTMLElement;
}

/** 断言所有 `[data-unit-index]` 都是**顶层**的（父链上再无同名属性） */
function expectTopLevelUnits(host: HTMLElement): void {
  const units = Array.from(host.querySelectorAll<HTMLElement>('[data-unit-index]'));
  for (const unit of units) {
    const parent = unit.parentElement;
    expect(parent).not.toBeNull();
    expect(parent?.closest('[data-unit-index]') ?? null).toBeNull();
  }
}

/**
 * 主题十六进制色 → jsdom CSSOM 归一化后的 `rgb(r, g, b)` 串。
 * （`cssstyle` 会把内联样式里的 `#RRGGBB` 归一化成 `rgb(...)`，直接比 hex 会假红。）
 */
function rgbOf(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 直接构造 `ResolvedBlock`（不走 resolve；用于「resolve 会过滤掉、但渲染器仍须能处理」的输入） */function manualResolved(block: DocBlock, payload: ResolvedPayload, extras: Partial<ResolvedBlock> = {}): ResolvedBlock {
  return {
    blockId: block.blockId,
    block,
    kind: block.kind,
    fieldIds: [],
    values: {},
    labels: {},
    payload,
    imageUrls: payload.kind === 'image' ? payload.images.map((image) => image.url) : [],
    rows: payload.kind === 'table' ? payload.rows : [],
    payloadHash: 'manual',
    ...extras,
  };
}

/* ===================== image ===================== */

function imageBlock(overrides: Partial<DocBlock> = {}): DocBlock {
  return {
    blockId: 'blk_img',
    kind: 'image',
    breakInside: 'avoid',
    fieldId: 'f_attach',
    mode: 'all',
    index: 0,
    width: 240,
    height: 120,
    align: 'left',
    hideWhenEmpty: false,
    ...overrides,
  } as DocBlock;
}

describe('image 区块', () => {
  it('mode=all：渲染 3 张图，src/alt 逐张对应，data-image-index = 0/1/2', () => {
    const root = blockRoot(renderBlock(imageBlock()), 'blk_img');
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));

    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'https://img.test/a.png',
      'https://img.test/b.png',
      'https://img.test/c.png',
    ]);
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['a.png', 'b.png', 'c.png']);
    expect(
      Array.from(root.querySelectorAll<HTMLElement>('.cbv-doc-image')).map((node) =>
        node.getAttribute('data-image-index'),
      ),
    ).toEqual(['0', '1', '2']);
  });

  it('mode=first 只出第 1 张；mode=index 出第 index 张（选图口径可证伪）', () => {
    const first = blockRoot(renderBlock(imageBlock({ mode: 'first' } as Partial<DocBlock>)), 'blk_img');
    expect(first.querySelectorAll('img').length).toBe(1);
    expect(first.querySelector('img')?.getAttribute('src')).toBe('https://img.test/a.png');

    const indexed = blockRoot(renderBlock(imageBlock({ mode: 'index', index: 1 } as Partial<DocBlock>)), 'blk_img');
    expect(indexed.querySelectorAll('img').length).toBe(1);
    expect(indexed.querySelector('img')?.getAttribute('src')).toBe('https://img.test/b.png');
  });

  it('width/height 同时写 HTML 属性与内联尺寸（measurer 估高依赖这两个属性）', () => {
    const root = blockRoot(renderBlock(imageBlock()), 'blk_img');
    const img = root.querySelector<HTMLImageElement>('img');

    expect(img?.getAttribute('width')).toBe('240');
    expect(img?.getAttribute('height')).toBe('120');
    expect(img?.style.width).toBe('240px');
    expect(img?.style.height).toBe('120px');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('未配 height 时不写 height 属性（避免把图片拉变形）', () => {
    const block = imageBlock({ mode: 'first' } as Partial<DocBlock>);
    delete (block as { height?: number }).height;
    const img = blockRoot(renderBlock(block), 'blk_img').querySelector<HTMLImageElement>('img');

    expect(img?.getAttribute('height')).toBeNull();
    expect(img?.style.height).toBe('auto');
  });

  it('align 映射到主轴对齐（left/center/right 三态各不相同）', () => {
    const wrap = (align: 'left' | 'center' | 'right'): string => {
      const root = blockRoot(renderBlock(imageBlock({ align } as Partial<DocBlock>)), 'blk_img');
      return root.querySelector<HTMLElement>('.cbv-doc-image-list')?.style.alignItems ?? '';
    };

    expect(wrap('left')).toBe('flex-start');
    expect(wrap('center')).toBe('center');
    expect(wrap('right')).toBe('flex-end');
  });

  it('caption 渲染为说明文本；未配时不渲染说明节点', () => {
    const withCaption = blockRoot(
      renderBlock(imageBlock({ caption: '现场照片' } as Partial<DocBlock>)),
      'blk_img',
    );
    expect(withCaption.querySelector('[data-image-caption="true"]')?.textContent).toBe('现场照片');

    const withoutCaption = blockRoot(renderBlock(imageBlock()), 'blk_img');
    expect(withoutCaption.querySelectorAll('[data-image-caption="true"]').length).toBe(0);
  });

  it('附件为空 → 渲染「暂无图片」占位（不静默空块）', () => {
    const block = imageBlock();
    const empty = manualResolved(block, {
      kind: 'image',
      images: [],
      width: 240,
      align: 'left',
    });
    const root = blockRoot(renderResolved(empty), block.blockId);

    expect(root.querySelectorAll('img').length).toBe(0);
    expect(root.querySelector('[data-image-empty="true"]')?.textContent).toBe('暂无图片');
  });

  it('clampImageWidth：超宽钳制到内容盒，未配宽度占满内容盒', () => {
    expect(clampImageWidth(240, CONTENT_WIDTH)).toBe(240);
    expect(clampImageWidth(900, CONTENT_WIDTH)).toBe(CONTENT_WIDTH);
    expect(clampImageWidth(0, CONTENT_WIDTH)).toBe(CONTENT_WIDTH);
    expect(clampImageWidth(-5, CONTENT_WIDTH)).toBe(CONTENT_WIDTH);
  });
});

/* ===================== table ===================== */

function tableBlock(overrides: Partial<DocBlock> = {}): DocBlock {
  return {
    blockId: 'blk_tbl',
    kind: 'table',
    breakInside: 'auto',
    columns: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }],
    rowSource: { type: 'currentRecord' },
    showHeader: true,
    zebra: false,
    ...overrides,
  } as DocBlock;
}

describe('table 区块', () => {
  it('currentRecord：表头 = 列标题，1 行数据，单元格文本走 DocFieldValue（千分位由 registry 产出）', () => {
    const root = blockRoot(renderBlock(tableBlock()), 'blk_tbl');

    expect(Array.from(root.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['客户名称', '金额']);
    const rows = Array.from(root.querySelectorAll<HTMLElement>('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelectorAll('td').length).toBe(2);
    expect(rows[0]?.textContent).toBe('张三1,234,567');
    // 单元格必须走唯一字段值出口（`.cbv-doc-field` = DocFieldValue 的外层标记）
    expect(root.querySelectorAll('td .cbv-doc-field').length).toBe(2);
    expect(Array.from(root.querySelectorAll('td .cbv-doc-field')).map((n) => n.getAttribute('data-field-id'))).toEqual([
      'f_title',
      'f_amount',
    ]);
  });

  it('linkedRecords：每行一条关联记录，3 行文本逐行对应', () => {
    const root = blockRoot(
      renderBlock(
        tableBlock({ rowSource: { type: 'linkedRecords', fieldId: 'f_link' } } as Partial<DocBlock>),
      ),
      'blk_tbl',
    );
    const rows = Array.from(root.querySelectorAll<HTMLElement>('tbody tr'));

    expect(rows.length).toBe(3);
    expect(rows.map((row) => row.textContent)).toEqual(['项目一期100', '项目二期200', '项目三期300']);
  });

  it('每行 = 一个原子单元，data-unit-index 为块内绝对行号，且是顶层', () => {
    const block = tableBlock({ rowSource: { type: 'linkedRecords', fieldId: 'f_link' } } as Partial<DocBlock>);
    const host = renderBlock(block);
    const root = blockRoot(host, 'blk_tbl');
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(rows.map((row) => row.tagName)).toEqual(['TR', 'TR', 'TR']);
    expect(rows.map((row) => row.getAttribute('data-unit-index'))).toEqual(['0', '1', '2']);
    expectTopLevelUnits(host);
  });

  it('跨页切片 slice={from:1,to:3} 只渲染第 1、2 行，索引仍为绝对行号，表头仍在', () => {
    const block = tableBlock({ rowSource: { type: 'linkedRecords', fieldId: 'f_link' } } as Partial<DocBlock>);
    const root = blockRoot(renderBlock(block, { slice: { from: 1, to: 3 } }), 'blk_tbl');
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(rows.map((row) => row.getAttribute('data-unit-index'))).toEqual(['1', '2']);
    expect(rows.map((row) => row.textContent)).toEqual(['项目二期200', '项目三期300']);
    // 续片同样渲染表头（这就是「续页重复表头」的实现方式）
    expect(root.querySelectorAll('[data-repeat-header]').length).toBe(1);
  });

  it('zebra 按**绝对行号**取奇偶（续片不因切片而错位：from=1 的首行即带底色）', () => {
    const block = tableBlock({
      rowSource: { type: 'linkedRecords', fieldId: 'f_link' },
      zebra: true,
    } as Partial<DocBlock>);
    const striped = blockRoot(renderBlock(block, { slice: { from: 1, to: 3 } }), 'blk_tbl');
    const rows = Array.from(striped.querySelectorAll<HTMLElement>('tbody tr'));

    expect(rows[0]?.getAttribute('data-unit-index')).toBe('1');
    expect(rows[0]?.style.backgroundColor).not.toBe('');
    expect(rows[1]?.style.backgroundColor).toBe('');
  });

  it('列配置生效：widthPx → th 宽度 + table-layout:fixed；align → 单元格 textAlign', () => {
    const root = blockRoot(
      renderBlock(
        tableBlock({
          columns: [
            { fieldId: 'f_title', widthPx: 200 },
            { fieldId: 'f_amount', align: 'right' },
          ],
        } as Partial<DocBlock>),
      ),
      'blk_tbl',
    );
    const ths = Array.from(root.querySelectorAll<HTMLElement>('th'));

    expect(ths[0]?.style.width).toBe('200px');
    expect(ths[1]?.style.textAlign).toBe('right');
    expect(root.querySelector<HTMLElement>('table')?.style.tableLayout).toBe('fixed');
    expect(root.querySelector<HTMLElement>('table')?.getAttribute('data-table-col-count')).toBe('2');
  });

  it('titleOverride 覆盖表头文案', () => {
    const root = blockRoot(
      renderBlock(
        tableBlock({
          columns: [{ fieldId: 'f_title', titleOverride: '客户' }, { fieldId: 'f_amount' }],
        } as Partial<DocBlock>),
      ),
      'blk_tbl',
    );
    expect(Array.from(root.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['客户', '金额']);
  });

  it('showHeader=false → 不渲染 thead，也不产出 data-repeat-header（不能骗测量器）', () => {
    const root = blockRoot(renderBlock(tableBlock({ showHeader: false } as Partial<DocBlock>)), 'blk_tbl');

    expect(root.querySelectorAll('thead').length).toBe(0);
    expect(root.querySelectorAll('[data-repeat-header]').length).toBe(0);
    // 表体仍在（否则「不重复表头」会退化成「没有数据」）
    expect(root.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('表头恰好一个 data-repeat-header，且就是 <thead> 本身', () => {
    const root = blockRoot(renderBlock(tableBlock()), 'blk_tbl');
    const headers = Array.from(root.querySelectorAll<HTMLElement>('[data-repeat-header]'));

    expect(headers.length).toBe(1);
    expect(headers[0]?.tagName).toBe('THEAD');
  });
});

/* ===================== divider / spacer / pageBreak / metaFooter ===================== */

function dividerBlock(overrides: Partial<DocBlock> = {}): DocBlock {
  return {
    blockId: 'blk_div',
    kind: 'divider',
    breakInside: 'avoid',
    thickness: 3,
    borderStyle: 'dashed',
    ...overrides,
  } as DocBlock;
}

describe('divider 区块', () => {
  it('线宽走 border-top-width、线型走 border-top-style，其余三边显式 none', () => {
    const divider = blockRoot(renderBlock(dividerBlock()), 'blk_div').querySelector<HTMLElement>('hr');

    expect(divider?.tagName).toBe('HR');
    expect(divider?.style.borderTopWidth).toBe('3px');
    expect(divider?.style.borderTopStyle).toBe('dashed');
    // 其余三边：jsdom 的 cssstyle 不暴露 border-*-style 长手属性（读出来恒为 ''），
    // 故改为断言**真实写进 DOM 的 style 属性串**（一样能被「删掉这三行声明」证伪）。
    const styleAttr = divider?.getAttribute('style') ?? '';
    expect(styleAttr).toMatch(/border-left-style:\s*none/);
    expect(styleAttr).toMatch(/border-right-style:\s*none/);
    expect(styleAttr).toMatch(/border-bottom-style:\s*none/);
    expect(divider?.getAttribute('data-divider-style')).toBe('dashed');
    expect(divider?.getAttribute('data-divider-thickness')).toBe('3');
  });

  it('线色：未配 style.color 时回落主题 dividerColor；配了则用用户色（Q4）', () => {
    const fallback = blockRoot(renderBlock(dividerBlock()), 'blk_div').querySelector<HTMLElement>('hr');
    expect(fallback?.style.borderTopColor).toBe(rgbOf(THEME.dividerColor));

    const custom = blockRoot(
      renderBlock(dividerBlock({ style: { color: '#FF0000' } } as Partial<DocBlock>)),
      'blk_div',
    ).querySelector<HTMLElement>('hr');
    expect(custom?.style.borderTopColor).toBe('rgb(255, 0, 0)');
  });

  it('thickness 非正 / 非法时兜底 1px（不产出 0 高度的隐形线）', () => {
    const divider = blockRoot(
      renderBlock(dividerBlock({ thickness: 0 } as Partial<DocBlock>)),
      'blk_div',
    ).querySelector<HTMLElement>('hr');

    expect(divider?.style.borderTopWidth).toBe('1px');
  });

  it('borderStyle=dotted 如实透传（线型不被写死）', () => {
    const divider = blockRoot(
      renderBlock(dividerBlock({ borderStyle: 'dotted' } as Partial<DocBlock>)),
      'blk_div',
    ).querySelector<HTMLElement>('hr');

    expect(divider?.style.borderTopStyle).toBe('dotted');
  });
});

describe('spacer 区块', () => {
  it('占位盒高度 = 配置的 height（px）', () => {
    const block: DocBlock = { blockId: 'blk_sp', kind: 'spacer', breakInside: 'auto', height: 24 };
    const spacer = blockRoot(renderBlock(block), 'blk_sp').querySelector<HTMLElement>('.cbv-doc-spacer');

    expect(spacer?.style.height).toBe('24px');
    expect(spacer?.getAttribute('data-spacer-height')).toBe('24');
    expect(spacer?.getAttribute('aria-hidden')).toBe('true');
  });

  it('高度非法（负 / NaN）兜底 0，不产出负高度', () => {
    const block: DocBlock = { blockId: 'blk_sp', kind: 'spacer', breakInside: 'auto', height: -10 };
    const spacer = blockRoot(renderBlock(block), 'blk_sp').querySelector<HTMLElement>('.cbv-doc-spacer');

    expect(spacer?.style.height).toBe('0px');
  });
});

describe('pageBreak 区块', () => {
  it('不产生任何可见 DOM（渲染结果为空字符串），但仍是合法的 ResolvedBlock（分页指令）', () => {
    const block: DocBlock = { blockId: 'blk_pb', kind: 'pageBreak', breakInside: 'auto' };
    const resolved = resolveOne(block);

    expect(resolved.kind).toBe('pageBreak');
    expect(resolved.payload.kind).toBe('pageBreak');
    expect(renderToStaticMarkup(<BlockRenderer resolved={resolved} fragmentIndex={0} fragmentsTotal={1} theme={THEME} locale="zh-CN" record={RECORD} fieldsById={FIELDS_BY_ID} contentWidth={CONTENT_WIDTH} />)).toBe('');
  });

  it('渲染后宿主里查不到 data-block-id 与任何内容节点', () => {
    const block: DocBlock = { blockId: 'blk_pb', kind: 'pageBreak', breakInside: 'auto' };
    const host = renderBlock(block);

    expect(host.querySelectorAll('[data-block-id]').length).toBe(0);
    expect((host.textContent ?? '').trim()).toBe('');
  });
});

function metaFooterBlock(overrides: Partial<DocBlock> = {}): DocBlock {
  return {
    blockId: 'blk_mf',
    kind: 'metaFooter',
    breakInside: 'avoid',
    fields: ['createdTime', 'recordId'],
    separator: ' · ',
    fontSize: 12,
    muted: true,
    ...overrides,
  } as DocBlock;
}

describe('metaFooter 区块', () => {
  it('逐项产出 data-meta-entry，项间插入 separator；textContent = 各项按 separator 拼接', () => {
    const resolved = resolveOne(metaFooterBlock());
    const payload = resolved.payload as ResolvedMetaFooterPayload;
    const root = blockRoot(renderResolved(resolved), 'blk_mf');

    const entries = Array.from(root.querySelectorAll<HTMLElement>('[data-meta-entry]'));
    const separators = Array.from(root.querySelectorAll<HTMLElement>('[data-meta-separator="true"]'));

    expect(entries.length).toBe(2);
    expect(entries.map((node) => node.getAttribute('data-meta-entry'))).toEqual(['createdTime', 'recordId']);
    // 渲染出的项文本必须**逐字**等于 resolve 产出的项（渲染层不得再格式化）
    expect(entries.map((node) => node.textContent)).toEqual(payload.entries.map((entry) => entry.text));
    expect(separators.length).toBe(entries.length - 1);
    expect(separators[0]?.textContent).toBe(' · ');
    expect(root.textContent).toBe(payload.entries.map((entry) => entry.text).join(' · '));
    // 记录 ID 是确定值（与本地时区无关的硬断言）
    expect(entries[1]?.textContent).toBe('rec_1');
  });

  it('拼接出的确切文本 = 各项 + separator（手造 payload，排除 resolve 干扰）', () => {
    const block = metaFooterBlock({ separator: ' | ' } as Partial<DocBlock>);
    const resolved = manualResolved(block, {
      kind: 'metaFooter',
      entries: [
        { key: 'createdUser', label: '创建人', text: '甲' },
        { key: 'modifiedUser', label: '修改人', text: '乙' },
        { key: 'recordId', label: '记录 ID', text: '丙' },
      ],
      separator: ' | ',
      fontSize: 12,
      muted: true,
      text: '甲 | 乙 | 丙',
    });
    const root = blockRoot(renderResolved(resolved), 'blk_mf');

    expect(root.textContent).toBe('甲 | 乙 | 丙');
    expect(root.textContent ?? '').not.toContain('·');
  });

  it('muted=true 用主题 mutedColor；fontSize 如实透传；条目数写在 data-meta-count', () => {
    const root = blockRoot(renderBlock(metaFooterBlock()), 'blk_mf');
    const box = root.querySelector<HTMLElement>('.cbv-doc-meta-footer');

    expect(box?.style.color).toBe(rgbOf(THEME.mutedColor));
    expect(box?.style.fontSize).toBe('12px');
    expect(box?.getAttribute('data-meta-count')).toBe('2');

    const notMuted = blockRoot(
      renderBlock(metaFooterBlock({ muted: false } as Partial<DocBlock>)),
      'blk_mf',
    ).querySelector<HTMLElement>('.cbv-doc-meta-footer');
    expect(notMuted?.style.color).toBe('');
  });

  it('entries 为空时渲染空容器（不崩、不产出分隔符）', () => {
    const block = metaFooterBlock();
    const resolved = manualResolved(block, {
      kind: 'metaFooter',
      entries: [],
      separator: ' · ',
      fontSize: 12,
      muted: true,
      text: '',
    });
    const root = blockRoot(renderResolved(resolved), 'blk_mf');

    expect(root.querySelectorAll('[data-meta-entry]').length).toBe(0);
    expect(root.querySelectorAll('[data-meta-separator="true"]').length).toBe(0);
    expect(root.textContent).toBe('');
  });
});

/* ===================== 三条硬契约 + 真实测量器端到端 ===================== */

/** T05 的 6 类区块（同一套 fixture，供契约断言与端到端测量共用） */
function allSixBlocks(): DocBlock[] {
  return [
    imageBlock({ mode: 'first' } as Partial<DocBlock>),
    tableBlock({ rowSource: { type: 'linkedRecords', fieldId: 'f_link' } } as Partial<DocBlock>),
    dividerBlock(),
    { blockId: 'blk_sp', kind: 'spacer', breakInside: 'auto', height: 24 } as DocBlock,
    { blockId: 'blk_pb', kind: 'pageBreak', breakInside: 'auto' } as DocBlock,
    metaFooterBlock(),
  ];
}

/** 5 类**产 DOM**的区块（pageBreak 不产，单独断言） */
const RENDERED_KINDS: readonly DocBlockKind[] = ['image', 'table', 'divider', 'spacer', 'metaFooter'];

/** 逐类渲染成独立宿主，返回 渲染器识别键 → 宿主 */
function renderByKind(): Record<string, { host: HTMLElement; block: DocBlock; resolved: ResolvedBlock }> {
  const out: Record<string, { host: HTMLElement; block: DocBlock; resolved: ResolvedBlock }> = {};
  for (const block of allSixBlocks()) {
    const resolved = resolveOne(block);
    out[block.blockId] = { host: renderResolved(resolved), block, resolved };
  }
  return out;
}

describe('T05 测量契约（DOM 标记）', () => {
  it('契约 3：data-repeat-header 恰好一个，且只有 table 产出；其余 4 类为 0', () => {
    const rendered = renderByKind();
    const counts: Record<string, number> = {};
    for (const kind of RENDERED_KINDS) {
      const entry = Object.values(rendered).find((item) => item.block.kind === kind);
      expect(entry).toBeDefined();
      counts[kind] = (entry as { host: HTMLElement }).host.querySelectorAll('[data-repeat-header]').length;
    }

    expect(counts.table).toBe(1);
    expect(counts.image).toBe(0);
    expect(counts.divider).toBe(0);
    expect(counts.spacer).toBe(0);
    expect(counts.metaFooter).toBe(0);
    // pageBreak 不产 DOM，故其 host 里也不可能有表头标记
    expect(rendered.blk_pb?.host.querySelectorAll('[data-repeat-header]').length).toBe(0);
  });

  it('契约 2：data-unit-index 只有 table 输出（3 行），其余 4 类 + pageBreak 为 0', () => {
    const rendered = renderByKind();
    const counts: Record<string, number> = {};
    for (const kind of RENDERED_KINDS) {
      const entry = Object.values(rendered).find((item) => item.block.kind === kind);
      counts[kind] = (entry as { host: HTMLElement }).host.querySelectorAll('[data-unit-index]').length;
    }

    expect(counts.table).toBe(3);
    expect(counts.image).toBe(0);
    expect(counts.divider).toBe(0);
    expect(counts.spacer).toBe(0);
    expect(counts.metaFooter).toBe(0);
    expect(rendered.blk_pb?.host.querySelectorAll('[data-unit-index]').length).toBe(0);
  });

  it('契约 1：外间距落在内层，区块根 margin 为 0 且是 BFC（display:flow-root）', () => {
    const rendered = renderByKind();
    for (const kind of RENDERED_KINDS) {
      const entry = Object.values(rendered).find((item) => item.block.kind === kind) as {
        host: HTMLElement;
        block: DocBlock;
      };
      const root = blockRoot(entry.host, entry.block.blockId);
      const inner = root.querySelector<HTMLElement>('.cbv-doc-block__inner');

      // 根：BFC + 零 margin（inline 与 computed 双证）
      expect(root.style.display).toBe('flow-root');
      expect(root.style.marginTop).toBe('');
      expect(root.style.marginBottom).toBe('');
      const computed = window.getComputedStyle(root);
      expect(['', '0px']).toContain(computed.marginTop);
      expect(['', '0px']).toContain(computed.marginBottom);

      // 间距在内层：theme.blockSpacing 完整落在 .cbv-doc-block__inner 的 margin-bottom
      expect(inner?.style.marginBottom).toBe(`${BLOCK_SPACING}px`);
    }
  });

  it('每类区块根都有唯一的 data-block-id，且 data-block-kind = kind', () => {
    const rendered = renderByKind();
    for (const kind of RENDERED_KINDS) {
      const entry = Object.values(rendered).find((item) => item.block.kind === kind) as {
        host: HTMLElement;
        block: DocBlock;
      };
      const roots = entry.host.querySelectorAll(`[data-block-id="${entry.block.blockId}"]`);
      expect(roots.length).toBe(1);
      expect((roots[0] as HTMLElement).getAttribute('data-block-kind')).toBe(kind);
    }
  });

  it('所有 data-unit-index 均满足顶层性（父链上无第二个同名属性）', () => {
    for (const block of allSixBlocks()) {
      expectTopLevelUnits(renderBlock(block));
    }
  });
});

describe('T05 端到端：真实 createDomMeasurer().measureBlocks()', () => {
  /**
   * jsdom 没有布局引擎（`offsetHeight` 恒 0），本用例**只为被断言的那几个节点**
   * 定义 `offsetHeight`，从而证明测量器**确实读到了正确的节点**：
   *  - 若 `data-repeat-header` 忘了写 / 写在别处 → `repeatHeaderHeight` 会是 0（红）；
   *  - 若 `data-unit-index` 写在包裹层或索引不是数字 → `units` 会是 undefined / 乱序（红）；
   *  - 若区块根没有 `data-block-id` → `outerHeight` 会是 0（红）。
   */
  function pinHeight(node: Element | null | undefined, value: number): void {
    expect(node).toBeTruthy();
    Object.defineProperty(node as HTMLElement, 'offsetHeight', { value, configurable: true });
  }

  it('6 个根都能按 data-block-id 索引到；table 的 units/repeatHeaderHeight 正确，其余 5 类为 undefined/0', () => {
    const blocks = allSixBlocks();
    const resolvedList = blocks.map((block) => resolveOne(block));
    const host = document.createElement('div');
    host.innerHTML = resolvedList.map((resolved) => renderToStaticMarkup(<BlockRenderer resolved={resolved} fragmentIndex={0} fragmentsTotal={1} theme={THEME} locale="zh-CN" record={RECORD} fieldsById={FIELDS_BY_ID} contentWidth={CONTENT_WIDTH} />)).join('');

    // 逐根 pin 上可辨识的高度（含 pageBreak：它根本不在宿主里）
    const expectedOuter: Record<string, number> = {
      blk_img: 180,
      blk_tbl: 260,
      blk_div: 25,
      blk_sp: 36,
      blk_mf: 20,
    };
    for (const [blockId, height] of Object.entries(expectedOuter)) {
      pinHeight(host.querySelector(`[data-block-id="${blockId}"]`), height);
    }
    // table 表头与 3 个数据行：行高 = 100 + 行号（索引错位/漏读都会让数组对不上）
    const tableRoot = host.querySelector('[data-block-id="blk_tbl"]') as HTMLElement;
    pinHeight(tableRoot.querySelector('[data-repeat-header]'), 33);
    const rows = Array.from(tableRoot.querySelectorAll('[data-unit-index]'));
    expect(rows.length).toBe(3);
    rows.forEach((row, index) => pinHeight(row, 100 + index));

    const metrics: BlockMetrics[] = createDomMeasurer().measureBlocks(
      host,
      resolvedList.map((resolved) => ({ blockId: resolved.blockId, kind: resolved.kind })),
    );

    expect(metrics.length).toBe(6);
    const byId = new Map(metrics.map((metric) => [metric.blockId, metric]));

    // ① 5 个产 DOM 的根全部被按 data-block-id 索引到（找不到时 outerHeight 会是 0）
    for (const [blockId, height] of Object.entries(expectedOuter)) {
      const metric = byId.get(blockId);
      expect(metric).toBeDefined();
      expect(metric?.kind).toBe(resolvedList.find((item) => item.blockId === blockId)?.kind);
      expect(metric?.outerHeight).toBe(height);
    }

    // ② table：units = 每个顶层 <tr> 的高度（按 data-unit-index 升序），表头高度被读到
    expect(byId.get('blk_tbl')?.units).toEqual([100, 101, 102]);
    expect(byId.get('blk_tbl')?.repeatHeaderHeight).toBe(33);

    // ③ 其余 4 类（不可切分）：units 必须 undefined（否则装箱会撕块），无表头 → 0
    for (const kind of ['image', 'divider', 'spacer', 'metaFooter'] as const) {
      const metric = metrics.find((item) => item.kind === kind);
      expect(metric?.units).toBeUndefined();
      expect(metric?.repeatHeaderHeight).toBe(0);
    }

    // ④ pageBreak：不渲染 → 测量器查无此根 → 走「根不存在」快路径
    //    （该路径只返回 `{blockId, kind, outerHeight: 0}`，故 units/repeatHeaderHeight 是
    //     `undefined` 而非 0 —— 按 §21.3.1「0/undefined = 不重复」两者同义）
    expect(byId.get('blk_pb')?.outerHeight).toBe(0);
    expect(byId.get('blk_pb')?.units).toBeUndefined();
    expect(byId.get('blk_pb')?.repeatHeaderHeight).toBeUndefined();
  });

  it('table 续片（slice）仍可被测量：units 数 = 本片段行数，索引为绝对行号、表头高度不变', () => {
    const block = tableBlock({ rowSource: { type: 'linkedRecords', fieldId: 'f_link' } } as Partial<DocBlock>);
    const resolved = resolveOne(block);
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<BlockRenderer resolved={resolved} fragmentIndex={1} fragmentsTotal={2} slice={{ from: 1, to: 3 }} theme={THEME} locale="zh-CN" record={RECORD} fieldsById={FIELDS_BY_ID} contentWidth={CONTENT_WIDTH} />);

    const root = host.querySelector('[data-block-id="blk_tbl"]') as HTMLElement;
    pinHeight(root, 200);
    pinHeight(root.querySelector('[data-repeat-header]'), 33);

    const metrics = createDomMeasurer().measureBlocks(host, [{ blockId: resolved.blockId, kind: 'table' }]);
    expect(metrics.length).toBe(1);
    expect(metrics[0]?.units?.length).toBe(2);
    expect(metrics[0]?.repeatHeaderHeight).toBe(33);
    expect(metrics[0]?.outerHeight).toBe(200);
  });
});
