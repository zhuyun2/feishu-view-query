/**
 * QA2 独立验证（任务 #13/#15）· T12：详情抽屉容器 + 悬浮预览意图。
 *
 * 断言来源：
 *  - `04 §11 R2` / 口径 #3：抽屉默认 **860px**、可拖 **560 ~ 满宽**、`Esc` **两级**（退全屏→关抽屉）、
 *    焦点归位（a11y）。
 *  - `04 §11 R5`：默认「适应宽度」；**缩放下限 0.75**（computeFitZoom 钳制 [0.75,1.5]）。
 *  - `04 §5.2/§3.7`：Hover ≥ **150ms** 触发气泡。
 *
 * ⭐ 设计变更（2026-09-21，用户拍板）：详情从「A4 分页预览」改为「**单张连续长页**」。
 *   本文件相应改断（旧断言的语义随形态变化而改写，不弱化）：
 *   ① 过期响应守卫 → **正文内容**级判别（页数已恒为 1，不再有判别力）；
 *   ② 字体迟到自愈 → **编排重算计数**（`awaitFonts` 再次被调用），而非页数；
 *   ③ 测量器失败 → 新形态下**不再阻断渲染**（无「降级」概念，正文照常完整渲染）。
 * 断言来源不得来自实现现状。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetailDrawer } from './DetailDrawer';
import {
  clampDrawerWidth,
  computeBubblePlacement,
  computeFitZoom,
  resolveEscStage,
} from './drawerMath';
import { HoverIntentController, HOVER_HIDE_GRACE_MS, HOVER_INTENT_DELAY_MS } from './hoverIntent';
import {
  DRAWER_MIN_WIDTH_PX,
  DRAWER_ZOOM_MAX,
  DRAWER_ZOOM_MIN,
  initialDrawerState,
  useUiStore,
} from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { createDefaultConfig } from '@/config/defaults';
import { getContentBox } from '@/constants/paper';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import type { Measurer } from '@/pagination/types';
import type { DocTemplate, PageSetup, ParagraphBlock } from '@/config/types';
import { awaitDocumentFonts, type UsePagedDocumentDeps } from '@/hooks/usePagedDocument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 纯几何 ============================ */

