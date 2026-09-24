/**
 * req1 · `FieldSelect` 的「可搜提示」与「浮层可用性」。
 *
 * 背景（真机观感）：触发体显示的是字段名而非「搜索」，无放大镜图标、浮层内无提示
 * → 用户看不出「这里能打字过滤」。本文件锁：
 *  1. `searchableHint` 开启时才出现 🔍 图标与浮层顶部提示行（**默认不出现**，证伪「恒显示」）；
 *  2. 浮层最小宽度生效（窄触发体不再把浮层压到 ~96px 导致中文标签截断）；
 *  3. `emptyText` 可覆写，**默认仍为「无匹配字段」**（既有断言口径）；
 *  4. 提示为**纯视觉**——不改变任何搜索/选择行为（正面锚点：开了提示仍能正常过滤/选中）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FIELD_SELECT_EMPTY_TEXT,
  FIELD_SELECT_POPUP_MIN_WIDTH,
  FIELD_SELECT_SEARCH_HINT_TEXT,
  FieldSelect,
} from './FieldSelect';
import type { FieldSelectOption } from './FieldSelect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: FieldSelectOption[] = [
  { value: 'f_name', label: '客户名称（文本）' },
  { value: 'f_amount', label: '金额（数字）' },
  { value: 'f_note', label: '备注（文本）' },
];

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

function typeInto(el: HTMLInputElement | null, value: string): void {
  expect(el).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function optionLabels(view: Mounted): string[] {
  return view
    .findAll('fs-option')
    .map((el) => el.querySelector('.cbv-fieldselect__option-label')?.textContent ?? '');
}

/* ===================== ① 可搜提示（opt-in，默认不显示） ===================== */

describe('req1 · FieldSelect 可搜提示', () => {
  it('searchableHint=true → 触发体带 🔍 图标 + 浮层顶部有「输入关键字筛选」提示行', () => {
    const view = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable searchableHint testId="fs" />,
    );
    // 触发体右侧的 🔍（纯装饰）
    expect(view.container.querySelector('.cbv-fieldselect__search-icon')).not.toBeNull();
    // 打开后浮层顶部提示行（确切文案）
    clickOpen(view.find('fs'));
    expect(FIELD_SELECT_SEARCH_HINT_TEXT).toBe('输入关键字筛选');
    expect(view.find('fs-hint')?.textContent).toBe(FIELD_SELECT_SEARCH_HINT_TEXT);
    view.unmount();
  });

  it('⭐ 默认（未传 searchableHint）→ 不显示提示（证伪「提示恒显示」）；正面对照：传了才显示', () => {
    const off = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable testId="fs" />,
    );
    expect(off.container.querySelector('.cbv-fieldselect__search-icon')).toBeNull();
    clickOpen(off.find('fs'));
    expect(off.find('fs-hint')).toBeNull();
    off.unmount();

    const on = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable searchableHint testId="fs" />,
    );
    clickOpen(on.find('fs'));
    expect(on.find('fs-hint')).not.toBeNull();
    on.unmount();
  });

  it('提示**不改变行为**：开了提示仍能按关键字过滤（正面锚点）', () => {
    const view = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable searchableHint testId="fs" />,
    );
    const combo = view.find('fs') as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '文本');
    expect(optionLabels(view)).toEqual(['客户名称（文本）', '备注（文本）']);
    view.unmount();
  });
});

/* ===================== ② 浮层最小宽度 ===================== */

describe('req1 · FieldSelect 浮层最小宽度', () => {
  it('窄触发体（jsdom 零矩形）→ 浮层宽度取最小值 240px，而非塌缩为 0 / 触发体宽', () => {
    const view = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable testId="fs" />,
    );
    clickOpen(view.find('fs'));
    const popup = view.find('fs-popup');
    expect(popup).not.toBeNull();
    // jsdom getBoundingClientRect 全 0 → 宽度应被抬到最小值（证明「不再是触发体宽度」）
    expect(FIELD_SELECT_POPUP_MIN_WIDTH).toBe(240);
    expect(popup?.style.width).toBe(`${FIELD_SELECT_POPUP_MIN_WIDTH}px`);
    view.unmount();
  });
});

/* ===================== ③ emptyText ===================== */

describe('req1 · FieldSelect 空态文案可覆写', () => {
  it('默认仍为「无匹配字段」；显式 emptyText → 覆盖', () => {
    const def = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable testId="fs" />,
    );
    clickOpen(def.find('fs'));
    typeInto(def.find('fs') as HTMLInputElement, 'zzz');
    expect(def.find('fs-empty')?.textContent).toBe('无匹配字段');
    expect(FIELD_SELECT_EMPTY_TEXT).toBe('无匹配字段');
    def.unmount();

    const custom = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={() => undefined} searchable emptyText="无匹配选项" testId="fs" />,
    );
    clickOpen(custom.find('fs'));
    typeInto(custom.find('fs') as HTMLInputElement, 'zzz');
    expect(custom.find('fs-empty')?.textContent).toBe('无匹配选项');
    custom.unmount();
  });
});

/* ===================== ④ 提示与选择互不干扰（回归锚点） ===================== */

describe('req1 · 提示与选择行为互不干扰', () => {
  it('开了提示后，点选候选项仍走 onChange（行为零回归）', () => {
    const onChange = vi.fn();
    const view = mount(
      <FieldSelect options={OPTIONS} value="f_name" onChange={onChange} searchable searchableHint testId="fs" />,
    );
    clickOpen(view.find('fs'));
    const target = view.findAll('fs-option').find((el) => el.getAttribute('data-option-value') === 'f_note');
    expect(target).not.toBeUndefined();
    act(() => {
      target?.click();
    });
    expect(onChange).toHaveBeenCalledWith('f_note');
    expect(view.find('fs-popup')).toBeNull();
    view.unmount();
  });
});
