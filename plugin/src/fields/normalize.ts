/**
 * 归一化：任意 `IOpenCellValue` → `NormalizedValue`（设计文档 §6.5）。
 *
 * 铁律（US-5 AC1）：本函数**永不**把原始 ID / JSON 放进 `text` / `display`。
 * 无法识别的结构一律折叠为 `unsupported`，由 FallbackRenderer 兜底展示。
 */
import type { FieldMetaLite, NormalizedItem, NormalizedValue } from './fieldTypes';
import { FieldType, getFieldPriority } from './fieldTypes';
import { formatCurrency, formatDate, formatNumber, toSafeText, truncate } from '@/utils/format';

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

/** 文本类 */
function normalizeText(raw: unknown): NormalizedValue {
  const text = toSafeText(raw);
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

/** 链接 */
function normalizeUrl(raw: unknown): NormalizedValue {
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
 * 公式 / 查找引用的「保守解包」：仅解包 { value } 与数组，
 * 解包失败即 unsupported（绝不 JSON.stringify）。
 */
function normalizeFormulaOrLookup(raw: unknown): NormalizedValue {
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
    case FieldType.AutoNumber:
      return normalizeNumber(raw);
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
      return normalizeFormulaOrLookup(raw);
    case FieldType.Lookup:
    case FieldType.Link:
    case FieldType.DuplexLink:
      return normalizeLookup(raw);
    default:
      return unsupportedValue();
  }
}
