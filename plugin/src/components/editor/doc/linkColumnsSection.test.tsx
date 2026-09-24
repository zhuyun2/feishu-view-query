/**
 * 「关联记录显示列」配置段单测（需求 2 · 第二阶段 · 编辑器侧）。
 *
 * 断言原则：负面断言配正面锚点；交互一律断言**写出的补丁 / 草稿具体值**，不复用实现内部状态。
 *
 * 本文件锁定：
 *  ① 无关联绑定 → 段不渲染；绑定但无解析入口 → **降级文案**（仍可保存）；
 *  ② 选择 / 移除 / 清空 / 关键字搜索（复用冻结的 `SearchableMultiSelect`）；
 *  ③ 列上限（>8）→ 明确文案并**拦截**该次变更（不静默截断）；
 *  ④ 行数上限输入 → 写出 `linkRowLimit`（清空 → 删除该键）；
 *  ⑤ 补丁形态按绑定作用域正确（fieldList/keyValueGrid → 整段数组；table → 直接键）；
 *  ⑥ ⭐ **写入 DraftStore 并保存后仍在**（updateDoc → buildConfig → serialize → migrate）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardViewConfig, DocBlock, FieldListBlock, KeyValueGridBlock, TableBlock } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { LinkTargetFieldsState } from '@/hooks/useLinkTargetFields';
import { useDraftStore } from '@/state/DraftStore';
import { deserializeEnvelope, serializeConfig } from '@/config/ConfigRepository';
import { migrate } from '@/config/migrations';
import { BlockPropertyForm } from './BlockPropertyForm';
import { updateBlock } from './blockMath';
import {
  LINK_COLUMNS_DEGRADED_TEXT,
  LINK_COLUMNS_MAX,
  LINK_COLUMNS_MAX_MESSAGE,
  LinkColumnsSection,
  buildLinkColumnsPatch,
  buildLinkRowLimitPatch,
  collectLinkBindings,
} from './LinkColumnsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 夹具 ===================== */

const F_TITLE: FieldMetaLite = { id: 'f_title', name: '客户名称', type: FieldType.Text, isPrimary: true };
const F_LINK: FieldMetaLite = { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false };
const F_TEXT: FieldMetaLite = { id: 'f_text', name: '备注', type: FieldType.Text, isPrimary: false };
const FIELDS: readonly FieldMetaLite[] = [F_TITLE, F_LINK, F_TEXT];

function tf(id: string, name: string): FieldMetaLite {
  return { id, name, type: FieldType.Text, isPrimary: false };
}
const TARGET: FieldMetaLite[] = [tf('tf_name', '项目名称'), tf('tf_amount', '金额'), tf('tf_owner', '负责人')];
const TARGET9: FieldMetaLite[] = Array.from({ length: 9 }, (_, i) => tf(`tf_${i}`, `字段${i}`));

function readyState(fields: FieldMetaLite[] = TARGET): LinkTargetFieldsState {
  return { status: 'ready', fields, tableId: 'tbl_target' };
}

function fieldListBlock(items?: Record<string, unknown>[]): FieldListBlock {
  return {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: (items ?? [{ fieldId: 'f_title' }, { fieldId: 'f_link' }]) as unknown as FieldListBlock['items'],
    showLabels: true,
    hideEmptyItems: false,
  };
}

function kvBlock(): KeyValueGridBlock {
  return {
    blockId: 'blk_kv',
    kind: 'keyValueGrid',
    breakInside: 'auto',
    columns: 1,
    rows: [{ fieldId: 'f_link' }, { fieldId: 'f_title' }],
    labelWidthPx: 88,
    showColon: true,
    zebra: false,
    hideEmptyRows: false,
  };
}

function tableBlock(): TableBlock {
  return {
    blockId: 'blk_tbl',
    kind: 'table',
    breakInside: 'auto',
    columns: [{ fieldId: 'f_title' }],
    rowSource: { type: 'linkedRecords', fieldId: 'f_link' },
    showHeader: true,
    zebra: true,
  };
}

/* ===================== 交互工具 ===================== */

