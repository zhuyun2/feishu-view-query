/**
 * 配置迁移（设计文档 §4.5 / §15）。
 *
 * 兼容承诺：高版本**必须**能读所有历史 `schemaVersion`；迁移函数只增不改。
 * 失败语义：`migrate()` 抛出 `MigrationError`，由配置仓储捕获 → 回退默认模板 + 备份原值。
 */
import { CURRENT_SCHEMA_VERSION, type CardViewConfig, type ConfigMigration } from './types';
import {
  createDefaultConfig,
  defaultCardLayout,
  defaultDensity,
  defaultDetailConfig,
  defaultDocTheme,
  defaultDrawerConfig,
} from './defaults';
import type {
  CardLayoutConfig,
  DensityConfig,
  DetailConfig,
  DrawerConfig,
  HighlightRule,
  SlotConfig,
  SlotId,
  StyleTheme,
} from './types';

/** 迁移失败（不可恢复的输入结构） */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 卡片槽位深合并（避免历史配置缺槽位导致渲染崩溃） */
function mergeSlots(
  partial: unknown,
  base: Record<SlotId, SlotConfig>,
): Record<SlotId, SlotConfig> {
  const source = isPlainObject(partial) ? (partial as Partial<Record<SlotId, unknown>>) : {};
  const mergeOne = (id: SlotId): SlotConfig => {
    const candidate = source[id];
    const extra = isPlainObject(candidate) ? (candidate as Partial<SlotConfig>) : {};
    return {
      ...base[id],
      ...extra,
      id,
      placements: Array.isArray(extra.placements) ? extra.placements : base[id].placements,
    };
  };
  return {
    title: mergeOne('title'),
    subtitle: mergeOne('subtitle'),
    attributes: mergeOne('attributes'),
    footer: mergeOne('footer'),
  };
}

/**
 * 迁移注册表。key = 起始版本号，值 = 把该版本升到「下一版」的函数。
 * 只增不改；新增版本时追加一项，切勿修改历史项。
 */
export const MIGRATIONS: Record<number, ConfigMigration> = {
  /** v1 → v2：`layout` → `card`；新增 `detail.doc`（默认 A4 文档模板） */
  1: (old) => {
    if (!isPlainObject(old)) throw new MigrationError('v1 配置不是对象，无法迁移');
    const source = old;
    const migrated: Record<string, unknown> = {
      ...source,
      schemaVersion: 2,
      card: isPlainObject(source.card)
        ? source.card
        : isPlainObject(source.layout)
          ? source.layout
          : defaultCardLayout(),
      detail: isPlainObject(source.detail) ? source.detail : defaultDetailConfig(),
    };
    delete migrated.layout; // 清理旧字段
    return migrated;
  },
};

/** 是否需要在读取时迁移（当前版本更旧） */
export function needsMigration(fromVersion: number): boolean {
  return Number.isFinite(fromVersion) && fromVersion < CURRENT_SCHEMA_VERSION;
}

/** 版本是否受支持（更高版本 → unsupportedNewer 只读模式） */
export function isSupportedSchema(version: number): boolean {
  return Number.isFinite(version) && version <= CURRENT_SCHEMA_VERSION;
}

/**
 * 逐级升级到当前版本，并补齐缺失分支 / 丢弃未知顶层字段。
 * @throws MigrationError 输入不可恢复（非对象 / 缺失迁移函数 / 升级后仍非对象）
 */
export function migrate(raw: unknown, fromVersion: number): CardViewConfig {
  if (!isPlainObject(raw)) {
    throw new MigrationError('配置内容不是对象');
  }
  let current: Record<string, unknown> = { ...raw };
  let version = Number.isFinite(fromVersion) ? fromVersion : CURRENT_SCHEMA_VERSION;

  let guard = 0;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new MigrationError(`缺少 v${version} → v${version + 1} 的迁移函数`);
    }
    const next = migration(current, version);
    if (!isPlainObject(next)) {
      throw new MigrationError(`v${version} 迁移函数返回了非对象`);
    }
    current = next;
    const reported = typeof current.schemaVersion === 'number' ? current.schemaVersion : version + 1;
    version = reported > version ? reported : version + 1;
    guard += 1;
    if (guard > 32) throw new MigrationError('迁移链出现循环');
  }

  return assertCardViewConfig(current);
}

