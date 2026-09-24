/**
 * 工程师 · 加载代号（generation）与失败标记：取消 / 刷新与在途批次不得互相污染。
 *
 * 直接驱动真实 `useViewStore.loadMore / refresh`，用可控的 dataSource 精确编排时序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkRecord } from '@/sdk/port';
import type { PageResult, RecordDataSource } from '@/data/RecordDataSource';
import type { EnvSnapshot } from '@/sdk/env';
import { useViewStore } from '@/state/ViewStore';

const ENV: EnvSnapshot = {
  productType: 'web',
  language: 'zh-CN',
  theme: 'light',
  tableId: 'tbl_gen',
  viewId: 'view_gen',
  appId: 'app_gen',
  userId: 'u_gen',
};

function rec(id: string): SdkRecord {
  return { recordId: id, fields: {} } as unknown as SdkRecord;
}

function fakeDataSource(loadPage: (q: unknown) => Promise<PageResult>): RecordDataSource {
  return {
    loadPage: loadPage as RecordDataSource['loadPage'],
    loadRecord: async () => null,
    count: async () => 0,
    countSafe: async () => ({ total: 0, totalKnown: false }),
    getVisibleRecordIds: async () => [],
    clearCache: () => undefined,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setBase(dataSource: RecordDataSource, records: SdkRecord[]): void {
  useViewStore.setState({
    dataSource,
    env: ENV,
    records,
    total: records.length,
    totalKnown: true,
    hasMore: true,
    nextPageToken: 'p2',
    loadingMore: false,
    loadGeneration: 0,
    loadMoreFailed: false,
  });
}

beforeEach(() => {
  setBase(fakeDataSource(async () => ({ records: [], pageToken: null, hasMore: false })), []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadMore', () => {
  it('成功：去重追加 + 用页 total 更新 total/totalKnown', async () => {
    const ds = fakeDataSource(async () => ({ records: [rec('r2')], pageToken: null, hasMore: false, total: 5 }));
    setBase(ds, [rec('r1')]);

    await useViewStore.getState().loadMore();

    const st = useViewStore.getState();
    expect(st.records.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    expect(st.hasMore).toBe(false);
    expect(st.total).toBe(5);
    expect(st.totalKnown).toBe(true);
    expect(st.loadMoreFailed).toBe(false);
  });

  it('失败：loadMoreFailed=true（供升级循环立即中止）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ds = fakeDataSource(async () => {
      throw new Error('network');
    });
    setBase(ds, [rec('r1')]);

    await useViewStore.getState().loadMore();

    const st = useViewStore.getState();
    expect(st.loadMoreFailed).toBe(true);
    expect(st.loadingMore).toBe(false);
    expect(st.records.map((r) => r.recordId)).toEqual(['r1']); // 未追加
    expect(errorSpy).toHaveBeenCalled();
  });

  it('bumpLoadGeneration 使在途批次作废：不追加、不推进游标', async () => {
    const d = deferred<PageResult>();
    const ds = fakeDataSource(() => d.promise);
    setBase(ds, [rec('r1')]);

    const inflight = useViewStore.getState().loadMore();
    useViewStore.getState().bumpLoadGeneration();

    d.resolve({ records: [rec('r2')], pageToken: 'p3', hasMore: true, total: 99 });
    await inflight;

    const st = useViewStore.getState();
    expect(st.records.map((r) => r.recordId)).toEqual(['r1']); // 作废，未追加
    expect(st.hasMore).toBe(true); // 游标未推进
    expect(st.loadingMore).toBe(false);
  });
});

describe('refresh 与在途 loadMore 不互相污染', () => {
  it('refresh 自增代号：在途 loadMore 结果被丢弃，refresh 结果获胜', async () => {
    const d = deferred<PageResult>();
    const loadPage = vi.fn();
    loadPage
      .mockImplementationOnce(() => d.promise) // loadMore 的请求（挂起）
      .mockResolvedValueOnce({ records: [rec('fresh')], pageToken: null, hasMore: false, total: 1 }); // refresh 的请求
    const ds = fakeDataSource(loadPage as unknown as (q: unknown) => Promise<PageResult>);
    setBase(ds, [rec('r1')]);

    const inflight = useViewStore.getState().loadMore();
    await useViewStore.getState().refresh(); // 自增代号 → 使上面在途批次作废

    d.resolve({ records: [rec('stale')], pageToken: 'p9', hasMore: true, total: 99 });
    await inflight;

    const st = useViewStore.getState();
    expect(st.records.map((r) => r.recordId)).toEqual(['fresh']);
    expect(st.total).toBe(1);
    expect(st.hasMore).toBe(false);
  });

  it('refresh 用首页 total 设置 total/totalKnown', async () => {
    const ds = fakeDataSource(async () => ({ records: [rec('a'), rec('b')], pageToken: null, hasMore: false, total: 2 }));
    setBase(ds, []);

    await useViewStore.getState().refresh();

    const st = useViewStore.getState();
    expect(st.records.map((r) => r.recordId)).toEqual(['a', 'b']);
    expect(st.total).toBe(2);
    expect(st.totalKnown).toBe(true);
  });
});
