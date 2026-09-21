/**
 * QA2 双盲独立复核（任务 #16）——P2-2：只读标记刷新口径（架构裁定 §0.2 · Q6）。
 *
 * 纪律：**不采信**工程师的 `readonlyUnlock.fix.test.ts`；本文件断言一律独立编写。
 * 复核对象：`refreshReadOnlyFromPayload`（共享助手）+ 两实现的（a）订阅回调与（b）load 路径。
 *
 * 口径（架构裁定 §0.2 **Q7 修订版，2026-09-20**：`load` 与 `subscribe` **统一为 fail-safe**）：
 *  - `unsupportedNewer === true`                     → 加锁
 *  - `degraded === false`（**有效配置 或 空值**）      → 解锁（保 provision / 自愈）
 *  - `degraded === true`（损坏 / 迁移失败）且非升版     → **保持原标记不变**
 *
 * 历史：原 Q7 曾裁定「load 保持解锁、与 subscribe 不同」，经本文件双盲实证存在覆盖高版本配置的
 * 数据丢失路径后，已整体作废并改为上式（见 `03-开发设计文档.md` §0.2 Q7 与 §0.2.1）。
 * §3 钉 `load` 路径的 fail-safe 与「空值仍解锁」边界；修复（#18）落地后本文件应全绿。
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

function cfg(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_1', now: 1_700_000_000_000 });
}

/** 合法 envelope，schemaVersion 可控 */
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

