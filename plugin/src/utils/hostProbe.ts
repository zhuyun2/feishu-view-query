/**
 * 宿主环境诊断（真机 E2E「所有 bitable SDK 调用统一 timeout」的取证工具）。
 *
 * ## 为什么需要它
 * 插件与多维表格宿主之间靠 `postMessage` 通信，而**不同 SDK 走的是两套互不兼容的协议**：
 *
 *  - `@lark-base-open/js-sdk`（**本项目当前在用**，v1.0.2）：**proactive handshake** 协议。
 *    客户端向 `window.parent` 发 `{ id, type:'handshake', payload:{ proactive:true } }`，
 *    等待宿主回一个带 `prefixId` 的 handshake 回调；重试 5 次仍无应答就 `reject('time out')`。
 *    且**每个 API 调用都是 `invokeApi(){ yield this._handshakePromise; ... }`** ——
 *    握手不过，所有 API 一起超时（这正好解释了"连 getLocale/getTheme 都超时"）。
 *
 *  - `@lark-opdev/block-bitable-api`（Pack SDK，最新 `0.4.1-alpha.11`）：**iframe-block** 协议。
 *    要求宿主把 `window.name` 写成 `{ blockTypeId, channel }`（创建 iframe 时写入），
 *    消息体带 `signature:'iframe-block'` 并按 `channel` 路由；取不到 `window.name` 就直接
 *    `throw new Error('Block client only running in Block host')`。**全文不含 handshake。**
 *
 * 于是「宿主到底实现了哪套协议」成为"要不要换 SDK"的唯一依据。而这个依据**只能从运行时
 * 宿主环境取**，静态分析取不到 —— 本模块就是把这个取证固化成一次函数调用 + 一段可复制文本。
 *
 * ## ⚠️ 迁移理由只能是「协议不兼容」，不是「版本新旧」
 * 时间线是反直觉的：`@lark-base-open/js-sdk@1.0.2` 发布于 **2026-01-21**，反而比
 * `@lark-opdev/block-bitable-api@0.4.1-alpha.11`（**2024-11-15**）**新约 14 个月**。
 * 因此任何人不得再用"旧包过时"作为换 SDK 的依据。
 *
 * ## 判定口径（见 `judgeHostProtocol`）
 *  - `hasBlockTypeId && hasChannel === true` → **iframe-block**：宿主实现 Pack SDK 协议，换 SDK 有依据；
 *  - `inIframe === false`                    → **不在 iframe 中**：属容器 / 嵌套问题，**换 SDK 无效**；
 *  - 两者都不是                               → **协议未知**，需另行取证。
 *
 * ## 契约
 * 本模块**保证不抛异常**：每个字段独立 `try/catch`。取证本身就是为了在"已经出错"的场景下
 * 使用，绝不能让自己变成新的崩溃点（跨域访问 `window.top`、宿主改写 `window.name` getter 等
 * 恶劣情况都必须扛住）。
 */
import { formatError } from './errorText';

/** 一次宿主环境取证的完整结果（全部字段保证有值，绝不抛异常） */
export interface HostProbeResult {
  /** `window.name` 原样字符串（空串也算取到了，表示"宿主没写"） */
  windowNameRaw: string;
  /** `JSON.parse(window.name)` 的结果；解析失败或原值为空串时为 `null` */
  windowNameParsed: unknown | null;
  /** 解析失败原因；解析成功时为 `null` */
  windowNameParseError: string | null;
  /** 解析结果是对象、且 `blockTypeId` 为非空字符串 */
  hasBlockTypeId: boolean;
  /** 解析结果是对象、且 `channel` 为非空字符串 */
  hasChannel: boolean;
  /** `window.parent !== window`（取不到时保守判为 true：能抛异常说明存在异域父窗口） */
  inIframe: boolean;
  /** `window.self === window.top`；跨域访问 `window.top` 抛异常时判为 false（存在跨域祖先） */
  isTopLevel: boolean;
  /** 祖先层数：`1` = 无父窗口；`2` = 至少一层父窗口（更深层跨域取不到，统一记 2） */
  ancestorCount: number;
  /** `location.href` */
  href: string;
  /** `location.origin` */
  origin: string;
  /** `navigator.userAgent` */
  userAgent: string;
  /** `document.referrer` */
  referrer: string;
}

/** 协议判定结论 */
export type HostProtocolVerdict = 'iframe-block' | 'not-in-iframe' | 'unknown';

/** 错误值的原始形态（用于判定 'timeout' / 'time out' / 对象 到底是哪一种） */
export interface ErrorShape {
  /** `formatError(err)` 归一化结果 */
  formatted: string;
  /** `String(err)` 原样结果 —— 区分字符串 `'timeout'` 与对象 `[object Object]` 的关键 */
  stringified: string;
  /** `typeof err` */
  typeOf: string;
  /** `err instanceof Error` */
  isErrorInstance: boolean;
}

/** 读取一个字符串型宿主字段；宿主 getter 抛异常 / 返回非字符串时降级为 '' */
function safeRead(read: () => string): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 是否为「非数组的普通对象」 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 对象上是否存在「非空字符串」属性（getter 抛异常视为不存在） */
function hasNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  try {
    const value = record[key];
    return typeof value === 'string' && value !== '';
  } catch {
    return false;
  }
}

/** 是否在 iframe 中（跨域下 `window.parent` 可读、读其属性才抛，故这里几乎不会进 catch） */
function detectInIframe(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.parent !== window;
  } catch {
    // 取不到 parent 时保守判为 true：能抛异常说明存在一个（异域的）父窗口
    return true;
  }
}

