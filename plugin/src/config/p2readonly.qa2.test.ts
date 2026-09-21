/**
 * QA2 独立验证（任务 #13/#15）· P2-2：只读标记刷新 + 介质降级单向闭锁。
 *
 * 断言来源（不来自实现现状）：
 *  - `03-开发设计文档.md` §0.2 · **Q6**（只读判定/解除；subscribe 命中 viewId 时按新载荷刷新）
 *  - **D1（主理人 2026-09-20 新裁定，推翻原 §0.2 Q7）**：`load` 路径与订阅路径**语义一致**——
 *    损坏载荷（`degraded:true` 且非升版）**必须保持只读标记**，绝不解锁后再 `save` 覆盖更高版本配置。
 *    原 Q7「load 保自愈」被裁定为**真实缺陷 D1（数据丢失路径）**，**非**有意设计；修复批次执行中。
 *  - §0.2 · **Q5-B**：只有「介质故障」触发降级，且降级为**单向闭锁、不可回退**。
 *
 * 重点施压（交付总监识别的最高风险点）：
 *  ① 订阅路径收到**降版**载荷 → 自动解除 `readOnlyViews` → `save()` 真的写成功；
 *  ② 订阅路径收到**升版**载荷 → 置为只读，且**不被损坏载荷误清**（fail-safe）；
 *  ③ **介质故障的降级单向闭锁**是否被 P2-2 新逻辑打穿（bridge 监听是否解绑、是否回写 bridge）。
 */
import { describe, expect, it } from 'vitest';
import { configKey, degradedConfigKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import { refreshReadOnlyFromPayload } from './ConfigRepository';
import {
  BridgeConfigRepository,
  type BridgeDataChangePayload,
  type BridgeStore,
} from './BridgeConfigRepository';
import { LocalStorageConfigRepository, type StorageLike } from './LocalStorageConfigRepository';
import { createDefaultConfig } from './defaults';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig } from './types';

/* ============================ 测试替身 ============================ */

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

/**
 * 内存 bridge 替身。`setData` **不**自动广播（由 `emit` 显式控制），
 * 便于精确区分「本端写入」与「外部写入」两条路径。
 */
class MemoryBridgeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  private readonly listeners = new Set<(payload: BridgeDataChangePayload) => void>();

  getDataCalls = 0;
  setDataCalls = 0;
  failGet: Error | null = null;
  failSet = false;

  async getData(key: string): Promise<unknown> {
    this.getDataCalls += 1;
    if (this.failGet) throw this.failGet;
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setData(key: string, value: unknown): Promise<boolean> {
    this.setDataCalls += 1;
    if (this.failSet) return false;
    this.map.set(key, value);
    return true;
  }

  onDataChange(listener: (payload: BridgeDataChangePayload) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** 模拟「外部写入」触发的变更广播 */
  emit(key: string, value: unknown): void {
    for (const listener of [...this.listeners]) listener({ key, value });
  }
}

/* ============================ 工具 ============================ */

function cfg(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_1', now: 1_700_000_000_000 });
}

function envelopeRaw(viewId: string, schemaVersion: number): string {
  const payload = cfg(viewId);
  return JSON.stringify({
    schemaVersion,
    pluginVersion: '1.0.0',
    writtenAt: 1,
    checksum: checksumOf(payload),
    payload,
  });
}

const NEWER = CURRENT_SCHEMA_VERSION + 2;
const CURRENT = CURRENT_SCHEMA_VERSION;
const CORRUPT_JSON = '{ not valid json';
const CORRUPT_CHECKSUM = JSON.stringify({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  pluginVersion: '1.0.0',
  writtenAt: 1,
  checksum: 'deadbeef',
  payload: { tampered: true },
});

async function isReadOnly(repo: { save: (v: string, c: CardViewConfig) => Promise<{ ok: boolean; reason?: string }> }, viewId: string): Promise<boolean> {
  const result = await repo.save(viewId, cfg(viewId));
  return result.ok === false && result.reason === 'unsupported-newer-readonly';
}

/* ============================ 0. 共享助手纯函数（Q6 口径） ============================ */

describe('QA2 · refreshReadOnlyFromPayload 语义（§0.2 Q6）', () => {
  it('升版（unsupportedNewer）→ 加锁', () => {
    const set = new Set<string>();
    refreshReadOnlyFromPayload(set, 'v', {
      config: null,
      degraded: false,
      unsupportedNewer: true,
      source: 'bridge',
    });
    expect(set.has('v')).toBe(true);
  });

  it('可解析且非升版（config!==null）→ 解锁', () => {
    const set = new Set<string>(['v']);
    refreshReadOnlyFromPayload(set, 'v', {
      config: cfg('v'),
      degraded: false,
      unsupportedNewer: false,
      source: 'bridge',
    });
    expect(set.has('v')).toBe(false);
  });

  it('不可信载荷（config=null 且非升版）→ 保持原标记（fail-safe，绝不解锁）', () => {
    const set = new Set<string>(['v']);
    refreshReadOnlyFromPayload(set, 'v', {
      config: null,
      degraded: true,
      unsupportedNewer: false,
      source: 'bridge',
    });
    expect(set.has('v')).toBe(true);
  });

  it('【D1】空值（config=null 且 degraded=false）→ 解锁（首开 provision / 配置被清空）', () => {
    const set = new Set<string>(['v']);
    refreshReadOnlyFromPayload(set, 'v', {
      config: null,
      degraded: false,
      unsupportedNewer: false,
      source: 'bridge',
    });
    // D1 新口径：degraded=false（有效**或空值**）→ 解锁；仅 degraded=true（损坏/迁移失败）才保持标记
    expect(set.has('v')).toBe(false);
  });
});

/* ============================ 1. bridge 订阅路径（onDataChange） ============================ */

describe('QA2 · P2-2 · bridge onDataChange 订阅路径', () => {
  it('升版载荷 → 只读 → save 被拒（不落盘）', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('vA', () => undefined);

    store.emit(configKey('vA'), envelopeRaw('vA', NEWER));
    const before = store.setDataCalls;
    await expect(repo.save('vA', cfg('vA'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    expect(store.setDataCalls).toBe(before); // 只读时不写介质

    unsub();
  });

  it('【反向验证·升版不被误清】升版 → 再收到损坏载荷 → 仍只读', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('vA', () => undefined);

    store.emit(configKey('vA'), envelopeRaw('vA', NEWER));
    store.emit(configKey('vA'), CORRUPT_JSON); // 非法 JSON（损坏 → degraded:true）
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    store.emit(configKey('vA'), CORRUPT_CHECKSUM); // 校验和不匹配（损坏 → degraded:true）
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    unsub();
  });

  it('【D1】空值载荷（degraded=false）→ 解锁（他人清空配置 / 首开 provision）', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('vA', () => undefined);

    store.emit(configKey('vA'), envelopeRaw('vA', NEWER)); // 先加锁
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    // D1：空值 degraded=false → 解锁（与「损坏 degraded=true → 保持」是不同分支）
    store.emit(configKey('vA'), null);
    expect(await isReadOnly(repo, 'vA')).toBe(false);

    unsub();
  });

  it('【降版解锁·主路径】升版 → 降版载荷 → save 真的写成功并回写', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('vA', () => undefined);

    store.emit(configKey('vA'), envelopeRaw('vA', NEWER));
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    store.emit(configKey('vA'), envelopeRaw('vA', CURRENT)); // 高版本客户端降版
    expect(await isReadOnly(repo, 'vA')).toBe(false);

    const result = await repo.save('vA', cfg('vA'));
    expect(result.ok).toBe(true);
    // 确认真的回写到了 bridge 介质
    expect(store.setDataCalls).toBeGreaterThan(0);
    unsub();
  });

  it('无关 viewId 的载荷不影响本 viewId 只读标记', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('vA', () => undefined);

    store.emit(configKey('vA'), envelopeRaw('vA', NEWER));
    store.emit(configKey('vB'), envelopeRaw('vB', CURRENT)); // 无关
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    unsub();
  });

  it('仅订阅目标 viewId 时才处理载荷（其他 key 不触发回调）', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const seen: string[] = [];
    const unsub = repo.subscribe('vA', (c) => seen.push(c.meta.configId));

    store.emit(configKey('vB'), envelopeRaw('vB', CURRENT));
    expect(seen).toEqual([]);

    store.emit(configKey('vA'), envelopeRaw('vA', CURRENT));
    expect(seen).toEqual(['vA']);

    unsub();
  });
});

/* ============================ 2. localStorage 订阅路径（storage 事件） ============================ */

describe('QA2 · P2-2 · localStorage storage 事件路径', () => {
  it('升版 → 只读；降版 → 解锁并可写', () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'vA');
    const unsub = repo.subscribe('vA', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('vA', NEWER) }));
    return isReadOnly(repo, 'vA')
      .then((locked) => {
        expect(locked).toBe(true);
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('vA', CURRENT) }));
        return repo.save('vA', cfg('vA'));
      })
      .then((result) => {
        expect(result.ok).toBe(true);
        unsub();
      });
  });

  it('损坏载荷 → 不解锁（fail-safe）', () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'vA');
    const unsub = repo.subscribe('vA', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('vA', NEWER) }));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: CORRUPT_JSON }));
    return isReadOnly(repo, 'vA').then((locked) => {
      expect(locked).toBe(true);
      unsub();
    });
  });
});

/* ============================ 3. 介质故障单向闭锁（Q5-B）不被 P2-2 打穿 ============================ */

