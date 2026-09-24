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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AUTO_LOAD_ALL_SILENT_THRESHOLD } from '@/constants';
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
  const totalKnown = useViewStore((state) => state.totalKnown);
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
  const filterLoadAllSilent = useUiStore((state) => state.filterLoadAllSilent);

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
        totalKnown,
        loaded: records.length,
        matched: visible.visible,
        hasFilter: visible.hasFilter,
        hasSearch: visible.hasSearch,
        hasMore,
        invalidCount: invalidConditionCount,
      }),
    [total, totalKnown, records.length, visible.visible, visible.hasFilter, visible.hasSearch, hasMore, invalidConditionCount],
  );

  // 覆盖率状态行（§22.11.3）：常驻覆盖范围 + 未加载全部时的诚实提示与升级入口
  const scopeStatus = useMemo(
    () =>
      selectFilterScopeStatus({
        total,
        totalKnown,
        loaded: records.length,
        filterMatched: visible.filterMatched,
        visible: visible.visible,
        hasFilter: visible.hasFilter,
        hasSearch: visible.hasSearch,
        hasMore,
        loadingAll: filterLoadingAll,
        loadingAllSilent: filterLoadAllSilent,
        startedFrom: filterLoadAllStartedFrom,
        invalidCount: invalidConditionCount,
      }),
    [
      total,
      totalKnown,
      records.length,
      visible.filterMatched,
      visible.visible,
      visible.hasFilter,
      visible.hasSearch,
      hasMore,
      filterLoadingAll,
      filterLoadAllSilent,
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
   * 「加载全部并重新筛选」（§22.11.3 Plan C-lite 升级 + 自动全量）。
   *
   * 复用既有 `ViewStore.loadMore()`（内含并发抑制 / 游标 / 去重 / 失败标记），
   * 循环翻到 `hasMore === false` 为止，期间由 UiStore 记录「正在升级」以显示进度。
   *
   * 三道安全闸（与 `ViewStore` 的加载代号协同）：
   * 1. **取消**：每轮开始校验 `filterLoadingAll`——取消按钮 / 清空条件会把它置 false，循环随即退出；
   * 2. **作废**：每轮校验 `loadGeneration`——`refresh()` 或条件重置会自增代号，使在途升级立即失效
   *    （杜绝「刷新与在途升级互相污染」）；
   * 3. **失败中止**：`loadMore` 失败会置 `loadMoreFailed`，本循环**立即中止 + 提示**，
   *    绝不让部分结果伪装成「已加载全部」。
   *
   * ⚠️ 无论成功 / 取消 / 异常都必须 `endFilterLoadAll()`，否则 UI 会永久停留在进度态。
   *
   * @param silent 静默模式（数据量 ≤ 阈值）：不显示进度 / 取消按钮，但加载行为完全一致。
   */
  const handleLoadAll = useCallback(async (silent: boolean): Promise<void> => {
    if (useUiStore.getState().filterLoadingAll) return;
    const startState = useViewStore.getState();
    // ⚠️ 这里**不**校验 `dataSource`：手动按钮是既有基线路径（其可达性已由 `hasMore` 保证，
    //    且 `loadMore` 自身对缺失数据源是安全 no-op）；数据源就绪与否只约束**自动触发**（见下方 effect）。
    if (!startState.hasMore) return;
    const startedFrom = startState.records.length;
    useUiStore.getState().beginFilterLoadAll(startedFrom, silent);
    const generation = startState.loadGeneration;
    let failed = false;
    try {
      for (let page = 0; page < MAX_LOAD_ALL_PAGES; page += 1) {
        if (!useUiStore.getState().filterLoadingAll) break; // 取消 / 条件清空
        if (useViewStore.getState().loadGeneration !== generation) break; // 刷新 / 条件重置作废
        if (!useViewStore.getState().hasMore) break; // 已到底
        await useViewStore.getState().loadMore();
        const after = useViewStore.getState();
        if (after.loadGeneration !== generation) break;
        if (after.loadMoreFailed) {
          failed = true;
          break;
        }
        if (!after.hasMore) break;
      }
    } finally {
      useUiStore.getState().endFilterLoadAll();
      if (failed) useUiStore.getState().showToast('加载全部数据失败，请稍后重试');
    }
  }, []);

  /** 取消「加载全部」：停止循环 + 作废在途批次（已加载的记录保留） */
  const handleCancelLoadAll = useCallback((): void => {
    useUiStore.getState().endFilterLoadAll();
    useViewStore.getState().bumpLoadGeneration();
  }, []);

  /**
   * 自动全量加载：**筛选或搜索「变为生效」时**触发（用户已拍板）。
   *
   * - 未生效不做任何事；**清空**筛选 / 搜索（生效 → 失效）时反而**作废在途批次**并停止升级
   *   （条件已重置，继续拉全量没有意义）；
   * - 仅在真实数据源就绪时触发（`dataSource` 为空=未初始化/测试环境，不触发）；
   * - 阈值：`totalKnown && total ≤ 阈值` → 静默全量（不打扰）；否则显示进度 + 取消按钮。
   *
   * 触发点刻意放在 **`ViewShell`**：`handleLoadAll` 与状态行都在这层，避免把加载编排下沉到 store。
   */
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const active = visible.hasFilter || visible.hasSearch;
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active && !wasActive) {
      const view = useViewStore.getState();
      if (!view.dataSource || !view.hasMore) return;
      const silent = view.totalKnown && view.total <= AUTO_LOAD_ALL_SILENT_THRESHOLD;
      void handleLoadAll(silent);
    } else if (!active && wasActive) {
      // 条件重置（清空筛选 / 搜索）：作废在途批次并停止升级，避免无谓拉取
      useViewStore.getState().bumpLoadGeneration();
      useUiStore.getState().endFilterLoadAll();
    }
  }, [visible.hasFilter, visible.hasSearch, handleLoadAll]);

  const handleLoadAllClick = useCallback((): void => {
    void handleLoadAll(false);
  }, [handleLoadAll]);

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
              onClick={handleLoadAllClick}
            >
              {scopeStatus.upgradeLabel}
            </button>
          ) : null}
          {filterLoadingAll && !filterLoadAllSilent ? (
            <button
              type="button"
              className="cbv-btn cbv-link-btn"
              data-testid="filter-load-all-cancel"
              onClick={handleCancelLoadAll}
            >
              取消加载
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
