/**
 * 回归测试（工程师）——T10：虚拟滚动 + 增量加载（**逻辑级**验证）。
 *
 * ⚠️ 真实 1.2 万行卡片的**渲染性能**无法在 jsdom 中验证（无布局引擎、无真实数据表）；
 * 本文件验证的是「分页触发次数 / 记录去重 / 缓存命中 / 不重复请求 / 虚拟窗口计算」等
 * **纯逻辑**正确性 —— 这是可在逻辑层确定的部分。
 */
import { describe, expect, it, vi } from 'vitest';
import type { IRecord } from '@lark-base-open/js-sdk';
import { RecordCache } from '@/data/RecordCache';
import type { PageResult } from '@/data/RecordDataSource';
import { appendUniqueRecords, PagedRecordController } from '@/data/recordPages';
import {
  ScrollLoadController,
  createScrollLoadController,
  estimateRowHeight,
  visibleCardRange,
} from '@/components/grid/gridMath';
import { selectRowCount } from '@/state/selectors';

function rec(index: number): IRecord {
  return { recordId: `r${index}`, fields: {} } as unknown as IRecord;
}

const TOTAL = 12_000;
const PAGE = 200;

/** 构造 12,000 行的分页数据源（页大小 200 → 60 页） */
function makeLoader(): { loader: (token: string | null) => Promise<PageResult>; calls: () => number } {
  const spy = vi.fn(async (token: string | null): Promise<PageResult> => {
    const start = token ? Number(token) : 0;
    const size = Math.min(PAGE, Math.max(0, TOTAL - start));
    const records = Array.from({ length: size }, (_, k) => rec(start + k));
    const next = start + records.length;
    const hasMore = next < TOTAL;
    return { records, pageToken: hasMore ? String(next) : null, hasMore };
  });
  return { loader: spy, calls: () => spy.mock.calls.length };
}

describe('T10 · ScrollLoadController（滚动阈值 + 节流 + 去重）', () => {
  it('接近底部触发一次；pending 期间不重复；节流窗口内不触发', () => {
    let clock = 0;
    const controller = new ScrollLoadController({ thresholdScreens: 1, throttleMs: 100, now: () => clock });
    const nearBottom = { scrollTop: 1000, viewportHeight: 800, contentHeight: 2000, hasMore: true, loading: false };

    expect(controller.update(nearBottom)).toBe(true);
    expect(controller.triggers).toBe(1);

    // 尚在请求中 → 不再触发（去重）
    expect(controller.update(nearBottom)).toBe(false);

    controller.markLoading(false);
    // 节流窗口内 → 不触发
    expect(controller.update(nearBottom)).toBe(false);

    clock += 150;
    expect(controller.update(nearBottom)).toBe(true);
    expect(controller.triggers).toBe(2);
  });

  it('远离底部 / 无更多 / 加载中 → 不触发', () => {
    const controller = createScrollLoadController({ now: () => 1000 });
    expect(
      controller.update({ scrollTop: 0, viewportHeight: 800, contentHeight: 5000, hasMore: true, loading: false }),
    ).toBe(false);
    expect(
      controller.update({ scrollTop: 4200, viewportHeight: 800, contentHeight: 5000, hasMore: false, loading: false }),
    ).toBe(false);
    expect(
      controller.update({ scrollTop: 4200, viewportHeight: 800, contentHeight: 5000, hasMore: true, loading: true }),
    ).toBe(false);
  });
});

describe('T10 · appendUniqueRecords（按 recordId 去重）', () => {
  it('重叠分页 / 重复回填 → 不产生重复卡片', () => {
    const existing = [rec(1), rec(2), rec(3)];
    const incoming = [rec(3), rec(4), rec(5)];
    const merged = appendUniqueRecords(existing, incoming);
    expect(merged.map((record) => record.recordId)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });
});

describe('T10 · PagedRecordController（12,000 行分页累积）', () => {
  it('分页触发次数、总条数、末页抑制', async () => {
    const { loader, calls } = makeLoader();
    const first = await loader(null); // 首页（200 条）
    const controller = new PagedRecordController({ first, loader });

    let guard = 0;
    while (controller.canLoadMore && guard < 1000) {
      await controller.loadNext();
      guard += 1;
    }

    expect(controller.count).toBe(TOTAL);
    // 首页 1 次 + 后续 59 次 = 60 次真实取数
    expect(calls()).toBe(60);
    expect(controller.requestCount).toBe(59);

    // 末页 → 不再请求
    await controller.loadNext();
    expect(controller.requestCount).toBe(59);
    expect(calls()).toBe(60);
  });

  it('并发调用只会产生一次真实请求（pending 抑制）', async () => {
    const { loader, calls } = makeLoader();
    const first = await loader(null);
    const controller = new PagedRecordController({ first, loader });
    const before = calls();

    const [addedA, addedB] = await Promise.all([controller.loadNext(), controller.loadNext()]);
    expect(calls()).toBe(before + 1);
    expect(addedA + addedB).toBe(PAGE); // 只有一次真正追加
  });

  it('页级缓存命中 → 零请求（跨控制器复用）', async () => {
    const { loader, calls } = makeLoader();
    const cache = new RecordCache();
    const first = await loader(null); // 首页（不计入缓存）
    const firstCalls = calls();

    const controllerA = new PagedRecordController({ first, loader, cache, cacheKeyPrefix: 'grid' });
    await controllerA.loadNext();
    const afterA = calls();
    expect(afterA).toBe(firstCalls + 1);

    // 新的控制器拿到同一首页游标 → 命中缓存，不再请求
    const controllerB = new PagedRecordController({ first, loader, cache, cacheKeyPrefix: 'grid' });
    await controllerB.loadNext();
    expect(calls()).toBe(afterA);
    expect(controllerB.count).toBe(PAGE * 2);
  });
});

describe('T10 · 虚拟窗口几何（行高 / 可见卡区间 / 行数）', () => {
  it('estimateRowHeight 含间距', () => {
    expect(estimateRowHeight(220, 16)).toBe(236);
    expect(estimateRowHeight(0, 16)).toBe(196);
  });

  it('visibleCardRange 由可见行区间换算卡片区间', () => {
    expect(visibleCardRange(0, 2, 4, 12_000)).toEqual({ startIndex: 0, endIndex: 12 });
    expect(visibleCardRange(2, 3, 4, 12_000)).toEqual({ startIndex: 8, endIndex: 16 });
    // 末尾不越界
    expect(visibleCardRange(2999, 2999, 4, 12_000)).toEqual({ startIndex: 11_996, endIndex: 12_000 });
  });

  it('行数 = ceil(12000 / 列数)', () => {
    expect(selectRowCount(12_000, 4)).toBe(3000);
    expect(selectRowCount(12_000, 1)).toBe(12_000);
  });
});
