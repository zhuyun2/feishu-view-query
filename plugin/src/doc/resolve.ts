/**
 * 文档区块解析层（设计文档 §21.2 `doc/resolve.ts` / §21.3.3）。
 *
 * 数据流中的位置：
 *   `DocTemplate.blocks`（**只有字段绑定引用，没有实际值**）
 *     → 【本模块】resolveBlocks()
 *   → `ResolvedBlock[]`（填好实际值的区块序列）
 *     → pagination（测量 + 装箱）→ components/doc（渲染）
 *
 * ⭐ 本层的四条硬约束（违反即功能性缺陷）：
 *  1. **纯函数**：同样的输入必须得到同样的输出。不依赖 `Date.now()` / `Math.random()` /
 *     模块级可变状态（id 生成走 T03a 的 `createBlockIdFactory`，**不**用 `defaults.ts` 的
 *     `createId`——后者含随机与时间，会破坏确定性与高度缓存命中率）。
 *  2. **字段值一律经 `fields/normalize()` 归一化为 `NormalizedValue`**，渲染层再统一交给
 *     `registry.renderDoc(nv, DocRenderContext)`（§21.0 冻结口径）。本层**不做任何渲染**，
 *     也**绝不**另写一套字段格式化。
 *  3. **单向依赖**：`doc/` 不依赖 `pagination/`（分页层在下游）。本层只负责「值」，
 *     跨页片段信息（`fragmentIndex` / `fragmentsTotal`）来自分页层，由本模块导出的
 *     `buildDocRenderContext()` 组装进 `DocRenderContext` 后交给渲染器。
 *  4. **12 类区块全覆盖**（heading/paragraph/richText · keyValueGrid/fieldList/badgeRow ·
 *     image/table · divider/spacer/pageBreak · metaFooter）。§21 正文个别处写「11 类」是笔误，
 *     以 `DocBlockKind` 联合类型为准。少一类 = 该类区块无法呈现。
 *
 * 边界裁定（§21 未明确，2026-09-21 主理人裁定，实现时不得自行改写）：
 *  ─ 「空」的判定（`hideWhenEmpty` / `hideEmptyRows` / `hideEmptyItems`）：
 *      · 算空：`null` / `undefined` / `''`（含纯空白）/ `[]`
 *      · **不算空**：`0` / `false`
 *      · 理由：数字 0 与复选框「未勾选」都是用户**真实填写的有效值**，把它们当空隐藏掉会丢信息。
 *        因此本模块的判空**绝不可**写成 `if (!value)` —— `0` 和 `false` 会被误杀。
 *  ─ 失效字段引用（配置里的 `fieldId` 在当前视图字段中找不到）：
 *      · 单字段区块（heading/paragraph/image）→ **整块隐藏**；
 *      · 字段组区块（keyValueGrid/fieldList/badgeRow）→ **剔除该引用**，块本身保留；
 *      · table → **剔除该列**；若列全失效（无列可渲染）→ 整块隐藏。
 *      · 理由：用户删了字段后不能显示一个空标签/空列（会让用户以为自己配过这个字段）。
 */
import type {
  BadgeRowBlock,
  DocBlock,
  DocBlockKind,
  FieldDisplayOptions,
  FieldListBlock,
  HeadingBlock,
  ImageBlock,
  KeyValueGridBlock,
  MetaFooterBlock,
  ParagraphBlock,
  RichTextBlock,
  RuleCondition,
  SpacerBlock,
  StyleTheme,
  TableBlock,
  DividerBlock,
} from '@/config/types';
import type { DocRenderContext, FieldMetaLite, NormalizedItem, NormalizedValue } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import { normalize } from '@/fields/normalize';
import { getRecordFields, getRecordId } from '@/data/RecordDataSource';
import { isBlockVisible } from '@/highlight/ruleEngine';
import type { FieldMetaMap } from '@/highlight/ruleEngine';
import { checksumOf } from '@/utils/hash';
import { createBlockIdFactory } from './blockDefaults';
import type { BlockIdFactory, BlockIdFactoryHandle } from './blockDefaults';
import { parseMarkdown } from './markdown';
import type { MarkdownNode } from './markdown';

/* ===================== 输入抽象 ===================== */

/**
 * 记录侧最小抽象（与 `highlight/ruleEngine` 的 `RuleRecordLike` 同构，刻意不直接依赖 SDK 形态）。
 * `SdkRecord`（= SDK `IRecord`）结构上完全满足本接口，可直接传入。
 */
export interface DocRecordLike {
  recordId?: string;
  fields?: Record<string, unknown>;
}

/**
 * 条件显隐求值器（可注入，便于单测与未来替换规则引擎）。
 * 签名与 `highlight/ruleEngine.isBlockVisible` 一致。
 */
export type BlockVisibilityPredicate = (
  visibleWhen: RuleCondition | null | undefined,
  record: DocRecordLike | null | undefined,
  metas: FieldMetaMap,
) => boolean;

