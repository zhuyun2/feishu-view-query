/**
 * `usePagedDocument` 编排测试（T07；2026-09-21 设计变更：详情改为「**单张连续长页**」后更新）。
 *
 * ⭐ 本文件随设计变更同步更新的断言（旧「分页」行为已按用户拍板移除）：
 *  - 产物**恒为单页**（`totalPages ∈ {0,1}`）：不再有「8 块 ×400px → 4 页」的装箱结果；
 *  - 注入的 `measurer` / `renderHost` 已**不参与**链路（惰性保留）→ 用「同一 measurer 下产物仍单页」证伪；
 *  - **不再回写** `UiStore.drawer` 的分页字段（`paginating` / `totalPages` / `currentPage` / `paginationFailed`）。
 *
 * 仍必须守住的两点（否则是「用户看得见但不报错」的静默故障）：
 *  - **过期响应不覆盖新记录**（`runSeqRef` + `cancelled` 双守卫）：夹具用**字体就绪标志**
 *    （B→`fontReady=true` / A→`false`）分离两条链路 —— 单页形态下页数不再可区分，故改用 fontReady；
 *  - **字体就绪**：`awaitDocumentFonts` 超时返回 false（不卡死），链路继续出结果，且字体迟到就绪后自动重算。
 *
 * 确定性来源：注入 stub `awaitFonts`（可控）+ 惰性 measurer；真实 DOM 测量在 jsdom 下恒为 0，无意义。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Measurer } from '@/pagination/types';
import type { DocTemplate, ParagraphBlock } from '@/config/types';
import type { ResolvedBlock } from '@/doc/resolve';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import {
  awaitDocumentFonts,
  emptyPagedDocument,
  toEngineBlock,
  usePagedDocument,
  type UsePagedDocumentArgs,
  type UsePagedDocumentDeps,
  type UsePagedDocumentResult,
} from './usePagedDocument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 夹具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

const TEMPLATE = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;

const RECORD_A = { recordId: 'rA', fields: { f1: '张伟', f2: 100 } } as never;
const RECORD_B = { recordId: 'rB', fields: { f1: '李四', f2: 200 } } as never;

/** 记录相关模板：每个区块都绑定 f1 → 记录切换时每个区块的 `payloadHash` 都变（用于内容级判别） */
function varyingTemplate(count = 8): DocTemplate {
  const base = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;
  const blocks: ParagraphBlock[] = Array.from({ length: count }, (_, index) => ({
    blockId: `blk_para_${index}`,
    kind: 'paragraph',
    breakInside: 'avoid',
    fieldId: 'f1',
    preserveLineBreaks: false,
    hideWhenEmpty: false,
  }));
  return { ...base, templateId: 't07-varying', blocks };
}

function baseArgs(): UsePagedDocumentArgs {
  return { template: TEMPLATE, record: null, recordId: null, fields: FIELDS, locale: 'zh-CN', enabled: false };
}

/**
 * 忽略宿主的确定性 measurer（**惰性**：单页长页后不再被读取）。
 * 保留它正是为了证明：注入「会让旧实现分 4 页」的 measurer，新实现产物**仍是单页**。
 */
function flatMeasurer(height: number): Measurer {
  return {
    measureBlocks: (_host, blocks) =>
      blocks.map((block) => ({ blockId: block.blockId, kind: block.kind, outerHeight: height })),
  };
}

/** no-op 离屏渲染（**惰性**：单页长页后不再渲染离屏宿主） */
const NOOP_RENDER_HOST = () => () => undefined;

function deps(overrides: Partial<UsePagedDocumentDeps> = {}): UsePagedDocumentDeps {
  return {
    measurer: flatMeasurer(400),
    renderHost: NOOP_RENDER_HOST,
    awaitFonts: () => Promise.resolve(true),
    ...overrides,
  };
}

/* ============================ 挂载工具 ============================ */

interface Harness {
  current: () => UsePagedDocumentResult;
  setArgs: (next: UsePagedDocumentArgs) => void;
  unmount: () => void;
}

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

