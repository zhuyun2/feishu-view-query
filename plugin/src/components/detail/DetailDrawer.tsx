/**
 * 详情抽屉容器（T12 / M3-T07 / P0-15）。
 *
 * 冻结口径（04 §11 R2）：
 *  - 默认宽 **860px**；左缘可拖宽 **560px ~ 满宽**；支持**全屏**；
 *  - 默认「**适应宽度**」；**缩放下限 0.75**；
 *  - `Esc` **两级**：先退全屏，再关抽屉；
 *  - 关闭后**焦点归位**（回到打开抽屉前的元素）。
 *
 * M3-T07 变更：正文区由 M2 的简易字段清单（`.cbv-doc-list` / `DocRow`）替换为文档预览
 * `<DocPreview/>`；文档编排交给 `usePagedDocument`。
 *
 * ⭐ 设计变更（2026-09-21，用户拍板）：详情从「A4 分页预览」改为「**单张连续长页**」——
 * 不再分页 / 不测量 / 不虚拟化；正文 = **一个** `<DocPreview/>`（内含单张 `.cbv-paper`，
 * 高度随内容增长，超出时由**外层视口**滚动）。页码导航 `PageNavigator` 已从本 UI 摘除；
 * `UiStore.drawer` 的 `currentPage` / `totalPages` / `paginating` / `paginationFailed` 不再被本路径驱动
 * （字段仍在 store 中保留，别处引用）。
 *
 * ⭐ 字段值出口（冻结口径）：本文件**不再**直调字段渲染注册表。文档态字段值的唯一出口是
 * `<DocFieldValue/>`（注册表调用发生在其内部）。本文件只负责「容器交互 + 文档编排接线」。
 *
 * ⭐ 「docx 模板导入」第五步 5a（2026-09-21）：正文区按 `detail.docSource` **二选一**：
 *  · `'blocks'`（**缺省**；旧配置亦按此）→ 现状路径，`usePagedDocument` + `<DocPreview/>`，
 *    **一行不改**（见 `resolveDocSource` 的缺省兜底）；
 *  · `'imported'` → `useImportedDoc` 产出「导入模板的填充字节」，由 `<DocxTemplatePreview/>`
 *    **保真渲染**。
 *
 * ⭐⭐⭐ 刻意分歧（**不要「顺手统一」**）⭐⭐⭐
 *   导入的 docx **自带页面几何（尺寸 / 边距）**。`'imported'` 分支**不套用** `.cbv-paper` 的
 *   纸张几何、也不受 `getContentBox().width` 不变式约束——否则等于**改版用户的 Word 模板**，
 *   且**不会有任何报错**。本分支只用一个普通包裹层（`zoom` 仅作**等比视觉缩放**，不改模板几何）。
 *
 * 失败必须**可见**：模板缺失 / 非法 / 填充失败，一律在正文区给出**明确文案**（见 `useImportedDoc`），
 * 绝不留一片空白让用户误以为「这个字段没数据」。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { usePagedDocument, type UsePagedDocumentDeps } from '@/hooks/usePagedDocument';
import { useImportedDoc, type UseImportedDocDeps } from '@/hooks/useImportedDoc';
import { DocPreview } from '@/components/doc/DocPreview';
import { DocxTemplatePreview } from '@/components/doc/DocxTemplatePreview';
import { resolveDocSource } from '@/doc/template/storage';
import { useUiStore, DRAWER_ZOOM_MAX, DRAWER_ZOOM_MIN, DRAWER_MIN_WIDTH_PX } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { clampDrawerWidth, computeFitZoom, resolveEscStage } from './drawerMath';

/** 文档内容基准宽度（A4 @96dpi ≈ 794px）——「适应宽度」缩放的参照物 */
const DOC_BASE_WIDTH_PX = 794;

/** `DetailDrawer` 入参（`pagedDeps` / `importedDeps` 仅供测试注入；生产不传，走真实编排） */
export interface DetailDrawerProps {
  pagedDeps?: UsePagedDocumentDeps;
  /** 「导入的 docx」数据管线的可注入依赖（测试用；生产不传） */
  importedDeps?: UseImportedDocDeps;
}

