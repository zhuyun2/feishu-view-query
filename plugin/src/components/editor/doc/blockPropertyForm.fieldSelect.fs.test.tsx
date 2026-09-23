/**
 * 编辑器属性面板字段绑定下拉的「模糊查询」接入测试（工程师 · engineer-fs）。
 *
 * 需求来源（用户反馈）：「字段选择框需要支持字段模糊查询，不然字段太多很难选择」。
 *
 * ⭐ 本文件守住三件事：
 *  1. **结构性替换**：`fieldPicker` / `fieldRows` 的控件由原生 `<select>` 换成
 *     共享的 `FieldSelect`（`role="combobox"`），label ↔ 控件的 `htmlFor` 关联**仍在**；
 *  2. **候选集不变式**：`eligibleFieldsFor` 的**字段类型过滤**不得被放宽
 *     （`image` 只允许附件字段选到东西 —— 文本字段绝不出现）；
 *  3. **业务语义**：`onChange` 仍构造**同一份区块补丁**（`commit(spec, value)`），
 *     断言补丁对象**逐键精确相等**（不是「非空」）。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { defaultBlockFor } from '@/doc/blockDefaults';
import { BlockPropertyForm } from './BlockPropertyForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f4', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  { id: 'f5', name: '负责人', type: FieldType.User, isPrimary: false },
  { id: 'f6', name: '附件', type: FieldType.Attachment, isPrimary: false },
];

const PARAGRAPH = defaultBlockFor('paragraph', FIELDS, { makeId: () => 'b1' });
const IMAGE = defaultBlockFor('image', FIELDS, { makeId: () => 'b2' });
const GRID = defaultBlockFor('keyValueGrid', FIELDS, { makeId: () => 'b3' });

/** 段落 fieldId 控件（`controlId` 规则：cbv-prop-<blockId>-<key>） */
const PARAGRAPH_FIELD_ID = 'cbv-prop-b1-fieldId';
const IMAGE_FIELD_ID = 'cbv-prop-b2-fieldId';
const GRID_ROW_1 = 'cbv-prop-b3-rows-row-1';

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

function optionValues(view: Mounted, testId: string): string[] {
  return view.findAll(`${testId}-option`).map((el) => el.getAttribute('data-option-value') ?? '');
}

function optionLabels(view: Mounted, testId: string): string[] {
  return view
    .findAll(`${testId}-option`)
    .map((el) => el.querySelector('.cbv-fieldselect__option-label')?.textContent ?? '');
}

function renderForm(block: typeof PARAGRAPH, onChange: (patch: Record<string, unknown>) => void): Mounted {
  return mount(<BlockPropertyForm block={block} fields={FIELDS} onChange={onChange} />);
}

/* ===================== ① 结构性替换 + a11y 关联 ===================== */

describe('编辑器字段下拉 · 已替换为可搜索 combobox', () => {
  it('fieldPicker 控件是 role=combobox 的 input；label 的 htmlFor 仍指向它', () => {
    const view = renderForm(PARAGRAPH, () => undefined);
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;

    expect(combo).not.toBeNull();
    expect(combo.tagName).toBe('INPUT');
    expect(combo.getAttribute('role')).toBe('combobox');
    expect(combo.value).toBe('客户名称（文本）'); // 段落默认绑定首个文本字段

    // a11y：标签与该控件仍通过 id 关联（原生 select 时代就有的契约）
    const label = view.container.querySelector(`label[for="${PARAGRAPH_FIELD_ID}"]`);
    expect(label).not.toBeNull();
    expect(combo.id).toBe(PARAGRAPH_FIELD_ID);
    view.unmount();
  });
});

/* ===================== ② 候选集：类型过滤不变 ===================== */

describe('编辑器字段下拉 · eligibleFieldsFor 的类型过滤不得被放宽', () => {
  it('image（仅附件字段）→ 候选 = 空选项 + 唯一附件字段，文本字段绝不出现', () => {
    const view = renderForm(IMAGE, () => undefined);
    clickOpen(view.find(IMAGE_FIELD_ID));
    expect(optionValues(view, IMAGE_FIELD_ID)).toEqual(['', 'f6']);
    expect(optionLabels(view, IMAGE_FIELD_ID)).toEqual(['（未绑定）', '附件（附件）']);
    expect(view.html()).not.toContain('客户名称');
    view.unmount();
  });

  it('paragraph（SCALAR 类型）→ 候选只含文本/数字/单选/多选，成员与附件被过滤掉', () => {
    const view = renderForm(PARAGRAPH, () => undefined);
    clickOpen(view.find(PARAGRAPH_FIELD_ID));
    expect(optionValues(view, PARAGRAPH_FIELD_ID)).toEqual(['', 'f1', 'f2', 'f3', 'f4']);
    expect(view.html()).not.toContain('负责人');
    expect(view.html()).not.toContain('附件（附件）');
    view.unmount();
  });
});

