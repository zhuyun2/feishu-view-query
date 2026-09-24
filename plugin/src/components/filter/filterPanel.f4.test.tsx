/**
 * 组件测试（工程师 · F4）——筛选面板 UI：**无效条件是否被显式告知**。
 *
 * ⭐ 断言纪律（团队禁令：禁止假绿）：每条断言都要能回答「把实现改坏，这条会不会红」。
 *    故本文件**不写**「面板渲染出来了」「组件存在」这类恒真断言，
 *    一律断言**确切文案**与**确切算子值**。
 *
 * 覆盖 §22.5.6 的四组正例 + 算子回落 / 值输入 / 字段下拉 / 与或语义：
 *  1. 有效条件 → 不标红；
 *  2. 无效条件 → 标红 + 确切文案；
 *  3. 状态行**同时**含「命中」与「N 个条件未生效」；
 *  4. `isEmpty` / `isNotEmpty` 对**任意**字段类型都不判无效、不标红。
 *
 * 环境说明：本仓无 `@testing-library/react`（见 `package.json`），
 * 沿用 F3 `viewShell.filter.f3.test.tsx` 的写法：`createRoot` + `act` 直出 DOM。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { defaultCardLayout, defaultDensity, defaultTheme } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FieldMetaMap } from '@/filter/engine';
import type { FilterCondition, FilterOperator } from '@/filter/types';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import {
  countInvalidConditions,
  invalidCountSuffix,
  selectFilterScopeLabel,
  selectFilterScopeStatus,
  selectVisibleRecords,
} from '@/state/selectors';
import type { ThemeTokens } from '@/hooks/useThemeTokens';
import {
  FilterConditionRow,
  INCOMPLETE_VALUE_TEXT,
  INVALID_TYPE_OPERATOR_TEXT,
  isConditionEffective,
  resolveConditionOnFieldChange,
  resolveConditionOnOperatorChange,
} from './FilterConditionRow';
import { FilterPanel } from './FilterPanel';

/**
 * ⭐ 网格必须 mock（与 F3 `viewShell.filter.f3.test.tsx` 同因）：
 * `@tanstack/react-virtual` 在 jsdom 里行数多为 0，直接断言会变成恒真/恒假。
 * 本文件只关心**状态行文案**，网格替换成哑元件即可。
 */
vi.mock('@/components/grid/VirtualCardGrid', () => ({
  VirtualCardGrid: () => <div data-testid="fake-grid" />,
}));

const { ViewShell } = await import('@/components/layout/ViewShell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

/** 未知/不可筛字段类型（`isFilterableFieldType` → false，不得进入字段下拉） */
const UNSUPPORTED_TYPE = 9999;

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f_flag', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
  { id: 'f_date', name: '截止日', type: FieldType.DateTime, isPrimary: false },
  { id: 'f_owner', name: '负责人', type: FieldType.User, isPrimary: false },
  {
    id: 'f_status',
    name: '状态',
    type: FieldType.SingleSelect,
    isPrimary: false,
    property: { options: [{ name: '进行中' }, { name: '已完成' }] },
  },
  { id: 'f_file', name: '附件', type: FieldType.Attachment, isPrimary: false },
  { id: 'f_weird', name: '异类字段', type: UNSUPPORTED_TYPE, isPrimary: false },
];

const fieldsById: FieldMetaMap = {};
for (const meta of metas) fieldsById[meta.id] = meta;

const records: SdkRecord[] = [
  { recordId: 'r1', fields: { f_title: '甲方案', f_amount: 100 } } as unknown as SdkRecord,
  { recordId: 'r2', fields: { f_title: '乙方案', f_amount: 200 } } as unknown as SdkRecord,
  { recordId: 'r3', fields: { f_title: '甲二期', f_amount: 300 } } as unknown as SdkRecord,
];

