/**
 * 页面与尺寸模型常量（设计文档 §5.3）。
 * 内部统一使用 px（@96dpi）基准；UI 呈现时通过 MM_TO_PX 换算为 mm。
 */

/** 纸张尺寸（@96dpi CSS 像素） */
export const PAPER_SIZE_PX = {
  A4: {
    portrait: { w: 794, h: 1123 },
    landscape: { w: 1123, h: 794 },
  },
  A5: {
    portrait: { w: 559, h: 794 },
    landscape: { w: 794, h: 559 },
  },
  Letter: {
    portrait: { w: 816, h: 1056 },
    landscape: { w: 1056, h: 816 },
  },
} as const;

export type PaperKind = keyof typeof PAPER_SIZE_PX;
export type PaperOrientation = 'portrait' | 'landscape';

/** 1mm = 96 / 25.4 px ≈ 3.7795px */
export const MM_TO_PX = 96 / 25.4;

/** 内容区尺寸（分页可容纳高度的基准） */
export interface ContentBox {
  /** 纸张宽 - 左右页边距 */
  width: number;
  /** 纸张高 - 上下页边距 */
  height: number;
  /** = margin.left */
  originX: number;
  /** = margin.top */
  originY: number;
}

export interface PageMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** mm → px */
export function mmToPx(mm: number): number {
  return mm * MM_TO_PX;
}

/** px → mm（保留 1 位小数） */
export function pxToMm(px: number): number {
  return Math.round((px / MM_TO_PX) * 10) / 10;
}

/** 取纸张像素尺寸 */
export function getPaperSizePx(paper: PaperKind, orientation: PaperOrientation): { w: number; h: number } {
  return PAPER_SIZE_PX[paper][orientation];
}

/** 计算内容区（ContentBox） */
export function getContentBox(
  paper: PaperKind,
  orientation: PaperOrientation,
  margin: PageMargin,
): ContentBox {
  const { w, h } = getPaperSizePx(paper, orientation);
  return {
    width: w - margin.left - margin.right,
    height: h - margin.top - margin.bottom,
    originX: margin.left,
    originY: margin.top,
  };
}
