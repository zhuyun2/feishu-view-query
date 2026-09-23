/**
 * QA 独立复核（F5 · 工具栏接入 + 筛选防抖持久化）——**证伪向**，实现方不得修改。
 *
 * 与工程师自写的 `toolbarFilter.f5.test.tsx` **互不引用**（避免「验证者横向通气」摧毁双盲，§0.2.1）。
 * 覆盖：
 *  B. 面板挂载：点「筛选」→ 真实渲染 `FilterPanel`（条件行/添加条件/清空），旧文案彻底消失；
 *     「排序」仍是说明面板；徽标 `筛选 (n)` 三档；`aria-label` / `data-testid` 与实际状态一致。
 *  C. 持久化 8 条：防抖**次数**、`unsupportedNewer` / `canEditConfig` 不写入、
 *     **定时期间状态变化**的二次校验（权限被收回 / config 被远端刷新）、初始化装载不回写
 *     （**内容比较而非引用比较**）、dirty 门槛另一半、写入载荷 `{...config, filter}`、失败不致命。
 *  D. 跨层：无效条件（数字字段 + `contains`）→ `ViewShell` 状态行出现「未生效」（§22.5.6 底线的最终落点）。
 *
 * 环境约定同本仓既有组件测试：无 @testing-library/react，用 `createRoot` + `act` 直出 DOM；
 * 假定时器只伪造 `setTimeout/clearTimeout`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { Toolbar } from '@/components/layout/Toolbar';
import { defaultCardLayout, defaultDensity, defaultTheme } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FilterCondition, FilterConfig, FilterConjunction, FilterOperator } from '@/filter/types';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import type { ThemeTokens } from '@/hooks/useThemeTokens';
import {
  FILTER_PERSIST_DEBOUNCE_MS,
  buildFilterPersistPayload,
  filterConfigEquals,
  shouldPersistFilter,
} from '@/hooks/useFilterPersistence';

/** 捕获网格收到的记录（工厂提升，状态放 `vi.hoisted`），避免 jsdom 下虚拟滚动把断言行数变成恒真 */
const fake = vi.hoisted(() => ({ gridRecords: [] as string[] }));

vi.mock('@/components/grid/VirtualCardGrid', () => ({
  VirtualCardGrid: (props: { records?: readonly { recordId: string }[] }) => {
    fake.gridRecords = (props.records ?? []).map((record) => record.recordId);
    return <div data-testid="fake-grid" />;
  },
}));

const { ViewShell } = await import('@/components/layout/ViewShell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];

const fieldsById: Record<string, FieldMetaLite> = { f_title: metas[0], f_amount: metas[1] };

const records: SdkRecord[] = [
  { recordId: 'r1', fields: { f_title: '甲方案', f_amount: 100 } } as unknown as SdkRecord,
];

const EMPTY_FILTER: FilterConfig = { enabled: true, conjunction: 'and', conditions: [] };

function cond(conditionId: string, fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  return { conditionId, fieldId, operator, value };
}

function makeFilter(conditions: FilterCondition[], conjunction: FilterConjunction = 'and'): FilterConfig {
  return { enabled: true, conjunction, conditions };
}

function makeConfig(filter: FilterConfig): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: {
      configId: 'view_qa2',
      tableId: 'tbl_qa2',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'u_qa2',
      templateId: 'standard',
    },
    card: defaultCardLayout(metas),
    detail: { mode: 'doc', doc: { blocks: [], pageSize: 'A4', orientation: 'portrait' } } as unknown as CardViewConfig['detail'],
    theme: defaultTheme(),
    density: defaultDensity(),
    highlightRules: [],
    filter,
  };
}

interface ResetOptions {
  filter: FilterConfig;
  configFilter: FilterConfig;
  filterTouched?: boolean;
  canEditConfig?: boolean;
  unsupportedNewer?: boolean;
}