function makeConfig(): CardViewConfig {
  return {
    schemaVersion: 2,
    meta: {
      configId: 'view_f4',
      tableId: 'tbl_f4',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'u_f4',
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

function resetStores(filter: { enabled: boolean; conjunction: 'and' | 'or'; conditions: FilterCondition[] }): void {
  useViewStore.setState({
    status: 'browse',
    fields: metas,
    fieldsById,
    records,
    total: 12480,
    hasMore: true,
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
    filter,
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
  });
}

/* ===================== 渲染工具 ===================== */

interface Mounted {
  container: HTMLElement;
  unmount: () => void;
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  findAll: (testId: string) => HTMLElement[];
}

/** 挂载到 document.body（React 事件委托需要真实文档树），返回查询句柄 */
function mount(node: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    html: () => container.innerHTML,
    find: (testId) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    findAll: (testId) => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 一次性渲染取 HTML（无需交互的断言用） */
function renderHtml(node: ReactElement): string {
  const view = mount(node);
  const markup = view.html();
  view.unmount();
  return markup;
}

/**
 * 绕过 React 的 `_valueTracker` 写入 value（等价于 RTL `fireEvent.change` 内部做法）：
 * 直接用 `el.value = x` 会同时更新 tracker，React 会认为「值没变」而不触发 onChange。
 */
function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
}

/** 触发 select 的变更（React 对 `<select>` 只监听 change） */
function selectOption(el: HTMLSelectElement, value: string): void {
  act(() => {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 触发文本输入（React 对文本 input 监听 input/change） */
function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 点击按钮 */
function clickButton(el: HTMLElement | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.click();
  });
}

/* ---------- 字段下拉的驱动辅助：原生 `<select>` → 共享 `FieldSelect` 组合框 ---------- */

/**
 * ⭐ 字段下拉已从原生 `<select>` 换成共享的可搜索组合框（`components/common/FieldSelect.tsx`，
 *   「字段太多很难选择」的用户反馈）。下面三个辅助只改**驱动方式**，
 *   **断言的主语与强度一律不变**（仍是「候选值集合」与「候选标签文本」，
 *   以及「选某字段后算子回落为 is」）。
 *   `data-testid="filter-field-select"` 沿用；候选项另带 `-option` 后缀与 `data-option-value`。
 */
const FIELD_OPTION_SELECTOR = '[data-testid="filter-field-select-option"]';

/** 展开字段组合框（FieldSelect 在 focus / click 时展开），并断言确实展开了 */
function openFieldSelect(view: Mounted): void {
  const trigger = view.find('filter-field-select');
  expect(trigger).not.toBeNull();
  act(() => {
    trigger?.click();
  });
  // 若未展开，后面的候选查询会静默返回空数组 → 断言会「假绿」，故此处先锁住展开态
  expect(trigger?.getAttribute('aria-expanded')).toBe('true');
}

/** 字段候选项的**值**序列（等价于原生 `select.options.map((o) => o.value)`） */
function fieldOptionValues(view: Mounted): string[] {
  openFieldSelect(view);
  return Array.from(view.container.querySelectorAll<HTMLElement>(FIELD_OPTION_SELECTOR)).map(
    (option) => option.getAttribute('data-option-value') ?? '',
  );
}

/** 字段候选项的**标签文本**序列（等价于原生 `select.options.map((o) => o.textContent)`） */
function fieldOptionLabels(view: Mounted): string[] {
  openFieldSelect(view);
  return Array.from(view.container.querySelectorAll<HTMLElement>(FIELD_OPTION_SELECTOR)).map(
    (option) => option.textContent ?? '',
  );
}

/** 在字段组合框里选中某个字段（等价于原生 `selectOption(el, fieldId)`） */
function chooseFieldOption(view: Mounted, fieldId: string): void {
  openFieldSelect(view);
  const option = view.container.querySelector<HTMLElement>(
    `${FIELD_OPTION_SELECTOR}[data-option-value="${fieldId}"]`,
  );
  expect(option).not.toBeNull();
  clickButton(option);
}

/** 受控行容器：把每次 onChange 的结果记录下来，便于断言「回落后的具体算子」 */
function RowHarness(props: {
  initial: FilterCondition;
  sink: FilterCondition[];
}): JSX.Element {
  const [condition, setCondition] = useState<FilterCondition>(props.initial);
  return (
    <FilterConditionRow
      condition={condition}
      fields={metas}
      fieldsById={fieldsById}
      onChange={(next) => {
        props.sink.push(next);
        setCondition(next);
      }}
      onRemove={() => undefined}
    />
  );
}

function cond(
  conditionId: string,
  fieldId: string,
  operator: FilterOperator,
  value?: unknown,
): FilterCondition {
  return { conditionId, fieldId, operator, value };
}

/* ===================== §22.5.6 正例 1/2：有效不标红、无效标红 ===================== */

describe('F4 · 无效条件必须显式告知（§22.5.6）', () => {
  beforeEach(() => {
    resetStores({ enabled: true, conjunction: 'and', conditions: [] });
  });

  it('① 有效条件 → **不**标红，且**不出现**「不会生效」文案（反号：能证伪「一律标红」）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'contains', '甲')],
    });
    const view = mount(<FilterPanel />);
    expect(view.html()).not.toContain('cbv-filter-row--invalid');
    expect(view.html()).not.toContain('不会生效');
    expect(view.findAll('filter-condition-invalid')).toHaveLength(0);
    view.unmount();
  });

  it('② 无效条件（数字字段用 contains）→ 标红 + 确切文案 + aria-invalid=true', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_amount', 'contains', '1')],
    });
    const view = mount(<FilterPanel />);
    expect(view.html()).toContain('cbv-filter-row--invalid');
    // ⭐ 断言**确切文案**，而非「有 class」——能证伪「只标红无说明」的实现
    expect(view.find('filter-condition-invalid')?.textContent).toBe(INVALID_TYPE_OPERATOR_TEXT);
    expect(view.html()).toContain(INVALID_TYPE_OPERATOR_TEXT);
    // a11y：行与三个控件都带 aria-invalid
    expect(view.find('filter-condition-row')?.getAttribute('aria-invalid')).toBe('true');
    expect(view.find('filter-field-select')?.getAttribute('aria-invalid')).toBe('true');
    expect(view.find('filter-operator-select')?.getAttribute('aria-invalid')).toBe('true');
    expect(view.find('filter-condition-row')?.getAttribute('title')).toBe(INVALID_TYPE_OPERATOR_TEXT);
    view.unmount();
  });

  it('②-b 未知算子 → 标红且文案点名该算子（能证伪「只处理类型不匹配」的实现）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'like' as FilterOperator, '甲')],
    });
    const view = mount(<FilterPanel />);
    expect(view.html()).toContain('cbv-filter-row--invalid');
    expect(view.find('filter-condition-invalid')?.textContent).toContain('不会生效');
    expect(view.find('filter-condition-invalid')?.textContent).toContain('like');
    view.unmount();
  });

  /*
   * ⭐ 提示优先级（团队裁定 · 2026-09-21）：**类型不匹配 优先于 值未填写**。
   *
   * 背景：类型不匹配时**填什么值都不可能生效**，用户的正确动作是换**算子**；
   * 若先提示「尚未填写筛选值」，用户会先去填值 → 填完才看到「算子不适用」→ 才去换算子。
   * 要两步才揭示真正问题，**而第一步就把人引向了无效动作**——UI 不得把用户引向无效动作。
   */
  it('②-c 类型不匹配 + **无值** → 报「算子不适用」而非「尚未填写筛选值」（能证伪旧顺序）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_amount', 'contains')], // 数字字段 + contains + 无值
    });
    const view = mount(<FilterPanel />);
    const text = view.find('filter-condition-invalid')?.textContent ?? '';
    expect(text).toBe(INVALID_TYPE_OPERATOR_TEXT);
    expect(text).toContain('不适用');
    expect(text).not.toContain('尚未填写筛选值');
    view.unmount();
  });

  it('②-d 类型**匹配** + 无值 → 才报「尚未填写筛选值」（证明不是「一律报算子不适用」）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'is')], // 文本字段 + is（类型匹配）+ 无值
    });
    const view = mount(<FilterPanel />);
    const text = view.find('filter-condition-invalid')?.textContent ?? '';
    expect(text).toBe(INCOMPLETE_VALUE_TEXT);
    expect(text).toContain('尚未填写筛选值');
    view.unmount();
  });

  it('②-e 未知算子仍优先于两者（三档文案互不串味）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_amount', 'like' as FilterOperator)], // 未知算子 + 无值
    });
    const view = mount(<FilterPanel />);
    const text = view.find('filter-condition-invalid')?.textContent ?? '';
    expect(text).toContain('未知算子');
    expect(text).not.toContain('尚未填写筛选值');
    expect(text).not.toContain('不适用于此字段类型');
    view.unmount();
  });

  it('③ 状态行**同时**含「命中 N 条」与「N 个条件未生效」（缺一即假绿）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [
        cond('c1', 'f_title', 'contains', '甲'), // 有效：命中 r1 / r3
        cond('c2', 'f_amount', 'contains', '1'), // 无效：数字字段无 contains
      ],
    });
    const view = mount(<FilterPanel />);
    const scope = view.find('filter-panel-scope-text')?.textContent ?? '';
    // ⭐ 两个信息必须**同时**出现
    expect(scope).toContain('命中 2 条');
    expect(scope).toContain('1 个条件未生效');
    expect(scope).toBe('已在已加载的 3 / 共 12,480 条中筛选，命中 2 条（其中 1 个条件未生效）');
    // 汇总提示同样给出数量（role=alert，读屏可播报）
    expect(view.find('filter-invalid-summary')?.textContent).toContain('有 1 个条件未生效');
    // 反号：未生效数量变化时文案必须跟着变，而不是写死
    expect(scope).not.toContain('2 个条件未生效');
    view.unmount();
  });

  it('③-b 两个无效条件 → 状态行报「2 个条件未生效」（能证伪「写死 1」的实现）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [
        cond('c1', 'f_title', 'contains', '甲'),
        cond('c2', 'f_amount', 'contains', '1'),
        cond('c3', 'f_flag', 'isGreater', 1), // 复选框仅 is → 无效
      ],
    });
    const view = mount(<FilterPanel />);
    const scope = view.find('filter-panel-scope-text')?.textContent ?? '';
    expect(scope).toContain('2 个条件未生效');
    expect(scope).toContain('命中 2 条');
    view.unmount();
  });

  it('③-c **无**无效条件时状态行不得出现「未生效」字样（能证伪「永远提示」的实现）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'contains', '甲')],
    });
    const view = mount(<FilterPanel />);
    expect(view.find('filter-panel-scope-text')?.textContent).not.toContain('未生效');
    expect(view.find('filter-invalid-summary')).toBeNull();
    view.unmount();
  });
});

