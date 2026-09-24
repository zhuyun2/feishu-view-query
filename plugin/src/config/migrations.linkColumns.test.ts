/**
 * 需求 2 · 第二阶段：**配置往返 / 迁移透传 / 老配置零回归** 单测。
 *
 * ⭐ 最关键的一条（团队历史事故模式）：`assertCardViewConfig()` **逐字段重建** `detail`，
 *   历史上曾把 `importedDocx` 静默抹掉。本功能把 `linkColumns` / `linkRowLimit` 挂在
 *   **`detail.doc.blocks` 的字段绑定项**上 —— 该分支**原样搬运**（不做逐字段重建），
 *   故**无需**额外透传代码。本文件用「保存 → 重载 → 配置仍在」的**往返用例**把这一结论钉死。
 *
 * 本文件锁定：
 *  ① **往返**：`serializeConfig` → `deserializeEnvelope` → `migrate` 后
 *     `linkColumns` / `linkRowLimit` **仍在**（逐字段具体值）；
 *  ② **老配置零回归**：无这两个字段的老配置迁移后**逐字不变**（不含新增键）；
 *  ③ **非法值**：迁移层**不崩、原样透传**（收敛职责在解析层，见 `linkTable.columns.test.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type { CardViewConfig, DocBlock, FieldListBlock } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { CURRENT_SCHEMA_VERSION } from '@/config/types';
import { assertCardViewConfig, migrate } from '@/config/migrations';
import { deserializeEnvelope, serializeConfig } from '@/config/ConfigRepository';

function linkFieldList(items: Array<Record<string, unknown>>): FieldListBlock {
  return {
    blockId: 'blk_fl',
    kind: 'fieldList',
    breakInside: 'auto',
    items: items as unknown as FieldListBlock['items'],
    showLabels: true,
    hideEmptyItems: false,
  };
}

function configWithBlocks(blocks: DocBlock[]): CardViewConfig {
  const config = createDefaultConfig({ viewId: 'v1', tableId: 'tbl_main' });
  return { ...config, detail: { ...config.detail, doc: { ...config.detail.doc, blocks } } };
}

describe('保存 → 重载 → 关联列配置仍在（迁移透传证据）', () => {
  it('⭐ 往返：linkColumns / linkRowLimit 逐字段存活（且 schemaVersion 不变）', () => {
    const blocks: DocBlock[] = [
      linkFieldList([
        { fieldId: 'f_link', linkColumns: ['tf_amount', 'tf_name'], linkRowLimit: 5 },
      ]),
    ];
    const config = configWithBlocks(blocks);

    const serialized = serializeConfig(config, 1700000000000);
    expect(serialized.ok).toBe(true);

    const parsed = deserializeEnvelope(serialized.raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.envelope).not.toBeNull();

    const reloaded = migrate(parsed.envelope?.payload, parsed.envelope?.schemaVersion ?? 0);
    const item = (reloaded.detail.doc.blocks[0] as FieldListBlock).items[0];
    // 逐字段具体值：顺序敏感（linkColumns 是「顺序即列顺序」的语义载体）
    expect(item.linkColumns).toEqual(['tf_amount', 'tf_name']);
    expect(item.linkRowLimit).toBe(5);
    // 不升版
    expect(reloaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(reloaded.schemaVersion).toBe(2);
  });

  it('字符串化的最终 payload 里确实带上了这两个键（不是靠内存引用蒙混）', () => {
    const config = configWithBlocks([
      linkFieldList([{ fieldId: 'f_link', linkColumns: ['tf_note'], linkRowLimit: 8 }]),
    ]);
    const serialized = serializeConfig(config, 1);
    const parsed = JSON.parse(serialized.raw) as { payload: CardViewConfig };
    const item = (parsed.payload.detail.doc.blocks[0] as FieldListBlock).items[0];
    expect(item.linkColumns).toEqual(['tf_note']);
    expect(item.linkRowLimit).toBe(8);
  });

  it('assertCardViewConfig 直接调用：blocks 内的关联列配置原样存活', () => {
    const block = linkFieldList([{ fieldId: 'f_link', linkColumns: ['tf_name'], linkRowLimit: 3 }]);
    const out = assertCardViewConfig({ detail: { doc: { blocks: [block] } } });
    const item = (out.detail.doc.blocks[0] as FieldListBlock).items[0];
    expect(item.linkColumns).toEqual(['tf_name']);
    expect(item.linkRowLimit).toBe(3);
  });
});

describe('老配置零回归（缺省 → 行为与 v1.5.0 逐字一致）', () => {
  it('⭐ 无 linkColumns / linkRowLimit 的老配置迁移后逐字不变（不含新增键）', () => {
    const legacyBlocks: DocBlock[] = [linkFieldList([{ fieldId: 'f_link' }, { fieldId: 'f_text' }])];
    const legacy = configWithBlocks(legacyBlocks);
    const migrated = migrate(legacy, CURRENT_SCHEMA_VERSION);

    // 深等价：老的 blocks 结构不被改写
    expect(migrated.detail.doc.blocks).toEqual(legacyBlocks);
    const item = (migrated.detail.doc.blocks[0] as FieldListBlock).items[0];
    expect('linkColumns' in item).toBe(false);
    expect('linkRowLimit' in item).toBe(false);
  });
});

describe('非法值：迁移层不崩、原样透传（收敛在解析层）', () => {
  it('非数组 linkColumns / 字符串 linkRowLimit → 迁移不抛，且原样保留', () => {
    const block = linkFieldList([
      { fieldId: 'f_link', linkColumns: 'oops' as unknown as string[], linkRowLimit: 'x' as unknown as number },
    ]);
    const migrated = migrate(configWithBlocks([block]), CURRENT_SCHEMA_VERSION);
    const item = (migrated.detail.doc.blocks[0] as FieldListBlock).items[0];
    // 迁移层职责 = 「保真透传」，不做值净化；净化交 `collectLinkFieldConfigs`（见上）
    expect(item.linkColumns).toBe('oops');
    expect(item.linkRowLimit).toBe('x');
  });

  it('blocks 非数组 → 迁移为 []（既有语义不变）', () => {
    const out = assertCardViewConfig({ detail: { doc: { blocks: 'not-an-array' } } });
    expect(out.detail.doc.blocks).toEqual([]);
  });
});
