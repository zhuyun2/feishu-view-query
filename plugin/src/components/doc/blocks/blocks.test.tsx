/**
 * T04 区块渲染器单测（heading / paragraph / richText · keyValueGrid / fieldList / badgeRow）。
 *
 * 断言原则：**每条断言都必须能被「把实现改坏」证伪** —— 只断言「渲染出了东西」
 * （`toBeTruthy()` / `children.length > 0`）的用例一律不写。
 * 因此这里断言的是：具体标签、具体文本、具体字段值（含千分位格式化）、
 * 具体单元数量与序号，以及**测量契约的 DOM 标记**（`data-block-id` / `data-unit-index`
 * 顶层性 / 未伪造 `data-repeat-header`）。
 *
 * 渲染方式：`renderToStaticMarkup()` → `innerHTML` 注入真实 DOM 节点树
 * （本仓未引入 @testing-library；这样既能查结构，也能走真实父子链做顶层性断言）。
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
import { createDomMeasurer } from '@/pagination/measurer';
import type { DocBlockKind } from '@/config/types';
import type { ResolvedBlock, ResolvedPayload } from '@/doc/resolve';
import type { BlockRendererProps } from './BlockRenderer';
import { BlockRenderer, PENDING_BLOCK_KINDS } from './BlockRenderer';
import { DocFieldValue } from '../DocFieldValue';
import { safeHref } from './TextBlocks';
import { badgeValueOf, clampLabelWidth } from './FieldBlocks';

const THEME: DocTheme = defaultDocTheme();
const CONTENT_WIDTH = 650;

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELD_AMOUNT: FieldMetaLite = { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false };
const FIELD_NOTE: FieldMetaLite = { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false };
const FIELD_TAGS: FieldMetaLite = {
  id: 'f_tags',
  name: '标签',
  type: FieldType.MultiSelect,
  isPrimary: false,
};
const FIELDS: readonly FieldMetaLite[] = [FIELD_TITLE, FIELD_AMOUNT, FIELD_NOTE, FIELD_TAGS];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = {
  f_title: FIELD_TITLE,
  f_amount: FIELD_AMOUNT,
  f_note: FIELD_NOTE,
  f_tags: FIELD_TAGS,
};
const RECORD = {
  recordId: 'rec_1',
  fields: {
    f_title: '张三',
    f_amount: 1234567,
    f_note: '第一行\n第二行\n第三行',
    f_tags: ['紧急', 'VIP', '续约'],
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

/** 按 §21.3.4 的默认入参渲染一个区块 */
function renderBlock(block: DocBlock, overrides: Partial<BlockRendererProps> = {}): HTMLElement {
  const resolved = resolveOne(block);
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

function headingBlock(level: 1 | 2 | 3, text: string): DocBlock {
  return {
    blockId: `blk_h_${level}_${text}`,
    kind: 'heading',
    breakInside: 'avoid',
    level,
    source: { type: 'static', text },
    hideWhenEmpty: false,
  };
}

/* ===================== heading ===================== */

describe('heading 区块', () => {
  it('L2 渲染为 h2 且字号 = baseFontSize × headingScale[1]（14×1.35→19px）', () => {
    const block = headingBlock(2, '客户档案');
    const root = blockRoot(renderBlock(block), block.blockId);

    const heading = root.querySelector('h2');
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe('客户档案');
    expect((heading as HTMLElement).style.fontSize).toBe('19px');
    expect(root.querySelectorAll('h1').length).toBe(0);
  });

  it('L1 渲染为 h1 且字号 = 14×1.6→22px（层级与字阶均可被改坏证伪）', () => {
    const block = headingBlock(1, '记录详情');
    const root = blockRoot(renderBlock(block), block.blockId);

    const heading = root.querySelector('h1');
    expect(heading?.textContent).toBe('记录详情');
    expect((heading as HTMLElement).style.fontSize).toBe('22px');
  });

  it('绑定字段时渲染字段值文本（张三），不渲染字段 id', () => {
    const block: DocBlock = {
      blockId: 'blk_h_field',
      kind: 'heading',
      breakInside: 'avoid',
      level: 3,
      source: { type: 'field', fieldId: 'f_title' },
      hideWhenEmpty: false,
    };
    const root = blockRoot(renderBlock(block), block.blockId);

    const heading = root.querySelector('h3');
    expect(heading?.textContent).toBe('张三');
    expect(root.textContent ?? '').not.toContain('f_title');
  });

  it('不可切分：不输出 data-unit-index', () => {
    const block = headingBlock(1, '标题');
    const root = blockRoot(renderBlock(block), block.blockId);
    expect(root.querySelectorAll('[data-unit-index]').length).toBe(0);
  });
});

/* ===================== paragraph ===================== */

describe('paragraph 区块', () => {
  const paragraphBlock: DocBlock = {
    blockId: 'blk_para',
    kind: 'paragraph',
    breakInside: 'auto',
    fieldId: 'f_note',
    preserveLineBreaks: true,
    hideWhenEmpty: false,
  };

  it('每行 = 一个原子单元，data-unit-index 为块内绝对行号且文本逐行对应', () => {
    const root = blockRoot(renderBlock(paragraphBlock), paragraphBlock.blockId);
    const lines = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(lines.length).toBe(3);
    expect(lines.map((line) => line.getAttribute('data-unit-index'))).toEqual(['0', '1', '2']);
    expect(lines.map((line) => line.textContent)).toEqual(['第一行', '第二行', '第三行']);
  });

  it('跨页切片 slice={from:1,to:3} 只渲染第 1、2 行且索引仍为绝对行号', () => {
    const root = blockRoot(
      renderBlock(paragraphBlock, { slice: { from: 1, to: 3 } }),
      paragraphBlock.blockId,
    );
    const lines = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(lines.length).toBe(2);
    expect(lines.map((line) => line.getAttribute('data-unit-index'))).toEqual(['1', '2']);
    expect(lines.map((line) => line.textContent)).toEqual(['第二行', '第三行']);
  });

  it('顶层性：行单元的父链上没有第二个 data-unit-index', () => {
    expectTopLevelUnits(renderBlock(paragraphBlock));
  });
});

/* ===================== richText ===================== */

describe('richText 区块', () => {
  function richBlock(markdown: string): DocBlock {
    return { blockId: 'blk_rich', kind: 'richText', breakInside: 'auto', markdown };
  }

  it('**粗体** 产出 strong 节点（不是字面量星号）', () => {
    const root = blockRoot(renderBlock(richBlock('这是**粗体**文本')), 'blk_rich');
    const strong = root.querySelector('strong');

    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('粗体');
    expect(root.textContent).toBe('这是粗体文本');
    expect(root.textContent ?? '').not.toContain('**');
  });

  it('*斜体* 产出 em，`行内代码` 产出 code', () => {
    const root = blockRoot(renderBlock(richBlock('*斜体*与`代码`')), 'blk_rich');

    expect(root.querySelector('em')?.textContent).toBe('斜体');
    expect(root.querySelector('code')?.textContent).toBe('代码');
  });

  it('***粗斜体*** 产出 strong>em 嵌套', () => {
    const root = blockRoot(renderBlock(richBlock('***粗斜体***')), 'blk_rich');
    const strong = root.querySelector('strong');

    expect(strong?.querySelector('em')?.textContent).toBe('粗斜体');
  });

  it('列表项产出 ul>li（两项）', () => {
    const root = blockRoot(renderBlock(richBlock('- 第一项\n- 第二项')), 'blk_rich');
    const items = Array.from(root.querySelectorAll('li'));

    expect(root.querySelectorAll('ul').length).toBe(1);
    expect(items.length).toBe(2);
    expect(items.map((item) => item.textContent)).toEqual(['第一项', '第二项']);
  });

  it('安全链接产出 a[href] 且带 noopener；javascript: 协议被降级为纯文本', () => {
    const safe = blockRoot(renderBlock(richBlock('[飞书](https://example.com)')), 'blk_rich');
    const anchor = safe.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.getAttribute('rel')).toContain('noopener');

    const unsafe = blockRoot(renderBlock(richBlock('[点我](javascript:alert(1))')), 'blk_rich');
    expect(unsafe.querySelectorAll('a').length).toBe(0);
    expect(unsafe.textContent).toContain('点我');
  });

  it('safeHref：白名单协议放行，其它协议一律拦截', () => {
    expect(safeHref('https://a.com')).toBe('https://a.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeHref('/rel/path')).toBe('/rel/path');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('   ')).toBeNull();
  });

  it('不可切分：不输出 data-unit-index', () => {
    const root = blockRoot(renderBlock(richBlock('纯文本')), 'blk_rich');
    expect(root.querySelectorAll('[data-unit-index]').length).toBe(0);
  });
});

/* ===================== keyValueGrid ===================== */

describe('keyValueGrid 区块', () => {
  function gridBlock(overrides: Partial<DocBlock> = {}): DocBlock {
    return {
      blockId: 'blk_kvg',
      kind: 'keyValueGrid',
      breakInside: 'avoid',
      columns: 2,
      rows: [
        { fieldId: 'f_title' },
        { fieldId: 'f_amount' },
        { fieldId: 'f_tags' },
        { fieldId: 'f_note' },
      ],
      labelWidthPx: 88,
      showColon: true,
      zebra: false,
      hideEmptyRows: false,
      ...overrides,
    } as DocBlock;
  }

  it('渲染出具体字段名（带冒号）与字段值（数字走 registry 千分位）', () => {
    const root = blockRoot(renderBlock(gridBlock()), 'blk_kvg');
    const labels = Array.from(root.querySelectorAll<HTMLElement>('[data-kv-label]')).map(
      (node) => node.textContent,
    );

    expect(labels).toEqual(['客户名称：', '金额：', '标签：', '备注：']);
    expect(root.textContent).toContain('张三');
    expect(root.textContent).toContain('1,234,567');
    expect(root.textContent).toContain('第一行\n第二行\n第三行');
  });

  it('columns=2 产出两列网格模板', () => {
    const root = blockRoot(renderBlock(gridBlock()), 'blk_kvg');
    const grid = root.querySelector<HTMLElement>('.cbv-doc-kv-grid');

    expect(grid?.style.gridTemplateColumns).toContain('repeat(2');
  });

  it('zebra 只对奇数行（第 2 行）上底色', () => {
    const root = blockRoot(renderBlock(gridBlock({ zebra: true } as Partial<DocBlock>)), 'blk_kvg');
    const cells = Array.from(root.querySelectorAll<HTMLElement>('[data-kv-index]'));

    expect(cells.length).toBe(4);
    expect(cells[0]?.style.backgroundColor).toBe('');
    expect(cells[1]?.style.backgroundColor).toBe('');
    expect(cells[2]?.style.backgroundColor).not.toBe('');
    expect(cells[3]?.style.backgroundColor).not.toBe('');
  });

  it('不可切分：不输出 data-unit-index（否则装箱会把它拆到两页）', () => {
    const root = blockRoot(renderBlock(gridBlock()), 'blk_kvg');
    expect(root.querySelectorAll('[data-unit-index]').length).toBe(0);
  });

  it('标签列宽在窄容器下被钳制（不超过单元格宽的 50%）', () => {
    expect(clampLabelWidth(88, 2, 650)).toBe(88);
    expect(clampLabelWidth(200, 2, 650)).toBe(162);
    expect(clampLabelWidth(0, 2, 650)).toBe(0);
  });
});

/* ===================== fieldList ===================== */

describe('fieldList 区块', () => {
  const listBlock: DocBlock = {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }, { fieldId: 'f_note' }],
    showLabels: true,
    hideEmptyItems: false,
  };

  it('每项 = 一个原子单元（0/1/2），标签与值都由渲染器输出', () => {
    const root = blockRoot(renderBlock(listBlock), 'blk_fl');
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(items.map((item) => item.getAttribute('data-unit-index'))).toEqual(['0', '1', '2']);
    expect(items[0]?.textContent).toContain('客户名称：');
    expect(items[0]?.textContent).toContain('张三');
    expect(items[1]?.textContent).toContain('金额：');
    expect(items[1]?.textContent).toContain('1,234,567');
  });

  it('续片（fragmentIndex=1/fragmentsTotal=2）抑制「字段名：」前缀，值仍完整', () => {
    const root = blockRoot(
      renderBlock(listBlock, { fragmentIndex: 1, fragmentsTotal: 2 }),
      'blk_fl',
    );
    const first = root.querySelector<HTMLElement>('[data-unit-index="0"]');

    expect(first?.textContent ?? '').toContain('张三');
    expect(first?.textContent ?? '').not.toContain('客户名称：');
  });

  it('跨页切片 slice={from:1,to:3} 只渲染第 1、2 项且索引为绝对序号', () => {
    const root = blockRoot(renderBlock(listBlock, { slice: { from: 1, to: 3 } }), 'blk_fl');
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));

    expect(items.map((item) => item.getAttribute('data-unit-index'))).toEqual(['1', '2']);
    expect(items[0]?.textContent).toContain('1,234,567');
  });

  it('顶层性：条目单元的父链上没有第二个 data-unit-index', () => {
    expectTopLevelUnits(renderBlock(listBlock));
  });
});