const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function type(el: Element | null, value: string): void {
  if (!el) throw new Error('type: element not found');
  act(() => {
    inputSetter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

/** 受控段 Harness：把补丁浅合并回本地区块（模拟 `updateBlock` 对浅合并的期望） */
function SectionHarness({
  initialBlock,
  states,
  onChangeSpy,
  onEnsure,
}: {
  initialBlock: DocBlock;
  states?: Record<string, LinkTargetFieldsState>;
  onChangeSpy?: (patch: Record<string, unknown>) => void;
  onEnsure?: (fieldId: string) => void;
}): JSX.Element {
  const [block, setBlock] = useState<DocBlock>(initialBlock);
  return createElement(LinkColumnsSection, {
    block,
    fields: FIELDS as FieldMetaLite[],
    linkTargetFields: states,
    onEnsure,
    onChange: (patch: Record<string, unknown>) => {
      onChangeSpy?.(patch);
      setBlock((current) => ({ ...current, ...patch }) as DocBlock);
    },
  });
}

/* ===================== ① 渲染 / 降级 ===================== */

describe('LinkColumnsSection · 渲染与降级', () => {
  it('无关联字段绑定 → 段不渲染', () => {
    const spacer: DocBlock = { blockId: 'blk_sp', kind: 'spacer', breakInside: 'auto', height: 12 };
    const html = renderToStaticMarkup(createElement(LinkColumnsSection, { block: spacer, fields: FIELDS as FieldMetaLite[], onChange: vi.fn() }));
    expect(html).not.toContain('data-link-cols-section');
  });

  it('⭐ 未接线（无 onEnsure）→ 显示降级文案，且该段仍渲染（不白屏）', () => {
    const html = renderToStaticMarkup(
      createElement(LinkColumnsSection, { block: fieldListBlock(), fields: FIELDS as FieldMetaLite[], onChange: vi.fn() }),
    );
    expect(html).toContain('data-link-cols-item');
    expect(html).toContain('data-link-cols-degraded');
    expect(html).toContain(LINK_COLUMNS_DEGRADED_TEXT);
  });

  it('read 状态 → 渲染候选下拉 + 「默认列」提示 + 行数上限输入', () => {
    const html = renderToStaticMarkup(
      createElement(LinkColumnsSection, {
        block: fieldListBlock(),
        fields: FIELDS as FieldMetaLite[],
        linkTargetFields: { f_link: readyState() },
        onEnsure: () => undefined,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('data-multiselect="true"');
    expect(html).toContain('data-link-cols-default');
    expect(html).toContain('未配置时默认显示：项目名称、金额、负责人');
    expect(html).toContain('data-link-cols-rowlimit');
  });
});

/* ===================== ② 选择 / 移除 / 清空 / 搜索 ===================== */

describe('LinkColumnsSection · 选择 / 移除 / 清空 / 搜索', () => {
  it('⭐ 选择候选项 → 写出 linkColumns（顺序即选中顺序）', () => {
    const patches: Record<string, unknown>[] = [];
    const block = fieldListBlock();
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState() }, onChangeSpy: (p) => patches.push(p), onEnsure: () => undefined }),
    );
    const testId = 'cbv-linkcols-blk_fl-fieldList-1';
    click(container.querySelector(`[data-testid="${testId}"]`));
    click(container.querySelector(`[data-testid="${testId}-option"][data-option-value="tf_amount"]`));

    const patch = patches.at(-1) as { items: FieldListBlock['items'] };
    expect(patch.items[1].linkColumns).toEqual(['tf_amount']);
    // 其它项未被污染
    expect(patch.items[0].fieldId).toBe('f_title');
    // 复选第二个 → 顺序为 [tf_amount, tf_owner]
    click(container.querySelector(`[data-testid="${testId}-option"][data-option-value="tf_owner"]`));
    const patch2 = patches.at(-1) as { items: FieldListBlock['items'] };
    expect(patch2.items[1].linkColumns).toEqual(['tf_amount', 'tf_owner']);
    unmount();
  });

  it('⭐ 移除单个 chip → 从配置中删掉该列', () => {
    const patches: Record<string, unknown>[] = [];
    const block = fieldListBlock([{ fieldId: 'f_title' }, { fieldId: 'f_link', linkColumns: ['tf_name', 'tf_amount'] }]);
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState() }, onChangeSpy: (p) => patches.push(p), onEnsure: () => undefined }),
    );
    const testId = 'cbv-linkcols-blk_fl-fieldList-1';
    click(container.querySelector(`[data-testid="${testId}-chip-remove"][data-chip-value="tf_name"]`));
    const patch = patches.at(-1) as { items: FieldListBlock['items'] };
    expect(patch.items[1].linkColumns).toEqual(['tf_amount']);
    unmount();
  });

  it('⭐ 一键清空 → linkColumns 变空数组', () => {
    const patches: Record<string, unknown>[] = [];
    const block = fieldListBlock([{ fieldId: 'f_title' }, { fieldId: 'f_link', linkColumns: ['tf_name'] }]);
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState() }, onChangeSpy: (p) => patches.push(p), onEnsure: () => undefined }),
    );
    click(container.querySelector('[data-testid="cbv-linkcols-blk_fl-fieldList-1-clear"]'));
    const patch = patches.at(-1) as { items: FieldListBlock['items'] };
    expect(patch.items[1].linkColumns).toEqual([]);
    unmount();
  });

  it('⭐ 关键字搜索过滤候选（输入「金额」→ 只剩金额）', () => {
    const block = fieldListBlock();
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState() }, onEnsure: () => undefined }),
    );
    const testId = 'cbv-linkcols-blk_fl-fieldList-1';
    click(container.querySelector(`[data-testid="${testId}"]`));
    type(container.querySelector(`[data-testid="${testId}"]`), '金额');
    const options = Array.from(container.querySelectorAll(`[data-testid="${testId}-option"]`)).map((o) => o.getAttribute('data-option-value'));
    expect(options).toEqual(['tf_amount']);
    unmount();
  });
});

