/**
 * 统一日志出口（§12 日志约定：ctx 必带 viewId / tableId / pluginVersion）。
 * 全项目唯一允许使用 console 的地方（eslint 已放开）。
 */
/* eslint-disable no-console */
import { formatError } from './errorText';

export interface LogContext {
  viewId?: string;
  tableId?: string;
  pluginVersion?: string;
  [key: string]: unknown;
}

function prefix(scope: string, ctx?: LogContext): string {
  const parts = [`[cbv:${scope}]`];
  if (ctx && ctx.viewId) parts.push(`view=${ctx.viewId}`);
  if (ctx && ctx.tableId) parts.push(`table=${ctx.tableId}`);
  return parts.join(' ');
}

/** 记录错误（不抛出，保证单点失败不扩散） */
export function logError(scope: string, err: unknown, ctx?: LogContext): void {
  // 非 Error 对象（飞书 SDK 形如 { code, msg }）必须保留错误码与原因，
  // 否则 String(err) 只会得到 "[object Object]"，生产环境无法诊断。
  const message = formatError(err);
  console.error(prefix(scope, ctx), message, { error: err, ...ctx });
}

/** 记录警告 */
export function logWarn(scope: string, message: string, ctx?: LogContext): void {
  console.warn(prefix(scope, ctx), message, ctx);
}

/** 记录信息（开发期诊断用；生产构建可自行裁剪） */
export function logInfo(scope: string, message: string, ctx?: LogContext): void {
  console.warn(prefix(scope, ctx), message, ctx);
}