function resetStores(options: ResetOptions): void {
  useViewStore.setState({
    status: 'browse',
    viewName: '订单视图',
    fields: metas,
    fieldsById,
    records,
    total: 3,
    hasMore: false,
    loadingMore: false,
    config: makeConfig(options.configFilter),
    canEditConfig: options.canEditConfig ?? true,
    unsupportedNewer: options.unsupportedNewer ?? false,
    degraded: false,
    corrupted: false,
    configCorrupted: false,
    provisionedFromTemplate: false,
    copyScenario: false,
  });
  useUiStore.setState({
    searchQuery: '',
    editorOpen: false,
    toast: null,
    copyBannerDismissed: false,
    hover: { recordId: null, anchor: null },
    filter: options.filter,
    filterTouched: options.filterTouched ?? false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
  });
}

/* ===================== 渲染工具 ===================== */

interface Mounted {
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  click: (testId: string) => void;
  unmount: () => void;
}

/**
 * 已挂载实例登记表：断言失败会跳过 `view.unmount()`，若不在 `afterEach` 兜底卸载，
 * 泄漏的组件会订阅 zustand——下一个用例 `resetStores()` 触发其 effect 重排定时器，
 * 定时器回调经 `getState()` 打到**下一个用例**的 persist mock 上（假红噪声）。
 * 这是测试卫生问题，非产品缺陷，但会让变异结果不可读，故统一兜底。
 */
const liveMounted: Array<() => void> = [];

function mount(node: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  let alive = true;
  const unmount = (): void => {
    if (!alive) return;
    alive = false;
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  liveMounted.push(unmount);
  return {
    root,
    container,
    html: () => container.innerHTML,
    find: (testId) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    click: (testId) => {
      const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      expect(el, `找不到 ${testId}`).not.toBeNull();
      act(() => {
        el?.click();
      });
    },
    unmount,
  };
}

afterEach(() => {
  // 兜底卸载所有仍存活的实例（幂等），防止失败用例泄漏组件污染后续用例
  for (const unmount of liveMounted.splice(0)) unmount();
});

function mountToolbar(): Mounted {
  return mount(<Toolbar countLabel="共 3 条" onOpenConfig={() => undefined} />);
}

/** 每测试前基线；`persist` 一律用 mock，避免触碰真实仓储 */
function armPersist(mock: ReturnType<typeof vi.fn>): void {
  useViewStore.setState({ persistConfig: mock as unknown as (config: CardViewConfig) => Promise<{ ok: boolean }> });
}

/* =====================================================================
 * B. 面板挂载（用户实际点到的入口）
 * ===================================================================== */

describe('QA2 · F5 面板挂载', () => {
  beforeEach(() => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
  });

  it('点「筛选」→ 渲染 FilterPanel 的**具体结构**（条件行/添加条件/清空），且旧文案彻底消失', () => {
    resetStores({ filter: makeFilter([cond('c1', 'f_title', 'contains', '甲')]), configFilter: EMPTY_FILTER });
    armPersist(vi.fn().mockResolvedValue({ ok: true }));
    const view = mountToolbar();

    // 折叠态：面板与旧说明面板都不存在
    expect(view.find('filter-panel')).toBeNull();
    expect(view.find('filter-add-condition')).toBeNull();

    view.click('toolbar-filter');

    // 断言面板内真实结构（不是「面板容器存在」这种恒真弱断言）
    expect(view.find('filter-panel')).not.toBeNull();
    expect(view.find('filter-add-condition')).not.toBeNull();
    expect(view.find('filter-clear')).not.toBeNull();
    expect(view.find('filter-condition-row')).not.toBeNull(); // 具体到「有 1 条条件行」

    // 反号：旧的「沿用原生筛选」纯文案必须消失（同时防「新旧面板并存」）
    expect(view.html()).not.toContain('原生筛选');
    expect(view.html()).not.toContain('修改筛选条件');
    expect(view.html()).not.toContain('cbv-note-panel');
    view.unmount();
  });

  it('0 条件 → 面板出现「暂无筛选条件」空提示，且**没有**条件行', () => {
    armPersist(vi.fn().mockResolvedValue({ ok: true }));
    const view = mountToolbar();
    view.click('toolbar-filter');
    expect(view.find('filter-empty-hint')).not.toBeNull();
    expect(view.find('filter-condition-row')).toBeNull();
    view.unmount();
  });

  it('点「排序」→ 仍是**说明面板**（未被误删），且不渲染 FilterPanel', () => {
    armPersist(vi.fn().mockResolvedValue({ ok: true }));
    const view = mountToolbar();
    const sort = Array.from(view.container.querySelectorAll<HTMLButtonElement>('.cbv-toolbar .cbv-btn')).find(
      (button) => button.textContent === '排序',
    );
    expect(sort).toBeTruthy();
    act(() => {
      sort?.click();
    });
    expect(view.html()).toContain('cbv-note-panel');
    expect(view.html()).toContain('沿用表格视图的');
    expect(view.html()).toContain('修改排序');
    expect(view.find('filter-panel')).toBeNull();
    view.unmount();
  });

  it('徽标 `筛选 (n)` 三档：0 →「筛选」，1 →「筛选 (1)」，2 →「筛选 (2)」', () => {
    armPersist(vi.fn().mockResolvedValue({ ok: true }));
    // 0 条
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    let view = mountToolbar();
    expect(view.find('toolbar-filter')?.textContent).toBe('筛选');
    view.unmount();
    // 1 条
    resetStores({ filter: makeFilter([cond('c1', 'f_title', 'contains', '甲')]), configFilter: EMPTY_FILTER });
    view = mountToolbar();
    expect(view.find('toolbar-filter')?.textContent).toBe('筛选 (1)');
    view.unmount();
    // 2 条
    resetStores({
      filter: makeFilter([cond('c1', 'f_title', 'contains', '甲'), cond('c2', 'f_amount', 'is', 100)]),
      configFilter: EMPTY_FILTER,
    });
    view = mountToolbar();
    expect(view.find('toolbar-filter')?.textContent).toBe('筛选 (2)');
    view.unmount();
  });

  it('aria-label / data-testid 与实际状态一致（随条件数与开合变化）', () => {
    armPersist(vi.fn().mockResolvedValue({ ok: true }));
    resetStores({
      filter: makeFilter([cond('c1', 'f_title', 'contains', '甲'), cond('c2', 'f_amount', 'is', 100)]),
      configFilter: EMPTY_FILTER,
    });
    const view = mountToolbar();
    const button = view.find('toolbar-filter');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-testid')).toBe('toolbar-filter');
    expect(button?.getAttribute('aria-label')).toBe('筛选（已启用 2 个条件）');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.className).toContain('cbv-btn--active');

    view.click('toolbar-filter');
    expect(view.find('toolbar-filter')?.getAttribute('aria-expanded')).toBe('true');
    view.unmount();
  });
});

