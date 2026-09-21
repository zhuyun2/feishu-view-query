/**
 * QA 独立复核（M1 / T04，本项目头号风险配置层）：
 * 64KB 边界、viewId 隔离、bridge 抛错行为、损坏回退与「原值备份」、只读标记。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONFIG_SIZE_LIMIT_BYTES,
  CONFIG_SIZE_WARN_BYTES,
  backupKey,
  configKey,
  degradedConfigKey,
} from '@/constants';
import { checksumOf } from '@/utils/hash';
import { createDefaultConfig } from './defaults';
import { resolveLoadedConfig, serializeConfig } from './ConfigRepository';
import { LocalStorageConfigRepository, type StorageLike } from './LocalStorageConfigRepository';
import {
  BridgeConfigRepository,
  type BridgeDataChangePayload,
  type BridgeStore,
} from './BridgeConfigRepository';
import { CURRENT_SCHEMA_VERSION } from './types';
import type { CardViewConfig, HighlightRule } from './types';

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

const FIXED_NOW = 1_700_000_000_000;

function baseConfig(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_1', now: FIXED_NOW });
}

// 冻结一份基准配置（固定 id / 时间戳），保证体积测量可复现：
// createDefaultConfig 会生成随机长度 id，故不能每次新建后再比较字节数。
const FROZEN_BASE: CardViewConfig = createDefaultConfig({
  viewId: 'view_v',
  tableId: 'tbl_1',
  now: FIXED_NOW,
});

/** 用一条 name 长度可控的高亮规则把配置体积精确调到目标字节数 */
function fillerRule(len: number): HighlightRule {
  return {
    ruleId: 'rule_fill',
    name: 'x'.repeat(len),
    enabled: true,
    target: { kind: 'cardBorder' },
    condition: { logic: 'and', items: [] },
    style: {},
    priority: 0,
  };
}

function withFiller(len: number): CardViewConfig {
  return { ...FROZEN_BASE, highlightRules: [fillerRule(len)] };
}

/** 固定 writtenAt 的字节测量（纯 ASCII 填充，字节数与填充长度 1:1 线性） */
function measure(len: number): number {
  return serializeConfig(withFiller(len), FIXED_NOW).bytes;
}

const BASE_BYTES = measure(0);
const LEN_EXACT = CONFIG_SIZE_LIMIT_BYTES - BASE_BYTES; // 恰好 64KB
const LEN_OVER = LEN_EXACT + 1; // 64KB + 1
const LEN_WARN = CONFIG_SIZE_WARN_BYTES + 1024 - BASE_BYTES; // 超过 80% 告警线

describe('QA · 配置体积 64KB 边界（D9，独立复核）', () => {
  it('体积标定自检：name 长度与字节数 1:1 线性', () => {
    expect(measure(LEN_EXACT)).toBe(CONFIG_SIZE_LIMIT_BYTES);
    expect(measure(LEN_OVER)).toBe(CONFIG_SIZE_LIMIT_BYTES + 1);
  });

  it('恰好 64KB（= 上限）→ ok=true / tooLarge=false，且可成功落盘并读回', async () => {
    const serialized = serializeConfig(withFiller(LEN_EXACT), FIXED_NOW);
    expect(serialized.bytes).toBe(CONFIG_SIZE_LIMIT_BYTES);
    expect(serialized.ok).toBe(true);
    expect(serialized.tooLarge).toBe(false);

    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    await expect(repo.save('view_v', withFiller(LEN_EXACT))).resolves.toEqual({ ok: true });
    expect(storage.map.has(degradedConfigKey('app', 'view_v'))).toBe(true);
    const loaded = await repo.load('view_v');
    expect(loaded.config?.meta.configId).toBe('view_v');
  });

  it('64KB + 1 → 被拦截（ok=false / tooLarge=true），提示可展示且不落盘', async () => {
    const serialized = serializeConfig(withFiller(LEN_OVER), FIXED_NOW);
    expect(serialized.bytes).toBe(CONFIG_SIZE_LIMIT_BYTES + 1);
    expect(serialized.ok).toBe(false);
    expect(serialized.tooLarge).toBe(true);

    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const result = await repo.save('view_v', withFiller(LEN_OVER));
    expect(result.ok).toBe(false);
    expect(result.tooLarge).toBe(true);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('64KB');
    expect(storage.map.size).toBe(0);
  });

  it('bridge 实现同样在 >64KB 时拦截，且不写入底层 store', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const result = await repo.save('view_v', withFiller(LEN_OVER));
    expect(result.ok).toBe(false);
    expect(result.tooLarge).toBe(true);
    expect(store.map.size).toBe(0);
  });

  it('接近上限（>80%）→ warn=true 但仍可保存', () => {
    const serialized = serializeConfig(withFiller(LEN_WARN), FIXED_NOW);
    expect(serialized.warn).toBe(true);
    expect(serialized.ok).toBe(true);
    expect(serialized.tooLarge).toBe(false);
  });
});

