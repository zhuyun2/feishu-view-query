/**
 * 配置数据模型 v2 全量定义（设计文档 §4，逐字落地）。
 * 纯类型模块：不含运行时依赖，可被任意层引用。
 */
import type { FilterConfig } from '@/filter/types';

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
  /**
   * ⭐ 字段筛选（§22，纯增）。
   *
   * 声明为**可选**：`schemaVersion` 保持 2 不升版（§22.2.3 裁定：升 v3 会让旧端
   * `unsupportedNewer` 整体只读，代价远大于「旧端仅丢一个可选字段」）。
   * 缺省（旧配置）语义 = **不筛**，由 `assertCardViewConfig()` 补 `defaultFilterConfig()`。
   */
  filter?: FilterConfig;
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

/**
 * 导入的 docx 模板（「docx 模板导入」存储层的持久化载体）。
 *
 * ⭐ **模板字节不再塞进主配置**（1MB 模板 → base64 约 1.37MB；若留在主配置里，任何一次
 * 配置保存都要搬运这 1.4MB，任一次失败会连累用户本次全部编辑一起丢）。现在主配置只留
 * **引用 + 完整性**（`templateId` / `chunkCount` / `chunkSize` / `contentHash`），
 * 字节本体分块存进**专用 key** `cbv:tpl:{viewId}:{templateId}:{index}`（见 `doc/template/storage.ts`）。
 *
 * ⚠️ `bytesBase64` 保留为**遗留可选字段**：旧配置里只有它、没有分块引用 →
 * 读取时仍按内联 base64 解码（保证老配置不失效）。新上传**不再写它**。
 */
export interface ImportedDocx {
  /** 原始文件名（仅用于展示，不参与渲染） */
  fileName: string;
  /** 原始字节数（用于校验「是否被截断/篡改」+ 展示，非 base64 长度） */
  sizeBytes: number;
  /** 导入时间戳（ms） */
  uploadedAt: number;
  /**
   * ⚠️ 遗留内联 base64（≈ 4/3 膨胀）。
   * 旧配置可能只有该字段；**新上传不再写**（改存分块）。读取时若存在则优先按内联解码。
   */
  bytesBase64?: string;
  /** 本次上传的标识（新上传生成新 id；分块 key 用它命名空间） */
  templateId?: string;
  /** 分块数量 */
  chunkCount?: number;
  /** 每块 base64 **字符数**（非字节数） */
  chunkSize?: number;
  /** 内容哈希（对原始字节计算；读回时校验完整性） */
  contentHash?: string;
}

/** 详情区配置：D3 固定为文档式 */
export interface DetailConfig {
  mode: 'document'; // 预留扩展位，当前恒为 document
  fieldScope: 'all' | 'placed' | 'custom';
  customFieldIds?: string[];
  /** 抽屉外观与预览控制（P0-15） */
  drawer: DrawerConfig;
  /** 文档模板（P0-11 / P0-12） */
  doc: DocTemplate;
  /**
   * ⭐ 文档来源（「docx 模板导入」纯增字段，**不升 schemaVersion**）：
   * - `'blocks'` = 用可视化编辑器排的区块模板（**默认**；字段缺省亦按此处理）；
   * - `'imported'` = 导入的 docx 模板（此时看 {@link ImportedDocx}）。
   *
   * 为什么可选且不升版：升版会让旧版插件读到 `unsupportedNewer` 从而**整体只读**，
   * 代价远大于「旧端仅丢两个可选字段」。旧配置缺省 → 按 `'blocks'` 处理即可
   * （由 `doc/template/storage.resolveDocSource` 统一兜底）。
   */
  docSource?: 'blocks' | 'imported';
  /** 导入的 docx 模板（仅在 `docSource === 'imported'` 时有意义） */
  importedDocx?: ImportedDocx;
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
  /**
   * ⚠️ `header` / `footer` / `showPageNumber` / `pageNumberFormat` / `headerFooterScope`
   * **有意保留，不是死代码**（2026-09-21 设计变更）：详情已改为「单张连续长页」，编辑器不再提供
   * 页眉/页码/页脚编辑控件，详情也不再渲染它们；但**已保存的历史配置**里存在这些字段，
   * 保留字段才能向后兼容（删除字段会让老配置的迁移 / 反序列化失败）。
   * 编辑器仅**不再编辑 / 不再渲染**它们，`PageSetupPanel` 见注释。
   */
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

/**
 * ⭐ 需求 2 · 第二阶段：**文档字段绑定项**上的「关联记录显示列」配置（纯增，不升 `schemaVersion`）。
 *
 * 仅对绑定到**关联字段**（`Link` 18 / `DuplexLink` 21）的绑定项有意义：
 * - `linkColumns` 的元素是**目标表**字段 id，**数组顺序即列显示顺序**；
 * - 缺省（老配置 / 未配置）→ 默认列规则（主字段 + 前 3 个可用字段），行为与 v1.5.0 **逐字一致**（零回归）。
 *
 * ⚠️ **两个字段随 `detail.doc.blocks` 逐字透传**：`config/migrations.ts` 的
 *   `assertCardViewConfig()` 在透传 `blocks` 时**原样搬运**（`blocks:` 分支），故**无需**
 *   额外的透传代码；反之若将来有人在该分支做「逐字段重建」，这两个字段就会被静默抹掉
 *   （= 「用户配了列、重开就没了」）。往返用例见 `migrations.linkColumns.test.ts`。
 */
export interface LinkTableColumnConfig {
  /** 目标表字段 id 列表；顺序即列顺序。非数组 / 空数组 / 全空串 → 视为未配置（回退默认列）。 */
  linkColumns?: string[];
  /** 关联记录展示的最大行数（1~50）；缺省 20，越界回退默认并告警。 */
  linkRowLimit?: number;
}

/** 字段绑定项（键值网格行 / 字段清单项）：在「一个字段引用」之上叠加关联列配置。 */
export interface FieldBindingItem extends LinkTableColumnConfig {
  fieldId: string;
  labelOverride?: string;
}

/** 3. 键值网格 */
export interface KeyValueGridBlock extends DocBlockBase {
  kind: 'keyValueGrid';
  columns: 1 | 2 | 3 | 4;
  rows: FieldBindingItem[];
  labelWidthPx: number; // 标签列宽
  showColon: boolean;
  zebra: boolean; // 斑马纹
  hideEmptyRows: boolean;
}

/** 4. 字段清单（纵向） */
export interface FieldListBlock extends DocBlockBase {
  kind: 'fieldList';
  items: FieldBindingItem[];
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
export interface TableBlock extends DocBlockBase, LinkTableColumnConfig {
  kind: 'table';
  /** 列定义：可绑定字段，也可用静态表头 */
  columns: Array<{
    fieldId: string;
    titleOverride?: string;
    widthPx?: number;
    align?: 'left' | 'center' | 'right';
  }>;
  /**
   * 行来源：关联记录 / 多选展开 / 单条记录字段（当前记录）。
   *
   * ⭐ `rowSource = linkedRecords` 时，`columns` **不再决定**展示列（列来自**目标表**）；
   * 展示列改由 {@link LinkTableColumnConfig.linkColumns}（目标表字段 id，顺序即列顺序）决定，
   * 与 `fieldList` / `keyValueGrid` 的关联字段**共用同一套列解析**（见 `doc/linkTable.ts`）。
   */
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
