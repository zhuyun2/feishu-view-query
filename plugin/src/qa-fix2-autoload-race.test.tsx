/**
 * QA（qa-fix2-batch）· **独立证伪**：自动全量加载 / 取消 / 竞态（行为级）。
 *
 * 独立重写，不复用实现方的 `autoLoadAll.test.tsx`。断言以「请求次数 + 记录序列 + 逐字文案 +
 * 代号（generation）」为准，并用可控 deferred 数据源制造**批次重叠**（不靠 sleep 计时）。
 *
 * 覆盖：
 *  - 筛选 / 搜索「变为生效」触发 vs 未生效不触发 vs 清空不触发；
 *  - 静默阈值（≤2000 静默 / >2000 显示进度 + 取消）；
 *  - 加载中改变条件 → 结果必须用**最新条件**重算；
 *  - 取消 / refresh 使在途批次作废（不掺杂、不推进游标）；
 *  - 失败立即中止且不伪装成「已全部加载」；
 *  - **手动**升级入口（阻断自动触发后单独验证）仍可用。
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
  tableId: 'tbl_qa2auto',
  viewId: 'view_qa2auto',
  appId: 'app_qa2auto',
  userId: 'u_qa2auto',
};

const EMPTY_FILTER: FilterConfig = { enabled: true, conjunction: 'and', conditions: [] };
function titleFilter(keyword: string): FilterConfig {
  return {
    enabled: true,
    conjunction: 'and',
    conditions: [{ conditionId: `c_${keyword}`, fieldId: 'f_title', operator: 'contains', value: keyword }],
  };
}
/** 有 conditions 但显式 enabled=false → isFilterActive 为假（「未生效」的一种，实现方未覆盖） */
const DISABLED_FILTER: FilterConfig = { ...titleFilter('甲'), enabled: false };

function rec(id: string, title = ''): SdkRecord {
  return { recordId: id, fields: { f_title: title } } as unknown as SdkRecord;
}

function makeConfig(): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: { configId: 'view_qa2auto', tableId: 'tbl_qa2auto', createdAt: 0, updatedAt: 0, updatedBy: 'u', templateId: 'standard' },
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface ResetOptions {
  dataSource: RecordDataSource | null;
  env: EnvSnapshot | null;
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
    env: o.env,
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

/* ===================== ① 触发条件 ===================== */

describe('① 自动全量：触发 / 不触发', () => {
  it('筛选「变为生效」（小表 ≤ 阈值）→ 静默拉完，状态行升级为「全部」口径', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn(() => d.promise);
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲-1')], hasMore: true, total: 3, totalKnown: true });

    const view = mount();
    await flush();
    expect(loadPage.mock.calls.length).toBe(0); // 未生效 → 不触发

    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();
    expect(loadPage.mock.calls.length).toBe(1);
    // 加载中观察「静默」：正在升级、静默标记为真、无取消/进度按钮
    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    expect(useUiStore.getState().filterLoadAllSilent).toBe(true);
    expect(view.find('filter-load-all-cancel')).toBeNull();
    expect(view.find('filter-load-all-progress')).toBeNull();

    d.resolve({ records: [rec('r2', '甲-2'), rec('r3', '甲-3')], pageToken: null, hasMore: false, total: 3 });
    await flush();

    expect(useViewStore.getState().records.map((r) => r.recordId)).toEqual(['r1', 'r2', 'r3']);
    expect(useViewStore.getState().hasMore).toBe(false);
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(view.html()).toContain('已在全部 3 条中筛选');
    view.unmount();
  });

  it('「有 conditions 但 enabled=false」→ 未生效：绝不触发（实现方未覆盖的组合）', async () => {
    const loadPage = vi.fn(async () => ({ records: [], pageToken: null, hasMore: false, total: 3 }));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 3, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(DISABLED_FILTER));
    await flush();

    expect(loadPage.mock.calls.length).toBe(0);
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    // 也不应渲染覆盖状态行（无收窄）
    expect(view.html()).not.toContain('data-testid="filter-scope"');
    view.unmount();
  });

  it('搜索单独「变为生效」→ 触发；清空搜索 → 不触发新请求', async () => {
    const loadPage = vi.fn(async () => ({ records: [rec('r2', '甲')], pageToken: null, hasMore: false, total: 2 }));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 2, totalKnown: true });

    const view = mount();
    await flush();
    expect(loadPage.mock.calls.length).toBe(0);

    act(() => useUiStore.getState().setSearchQuery('甲'));
    await flush();
    expect(loadPage.mock.calls.length).toBe(1);

    act(() => useUiStore.getState().setSearchQuery(''));
    await flush();
    expect(loadPage.mock.calls.length).toBe(1); // 清空不触发
    view.unmount();
  });

  it('无数据源（未初始化）→ 筛选生效也不误触', async () => {
    const loadPage = vi.fn(async () => ({ records: [], pageToken: null, hasMore: false, total: 3 }));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 3, totalKnown: true });
    useViewStore.setState({ dataSource: null, env: null });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();
    expect(loadPage.mock.calls.length).toBe(0);
    view.unmount();
  });
});

