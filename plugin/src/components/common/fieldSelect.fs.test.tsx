/**
 * `FieldSelect` 组件测试（工程师 · engineer-fs）。
 *
 * 需求来源（用户反馈）：「字段选择框需要支持字段模糊查询，不然字段太多很难选择」。
 *
 * ⭐ 断言纪律（团队禁令：禁止假绿）：
 *  - **确切序列**：搜索过滤后断言**剩下的确切标签序列**（不是「项数变少」）；
 *  - **正向锚点**：每条否定式断言都配一个「实现正常时必须成立」的正面断言
 *    （如 Esc 不冒泡 ↔ 其他键必须冒泡）；
 *  - 覆盖键盘、a11y 属性、空态文案、受控性、浮层翻转（纯函数）。
 *
 * 环境：本仓无 `@testing-library/react`，沿用 `filterPanel.f4.test.tsx` 的
 * `createRoot` + `act` 直出 DOM 写法。
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FIELD_SELECT_EMPTY_TEXT,
  FieldSelect,
  filterFieldOptions,
  normalizeFieldQuery,
  shouldDropUp,
} from './FieldSelect';
import type { FieldSelectOption } from './FieldSelect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const OPTIONS: FieldSelectOption[] = [
  { value: 'f_name', label: '客户名称（文本）' },
  { value: 'f_amount', label: '金额（数字）' },
  { value: 'f_note', label: '备注（文本）' },
  { value: 'f_status', label: '状态（单选）' },
  { value: 'f_code', label: 'Code（文本）' },
];

/** 每个候选项的标签（严格按候选顺序） */
const ALL_LABELS = OPTIONS.map((option) => option.label);

/* ===================== 渲染 / 交互工具 ===================== */

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

/** 点击打开浮层（等价用户点击触发体） */
function clickOpen(el: HTMLElement | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.click();
  });
}

/** 派发键盘事件（React 委托在根容器上，直接派发即可命中组件处理器） */
function keyDown(el: HTMLElement | null, key: string): void {
  expect(el).not.toBeNull();
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/**
 * 绕过 React 的 `_valueTracker` 写入 input 值（等价 RTL `fireEvent.change`）：
 * 直接用 `el.value = x` 会更新 tracker，React 会认为「值没变」而不触发 onChange。
 */
function typeInto(el: HTMLInputElement | null, value: string): void {
  expect(el).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function mouseDown(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

/** 候选值序列（按渲染顺序） */
function optionValues(view: Mounted): string[] {
  return view.findAll('fs-option').map((el) => el.getAttribute('data-option-value') ?? '');
}

/** 候选标签序列（按渲染顺序）——搜索过滤的核心断言对象 */
function optionLabels(view: Mounted): string[] {
  return view
    .findAll('fs-option')
    .map((el) => el.querySelector('.cbv-fieldselect__option-label')?.textContent ?? '');
}

function renderSelect(value = 'f_name', onChange: (next: string) => void = () => undefined): Mounted {
  return mount(
    <FieldSelect options={OPTIONS} value={value} onChange={onChange} searchable testId="fs" ariaLabel="字段" />,
  );
}

/* ===================== ① 关闭态 / a11y 基本契约 ===================== */

describe('FieldSelect · 关闭态与无障碍基本契约', () => {
  it('触发体是 role=combobox 的可编辑输入，显示当前值标签，浮层未挂载', () => {
    const view = renderSelect('f_amount');
    const combo = view.find('fs') as HTMLInputElement;

    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.getAttribute('aria-haspopup')).toBe('listbox');
    expect(combo.getAttribute('aria-expanded')).toBe('false');
    expect(combo.getAttribute('aria-label')).toBe('字段');
    expect(combo.value).toBe('金额（数字）');
    // 反号：关闭时不得残留 aria-activedescendant（否则读屏会指向不存在的项）
    expect(combo.getAttribute('aria-activedescendant')).toBeNull();
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });

  it('展开后 aria-expanded=true、aria-controls 指向真实存在的 listbox、候选与 options 一一对应', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);

    expect(combo.getAttribute('aria-expanded')).toBe('true');
    const controls = combo.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const listbox = view.container.querySelector(`[id="${String(controls)}"]`);
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute('role')).toBe('listbox');

    expect(optionValues(view)).toEqual(OPTIONS.map((option) => option.value));
    expect(optionLabels(view)).toEqual(ALL_LABELS);
    view.unmount();
  });

  it('disabled：触发体带 disabled 属性（不可编辑 / 不可展开）', () => {
    const view = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable disabled testId="fs" />,
    );
    const combo = view.find('fs') as HTMLInputElement;
    expect(combo.disabled).toBe(true);
    clickOpen(combo);
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });
});

/* ===================== ② 模糊查询（核心需求） ===================== */

