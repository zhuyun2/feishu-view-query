/**
 * `usePagedDocument` 的**关联表格预取**编排测试（需求 2 · 第一阶段）。
 *
 * 本文件只锁一件事 —— 预取链路的两条**静默故障**防线（与 `usePagedDocument.test.tsx`
 * 里字体链路的守卫同款，但这里是**独立**的 `linkRunSeqRef`）：
 *  ① **过期响应不得覆盖新记录**：快速点两张卡片时，先发起（后完成）的关联表格
 *     **绝不**能落到新记录上。若不守，用户会看到「B 记录配 A 记录的关联表」且不报错。
 *  ② **记录切换即清空**：`record` 变化瞬间必须**同步**清空上一轮的表格，
 *     绝不允许「新记录 + 旧关联表」在预取完成前继续显示。
 *
 * ⭐ 守卫是**双保险**（`linkRunSeqRef` 序号 + `cancelled` 标志）：只删一处不一定变红，
 *   故本文件的判别用例以「更晚完成的旧链路」为攻击面，同时覆盖两条防线的存在性。
 *
 * 确定性来源：注入 `linkSource.resolveAccess`（可控闸门，**不 sleep**）+ 惰性 measurer；
 * 注入后**完全不会加载 SDK**（jsdom 下加载 SDK 会产生未处理 rejection）。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocTemplate, FieldListBlock } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type { LinkTable, LinkTablePrefetchAccess } from '@/doc/linkTable';
import {
  usePagedDocument,
  type UsePagedDocumentArgs,
  type UsePagedDocumentDeps,
  type UsePagedDocumentResult,
} from './usePagedDocument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 夹具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f_link', name: '关联项目', type: FieldType.Link, isPrimary: false },
];

const LINK_BLOCK: FieldListBlock = {
  blockId: 'blk_fl',
  kind: 'fieldList',
  breakInside: 'auto',
  items: [{ fieldId: 'f_link' }],
  showLabels: true,
  hideEmptyItems: false,
};

/** 只含一个「关联字段」区块的模板：预取结果一旦落到 state，即可经 `linkTables` 观察到 */
function linkTemplate(): DocTemplate {
  const base = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail.doc;
  return { ...base, templateId: 'req2-link', blocks: [LINK_BLOCK] };
}

const RECORD_A = { recordId: 'rA', fields: { f1: '甲' } } as unknown as SdkRecord;
const RECORD_B = { recordId: 'rB', fields: { f1: '乙' } } as unknown as SdkRecord;

/**
 * 构造一个「结果可区分的」只读访问能力：列标题 = `${label}项目`。
 * 两条记录用不同 label（`A表` / `B表`）→ 断言最终剩下的是哪一条，判别力所在。
 */
function accessFor(label: string): LinkTablePrefetchAccess {
  return {
    reader: async () => ({ recordIds: ['rec_l1'], tableId: 'tbl_t' }),
    getTargetFieldMetas: async () => [
      { id: 'tf_name', name: `${label}项目`, type: FieldType.Text, isPrimary: true },
    ],
    getTargetRow: async (_tableId: string, recordId: string) => ({
      recordId,
      fields: { tf_name: `${label}·行` },
    }),
  };
}

