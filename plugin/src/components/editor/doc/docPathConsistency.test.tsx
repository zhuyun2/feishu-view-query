/**
 * 「两条渲染路径不得分叉」一致性守卫（M3-T08，team-lead 指定）。
 *
 * 背景：编辑器画布 `DocCanvas`（可编辑的线性区块流）**没有**内嵌 `DocPreview`（已排版的
 * 绝对定位 + 纸页虚拟化，无法叠加投放槽 / 逐块选中）。二者改为**共用同一套底层原语**：
 * 同一个 `BlockRenderer`、同一套纸页几何（`constants/paper.ts` 的 `getPaperSizePx()` /
 * `getContentBox()`）、同一份 `PageSetup` / `DocTheme`。
 *
 * ⚠️ 这种「共用」一旦被人改坏（某一侧偷偷硬编码宽度、或改了纸页几何而不同步另一侧），
 * **不会有任何测试变红** —— 编辑器中排好的换行位置会与「详情里分页后看到的」静默分叉。
 * 本文件就是这道防线，共三条守卫：
 *
 *  守卫 1（运行时同值）：**内容宽度必须等于 `getContentBox().width`**
 *    —— `DocCanvas` 的 `[data-content-width]` 与 `DocPaper` 的 `[data-content-box]` 宽度，
 *    对**同一份 `PageSetup`** 必须**恒等于** `getContentBox(paper, orientation, margin).width`。
 *
 *  守卫 2（同源 + 无硬编码）：**两条路径共用同一几何来源**
 *    —— 二者的源码都必须 `from '@/constants/paper'`、都必须调用 `getContentBox(` /
 *    `getPaperSizePx(`，且**都不含**纸张像素硬编码（`794/1123/559/816/1056`）。
 *    谁把尺寸写死（例如 `width: 794`），此断言立刻变红。
 *
 *  守卫 3（交叉引用注释锁）：**两处交叉引用注释必须同时存在**
 *    —— `DocCanvas` 与 `DocPaper` 各有一行「本处几何须与另一侧保持一致」的注释；
 *    任一侧被删（通常是「顺手重构」时），此断言变红，提醒同步另一侧。
 *
 * 变异验证（本文件已实测，见交付报告）：
 *  - M6：把 `DocCanvas` 的 `getContentBox(...)` 换成硬编码 `{ width: 700 }`
 *        → 守卫 1（运行时）与守卫 2（源码无硬编码）**双红**。
 *  - M7：删掉 `DocPaper` 里那行交叉引用注释 → 守卫 3 **红**。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import type { DocTemplate, PageSetup } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { defaultDocTemplate, defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { getContentBox } from '@/constants/paper';
import { DocPaper } from '@/components/doc/DocPaper';
import { DocCanvas } from './DocCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

/** 至少覆盖「纵向 / 横向 / 非 A4 / 非对称边距」——硬编码任何单一尺寸都跑不过 */
const PAGE_CASES: ReadonlyArray<{ name: string; setup: PageSetup }> = [
  { name: 'A4 · 纵向 · 默认边距', setup: defaultPageSetup() },
  {
    name: 'A4 · 横向 · 非对称边距',
    setup: {
      ...defaultPageSetup(),
      orientation: 'landscape',
      margin: { top: 40, right: 56, bottom: 40, left: 72 },
    },
  },
  { name: 'Letter · 纵向', setup: { ...defaultPageSetup(), paper: 'Letter' } },
];

/** 挂载任意节点（jsdom）；返回容器与卸载函数 */
function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 读 `DocCanvas` 自报的内容宽度（`[data-content-width]`） */
function canvasContentWidth(container: HTMLElement): number {
  const paper = container.querySelector<HTMLElement>('[data-content-width]');
  if (!paper) throw new Error('DocCanvas 未渲染纸页几何（缺 [data-content-width]）');
  const raw = paper.getAttribute('data-content-width');
  if (raw === null) throw new Error('DocCanvas 的 [data-content-width] 为空');
  return Number(raw);
}

/** 读 `DocPaper` 内容盒的实际宽度（`[data-content-box]` 的 style.width） */
function paperContentWidth(container: HTMLElement): number {
  const body = container.querySelector<HTMLElement>('[data-content-box="true"]');
  if (!body) throw new Error('DocPaper 未渲染内容盒（缺 [data-content-box]）');
  return Number.parseFloat(body.style.width);
}

/** 挂载 `DocCanvas`（需 dnd-kit 上下文承载 useDraggable/useDroppable） */
function mountCanvas(template: DocTemplate): { container: HTMLElement; unmount: () => void } {
  return mount(createElement(DndContext, null, createElement(DocCanvas, { template, fields: FIELDS })));
}

