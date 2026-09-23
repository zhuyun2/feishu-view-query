/**
 * `PageSetupPanel` 设计变更测试（2026-09-21，software-engineer-doc）。
 *
 * 变更：详情改为「单张连续长页」→ 面板**移除**「页眉 / 页码 / 页脚」编辑控件，
 * **保留**「纸张尺寸 / 方向 / 页边距」（决定内容宽度，影响文字换行位置）。
 *
 * 断言取向（禁止假绿）：
 *  - 移除项用**否定式断言**，但每条都配**正面锚点**（`[data-page-setup]` 与保留控件确实渲染）；
 *  - `PageSetup` 类型字段**仍然存在**（向后兼容，非死代码）——用 `defaultPageSetup()` 的键集正面断言。
 */
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageSetup } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { mmToPx } from '@/constants/paper';
import { PageSetupPanel } from './PageSetupPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: FieldMetaLite[] = [{ id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true }];

const SETUP: PageSetup = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc.pageSetup;

/** 受控 Harness：把 onChange 结果反映到本地 state，使交互结果可见 */
function Harness({ spy }: { spy: (next: PageSetup) => void }): JSX.Element {
  const [setup, setSetup] = useState<PageSetup>(SETUP);
  return createElement(PageSetupPanel, {
    setup,
    onChange: (next: PageSetup) => {
      spy(next);
      setSetup(next);
    },
  });
}

const mountedRoots: Array<() => void> = [];
afterEach(() => {
  while (mountedRoots.length > 0) mountedRoots.pop()?.();
});

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mountedRoots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container };
}

const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

function setControl(el: Element | null, value: string): void {
  if (!el) throw new Error('setControl: element not found');
  act(() => {
    if (el instanceof HTMLSelectElement) selectSetter?.call(el, value);
    else inputSetter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('PageSetupPanel · 移除页眉/页码/页脚，保留纸张/方向/页边距', () => {
  it('保留项齐全（正面锚点）；页眉/页码/页脚编辑控件全部不存在', () => {
    const { container } = mount(createElement(Harness, { spy: () => undefined }));

    // 正面锚点：面板与三项保留控件确实渲染
    expect(container.querySelector('[data-page-setup="true"]')).not.toBeNull();
    expect(container.querySelector('[data-setup-control="paper"]')).not.toBeNull();
    expect(container.querySelector('[data-setup-orientation="portrait"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-setup-margin]').length).toBe(4);

    // 移除项：页眉 / 页脚 分组与开关
    expect(container.querySelectorAll('[data-hf]').length).toBe(0);
    expect(container.querySelectorAll('[data-hf-toggle]').length).toBe(0);
    expect(container.querySelectorAll('.cbv-setup__hf').length).toBe(0);
    // 移除项：显示页码 / 页码格式 / 页眉页脚范围
    expect(container.querySelector('[data-setup-control="showPageNumber"]')).toBeNull();
    expect(container.querySelectorAll('[data-setup-page-number]').length).toBe(0);
    expect(container.querySelectorAll('[data-setup-scope]').length).toBe(0);
  });

  it('交互仍可用：点「横向」→ onChange 收到 orientation=landscape（payload 具体值）', () => {
    const calls: PageSetup[] = [];
    const { container } = mount(createElement(Harness, { spy: (next) => calls.push(next) }));
    click(container.querySelector('[data-setup-orientation="landscape"]'));
    expect(calls.length).toBe(1);
    expect(calls[0].orientation).toBe('landscape');
    expect(calls[0].paper).toBe(SETUP.paper); // 其余字段未被误改
    expect(calls[0].margin).toEqual(SETUP.margin);
  });

  it('交互仍可用：页边距 mm 输入 → 存储值 = mmToPx(mm)，其余方向不变', () => {
    const calls: PageSetup[] = [];
    const { container } = mount(createElement(Harness, { spy: (next) => calls.push(next) }));
    setControl(container.querySelector('[data-setup-margin="top"]'), '30');
    const next = calls[calls.length - 1];
    expect(next.margin.top).toBeCloseTo(mmToPx(30), 6);
    expect(next.margin.left).toBe(SETUP.margin.left);
    expect(next.margin.right).toBe(SETUP.margin.right);
    expect(next.margin.bottom).toBe(SETUP.margin.bottom);
  });

  it('向后兼容：PageSetup 类型仍保留页眉/页脚/页码字段（非死代码）', () => {
    // 已保存的历史配置里存在这些字段；删字段会让老配置迁移 / 反序列化失败
    for (const key of ['header', 'footer', 'showPageNumber', 'pageNumberFormat', 'headerFooterScope'] as const) {
      expect(Object.prototype.hasOwnProperty.call(SETUP, key)).toBe(true);
    }
    expect(SETUP.showPageNumber).toBe(true);
    expect(SETUP.pageNumberFormat).toBe('n/total');
    expect(SETUP.headerFooterScope).toBe('all');
  });
});