/* ===================== ③ 模糊查询 ===================== */

describe('编辑器字段下拉 · 模糊查询', () => {
  it('输入「状态」→ 只剩「状态（单选）」', () => {
    const view = renderForm(PARAGRAPH, () => undefined);
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '状态');
    expect(optionLabels(view, PARAGRAPH_FIELD_ID)).toEqual(['状态（单选）']);
    expect(optionValues(view, PARAGRAPH_FIELD_ID)).toEqual(['f3']);
    view.unmount();
  });

  it('输入「文本」→ 按类型标签命中（不必记字段名）', () => {
    const view = renderForm(PARAGRAPH, () => undefined);
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '文本');
    expect(optionLabels(view, PARAGRAPH_FIELD_ID)).toEqual(['客户名称（文本）']);
    view.unmount();
  });

  it('无匹配 → 确切空态文案', () => {
    const view = renderForm(PARAGRAPH, () => undefined);
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;
    clickOpen(combo);
    typeInto(combo, '不存在');
    expect(view.find(`${PARAGRAPH_FIELD_ID}-empty`)?.textContent).toBe('无匹配字段');
    view.unmount();
  });
});

/* ===================== ④ 原语义：commit 补丁逐键精确 ===================== */

describe('编辑器字段下拉 · onChange 仍构造同一份区块补丁（commit）', () => {
  it('fieldPicker 搜索后点选 → 补丁精确等于 { fieldId: "f3" }', () => {
    const patches: Array<Record<string, unknown>> = [];
    const view = renderForm(PARAGRAPH, (patch) => patches.push(patch));
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;

    clickOpen(combo);
    typeInto(combo, '状态');
    const target = view.findAll(`${PARAGRAPH_FIELD_ID}-option`)[0];
    act(() => {
      target?.click();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ fieldId: 'f3' });
    view.unmount();
  });

  it('fieldPicker 键盘 ↓ + Enter → 补丁精确等于 { fieldId: "f2" }', () => {
    const patches: Array<Record<string, unknown>> = [];
    const view = renderForm(PARAGRAPH, (patch) => patches.push(patch));
    const combo = view.find(PARAGRAPH_FIELD_ID) as HTMLInputElement;

    keyDown(combo, 'ArrowDown'); // 打开，高亮落在当前值（f1，过滤后 index 1）
    keyDown(combo, 'ArrowDown'); // 移到 index 2 = 金额
    keyDown(combo, 'Enter');

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ fieldId: 'f2' });
    view.unmount();
  });

  it('fieldRows 第 2 行改绑 → 补丁精确等于替换后的整组 rows', () => {
    const patches: Array<Record<string, unknown>> = [];
    const view = renderForm(GRID, (patch) => patches.push(patch));
    const rowCombo = view.find(GRID_ROW_1) as HTMLInputElement;
    expect(rowCombo.value).toBe('金额（数字）'); // 网格默认第 2 行 = f2

    clickOpen(rowCombo);
    typeInto(rowCombo, '负责人');
    const target = view.findAll(`${GRID_ROW_1}-option`)[0];
    act(() => {
      target?.click();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      rows: [{ fieldId: 'f1' }, { fieldId: 'f5' }, { fieldId: 'f3' }, { fieldId: 'f4' }],
    });
    view.unmount();
  });

  it('选「（未绑定）」→ 清空绑定（补丁 fieldId 为空串）', () => {
    const patches: Array<Record<string, unknown>> = [];
    const view = renderForm(PARAGRAPH, (patch) => patches.push(patch));
    clickOpen(view.find(PARAGRAPH_FIELD_ID));
    const unbound = view.findAll(`${PARAGRAPH_FIELD_ID}-option`)[0];
    expect(unbound.getAttribute('data-option-value')).toBe('');
    act(() => {
      unbound.click();
    });
    expect(patches[0]).toEqual({ fieldId: '' });
    view.unmount();
  });
});
