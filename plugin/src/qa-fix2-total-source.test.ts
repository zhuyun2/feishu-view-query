/**
 * QA（qa-fix2-batch）· **独立证伪**：总数的真源（页响应 total / countSafe / 回退）与边界。
 *
 * 只读实现，独立重写断言，不复用实现方的 `SdkRecordDataSource.total.test.ts`。
 *
 * 关注点（用户问题 2「提示显示不正确」的上游根因）：
 *  - 缺 `total` 字段 / 脏 total（负 / 浮点 / 字符串 / NaN / Infinity）如何收敛？
 *  - `countSafe` 能否把「取不到」与「真的是 0」分开？失败是否真的打 warn 且不上抛？
 *  - `resolveTotalInfo` 的三档优先级与降级标记是否与实现声明一致？
 */
import { describe, expect, it, vi } from 'vitest';
import type { SdkRecord, SdkTable } from '@/sdk/port';
import { resolveTotalInfo } from '@/data/RecordDataSource';
import type { PageResult, RecordDataSource } from '@/data/RecordDataSource';
import { SdkRecordDataSource } from '@/data/SdkRecordDataSource';

/** 结构化 spy 类型（避免依赖 vitest 的 Mock 泛型推断细节） */
interface Spy {
  mock: { calls: unknown[][] };
}

function rec(id: string): SdkRecord {
  return { recordId: id, fields: {} } as unknown as SdkRecord;
}

interface ByPageResponse {
  records?: unknown;
  pageToken?: unknown;
  hasMore?: unknown;
  total?: unknown;
}

function makeTable(opts: {
  byPage?: (params: unknown) => ByPageResponse | Promise<ByPageResponse>;
  visibleIds?: () => unknown;
  visibleThrows?: boolean;
}): { table: SdkTable; byPageSpy: Spy; getViewSpy: Spy } {
  const byPageSpy = vi.fn((params: unknown) => {
    if (opts.byPage) return opts.byPage(params);
    return { records: [], pageToken: null, hasMore: false };
  });
  const getViewSpy = vi.fn(async () => ({
    getVisibleRecordIdList: opts.visibleThrows
      ? vi.fn().mockRejectedValue(new Error('no view'))
      : vi.fn(async () => (opts.visibleIds ? await opts.visibleIds() : [])),
  }));
  const table = { getRecordsByPage: byPageSpy, getViewById: getViewSpy } as unknown as SdkTable;
  return { table, byPageSpy, getViewSpy };
}

/** 从被 mock 的 console.warn 调用里取「scope 命中」的 ctx 列表 */
function warnsFrom(spy: Spy, scope: string): Record<string, unknown>[] {
  return spy.mock.calls
    .filter((call) => String(call[0]).includes(`[cbv:${scope}]`))
    .map((call) => (call[2] ?? {}) as Record<string, unknown>);
}

/* ===================== ① 页响应 total 的收敛 ===================== */

describe('① loadPage：响应 total 的边界收敛', () => {
  it('合法整数 0 / 5 → 原样（0 是「真的是 0」，不是「取不到」）', async () => {
    const t0 = makeTable({ byPage: () => ({ records: [], hasMore: false, total: 0 }) });
    expect((await new SdkRecordDataSource(t0.table, 'v').loadPage({ viewId: 'v', pageSize: 200 })).total).toBe(0);

    const t5 = makeTable({ byPage: () => ({ records: [], hasMore: false, total: 5 }) });
    expect((await new SdkRecordDataSource(t5.table, 'v').loadPage({ viewId: 'v', pageSize: 200 })).total).toBe(5);
  });

  it('浮点 3.9 → 截断为 3（不产生小数分母）', async () => {
    const t = makeTable({ byPage: () => ({ records: [], hasMore: false, total: 3.9 }) });
    expect((await new SdkRecordDataSource(t.table, 'v').loadPage({ viewId: 'v', pageSize: 200 })).total).toBe(3);
  });

  it('负数 / NaN / Infinity / 字符串 / 布尔 / null / 缺失 → 一律 undefined（不臆造 0）', async () => {
    const dirty: unknown[] = [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '100', true, null, undefined];
    for (const value of dirty) {
      const { table } = makeTable({ byPage: () => ({ records: [], hasMore: false, total: value }) });
      const page = await new SdkRecordDataSource(table, 'v').loadPage({ viewId: 'v', pageSize: 200 });
      expect(page.total, `total=${String(value)} 必须收敛为 undefined`).toBeUndefined();
    }
  });

  it('缺 total 字段 → undefined（关键：不得当成 0）', async () => {
    const { table } = makeTable({ byPage: () => ({ records: [rec('r1')], hasMore: false }) });
    expect((await new SdkRecordDataSource(table, 'v').loadPage({ viewId: 'v', pageSize: 200 })).total).toBeUndefined();
  });

  it('缓存页回填：同 token 第二次走缓存，total 仍被记住（count 可复用）', async () => {
    const { table, byPageSpy } = makeTable({
      byPage: () => ({ records: [rec('r1')], pageToken: null, hasMore: false, total: 7 }),
    });
    const ds = new SdkRecordDataSource(table, 'v');
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    expect(byPageSpy.mock.calls.length).toBe(1); // 第二次命中缓存
    await expect(ds.count()).resolves.toBe(7);
  });
});

