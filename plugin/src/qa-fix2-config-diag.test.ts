/**
 * QA（qa-fix2-batch）· **独立证伪**：配置损坏路径的诊断日志与备份诚实性。
 *
 * 独立重写，不复用实现方的 `configLoadDiag.fix.test.ts`。断言锚定**结构性字段**
 * （phase / reason / rawLen / rawHead / schemaVersion），每条否定断言都配**正面锚点**。
 *
 * 覆盖：
 *  - 五种 reason 各打**恰好一条** `phase:'corrupted'`，`rawLen` 正确、`rawHead` ≤120 且为原文前缀；
 *  - 反面对照：正常读取 / 空值 / 介质读取失败 → **零条**损坏日志；
 *  - **订阅路径**（onDataChange 推送损坏载荷）同样落一条（实现方未覆盖的路径）；
 *  - 备份写入失败 → `phase:'backup-failed'`，且 `load` 仍正常返回「损坏回退」结果、不切介质。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { configKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import type { BridgeDataChangePayload, BridgeStore } from '@/config/BridgeConfigRepository';
import { BridgeConfigRepository } from '@/config/BridgeConfigRepository';
import { resolveLoadedConfig, serializeConfig } from '@/config/ConfigRepository';
import { createDefaultConfig } from '@/config/defaults';
import { CURRENT_SCHEMA_VERSION } from '@/config/types';

const VIEW = 'view_qf2diag';
const BACKUP_PREFIX = `${configKey(VIEW)}:backup`;

let warnSpy: MockInstance;

interface WarnCall {
  message: unknown;
  ctx: Record<string, unknown>;
}

function warnCalls(): WarnCall[] {
  return warnSpy.mock.calls.map((call) => ({
    message: call[1] as unknown,
    ctx: (call[2] ?? {}) as Record<string, unknown>,
  }));
}

function byPhase(phase: string): WarnCall[] {
  return warnCalls().filter((call) => call.ctx.phase === phase);
}

const VALID = createDefaultConfig({ viewId: VIEW, tableId: 'tbl_qf2diag', now: 1_700_000_000_000 });

function envelopeRaw(
  payload: unknown,
  overrides: { schemaVersion?: number; checksum?: string } = {},
): string {
  return JSON.stringify({
    schemaVersion: overrides.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    pluginVersion: 'test',
    writtenAt: 1,
    checksum: overrides.checksum ?? checksumOf(payload),
    payload,
  });
}

interface CorruptCase {
  reason: string;
  prefix: boolean;
  raw: string;
}

const CORRUPT_CASES: CorruptCase[] = [
  { reason: 'invalid-json', prefix: false, raw: '{ this is not json' },
  { reason: 'not-object', prefix: false, raw: '[1,2,3]' },
  { reason: 'missing-fields', prefix: false, raw: JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }) },
  { reason: 'checksum-mismatch', prefix: false, raw: envelopeRaw(VALID, { checksum: 'deadbeef' }) },
  { reason: 'migration-failed', prefix: true, raw: envelopeRaw({ schemaVersion: 0 }, { schemaVersion: 0 }) },
];

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

/* ===================== ① 五种 reason ===================== */