describe('T12 · drawerMath 纯几何（R2 / R5）', () => {
  it('clampDrawerWidth：钳制到 [560, 视口宽]', () => {
    expect(clampDrawerWidth(100, 1280)).toBe(DRAWER_MIN_WIDTH_PX);
    expect(clampDrawerWidth(5000, 1280)).toBe(1280);
    expect(clampDrawerWidth(860, 1280)).toBe(860);
    expect(clampDrawerWidth(Number.NaN, 1280)).toBe(860);
    // 视口窄于下限时，保留下限（优先保证正文可读，宁可横向溢出）——实现取舍，非缺陷
    expect(clampDrawerWidth(100, 400)).toBe(DRAWER_MIN_WIDTH_PX);
  });

  it('computeFitZoom：钳制到 [0.75, 1.5]，非法输入 → 1', () => {
    expect(computeFitZoom(794, 794)).toBe(1);
    expect(computeFitZoom(200, 794)).toBe(DRAWER_ZOOM_MIN); // 0.25 → 0.75
    expect(computeFitZoom(100000, 794)).toBe(DRAWER_ZOOM_MAX); // → 1.5
    expect(computeFitZoom(0, 794)).toBe(1);
    expect(computeFitZoom(Number.NaN, 794)).toBe(1);
  });

  it('resolveEscStage：全屏 → 退全屏；否则 → 关闭（两级）', () => {
    expect(resolveEscStage(true)).toBe('exit-fullscreen');
    expect(resolveEscStage(false)).toBe('close');
  });

  it('computeBubblePlacement：右缘放不下 → 翻到左侧', () => {
    const right = computeBubblePlacement({
      anchor: { x: 100, y: 100, width: 200, height: 100 },
      bubbleWidth: 280,
      bubbleHeight: 180,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(right.side).toBe('right');

    const left = computeBubblePlacement({
      anchor: { x: 1150, y: 100, width: 100, height: 100 },
      bubbleWidth: 280,
      bubbleHeight: 180,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(left.side).toBe('left');
    expect(left.left).toBeGreaterThanOrEqual(8);
  });
});

/* ============================ 悬浮意图（150ms / 宽限） ============================ */

interface FakeTimers {
  api: { set: (fn: () => void, ms: number) => number; clear: (h: number) => void };
  pending: () => Array<{ id: number; ms: number }>;
  fire: (id: number) => void;
}

function fakeTimers(): FakeTimers {
  let next = 1;
  const tasks = new Map<number, { fn: () => void; ms: number }>();
  return {
    api: {
      set: (fn, ms) => {
        const id = next;
        next += 1;
        tasks.set(id, { fn, ms });
        return id;
      },
      clear: (id) => {
        tasks.delete(id);
      },
    },
    pending: () => [...tasks.entries()].map(([id, t]) => ({ id, ms: t.ms })),
    fire: (id) => {
      const task = tasks.get(id);
      tasks.delete(id);
      task?.fn();
    },
  };
}

describe('T12 · HoverIntentController（D2：150ms 触发）', () => {
  it('延迟常量符合 04 §5.2（150ms）', () => {
    expect(HOVER_INTENT_DELAY_MS).toBe(150);
    expect(HOVER_HIDE_GRACE_MS).toBeGreaterThan(0);
  });

  it('指针进入 → 150ms 后 onShow；快速划过不触发', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const hidden: string[] = [];
    const controller = new HoverIntentController(
      { onShow: (id) => shown.push(id), onHide: () => hidden.push('hide') },
      HOVER_INTENT_DELAY_MS,
      HOVER_HIDE_GRACE_MS,
      timers.api,
    );

    const anchor = { x: 0, y: 0, width: 100, height: 100 };
    controller.pointerEnter('r1', anchor);
    expect(timers.pending()[0].ms).toBe(150);
    expect(shown).toEqual([]); // 未到时间不弹

    // 快速划过：离开 → 取消 show
    controller.pointerLeave();
    const showTask = timers.pending().find((t) => t.ms === 150);
    expect(showTask).toBeUndefined(); // show 定时器已取消

    controller.pointerEnter('r1', anchor);
    const task = timers.pending().find((t) => t.ms === 150) as { id: number };
    timers.fire(task.id);
    expect(shown).toEqual(['r1']);
    expect(controller.activeId).toBe('r1');
  });

  it('移入气泡不消失；离开约 140ms 后隐藏', () => {
    const timers = fakeTimers();
    const hidden: string[] = [];
    const controller = new HoverIntentController(
      { onShow: () => undefined, onHide: () => hidden.push('hide') },
      150,
      140,
      timers.api,
    );

    controller.pointerEnter('r1', { x: 0, y: 0, width: 10, height: 10 });
    timers.fire(timers.pending()[0].id);
    expect(controller.activeId).toBe('r1');

    controller.pointerLeave();
    controller.bubbleEnter(); // 移入气泡 → 取消隐藏
    expect(timers.pending().length).toBe(0);
    expect(controller.activeId).toBe('r1');

    controller.bubbleLeave();
    const hide = timers.pending()[0];
    expect(hide.ms).toBe(140);
    timers.fire(hide.id);
    expect(hidden).toEqual(['hide']);
    expect(controller.activeId).toBeNull();
  });

  it('hideNow：立即隐藏（打开抽屉 / 滚动离开）', () => {
    const controller = new HoverIntentController({ onShow: () => undefined, onHide: () => undefined });
    controller.hideNow();
    expect(controller.activeId).toBeNull();
  });
});

/* ============================ DetailDrawer 组件 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

function seedView(): void {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
  useViewStore.setState({
    config,
    fields: FIELDS,
    fieldsById: { f1: FIELDS[0], f2: FIELDS[1] },
    records: [{ recordId: 'r1', fields: { f1: '张伟', f2: 100 } } as never],
    env: { language: 'zh-CN' } as never,
  });
}

/** 已挂载根登记表：无论断言是否抛错，每个用例后都强制卸载，避免监听器泄漏到后续用例 */
const mountedRoots: Array<() => void> = [];

afterEach(() => {
  while (mountedRoots.length > 0) mountedRoots.pop()?.();
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
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  mountedRoots.push(unmount);
  return { container, unmount };
}

function open(opts: Partial<ReturnType<typeof initialDrawerState>> = {}): void {
  useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'r1', ...opts } });
}

describe('T12 · DetailDrawer（默认 860 / Esc 两级 / 焦点归位）', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('默认宽度 860px / 页脚提示（R2）；正文渲染文档预览（非 M2 简易字段清单）', () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer));
    const html = container.innerHTML;
    // 客户端渲染的 DOM 由 CSSOM 序列化，内联样式为 'width: 860px;'（含空格）
    expect(html).toMatch(/width:\s*860px/);
    expect(html).toContain('860px');
    expect(html).toContain('560px ~ 满宽');
    expect(html).toContain('75%~150%');
    // T07 实现形态：正文是文档预览容器（回归 M2 简易字段清单 → 两条都变红）
    expect(container.querySelector('[data-testid="doc-preview"]')).not.toBeNull();
    expect(container.querySelector('.cbv-doc-list')).toBeNull();
    unmount();
  });

  it('缩放下限 0.75 / 上限 1.5 由 store 钳制（R5）', () => {
    useUiStore.getState().setDrawerZoom(0.1);
    expect(useUiStore.getState().drawer.zoom).toBe(DRAWER_ZOOM_MIN);
    useUiStore.getState().setDrawerZoom(9);
    expect(useUiStore.getState().drawer.zoom).toBe(DRAWER_ZOOM_MAX);
  });

  it('Esc 两级：非全屏 → 直接关闭', () => {
    open();
    const { unmount } = mount(createElement(DetailDrawer));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUiStore.getState().drawer.open).toBe(false);
    unmount();
  });

  it('Esc 两级：全屏 → 先退全屏（抽屉仍开），再按才关闭', () => {
    open({ fullscreen: true });
    const { container, unmount } = mount(createElement(DetailDrawer));
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

  it('关闭后焦点归位到打开前的元素（a11y）', () => {
    const trigger = document.createElement('button');
    trigger.textContent = '打开详情';
    document.body.appendChild(trigger);
    trigger.focus();

    open();
    const { unmount } = mount(createElement(DetailDrawer));

    act(() => {
      useUiStore.getState().closeDrawer();
    });
    expect(document.activeElement).toBe(trigger);

    unmount();
    trigger.remove();
  });

  it('记录不存在 → 显示占位文案，不崩', () => {
    open({ recordId: 'missing' });
    const { container, unmount } = mount(createElement(DetailDrawer));
    expect(container.innerHTML).toContain('记录不存在');
    unmount();
  });
});