/** `resolveBlocks` 入参 */
export interface ResolveBlocksArgs {
  /** 区块模板序列（`DocTemplate.blocks`，只有字段绑定引用） */
  blocks: ReadonlyArray<DocBlock>;
  /** 当前记录（null/undefined → 所有字段按空处理） */
  record: SdkRecord | DocRecordLike | null | undefined;
  /** 当前视图字段元数据（顺序即字段池顺序） */
  fields: ReadonlyArray<FieldMetaLite>;
  /** 语言环境（参与 payloadHash，避免将来本地化格式化变化导致高度缓存不失效） */
  locale?: string;
  /** 条件显隐求值器；缺省复用 `highlight/ruleEngine.isBlockVisible` */
  isVisible?: BlockVisibilityPredicate;
  /** 区块 id 生成器；缺省 = 确定性工厂 `createBlockIdFactory(0)` */
  makeId?: BlockIdFactory;
}

/* ===================== 解析产物类型 ===================== */

/** 键值网格的一个已求值单元格 */
export interface ResolvedKeyValueRow {
  fieldId: string;
  /** = `labelOverride` ?? 字段中文名 */
  label: string;
  value: NormalizedValue;
}

/** 字段清单的一个已求值条目 */
export interface ResolvedFieldItem {
  fieldId: string;
  label: string;
  value: NormalizedValue;
}

/** 标签行的一个已求值标签（一个字段 → 若干个标签） */
export interface ResolvedBadge {
  fieldId: string;
  label: string;
  /** 标签文本（已按 maxItems 截断） */
  texts: string[];
  /** 与 texts 同序的色板序号（缺失处为 undefined 占位由渲染层回退） */
  colorIndexes: Array<number | undefined>;
  value: NormalizedValue;
}

/** 图片块解析出的一张图 */
export interface ResolvedImage {
  /** 附件名（alt / 加载失败兜底文案） */
  name: string;
  /** 可渲染地址（空串表示无可用地址，不会被产出） */
  url: string;
  /** 在「最终选中集合」中的序号（0 起，渲染层 key 用） */
  index: number;
}

/** 表格列 */
export interface ResolvedTableColumn {
  fieldId: string;
  /** = `titleOverride` ?? 字段中文名 */
  title: string;
  widthPx?: number;
  align?: 'left' | 'center' | 'right';
}

/** 表格行 */
export interface ResolvedTableRow {
  /** 行来源记录 id（currentRecord = 当前记录 id；linkedRecords = 被关联记录 id，取不到则空串） */
  recordId: string;
  /** 行首兜底文本（关联记录无字段可读时用于展示） */
  title: string;
  /** 列 fieldId → 归一化值（只含有效列） */
  cells: Record<string, NormalizedValue>;
}

/** 页脚元信息键（与 `MetaFooterBlock.fields` 同集） */
export type MetaFooterKey = 'createdUser' | 'createdTime' | 'modifiedUser' | 'modifiedTime' | 'recordId';

/** 页脚元信息的一项 */
export interface ResolvedMetaEntry {
  key: MetaFooterKey;
  label: string;
  text: string;
}

/* ---- 12 类区块的 payload（按 kind 判别；结构化数据，绝非 HTML 字符串） ---- */

export interface ResolvedHeadingPayload {
  kind: 'heading';
  level: 1 | 2 | 3;
  text: string;
  /** 字段来源时非空（静态来源无此字段） */
  fieldId?: string;
}

export interface ResolvedParagraphPayload {
  kind: 'paragraph';
  fieldId: string;
  text: string;
  /** 行序列（已按 `preserveLineBreaks` 与 `maxLines` 处理）；分页层按此切分 */
  lines: string[];
  preserveLineBreaks: boolean;
}

export interface ResolvedKeyValueGridPayload {
  kind: 'keyValueGrid';
  columns: 1 | 2 | 3 | 4;
  rows: ResolvedKeyValueRow[];
  labelWidthPx: number;
  showColon: boolean;
  zebra: boolean;
}

export interface ResolvedFieldListPayload {
  kind: 'fieldList';
  items: ResolvedFieldItem[];
  showLabels: boolean;
}

export interface ResolvedBadgeRowPayload {
  kind: 'badgeRow';
  badges: ResolvedBadge[];
  showLabels: boolean;
  maxItems: number;
}

export interface ResolvedImagePayload {
  kind: 'image';
  images: ResolvedImage[];
  width: number;
  height?: number;
  align: 'left' | 'center' | 'right';
  caption?: string;
}

export interface ResolvedTablePayload {
  kind: 'table';
  columns: ResolvedTableColumn[];
  rows: ResolvedTableRow[];
  showHeader: boolean;
  zebra: boolean;
}

