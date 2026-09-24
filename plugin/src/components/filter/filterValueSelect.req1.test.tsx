/**
 * req1 · 筛选值输入：单选 → 可搜下拉、多选 → 可搜多选、布尔 → 可搜下拉。
 *
 * 需求（用户原话）：「筛选字段，字段为下拉单选、多选类型字段需要提供关键字索引」。
 * 背景：值控件原为原生 `<select>`——选项多（数百）时中文无法定位；且多选字段实际只能选一个值。
 *
 * ⭐ 断言纪律（团队禁令：禁止假绿）：
 *  - 断言**确切序列**（过滤后剩哪些选项，逐字）；
 *  - 每条否定式断言都配一个「实现正常时必须成立」的正面锚点；
 *  - 引擎联动用**真实** `evaluateFilter`（不 mock），如实锁实际语义。
 *
 * 环境：本仓无 `@testing-library/react`，沿用 `filterPanel.f4.test.tsx` 的
 * `createRoot` + `act` 直出 DOM 写法。
 */
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SdkRecord } from '@/sdk/port';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { FieldMetaMap } from '@/filter/engine';
import { evaluateFilter } from '@/filter/engine';
import { getValueInputKind } from '@/filter/operatorMatrix';
import type { FilterCondition, FilterOperator } from '@/filter/types';
import { FilterConditionRow } from './FilterConditionRow';
import { defaultValueForKind } from './FilterValueInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  {
    id: 'f_status',
    name: '状态',
    type: FieldType.SingleSelect,
    isPrimary: false,
    property: { options: [{ name: '进行中' }, { name: '已完成' }, { name: '已延期' }] },
  },
  {
    id: 'f_tags',
    name: '标签',
    type: FieldType.MultiSelect,
    isPrimary: false,
    property: { options: [{ name: '甲' }, { name: '乙' }, { name: '丙' }, { name: '丁' }] },
  },
  { id: 'f_flag', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
];

const byId: FieldMetaMap = {};
for (const meta of metas) byId[meta.id] = meta;