/* ===================== §22.5.6 正例 4：空值算子豁免 ===================== */

describe('F4 · isEmpty / isNotEmpty 对任意字段类型都豁免（§22.3.2 / §22.5.6-4）', () => {
  const types: Array<{ id: string; label: string }> = [
    { id: 'f_title', label: '文本' },
    { id: 'f_amount', label: '数字' },
    { id: 'f_flag', label: '复选框（矩阵里根本没有 isEmpty）' },
    { id: 'f_date', label: '日期' },
    { id: 'f_owner', label: '成员' },
    { id: 'f_status', label: '单选' },
    { id: 'f_file', label: '附件' },
    { id: 'f_weird', label: '未知类型 9999' },
  ];

  for (const operator of ['isEmpty', 'isNotEmpty'] as const) {
    for (const target of types) {
      it(`${operator} · ${target.label} → 不判无效、不标红`, () => {
        const condition = cond('c1', target.id, operator);
        // 引擎口径（唯一真源）
        expect(isConditionEffective(condition, fieldsById)).toBe(true);
        // UI 口径
        const markup = renderHtml(
          <FilterConditionRow
            condition={condition}
            fields={metas}
            fieldsById={fieldsById}
            onChange={() => undefined}
            onRemove={() => undefined}
          />,
        );
        expect(markup).not.toContain('cbv-filter-row--invalid');
        expect(markup).not.toContain('不会生效');
      });
    }
  }

  it('反号：同一字段换成**值比较类**不匹配算子 → 立刻标红（证明豁免不是「一律不校验」）', () => {
    const ok = cond('c1', 'f_flag', 'isEmpty'); // 复选框 + isEmpty → 豁免
    const bad = cond('c2', 'f_flag', 'isGreater', 1); // 复选框 + isGreater → 无效
    expect(isConditionEffective(ok, fieldsById)).toBe(true);
    expect(isConditionEffective(bad, fieldsById)).toBe(false);
    expect(renderHtml(
      <FilterConditionRow
        condition={bad}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    )).toContain('cbv-filter-row--invalid');
  });
});