/* ===================== ② 静默阈值 ===================== */

describe('② 静默阈值：≤2000 静默 / >2000 显示进度 + 取消', () => {
  it('total=2000（边界含）→ 静默：无取消按钮、无进度文案', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn(() => d.promise);
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 2000, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();

    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    expect(useUiStore.getState().filterLoadAllSilent).toBe(true);
    expect(view.find('filter-load-all-cancel')).toBeNull();
    expect(view.find('filter-load-all-progress')).toBeNull();
    d.resolve({ records: [], pageToken: null, hasMore: false, total: 2000 });
    await flush();
    view.unmount();
  });

  it('total=2001 → 非静默：出现取消按钮与进度文案', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn(() => d.promise);
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 2001, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();

    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    expect(useUiStore.getState().filterLoadAllSilent).toBe(false);
    expect(view.find('filter-load-all-cancel')).not.toBeNull();
    expect(view.find('filter-load-all-progress')).not.toBeNull();
    d.resolve({ records: [], pageToken: null, hasMore: false, total: 2001 });
    await flush();
    view.unmount();
  });

  it('总数未知（totalKnown=false）→ 不静默（不敢假设量小）', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn(() => d.promise);
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 0, totalKnown: false });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();
    expect(useUiStore.getState().filterLoadAllSilent).toBe(false);
    d.resolve({ records: [], pageToken: null, hasMore: false, total: 0 });
    await flush();
    view.unmount();
  });
});

/* ===================== ③ 加载中改变条件 → 用最新条件重算 ===================== */

