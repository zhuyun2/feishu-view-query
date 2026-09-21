/**
 * 虚拟网格几何与增量加载判定（T10，纯函数 —— 便于逻辑级单测）。
 *
 * 设计文档 §13.1：行级虚拟化 + 动态高度测量；增量加载「剩余 < 1 屏触发；100ms 节流」。
 * 本模块只做**纯计算 / 纯状态机**，不依赖 React 与 DOM，因此可在 jsdom 下逐条断言。
 */

/** 单行高度估算（未测量时的兜底） */
export function estimateRowHeight(maxCardHeight: number, gap: number): number {
  const height = maxCardHeight > 0 ? maxCardHeight : 180;
  return height + Math.max(0, gap);
}

export interface LoadMoreInput {
  scrollTop: number;
  viewportHeight: number;
  /** 当前已渲染内容总高度（px） */
  contentHeight: number;
  hasMore: boolean;
  loading: boolean;
  /** 剩余不足「thresholdScreens 屏」时触发，默认 1 屏 */
  thresholdScreens?: number;
}

/**
 * 是否应触发「取下一页」。
 * 不满足任一前置条件（无更多 / 加载中 / 视口/内容高度非法）→ false。
 */
export function shouldLoadMore(input: LoadMoreInput): boolean {
  const { scrollTop, viewportHeight, contentHeight, hasMore, loading } = input;
  if (!hasMore || loading) return false;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight) || !Number.isFinite(contentHeight)) {
    return false;
  }
  if (viewportHeight <= 0) return false;
  const thresholdScreens = input.thresholdScreens ?? 1;
  const remaining = contentHeight - (scrollTop + viewportHeight);
  return remaining <= viewportHeight * thresholdScreens;
}

/** 由可见行区间换算可见卡片索引区间（闭区间 → 半开区间 [startIndex, endIndex)） */
export function visibleCardRange(
  startRow: number,
  endRow: number,
  columns: number,
  itemCount: number,
): { startIndex: number; endIndex: number } {
  const safeColumns = Math.max(1, columns);
  const startIndex = Math.max(0, Math.floor(startRow) * safeColumns);
  const endIndex = Math.min(itemCount, (Math.floor(endRow) + 1) * safeColumns);
  return { startIndex, endIndex: Math.max(startIndex, endIndex) };
}

export interface ScrollLoadState {
  /** 上次触发时刻（节流用） */
  lastTriggeredAt: number;
  /** 已请求但尚未回填 → 抑制重复请求 */
  pending: boolean;
}

export function createScrollLoadState(): ScrollLoadState {
  return { lastTriggeredAt: 0, pending: false };
}

export interface ScrollLoadOptions {
  thresholdScreens?: number;
  /** 节流窗口（ms），设计文档 §13.1 取 100ms */
  throttleMs?: number;
  now?: () => number;
}

/**
 * 滚动触发的增量加载控制器（去重 + 节流）。
 *
 * - `markLoading(true/false)` 由外部在请求前后调用，用于抑制重复请求；
 * - `update()` 在**同一落点**只会触发一次，直到 loading 结束；
 * - 每次真实触发都会记录时刻，窗口内不再触发（节流）。
 */
export class ScrollLoadController {
  private readonly thresholdScreens: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  /** 上次触发时刻；初值 -Infinity 保证「首次触发」不被节流误伤 */
  private lastTriggeredAt = Number.NEGATIVE_INFINITY;
  private pending = false;
  private triggerCount = 0;

  constructor(options: ScrollLoadOptions = {}) {
    this.thresholdScreens = options.thresholdScreens ?? 1;
    this.throttleMs = options.throttleMs ?? 100;
    this.now = options.now ?? (() => Date.now());
  }

  /** 请求开始 / 结束时同步（loading=true 表示请求在途） */
  markLoading(loading: boolean): void {
    this.pending = loading;
  }

  /** 是否正在等待上一请求回填 */
  get isPending(): boolean {
    return this.pending;
  }

  /** 已真实触发的次数（测试断言用） */
  get triggers(): number {
    return this.triggerCount;
  }

  /**
   * 滚动位置更新。返回 true 表示**本次应发起一次取数**（已记账）。
   */
  update(input: Omit<LoadMoreInput, 'thresholdScreens'>): boolean {
    const nearBottom = shouldLoadMore({ ...input, loading: input.loading || this.pending, thresholdScreens: this.thresholdScreens });
    if (!nearBottom) return false;
    const timestamp = this.now();
    if (this.pending) return false;
    if (timestamp - this.lastTriggeredAt < this.throttleMs) return false;

    this.lastTriggeredAt = timestamp;
    this.pending = true;
    this.triggerCount += 1;
    return true;
  }
}

/** 工厂：便于在组件内 `useRef(createScrollLoadController(...))` 一次性构造 */
export function createScrollLoadController(options: ScrollLoadOptions = {}): ScrollLoadController {
  return new ScrollLoadController(options);
}