/* ===================== 算子回落（§22.3 UI 降级规则 1） ===================== */

describe('F4 · 切换字段时的算子回落', () => {
  it('文本 contains → 数字字段：回落到 **is**（数字类型第一个可用算子）', () => {
    const next = resolveConditionOnFieldChange(cond('c1', 'f_title', 'contains', '甲'), 'f_amount', fieldsById);
    expect(next.operator).toBe('is');
    expect(next.fieldId).toBe('f_amount');
    expect(next.value).toBeUndefined(); // 值必须清空
  });

  it('数字 isGreater → 复选框字段：回落到 **is**（复选框只有 is）', () => {
    const next = resolveConditionOnFieldChange(cond('c1', 'f_amount', 'isGreater', 100), 'f_flag', fieldsById);
    expect(next.operator).toBe('is');
  });

  it('文本 contains → 成员字段：**保留** contains（成员允许集内），但仍清空值', () => {
    const next = resolveConditionOnFieldChange(cond('c1', 'f_title', 'contains', '甲'), 'f_owner', fieldsById);
    expect(next.operator).toBe('contains');
    expect(next.value).toBeUndefined();
  });

  it('UI 上真实切换字段 → 算子下拉的选中值同步回落为 is', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_title', 'contains', '甲')} sink={sink} />);
    chooseFieldOption(view, 'f_amount');
    // 回落后的**具体算子值**
    expect(sink).toHaveLength(1);
    expect(sink[0].operator).toBe('is');
    expect((view.find('filter-operator-select') as HTMLSelectElement).value).toBe('is');
    view.unmount();
  });
});