/* ============================ 已切至文档预览实现（M3-T07 · QA 复核对齐 2026-09-21） ============================ */

describe('T12 · 抽屉正文已切至文档预览实现（T07 替换 M2 过渡实现）', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/components/detail/DetailDrawer.tsx'), 'utf8');

  it('源码经 usePagedDocument 编排、渲染 <DocPreview/>（断言「已切到新实现」）', () => {
    // 锚定真实 import / 调用 / JSX，避免被文件头注释里的同名字样「偶然满足」（注释里有 usePagedDocument / <DocPreview/> 字样）
    expect(source).toMatch(/import\s*\{[^}]*\busePagedDocument\b[^}]*\}\s*from\s*'@\/hooks\/usePagedDocument'/);
    expect(source).toContain('usePagedDocument({');
    expect(source).toMatch(/import\s*\{[^}]*\bDocPreview\b[^}]*\}\s*from\s*'@\/components\/doc\/DocPreview'/);
    expect(source).toMatch(/<DocPreview\s+pagedDoc=\{paged\.pagedDoc\}/);
    // 旧过渡实现口径的字样必须消失（若回归 M2 文本 → 红）
    expect(source).not.toContain('过渡实现');
  });

  it('字段值唯一出口：源码不直调字段渲染注册表（renderDoc / fields/registry）', () => {
    // 字段值一律经 <DocFieldValue/>（注册表调用发生在其内部）；本文件若出现直调 → 红
    expect(source).not.toContain('renderDoc');
    expect(source).not.toMatch(/fields\/registry/);
    // 反向哨兵：确保断言不是因为「读到的源文件为空」而恒真
    expect(source).toContain('DetailDrawer');
  });
});

