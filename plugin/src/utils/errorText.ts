/**
 * 错误信息归一化（真机 E2E 暴露的缺陷：初始化失败不可诊断）。
 *
 * 背景：飞书多维表格 JS SDK / 开放平台在 Promise 被拒绝时，抛出的常常是**普通对象**
 * （形如 `{ code, msg }` / `{ code, message }` / `{ errcode, errmsg }`），
 * 而**不是** `Error` 实例。若继续用 `err instanceof Error ? err.message : '兜底文案'`，
 * 错误码与原因会被**整体丢弃**，生产环境只剩一句无信息量的兜底提示，无法定位。
 *
 * 本模块把任意 `unknown` 归一为**可读且尽量完整**的字符串，并保证**绝不抛异常**
 * （内部全量 try/catch），以免"取错误信息"本身成为新的崩溃点。
 */

/** 可能的「人类可读文案」字段（按优先级依次尝试） */
const TEXT_KEYS: readonly string[] = [
  'message',
  'msg',
  'error',
  'error_msg',
  'errorMsg',
  'errmsg',
  'reason',
  'description',
];

/** 可能的「错误码」字段（按优先级依次尝试） */
const CODE_KEYS: readonly string[] = ['code', 'errcode', 'errCode', 'errorCode', 'error_code', 'status'];

/**
 * 安全 JSON 序列化：能处理**循环引用**、`undefined`、含函数的对象、BigInt。
 * 失败一律返回 null（由调用方降级到 `String(err)`）。
 */
function safeStringify(value: unknown): string | null {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key: string, val: unknown): unknown => {
      if (typeof val === 'object' && val !== null) {
        // 同一引用第二次出现 → 视为循环（比让 stringify 抛 TypeError 更安全）
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        return val;
      }
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'bigint') return String(val);
      return val;
    });
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/** 取第一个「标量」字段（string / 有限 number），取不到返回 null */
function firstScalar(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    let value: unknown;
    try {
      value = record[key];
    } catch {
      // 恶意 getter：跳过该字段，继续尝试下一个
      continue;
    }
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
  }
  return null;
}

/**
 * 把任意抛出的值格式化为可读字符串（**绝不抛异常**）。
 *
 * - `Error` 实例 → `message`；若 `name` 非空且不是 'Error'，拼为 `<name>: <message>`；
 * - `string` → 原样返回；
 * - 对象 → 依次取 `message` / `msg` / `error` / `error_msg` …；若同时有 `code`，
 *   拼为 `code=<code> <文案>`；仅有 code 时为 `code=<code>`；
 * - 其余 → 安全 JSON 序列化；序列化失败 → `String(err)`。
 */
export function formatError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const name = typeof err.name === 'string' ? err.name : '';
      const message = typeof err.message === 'string' ? err.message : '';
      if (name !== '' && name !== 'Error') return `${name}: ${message}`;
      return message;
    }

    if (typeof err === 'string') return err;

    if (
      typeof err === 'number' ||
      typeof err === 'boolean' ||
      typeof err === 'bigint' ||
      typeof err === 'symbol'
    ) {
      return String(err);
    }

    if (err === null || err === undefined) return String(err);

    if (typeof err === 'object') {
      const record = err as Record<string, unknown>;
      const text = firstScalar(record, TEXT_KEYS);
      const code = firstScalar(record, CODE_KEYS);
      if (text !== null && code !== null) return `code=${code} ${text}`;
      if (text !== null) return text;
      if (code !== null) return `code=${code}`;

      const serialized = safeStringify(err);
      if (serialized !== null && serialized !== '' && serialized !== '{}') return serialized;
      return String(err);
    }

    return String(err);
  } catch {
    try {
      return String(err);
    } catch {
      return 'unknown error';
    }
  }
}
