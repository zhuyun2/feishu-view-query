/**
 * M3 · **端到端往返（T13）** 集成测试 —— QA 独立证伪向（实现方不得修改）。
 *
 * 为什么需要这一环：分层全绿 ≠ 组合正确。本项目已踩过一次同类坑（搜索框过滤只接进
 * 计数、没接进卡片墙）。本文件把「用户真正会做的一条往返链路」当作被测对象，**走完整闭环**：
 *
 * ```
 * 打开配置抽屉 →（doc）切「文档排版」→ 三栏编辑器
 *    → 改文档模板（删区块 / 改朝向 / 改主题）
 *      → 保存 →（真实 serialize+checksum 写入仓储）
 *        → 断言存储载荷 payload.detail.doc = 改后模板
 *          → 新仓储实例重载（模拟重开）→ 落地 ViewStore
 *            → 详情抽屉渲染出的文档**反映刚才的改动**（闭环，最易断的一环）
 * ```
 *
 * 三条附加往返：
 *  A. 卡片排版同类往返（换模板 → 保存 → 重载 → **真实卡片墙** data-template 反映）；
 *  B. 两 tab 草稿互不干扰（doc 改了不保存 → 切 card 改 → 切回 doc，doc 草稿仍在、card 独立）；
 *  C. 断链证伪：不保存 → 重载得空配置（证明上面闭环**依赖**持久化，不是内存残留）。
 *
 * 环境约定同本仓既有测试：无 @testing-library/react，`createRoot` + `act` 直出 DOM。
 * 替身与未覆盖项（**诚实申报**，见文件末注释）：
 *   - 分页测量：注入 stub measurer + no-op 离屏渲染（jsdom 无布局引擎，`offsetHeight` 恒 0）；
 *   - 卡片墙虚拟化：临时把 `offsetWidth/offsetHeight/clientWidth/clientHeight` 固定为非 0
 *     （tanstack-virtual 依 `offsetHeight` 决定渲染行），否则虚拟化在 jsdom 下渲染 0 行。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardViewConfig } from '@/config/types';
import type { SdkRecord } from '@/sdk/port';
import type { EnvSnapshot } from '@/sdk/env';
import type { Measurer } from '@/pagination/types';
import type { UsePagedDocumentDeps } from '@/hooks/usePagedDocument';
import { createDefaultConfig } from '@/config/defaults';
import { degradedConfigKey } from '@/constants';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { getContentBox, getPaperSizePx } from '@/constants/paper';
import { deserializeEnvelope } from '@/config/ConfigRepository';
import { resolveBlocks } from '@/doc/resolve';
import { LocalStorageConfigRepository, type StorageLike } from '@/config/LocalStorageConfigRepository';
import { useDraftStore } from '@/state/DraftStore';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { ConfigDrawer } from './ConfigDrawer';
import { DetailDrawer } from '@/components/detail/DetailDrawer';
import { VirtualCardGrid } from '@/components/grid/VirtualCardGrid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 夹具 ============================ */

const APP_ID = 'app_1';
const VIEW_ID = 'view_1';

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f4', name: '创建时间', type: FieldType.CreatedTime, isPrimary: false },
];

const FIELDS_BY_ID: Record<string, FieldMetaLite> = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

const RECORDS: SdkRecord[] = [
  { recordId: 'rA', fields: { f1: '张伟', f2: 100, f3: '进行中' } } as unknown as SdkRecord,
  { recordId: 'rB', fields: { f1: '李四', f2: 200, f3: '已完成' } } as unknown as SdkRecord,
];

const ENV: EnvSnapshot = {
  productType: 'web',
  language: 'zh-CN',
  theme: 'light',
  tableId: 'tbl_1',
  viewId: VIEW_ID,
  appId: APP_ID,
  userId: 'u_1',
};

/** 内存 `StorageLike`（真实持久化介质：非绕过，`LocalStorageConfigRepository` 原样使用） */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 忽略宿主的确定性 measurer：所有区块同高 → 页数可精确预期 */
function flatMeasurer(height: number): Measurer {
  return {
    measureBlocks: (_host, blocks) =>
      blocks.map((block) => ({ blockId: block.blockId, kind: block.kind, outerHeight: height })),
  };
}

