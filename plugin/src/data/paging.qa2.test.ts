/**
 * QA2 独立验证（任务 #13/#15）· T10：虚拟滚动网格的数据分页/增量加载逻辑。
 *
 * ⚠️ 覆盖边界（诚实标注）：
 *  - 本文件验证的是**逻辑级**（纯函数 / 纯类）：分页去重追加、并发抑制、末页抑制、缓存命中、
 *    触底判定、节流。
 *  - **jsdom 下无法验证**：真实 1.2 万行的渲染性能、滚动帧率（≥50FPS）、`@tanstack/react-virtual`
 *    的真实测量与 overscan 行为、ResizeObserver 驱动的列数变化 —— 这些属**真机/浏览器**项。
 *
 * 断言来源：`03 §13.1` 增量加载「剩余 < 1 屏触发；100ms 节流」；T10「增量加载触发正确」。
 */
import { describe, expect, it } from 'vitest';
import type { IRecord } from '@lark-base-open/js-sdk';
import { appendUniqueRecords, PagedRecordController, type PageLoader } from './recordPages';
import { RecordCache } from './RecordCache';
import { getRecordId, type PageResult } from './RecordDataSource';
import {
  createScrollLoadController,
  estimateRowHeight,
  shouldLoadMore,
  visibleCardRange,
} from '@/components/grid/gridMath';

function rec(id: string): IRecord {
  return { recordId: id } as unknown as IRecord;
}

function page(records: IRecord[], pageToken: string | null, hasMore: boolean): PageResult {
  return { records, pageToken, hasMore };
}

const ids = (list: readonly IRecord[]): string[] => list.map((r) => getRecordId(r));

/* ============================ 去重追加 ============================ */

describe('T10 · 分页去重追加（appendUniqueRecords）', () => {
  it('按 recordId 去重，保持既有顺序在前', () => {
    expect(ids(appendUniqueRecords([rec('a'), rec('b')], [rec('b'), rec('c')]))).toEqual(['a', 'b', 'c']);
  });

  it('完全重叠 → 不新增', () => {
    expect(ids(appendUniqueRecords([rec('a')], [rec('a')]))).toEqual(['a']);
  });

  it('缺 recordId 的记录不参与去重（原样保留）', () => {
    const noId = { fields: {} } as unknown as IRecord;
    expect(appendUniqueRecords([noId], [noId]).length).toBe(2);
  });
});

/* ============================ 分页累积控制器 ============================ */

describe('T10 · PagedRecordController：串行追加 / 并发抑制 / 末页抑制', () => {
  it('顺序 loadNext 追加，末页后不再请求', async () => {
    let calls = 0;
    const loader: PageLoader = async () => {
      calls += 1;
      return page([rec('b')], null, false);
    };
    const controller = new PagedRecordController({
      first: page([rec('a')], 'p2', true),
      loader,
    });

    expect(await controller.loadNext()).toBe(1);
    expect(ids(controller.list)).toEqual(['a', 'b']);
    expect(controller.canLoadMore).toBe(false);

    // 末页抑制：hasMore=false → 返回 0 且不发请求
    expect(await controller.loadNext()).toBe(0);
    expect(calls).toBe(1);
    expect(controller.requestCount).toBe(1);
  });

  it('并发 loadNext：只有一次真实请求（pending 抑制）', async () => {
    let release: (p: PageResult) => void = () => undefined;
    const gate = new Promise<PageResult>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const loader: PageLoader = () => {
      calls += 1;
      return gate;
    };
    const controller = new PagedRecordController({ first: page([rec('a')], 'p2', true), loader });

    const first = controller.loadNext();
    const second = controller.loadNext();
    expect(await second).toBe(0); // 被抑制
    expect(calls).toBe(1);
    expect(controller.isLoading).toBe(true);

    release(page([rec('b')], null, false));
    expect(await first).toBe(1);
    expect(controller.isLoading).toBe(false);
    expect(calls).toBe(1);
  });

  it('重叠分页：去重后只计新增数', async () => {
    const loader: PageLoader = async () => page([rec('b'), rec('c')], null, false);
    const controller = new PagedRecordController({ first: page([rec('a'), rec('b')], 'p2', true), loader });
    expect(await controller.loadNext()).toBe(1);
    expect(ids(controller.list)).toEqual(['a', 'b', 'c']);
  });

  it('页级缓存：重复游标命中缓存，loader 不再被调用', async () => {
    const cache = new RecordCache();
    let calls = 0;
    const loader: PageLoader = async () => {
      calls += 1;
      return page([rec('x')], null, false);
    };
    const controller = new PagedRecordController({
      first: page([rec('a')], 'p2', true),
      loader,
      cache,
      cacheKeyPrefix: 'page',
    });

    await controller.loadNext();
    expect(calls).toBe(1);

    controller.reset(page([rec('a')], 'p2', true));
    await controller.loadNext();
    expect(calls).toBe(1); // 命中缓存
    expect(controller.requestCount).toBe(2); // 「请求意图」计 2 次，但真实 loader 仅 1 次
  });
});