/* ===================== ③ 列上限 ===================== */

describe('LinkColumnsSection · 列上限', () => {
  it('⭐ 选中第 9 列 → 明确文案并拦截（onChange 不触发，配置不变）', () => {
    const patches: Record<string, unknown>[] = [];
    const eight = TARGET9.slice(0, LINK_COLUMNS_MAX).map((f) => f.id);
    const block = fieldListBlock([{ fieldId: 'f_title' }, { fieldId: 'f_link', linkColumns: eight }]);
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState(TARGET9) }, onChangeSpy: (p) => patches.push(p), onEnsure: () => undefined }),
    );
    const testId = 'cbv-linkcols-blk_fl-fieldList-1';
    click(container.querySelector(`[data-testid="${testId}"]`));
    click(container.querySelector(`[data-testid="${testId}-option"][data-option-value="tf_8"]`));

    expect(patches.length).toBe(0); // 未提交变更
    const error = container.querySelector('[data-link-cols-error]');
    expect(error?.textContent).toBe(LINK_COLUMNS_MAX_MESSAGE);
    // chip 仍是 8 个（未静默截断/未添加）
    expect(container.querySelectorAll(`[data-testid="${testId}-chip"]`).length).toBe(LINK_COLUMNS_MAX);
    unmount();
  });
});

/* ===================== ④ 行数上限 ===================== */

describe('LinkColumnsSection · 行数上限', () => {
  it('⭐ 输入 5 → 写出 linkRowLimit=5；清空 → 删除该键', () => {
    const patches: Record<string, unknown>[] = [];
    const block = fieldListBlock();
    const { container, unmount } = mount(
      createElement(SectionHarness, { initialBlock: block, states: { f_link: readyState() }, onChangeSpy: (p) => patches.push(p), onEnsure: () => undefined }),
    );
    const input = container.querySelector('[data-link-cols-rowlimit]');
    type(input, '5');
    let patch = patches.at(-1) as { items: FieldListBlock['items'] };
    expect(patch.items[1].linkRowLimit).toBe(5);

    type(container.querySelector('[data-link-cols-rowlimit]'), '');
    patch = patches.at(-1) as { items: FieldListBlock['items'] };
    expect('linkRowLimit' in patch.items[1]).toBe(false);
    unmount();
  });
});

/* ===================== ⑤ 补丁形态（纯函数） ===================== */

