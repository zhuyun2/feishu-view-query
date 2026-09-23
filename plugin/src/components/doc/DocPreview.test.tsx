/**
 * T06 · `DocPreview` 单测（2026-09-21 设计变更：详情改为「**单张连续长页**」后更新）。
 *
 * ⭐ 本文件随设计变更同步更新的断言（旧行为已按用户拍板移除）：
 *  - **纸页虚拟化**（只渲染当前页 ±buffer、其余等高占位）→ 移除；改为断言**恒只渲染 1 张纸页**；
 *  - **分页状态**（`paginating` / `paginationFailed` / `degraded` 提示）→ 移除；仅保留空态；
 *  - **页码导航**（`data-page-nav` / 指示器 / `onPageChange`）→ 移除；改为断言**完全不渲染导航**。
 *
 * 保留：`visiblePageRange` / `isPageRendered`（**遗留纯函数**，仍在导出面内，锁其行为不变）、
 * 缩放 / 打印态、`fitToWidth` 实测宽度反推缩放。
 *
 * 断言原则：负断言必须配**正面锚点**（先证 paper 已渲染，再证没有导航），避免「目标消失 → 恒真」。
 * 交互类断言用 `createRoot + act`（沿用本仓 `drawer.qa2.test.tsx` 的做法）。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocTheme } from '@/config/types';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { resolveBlocks } from '@/doc/resolve';
import type { ResolvedBlock } from '@/doc/resolve';
import type { PagedDocument, PagedItem } from '@/pagination/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocPreview, PAGE_VIRTUAL_BUFFER, isPageRendered, visiblePageRange } from './DocPreview';
import type { DocPreviewProps } from './DocPreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THEME: DocTheme = defaultDocTheme();

const FIELD_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f_title: FIELD_TITLE };
const RECORD = { recordId: 'rec_1', fields: { f_title: '张三' } } as unknown as SdkRecord;

const RESOLVED: ResolvedBlock[] = resolveBlocks({
  blocks: [
    { blockId: 'blk_h', kind: 'heading', breakInside: 'avoid', level: 1, source: { type: 'static', text: '标题' }, hideWhenEmpty: false },
  ],
  record: RECORD,
  fields: [FIELD_TITLE],
});
const BLOCKS_BY_ID: Record<string, ResolvedBlock> = Object.fromEntries(RESOLVED.map((block) => [block.blockId, block]));

function makePagedDoc(totalPages: number, degraded = false): PagedDocument {
  const pages = Array.from({ length: totalPages }, (_unused, index) => ({
    pageIndex: index,
    items: [{ blockId: 'blk_h', fragmentIndex: 0, fragmentsTotal: 1, height: 30 } satisfies PagedItem],
    usedHeight: 30,
  }));
  return { pages, totalPages, fontReady: true, degraded };
}

/** 单页长页：正常形态是 `totalPages = 1`、`pages[0].items` = 全部区块 */
function singlePageDoc(): PagedDocument {
  return makePagedDoc(1);
}

function baseProps(overrides: Partial<DocPreviewProps> = {}): DocPreviewProps {
  return {
    pagedDoc: singlePageDoc(),
    pageSetup: defaultPageSetup(),
    theme: THEME,
    zoom: 1,
    fitToWidth: false,
    currentPage: 0,
    onPageChange: () => undefined,
    showBoundary: false,
    blocksById: BLOCKS_BY_ID,
    record: RECORD,
    fieldsById: FIELDS_BY_ID,
    locale: 'zh-CN',
    ...overrides,
  };
}

function renderToDom(props: DocPreviewProps): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(DocPreview, props));
  return host;
}

/** 已挂载根登记表：无论断言是否抛错，用例后强制卸载 + 还原被 mock 的原型属性 */
const mountedRoots: Array<() => void> = [];
afterEach(() => {
  while (mountedRoots.length > 0) mountedRoots.pop()?.();
});

function mount(props: DocPreviewProps): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(DocPreview, props));
  });
  mountedRoots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container };
}

function renderedPageIndices(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.cbv-paper[data-page-index]')).map(
    (paper) => paper.dataset.pageIndex ?? '',
  );
}

/* ===================== 遗留纯函数（仍导出，锁定其行为） ===================== */

describe('visiblePageRange（遗留纯函数）', () => {
  it('currentPage ± buffer 并钳制到 [0, total-1]', () => {
    expect(PAGE_VIRTUAL_BUFFER).toBe(2);
    expect(visiblePageRange(10, 20)).toEqual({ from: 8, to: 12 });
    expect(visiblePageRange(0, 20)).toEqual({ from: 0, to: 2 });
    expect(visiblePageRange(19, 20)).toEqual({ from: 17, to: 19 });
    expect(visiblePageRange(5, 3)).toEqual({ from: 0, to: 2 }); // current 超界 → 钳到 2
  });

  it('空文档 → {from:0,to:-1}（无页可渲染）', () => {
    expect(visiblePageRange(0, 0)).toEqual({ from: 0, to: -1 });
  });

  it('isPageRendered 与区间一致', () => {
    const range = visiblePageRange(10, 20);
    expect(isPageRendered(8, range)).toBe(true);
    expect(isPageRendered(12, range)).toBe(true);
    expect(isPageRendered(7, range)).toBe(false);
    expect(isPageRendered(13, range)).toBe(false);
  });
});

/* ===================== 单张连续长页：恒一张纸页 ===================== */

