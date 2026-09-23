/**
 * 分页控制器单测（设计文档 §21.2 A 组 / §21.3.2 / §21.4.4 / §21.10-⑦）。
 *
 * ⚠️ 反假绿基线：**全部用例注入 `measurer.stub.ts`，绝不依赖真实布局**。
 * jsdom 没有布局引擎，`offsetHeight` 恒为 0 —— 若走真实测量，所有区块高度都会是 0，
 * 分页退化成「全部塞进第一页」，测试可能依然"绿"但验证的是错的场景。
 * 因此本文件每条用例都断言**具体区块顺序 / 具体数值**，改坏实现必然变红：
 *  - 断言 `pages[0].items.map(i => i.blockId)` 精确等于 `['b1','b2']`，而非「分了两页」；
 *  - 断言高度为注入值 `100/400/100`，若为 0（说明误走真实布局）立即红。
 */
import { describe, expect, it, vi } from 'vitest';
import type { BreakInside, DocBlockKind } from '@/config/types';
import { createHeightCache, metricsKey, type HeightCache } from './heightCache';
import {
  ESTIMATED_BLOCK_HEIGHT,
  LARGE_DOC_BLOCK_LIMIT,
  LARGE_DOC_PAGE_LIMIT,
  MEASURE_CHUNK_SIZE,
  createPaginationController,
  type EngineBlock,
  type PaginateInput,
  type PaginationControllerDeps,
} from './engine';
import { DEFAULT_IMAGE_TIMEOUT_MS, createDomMeasurer, createOffscreenHost } from './measurer';
import { createStubMeasurer } from './measurer.stub';
import type { BlockMetrics, Measurer } from './types';

/** 测试期静默错误出口（生产默认走 logError） */
const silent: NonNullable<PaginationControllerDeps['onError']> = (): void => {
  //  intentionally empty
};

interface BlockSpec {
  id: string;
  kind?: DocBlockKind;
  breakInside?: BreakInside;
  keepWithNext?: boolean;
  hash?: string;
}

function blockOf(spec: BlockSpec): EngineBlock {
  const out: EngineBlock = {
    blockId: spec.id,
    kind: spec.kind ?? 'paragraph',
    breakInside: spec.breakInside ?? 'avoid',
    payloadHash: spec.hash ?? 'v1',
  };
  if (spec.keepWithNext !== undefined) out.keepWithNext = spec.keepWithNext;
  return out;
}

function heightsOf(entries: Record<string, number>): Record<string, Partial<BlockMetrics>> {
  const out: Record<string, Partial<BlockMetrics>> = {};
  Object.keys(entries).forEach((id) => {
    out[id] = { outerHeight: entries[id] };
  });
  return out;
}

function idsOf(pageIndex: number, pages: { pages: Array<{ items: Array<{ blockId: string }> }> }): string[] {
  const page = pages.pages[pageIndex];
  return page ? page.items.map((item) => item.blockId) : [];
}

/** 供 stub 使用的宿主：jsdom 元素，但 stub 根本不读它（仅证明编排链路通畅） */
function fakeHost(): HTMLElement {
  return document.createElement('div');
}