export interface ResolvedRichTextPayload {
  kind: 'richText';
  /** markdown 子集解析出的安全节点（含 link / code 扩展） */
  nodes: MarkdownNode[];
}

export interface ResolvedDividerPayload {
  kind: 'divider';
  thickness: number;
  borderStyle: 'solid' | 'dashed' | 'dotted';
}

export interface ResolvedSpacerPayload {
  kind: 'spacer';
  height: number;
}

export interface ResolvedPageBreakPayload {
  kind: 'pageBreak';
}

export interface ResolvedMetaFooterPayload {
  kind: 'metaFooter';
  entries: ResolvedMetaEntry[];
  separator: string;
  fontSize: number;
  muted: boolean;
  /** entries 按 separator 拼接后的整行文本（渲染层可直接用） */
  text: string;
}

/** 12 类 payload 的判别联合 */
export type ResolvedPayload =
  | ResolvedHeadingPayload
  | ResolvedParagraphPayload
  | ResolvedKeyValueGridPayload
  | ResolvedFieldListPayload
  | ResolvedBadgeRowPayload
  | ResolvedImagePayload
  | ResolvedTablePayload
  | ResolvedRichTextPayload
  | ResolvedDividerPayload
  | ResolvedSpacerPayload
  | ResolvedPageBreakPayload
  | ResolvedMetaFooterPayload;

/** ⭐ 求值后的区块：渲染层（`components/doc`）与测量层都只消费它 */
export interface ResolvedBlock {
  /** 稳定、唯一的区块 id（模板缺失或重复时由确定性工厂补齐/去重） */
  blockId: string;
  /** 原始区块模板（渲染层取样式与布局配置） */
  block: DocBlock;
  kind: DocBlockKind;
  /** 该区块引用的**有效**字段 id（去重、保序；失效引用不含） */
  fieldIds: string[];
  /** 字段 id → 归一化值（只含有效引用） */
  values: Record<string, NormalizedValue>;
  /** 字段 id → 展示标签（= labelOverride ?? 字段中文名） */
  labels: Record<string, string>;
  /** 渲染/测量 payload */
  payload: ResolvedPayload;
  /** 图片块解析出的 URL（§21.3.3 `imageUrls`；仅 image 块非空，无地址的附件不计入） */
  imageUrls: string[];
  /** 表格块解析出的行（§21.3.3 `rows`；仅 table 块非空） */
  rows: ResolvedTableRow[];
  /** 渲染/测量所需的 payload hash（高度缓存键用，内容变则变） */
  payloadHash: string;
}

/* ===================== 判空（主理人裁定） ===================== */

/**
 * 「空」的判定（§21 未明确，2026-09-21 主理人裁定）：
 *   - **算空**：`null` / `undefined` / `''`（含纯空白字符串）/ `[]`（空数组）
 *   - **不算空**：`0` / `false`
 *
 * 理由：数字 0 与复选框「未勾选」都是用户**真实填写的有效值**，把它们当空隐藏掉会丢信息
 * （例如「折扣率 0%」「已完成 = 否」）。
 *
 * ⚠️ 因此本函数**绝不可**写成 `return !value;` —— `0` 与 `false` 会被误杀。
 * 该语义由 `resolve.test.ts` 的两条专项用例守卫（数字 0 / 复选框 false 各一条）。
 */
export function isEmptyDocValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/* ===================== 归一化值的小工具 ===================== */

/** 展示文本优先取 `display`（可能含千分位/日期格式），缺失回退 `text` */
function displayOf(nv: NormalizedValue): string {
  return nv.display !== '' ? nv.display : nv.text;
}

/** 空值（统一新造对象，避免共享引用被下游改写） */
function emptyNormalized(): NormalizedValue {
  return { kind: 'empty', text: '', display: '', isEmpty: true };
}

/** 标签文本序列：优先 `items[].text`，无 items 时用展示文本兜底（空值 → 空数组） */
function badgeTexts(nv: NormalizedValue): string[] {
  if (Array.isArray(nv.items) && nv.items.length > 0) {
    return nv.items.map((item) => item.text).filter((text) => text !== '');
  }
  const text = displayOf(nv);
  return text === '' ? [] : [text];
}

/** 与 `badgeTexts` 同序的色板序号 */
function badgeColorIndexes(nv: NormalizedValue): Array<number | undefined> {
  if (Array.isArray(nv.items) && nv.items.length > 0) {
    return nv.items.map((item) => item.colorIndex);
  }
  return [undefined];
}

/* ===================== 字段求值 ===================== */

/** 单个字段的求值结果 */
interface FieldEvaluation {
  meta: FieldMetaLite;
  nv: NormalizedValue;
  /** 空判定结果（已含「0 / false 不算空」裁定） */
  empty: boolean;
}