describe('① 五种 reason 各打恰好一条 corrupted warn', () => {
  it.each(CORRUPT_CASES)('$reason → 一条 warn；rawLen 正确、rawHead ≤120 且为原文前缀', (testCase) => {
    const { reason, prefix, raw } = testCase;
    const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });

    // 正面锚点：确实判损坏并回退默认
    expect(result.corrupted).toBe(true);
    expect(result.config).toBeNull();

    const warns = byPhase('corrupted');
    expect(warns.length).toBe(1);
    const { ctx, message } = warns[0];

    if (prefix) expect(String(ctx.reason).startsWith(reason)).toBe(true);
    else expect(ctx.reason).toBe(reason);
    expect(ctx.viewId).toBe(VIEW);
    expect(ctx.source).toBe('bridge');

    expect(typeof ctx.rawLen).toBe('number');
    expect(ctx.rawLen).toBe(raw.length);
    expect(typeof ctx.rawHead).toBe('string');
    expect((ctx.rawHead as string).length).toBeLessThanOrEqual(120);
    expect(raw.startsWith(ctx.rawHead as string)).toBe(true);
    expect(String(message)).toContain('配置损坏');
  });

  it('无信封的 reason（invalid-json / not-object / missing-fields）→ schemaVersion 必须为 undefined', () => {
    for (const raw of ['{bad', '[1]', JSON.stringify({ schemaVersion: 1 })]) {
      warnSpy.mockClear();
      resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
      const ctx = byPhase('corrupted')[0].ctx;
      expect(ctx.schemaVersion, `raw=${raw}`).toBeUndefined();
    }
  });

  it('checksum-mismatch / migration-failed → schemaVersion 取自信封（可诊断「谁写的版本」）', () => {
    warnSpy.mockClear();
    resolveLoadedConfig(envelopeRaw(VALID, { checksum: 'deadbeef' }), { viewId: VIEW, source: 'bridge' });
    expect(byPhase('corrupted')[0].ctx.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    warnSpy.mockClear();
    resolveLoadedConfig(envelopeRaw({ schemaVersion: 0 }, { schemaVersion: 0 }), { viewId: VIEW, source: 'bridge' });
    expect(byPhase('corrupted')[0].ctx.schemaVersion).toBe(0);
  });
});

/* ===================== ② rawHead 截断边界 ===================== */

describe('② rawHead 截断边界', () => {
  it('超长损坏串（5000 字符）→ rawHead 恰好 120，rawLen 为全长', () => {
    const raw = `{"a":${'x'.repeat(4990)}`; // 非法 JSON，长度 5000
    resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    const ctx = byPhase('corrupted')[0].ctx;
    expect(ctx.rawLen).toBe(raw.length);
    expect(ctx.rawHead).toBe(raw.slice(0, 120));
    expect((ctx.rawHead as string).length).toBe(120);
  });

  it('恰好 120 字符 → 不截断（rawHead === raw）', () => {
    const raw = `{"b":${'y'.repeat(120 - '{"b":'.length)}`; // 长度 120
    expect(raw.length).toBe(120);
    resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    const ctx = byPhase('corrupted')[0].ctx;
    expect(ctx.rawHead).toBe(raw);
    expect(ctx.rawLen).toBe(120);
  });

  it('121 字符 → 截断到 120（边界另一侧）', () => {
    const raw = `{"b":${'y'.repeat(121 - '{"b":'.length)}`; // 长度 121
    expect(raw.length).toBe(121);
    resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    const ctx = byPhase('corrupted')[0].ctx;
    expect((ctx.rawHead as string).length).toBe(120);
    expect(ctx.rawLen).toBe(121);
  });

  it('非字符串 raw（对象）→ rawLen 为 JSON 串长度，rawHead 为其前缀', () => {
    const raw = { title: '裸对象' };
    resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    const ctx = byPhase('corrupted')[0].ctx;
    expect(ctx.reason).toBe('missing-fields');
    expect(ctx.rawLen).toBe(JSON.stringify(raw).length);
    expect(ctx.rawHead).toBe(JSON.stringify(raw));
  });
});

/* ===================== ③ 反面对照（防假阳） ===================== */

