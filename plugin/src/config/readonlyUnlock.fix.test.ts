/**
 * 回归测试（工程师）——P2-2 健壮性补强（架构裁定 §0.2 · Q6）：
 * 同一会话内，更高版本客户端把配置「降版」后，本端 `subscribe` 收到新载荷即
 * 自动刷新 `readOnlyViews` → 只读解除 → 随后 `save()` 可成功。
 *
 * 覆盖两实现：`BridgeConfigRepository`（onDataChange）与 `LocalStorageConfigRepository`（storage 事件）。
 */
import { describe, expect, it } from 'vitest';
import { configKey, degradedConfigKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import type { BridgeDataChangePayload, BridgeStore } from './BridgeConfigRepository';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import { createDefaultConfig } from './defaults';
import { LocalStorageConfigRepository, type StorageLike } from './LocalStorageConfigRepository';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig } from './types';

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

/** 合法 envelope，`schemaVersion` 可控（用于伪造「更高版本」与「降版后」两种载荷） */
function envelopeRaw(viewId: string, schemaVersion: number): string {
  const payload = makeConfig(viewId);
  return JSON.stringify({
    schemaVersion,
    pluginVersion: schemaVersion > CURRENT_SCHEMA_VERSION ? '9.9.9' : '0.1.0',
    writtenAt: 1,
    checksum: checksumOf(payload),
    payload,
  });
}

describe('P2-2 · bridge：降版配置到达 → 只读自动解除 → 可保存', () => {
  it('订阅后收到降版载荷 → readOnlyViews 清除 → 随后的 save 成功且回写 bridge', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    // 场景前置：对方（更高版本）写入 → 本端 load 记住只读
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 3));
    const loaded = await repo.load('view_A');
    expect(loaded.unsupportedNewer).toBe(true);
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    // 订阅建立底层 onDataChange 监听（绑定 bridge 介质）
    const received: CardViewConfig[] = [];
    const unsubscribe = repo.subscribe('view_A', (config) => received.push(config));

    // 更高版本客户端把配置降版 → 新载荷到达
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION));

    // 只读标记应被自动清除 → save 不再被拒，且确实回写 bridge
    const saved = await repo.save('view_A', makeConfig('view_A'));
    expect(saved.ok).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1]?.meta.configId).toBe('view_A');

    unsubscribe();
  });

  it('反向：订阅期间收到更高版本载荷 → 只读标记被置上 → save 被拒', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('无关 viewId 的变更不影响本 viewId 的只读标记', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 2));
    await repo.load('view_A'); // A 只读

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    await store.setData(configKey('view_B'), envelopeRaw('view_B', CURRENT_SCHEMA_VERSION));

    // A 仍只读
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('损坏载荷（非法 JSON）到达 → 版本未知 → 不误解锁，只读标记保持 → save 仍被拒', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));
    await repo.load('view_A'); // A 只读

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    // 损坏载荷：无法解析信封 → 版本不可判定（不得据此解除只读）
    await store.setData(configKey('view_A'), '{ not valid json');

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('损坏载荷（checksum 不匹配）到达 → 不误解锁', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));
    await repo.load('view_A');

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    const tampered = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pluginVersion: '0.1.0',
      writtenAt: 1,
      checksum: 'deadbeef',
      payload: makeConfig('view_A'),
    });
    await store.setData(configKey('view_A'), tampered);

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('空值 → 解锁（load 与 subscribe）：首开可 provision；曾加锁后被清空/他人清空，本端均可重配', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    // 首开：存储为空（空值）→ 未加锁 → 保存直接成功（放行 provision 默认模板）
    expect((await repo.load('view_A')).unsupportedNewer).toBe(false);
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    // 曾加锁（更高版本）→ 存储被清空为「空值」→ load 亦应解锁（D1 靶心：空值 ≠ 损坏）
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    await store.setData(configKey('view_A'), null); // 空值（degraded=false），非损坏
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    // 再次加锁 → 经 subscribe 收到「他人清空」（value=null 空值）→ 解锁
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 2));
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    await store.setData(configKey('view_A'), null);
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    unsubscribe();
  });
});

describe('P2-2 · localStorage：降版配置到达 → 只读自动解除 → 可保存', () => {
  it('storage 事件携带降版载荷 → 只读清除 → save 成功写盘', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    storage.map.set(key, envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 2));
    expect((await repo.load('view_A')).unsupportedNewer).toBe(true);
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    const received: CardViewConfig[] = [];
    const unsubscribe = repo.subscribe('view_A', (config) => received.push(config));

    // 模拟另一标签页/更高版本客户端把配置降版后写入
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', CURRENT_SCHEMA_VERSION) }),
    );

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });
    expect(received.length).toBe(1);

    unsubscribe();
  });

  it('反向：storage 事件携带更高版本载荷 → 只读标记被置上', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1) }),
    );

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('损坏载荷（非法 JSON）到达 → 不误解锁（storage 事件）', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    storage.map.set(key, envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));
    await repo.load('view_A'); // A 只读

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{ not valid json' }));

    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsubscribe();
  });

  it('空值 → 解锁（load 与 storage 事件）：首开可 provision；曾加锁后被清空/他人清空，本端均可重配', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    // 首开：存储为空（空值）→ 未加锁 → 保存直接成功
    expect((await repo.load('view_A')).unsupportedNewer).toBe(false);
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    // 曾加锁（更高版本）→ 存储被清空为「空值」（''）→ load 亦应解锁（D1）
    storage.map.set(key, envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 1));
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    storage.map.set(key, '');
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    // 再次加锁 → 经 storage 事件收到「他人清空」（newValue=null 空值）→ 解锁
    storage.map.set(key, envelopeRaw('view_A', CURRENT_SCHEMA_VERSION + 2));
    await repo.load('view_A');
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    const unsubscribe = repo.subscribe('view_A', () => undefined);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
    await expect(repo.save('view_A', makeConfig('view_A'))).resolves.toMatchObject({ ok: true });

    unsubscribe();
  });
});