describe('QA · viewId 命名空间隔离（独立复核）', () => {
  it('localStorage 实现：写 A 不影响 B；删 A 不影响 B', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const a = baseConfig('view_A');
    const b = baseConfig('view_B');
    b.theme.primaryColor = '#000000';

    await repo.save('view_A', a);
    await repo.save('view_B', b);
    expect((await repo.load('view_A')).config?.theme.primaryColor).toBe('#3370FF');
    expect((await repo.load('view_B')).config?.theme.primaryColor).toBe('#000000');

    await repo.remove('view_A');
    expect((await repo.load('view_A')).config).toBeNull();
    expect((await repo.load('view_B')).config?.meta.configId).toBe('view_B');
  });

  it('bridge 实现：两个视图 key 不同、互不覆盖', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const a = baseConfig('view_A');
    const b = baseConfig('view_B');
    b.density.cardMinWidth = 400;

    await repo.save('view_A', a);
    await repo.save('view_B', b);
    expect(store.map.has(configKey('view_A'))).toBe(true);
    expect(store.map.has(configKey('view_B'))).toBe(true);
    expect((await repo.load('view_A')).config?.density.cardMinWidth).toBe(280);
    expect((await repo.load('view_B')).config?.density.cardMinWidth).toBe(400);
  });
});

