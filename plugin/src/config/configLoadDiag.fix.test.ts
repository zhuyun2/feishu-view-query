/**
 * fix2-corrupt 批次回归 —— 「配置损坏」路径补**诊断日志** + 备份写入**不再吞错/不再谎报**。
 *
 * 背景（只读排查结论）：真机常驻「配置数据损坏」横幅 = `load.corrupted===true && load.config===null`；
 * `corrupted=true` 只可能来自 `resolveLoadedConfig` 的两处分支（反序列化失败 / 迁移抛错），
 * 而这两处**原本零日志**、横幅也不显示 reason → 真机无法定案。本文件钉住「补齐后可定案」。
 *
 * 断言铁律遵循：
 *  - 锚定**结构性特征**（载荷对象的 `phase` / `reason` / `rawLen` / `rawHead` 字段），不用裸词匹配；
 *  - 每条否定式断言都配**正面锚点**（先证明「确实走了损坏/确实读出了配置/确实是介质失败」）；
 *  - 不依赖 vitest globals，显式从 `vitest` 引入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { configKey } from '@/constants';
import { checksumOf } from '@/utils/hash';
import type { BridgeStore } from './BridgeConfigRepository';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import { resolveLoadedConfig, serializeConfig } from './ConfigRepository';
import { createDefaultConfig } from './defaults';
import { CURRENT_SCHEMA_VERSION } from './types';

const VIEW = 'view_diag';
const BACKUP_PREFIX = `${configKey(VIEW)}:backup`;

/** 统一日志出口（`@/utils/log`）最终落到 `console.warn(prefix, message, ctx)` */
let warnSpy: MockInstance;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

interface WarnCall {
  message: unknown;
  ctx: Record<string, unknown>;
}

/** 取所有被捕获的 warn 调用（message = args[1]，ctx = args[2]） */
function warnCalls(): WarnCall[] {
  return warnSpy.mock.calls.map((call) => ({
    message: call[1] as unknown,
    ctx: (call[2] ?? {}) as Record<string, unknown>,
  }));
}

/** 只取「损坏诊断」warn */
function corruptedWarns(): WarnCall[] {
  return warnCalls().filter((call) => call.ctx.phase === 'corrupted');
}

/** 只取「备份写入失败」warn */
function backupWarns(): WarnCall[] {
  return warnCalls().filter((call) => call.ctx.phase === 'backup-failed');
}

const VALID_CONFIG = createDefaultConfig({ viewId: VIEW, tableId: 'tbl_diag', now: 1_700_000_000_000 });

/** 构造合法 envelope 原始串（可覆写 checksum / 顶层 schemaVersion） */
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
  match: 'exact' | 'prefix';
  raw: string;
}

/** 五种 reason 的损坏载荷 */
const CORRUPT_CASES: CorruptCase[] = [
  { reason: 'invalid-json', match: 'exact', raw: '{ this is not json' },
  { reason: 'not-object', match: 'exact', raw: '[1,2,3]' },
  { reason: 'missing-fields', match: 'exact', raw: JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }) },
  { reason: 'checksum-mismatch', match: 'exact', raw: envelopeRaw(VALID_CONFIG, { checksum: 'deadbeef' }) },
  {
    reason: 'migration-failed',
    match: 'prefix',
    // v0 无迁移函数（MIGRATIONS 只注册了 [1]）→ migrate 抛错 → migration-failed
    raw: envelopeRaw({ schemaVersion: 0 }, { schemaVersion: 0 }),
  },
];

/** 一个「配置键返回损坏串、其余键返回 null」的 store */
function storeWithCorruptConfig(
  setDataImpl: (key: string, value: unknown) => Promise<boolean>,
): BridgeStore {
  return {
    getData: async (key) => (key === configKey(VIEW) ? '{broken' : null),
    setData: setDataImpl,
    onDataChange: () => () => undefined,
  };
}

