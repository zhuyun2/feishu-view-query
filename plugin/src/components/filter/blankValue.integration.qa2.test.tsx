/**
 * F5b · 集成验证：**未填值条件不得隐藏数据** + 字段下拉组合框接入（QA 独立复核，实现方不得修改）。
 *
 * 真机缺陷（用户原话）：「视图页点击筛选选择筛选条件时候在没有实际应用筛选字段时不要隐藏视图的数据」。
 * 根因：新建 / 历史持久化的「需值算子 + 空值」条件被旧引擎当**合法**条件 → `is ''` 对每条记录
 * 算 noMatch → 全表被筛空（空态 + 计数 0）。修复落在 `engine.isValidConditionValue`（单一真源）。
 *
 * 本文件**只从集成链路取证**（不重复引擎单测）：
 *  1. 已持久化的空值条件经 `sanitize → replaceFilter`（= `useCardViewInit` 的装载路径）载入后，
 *     卡片区仍有数据、计数不为 0、状态行显式报「未生效」；
 *  2. **判别式**：空值条件 + 命中条件 → 保留；空值条件 + 不命中条件 → **仍收窄**（防「有坏条件就整体放行」）；
 *  3. 真面板可操作链路：加条件→未生效且不隐藏；填值→即时收窄；清空→恢复；
 *  4. 字段下拉组合框走**真实面板**：模糊查询、键盘选中、换字段算子回落。
 *
 * 断言纪律：锚定确切序列 / 确切文案；否定式断言一律配正面锚点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { defaultCardLayout, defaultDensity, defaultTheme } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { sanitizeFilterConfig } from '@/filter/sanitize';
import type { FilterCondition, FilterConfig, FilterOperator } from '@/filter/types';
import { INCOMPLETE_VALUE_TEXT } from '@/components/filter/FilterConditionRow';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import type { ThemeTokens } from '@/hooks/useThemeTokens';

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
  { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];

const fieldsById: Record<string, FieldMetaLite> = { f_note: metas[0], f_amount: metas[1] };

const records: SdkRecord[] = [
  { recordId: 'r1', fields: { f_note: '甲', f_amount: 100 } } as unknown as SdkRecord,
  { recordId: 'r2', fields: { f_note: '乙', f_amount: 200 } } as unknown as SdkRecord,
  { recordId: 'r3', fields: { f_note: '丙', f_amount: 300 } } as unknown as SdkRecord,
];

const EMPTY_FILTER: FilterConfig = { enabled: true, conjunction: 'and', conditions: [] };

function cond(conditionId: string, fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  const condition: FilterCondition = { conditionId, fieldId, operator };
  if (value !== undefined) condition.value = value;
  return condition;
}

function makeConfig(filter: FilterConfig): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: { configId: 'view_qa2b', tableId: 'tbl_qa2b', createdAt: 0, updatedAt: 0, updatedBy: 'u', templateId: 'standard' },
    card: defaultCardLayout(metas),
    detail: { mode: 'doc', doc: { blocks: [], pageSize: 'A4', orientation: 'portrait' } } as unknown as CardViewConfig['detail'],
    theme: defaultTheme(),
    density: defaultDensity(),
    highlightRules: [],
    filter,
  };
}

const tokens: ThemeTokens = { theme: defaultTheme(), density: defaultDensity(), hostTheme: 'light', titleLineHeight: '1.3' };

function resetStores(options: { filter?: FilterConfig; total?: number; hasMore?: boolean } = {}): void {
  useViewStore.setState({
    status: 'browse',
    viewName: '订单视图',
    fields: metas,
    fieldsById,
    records,
    total: options.total ?? 3,
    hasMore: options.hasMore ?? false,
    loadingMore: false,
    config: makeConfig(options.filter ?? EMPTY_FILTER),
    canEditConfig: true,
    unsupportedNewer: false,
    degraded: false,
    corrupted: false,
    configCorrupted: false,
    provisionedFromTemplate: false,
    copyScenario: false,
    // 防抖持久化在 Toolbar 常驻：stub 掉，避免触碰真实仓储
    persistConfig: (async () => ({ ok: true })) as unknown as (config: CardViewConfig) => Promise<{ ok: boolean }>,
  });
  useUiStore.setState({
    searchQuery: '',
    editorOpen: false,
    toast: null,
    copyBannerDismissed: false,
    hover: { recordId: null, anchor: null },
    filter: options.filter ?? EMPTY_FILTER,
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
  });
  fake.gridRecords = [];
}

/* ===================== 渲染工具 ===================== */

