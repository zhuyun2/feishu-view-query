/**
 * 抽屉 / 气泡的几何计算（T12，**纯函数**，便于单测）。
 *
 * 冻结口径（04 §11 R2）：
 *  - 抽屉默认宽 **860px**；可拖宽 **560px ~ 满宽**；
 *  - 支持全屏；默认「适应宽度」；**缩放下限 0.75**；
 *  - `Esc` **两级**：先退全屏，再关抽屉。
 *  - 悬浮气泡贴右缘时翻到左侧防溢出。
 */
import { DRAWER_MIN_WIDTH_PX, DRAWER_ZOOM_MAX, DRAWER_ZOOM_MIN, type HoverAnchor } from '@/state/UiStore';

/** 钳制抽屉宽度到 [560, 视口宽] */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH_PX, Math.floor(viewportWidth));
  if (!Number.isFinite(width)) return Math.min(860, max);
  return Math.min(Math.max(Math.round(width), DRAWER_MIN_WIDTH_PX), max);
}

/**
 * 「适应宽度」缩放：把内容基准宽度缩放到恰好填满可视宽度，并钳制到 [0.75, 1.5]。
 * 返回 1 表示无需缩放。
 */
export function computeFitZoom(availableWidth: number, contentBaseWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  if (!Number.isFinite(contentBaseWidth) || contentBaseWidth <= 0) return 1;
  const raw = availableWidth / contentBaseWidth;
  return Math.min(Math.max(raw, DRAWER_ZOOM_MIN), DRAWER_ZOOM_MAX);
}

/** Esc 的两级语义 */
export type EscStage = 'close' | 'exit-fullscreen';

/** 当前处于全屏 → 先退全屏；否则 → 关闭抽屉 */
export function resolveEscStage(fullscreen: boolean): EscStage {
  return fullscreen ? 'exit-fullscreen' : 'close';
}

export interface BubblePlacement {
  left: number;
  top: number;
  /** 气泡落在锚点右侧（right）还是左侧（left，防右缘溢出） */
  side: 'right' | 'left';
}

export interface BubblePlacementInput {
  anchor: HoverAnchor;
  bubbleWidth: number;
  bubbleHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** 与锚点的水平间距 */
  offset?: number;
  /** 与视口边缘的安全边距 */
  margin?: number;
}

/**
 * 计算气泡位置：默认置于卡片右侧；右侧放不下 → 翻到左侧；再做垂直方向边界钳制。
 */
export function computeBubblePlacement(input: BubblePlacementInput): BubblePlacement {
  const { anchor, bubbleWidth, bubbleHeight, viewportWidth, viewportHeight } = input;
  const offset = input.offset ?? 12;
  const margin = input.margin ?? 8;

  const spaceRight = viewportWidth - (anchor.x + anchor.width) - offset;
  const side: BubblePlacement['side'] = spaceRight >= bubbleWidth || anchor.x < bubbleWidth + offset ? 'right' : 'left';

  let left = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - bubbleWidth - offset;
  left = Math.min(Math.max(left, margin), Math.max(margin, viewportWidth - bubbleWidth - margin));

  let top = anchor.y;
  top = Math.min(Math.max(top, margin), Math.max(margin, viewportHeight - bubbleHeight - margin));

  return { left, top, side };
}
