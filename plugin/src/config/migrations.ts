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
  ImportedDocx,
  SlotConfig,
  SlotId,
  StyleTheme,
} from './types';
import { sanitizeFilterConfig } from '@/filter/sanitize';

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

/**
 * ⭐ 纯增（「docx 模板导入」存储层）：净化导入的 docx 模板。
 *
 * `assertCardViewConfig()` 会**按字段逐个重建** `detail`（未知字段被丢弃，是「读新降级」
 * 的既有语义）。若不在此显式搬运 `docSource` / `importedDocx`，导入的 docx 模板会在
 * **每次读取时被静默抹掉**，整个功能失效 —— 故这里是最小且必要的透传点。
 *
 * 结构净化（不抛错）：非对象 → undefined；各字段类型不符 → 归为安全默认值。
 *
 * ⭐ 1MB / 分块改造后：`importedDocx` 只承载**引用 + 完整性**（`templateId` / `chunkCount` /
 * `chunkSize` / `contentHash`）+ 遗留内联 `bytesBase64`。这里**逐个纯增透传**这些可选字段
 * （漏掉任一 → 重载后分块引用消失，模板在读取侧被判「缺失/无效」）。缺 `templateId` 等
 * 分块字段的旧配置**不崩**：可选字段一律「有则透传、无则不写」。
 */
function sanitizeImportedDocx(value: unknown): ImportedDocx | undefined {
  if (!isPlainObject(value)) return undefined;

  const readString = (key: string): string | undefined =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined;
  const readNumber = (key: string): number | undefined => {
    const raw = value[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  };

  const sanitized: ImportedDocx = {
    fileName: typeof value.fileName === 'string' ? value.fileName : '',
    sizeBytes:
      typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) ? value.sizeBytes : 0,
    uploadedAt:
      typeof value.uploadedAt === 'number' && Number.isFinite(value.uploadedAt)
        ? value.uploadedAt
        : 0,
  };

  // 可选字段：有则透传、无则不写（不制造 `undefined` 键，保持旧对象形态）。
  const bytesBase64 = readString('bytesBase64');
  if (bytesBase64 !== undefined) sanitized.bytesBase64 = bytesBase64;
  const templateId = readString('templateId');
  if (templateId !== undefined) sanitized.templateId = templateId;
  const chunkCount = readNumber('chunkCount');
  if (chunkCount !== undefined) sanitized.chunkCount = chunkCount;
  const chunkSize = readNumber('chunkSize');
  if (chunkSize !== undefined) sanitized.chunkSize = chunkSize;
  const contentHash = readString('contentHash');
  if (contentHash !== undefined) sanitized.contentHash = contentHash;

  return sanitized;
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

  // ⭐ 纯增（docx 模板导入）：透传导入来源与模板本体；缺省一律不写字段（= 按 'blocks' 处理）。
  const docSource: DetailConfig['docSource'] =
    detailSource && (detailSource.docSource === 'blocks' || detailSource.docSource === 'imported')
      ? detailSource.docSource
      : undefined;
  const importedDocx = detailSource ? sanitizeImportedDocx(detailSource.importedDocx) : undefined;

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
        // 仅在实际存在时写入：保持旧配置对象形态不变（纯增，不影响既有断言）。
        ...(docSource !== undefined ? { docSource } : {}),
        ...(importedDocx !== undefined ? { importedDocx } : {}),
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
    // §22：可选顶层字段，缺失/损坏一律净化为「不筛」；此处拿不到字段元数据，
    // 故只做结构/算子/值校验，字段存在性由上层拿到字段列表后二次净化。
    filter: sanitizeFilterConfig(raw.filter),
  };
}
