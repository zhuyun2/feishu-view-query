/**
 * 详情抽屉容器（T12 / P0-15）。
 *
 * 冻结口径（04 §11 R2）：
 *  - 默认宽 **860px**；左缘可拖宽 **560px ~ 满宽**；支持**全屏**；
 *  - 默认「**适应宽度**」；**缩放下限 0.75**；
 *  - `Esc` **两级**：先退全屏，再关抽屉；
 *  - 关闭后**焦点归位**（回到打开抽屉前的元素）。
 *
 * ⚠️ **过渡实现**：M2 仅用 `registry.renderDoc` 渲染一个简易字段清单，
 * 用于验证容器与交互（宽度 / 全屏 / 缩放 / Esc / 焦点）。
 * **分页引擎、纸张、页眉页脚、打印导出属 M3（T16~T20），本文件刻意不实现。**
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { IRecord } from '@lark-base-open/js-sdk';
import type { FieldDisplayOptions, StyleTheme } from '@/config/types';
import type { DocRenderContext, FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { FALLBACK_VALUE, renderDoc } from '@/fields/registry';
import { getRecordFields } from '@/data/RecordDataSource';
import { useUiStore, DRAWER_ZOOM_MAX, DRAWER_ZOOM_MIN, DRAWER_MIN_WIDTH_PX } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { logError } from '@/utils/log';
import { clampDrawerWidth, computeFitZoom, resolveEscStage } from './drawerMath';

/** 文档内容基准宽度（A4 @96dpi ≈ 794px）——「适应宽度」缩放的参照物 */
const DOC_BASE_WIDTH_PX = 794;

/** 抽屉内兜底主题（模块级常量，避免 render 内新建对象） */
const FALLBACK_THEME: StyleTheme = {
  preset: 'feishu-default',
  primaryColor: '#3370FF',
  borderRadius: 8,
  shadowLevel: 1,
  fontScale: 1,
  titleWeight: 600,
};

/** 文档态默认展示选项（模块级常量：避免在 render 内新建对象） */
const DOC_DISPLAY: FieldDisplayOptions = {
  maxLines: 0,
  truncate: 'none',
  maxItems: 0,
  hideWhenEmpty: false,
};

interface DocRowProps {
  record: IRecord;
  field: FieldMetaLite;
  theme: StyleTheme;
  locale: string;
}

function DocRow({ record, field, theme, locale }: DocRowProps): JSX.Element {
  const nv = useMemo<NormalizedValue>(() => {
    try {
      return normalize(getRecordFields(record)[field.id], field);
    } catch (err) {
      logError('detail.docRow.normalize', err, { fieldId: field.id });
      return FALLBACK_VALUE;
    }
  }, [record, field]);

  const ctx = useMemo<DocRenderContext>(
    () => ({
      fieldMeta: field,
      display: DOC_DISPLAY,
      theme,
      locale,
      fragmentIndex: 0,
      fragmentsTotal: 1,
      showLabel: false,
      labelText: field.name,
    }),
    [field, theme, locale],
  );

  return (
    <div className="cbv-doc-row" data-field-id={field.id}>
      <span className="cbv-doc-row__label">{field.name}</span>
      <span className="cbv-doc-row__value">{renderDoc(nv, ctx)}</span>
    </div>
  );
}

export function DetailDrawer(): JSX.Element | null {
  const open = useUiStore((state) => state.drawer.open);
  const recordId = useUiStore((state) => state.drawer.recordId);
  const widthPx = useUiStore((state) => state.drawer.widthPx);
  const fullscreen = useUiStore((state) => state.drawer.fullscreen);
  const zoom = useUiStore((state) => state.drawer.zoom);
  const fitToWidth = useUiStore((state) => state.drawer.fitToWidth);
  const closeDrawer = useUiStore((state) => state.closeDrawer);
  const setDrawerWidth = useUiStore((state) => state.setDrawerWidth);
  const toggleFullscreen = useUiStore((state) => state.toggleFullscreen);
  const setDrawerZoom = useUiStore((state) => state.setDrawerZoom);
  const setFitToWidth = useUiStore((state) => state.setFitToWidth);

  const records = useViewStore((state) => state.records);
  const fields = useViewStore((state) => state.fields);
  const theme = useViewStore((state) => state.config?.theme ?? null);
  const scope = useViewStore((state) => state.config?.detail.fieldScope ?? 'all');
  const locale = useViewStore((state) => state.env?.language ?? 'zh-CN');

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef(false);
  const [availableWidth, setAvailableWidth] = useState(0);

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
    if (Math.abs(next - zoom) > 0.001) setDrawerZoom(next);
  }, [fitToWidth, availableWidth, zoom, setDrawerZoom]);

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

  const record = recordId ? records.find((item) => item.recordId === recordId) ?? null : null;
  const scopedFields = scope === 'placed' ? [] : fields;

  const rootStyle: CSSProperties = fullscreen ? {} : { width: widthPx };
  const contentStyle: CSSProperties = {
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
    width: `${100 / zoom}%`,
  };

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
            <div className="cbv-drawer__content" style={contentStyle}>
              {/* ⚠️ 过渡实现：简易字段清单；M3 由文档引擎（分页/纸张/页眉页脚）接管 */}
              {scopedFields.length > 0 ? (
                <div className="cbv-doc-list">
                  {scopedFields.map((field) => (
                    <DocRow key={field.id} record={record} field={field} theme={theme ?? FALLBACK_THEME} locale={locale} />
                  ))}
                </div>
              ) : (
                <div className="cbv-state">
                  <div className="cbv-state__desc">该记录暂无可展示的字段。</div>
                </div>
              )}
            </div>
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