describe('pagination/engine —— 测量 → 装箱 编排（注入 stub，零布局依赖）', () => {
  it('注入 stub：100/400/100 在 500 内容盒下恰好切为 [b1,b2] + [b3]', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100, b2: 400, b3: 100 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const input: PaginateInput = {
      blocks: [blockOf({ id: 'b1' }), blockOf({ id: 'b2' }), blockOf({ id: 'b3' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    };

    const doc = controller.paginate(input);

    expect(doc.degraded).toBe(false);
    expect(doc.fontReady).toBe(true);
    expect(doc.totalPages).toBe(2);
    // 高度为注入值而非 0 —— 若为 0 说明误走了 jsdom 的真实布局
    expect(doc.pages[0].items.map((i) => i.height)).toEqual([100, 400]);
    expect(doc.pages[0].usedHeight).toBe(500);
    expect(idsOf(0, doc)).toEqual(['b1', 'b2']);
    expect(doc.pages[1].items.map((i) => i.height)).toEqual([100]);
    expect(idsOf(1, doc)).toEqual(['b3']);
    expect(stub.callCount).toBe(1);
  });

  it('相同 payloadHash 二次分页命中缓存：测量器只被调用一次', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100, b2: 400, b3: 100 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const input: PaginateInput = {
      blocks: [blockOf({ id: 'b1' }), blockOf({ id: 'b2' }), blockOf({ id: 'b3' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    };

    const first = controller.paginate(input);
    const second = controller.paginate(input);

    expect(stub.callCount).toBe(1);
    expect(second).toEqual(first);
    expect(controller.lastReport()?.cachedCount).toBe(3);
    expect(controller.lastReport()?.measuredCount).toBe(0);
    expect(controller.lastReport()?.degraded).toBe(false);
  });

  it('payloadHash 变化必须重新测量（内容变了高度却不更新 = 最难排查的 bug）', () => {
    const table = heightsOf({ b1: 100, b2: 300 });
    const stub = createStubMeasurer(table);
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const base = { contentWidth: 560, contentHeight: 500, host: fakeHost() };

    const v1 = controller.paginate({
      ...base,
      blocks: [blockOf({ id: 'b1', hash: 'v1' }), blockOf({ id: 'b2', hash: 'v1' })],
    });
    expect(v1.totalPages).toBe(1);
    expect(v1.pages[0].items.map((i) => i.height)).toEqual([100, 300]);
    expect(stub.callCount).toBe(1);

    // 内容变化：b1 由 100 变 300，hash 由 v1 变 v2
    table.b1 = { outerHeight: 300 };
    const v2 = controller.paginate({
      ...base,
      blocks: [blockOf({ id: 'b1', hash: 'v2' }), blockOf({ id: 'b2', hash: 'v1' })],
    });

    expect(stub.callCount).toBe(2); // 重新测量，而不是命中旧缓存
    expect(v2.totalPages).toBe(2);
    expect(idsOf(0, v2)).toEqual(['b1']);
    expect(v2.pages[0].items[0].height).toBe(300);
    expect(idsOf(1, v2)).toEqual(['b2']);

    // 同一 v2 再算一次 → 这次应命中缓存
    controller.paginate({
      ...base,
      blocks: [blockOf({ id: 'b1', hash: 'v2' }), blockOf({ id: 'b2', hash: 'v1' })],
    });
    expect(stub.callCount).toBe(2);
  });

  it('contentWidth 变化必须重新测量（缓存键含宽度）', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const blocks = [blockOf({ id: 'b1' })];

    controller.paginate({ blocks, contentWidth: 560, contentHeight: 500, host: fakeHost() });
    controller.paginate({ blocks, contentWidth: 800, contentHeight: 500, host: fakeHost() });

    expect(stub.callCount).toBe(2);
  });

  it('调用方已测量的 metrics 直接装箱，不再触发测量器', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const metrics: BlockMetrics[] = [
      { blockId: 'b1', kind: 'paragraph', outerHeight: 300 },
      { blockId: 'b2', kind: 'paragraph', outerHeight: 300 },
    ];

    const doc = controller.paginate({
      blocks: [blockOf({ id: 'b1' }), blockOf({ id: 'b2' })],
      metrics,
      contentWidth: 560,
      contentHeight: 500,
    });

    expect(stub.callCount).toBe(0);
    expect(doc.degraded).toBe(false);
    expect(doc.totalPages).toBe(2);
    expect(idsOf(0, doc)).toEqual(['b1']);
    expect(idsOf(1, doc)).toEqual(['b2']);
  });

  it('测量器抛异常不崩溃：按估算高度继续并标记 degraded', () => {
    const boom: Measurer = {
      measureBlocks(): BlockMetrics[] {
        throw new Error('layout boom');
      },
    };
    const controller = createPaginationController({ measurer: boom, onError: silent });

    const doc = controller.paginate({
      blocks: [blockOf({ id: 'b1' }), blockOf({ id: 'b2' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    });

    expect(doc.degraded).toBe(true);
    expect(doc.totalPages).toBe(1);
    expect(doc.pages[0].items.map((i) => i.height)).toEqual([
      ESTIMATED_BLOCK_HEIGHT.paragraph,
      ESTIMATED_BLOCK_HEIGHT.paragraph,
    ]);
    expect(ESTIMATED_BLOCK_HEIGHT.paragraph).toBeGreaterThan(0); // 估算值不可为 0
    expect(controller.lastReport()?.estimatedCount).toBe(2);
    expect(controller.lastReport()?.failure).toBe('layout boom');
  });

  it('既无宿主也无 metrics：走估算降级而不是抛错', () => {
    const controller = createPaginationController({ onError: silent });
    const doc = controller.paginate({
      blocks: [blockOf({ id: 'b1', kind: 'heading' })],
      contentWidth: 560,
      contentHeight: 500,
    });

    expect(doc.degraded).toBe(true);
    expect(doc.pages[0].items[0].height).toBe(ESTIMATED_BLOCK_HEIGHT.heading);
    expect(controller.lastReport()?.failure).toBe('no-measure-source');
  });

  it('装箱异常被兜住：退化为单页长文档（内容不丢）', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 300, b2: 300 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });

    const doc = controller.paginate({
      blocks: [blockOf({ id: 'b1' }), blockOf({ id: 'b2' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
      // 读取该配置即抛 → 逼 packPages 走异常分支（正常路径应为 2 页）
      options: {
        get minUnitsAtBottom(): number {
          throw new Error('pack boom');
        },
      },
    });

    expect(doc.degraded).toBe(true);
    expect(doc.totalPages).toBe(1);
    expect(idsOf(0, doc)).toEqual(['b1', 'b2']);
    expect(controller.lastReport()?.failure).toBe('pack boom');
  });

  it('字体未就绪：fontReady=false 且不写缓存（字体到位后高度会变）', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100 }));
    const cache: HeightCache = createHeightCache();
    const controller = createPaginationController({ measurer: stub, cache, onError: silent });
    const input = {
      blocks: [blockOf({ id: 'b1' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    };

    const notReady = controller.paginate({ ...input, fontReady: false });
    expect(notReady.fontReady).toBe(false);
    expect(cache.size).toBe(0);

    controller.paginate(input);
    expect(cache.size).toBe(1);
  });
});

describe('pagination/engine —— 大文档保护（§21.4.4）', () => {
  it('>200 区块：分块测量（每批 ≤64）且不写缓存，避免冲刷 LRU', () => {
    const count = 250;
    const blocks: EngineBlock[] = [];
    const table: Record<string, Partial<BlockMetrics>> = {};
    for (let i = 0; i < count; i += 1) {
      const id = `b${i}`;
      blocks.push(blockOf({ id }));
      table[id] = { outerHeight: 20 };
    }
    const stub = createStubMeasurer(table);
    const cache = createHeightCache();
    const controller = createPaginationController({ measurer: stub, cache, onError: silent });

    const doc = controller.paginate({
      blocks,
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    });

    expect(count).toBeGreaterThan(LARGE_DOC_BLOCK_LIMIT);
    expect(stub.callCount).toBe(Math.ceil(count / MEASURE_CHUNK_SIZE)); // 250 → 4 批
    expect(cache.size).toBe(0); // 大文档只读不写
    expect(controller.lastReport()?.protections).toContain('block-limit');
    expect(controller.lastReport()?.protections).toContain('chunked-measure');
    expect(doc.degraded).toBe(false);
    expect(doc.totalPages).toBe(10); // 250 块 ×20px = 5000px，每页 500px → 恰好 10 页
  });

  it('>50 页：触发页上限保护，同样不写缓存', () => {
    const blocks: EngineBlock[] = [];
    const table: Record<string, Partial<BlockMetrics>> = {};
    for (let i = 0; i < 60; i += 1) {
      const id = `b${i}`;
      blocks.push(blockOf({ id }));
      table[id] = { outerHeight: 500 };
    }
    const cache = createHeightCache();
    const controller = createPaginationController({
      measurer: createStubMeasurer(table),
      cache,
      onError: silent,
    });

    const doc = controller.paginate({
      blocks,
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    });

    expect(doc.totalPages).toBe(60);
    expect(60).toBeGreaterThan(LARGE_DOC_PAGE_LIMIT);
    expect(controller.lastReport()?.protections).toContain('page-limit');
    expect(cache.size).toBe(0);
  });
});

describe('pagination/heightCache —— 键构成与淘汰', () => {
  it('metricsKey 由 blockId + 宽 + payloadHash 三者共同决定', () => {
    expect(metricsKey('b1', 560, 'v1')).toBe(metricsKey('b1', 560, 'v1'));
    expect(metricsKey('b1', 560, 'v1')).not.toBe(metricsKey('b1', 800, 'v1'));
    expect(metricsKey('b1', 560, 'v1')).not.toBe(metricsKey('b1', 560, 'v2'));
    expect(metricsKey('b1', 560, 'v1')).not.toBe(metricsKey('b2', 560, 'v1'));
  });

  it('超出上限按 LRU 淘汰，避免万级区块下无限增长', () => {
    const cache = createHeightCache({ maxEntries: 2 });
    const metricOf = (id: string): BlockMetrics => ({
      blockId: id,
      kind: 'paragraph',
      outerHeight: 10,
    });

    cache.set(metricsKey('b1', 560, 'v1'), metricOf('b1'));
    cache.set(metricsKey('b2', 560, 'v1'), metricOf('b2'));
    cache.get(metricsKey('b1', 560, 'v1')); // 刷新 b1 热度
    cache.set(metricsKey('b3', 560, 'v1'), metricOf('b3'));

    expect(cache.size).toBe(2);
    expect(cache.maxEntries).toBe(2);
    expect(cache.get(metricsKey('b2', 560, 'v1'))).toBeUndefined();
    expect(cache.get(metricsKey('b1', 560, 'v1'))?.outerHeight).toBe(10);
    expect(cache.get(metricsKey('b3', 560, 'v1'))?.outerHeight).toBe(10);
  });

  it('invalidate 可按 blockId 精确失效其全部条目，不传参则全清', () => {
    const cache = createHeightCache();
    const metricOf = (id: string): BlockMetrics => ({
      blockId: id,
      kind: 'paragraph',
      outerHeight: 10,
    });
    cache.set(metricsKey('b1', 560, 'v1'), metricOf('b1'));
    cache.set(metricsKey('b1', 800, 'v1'), metricOf('b1'));
    cache.set(metricsKey('b2', 560, 'v1'), metricOf('b2'));

    cache.invalidate(['b1']);
    expect(cache.get(metricsKey('b1', 560, 'v1'))).toBeUndefined();
    expect(cache.get(metricsKey('b1', 800, 'v1'))).toBeUndefined();
    expect(cache.get(metricsKey('b2', 560, 'v1'))).toBeDefined();
    expect(cache.size).toBe(1);

    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it('控制器 invalidate 透传缓存，使后续分页重新测量', () => {
    const stub = createStubMeasurer(heightsOf({ b1: 100 }));
    const controller = createPaginationController({ measurer: stub, onError: silent });
    const input: PaginateInput = {
      blocks: [blockOf({ id: 'b1' })],
      contentWidth: 560,
      contentHeight: 500,
      host: fakeHost(),
    };

    controller.paginate(input);
    controller.paginate(input);
    expect(stub.callCount).toBe(1);

    controller.invalidate(['b1']);
    controller.paginate(input);
    expect(stub.callCount).toBe(2);
  });
});

describe('pagination/measurer —— 离屏宿主与图片超时（不依赖 offsetHeight）', () => {
  it('stub 完全不碰 DOM：host 传 null 仍返回注入高度', () => {
    const stub = createStubMeasurer({ b1: { outerHeight: 100 } });
    const metrics = stub.measureBlocks(null as unknown as HTMLElement, [
      { blockId: 'b1', kind: 'paragraph' },
    ]);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].blockId).toBe('b1');
    expect(metrics[0].outerHeight).toBe(100);
    expect(metrics[0].units).toBeUndefined();
  });

  it('离屏宿主：hidden + absolute + 宽度=内容盒宽；destroy 后脱离文档', () => {
    const handle = createOffscreenHost(560);

    expect(handle.host.style.visibility).toBe('hidden'); // 不可见但仍参与布局
    expect(handle.host.style.position).toBe('absolute');
    expect(handle.host.style.width).toBe('560px');
    expect(handle.host.isConnected).toBe(true);

    handle.destroy();
    expect(handle.host.isConnected).toBe(false);
  });

  it('宿主缺少某区块根节点时不抛异常，高度记 0', () => {
    const handle = createOffscreenHost(560);
    const measurer = createDomMeasurer();

    const metrics = measurer.measureBlocks(handle.host, [
      { blockId: 'missing', kind: 'paragraph' },
    ]);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].blockId).toBe('missing');
    expect(metrics[0].outerHeight).toBe(0);
    handle.destroy();
  });

  it('无待定图片时立即放行（不引入任何等待）', async () => {
    const handle = createOffscreenHost(560);
    const measurer = createDomMeasurer({ imageTimeoutMs: 5000 });
    let done = false;

    void measurer.waitForImages(handle.host).then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(done).toBe(true);
    handle.destroy();
  });

  it('图片迟迟不加载：到点即放行，不把测量卡死（3s 默认口径）', async () => {
    expect(DEFAULT_IMAGE_TIMEOUT_MS).toBe(3000);
    const handle = createOffscreenHost(560);
    handle.host.innerHTML = '<div><img src="https://example.invalid/slow.png" alt="x" /></div>';
    const measurer = createDomMeasurer({ imageTimeoutMs: 20 });

    vi.useFakeTimers();
    let done = false;
    const pending = measurer.waitForImages(handle.host).then(() => {
      done = true;
    });

    vi.advanceTimersByTime(19);
    await Promise.resolve();
    expect(done).toBe(false); // 未到超时不放行

    vi.advanceTimersByTime(2);
    await pending;
    expect(done).toBe(true); // 超时后强制放行

    vi.useRealTimers();
    handle.destroy();
  });
});
