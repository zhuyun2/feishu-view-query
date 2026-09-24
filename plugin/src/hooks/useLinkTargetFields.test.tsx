/**
 * `useLinkTargetFields` 单测（需求 2 · 第二阶段 · 编辑器目标表字段解析）。
 *
 * 断言原则：一律配正面锚点（status 具体值 / 字段名 / 解析调用参数），杀死「恒 unavailable / 恒空」假绿。
 *
 * 本文件锁定：
 *  ① 关联字段（带 `property.tableId`）→ 按**该 tableId** 解析 → `ready` + 目标字段；
 *  ② 无 `property.tableId` / 非关联字段 → `unavailable` 且**不发请求**；
 *  ③ 解析抛错 / 返回空 → `unavailable` + 告警（绝不抛、绝不白屏）；
 *  ④ 多字段并发解析不串写（各就各位）。
 */
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { useLinkTargetFields } from './useLinkTargetFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const F_LINK: FieldMetaLite = {
  id: 'f_link',
  name: '关联项目',
  type: FieldType.Link,
  isPrimary: false,
  property: { tableId: 'tbl_target' },
};
const F_DUPLEX: FieldMetaLite = {
  id: 'f_duplex',
  name: '双向关联',
  type: FieldType.DuplexLink,
  isPrimary: false,
  property: { table_id: 'tbl_target_b' },
};
const F_NO_TABLE: FieldMetaLite = { id: 'f_plain_link', name: '无目标', type: FieldType.Link, isPrimary: false };
const F_TEXT: FieldMetaLite = { id: 'f_text', name: '客户名称', type: FieldType.Text, isPrimary: true };

const TARGET_A: FieldMetaLite[] = [
  { id: 'tf_name', name: '项目名称', type: FieldType.Text, isPrimary: true },
  { id: 'tf_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];
const TARGET_B: FieldMetaLite[] = [{ id: 'tb_note', name: '备注B', type: FieldType.Text, isPrimary: true }];

interface HarnessProps {
  fields: FieldMetaLite[];
  fieldIds: string[];
  resolveTargetFields?: (tableId: string) => Promise<ReadonlyArray<FieldMetaLite>>;
  onWarn?: (scope: string, message: string, ctx?: Record<string, unknown>) => void;
}

/** 把每个字段的状态渲染进 DOM，供断言 */
function Harness({ fields, fieldIds, resolveTargetFields, onWarn }: HarnessProps): JSX.Element {
  const { states, ensure } = useLinkTargetFields(fields, { resolveTargetFields, onWarn });
  useEffect(() => {
    for (const fieldId of fieldIds) ensure(fieldId);
  }, [ensure, fieldIds]);
  return createElement(
    'div',
    { 'data-harness': 'true' },
    fieldIds.map((fieldId) => {
      const state = states[fieldId];
      return createElement('div', {
        key: fieldId,
        'data-field': fieldId,
        'data-status': state?.status ?? 'none',
        'data-table': state?.tableId ?? '',
        'data-count': String(state?.fields.length ?? 0),
        'data-names': (state?.fields ?? []).map((field) => field.name).join(','),
      });
    }),
  );
}

function mount(node: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 冲刷微任务（解析器是 async） */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function row(container: HTMLElement, fieldId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-field="${fieldId}"]`);
  if (!el) throw new Error(`row ${fieldId} not found`);
  return el;
}

describe('useLinkTargetFields · 按需解析目标表字段', () => {
  it('⭐ 关联字段（property.tableId）→ 按该 tableId 解析 → ready + 目标字段', async () => {
    const resolve = vi.fn(async () => TARGET_A);
    const { container, unmount } = mount(createElement(Harness, { fields: [F_LINK], fieldIds: ['f_link'], resolveTargetFields: resolve }));
    await flush();

    expect(resolve).toHaveBeenCalledWith('tbl_target');
    const el = row(container, 'f_link');
    expect(el.getAttribute('data-status')).toBe('ready');
    expect(el.getAttribute('data-table')).toBe('tbl_target');
    expect(el.getAttribute('data-count')).toBe('2');
    expect(el.getAttribute('data-names')).toBe('项目名称,金额');
    unmount();
  });

  it('兼容 deprecated `property.table_id`', async () => {
    const resolve = vi.fn(async () => TARGET_B);
    const { container, unmount } = mount(createElement(Harness, { fields: [F_DUPLEX], fieldIds: ['f_duplex'], resolveTargetFields: resolve }));
    await flush();
    expect(resolve).toHaveBeenCalledWith('tbl_target_b');
    expect(row(container, 'f_duplex').getAttribute('data-status')).toBe('ready');
    unmount();
  });

  it('⭐ 无 property.tableId → unavailable 且**不发请求**', async () => {
    const resolve = vi.fn(async () => TARGET_A);
    const { container, unmount } = mount(createElement(Harness, { fields: [F_NO_TABLE], fieldIds: ['f_plain_link'], resolveTargetFields: resolve }));
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(row(container, 'f_plain_link').getAttribute('data-status')).toBe('unavailable');
    unmount();
  });

  it('⭐ 非关联字段 → unavailable 且不发请求', async () => {
    const resolve = vi.fn(async () => TARGET_A);
    const { container, unmount } = mount(createElement(Harness, { fields: [F_TEXT], fieldIds: ['f_text'], resolveTargetFields: resolve }));
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(row(container, 'f_text').getAttribute('data-status')).toBe('unavailable');
    unmount();
  });

  it('⭐ 解析抛错 → unavailable + 告警（不抛、不白屏）', async () => {
    const onWarn = vi.fn();
    const resolve = vi.fn(async () => {
      throw new Error('sdk-down');
    });
    const { container, unmount } = mount(
      createElement(Harness, { fields: [F_LINK], fieldIds: ['f_link'], resolveTargetFields: resolve, onWarn }),
    );
    await flush();
    expect(onWarn).toHaveBeenCalledWith('editor.linkColumns', expect.stringContaining('读取关联表字段失败'), expect.objectContaining({ tableId: 'tbl_target' }));
    expect(row(container, 'f_link').getAttribute('data-status')).toBe('unavailable');
    unmount();
  });

  it('解析返回空数组 → unavailable（目标表无字段 → 回退默认列）', async () => {
    const { container, unmount } = mount(
      createElement(Harness, { fields: [F_LINK], fieldIds: ['f_link'], resolveTargetFields: async () => [] }),
    );
    await flush();
    expect(row(container, 'f_link').getAttribute('data-status')).toBe('unavailable');
    unmount();
  });

  it('⭐ 多字段并发解析不串写（各就各位）', async () => {
    const resolve = vi.fn(async (tableId: string) => (tableId === 'tbl_target' ? TARGET_A : TARGET_B));
    const { container, unmount } = mount(
      createElement(Harness, { fields: [F_LINK, F_DUPLEX], fieldIds: ['f_link', 'f_duplex'], resolveTargetFields: resolve }),
    );
    await flush();
    expect(row(container, 'f_link').getAttribute('data-names')).toBe('项目名称,金额');
    expect(row(container, 'f_duplex').getAttribute('data-names')).toBe('备注B');
    unmount();
  });

  it('重复 ensure 同一字段 → 只解析一次（幂等）', async () => {
    const resolve = vi.fn(async () => TARGET_A);
    const { unmount } = mount(
      createElement(Harness, { fields: [F_LINK], fieldIds: ['f_link'], resolveTargetFields: resolve }),
    );
    await flush();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    unmount();
  });
});