describe('③ 加载中改变筛选条件 → 结果必须用最新条件重算', () => {
  it('A→B 期间在途批次落地后，命中数必须是 B 的（不得沿用旧条件）', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn(() => d.promise);
    const ds = fakeDataSource(loadPage);
    // 初始只有 p('甲')；在途批次带来 q('乙') 与 r('甲')
    resetStores({ dataSource: ds, env: ENV, records: [rec('p', '甲')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲'))); // 触发（非静默）
    await flush();
    expect(loadPage.mock.calls.length).toBe(1);

    // 加载中把条件改为「乙」；hasFilter 仍为 true → 不应重复触发
    act(() => useUiStore.getState().setFilter(titleFilter('乙')));
    await flush();
    expect(loadPage.mock.calls.length).toBe(1);

    d.resolve({ records: [rec('q', '乙'), rec('r', '甲')], pageToken: null, hasMore: false, total: 12480 });
    await flush();

    const st = useViewStore.getState();
    expect(st.records.map((x) => x.recordId)).toEqual(['p', 'q', 'r']);
    expect(st.hasMore).toBe(false);
    // 「甲」会命中 p/r = 2；「乙」只命中 q = 1。断言 1 才能证伪「沿用旧条件」。
    expect(view.html()).toContain('已在全部 12,480 条中筛选，命中 1 条');
    expect(view.html()).not.toContain('命中 2 条');
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    view.unmount();
  });
});

/* ===================== ④ 取消 / 竞态 ===================== */

describe('④ 取消与竞态', () => {
  it('点击取消 → 作废在途批次、不追加、不继续翻页', async () => {
    const resolvers: Array<(p: PageResult) => void> = [];
    const loadPage = vi.fn(() => new Promise<PageResult>((resolve) => resolvers.push(resolve)));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();

    expect(view.find('filter-load-all-cancel')).not.toBeNull();
    const genBefore = useViewStore.getState().loadGeneration;

    view.click('filter-load-all-cancel');
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(useViewStore.getState().loadGeneration).toBe(genBefore + 1);

    const before = useViewStore.getState().records.length;
    await act(async () => {
      resolvers[0]?.({ records: [rec('rX', '甲')], pageToken: 'p3', hasMore: true, total: 12480 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useViewStore.getState().records.length).toBe(before); // 未追加
    expect(loadPage.mock.calls.length).toBe(1); // 未继续翻页
    view.unmount();
  });

  it('清空筛选 → 中止升级并作废在途批次（记录不掺杂）', async () => {
    const resolvers: Array<(p: PageResult) => void> = [];
    const loadPage = vi.fn(() => new Promise<PageResult>((resolve) => resolvers.push(resolve)));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();
    expect(useUiStore.getState().filterLoadingAll).toBe(true);

    act(() => useUiStore.getState().clearFilter());
    expect(useUiStore.getState().filterLoadingAll).toBe(false);

    await act(async () => {
      resolvers[0]?.({ records: [rec('rX', '甲')], pageToken: 'p3', hasMore: true, total: 12480 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useViewStore.getState().records.map((r) => r.recordId)).toEqual(['r1']);
    expect(loadPage.mock.calls.length).toBe(1);
    view.unmount();
  });

  it('加载中调 refresh() → 在途批次作废，refresh 结果获胜', async () => {
    const stale = deferred<PageResult>();
    const loadPage = vi.fn();
    loadPage
      .mockImplementationOnce(() => stale.promise) // 自动升级的在途批次
      .mockResolvedValueOnce({ records: [rec('fresh', '甲')], pageToken: null, hasMore: false, total: 1 }); // refresh 的首页
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();

    await act(async () => {
      await useViewStore.getState().refresh();
    });

    await act(async () => {
      stale.resolve({ records: [rec('stale', '甲')], pageToken: 'p9', hasMore: true, total: 99 });
      await Promise.resolve();
      await Promise.resolve();
    });

    const st = useViewStore.getState();
    expect(st.records.map((r) => r.recordId)).toEqual(['fresh']);
    expect(st.total).toBe(1);
    expect(st.hasMore).toBe(false);
    expect(loadPage.mock.calls.length).toBe(2);
    view.unmount();
  });
});

/* ===================== ⑤ 失败中止 ===================== */

describe('⑤ 加载失败 → 立即中止且不伪装成「已全部加载」', () => {
  it('loadMore 失败 → 保留「未加载全部」，提示 toast，且不空转', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadPage = vi.fn(async () => {
      throw new Error('network');
    });
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('r1', '甲')], hasMore: true, total: 12480, totalKnown: true });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();

    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(useUiStore.getState().toast).toContain('加载全部数据失败');
    expect(useViewStore.getState().hasMore).toBe(true); // 未伪装成已加载全部
    expect(view.html()).toContain('未加载全部');
    expect(loadPage.mock.calls.length).toBe(1); // 失败即止
    errorSpy.mockRestore();
    view.unmount();
  });
});

/* ===================== ⑥ 手动升级入口（阻断自动触发后单独验证） ===================== */

describe('⑥ 手动「加载全部并重新筛选」路径仍可用', () => {
  it('先无数据源避免自动触发，再恢复数据源并点按钮 → 正常拉完并升级口径', async () => {
    const loadPage = vi.fn(async () => ({ records: [rec('x', '甲')], pageToken: null, hasMore: false, total: 12480 }));
    const ds = fakeDataSource(loadPage);
    resetStores({ dataSource: ds, env: ENV, records: [rec('p1', '甲')], hasMore: true, total: 12480, totalKnown: true });
    // 阻断自动触发（dataSource 为空时 effect 直接 return）
    useViewStore.setState({ dataSource: null, env: null });

    const view = mount();
    act(() => useUiStore.getState().setFilter(titleFilter('甲')));
    await flush();
    expect(loadPage.mock.calls.length).toBe(0);

    // 恢复数据源（筛选未变 → 自动触发不重跑）
    act(() => useViewStore.setState({ dataSource: ds, env: ENV }));
    await flush();
    expect(loadPage.mock.calls.length).toBe(0);

    // 手动入口
    expect(view.find('filter-load-all')).not.toBeNull();
    view.click('filter-load-all');
    await flush();

    expect(loadPage.mock.calls.length).toBe(1);
    expect(useViewStore.getState().records.map((r) => r.recordId)).toEqual(['p1', 'x']);
    expect(useViewStore.getState().hasMore).toBe(false);
    expect(view.html()).toContain('已在全部 12,480 条中筛选，命中 2 条');
    expect(view.find('filter-load-all')).toBeNull(); // 已加载完 → 入口消失
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    view.unmount();
  });
});