function cond(conditionId: string, fieldId: string, operator: FilterOperator, value?: unknown): FilterCondition {
  const condition: FilterCondition = { conditionId, fieldId, operator };
  if (value !== undefined) condition.value = value;
  return condition;
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

function clickButton(el: HTMLElement | null): void {
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

/** 绕过 React `_valueTracker` 写入 input 值（等价 RTL `fireEvent.change`） */
function typeInto(el: HTMLInputElement | null, value: string): void {
  expect(el).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 候选项的 `data-option-value` 序列（按渲染顺序） */
function optionValues(view: Mounted): string[] {
  return view.findAll('filter-value-input-option').map((el) => el.getAttribute('data-option-value') ?? '');
}

function chooseOption(view: Mounted, value: string): void {
  const target = view
    .findAll('filter-value-input-option')
    .find((el) => el.getAttribute('data-option-value') === value);
  expect(target, `候选中应存在 value=${value}`).not.toBeUndefined();
  clickButton(target ?? null);
}

/** 受控壳：记录每次 onChange 并回灌，便于断言写回的确切值 */
function RowHarness(props: { initial: FilterCondition; sink: FilterCondition[] }): JSX.Element {
  const [condition, setCondition] = useState<FilterCondition>(props.initial);
  return (
    <FilterConditionRow
      condition={condition}
      fields={metas}
      fieldsById={byId}
      onChange={(next) => {
        props.sink.push(next);
        setCondition(next);
      }}
      onRemove={() => undefined}
    />
  );
}

function renderControlled(initial: FilterCondition): { view: Mounted; sink: FilterCondition[] } {
  const sink: FilterCondition[] = [];
  const view = mount(<RowHarness initial={initial} sink={sink} />);
  return { view, sink };
}

/* ===================== ① 单选值 → 可搜下拉 ===================== */

describe('req1 · 单选值输入（可搜下拉）', () => {
  it('是 role=combobox 的 input，显示当前选项名；候选含选项名与「请选择」', () => {
    const { view } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    const combo = view.find('filter-value-input') as HTMLInputElement;

    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.getAttribute('aria-label')).toBe('筛选值');
    expect(combo.value).toBe('进行中');

    clickButton(combo);
    expect(combo.getAttribute('aria-expanded')).toBe('true');
    expect(optionValues(view)).toEqual(['', '进行中', '已完成', '已延期']);
    view.unmount();
  });

  it('输入「已完成」→ **只剩该选项**（确切序列；证伪「只是变少 / 没过滤」）', () => {
    const { view } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    const combo = view.find('filter-value-input') as HTMLInputElement;
    clickButton(combo);
    typeInto(combo, '已完成');

    expect(optionValues(view)).toEqual(['已完成']);
    // 反号 + 正面锚点：不匹配的必须真的消失，且改回可命中时恢复
    expect(optionValues(view)).not.toContain('进行中');
    typeInto(combo, '');
    expect(optionValues(view)).toEqual(['', '进行中', '已完成', '已延期']);
    view.unmount();
  });

  it('无匹配 → 确切空态文案「无匹配选项」；改回可命中则空态消失', () => {
    const { view } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    const combo = view.find('filter-value-input') as HTMLInputElement;
    clickButton(combo);
    typeInto(combo, 'zzz-不存在');

    expect(view.find('filter-value-input-empty')?.textContent).toBe('无匹配选项');
    expect(view.findAll('filter-value-input-option')).toHaveLength(0);

    typeInto(combo, '延期');
    expect(view.find('filter-value-input-empty')).toBeNull();
    expect(optionValues(view)).toEqual(['已延期']);
    view.unmount();
  });

  it('点选候选项 → onChange 写回**选项名（string）**', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    clickButton(view.find('filter-value-input'));
    chooseOption(view, '已完成');

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toBe('已完成');
    expect(typeof sink[0].value).toBe('string');
    view.unmount();
  });

  it('选中「请选择」（value=""）→ 值写回空串（可清空回未选）', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    clickButton(view.find('filter-value-input'));
    chooseOption(view, '');

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toBe('');
    view.unmount();
  });

  it('键盘：↓ 打开并移动高亮，Enter 选中确切选项', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_status', 'is', '进行中'));
    const combo = view.find('filter-value-input') as HTMLInputElement;

    keyDown(combo, 'ArrowDown'); // 打开，高亮落在当前值「进行中」(index 1)
    keyDown(combo, 'ArrowDown'); // 移到 index 2 = 已完成
    keyDown(combo, 'Enter');

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toBe('已完成');
    expect(view.find('filter-value-input-popup')).toBeNull(); // 选中后关闭
    view.unmount();
  });

  it('Esc 关闭浮层且**不冒泡**（外层 onKeyDown 不被调用）；正面对照：其他键必须冒泡', () => {
    const outer: string[] = [];
    const sink: FilterCondition[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <div onKeyDown={(event) => outer.push(event.key)}>
          <FilterConditionRow
            condition={cond('c1', 'f_status', 'is', '进行中')}
            fields={metas}
            fieldsById={byId}
            onChange={(next) => sink.push(next)}
            onRemove={() => undefined}
          />
        </div>,
      );
    });
    const view: Mounted = {
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
    const combo = view.find('filter-value-input') as HTMLInputElement;

    clickButton(combo);
    expect(view.find('filter-value-input-popup')).not.toBeNull();
    keyDown(combo, 'Escape');
    expect(view.find('filter-value-input-popup')).toBeNull(); // 关掉了
    expect(outer).toHaveLength(0); // 且没冒泡出去

    // 正面锚点：同一外层监听对非 Esc 键**一定**会被调用（否则上面 toHaveLength(0) 恒真）
    clickButton(combo);
    keyDown(combo, 'a');
    expect(outer).toEqual(['a']);
    view.unmount();
  });
});

/* ===================== ② 多选值 → 可搜多选 ===================== */