/** 挂载一个只调用 hook 的探针；`setArgs` 触发重渲染（模拟记录切换） */
function mountHook(initial: UsePagedDocumentArgs): Harness {
  let args = initial;
  let result: UsePagedDocumentResult | null = null;
  function Probe(): JSX.Element {
    result = usePagedDocument(args);
    return createElement('span', { 'data-testid': 'probe', 'data-total': result.pagedDoc.totalPages });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (): void => {
    act(() => {
      root.render(createElement(Probe));
    });
  };
  render();
  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return {
    current: () => {
      if (!result) throw new Error('hook 结果尚未就绪');
      return result;
    },
    setArgs: (next) => {
      args = next;
      render();
    },
    unmount,
  };
}

/** 冲净微任务（让 awaitFonts 之后的同步链路跑完并落 state） */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 临时替换 `document.fonts`（jsdom 未实现 FontFaceSet）；结束后还原/移除自有属性 */
async function withFonts(value: unknown, fn: () => Promise<void>): Promise<void> {
  const own = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, writable: true, value });
  try {
    await fn();
  } finally {
    if (own) Object.defineProperty(document, 'fonts', own);
    else Reflect.deleteProperty(document, 'fonts');
  }
}

beforeEach(() => {
  useUiStore.setState({ drawer: initialDrawerState(null) });
});

/* ============================ 用例 ============================ */