/** 默认注入依赖：stub 测量 + no-op 离屏渲染 + 立即就绪的字体（jsdom 无布局引擎） */
function stubDeps(height: number): UsePagedDocumentDeps {
  return {
    measurer: flatMeasurer(height),
    renderHost: () => () => undefined,
    awaitFonts: () => Promise.resolve(true),
  };
}

/* ============================ 挂载 / 交互工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return { container, unmount };
}

/** 冲净微任务（让 awaitFonts 之后的链路落 state / 重渲染，并让 async 保存完成） */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

/** 受控表单控件赋值（绕过 React 的 value 追踪） */
function setControl(el: Element | null, value: string): void {
  if (!el) throw new Error('setControl: element not found');
  act(() => {
    if (el instanceof HTMLSelectElement) selectSetter?.call(el, value);
    else inputSetter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 按标签 + 精确文本找按钮（顶栏 tab / 保存） */
function buttonByText(container: HTMLElement, text: string): HTMLElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text);
  if (!el) throw new Error(`button not found: "${text}"`);
  return el as HTMLElement;
}

/** 临时把 HTMLElement 的布局尺寸固定为非 0（jsdom 恒 0，会让虚拟化渲染 0 行） */
async function withLayoutBox(width: number, height: number, fn: () => Promise<void>): Promise<void> {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const keys = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(proto, key));
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => width });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => height });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => height });
  try {
    await fn();
  } finally {
    keys.forEach((key, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete proto[key];
    });
  }
}

/** 把 ViewStore 置为「已装载、可编辑」态（= useCardViewInit 成功后的形态） */
function seedLoadedView(config: CardViewConfig, repository: LocalStorageConfigRepository): void {
  useViewStore.setState({
    status: 'browse',
    env: ENV,
    viewName: '订单视图',
    fields: FIELDS,
    fieldsById: FIELDS_BY_ID,
    records: RECORDS,
    total: RECORDS.length,
    hasMore: false,
    loadingMore: false,
    config,
    configSource: 'localStorage',
    canEditConfig: true,
    unsupportedNewer: false,
    degraded: false,
    corrupted: false,
    configCorrupted: false,
    repository,
  });
  useUiStore.setState({
    editorOpen: false,
    editMode: 'card',
    toast: null,
    searchQuery: '',
    drawer: initialDrawerState(null),
  });
  useDraftStore.getState().close();
}

beforeEach(() => {
  useDraftStore.getState().close();
  useUiStore.setState({ editorOpen: false, editMode: 'card', toast: null, drawer: initialDrawerState(null) });
});

/* =====================================================================
 * ① doc 往返闭环（用户报的入口：切「文档排版」→ 三栏编辑器）
 * ===================================================================== */