/** 是否顶层窗口（跨域读 `window.top` 会抛 SecurityError → 说明存在跨域祖先，必然非顶层） */
function detectIsTopLevel(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.self === window.top;
  } catch {
    return false;
  }
}

/**
 * 采集宿主环境取证信息。**绝不抛异常。**
 *
 * 用法（错误分支里调用，随日志与 UI 一起输出）：
 * ```ts
 * const probe = collectHostProbe();
 * logError('init', err, { step, probe });
 * ```
 */
export function collectHostProbe(): HostProbeResult {
  const windowNameRaw = safeRead(() => (typeof window === 'undefined' ? '' : window.name));

  let windowNameParsed: unknown | null = null;
  let windowNameParseError: string | null = null;
  if (windowNameRaw !== '') {
    try {
      windowNameParsed = JSON.parse(windowNameRaw) as unknown;
    } catch (err) {
      windowNameParsed = null;
      windowNameParseError = formatError(err);
    }
  }

  const parsedRecord = isPlainRecord(windowNameParsed) ? windowNameParsed : null;
  const hasBlockTypeId = parsedRecord !== null && hasNonEmptyString(parsedRecord, 'blockTypeId');
  const hasChannel = parsedRecord !== null && hasNonEmptyString(parsedRecord, 'channel');

  const inIframe = detectInIframe();

  return {
    windowNameRaw,
    windowNameParsed,
    windowNameParseError,
    hasBlockTypeId,
    hasChannel,
    inIframe,
    isTopLevel: detectIsTopLevel(),
    ancestorCount: inIframe ? 2 : 1,
    href: safeRead(() => (typeof location === 'undefined' ? '' : location.href)),
    origin: safeRead(() => (typeof location === 'undefined' ? '' : location.origin)),
    userAgent: safeRead(() => (typeof navigator === 'undefined' ? '' : navigator.userAgent)),
    referrer: safeRead(() => (typeof document === 'undefined' ? '' : document.referrer)),
  };
}

/**
 * 依据取证结果判定宿主协议：
 *  - `iframe-block` —— `hasBlockTypeId && hasChannel`，宿主实现 Pack SDK 协议，换 SDK 有依据；
 *  - `not-in-iframe` —— 不在 iframe 中，属容器 / 嵌套问题，**换 SDK 无效**；
 *  - `unknown` —— 协议未知，需另行取证。
 */
export function judgeHostProtocol(probe: HostProbeResult): HostProtocolVerdict {
  if (probe.hasBlockTypeId && probe.hasChannel) return 'iframe-block';
  if (!probe.inIframe) return 'not-in-iframe';
  return 'unknown';
}

/** 判定结论的人类可读说明（供 UI 直接展示） */
export function describeHostProtocol(verdict: HostProtocolVerdict): string {
  if (verdict === 'iframe-block') {
    return 'iframe-block ✓（宿主实现 Pack SDK 协议，换 SDK 有依据）';
  }
  if (verdict === 'not-in-iframe') {
    return '不在 iframe 中（容器 / 嵌套问题，换 SDK 无效）';
  }
  return '未知（需另行取证）';
}

/** 把取证结果格式化为等宽多行文本（供 `<pre>` 展示，用户可整段选中复制） */
export function formatHostProbe(probe: HostProbeResult): string {
  const verdict = judgeHostProtocol(probe);
  const lines: string[] = [
    '—— 环境诊断（请截图给开发）——',
    `window.name    = ${probe.windowNameRaw === '' ? '(空)' : probe.windowNameRaw}`,
    `协议判定        = ${describeHostProtocol(verdict)}`,
    `在 iframe 内    = ${String(probe.inIframe)}`,
    `是否顶层        = ${String(probe.isTopLevel)}`,
    `祖先层级        = ${probe.ancestorCount === 1 ? '1（无父窗口）' : '2+（有父窗口，更深层跨域取不到）'}`,
    `href           = ${probe.href === '' ? '(空)' : probe.href}`,
    `origin         = ${probe.origin === '' ? '(空)' : probe.origin}`,
    `UA             = ${probe.userAgent === '' ? '(空)' : probe.userAgent}`,
    `referrer       = ${probe.referrer === '' ? '(空)' : probe.referrer}`,
  ];
  if (probe.windowNameParseError !== null) {
    lines.push(`name 解析失败   = ${probe.windowNameParseError}`);
  }
  return lines.join('\n');
}

/**
 * 采集错误值的**原始形态**。**绝不抛异常。**
 *
 * 用途：判定真机那个 `timeout` 到底来自哪一层 ——
 *  - `stringified === 'timeout'` 且 `typeOf === 'string'` → err 本身就是字符串 `'timeout'`
 *    （注意：SDK 里的字面量是 "time out" 两词，若真机是一词，说明来自**另一层**）；
 *  - `typeOf === 'object'` 且 `stringified === '[object Object]'` → err 是飞书那类普通对象，
 *    只有 `formatError` 能把 `code` / `msg` 捞出来。
 */
export function collectErrorShape(err: unknown): ErrorShape {
  let stringified = '';
  try {
    stringified = String(err);
  } catch {
    stringified = '<String(err) 抛异常>';
  }
  return {
    formatted: formatError(err),
    stringified,
    typeOf: typeof err,
    isErrorInstance: err instanceof Error,
  };
}

/** 把错误形态格式化为等宽多行文本 */
export function formatErrorShape(shape: ErrorShape): string {
  return [
    '—— 错误原始形态 ——',
    `formatError(err)      = ${shape.formatted}`,
    `String(err)           = ${shape.stringified}`,
    `typeof err            = ${shape.typeOf}`,
    `err instanceof Error  = ${String(shape.isErrorInstance)}`,
  ].join('\n');
}