/* ===================== badgeRow ===================== */

describe('badgeRow 区块', () => {
  function badgeBlock(maxItems: number, showLabels: boolean): DocBlock {
    return {
      blockId: 'blk_badge',
      kind: 'badgeRow',
      breakInside: 'avoid',
      fieldIds: ['f_tags'],
      maxItems,
      showLabels,
    };
  }

  it('多选字段渲染为标签 chips，并按 maxItems 截断（3 选 2）', () => {
    const root = blockRoot(renderBlock(badgeBlock(2, false)), 'blk_badge');
    const chips = Array.from(root.querySelectorAll<HTMLElement>('.cbv-tag'));

    expect(chips.map((chip) => chip.textContent)).toEqual(['紧急', 'VIP']);
    expect(root.textContent ?? '').not.toContain('续约');
  });

  it('showLabels 输出字段名标签；关闭时无标签节点', () => {
    const withLabel = blockRoot(renderBlock(badgeBlock(3, true)), 'blk_badge');
    expect(withLabel.querySelector('.cbv-doc-badge-label')?.textContent).toBe('标签');
    expect(withLabel.querySelectorAll('.cbv-tag').length).toBe(3);

    const withoutLabel = blockRoot(renderBlock(badgeBlock(3, false)), 'blk_badge');
    expect(withoutLabel.querySelectorAll('.cbv-doc-badge-label').length).toBe(0);
  });

  it('badgeValueOf 把 texts/colorIndexes 还原成 items（色板交给 TagRenderer，不复制色板）', () => {
    const nv = badgeValueOf({
      fieldId: 'f_tags',
      label: '标签',
      texts: ['紧急', 'VIP'],
      colorIndexes: [0, 3],
      value: {
        kind: 'multiSelect',
        text: '紧急、VIP、续约',
        display: '紧急、VIP、续约',
        isEmpty: false,
      },
    });

    expect(nv.items?.map((item) => item.text)).toEqual(['紧急', 'VIP']);
    expect(nv.items?.map((item) => item.colorIndex)).toEqual([0, 3]);
    expect(nv.isEmpty).toBe(false);
  });

  it('不可切分：不输出 data-unit-index', () => {
    const root = blockRoot(renderBlock(badgeBlock(3, true)), 'blk_badge');
    expect(root.querySelectorAll('[data-unit-index]').length).toBe(0);
  });
});