describe('QA · 介质降级与 bridge 异常行为（独立复核）', () => {
  it('[实证] bridge.getData 抛错 → degraded=true / source=bridge / config=null（未切换到 localStorage）', async () => {
    const store: BridgeStore = {
      getData: vi.fn().mockRejectedValue(new Error('bridge down')),
      setData: vi.fn().mockResolvedValue(true),
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load('view_A');
    expect(loaded.degraded).toBe(true);
    expect(loaded.config).toBeNull();
    expect(loaded.source).toBe('bridge');
    expect(loaded.error).toContain('bridge down');
  });

  it('bridge.setData 抛错 → save 返回 ok=false 且带错误', async () => {
    const store: BridgeStore = {
      getData: vi.fn().mockResolvedValue(null),
      setData: vi.fn().mockRejectedValue(new Error('write denied')),
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const result = await repo.save('view_A', baseConfig('view_A'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('write denied');
  });

  it('bridge.setData 返回 false → save 返回 ok=false', async () => {
    const store: BridgeStore = {
      getData: vi.fn().mockResolvedValue(null),
      setData: vi.fn().mockResolvedValue(false),
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    await expect(repo.save('view_A', baseConfig('view_A'))).resolves.toMatchObject({ ok: false });
  });
});

describe('QA · F2 介质降级口径：介质故障切换 / 数据损坏不切换（独立复核）', () => {
  it('[回归·F2] 介质故障（getData 抛错）+ 注入 fallback → 单向切换到 localStorage，之后 save 不回写 bridge', async () => {
    const setData = vi.fn().mockResolvedValue(true);
    const store: BridgeStore = {
      getData: vi.fn().mockRejectedValue(new Error('bridge down')),
      setData,
      onDataChange: () => () => undefined,
    };
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });

    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('localStorage'); // 已切介质
    expect(loaded.degraded).toBe(true);
    expect(repo.isDegraded()).toBe(true); // 闭锁成立

    // 降级后 save 一律走 fallback，绝不回写 bridge
    await repo.save('view_A', baseConfig('view_A'));
    expect(setData).not.toHaveBeenCalled(); // 未回写 bridge
    expect(storage.map.has(degradedConfigKey('app', 'view_A'))).toBe(true);
    expect((await repo.load('view_A')).source).toBe('localStorage'); // 单向闭锁：不因 bridge 恢复而回切
  });

  it('[回归·F2] 介质故障（setData 返回 false）+ 注入 fallback → 降级并转写 fallback', async () => {
    const store: BridgeStore = {
      getData: vi.fn().mockResolvedValue(null),
      setData: vi.fn().mockResolvedValue(false),
      onDataChange: () => () => undefined,
    };
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });

    await expect(repo.save('view_A', baseConfig('view_A'))).resolves.toEqual({ ok: true });
    expect(repo.isDegraded()).toBe(true);
    expect(storage.map.has(degradedConfigKey('app', 'view_A'))).toBe(true); // 已落 fallback
  });

  it('[回归·F2 口径] 数据损坏（checksum 不匹配）→ 不切换介质（source=bridge / isDegraded=false）', async () => {
    const store = new MemoryBridgeStore();
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });

    const raw = serializeConfig(baseConfig('view_A')).raw;
    const tampered = JSON.parse(raw) as { payload: CardViewConfig };
    tampered.payload.meta.updatedBy = 'intruder';
    await store.setData(configKey('view_A'), JSON.stringify(tampered));

    const loaded = await repo.load('view_A');
    expect(loaded.config).toBeNull();
    expect(loaded.degraded).toBe(true); // 数据问题 → 结果为降级（回退默认 + 备份）
    expect(loaded.source).toBe('bridge'); // 介质仍为 bridge
    expect(repo.isDegraded()).toBe(false); // 未发生介质切换

    // 关键反证：介质未切换 → 后续 save 仍走 bridge，不落 localStorage
    await repo.save('view_A', baseConfig('view_A'));
    expect(store.map.has(configKey('view_A'))).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it('[回归·F2 口径] 数据损坏（非法 JSON）→ 同样不切换介质', async () => {
    const store = new MemoryBridgeStore();
    const storage = new MemoryStorage();
    const fallback = new LocalStorageConfigRepository(storage, 'app');
    const repo = new BridgeConfigRepository(store, { fallback });
    await store.setData(configKey('view_A'), 'not-json-at-all');

    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('bridge');
    expect(loaded.degraded).toBe(true);
    expect(repo.isDegraded()).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('QA · F5 更高版本只读拒保存（独立复核）', () => {
  function newerRaw(viewId: string): string {
    const payload = baseConfig(viewId);
    return JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      pluginVersion: '9.9.9',
      writtenAt: 1,
      checksum: checksumOf(payload),
      payload,
    });
  }

  it('bridge：读到更高版本后 save 被拒（reason=unsupported-newer-readonly）且不覆盖原数据', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    await store.setData(configKey('view_A'), newerRaw('view_A'));

    const loaded = await repo.load('view_A');
    expect(loaded.unsupportedNewer).toBe(true);
    expect(loaded.config).not.toBeNull(); // 仅只读，数据仍可读

    const before = store.map.get(configKey('view_A'));
    const result = await repo.save('view_A', baseConfig('view_A'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported-newer-readonly');
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('只读');
    expect(store.map.get(configKey('view_A'))).toBe(before); // 未被降级覆盖
  });

  it('bridge：remove 清除只读标记后，正常配置可再次保存', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    await store.setData(configKey('view_A'), newerRaw('view_A'));
    await repo.load('view_A'); // 记住只读
    await repo.remove('view_A'); // 清标记

    await expect(repo.save('view_A', baseConfig('view_A'))).resolves.toMatchObject({ ok: true });
  });

  it('localStorage：读到更高版本后 save 被拒，remove 后可再保存', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    storage.map.set(degradedConfigKey('app', 'view_A'), newerRaw('view_A'));

    expect((await repo.load('view_A')).unsupportedNewer).toBe(true);
    await expect(repo.save('view_A', baseConfig('view_A'))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-newer-readonly',
    });

    await repo.remove('view_A');
    await expect(repo.save('view_A', baseConfig('view_A'))).resolves.toMatchObject({ ok: true });
  });
});

describe('QA · 损坏回退与「原值备份」（独立复核）', () => {
  it('localStorage：非法 JSON → config=null/degraded=true，备份内容 === 原始损坏串', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const corrupt = '{definitely-not-json';
    storage.map.set(degradedConfigKey('app', 'view_v'), corrupt);

    const loaded = await repo.load('view_v');
    expect(loaded.degraded).toBe(true);
    expect(loaded.config).toBeNull();
    expect(loaded.error).toBe('invalid-json');

    const backups = [...storage.map.entries()].filter(([key]) => key.includes(':backup:'));
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0][1]).toBe(corrupt); // 原值逐字保留
  });

  it('localStorage：checksum 不匹配（结构合法但被篡改）→ 回退且备份原值', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app');
    const raw = serializeConfig(baseConfig('view_A')).raw;
    const tampered = JSON.parse(raw) as { payload: CardViewConfig };
    tampered.payload.meta.updatedBy = 'intruder';
    const tamperedRaw = JSON.stringify(tampered);
    storage.map.set(degradedConfigKey('app', 'view_A'), tamperedRaw);

    const loaded = await repo.load('view_A');
    expect(loaded.degraded).toBe(true);
    expect(loaded.config).toBeNull();
    expect(loaded.error).toBe('checksum-mismatch');
    const backups = [...storage.map.entries()].filter(([key]) => key.includes(':backup:'));
    expect(backups.map(([, value]) => value)).toContain(tamperedRaw);
  });

  it('bridge：损坏 → 降级且以 backupKey 前缀落备份（含原值）', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const corrupt = 'not-json-at-all';
    await store.setData(configKey('view_A'), corrupt);

    const loaded = await repo.load('view_A');
    expect(loaded.degraded).toBe(true);
    expect(loaded.config).toBeNull();
    const prefix = backupKey('view_A', 0).replace(/0$/, '');
    const backups = [...store.map.entries()].filter(([key]) => key.startsWith(prefix));
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.map(([, value]) => value)).toContain(corrupt);
  });
});