/* ============================ 1.2 万行（逻辑级） ============================ */

describe('T10 · 1.2 万行分页累积（逻辑级，非真机渲染）', () => {
  const TOTAL = 12000;
  const PAGE = 200;
  const PAGES = TOTAL / PAGE; // 60

  function pageAt(index: number): PageResult {
    const start = index * PAGE;
    const records = Array.from({ length: PAGE }, (_, i) => rec(`r${start + i}`));
    const hasMore = index < PAGES - 1;
    return { records, pageToken: hasMore ? String(index + 1) : null, hasMore };
  }

  it('累积 12000 条、真实请求 59 次、无重复', async () => {
    let calls = 0;
    const loader: PageLoader = async (token) => {
      calls += 1;
      return pageAt(Number(token));
    };
    const controller = new PagedRecordController({ first: pageAt(0), loader });

    let guard = 0;
    while (controller.canLoadMore && guard < 500) {
      await controller.loadNext();
      guard += 1;
    }

    expect(controller.count).toBe(TOTAL);
    expect(calls).toBe(PAGES - 1); // 首页已提供
    expect(new Set(ids(controller.list)).size).toBe(TOTAL); // 无重复
  });
});

/* ============================ 触底判定 / 节流 ============================ */

describe('T10 · shouldLoadMore / 节流（100ms）', () => {
  it('剩余 < 1 屏 → 触发；否则不触发', () => {
    const base = { viewportHeight: 100, contentHeight: 1000, hasMore: true, loading: false };
    expect(shouldLoadMore({ ...base, scrollTop: 900 })).toBe(true); // remaining = 0
    expect(shouldLoadMore({ ...base, scrollTop: 800 })).toBe(true); // remaining = 100 <= 100
    expect(shouldLoadMore({ ...base, scrollTop: 700 })).toBe(false); // remaining = 200 > 100
  });

  it('前置不满足（无更多 / 加载中 / 非法高度）→ 不触发', () => {
    const base = { scrollTop: 900, viewportHeight: 100, contentHeight: 1000, hasMore: true, loading: false };
    expect(shouldLoadMore({ ...base, hasMore: false })).toBe(false);
    expect(shouldLoadMore({ ...base, loading: true })).toBe(false);
    expect(shouldLoadMore({ ...base, viewportHeight: 0 })).toBe(false);
    expect(shouldLoadMore({ ...base, contentHeight: Number.NaN })).toBe(false);
  });

  it('ScrollLoadController：首次触发 → pending 抑制 → 节流窗口内不重复 → 超窗再触发', () => {
    let now = 1000;
    const controller = createScrollLoadController({ thresholdScreens: 1, throttleMs: 100, now: () => now });
    const input = { scrollTop: 900, viewportHeight: 100, contentHeight: 1000, hasMore: true, loading: false };

    expect(controller.update(input)).toBe(true);
    expect(controller.triggers).toBe(1);

    expect(controller.update(input)).toBe(false); // pending 抑制
    controller.markLoading(false);
    expect(controller.update(input)).toBe(false); // 节流窗口内（now 未变）

    now += 150;
    expect(controller.update(input)).toBe(true);
    expect(controller.triggers).toBe(2);
  });

  it('未到触底 → 从不触发', () => {
    const controller = createScrollLoadController({ now: () => 0 });
    expect(controller.update({ scrollTop: 0, viewportHeight: 100, contentHeight: 5000, hasMore: true, loading: false })).toBe(false);
    expect(controller.triggers).toBe(0);
  });
});

/* ============================ 几何纯函数 ============================ */

describe('T10 · 行高估算 / 可见区间', () => {
  it('estimateRowHeight：maxCardHeight + gap（非法则兜底 180）', () => {
    expect(estimateRowHeight(220, 16)).toBe(236);
    expect(estimateRowHeight(0, 16)).toBe(196);
    expect(estimateRowHeight(-1, -5)).toBe(180);
  });

  it('visibleCardRange：闭区间行 → 半开区间卡片索引', () => {
    expect(visibleCardRange(0, 2, 3, 100)).toEqual({ startIndex: 0, endIndex: 9 });
    expect(visibleCardRange(1, 1, 2, 3)).toEqual({ startIndex: 2, endIndex: 3 });
    expect(visibleCardRange(0, 9, 2, 5)).toEqual({ startIndex: 0, endIndex: 5 });
  });
});
