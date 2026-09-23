/**
 * M3-T10：`ConfigDrawer` 接入文档排版（**移除「文档排版即将上线」占位**）。
 *
 * 背景（用户报障）：编辑器「文档排版」tab 之前显示的是一段「即将上线」占位文案，
 * 用户看不到任何可视化配置。T10 把 doc 分支替换为 T09 交付的 `DocLayoutEditor`
 * （区块库 / A4 画布 / 属性面板），并把文档草稿接入保存载荷。
 *
 * 断言策略（团队三条铁律）：
 *  1. **结构性锚点**：断言 doc 编辑器内部的具体元素（`[data-doc-editor]` / `.cbv-blocklib__item`
 *     / `[data-testid="doc-canvas"]` / `[data-docslot-index]` / `.cbv-docprops`），而不是「占位没了」；
 *     源码层用**结构性正则**（class 属性 + 文本）与**分支区域切片**，不做裸词匹配。
 *  2. **否定式断言配正面锚点**：断言「占位文案不存在」的同一条用例里，先断言 doc 编辑器**确实渲染**。
 *  3. **两链路可分离**：保存载荷断言比对 `payload.detail.doc` 与**当前 doc 草稿的具体内容**
 *     （改主色为 `#00B42A`，与基准 `#3370FF` 分离）。
 *
 * ⚠️ 关键约束（被本文件的源码断言锁定）：`DocLayoutEditor` **自带 `<DndContext>`**；
 * `ConfigDrawer` 的 **doc 分支绝不再包一层** DndContext（嵌套会导致拖拽静默错乱、不报错）。
 * card 分支保留自身 DndContext（不在本文件断言范围内改动）。
 *
 * ⚠️ 覆盖边界：jsdom 下 dnd-kit 的真实指针拖拽不可靠，本文件不伪造拖拽手势测试。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveResult } from '@/config/ConfigRepository';
import { createDefaultConfig } from '@/config/defaults';
import type { CardViewConfig } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { ConfigDrawer } from './ConfigDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f4', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  { id: 'f5', name: '备注', type: FieldType.Text, isPrimary: false },
];

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findByText(container: HTMLElement, selector: string, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) => (el.textContent ?? '').includes(text));
}

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 打开编辑器（草稿基准 = 默认配置，card 模式） */
function openEditor(): CardViewConfig {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
  useViewStore.setState({ config, fields: FIELDS, canEditConfig: true, unsupportedNewer: false });
  useDraftStore.getState().close();
  useDraftStore.getState().open(config, 'card');
  useUiStore.setState({ editorOpen: true, editMode: 'card', toast: null });
  return config;
}

/** 顶栏分段控件：切到「卡片排版 / 文档排版」 */
function switchTab(container: HTMLElement, label: '卡片排版' | '文档排版'): void {
  const tab = findByText(container, 'button', label);
  if (!tab) throw new Error(`switchTab: ${label} button not found`);
  click(tab);
}

const readSrc = (): string => readFileSync(path.resolve(process.cwd(), 'src/components/editor/ConfigDrawer.tsx'), 'utf8');

/* ==================== ① doc 模式渲染 DocLayoutEditor 的真实结构 ==================== */

describe('T10 · 文档排版 tab 渲染 DocLayoutEditor 的真实结构', () => {
  beforeEach(() => {
    openEditor();
  });

  it('doc 分支渲染区块库(12 类) / A4 画布 / 文档属性面板（而非占位）', () => {
    const config = useViewStore.getState().config as CardViewConfig;
    const { container, unmount } = mount(createElement(ConfigDrawer));

    switchTab(container, '文档排版');

    // 结构性锚点：doc 编辑器根 + 三栏
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    expect(container.querySelector('[data-doc-editor-center="true"]')).not.toBeNull();
    expect(container.querySelector('.cbv-editor__body--doc')).not.toBeNull();
    // 左栏区块库：5 组 / 12 类
    expect(container.querySelectorAll('.cbv-blocklib__group').length).toBe(5);
    expect(container.querySelectorAll('.cbv-blocklib__item').length).toBe(12);
    // 中栏 A4 画布 + 插入槽（区块数 N → 槽 N+1）
    const canvas = container.querySelector('[data-testid="doc-canvas"]');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('data-block-count')).toBe(String(config.detail.doc.blocks.length));
    expect(canvas?.getAttribute('data-slot-count')).toBe(String(config.detail.doc.blocks.length + 1));
    expect(container.querySelectorAll('[data-docslot-index]').length).toBe(config.detail.doc.blocks.length + 1);
    // 右栏文档属性面板
    expect(container.querySelector('.cbv-docprops')).not.toBeNull();
    expect(container.querySelectorAll('[data-docprops-section]').length).toBe(3);

    unmount();
  });

  it('画布模板来源 = 当前 doc 草稿（改草稿 → 画布重渲染，非内部副本）', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    switchTab(container, '文档排版');

    const canvasSel = '[data-testid="doc-canvas"]';
    expect(container.querySelector(canvasSel)?.getAttribute('data-block-count')).toBe('8');

    act(() => {
      useDraftStore.getState().updateDoc((t) => ({ ...t, blocks: t.blocks.slice(0, 3) }));
    });
    expect(container.querySelector(canvasSel)?.getAttribute('data-block-count')).toBe('3');

    unmount();
  });
});