describe('T07 · usePagedDocument 编排（单页长页）', () => {
  it('空文档工厂：totalPages=0 且不降级（渲染层据此出空态）', () => {
    expect(emptyPagedDocument()).toEqual({ pages: [], totalPages: 0, fontReady: true, degraded: false });
  });

  it('未启用（enabled=false）→ 空产物，且不触碰 UiStore 分页字段', async () => {
    const h = mountHook(baseArgs());
    await flush();
    expect(h.current().pagedDoc.totalPages).toBe(0);
    expect(h.current().resolvedBlocks).toEqual([]);
    expect(useUiStore.getState().drawer.paginating).toBe(false);
    expect(useUiStore.getState().drawer.paginationFailed).toBe(false);
  });

  it('打开记录 → 出「单页」产物（8 块全部同页）；即使注入 400px/块 measurer 也不再分页', async () => {
    const h = mountHook({
      ...baseArgs(),
      enabled: true,
      record: RECORD_A,
      recordId: 'rA',
      deps: deps(), // measurer = 400px/块（旧实现会切成 4 页）
    });
    await flush();
    // 正面锚点：8 块确实求值出来了
    expect(h.current().resolvedBlocks.length).toBe(8);
    // ⭐ 单页：8 块全部落在唯一一页
    expect(h.current().pagedDoc.totalPages).toBe(1);
    expect(h.current().pagedDoc.pages.length).toBe(1);
    expect(h.current().pagedDoc.pages[0]?.items.length).toBe(8);
    // ⭐ 不再回写 store 分页字段（保留在 store，值仍为初始）
    expect(useUiStore.getState().drawer.paginating).toBe(false);
    expect(useUiStore.getState().drawer.paginationFailed).toBe(false);
  });

  it('⭐ 切换记录：过期（更晚完成）的响应不得覆盖新记录的结果', async () => {
    const resolvers: Array<(ready: boolean) => void> = [];
    const awaitFonts = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      });
    const shared = deps({ awaitFonts });
    const template = varyingTemplate();

    const h = mountHook({
      ...baseArgs(),
      template,
      enabled: true,
      record: RECORD_A,
      recordId: 'rA',
      deps: shared,
    });
    expect(resolvers.length).toBe(1); // A 链路挂在字体等待上
    expect(h.current().pagedDoc.totalPages).toBe(0); // 尚未出结果

    // 切到 B：A 链路被作废，B 链路启动（仍挂在字体等待上）
    h.setArgs({ ...baseArgs(), template, enabled: true, record: RECORD_B, recordId: 'rB', deps: shared });
    expect(resolvers.length).toBe(2);

    // 先让 B 完成：fontReady = true（B 是「新记录」）
    await act(async () => {
      resolvers[1](true);
    });
    expect(h.current().pagedDoc.totalPages).toBe(1);
    expect(h.current().pagedDoc.fontReady).toBe(true);

    // 再让 A（更晚）完成：fontReady = false。守卫失效 → 会被覆盖成 false（判别力所在）
    await act(async () => {
      resolvers[0](false);
    });
    expect(h.current().pagedDoc.totalPages).toBe(1);
    expect(h.current().pagedDoc.fontReady).toBe(true); // 仍是 B 的结果
  });

  it('字体未就绪（超时）→ 继续出结果，标记 fontReady=false 但**不**置降级（degraded=false）', async () => {
    const h = mountHook({
      ...baseArgs(),
      enabled: true,
      record: RECORD_A,
      recordId: 'rA',
      deps: deps({ awaitFonts: () => Promise.resolve(false) }),
    });
    await flush();
    expect(h.current().pagedDoc.totalPages).toBe(1); // 仍出了结果（不卡死）
    expect(h.current().fontReady).toBe(false);
    expect(h.current().pagedDoc.degraded).toBe(false);
    expect(useUiStore.getState().drawer.paginationFailed).toBe(false);
  });

  it('字体迟到就绪 → 自动重算一次（自愈：第二次结果 fontReady=true）', async () => {
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    await withFonts({ ready }, async () => {
      let calls = 0;
      const h = mountHook({
        ...baseArgs(),
        enabled: true,
        record: RECORD_A,
        recordId: 'rA',
        deps: deps({
          awaitFonts: () => {
            calls += 1;
            return Promise.resolve(calls > 1); // 首次未就绪 → 迟到就绪后为 true
          },
        }),
      });
      await flush();
      expect(h.current().fontReady).toBe(false); // 首次：未就绪

      await act(async () => {
        resolveReady();
        await Promise.resolve();
      });
      await flush();
      expect(h.current().fontReady).toBe(true); // 自愈重算
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });

  it('不再回写 UiStore.drawer：store 里 currentPage 保持不动（详情路径不驱动分页字段）', async () => {
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, currentPage: 99 } });
    const h = mountHook({
      ...baseArgs(),
      enabled: true,
      record: RECORD_A,
      recordId: 'rA',
      deps: deps(),
    });
    await flush();
    // 正面锚点：链路确实跑完并产出单页
    expect(h.current().pagedDoc.totalPages).toBe(1);
    // 负断言：currentPage 不再被回写/钳制（仍为 99）
    expect(useUiStore.getState().drawer.currentPage).toBe(99);
  });

  it('toEngineBlock（遗留纯函数）：映射 blockId/kind/breakInside/payloadHash', () => {
    const resolved = {
      blockId: 'b1',
      kind: 'paragraph',
      block: { breakInside: 'auto' },
      payloadHash: 'h1',
    } as unknown as ResolvedBlock;
    expect(toEngineBlock(resolved)).toEqual({
      blockId: 'b1',
      kind: 'paragraph',
      breakInside: 'auto',
      payloadHash: 'h1',
    });
  });
});

describe('T07 · awaitDocumentFonts（超时不卡死）', () => {
  it('超时 → 返回 false（且远快于超时上限，不阻塞）', async () => {
    await withFonts({ ready: new Promise(() => undefined) }, async () => {
      const started = Date.now();
      await expect(awaitDocumentFonts(30)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('字体就绪 → 返回 true', async () => {
    await withFonts({ ready: Promise.resolve() }, async () => {
      await expect(awaitDocumentFonts(500)).resolves.toBe(true);
    });
  });

  it('无 FontFaceSet（如环境缺失）→ 视为就绪（不阻塞）', async () => {
    await withFonts(undefined, async () => {
      await expect(awaitDocumentFonts(30)).resolves.toBe(true);
    });
  });
});
