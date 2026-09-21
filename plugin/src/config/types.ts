/**
 * 配置数据模型 v2 全量定义（设计文档 §4，逐字落地）。
 * 纯类型模块：不含运行时依赖，可被任意层引用。
 */

/** 当前配置结构版本。v1 → v2：新增 doc 分支（文档式详情）。只增不改。 */
export const CURRENT_SCHEMA_VERSION = 2;

/* ===================== 4.1 配置根对象 ===================== */

export interface CardViewConfig {
  schemaVersion: number; // = 2
  meta: ConfigMeta;
  card: CardLayoutConfig; // 卡片视图排版（原 layout，重命名以免与 doc 混淆）
  detail: DetailConfig; // 详情配置（含 doc 文档模板）
  theme: StyleTheme;
  density: DensityConfig;
  highlightRules: HighlightRule[];
}

export interface ConfigEnvelope {
  schemaVersion: number;
  pluginVersion: string;
  writtenAt: number;
  checksum: string;
  payload: CardViewConfig;
}

export interface ConfigMeta {
  configId: string; // = viewId
  tableId: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  templateId: string; // 来源模板，用于 D4「从模板重配」
  /** D4：本配置是否由「复制视图」首次打开时从模板生成 */
  provisionedFromTemplate?: boolean;
}

/* ===================== 4.2 卡片排版（沿用 v1） ===================== */

export type SlotId = 'title' | 'subtitle' | 'attributes' | 'footer';

export interface CardLayoutConfig {
  templateId: 'standard' | 'compact' | 'cover' | 'list' | 'custom';
  slots: Record<SlotId, SlotConfig>;
  cardAspect: 'auto' | 'square' | 'fixed';
  /**
   * R4 冻结：卡片**不显示封面图**。本字段为扩展位，恒为 `false`（或缺省）；
   * `cover` 模板的「大图」由**属性区首图**体现，而非独立封面槽位。见 `config/presets.ts` 注释。
   */
  showCoverImage?: boolean;
}

export interface SlotConfig {
  id: SlotId;
  visible: boolean;
  collapsibleWhenEmpty: boolean;
  direction: 'row' | 'column';
  separator: string; // 默认 ' · '
  maxItemsPerCard: number;
  placements: FieldPlacement[]; // 槽位内字段落位（有序）
}

export interface FieldPlacement {
  placementId: string;
  fieldId: string;
  order: number;
  label?: string;
  labelVisible: boolean;
  display: FieldDisplayOptions;
}

export interface FieldDisplayOptions {
  maxLines: number;
  truncate: 'ellipsis' | 'clip' | 'none';
  maxItems: number;
  prefix?: string;
  suffix?: string;
  numberFormat?: NumberFormatOptions;
  dateFormat?: string;
  hideWhenEmpty: boolean;
}

export interface NumberFormatOptions {
  useGrouping: boolean;
  decimals?: number;
  unit?: string;
}

/* ===================== 4.3 文档排版模型（新增） ===================== */

/** 详情区配置：D3 固定为文档式 */
export interface DetailConfig {
  mode: 'document'; // 预留扩展位，当前恒为 document
  fieldScope: 'all' | 'placed' | 'custom';
  customFieldIds?: string[];
  /** 抽屉外观与预览控制（P0-15） */
  drawer: DrawerConfig;
  /** 文档模板（P0-11 / P0-12） */
  doc: DocTemplate;
}

export interface DrawerConfig {
  defaultWidthPx: number; // 默认 860
  maximizable: boolean; // 支持全屏
  defaultZoom: number; // 1 = 100%
  zoomPresets: number[]; // [0.5, 0.75, 1, 1.25, 1.5]
  defaultFitToWidth: boolean; // 默认「适应宽度」
}

/** ===== 文档模板 ===== */
export interface DocTemplate {
  templateId: string;
  pageSetup: PageSetup;
  theme: DocTheme;
  /** 有序区块流：文档渲染的原子序列 */
  blocks: DocBlock[];
}

export interface PageSetup {
  paper: 'A4' | 'A5' | 'Letter';
  orientation: 'portrait' | 'landscape';
  /** 页边距，单位 px（@96dpi 基准；UI 层以 mm 呈现） */
  margin: { top: number; right: number; bottom: number; left: number };
  header?: HeaderFooterConfig;
  footer?: HeaderFooterConfig;
  showPageNumber: boolean;
  pageNumberFormat: 'n' | 'n/total' | 'page-n'; // 1 / 1/3 / 第1页
  headerFooterScope: 'first' | 'all';
}

