import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './types';
import type { HeadingBlock, KeyValueGridBlock, FieldListBlock } from './types';
import { MigrationError, isSupportedSchema, migrate, needsMigration } from './migrations';
import { defaultDocTemplate } from './defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';

const sampleFields: FieldMetaLite[] = [
  { id: 'f_name', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f_owner', name: '报备人', type: FieldType.Text, isPrimary: false },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f_status', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f_date', name: '签约日期', type: FieldType.DateTime, isPrimary: false },
  { id: 'f_done', name: '已完成', type: FieldType.Checkbox, isPrimary: false },
  { id: 'f_price', name: '单价', type: FieldType.Currency, isPrimary: false },
];

describe('config/migrations', () => {
  it('1 → 2 迁移：layout 重命名为 card，并生成默认 detail.doc', () => {
    const legacy = {
      schemaVersion: 1,
      meta: { configId: 'view_1', tableId: 'tbl_1' },
      layout: { templateId: 'compact', cardAspect: 'square', slots: {} },
      theme: { preset: 'p', primaryColor: '#000000', borderRadius: 6, shadowLevel: 2, fontScale: 1, titleWeight: 500 },
      density: { cardMinWidth: 300, columnsMode: 'auto', gap: 12, padding: 12, maxCardHeight: 0 },
      highlightRules: [],
      legacyOnlyField: 'should-be-dropped',
    };

    const migrated = migrate(legacy, 1);

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.card.templateId).toBe('compact');
    expect(migrated.card.cardAspect).toBe('square');
    // 槽位被补全为四态，不因旧配置缺槽位而崩溃
    expect(Object.keys(migrated.card.slots).sort()).toEqual(['attributes', 'footer', 'subtitle', 'title']);
    expect(migrated.detail.mode).toBe('document');
    expect(migrated.detail.doc.blocks.length).toBeGreaterThan(0);
    // 旧字段 layout 被清理
    expect((migrated as unknown as Record<string, unknown>).layout).toBeUndefined();
    // 未知顶层字段被丢弃
    expect((migrated as unknown as Record<string, unknown>).legacyOnlyField).toBeUndefined();
  });

  it('空配置不抛错，回落到合法默认结构', () => {
    const migrated = migrate({}, 1);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.card.slots.title).toBeDefined();
    expect(Array.isArray(migrated.highlightRules)).toBe(true);
  });

  it('更高版本：不迁移、仅补齐已知字段（只读模式由上层标记）', () => {
    expect(isSupportedSchema(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
    expect(needsMigration(CURRENT_SCHEMA_VERSION + 1)).toBe(false);

    const futurePayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      card: { templateId: 'custom', cardAspect: 'auto', slots: {} },
      unknownBranch: { whatever: true },
    };
    const result = migrate(futurePayload, CURRENT_SCHEMA_VERSION + 1);
    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect((result as unknown as Record<string, unknown>).unknownBranch).toBeUndefined();
  });

  it('损坏输入（非对象）抛出 MigrationError', () => {
    expect(() => migrate('not-an-object', 1)).toThrow(MigrationError);
    expect(() => migrate(null, 1)).toThrow(MigrationError);
    expect(() => migrate([1, 2, 3], 1)).toThrow(MigrationError);
  });

  it('未知字段类型不影响迁移（保留原始 highlightRules 数组）', () => {
    const result = migrate({ schemaVersion: 1, highlightRules: [{ ruleId: 'r1' }] }, 1);
    expect(result.highlightRules).toHaveLength(1);
  });
});

describe('config/defaults.defaultDocTemplate（默认 A4 模板）', () => {
  it('有字段时：标题绑定首个文本字段，键值网格承载前 6 个 P0 字段', () => {
    const template = defaultDocTemplate(sampleFields);
    expect(template.pageSetup.paper).toBe('A4');
    expect(template.blocks).toHaveLength(8);

    const heading = template.blocks[0] as HeadingBlock;
    expect(heading.kind).toBe('heading');
    expect(heading.level).toBe(1);
    expect(heading.source).toEqual({ type: 'field', fieldId: 'f_name' });

    const grid = template.blocks[2] as KeyValueGridBlock;
    expect(grid.kind).toBe('keyValueGrid');
    expect(grid.columns).toBe(2);
    expect(grid.rows).toHaveLength(6);

    const fieldList = template.blocks[5] as FieldListBlock;
    expect(fieldList.kind).toBe('fieldList');
    expect(fieldList.items.map((item) => item.fieldId)).toEqual(['f_price']);
  });

  it('无字段时：生成结构合法、静态标题的模板', () => {
    const template = defaultDocTemplate([]);
    expect(template.blocks).toHaveLength(8);
    const heading = template.blocks[0] as HeadingBlock;
    expect(heading.source).toEqual({ type: 'static', text: '记录详情' });
    expect((template.blocks[2] as KeyValueGridBlock).rows).toHaveLength(0);
  });

  it('区块 id 唯一', () => {
    const template = defaultDocTemplate(sampleFields);
    const ids = template.blocks.map((block) => block.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
