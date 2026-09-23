/**
 * 归一化：任意 `IOpenCellValue` → `NormalizedValue`（设计文档 §6.5）。
 *
 * 铁律（US-5 AC1）：本函数**永不**把原始 ID / JSON 放进 `text` / `display`。
 * 无法识别的结构一律折叠为 `unsupported`，由 FallbackRenderer 兜底展示。
 */
import type { FieldMetaLite, FieldTypeValue, NormalizedItem, NormalizedValue } from './fieldTypes';
import { FieldType, getFieldPriority } from './fieldTypes';
import {
  formatCurrency,
  formatDate,
  formatNumber,
  mapDateFormatterPattern,
  toSafeText,
  truncate,
} from '@/utils/format';
import { logInfo } from '@/utils/log';

const EMPTY: NormalizedValue = { kind: 'empty', text: '', display: '', isEmpty: true };

const UNSUPPORTED: NormalizedValue = {
  kind: 'unsupported',
  text: '该字段类型暂不支持',
  display: '该字段类型暂不支持',
  isEmpty: false,
};

function emptyValue(): NormalizedValue {
  return { ...EMPTY };
}

function unsupportedValue(): NormalizedValue {
  return { ...UNSUPPORTED };
}

/** 判定「空」：null / undefined / 空串 / 空数组 / 空对象 */
function isEmptyRaw(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/**
 * 数值字段的「受支持输入」→ 有限数字；否则返回 null（调用方折叠为 empty）。
 *
 * ⚠️ F4 修复：仅接受 **number 标量** 与 **可解析为有限数字的字符串**。
 * 对象 / 数组 / 布尔等非标量输入**不再**落到 `Number()` 强转（否则 `{...}` 会变成 `0`/`¥0.00`，
 * 比空值更糟：用户会误以为金额真的为 0）。SDK 对数字/货币字段的合法值即为标量，
 * 故此处不涉及任何「已识别包装」的误伤（`{ value }` 包装由公式分支单独解包）。
 */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 读取单选/多选字段的选项色板序号 */
function resolveColorIndex(meta: FieldMetaLite, optionName: string): number | undefined {
  const property = meta.property as { options?: Array<{ name?: unknown; color?: unknown }> } | undefined;
  const options = property?.options;
  if (!Array.isArray(options)) return undefined;
  const hit = options.find((option) => option && option.name === optionName);
  if (hit && typeof hit.color === 'number') return hit.color;
  return undefined;
}

/** 读取货币符号（货币字段 property.symbol，缺省 ¥） */
function resolveCurrencySymbol(meta: FieldMetaLite): string {
  const property = meta.property as { symbol?: unknown } | undefined;
  if (property && typeof property.symbol === 'string' && property.symbol.trim() !== '') {
    return property.symbol;
  }
  return '¥';
}

/** 把「字符串或 {text/name} 对象」安全转成展示文本（绝不输出 JSON） */
function itemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'name', 'label', 'title', 'enName', 'address']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
  }
  return '';
}

function toItem(value: unknown): NormalizedItem | null {
  const text = itemText(value);
  if (text === '') return null;
  const item: NormalizedItem = { text };
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const avatar = record.avatarUrl ?? record.avatar_url ?? record.tmpUrl;
    if (typeof avatar === 'string' && avatar !== '') item.imageUrl = avatar;
  }
  return item;
}

/* ===================== SDK 段结构（IOpenSegment）解包（批次 A） ===================== */

/**
 * IOpenSegment 结构特征判定：含 `type` 字段（字符串或数值）与字符串 `text` 字段的对象。
 *
 * ⚠️ **必须校验 `type` 存在**：单选/多选的选项是 `{ id, text }`（无 `type` 字段），
 *    仅凭 `text` 判定会把多选数组误认成段数组（真机多选永不走文本归一化，
 *    但文本分支收到该形态时必须按「非段数组 → 空值」处理，绝不误拼）。
 * 对齐 SDK d.ts：`IOpenSegment` = text / url / mention 段联合，各段均含 `type` 与 `text`。
 */
function isSegmentLike(entry: unknown): entry is { type: string | number; text: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (typeof record.text !== 'string') return false;
  return typeof record.type === 'string' || typeof record.type === 'number';
}

