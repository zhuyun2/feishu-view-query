/**
 * QA2 补测 ·「配置数据损坏」误报修复（端到端：真实 hook → 真实 ViewStore → 真实 Banner）。
 *
 * 与 `src/config/configCorrupted.qa2.test.ts`（只验仓储返回的 `corrupted`）互补：
 * 本文件 **不重写** `useCardViewInit` 里的判定公式，而是**真的跑一遍** `useCardViewInit`
 * （仅把 SDK 边界整体 mock 掉），再读 `useViewStore` 的 `corrupted / configCorrupted`
 * 与渲染后的 `BannerStack` 文案 —— 这样 `useCardViewInit.ts:108` 的
 * `configCorrupted: load.corrupted === true && load.config === null` 是**被测代码本身**。
 *
 * 目的：证明三场景不会误报 / 漏报，且两条横幅**互斥不叠加**。
 *
 * ⚠️ 本文件为**新增**，不修改任何既有测试文件；不改动被测源码。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BannerStack } from '@/components/layout/Banner';
import { createDefaultConfig } from '@/config/defaults';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig } from '@/config/types';
import { useCardViewInit } from '@/hooks/useCardViewInit';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { checksumOf } from '@/utils/hash';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * SDK 边界的可变桩：`vi.mock` 工厂被提升到 import 之前，故状态必须放在 `vi.hoisted` 里。
 * 这样既保证主套件「零运行时加载 SDK」，又能逐场景切 bridge 内容。
 */
const fake = vi.hoisted(() => ({
  env: {
    productType: 'web',
    language: 'zh-CN',
    theme: 'light',
    tableId: 'tbl_qa2',
    viewId: 'view_qa2',
    appId: 'app_qa2',
    userId: 'u_qa2',
  },
  bridgeStore: null as unknown,
  bridgeAvailable: true,
}));

vi.mock('@/sdk/env', () => ({
  getEnvSnapshot: () => Promise.resolve(fake.env),
  subscribeThemeChange: () => () => undefined,
}));

vi.mock('@/sdk/base', () => ({
  getTable: () => Promise.resolve({}),
  getFieldMetaList: () => Promise.resolve([]),
  getViewMetaList: () => Promise.resolve([]),
  canEditTable: () => Promise.resolve(true),
  getBridgeStore: () => fake.bridgeStore,
  isBridgeAvailable: () => fake.bridgeAvailable,
  getAppId: () => fake.env.appId,
}));

vi.mock('@/data/SdkRecordDataSource', () => ({
  SdkRecordDataSource: class {
    async loadPage(): Promise<{ records: never[]; hasMore: boolean; pageToken: null }> {
      return { records: [], hasMore: false, pageToken: null };
    }
    async count(): Promise<number> {
      return 0;
    }
  },
}));

/** 组装一个 bridge 介质桩（BridgeStore 结构） */
function bridgeOf(getData: () => Promise<unknown>): unknown {
  return {
    getData,
    setData: () => Promise.resolve(true),
    onDataChange: () => () => undefined,
  };
}

/** 返回固定 raw 的 bridge */
function bridgeReturning(raw: string | null): unknown {
  return bridgeOf(() => Promise.resolve(raw));
}

/** 读取即抛错的 bridge（介质故障） */
function bridgeThrowing(): unknown {
  return bridgeOf(() => Promise.reject(new Error('bridge down')));
}

function makeConfig(viewId: string): CardViewConfig {
  return createDefaultConfig({ viewId, tableId: 'tbl_qa2', now: 1_700_000_000_000 });
}

function envelopeRaw(config: CardViewConfig, schemaVersion: number = CURRENT_SCHEMA_VERSION): string {
  return JSON.stringify({
    schemaVersion,
    pluginVersion: '1.0.0',
    writtenAt: 1,
    checksum: checksumOf(config),
    payload: config,
  });
}