/* =====================================================================
 * C. 防抖持久化（§22.5.4 / §22.6）
 * ===================================================================== */

describe('QA2 · F5 防抖持久化', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushDebounce(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(FILTER_PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /* ---- C1 防抖：锁定**调用次数** ---- */
  it('C1 连续 3 次变更 → persistConfig **恰好 1 次**，且写入最新值', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '一')])));
    act(() => vi.advanceTimersByTime(150));
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '二')])));
    act(() => vi.advanceTimersByTime(150));
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '三')])));

    expect(persist).not.toHaveBeenCalled(); // 300ms 内被后续编辑重置，不应写
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0][0] as CardViewConfig).filter?.conditions[0].value).toBe('三');
    view.unmount();
  });

  /* ---- C2 unsupportedNewer：断言**未被调用**（不是「没报错」） ---- */
  it('C2 unsupportedNewer=true → persistConfig **未被调用**，但筛选仍即时生效', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, unsupportedNewer: true });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });

  /* ---- C3 canEditConfig=false：断言**未被调用** ---- */
  it('C3 canEditConfig=false → persistConfig **未被调用**，但筛选仍即时生效', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, canEditConfig: false });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });

  /* ---- C4 定时期间权限被收回 → 最终不写 ---- */
  it('C4 点击后、防抖窗口内权限被收回（canEditConfig → false）→ 最终**未写入**', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, canEditConfig: true });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    act(() => vi.advanceTimersByTime(200)); // 尚未到防抖终点
    act(() => useViewStore.setState({ canEditConfig: false })); // 窗口内权限变化
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    view.unmount();
  });

  /* ---- C4b 隔离「写入前二次校验读的是 fire 时刻状态」：config 在窗口内被远端刷新为与草稿一致 ----
   *   config **不是** effect 依赖 → 不会重排定时器；此例只有在「fire 时刻用**新鲜** config 重算」
   *   时才不写。若实现把 gate 决策**提前到排定时器那一刻**（用旧 config 判定），此例会**变红**。 */
  it('C4b 防抖窗口内 config 被刷新为与当前草稿一致 → **未写入**（证明 gate 在 fire 时刻重算）', async () => {
    const draft = makeFilter([cond('c1', 'f_title', 'contains', '甲')]);
    resetStores({ filter: draft, configFilter: EMPTY_FILTER, filterTouched: false }); // 排定时器时 dirty=true
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    act(() => vi.advanceTimersByTime(200)); // 定时器已排，尚未触发
    act(() => useViewStore.setState({ config: makeConfig(draft) })); // 远端同步落地：config.filter === draft
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    view.unmount();
  });

  /* ---- C5 初始化装载不回写（内容比较而非引用比较） ---- */
  it('C5 filter 与 config.filter **内容相同但引用不同** 且未 touched → **不回写**', async () => {
    const loaded = makeFilter([cond('c1', 'f_title', 'contains', '甲')]);
    resetStores({ filter: { ...loaded, conditions: [{ ...loaded.conditions[0] }] }, configFilter: loaded });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    await flushDebounce();
    expect(persist).not.toHaveBeenCalled();
    view.unmount();
  });

  /* ---- C6 dirty 门槛的另一半 ---- */
  it('C6 未 touched 但 filter ≠ config.filter → **写入 1 次**（证明门槛不是「只看 touched」）', async () => {
    resetStores({
      filter: makeFilter([cond('c1', 'f_title', 'contains', '甲')]),
      configFilter: EMPTY_FILTER,
      filterTouched: false,
    });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    await flushDebounce();
    expect(persist).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /* ---- C7 写入载荷 = {...config, filter}（config 其余分支必须原样保留） ---- */
  it('C7 写入载荷是 `{...config, filter}`：config 其余字段原样、filter 为当前草稿', async () => {
    const baseConfig = makeConfig(EMPTY_FILTER);
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    useViewStore.setState({ config: baseConfig });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    armPersist(persist);
    const view = mountToolbar();

    const next = makeFilter([cond('c1', 'f_title', 'contains', '甲')]);
    act(() => useUiStore.getState().setFilter(next));
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0][0] as CardViewConfig;
    // 逐字段：filter 被替换为当前草稿，其余配置（含 card/theme/density/meta）必须完整保留
    expect(payload.filter).toEqual(next);
    expect(payload.meta).toEqual(baseConfig.meta);
    expect(payload.card).toEqual(baseConfig.card);
    expect(payload.theme).toEqual(baseConfig.theme);
    expect(payload.density).toEqual(baseConfig.density);
    expect(payload.schemaVersion).toBe(2);
    expect(payload).toEqual({ ...baseConfig, filter: next });
    view.unmount();
  });

  /* ---- C8 失败不致命（抛异常） ---- */
  it('C8 persistConfig 抛异常 → 不崩溃、记录错误、筛选仍可用', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const persist = vi.fn().mockRejectedValue(new Error('network-down'));
    armPersist(persist);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    errorSpy.mockRestore();
    view.unmount();
  });
});