/* ============================ QA 独立复核（T07 · 2026-09-21） ============================ */

/** 冲净微任务（让 awaitFonts 之后的异步链路跑完并落 state / 重渲染） */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * 记录相关模板：前 4 块绑 f1（两记录都非空），后 4 块绑 f2 且 `hideWhenEmpty=true`。
 * 于是两条记录的**区块集合不同**：rB 的 f2 为空 → 后 4 块被 `resolveBlocks` 隐藏。
 *
 * ⚠️ 为什么必须让集合不同（否则是「巧合同容」假绿）：`<DocPaper/>` 是按**实时** `blocksById`
 * 取块渲染的，而同一 template 下 blockId 相同。若两记录的区块 id 集合一致，陈旧产物引用
 * 的 blockId 在新记录里**照样能取到块** → 正文内容恒为新记录，过期响应**内容不可见**。
 * 只有集合不同时，「陈旧产物引用了新记录已不存在的块」才会暴露为「【缺失区块】」占位。
 */
function varyingTemplate(): DocTemplate {
  const base = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;
  const make = (index: number, fieldId: string, hideWhenEmpty: boolean): ParagraphBlock => ({
    blockId: `blk_para_${index}`,
    kind: 'paragraph',
    breakInside: 'avoid',
    fieldId,
    preserveLineBreaks: false,
    hideWhenEmpty,
  });
  const blocks: ParagraphBlock[] = [
    make(0, 'f1', false),
    make(1, 'f1', false),
    make(2, 'f1', false),
    make(3, 'f1', false),
    make(4, 'f2', true),
    make(5, 'f2', true),
    make(6, 'f2', true),
    make(7, 'f2', true),
  ];
  return { ...base, templateId: 't07-qa-varying', blocks };
}

/** 两条记录（rA=张伟/金额 100 → 8 块；rB=李四/金额空 → 仅 4 块）+ 记录相关模板 */
function seedTwoRecords(): void {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
  useViewStore.setState({
    config: { ...config, detail: { ...config.detail, doc: varyingTemplate() } },
    fields: FIELDS,
    fieldsById: { f1: FIELDS[0], f2: FIELDS[1] },
    records: [
      { recordId: 'rA', fields: { f1: '张伟', f2: 100 } } as never,
      { recordId: 'rB', fields: { f1: '李四', f2: null } } as never,
    ],
    env: { language: 'zh-CN' } as never,
  });
}

/** 确定性 stub 依赖：固定高度的 measurer + no-op 离屏渲染 + 立即就绪的字体 */
function stubDeps(height: number, overrides: Partial<UsePagedDocumentDeps> = {}): UsePagedDocumentDeps {
  const measurer: Measurer = {
    measureBlocks: (_host, blocks) =>
      blocks.map((b) => ({ blockId: b.blockId, kind: b.kind, outerHeight: height })),
  };
  return { measurer, renderHost: () => () => undefined, awaitFonts: () => Promise.resolve(true), ...overrides };
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

/** 临时替换 `document.fonts`（jsdom 未实现 FontFaceSet）；结束后还原/移除自有属性 */
async function withFonts(value: unknown, fn: () => Promise<void>): Promise<void> {
  const own = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, writable: true, value });
  try {
    await fn();
  } finally {
    if (own) Object.defineProperty(document, 'fonts', own);
    else Reflect.deleteProperty(document, 'fonts');
  }
}

