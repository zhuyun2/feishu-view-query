/**
 * QA2 独立验证（任务 #13/#15）· T12：详情抽屉容器 + 悬浮预览意图。
 *
 * 断言来源：
 *  - `04 §11 R2` / 口径 #3：抽屉默认 **860px**、可拖 **560 ~ 满宽**、`Esc` **两级**（退全屏→关抽屉）、
 *    焦点归位（a11y）。
 *  - `04 §11 R5`：默认「适应宽度」；**缩放下限 0.75**（computeFitZoom 钳制 [0.75,1.5]）。
 *  - `04 §5.2/§3.7`：Hover ≥ **150ms** 触发气泡。
 *  - 口径 #7：M2 抽屉正文为**过渡实现**（简易字段清单），**不假装已实现 A4 分页（M3）**。
 *
 * 断言来源不得来自实现现状；本文件对「过渡实现」做的是**契约检查**（源码内有明确标记、
 * 且未引入分页引擎），而非验收 A4 排版。
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
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';

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

  it('默认宽度 860px；页脚展示 560 ~ 满宽与缩放区间（R2）', () => {
    open();
    const { container, unmount } = mount(createElement(DetailDrawer));
    const html = container.innerHTML;
    // 客户端渲染的 DOM 由 CSSOM 序列化，内联样式为 'width: 860px;'（含空格）
    expect(html).toMatch(/width:\s*860px/);
    expect(html).toContain('860px');
    expect(html).toContain('560px ~ 满宽');
    expect(html).toContain('75%~150%');
    expect(html).toContain('客户名称'); // 过渡实现：简易字段清单（非 A4 分页）
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

/* ============================ 过渡实现契约（口径 #7） ============================ */

describe('T12 · 抽屉正文为过渡实现（M3 才做 A4 分页）', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/components/detail/DetailDrawer.tsx'), 'utf8');

  it('源码内有明确的「过渡实现 / M3」标记', () => {
    expect(source).toContain('过渡实现');
    expect(source).toContain('M3');
  });

  it('未引入分页引擎 / 纸张 / 打印导出（不得假装已实现 A4 分页）', () => {
    expect(source).not.toMatch(/@\/pagination/);
    expect(source).not.toMatch(/\bpaginate\b/);
    expect(source).not.toMatch(/window\.print/);
  });
});
