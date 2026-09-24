/**
 * 工程师 · 自动全量加载 + 取消 + 竞态（行为级，ViewShell ↔ 真实 ViewStore.loadMore）。
 *
 * 覆盖验收：
 *  - 筛选/搜索「变为生效」→ 自动全量加载（小表静默，直接拉完）；
 *  - 未生效 / 清空 → **不触发**；
 *  - 取消加载 → 停止循环并作废在途批次（已加载记录保留）；
 *  - 失败 → 立即中止 + 提示（不静默继续）。
 *
 * ⚠️ 与既有 F3 测试同构：mock `VirtualCardGrid`（jsdom 下 @tanstack/react-virtual 行数不可靠），
 *    本文件只断言**行为与文案**，不触碰网格内部。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { defaultCardLayout, defaultDensity, defaultTheme } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FilterConfig } from '@/filter/types';
import type { PageResult, RecordDataSource } from '@/data/RecordDataSource';
import type { EnvSnapshot } from '@/sdk/env';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import type { ThemeTokens } from '@/hooks/useThemeTokens';

vi.mock('@/components/grid/VirtualCardGrid', () => ({
  VirtualCardGrid: () => <div data-testid="fake-grid" />,
}));

const { ViewShell } = await import('@/components/layout/ViewShell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];
const fieldsById: Record<string, FieldMetaLite> = { f_title: metas[0], f_amount: metas[1] };

const ENV: EnvSnapshot = {
  productType: 'web',
  language: 'zh-CN',
  theme: 'light',
  tableId: 'tbl_auto',
  viewId: 'view_auto',
  appId: 'app_auto',
  userId: 'u_auto',
};

const EMPTY_FILTER: FilterConfig = { enabled: true, conjunction: 'and', conditions: [] };
const TITLE_FILTER: FilterConfig = {
  enabled: true,
  conjunction: 'and',
  conditions: [{ conditionId: 'c1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
};

function rec(id: string): SdkRecord {
  return { recordId: id, fields: { f_title: `甲-${id}` } } as unknown as SdkRecord;
}

function makeConfig(): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: { configId: 'view_auto', tableId: 'tbl_auto', createdAt: 0, updatedAt: 0, updatedBy: 'u', templateId: 'standard' },
    card: defaultCardLayout(metas),
    detail: { mode: 'doc', doc: { blocks: [], pageSize: 'A4', orientation: 'portrait' } } as unknown as CardViewConfig['detail'],
    theme: defaultTheme(),
    density: defaultDensity(),
    highlightRules: [],
    filter: EMPTY_FILTER,
  };
}

const tokens: ThemeTokens = { theme: defaultTheme(), density: defaultDensity(), hostTheme: 'light', titleLineHeight: '1.3' };

function fakeDataSource(loadPage: (q: unknown) => Promise<PageResult>): RecordDataSource {
  return {
    loadPage: loadPage as RecordDataSource['loadPage'],
    loadRecord: async () => null,
    count: async () => 0,
    countSafe: async () => ({ total: 0, totalKnown: false }),
    getVisibleRecordIds: async () => [],
    clearCache: () => undefined,
  };
}

interface ResetOptions {
  dataSource: RecordDataSource;
  records: SdkRecord[];
  hasMore: boolean;
  total: number;
  totalKnown: boolean;
}

function resetStores(o: ResetOptions): void {
  useViewStore.setState({
    status: 'browse',
    viewName: '视图',
    fields: metas,
    fieldsById,
    records: o.records,
    total: o.total,
    totalKnown: o.totalKnown,
    hasMore: o.hasMore,
    nextPageToken: o.hasMore ? 'p2' : null,
    loadingMore: false,
    loadGeneration: 0,
    loadMoreFailed: false,
    config: makeConfig(),
    dataSource: o.dataSource,
    env: ENV,
    degraded: false,
    corrupted: false,
    configCorrupted: false,
    unsupportedNewer: false,
    canEditConfig: true,
    provisionedFromTemplate: false,
    copyScenario: false,
  });
  useUiStore.setState({
    searchQuery: '',
    editorOpen: false,
    toast: null,
    filter: EMPTY_FILTER,
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
    filterLoadAllSilent: false,
    hover: { recordId: null, anchor: null },
  });
}

/* ===================== 渲染 / 冲刷工具 ===================== */

interface Mounted {
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  click: (testId: string) => void;
  unmount: () => void;
}