/** 字段 id → 元数据索引（保留首现顺序无关，纯查表） */
function indexFields(fields: ReadonlyArray<FieldMetaLite>): FieldMetaMap {
  const metas: FieldMetaMap = {};
  for (const field of fields) {
    if (field && typeof field.id === 'string' && field.id !== '') metas[field.id] = field;
  }
  return metas;
}

/**
 * 求一个字段的值。
 * @returns `null` = **失效字段引用**（fieldId 为空或不在字段表中）。
 */
function evaluateField(
  recordFields: Record<string, unknown>,
  fieldId: string,
  metas: FieldMetaMap,
): FieldEvaluation | null {
  if (typeof fieldId !== 'string' || fieldId === '') return null;
  const meta = metas[fieldId];
  if (!meta) return null;

  const raw = recordFields[fieldId];
  let nv: NormalizedValue;
  try {
    nv = normalize(raw, meta);
  } catch {
    // 单字段归一化异常不得拖垮整份文档（与 registry 的字段级隔离同口径）
    nv = emptyNormalized();
  }

  // 「空」= 原始值命中裁定口径 **或** 归一化结果自报为空（二者对 0/false 的判定一致：非空）
  const empty = isEmptyDocValue(raw) || nv.isEmpty === true;
  return { meta, nv, empty };
}

/* ===================== 内部解析上下文 ===================== */

interface ResolveContext {
  /** 原始记录（原样透传给规则引擎，null 时所有字段按空处理） */
  record: SdkRecord | DocRecordLike | null | undefined;
  recordFields: Record<string, unknown>;
  recordId: string;
  fields: ReadonlyArray<FieldMetaLite>;
  metas: FieldMetaMap;
  locale: string;
  isVisible: BlockVisibilityPredicate;
  ids: BlockIdFactoryHandle;
  used: Set<string>;
}

/** 默认条件显隐求值器：复用高亮规则引擎（null / 未配置 → 可见） */
const defaultIsVisible: BlockVisibilityPredicate = (visibleWhen, record, metas) =>
  isBlockVisible(visibleWhen, record, metas);

/**
 * 保证 blockId 唯一且非空。
 * 分页层用 `blocksById[blockId]` 索引区块，重复 id 会**静默丢失区块**，故此处必须去重。
 */