describe('QA2 · P2-2 × Q5-B · 介质降级单向闭锁完整性', () => {
  it('bridge 读取抛错 → latch 降级：isDegraded=true、bridge 监听解绑、订阅切到 fallback', async () => {
    const store = new MemoryBridgeStore();
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });

    const seen: string[] = [];
    const unsub = repo.subscribe('vA', (c) => seen.push(c.meta.configId));
    expect(store.listenerCount).toBe(1); // 未降级前监听 bridge

    store.failGet = new Error('bridge getData 介质故障');
    const load = await repo.load('vA');

    expect(repo.isDegraded()).toBe(true);
    expect(load.degraded).toBe(true);
    expect(store.listenerCount).toBe(0); // ⭐ 关键：bridge 监听被解绑，降级后 bridge 载荷无法再解锁只读

    // 降级后 bridge 广播（含升/降版）都不应再影响本端（监听已解绑）
    store.emit(configKey('vA'), envelopeRaw('vA', CURRENT));
    expect(seen).toEqual([]);

    unsub();
  });

  it('降级后 save 一律走 fallback，**绝不回写 bridge**（保护更高版本数据）', async () => {
    const store = new MemoryBridgeStore();
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });

    // 先在 bridge 上把 vA 置为只读（更高版本）
    const unsub = repo.subscribe('vA', () => undefined);
    store.emit(configKey('vA'), envelopeRaw('vA', NEWER));
    expect(await isReadOnly(repo, 'vA')).toBe(true);
    const setCallsBefore = store.setDataCalls;

    // 介质故障 → 闭锁降级
    store.failGet = new Error('bridge getData 介质故障');
    await repo.load('vA');
    expect(repo.isDegraded()).toBe(true);

    // 降级期间即便收到「降版」载荷（经 bridge 广播），也不应把写入打回 bridge
    store.emit(configKey('vA'), envelopeRaw('vA', CURRENT));
    const result = await repo.save('vA', cfg('vA'));

    expect(result.ok).toBe(true); // 写到了 localStorage fallback
    expect(store.setDataCalls).toBe(setCallsBefore); // ⭐ bridge 未被写入
    expect(storage.map.has(degradedConfigKey('app', 'vA'))).toBe(true);
    unsub();
  });

  it('降级单向闭锁：即便后续 bridge 恢复正常，也不回退到 bridge（不可回退）', async () => {
    const store = new MemoryBridgeStore();
    const storage = new MemoryStorage();
    const repo = new BridgeConfigRepository(store, {
      fallback: new LocalStorageConfigRepository(storage, 'app'),
    });

    store.failGet = new Error('boom');
    await repo.load('vA');
    expect(repo.isDegraded()).toBe(true);

    store.failGet = null; // 介质“恢复”
    const setCallsBefore = store.setDataCalls;
    const result = await repo.save('vA', cfg('vA'));

    expect(result.ok).toBe(true);
    expect(store.setDataCalls).toBe(setCallsBefore); // 仍不回写 bridge
    expect(repo.isDegraded()).toBe(true);
  });
});

/* ============================ 4. load 路径（D1：与订阅路径语义一致，损坏保持标记） ============================ */

describe('QA2 · load 路径（D1 新裁定：损坏载荷保持只读标记，与订阅路径一致）', () => {
  it('bridge：load 读到升版 → 只读', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    store.map.set(configKey('vA'), envelopeRaw('vA', NEWER));
    await repo.load('vA');
    expect(await isReadOnly(repo, 'vA')).toBe(true);
  });

  it('bridge：load 读到降版 → 解锁可写', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    store.map.set(configKey('vA'), envelopeRaw('vA', NEWER));
    await repo.load('vA');
    store.map.set(configKey('vA'), envelopeRaw('vA', CURRENT));
    await repo.load('vA');
    await expect(repo.save('vA', cfg('vA'))).resolves.toMatchObject({ ok: true });
  });

  it('【D1】bridge：已只读 → 存储损坏 → load 不得误解锁 → save 仍被拒', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    store.map.set(configKey('vA'), envelopeRaw('vA', NEWER));
    await repo.load('vA');
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    store.map.set(configKey('vA'), CORRUPT_JSON);
    const reloaded = await repo.load('vA');
    expect(reloaded.config).toBeNull();
    expect(reloaded.degraded).toBe(true);

    // D1：损坏载荷版本不可判定 → 只读标记必须保持 → save 被拒（防覆盖更高版本配置，杜绝数据丢失）
    await expect(repo.save('vA', cfg('vA'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
  });

  it('【D1】localStorage：已只读 → 存储损坏 → load 不得误解锁 → save 仍被拒', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'vA');
    storage.map.set(key, envelopeRaw('vA', NEWER));
    await repo.load('vA');
    expect(await isReadOnly(repo, 'vA')).toBe(true);

    storage.map.set(key, CORRUPT_JSON);
    const reloaded = await repo.load('vA');
    expect(reloaded.config).toBeNull();
    await expect(repo.save('vA', cfg('vA'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
  });

  it('load 空值 → 无配置且不误置只读（首开 provision 依赖此路径）', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const result = await repo.load('vA');
    expect(result.config).toBeNull();
    expect(result.unsupportedNewer).toBe(false);
    await expect(repo.save('vA', cfg('vA'))).resolves.toMatchObject({ ok: true });
  });
});
