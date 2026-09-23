/**
 * 集成测试（工程师 · F5）——「工具栏接入筛选面板 + 防抖持久化」。
 *
 * ⭐ 断言纪律（团队禁令：禁止假绿）：每条断言都要能回答「把实现改坏，这条会不会红」。
 *    故本文件**不写**「面板存在」「保存被调用过」这类弱断言，一律断言
 *    **确切文案 / 确切计数 / 确切写入条件**。
 *
 * 覆盖：
 *  A. 点「筛选」→ 渲染 `FilterPanel`（且**旧说明文案不再出现**）；点「排序」→ 仍是说明面板（未误删）；
 *  B. 筛选按钮徽标 `筛选 (n)` 与 `aria-label`；
 *  C. 防抖持久化：连续变更**只写一次**、初始化装载**不回写**、
 *     `unsupportedNewer` / `canEditConfig=false` **不写入**、失败**不影响筛选使用**。
 *
 * 环境说明（与本仓既有组件测试一致）：无 `@testing-library/react`，
 * 沿用 `createRoot` + `act` 直出 DOM；假定时器仅伪造 `setTimeout/clearTimeout`
 * （不伪造 Date / 微任务，避免干扰 React 调度）。
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
import { FILTER_PERSIST_DEBOUNCE_MS } from '@/hooks/useFilterPersistence';

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
      configId: 'view_f5',
      tableId: 'tbl_f5',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'u_f5',
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
  /** 运行期筛选（`UiStore.filter`） */
  filter: FilterConfig;
  /** 已持久化筛选（`ViewStore.config.filter`） */
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
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  click: (testId: string) => void;
  unmount: () => void;
}

/**
 * 本文件内已挂载、尚未卸载的视图。
 *
 * ⭐ 测试卫生（非产品逻辑）：用例若在 `unmount()` 之前断言失败，`unmount()` 会被跳过，
 *    泄漏的组件会把**防抖定时器**打到后续用例的 `persistConfig` mock 上，
 *    让后续用例出现「假红 2/3/4 次」的幽灵失败——恰好在排障时最难分辨。
 *    故统一登记，由文件级 `afterEach` 兜底卸载（成功路径显式卸载后会自动移除）。
 */
const mountedViews: Mounted[] = [];

function mount(node: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let disposed = false;
  const view: Mounted = {
    html: () => container.innerHTML,
    find: (testId) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    click: (testId) => {
      const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      expect(el).not.toBeNull();
      act(() => {
        el?.click();
      });
    },
    // 幂等：成功路径已显式卸载过，兜底 afterEach 再调一次不得二次 unmount
    unmount: () => {
      if (disposed) return;
      disposed = true;
      act(() => {
        root.unmount();
      });
      container.remove();
      const index = mountedViews.indexOf(view);
      if (index >= 0) mountedViews.splice(index, 1);
    },
  };
  // 先登记再渲染：万一 render 抛错，兜底 afterEach 仍能清理
  mountedViews.push(view);
  act(() => {
    root.render(node);
  });
  return view;
}

/** 挂载工具栏（不传 onOpenConfig 的副作用） */
function mountToolbar(): Mounted {
  return mount(<Toolbar countLabel="共 3 条" onOpenConfig={() => undefined} />);
}

/**
 * 文件级兜底清理（**不改任何断言**）：无论用例成功或失败，都卸载残留组件、复位假定时器。
 * 断言语义完全不变——它只保证「失败时也不泄漏」，消除后续用例的幽灵假红。
 */
afterEach(() => {
  while (mountedViews.length > 0) mountedViews[mountedViews.length - 1].unmount();
  vi.useRealTimers();
});

/* ===================== A. 工具栏接入 ===================== */

describe('F5 · 工具栏「筛选」接入 FilterPanel', () => {
  beforeEach(() => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
  });

  it('点「筛选」→ 渲染 FilterPanel（有「添加条件」），且**旧说明文案不再出现**', () => {
    const view = mountToolbar();
    // 折叠态：面板不存在
    expect(view.find('filter-panel')).toBeNull();

    view.click('toolbar-filter');

    // ⭐ 断言面板内的**具体结构**（能证伪「只换了容器、没挂组件」）
    expect(view.find('filter-panel')).not.toBeNull();
    expect(view.find('filter-add-condition')).not.toBeNull();
    expect(view.find('filter-clear')).not.toBeNull();
    // aria-expanded 反映展开
    expect(view.find('toolbar-filter')?.getAttribute('aria-expanded')).toBe('true');

    // ⭐ 反号：旧的「沿用原生筛选」纯文案必须**消失**（能证伪「新旧面板并存」）
    expect(view.html()).not.toContain('原生筛选');
    expect(view.html()).not.toContain('修改筛选条件');
    expect(view.html()).not.toContain('cbv-note-panel');
    view.unmount();
  });

  it('点「排序」→ 仍是**说明面板**（证明筛选替换未误删排序）', () => {
    const view = mountToolbar();
    const sortButton = Array.from(view.html().matchAll(/data-testid="([^"]+)"/g)).map((m) => m[1]);
    void sortButton;
    // 「排序」按钮无 testid，按文案定位
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.cbv-toolbar .cbv-btn'));
    const sort = buttons.find((button) => button.textContent === '排序');
    expect(sort).toBeTruthy();
    act(() => {
      sort?.click();
    });

    expect(view.html()).toContain('cbv-note-panel');
    expect(view.html()).toContain('沿用表格视图的');
    expect(view.html()).toContain('修改排序');
    expect(view.html()).toContain('知道了');
    // 排序面板不得变成筛选面板
    expect(view.find('filter-panel')).toBeNull();
    view.unmount();
  });
});