function ensureUniqueBlockId(
  rawId: unknown,
  kind: DocBlockKind,
  ids: BlockIdFactoryHandle,
  used: Set<string>,
): string {
  const base = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : ids.next(`blk_${kind}`);

  // ⚠️ 冲突时**只做字符串后缀递增**，不在循环里反复调生成器：
  // 注入的 `makeId` 可能是常量函数（如测试桩），反复调用会死循环。
  // 后缀递增保证每轮都产出新串，最多迭代 `used.size + 1` 次必然终止。
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/* ===================== 12 类区块的逐一解析 ===================== */

/** 1. 标题：静态文本 / 绑定字段 */
function resolveHeading(block: HeadingBlock, ctx: ResolveContext): ResolvedHeadingPayload | null {
  let text = '';
  let fieldId: string | undefined;

  if (block.source.type === 'field') {
    const ev = evaluateField(ctx.recordFields, block.source.fieldId, ctx.metas);
    // 失效字段引用 → 整块隐藏（§21.2「失效字段引用隐藏」）
    if (!ev) return null;
    fieldId = block.source.fieldId;
    text = ev.empty ? '' : displayOf(ev.nv);
  } else {
    text = typeof block.source.text === 'string' ? block.source.text : '';
  }

  if (block.hideWhenEmpty === true && text.trim() === '') return null;

  const payload: ResolvedHeadingPayload = { kind: 'heading', level: block.level, text };
  if (fieldId !== undefined) payload.fieldId = fieldId;
  return payload;
}

/** 按 `preserveLineBreaks` 拆行 */
function splitLines(text: string, preserveLineBreaks: boolean): string[] {
  if (text === '') return [];
  return preserveLineBreaks ? text.split('\n') : [text.replace(/\s*\n\s*/g, ' ')];
}

/** 2. 段落：字段长文本，按行跨页 */
function resolveParagraph(block: ParagraphBlock, ctx: ResolveContext): ResolvedParagraphPayload | null {
  const ev = evaluateField(ctx.recordFields, block.fieldId, ctx.metas);
  if (!ev) return null;

  const text = ev.empty ? '' : displayOf(ev.nv);
  if (block.hideWhenEmpty === true && text.trim() === '') return null;

  const lines = splitLines(text, block.preserveLineBreaks === true);
  const capped =
    typeof block.maxLines === 'number' && block.maxLines > 0 ? lines.slice(0, block.maxLines) : lines;

  return {
    kind: 'paragraph',
    fieldId: block.fieldId,
    text,
    lines: capped,
    preserveLineBreaks: block.preserveLineBreaks === true,
  };
}

/** 3. 键值网格：逐行求值，`hideEmptyRows` 剔除空行；失效引用剔除（块本身保留） */
function resolveKeyValueGrid(block: KeyValueGridBlock, ctx: ResolveContext): ResolvedKeyValueGridPayload {
  const rows: ResolvedKeyValueRow[] = [];
  for (const row of block.rows ?? []) {
    const ev = evaluateField(ctx.recordFields, row.fieldId, ctx.metas);
    if (!ev) continue; // 失效字段引用 → 剔除该行
    if (block.hideEmptyRows === true && ev.empty) continue;
    rows.push({
      fieldId: row.fieldId,
      label: row.labelOverride ?? ev.meta.name,
      value: ev.nv,
    });
  }
  return {
    kind: 'keyValueGrid',
    columns: block.columns,
    rows,
    labelWidthPx: block.labelWidthPx,
    showColon: block.showColon === true,
    zebra: block.zebra === true,
  };
}

/** 4. 字段清单：逐项求值，`hideEmptyItems` 剔除空项；失效引用剔除（块本身保留） */
function resolveFieldList(block: FieldListBlock, ctx: ResolveContext): ResolvedFieldListPayload {
  const items: ResolvedFieldItem[] = [];
  for (const item of block.items ?? []) {
    const ev = evaluateField(ctx.recordFields, item.fieldId, ctx.metas);
    if (!ev) continue; // 失效字段引用 → 剔除该项
    if (block.hideEmptyItems === true && ev.empty) continue;
    items.push({
      fieldId: item.fieldId,
      label: item.labelOverride ?? ev.meta.name,
      value: ev.nv,
    });
  }
  return { kind: 'fieldList', items, showLabels: block.showLabels === true };
}

/**
 * 5. 标签行：逐字段求值 → 标签组。
 * 空字段不出标签（等价于「未填就不显示」）；`maxItems` 为**每个字段**的标签数上限
 * （默认值取自 `MULTI_SELECT_PREVIEW_LIMIT`，语义即多选预览条数）。
 */
function resolveBadgeRow(block: BadgeRowBlock, ctx: ResolveContext): ResolvedBadgeRowPayload {
  const badges: ResolvedBadge[] = [];
  const limit = typeof block.maxItems === 'number' && block.maxItems > 0 ? block.maxItems : Number.MAX_SAFE_INTEGER;

  for (const fieldId of block.fieldIds ?? []) {
    const ev = evaluateField(ctx.recordFields, fieldId, ctx.metas);
    if (!ev) continue; // 失效字段引用 → 剔除
    if (ev.empty) continue; // 空字段 → 不出标签
    const texts = badgeTexts(ev.nv);
    if (texts.length === 0) continue;
    badges.push({
      fieldId,
      label: ev.meta.name,
      texts: texts.slice(0, limit),
      colorIndexes: badgeColorIndexes(ev.nv).slice(0, limit),
      value: ev.nv,
    });
  }
  return { kind: 'badgeRow', badges, showLabels: block.showLabels === true, maxItems: block.maxItems };
}

/** 6. 图片：附件字段 → 按 mode（first / all / index）选出可渲染图片 */
function resolveImage(block: ImageBlock, ctx: ResolveContext): ResolvedImagePayload | null {
  const ev = evaluateField(ctx.recordFields, block.fieldId, ctx.metas);
  if (!ev) return null; // 失效字段引用 → 整块隐藏

  const items: NormalizedItem[] = Array.isArray(ev.nv.items) ? ev.nv.items : [];
  // 只有带可渲染地址的附件才算「图」；无地址的附件不产出 URL，避免 <img src=""> 破图
  const usable = items.filter((item) => typeof item.imageUrl === 'string' && item.imageUrl !== '');

  let selected: NormalizedItem[];
  if (block.mode === 'first') {
    selected = usable.slice(0, 1);
  } else if (block.mode === 'index') {
    const at = Number.isFinite(block.index) ? Math.trunc(block.index) : 0;
    selected = at >= 0 && at < usable.length ? [usable[at]] : [];
  } else {
    selected = usable; // 'all'
  }

  if (block.hideWhenEmpty === true && selected.length === 0) return null;

  const images: ResolvedImage[] = selected.map((item, index) => ({
    name: item.text,
    url: item.imageUrl ?? '',
    index,
  }));

  const payload: ResolvedImagePayload = {
    kind: 'image',
    images,
    width: block.width,
    align: block.align,
  };
  if (typeof block.height === 'number') payload.height = block.height;
  if (typeof block.caption === 'string') payload.caption = block.caption;
  return payload;
}

/** 取关联记录字段的原始数组（每项可能是字符串 / {recordId,text,fields} 对象） */
function linkedRowEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined) return [];
  return [raw];
}

/** 从关联项里取记录 id（取不到则空串；**仅内部定位用，不渲染**） */
function linkedRowId(entry: unknown): string {
  if (typeof entry === 'string') return '';
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    for (const key of ['recordId', 'record_id', 'id']) {
      if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string;
    }
  }
  return '';
}