describe('req1 · 多选值输入（可搜多选）', () => {
  it('渲染 role=combobox 的搜索框；无已选时无 chip', () => {
    const { view } = renderControlled(cond('c1', 'f_tags', 'contains'));
    const combo = view.find('filter-value-input') as HTMLInputElement;

    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(view.findAll('filter-value-input-chip')).toHaveLength(0);
    view.unmount();
  });

  it('输入「甲」→ **只剩甲**（确切序列）', () => {
    const { view } = renderControlled(cond('c1', 'f_tags', 'contains'));
    const combo = view.find('filter-value-input') as HTMLInputElement;
    clickButton(combo);
    typeInto(combo, '甲');
    expect(optionValues(view)).toEqual(['甲']);
    view.unmount();
  });

  it('连续勾选多个 → onChange 每次收到**最新整份 string[]**，并出现对应 chips', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_tags', 'contains'));
    clickButton(view.find('filter-value-input'));

    chooseOption(view, '甲');
    expect(sink).toHaveLength(1);
    expect(sink[0].value).toEqual(['甲']);
    chooseOption(view, '丙');
    expect(sink).toHaveLength(2);
    expect(sink[1].value).toEqual(['甲', '丙']); // 追加，不是替换

    // chips 反映已选（正面对照：确实产生了 2 个 chip，且带正确 data-chip-value）
    const chips = view.findAll('filter-value-input-chip').map((el) => el.getAttribute('data-chip-value'));
    expect(chips).toEqual(['甲', '丙']);
    // 勾选后浮层**不关闭**（可连续选）
    expect(view.find('filter-value-input-popup')).not.toBeNull();
    view.unmount();
  });

  it('再点同一项 → 取消勾选（值移除该选项）', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_tags', 'contains', ['甲', '丙']));
    clickButton(view.find('filter-value-input'));
    chooseOption(view, '甲');

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toEqual(['丙']);
    view.unmount();
  });

  it('chip 上的 ✕ → 只移除该值；「清空」→ onChange([])', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_tags', 'contains', ['甲', '乙', '丙']));

    const remove乙 = view
      .findAll('filter-value-input-chip-remove')
      .find((el) => el.getAttribute('data-chip-value') === '乙');
    clickButton(remove乙 ?? null);
    expect(sink[0].value).toEqual(['甲', '丙']);

    clickButton(view.find('filter-value-input-clear'));
    expect(sink[1].value).toEqual([]);
    view.unmount();
  });

  it('无匹配 → 确切空态文案「无匹配选项」', () => {
    const { view } = renderControlled(cond('c1', 'f_tags', 'contains'));
    const combo = view.find('filter-value-input') as HTMLInputElement;
    clickButton(combo);
    typeInto(combo, '没有这个选项');
    expect(view.find('filter-value-input-empty')?.textContent).toBe('无匹配选项');
    expect(view.findAll('filter-value-input-option')).toHaveLength(0);
    view.unmount();
  });

  it('键盘 ↑↓ + Enter 切换高亮项（选中后保持浮层打开）', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_tags', 'contains'));
    const combo = view.find('filter-value-input') as HTMLInputElement;

    keyDown(combo, 'ArrowDown'); // 打开，高亮 0 = 甲
    keyDown(combo, 'ArrowDown'); // 高亮 1 = 乙
    keyDown(combo, 'Enter'); // 切换乙

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toEqual(['乙']);
    expect(view.find('filter-value-input-popup')).not.toBeNull();
    view.unmount();
  });
});

/* ===================== ③ 引擎联动（真实 evaluateFilter） ===================== */

