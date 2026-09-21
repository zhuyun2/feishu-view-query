/**
 * 回归测试（工程师）——T12：悬浮预览意图 + 抽屉几何（R2 冻结口径）。
 *
 * 纯逻辑（定时器 / 几何 / Esc 语义）在此逐条断言；容器渲染交由人工视觉走查（T21）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOVER_HIDE_GRACE_MS, HOVER_INTENT_DELAY_MS, HoverIntentController } from '@/components/detail/hoverIntent';
import {
  clampDrawerWidth,
  computeBubblePlacement,
  computeFitZoom,
  resolveEscStage,
} from '@/components/detail/drawerMath';
import { DRAWER_MIN_WIDTH_PX, DRAWER_ZOOM_MAX, DRAWER_ZOOM_MIN } from '@/state/UiStore';

const ANCHOR = { x: 100, y: 200, width: 260, height: 120 };

describe('T12 · HoverIntentController（150ms 延迟 / 气泡不消失 / 宽限隐藏）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('延迟 150ms 才展示；未到时间不展示', () => {
    vi.useFakeTimers();
    const onShow = vi.fn();
    const onHide = vi.fn();
    const controller = new HoverIntentController({ onShow, onHide });

    controller.pointerEnter('r1', ANCHOR);
    vi.advanceTimersByTime(HOVER_INTENT_DELAY_MS - 1);
    expect(onShow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith('r1', ANCHOR);
    expect(controller.activeId).toBe('r1');
  });

  it('快速划过（未到 150ms 即离开）→ 不展示', () => {
    vi.useFakeTimers();
    const onShow = vi.fn();
    const controller = new HoverIntentController({ onShow, onHide: vi.fn() });

    controller.pointerEnter('r1', ANCHOR);
    vi.advanceTimersByTime(50);
    controller.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('移入气泡不消失：bubbleEnter 取消待定的隐藏', () => {
    vi.useFakeTimers();
    const onShow = vi.fn();
    const onHide = vi.fn();
    const controller = new HoverIntentController({ onShow, onHide });

    controller.pointerEnter('r1', ANCHOR);
    vi.advanceTimersByTime(HOVER_INTENT_DELAY_MS);
    expect(onShow).toHaveBeenCalledTimes(1);

    controller.pointerLeave(); // 安排隐藏
    controller.bubbleEnter(); // 立即取消
    vi.advanceTimersByTime(HOVER_HIDE_GRACE_MS);
    expect(onHide).not.toHaveBeenCalled();

    controller.bubbleLeave();
    vi.advanceTimersByTime(HOVER_HIDE_GRACE_MS);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('同卡内移动 → 立即刷新锚点（不再延时）', () => {
    vi.useFakeTimers();
    const onShow = vi.fn();
    const controller = new HoverIntentController({ onShow, onHide: vi.fn() });

    controller.pointerEnter('r1', ANCHOR);
    vi.advanceTimersByTime(HOVER_INTENT_DELAY_MS);
    const moved = { x: 120, y: 210, width: 260, height: 120 };
    controller.pointerEnter('r1', moved);
    expect(onShow).toHaveBeenCalledTimes(2);
    expect(onShow).toHaveBeenLastCalledWith('r1', moved);
  });

  it('hideNow：打开抽屉 / 滚动离开时立即收起', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const controller = new HoverIntentController({ onShow: vi.fn(), onHide });

    controller.pointerEnter('r1', ANCHOR);
    vi.advanceTimersByTime(HOVER_INTENT_DELAY_MS);
    controller.hideNow();
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(controller.activeId).toBeNull();
  });
});

describe('T12 · 抽屉几何（R2 冻结口径）', () => {
  it('R2 常量：默认宽 860 / 下限 560 / 缩放下限 0.75 / 上限 1.5', () => {
    expect(DRAWER_MIN_WIDTH_PX).toBe(560);
    expect(DRAWER_ZOOM_MIN).toBe(0.75);
    expect(DRAWER_ZOOM_MAX).toBe(1.5);
  });

  it('clampDrawerWidth：默认 860，钳制到 [560, 视口宽]', () => {
    expect(clampDrawerWidth(1000, 1400)).toBe(1000);
    expect(clampDrawerWidth(100, 1400)).toBe(560);
    expect(clampDrawerWidth(2000, 1400)).toBe(1400);
    expect(clampDrawerWidth(Number.NaN, 1400)).toBe(860);
  });

  it('computeFitZoom：缩放到填满可用宽度，并钳制到 [0.75, 1.5]', () => {
    expect(computeFitZoom(794, 794)).toBeCloseTo(1, 5);
    expect(computeFitZoom(1588, 794)).toBe(1.5);
    expect(computeFitZoom(200, 794)).toBe(0.75);
    expect(computeFitZoom(900, 794)).toBeCloseTo(1.133, 2);
    expect(computeFitZoom(0, 794)).toBe(1);
  });

  it('resolveEscStage：Esc 两级（全屏 → 退全屏；否则 → 关闭）', () => {
    expect(resolveEscStage(true)).toBe('exit-fullscreen');
    expect(resolveEscStage(false)).toBe('close');
  });
});

describe('T12 · 悬浮气泡定位（贴右缘翻左侧 + 视口钳制）', () => {
  it('空间充足 → 置于右侧', () => {
    const placement = computeBubblePlacement({
      anchor: { x: 100, y: 200, width: 200, height: 100 },
      bubbleWidth: 288,
      bubbleHeight: 180,
      viewportWidth: 1400,
      viewportHeight: 900,
    });
    expect(placement.side).toBe('right');
    expect(placement.left).toBe(312);
    expect(placement.top).toBe(200);
  });

  it('贴右缘 → 翻到左侧，防溢出', () => {
    const placement = computeBubblePlacement({
      anchor: { x: 1200, y: 100, width: 200, height: 100 },
      bubbleWidth: 288,
      bubbleHeight: 180,
      viewportWidth: 1400,
      viewportHeight: 900,
    });
    expect(placement.side).toBe('left');
    expect(placement.left).toBe(900);
    expect(placement.left + 288).toBeLessThanOrEqual(1400);
  });

  it('垂直方向越界 → 钳制到视口内', () => {
    const placement = computeBubblePlacement({
      anchor: { x: 100, y: 880, width: 200, height: 100 },
      bubbleWidth: 288,
      bubbleHeight: 180,
      viewportWidth: 1400,
      viewportHeight: 900,
    });
    expect(placement.top).toBeLessThanOrEqual(900 - 180);
    expect(placement.top).toBeGreaterThanOrEqual(0);
  });
});