/* =====================================================================
 * C-extra. 纯函数：门槛顺序 / 语义比较 / 载荷（直接锁定，无需渲染）
 * ===================================================================== */

describe('QA2 · useFilterPersistence 纯函数门槛', () => {
  it('shouldPersistFilter：硬门槛（权限 / 更高版本）**先于** dirty 门槛', () => {
    const base = {
      canEditConfig: true,
      unsupportedNewer: false,
      filterTouched: true,
      current: EMPTY_FILTER,
      persisted: EMPTY_FILTER,
    };
    expect(shouldPersistFilter(base)).toBe(true);
    // touched=true 也压不过权限硬门槛
    expect(shouldPersistFilter({ ...base, canEditConfig: false })).toBe(false);
    expect(shouldPersistFilter({ ...base, unsupportedNewer: true })).toBe(false);
    // 未 touched 且内容相同 → 不写
    expect(shouldPersistFilter({ ...base, filterTouched: false })).toBe(false);
    // 未 touched 但内容不同 → 写
    expect(shouldPersistFilter({ ...base, filterTouched: false, current: makeFilter([cond('c1', 'f_title', 'is', 'x')]) })).toBe(true);
  });

  it('filterConfigEquals：键序无关的语义比较；null/undefined 归一等价', () => {
    expect(filterConfigEquals(makeFilter([cond('c1', 'f_title', 'contains', '甲')]), { conjunction: 'and', conditions: [{ value: '甲', operator: 'contains', fieldId: 'f_title', conditionId: 'c1' }], enabled: true })).toBe(true);
    expect(filterConfigEquals(null, undefined)).toBe(true);
    expect(filterConfigEquals(EMPTY_FILTER, makeFilter([cond('c1', 'f_title', 'is', 'x')]))).toBe(false);
  });

  it('buildFilterPersistPayload：config 未就绪 → null；就绪 → 整体替换 filter 分支', () => {
    expect(buildFilterPersistPayload(null, EMPTY_FILTER)).toBeNull();
    const cfg = makeConfig(EMPTY_FILTER);
    const next = makeFilter([cond('c1', 'f_title', 'contains', '甲')]);
    expect(buildFilterPersistPayload(cfg, next)).toEqual({ ...cfg, filter: next });
  });
});

