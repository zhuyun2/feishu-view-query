/**
 * T06 · `PageNavigator` 单测。
 *
 * 断言：页码钳制纯函数、指示器文本、首/末页按钮禁用态、以及**真实交互**
 * （点击上一页/下一页、输入页码后提交跳转）确实回调 `onPageChange`。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageNavigator, clampPageIndex, formatPageIndicator } from './PageNavigator';
import type { PageNavigatorProps } from './PageNavigator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<() => void> = [];
afterEach(() => {
  while (mountedRoots.length > 0) mountedRoots.pop()?.();
});

function renderToDom(props: PageNavigatorProps): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(PageNavigator, props));
  return host;
}

function mount(props: PageNavigatorProps): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(PageNavigator, props));
  });
  mountedRoots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container };
}

/** React 受控输入：必须走原生 setter + input 事件，直接改 value 不会触发 onChange */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ===================== 纯函数 ===================== */

describe('页码纯逻辑', () => {
  it('clampPageIndex：钳制到 [0, total-1]；非法输入 → 0', () => {
    expect(clampPageIndex(5, 10)).toBe(5);
    expect(clampPageIndex(-3, 10)).toBe(0);
    expect(clampPageIndex(99, 10)).toBe(9);
    expect(clampPageIndex(Number.NaN, 10)).toBe(0);
    expect(clampPageIndex(2, 0)).toBe(0); // total 兜底为 1
  });

  it('formatPageIndicator：1 起、按 total 钳制', () => {
    expect(formatPageIndicator(0, 3)).toBe('1/3');
    expect(formatPageIndicator(2, 3)).toBe('3/3');
    expect(formatPageIndicator(10, 3)).toBe('3/3');
    expect(formatPageIndicator(0, 0)).toBe('1/1');
  });
});

/* ===================== 静态结构 ===================== */

describe('PageNavigator · 静态结构', () => {
  it('指示器 = n/total；首页「上一页」禁用、「下一页」可用', () => {
    const host = renderToDom({ currentPage: 0, totalPages: 3, onPageChange: () => undefined });
    expect(host.querySelector('[data-page-indicator="true"]')?.textContent).toBe('1/3');
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="prev"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="next"]')?.disabled).toBe(false);
  });

  it('末页「下一页」禁用', () => {
    const host = renderToDom({ currentPage: 2, totalPages: 3, onPageChange: () => undefined });
    expect(host.querySelector('[data-page-indicator="true"]')?.textContent).toBe('3/3');
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="next"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="prev"]')?.disabled).toBe(false);
  });

  it('disabled=true → 全部交互禁用（打印态 / 分页中）', () => {
    const host = renderToDom({ currentPage: 1, totalPages: 3, onPageChange: () => undefined, disabled: true });
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="prev"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="next"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-page-nav="go"]')?.disabled).toBe(true);
  });
});

/* ===================== 交互 ===================== */

describe('PageNavigator · 交互', () => {
  it('点击「下一页」→ onPageChange(1)', () => {
    const calls: number[] = [];
    const { container } = mount({ currentPage: 0, totalPages: 3, onPageChange: (page) => calls.push(page) });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-page-nav="next"]')?.click();
    });
    expect(calls).toEqual([1]);
  });

  it('点击「上一页」→ onPageChange(1)（从第 3 页回到第 2 页）', () => {
    const calls: number[] = [];
    const { container } = mount({ currentPage: 2, totalPages: 3, onPageChange: (page) => calls.push(page) });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-page-nav="prev"]')?.click();
    });
    expect(calls).toEqual([1]);
  });

  it('输入页码 3 提交 → onPageChange(2)（1 起 → 0 起）', () => {
    const calls: number[] = [];
    const { container } = mount({ currentPage: 0, totalPages: 5, onPageChange: (page) => calls.push(page) });
    const input = container.querySelector<HTMLInputElement>('[data-page-nav="input"]');
    const form = container.querySelector<HTMLFormElement>('.cbv-page-nav__jump');

    act(() => {
      if (input) setInputValue(input, '3');
    });
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual([2]);
  });
});
