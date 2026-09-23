/**
 * 组件测试（工程师 · F3）——`ViewShell` 的**接线正确性**：
 * 「原生筛选 → 插件筛选 → 搜索」这条链是否真的接到了卡片墙，覆盖率状态行是否常驻且诚实。
 *
 * ⭐ 为什么必须 mock `VirtualCardGrid`：网格内部有一套 `@tanstack/react-virtual`，
 * 在 jsdom 里行数多为 0，**断言行数会变成恒真/恒假**。这里改为**断言传给网格的 props**，
 * 这恰恰是本次改动的核心：改动前网格直接读 `ViewStore.records`（根本收不到筛选结果），
 * 改动后必须收到 `selectVisibleRecords` 的输出。
 *
 * 断言纪律：全部用**具体 ID 序列**与**具体文案**，无 `length > 0` 式恒真断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { defaultCardLayout, defaultDensity, defaultTheme } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import type { ThemeTokens } from '@/hooks/useThemeTokens';

/** 捕获网格收到的 props；工厂在 import 期提升，故状态放 `vi.hoisted` */
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
  { recordId: 'r2', fields: { f_title: '乙方案', f_amount: 200 } } as unknown as SdkRecord,
  { recordId: 'r3', fields: { f_title: '甲二期', f_amount: 300 } } as unknown as SdkRecord,
];

function makeConfig(): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: {
      configId: 'view_f3',
      tableId: 'tbl_f3',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'u_f3',
      templateId: 'standard',
    },
    card: defaultCardLayout(metas),
    detail: { mode: 'doc', doc: { blocks: [], pageSize: 'A4', orientation: 'portrait' } } as unknown as CardViewConfig['detail'],
    theme: defaultTheme(),
    density: defaultDensity(),
    highlightRules: [],
    filter: { enabled: true, conjunction: 'and', conditions: [] },
  };
}

const tokens: ThemeTokens = {
  theme: defaultTheme(),
  density: defaultDensity(),
  hostTheme: 'light',
  titleLineHeight: '1.3',
};

/** 客户端渲染到 detached 容器，返回 innerHTML */
function render(node: ReactElement): string {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const markup = container.innerHTML;
  act(() => {
    root.unmount();
  });
  container.remove();
  return markup;
}

/** 重置两个 store 到干净基线 */
function resetStores(loadedCount: number, hasMore: boolean): void {
  useViewStore.setState({
    status: 'browse',
    fields: metas,
    fieldsById,
    records: records.slice(0, loadedCount),
    total: 12480,
    hasMore,
    config: makeConfig(),
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
    copyBannerDismissed: false,
    hover: { recordId: null, anchor: null },
    filter: { enabled: true, conjunction: 'and', conditions: [] },
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
  });
  fake.gridRecords = [];
}

beforeEach(() => {
  resetStores(3, true);
});

/* ===================== 接线：筛选必须真的到达卡片墙 ===================== */

describe('F3 · ViewShell：筛选链路真的接到网格', () => {
  it('无筛选 → 网格收到**全部**已加载记录（打底：证明不是永远传空数组）', () => {
    render(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual(['r1', 'r2', 'r3']);
  });

  it('有筛选 → 网格只收到**命中**记录（r2 必须消失，而非只多了现存项）', () => {
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
      },
    });
    render(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual(['r1', 'r3']);
  });

  it('筛选 ∩ 搜索叠加：两者都要满足', () => {
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
      },
      searchQuery: '二期',
    });
    render(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual(['r3']);
  });
});

/* ===================== countLabel 与覆盖率状态行 ===================== */

describe('F3 · ViewShell：countLabel 与覆盖范围状态行', () => {
  it('未加载全部 + 有筛选 → 计数含「已加载」限定词，状态行常驻且给出升级入口', () => {
    resetStores(2, true); // 只加载了 2 条（total 仍为 12,480，hasMore=true）
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
      },
    });
    const markup = render(<ViewShell tokens={tokens} />);
    expect(markup).toContain('共 12,480 条 · 已在已加载的 2 条中筛选，命中 1 条');
    expect(markup).toContain('data-testid="filter-scope"');
    expect(markup).toContain('已在已加载的 2 / 共 12,480 条中筛选，命中 1 条');
    expect(markup).toContain('未加载全部');
    expect(markup).toContain('data-testid="filter-load-all"');
    expect(markup).toContain('加载全部并重新筛选');
    // ⭐ 反号：不得出现「命中数即全量」的措辞
    expect(markup).not.toContain('（已筛选 1 条）');
    expect(markup).not.toContain('共 1 条');
  });

  it('已加载全部（hasMore=false）→ 才允许出现「全部」口径，且**不再**提供升级入口', () => {
    resetStores(3, false);
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
      },
    });
    const markup = render(<ViewShell tokens={tokens} />);
    expect(markup).toContain('共 12,480 条（已筛选 2 条）');
    expect(markup).toContain('已在全部 12,480 条中筛选，命中 2 条');
    expect(markup).not.toContain('未加载全部');
    expect(markup).not.toContain('data-testid="filter-load-all"');
  });

  it('无筛选无搜索 → **不渲染**覆盖率状态行（避免噪声）', () => {
    const markup = render(<ViewShell tokens={tokens} />);
    expect(markup).not.toContain('data-testid="filter-scope"');
    expect(markup).toContain('共 12,480 条');
  });

  it('筛选后 0 命中 → 走 filterEmpty 空态，并可一键清空筛选', () => {
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '不存在' }],
      },
    });
    const markup = render(<ViewShell tokens={tokens} />);
    expect(markup).toContain('data-empty-kind="filterEmpty"');
    expect(markup).toContain('清空筛选');
  });
});

/* ===================== 「加载全部并重新筛选」升级路径 ===================== */

describe('F3 · ViewShell：加载全部并重新筛选', () => {
  it('点击后翻完所有页 → 文案由「已加载」口径升级为「全部」口径', async () => {
    resetStores(2, true);
    useUiStore.setState({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' }],
      },
    });

    // 假的增量加载：第一次补上第 3 条并关掉 hasMore
    useViewStore.setState({
      loadMore: async () => {
        useViewStore.setState({ records, hasMore: false, nextPageToken: null });
      },
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<ViewShell tokens={tokens} />);
    });
    expect(container.innerHTML).toContain('已在已加载的 2 / 共 12,480 条中筛选');

    const button = container.querySelector<HTMLButtonElement>('[data-testid="filter-load-all"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(container.innerHTML).toContain('已在全部 12,480 条中筛选，命中 2 条');
    expect(container.innerHTML).toContain('共 12,480 条（已筛选 2 条）');
    expect(container.innerHTML).not.toContain('未加载全部');
    // 升级结束后必须复位（否则 UI 会永久停留在进度态）
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
    expect(useUiStore.getState().filterLoadAllStartedFrom).toBe(2);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