/* ===================== 值输入（§22.3 规则 2 / §22.5.2） ===================== */

describe('F4 · 值输入控件', () => {
  it('isEmpty 选中 → 值输入**不渲染**（反号：is 时**必须**渲染）', () => {
    const empty = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_title', 'isEmpty')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(empty.find('filter-value-input')).toBeNull();
    empty.unmount();

    const eq = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_title', 'is', '甲')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(eq.find('filter-value-input')).not.toBeNull();
    eq.unmount();
  });

  it('isNotEmpty 选中 → 值输入同样不渲染', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_amount', 'isNotEmpty')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(view.find('filter-value-input')).toBeNull();
    view.unmount();
  });

  it('UI 上把算子下拉切到 isEmpty → 值输入**随即消失**且 value 被剥离（算子下拉真接线，非仅初始渲染）', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_title', 'is', '甲')} sink={sink} />);
    expect(view.find('filter-value-input')).not.toBeNull();

    selectOption(view.find('filter-operator-select') as HTMLSelectElement, 'isEmpty');

    expect(sink).toHaveLength(1);
    expect(sink[0].operator).toBe('isEmpty');
    expect('value' in sink[0]).toBe(false);
    expect(view.find('filter-value-input')).toBeNull();
    view.unmount();
  });

  it('数字字段 → number 输入，写入的是 **number 类型**的值（不是字符串）', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_amount', 'is', 100)} sink={sink} />);
    const input = view.find('filter-value-input') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('number');
    expect(input.value).toBe('100');
    typeInto(input, '250');
    expect(sink[sink.length - 1].value).toBe(250);
    expect(typeof sink[sink.length - 1].value).toBe('number');
    view.unmount();
  });

  it('数字输入清空 → 值变为 undefined（绝不写入 NaN）', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_amount', 'is', 100)} sink={sink} />);
    typeInto(view.find('filter-value-input') as HTMLInputElement, '');
    expect(sink[sink.length - 1].value).toBeUndefined();
    view.unmount();
  });

  it('单选字段 → 可搜下拉，候选来自 meta.property.options（选项名，不含 id）', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_status', 'is', '进行中')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    // ⭐ req1 机械改动（原断言 619-623）：单选值控件由原生 `<select>` 换成可搜下拉（`FieldSelect`）。
    //    断言**主语与强度不变**（候选的**选项名**集合 + 当前选中值），只把驱动方式从
    //    `select.options` 换成「展开后读候选项 data-option-value」。
    const combo = view.find('filter-value-input') as HTMLInputElement;
    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.value).toBe('进行中'); // 当前值 = 选项显示名

    clickButton(combo);
    const values = view
      .findAll('filter-value-input-option')
      .map((el) => el.getAttribute('data-option-value') ?? '');
    expect(values).toContain('进行中');
    expect(values).toContain('已完成');
    expect(values).toContain(''); // 「请选择」= 清空
    view.unmount();
  });

  it('日期字段 → date 输入，yyyy-mm-dd ↔ 时间戳互转', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_date', 'is', Date.parse('2024-05-01T00:00:00'))}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const input = view.find('filter-value-input') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('date');
    expect(input.value).toBe('2024-05-01');
    view.unmount();
  });

  it('复选框字段 → 是/否下拉（值映射 true/false，候选序列与原生 select 等价）', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_flag', 'is', true)}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    // ⭐ req1 机械改动（原断言 653-655）：布尔值控件由原生 `<select>` 换成共享 `FieldSelect`。
    //    断言**主语与强度不变**（候选值序列 `['', 'true', 'false']` + 当前值），只改驱动方式。
    const combo = view.find('filter-value-input') as HTMLInputElement;
    expect(combo.tagName).toBe('INPUT');
    expect(combo.value).toBe('是'); // value === true → 显示「是」

    clickButton(combo);
    expect(
      view.findAll('filter-value-input-option').map((el) => el.getAttribute('data-option-value') ?? ''),
    ).toEqual(['', 'true', 'false']);
    view.unmount();
  });

  it('算子由 is → isNotEmpty：value 被剥离；再切回 is：补默认值而非旧值', () => {
    const toEmpty = resolveConditionOnOperatorChange(cond('c1', 'f_title', 'is', '甲'), 'isNotEmpty', fieldsById);
    expect(toEmpty.value).toBeUndefined();
    expect('value' in toEmpty).toBe(false);

    const backToIs = resolveConditionOnOperatorChange(cond('c1', 'f_title', 'isNotEmpty'), 'is', fieldsById);
    expect(backToIs.value).toBe(''); // 文本形态默认值，不是 undefined / 不是旧值 '甲'
  });

  it('算子由 is → isNot：**保留**已输入的值（用户改算子不该丢输入）', () => {
    const next = resolveConditionOnOperatorChange(cond('c1', 'f_title', 'is', '甲'), 'isNot', fieldsById);
    expect(next.value).toBe('甲');
  });
});