/* ==================== ② 占位文案彻底移除（DOM + 源码两层） ==================== */

describe('T10 · 「文档排版即将上线」占位彻底移除', () => {
  beforeEach(() => {
    openEditor();
  });

  it('DOM 层：doc 模式不含占位文案（且 doc 编辑器确实渲染 = 正面锚点）', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    switchTab(container, '文档排版');

    // 正面锚点：占位真的被真实编辑器替换（否则「不存在」断言恒真）
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();

    const html = container.innerHTML;
    expect(html).not.toContain('文档排版即将上线');
    expect(html).not.toContain('将在下个版本提供');
    expect(html).not.toContain('返回卡片排版'); // 占位里的返回按钮也不应存在
    // 对照：card 模式的字段池文案此时不应出现（确认确实在 doc 分支）
    expect(html).not.toContain('未使用');

    unmount();
  });

  it('源码层：doc 分支区域含 <DocLayoutEditor/>，不含占位标题/描述/返回按钮', () => {
    const src = readSrc();

    // 结构性正则（class 属性 + 文本），非裸词
    expect(src).not.toMatch(/cbv-state__title"\s*>\s*文档排版即将上线/);
    expect(src).not.toMatch(/cbv-state__desc"[\s\S]{0,120}?将在下个版本提供/);

    // 分支区域切片：锁定「mode === 'doc'」到「card 分支」之间
    const start = src.indexOf("mode === 'doc' ? (");
    const end = src.indexOf(") : layout && density && theme ? (");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const docBranch = src.slice(start, end);

    // 正面锚点：真实接线在 doc 分支内
    expect(docBranch).toMatch(/<DocLayoutEditor/);
    expect(docBranch).toMatch(/template=\{docDraft\}/);
    expect(docBranch).toMatch(/fields=\{fields\}/);
    expect(docBranch).toMatch(/onChange=\{handleDocChange\}/);
    expect(docBranch).toMatch(/onBeforeChange=\{handleDocBeforeChange\}/);
    expect(docBranch).toMatch(/locale="zh-CN"/);

    // 占位残留物不在 doc 分支
    expect(docBranch).not.toContain('文档排版即将上线');
    expect(docBranch).not.toContain('下个版本提供');
    expect(docBranch).not.toContain('返回卡片排版');
  });

  it('源码层：doc 分支**不**再包一层 DndContext（嵌套 DndContext 会静默错乱）', () => {
    const src = readSrc();
    const start = src.indexOf("mode === 'doc' ? (");
    const end = src.indexOf(") : layout && density && theme ? (");
    const docBranch = src.slice(start, end);

    // 正面锚点：doc 分支确实存在且接入了编辑器
    expect(docBranch).toMatch(/<DocLayoutEditor/);
    // 关键：doc 分支内不得出现 DndContext（DocLayoutEditor 自带）
    expect(docBranch).not.toMatch(/<DndContext/);

    // 反向确认：card 分支**仍然**有自己的 DndContext（未被误删 → 避免「整文件都没有」而恒真）
    const cardBranch = src.slice(end);
    expect(cardBranch).toMatch(/<DndContext/);
  });
});

/* ==================== ③ card 模式未回归 ==================== */

describe('T10 · 卡片排版模式未回归', () => {
  beforeEach(() => {
    openEditor();
  });

  it('card 模式渲染卡片排版结构，且不含 doc 编辑器', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));

    // 正面锚点：卡片排版三栏结构
    expect(container.querySelector('.cbv-editor__body')).not.toBeNull();
    expect(container.querySelector('.cbv-editor__body--doc')).toBeNull();
    expect(container.querySelectorAll('[data-slot-id]').length).toBe(4); // 4 个槽位投放区
    expect(container.querySelector('[data-doc-editor="true"]')).toBeNull();
    expect(container.innerHTML).toContain('未使用');

    unmount();
  });

  it('doc → card 来回切换后，card 结构完好且 doc 编辑器移除', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));

    switchTab(container, '文档排版');
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();

    switchTab(container, '卡片排版');
    expect(container.querySelector('[data-slot-id]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot-id]').length).toBe(4);
    expect(container.querySelector('[data-doc-editor="true"]')).toBeNull();

    unmount();
  });
});