/** 可逐拍 resolve 的闸门（**不 sleep**，时序确定） */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function mountHook(initial: UsePagedDocumentArgs): Harness {
  let args = initial;
  let result: UsePagedDocumentResult | null = null;
  function Probe(): JSX.Element {
    result = usePagedDocument(args);
    return createElement('span', { 'data-testid': 'probe' });
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

/** 冲净微任务（让预取链路的多个 await 全部落定并触发 setState） */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 从产物里读出「关联表格的列标题」（= 判别两条记录结果是否串台的锚点） */
function linkLabel(h: Harness): string | undefined {
  const block = h.current().resolvedBlocks.find((item) => item.blockId === 'blk_fl');
  const table: LinkTable | undefined = block?.linkTables?.f_link;
  return table?.columns[0]?.label;
}

/** 只注入「字体就绪（即时）+ 关联访问能力」的依赖 */
function linkDeps(
  resolveAccess: (tableId: string | null, record: SdkRecord | null) => Promise<LinkTablePrefetchAccess | null>,
): UsePagedDocumentDeps {
  return { awaitFonts: () => Promise.resolve(true), linkSource: { resolveAccess } };
}

function argsFor(
  template: DocTemplate,
  record: SdkRecord,
  recordId: string,
  deps: UsePagedDocumentDeps,
): UsePagedDocumentArgs {
  return { template, record, recordId, fields: FIELDS, locale: 'zh-CN', enabled: true, tableId: 't', deps };
}

/* ============================ 用例 ============================ */

describe('需求2 · usePagedDocument 关联表格预取 · 过期响应守卫', () => {
  it('⭐ 切换记录：更晚完成的**旧**记录预取不得覆盖新记录', async () => {
    const gateA = deferred<LinkTablePrefetchAccess | null>();
    const gateB = deferred<LinkTablePrefetchAccess | null>();
    const resolveAccess = (
      _tableId: string | null,
      record: SdkRecord | null,
    ): Promise<LinkTablePrefetchAccess | null> =>
      record?.recordId === 'rA' ? gateA.promise : gateB.promise;

    const template = linkTemplate();
    const deps = linkDeps(resolveAccess);

    const h = mountHook(argsFor(template, RECORD_A, 'rA', deps));
    await flush();
    // A 链路仍挂在闸门上 → 尚无任何关联表格（也证明预取确实是异步的）
    expect(linkLabel(h)).toBeUndefined();

    // 切到 B：A 链路被作废，B 链路启动（仍挂在闸门上）
    h.setArgs(argsFor(template, RECORD_B, 'rB', deps));
    await flush();

    // ⭐ B（后发起）先完成 → 正面锚点：B 的表确实落到了新记录上
    await act(async () => {
      gateB.resolve(accessFor('B表'));
    });
    await flush();
    expect(linkLabel(h)).toBe('B表项目');

    // ⭐ A（先发起）后完成 —— 这是**过期**结果，绝不能覆盖 B（守卫失效 → 必红）
    await act(async () => {
      gateA.resolve(accessFor('A表'));
    });
    await flush();

    expect(linkLabel(h)).toBe('B表项目');
    expect(linkLabel(h)).not.toBe('A表项目');
  });

  it('⭐ 切换记录：上一记录的关联表格在**新结果到达前**立即清空（不显示旧表）', async () => {
    const gateA = deferred<LinkTablePrefetchAccess | null>();
    const gateB = deferred<LinkTablePrefetchAccess | null>();
    const resolveAccess = (
      _tableId: string | null,
      record: SdkRecord | null,
    ): Promise<LinkTablePrefetchAccess | null> =>
      record?.recordId === 'rA' ? gateA.promise : gateB.promise;

    const template = linkTemplate();
    const deps = linkDeps(resolveAccess);

    const h = mountHook(argsFor(template, RECORD_A, 'rA', deps));
    await flush();
    await act(async () => {
      gateA.resolve(accessFor('A表'));
    });
    await flush();
    expect(linkLabel(h)).toBe('A表项目'); // 正面锚点：A 的表已生效

    // 切到 B（B 仍挂在闸门上）→ 旧表必须**立刻**消失
    h.setArgs(argsFor(template, RECORD_B, 'rB', deps));
    await flush();
    expect(linkLabel(h)).toBeUndefined();

    // B 完成 → 换成 B 的表
    await act(async () => {
      gateB.resolve(accessFor('B表'));
    });
    await flush();
    expect(linkLabel(h)).toBe('B表项目');
  });

  it('无可用访问能力（编辑器 / SDK 不可用）→ 不落表，块仍正常求值（优雅降级）', async () => {
    const template = linkTemplate();
    const deps = linkDeps(async () => null);

    const h = mountHook(argsFor(template, RECORD_A, 'rA', deps));
    await flush();

    // 正面锚点：块确实求值出来了（不是「整块没渲染」）
    expect(h.current().resolvedBlocks.length).toBe(1);
    // 反面锚点：没有关联表格
    expect(linkLabel(h)).toBeUndefined();
  });
});