/* ===================== 字段下拉（§22.3 规则 5） ===================== */

describe('F4 · 字段下拉不含不可筛字段', () => {
  it('未知类型 9999 的字段**不在**字段下拉中（可筛字段必须在）', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_title', 'contains', '甲')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const values = fieldOptionValues(view);
    expect(values).not.toContain('f_weird');
    expect(values).toContain('f_title');
    expect(values).toContain('f_amount');
    expect(values).toContain('f_status');
    view.unmount();
  });

  it('字段项显示「字段名（类型中文名）」', () => {
    const view = mount(
      <FilterConditionRow
        condition={cond('c1', 'f_title', 'contains', '甲')}
        fields={metas}
        fieldsById={fieldsById}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const labels = fieldOptionLabels(view);
    expect(labels).toContain('标题（文本）');
    expect(labels).toContain('金额（数字）');
    view.unmount();
  });
});

/* ===================== 与/或 语义 ===================== */

describe('F4 · 与 / 或 切换', () => {
  beforeEach(() => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [
        cond('c1', 'f_title', 'contains', '甲'), // r1 / r3
        cond('c2', 'f_amount', 'is', 200), // r2
      ],
    });
  });

  it('默认「与」：交集为空；点「或」后 → 并集为 r1+r2+r3，写回 conjunction=or', () => {
    const view = mount(<FilterPanel />);
    expect(view.find('filter-conjunction-and')).not.toBeNull();

    const andResult = selectVisibleRecords({
      records,
      filter: useUiStore.getState().filter,
      fieldsById,
      layout: makeConfig().card,
      searchQuery: '',
    });
    expect(andResult.records.map((record) => record.recordId)).toEqual([]);

    clickButton(view.find('filter-conjunction-or'));
    expect(useUiStore.getState().filter.conjunction).toBe('or');

    const orResult = selectVisibleRecords({
      records,
      filter: useUiStore.getState().filter,
      fieldsById,
      layout: makeConfig().card,
      searchQuery: '',
    });
    expect(orResult.records.map((record) => record.recordId)).toEqual(['r1', 'r2', 'r3']);
    view.unmount();
  });

  it('只有 1 条条件时不渲染与/或切换（≥2 才出现）', () => {
    resetStores({ enabled: true, conjunction: 'and', conditions: [cond('c1', 'f_title', 'contains', '甲')] });
    const view = mount(<FilterPanel />);
    expect(view.find('filter-conjunction-and')).toBeNull();
    expect(view.find('filter-conjunction-or')).toBeNull();
    view.unmount();
  });
});

/* ===================== 增删与清空 ===================== */