describe('FieldSelect · 模糊查询真的在过滤（断言确切标签序列）', () => {
  it('输入「文本」→ 只剩 3 个文本型字段，**顺序与标签逐字正确**', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '文本');

    expect(optionLabels(view)).toEqual(['客户名称（文本）', '备注（文本）', 'Code（文本）']);
    expect(optionValues(view)).toEqual(['f_name', 'f_note', 'f_code']);
    // 反号：不匹配的必须**真的消失**（证伪「只是变少/没过滤」）
    expect(optionLabels(view)).not.toContain('金额（数字）');
    expect(optionLabels(view)).not.toContain('状态（单选）');
    view.unmount();
  });

  it('输入「备注」→ 只命中该字段（字段名匹配）', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '备注');
    expect(optionLabels(view)).toEqual(['备注（文本）']);
    view.unmount();
  });

  it('输入「单选」→ 按**类型标签**命中（不需要记住字段名）', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '单选');
    expect(optionLabels(view)).toEqual(['状态（单选）']);
    view.unmount();
  });

  it('大小写不敏感：code / CODE / CoDe 三种写法命中同一项', () => {
    for (const query of ['code', 'CODE', 'CoDe']) {
      const view = renderSelect();
      const combo = view.find('fs') as HTMLInputElement;
      clickOpen(combo);
      typeInto(combo, query);
      expect(optionLabels(view)).toEqual(['Code（文本）']);
      view.unmount();
    }
  });

  it('hint 也参与匹配（次要说明可作为搜索词）', () => {
    const options: FieldSelectOption[] = [
      { value: 'a', label: '甲（文本）', hint: '支持包含 / 为空' },
      { value: 'b', label: '乙（数字）', hint: '支持大于 / 小于' },
    ];
    const view = mount(<FieldSelect options={options} value="a" onChange={() => undefined} searchable testId="fs" />);
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '大于');
    expect(optionLabels(view)).toEqual(['乙（数字）']);
    view.unmount();
  });

  it('清空查询 → 候选**完整恢复**（证伪「搜过一次就永久残缺」）', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '数字');
    expect(optionLabels(view)).toEqual(['金额（数字）']);
    typeInto(combo, '');
    expect(optionLabels(view)).toEqual(ALL_LABELS);
    view.unmount();
  });
});

/* ===================== ③ 空态（不能一片空白） ===================== */

describe('FieldSelect · 无匹配时的显式空态', () => {
  it('无匹配 → 确切空态文案 + listbox 中 0 个候选项', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, 'zzz-不存在');

    expect(FIELD_SELECT_EMPTY_TEXT).toBe('无匹配字段');
    expect(view.find('fs-empty')).not.toBeNull();
    expect(view.find('fs-empty')?.textContent).toBe(FIELD_SELECT_EMPTY_TEXT);
    expect(view.findAll('fs-option')).toHaveLength(0);
    // 正面锚点：查询改回可命中后，空态必须消失、候选回来（证伪「空态恒显示」）
    typeInto(combo, '状态');
    expect(view.find('fs-empty')).toBeNull();
    expect(optionLabels(view)).toEqual(['状态（单选）']);
    view.unmount();
  });
});

/* ===================== ④ 键盘可达 ===================== */