/** 从关联项里取「行首兜底文本」 */
function linkedRowTitle(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    for (const key of ['text', 'name', 'title', 'label']) {
      if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string;
    }
  }
  return '';
}

/** 从关联项里取它自身携带的字段值表（若有） */
function linkedRowFields(entry: unknown): Record<string, unknown> | null {
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    if (record.fields && typeof record.fields === 'object') return record.fields as Record<string, unknown>;
  }
  return null;
}

/** 7. 表格：列解析 + 行来源解析（currentRecord / linkedRecords） */
function resolveTable(block: TableBlock, ctx: ResolveContext): ResolvedTablePayload | null {
  const columns: ResolvedTableColumn[] = [];
  for (const column of block.columns ?? []) {
    const meta = ctx.metas[column.fieldId];
    if (!meta) continue; // 失效字段引用 → 剔除该列
    const resolved: ResolvedTableColumn = { fieldId: column.fieldId, title: column.titleOverride ?? meta.name };
    if (typeof column.widthPx === 'number') resolved.widthPx = column.widthPx;
    if (column.align !== undefined) resolved.align = column.align;
    columns.push(resolved);
  }
  // 无有效列 → 无表格可渲染 → 整块隐藏
  if (columns.length === 0) return null;

  const rows: ResolvedTableRow[] = [];

  if (block.rowSource.type === 'linkedRecords') {
    const linkFieldId = block.rowSource.fieldId;
    const raw = ctx.recordFields[linkFieldId];
    for (const entry of linkedRowEntries(raw)) {
      const rowFields = linkedRowFields(entry);
      const title = linkedRowTitle(entry);
      const cells: Record<string, NormalizedValue> = {};
      for (const column of columns) {
        const meta = ctx.metas[column.fieldId];
        // 关联记录通常只带「被关联表的标题文本」，本表字段未必可读：
        // ① 行自带 fields → 直接取；② 列即关联字段本身 → 用行首文本；③ 否则为空（不臆造）
        const source = rowFields
          ? rowFields[column.fieldId]
          : column.fieldId === linkFieldId
            ? title
            : undefined;
        try {
          cells[column.fieldId] = normalize(source, meta);
        } catch {
          cells[column.fieldId] = emptyNormalized();
        }
      }
      rows.push({ recordId: linkedRowId(entry), title, cells });
    }
  } else {
    const cells: Record<string, NormalizedValue> = {};
    for (const column of columns) {
      const meta = ctx.metas[column.fieldId];
      try {
        cells[column.fieldId] = normalize(ctx.recordFields[column.fieldId], meta);
      } catch {
        cells[column.fieldId] = emptyNormalized();
      }
    }
    const primary = ctx.fields.find((field) => field.isPrimary === true);
    const primaryValue = primary ? cells[primary.id] : undefined;
    rows.push({
      recordId: ctx.recordId,
      title: primaryValue ? displayOf(primaryValue) : '',
      cells,
    });
  }

  const capped =
    typeof block.maxRows === 'number' && block.maxRows > 0 ? rows.slice(0, block.maxRows) : rows;

  return {
    kind: 'table',
    columns,
    rows: capped,
    showHeader: block.showHeader === true,
    zebra: block.zebra === true,
  };
}

/** 8. 静态富文本：markdown 子集 → 安全节点 */
function resolveRichText(block: RichTextBlock): ResolvedRichTextPayload {
  return { kind: 'richText', nodes: parseMarkdown(typeof block.markdown === 'string' ? block.markdown : '') };
}

/** 9. 分隔线 */
function resolveDivider(block: DividerBlock): ResolvedDividerPayload {
  return { kind: 'divider', thickness: block.thickness, borderStyle: block.borderStyle };
}

/** 10. 间距 */
function resolveSpacer(block: SpacerBlock): ResolvedSpacerPayload {
  return { kind: 'spacer', height: block.height };
}

/** 11. 强制分页（不渲染 DOM，仅作为分页层的换页指令） */
function resolvePageBreak(): ResolvedPageBreakPayload {
  return { kind: 'pageBreak' };
}

/** 页脚元信息项的中文名 */
const META_FOOTER_LABEL: Readonly<Record<MetaFooterKey, string>> = {
  createdUser: '创建人',
  createdTime: '创建时间',
  modifiedUser: '修改人',
  modifiedTime: '修改时间',
  recordId: '记录 ID',
};

/** 元信息键 → 对应的字段类型（recordId 不依赖字段） */
const META_FOOTER_FIELD_TYPES: Readonly<Partial<Record<MetaFooterKey, readonly FieldType[]>>> = {
  createdUser: [FieldType.CreatedUser],
  modifiedUser: [FieldType.ModifiedUser],
  createdTime: [FieldType.CreatedTime],
  modifiedTime: [FieldType.ModifiedTime],
};