describe('collectLinkBindings / 补丁构造（纯函数）', () => {
  it('collectLinkBindings：按作用域与下标收集（table 的 index = -1）', () => {
    expect(collectLinkBindings(fieldListBlock(), FIELDS as FieldMetaLite[])).toEqual([
      { scope: 'fieldList', index: 1, fieldId: 'f_link', label: '关联项目', columns: [], rowLimit: undefined },
    ]);
    expect(collectLinkBindings(kvBlock(), FIELDS as FieldMetaLite[])[0]?.scope).toBe('keyValueGrid');
    expect(collectLinkBindings(tableBlock(), FIELDS as FieldMetaLite[])).toEqual([
      { scope: 'table', index: -1, fieldId: 'f_link', label: '关联项目', columns: [], rowLimit: undefined },
    ]);
    // 普通字段不产出绑定
    expect(collectLinkBindings({ blockId: 'b', kind: 'spacer', breakInside: 'auto', height: 8 }, FIELDS as FieldMetaLite[])).toEqual([]);
  });

  it('buildLinkColumnsPatch：table → 直接键；fieldList → 整段数组且不动其它项', () => {
    const tbl = tableBlock();
    expect(buildLinkColumnsPatch(tbl, collectLinkBindings(tbl, FIELDS as FieldMetaLite[])[0], ['tf_name'])).toEqual({
      linkColumns: ['tf_name'],
    });

    const fl = fieldListBlock();
    const patch = buildLinkColumnsPatch(fl, collectLinkBindings(fl, FIELDS as FieldMetaLite[])[0], ['tf_amount']);
    expect(patch).toEqual({ items: [{ fieldId: 'f_title' }, { fieldId: 'f_link', linkColumns: ['tf_amount'] }] });
  });

  it('buildLinkRowLimitPatch：undefined → 删除键；数字 → 写入', () => {
    const fl = fieldListBlock([{ fieldId: 'f_title' }, { fieldId: 'f_link', linkRowLimit: 7 }]);
    const binding = collectLinkBindings(fl, FIELDS as FieldMetaLite[])[0];
    const cleared = buildLinkRowLimitPatch(fl, binding, undefined) as { items: FieldListBlock['items'] };
    expect('linkRowLimit' in cleared.items[1]).toBe(false);
    const set = buildLinkRowLimitPatch(fl, binding, 12) as { items: FieldListBlock['items'] };
    expect(set.items[1].linkRowLimit).toBe(12);
  });
});

/* ===================== ⑥ 写入 DraftStore 并保存后仍在 ===================== */

describe('LinkColumnsSection · 接入 DraftStore 并持久化', () => {
  beforeEach(() => {
    useDraftStore.getState().close();
  });

  function makeConfig(): CardViewConfig {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 'tbl_main', fields: FIELDS as FieldMetaLite[] });
    const blocks: DocBlock[] = [fieldListBlock()];
    return { ...config, detail: { ...config.detail, doc: { ...config.detail.doc, blocks } } };
  }

  it('⭐ 选择列 → 写入 DraftStore → 保存（buildConfig + serialize + migrate）后配置仍在', () => {
    const config = makeConfig();
    useDraftStore.getState().open(config, 'doc');

    function StoreHarness(): JSX.Element | null {
      const template = useDraftStore((state) => state.docDraft);
      if (!template) return null;
      const block = template.blocks[0];
      return createElement(BlockPropertyForm, {
        block,
        fields: FIELDS as FieldMetaLite[],
        linkTargetFields: { f_link: readyState() },
        onEnsureLinkFields: () => undefined,
        onChange: (patch: Record<string, unknown>) =>
          useDraftStore.getState().updateDoc((current) => updateBlock(current, block.blockId, patch as unknown as Partial<DocBlock>)),
      });
    }

    const { container, unmount } = mount(createElement(StoreHarness));
    const testId = 'cbv-linkcols-blk_fl-fieldList-1';
    click(container.querySelector(`[data-testid="${testId}"]`));
    click(container.querySelector(`[data-testid="${testId}-option"][data-option-value="tf_amount"]`));

    const draftBlocks = useDraftStore.getState().docDraft?.blocks ?? [];
    const item = (draftBlocks[0] as FieldListBlock).items[1];
    expect(item.linkColumns).toEqual(['tf_amount']);

    // 保存链路：buildConfig → serialize → deserialize → migrate
    const persisted = useDraftStore.getState().buildConfig(config);
    const serialized = serializeConfig(persisted, 1);
    const parsed = deserializeEnvelope(serialized.raw);
    expect(parsed.valid).toBe(true);
    const reloaded = migrate(parsed.envelope?.payload, parsed.envelope?.schemaVersion ?? 0);
    const reloadedItem = (reloaded.detail.doc.blocks[0] as FieldListBlock).items[1];
    expect(reloadedItem.linkColumns).toEqual(['tf_amount']);
    unmount();
  });

  it('源码级：降级文案常量存在且被组件引用（防止文案被删而测试遗漏）', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/components/editor/doc/LinkColumnsSection.tsx'), 'utf8');
    expect(source).toContain('LINK_COLUMNS_DEGRADED_TEXT');
    expect(source).toContain('无法读取关联表的字段，将使用默认列');
    expect(source).toContain('data-link-cols-degraded');
  });
});
