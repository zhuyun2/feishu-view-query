/**
 * 详情「**单张连续长页**」行为测试（2026-09-21 设计变更，software-engineer-doc）。
 *
 * 覆盖（团队禁令：禁止假绿 —— 判据「把实现改坏，这条断言会变红吗？」）：
 *  - **恰好一个页面容器**（`.cbv-paper` 数量 === 1）且**不存在页码导航**（配正面锚点：抽屉已渲染）；
 *  - **高度自适应**：内容更多 → 容器更高（2 块 vs 8 块）；且**不是固定 1123**（断言具体数值不等）；
 *  - **DOM 里不存在页眉/页脚/页码**（配正面锚点：纸页存在）；
 *  - **内容宽度不变式**：`[data-content-box]` 宽度恒等于 `getContentBox().width`；
 *  - **删掉一个区块 → 页面变矮**；
 *  - **外层滚动**（视口 `overflow:auto`）且**纸内不套滚动区**；
 *  - 既有交互未回归：`Esc` 两级 / 焦点归位 / 适应宽度 / 860px / 无页码导航。
 *
 * 确定性来源：`offsetHeight` 由本文件的**流式布局桩**提供（jsdom 无布局引擎，恒为 0）：
 *   ① 元素有内联 `height` → 返回该值（模拟「固定高度」错误实现）；② `.cbv-paper` → 按区块数折算；
 *   ③ 其余 → 0。这样「高度自适应」与「固定 1123」在桩下会给出**不同**结果，断言才有判别力。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocTemplate, ParagraphBlock, PageSetup } from '@/config/types';
import type { SdkRecord } from '@/sdk/port';
import { createDefaultConfig } from '@/config/defaults';
import { getContentBox } from '@/constants/paper';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { resolveBlocks } from '@/doc/resolve';
import { emptyPagedDocument } from '@/hooks/usePagedDocument';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { DocPreview, type DocPreviewProps } from '@/components/doc/DocPreview';
import { DetailDrawer } from './DetailDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 夹具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

const RECORD = { recordId: 'rA', fields: { f1: '张伟', f2: 100 } } as unknown as SdkRecord;

const CONFIG = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });

/** N 个段落区块的模板（每块都绑定 f1 → 内容确定、可数） */
function paragraphTemplate(count: number, pageSetup?: PageSetup): DocTemplate {
  const base = CONFIG.detail.doc;
  const blocks: ParagraphBlock[] = Array.from({ length: count }, (_, index) => ({
    blockId: `blk_p${index}`,
    kind: 'paragraph',
    breakInside: 'auto',
    fieldId: 'f1',
    preserveLineBreaks: false,
    hideWhenEmpty: false,
  }));
  return pageSetup ? { ...base, blocks, pageSetup } : { ...base, blocks };
}

function seedStore(template: DocTemplate): void {
  const config = { ...CONFIG, detail: { ...CONFIG.detail, doc: template } };
  useViewStore.setState({
    config,
    fields: FIELDS,
    fieldsById: FIELDS_BY_ID,
    records: [RECORD],
    env: { language: 'zh-CN' } as never,
  });
}

/* ============================ 挂载工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  useUiStore.setState({ drawer: initialDrawerState(null) });
});

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return { container, unmount };
}

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 打开抽屉（recordId = rA） */
function open(): void {
  useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA' } });
}

/** 组装 `DocPreview` 入参（用真实 resolve，单页形态） */
function previewProps(template: DocTemplate, overrides: Partial<DocPreviewProps> = {}): DocPreviewProps {
  const resolved = resolveBlocks({ blocks: template.blocks, record: RECORD, fields: FIELDS, locale: 'zh-CN' });
  const blocksById = Object.fromEntries(resolved.map((b) => [b.blockId, b]));
  const items = resolved.map((b) => ({ blockId: b.blockId, fragmentIndex: 0, fragmentsTotal: 1, height: 0 }));
  const pagedDoc =
    resolved.length === 0
      ? emptyPagedDocument()
      : { pages: [{ pageIndex: 0, items, usedHeight: 0 }], totalPages: 1, fontReady: true, degraded: false };
  return {
    pagedDoc,
    pageSetup: template.pageSetup,
    theme: template.theme,
    zoom: 1,
    fitToWidth: false,
    currentPage: 0,
    onPageChange: () => undefined,
    showBoundary: false,
    blocksById,
    record: RECORD,
    fieldsById: FIELDS_BY_ID,
    locale: 'zh-CN',
    ...overrides,
  };
}

