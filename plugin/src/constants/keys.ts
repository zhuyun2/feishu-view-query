/**
 * 存储 key 与容量预算常量（设计文档 §15 存储 key 约定 + §12 配置体积超限）。
 * 统一前缀 `cbv:`，便于排查与清理。
 */

/** 全局前缀 */
export const STORAGE_PREFIX = 'cbv';

/** 配置存储 key 前缀（bridge 作用域为「文档 + 插件」级，必须附加 viewId 命名空间） */
export const CONFIG_KEY_PREFIX = `${STORAGE_PREFIX}:config`;

/**
 * 视图配置文件 key。
 * ⚠️ 必须带 viewId：bridge 作用域是「同一文档 + 同一插件」级、而非视图级，
 * 同一文档可存在多个卡片视图，不加命名空间会互相覆盖。
 */
export function configKey(viewId: string): string {
  return `${CONFIG_KEY_PREFIX}:${viewId}`;
}

/** 配置备份 key（损坏/迁移失败时保留原值） */
export function backupKey(viewId: string, timestamp: number): string {
  return `${CONFIG_KEY_PREFIX}:${viewId}:backup:${timestamp}`;
}

/** 降级（localStorage）配置 key：补 appId 维度，避免多应用同浏览器串扰 */
export function degradedConfigKey(appId: string, viewId: string): string {
  return `${STORAGE_PREFIX}:config:${appId}:${viewId}`;
}

/** 埋点 key（MVP 无外网上报，落 bridge/localStorage） */
export function metricsKey(viewId: string): string {
  return `${STORAGE_PREFIX}:metrics:${viewId}`;
}

/** 配置体积预算：≤ 64KB（D9） */
export const CONFIG_SIZE_LIMIT_BYTES = 64 * 1024;

/** 配置体积「接近上限」提示阈值（80%） */
export const CONFIG_SIZE_WARN_BYTES = Math.floor(CONFIG_SIZE_LIMIT_BYTES * 0.8);
