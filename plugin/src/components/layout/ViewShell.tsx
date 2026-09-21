/**
 * 视图外壳（T09~T13）：工具栏 + 提示条 + 卡片墙（虚拟滚动）/空态 + 详情抽屉 + 悬浮预览 + 编辑器。
 *
 * 编排要点：
 *  - **编辑态**：卡片墙隐藏，由 `ConfigDrawer` 接管（R6）；
 *  - **错误边界**：卡片区与文档区各自独立（T13，插件不白屏）；
 *  - **空态/异常态**：字段缺失 / 无记录 / 搜索无结果 分别走 `EmptyState`；
 *  - **交互**：点击卡片打开详情抽屉；悬停 150ms 弹简要气泡（`useHoverIntent`）。
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { HighlightRule } from '@/config/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { VirtualCardGrid } from '@/components/grid/VirtualCardGrid';
import { DetailDrawer } from '@/components/detail/DetailDrawer';
import { HoverPreview } from '@/components/detail/HoverPreview';
import { useHoverIntent } from '@/components/detail/useHoverIntent';
import { ConfigDrawer } from '@/components/editor/ConfigDrawer';
import { useUiStore, type HoverAnchor } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { filterRecordsByQuery, selectAttributesMaxRows, selectCountLabel } from '@/state/selectors';
import type { ThemeTokens } from '@/hooks/useThemeTokens';
import { BannerStack } from './Banner';
import { EmptyState } from './EmptyState';
import { Toolbar } from './Toolbar';

export interface ViewShellProps {
  tokens: ThemeTokens;
}

const TOAST_DURATION_MS = 2400;

/** 模块级常量：避免在 render 内新建对象/数组 */
const EMPTY_RULES: HighlightRule[] = [];

export function ViewShell({ tokens }: ViewShellProps): JSX.Element {
  const records = useViewStore((state) => state.records);
  const total = useViewStore((state) => state.total);
  const fields = useViewStore((state) => state.fields);
  const fieldsById = useViewStore((state) => state.fieldsById);
  const config = useViewStore((state) => state.config);
  const locale = useViewStore((state) => state.env?.language ?? 'zh-CN');

  const searchQuery = useUiStore((state) => state.searchQuery);
  const editorOpen = useUiStore((state) => state.editorOpen);
  const openEditor = useUiStore((state) => state.openEditor);
  const openDrawer = useUiStore((state) => state.openDrawer);
  const toast = useUiStore((state) => state.toast);
  const showToast = useUiStore((state) => state.showToast);

  const hoverIntent = useHoverIntent();

  const layout = config?.card ?? null;
  const density = tokens.density;
  const theme = tokens.theme;
  const highlightRules = config?.highlightRules ?? EMPTY_RULES;

  const filteredRecords = useMemo(
    () => filterRecordsByQuery(records, layout, fieldsById, searchQuery),
    [records, layout, fieldsById, searchQuery],
  );

  const countLabel = useMemo(() => {
    const filtered = searchQuery.trim() !== '';
    return selectCountLabel(total, filtered ? filteredRecords.length : records.length, filtered);
  }, [total, records.length, filteredRecords.length, searchQuery]);

  const attributesMaxRows = selectAttributesMaxRows(density);

  const handleOpenRecord = useCallback(
    (recordId: string) => {
      hoverIntent.hideNow();
      openDrawer(recordId);
    },
    [hoverIntent, openDrawer],
  );

  const handleHoverRecord = useCallback(
    (recordId: string, anchor: HoverAnchor) => {
      hoverIntent.pointerEnter(recordId, anchor);
    },
    [hoverIntent],
  );

  const handleHoverEnd = useCallback(() => {
    hoverIntent.pointerLeave();
  }, [hoverIntent]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => showToast(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast, showToast]);

  // 编辑态收起悬浮气泡，避免浮层残留
  useEffect(() => {
    if (editorOpen) hoverIntent.hideNow();
  }, [editorOpen, hoverIntent]);

  const emptyKind = ((): 'noFields' | 'noRecords' | 'searchEmpty' | null => {
    if (fields.length === 0) return 'noFields';
    if (records.length === 0) return 'noRecords';
    if (filteredRecords.length === 0 && searchQuery.trim() !== '') return 'searchEmpty';
    return null;
  })();

  const handleEmptyAction = useCallback((label: string) => {
    if (label === '清空搜索') useUiStore.getState().setSearchQuery('');
    else if (label === '重试') void useViewStore.getState().refresh();
  }, []);

  return (
    <div className="cbv-app">
      <Toolbar countLabel={countLabel} onOpenConfig={() => openEditor('card')} />
      <BannerStack
        onReconfigureFromTemplate={() => openEditor('card')}
        onOpenEditor={() => openEditor('card')}
        onRetryRead={() => void useViewStore.getState().refresh()}
      />

      {editorOpen ? (
        <ErrorBoundary variant="doc">
          <ConfigDrawer />
        </ErrorBoundary>
      ) : emptyKind ? (
        <EmptyState kind={emptyKind} onAction={handleEmptyAction} />
      ) : layout ? (
        <ErrorBoundary variant="grid">
          <VirtualCardGrid
            layout={layout}
            density={density}
            theme={theme}
            fieldsById={fieldsById}
            locale={locale}
            attributesMaxRows={attributesMaxRows}
            highlightRules={highlightRules}
            onOpenRecord={handleOpenRecord}
            onHoverRecord={handleHoverRecord}
            onHoverEnd={handleHoverEnd}
          />
        </ErrorBoundary>
      ) : (
        <EmptyState kind="configPending" />
      )}

      <ErrorBoundary variant="doc">
        <DetailDrawer />
      </ErrorBoundary>

      <HoverPreview onEnter={() => hoverIntent.bubbleEnter()} onLeave={() => hoverIntent.bubbleLeave()} />

      {toast ? (
        <div className="cbv-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** 供 `ViewShell` 之外复用筛选计数（导出便于单测） */
export { filterRecordsByQuery };