describe('F4 · 添加条件 / 删除 / 清空', () => {
  it('空面板点「添加条件」→ 产出 1 条，字段取第一个可筛字段、算子取该类型第一个可用算子', () => {
    resetStores({ enabled: true, conjunction: 'and', conditions: [] });
    const view = mount(<FilterPanel />);
    expect(view.find('filter-empty-hint')).not.toBeNull();
    clickButton(view.find('filter-add-condition'));
    const conditions = useUiStore.getState().filter.conditions;
    expect(conditions).toHaveLength(1);
    expect(conditions[0].fieldId).toBe('f_title'); // 不可筛的 f_weird 不会被选中
    expect(conditions[0].operator).toBe('is'); // 文本类型第一个可用算子
    view.unmount();
  });

  it('点删除 → 该条消失', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'contains', '甲'), cond('c2', 'f_amount', 'is', 200)],
    });
    const view = mount(<FilterPanel />);
    expect(view.findAll('filter-condition-row')).toHaveLength(2);
    const removeButtons = view.findAll('filter-condition-remove');
    clickButton(removeButtons[0]);
    const conditions = useUiStore.getState().filter.conditions;
    expect(conditions.map((item) => item.conditionId)).toEqual(['c2']);
    view.unmount();
  });

  it('点「清空」→ conditions 归零，且 filterTouched 置位', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'contains', '甲')],
    });
    const view = mount(<FilterPanel />);
    clickButton(view.find('filter-clear'));
    expect(useUiStore.getState().filter.conditions).toEqual([]);
    expect(useUiStore.getState().filterTouched).toBe(true);
    view.unmount();
  });

  it('「完成」按钮触发 onApply（语义=仅收起面板，筛选早已即时生效，非提交）', () => {
    resetStores({ enabled: true, conjunction: 'and', conditions: [cond('c1', 'f_title', 'contains', '甲')] });
    let applied = 0;
    const view = mount(<FilterPanel onApply={() => { applied += 1; }} />);
    // ⭐ 按钮名必须是「完成」：筛选在输入时已生效，本按钮**只收起面板**。
    //    叫「应用」会暗示「点了才生效」，与事实不符（团队裁定 · 2026-09-21）。
    expect(view.find('filter-apply')?.textContent).toBe('完成');
    expect(view.find('filter-apply')?.textContent).not.toBe('应用');
    // 且头部「即时生效」提示必须保留，与本按钮名互补（不是靠改名掩盖语义）
    expect(view.html()).toContain('即时生效');
    clickButton(view.find('filter-apply'));
    expect(applied).toBe(1);
    view.unmount();
  });
});

/* ===================== 跨模块接线：状态行也必须报「未生效」 ===================== */

