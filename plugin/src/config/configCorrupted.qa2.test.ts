/**
 * QA2 补测 ·「配置数据损坏」误报修复（诊断 7 场景 · 仓储/状态层）。
 *
 * 背景：`degraded` 混装了「数据损坏」与「介质读取失败」两种语义，导致 bridge 一次
 * 读取抖动就被 `useCardViewInit` 判成「配置损坏」并弹错误横幅（误报）。
 * 修复引入 `LoadResult.corrupted`：只有**介质读到了数据但内容不可信**才为 true。
 *
 * 本文件只断言**仓储返回的 `corrupted` 契约**（ConfigRepository / Bridge / LocalStorage
 * 三个实现的分支赋值），不涉及 UI；UI 互斥见
 * `src/hooks/useCardViewInit.corrupted.qa2.test.tsx`（走真实 hook + 真实 Banner）。
 *
 * ⚠️ 本文件为**新增**，不修改任何既有测试文件的断言。
 */
import { describe, expect, it } from 'vitest';
import { configKey, degradedConfigKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import type { BridgeStore } from './BridgeConfigRepository';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import { createDefaultConfig } from './defaults';
import { resolveLoadedConfig } from './ConfigRepository';
import { LocalStorageConfigRepository, type StorageLike } from './LocalStorageConfigRepository';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig } from './types';

/** 内存版 localStorage（可注入抛错） */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  /** 注入后 getItem 抛错，模拟隐私模式 / 配额异常 */
  failGet: Error | null = null;
  getItem(key: string): string | null {
    if (this.failGet) throw this.failGet;
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 内存版 bridge（可注入返回任意 raw / 抛错） */
class MemoryBridgeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  failGet: Error | null = null;
  async getData(key: string): Promise<unknown> {
    if (this.failGet) throw this.failGet;
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async setData(key: string, value: unknown): Promise<boolean> {
    this.map.set(key, value);
    return true;
  }
  onDataChange(): () => void {
    return () => undefined;
  }
}

function makeConfig(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_qa2', now: 1_700_000_000_000 });
}

/** 构造合法 envelope 字符串（可指定 schemaVersion 以触发迁移 / 升版） */
function envelopeRaw(config: CardViewConfig, schemaVersion: number = CURRENT_SCHEMA_VERSION): string {
  return JSON.stringify({
    schemaVersion,
    pluginVersion: '1.0.0',
    writtenAt: 1,
    checksum: checksumOf(config),
    payload: config,
  });
}

/** 新建带 fallback 的 bridge 仓储（介质故障场景用） */
function bridgeWithFallback(storage: MemoryStorage): { repo: BridgeConfigRepository; store: MemoryBridgeStore } {
  const store = new MemoryBridgeStore();
  const fallback = new LocalStorageConfigRepository(storage, 'app_qa2');
  return { repo: new BridgeConfigRepository(store, { fallback }), store };
}

describe('场景 1 · 全新视图（bridge 返回 null）→ 不是损坏', () => {
  it('config=null / degraded=false / corrupted=false（corrupted 必须是 false 而非 undefined）', async () => {
    const storage = new MemoryStorage();
    const { repo } = bridgeWithFallback(storage);
    const load = await repo.load('view_new');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(false);
    // 修复核心：空值不等于损坏；断言 toBe(false) 可同时挡住 `undefined`
    expect(load.corrupted).toBe(false);
    expect(load.source).toBe('bridge');
    expect(load.unsupportedNewer).toBe(false);
  });

  it('空串 / null / undefined 同样 corrupted=false', () => {
    for (const raw of ['', null, undefined]) {
      const result = resolveLoadedConfig(raw, { viewId: 'v', source: 'bridge' });
      expect(result.corrupted).toBe(false);
      expect(result.degraded).toBe(false);
      expect(result.config).toBeNull();
    }
  });
});

describe('场景 2 · 介质降级（bridge 读取失败 → fallback 为空）→ 不是损坏', () => {
  it('getData 抛错 + fallback 为空 → corrupted=false 但 degraded=true，reason 属实非空', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    store.failGet = new Error('bridge down');

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    // ⭐ 修复核心断言：介质故障绝不能被判成「数据损坏」
    expect(load.corrupted).toBe(false);
    expect(load.source).toBe('localStorage');
    // reason 必须给出准确文案，不能空（空则 UI 落到与事实不符的兜底）
    expect(load.reason).toBe('配置存储读取失败，已回退到本地保存，其他成员看不到你的排版。');
    expect(load.reason?.trim()).not.toBe('');
  });

  it('无 fallback 可退时同样 corrupted=false，且 reason 不谎称「已本地保存」', async () => {
    const store = new MemoryBridgeStore();
    store.failGet = new Error('bridge down');
    const repo = new BridgeConfigRepository(store); // 不注入 fallback

    const load = await repo.load('view_A');

    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(false);
    expect(load.reason).toContain('无可用本地存储');
    expect(load.reason).not.toContain('已回退到本地保存');
  });
});