/**
 * 段数组 → 拼接文本（真机文本/链接单元格的实际形态，SDK `IOpenCellValue` 的 `IOpenSegment[]`）。
 *
 * - **全元素**都是段结构才认定为段数组；混入任何非段结构（如多选的 `{ id, text }`、
 *   嵌套对象等）→ 返回 `null`，调用方回落原有标量语义（宁可判空也不外泄 JSON）；
 * - 只拼接有 `text` 的段（text / url / mention 段的 `text` 均为人可见文本，
 *   mention 段的 `token` / `id` 等敏感字段**绝不**读取）；
 * - 全部段都无 text → 返回 `''`（确认为段数组但内容为空 → 走 empty 语义，不编造内容）；
 * - 非数组 / 空数组 → `null`（空数组已被 `isEmptyRaw` 在主入口拦截，此处为纯函数兜底）。
 *
 * @param separator 段间连接符：多行文本用 `''`（分段是连续文本流，换行在 text 内）；
 *                  链接字段用 `'、'`（各段是离散链接值，同多值展示口径）。
 */
function segmentArrayText(raw: unknown, separator = ''): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: string[] = [];
  for (const entry of raw) {
    if (!isSegmentLike(entry)) return null;
    if (entry.text !== '') parts.push(entry.text);
  }
  return parts.length > 0 ? parts.join(separator) : '';
}

/** 文本类：真机多行文本是 IOpenSegment[] 分段数组，先解包再走标量口径（批次 A） */
function normalizeText(raw: unknown): NormalizedValue {
  const joined = segmentArrayText(raw);
  const text = joined !== null ? joined : toSafeText(raw);
  if (text === '') return emptyValue();
  return { kind: 'text', text, display: text, isEmpty: false };
}

/** 数字类 */
function normalizeNumber(raw: unknown): NormalizedValue {
  const num = toFiniteNumber(raw);
  if (num === null) return emptyValue();
  return { kind: 'number', text: String(num), display: formatNumber(num), number: num, isEmpty: false };
}

/** 货币类 */
function normalizeCurrency(raw: unknown, meta: FieldMetaLite): NormalizedValue {
  const num = toFiniteNumber(raw);
  if (num === null) return emptyValue();
  const symbol = resolveCurrencySymbol(meta);
  return {
    kind: 'currency',
    text: String(num),
    display: formatCurrency(num, symbol),
    symbol,
    number: num,
    isEmpty: false,
  };
}

/** 单选 */
function normalizeSingleSelect(raw: unknown, meta: FieldMetaLite): NormalizedValue {
  const text = itemText(raw);
  if (text === '') return emptyValue();
  const item: NormalizedItem = { text };
  const colorIndex = resolveColorIndex(meta, text);
  if (colorIndex !== undefined) item.colorIndex = colorIndex;
  return { kind: 'select', text, display: text, items: [item], isEmpty: false };
}

/** 多选 */
function normalizeMultiSelect(raw: unknown, meta: FieldMetaLite): NormalizedValue {
  const list = Array.isArray(raw) ? raw : [raw];
  const items: NormalizedItem[] = [];
  for (const entry of list) {
    const item = toItem(entry);
    if (!item) continue;
    const colorIndex = resolveColorIndex(meta, item.text);
    if (colorIndex !== undefined) item.colorIndex = colorIndex;
    items.push(item);
  }
  if (items.length === 0) return emptyValue();
  const text = items.map((item) => item.text).join('、');
  return { kind: 'multiSelect', text, display: text, items, isEmpty: false };
}

/** 日期时间 */
function normalizeDateTime(raw: unknown): NormalizedValue {
  const timestamp = toFiniteNumber(raw);
  if (timestamp === null || timestamp <= 0) return emptyValue();
  const display = formatDate(timestamp, 'YYYY-MM-DD');
  if (display === '') return emptyValue();
  return { kind: 'dateTime', text: display, display, timestamp, isEmpty: false };
}

/** 复选框 */
function normalizeCheckbox(raw: unknown): NormalizedValue {
  const bool = typeof raw === 'boolean' ? raw : raw === 'true';
  return {
    kind: 'checkbox',
    text: bool ? 'true' : 'false',
    display: bool ? '是' : '否',
    boolean: bool,
    isEmpty: false,
  };
}