/**
 * 12. 页脚元信息：创建人 / 创建时间 / 修改人 / 修改时间 / 记录 ID。
 * 前四者依赖表中**对应类型**的字段；表里没有该类型字段时**跳过该项**（不臆造时间/人名）。
 */
function resolveMetaFooter(block: MetaFooterBlock, ctx: ResolveContext): ResolvedMetaFooterPayload {
  const entries: ResolvedMetaEntry[] = [];

  for (const key of block.fields ?? []) {
    const label = META_FOOTER_LABEL[key] ?? key;

    if (key === 'recordId') {
      if (ctx.recordId === '') continue;
      entries.push({ key, label, text: ctx.recordId });
      continue;
    }

    const types = META_FOOTER_FIELD_TYPES[key];
    const meta = types ? ctx.fields.find((field) => types.includes(field.type as FieldType)) : undefined;
    if (!meta) continue; // 表里没有该元信息字段 → 不产出（绝不凭空造值）

    let nv: NormalizedValue;
    try {
      nv = normalize(ctx.recordFields[meta.id], meta);
    } catch {
      nv = emptyNormalized();
    }
    const text = nv.isEmpty === true ? '' : displayOf(nv);
    if (text === '') continue;
    entries.push({ key, label, text });
  }

  const separator = typeof block.separator === 'string' ? block.separator : ' · ';
  return {
    kind: 'metaFooter',
    entries,
    separator,
    fontSize: block.fontSize,
    muted: block.muted === true,
    text: entries.map((entry) => entry.text).join(separator),
  };
}

/* ===================== 区块级收拢 ===================== */

/** 从 block 收集「有效字段引用」（去重、保序） */
function referencedFieldIds(block: DocBlock, metas: FieldMetaMap): string[] {
  const ids: string[] = [];
  const push = (fieldId: unknown): void => {
    if (typeof fieldId !== 'string' || fieldId === '') return;
    if (!metas[fieldId]) return; // 失效引用不计入
    if (ids.includes(fieldId)) return;
    ids.push(fieldId);
  };

  switch (block.kind) {
    case 'heading':
      if (block.source.type === 'field') push(block.source.fieldId);
      break;
    case 'paragraph':
    case 'image':
      push(block.fieldId);
      break;
    case 'keyValueGrid':
      for (const row of block.rows ?? []) push(row.fieldId);
      break;
    case 'fieldList':
      for (const item of block.items ?? []) push(item.fieldId);
      break;
    case 'badgeRow':
      for (const fieldId of block.fieldIds ?? []) push(fieldId);
      break;
    case 'table':
      for (const column of block.columns ?? []) push(column.fieldId);
      break;
    default:
      break;
  }
  return ids;
}

/** 单块解析：返回 null = 该块不产出（条件未命中 / hideWhenEmpty / 失效引用 / 无有效列） */
function resolveBlock(block: DocBlock, ctx: ResolveContext): ResolvedBlock | null {
  if (!block || typeof block !== 'object') return null;

  // ① 条件显隐（visibleWhen）：未配置 / null → 可见
  if (!ctx.isVisible(block.visibleWhen ?? null, ctx.record ?? null, ctx.metas)) {
    return null;
  }

  // ② 按 12 类逐一解析出 payload
  let payload: ResolvedPayload;
  switch (block.kind) {
    case 'heading': {
      const value = resolveHeading(block, ctx);
      if (!value) return null;
      payload = value;
      break;
    }
    case 'paragraph': {
      const value = resolveParagraph(block, ctx);
      if (!value) return null;
      payload = value;
      break;
    }
    case 'keyValueGrid':
      payload = resolveKeyValueGrid(block, ctx);
      break;
    case 'fieldList':
      payload = resolveFieldList(block, ctx);
      break;
    case 'badgeRow':
      payload = resolveBadgeRow(block, ctx);
      break;
    case 'image': {
      const value = resolveImage(block, ctx);
      if (!value) return null;
      payload = value;
      break;
    }
    case 'table': {
      const value = resolveTable(block, ctx);
      if (!value) return null;
      payload = value;
      break;
    }
    case 'richText':
      payload = resolveRichText(block);
      break;
    case 'divider':
      payload = resolveDivider(block);
      break;
    case 'spacer':
      payload = resolveSpacer(block);
      break;
    case 'pageBreak':
      payload = resolvePageBreak();
      break;
    case 'metaFooter':
      payload = resolveMetaFooter(block, ctx);
      break;
    default:
      // 未知 kind（配置损坏 / 未来版本新增类型）：不渲染，避免污染版式与分页
      return null;
  }

  // ③ 字段引用 / 值 / 标签收拢
  const fieldIds = referencedFieldIds(block, ctx.metas);
  const values: Record<string, NormalizedValue> = {};
  const labels: Record<string, string> = {};
  for (const fieldId of fieldIds) {
    const ev = evaluateField(ctx.recordFields, fieldId, ctx.metas);
    if (!ev) continue;
    values[fieldId] = ev.nv;
    labels[fieldId] = ev.meta.name;
  }

  // ④ 便捷出口：imageUrls / rows（§21.3.3）
  const imageUrls = payload.kind === 'image' ? payload.images.map((image) => image.url) : [];
  const rows = payload.kind === 'table' ? payload.rows : [];

  const blockId = ensureUniqueBlockId(block.blockId, block.kind, ctx.ids, ctx.used);

  return {
    blockId,
    block,
    kind: block.kind,
    fieldIds,
    values,
    labels,
    payload,
    imageUrls,
    rows,
    // locale 参与哈希：将来本地化格式化变化时高度缓存能正确失效
    payloadHash: checksumOf({ locale: ctx.locale, payload }),
  };
}