export function DetailDrawer({ pagedDeps, importedDeps }: DetailDrawerProps): JSX.Element | null {
  const open = useUiStore((state) => state.drawer.open);
  const recordId = useUiStore((state) => state.drawer.recordId);
  const widthPx = useUiStore((state) => state.drawer.widthPx);
  const fullscreen = useUiStore((state) => state.drawer.fullscreen);
  const zoom = useUiStore((state) => state.drawer.zoom);
  const fitToWidth = useUiStore((state) => state.drawer.fitToWidth);
  const currentPage = useUiStore((state) => state.drawer.currentPage);
  const showBoundary = useUiStore((state) => state.drawer.showBoundary);
  const paginating = useUiStore((state) => state.drawer.paginating);
  const paginationFailed = useUiStore((state) => state.drawer.paginationFailed);
  const closeDrawer = useUiStore((state) => state.closeDrawer);
  const setDrawerWidth = useUiStore((state) => state.setDrawerWidth);
  const toggleFullscreen = useUiStore((state) => state.toggleFullscreen);
  const setDrawerZoom = useUiStore((state) => state.setDrawerZoom);
  const setFitToWidth = useUiStore((state) => state.setFitToWidth);
  const setCurrentPage = useUiStore((state) => state.setCurrentPage);

  const records = useViewStore((state) => state.records);
  const fields = useViewStore((state) => state.fields);
  const fieldsById = useViewStore((state) => state.fieldsById);
  const detailConfig = useViewStore((state) => state.config?.detail ?? null);
  const docTemplate = useViewStore((state) => state.config?.detail.doc ?? null);
  const tableId = useViewStore((state) => state.env?.tableId ?? null);
  const viewId = useViewStore((state) => state.env?.viewId ?? null);
  const locale = useViewStore((state) => state.env?.language ?? 'zh-CN');

  /** 生效的文档来源：`docSource` 缺省（旧配置）→ `'blocks'`（由存储层统一兜底） */
  const docSource = resolveDocSource(detailConfig);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef(false);
  const [availableWidth, setAvailableWidth] = useState(0);

  const record = recordId ? records.find((item) => item.recordId === recordId) ?? null : null;

  // ⭐ 分页编排：解析 → 离屏测量 → 装箱 → 回写 UiStore.drawer（必须在任何 early-return 之前调用）
  const paged = usePagedDocument({
    template: docTemplate,
    record,
    recordId,
    fields,
    locale,
    // ⭐ 需求 2：关联表格预取需要「当前是哪张表」才能解析目标表句柄
    tableId,
    enabled: open && record !== null,
    deps: pagedDeps,
  });

  // ⭐ 导入的 docx 数据管线（仅在 `docSource === 'imported'` 时启用）。
  //    与 `usePagedDocument` 一样**无条件调用**（Hooks 规则），启用与否由 `enabled` 表达；
  //    未启用 / 非导入来源 → 复位为 idle、不产出字节 → **块路径完全不受影响**。
  const imported = useImportedDoc({
    detail: detailConfig,
    recordId,
    fields,
    tableId,
    viewId,
    enabled: open && record !== null && docSource === 'imported',
    deps: importedDeps,
  });

  // 焦点归位：打开时记住当前焦点元素，关闭后还原
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = typeof document !== 'undefined' ? (document.activeElement as HTMLElement) : null;
    return () => {
      const element = restoreFocusRef.current;
      if (element && typeof element.focus === 'function') element.focus();
    };
  }, [open]);

  // 「适应宽度」：ResizeObserver 实测可用宽度 → 反推缩放
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = (): void => setAvailableWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, fullscreen, widthPx]);

  useEffect(() => {
    if (!fitToWidth) return;
    if (availableWidth <= 0) return;
    const next = computeFitZoom(availableWidth, DOC_BASE_WIDTH_PX);
    if (Math.abs(next - zoom) > 0.001) {
      // ⚠️ `setDrawerZoom` 会顺带把 `fitToWidth` 置 false（UiStore 既有语义）；
      // 这里补一次 `setFitToWidth(true)`，使「适应宽度」保持按下、并随抽屉宽度持续跟随。
      setDrawerZoom(next);
      setFitToWidth(true);
    }
  }, [fitToWidth, availableWidth, zoom, setDrawerZoom, setFitToWidth]);

  // Esc 两级：全屏 → 退全屏；否则 → 关闭
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (resolveEscStage(fullscreen) === 'exit-fullscreen') {
        toggleFullscreen();
      } else {
        closeDrawer();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, fullscreen, toggleFullscreen, closeDrawer]);

  // 左缘拖动改宽
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    const onMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return;
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : widthPx;
      setDrawerWidth(clampDrawerWidth(viewportWidth - event.clientX, viewportWidth));
    };
    const onUp = (): void => {
      draggingRef.current = false;
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [open, widthPx, setDrawerWidth]);

  const onResizeStart = useCallback((): void => {
    draggingRef.current = true;
    if (typeof document !== 'undefined') document.body.style.userSelect = 'none';
  }, []);

  if (!open) return null;

  const rootStyle: CSSProperties = fullscreen ? {} : { width: widthPx };

  return (
    <div className="cbv-drawer-root" data-fullscreen={fullscreen ? 'true' : 'false'}>
      <div className="cbv-drawer__scrim" role="presentation" onClick={closeDrawer} />
      <aside
        className="cbv-drawer"
        style={rootStyle}
        role="dialog"
        aria-modal="true"
        aria-label="记录详情"
        data-testid="detail-drawer"
      >
        <div
          className="cbv-drawer__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整抽屉宽度"
          onMouseDown={onResizeStart}
        />
        <header className="cbv-drawer__header">
          <span className="cbv-drawer__title">记录详情</span>
          <span className="cbv-toolbar__spacer" />
          <button
            type="button"
            className="cbv-btn"
            onClick={() => setFitToWidth(!fitToWidth)}
            aria-pressed={fitToWidth}
            title="适应宽度"
          >
            适应宽度
          </button>
          <button
            type="button"
            className="cbv-btn"
            onClick={() => setDrawerZoom(Math.max(DRAWER_ZOOM_MIN, zoom - 0.25))}
            aria-label="缩小"
          >
            －
          </button>
          <span className="cbv-count">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="cbv-btn"
            onClick={() => setDrawerZoom(Math.min(DRAWER_ZOOM_MAX, zoom + 0.25))}
            aria-label="放大"
          >
            ＋
          </button>
          <button type="button" className="cbv-btn" onClick={toggleFullscreen} aria-pressed={fullscreen}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
          <button type="button" className="cbv-btn" onClick={closeDrawer} aria-label="关闭详情">
            ✕
          </button>
        </header>

        <div className="cbv-drawer__body" ref={bodyRef}>
          {record ? (
            docSource === 'imported' ? (
              // ⭐ 导入的 docx 路径：**不套** `.cbv-paper` 几何（模板自带页面尺寸/边距）。
              //    `zoom` 只作等比视觉缩放，不改模板内部版式。
              <div className="cbv-docx-view" data-docx-view="true" style={{ zoom }}>
                {imported.status === 'error' && imported.error ? (
                  // 失败必须可见（明确文案 + 正面锚点 data-docx-state=error），不留空白
                  <div className="cbv-state cbv-docx-state" data-docx-state="error" role="alert">
                    <div className="cbv-state__desc">{imported.error}</div>
                  </div>
                ) : null}
                {imported.status === 'loading' ? (
                  <div className="cbv-state cbv-docx-state" data-docx-state="loading">
                    <div className="cbv-state__desc">正在生成文档…</div>
                  </div>
                ) : null}
                <DocxTemplatePreview bytes={imported.status === 'ready' ? imported.bytes : null} />
              </div>
            ) : (
              <DocPreview
                pagedDoc={paged.pagedDoc}
                pageSetup={paged.pageSetup}
                theme={paged.theme}
                zoom={zoom}
                fitToWidth={fitToWidth}
                currentPage={currentPage}
                onPageChange={setCurrentPage}
                showBoundary={showBoundary}
                blocksById={paged.blocksById}
                record={record}
                fieldsById={fieldsById}
                locale={locale}
                paginating={paginating}
                paginationFailed={paginationFailed}
              />
            )
          ) : (
            <div className="cbv-state">
              <div className="cbv-state__desc">记录不存在或已被删除。</div>
            </div>
          )}
        </div>
        <footer className="cbv-drawer__footer cbv-count">
          {DRAWER_MIN_WIDTH_PX}px ~ 满宽 · 缩放 {Math.round(DRAWER_ZOOM_MIN * 100)}%~{Math.round(DRAWER_ZOOM_MAX * 100)}%
        </footer>
      </aside>
    </div>
  );
}
