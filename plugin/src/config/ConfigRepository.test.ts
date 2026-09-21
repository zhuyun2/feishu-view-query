import { describe, expect, it, vi } from 'vitest';
import { CONFIG_SIZE_LIMIT_BYTES, backupKey, configKey, degradedConfigKey } from '@/constants';
import { createDefaultConfig } from './defaults';
import type { CardViewConfig, HighlightRule } from './types';
import { CURRENT_SCHEMA_VERSION } from './types';
import {
  deserializeEnvelope,
  resolveLoadedConfig,
  serializeConfig,
} from './ConfigRepository';
import {
  LocalStorageConfigRepository,
  type StorageLike,
} from './LocalStorageConfigRepository';
import { BridgeConfigRepository, type BridgeDataChangePayload, type BridgeStore } from './BridgeConfigRepository';

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

function makeConfig(viewId: string, tableId = 'tbl_1'): CardViewConfig {
  return createDefaultConfig({ viewId, tableId, now: 1_700_000_000_000 });
}

function makeOversizedConfig(viewId: string): CardViewConfig {
  const config = makeConfig(viewId);
  const rules: HighlightRule[] = [];
  const longText = 'x'.repeat(400);
  for (let i = 0; i < 400; i += 1) {
    rules.push({
      ruleId: `r_${i}`,
      name: `规则-${i}-${longText}`,
      enabled: true,
      target: { kind: 'cardBorder' },
      condition: { logic: 'and', items: [{ fieldId: 'f_1', operator: 'eq', value: longText }] },
      style: { borderColor: '#F54A45', borderWidth: 2 },
      priority: i,
    });
  }
  return { ...config, highlightRules: rules };
}