/** 挂载 `DocPaper`（空 items：只验纸页几何，不牵扯分页产物） */
function mountPaper(setup: PageSetup): { container: HTMLElement; unmount: () => void } {
  return mount(
    createElement(DocPaper, {
      pageIndex: 0,
      totalPages: 1,
      items: [],
      pageSetup: setup,
      theme: defaultDocTheme(),
      blocksById: {},
      record: null,
      fieldsById: {},
      locale: 'zh-CN',
      showHeaderFooter: false,
    }),
  );
}

/* ============================== 守卫 1：运行时同值 ============================== */

describe('守卫 1 · 内容宽度恒等于 getContentBox().width（两条路径同值）', () => {
  for (const { name, setup } of PAGE_CASES) {
    it(`${name}：DocCanvas 内容宽度 === getContentBox().width`, () => {
      const expected = getContentBox(setup.paper, setup.orientation, setup.margin).width;
      const { container, unmount } = mountCanvas({ ...defaultDocTemplate(FIELDS), pageSetup: setup });
      // 变异验证：DocCanvas 改硬编码 { width: 700 } → 此断言立刻变红
      expect(canvasContentWidth(container)).toBe(expected);
      unmount();
    });

    it(`${name}：DocPaper 内容盒宽度 === getContentBox().width`, () => {
      const expected = getContentBox(setup.paper, setup.orientation, setup.margin).width;
      const { container, unmount } = mountPaper(setup);
      expect(paperContentWidth(container)).toBe(expected);
      unmount();
    });

    it(`${name}：两条路径宽度严格相等（同一 getContentBox 来源）`, () => {
      const canvas = mountCanvas({ ...defaultDocTemplate(FIELDS), pageSetup: setup });
      const paper = mountPaper(setup);
      const w1 = canvasContentWidth(canvas.container);
      const w2 = paperContentWidth(paper.container);
      expect(w1).toBe(w2);
      expect(w1).toBe(getContentBox(setup.paper, setup.orientation, setup.margin).width);
      // 正向信号：横向/非 A4 的宽度**不等于** A4 纵向默认宽度（否则等于没换纸）
      if (setup.orientation === 'landscape' || setup.paper !== 'A4') {
        expect(w1).not.toBe(getContentBox('A4', 'portrait', defaultPageSetup().margin).width);
      }
      canvas.unmount();
      paper.unmount();
    });
  }
});

/* ===================== 守卫 2：同一几何来源 + 不得硬编码尺寸 ===================== */

describe('守卫 2 · 两条路径共用同一几何来源（constants/paper.ts），且无硬编码纸尺寸', () => {
  const read = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');
  const CANVAS_SRC = 'src/components/editor/doc/DocCanvas.tsx';
  const PAPER_SRC = 'src/components/doc/DocPaper.tsx';

  /** 纸张像素硬编码：A4 794/1123 · A5 559/794 · Letter 816/1056 */
  const HARDCODED_PAPER_PX = /\b(794|1123|559|816|1056)\b/;

  it('两侧都从 @/constants/paper 取几何，且都调用 getContentBox / getPaperSizePx', () => {
    for (const src of [CANVAS_SRC, PAPER_SRC]) {
      const text = read(src);
      expect(text).toMatch(/from '@\/constants\/paper'/);
      expect(text).toContain('getContentBox(');
      expect(text).toContain('getPaperSizePx(');
    }
  });

  it('两侧均无硬编码纸张像素尺寸（谁写死谁红）', () => {
    for (const src of [CANVAS_SRC, PAPER_SRC]) {
      expect(read(src)).not.toMatch(HARDCODED_PAPER_PX);
    }
  });
});

/* ========================= 守卫 3：两处交叉引用注释必须都在 ========================= */

describe('守卫 3 · DocCanvas 与 DocPaper 各有一行「几何须与另一侧保持一致」的交叉引用注释', () => {
  const read = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

  it('DocCanvas 注释指向 DocPaper', () => {
    const text = read('src/components/editor/doc/DocCanvas.tsx');
    expect(text).toContain('本处几何须与 DocPaper 保持一致');
    expect(text).toContain('docPathConsistency.test.tsx');
  });

  it('DocPaper 注释指向 DocCanvas', () => {
    const text = read('src/components/doc/DocPaper.tsx');
    // 变异验证：删掉 DocPaper 这行注释 → 此断言立刻变红
    expect(text).toContain('本处几何须与编辑器画布 DocCanvas 保持一致');
    expect(text).toContain('docPathConsistency.test.tsx');
  });
});