/* ===================== ② count() / countSafe() / getVisibleRecordIds() ===================== */

describe('② countSafe：区分「取不到」与「真的是 0」', () => {
  it('有页 total（含 0）→ 直接用，且不请求 id 列表', async () => {
    const { table, getViewSpy } = makeTable({ byPage: () => ({ records: [], hasMore: false, total: 0 }) });
    const ds = new SdkRecordDataSource(table, 'v');
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 0, totalKnown: true });
    expect(getViewSpy.mock.calls.length).toBe(0);
  });

  it('无页 total + id 列表成功（含空表）→ { length, true }', async () => {
    const { table } = makeTable({ byPage: () => ({ records: [], hasMore: false }), visibleIds: () => ['a', 'b'] });
    const ds = new SdkRecordDataSource(table, 'v');
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 2, totalKnown: true });

    const empty = makeTable({ byPage: () => ({ records: [], hasMore: false }), visibleIds: () => [] });
    const ds2 = new SdkRecordDataSource(empty.table, 'v');
    await ds2.loadPage({ viewId: 'v', pageSize: 200 });
    await expect(ds2.countSafe()).resolves.toEqual({ total: 0, totalKnown: true });
  });

  it('无页 total + id 列表抛错 → { 0, false } 且打 data.countSafe warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { table } = makeTable({ byPage: () => ({ records: [], hasMore: false }), visibleThrows: true });
    const ds = new SdkRecordDataSource(table, 'v');
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 0, totalKnown: false });
    expect(warnsFrom(warnSpy, 'data.countSafe').length).toBe(1);
    warnSpy.mockRestore();
  });

  it('getVisibleRecordIds：SDK 抛错 → 返回 [] 且**不上抛**，打 data.getVisibleRecordIds warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { table } = makeTable({ visibleThrows: true });
    const ds = new SdkRecordDataSource(table, 'v');
    await expect(ds.getVisibleRecordIds()).resolves.toEqual([]); // 不抛
    expect(warnsFrom(warnSpy, 'data.getVisibleRecordIds').length).toBe(1);
    warnSpy.mockRestore();
  });

  it('getVisibleRecordIds：非数组返回 → []；混入非字符串项被过滤（容器形状防御）', async () => {
    const nonArray = makeTable({ visibleIds: () => 'not-an-array' });
    await expect(new SdkRecordDataSource(nonArray.table, 'v').getVisibleRecordIds()).resolves.toEqual([]);

    const mixed = makeTable({ visibleIds: () => ['a', 1, null, 'b'] });
    await expect(new SdkRecordDataSource(mixed.table, 'v').getVisibleRecordIds()).resolves.toEqual(['a', 'b']);
  });

  it('count()：优先页 total；缺失回退 id 长度；clearCache 后旧 total 作废', async () => {
    const { table } = makeTable({
      byPage: () => ({ records: [], hasMore: false, total: 9 }),
      visibleIds: () => ['a', 'b', 'c'],
    });
    const ds = new SdkRecordDataSource(table, 'v');
    await ds.loadPage({ viewId: 'v', pageSize: 200 });
    await expect(ds.count()).resolves.toBe(9);
    ds.clearCache();
    await expect(ds.count()).resolves.toBe(3); // 回退 id 列表
    await expect(ds.countSafe()).resolves.toEqual({ total: 3, totalKnown: true });
  });

  it('陈旧 total 保留语义：后续页缺 total 时不覆盖既有已知值（不静默归零）', async () => {
    let call = 0;
    const { table } = makeTable({
      byPage: () => {
        call += 1;
        return call === 1
          ? { records: [rec('r1')], pageToken: 'p2', hasMore: true, total: 100 }
          : { records: [rec('r2')], pageToken: null, hasMore: false }; // 第二页缺 total
      },
    });
    const ds = new SdkRecordDataSource(table, 'v');
    const p1 = await ds.loadPage({ viewId: 'v', pageSize: 200 });
    expect(p1.total).toBe(100);
    const p2 = await ds.loadPage({ viewId: 'v', pageSize: 200, pageToken: 'p2' });
    expect(p2.total).toBeUndefined();
    await expect(ds.count()).resolves.toBe(100); // 旧 total 未被 undefined 覆盖
  });
});

