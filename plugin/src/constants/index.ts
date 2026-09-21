/**
 * 应用级常量与枚举的集中出口（§6 分层：常量不依赖任何上层）。
 */
export * from './keys';
export * from './paper';

/** 插件展示名 */
export const APP_NAME = '卡片视图';

/** 插件版本（写入配置 envelope.pluginVersion，与 schemaVersion 解耦） */
export const PLUGIN_VERSION = '0.1.0';

/** 数据分页默认页大小（官方上限 200，设计文档 §13.1 首批 100 亦可） */
export const DEFAULT_PAGE_SIZE = 200;

/** 分页页大小硬上限（官方限制） */
export const MAX_PAGE_SIZE = 200;

/** 卡片网格首批渲染条数（M1 只取首批 1 页，M2 由虚拟滚动增量加载接管） */
export const FIRST_BATCH_PAGE_SIZE = 200;

/** 默认视图选择器常量：无选中项时为空串 */
export const EMPTY_ID = '';

/** 卡片排版模板 id 枚举 */
export const CARD_TEMPLATE_IDS = ['standard', 'compact', 'cover', 'list', 'custom'] as const;
export type CardTemplateId = (typeof CARD_TEMPLATE_IDS)[number];

/** 卡片槽位 id 枚举 */
export const SLOT_IDS = ['title', 'subtitle', 'attributes', 'footer'] as const;
export type SlotIdValue = (typeof SLOT_IDS)[number];

/** 文档区块类型枚举（与 §4.3 DocBlockKind 对齐，供编辑器/目录使用） */
export const DOC_BLOCK_KINDS = [
  'heading',
  'paragraph',
  'keyValueGrid',
  'fieldList',
  'badgeRow',
  'image',
  'table',
  'richText',
  'divider',
  'spacer',
  'pageBreak',
  'metaFooter',
] as const;
export type DocBlockKindValue = (typeof DOC_BLOCK_KINDS)[number];

/** 默认文档模板使用的 A4 页边距（px @96dpi ≈ 19mm） */
export const DEFAULT_PAGE_MARGIN_PX = 72;

/** keyValueGrid 默认列数 */
export const DEFAULT_KEY_VALUE_COLUMNS = 2;

/** 默认 A4 模板中 keyValueGrid 承载的 P0 字段数量 */
export const DEFAULT_GRID_FIELD_COUNT = 6;

/** 文档态默认最大标签数等安全性上限 */
export const MULTI_SELECT_PREVIEW_LIMIT = 3;