/* ===================== 测量契约（T02 measurer 依赖） ===================== */

describe('测量契约 DOM 标记', () => {
  const ALL_SIX: DocBlock[] = [
    headingBlock(1, '标题'),
    {
      blockId: 'blk_para2',
      kind: 'paragraph',
      breakInside: 'auto',
      fieldId: 'f_note',
      preserveLineBreaks: true,
      hideWhenEmpty: false,
    },
    { blockId: 'blk_rich2', kind: 'richText', breakInside: 'auto', markdown: '**粗**文本' },
    {
      blockId: 'blk_kvg2',
      kind: 'keyValueGrid',
      breakInside: 'avoid',
      columns: 2,
      rows: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }],
      labelWidthPx: 88,
      showColon: true,
      zebra: false,
      hideEmptyRows: false,
    } as DocBlock,
    {
      blockId: 'blk_fl2',
      kind: 'fieldList',
      breakInside: 'auto',
      items: [{ fieldId: 'f_title' }, { fieldId: 'f_amount' }],
      showLabels: true,
      hideEmptyItems: false,
    },
    {
      blockId: 'blk_badge2',
      kind: 'badgeRow',
      breakInside: 'avoid',
      fieldIds: ['f_tags'],
      maxItems: 3,
      showLabels: true,
    },
  ];

  it('六类区块都输出唯一的 data-block-id 根节点，且 data-block-kind = kind', () => {
    for (const block of ALL_SIX) {
      const host = renderBlock(block);
      const roots = host.querySelectorAll(`[data-block-id="${block.blockId}"]`);
      expect(roots.length).toBe(1);
      expect((roots[0] as HTMLElement).getAttribute('data-block-kind')).toBe(block.kind);
    }
  });

  it('所有 data-unit-index 均满足顶层性（父链上无第二个同名属性）', () => {
    for (const block of ALL_SIX) {
      expectTopLevelUnits(renderBlock(block));
    }
  });

  it('可切分类（paragraph/fieldList）产出单元；不可切分类不产出', () => {
    const counts: Record<string, number> = {};
    for (const block of ALL_SIX) {
      const host = renderBlock(block);
      counts[block.kind] = host.querySelectorAll('[data-unit-index]').length;
    }
    expect(counts.paragraph).toBe(3);
    expect(counts.fieldList).toBe(2);
    expect(counts.heading).toBe(0);
    expect(counts.richText).toBe(0);
    expect(counts.keyValueGrid).toBe(0);
    expect(counts.badgeRow).toBe(0);
  });

  it('本批六类不产出 data-repeat-header（那是表格续页表头专用标记，属 T05）', () => {
    for (const block of ALL_SIX) {
      const host = renderBlock(block);
      expect(host.querySelectorAll('[data-repeat-header]').length).toBe(0);
    }
  });

  /**
   * ⭐ 契约端到端：**真的**把 T02 的 `createDomMeasurer()` 拿过来量本批渲染结果。
   * jsdom 无真实布局（高度恒为 0），但「能否按 `data-block-id` 找到区块根」与
   * 「`units` 数组长度 = 顶层原子单元数」这两条是**可断言且能证伪**的 ——
   * 一旦标记写错（拼错属性名 / 单元嵌套），`units` 会变 undefined 或长度不对。
   */
  it('T02 真实测量器能识别全部区块根与原子单元（jsdom 下断言结构与长度）', () => {
    const host = document.createElement('div');
    const resolvedList = ALL_SIX.map((block) => resolveOne(block));
    host.innerHTML = resolvedList
      .map((resolved) =>
        renderToStaticMarkup(
          <BlockRenderer
            resolved={resolved}
            fragmentIndex={0}
            fragmentsTotal={1}
            theme={THEME}
            locale="zh-CN"
            record={RECORD}
            fieldsById={FIELDS_BY_ID}
            contentWidth={CONTENT_WIDTH}
          />,
        ),
      )
      .join('');

    const measurer = createDomMeasurer();
    const metrics = measurer.measureBlocks(
      host,
      resolvedList.map((resolved) => ({ blockId: resolved.blockId, kind: resolved.kind })),
    );

    expect(metrics.length).toBe(6);
    const byId = new Map(metrics.map((metric) => [metric.blockId, metric]));

    // 六个根全部被按 data-block-id 索引到（找不到时 outerHeight 会是 0 且 units 为 undefined）
    for (const resolved of resolvedList) {
      expect(byId.has(resolved.blockId)).toBe(true);
      expect(byId.get(resolved.blockId)?.kind).toBe(resolved.kind);
    }
    // 可切分类：units 长度 = 顶层单元数
    expect(byId.get('blk_para2')?.units?.length).toBe(3);
    expect(byId.get('blk_fl2')?.units?.length).toBe(2);
    // 不可切分类：units 必须为 undefined（否则装箱会误判为可切分）
    expect(byId.get('blk_h_1_标题')?.units).toBeUndefined();
    expect(byId.get('blk_rich2')?.units).toBeUndefined();
    expect(byId.get('blk_kvg2')?.units).toBeUndefined();
    expect(byId.get('blk_badge2')?.units).toBeUndefined();
    // 表头标记：本批不产出 → 0
    expect(byId.get('blk_para2')?.repeatHeaderHeight).toBe(0);
  });

  it('区块外间距落在内层 margin（根为 BFC），测量 offsetHeight 才会含间距', () => {
    const block = headingBlock(1, '标题');
    const host = renderBlock(block);
    const root = blockRoot(host, block.blockId);
    const inner = root.querySelector<HTMLElement>('.cbv-doc-block__inner');

    expect(root.style.display).toBe('flow-root');
    expect(inner?.style.marginBottom).toBe(`${THEME.blockSpacing}px`);
    expect(root.style.marginBottom).toBe('');
  });

  it('block.style.marginTop 覆盖默认间距', () => {
    const block: DocBlock = { ...headingBlock(1, '标题'), style: { marginTop: 24 } };
    const root = blockRoot(renderBlock(block), block.blockId);
    const inner = root.querySelector<HTMLElement>('.cbv-doc-block__inner');

    expect(inner?.style.marginTop).toBe('24px');
  });
});

