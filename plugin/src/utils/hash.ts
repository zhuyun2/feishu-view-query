/**
 * 配置完整性校验工具集（checksum / 稳定序列化 / 字节体积）。
 * 纯函数、无副作用、可单测。
 */

/**
 * 稳定序列化：递归按 key 字典序排序，保证同一对象在不同创建顺序下产出相同字符串。
 * checksum 依赖该稳定性，否则刷新后会出现「假损坏」。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // undefined 在 JSON 中会被丢弃，这里统一归一为 null，保证确定性。
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * FNV-1a 32bit 字符串哈希，输出 8 位小写十六进制。
 * 用途仅为「配置损坏检测」，不用于安全场景。
 */
export function checksum(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619，用移位避免浮点误差（Math.imul 保证 32bit 语义）
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 转无符号
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 对任意对象做稳定 checksum */
export function checksumOf(value: unknown): string {
  return checksum(stableStringify(value));
}

/** UTF-8 字节长度（用于配置体积预算判断，不能用 .length：中文占多字节） */
export function utf8ByteLength(input: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(input).length;
  }
  // 兜底：按 UTF-8 规则手工计数
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // 跳过低位代理
    } else bytes += 3;
  }
  return bytes;
}