describe('config/envelope（checksum 与结构校验）', () => {
  it('序列化 → 反序列化 往返一致且校验通过', () => {
    const config = makeConfig('view_A');
    const serialized = serializeConfig(config);
    expect(serialized.tooLarge).toBe(false);

    const result = deserializeEnvelope(serialized.raw);
    expect(result.valid).toBe(true);
    expect(result.envelope?.payload.meta.configId).toBe('view_A');
    expect(result.envelope?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('checksum 被篡改 → 校验失败（触发回退 + 备份）', () => {
    const serialized = serializeConfig(makeConfig('view_A'));
    const tampered = JSON.parse(serialized.raw) as Record<string, unknown>;
    tampered.checksum = 'deadbeef';
    const result = deserializeEnvelope(JSON.stringify(tampered));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('checksum-mismatch');
  });

  it('payload 被篡改（checksum 未同步）→ 校验失败', () => {
    const serialized = serializeConfig(makeConfig('view_A'));
    const tampered = JSON.parse(serialized.raw) as { payload: CardViewConfig };
    tampered.payload.meta.updatedBy = 'intruder';
    const result = deserializeEnvelope(JSON.stringify(tampered));
    expect(result.valid).toBe(false);
  });

  it('非 JSON / 空值 → 校验失败且不抛错', () => {
    expect(deserializeEnvelope('{not-json').valid).toBe(false);
    expect(deserializeEnvelope('').valid).toBe(false);
    expect(deserializeEnvelope(null).valid).toBe(false);
  });

  it('配置体积超限被拦截（D9：≤64KB）', () => {
    const oversized = makeOversizedConfig('view_big');
    const serialized = serializeConfig(oversized);
    expect(serialized.bytes).toBeGreaterThan(CONFIG_SIZE_LIMIT_BYTES);
    expect(serialized.tooLarge).toBe(true);
    expect(serialized.ok).toBe(false);
  });
});

describe('config/BridgeConfigRepository', () => {
  it('保存 → 读取 往返一致；key 带 viewId 命名空间', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const config = makeConfig('view_A');

    await expect(repo.save('view_A', config)).resolves.toEqual({ ok: true });
    expect(store.map.has(configKey('view_A'))).toBe(true);

    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('bridge');
    expect(loaded.config?.meta.configId).toBe('view_A');
    expect(loaded.degraded).toBe(false);
  });

  it('viewId 命名空间隔离：两个视图配置互不污染', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);

    const configA = makeConfig('view_A');
    const configB = makeConfig('view_B');
    configB.theme.primaryColor = '#000000';

    await repo.save('view_A', configA);
    await repo.save('view_B', configB);

    const loadedA = await repo.load('view_A');
    const loadedB = await repo.load('view_B');

    expect(loadedA.config?.meta.configId).toBe('view_A');
    expect(loadedA.config?.theme.primaryColor).toBe('#3370FF');
    expect(loadedB.config?.meta.configId).toBe('view_B');
    expect(loadedB.config?.theme.primaryColor).toBe('#000000');
  });

  it('存储损坏 → degraded=true、config=null，并落备份', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    await store.setData(configKey('view_A'), '{broken');

    const loaded = await repo.load('view_A');
    expect(loaded.degraded).toBe(true);
    expect(loaded.config).toBeNull();

    const backupKeys = [...store.map.keys()].filter((key) => key.startsWith(backupKey('view_A', 0).replace(/0$/, '')));
    expect(backupKeys.length).toBeGreaterThan(0);
  });

  it('体积超限 → save 返回 tooLarge', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const result = await repo.save('view_big', makeOversizedConfig('view_big'));
    expect(result.ok).toBe(false);
    expect(result.tooLarge).toBe(true);
    expect(store.map.size).toBe(0);
  });

  it('subscribe 仅对匹配 viewId 的变更回调', async () => {
    const store = new MemoryBridgeStore();
    const repo = new BridgeConfigRepository(store);
    const callback = vi.fn();
    const unsubscribe = repo.subscribe('view_A', callback);

    await repo.save('view_B', makeConfig('view_B'));
    expect(callback).not.toHaveBeenCalled();

    await repo.save('view_A', makeConfig('view_A'));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]?.meta.configId).toBe('view_A');

    unsubscribe();
    await repo.save('view_A', makeConfig('view_A'));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('config/LocalStorageConfigRepository（降级实现）', () => {
  it('降级保存/读取生效，key 补 appId 维度', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app_test');
    await repo.save('view_A', makeConfig('view_A'));

    expect(storage.map.has(degradedConfigKey('app_test', 'view_A'))).toBe(true);
    const loaded = await repo.load('view_A');
    expect(loaded.source).toBe('localStorage');
    expect(loaded.config?.meta.configId).toBe('view_A');
  });

  it('降级实现同样做 viewId 命名空间隔离', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app_test');
    const configA = makeConfig('view_A');
    const configB = makeConfig('view_B');
    configB.density.cardMinWidth = 400;

    await repo.save('view_A', configA);
    await repo.save('view_B', configB);

    expect((await repo.load('view_A')).config?.density.cardMinWidth).toBe(280);
    expect((await repo.load('view_B')).config?.density.cardMinWidth).toBe(400);
  });

  it('clear 后读取无配置', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, 'app_test');
    await repo.save('view_A', makeConfig('view_A'));
    await repo.remove('view_A');
    const loaded = await repo.load('view_A');
    expect(loaded.config).toBeNull();
    expect(loaded.degraded).toBe(false);
    expect(loaded.source).toBe('localStorage');
  });
});

describe('config/resolveLoadedConfig', () => {
  it('空值 → 无配置、非降级', () => {
    const result = resolveLoadedConfig(null, { viewId: 'v', source: 'bridge' });
    expect(result.config).toBeNull();
    expect(result.degraded).toBe(false);
  });

  it('更高版本 → unsupportedNewer=true，仅读已知字段', () => {
    const config = makeConfig('view_A');
    const raw = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      pluginVersion: '9.9.9',
      writtenAt: 1,
      checksum: serializeConfig(config).raw
        ? (JSON.parse(serializeConfig(config).raw) as { checksum: string }).checksum
        : '',
      payload: config,
    });
    const result = resolveLoadedConfig(raw, { viewId: 'view_A', source: 'bridge' });
    expect(result.unsupportedNewer).toBe(true);
    expect(result.config?.meta.configId).toBe('view_A');
  });

  it('损坏 → 回退（config=null / degraded=true）并调用备份回调', () => {
    const backup = vi.fn();
    const result = resolveLoadedConfig('garbage', { viewId: 'v', source: 'bridge', backup });
    expect(result.degraded).toBe(true);
    expect(result.config).toBeNull();
    expect(backup).toHaveBeenCalledWith('garbage');
  });
});
