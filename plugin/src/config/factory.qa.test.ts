/**
 * QA 独立复核（M1 / T04）：配置仓储介质选型与降级标志（bridge 不可用 → localStorage）。
 */
import { describe, expect, it, vi } from 'vitest';
import { getBridgeStore } from '@/sdk/base';
import type { BridgeStore } from '@/sdk/base';
import { selectConfigRepository } from './factory';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import { LocalStorageConfigRepository } from './LocalStorageConfigRepository';

vi.mock('@/sdk/base', () => ({
  isBridgeAvailable: vi.fn(() => false),
  getBridgeStore: vi.fn(() => null),
  getAppId: vi.fn(() => 'app_test'),
}));

const mockedGetBridgeStore = vi.mocked(getBridgeStore);

const stubStore: BridgeStore = {
  getData: async () => null,
  setData: async () => true,
  onDataChange: () => () => undefined,
};

describe('QA · config/factory 介质选型与降级标志（独立复核）', () => {
  it('bridge 可用 → 首选 BridgeConfigRepository，degraded=false', () => {
    mockedGetBridgeStore.mockReturnValue(stubStore);
    const selection = selectConfigRepository('app_test');
    expect(selection.kind).toBe('bridge');
    expect(selection.degraded).toBe(false);
    expect(selection.repository).toBeInstanceOf(BridgeConfigRepository);
  });

  it('bridge 不可用但 localStorage 可用 → 降级 localStorage，degraded=true 且带可展示原因', () => {
    mockedGetBridgeStore.mockReturnValue(null);
    const selection = selectConfigRepository('app_test');
    expect(selection.kind).toBe('localStorage');
    expect(selection.degraded).toBe(true);
    expect(selection.reason.length).toBeGreaterThan(0);
    expect(selection.repository).toBeInstanceOf(LocalStorageConfigRepository);
  });
});