describe('T07 · QA 独立复核：过期响应守卫（内容级判别）', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('⭐ 旧链路更晚完成时，正文内容保持后一条记录（过期响应被丢弃）', async () => {
    const resolvers: Array<(ready: boolean) => void> = [];
    const awaitFonts = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      });

    seedTwoRecords();
    open({ recordId: 'rA' });
    const { container, unmount } = mount(
      createElement(DetailDrawer, { pagedDeps: { awaitFonts } }),
    );
    expect(resolvers.length).toBe(1); // A 链路挂在字体等待上

    act(() => {
      useUiStore.setState((state) => ({ drawer: { ...state.drawer, recordId: 'rB' } }));
    });
    expect(resolvers.length).toBe(2); // 切到 B：旧链路作废

    await act(async () => {
      resolvers[1](true); // 后链路（B）先完成 → 渲染「李四」
    });
    await flush();
    // 正面锚点：单页文档确实把「后一条」记录渲染了出来（否则下面的「不覆盖」无意义）
    const preview = container.querySelector('[data-testid="doc-preview"]');
    expect(preview).not.toBeNull();
    expect(container.querySelector('[data-content-box="true"]')).not.toBeNull();
    expect(container.textContent).toContain('李四');
    // B 的 f2 为空 → 后 4 块被隐藏，正文不应出现任何缺失占位
    expect(container.querySelectorAll('[data-block-missing="true"]').length).toBe(0);

    await act(async () => {
      resolvers[0](true); // 旧链路（A）更晚完成 → 必须被守卫丢弃
    });
    await flush();
    // ⭐ 关键判别（内容级）：正文仍是「李四」，绝不能被旧记录「张伟」覆盖
    expect(container.textContent).toContain('李四');
    expect(container.textContent).not.toContain('张伟');
    // ⭐ 真正的判别量：陈旧产物（A 的 8 块）若覆盖 B，其引用的后 4 块在 B 已不存在 →
    //    `<DocPaper/>` 按实时 blocksById 取不到 → 渲染「【缺失区块】」占位。守卫有效则恒无。
    expect(container.querySelectorAll('[data-block-missing="true"]').length).toBe(0);
    expect(container.textContent).not.toContain('缺失区块');
    unmount();
  });
});

describe('T07 · QA 独立复核：字体未就绪（拒绝 / 迟到自愈）', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('awaitDocumentFonts：ready 拒绝 → 返回 false（绝不挂起）', async () => {
    await withFonts({ ready: Promise.reject(new Error('font-load-failed')) }, async () => {
      await expect(awaitDocumentFonts(50)).resolves.toBe(false);
    });
  });

  it('字体迟到就绪 → 自愈重算一次（可观测量：编排链路重跑、awaitFonts 再次被调用）', async () => {
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    await withFonts({ ready }, async () => {
      let calls = 0;
      const awaitFonts = (): Promise<boolean> => {
        calls += 1;
        return Promise.resolve(calls !== 1); // 首次未就绪，其后就绪
      };

      open();
      const { container, unmount } = mount(
        createElement(DetailDrawer, { pagedDeps: { awaitFonts } }),
      );
      await flush();
      expect(calls).toBe(1); // 首跑卡在「字体未就绪」，未再重算

      await act(async () => {
        resolveReady(); // fonts.ready 迟到就绪 → setFontEpoch → 自愈重算
      });
      await flush();
      // ⭐ 可观测量：单页长页下页数恒为 1（不可用），改断「编排**确实重算了一次**」——awaitFonts 再次被调用
      expect(calls).toBe(2);
      // 正面锚点：重算后文档仍完整渲染（不是空白 / 空态）
      expect(container.querySelector('[data-testid="doc-preview"]')).not.toBeNull();
      expect(container.querySelector('[data-content-box="true"]')).not.toBeNull();
      unmount();
    });
  });
});