describe('req1 · 多选值 × 引擎真实语义（不用 mock）', () => {
  /**
   * 引擎语义（`filter/engine.ts` 的 `toContainsKeywords` + `matchContains`）：
   *  - 「包含」的**数组值**（多选/成员等多值条件）→ 每个非空元素各成一个关键字，
   *    语义 = **任一关键字命中任一选项即命中**（与原生多维表格多选「包含」一致）；
   *  - 单值条件 → 仍按子串匹配（与修复前逐字等价）。
   *
   * 历史（2026-09-23 主理人裁定）：修复前数组被 `toText` 以「、」拼成单个关键字，
   * `['甲','乙']` → `'甲、乙'`，与任何**单个**选项文本都不构成子串关系 ⇒
   * 「多选筛选项选了 ≥2 个时一条都筛不到，且不报错」（静默 false negative）。
   */
  const records: SdkRecord[] = [
    { recordId: 'r1', fields: { f_tags: ['甲', '乙'] } },
    { recordId: 'r2', fields: { f_tags: ['乙', '丙'] } },
    { recordId: 'r3', fields: { f_tags: ['丁'] } },
  ] as unknown as SdkRecord[];

  it('选**一个**选项 + 「包含」→ 命中含该选项的记录（这正是「关键字索引」的主用法）', () => {
    const filter = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', ['甲'])],
    };
    expect(records.filter((record) => evaluateFilter(filter, record, byId)).map((r) => r.recordId)).toEqual(['r1']);
    // 正面锚点：换成别的选项，命中集合随之变化（证伪「恒命中 r1」）
    const other = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', ['丙'])],
    };
    expect(records.filter((record) => evaluateFilter(other, record, byId)).map((r) => r.recordId)).toEqual(['r2']);
  });

  it('多选值等值集合 + 「等于」→ 命中**完全一致（含顺序）**的记录', () => {
    const filter = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'is', ['甲', '乙'])],
    };
    expect(evaluateFilter(filter, records[0], byId)).toBe(true); // r1 = [甲,乙]
    expect(evaluateFilter(filter, records[1], byId)).toBe(false); // r2 = [乙,丙]
  });

  it('多选值 ≥2 项 + 「包含」→ **任一命中即命中**（修复后语义）', () => {
    const filter = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', ['甲', '乙'])],
    };
    // r1=[甲,乙] 含「甲」；r2=[乙,丙] 含「乙」；r3=[丁] 都不含
    expect(records.filter((record) => evaluateFilter(filter, record, byId)).map((r) => r.recordId)).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('判别性对照：只命中「第二个」关键字的记录也必须被选出（旧拼接语义下必为 false）', () => {
    // 这条用例是「旧实现必红」的判别器：r2 = [乙,丙]，条件 ['甲','乙']
    //  - 旧语义：toText(['甲','乙']) === '甲、乙' → r2 的选项文本均不含该子串 → false
    //  - 新语义：任一命中 → 命中「乙」→ true
    const filter = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', ['甲', '乙'])],
    };
    expect(evaluateFilter(filter, records[1], byId)).toBe(true);
  });

  it('多选值 ≥2 项 + 「不包含」→ 含**任一**者被排除、不含者保留', () => {
    const filter = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'doesNotContain', ['甲', '乙'])],
    };
    // r1/r2 含 甲 或 乙 → 排除；r3=[丁] → 保留
    expect(records.filter((record) => evaluateFilter(filter, record, byId)).map((r) => r.recordId)).toEqual(['r3']);
  });

  it('空数组 / 全空串数组 → 判「未填写」→ **记录保留**（条件被跳过，不得筛光）', () => {
    for (const value of [[], ['', '  ']]) {
      const filter = {
        enabled: true,
        conjunction: 'and' as const,
        conditions: [cond('c1', 'f_tags', 'contains', value)],
      };
      expect(records.filter((record) => evaluateFilter(filter, record, byId)).map((r) => r.recordId)).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
    }
    // 正面锚点：同一字段换成有效值确实会收窄（证伪「筛选恒不过滤」）
    const narrowed = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', ['丁'])],
    };
    expect(records.filter((record) => evaluateFilter(narrowed, record, byId)).map((r) => r.recordId)).toEqual(['r3']);
  });

  it('值无法构成关键字（对象等不可读值）→ 判「未生效」→ **记录保留**（不得静默筛空）', () => {
    for (const value of [{ a: 1 }, { name: '甲' }]) {
      const filter = {
        enabled: true,
        conjunction: 'and' as const,
        conditions: [cond('c1', 'f_tags', 'contains', value)],
      };
      // 反面：若判 noMatch，会把三条记录全部筛掉且不报错（QA 2026-09-23 提出的同族风险）
      expect(records.filter((record) => evaluateFilter(filter, record, byId)).map((r) => r.recordId)).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
    }
    // 正面锚点：同字段换有效关键字确实会收窄（证伪「筛选恒不过滤」）
    const narrowed = {
      enabled: true,
      conjunction: 'and' as const,
      conditions: [cond('c1', 'f_tags', 'contains', '丁')],
    };
    expect(records.filter((record) => evaluateFilter(narrowed, record, byId)).map((r) => r.recordId)).toEqual(['r3']);
  });
});

/* ===================== ④ 布尔值 → 可搜下拉（等价映射） ===================== */

describe('req1 · 布尔值输入（复用 FieldSelect，映射等价）', () => {
  it('value=true → 显示「是」；候选序列恰为 ["", "true", "false"]', () => {
    const { view } = renderControlled(cond('c1', 'f_flag', 'is', true));
    const combo = view.find('filter-value-input') as HTMLInputElement;
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.value).toBe('是');

    clickButton(combo);
    expect(optionValues(view)).toEqual(['', 'true', 'false']);
    view.unmount();
  });

  it('选中「否」→ onChange 写回布尔 false（不是字符串）', () => {
    const { view, sink } = renderControlled(cond('c1', 'f_flag', 'is', true));
    clickButton(view.find('filter-value-input'));
    chooseOption(view, 'false');

    expect(sink).toHaveLength(1);
    expect(sink[0].value).toBe(false);
    expect(typeof sink[0].value).toBe('boolean');
    view.unmount();
  });
});

/* ===================== ⑤ 纯函数 ===================== */

describe('req1 · 形态与默认值（纯函数）', () => {
  it('多选字段的值形态是专用 `multiSelect`（不再退化为 `select`）', () => {
    expect(getValueInputKind(FieldType.MultiSelect)).toBe('multiSelect');
    expect(getValueInputKind(FieldType.SingleSelect)).toBe('select');
  });

  it('defaultValueForKind：multiSelect → []（空数组，引擎判「未填写」），select/text → ""', () => {
    expect(defaultValueForKind('multiSelect')).toEqual([]);
    expect(defaultValueForKind('select')).toBe('');
    expect(defaultValueForKind('text')).toBe('');
    expect(defaultValueForKind('boolean')).toBe(true);
    expect(defaultValueForKind('number')).toBeUndefined();
  });
});