describe('FieldSelect · 键盘操作', () => {
  it('↑/↓ 打开并移动高亮，Enter 选中确切值（走 onChange）', () => {
    const onChange = vi.fn();
    const view = renderSelect('f_name', onChange);
    const combo = view.find('fs') as HTMLInputElement;

    // 关闭态按 ↓ → 打开，高亮落在当前值（index 0）
    keyDown(combo, 'ArrowDown');
    expect(combo.getAttribute('aria-expanded')).toBe('true');
    keyDown(combo, 'ArrowDown'); // 移到 index 1 = 金额
    keyDown(combo, 'Enter');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('f_amount');
    // 选中后关闭浮层（正面锚点：不是「一直开着」）
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });

  it('↑ 从当前值反向移动（wrap）后 Enter 选中最后一个字段', () => {
    const onChange = vi.fn();
    const view = renderSelect('f_name', onChange);
    const combo = view.find('fs') as HTMLInputElement;
    keyDown(combo, 'ArrowDown'); // 打开，高亮 0
    keyDown(combo, 'ArrowUp'); // wrap 到最后一个
    keyDown(combo, 'Enter');
    expect(onChange).toHaveBeenCalledWith('f_code');
    view.unmount();
  });

  it('aria-activedescendant 跟随高亮；aria-selected 只落在当前值上', () => {
    const view = renderSelect('f_name');
    const combo = view.find('fs') as HTMLInputElement;
    keyDown(combo, 'ArrowDown'); // 打开 → 高亮 0

    expect(combo.getAttribute('aria-activedescendant')).toBe(view.findAll('fs-option')[0].id);
    expect(view.findAll('fs-option').map((el) => el.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);

    keyDown(combo, 'ArrowDown'); // 高亮 1
    expect(combo.getAttribute('aria-activedescendant')).toBe(view.findAll('fs-option')[1].id);
    // 高亮变了，但**选中值**没变（当前值仍是 f_name）
    expect(view.findAll('fs-option').map((el) => el.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    view.unmount();
  });

  it('Tab 不拦截默认行为（能正常离开），仅顺带收起浮层', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    expect(view.find('fs-popup')).not.toBeNull();

    let defaultPrevented = true;
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      combo.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
    });
    expect(defaultPrevented).toBe(false); // 不得 preventDefault
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });

  it('Esc 关闭且**不冒泡**（外层 onKeyDown 不被调用）；正面对照：其他键必须冒泡', () => {
    const outer = vi.fn();
    const view = mount(
      <div onKeyDown={outer}>
        <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable testId="fs" />
      </div>,
    );
    const combo = view.find('fs') as HTMLInputElement;

    clickOpen(combo);
    expect(view.find('fs-popup')).not.toBeNull();
    keyDown(combo, 'Escape');
    expect(view.find('fs-popup')).toBeNull(); // 关掉了
    expect(outer).not.toHaveBeenCalled(); // 且没冒泡出去

    // 正面锚点：同一外层监听对非 Esc 键**一定**会被调用（否则上面的 not.toHaveBeenCalled 恒真）
    clickOpen(combo);
    keyDown(combo, 'a');
    expect(outer).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

/* ===================== ⑤ 关闭行为 ===================== */

describe('FieldSelect · 点击外部 / 内部', () => {
  it('点击浮层外部 → 关闭；点击内部 → 保持打开', () => {
    const view = renderSelect();
    const combo = view.find('fs') as HTMLInputElement;

    clickOpen(combo);
    mouseDown(combo); // 内部
    expect(view.find('fs-popup')).not.toBeNull();

    mouseDown(document.body); // 外部
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });

  it('点击候选项 → onChange 收到该值并关闭', () => {
    const onChange = vi.fn();
    const view = renderSelect('f_name', onChange);
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    const target = view.findAll('fs-option').find((el) => el.getAttribute('data-option-value') === 'f_status');
    expect(target).not.toBeUndefined();
    act(() => {
      target?.click();
    });
    expect(onChange).toHaveBeenCalledWith('f_status');
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });
});

/* ===================== ⑥ 受控性 ===================== */

describe('FieldSelect · 完全受控（内部不保留真源）', () => {
  function Controlled(): JSX.Element {
    const [value, setValue] = useState('f_name');
    return (
      <div>
        <button type="button" data-testid="fs-set" onClick={() => setValue('f_status')}>
          set
        </button>
        <FieldSelect options={OPTIONS} value={value} onChange={setValue} searchable testId="fs" />
      </div>
    );
  }

  it('外部改变 value → 显示跟随（组件自己不会「记住」旧值）', () => {
    const view = mount(<Controlled />);
    expect((view.find('fs') as HTMLInputElement).value).toBe('客户名称（文本）');
    act(() => {
      view.find('fs-set')?.click();
    });
    expect((view.find('fs') as HTMLInputElement).value).toBe('状态（单选）');
    view.unmount();
  });
});

/* ===================== ⑦ 纯函数：过滤 / 翻转 ===================== */

describe('FieldSelect · 纯函数', () => {
  it('normalizeFieldQuery：忽略两端空白 + 大小写不敏感', () => {
    expect(normalizeFieldQuery('  Code  ')).toBe('code');
    expect(normalizeFieldQuery('')).toBe('');
  });

  it('filterFieldOptions：空查询返回全部（且不是同一引用，防调用方误改）', () => {
    const all = filterFieldOptions(OPTIONS, '');
    expect(all).toEqual(OPTIONS);
    expect(all).not.toBe(OPTIONS);
    expect(filterFieldOptions(OPTIONS, '文本').map((option) => option.value)).toEqual(['f_name', 'f_note', 'f_code']);
    expect(filterFieldOptions(OPTIONS, 'zzz')).toEqual([]);
  });

  it('shouldDropUp：下方够 → false；下方不足且上方更大 → true；上方也小 → 仍 false', () => {
    // 下方 470px ≥ 240 → 向下
    expect(shouldDropUp({ top: 100, bottom: 130 }, 600)).toBe(false);
    // 下方 70px < 240，上方 500px > 70 → 向上翻转
    expect(shouldDropUp({ top: 500, bottom: 530 }, 600)).toBe(true);
    // 下方 20px < 240，上方 10px 也不大 → 仍向下（不无脑翻转）
    expect(shouldDropUp({ top: 10, bottom: 580 }, 600)).toBe(false);
  });
});
