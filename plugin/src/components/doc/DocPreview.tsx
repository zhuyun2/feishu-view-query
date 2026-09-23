/**
 * 文档预览容器（设计文档 §21.3.4 / §21.5 / §5.6 / M3-T06；2026-09-21 **设计变更**）。
 *
 * ⭐ 设计变更（用户拍板）：详情从「A4 分页预览」改为「**单张连续长页**」。职责相应收敛为：
 *  - **单张纸页**：只渲染**一个** `<DocPaper/>`（宽度 = 纸张 px；高度随内容增长）。
 *  - **外层滚动**：`.cbv-doc-preview__viewport` 是**唯一**滚动容器（`overflow:auto`）；
 *    纸页内部**不再**套一层滚动区（内容超出时由视口滚动，而非纸张内滚动）。
 *  - **缩放**：`transform: scale(zoom)`（`transform-origin: top center`）；`printing` 态强制 `zoom = 1`。
 *  - **适应宽度**：`ResizeObserver` 实测可用宽度 → `computeFitZoom()` 反推缩放（钳制 [0.75, 1.5]）。
 *  - **不再分页**：不跑装箱 / 不测量 / 不做纸页虚拟化；**不再渲染页眉/页脚/页码/分页导航**。
 *  - 空文档（`totalPages === 0`）→ 空态提示。
 *
 * ⚠️ 兼容性说明（刻意保留的惰性 API 面）：`pagedDoc` 现恒为「单页」形态（`totalPages ∈ {0,1}`，
 *   `pages[0].items` 即全部区块）；`currentPage` / `onPageChange` / `paginating` / `paginationFailed` /
 *   `showBoundary` 不再被消费，仅保留在 `DocPreviewProps` 以维持既有调用方与单测的编译期兼容。
 *   纯函数 `visiblePageRange` / `isPageRendered` 亦为**遗留**导出（虚拟化已移除），仅为兼容既有单测。
 */
import type { CSSProperties, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DocTheme, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type { PagedDocument } from '@/pagination/types';
import type { ResolvedBlock } from '@/doc/resolve';
import { getPaperSizePx } from '@/constants/paper';
import { DRAWER_ZOOM_MAX, DRAWER_ZOOM_MIN } from '@/state/UiStore';
import { computeFitZoom } from '../detail/drawerMath';
import { DocPaper } from './DocPaper';

/** @deprecated 纸页虚拟化已移除；保留仅为兼容既有单测。 */
export const PAGE_VIRTUAL_BUFFER = 2;
/** 预览容器内边距（适应宽度时从可用宽度中扣除） */
export const PREVIEW_PADDING_PX = 24;
/** @deprecated 单页长页无「页与页之间」间距；保留仅为兼容既有引用。 */
export const PREVIEW_PAGE_GAP = 16;

/** `DocPreview` 入参（§21.3.4；`currentPage` / `paginating` / `paginationFailed` 等为**惰性保留**） */
export interface DocPreviewProps {
  /** 单页产物（`pages[0].items` 即全部区块） */
  pagedDoc: PagedDocument;
  pageSetup: PageSetup;
  theme: DocTheme;
  /** 缩放（0.75 ~ 1.5，与 `UiStore.drawer` 一致） */
  zoom: number;
  fitToWidth: boolean;
  /** @deprecated 单页长页无翻页；保留仅为兼容既有调用方。 */
  currentPage: number;
  /** @deprecated 单页长页无翻页；保留仅为兼容既有调用方。 */
  onPageChange(page: number): void;
  /** @deprecated 单页长页无分页边界；保留仅为兼容既有调用方。 */
  showBoundary: boolean;
  blocksById: Record<string, ResolvedBlock>;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  locale: string;
  /** 打印态：由 DocExporter 置位（隐藏 UI / 强制 zoom=1） */
  printing?: boolean;
  /** @deprecated 单页长页无分页中态；保留仅为兼容既有调用方。 */
  paginating?: boolean;
  /** @deprecated 单页长页无降级概念；保留仅为兼容既有调用方。 */
  paginationFailed?: boolean;
}

/** 可见页区间（**遗留纯函数**，虚拟化已移除） */
export interface PageRange {
  from: number;
  to: number;
}

/**
 * @deprecated 纸页虚拟化已移除（单页长页只渲染一张）；保留仅为兼容既有单测。
 */
export function visiblePageRange(
  currentPage: number,
  totalPages: number,
  buffer: number = PAGE_VIRTUAL_BUFFER,
): PageRange {
  const total = Math.max(0, Math.trunc(Number.isFinite(totalPages) ? totalPages : 0));
  if (total === 0) return { from: 0, to: -1 };
  const current = Math.min(Math.max(0, Math.trunc(Number.isFinite(currentPage) ? currentPage : 0)), total - 1);
  const span = Math.max(0, Math.trunc(Number.isFinite(buffer) ? buffer : 0));
  return { from: Math.max(0, current - span), to: Math.min(total - 1, current + span) };
}

/** @deprecated 纸页虚拟化已移除；保留仅为兼容既有单测。 */
export function isPageRendered(pageIndex: number, range: PageRange): boolean {
  return pageIndex >= range.from && pageIndex <= range.to;
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(zoom, DRAWER_ZOOM_MIN), DRAWER_ZOOM_MAX);
}

