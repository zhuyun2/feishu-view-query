/**
 * 视图外壳（T09~T13）：工具栏 + 提示条 + 卡片墙（虚拟滚动）/空态 + 详情抽屉 + 悬浮预览 + 编辑器。
 *
 * 编排要点：
 *  - **编辑态**：卡片墙隐藏，由 `ConfigDrawer` 接管（R6）；
 *  - **错误边界**：卡片区与文档区各自独立（T13，插件不白屏）；
 *  - **空态/异常态**：字段缺失 / 无记录 / 搜索无结果 / 筛选无结果 分别走 `EmptyState`；
 *  - **交互**：点击卡片打开详情抽屉；悬停 150ms 弹简要气泡（`useHoverIntent`）。
 *
 * ⭐ 数据流（§22.1.2 F3）：插入点选在**选择器层**——
 *   `ViewStore.records`（服务端原生筛选 ∩ 原生排序）
 *     → `selectVisibleRecords`：`applyFilterConditions`（插件筛选）→ `filterRecordsByQuery`（搜索）
 *     → `VirtualCardGrid`（客户端纯收窄，绝不下推服务端：D1 只读 + 下推会丢原生筛选）
 *
 * ⭐ 覆盖范围诚实性（§22.11）：筛选默认只作用于**已加载记录**，故状态行常驻覆盖范围，
 *   `hasMore` 为真时常驻「未加载全部」+「加载全部并重新筛选」升级入口；
 *   只有真正翻完所有页（`!hasMore`）才允许出现「全部」字样。
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
import {
  countInvalidConditions,
  selectAttributesMaxRows,
  selectFilterScopeLabel,
  selectFilterScopeStatus,
  selectVisibleRecords,
} from '@/state/selectors';
import type { ThemeTokens } from '@/hooks/useThemeTokens';
import { BannerStack } from './Banner';
import { EmptyState } from './EmptyState';
import { Toolbar } from './Toolbar';

export interface ViewShellProps {
  tokens: ThemeTokens;
}

const TOAST_DURATION_MS = 2400;

/** 「加载全部并重新筛选」的翻页上限（防御性：异常 SDK 反复返回 hasMore 时不死循环） */
const MAX_LOAD_ALL_PAGES = 500;

/** 模块级常量：避免在 render 内新建对象/数组 */
const EMPTY_RULES: HighlightRule[] = [];