/** 挂载真实 hook 并等它跑完（status 落到 browse / error） */
async function runInit(): Promise<void> {
  function Probe(): null {
    useCardViewInit();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      for (let i = 0; i < 40; i += 1) {
        const status = useViewStore.getState().status;
        if (status === 'browse' || status === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

/** 用当前 store 状态渲染真实 BannerStack，返回 innerHTML */
function bannerMarkup(): string {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<BannerStack />);
  });
  const markup = container.innerHTML;
  act(() => {
    root.unmount();
  });
  container.remove();
  return markup;
}

beforeEach(() => {
  window.localStorage.clear();
  useViewStore.setState({
    status: 'boot',
    errorMessage: null,
    config: null,
    degraded: false,
    degradedReason: '',
    corrupted: false,
    configCorrupted: false,
    unsupportedNewer: false,
    provisionedFromTemplate: false,
    copyScenario: false,
  });
  useUiStore.setState({ copyBannerDismissed: false });
  fake.bridgeAvailable = true;
  fake.bridgeStore = null;
});

describe('E2E · 场景 1：全新视图（bridge 返回 null）', () => {
  it('configCorrupted=false / corrupted=false / degraded=false；仅 D4 首开 info 条', async () => {
    fake.bridgeStore = bridgeReturning(null);
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse'); // 先证明初始化真的成功了，否则下面的 false 是假绿
    expect(state.corrupted).toBe(false);
    expect(state.configCorrupted).toBe(false);
    expect(state.degraded).toBe(false);

    const markup = bannerMarkup();
    expect(markup).not.toContain('data-testid="banner-degraded"');
    expect(markup).not.toContain('data-testid="banner-corrupted"');
    expect(markup).toContain('data-testid="banner-provisioned"');
  });
});

describe('E2E · 场景 2：介质降级（bridge 抛错 → fallback 为空）', () => {
  it('configCorrupted=false；R8 降级条出现且 reason 属实（非兜底文案）', async () => {
    fake.bridgeStore = bridgeThrowing();
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.degraded).toBe(true);
    // ⭐ 修复目标：这里**必须**是 false —— 修复前为 true，会误报「配置数据损坏」
    expect(state.corrupted).toBe(false);
    expect(state.configCorrupted).toBe(false);
    // R8 会陈述存储位置，故 reason 必须有真实内容，不能落到兜底
    expect(state.degradedReason).not.toBe('');
    expect(state.degradedReason).toBe('配置存储读取失败，已回退到本地保存，其他成员看不到你的排版。');

    const markup = bannerMarkup();
    expect(markup).toContain('data-testid="banner-degraded"');
    expect(markup).not.toContain('data-testid="banner-corrupted"');
    // 这句在介质降级场景下是**真**的（配置确实落到 localStorage）
    expect(markup).toContain('其他成员看不到你的排版');
    expect(markup).not.toContain('配置数据损坏');
  });
});

describe('E2E · 场景 3：真实损坏（bridge 读到坏数据）', () => {
  it('非法 JSON → configCorrupted=true；仅数据损坏条，且不出现「仅本地保存」假陈述', async () => {
    fake.bridgeStore = bridgeReturning('{ 这不是 JSON');
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.corrupted).toBe(true);
    expect(state.configCorrupted).toBe(true);

    const markup = bannerMarkup();
    expect(markup).toContain('data-testid="banner-corrupted"');
    // 两条互斥：损坏场景绝不能同时弹 R8 降级条
    expect(markup).not.toContain('data-testid="banner-degraded"');
    // 数据其实还在 bridge，这句「仅本地保存」是假的
    expect(markup).not.toContain('其他成员看不到你的排版');
    // D4「首次打开已按默认模板生成配置」在损坏场景是**假陈述**（不是首次打开，是读出来的数据坏了），
    // 且与上面的损坏条自相矛盾 → 必须被抑制（useCardViewInit.ts:105-107）
    expect(markup).not.toContain('data-testid="banner-provisioned"');
    expect(markup).not.toContain('首次打开');
    // ⭐ 防误删锁（与上面成对）：提示被抑制 ≠ 回退默认模板被删。
    // 将来有人为了「去掉这行显示」而顺手删掉回退逻辑，上面那条照样绿（就是不显示嘛），
    // 只有这里会红 —— 损坏后用户仍必须拿到一份可用的默认模板配置。
    expect(state.config).not.toBeNull();
    expect(state.config?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(state.configSource).toBe('default');
  });
});