describe('T13 · doc 排版端到端往返（保存 → 重载 → 详情抽屉反映）', () => {
  it('删区块 + 改朝向 + 改主题 → 保存写入载荷 → 重载 → 详情抽屉渲染反映（完整闭环）', async () => {
    const storage = memoryStorage();
    const repository = new LocalStorageConfigRepository(storage, APP_ID);
    const baseConfig = createDefaultConfig({ viewId: VIEW_ID, tableId: 'tbl_1', fields: FIELDS });
    const baseBlockCount = baseConfig.detail.doc.blocks.length; // 默认 A4 模板 8 块
    seedLoadedView(baseConfig, repository);

    /* ── 环节 A：打开配置抽屉（用户点「配置」）── */
    act(() => {
      useUiStore.getState().openEditor('card');
    });
    const editor = mount(createElement(ConfigDrawer));
    await flush();
    expect(editor.container.querySelector('[data-testid="config-drawer"]')).not.toBeNull();

    /* ── 环节 B：切「文档排版」→ 三栏编辑器渲染（正面锚点）── */
    click(buttonByText(editor.container, '文档排版'));
    expect(editor.container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    expect(editor.container.querySelector('[data-testid="doc-canvas"]')).not.toBeNull();
    expect(editor.container.querySelectorAll('.cbv-blocklib__item').length).toBe(12);

    /* ── 环节 C1：删一个区块（真实 UI：点画布首块 → 点「删除该区块」）── */
    const flow = editor.container.querySelector('.cbv-editor__doc-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    const firstShell = Array.from(flow.children).find((el) => el.hasAttribute('data-block-id')) as HTMLElement;
    const deletedId = firstShell.getAttribute('data-block-id') as string;
    expect(deletedId).toBeTruthy();
    click(firstShell);
    const deleteBtn = Array.from(editor.container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('删除该区块'),
    );
    click(deleteBtn ?? null);
    expect(useDraftStore.getState().docDraft?.blocks.length).toBe(baseBlockCount - 1);
    expect(useDraftStore.getState().docDraft?.blocks.some((b) => b.blockId === deletedId)).toBe(false);

    /* ── 环节 C2：改页面朝向（真实 UI：展开「页面设置」→ 点「横向」）── */
    click(editor.container.querySelector('[data-docprops-toggle="page"]'));
    click(editor.container.querySelector('[data-setup-orientation="landscape"]'));
    expect(useDraftStore.getState().docDraft?.pageSetup.orientation).toBe('landscape');

    /* ── 环节 C3：改主题（真实 UI：展开「主题」→ 点主色 swatch + 改基准字号）── */
    click(editor.container.querySelector('[data-docprops-toggle="theme"]'));
    click(editor.container.querySelector('[data-theme-swatch="#00B42A"]'));
    setControl(editor.container.querySelector('[data-theme-control="baseFontSize"]'), '18');
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');
    expect(useDraftStore.getState().docDraft?.theme.baseFontSize).toBe(18);
    // 正面锚点：草稿已被标记 dirty（否则「保存」按钮语义无意义）
    expect(useDraftStore.getState().dirty).toBe(true);

    /* ── 环节 D：保存（真实 UI：点「保存」）── */
    click(buttonByText(editor.container, '保存'));
    await flush();
    expect(useUiStore.getState().editorOpen).toBe(false); // 保存成功 → 编辑器关闭
    expect(useUiStore.getState().toast).toBe('已保存');

    /* ── 环节 E：断言写入存储的载荷是「改后」模板（真实 serialize + checksum）── */
    const raw = storage.getItem(degradedConfigKey(APP_ID, VIEW_ID));
    expect(raw).not.toBeNull();
    const { envelope, valid } = deserializeEnvelope(raw);
    expect(valid).toBe(true); // checksum 校验通过（序列化无损）
    const payload = envelope?.payload as CardViewConfig;
    expect(payload.detail.doc.blocks.length).toBe(baseBlockCount - 1);
    expect(payload.detail.doc.blocks.some((b) => b.blockId === deletedId)).toBe(false);
    expect(payload.detail.doc.pageSetup.orientation).toBe('landscape');
    expect(payload.detail.doc.theme.primaryColor).toBe('#00B42A');
    expect(payload.detail.doc.theme.baseFontSize).toBe(18);
    // 未触碰的 card 分支必须原样保留（保存是整包写入，不能误伤）
    expect(payload.card).toEqual(baseConfig.card);
    editor.unmount();

    /* ── 环节 F：模拟「重开」——新仓储实例读同一存储 ── */
    const reloaded = await new LocalStorageConfigRepository(storage, APP_ID).load(VIEW_ID);
    expect(reloaded.config).not.toBeNull();
    expect(reloaded.degraded).toBe(false);
    const reloadedConfig = reloaded.config as CardViewConfig;
    expect(reloadedConfig.detail.doc.blocks.length).toBe(baseBlockCount - 1);
    expect(reloadedConfig.detail.doc.pageSetup.orientation).toBe('landscape');
    expect(reloadedConfig.detail.doc.theme.primaryColor).toBe('#00B42A');
    expect(reloadedConfig.detail.doc.theme.baseFontSize).toBe(18);

    // 落地 ViewStore（= useCardViewInit 装载路径）
    act(() => {
      useViewStore.setState({ config: reloadedConfig });
    });

    /* ── 环节 G：闭环 —— 详情抽屉渲染出的文档反映改动 ── */
    act(() => {
      useUiStore.getState().openDrawer('rA');
    });
    const drawer = mount(createElement(DetailDrawer, { pagedDeps: stubDeps(60) }));
    await flush();

    const paper = drawer.container.querySelector('.cbv-paper') as HTMLElement;
    expect(paper).not.toBeNull();
    // G1 页面几何：朝向已生效（DocPaper data-orientation + 纸宽 + 内容盒宽）
    expect(paper.getAttribute('data-orientation')).toBe('landscape');
    expect(paper.style.width).toBe(`${getPaperSizePx('A4', 'landscape').w}px`);
    const contentBox = getContentBox('A4', 'landscape', reloadedConfig.detail.doc.pageSetup.margin);
    const contentBody = paper.querySelector('[data-content-box="true"]') as HTMLElement;
    expect(contentBody.style.width).toBe(`${contentBox.width}px`);
    expect(contentBody.style.width).not.toBe(`${getContentBox('A4', 'portrait', reloadedConfig.detail.doc.pageSetup.margin).width}px`);
    // G2 主题：基准字号已生效（DocPaper 根 inline style）
    expect(paper.style.fontSize).toBe('18px');

    // G3 区块集合：渲染出的 blockId 序列 == 重载模板经 resolve 后的序列，且被删块不在其中
    const expectedIds = resolveBlocks({
      blocks: reloadedConfig.detail.doc.blocks,
      record: RECORDS[0] as never,
      fields: FIELDS,
      locale: 'zh-CN',
    }).map((block) => block.blockId);
    const renderedIds = Array.from(drawer.container.querySelectorAll('[data-block-id]')).map((el) =>
      el.getAttribute('data-block-id'),
    );
    expect(expectedIds).not.toContain(deletedId);
    expect(expectedIds.length).toBe(baseBlockCount - 1);
    expect(renderedIds).toEqual(expectedIds);
    expect(renderedIds).not.toContain(deletedId);

    drawer.unmount();
  });

  it('断链证伪：只改不保存 → 重载得到空配置（闭环**依赖**持久化，非内存残留）', async () => {
    const storage = memoryStorage();
    const repository = new LocalStorageConfigRepository(storage, APP_ID);
    const baseConfig = createDefaultConfig({ viewId: VIEW_ID, tableId: 'tbl_1', fields: FIELDS });
    seedLoadedView(baseConfig, repository);

    act(() => {
      useUiStore.getState().openEditor('doc');
    });
    const editor = mount(createElement(ConfigDrawer));
    await flush();
    click(editor.container.querySelector('[data-docprops-toggle="theme"]'));
    click(editor.container.querySelector('[data-theme-swatch="#F53F3F"]'));
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#F53F3F');

    // 未保存 → 存储里什么都没有
    expect(storage.getItem(degradedConfigKey(APP_ID, VIEW_ID))).toBeNull();
    const reloaded = await new LocalStorageConfigRepository(storage, APP_ID).load(VIEW_ID);
    expect(reloaded.config).toBeNull();
    editor.unmount();
  });
});

/* =====================================================================
 * ② card 排版同类往返（防 T10 接线只对了 doc 分支而破坏 card 往返）
 * ===================================================================== */

describe('T13 · card 排版端到端往返（保存 → 重载 → 卡片墙反映）', () => {
  it('换卡片模板 → 保存 → 重载 → 真实卡片墙 data-template 反映，且 doc 分支未被误伤', async () => {
    const storage = memoryStorage();
    const repository = new LocalStorageConfigRepository(storage, APP_ID);
    const baseConfig = createDefaultConfig({ viewId: VIEW_ID, tableId: 'tbl_1', fields: FIELDS });
    expect(baseConfig.card.templateId).toBe('standard');
    seedLoadedView(baseConfig, repository);

    act(() => {
      useUiStore.getState().openEditor('card'); // 默认 card 模式
    });
    const editor = mount(createElement(ConfigDrawer));
    await flush();

    // 卡片模板画廊（真实 UI）：点「清单」
    click(editor.container.querySelector('[data-template-id="list"]'));
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('list');

    click(buttonByText(editor.container, '保存'));
    await flush();
    expect(useUiStore.getState().editorOpen).toBe(false);

    const raw = storage.getItem(degradedConfigKey(APP_ID, VIEW_ID));
    const { envelope, valid } = deserializeEnvelope(raw);
    expect(valid).toBe(true);
    const payload = envelope?.payload as CardViewConfig;
    expect(payload.card.templateId).toBe('list');
    // doc 分支未被 card 编辑波及（两分支各自独立进载荷）
    expect(payload.detail.doc).toEqual(baseConfig.detail.doc);
    editor.unmount();

    // 重载 → 落地 → 渲染真实卡片墙
    const reloaded = await new LocalStorageConfigRepository(storage, APP_ID).load(VIEW_ID);
    expect(reloaded.config?.card.templateId).toBe('list');
    const layout = (reloaded.config as CardViewConfig).card;
    expect(layout.templateId).not.toBe('standard');
    act(() => {
      useViewStore.setState({ config: reloaded.config });
    });

    await withLayoutBox(1200, 600, async () => {
      const grid = mount(
        createElement(VirtualCardGrid, {
          layout,
          density: (reloaded.config as CardViewConfig).density,
          theme: (reloaded.config as CardViewConfig).theme,
          fieldsById: FIELDS_BY_ID,
          locale: 'zh-CN',
          attributesMaxRows: 3,
          highlightRules: [],
          records: RECORDS,
          onOpenRecord: () => undefined,
        }),
      );
      await flush();
      const cards = grid.container.querySelectorAll('.cbv-card');
      expect(cards.length).toBeGreaterThan(0); // 卡片墙确实渲染了卡片（非空断言的正面锚点）
      expect(cards[0].getAttribute('data-template')).toBe('list');
      expect(cards[0].getAttribute('data-template')).not.toBe('standard');
      grid.unmount();
    });
  });
});

/* =====================================================================
 * ③ 两个 tab 互不干扰（doc 草稿 vs card 草稿）
 * ===================================================================== */

describe('T13 · doc / card 草稿互不干扰', () => {
  it('doc 改了不保存 → 切 card 改 → 切回 doc：doc 草稿仍在，card 草稿独立，且未保存不写入存储', async () => {
    const storage = memoryStorage();
    const repository = new LocalStorageConfigRepository(storage, APP_ID);
    const baseConfig = createDefaultConfig({ viewId: VIEW_ID, tableId: 'tbl_1', fields: FIELDS });
    seedLoadedView(baseConfig, repository);

    act(() => {
      useUiStore.getState().openEditor('card');
    });
    const editor = mount(createElement(ConfigDrawer));
    await flush();

    // doc 分支改主题主色
    click(buttonByText(editor.container, '文档排版'));
    click(editor.container.querySelector('[data-docprops-toggle="theme"]'));
    click(editor.container.querySelector('[data-theme-swatch="#00B42A"]'));
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');

    // 切回 card 分支改模板
    click(buttonByText(editor.container, '卡片排版'));
    click(editor.container.querySelector('[data-template-id="compact"]'));
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('compact');
    // card 变更**不得**污染 doc 草稿
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('compact');

    // 再切回 doc：doc 编辑器重新渲染，且 DOM 反映 doc 草稿（主题段主色仍按下）
    click(buttonByText(editor.container, '文档排版'));
    expect(editor.container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    click(editor.container.querySelector('[data-docprops-toggle="theme"]'));
    expect(
      editor.container.querySelector('[data-theme-swatch="#00B42A"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    // 两分支草稿均独立保留
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('compact');

    // 全程未保存 → 存储无任何写入
    expect(storage.getItem(degradedConfigKey(APP_ID, VIEW_ID))).toBeNull();
    editor.unmount();
  });
});