export interface HeaderFooterConfig {
  enabled: boolean;
  /** 静态文本与字段占位符混排，如 "{记录标题}" 或 "客户档案 · 生成于 {修改时间}" */
  content: string;
  align: 'left' | 'center' | 'right';
  fontSize: number;
  color: string;
  showBorder: boolean; // 页眉/页脚与正文之间的分隔线
}

export interface DocTheme {
  fontFamily: string; // 默认 '"PingFang SC","Microsoft YaHei",sans-serif'
  baseFontSize: number; // px，默认 14
  lineHeight: number; // 默认 1.6
  headingScale: [number, number, number]; // h1/h2/h3 相对倍率，默认 [1.6, 1.35, 1.15]
  headingWeight: 400 | 500 | 600 | 700;
  blockSpacing: number; // 区块间距 px，默认 12
  paragraphIndent: number; // 首行缩进 px
  primaryColor: string;
  textColor: string;
  mutedColor: string;
  dividerColor: string;
}

/** ===== 区块 ===== */
export type DocBlockKind =
  | 'heading'
  | 'paragraph'
  | 'keyValueGrid'
  | 'fieldList'
  | 'badgeRow'
  | 'image'
  | 'table'
  | 'richText'
  | 'divider'
  | 'spacer'
  | 'pageBreak'
  | 'metaFooter';

export type BreakInside = 'auto' | 'avoid';

export interface DocBlockStyle {
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700;
  color?: string;
  backgroundColor?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  marginTop?: number;
  marginBottom?: number;
  paddingX?: number;
  paddingY?: number;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
}

interface DocBlockBase {
  blockId: string;
  kind: DocBlockKind;
  /** 用于区块分组/条件显隐；复用 highlight 的 RuleCondition */
  visibleWhen?: RuleCondition | null;
  style?: DocBlockStyle;
  /** 分页行为：avoid = 整体不跨页；auto = 允许按行切分 */
  breakInside: BreakInside;
  /** 区块内部标识，供 UI 列表展示（非用户可见文案时用 kind 的中文名） */
  note?: string;
}

/** 1. 标题 */
export interface HeadingBlock extends DocBlockBase {
  kind: 'heading';
  level: 1 | 2 | 3;
  /** 内容来源：静态文本 或 绑定字段 */
  source: { type: 'static'; text: string } | { type: 'field'; fieldId: string };
  /** 为 true 时，字段为空则整块不渲染 */
  hideWhenEmpty: boolean;
}

/** 2. 段落 */
export interface ParagraphBlock extends DocBlockBase {
  kind: 'paragraph';
  fieldId: string;
  /** 保留换行 / 折叠空白 */
  preserveLineBreaks: boolean;
  maxLines?: number; // 未设 = 不限（文档内建议不限，靠分页）
  hideWhenEmpty: boolean;
}

/** 3. 键值网格 */
export interface KeyValueGridBlock extends DocBlockBase {
  kind: 'keyValueGrid';
  columns: 1 | 2 | 3 | 4;
  rows: Array<{ fieldId: string; labelOverride?: string }>;
  labelWidthPx: number; // 标签列宽
  showColon: boolean;
  zebra: boolean; // 斑马纹
  hideEmptyRows: boolean;
}

/** 4. 字段清单（纵向） */
export interface FieldListBlock extends DocBlockBase {
  kind: 'fieldList';
  items: Array<{ fieldId: string; labelOverride?: string }>;
  showLabels: boolean;
  hideEmptyItems: boolean;
}

/** 5. 标签行 */
export interface BadgeRowBlock extends DocBlockBase {
  kind: 'badgeRow';
  fieldIds: string[];
  maxItems: number;
  showLabels: boolean;
}

/** 6. 图片 */
export interface ImageBlock extends DocBlockBase {
  kind: 'image';
  fieldId: string; // 附件字段
  mode: 'first' | 'all' | 'index';
  index: number;
  width: number; // px
  height?: number; // 未设 = 按比例
  align: 'left' | 'center' | 'right';
  caption?: string;
  hideWhenEmpty: boolean;
}