/* ==================== ④ 两个 tab 草稿互不干扰 ==================== */

describe('T10 · 卡片草稿与文档草稿互不干扰', () => {
  beforeEach(() => {
    openEditor();
  });

  it('文档排版里的改动不污染卡片草稿；切回卡片也不重置文档草稿', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));

    const cardBefore = JSON.stringify(useDraftStore.getState().cardDraft);

    switchTab(container, '文档排版');
    // 展开「主题」段并改主色（走 handleDocChange → updateDoc）
    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));

    const afterDocEdit = useDraftStore.getState();
    expect(afterDocEdit.docDraft?.theme.primaryColor).toBe('#00B42A');
    // 卡片草稿一字未动
    expect(JSON.stringify(afterDocEdit.cardDraft)).toBe(cardBefore);

    // 切回卡片：草稿不被重置，文档改动保留
    switchTab(container, '卡片排版');
    const afterSwitch = useDraftStore.getState();
    expect(JSON.stringify(afterSwitch.cardDraft)).toBe(cardBefore);
    expect(afterSwitch.docDraft?.theme.primaryColor).toBe('#00B42A');

    unmount();
  });

  it('卡片排版里的改动不污染文档草稿；切到文档也不重置卡片草稿', () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));

    const docBefore = JSON.stringify(useDraftStore.getState().docDraft);

    // 卡片模板 → compact（走 handleTemplateChange → updateCard）
    click(container.querySelector('[data-template-id="compact"]'));
    const afterCardEdit = useDraftStore.getState();
    expect(afterCardEdit.cardDraft?.templateId).toBe('compact');
    expect(JSON.stringify(afterCardEdit.docDraft)).toBe(docBefore);

    // 切到文档：文档草稿未被重置，doc 编辑器正常渲染
    switchTab(container, '文档排版');
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    const afterSwitch = useDraftStore.getState();
    expect(afterSwitch.docDraft?.templateId).toBe('a4-default'); // 默认模板未被卡片操作改写
    expect(afterSwitch.cardDraft?.templateId).toBe('compact');

    unmount();
  });
});

/* ==================== ⑤ 保存载荷含文档草稿 ==================== */

describe('T10 · 保存时文档草稿进入配置载荷', () => {
  beforeEach(() => {
    openEditor();
  });

  it('handleSave → persistConfig 收到的 config.detail.doc = 当前文档草稿（具体内容）', async () => {
    const spy = vi.fn(async (_config: CardViewConfig): Promise<SaveResult> => {
      void _config;
      return { ok: true };
    });
    useViewStore.setState({ persistConfig: spy });

    const { container, unmount } = mount(createElement(ConfigDrawer));

    // 在文档排版里改主色（与基准 #3370FF 分离）
    switchTab(container, '文档排版');
    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');
    // 保存成功后编辑器会关闭并清空草稿 → 先留一份快照用于比对具体内容
    const docSnapshot = useDraftStore.getState().docDraft;

    const save = findByText(container, 'button', '保存');
    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    // 具体内容断言（不是「被调用过」）
    expect(payload?.detail.doc.theme.primaryColor).toBe('#00B42A');
    expect(payload?.detail.doc).toEqual(docSnapshot);

    unmount();
  });
});

/* ==================== ⑥ unsupportedNewer 只读时保存被禁用 ==================== */

describe('T10 · unsupportedNewer 只读保护不变', () => {
  it('更高版本配置 → 保存按钮 disabled，且点击不触达 persistConfig', () => {
    openEditor();
    const spy = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
    useViewStore.setState({ persistConfig: spy, unsupportedNewer: true });

    const { container, unmount } = mount(createElement(ConfigDrawer));

    const save = findByText(container, 'button', '保存') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.innerHTML).toContain('只读模式');

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(spy).not.toHaveBeenCalled();

    unmount();
  });
});