/* ===================== ③ resolveTotalInfo 三档优先级 ===================== */

function fakeSource(partial: Partial<RecordDataSource>): RecordDataSource {
  return {
    loadPage: async () => ({ records: [], pageToken: null, hasMore: false }),
    loadRecord: async () => null,
    count: async () => 0,
    getVisibleRecordIds: async () => [],
    clearCache: () => undefined,
    ...partial,
  };
}

describe('③ resolveTotalInfo：页 total → countSafe → count（标未知）', () => {
  it('页 total 为有限数字 → 采用，且不触碰 countSafe / count', async () => {
    const countSafe = vi.fn(async () => ({ total: 999, totalKnown: true }));
    const count = vi.fn(async () => 999);
    const source = fakeSource({ countSafe, count });
    const page: PageResult = { records: [], pageToken: null, hasMore: false, total: 12 };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 12, totalKnown: true });
    expect(countSafe.mock.calls.length).toBe(0);
    expect(count.mock.calls.length).toBe(0);
  });

  it('页 total 为 NaN / 字符串 → 不采用，落到 countSafe', async () => {
    const bads: unknown[] = [Number.NaN, '100'];
    for (const bad of bads) {
      const countSafe = vi.fn(async () => ({ total: 4, totalKnown: true }));
      const source = fakeSource({ countSafe });
      const page: PageResult = { records: [], pageToken: null, hasMore: false, total: bad as number };
      await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 4, totalKnown: true });
      expect(countSafe.mock.calls.length).toBe(1);
    }
  });

  it('桩缺 countSafe → 回退 count()，并**标为未知**（保守）', async () => {
    const source = fakeSource({ count: async () => 3 });
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 3, totalKnown: false });
  });

  it('countSafe 抛错 → 平稳回退 count()，不上抛', async () => {
    const source = fakeSource({
      countSafe: async () => {
        throw new Error('boom');
      },
      count: async () => 5,
    });
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 5, totalKnown: false });
  });

  it('countSafe 给出 totalKnown=false → 原样透传（不擅自翻成已知）', async () => {
    const source = fakeSource({ countSafe: async () => ({ total: 0, totalKnown: false }) });
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 0, totalKnown: false });
  });

  it('⚠️ 观察项：页 total 为负数（非 SDK 路径可达）→ 夹到 0 且标 totalKnown=true', async () => {
    // SDK 路径的 toPageTotal 已把负数收敛为 undefined；此处覆盖「其它数据源直接给负数」。
    const source = fakeSource({});
    const page: PageResult = { records: [], pageToken: null, hasMore: false, total: -3 };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 0, totalKnown: true });
  });

  it('⚠️ 观察项：countSafe 给负数 → 夹到 0 且 totalKnown 保留', async () => {
    const source = fakeSource({ countSafe: async () => ({ total: -8, totalKnown: true }) });
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 0, totalKnown: true });
  });
});
