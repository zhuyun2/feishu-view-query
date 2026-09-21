/**
 * QA 独立复核（M1 / T05）：getRecordsByPage 分页/游标/页大小 clamp/缓存命中；空表与异常不崩。
 */
import { describe, expect, it, vi } from 'vitest';
import type { IRecord, ITable } from '@lark-base-open/js-sdk';
import { getRecordFields, getRecordId } from './RecordDataSource';
import { SdkRecordDataSource } from './SdkRecordDataSource';

function rec(id: string, fields: Record<string, unknown> = {}): IRecord {
  return { recordId: id, fields } as unknown as IRecord;
}

interface PageResponse {
  records?: unknown;
  pageToken?: unknown;
  hasMore?: unknown;
}

function dsWith(impl: (params: { viewId: string; pageSize: number; pageToken?: number }) => Promise<PageResponse>) {
  const spy = vi.fn(impl);
  const table = { getRecordsByPage: spy } as unknown as ITable;
  return { ds: new SdkRecordDataSource(table, 'view_A'), spy };
}

describe('QA · data/SdkRecordDataSource 分页与缓存（独立复核）', () => {
  it('pageSize > 200 被 clamp 到 200（官方上限）', async () => {
    const { ds, spy } = dsWith(async () => ({ records: [], pageToken: null }));
    await ds.loadPage({ viewId: 'view_A', pageSize: 9999 });
    expect(spy.mock.calls[0][0]).toMatchObject({ viewId: 'view_A', pageSize: 200 });
  });

  it('pageSize <= 0 被 clamp 到 1', async () => {
    const { ds, spy } = dsWith(async () => ({ records: [], pageToken: null }));
    await ds.loadPage({ viewId: 'view_A', pageSize: 0 });
    expect(spy.mock.calls[0][0]).toMatchObject({ pageSize: 1 });
  });

  it('pageToken 透传：首页 undefined；续页「字符串游标」→ SDK 数字游标', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ records: [], pageToken: 100, hasMore: true })
      .mockResolvedValueOnce({ records: [], pageToken: undefined, hasMore: false });
    const table = { getRecordsByPage: spy } as unknown as ITable;
    const ds = new SdkRecordDataSource(table, 'view_A');

    const p1 = await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(spy.mock.calls[0][0].pageToken).toBeUndefined();
    expect(p1.pageToken).toBe('100');
    expect(p1.hasMore).toBe(true);

    const p2 = await ds.loadPage({ viewId: 'view_A', pageSize: 100, pageToken: '100' });
    expect(spy.mock.calls[1][0].pageToken).toBe(100); // 数字游标
    expect(p2.pageToken).toBeNull();
    expect(p2.hasMore).toBe(false);
  });

  it('末页（hasMore 缺省、pageToken=null）→ hasMore=false，records 正常返回', async () => {
    const { ds } = dsWith(async () => ({ records: [rec('r1')] }));
    const res = await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(res.hasMore).toBe(false);
    expect(res.pageToken).toBeNull();
    expect(res.records).toHaveLength(1);
  });

  it('非数字游标 → 视为首页（pageToken 传 undefined）', async () => {
    const { ds, spy } = dsWith(async () => ({ records: [], pageToken: null }));
    await ds.loadPage({ viewId: 'view_A', pageSize: 100, pageToken: 'abc' });
    expect(spy.mock.calls[0][0].pageToken).toBeUndefined();
  });

  it('缓存命中 → 同页不重复发起请求（mock 计数为 1）', async () => {
    const { ds, spy } = dsWith(async () => ({ records: [], pageToken: null }));
    await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('不同 pageToken 视为不同页；clearCache 后重新请求', async () => {
    const { ds, spy } = dsWith(async () => ({ records: [], pageToken: null }));
    await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    await ds.loadPage({ viewId: 'view_A', pageSize: 100, pageToken: '1' });
    expect(spy).toHaveBeenCalledTimes(2);

    ds.clearCache();
    await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('空表：响应无 records 字段 → 返回空数组，不抛错', async () => {
    const { ds } = dsWith(async () => ({}));
    const res = await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(res.records).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it('空表：records 非数组（异常形态）→ 归一为空数组，不抛错', async () => {
    const { ds } = dsWith(async () => ({ records: 'nope' }));
    const res = await ds.loadPage({ viewId: 'view_A', pageSize: 100 });
    expect(res.records).toEqual([]);
  });

  it('loadPage：SDK 抛错 → 上抛（交由上层 Error 态接管）', async () => {
    const { ds } = dsWith(async () => {
      throw new Error('network');
    });
    await expect(ds.loadPage({ viewId: 'view_A', pageSize: 100 })).rejects.toThrow('network');
  });

  it('loadRecord：空 id → null 且不发请求', async () => {
    const spy = vi.fn();
    const table = { getRecordById: spy } as unknown as ITable;
    const ds = new SdkRecordDataSource(table, 'view_A');
    await expect(ds.loadRecord('')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('QA · data 辅助函数与无字段容错（独立复核）', () => {
  it('getVisibleRecordIds：SDK 抛错 → 返回 []，count() 为 0（不抛未捕获异常）', async () => {
    const table = { getViewById: vi.fn().mockRejectedValue(new Error('no view')) } as unknown as ITable;
    const ds = new SdkRecordDataSource(table, 'view_A');
    await expect(ds.getVisibleRecordIds()).resolves.toEqual([]);
    await expect(ds.count()).resolves.toBe(0);
  });

  it('getVisibleRecordIds：过滤掉非字符串 id', async () => {
    const view = { getVisibleRecordIdList: vi.fn().mockResolvedValue(['a', 1, null, 'b']) };
    const table = { getViewById: vi.fn().mockResolvedValue(view) } as unknown as ITable;
    const ds = new SdkRecordDataSource(table, 'view_A');
    await expect(ds.getVisibleRecordIds()).resolves.toEqual(['a', 'b']);
  });

  it('getRecordFields：null / 无 fields / fields 非对象 → 均返回 {}', () => {
    expect(getRecordFields(null)).toEqual({});
    expect(getRecordFields(undefined)).toEqual({});
    expect(getRecordFields({ recordId: 'r' } as unknown as IRecord)).toEqual({});
    expect(getRecordFields({ recordId: 'r', fields: 123 } as unknown as IRecord)).toEqual({});
    expect(getRecordFields({ recordId: 'r', fields: { a: 1 } } as unknown as IRecord)).toEqual({ a: 1 });
  });

  it('getRecordId：recordId 优先，回退 id，空记录为空串', () => {
    expect(getRecordId({ recordId: 'r1' } as unknown as IRecord)).toBe('r1');
    expect(getRecordId({ id: 'r2' } as unknown as IRecord)).toBe('r2');
    expect(getRecordId(null)).toBe('');
  });
});