function DocPreviewImpl(props: DocPreviewProps): ReactElement {
  const { pagedDoc, pageSetup, theme, zoom, fitToWidth, blocksById, record, fieldsById, locale, printing } = props;

  const paper = getPaperSizePx(pageSetup.paper, pageSetup.orientation);
  const totalPages = Math.max(0, Math.trunc(pagedDoc.totalPages));
  const isEmpty = totalPages === 0;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  // 「适应宽度」：实测视口可用宽度（仅本组件自持的内部状态）
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = (): void => setAvailableWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const inputZoom = clampZoom(zoom);
  const fitZoom =
    availableWidth > 0 ? computeFitZoom(availableWidth - PREVIEW_PADDING_PX, paper.w) : inputZoom;
  const effectiveZoom = printing === true ? 1 : fitToWidth ? fitZoom : inputZoom;

  const items = pagedDoc.pages[0]?.items ?? [];

  const rootStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--color-bg-canvas, #f2f3f5)',
  };

  // ⭐ 唯一滚动容器：内容超出时由此层滚动（纸张内部不再套滚动区）
  const viewportStyle: CSSProperties = {
    flex: '1 1 auto',
    overflow: 'auto',
    padding: `${PREVIEW_PADDING_PX}px`,
    boxSizing: 'border-box',
  };

  const canvasStyle: CSSProperties = {
    width: paper.w,
    margin: '0 auto',
    transform: `scale(${effectiveZoom})`,
    transformOrigin: 'top center',
  };

  return (
    <div
      className="cbv-doc-preview"
      data-testid="doc-preview"
      data-zoom={effectiveZoom}
      data-current-page={0}
      data-total-pages={totalPages}
      data-fit-to-width={fitToWidth ? 'true' : 'false'}
      data-printing={printing === true ? 'true' : 'false'}
      style={rootStyle}
    >
      {isEmpty ? (
        <div className="cbv-doc-preview__status" data-state="empty" role="status">
          暂无可排版的文档内容。
        </div>
      ) : null}

      <div
        className="cbv-doc-preview__viewport"
        data-testid="doc-preview-viewport"
        ref={viewportRef}
        style={viewportStyle}
      >
        <div className="cbv-doc-preview__canvas" data-testid="doc-preview-canvas" style={canvasStyle}>
          {isEmpty ? null : (
            <DocPaper
              pageIndex={0}
              totalPages={1}
              items={items}
              pageSetup={pageSetup}
              theme={theme}
              blocksById={blocksById}
              record={record}
              fieldsById={fieldsById}
              locale={locale}
              showHeaderFooter={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const DocPreview = DocPreviewImpl;

export default DocPreview;