interface Mounted {
  container: HTMLElement;
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  findAll: (testId: string) => HTMLElement[];
  click: (testId: string) => void;
  unmount: () => void;
}

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
    container,
    html: () => container.innerHTML,
    find: (testId) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    findAll: (testId) => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)),
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
  for (const unmount of liveMounted.splice(0)) unmount();
});

/** 绕过 React `_valueTracker` 写 input 值（等价 RTL fireEvent.change） */
function typeInto(el: Element | null, value: string): void {
  expect(el).not.toBeNull();
  act(() => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function keyDown(el: Element | null, key: string): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function scopeText(view: Mounted): string {
  return view.find('filter-scope-text')?.textContent ?? '';
}

/* =====================================================================
 * 1. ⭐ 用户真机场景复现：已持久化的空值条件，装载后不得隐藏数据
 * ===================================================================== */

describe('QA2b · 真机场景：历史持久化的空值条件不得隐藏数据', () => {
  beforeEach(() => resetStores({ hasMore: true, total: 12480 }));

  it('空值条件经 sanitize → replaceFilter 载入 → 卡片仍有数据、计数非 0、状态行报「未生效」', () => {
    // 用户历史状态里那一行：备注（文本） 等于 [空]
    const persisted = {
      enabled: true,
      conjunction: 'and',
      conditions: [{ conditionId: 'flt_1', fieldId: 'f_note', operator: 'is', value: '' }],
    };
    // 复刻 useCardViewInit 的装载路径：sanitizeFilterConfig(config.filter, { fields }) → replaceFilter
    useUiStore.getState().replaceFilter(sanitizeFilterConfig(persisted, { fields: metas }));
    // 前提：空值草稿被 sanitize **保留**（不静默丢用户输入），故它确实进入了运行期 filter
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);

    const view = mount(<ViewShell tokens={tokens} />);

    // ① 卡片区仍有记录（不是空态）——正是用户报的「不要隐藏数据」
    expect(view.find('fake-grid')).not.toBeNull();
    expect(fake.gridRecords).toEqual(['r1', 'r2', 'r3']);
    // ② 顶部计数不是 0
    const count = view.find('toolbar-count')?.textContent ?? '';
    expect(count).toContain('命中 3 条');
    expect(count).not.toContain('命中 0 条');
    // ③ §22.5.6：状态行**显式**告知有 1 个条件未生效（不能静默）
    expect(scopeText(view)).toContain('1 个条件未生效');
    view.unmount();
  });

  it('对照：把同一条件**填上值** → 必须真的收窄（证明夹具能筛，上一例不是恒真）', () => {
    useUiStore.getState().replaceFilter({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('flt_1', 'f_note', 'is', '甲')],
    });
    const view = mount(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual(['r1']);
    expect(scopeText(view)).not.toContain('未生效');
    view.unmount();
  });
});

/* =====================================================================
 * 2. ⭐ 集成判别式：跳过 ≠ 放行
 * ===================================================================== */

describe('QA2b · 判别式：空值条件被跳过，而不是让整个筛选放行', () => {
  beforeEach(() => resetStores());

  it('[空值条件, 命中条件] and → 卡片**保留**命中记录（空值条件被跳过）', () => {
    resetStores({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [cond('c_blank', 'f_note', 'is', ''), cond('c_hit', 'f_note', 'is', '甲')],
      },
    });
    const view = mount(<ViewShell tokens={tokens} />);
    view.click('toolbar-filter'); // 打开真实面板
    // 面板里两条都在；未填值那条显式告知原因
    expect(view.findAll('filter-condition-row')).toHaveLength(2);
    expect(view.find('filter-condition-invalid')?.textContent).toBe(INCOMPLETE_VALUE_TEXT);
    // 卡片保留命中记录（不是被空条件筛空）
    expect(fake.gridRecords).toEqual(['r1']);
    expect(fake.gridRecords.length).toBeGreaterThan(0);
    view.unmount();
  });

  it('⭐ [空值条件, 不命中条件] and → **仍收窄为 []**（若闸门被误开成「放行一切」本条会红）', () => {
    resetStores({
      filter: {
        enabled: true,
        conjunction: 'and',
        conditions: [cond('c_blank', 'f_note', 'is', ''), cond('c_miss', 'f_note', 'is', 'ZZZ')],
      },
    });
    const view = mount(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual([]);
    view.unmount();
  });
});

/* =====================================================================
 * 3. 用户可见链路：加条件 / 填值 / 清空（走真实面板）
 * ===================================================================== */

describe('QA2b · 用户可见链路（真实工具栏 + 面板）', () => {
  beforeEach(() => resetStores());

  it('新增条件 → 不隐藏数据 + 行内「尚未填写筛选值」；填值 → 即时收窄；清空 → 恢复', () => {
    const view = mount(<ViewShell tokens={tokens} />);
    expect(fake.gridRecords).toEqual(['r1', 'r2', 'r3']);

    view.click('toolbar-filter');
    view.click('filter-add-condition');

    // 新行：不写 value 键
    const created = useUiStore.getState().filter.conditions;
    expect(created).toHaveLength(1);
    expect('value' in created[0]).toBe(false);
    // 仍未隐藏任何数据
    expect(fake.gridRecords).toEqual(['r1', 'r2', 'r3']);
    expect(view.find('filter-condition-invalid')?.textContent).toBe(INCOMPLETE_VALUE_TEXT);

    // 填值 → 即时生效（收窄）
    typeInto(view.find('filter-value-input'), '甲');
    expect((useUiStore.getState().filter.conditions[0] as FilterCondition).value).toBe('甲');
    expect(fake.gridRecords).toEqual(['r1']);
    expect(view.find('filter-condition-invalid')).toBeNull();

    // 清空值 → 回到「未生效」，数据恢复显示
    typeInto(view.find('filter-value-input'), '');
    expect(fake.gridRecords).toEqual(['r1', 'r2', 'r3']);
    expect(view.find('filter-condition-invalid')?.textContent).toBe(INCOMPLETE_VALUE_TEXT);
    view.unmount();
  });

  it('「应用」按钮行为与提示自洽性：点击即**收起面板**，筛选已即时生效（非提交语义）', () => {
    const view = mount(<ViewShell tokens={tokens} />);
    view.click('toolbar-filter');
    view.click('filter-add-condition');
    typeInto(view.find('filter-value-input'), '甲');
    expect(fake.gridRecords).toEqual(['r1']); // 未点应用就已生效

    view.click('filter-apply');
    expect(view.find('filter-panel')).toBeNull(); // 面板收起
    expect(fake.gridRecords).toEqual(['r1']); // 筛选结果不变（「应用」不是提交）
    // 面板头部的提示文案确实宣称「即时生效」
    view.unmount();
  });
});

/* =====================================================================
 * 4. 字段下拉组合框（真实面板）：查询 / 键盘 / 算子回落
 * ===================================================================== */

describe('QA2b · 字段下拉组合框走真实面板', () => {
  beforeEach(() => {
    resetStores({
      filter: { enabled: true, conjunction: 'and', conditions: [cond('c1', 'f_note', 'is', '甲')] },
    });
  });

  it('模糊查询：「金额」只剩数字字段；键盘 Enter 选中 → 换字段 + 算子回落为 is + 值清空', () => {
    const view = mount(<ViewShell tokens={tokens} />);
    view.click('toolbar-filter');

    const combo = view.find('filter-field-select');
    expect(combo).not.toBeNull();
    expect(combo?.getAttribute('role')).toBe('combobox');
    act(() => {
      combo?.click();
    });
    expect(combo?.getAttribute('aria-expanded')).toBe('true');

    typeInto(combo, '金额');
    const labels = view.findAll('filter-field-select-option').map((el) => el.textContent ?? '');
    expect(labels).toEqual(['金额（数字）']);

    keyDown(combo, 'Enter'); // 选中唯一的「金额」
    const next = useUiStore.getState().filter.conditions[0];
    expect(next.fieldId).toBe('f_amount');
    expect(next.operator).toBe('is'); // 数字类型第一个可用算子（回落）
    expect('value' in next).toBe(false); // 换字段清空值
    // 算子下拉的选中值同步为 is（真实接线）
    expect((view.find('filter-operator-select') as HTMLSelectElement).value).toBe('is');
    view.unmount();
  });

  it('候选不含不可筛字段（且候选项序列非空，否定断言有正面锚点）', () => {
    const view = mount(<ViewShell tokens={tokens} />);
    view.click('toolbar-filter');
    const combo = view.find('filter-field-select');
    act(() => {
      combo?.click();
    });
    const values = view.findAll('filter-field-select-option').map((el) => el.getAttribute('data-option-value') ?? '');
    expect(values).toEqual(['f_note', 'f_amount']); // 正面锚点：确切序列
    view.unmount();
  });
});