/* ===================== 主入口 ===================== */

/**
 * ⭐ 区块模板序列 + 记录 + 字段元信息 + 规则引擎 → `ResolvedBlock[]`。
 *
 * **纯函数**：同输入恒同输出；不读时间 / 随机 / 全局可变状态。
 * 已在此阶段完成的过滤：条件显隐（`visibleWhen`）、`hideWhenEmpty`、
 * `hideEmptyRows` / `hideEmptyItems`、失效字段引用、无有效列的表格。
 *
 * @param args.blocks    区块模板序列（`DocTemplate.blocks`）
 * @param args.record    当前记录（null/undefined → 字段全按空处理）
 * @param args.fields    当前视图字段元数据
 * @param args.locale    语言环境（缺省 'zh-CN'；参与 payloadHash）
 * @param args.isVisible 条件显隐求值器（缺省 = `ruleEngine.isBlockVisible`）
 * @param args.makeId    区块 id 生成器（缺省 = 确定性 `createBlockIdFactory(0)`）
 */
export function resolveBlocks(args: ResolveBlocksArgs): ResolvedBlock[] {
  const blocks = Array.isArray(args.blocks) ? args.blocks : [];
  const fields = Array.isArray(args.fields) ? args.fields : [];
  const locale = typeof args.locale === 'string' && args.locale !== '' ? args.locale : 'zh-CN';

  const ctx: ResolveContext = {
    record: args.record,
    recordFields: getRecordFields(args.record as SdkRecord | null | undefined),
    recordId: getRecordId(args.record as SdkRecord | null | undefined),
    fields,
    metas: indexFields(fields),
    locale,
    isVisible: args.isVisible ?? defaultIsVisible,
    ids: args.makeId ? { next: args.makeId } : createBlockIdFactory(0),
    used: new Set<string>(),
  };

  const out: ResolvedBlock[] = [];
  for (const block of blocks) {
    const resolved = resolveBlock(block, ctx);
    if (resolved) out.push(resolved);
  }
  return out;
}

/* ===================== 跨页片段 → 渲染上下文 ===================== */

/** `buildDocRenderContext` 入参 */
export interface DocRenderContextInput {
  fieldMeta: FieldMetaLite;
  /** 字段展示选项（渲染层持有，本层不臆造默认） */
  display: FieldDisplayOptions;
  theme: StyleTheme;
  locale?: string;
  /** 文档态是否显示「字段名：」前缀 */
  showLabel?: boolean;
  labelText?: string;
  /** 该块被分页切分后的第几段（0 起）；缺省 0 */
  fragmentIndex?: number;
  /** 该块总段数；缺省 1（= 未切分） */
  fragmentsTotal?: number;
}

/**
 * 组装文档态字段渲染上下文（§21.3.3 / §6.5）。
 *
 * ⭐ **跨页片段透传**：分页层产出的 `PagedItem.fragmentIndex / fragmentsTotal` 由调用方
 * （`components/doc/blocks/*`）传入本函数，落进 `DocRenderContext`，渲染器据此
 * **在非首片省略「字段名：」标签**（`fieldTypes.docLabelPrefix` 已实现该规则），
 * 防止同一字段在续页重复画标签。
 *
 * 依赖方向保持单向：`doc/` 只**提供组装函数**，不 import `pagination/`。
 */
export function buildDocRenderContext(input: DocRenderContextInput): DocRenderContext {
  const fragmentsTotal = Number.isFinite(input.fragmentsTotal)
    ? Math.max(1, Math.trunc(input.fragmentsTotal as number))
    : 1;
  const fragmentIndex = Number.isFinite(input.fragmentIndex)
    ? Math.min(Math.max(0, Math.trunc(input.fragmentIndex as number)), fragmentsTotal - 1)
    : 0;

  return {
    fieldMeta: input.fieldMeta,
    display: input.display,
    theme: input.theme,
    locale: input.locale ?? 'zh-CN',
    fragmentIndex,
    fragmentsTotal,
    showLabel: input.showLabel === true,
    labelText: input.labelText,
  };
}