const NEWER = CURRENT_SCHEMA_VERSION + 3; // 更高版本（只读）
const CURRENT = CURRENT_SCHEMA_VERSION; // 当前/降版（可写）
const CORRUPT_JSON = '{ not valid json';
const CORRUPT_CHECKSUM = JSON.stringify({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  pluginVersion: '1.0.0',
  writtenAt: 1,
  checksum: 'deadbeef',
  payload: { tampered: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// 0. 共享助手纯函数语义（Q7 修订版：按 `degraded` 区分「损坏」与「空值」）
// ─────────────────────────────────────────────────────────────────────────────
describe('QA2 · refreshReadOnlyFromPayload 语义（Q7 修订版）', () => {
  it('升版 → 加锁', () => {
    const s = new Set<string>();
    refreshReadOnlyFromPayload(s, 'v', {
      config: null,
      degraded: false,
      unsupportedNewer: true,
      source: 'bridge',
    });
    expect(s.has('v')).toBe(true);
  });

  it('损坏载荷（degraded=true, config=null, 非升版）→ 保持原标记不变（fail-safe）', () => {
    const s = new Set<string>(['v']);
    refreshReadOnlyFromPayload(s, 'v', {
      config: null,
      degraded: true,
      unsupportedNewer: false,
      source: 'bridge',
    });
    expect(s.has('v')).toBe(true); // 绝不因不可信载荷解锁
  });

  it('空值（config=null 但 degraded=false）→ 解锁（保 provision / 清除后重配）', () => {
    const s = new Set<string>(['v']);
    refreshReadOnlyFromPayload(s, 'v', {
      config: null,
      degraded: false,
      unsupportedNewer: false,
      source: 'bridge',
    });
    expect(s.has('v')).toBe(false); // 空值 ≠ 损坏：必须放行写入
  });

  it('有效且非升版（config!==null, degraded=false）→ 解锁', () => {
    const s = new Set<string>(['v']);
    refreshReadOnlyFromPayload(s, 'v', {
      config: cfg('v'),
      degraded: false,
      unsupportedNewer: false,
      source: 'bridge',
    });
    expect(s.has('v')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. bridge：（a）订阅回调路径（onDataChange）
// ─────────────────────────────────────────────────────────────────────────────
describe('QA2 · P2-2 双盲 · bridge onDataChange', () => {
  it('(c) 升版载荷到达 → 加锁 → save 被拒，且重复升版不会被误清', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('view_A', () => undefined);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER));
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    // 再来一条升版载荷 → 锁不应被 else 分支误删
    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER + 1));
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    unsub();
  });

  it('(a) 损坏载荷（非法 JSON）到达 → 不误解锁 → save 仍被拒', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('view_A', () => undefined);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER)); // 先加锁
    await store.setData(configKey('view_A'), CORRUPT_JSON); // 再损坏

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });

  it('(a) 损坏载荷（checksum 不匹配）到达 → 不误解锁', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('view_A', () => undefined);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER));
    await store.setData(configKey('view_A'), CORRUPT_CHECKSUM);

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });

  it('(降版) 更高版本客户端降版 → 解锁 → save 成功', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('view_A', () => undefined);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER)); // 加锁
    await store.setData(configKey('view_A'), envelopeRaw('view_A', CURRENT)); // 降版

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: true });
    unsub();
  });

  it('(4) 无关 viewId 的变更不影响本 viewId 的标记', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe('view_A', () => undefined);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER)); // A 加锁
    await store.setData(configKey('view_B'), envelopeRaw('view_B', CURRENT)); // 无关

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. localStorage：（a）订阅回调路径（storage 事件）
// ─────────────────────────────────────────────────────────────────────────────
describe('QA2 · P2-2 双盲 · localStorage storage 事件', () => {
  it('(c) 升版载荷 → 加锁 → save 被拒', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');
    const unsub = repo.subscribe('view_A', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', NEWER) }));
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });

  it('(a) 损坏载荷（非法 JSON）→ 不误解锁 → save 仍被拒', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');
    const unsub = repo.subscribe('view_A', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', NEWER) }));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: CORRUPT_JSON }));

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });

  it('(a) 损坏载荷（checksum 不匹配）→ 不误解锁', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');
    const unsub = repo.subscribe('view_A', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', NEWER) }));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: CORRUPT_CHECKSUM }));

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });

  it('(降版) 降版载荷 → 解锁 → save 成功', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');
    const unsub = repo.subscribe('view_A', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', NEWER) }));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: envelopeRaw('view_A', CURRENT) }));

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: true });
    unsub();
  });

  it('(4) 无关 viewId 的 storage 事件不影响本 viewId', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const keyA = degradedConfigKey('app', 'view_A');
    const keyB = degradedConfigKey('app', 'view_B');
    const unsub = repo.subscribe('view_A', () => undefined);

    window.dispatchEvent(new StorageEvent('storage', { key: keyA, newValue: envelopeRaw('view_A', NEWER) }));
    window.dispatchEvent(new StorageEvent('storage', { key: keyB, newValue: envelopeRaw('view_B', CURRENT) }));

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
    unsub();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. load 路径：Q7 修订版 —— fail-safe（与 subscribe 统一），且「空值仍解锁」
//
//    架构裁定 §0.2 Q7 修订版：`load` 读到 **degraded:true（损坏 / 迁移失败）** 时，
//    若本端此前因更高版本加锁，**必须保持标记**——否则「存储后续损坏 → load 误解锁
//    → save 成功」会覆盖更高版本客户端配置（不可逆数据丢失，即 D1）。
//    但 **degraded:false（有效 或 空值）** 仍须解锁，以保住首开 provision 与
//    「清除后重配」的自愈路径（空值 ≠ 损坏，二者共用 config:null，靠 degraded 区分）。
//    本组即 D1 修复（任务 #18）的验收断言：修复落地前 2 条 fail-safe 用例为红。
// ─────────────────────────────────────────────────────────────────────────────
describe('QA2 · load 路径只读刷新 = Q7 修订版 fail-safe（+ 空值边界）', () => {
  it('[D1] bridge：已只读后 load() 读到损坏载荷 → 标记必须保持 → save 必须被拒', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER));
    await repo.load('view_A'); // 只读标记置上
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: false }); // 前置：锁生效

    // 介质内容损坏（内容层损坏，非介质故障）→ load 再读
    await store.setData(configKey('view_A'), CORRUPT_JSON);
    const reloaded = await repo.load('view_A');
    expect(reloaded.config).toBeNull();
    expect(reloaded.degraded).toBe(true); // 损坏 → degraded:true

    // Q7 修订版：degraded:true 且非升版 → 保持标记 → save 仍被拒（防覆盖高版本）
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
  });

  it('bridge：已只读后 load() 读到空值 → 解锁（保 provision / 清除后重配）→ save 可成功', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    await store.setData(configKey('view_A'), envelopeRaw('view_A', NEWER));
    await repo.load('view_A');
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: false }); // 前置

    await store.setData(configKey('view_A'), null); // 清空 → 空值
    const reloaded = await repo.load('view_A');
    expect(reloaded.config).toBeNull();
    expect(reloaded.degraded).toBe(false); // 空值 ≠ 损坏

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: true });
  });

  it('[D1] localStorage：已只读后 load() 读到损坏载荷 → 标记必须保持 → save 必须被拒', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    storage.map.set(key, envelopeRaw('view_A', NEWER));
    await repo.load('view_A');
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: false }); // 前置

    storage.map.set(key, CORRUPT_JSON);
    const reloaded = await repo.load('view_A');
    expect(reloaded.config).toBeNull();
    expect(reloaded.degraded).toBe(true);

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });
  });

  it('localStorage：已只读后 load() 读到空值 → 解锁 → save 可成功', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const key = degradedConfigKey('app', 'view_A');

    storage.map.set(key, envelopeRaw('view_A', NEWER));
    await repo.load('view_A');
    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: false }); // 前置

    storage.map.delete(key); // 清空 → 空值
    const reloaded = await repo.load('view_A');
    expect(reloaded.config).toBeNull();
    expect(reloaded.degraded).toBe(false);

    await expect(repo.save('view_A', cfg('view_A'))).resolves.toMatchObject({ ok: true });
  });
});
