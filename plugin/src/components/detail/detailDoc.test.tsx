/**
 * 详情抽屉 × 文档预览 集成测试（T07；2026-09-21 设计变更：详情改为「**单张连续长页**」后更新）。
 *
 * 断言取向（判据：把实现改坏，这条断言会红吗？）：
 *  - **具体结构**：抽屉内出现**恰好 1 张** `.cbv-paper`、`data-total-pages = 1`、**无页码导航**，
 *    且区块按 `blockId` 顺序摆放；
 *  - **字段值出口**：正文里的字段值只经 `<DocFieldValue/>`（渲染出 `.cbv-doc-field`），
 *    且源码级断言 `DetailDrawer` 不再直调字段渲染注册表；
 *  - **⭐ 过期响应不覆盖新记录**：连续切换两条记录（旧链路更晚完成），最终渲染的必须是**后一条**；
 *  - **既有行为回归**：`Esc` 两级 / 焦点归位 / 适应宽度 / 860px（R2）。
 *
 * ⭐ 本文件随设计变更同步更新的断言：
 *  - 结构断言：旧 `data-total-pages = 4` + 页码导航 → 改为 `= 1` + 无导航；
 *  - 过期响应断言：旧判据是**页数**（4 vs 8）——单页化后页数恒为 1，不再有判别力 →
 *    改为**区块集合判别**：让 rA 比 rB 多解析出 1 个区块（绑定 f2 且 `hideWhenEmpty`），
 *    过期链路若覆盖成功，页面会出现 `[data-block-missing]`（见 `varyingTemplate` 注释）。
 *
 * 确定性来源：注入可控 `awaitFonts`（stub 测量/离屏渲染已惰性，真实 DOM 测量在 jsdom 下恒为 0）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Measurer } from '@/pagination/types';
import type { DocTemplate, ParagraphBlock } from '@/config/types';
import type { UsePagedDocumentDeps } from '@/hooks/usePagedDocument';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { DetailDrawer } from './DetailDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 夹具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

const CONFIG = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });

/**
 * 记录相关模板：8 个区块绑定 f1（**两条记录都有值**）+ 1 个绑定 f2 且 `hideWhenEmpty` 的区块。
 *
 * ⭐ 为什么这样造：单页化后「页数」不再能区分两条链路（恒为 1），需要**区块集合**来区分：
 *  - rA（`fields.f2 = 100`）→ 解析出 **9** 块（f2 块可见）；
 *  - rB（**无 f2**）→ 解析出 **8** 块（f2 块被 `hideWhenEmpty` 隐藏）。
 * 过期链路 A 的 9 个 item 落在新记录 B 的 `blocksById`（8 块）上会命中「缺失区块」分支 →
 * 若过期守卫失效，页面会渲染出 `[data-block-missing="true"]`（断言据此判红）。
 */
function varyingTemplate(count = 8): DocTemplate {
  const base = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;
  const blocks: ParagraphBlock[] = Array.from({ length: count }, (_, index) => ({
    blockId: `blk_para_${index}`,
    kind: 'paragraph',
    breakInside: 'avoid',
    fieldId: 'f1',
    preserveLineBreaks: false,
    hideWhenEmpty: false,
  }));
  blocks.push({
    blockId: 'blk_para_f2',
    kind: 'paragraph',
    breakInside: 'avoid',
    fieldId: 'f2',
    preserveLineBreaks: false,
    hideWhenEmpty: true, // rB 无 f2 → 该块被隐藏（仅 rA 产出）
  });
  return { ...base, templateId: 't07-varying', blocks };
}

function seedView(config: typeof CONFIG = CONFIG): void {
  useViewStore.setState({
    config,
    fields: FIELDS,
    fieldsById: { f1: FIELDS[0], f2: FIELDS[1] },
    records: [
      { recordId: 'rA', fields: { f1: '张伟', f2: 100 } } as never,
      { recordId: 'rB', fields: { f1: '李四' } } as never, // ⭐ 无 f2（用于区块集合判别）
    ],
    env: { language: 'zh-CN' } as never,
  });
}