describe('QA · resolveLoadedConfig 只读 / 迁移标记（独立复核）', () => {
  it('更高版本 → unsupportedNewer=true，且配置仍可读（只读标记依据）', () => {
    const payload = baseConfig('view_A');
    const raw = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      pluginVersion: '9.9.9',
      writtenAt: 1,
      checksum: checksumOf(payload),
      payload,
    });
    const result = resolveLoadedConfig(raw, { viewId: 'view_A', source: 'bridge' });
    expect(result.unsupportedNewer).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.config?.meta.configId).toBe('view_A');
  });

  it('更低版本（v1）→ 自动迁移到当前版本，且非只读', () => {
    const legacyPayload = {
      schemaVersion: 1,
      meta: { configId: 'view_A', tableId: 'tbl' },
      layout: { templateId: 'compact', cardAspect: 'square', slots: {} },
      highlightRules: [],
    };
    const raw = JSON.stringify({
      schemaVersion: 1,
      pluginVersion: '0.1.0',
      writtenAt: 1,
      checksum: checksumOf(legacyPayload),
      payload: legacyPayload,
    });
    const result = resolveLoadedConfig(raw, { viewId: 'view_A', source: 'bridge' });
    expect(result.config?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.config?.card.templateId).toBe('compact');
    expect(result.unsupportedNewer).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('空值 → 非降级、无配置', () => {
    const result = resolveLoadedConfig(null, { viewId: 'v', source: 'localStorage' });
    expect(result.config).toBeNull();
    expect(result.degraded).toBe(false);
    expect(result.unsupportedNewer).toBe(false);
  });
});