describe('T07 · QA 独立复核：适应宽度与手动缩放互不干扰', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('手动缩放后（fitToWidth=false）「适应宽度」不再改写 zoom', async () => {
    await withClientWidth(1200, async () => {
      useUiStore.setState({
        drawer: { ...initialDrawerState(null), open: true, recordId: 'r1', fitToWidth: false, zoom: 1 },
      });
      const { unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
      await flush();
      expect(useUiStore.getState().drawer.zoom).toBe(1); // 未被 fit 覆盖（1200/794 → 1.5）
      expect(useUiStore.getState().drawer.fitToWidth).toBe(false);
      unmount();
    });
  });
});

describe('T07 · QA 独立复核：新形态下测量器不可用不再阻断渲染', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('⭐ 测量器抛异常也不再阻断：单页文档仍完整渲染，且不出现降级提示', async () => {
    const throwingMeasurer: Measurer = {
      measureBlocks: () => {
        throw new Error('measure boom');
      },
    };
    open();
    const { container, unmount } = mount(
      createElement(DetailDrawer, {
        pagedDeps: {
          measurer: throwingMeasurer,
          awaitFonts: () => Promise.resolve(true),
          onError: () => undefined,
        },
      }),
    );
    await flush();

    // ⭐ 新形态真正该成立的事：详情**不依赖测量器** → 单页文档照常完整渲染（正面锚点）
    const preview = container.querySelector('[data-testid="doc-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('data-total-pages')).toBe('1'); // 恒单页
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1); // 恰好一张纸页
    expect(container.querySelector('[data-content-box="true"]')).not.toBeNull();
    expect(container.textContent).toContain('张伟'); // 正文确实渲染出来了
    // 新形态下「降级」概念已不成立：不应出现任何降级提示（目标不存在 → 需要上面的正面锚点兜底）
    expect(preview?.getAttribute('data-degraded')).toBeNull();
    expect(container.querySelector('[data-state="degraded"]')).toBeNull();
    unmount();
  });
});

/* ============================ QA 独立复核：单张连续长页 6 条不变式（2026-09-21 设计变更） ============================ */

/** N 段段落（都绑 f1）的文档模板；可选覆盖 pageSetup。段落数可控 → 可断言高度随内容增长 */
function docTemplate(count: number, pageSetup?: PageSetup): DocTemplate {
  const base = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;
  const blocks: ParagraphBlock[] = Array.from({ length: count }, (_, index) => ({
    blockId: `blk_p${index}`,
    kind: 'paragraph',
    breakInside: 'auto',
    fieldId: 'f1',
    preserveLineBreaks: false,
    hideWhenEmpty: false,
  }));
  const template: DocTemplate = { ...base, templateId: 't07-qa-continuous', blocks };
  return pageSetup ? { ...template, pageSetup } : template;
}

/** 写入「N 段文档」到 ViewStore（记录 r1 = 张伟） */
function seedDoc(count: number, pageSetup?: PageSetup): void {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
  useViewStore.setState({
    config: { ...config, detail: { ...config.detail, doc: docTemplate(count, pageSetup) } },
    fields: FIELDS,
    fieldsById: { f1: FIELDS[0], f2: FIELDS[1] },
    records: [{ recordId: 'r1', fields: { f1: '张伟', f2: 100 } } as never],
    env: { language: 'zh-CN' } as never,
  });
}

/**
 * `offsetHeight` 流式布局桩（jsdom 无布局引擎，恒 0）：`.cbv-paper` → 40 × 内部区块数；
 * 有内联 `height` → 用该值（这样「固定高度」错误实现会与内容驱动高度给出**不同**结果）。
 */