/** 忽略宿主的确定性 measurer：所有区块同高 → 页数可精确预期 */
function flatMeasurer(height: number): Measurer {
  return {
    measureBlocks: (_host, blocks) =>
      blocks.map((block) => ({ blockId: block.blockId, kind: block.kind, outerHeight: height })),
  };
}

/** 默认注入依赖：stub 测量 + no-op 离屏渲染 + 立即就绪的字体 */
function stubDeps(height: number, overrides: Partial<UsePagedDocumentDeps> = {}): UsePagedDocumentDeps {
  return {
    measurer: flatMeasurer(height),
    renderHost: () => () => undefined,
    awaitFonts: () => Promise.resolve(true),
    ...overrides,
  };
}

/* ============================ 挂载工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
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

/** 冲净微任务（让 awaitFonts 之后的同步链路跑完并落 state / 重渲染） */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 临时把 HTMLElement.clientWidth 固定为给定值（jsdom 无布局引擎） */
async function withClientWidth(width: number, fn: () => Promise<void>): Promise<void> {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
  try {
    await fn();
  } finally {
    if (previous) Object.defineProperty(proto, 'clientWidth', previous);
    else delete proto.clientWidth;
  }
}

function open(opts: Partial<ReturnType<typeof initialDrawerState>> = {}): void {
  useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA', ...opts } });
}

beforeEach(() => {
  seedView();
  useUiStore.setState({ drawer: initialDrawerState(null) });
});

/* ============================ 用例 ============================ */

describe('T07 · 详情抽屉接入文档预览（结构）', () => {
  it('正文为**单张连续长页**：恰好 1 个 .cbv-paper、data-total-pages=1、无页码导航（非字段清单）', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();

    const preview = container.querySelector('[data-testid="doc-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('data-total-pages')).toBe('1'); // ⭐ 单页（旧实现为 4）
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1);

    // 页码导航已随分页移除
    expect(container.querySelector('[data-testid="page-navigator"]')).toBeNull();
    expect(container.querySelectorAll('[data-page-nav]').length).toBe(0);

    // M2 过渡实现（简易字段清单）已不存在
    expect(container.querySelector('.cbv-doc-list')).toBeNull();
    unmount();
  });

  it('纸页内区块按 blockId 顺序摆放（= 模板区块顺序）', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();

    const expected = CONFIG.detail.doc.blocks.map((block) => block.blockId);
    const rendered = Array.from(container.querySelectorAll('[data-page-index="0"] [data-block-id]')).map((el) =>
      el.getAttribute('data-block-id'),
    );
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toEqual(expected.slice(0, rendered.length));
    unmount();
  });

  it('字段值只经 DocFieldValue：正文出现 .cbv-doc-field；且源码不再直调字段渲染注册表', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    expect(container.querySelectorAll('.cbv-doc-field').length).toBeGreaterThan(0);
    unmount();

    const source = readFileSync(path.resolve(process.cwd(), 'src/components/detail/DetailDrawer.tsx'), 'utf8');
    // ① 负断言（**缺失**）：对**原始源码**断言（更保守 —— 注释里出现也算不合格，绝不放过）
    expect(source).not.toContain('renderDoc');
    expect(source).not.toMatch(/fields\/registry/);
    // ② 正断言（**存在**）：先**剔除注释**再匹配结构特征（import 语句 + JSX 属性）。
    //    否则「文件头注释里提到 DocPreview / <DocPreview/>」会偶然满足断言（裸词匹配事故）。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/import\s*\{[^}]*\bDocPreview\b[^}]*\}\s*from\s*'@\/components\/doc\/DocPreview'/);
    expect(code).toMatch(/<DocPreview\s+pagedDoc=\{paged\.pagedDoc\}/);
    // 反向哨兵：确保断言不是因「读到的源码为空/被清空」而恒真
    expect(source).toContain('DetailDrawer');
  });

  it('记录不存在 → 显示占位文案，且不渲染纸页（不崩）', async () => {
    open({ recordId: 'missing' });
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    expect(container.innerHTML).toContain('记录不存在');
    expect(container.querySelector('.cbv-paper')).toBeNull();
    unmount();
  });
});

