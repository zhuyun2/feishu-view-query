/**
 * QA 独立复核（M1 / T03）：config/migrations 幂等性与边界。
 * 本文件由 QA 编写，不复用工程师既有测试断言。
 */
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './types';
import type { CardViewConfig } from './types';
import { MigrationError, isSupportedSchema, migrate, needsMigration } from './migrations';

/** 一份「完整」的 v1 配置（layout 分支 + 已知 theme / density） */
function legacyV1(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    meta: {
      configId: 'view_1',
      tableId: 'tbl_1',
      createdAt: 1000,
      updatedAt: 2000,
      updatedBy: 'u_1',
      templateId: 'standard',
    },
    layout: {
      templateId: 'compact',
      cardAspect: 'square',
      slots: {
        title: {
          id: 'title',
          visible: true,
          collapsibleWhenEmpty: true,
          direction: 'row',
          separator: ' · ',
          maxItemsPerCard: 3,
          placements: [],
        },
      },
    },
    theme: {
      preset: 'legacy',
      primaryColor: '#123456',
      borderRadius: 6,
      shadowLevel: 2,
      fontScale: 1,
      titleWeight: 500,
    },
    density: { cardMinWidth: 300, columnsMode: 'auto', gap: 12, padding: 12, maxCardHeight: 0 },
    highlightRules: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('QA · config/migrations 幂等性与边界（独立复核）', () => {
  it('1→2 迁移幂等：对迁移结果再迁移一次，结构完全一致', () => {
    const once = migrate(legacyV1(), 1);
    const twice = migrate(asRecord(once), CURRENT_SCHEMA_VERSION);
    expect(twice).toEqual(once);
  });

  it('1→2 迁移幂等：迁移结果不随调用次数漂移（固定点稳定）', () => {
    const once = migrate(legacyV1(), 1);
    const twice = migrate(asRecord(once), CURRENT_SCHEMA_VERSION);
    const thrice = migrate(asRecord(twice), CURRENT_SCHEMA_VERSION);
    expect(thrice).toEqual(once);
  });

  it('空对象 → 补齐为合法默认结构，不抛错', () => {
    const out = migrate({}, 1);
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out.card.templateId).toBe('standard');
    expect(Object.keys(out.card.slots).sort()).toEqual(['attributes', 'footer', 'subtitle', 'title']);
    expect(out.detail.mode).toBe('document');
    expect(out.detail.doc.blocks.length).toBeGreaterThan(0);
    expect(Array.isArray(out.highlightRules)).toBe(true);
  });

  it('缺字段（仅 schemaVersion）→ 各分支被补齐且类型正确', () => {
    const out = migrate({ schemaVersion: 1 }, 1);
    expect(typeof out.meta.configId).toBe('string');
    expect(typeof out.meta.tableId).toBe('string');
    expect(typeof out.density.cardMinWidth).toBe('number');
    expect(typeof out.theme.primaryColor).toBe('string');
    expect(out.detail.drawer.defaultWidthPx).toBeGreaterThan(0);
    expect(out.detail.doc.pageSetup.paper).toBe('A4');
  });

  it('顶层未知字段按 §4.5「读新降级」被丢弃，旧 layout 被清理', () => {
    const out = asRecord(migrate({ ...legacyV1(), unknownTopLevel: { a: 1 } }, 1));
    expect(out.unknownTopLevel).toBeUndefined();
    expect(out.layout).toBeUndefined();
  });

  it('已知分支内的未知字段被保留（浅合并，不丢用户扩展）', () => {
    const input = legacyV1();
    asRecord(input.theme).customThemeFlag = true;
    asRecord(input.density).customDensityFlag = true;
    const out = migrate(input, 1) as unknown as CardViewConfig;
    expect(asRecord(out.theme).customThemeFlag).toBe(true);
    expect(asRecord(out.density).customDensityFlag).toBe(true);
  });

  it('schemaVersion 更高 → isSupportedSchema=false / needsMigration=false（只读标记依据）', () => {
    expect(isSupportedSchema(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(isSupportedSchema(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
    expect(needsMigration(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
    expect(needsMigration(CURRENT_SCHEMA_VERSION)).toBe(false);
    expect(needsMigration(1)).toBe(true);
  });

  it('更高版本 payload 仍产出「已读已知字段」的可用配置（不丢已知数据）', () => {
    const out = migrate(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION + 3,
        theme: {
          preset: 'future',
          primaryColor: '#abcdef',
          borderRadius: 9,
          shadowLevel: 3,
          fontScale: 1,
          titleWeight: 700,
        },
      },
      CURRENT_SCHEMA_VERSION + 3,
    );
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out.theme.preset).toBe('future');
    expect(out.theme.primaryColor).toBe('#abcdef');
  });

  it('非对象 / 数组 / null → MigrationError（调用方据此回退默认 + 备份）', () => {
    expect(() => migrate('x', 1)).toThrow(MigrationError);
    expect(() => migrate(null, 1)).toThrow(MigrationError);
    expect(() => migrate([1, 2], 1)).toThrow(MigrationError);
  });

  it('fromVersion 为 NaN → 视为当前版本，不抛错', () => {
    const out = migrate(legacyV1(), Number.NaN);
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out.card).toBeDefined();
    expect(out.detail).toBeDefined();
  });
});