/* =====================================================================
 * D. 跨层：无效条件 → ViewShell 状态行「未生效」（§22.5.6 最终落点）
 * ===================================================================== */

const tokens: ThemeTokens = {
  theme: defaultTheme(),
  density: defaultDensity(),
  hostTheme: 'light',
  titleLineHeight: '1.3',
};

function prepViewShell(filter: FilterConfig): void {
  useViewStore.setState({
    status: 'browse',
    fields: metas,
    fieldsById,
    records,
    total: 3,
    hasMore: false,
    loadingMore: false,
    config: makeConfig(EMPTY_FILTER),
    canEditConfig: true,
    unsupportedNewer: false,
    degraded: false,
    corrupted: false,
    configCorrupted: false,
    provisionedFromTemplate: false,
    copyScenario: false,
  });
  useUiStore.setState({
    searchQuery: '',
    editorOpen: false,
    toast: null,
    copyBannerDismissed: false,
    hover: { recordId: null, anchor: null },
    filter,
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
  });
  fake.gridRecords = [];
}

describe('QA2 · F5 跨层：无效条件必须由状态行显式告知', () => {
  it('数字字段 + contains（类型×算子不匹配）→ 状态行出现「1 个条件未生效」', () => {
    prepViewShell(makeFilter([cond('bad', 'f_amount', 'contains', '1')]));
    const view = mount(<ViewShell tokens={tokens} />);
    const scopeText = view.find('filter-scope-text')?.textContent ?? '';
    expect(scopeText).toContain('未生效');
    expect(scopeText).toContain('1 个条件未生效');
    view.unmount();
  });

  it('反号：全部条件有效 → 状态行**不得**出现「未生效」', () => {
    prepViewShell(makeFilter([cond('ok', 'f_title', 'contains', '甲')]));
    const view = mount(<ViewShell tokens={tokens} />);
    const scopeText = view.find('filter-scope-text')?.textContent ?? '';
    expect(scopeText).toContain('命中 1 条');
    expect(scopeText).not.toContain('未生效');
    view.unmount();
  });
});