/**
 * 结构补全：把任意对象收敛为合法的 `CardViewConfig`。
 * - 缺失分支 → 用默认值填充（兼容「空配置 / 部分配置」）；
 * - 未知顶层字段 → 丢弃（兼容「读新降级」）；
 * - 已存在分支做浅合并，尊重其中已有的值。
 */
export function assertCardViewConfig(raw: unknown): CardViewConfig {
  if (!isPlainObject(raw)) throw new MigrationError('配置内容不是对象');
  const base = createDefaultConfig({ viewId: '', tableId: '' });

  const metaSource = isPlainObject(raw.meta) ? raw.meta : {};
  const cardSource = isPlainObject(raw.card) ? (raw.card as unknown as CardLayoutConfig) : null;
  const detailSource = isPlainObject(raw.detail) ? (raw.detail as unknown as DetailConfig) : null;
  const themeSource = isPlainObject(raw.theme) ? (raw.theme as unknown as StyleTheme) : null;
  const densitySource = isPlainObject(raw.density) ? (raw.density as unknown as DensityConfig) : null;

  const highlightRules: HighlightRule[] = Array.isArray(raw.highlightRules)
    ? (raw.highlightRules.filter(isPlainObject) as unknown as HighlightRule[])
    : [];

  const card: CardLayoutConfig = cardSource
    ? {
        templateId: cardSource.templateId ?? base.card.templateId,
        cardAspect: cardSource.cardAspect ?? base.card.cardAspect,
        slots: mergeSlots(cardSource.slots, base.card.slots),
      }
    : base.card;

  const drawerSource: Partial<DrawerConfig> = isPlainObject(detailSource?.drawer)
    ? (detailSource.drawer as unknown as Partial<DrawerConfig>)
    : {};

  const detail: DetailConfig = detailSource
    ? {
        mode: 'document',
        fieldScope: detailSource.fieldScope ?? base.detail.fieldScope,
        customFieldIds: detailSource.customFieldIds,
        drawer: { ...defaultDrawerConfig(), ...drawerSource },
        doc: isPlainObject(detailSource.doc)
          ? {
              templateId: detailSource.doc.templateId ?? 'a4-default',
              pageSetup: { ...base.detail.doc.pageSetup, ...(detailSource.doc.pageSetup ?? {}) },
              theme: { ...defaultDocTheme(), ...(detailSource.doc.theme ?? {}) },
              blocks: Array.isArray(detailSource.doc.blocks) ? detailSource.doc.blocks : [],
            }
          : base.detail.doc,
      }
    : defaultDetailConfig();

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      configId: typeof metaSource.configId === 'string' ? metaSource.configId : base.meta.configId,
      tableId: typeof metaSource.tableId === 'string' ? metaSource.tableId : base.meta.tableId,
      createdAt: typeof metaSource.createdAt === 'number' ? metaSource.createdAt : base.meta.createdAt,
      updatedAt: typeof metaSource.updatedAt === 'number' ? metaSource.updatedAt : base.meta.updatedAt,
      updatedBy: typeof metaSource.updatedBy === 'string' ? metaSource.updatedBy : base.meta.updatedBy,
      templateId: typeof metaSource.templateId === 'string' ? metaSource.templateId : base.meta.templateId,
      provisionedFromTemplate:
        typeof metaSource.provisionedFromTemplate === 'boolean'
          ? metaSource.provisionedFromTemplate
          : undefined,
    },
    card,
    detail,
    theme: themeSource ? { ...base.theme, ...themeSource } : base.theme,
    density: densitySource ? { ...defaultDensity(), ...densitySource } : base.density,
    highlightRules,
  };
}