export function ViewShell({ tokens }: ViewShellProps): JSX.Element {
  const records = useViewStore((state) => state.records);
  const total = useViewStore((state) => state.total);
  const hasMore = useViewStore((state) => state.hasMore);
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
  const filter = useUiStore((state) => state.filter);
  const filterLoadingAll = useUiStore((state) => state.filterLoadingAll);
  const filterLoadAllStartedFrom = useUiStore((state) => state.filterLoadAllStartedFrom);

  const hoverIntent = useHoverIntent();

  const layout = config?.card ?? null;
  const density = tokens.density;
  const theme = tokens.theme;
  const highlightRules = config?.highlightRules ?? EMPTY_RULES;

  // ⭐ 唯一可见集：原生筛选 ∩ 插件筛选 ∩ 搜索（三者叠加，顺序收窄）
  const visible = useMemo(
    () => selectVisibleRecords({ records, filter, fieldsById, layout, searchQuery }),
    [records, filter, fieldsById, layout, searchQuery],
  );

  // ⭐ 未生效条件数（§22.5.6-3）：无效条件会被 `evaluateFilter` 丢弃，用户看到的是
  //    **全部记录**。若状态行只显示「命中 N 条」，用户会以为「这就是筛选结果」——
  //    与 §22.11.4「谎报筛过了全量」是同一类问题，必须由 UI 显式告知。
  //    判定reuse 引擎：`countInvalidConditions` 内部只调 `isConditionValid()` +
  //    `evaluateConditionState()`，**不另写**第二套校验（写两套必然漂移）。
  const invalidConditionCount = useMemo(
    () => countInvalidConditions(filter, fieldsById),
    [filter, fieldsById],
  );

  const countLabel = useMemo(
    () =>
      selectFilterScopeLabel({
        total,
        loaded: records.length,
        matched: visible.visible,
        hasFilter: visible.hasFilter,
        hasSearch: visible.hasSearch,
        hasMore,
        invalidCount: invalidConditionCount,
      }),
    [total, records.length, visible.visible, visible.hasFilter, visible.hasSearch, hasMore, invalidConditionCount],
  );

  // 覆盖率状态行（§22.11.3）：常驻覆盖范围 + 未加载全部时的诚实提示与升级入口
  const scopeStatus = useMemo(
    () =>
      selectFilterScopeStatus({
        total,
        loaded: records.length,
        filterMatched: visible.filterMatched,
        visible: visible.visible,
        hasFilter: visible.hasFilter,
        hasSearch: visible.hasSearch,
        hasMore,
        loadingAll: filterLoadingAll,
        startedFrom: filterLoadAllStartedFrom,
        invalidCount: invalidConditionCount,
      }),
    [
      total,
      records.length,
      visible.filterMatched,
      visible.visible,
      visible.hasFilter,
      visible.hasSearch,
      hasMore,
      filterLoadingAll,
      filterLoadAllStartedFrom,
      invalidConditionCount,
    ],
  );

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

  const emptyKind = ((): 'noFields' | 'noRecords' | 'searchEmpty' | 'filterEmpty' | null => {
    if (fields.length === 0) return 'noFields';
    if (records.length === 0) return 'noRecords';
    if (visible.records.length === 0) {
      // 筛选优先于搜索：是「条件筛没了」而非「关键词不对」，直接给出清空筛选的出路
      if (visible.hasFilter) return 'filterEmpty';
      if (visible.hasSearch) return 'searchEmpty';
    }
    return null;
  })();

  const handleEmptyAction = useCallback((label: string) => {
    if (label === '清空搜索') useUiStore.getState().setSearchQuery('');
    else if (label === '清空筛选') useUiStore.getState().clearFilter();
    else if (label === '重试') void useViewStore.getState().refresh();
  }, []);

  /**
   * 「加载全部并重新筛选」（§22.11.3 Plan C-lite 升级）。
   *
   * 复用既有 `ViewStore.loadMore()`（内含并发抑制 / 游标 / 去重 / 失败兜底），
   * 循环翻到 `hasMore === false` 为止，期间由 UiStore 记录「正在升级」以显示进度。
   * ⚠️ 无论成功或异常都必须 `endFilterLoadAll()`，否则 UI 会永久停留在进度态。
   */
  const handleLoadAll = useCallback(async (): Promise<void> => {
    if (useUiStore.getState().filterLoadingAll) return;
    const startedFrom = useViewStore.getState().records.length;
    useUiStore.getState().beginFilterLoadAll(startedFrom);
    try {
      for (let page = 0; page < MAX_LOAD_ALL_PAGES; page += 1) {
        if (!useViewStore.getState().hasMore) break;
        await useViewStore.getState().loadMore();
        if (!useViewStore.getState().hasMore) break;
      }
    } finally {
      useUiStore.getState().endFilterLoadAll();
    }
  }, []);

  return (
    <div className="cbv-app">
      <Toolbar countLabel={countLabel} onOpenConfig={() => openEditor('card')} />
      <BannerStack
        onReconfigureFromTemplate={() => openEditor('card')}
        onOpenEditor={() => openEditor('card')}
        onRetryRead={() => void useViewStore.getState().refresh()}
      />

      {/* ⭐ 覆盖范围状态行（§22.11.3）：常驻，含「未加载全部」+ 升级入口 */}
      {scopeStatus.visible ? (
        <div className="cbv-filter-scope" data-testid="filter-scope" role="status">
          <span className="cbv-filter-scope__text" data-testid="filter-scope-text">
            {scopeStatus.scopeText}
          </span>
          {scopeStatus.incompleteText ? (
            <span className="cbv-filter-scope__incomplete" data-testid="filter-scope-incomplete">
              {scopeStatus.incompleteText}
            </span>
          ) : null}
          {scopeStatus.canUpgrade ? (
            <button
              type="button"
              className="cbv-btn cbv-link-btn"
              data-testid="filter-load-all"
              onClick={() => void handleLoadAll()}
            >
              {scopeStatus.upgradeLabel}
            </button>
          ) : null}
          {scopeStatus.progressText ? (
            <span className="cbv-filter-scope__progress" data-testid="filter-load-all-progress">
              {scopeStatus.progressText}
            </span>
          ) : null}
        </div>
      ) : null}

      {editorOpen ? (
        <ErrorBoundary variant="doc">
          <ConfigDrawer />
        </ErrorBoundary>
      ) : emptyKind ? (
        <EmptyState kind={emptyKind} onAction={handleEmptyAction} />
      ) : layout ? (
        <ErrorBoundary variant="grid">
          <VirtualCardGrid
            records={visible.records}
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

/** 向后兼容：曾有调用方从 `ViewShell` 取该纯函数；正式来源仍是 `state/selectors` */
export { filterRecordsByQuery } from '@/state/selectors';