/* ===================== 分发器的占位分支 ===================== */

describe('BlockRenderer 分派收敛（T04 → T05）', () => {
  /**
   * 直接构造 `ResolvedBlock`（不走 `resolveBlocks`）：`image` / `table` 的空配置会被
   * resolve 判为「无内容」而剔除（这正是它的职责），但**分发器**仍必须能处理它们
   * —— 本组用例只验证 **BlockRenderer 的分派行为**（区块自身的渲染细节见
   * `blocks.media.test.tsx`）。
   *
   * ⚠️ T05 交付后本组用例改为**双向**断言：
   *  ① **肯定式（关键）**：每类都分派到**对的真实渲染器** —— 容器内必须出现该类
   *     **特有的结构标记**（`image` → `img[src]`；`table` → `thead[data-repeat-header]`
   *     + `tr[data-unit-index]`；`divider` → `hr[data-divider-style]`；
   *     `spacer` → `div[data-spacer-height]`；`metaFooter` → `span[data-meta-entry]`）。
   *     为什么必须肯定式：只断言「`data-block-pending` 数为 0」是**否定式**，
   *     在「分派进了错的分支」或「直接 `return null`」的实现下**同样成立**，
   *     锁不住「确实分派到位」。
   *  ② **否定式**：不得再命中 `PendingBlockView`（占位标记数 0、文本无「占位」）。
   */
  function signedResolved(kind: DocBlockKind): ResolvedBlock {
    const blockId = `blk_${kind}`;
    const block = { blockId, kind, breakInside: 'avoid' } as DocBlock;
    const base = {
      blockId,
      block,
      kind,
      fieldIds: [],
      values: {},
      labels: {},
      imageUrls: [],
      rows: [],
      payloadHash: 'dispatch',
    };
    // 最小但**能产出签名结构**的合法 payload（否则「分派到位」无从断言）
    const payload: Record<string, unknown> = { kind };
    if (kind === 'image') {
      payload.images = [{ name: 'a.png', url: 'https://img.test/a.png', index: 0 }];
      payload.width = 240;
      payload.align = 'left';
    }
    if (kind === 'table') {
      payload.columns = [{ fieldId: 'f_title' }];
      payload.rows = [
        {
          recordId: 'rec_x',
          title: '',
          cells: { f_title: { kind: 'text', text: '张三', display: '张三', isEmpty: false } },
        },
      ];
      payload.showHeader = true;
      payload.zebra = false;
    }
    if (kind === 'divider') {
      payload.thickness = 2;
      payload.borderStyle = 'dashed';
    }
    if (kind === 'spacer') payload.height = 12;
    if (kind === 'metaFooter') {
      payload.entries = [{ key: 'recordId', label: '记录 ID', text: 'rec_1' }];
      payload.separator = ' · ';
      payload.fontSize = 12;
      payload.muted = true;
      payload.text = 'rec_1';
    }
    return { ...base, payload: payload as unknown as ResolvedPayload };
  }

  /** 每类的「签名结构」——出现即证明分派到了该类的真实渲染器（而非占位 / 错分支 / null） */
  const DISPATCH_CASES: Array<{
    kind: DocBlockKind;
    signature: Array<{ selector: string; count: number }>;
    /** 容器文本必须包含（证明渲染器用的是本 payload 的内容） */
    text?: string;
  }> = [
    { kind: 'image', signature: [{ selector: 'img[src="https://img.test/a.png"]', count: 1 }] },
    {
      kind: 'table',
      signature: [
        { selector: 'thead[data-repeat-header]', count: 1 },
        { selector: 'tbody tr[data-unit-index="0"]', count: 1 },
      ],
      text: '张三',
    },
    { kind: 'divider', signature: [{ selector: 'hr[data-divider-style="dashed"]', count: 1 }] },
    { kind: 'spacer', signature: [{ selector: 'div[data-spacer-height="12"]', count: 1 }] },
    {
      kind: 'metaFooter',
      signature: [{ selector: 'span[data-meta-entry="recordId"]', count: 1 }],
      text: 'rec_1',
    },
  ];

  it('5 类各自分派到真实渲染器：区块根存在、kind 正确、签名结构俱全', () => {
    /**
     * ⚠️ 本用例的**肯定式**断言是刻意设计的，别把它简化回否定式：
     * 否定式断言（`data-block-pending` 数为 0 / 文本不含「占位」）在
     * 「**分派到错误渲染器**」时**不会变红** —— 反证 M8：把 `spacer` 分派给 `DividerView`
     * （既不产 pending 也不 `return null`），旧否定式断言全绿，而加强后 M8 共 3 条红（含本用例）。
     */
    // 用例表必须与「曾待实现清单」逐项对齐，防止漏测某一类
    expect(DISPATCH_CASES.map((item) => item.kind)).toEqual([...PENDING_BLOCK_KINDS]);
    expect(PENDING_BLOCK_KINDS).toEqual(['image', 'table', 'divider', 'spacer', 'metaFooter']);

    for (const item of DISPATCH_CASES) {
      const resolved = signedResolved(item.kind);
      const host = renderToDom(
        <BlockRenderer
          resolved={resolved}
          fragmentIndex={0}
          fragmentsTotal={1}
          theme={THEME}
          locale="zh-CN"
          record={RECORD}
          fieldsById={FIELDS_BY_ID}
          contentWidth={CONTENT_WIDTH}
        />,
      );
      const root = blockRoot(host, resolved.blockId);

      // ① 肯定式：分派到位（签名结构 + 内容都来自本 payload）
      expect(root.getAttribute('data-block-kind')).toBe(item.kind);
      for (const { selector, count } of item.signature) {
        expect(root.querySelectorAll(selector).length).toBe(count);
      }
      if (item.text !== undefined) expect(root.textContent ?? '').toContain(item.text);

      // ② 否定式：不再命中占位分支
      expect(root.querySelectorAll('[data-block-pending="true"]').length).toBe(0);
      expect(root.textContent ?? '').not.toContain('占位');
    }
  });

  it('未知 kind → 显式占位，文案锁定为「不支持的区块类型」（不得引回实现状态口径）', () => {
    const resolved = {
      ...signedResolved('spacer'),
      blockId: 'blk_mystery',
      kind: 'mystery' as DocBlockKind,
      block: { blockId: 'blk_mystery', kind: 'mystery', breakInside: 'avoid' } as unknown as DocBlock,
      payload: { kind: 'mystery' } as unknown as ResolvedPayload,
    } as ResolvedBlock;
    const root = blockRoot(
      renderToDom(
        <BlockRenderer
          resolved={resolved}
          fragmentIndex={0}
          fragmentsTotal={1}
          theme={THEME}
          locale="zh-CN"
          record={RECORD}
          fieldsById={FIELDS_BY_ID}
          contentWidth={CONTENT_WIDTH}
        />,
      ),
      'blk_mystery',
    );

    expect(root.getAttribute('data-block-kind')).toBe('unknown');
    expect(root.querySelectorAll('[data-block-pending="true"]').length).toBe(1);
    expect(root.querySelector('[data-block-pending="true"]')?.textContent).toBe(
      '【占位】不支持的区块类型：未知区块',
    );
    expect(root.textContent ?? '').not.toContain('待实现');
  });

  it('pageBreak 永不渲染（§21.4 规则 9），渲染结果为空字符串', () => {
    const block = { blockId: 'blk_pb', kind: 'pageBreak', breakInside: 'auto' } as DocBlock;
    const resolved = resolveOne(block);
    const html = renderToStaticMarkup(
      <BlockRenderer
        resolved={resolved}
        fragmentIndex={0}
        fragmentsTotal={1}
        theme={THEME}
        locale="zh-CN"
        record={RECORD}
        fieldsById={FIELDS_BY_ID}
        contentWidth={CONTENT_WIDTH}
      />,
    );

    expect(html).toBe('');
  });
});