function mount(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let disposed = false;
  const view: Mounted = {
    html: () => container.innerHTML,
    find: (testId) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    click: (testId) => {
      const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      act(() => {
        el?.click();
      });
    },
    unmount: () => {
      if (disposed) return;
      disposed = true;
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
  act(() => {
    root.render(<ViewShell tokens={tokens} />);
  });
  return view;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* ===================== 自动全量：触发 / 不触发 ===================== */

describe('自动全量加载：筛选生效时触发', () => {
  it('筛选变为生效（小表 ≤ 阈值）→ 静默拉完全部并升级为「全部」口径', async () => {
    const loadPage = vi.fn().mockResolvedValue({ records: [rec('r2'), rec('r3')], pageToken: null, hasMore: false, total: 3 });
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 3, totalKnown: true });

    const view = mount();
    await flush();
    expect(loadPage).not.toHaveBeenCalled(); // 未生效 → 不触发

    act(() => useUiStore.getState().setFilter(TITLE_FILTER));
    await flush();

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(useViewStore.getState().hasMore).toBe(false);
    expect(useViewStore.getState().records.map((r) => r.recordId)).toEqual(['r1', 'r2', 'r3']);
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    // 已加载全部 → 状态行允许称「全部」
    expect(view.html()).toContain('已在全部 3 条中筛选');
    view.unmount();
  });

  it('清空筛选：不触发加载，且不新增请求', async () => {
    const loadPage = vi.fn().mockResolvedValue({ records: [rec('r2')], pageToken: null, hasMore: false, total: 2 });
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 2, totalKnown: true });

    const view = mount();
    await flush();
    expect(loadPage).not.toHaveBeenCalled();

    act(() => useUiStore.getState().setFilter(TITLE_FILTER)); // 生效 → 触发一次
    await flush();
    expect(loadPage).toHaveBeenCalledTimes(1);

    act(() => useUiStore.getState().clearFilter()); // 清空 → 不触发
    await flush();
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    view.unmount();
  });

  it('无数据源（未初始化）→ 不触发（不因筛选生效而误触）', async () => {
    const loadPage = vi.fn().mockResolvedValue({ records: [], pageToken: null, hasMore: false, total: 0 });
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 3, totalKnown: true });
    useViewStore.setState({ dataSource: null, env: null });

    const view = mount();
    act(() => useUiStore.getState().setFilter(TITLE_FILTER));
    await flush();
    expect(loadPage).not.toHaveBeenCalled();
    view.unmount();
  });
});

/* ===================== 取消 & 竞态 ===================== */

describe('取消加载（竞态）', () => {
  it('点击取消 → 停止升级并作废在途批次（不追加记录）', async () => {
    // 每批都挂起，且返回 hasMore=true —— 若「取消」被忽略，循环会继续并追加记录 → 断言变红
    const pendingResolvers: Array<(p: PageResult) => void> = [];
    const loadPage = vi.fn(
      () => new Promise<PageResult>((resolve) => pendingResolvers.push(resolve)),
    );
    const ds = fakeDataSource(loadPage);
    // total > 阈值 → 非静默（显示进度 + 取消按钮）
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(TITLE_FILTER));
    await flush();

    // 非静默：应出现取消按钮与进度
    expect(view.find('filter-load-all-cancel')).not.toBeNull();
    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    const genAfterStart = useViewStore.getState().loadGeneration;

    view.click('filter-load-all-cancel');
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(useViewStore.getState().loadGeneration).toBe(genAfterStart + 1); // 作废在途

    const before = useViewStore.getState().records.length;
    // 释放被取消的在途批次（hasMore=true：正常实现必须作废、不追加）
    await act(async () => {
      pendingResolvers[0]?.({ records: [rec('rX')], pageToken: 'p3', hasMore: true, total: 12480 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useViewStore.getState().records.length).toBe(before); // 未追加
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(1); // 未继续翻页
    view.unmount();
  });

  it('仅翻转取消标志（**不动**加载代号）→ 循环也必须立即停止（取消闸门独立生效）', async () => {
    // 目的：把「取消闸门」与「代号作废」拆开验证——本用例只让 filterLoadingAll 变 false，
    // 代号保持不变，从而排除「靠代号兜底」的假通过；若循环忽略取消标志，会继续第二次翻页 → 变红。
    const pendingResolvers: Array<(p: PageResult) => void> = [];
    const loadPage = vi.fn(() => new Promise<PageResult>((resolve) => pendingResolvers.push(resolve)));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(TITLE_FILTER));
    await flush();

    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    const genBefore = useViewStore.getState().loadGeneration;

    // 只清掉取消标志（等价于「取消」语义），**不**推进代号
    act(() => useUiStore.getState().endFilterLoadAll());
    expect(useViewStore.getState().loadGeneration).toBe(genBefore); // 代号未变：排除代号兜底

    // 释放挂起的批次并返回 hasMore=true：若取消标志被忽略，循环会再次 loadPage → 变红
    await act(async () => {
      pendingResolvers[0]?.({ records: [rec('rX')], pageToken: 'p3', hasMore: true, total: 12480 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadPage).toHaveBeenCalledTimes(1); // 取消标志生效 → 未继续翻页
    view.unmount();
  });

  it('loadMore 失败 → 立即中止并提示（不把部分结果伪装成全量）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadPage = vi.fn().mockRejectedValue(new Error('network'));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, records: [rec('r1')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(TITLE_FILTER));
    await flush();

    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(useUiStore.getState().toast).toContain('加载全部数据失败');
    // 仍然未加载全部 → 状态行必须继续诚实标注
    expect(view.html()).toContain('未加载全部');
    expect(loadPage).toHaveBeenCalledTimes(1); // 失败即止，不空转
    errorSpy.mockRestore();
    view.unmount();
  });
});
