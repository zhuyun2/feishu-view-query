/**
 * 虚拟滚动卡片墙（T10）：`@tanstack/react-virtual` 行虚拟化 + **动态高度测量**。
 *
 * 关键点（设计文档 §13.1）：
 *  - 卡片**不定高**，故每行元素带 `data-index` 且把 `measureElement` 挂到行上，由 ResizeObserver 回填实测高度；
 *  - 每行渲染 `columns` 张卡（列数由 ResizeObserver 实测容器宽 + 密度推导）；
 *  - 滚动到「剩余 < 1 屏」时触发 `loadMore()`（`ScrollLoadController` 去重 + 100ms 节流），
 *    底部渲染骨架卡过渡；
 *  - **性能红线**：行内不新建对象/函数；`CardItem` 已 `memo`；回调全部 `useCallback` 稳定引用。
 *  - 交互走**容器级事件委托**（`[data-record-id]`），卡片自身不挂 handler。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CardLayoutConfig, DensityConfig, HighlightRule, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { useViewStore } from '@/state/ViewStore';
import { selectGridMetrics, selectRowCount } from '@/state/selectors';
import type { HoverAnchor } from '@/state/UiStore';
import { CardItem } from './CardItem';
import { CardSkeleton } from './CardSkeleton';
import { createScrollLoadController, estimateRowHeight } from './gridMath';
import { useVirtualGrid } from './useVirtualGrid';

export interface VirtualCardGridProps {
  layout: CardLayoutConfig;
  density: DensityConfig;
  theme: StyleTheme;
  fieldsById: Record<string, FieldMetaLite>;
  locale: string;
  attributesMaxRows: number;
  highlightRules: HighlightRule[];
  /**
   * 要渲染的记录序列（§22 F3 数据流终点）。
   *
   * **不传**时回落到 `ViewStore.records`（既有行为不变，例如编辑态预览）。
   * `ViewShell` 传入的是 `selectVisibleRecords` 的输出
   * （原生筛选 ∩ 插件筛选 ∩ 搜索），保证「屏幕上看到的」与「状态行声称的」是同一个集合。
   */
  records?: readonly SdkRecord[];
  /** 编辑态预览时传 false（不参与交互） */
  interactive?: boolean;
  onOpenRecord: (recordId: string) => void;
  /** 悬浮意图命中后回调（带卡片视口矩形，供气泡定位） */
  onHoverRecord?: (recordId: string, anchor: HoverAnchor) => void;
  onHoverEnd?: () => void;
}

const SKELETON_ROW_COUNT = 2;

/** 从事件目标回溯到最近的卡片单元，取出 recordId */
function recordIdFromEvent(target: EventTarget | null): { recordId: string; element: HTMLElement } | null {
  if (!(target instanceof HTMLElement)) return null;
  const cell = target.closest<HTMLElement>('[data-record-id]');
  if (!cell) return null;
  const recordId = cell.getAttribute('data-record-id');
  if (!recordId) return null;
  return { recordId, element: cell };
}

function VirtualCardGridInner(props: VirtualCardGridProps): JSX.Element {
  const {
    layout,
    density,
    theme,
    fieldsById,
    locale,
    attributesMaxRows,
    highlightRules,
    records: recordsProp,
    interactive = true,
    onOpenRecord,
    onHoverRecord,
    onHoverEnd,
  } = props;

  const storeRecords = useViewStore((state) => state.records);
  const hasMore = useViewStore((state) => state.hasMore);
  const loadingMore = useViewStore((state) => state.loadingMore);
  const loadMore = useViewStore((state) => state.loadMore);

  // 未提供 records 时延用库内的已加载记录（保持既有调用点行为零变更）
  const records: readonly SdkRecord[] = recordsProp ?? storeRecords;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const scrollController = useRef(createScrollLoadController({ thresholdScreens: 1, throttleMs: 100 }));

  // 容器宽度实测（列数随宽度变化）
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = (): void => setContainerWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const metrics = useMemo(() => selectGridMetrics(containerWidth, density), [containerWidth, density]);
  const columns = Math.max(1, metrics.columns);

  const contentRows = selectRowCount(records.length, columns);
  const skeletonRows = loadingMore && records.length > 0 ? 1 : 0;
  const rowCount = contentRows + skeletonRows;

  const estimateSize = useMemo(
    () => estimateRowHeight(density.maxCardHeight, density.gap),
    [density.maxCardHeight, density.gap],
  );

  const getScrollElement = useCallback(() => containerRef.current, []);
  const { virtualRows, totalSize, measureElement } = useVirtualGrid({
    rowCount,
    estimateSize,
    overscan: 3,
    getScrollElement,
  });

  // 同步 loading 状态到控制器（抑制重复请求）
  useEffect(() => {
    scrollController.current.markLoading(loadingMore);
  }, [loadingMore]);

  const handleScroll = useCallback((): void => {
    const element = containerRef.current;
    if (!element) return;
    const shouldLoad = scrollController.current.update({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      contentHeight: element.scrollHeight,
      hasMore,
      loading: loadingMore,
    });
    if (shouldLoad) void loadMore();
  }, [hasMore, loadingMore, loadMore]);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const hit = recordIdFromEvent(event.target);
      if (!hit) return;
      onOpenRecord(hit.recordId);
    },
    [onOpenRecord],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const hit = recordIdFromEvent(event.target);
      if (!hit) return;
      event.preventDefault();
      onOpenRecord(hit.recordId);
    },
    [onOpenRecord],
  );

  const handleMouseOver = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!onHoverRecord) return;
      const hit = recordIdFromEvent(event.target);
      if (!hit) return;
      const rect = hit.element.getBoundingClientRect();
      onHoverRecord(hit.recordId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    },
    [onHoverRecord],
  );

  const handleMouseOut = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!onHoverEnd) return;
      const related = event.relatedTarget as Node | null;
      const cell = event.currentTarget.querySelector<HTMLElement>('[data-record-id]:hover');
      if (related && cell && cell.contains(related)) return;
      onHoverEnd();
    },
    [onHoverEnd],
  );

  return (
    <div
      ref={containerRef}
      className="cbv-grid"
      role="grid"
      aria-rowcount={contentRows}
      aria-colcount={columns}
      data-columns={columns}
      onScroll={handleScroll}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onMouseOver={interactive ? handleMouseOver : undefined}
      onMouseOut={interactive ? handleMouseOut : undefined}
    >
      <div className="cbv-grid__inner" style={{ height: totalSize }}>
        {virtualRows.map((virtualRow) => {
          const isSkeleton = virtualRow.index >= contentRows;
          const start = virtualRow.index * columns;
          const rowRecords = isSkeleton ? [] : records.slice(start, start + columns);
          return (
            <div
              key={virtualRow.key}
              ref={measureElement}
              data-index={virtualRow.index}
              className="cbv-grid__row"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {isSkeleton
                ? Array.from({ length: Math.min(columns, SKELETON_ROW_COUNT + 1) }).map((_, index) => (
                    <CardSkeleton key={`sk-${index}`} index={index} />
                  ))
                : rowRecords.map((record) => (
                    <CardItem
                      key={record.recordId}
                      record={record}
                      layout={layout}
                      fieldsById={fieldsById}
                      theme={theme}
                      locale={locale}
                      attributesMaxRows={attributesMaxRows}
                      highlightRules={highlightRules}
                      interactive={interactive}
                    />
                  ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VirtualCardGrid = memo(VirtualCardGridInner);
VirtualCardGrid.displayName = 'VirtualCardGrid';