/**
 * 流式布局桩：给 `offsetHeight` 一个「内容驱动」的模型。
 *  - 有内联 `height` → 返回该值（模拟「固定高度」实现，会被下面用例判红）；
 *  - `.cbv-paper` → 40px × 内部 `.cbv-doc-block` 个数；
 *  - 其余 → 0。
 */
async function withFlowHeight(fn: () => Promise<void> | void): Promise<void> {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      const inline = this.style?.height;
      if (typeof inline === 'string' && inline.endsWith('px')) return Number.parseFloat(inline) || 0;
      if (this.classList?.contains('cbv-paper')) return 40 * this.querySelectorAll('.cbv-doc-block').length;
      return 0;
    },
  });
  try {
    await fn();
  } finally {
    if (previous) Object.defineProperty(proto, 'offsetHeight', previous);
    else Reflect.deleteProperty(proto, 'offsetHeight');
  }
}

beforeEach(() => {
  seedStore(CONFIG.detail.doc);
  useUiStore.setState({ drawer: initialDrawerState(null) });
});

/* ============================================================
 * ① 恰好一个页面容器 · 无页码导航
 * ============================================================ */

describe('单张连续长页 · 一个页面容器 + 无页码导航', () => {
  it('抽屉渲染 1 张 .cbv-paper；页码导航 / 虚拟化占位 / 分页边界 全部消失', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
    await flush();

    // 正面锚点：抽屉与文档预览确实渲染了，且真渲染出了区块（防「目标消失 → 恒真」）
    expect(container.querySelector('[data-testid="detail-drawer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="doc-preview"]')).not.toBeNull();
    expect(container.querySelectorAll('.cbv-doc-block').length).toBeGreaterThan(0);

    // 核心断言：恰好一个页面容器
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1);

    // 页码导航 / 虚拟化 / 分页边界 均不存在
    expect(container.querySelector('[data-testid="page-navigator"]')).toBeNull();
    expect(container.querySelectorAll('[data-page-nav]').length).toBe(0);
    expect(container.querySelectorAll('.cbv-page-nav').length).toBe(0);
    expect(container.querySelectorAll('.cbv-doc-preview__placeholder').length).toBe(0);
    expect(container.querySelectorAll('.cbv-paper__boundary').length).toBe(0);
    unmount();
  });

  it('来源级：DetailDrawer / DocPreview 源码不再 import 或渲染 PageNavigator', () => {
    const drawerSrc = readFileSync(path.resolve(process.cwd(), 'src/components/detail/DetailDrawer.tsx'), 'utf8');
    const previewSrc = readFileSync(path.resolve(process.cwd(), 'src/components/doc/DocPreview.tsx'), 'utf8');
    // 结构性锚点：不匹配「import 语句」与「JSX 组件用法」——而非裸词匹配（注释里提名字是允许的）
    const importPattern = /from\s+['"][^'"]*PageNavigator['"]/;
    const jsxPattern = /<PageNavigator[\s/>]/;
    expect(drawerSrc).not.toMatch(importPattern);
    expect(previewSrc).not.toMatch(importPattern);
    expect(previewSrc).not.toMatch(jsxPattern);
    // 反面哨兵：确实读到了非空源码（否则「不含」恒真）
    expect(drawerSrc).toContain('DetailDrawer');
    expect(previewSrc).toContain('DocPreview');
    // 正面锚点：DocPreview 仍真实渲染 DocPaper（证明读的是正文源码，不是被截断的空串）
    expect(previewSrc).toContain('<DocPaper');
  });

  it('多区块也只有一个容器（8 块 → 仍是 1 张纸，不再分行分页）', async () => {
    seedStore(paragraphTemplate(8));
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
    await flush();
    expect(container.querySelectorAll('.cbv-doc-block').length).toBe(8); // 正面锚点：8 块都在
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1);
    unmount();
  });
});

/* ============================================================
 * ② 高度自适应
 * ============================================================ */