/** 成员类（P1，但归一化需保证不泄漏 id） */
function normalizeUser(raw: unknown): NormalizedValue {
  const list = Array.isArray(raw) ? raw : [raw];
  const items: NormalizedItem[] = [];
  for (const entry of list) {
    const item = toItem(entry);
    if (item) items.push(item);
  }
  if (items.length === 0) return emptyValue();
  const text = items.map((item) => item.text).join('、');
  return { kind: 'user', text, display: text, items, isEmpty: false };
}

/** 附件类（P1，但归一化需保证不泄漏 token） */
function normalizeAttachment(raw: unknown): NormalizedValue {
  const list = Array.isArray(raw) ? raw : [raw];
  const items: NormalizedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (name === '') continue;
    const item: NormalizedItem = { text: name };
    const url = record.tmpUrl ?? record.url;
    if (typeof url === 'string' && url !== '') item.imageUrl = url;
    items.push(item);
  }
  if (items.length === 0) return emptyValue();
  const text = items.map((item) => item.text).join('、');
  return { kind: 'attachment', text, display: text, items, isEmpty: false };
}

/** 链接：真机值是 IOpenUrlSegment[]（[{type:'url',text,link},...]），单对象 / 字符串亦兼容 */
function normalizeUrl(raw: unknown): NormalizedValue {
  if (Array.isArray(raw)) {
    // 段数组：人可见文本 = 各段 text（多个链接值用「、」连接，同多值展示口径）。
    // 铁律不保留原始 href / link；LinkRenderer 仅在人可见文本本身是合法 URL 时生成 <a>。
    const joined = segmentArrayText(raw, '、');
    if (joined === null) return emptyValue(); // 非段结构的数组（异常形态）→ 折叠为空，不外泄 JSON
    if (joined === '') return emptyValue();
    return { kind: 'url', text: joined, display: joined, items: [{ text: joined }], isEmpty: false };
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text : '';
    const link = typeof record.link === 'string' ? record.link : '';
    const display = text !== '' ? text : link;
    if (display === '') return emptyValue();
    return { kind: 'url', text: display, display, items: [{ text: display }], isEmpty: false };
  }
  const text = toSafeText(raw);
  if (text === '') return emptyValue();
  return { kind: 'url', text, display: text, items: [{ text }], isEmpty: false };
}

/** 评分 / 进度：数值型，语义化 kind */
function normalizeRatingOrProgress(raw: unknown, kind: 'rating' | 'progress'): NormalizedValue {
  const num = toFiniteNumber(raw);
  if (num === null) return emptyValue();
  const display = kind === 'progress' ? `${Math.round(num)}%` : String(num);
  return { kind, text: String(num), display, number: num, isEmpty: false };
}

/**
 * 自动编号（批次 A）：SDK `IOpenAutoNumber = ISelfCalculationValue<string>`——
 * 真机值是 `{ value: string, status }` 包装对象，且 **value 是字符串编号**
 * （可能带字母前缀 / 前导零，如 "F-2024-0001" / "0008"，**不是**数字）。
 *
 * - `{ value }` 解包（与公式分支 `formulaNumericCandidate` 同款模式）；
 * - 字符串 → **文本语义**（保留前导零 / 前缀，display 原样）；
 *   纯数字串额外补充 `number` 字段，供筛选引擎的数值比较（is / 区间）继续可用；
 * - 裸标量（number / 数字串，编辑器样例卡等历史形态）→ 数字语义不变；
 * - 解包后仍不可识别（null / 对象等）→ empty（不再静默丢失整行）。
 */
function normalizeAutoNumber(raw: unknown): NormalizedValue {
  let candidate: unknown = raw;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    if ('value' in record) candidate = record.value;
  }
  if (typeof candidate === 'string') {
    if (candidate.trim() === '') return emptyValue();
    const nv: NormalizedValue = { kind: 'text', text: candidate, display: candidate, isEmpty: false };
    const numeric = toFiniteNumber(candidate);
    if (numeric !== null) nv.number = numeric;
    return nv;
  }
  if (typeof candidate === 'number') return normalizeNumber(candidate);
  return emptyValue();
}

/* ===================== 公式字段：结果类型解包（SDK dataType） ===================== */

/** 日期类字段类型集合（决定公式结果是否应带日期语义） */
const DATE_FIELD_TYPES: readonly number[] = [
  FieldType.DateTime,
  FieldType.CreatedTime,
  FieldType.ModifiedTime,
];

