/**
 * 筛选面板字段下拉的「模糊查询」接入测试（工程师 · engineer-fs）。
 *
 * 需求来源（用户反馈）：「视图筛选下拉选择字段要支持字段模糊查询」。
 *
 * ⭐ 本文件守住三件事：
 *  1. **结构性替换**：`filter-field-select` 不再是原生 `<select>`，而是 `role="combobox"` 的可搜索控件
 *     （裸词断言会被注释偶然满足，故直接锚定 DOM 结构与 ARIA 属性）；
 *  2. **候选集不变式**：不可筛字段仍不进候选、当前字段不可筛时仍**显示出来**（§22.3 规则 5 / §22.5.6）；
 *  3. **业务语义**：`onChange` 仍然走 `resolveConditionOnFieldChange`
 *     —— 切字段时**算子回落 + 清空值**，且规则对「保留」与「回落」两条链路都成立（分离夹具）。
 *
 * 环境：同 `filterPanel.f4.test.tsx`，`createRoot` + `act` 直出 DOM（本仓无 RTL）。
 */
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FieldMetaMap } from '@/filter/engine';
import type { FilterCondition, FilterOperator } from '@/filter/types';
import { FilterConditionRow } from './FilterConditionRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

/** 不可筛类型（不在算子矩阵中 → `isFilterableFieldType` 为 false，不得进字段下拉） */
const UNSUPPORTED_TYPE = 9999;

const METAS: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f_owner', name: '负责人', type: FieldType.User, isPrimary: false },
  { id: 'f_status', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f_weird', name: '异类字段', type: UNSUPPORTED_TYPE, isPrimary: false },
];

const BY_ID: FieldMetaMap = {};
for (const meta of METAS) BY_ID[meta.id] = meta;

/** 可筛字段的候选值序列（顺序 = METAS 过滤后的顺序） */
const FILTERABLE_IDS = ['f_title', 'f_amount', 'f_owner', 'f_status'];
const FILTERABLE_LABELS = ['标题（文本）', '金额（数字）', '负责人（成员）', '状态（单选）'];

function cond(
  conditionId: string,
  fieldId: string,
  operator: FilterOperator,
  value?: unknown,
): FilterCondition {
  return { conditionId, fieldId, operator, value };
}

/* ===================== 工具 ===================== */

interface Mounted {
  container: HTMLElement;
  html: () => string;
  find: (testId: string) => HTMLElement | null;
  findAll: (testId: string) => HTMLElement[];
  unmount: () => void;
}

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

function clickOpen(el: HTMLElement | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.click();
  });
}

function keyDown(el: HTMLElement | null, key: string): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function typeInto(el: HTMLInputElement | null, value: string): void {
  expect(el).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function optionValues(view: Mounted): string[] {
  return view
    .findAll('filter-field-select-option')
    .map((el) => el.getAttribute('data-option-value') ?? '');
}

function optionLabels(view: Mounted): string[] {
  return view
    .findAll('filter-field-select-option')
    .map((el) => el.querySelector('.cbv-fieldselect__option-label')?.textContent ?? '');
}

/** 渲染单条条件行（受控壳，记录每次 onRemove 以外无需处理） */
function renderRow(condition: FilterCondition): Mounted {
  return mount(
    <FilterConditionRow
      condition={condition}
      fields={METAS}
      fieldsById={BY_ID}
      onChange={() => undefined}
      onRemove={() => undefined}
    />,
  );
}

/** 受控壳：把每次 onChange 的结果记入 sink 并回灌，便于断言回落后的具体算子 */
function RowHarness(props: { initial: FilterCondition; sink: FilterCondition[] }): JSX.Element {
  const [condition, setCondition] = useState<FilterCondition>(props.initial);
  return (
    <FilterConditionRow
      condition={condition}
      fields={METAS}
      fieldsById={BY_ID}
      onChange={(next) => {
        props.sink.push(next);
        setCondition(next);
      }}
      onRemove={() => undefined}
    />
  );
}

/* ===================== ① 结构性替换（不是原生 select 了） ===================== */

describe('筛选字段下拉 · 已替换为可搜索 combobox', () => {
  it('filter-field-select 是 role=combobox 的 input（不是 HTMLSelectElement）', () => {
    const view = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    const combo = view.find('filter-field-select') as HTMLInputElement;

    expect(combo).not.toBeNull();
    expect(combo.tagName).not.toBe('SELECT');
    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.getAttribute('aria-expanded')).toBe('false');
    // 字段控件容器内**不再有原生 <option>**（算子下拉仍是原生 select，故只针对字段控件范围断言）
    expect(combo.parentElement?.className).toContain('cbv-fieldselect');
    expect(combo.parentElement?.querySelectorAll('option').length ?? 0).toBe(0);
    view.unmount();
  });

  it('保留 data-testid 与 aria-label="筛选字段"；无效态 aria-invalid 仍在触发体上', () => {
    const invalid = renderRow(cond('c1', 'f_amount', 'contains', '1'));
    const invalidCombo = invalid.find('filter-field-select');
    expect(invalidCombo?.getAttribute('aria-label')).toBe('筛选字段');
    expect(invalidCombo?.getAttribute('aria-invalid')).toBe('true');
    invalid.unmount();

    // 正面锚点：有效条件下**不得**带 aria-invalid（证伪「一律 aria-invalid」）
    const valid = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    expect(valid.find('filter-field-select')?.getAttribute('aria-invalid')).toBeNull();
    valid.unmount();
  });
});