describe('单张连续长页 · 高度随内容增长', () => {
  it('内容更多 → 容器更高（8 块 > 2 块）；且高度 ≠ 固定 1123', async () => {
    await withFlowHeight(async () => {
      const two = mount(createElement(DocPreview, previewProps(paragraphTemplate(2))));
      const eight = mount(createElement(DocPreview, previewProps(paragraphTemplate(8))));

      const paperTwo = two.container.querySelector<HTMLElement>('.cbv-paper');
      const paperEight = eight.container.querySelector<HTMLElement>('.cbv-paper');
      expect(paperTwo).not.toBeNull();
      expect(paperEight).not.toBeNull();

      // 正面锚点：两张纸的区块数确实不同（否则「高度关系」会被同一内容巧合满足）
      expect(paperTwo?.querySelectorAll('.cbv-doc-block').length).toBe(2);
      expect(paperEight?.querySelectorAll('.cbv-doc-block').length).toBe(8);

      // 高度关系：8 块更高
      expect((paperEight as HTMLElement).offsetHeight).toBeGreaterThan((paperTwo as HTMLElement).offsetHeight);
      // 不是固定 1123（A4 纸高）——「固定高度」实现下二者会相等且 = 1123
      expect((paperEight as HTMLElement).offsetHeight).not.toBe(1123);
      expect((paperTwo as HTMLElement).offsetHeight).not.toBe(1123);
      // 内联样式里不设 height（高度完全由内容决定）
      expect(paperEight?.style.height).toBe('');
      expect(paperTwo?.style.height).toBe('');

      two.unmount();
      eight.unmount();
    });
  });

  it('删掉一个区块 → 页面变矮（且被删块确实消失）', async () => {
    await withFlowHeight(async () => {
      const eight = mount(createElement(DocPreview, previewProps(paragraphTemplate(8))));
      const seven = mount(createElement(DocPreview, previewProps(paragraphTemplate(7))));
      const h8 = eight.container.querySelector<HTMLElement>('.cbv-paper') as HTMLElement;
      const h7 = seven.container.querySelector<HTMLElement>('.cbv-paper') as HTMLElement;

      expect(h7.offsetHeight).toBeLessThan(h8.offsetHeight);
      // 被删块不在（正面锚点：其余块仍在）
      expect(seven.container.querySelector('[data-block-id="blk_p7"]')).toBeNull();
      expect(seven.container.querySelector('[data-block-id="blk_p0"]')).not.toBeNull();
      expect(seven.container.querySelectorAll('.cbv-doc-block').length).toBe(7);

      eight.unmount();
      seven.unmount();
    });
  });
});

/* ============================================================
 * ③ 无页眉 / 页脚 / 页码
 * ============================================================ */

describe('单张连续长页 · DOM 无页眉/页脚/页码', () => {
  it('即使 PageSetup 里启用了页眉页脚与页码，详情也不渲染它们', async () => {
    const setup: PageSetup = {
      ...CONFIG.detail.doc.pageSetup,
      header: { enabled: true, content: '客户档案', align: 'center', fontSize: 12, color: '#8F959E', showBorder: true },
      footer: { enabled: true, content: '', align: 'center', fontSize: 12, color: '#8F959E', showBorder: false },
      showPageNumber: true,
      pageNumberFormat: 'n/total',
      headerFooterScope: 'all',
    };
    const { container, unmount } = mount(
      createElement(DocPreview, previewProps(paragraphTemplate(3, setup))),
    );

    // 正面锚点：纸页确实渲染了
    expect(container.querySelector('.cbv-paper')).not.toBeNull();
    expect(container.querySelectorAll('.cbv-doc-block').length).toBe(3);

    // 页眉/页脚/页码 一律不存在
    expect(container.querySelectorAll('[data-header-footer]').length).toBe(0);
    expect(container.querySelectorAll('[data-page-number]').length).toBe(0);
    expect(container.querySelectorAll('.cbv-page-number').length).toBe(0);
    expect(container.querySelectorAll('.cbv-doc-head').length).toBe(0);
    expect(container.querySelectorAll('.cbv-doc-foot').length).toBe(0);
    unmount();
  });
});

/* ============================================================
 * ④ 内容宽度不变式
 * ============================================================ */