/* ===================== B. 筛选按钮徽标 / aria ===================== */

describe('F5 · 筛选按钮徽标与 aria', () => {
  it('无生效条件 → 文案「筛选」、aria-label「筛选」、**不带** active 类', () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const view = mountToolbar();
    const button = view.find('toolbar-filter');
    expect(button?.textContent).toBe('筛选');
    expect(button?.getAttribute('aria-label')).toBe('筛选');
    expect(button?.className).not.toContain('cbv-btn--active');
    view.unmount();
  });

  it('有 2 条条件 → 文案「筛选 (2)」、aria-label 含「已启用 2 个条件」、带 active 类', () => {
    resetStores({
      filter: makeFilter([cond('c1', 'f_title', 'contains', '甲'), cond('c2', 'f_amount', 'is', 100)]),
      configFilter: EMPTY_FILTER,
    });
    const view = mountToolbar();
    const button = view.find('toolbar-filter');
    expect(button?.textContent).toBe('筛选 (2)');
    expect(button?.getAttribute('aria-label')).toBe('筛选（已启用 2 个条件）');
    expect(button?.className).toContain('cbv-btn--active');
    view.unmount();
  });
});

/* ===================== C. 防抖持久化 ===================== */

describe('F5 · 筛选防抖持久化（§22.5.4）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  /*
   * ⚠️ 假定时器的复位统一交给**文件级** `afterEach`（见上）：它在卸载残留组件**之后**才
   *    `vi.useRealTimers()`，保证 effect 清理函数拿到的仍是当初创建该定时器的 API。
   *    此处不再重复复位，避免两处 afterEach 的执行顺序影响清理时机。
   */

  /** 冲刷防抖定时器 + 微任务（persistConfig 是 Promise） */
  async function flushDebounce(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(FILTER_PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('连续 3 次变更 → 只触发**一次**保存，且写入最新 filter（能证伪「每次立即保存」）', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();

    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    act(() => vi.advanceTimersByTime(200));
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '乙')])));
    act(() => vi.advanceTimersByTime(200));
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '丙')])));

    // ⭐ 400ms 内未到防抖终点（每次编辑都重置定时器）→ 一次都不该写
    expect(persist).not.toHaveBeenCalled();

    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0][0] as CardViewConfig;
    expect(payload.filter).toEqual(useUiStore.getState().filter);
    expect(payload.filter?.conditions[0].value).toBe('丙');
    view.unmount();
  });

  /*
   * ⭐ 次级门槛（dirty gate）两条断言：`shouldPersistFilter` 的第二道闸是
   *   `filterTouched || filter ≠ config.filter`。
   *   两条必须**成对**存在——只留一条时，把门槛删成恒真（或删成只看 touched）都能骗过测试。
   */
  it('初始化装载（filterTouched=false 且 filter 与 config.filter 一致）→ **不回写**', async () => {
    const loaded = makeFilter([cond('c1', 'f_title', 'contains', '甲')]);
    // 复制一份内容相同、引用不同的对象，验证比较是**语义**比较而非引用比较
    resetStores({ filter: { ...loaded, conditions: [{ ...loaded.conditions[0] }] }, configFilter: loaded });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    view.unmount();
  });

  it('dirty 门槛的另一半：未 touched 但 filter **≠** config.filter → 仍写入一次（能证伪「只看 filterTouched」）', async () => {
    resetStores({
      filter: makeFilter([cond('c1', 'f_title', 'contains', '甲')]),
      configFilter: EMPTY_FILTER, // 运行期与已持久化**不一致**
      filterTouched: false, // 刻意不置 touched：证明门槛不是「只看 touched」
    });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0][0] as CardViewConfig).filter?.conditions).toEqual([
      { conditionId: 'c1', fieldId: 'f_title', operator: 'contains', value: '甲' },
    ]);
    view.unmount();
  });

  it('unsupportedNewer=true → **不写入**（能证伪「只要 canEdit 就写」）', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, unsupportedNewer: true });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    // 反号：筛选仍然即时生效（只是不落盘）
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });

  it('正对照：同样一次变更、unsupportedNewer=false → 写入**一次**（证明上一条不是恒不写）', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, unsupportedNewer: false });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('canEditConfig=false（仅查看权限）→ **不写入**，但筛选可用', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER, canEditConfig: false });
    const persist = vi.fn().mockResolvedValue({ ok: true });
    useViewStore.setState({ persistConfig: persist });

    const view = mountToolbar();
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).not.toHaveBeenCalled();
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });

  it('保存返回 not-ok（如超限 / 介质失败）→ 不抛异常、记录错误、筛选仍可用', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const persist = vi.fn().mockResolvedValue({ ok: false, reason: 'write-failed', error: 'boom' });
    useViewStore.setState({ persistConfig: persist });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const view = mountToolbar();
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    // 错误被记录（logError → console.error），且**没有**冒泡成测试失败
    expect(errorSpy).toHaveBeenCalled();
    // 筛选本身仍可用
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });

  it('保存**抛异常** → 不产生未处理 rejection、记录错误、筛选仍可用', async () => {
    resetStores({ filter: EMPTY_FILTER, configFilter: EMPTY_FILTER });
    const persist = vi.fn().mockRejectedValue(new Error('network-down'));
    useViewStore.setState({ persistConfig: persist });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const view = mountToolbar();
    act(() => useUiStore.getState().setFilter(makeFilter([cond('c1', 'f_title', 'contains', '甲')])));
    await flushDebounce();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    view.unmount();
  });
});
