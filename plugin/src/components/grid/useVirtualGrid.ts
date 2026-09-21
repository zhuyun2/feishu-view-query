/**
 * 行级虚拟化（T10，`@tanstack/react-virtual`）：卡片**不定高**，故启用动态高度测量
 * （`measureElement` + 行元素 `data-index`）。
 *
 * 只用其能力做「按行虚拟化」：每行渲染 `columns` 张卡，行高由 ResizeObserver 实测回填。
 * 纯几何计算（估算高度 / 可见区间 / 增量加载判定）在 `gridMath.ts`，与本 hook 解耦以便单测。
 */
import { useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';

export interface UseVirtualGridOptions {
  /** 总行数 = ceil(itemCount / columns) */
  rowCount: number;
  /** 未测量时单行估算高度（px） */
  estimateSize: number;
  overscan?: number;
  getScrollElement: () => HTMLElement | null;
}

export interface VirtualGridApi {
  virtualRows: VirtualItem[];
  totalSize: number;
  measureElement: (element: Element | null) => void;
  scrollToOffset: (offset: number) => void;
  scrollToIndex: (rowIndex: number) => void;
  /** 底层实例（调试/埋点用；不建议在渲染中读取频繁变化的值） */
  virtualizer: Virtualizer<HTMLElement, Element>;
}

export function useVirtualGrid(options: UseVirtualGridOptions): VirtualGridApi {
  const { rowCount, estimateSize, overscan = 4, getScrollElement } = options;

  const estimate = useCallback(() => estimateSize, [estimateSize]);
  const measureElement = useCallback(
    (element: Element | null): number => {
      if (!element) return estimateSize;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 ? rect.height : estimateSize;
    },
    [estimateSize],
  );

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: rowCount,
    getScrollElement,
    estimateSize: estimate,
    measureElement,
    overscan,
    getItemKey: useCallback((index: number) => index, []),
  });

  const virtualRows = virtualizer.getVirtualItems();

  return useMemo<VirtualGridApi>(
    () => ({
      virtualRows,
      totalSize: virtualizer.getTotalSize(),
      measureElement: virtualizer.measureElement,
      scrollToOffset: virtualizer.scrollToOffset,
      scrollToIndex: virtualizer.scrollToIndex,
      virtualizer,
    }),
    [virtualRows, virtualizer],
  );
}