describe('单张连续长页 · 内容宽度恒等 getContentBox().width', () => {
  it('横向 + 非对称边距 → 内容盒宽度 = getContentBox()，且不等于纵向默认宽度', () => {
    const setup: PageSetup = {
      ...CONFIG.detail.doc.pageSetup,
      orientation: 'landscape',
      margin: { top: 40, right: 56, bottom: 40, left: 72 },
    };
    const template = paragraphTemplate(3, setup);
    const { container, unmount } = mount(createElement(DocPreview, previewProps(template)));

    const body = container.querySelector<HTMLElement>('[data-content-box="true"]');
    expect(body).not.toBeNull();
    const expected = getContentBox(setup.paper, setup.orientation, setup.margin).width;
    const portrait = getContentBox('A4', 'portrait', CONFIG.detail.doc.pageSetup.margin).width;

    expect(Number.parseFloat((body as HTMLElement).style.width)).toBe(expected);
    expect(expected).not.toBe(portrait); // 分离：换纸/朝向真的改变了宽度
    unmount();
  });
});

/* ============================================================
 * ⑤ 外层滚动（纸内不滚动）
 * ============================================================ */

describe('单张连续长页 · 由外层视口滚动', () => {
  it('视口 overflow:auto；纸页自身不设 overflow（无内层滚动区）', () => {
    const { container, unmount } = mount(createElement(DocPreview, previewProps(paragraphTemplate(6))));
    const viewport = container.querySelector<HTMLElement>('[data-testid="doc-preview-viewport"]');
    const paper = container.querySelector<HTMLElement>('.cbv-paper');

    expect(viewport).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(viewport?.style.overflow).toBe('auto');
    // 纸内不得再套一层滚动区
    expect(paper?.style.overflow).toBe('');
    expect(paper?.style.overflowY).toBe('');
    unmount();
  });
});

/* ============================================================
 * ⑥ 既有交互未回归（M2 冻结值）
 * ============================================================ */

describe('单张连续长页 · 既有交互未回归', () => {
  it('默认宽 860px / 页脚提示（R2）', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
    await flush();
    const html = container.innerHTML;
    expect(html).toMatch(/width:\s*860px/);
    expect(html).toContain('560px ~ 满宽');
    expect(html).toContain('75%~150%');
    unmount();
  });

  it('Esc 两级：全屏 → 先退全屏（抽屉仍开），再按一次才关闭', async () => {
    seedStore(CONFIG.detail.doc);
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA', fullscreen: true } });
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
    await flush();
    expect(container.innerHTML).toContain('data-fullscreen="true"');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUiStore.getState().drawer.fullscreen).toBe(false);
    expect(useUiStore.getState().drawer.open).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUiStore.getState().drawer.open).toBe(false);
    unmount();
  });

  it('关闭后焦点归位到打开前的元素（a11y）', async () => {
    seedStore(CONFIG.detail.doc);
    const trigger = document.createElement('button');
    trigger.textContent = '打开详情';
    document.body.appendChild(trigger);
    trigger.focus();

    open();
    const { unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
    await flush();

    act(() => {
      useUiStore.getState().closeDrawer();
    });
    expect(document.activeElement).toBe(trigger);

    unmount();
    trigger.remove();
  });

  it('适应宽度：ResizeObserver 实测宽度驱动缩放，且「适应宽度」保持按下', async () => {
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    const previousCW = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    const previousRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    class StubResizeObserver {
      constructor(private readonly cb: () => void) {}
      observe(): void {
        this.cb();
      }
      disconnect(): void {
        /* noop */
      }
    }
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 1200 });
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;

    try {
      seedStore(CONFIG.detail.doc);
      open(); // fitToWidth 默认 true
      const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: { awaitFonts: () => Promise.resolve(true) } }));
      await flush();

      expect(useUiStore.getState().drawer.zoom).toBeCloseTo(1.5, 5); // 1200 / 794 → 钳制 1.5
      expect(useUiStore.getState().drawer.fitToWidth).toBe(true);
      expect(container.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.fitToWidth).toBe('true');
      unmount();
    } finally {
      if (previousCW) Object.defineProperty(proto, 'clientWidth', previousCW);
      else Reflect.deleteProperty(proto, 'clientWidth');
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previousRO;
    }
  });
});