describe('F4 · 跨模块接线：ViewShell 状态行 / 工具栏计数也报「N 个条件未生效」', () => {
  const tokens: ThemeTokens = {
    theme: defaultTheme(),
    density: defaultDensity(),
    hostTheme: 'light',
    titleLineHeight: '1.3',
  };

  beforeEach(() => {
    resetStores({ enabled: true, conjunction: 'and', conditions: [] });
  });

  it('countInvalidConditions 是**动态计数**（0 / 1 / 2 三档都对，能证伪「写死 1」）', () => {
    expect(countInvalidConditions({ enabled: true, conjunction: 'and', conditions: [] }, fieldsById)).toBe(0);
    expect(
      countInvalidConditions(
        { enabled: true, conjunction: 'and', conditions: [cond('c1', 'f_amount', 'contains', '1')] },
        fieldsById,
      ),
    ).toBe(1);
    expect(
      countInvalidConditions(
        {
          enabled: true,
          conjunction: 'and',
          conditions: [
            cond('c1', 'f_amount', 'contains', '1'),
            cond('c2', 'f_flag', 'isGreater', 1),
            cond('c3', 'f_title', 'contains', '甲'), // 有效，不计入
          ],
        },
        fieldsById,
      ),
    ).toBe(2);
    // 豁免不受影响：空值算子永不计入
    expect(
      countInvalidConditions(
        { enabled: true, conjunction: 'and', conditions: [cond('c1', 'f_flag', 'isEmpty')] },
        fieldsById,
      ),
    ).toBe(0);
  });

  it('selectFilterScopeLabel：invalidCount 缺省 / 0 时文案**逐字不变**（F3 断言锁定）', () => {
    const base = {
      total: 12480,
      loaded: 3,
      matched: 2,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    };
    expect(selectFilterScopeLabel(base)).toBe('共 12,480 条 · 已在已加载的 3 条中筛选，命中 2 条');
    expect(selectFilterScopeLabel({ ...base, invalidCount: 0 })).toBe(
      '共 12,480 条 · 已在已加载的 3 条中筛选，命中 2 条',
    );
    expect(selectFilterScopeLabel({ total: 12480, loaded: 3, matched: 2, hasFilter: true, hasSearch: false, hasMore: false })).toBe(
      '共 12,480 条（已筛选 2 条）',
    );
  });

  it('selectFilterScopeLabel：invalidCount > 0 时追加「（其中 N 个条件未生效）」且数字跟随计数', () => {
    const base = { total: 12480, loaded: 3, matched: 2, hasFilter: true, hasSearch: false, hasMore: true };
    expect(selectFilterScopeLabel({ ...base, invalidCount: 1 })).toBe(
      '共 12,480 条 · 已在已加载的 3 条中筛选，命中 2 条（其中 1 个条件未生效）',
    );
    expect(selectFilterScopeLabel({ ...base, invalidCount: 2 })).toBe(
      '共 12,480 条 · 已在已加载的 3 条中筛选，命中 2 条（其中 2 个条件未生效）',
    );
  });

  it('invalidCountSuffix：0 / 脏数据 → 空串（绝不产出「0 个条件未生效」这种噪声）', () => {
    expect(invalidCountSuffix(0)).toBe('');
    expect(invalidCountSuffix(2)).toBe('（其中 2 个条件未生效）');
    expect(invalidCountSuffix(Number.NaN)).toBe('');
    expect(invalidCountSuffix(-3)).toBe('');
  });

  it('selectFilterScopeStatus：存在无效条件时 scopeText **同时**含「命中」与「未生效」', () => {
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 3,
      filterMatched: 2,
      visible: 2,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
      startedFrom: 0,
      invalidCount: 1,
    });
    expect(status.scopeText).toBe('已在已加载的 3 / 共 12,480 条中筛选，命中 2 条（其中 1 个条件未生效）');
    expect(status.scopeText).toContain('命中 2 条');
    expect(status.scopeText).toContain('1 个条件未生效');
  });

  it('ViewShell 真实渲染：状态行 + 工具栏计数都带上「1 个条件未生效」（证伪「只在面板里做了」）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [
        cond('c1', 'f_title', 'contains', '甲'), // 有效
        cond('c2', 'f_amount', 'contains', '1'), // 无效
      ],
    });
    const view = mount(<ViewShell tokens={tokens} />);
    const scopeText = view.find('filter-scope-text')?.textContent ?? '';
    expect(scopeText).toContain('命中 2 条');
    expect(scopeText).toContain('1 个条件未生效');
    expect(scopeText).toBe('已在已加载的 3 / 共 12,480 条中筛选，命中 2 条（其中 1 个条件未生效）');
    // 工具栏记录数（selectFilterScopeLabel）同样不得沉默
    expect(view.find('toolbar-count')?.textContent).toBe(
      '共 12,480 条 · 已在已加载的 3 条中筛选，命中 2 条（其中 1 个条件未生效）',
    );
    view.unmount();
  });

  it('ViewShell：两个无效条件 → 状态行报「2 个条件未生效」（动态，非写死）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [
        cond('c1', 'f_title', 'contains', '甲'),
        cond('c2', 'f_amount', 'contains', '1'),
        cond('c3', 'f_flag', 'isGreater', 1),
      ],
    });
    const view = mount(<ViewShell tokens={tokens} />);
    const scopeText = view.find('filter-scope-text')?.textContent ?? '';
    expect(scopeText).toContain('2 个条件未生效');
    expect(scopeText).toContain('命中 2 条');
    view.unmount();
  });

  it('ViewShell：全部条件有效 → 状态行**不得**出现「未生效」（证伪「永远提示」）', () => {
    resetStores({
      enabled: true,
      conjunction: 'and',
      conditions: [cond('c1', 'f_title', 'contains', '甲')],
    });
    const view = mount(<ViewShell tokens={tokens} />);
    expect(view.find('filter-scope-text')?.textContent).toBe('已在已加载的 3 / 共 12,480 条中筛选，命中 2 条');
    expect(view.html()).not.toContain('未生效');
    view.unmount();
  });
});