/* ===================== ② 候选集不变式 ===================== */

describe('筛选字段下拉 · 候选集仍受可筛性约束', () => {
  it('候选 = 全部可筛字段（顺序与标签逐字正确），不可筛字段不在候选里', () => {
    const view = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    clickOpen(view.find('filter-field-select'));
    expect(optionValues(view)).toEqual(FILTERABLE_IDS);
    expect(optionLabels(view)).toEqual(FILTERABLE_LABELS);
    expect(view.html()).not.toContain('异类字段');
    view.unmount();
  });

  it('当前字段不可筛（历史配置）→ 仍出现在候选首位并标注「不支持筛选」', () => {
    const view = renderRow(cond('c1', 'f_weird', 'contains', 'x'));
    const combo = view.find('filter-field-select') as HTMLInputElement;
    expect(combo.value).toBe('异类字段（不支持筛选）');
    clickOpen(combo);
    expect(optionValues(view)).toEqual(['f_weird', ...FILTERABLE_IDS]);
    expect(optionLabels(view)[0]).toBe('异类字段（不支持筛选）');
    view.unmount();
  });
});

/* ===================== ③ 模糊查询 ===================== */

describe('筛选字段下拉 · 模糊查询', () => {
  it('输入「文本」→ 只剩文本型字段（确切标签序列）', () => {
    const view = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    const combo = view.find('filter-field-select') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '文本');
    expect(optionLabels(view)).toEqual(['标题（文本）']);
    expect(optionValues(view)).toEqual(['f_title']);
    view.unmount();
  });

  it('输入「成员」→ 按类型标签命中「负责人」（不必记字段名）', () => {
    const view = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    const combo = view.find('filter-field-select') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '成员');
    expect(optionLabels(view)).toEqual(['负责人（成员）']);
    view.unmount();
  });

  it('无匹配 → 确切空态文案', () => {
    const view = renderRow(cond('c1', 'f_title', 'contains', '甲'));
    const combo = view.find('filter-field-select') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '没有这个字段');
    expect(view.find('filter-field-select-empty')?.textContent).toBe('无匹配字段');
    expect(view.findAll('filter-field-select-option')).toHaveLength(0);
    view.unmount();
  });
});

/* ===================== ④ 原语义：算子回落（分离夹具） ===================== */

describe('筛选字段下拉 · onChange 仍走 resolveConditionOnFieldChange（算子回落 + 清空值）', () => {
  it('键盘 ↓ + Enter 选中「金额」→ 算子从 contains 回落到 is，值被清空', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_title', 'contains', '甲')} sink={sink} />);
    const combo = view.find('filter-field-select') as HTMLInputElement;

    keyDown(combo, 'ArrowDown'); // 打开，高亮落在当前值（f_title，index 0）
    keyDown(combo, 'ArrowDown'); // 移到 index 1 = 金额
    keyDown(combo, 'Enter');

    expect(sink).toHaveLength(1);
    expect(sink[0].fieldId).toBe('f_amount');
    expect(sink[0].operator).toBe('is'); // 数字类型第一个可用算子
    expect('value' in sink[0]).toBe(false); // 值被清空（键都不写回）
    expect(sink[0].conditionId).toBe('c1'); // 条件 id 不变，只是换了字段
    view.unmount();
  });

  it('⭐ 分离链路：切到「成员」字段时 **保留** contains（证伪「回落逻辑被写成恒 is」）', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_title', 'contains', '甲')} sink={sink} />);
    const combo = view.find('filter-field-select') as HTMLInputElement;
    clickOpen(combo);

    const ownerOption = view
      .findAll('filter-field-select-option')
      .find((el) => el.getAttribute('data-option-value') === 'f_owner');
    expect(ownerOption).not.toBeUndefined();
    act(() => {
      ownerOption?.click();
    });

    expect(sink).toHaveLength(1);
    expect(sink[0].fieldId).toBe('f_owner');
    expect(sink[0].operator).toBe('contains'); // 成员字段允许 contains → 保留，不是 is
    expect('value' in sink[0]).toBe(false); // 但值照样清空
    view.unmount();
  });

  it('点选后 UI 同步：算子下拉的选中值 = 回落后的具体算子', () => {
    const sink: FilterCondition[] = [];
    const view = mount(<RowHarness initial={cond('c1', 'f_title', 'contains', '甲')} sink={sink} />);
    clickOpen(view.find('filter-field-select'));
    const amountOption = view
      .findAll('filter-field-select-option')
      .find((el) => el.getAttribute('data-option-value') === 'f_amount');
    act(() => {
      amountOption?.click();
    });
    expect((view.find('filter-operator-select') as HTMLSelectElement).value).toBe('is');
    view.unmount();
  });
});