describe('场景 3 · bridge 存非法 JSON / checksum 不符 → 真实损坏', () => {
  it('非法 JSON → corrupted=true（degraded=true、config=null）', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    store.map.set(configKey('view_A'), '{ 这不是 JSON');

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(true);
    expect(load.error).toBe('invalid-json');
    // 数据损坏**不**切介质：仍停在 bridge
    expect(load.source).toBe('bridge');
    expect(repo.isDegraded()).toBe(false);
  });

  it('checksum 不符 → corrupted=true', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    const config = makeConfig('view_A');
    store.map.set(configKey('view_A'), envelopeRaw(config).replace(checksumOf(config), 'deadbeef'));

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(true);
    expect(load.error).toBe('checksum-mismatch');
  });
});

describe('场景 4 · migrate 抛错 → 真实损坏', () => {
  it('schemaVersion=0（缺失 v0→v1 迁移函数）→ corrupted=true，error 以 migration-failed 开头', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    const config = makeConfig('view_A');
    // checksum 合法、信封可解析，但迁移链断 → migrate 抛 MigrationError
    store.map.set(configKey('view_A'), envelopeRaw(config, 0));

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(true);
    expect(load.error).toMatch(/^migration-failed: /);
  });
});

describe('场景 5 · 裸数据（无 envelope 三要素）→ 主理人裁定为损坏', () => {
  it('缺 schemaVersion / checksum / payload → corrupted=true，reason=missing-fields', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    // 裁定理由：bridge 里确实有数据却无法识别，静默当「无配置」会让用户排版凭空消失且无解释
    store.map.set(configKey('view_A'), JSON.stringify({ title: '旧版裸数据', card: { templateId: 't1' } }));

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(true);
    expect(load.error).toBe('missing-fields');
  });

  it('bridge 直接返回非 envelope 的**对象**（非字符串）同样 corrupted=true', () => {
    const result = resolveLoadedConfig({ title: '裸对象' }, { viewId: 'v', source: 'bridge' });
    expect(result.degraded).toBe(true);
    expect(result.corrupted).toBe(true);
    expect(result.error).toBe('missing-fields');
  });

  it('裸数组 / 裸标量同样 corrupted=true（不是空值）', () => {
    expect(resolveLoadedConfig([1, 2, 3], { viewId: 'v', source: 'bridge' }).corrupted).toBe(true);
    expect(resolveLoadedConfig('"just-a-string"', { viewId: 'v', source: 'bridge' }).corrupted).toBe(true);
  });
});

describe('场景 6 · localStorage 读取抛错 → 不是损坏', () => {
  it('getItem 抛错 → corrupted=false / degraded=true，reason 说明无法保存', async () => {
    const storage = new MemoryStorage();
    storage.failGet = new Error('localStorage denied');
    const repo = new LocalStorageConfigRepository(storage, 'app_qa2');

    const load = await repo.load('view_A');

    expect(load.config).toBeNull();
    expect(load.degraded).toBe(true);
    // ⭐ 修复核心断言：本地介质故障 ≠ 数据损坏
    expect(load.corrupted).toBe(false);
    expect(load.source).toBe('localStorage');
    expect(load.reason).toContain('本地存储读取失败');
    expect(load.reason?.trim()).not.toBe('');
  });

  it('localStorage 里的**损坏串**仍判 corrupted=true（与上面「介质故障」区分）', async () => {
    const storage = new MemoryStorage();
    storage.map.set(degradedConfigKey('app_qa2', 'view_A'), '{ 坏数据');
    const repo = new LocalStorageConfigRepository(storage, 'app_qa2');

    const load = await repo.load('view_A');

    expect(load.degraded).toBe(true);
    expect(load.corrupted).toBe(true);
  });
});

describe('场景 7 · unsupportedNewer 与 corrupted 互斥，不叠加', () => {
  it('更高版本且合法 → unsupportedNewer=true / corrupted=false / config 可用', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    const config = makeConfig('view_A');
    store.map.set(configKey('view_A'), envelopeRaw(config, CURRENT_SCHEMA_VERSION + 5));

    const load = await repo.load('view_A');

    expect(load.unsupportedNewer).toBe(true);
    expect(load.corrupted).toBe(false);
    expect(load.config).not.toBeNull();
  });

  it('更高版本 + checksum 被篡改 → 只报损坏，不同时报升版（二者互斥）', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    const config = makeConfig('view_A');
    const raw = envelopeRaw(config, CURRENT_SCHEMA_VERSION + 5).replace(checksumOf(config), 'ffffffff');
    store.map.set(configKey('view_A'), raw);

    const load = await repo.load('view_A');

    // 信封不可信 → 版本号不可信 → unsupportedNewer 必须回到 false
    expect(load.unsupportedNewer).toBe(false);
    expect(load.corrupted).toBe(true);
    expect(load.config).toBeNull();
  });

  it('穷举各态：任一 LoadResult 都不会同时 corrupted=true 且 unsupportedNewer=true', async () => {
    const storage = new MemoryStorage();
    const { repo, store } = bridgeWithFallback(storage);
    const config = makeConfig('view_A');
    const cases: unknown[] = [
      null, // 空值
      '{ 坏 JSON', // 非法 JSON
      envelopeRaw(config, 0), // 迁移失败
      JSON.stringify({ title: '裸数据' }), // 缺字段
      envelopeRaw(config, CURRENT_SCHEMA_VERSION + 5), // 升版
      envelopeRaw(config), // 正常
    ];
    for (const raw of cases) {
      store.map.set(configKey('view_A'), raw);
      const load = await repo.load('view_A');
      expect(load.corrupted === true && load.unsupportedNewer === true).toBe(false);
    }
  });
});