describe('损坏分支补诊断日志：一条 warn 即可区分五种 reason', () => {
  it.each(CORRUPT_CASES)(
    '$reason → 打一条 corrupted warn，载荷含 reason / rawLen / rawHead',
    (testCase: CorruptCase) => {
      const { reason, match, raw } = testCase;
      const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });

      // 正面锚点：确实判为损坏且回退（config=null）
      expect(result.corrupted).toBe(true);
      expect(result.config).toBeNull();

      const warns = corruptedWarns();
      expect(warns.length).toBe(1);
      const { ctx, message } = warns[0];

      if (match === 'prefix') {
        expect(String(ctx.reason).startsWith(reason)).toBe(true);
      } else {
        expect(ctx.reason).toBe(reason);
      }
      expect(ctx.viewId).toBe(VIEW);
      expect(ctx.source).toBe('bridge');
      expect(typeof ctx.rawLen).toBe('number');
      expect(ctx.rawLen).toBe(raw.length);
      expect(typeof ctx.rawHead).toBe('string');
      expect((ctx.rawHead as string).length).toBeLessThanOrEqual(120);
      // rawHead 必须是原始串的前缀（否则「截断展示」失真）
      expect(raw.startsWith(ctx.rawHead as string)).toBe(true);
      // 文案锚点：日志消息带「配置损坏」（含 reason），用户可直接截图
      expect(String(message)).toContain('配置损坏');
    },
  );

  it('超长损坏载荷 → rawHead 精确截断到 120 字符，不把整份刷进控制台', () => {
    const raw = `{"a":${'x'.repeat(600)}`; // 非法 JSON 且远超 120 字符
    const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });
    expect(result.corrupted).toBe(true);

    const ctx = corruptedWarns()[0].ctx;
    expect(ctx.rawLen).toBe(raw.length);
    expect(ctx.rawHead).toBe(raw.slice(0, 120));
    expect((ctx.rawHead as string).length).toBe(120);
  });

  it('checksum-mismatch → schemaVersion 取自信封（可诊断「谁写的版本」）', () => {
    resolveLoadedConfig(envelopeRaw(VALID_CONFIG, { checksum: 'deadbeef' }), {
      viewId: VIEW,
      source: 'bridge',
    });
    const ctx = corruptedWarns()[0].ctx;
    expect(ctx.reason).toBe('checksum-mismatch');
    expect(ctx.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('migration-failed → schemaVersion 为信封版本（此处 0），且 reason 保留既有前缀', () => {
    resolveLoadedConfig(envelopeRaw({ schemaVersion: 0 }, { schemaVersion: 0 }), {
      viewId: VIEW,
      source: 'bridge',
    });
    const ctx = corruptedWarns()[0].ctx;
    expect(String(ctx.reason).startsWith('migration-failed:')).toBe(true);
    expect(ctx.schemaVersion).toBe(0);
  });
});

describe('反面对照（防假阳）：非损坏路径不得打成 corrupted', () => {
  it('正常读取合法配置 → 无 corrupted warn，且确实读出配置', () => {
    const raw = serializeConfig(VALID_CONFIG).raw;
    const result = resolveLoadedConfig(raw, { viewId: VIEW, source: 'bridge' });

    // 正面锚点：确实读出了配置（不是「什么都没读到」造成的假阴性）
    expect(result.config?.meta.configId).toBe(VIEW);
    expect(result.corrupted).toBe(false);
    // 否定：损坏诊断零条
    expect(corruptedWarns().length).toBe(0);
  });

  it('空值（无配置）→ 无 corrupted warn', () => {
    const result = resolveLoadedConfig(null, { viewId: VIEW, source: 'bridge' });
    expect(result.degraded).toBe(false);
    expect(result.corrupted).toBe(false);
    expect(corruptedWarns().length).toBe(0);
  });

  it('介质读取失败（getData 抛错）→ 不得打成任何损坏 reason', async () => {
    const store: BridgeStore = {
      getData: async () => {
        throw new Error('bridge down');
      },
      setData: async () => true,
      onDataChange: () => () => undefined,
    };
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);

    // 正面锚点：确实是「介质读取失败」（degraded 且 corrupted=false）
    expect(loaded.degraded).toBe(true);
    expect(loaded.corrupted).toBe(false);
    // 否定：零条损坏诊断（介质问题绝不能被误报成数据损坏）
    expect(corruptedWarns().length).toBe(0);
  });
});

describe('备份写入不再吞错：失败在控制台可查（phase: backup-failed）', () => {
  it('备份 setData 抛错（Promise rejection）→ 记 backup-failed，但 load 仍返回损坏结果、不整体失败', async () => {
    const store = storeWithCorruptConfig(async (key: string) => {
      if (key.startsWith(BACKUP_PREFIX)) throw { code: 50001, msg: 'backup denied' };
      return true;
    });
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    // 让被吞的 rejection 的 catch 回调执行
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 行为与现状一致：load 未失败，仍返回「损坏回退默认」；数据损坏不切介质
    expect(loaded.corrupted).toBe(true);
    expect(loaded.config).toBeNull();
    expect(repo.isDegraded()).toBe(false);

    const warns = backupWarns();
    expect(warns.length).toBe(1);
    expect(String(warns[0].ctx.backupKey).startsWith(BACKUP_PREFIX)).toBe(true);
    expect(warns[0].ctx.viewId).toBe(VIEW);
    // 保留 SDK 错误码（普通对象也经 formatError 归一）
    expect(String(warns[0].ctx.error)).toContain('code=50001');
  });

  it('备份 setData 同步抛错 → 同样记 backup-failed，且异常不外泄（load 成功返回）', async () => {
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
    expect(repo.isDegraded()).toBe(false);

    const warns = backupWarns();
    expect(warns.length).toBe(1);
    expect(String(warns[0].ctx.error)).toContain('sync backup fail');
  });

  it('备份写入成功 → 不出现 backup-failed（防假阳），且备份键确实被写', async () => {
    const written: string[] = [];
    const store = storeWithCorruptConfig(async (key: string) => {
      written.push(key);
      return true;
    });
    const repo = new BridgeConfigRepository(store);
    const loaded = await repo.load(VIEW);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loaded.corrupted).toBe(true);
    // 正面锚点：备份键确实被写（证明走了备份路径，否定断言才不是假阴性）
    expect(written.some((key) => key.startsWith(BACKUP_PREFIX))).toBe(true);
    // 否定：无失败日志
    expect(backupWarns().length).toBe(0);
  });
});
