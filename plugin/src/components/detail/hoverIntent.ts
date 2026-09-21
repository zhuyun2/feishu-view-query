/**
 * 悬浮预览的「意图」控制器（T12 / P0-15，**纯逻辑**，便于用假定时器单测）。
 *
 * 交互约定（04 §5.2）：
 *  - 悬停 **150ms** 后才弹出气泡（快速划过不触发，避免闪烁）；
 *  - 鼠标从卡片移入气泡时**不消失**（`bubbleEnter` 取消隐藏）；
 *  - 离开卡片 / 气泡后，经短暂宽限（`HOVER_HIDE_GRACE_MS`）再隐藏。
 *
 * 定时器通过 `TimerApi` 注入，测试可替换为手动触发，无需真等待。
 */
import type { HoverAnchor } from '@/state/UiStore';

/** 悬停意图延迟（ms） */
export const HOVER_INTENT_DELAY_MS = 150;
/** 离开后的隐藏宽限（ms），给用户「移向气泡」的时间 */
export const HOVER_HIDE_GRACE_MS = 140;

export interface TimerApi {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => (typeof window === 'undefined' ? 0 : window.setTimeout(fn, ms)),
  clear: (handle) => {
    if (typeof window !== 'undefined') window.clearTimeout(handle);
  },
};

export interface HoverIntentCallbacks {
  onShow(recordId: string, anchor: HoverAnchor): void;
  onHide(): void;
}

export class HoverIntentController {
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private current: string | null = null;
  private visible = false;

  constructor(
    private readonly callbacks: HoverIntentCallbacks,
    private readonly delayMs: number = HOVER_INTENT_DELAY_MS,
    private readonly graceMs: number = HOVER_HIDE_GRACE_MS,
    private readonly timers: TimerApi = defaultTimers,
  ) {}

  /** 当前已展示的 recordId（未展示为 null） */
  get activeId(): string | null {
    return this.visible ? this.current : null;
  }

  private cancelShow(): void {
    if (this.showTimer !== null) {
      this.timers.clear(this.showTimer);
      this.showTimer = null;
    }
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      this.timers.clear(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /** 指针进入某卡片 */
  pointerEnter(recordId: string, anchor: HoverAnchor): void {
    this.cancelHide();
    if (this.visible && this.current === recordId) {
      // 同卡内移动：立即刷新锚点，无需再次延时
      this.callbacks.onShow(recordId, anchor);
      return;
    }
    this.cancelShow();
    this.showTimer = this.timers.set(() => {
      this.showTimer = null;
      this.current = recordId;
      this.visible = true;
      this.callbacks.onShow(recordId, anchor);
    }, this.delayMs);
  }

  /** 指针离开卡片（进入气泡前会先触发，随后被 bubbleEnter 取消） */
  pointerLeave(): void {
    this.cancelShow();
    this.scheduleHide();
  }

  /** 指针进入气泡 → 取消隐藏 */
  bubbleEnter(): void {
    this.cancelHide();
  }

  /** 指针离开气泡 → 安排隐藏 */
  bubbleLeave(): void {
    this.scheduleHide();
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = this.timers.set(() => {
      this.hideTimer = null;
      if (!this.visible) return;
      this.visible = false;
      this.current = null;
      this.callbacks.onHide();
    }, this.graceMs);
  }

  /** 立即隐藏（如打开抽屉、滚动离开） */
  hideNow(): void {
    this.cancelShow();
    this.cancelHide();
    if (!this.visible) return;
    this.visible = false;
    this.current = null;
    this.callbacks.onHide();
  }

  dispose(): void {
    this.cancelShow();
    this.cancelHide();
    this.visible = false;
    this.current = null;
  }
}