describe('③ 非损坏路径不得打成 corrupted', () => {
  it('正常读取合法配置 → 零条 corrupted，且确实读出配置（正面锚点）', () => {
    const raw = serializeConfig(VALID).raw;
    const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    expect(result.config?.meta.configId).toBe(VIEW);
    expect(result.corrupted).toBe(false);
    expect(byPhase('corrupted').length).toBe(0);
  });

  it('空值（null / undefined / 空串）→ 零条 corrupted', () => {
    for (const raw of [null, undefined, '']) {
      warnSpy.mockClear();
      const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
      expect(result.degraded).toBe(false);
      expect(result.corrupted).toBe(false);
      expect(byPhase('corrupted').length).toBe(0);
    }
  });

  it('介质读取失败（getData 抛错）→ 零条 corrupted，且 corrupted=false / degraded=true', async () => {
    const store: BridgeStore = {
      getData: async () => {
        throw new Error('bridge down');
      },
      setData: async () => true,
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    expect(loaded.degraded).toBe(true);
    expect(loaded.corrupted).toBe(false);
    expect(byPhase('corrupted').length).toBe(0);
  });
});

/* ===================== ④ 订阅路径（实现方未覆盖） ===================== */

describe('④ 订阅路径推送损坏载荷 → 同样落一条 corrupted warn', () => {
  it('onDataChange 推送非法 JSON → 恰好一条 corrupted warn（且不误判为空值）', () => {
    let changeCb: ((payload: BridgeDataChangePayload) => void) | null = null;
    const store: BridgeStore = {
      getData: async () => null,
      setData: async () => true,
      onDataChange: (cb) => {
        changeCb = cb;
        return () => {
          changeCb = null;
        };
      },
    };
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe(VIEW, () => undefined);
    expect(changeCb).not.toBeNull();

    changeCb!({ key: configKey(VIEW), value: '{broken-subscribe' });

    const warns = byPhase('corrupted');
    expect(warns.length).toBe(1);
    expect(warns[0].ctx.reason).toBe('invalid-json');
    expect(warns[0].ctx.viewId).toBe(VIEW);
    unsub();
  });

  it('onDataChange 推送无关 key → 零条 corrupted（防噪音）', () => {
    let changeCb: ((payload: BridgeDataChangePayload) => void) | null = null;
    const store: BridgeStore = {
      getData: async () => null,
      setData: async () => true,
      onDataChange: (cb) => {
        changeCb = cb;
        return () => undefined;
      },
    };
    const repo = new BridgeConfigRepository(store);
    const unsub = repo.subscribe(VIEW, () => undefined);
    changeCb!({ key: 'other:key', value: '{broken' });
    expect(byPhase('corrupted').length).toBe(0);
    unsub();
  });
});

/* ===================== ⑤ 备份写入诚实性 ===================== */

function storeWithCorruptConfig(setDataImpl: (key: string, value: unknown) => Promise<boolean>): BridgeStore {
  return {
    getData: async (key) => (key === configKey(VIEW) ? '{broken' : null),
    setData: setDataImpl,
    onDataChange: () => () => undefined,
  };
}

describe('⑤ 备份写入不再吞错', () => {
  it('备份 setData reject → 一条 backup-failed；load 仍返回损坏回退结果、不切介质', async () => {
    const store = storeWithCorruptConfig(async (key: string) => {
      if (key.startsWith(BACKUP_PREFIX)) throw { code: 50001, msg: 'backup denied' };
      return true;
    });
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loaded.corrupted).toBe(true);
    expect(loaded.config).toBeNull();
    expect(repo.isDegraded()).toBe(false);

    const warns = byPhase('backup-failed');
    expect(warns.length).toBe(1);
    expect(String(warns[0].ctx.backupKey).startsWith(BACKUP_PREFIX)).toBe(true);
    expect(String(warns[0].ctx.error)).toContain('code=50001');
  });

  it('备份 setData 同步抛错 → 同样落 backup-failed，且异常不外泄', async () => {
    const store: BridgeStore = {
      getData: async (key) => (key === configKey(VIEW) ? '{broken' : null),
      setData: (key: string) => {
        if (key.startsWith(BACKUP_PREFIX)) throw new Error('sync backup fail');
        return Promise.resolve(true);
      },
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    expect(loaded.corrupted).toBe(true);
    expect(byPhase('backup-failed').length).toBe(1);
    expect(String(byPhase('backup-failed')[0].ctx.error)).toContain('sync backup fail');
  });

  it('备份成功 → 零条 backup-failed，且备份键确实被写（正面锚点）', async () => {
    const written: string[] = [];
    const store = storeWithCorruptConfig(async (key: string) => {
      written.push(key);
      return true;
    });
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loaded.corrupted).toBe(true);
    expect(written.some((key) => key.startsWith(BACKUP_PREFIX))).toBe(true);
    expect(byPhase('backup-failed').length).toBe(0);
  });
});