async function withPaperHeight(fn: () => Promise<void>): Promise<void> {
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

describe('T07 · QA 独立复核：单张连续长页 6 条不变式', () => {
  beforeEach(() => {
    seedView();
    useUiStore.setState({ drawer: initialDrawerState(null), toast: null });
  });

  it('不变式①：恰好一个页面容器，且不存在页码导航（配正文正面锚点）', async () => {
    seedDoc(5);
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    // 正面锚点：正文确实渲染出 5 块（防「整体渲染失败 → 否定式恒真」）
    expect(container.querySelectorAll('.cbv-doc-block').length).toBe(5);
    // 恰好一个页面容器
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1);
    // 页码导航消失
    expect(container.querySelector('[data-testid="page-navigator"]')).toBeNull();
    expect(container.querySelectorAll('.cbv-page-nav').length).toBe(0);
    unmount();
  });

  it('不变式②：高度随内容增长（8 块 > 2 块），且 ≠ 固定 1123', async () => {
    await withPaperHeight(async () => {
      seedDoc(2);
      open();
      const two = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
      await flush();
      const p2 = two.container.querySelector<HTMLElement>('.cbv-paper') as HTMLElement;
      const blocks2 = p2.querySelectorAll('.cbv-doc-block').length;
      const h2 = p2.offsetHeight;
      two.unmount();

      seedDoc(8);
      open();
      const eight = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
      await flush();
      const p8 = eight.container.querySelector<HTMLElement>('.cbv-paper') as HTMLElement;
      const blocks8 = p8.querySelectorAll('.cbv-doc-block').length;
      const h8 = p8.offsetHeight;
      eight.unmount();

      // 正面锚点：内容确实不同（否则「高度关系」可能被同一内容巧合满足）
      expect(blocks2).toBe(2);
      expect(blocks8).toBe(8);
      expect(h8).toBeGreaterThan(h2);
      expect(h8).not.toBe(1123); // 不是固定纸高
      expect(p8.style.height).toBe(''); // 内联不设 height（高度由内容决定）
    });
  });

  it('不变式③：DOM 中不存在页眉/页脚/页码（配纸页正面锚点）', async () => {
    seedDoc(3);
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    expect(container.querySelector('.cbv-paper')).not.toBeNull(); // 正面锚点：纸页渲染了
    expect(container.querySelectorAll('.cbv-doc-block').length).toBe(3);
    expect(container.querySelectorAll('[data-header-footer]').length).toBe(0);
    expect(container.querySelectorAll('[data-page-number]').length).toBe(0);
    expect(container.querySelectorAll('.cbv-doc-head').length).toBe(0);
    expect(container.querySelectorAll('.cbv-doc-foot').length).toBe(0);
    unmount();
  });

  it('不变式④：唯一滚动容器 = 外层视口；纸页自身不设 overflow（无内层滚动区）', async () => {
    seedDoc(6);
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    const viewport = container.querySelector<HTMLElement>('[data-testid="doc-preview-viewport"]');
    const paper = container.querySelector<HTMLElement>('.cbv-paper');
    expect(viewport).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(viewport?.style.overflow).toBe('auto');
    expect(paper?.style.overflow).toBe('');
    expect(paper?.style.overflowY).toBe('');
    unmount();
  });

  it('不变式⑤：内容盒宽度恒等于 getContentBox().width（横向 + 非对称边距）', async () => {
    const setup: PageSetup = {
      ...createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc.pageSetup,
      orientation: 'landscape',
      margin: { top: 40, right: 56, bottom: 40, left: 72 },
    };
    seedDoc(3, setup);
    open();
    const { container, unmount } = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(400) }));
    await flush();
    const box = container.querySelector<HTMLElement>('[data-content-box="true"]');
    expect(box).not.toBeNull();
    const expected = getContentBox(setup.paper, setup.orientation, setup.margin).width;
    const portrait = getContentBox(setup.paper, 'portrait', setup.margin).width;
    expect(Number.parseFloat((box as HTMLElement).style.width)).toBe(expected);
    // 分离：换朝向确实改变宽度（否则 expected 可能恰好等于任意值而恒真）
    expect(expected).not.toBe(portrait);
    unmount();
  });

  // 不变式⑥（既有交互未回归）由本文件 T12 段覆盖：默认 860px / Esc 两级 / 焦点归位 / 缩放下限 0.75。
});