/** 公式字段的「结果类型 + 展示格式」，来自 SDK `IFormulaFieldProperty.dataType` */
interface FormulaDataType {
  /** 公式结果的字段类型（`dataType.type`） */
  type: FieldTypeValue;
  /** 结果字段自身的日期展示格式（`dataType.property.dateFormat`，`DateFormatter`） */
  dateFormat?: string;
}

/**
 * 读取公式字段的 `property.dataType`（SDK `index.d.ts` 的 `IFormulaFieldProperty`）。
 *
 * ⚠️ `dataType` 在 SDK 中是**可选字段**（`dataType?`）。结构缺失 / 类型不符时返回 `null`，
 *    调用方据此**维持现状**（绝不臆测格式：把大数字静默当日期比显示原值更糟）。
 */
function resolveFormulaDataType(meta: FieldMetaLite): FormulaDataType | null {
  const property = meta.property as { dataType?: unknown } | null | undefined;
  if (!property || typeof property !== 'object') return null;
  const dataType = (property as { dataType?: unknown }).dataType;
  if (!dataType || typeof dataType !== 'object') return null;
  const type = (dataType as { type?: unknown }).type;
  if (typeof type !== 'number') return null;
  const inner = (dataType as { property?: unknown }).property;
  const dateFormat =
    inner && typeof inner === 'object' && typeof (inner as { dateFormat?: unknown }).dateFormat === 'string'
      ? (inner as { dateFormat: string }).dateFormat
      : undefined;
  return { type, dateFormat };
}

/** 已打印过诊断日志的字段 id（一次性，避免同屏多卡刷屏） */
const loggedFormulaMetaFields = new Set<string>();

/**
 * dataType 缺失时的**一次性**诊断日志。
 *
 * 目的：若真机上 SDK 未填充公式的 `dataType`，我们需要这条日志来定位，而不是把
 * 「毫秒区间猜测」当成修复——那会让用户看到**错误的数据**（而非未格式化的数据）。
 *
 * 仅在 `dataType` **缺失**时打印；`dataType` 存在但非日期类（如 Number/Text 公式）
 * 属预期行为，不打印（避免正常公式刷屏）。
 */
function logFormulaMetaOnce(meta: FieldMetaLite): void {
  if (loggedFormulaMetaFields.has(meta.id)) return;
  loggedFormulaMetaFields.add(meta.id);
  logInfo('formula-meta', '公式字段缺少 dataType，按原始值显示（不猜测格式）', {
    fieldId: meta.id,
    fieldName: meta.name,
    property: meta.property,
  });
}

/** 从公式结果里提取「数字候选」（解包 `{ value }` 包装）；非有限数字 → null */
function formulaNumericCandidate(raw: unknown): number | null {
  let candidate: unknown = raw;
  if (candidate && typeof candidate === 'object' && 'value' in (candidate as Record<string, unknown>)) {
    candidate = (candidate as Record<string, unknown>).value;
  }
  return toFiniteNumber(candidate);
}

/**
 * 公式的**日期结果** → 带日期语义 + 字段自身展示格式的归一化值。
 *
 * - 取不到有效时间戳（空值 / 异常形状）→ 返回 `empty`，由调用方交回保守解包（绝不隐藏数据）；
 * - `dateFormat` 缺失或映射后为空 → 保留 `normalizeDateTime` 的默认展示（`YYYY-MM-DD`）。
 */
function normalizeFormulaDate(raw: unknown, dateFormat: string | undefined): NormalizedValue {
  const timestamp = formulaNumericCandidate(raw);
  if (timestamp === null || timestamp <= 0) return emptyValue();
  const nv = normalizeDateTime(timestamp);
  if (nv.isEmpty) return nv;
  const mapped = dateFormat ? mapDateFormatterPattern(dateFormat) : '';
  if (mapped !== '') {
    const display = formatDate(timestamp, mapped);
    if (display !== '') {
      nv.dateFormat = mapped;
      nv.display = display;
      nv.text = display;
    }
  }
  return nv;
}