describe('E2E · 场景 4 / 5：迁移失败与裸数据', () => {
  it('migrate 抛错（schemaVersion=0）→ configCorrupted=true', async () => {
    fake.bridgeStore = bridgeReturning(envelopeRaw(makeConfig('view_qa2'), 0));
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.corrupted).toBe(true);
    expect(state.configCorrupted).toBe(true);
    // 同样是「真实损坏」分支 → D4 首开条必须被抑制，且默认模板仍须生成
    const markup = bannerMarkup();
    expect(markup).toContain('data-testid="banner-corrupted"');
    expect(markup).not.toContain('data-testid="banner-provisioned"');
    expect(state.config).not.toBeNull();
  });

  it('裸数据（无 envelope 三要素）→ 裁定为损坏，configCorrupted=true', async () => {
    fake.bridgeStore = bridgeReturning(JSON.stringify({ title: '旧版裸数据' }));
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.corrupted).toBe(true);
    expect(state.configCorrupted).toBe(true);
    // 同样是「真实损坏」分支 → D4 首开条必须被抑制，且默认模板仍须生成
    const markup = bannerMarkup();
    expect(markup).toContain('data-testid="banner-corrupted"');
    expect(markup).not.toContain('data-testid="banner-provisioned"');
    expect(state.config).not.toBeNull();
  });
});

describe('E2E · 场景 6：localStorage 读取抛错', () => {
  it('configCorrupted=false（介质故障 ≠ 数据损坏）', async () => {
    fake.bridgeAvailable = false; // 走 LocalStorageConfigRepository
    fake.bridgeStore = null;
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('localStorage denied');
    });

    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.degraded).toBe(true);
    expect(state.corrupted).toBe(false);
    expect(state.configCorrupted).toBe(false);
    expect(bannerMarkup()).not.toContain('data-testid="banner-corrupted"');
  });
});

describe('E2E · 场景 7：unsupportedNewer 与 configCorrupted 互斥', () => {
  it('更高版本合法配置 → 只读条出现，configCorrupted=false，不叠加损坏条', async () => {
    fake.bridgeStore = bridgeReturning(envelopeRaw(makeConfig('view_qa2'), CURRENT_SCHEMA_VERSION + 5));
    await runInit();

    const state = useViewStore.getState();
    expect(state.status).toBe('browse');
    expect(state.unsupportedNewer).toBe(true);
    expect(state.corrupted).toBe(false);
    expect(state.configCorrupted).toBe(false);

    const markup = bannerMarkup();
    expect(markup).toContain('data-testid="banner-newer-readonly"');
    expect(markup).not.toContain('data-testid="banner-corrupted"');
    expect(markup).not.toContain('data-testid="banner-degraded"');
  });
});

describe('UI 互斥总闸：两条横幅永不共存', () => {
  it('遍历五态，任意组合下都不会同时出现 R8 条与损坏条', async () => {
    const scenarios: Array<string | null> = [
      null, // 全新视图
      '{ 坏 JSON', // 真实损坏
      JSON.stringify({ title: '裸数据' }), // 裸数据 → 裁定损坏
      envelopeRaw(makeConfig('view_qa2'), CURRENT_SCHEMA_VERSION + 5), // 升版
      envelopeRaw(makeConfig('view_qa2')), // 正常
    ];
    for (const raw of scenarios) {
      fake.bridgeStore = bridgeReturning(raw);
      await runInit();
      expect(useViewStore.getState().status).toBe('browse');
      const markup = bannerMarkup();
      const hasDegraded = markup.includes('data-testid="banner-degraded"');
      const hasCorrupted = markup.includes('data-testid="banner-corrupted"');
      // 二者互斥：至多出现一条
      expect(hasDegraded && hasCorrupted).toBe(false);
    }
  });

  it('（哨兵）互斥断言不是恒真：corrupted=false 但 configCorrupted=true 时两条会共存', () => {
    useViewStore.setState({ degraded: true, degradedReason: 'x', corrupted: false, configCorrupted: true });
    const markup = bannerMarkup();
    // 证明上面的 `hasDegraded && hasCorrupted` 断言有能力变红，不是永远通过的空断言
    expect(markup).toContain('data-testid="banner-degraded"');
    expect(markup).toContain('data-testid="banner-corrupted"');
  });
});