describe('T07 · 详情抽屉既有行为回归（M2 不破）', () => {
  it('R2 冻结值：默认宽 860px、页脚提示 560px ~ 满宽 / 75%~150%', async () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    const html = container.innerHTML;
    expect(html).toMatch(/width:\s*860px/);
    expect(html).toContain('560px ~ 满宽');
    expect(html).toContain('75%~150%');
    unmount();
  });

  it('Esc 两级：全屏 → 先退全屏（抽屉仍开），再按一次才关闭', async () => {
    open({ fullscreen: true });
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
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
    const trigger = document.createElement('button');
    trigger.textContent = '打开详情';
    document.body.appendChild(trigger);
    trigger.focus();

    open();
    const { unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();

    act(() => {
      useUiStore.getState().closeDrawer();
    });
    expect(document.activeElement).toBe(trigger);

    unmount();
    trigger.remove();
  });

  it('适应宽度：ResizeObserver 实测宽度驱动缩放，且「适应宽度」保持按下（不被 setDrawerZoom 关掉）', async () => {
    await withClientWidth(1200, async () => {
      open(); // fitToWidth 默认 true（R5）
      const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
      await flush();

      expect(useUiStore.getState().drawer.zoom).toBeCloseTo(1.5, 5); // 1200 / 794 → 钳制 1.5
      expect(useUiStore.getState().drawer.fitToWidth).toBe(true);
      const preview = container.querySelector('[data-testid="doc-preview"]');
      expect(preview?.getAttribute('data-fit-to-width')).toBe('true');
      unmount();
    });
  });
});

describe('T07 · ⭐ 过期响应不得覆盖新记录（抽屉级）', () => {
  it('切换记录：旧链路更晚完成，最终渲染的仍是后一条（区块集合 / 内容）', async () => {
    const resolvers: Array<(ready: boolean) => void> = [];
    const awaitFonts = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      });
    // 单页化后 measurer 已惰性；此处只注入可控 awaitFonts，让两条链路挂在同一点上交错完成
    const shared: UsePagedDocumentDeps = { awaitFonts };

    // 每块都随记录变；额外让 rA 比 rB 多 1 块 → 过期链路若覆盖成功会出现「缺失区块」
    seedView({ ...CONFIG, detail: { ...CONFIG.detail, doc: varyingTemplate() } });
    open({ recordId: 'rA' });
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: shared }));
    expect(resolvers.length).toBe(1); // A 链路挂在字体等待

    // 切到 B（旧链路被作废）
    act(() => {
      useUiStore.setState((state) => ({ drawer: { ...state.drawer, recordId: 'rB' } }));
    });
    expect(resolvers.length).toBe(2);

    // B 先完成：rB 解析出 8 块 → 单页、8 个区块
    await act(async () => {
      resolvers[1](true);
    });
    await flush(2);
    expect(container.textContent).toContain('李四');
    const renderedAfterB = container.querySelectorAll('[data-page-index="0"] [data-block-id]').length;
    expect(renderedAfterB).toBe(8);
    expect(container.querySelectorAll('[data-block-missing="true"]').length).toBe(0);

    // A 后完成（过期）：rA 有 9 块；守卫失效 → items 会被换成 A 的 9 块，
    // 其中 `blk_para_f2` 不在 B 的 blocksById 中 → 渲染出「缺失区块」占位（断言据此判红）
    await act(async () => {
      resolvers[0](true);
    });
    await flush(2);
    expect(container.querySelectorAll('[data-page-index="0"] [data-block-id]').length).toBe(8);
    expect(container.querySelectorAll('[data-block-missing="true"]').length).toBe(0);
    expect(container.textContent).toContain('李四');
    unmount();
  });
});