describe('DocPreview · 单张连续长页', () => {
  it('恒只渲染 1 张纸页（即便 pagedDoc 声明 20 页）；无占位节点', () => {
    // 旧实现：currentPage=10 → 渲染 8/9/10/11/12 共 5 张 + 15 个等高占位
    const host = renderToDom(baseProps({ pagedDoc: makePagedDoc(20), currentPage: 10 }));
    expect(renderedPageIndices(host)).toEqual(['0']);
    expect(host.querySelectorAll('.cbv-paper').length).toBe(1);
    // 正面锚点：纸页内确实有区块（不是空壳）
    expect(host.querySelectorAll('.cbv-paper [data-block-id="blk_h"]').length).toBe(1);
    // 占位节点已随虚拟化移除
    expect(host.querySelectorAll('[data-placeholder="true"]').length).toBe(0);
  });

  it('paper 只有一个直接子节点（内容盒）；无边界虚线（showBoundary 惰性）', () => {
    const host = renderToDom(baseProps({ showBoundary: true }));
    const paper = host.querySelector<HTMLElement>('.cbv-paper');
    expect(paper).not.toBeNull();
    expect(paper?.children.length).toBe(1);
    expect(paper?.children[0]?.classList.contains('cbv-paper__body')).toBe(true);
    expect(host.querySelectorAll('.cbv-paper__boundary').length).toBe(0);
  });

  it('外层视口是唯一滚动容器：viewport overflow:auto，纸页自身不滚动', () => {
    const host = renderToDom(baseProps());
    const viewport = host.querySelector<HTMLElement>('[data-testid="doc-preview-viewport"]');
    const paper = host.querySelector<HTMLElement>('.cbv-paper');
    expect(viewport).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(viewport?.style.overflow).toBe('auto');
    expect(paper?.style.overflow).toBe('');
    expect(paper?.style.overflowY).toBe('');
  });

  it('不渲染页码导航：无 PageNavigator / data-page-nav / 指示器', () => {
    const host = renderToDom(baseProps());
    // 正面锚点：预览根与纸页确实渲染
    expect(host.querySelector('[data-testid="doc-preview"]')).not.toBeNull();
    expect(host.querySelector('.cbv-paper')).not.toBeNull();
    // 移除项
    expect(host.querySelector('[data-testid="page-navigator"]')).toBeNull();
    expect(host.querySelectorAll('[data-page-nav]').length).toBe(0);
    expect(host.querySelectorAll('.cbv-page-nav').length).toBe(0);
    expect(host.querySelector('[data-page-indicator="true"]')).toBeNull();
  });
});

/* ===================== 缩放 / 打印 ===================== */

describe('DocPreview · 缩放与打印态', () => {
  it('非适应宽度时 data-zoom = 传入 zoom，画布 transform = scale(zoom)', () => {
    const host = renderToDom(baseProps({ zoom: 1.25, fitToWidth: false }));
    const root = host.querySelector<HTMLElement>('[data-testid="doc-preview"]');
    const canvas = host.querySelector<HTMLElement>('[data-testid="doc-preview-canvas"]');

    expect(root?.dataset.zoom).toBe('1.25');
    expect(canvas?.style.transform).toBe('scale(1.25)');
  });

  it('printing=true → 强制 zoom=1（打印不受屏幕缩放影响）', () => {
    const host = renderToDom(baseProps({ zoom: 1.25, printing: true }));
    expect(host.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.zoom).toBe('1');
    expect(host.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.printing).toBe('true');
  });

  it('fitToWidth：实测宽度 → 反推缩放并钳制到 [0.75, 1.5]', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    let width = 818;
    class StubResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback();
      }
      disconnect(): void {
        /* noop */
      }
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;

    try {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });

      // 可用宽度 818 → (818-24)/794 = 1
      const wide = mount(baseProps({ fitToWidth: true, zoom: 0.5 }));
      expect(wide.container.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.zoom).toBe('1');

      // 可用宽度 100 → (100-24)/794 ≈ 0.0957 → 钳到下限 0.75
      width = 100;
      const narrow = mount(baseProps({ fitToWidth: true, zoom: 0.5 }));
      expect(narrow.container.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.zoom).toBe('0.75');
    } finally {
      if (originalDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalDescriptor);
      else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
    }
  });
});

/* ===================== 状态：仅保留空态 ===================== */

describe('DocPreview · 状态', () => {
  it('空文档（totalPages=0）→ 空态提示；且不渲染纸页', () => {
    const host = renderToDom(baseProps({ pagedDoc: makePagedDoc(0), currentPage: 0 }));
    expect(host.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(host.querySelectorAll('.cbv-paper').length).toBe(0);
  });

  it('paginating / paginationFailed / degraded 不再产生任何状态提示（分页概念已移除）', () => {
    const host = renderToDom(
      baseProps({ paginating: true, paginationFailed: true, pagedDoc: makePagedDoc(1, true) }),
    );
    // 正面锚点：纸页照常渲染
    expect(host.querySelector('.cbv-paper')).not.toBeNull();
    // 移除项
    expect(host.querySelector('[data-state="paginating"]')).toBeNull();
    expect(host.querySelector('[data-state="degraded"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.degraded).toBeUndefined();
  });

  it('非空文档不出现空态提示', () => {
    const host = renderToDom(baseProps());
    expect(host.querySelector('[data-state="empty"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-testid="doc-preview"]')?.dataset.totalPages).toBe('1');
  });
});