/** 7. 表格 */
export interface TableBlock extends DocBlockBase {
  kind: 'table';
  /** 列定义：可绑定字段，也可用静态表头 */
  columns: Array<{
    fieldId: string;
    titleOverride?: string;
    widthPx?: number;
    align?: 'left' | 'center' | 'right';
  }>;
  /** 行来源：关联记录 / 多选展开 / 单条记录字段（当前记录） */
  rowSource: { type: 'linkedRecords'; fieldId: string } | { type: 'currentRecord' };
  showHeader: boolean;
  zebra: boolean;
  maxRows?: number;
}

/** 8. 静态富文本 */
export interface RichTextBlock extends DocBlockBase {
  kind: 'richText';
  /** MVP 支持 markdown 子集：**粗体** / *斜体* / 换行 / - 列表 */
  markdown: string;
}

/**
 * 9. 分隔线
 *
 * 架构裁定 Q4：线型字段命名为 `borderStyle`（`'solid' | 'dashed' | 'dotted'`），
 * 避免与基类 `DocBlockBase.style`（DocBlockStyle：字号/颜色/边距等通用样式）撞名。
 * 分隔线颜色沿用基类 `style.color`，线宽/线型由本区块的 `thickness` / `borderStyle` 决定。
 */
export interface DividerBlock extends DocBlockBase {
  kind: 'divider';
  /** 线宽（px） */
  thickness: number;
  /** 线型 */
  borderStyle: 'solid' | 'dashed' | 'dotted';
}

/** 10. 间距 */
export interface SpacerBlock extends DocBlockBase {
  kind: 'spacer';
  height: number;
}

/** 11. 强制分页 */
export interface PageBreakBlock extends DocBlockBase {
  kind: 'pageBreak';
}

/** 12. 页脚元信息 */
export interface MetaFooterBlock extends DocBlockBase {
  kind: 'metaFooter';
  fields: Array<'createdUser' | 'createdTime' | 'modifiedUser' | 'modifiedTime' | 'recordId'>;
  separator: string;
  fontSize: number;
  muted: boolean;
}

export type DocBlock =
  | HeadingBlock
  | ParagraphBlock
  | KeyValueGridBlock
  | FieldListBlock
  | BadgeRowBlock
  | ImageBlock
  | TableBlock
  | RichTextBlock
  | DividerBlock
  | SpacerBlock
  | PageBreakBlock
  | MetaFooterBlock;

/* ===================== 4.4 条件高亮（v1 沿用，D5 边界） ===================== */

export interface HighlightRule {
  ruleId: string;
  name: string;
  enabled: boolean;
  target: HighlightTarget;
  condition: RuleCondition; // 单层 and/or
  style: HighlightStyle;
  priority: number;
}

export type HighlightTarget =
  | { kind: 'cardBorder' }
  | { kind: 'field'; fieldId: string }
  | { kind: 'badge'; fieldId: string };

/** 单层组合，不支持嵌套（D5） */
export interface RuleCondition {
  logic: 'and' | 'or';
  items: RuleExpr[];
}

export interface RuleExpr {
  fieldId: string;
  operator: RuleOperator;
  value?: unknown;
}

export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'before'
  | 'after';

export interface HighlightStyle {
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
}

export interface StyleTheme {
  preset: string;
  primaryColor: string;
  backgroundColor?: string;
  borderColor?: string;
  borderRadius: number;
  shadowLevel: 0 | 1 | 2 | 3;
  fontScale: number; // 0.85 ~ 1.3
  titleWeight: 400 | 500 | 600 | 700;
}

export interface DensityConfig {
  /** R3 冻结：三档密度预设（紧凑 / 标准 / 宽松） */
  preset?: 'compact' | 'standard' | 'comfortable';
  cardMinWidth: number;
  columnsMode: 'auto' | 'fixed';
  fixedColumns?: number;
  gap: number;
  padding: number;
  maxCardHeight: number;
  /**
   * R3 冻结：属性区默认最多**行数**（紧凑 2 / 标准 3 / 宽松 5）；
   * 超出按 `SlotConfig.maxItemsPerCard` 截断并显示 `+n`。
   */
  attributesMaxRows?: number;
}

/* ===================== 4.5 迁移策略（v1 → v2） ===================== */

export type ConfigMigration = (input: unknown, fromVersion: number) => unknown;