/* ===================== DocFieldValue ===================== */

describe('DocFieldValue（唯一字段值出口）', () => {
  it('字段元数据缺失时渲染占位符而非静默 null', () => {
    const host = renderToDom(
      <DocFieldValue
        fieldId="f_ghost"
        record={RECORD}
        fieldsById={FIELDS_BY_ID}
        theme={{
          preset: 'doc',
          primaryColor: '#3370FF',
          borderRadius: 4,
          shadowLevel: 0,
          fontScale: 1,
          titleWeight: 600,
        }}
        locale="zh-CN"
        showLabel={false}
      />,
    );

    expect(host.querySelector('.cbv-doc-field--missing')?.textContent).toBe('—');
  });

  it('归一化值走 registry.renderDoc：数字字段输出千分位格式化文本', () => {
    const host = renderToDom(
      <DocFieldValue
        fieldId="f_amount"
        record={RECORD}
        fieldsById={FIELDS_BY_ID}
        theme={{
          preset: 'doc',
          primaryColor: '#3370FF',
          borderRadius: 4,
          shadowLevel: 0,
          fontScale: 1,
          titleWeight: 600,
        }}
        locale="zh-CN"
        showLabel
        labelText="金额"
      />,
    );

    expect(host.textContent).toContain('金额：');
    expect(host.textContent).toContain('1,234,567');
  });
});
