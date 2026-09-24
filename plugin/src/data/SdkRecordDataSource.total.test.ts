/**
 * 工程师 · 修复「总数取到 0」——数据层：读页响应 total / 回退路径 / 失败可区分 + warn。
 *
 * 这是「总数恒为 0」的关键修复点：`getRecordsByPage` 响应本就含 `total`，
 * 之前被丢弃；现在读出并复用（零额外请求），且把「取不到」与「真的是 0」用
 * `countSafe()` 明确区分开。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SdkRecord, SdkTable } from '@/sdk/port';
import type { PageResult, RecordDataSource } from './RecordDataSource';
import { resolveTotalInfo } from './RecordDataSource';
import { SdkRecordDataSource } from './SdkRecordDataSource';

function rec(id: string): SdkRecord {
  return { recordId: id, fields: {} } as unknown as SdkRecord;
}

interface ByPageResponse {
  records?: unknown;
  pageToken?: unknown;
  hasMore?: unknown;
  total?: unknown;
}

/** 组装 table：getRecordsByPage + 可选 getViewById（id 列表用） */
function makeTable(opts: {
  byPage?: (params: unknown) => Promise<ByPageResponse>;
  visibleIds?: () => Promise<unknown>;
  visibleThrows?: boolean;
}) {
  const byPageSpy = vi.fn(opts.byPage ?? (async () => ({ records: [], pageToken: null, hasMore: false })));
  const getViewSpy = vi.fn(async () => ({
    getVisibleRecordIdList: opts.visibleThrows
      ? vi.fn().mockRejectedValue(new Error('no view'))
      : vi.fn().mockResolvedValue(opts.visibleIds ? await opts.visibleIds() : []),
  }));
  const table = { getRecordsByPage: byPageSpy, getViewById: getViewSpy } as unknown as SdkTable;
  return { table, byPageSpy, getViewSpy };
}

describe('loadPage · 读取响应 total', () => {
  it('响应含数字 total → 随 PageResult 返回', async () => {
    const { table } = makeTable({
      byPage: async () => ({ records: [rec('r1')], pageToken: null, hasMore: false, total: 12480 }),
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    const page = await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    expect(page.total).toBe(12480);
  });

  it('响应缺 total → 结果为 undefined（不臆造 0）', async () => {
    const { table } = makeTable({ byPage: async () => ({ records: [rec('r1')], hasMore: false }) });
    const ds = new SdkRecordDataSource(table, 'view_A');
    const page = await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    expect(page.total).toBeUndefined();
  });

  it('响应 total 为脏数据（负数 / 非数字）→ undefined', async () => {
    const { table } = makeTable({ byPage: async () => ({ records: [], hasMore: false, total: -5 }) });
    const ds = new SdkRecordDataSource(table, 'view_A');
    expect((await ds.loadPage({ viewId: 'view_A', pageSize: 200 })).total).toBeUndefined();

    const { table: table2 } = makeTable({ byPage: async () => ({ records: [], hasMore: false, total: 'x' }) });
    const ds2 = new SdkRecordDataSource(table2, 'view_A');
    expect((await ds2.loadPage({ viewId: 'view_A', pageSize: 200 })).total).toBeUndefined();
  });
});

describe('count() · 优先用页响应 total，缺失才回退 id 列表', () => {
  it('有页 total → 直接返回它，不再请求 id 列表', async () => {
    const { table, getViewSpy } = makeTable({
      byPage: async () => ({ records: [rec('r1')], pageToken: null, hasMore: false, total: 42 }),
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.count()).resolves.toBe(42);
    expect(getViewSpy).not.toHaveBeenCalled();
  });

  it('无页 total → 回退 getVisibleRecordIdList 的长度', async () => {
    const { table, getViewSpy } = makeTable({
      byPage: async () => ({ records: [rec('r1')], pageToken: null, hasMore: false }),
      visibleIds: async () => ['a', 'b', 'c'],
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.count()).resolves.toBe(3);
    expect(getViewSpy).toHaveBeenCalled();
  });

  it('clearCache 后旧 total 作废：count 回退 id 列表', async () => {
    const { table } = makeTable({
      byPage: async () => ({ records: [], pageToken: null, hasMore: false, total: 9 }),
      visibleIds: async () => ['a'],
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.count()).resolves.toBe(9);
    ds.clearCache();
    await expect(ds.count()).resolves.toBe(1);
  });
});

describe('countSafe() · 「取不到」与「真的是 0」可区分', () => {
  it('有页 total → { total, totalKnown: true }，不发额外请求', async () => {
    const { table, getViewSpy } = makeTable({
      byPage: async () => ({ records: [], pageToken: null, hasMore: false, total: 0 }),
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 0, totalKnown: true });
    expect(getViewSpy).not.toHaveBeenCalled();
  });

  it('无页 total 但 id 列表成功（含空表）→ { length, true }', async () => {
    const { table } = makeTable({
      byPage: async () => ({ records: [], hasMore: false }),
      visibleIds: async () => [],
    });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 0, totalKnown: true });
  });

  it('无页 total 且 id 列表失败 → { 0, false } 且打一条 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { table } = makeTable({ byPage: async () => ({ records: [], hasMore: false }), visibleThrows: true });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await ds.loadPage({ viewId: 'view_A', pageSize: 200 });
    await expect(ds.countSafe()).resolves.toEqual({ total: 0, totalKnown: false });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('getVisibleRecordIds() · 失败打 warn（不再无声无息）', () => {
  it('SDK 抛错 → 返回 []，并 console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { table } = makeTable({ visibleThrows: true });
    const ds = new SdkRecordDataSource(table, 'view_A');
    await expect(ds.getVisibleRecordIds()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('resolveTotalInfo · 三档优先级', () => {
  it('页响应 total 优先（不触碰 countSafe / count）', async () => {
    const source = {
      countSafe: vi.fn(),
      count: vi.fn(),
    } as unknown as RecordDataSource;
    const page: PageResult = { records: [], pageToken: null, hasMore: false, total: 100 };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 100, totalKnown: true });
    expect(source.countSafe).not.toHaveBeenCalled();
    expect(source.count).not.toHaveBeenCalled();
  });

  it('无页 total 但有 countSafe → 采用其结论', async () => {
    const source = {
      countSafe: vi.fn().mockResolvedValue({ total: 7, totalKnown: true }),
      count: vi.fn().mockResolvedValue(999),
    } as unknown as RecordDataSource;
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 7, totalKnown: true });
    expect(source.count).not.toHaveBeenCalled();
  });

  it('桩缺 countSafe → 回退 count()，且 totalKnown=false（无法区分 0 与取不到）', async () => {
    const source = { count: vi.fn().mockResolvedValue(3) } as unknown as RecordDataSource;
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 3, totalKnown: false });
  });

  it('countSafe 抛错 → 平稳回退 count()', async () => {
    const source = {
      countSafe: vi.fn().mockRejectedValue(new Error('boom')),
      count: vi.fn().mockResolvedValue(5),
    } as unknown as RecordDataSource;
    const page: PageResult = { records: [], pageToken: null, hasMore: false };
    await expect(resolveTotalInfo(source, page)).resolves.toEqual({ total: 5, totalKnown: false });
  });
});
