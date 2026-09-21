/**
 * 回归测试（工程师）——F2（运行期介质降级）+ F5（更高版本只读禁止保存）+ Q4（分隔线 borderStyle）。
 */
import { describe, expect, it } from 'vitest';
import { configKey, degradedConfigKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import type { BridgeDataChangePayload, BridgeStore } from './BridgeConfigRepository';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import { createDefaultConfig, defaultDocTemplate } from './defaults';
import { LocalStorageConfigRepository, type StorageLike } from './LocalStorageConfigRepository';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig, type DividerBlock } from './types';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class MemoryBridgeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  private listeners: Array<(payload: BridgeDataChangePayload) => void> = [];
  async getData(key: string): Promise<unknown> {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async setData(key: string, value: unknown): Promise<boolean> {
    this.map.set(key, value);
    for (const listener of [...this.listeners]) listener({ key, value });
    return true;
  }
  onDataChange(listener: (payload: BridgeDataChangePayload) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }
}

function makeConfig(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_1', now: 1_700_000_000_000 });
}

/** 构造一份「更高版本」的合法 envelope（校验通过、仅版本号更高） */
function newerVersionRaw(viewId: string): string {
  const payload = makeConfig(viewId);
  return JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION + 5,
    pluginVersion: '9.9.9',
    writtenAt: 1,
    checksum: checksumOf(payload),
    payload,
  });
}

describe('F2 回归 · 运行期 bridge 失败 → 单向降级到 localStorage', () => {
  it('getData 抛错 → 切换 fallback：source=localStorage / degraded=true / isDegraded()=true；save 不回写 bridge', async () => {
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app_test');
    let bridgeWrites = 0;
    const store: BridgeStore = {
      getData: async () => {
        throw new Error('bridge down');
      },
      setData: async () => {
        bridgeWrites += 1;
        return true;
      },
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store, { fallback });

    expect(repo.isDegraded()).toBe(false);
    const loaded = await repo.load('view_A');
    expect(repo.isDegraded()).toBe(true);
    expect(loaded.source).toBe('localStorage');
    expect(loaded.degraded).toBe(true);

    const saved = await repo.save('view_A', makeConfig('view_A'));
    expect(saved.ok).toBe(true);
    expect(bridgeWrites).toBe(0); // 降级后绝不回写 bridge
    expect(storage.map.size).toBeGreaterThan(0); // 落到 localStorage

    const reread = await repo.load('view_A');
    expect(reread.source).toBe('localStorage');
    expect(reread.config?.meta.configId).toBe('view_A');
  });

  it('setData 返回 false → 降级并把写入转交 fallback', async () => {
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app_test');
    const store: BridgeStore = {
      getData: async () => null,
      setData: async () => false,
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store, { fallback });

    const result = await repo.save('view_A', makeConfig('view_A'));
    expect(repo.isDegraded()).toBe(true);
    expect(result.ok).toBe(true);
    expect(storage.map.has(degradedConfigKey('app_test', 'view_A'))).toBe(true);
  });

  it('数据损坏（非法 JSON）不触发介质切换：仍 source=bridge，isDegraded()=false', async () => {
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app_test');
    const store = new MemoryBridgeStore();
    await store.setData(configKey('view_A'), '{broken');

    const repo = new BridgeConfigRepository(store, { fallback });
    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('bridge');
    expect(loaded.degraded).toBe(true); // 损坏回退
    expect(repo.isDegraded()).toBe(false); // 非介质降级
  });

  it('未注入 fallback 时保持原有行为（不抛错，source=bridge）', async () => {
    const store: BridgeStore = {
      getData: async () => {
        throw new Error('bridge down');
      },
      setData: async () => true,
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('bridge');
    expect(loaded.degraded).toBe(true);
    expect(loaded.error).toContain('bridge down');
  });
});

describe('F5 回归 · 更高版本配置 → 仓储层禁止保存', () => {
  it('localStorage：读到更高版本后 save 被拒（reason=unsupported-newer-readonly），且不落盘', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    storage.map.set(degradedConfigKey('app', 'view_A'), newerVersionRaw('view_A'));

    const loaded = await repo.load('view_A');
    expect(loaded.unsupportedNewer).toBe(true);

    const snapshot = JSON.stringify([...storage.map.entries()]);
    const result = await repo.save('view_A', makeConfig('view_A'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported-newer-readonly');
    expect(typeof result.error).toBe('string');
    expect(result.error?.length).toBeGreaterThan(0);
    expect(JSON.stringify([...storage.map.entries()])).toBe(snapshot); // 未写盘
  });

  it('bridge：读到更高版本后 save 被拒，且不写底层 store', async () => {
    const store = new MemoryBridgeStore();
    await store.setData(configKey('view_A'), newerVersionRaw('view_A'));
    const repo = new BridgeConfigRepository(store);

    const loaded = await repo.load('view_A');
    expect(loaded.unsupportedNewer).toBe(true);

    const sizeBefore = store.map.size;
    const result = await repo.save('view_A', makeConfig('view_A'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported-newer-readonly');
    expect(store.map.size).toBe(sizeBefore);
  });

  it('非只读（正常版本）仍可正常保存', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const saved = await repo.save('view_A', makeConfig('view_A'));
    expect(saved).toEqual({ ok: true });
  });
});

describe('Q4 回归 · 分隔线线型字段名为 borderStyle', () => {
  it('默认文档模板的分隔线使用 borderStyle，且不含 style', () => {
    const template = defaultDocTemplate([]);
    const divider = template.blocks.find((block) => block.kind === 'divider') as DividerBlock;
    expect(divider).toBeDefined();
    expect(divider.borderStyle).toBe('solid');
    expect(divider.thickness).toBe(1);
    expect(divider).not.toHaveProperty('style');
  });
});
