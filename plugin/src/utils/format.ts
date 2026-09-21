/**
 * 展示格式化工具（卡片态/文档态共用）。
 * 目标：把结构化值转成「人可见文本」，绝不输出原始 ID / JSON。
 */
import type { NumberFormatOptions } from '@/config/types';

const DATE_PAD = (value: number): string => (value < 10 ? `0${value}` : String(value));

/**
 * 通用日期格式化。
 * 支持 token：YYYY MM DD HH mm ss（其余字符原样输出）。
 * @param timestamp 毫秒时间戳
 * @param pattern 默认 'YYYY-MM-DD'
 */
export function formatDate(timestamp: number, pattern = 'YYYY-MM-DD'): string {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const map: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: DATE_PAD(date.getMonth() + 1),
    DD: DATE_PAD(date.getDate()),
    HH: DATE_PAD(date.getHours()),
    mm: DATE_PAD(date.getMinutes()),
    ss: DATE_PAD(date.getSeconds()),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => map[token] ?? token);
}

/** 千分位 + 可选小数位 */
export function formatNumber(value: number, options?: NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '';
  const useGrouping = options?.useGrouping ?? true;
  const decimals = typeof options?.decimals === 'number' ? options.decimals : undefined;
  const fixed = typeof decimals === 'number' ? value.toFixed(decimals) : String(value);
  if (!useGrouping) return fixed;
  const [intPart, decimalPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const withUnit = options?.unit ? `${grouped}${options.unit}` : grouped;
  return decimalPart !== undefined ? `${withUnit}.${decimalPart}` : withUnit;
}

/** 货币格式化（默认 ¥，千分位 + 2 位小数） */
export function formatCurrency(value: number, symbol = '¥', options?: NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '';
  const formatted = formatNumber(value, { useGrouping: true, decimals: 2, ...options });
  const sign = value < 0 ? '-' : '';
  return `${sign}${symbol}${formatted.replace('-', '')}`;
}

/** 截断（超出补省略号）；max <= 0 表示不截断 */
export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 安全转字符串：仅接受原始标量，对象一律返回空串（避免 JSON 外泄） */
export function toSafeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}