/**
 * 公式 / 查找引用的归一化。
 *
 * 公式字段优先按其**结果类型**（`meta.property.dataType.type`）解包：
 *  - `dataType` 缺失 → 记录一次性诊断日志，并**维持原保守解包**（行为与历史一致）；
 *  - `dataType.type` 属日期类且原始值为数字 → 复用 `normalizeDateTime` 得到日期语义，
 *    并带上字段自身的 `dateFormat`（供渲染层按字段格式展示，而不是视图级默认格式）；
 *  - 其余情况（含日期结果但取不到时间戳）→ 落入下方的**保守解包**，
 *    仅解包 `{ value }` 与数组，解包失败即 `unsupported`（绝不 `JSON.stringify`）。
 */
function normalizeFormulaOrLookup(raw: unknown, meta: FieldMetaLite): NormalizedValue {
  const dataType = resolveFormulaDataType(meta);
  if (dataType === null) {
    logFormulaMetaOnce(meta);
  } else if (DATE_FIELD_TYPES.includes(dataType.type as number)) {
    const dated = normalizeFormulaDate(raw, dataType.dateFormat);
    if (!dated.isEmpty) return dated;
    // 日期结果但无有效时间戳（空值 / 异常形状）→ 交回保守解包，绝不隐藏数据
  }

  if (Array.isArray(raw)) {
    return normalizeLookup(raw);
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if ('value' in record) {
      const inner = record.value;
      if (typeof inner === 'number') return normalizeNumber(inner);
      if (typeof inner === 'boolean') return normalizeCheckbox(inner);
      const text = itemText(inner);
      if (text !== '') return { kind: 'text', text, display: text, isEmpty: false };
    }
    const text = itemText(raw);
    if (text !== '') return { kind: 'text', text, display: text, isEmpty: false };
  }
  if (typeof raw === 'number') return normalizeNumber(raw);
  if (typeof raw === 'string') return normalizeText(raw);
  return unsupportedValue();
}

/** 查找引用/关联：多值展开为文本列表 */
function normalizeLookup(raw: unknown): NormalizedValue {
  const list = Array.isArray(raw) ? raw : [raw];
  const items: NormalizedItem[] = [];
  for (const entry of list) {
    const text = itemText(entry);
    if (text !== '') items.push({ text });
  }
  if (items.length === 0) return unsupportedValue();
  const text = items.map((item) => item.text).join('、');
  return { kind: 'text', text: truncate(text, 200), display: truncate(text, 200), items, isEmpty: false };
}

/**
 * 主入口：字段值 + 元数据 → NormalizedValue。
 * 对不支持类型返回 `unsupported`（而非抛错），保证整卡不被单个字段拖垮。
 */
export function normalize(raw: unknown, meta: FieldMetaLite): NormalizedValue {
  if (isEmptyRaw(raw)) return emptyValue();
  if (getFieldPriority(meta.type) === 'unsupported') return unsupportedValue();

  switch (meta.type as FieldType) {
    case FieldType.Text:
      return normalizeText(raw);
    case FieldType.Phone:
      return typeof raw === 'string'
        ? { kind: 'phone', text: raw, display: raw, isEmpty: false }
        : normalizeText(raw);
    case FieldType.Number:
      return normalizeNumber(raw);
    case FieldType.AutoNumber:
      return normalizeAutoNumber(raw);
    case FieldType.Currency:
      return normalizeCurrency(raw, meta);
    case FieldType.SingleSelect:
      return normalizeSingleSelect(raw, meta);
    case FieldType.MultiSelect:
      return normalizeMultiSelect(raw, meta);
    case FieldType.DateTime:
    case FieldType.CreatedTime:
    case FieldType.ModifiedTime:
      return normalizeDateTime(raw);
    case FieldType.Checkbox:
      return normalizeCheckbox(raw);
    case FieldType.User:
    case FieldType.CreatedUser:
    case FieldType.ModifiedUser:
    case FieldType.GroupChat:
      return normalizeUser(raw);
    case FieldType.Attachment:
      return normalizeAttachment(raw);
    case FieldType.Url:
      return normalizeUrl(raw);
    case FieldType.Rating:
      return normalizeRatingOrProgress(raw, 'rating');
    case FieldType.Progress:
      return normalizeRatingOrProgress(raw, 'progress');
    case FieldType.Formula:
      return normalizeFormulaOrLookup(raw, meta);
    case FieldType.Lookup:
    case FieldType.Link:
    case FieldType.DuplexLink:
      return normalizeLookup(raw);
    default:
      return unsupportedValue();
  }
}
