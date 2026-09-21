/**
 * 环境探测（设计文档 §6.2）：产品端 / 语言 / 主题 / tableId / viewId。
 * 全部调用做防御性 try/catch：任一项探测失败都不阻断插件启动（给默认值）。
 *
 * 已核对 `@lark-base-open/js-sdk@1.0.2`：
 *  - `bridge.getLocale(): Promise<Locale>` / `bridge.getLanguage(): Promise<Language>`
 *  - `bridge.getTheme(): Promise<ThemeModeType>`（'LIGHT' | 'DARK'）
 *  - `bridge.getUserId(): Promise<string>`
 *  - `bridge.getEnv(): Promise<Env>`（Env.product: 'lark' | 'feishu'）
 *  - `bridge.onThemeChange(cb: (ev: IEventCbCtx<ThemeModeCtx>) => void): () => void`
 */
import { bitable } from '@lark-base-open/js-sdk';
import { getAppId, getSelection } from './base';
import { logError } from '@/utils/log';

export type ProductType = 'client' | 'web' | 'unknown';
export type ThemeMode = 'light' | 'dark';

export interface EnvSnapshot {
  productType: ProductType;
  language: string;
  theme: ThemeMode;
  tableId: string;
  viewId: string;
  appId: string;
  userId: string;
}

interface BridgeShortcuts {
  getLocale?: () => Promise<unknown>;
  getLanguage?: () => Promise<unknown>;
  getTheme?: () => Promise<unknown>;
  getProductType?: () => Promise<unknown>;
  getUserId?: () => Promise<unknown>;
  getEnv?: () => Promise<unknown>;
  onThemeChange?: (cb: (ev: unknown) => void) => unknown;
}

function bridgeShortcuts(): BridgeShortcuts {
  return bitable.bridge as unknown as BridgeShortcuts;
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

/** 语言（优先 getLocale，其次 getLanguage；默认 zh-CN） */
export async function getLanguage(): Promise<string> {
  const shortcuts = bridgeShortcuts();
  try {
    const fromLocale = normalizeLanguage(await shortcuts.getLocale?.());
    if (fromLocale) return fromLocale;
  } catch (err) {
    logError('env.getLocale', err);
  }
  try {
    const fromLanguage = normalizeLanguage(await shortcuts.getLanguage?.());
    if (fromLanguage) return fromLanguage;
  } catch (err) {
    logError('env.getLanguage', err);
  }
  return 'zh-CN';
}

/** 主题（默认 light；本期不做深色皮肤，仅据宿主切换根属性） */
export async function getTheme(): Promise<ThemeMode> {
  try {
    const value = await bridgeShortcuts().getTheme?.();
    if (typeof value === 'string') {
      return value.toLowerCase().includes('dark') ? 'dark' : 'light';
    }
  } catch (err) {
    logError('env.getTheme', err);
  }
  return 'light';
}

/** 产品端（桌面客户端 / 网页版；探测不到返回 unknown） */
export async function getProductType(): Promise<ProductType> {
  try {
    const shortcuts = bridgeShortcuts();
    const explicit = await shortcuts.getProductType?.();
    const normalized = typeof explicit === 'string' ? explicit.toLowerCase() : '';
    if (normalized.includes('web')) return 'web';
    if (normalized.includes('client') || normalized.includes('pc')) return 'client';
    // 退而使用 getEnv().product（lark / feishu 无法区分端，仅作存在性探测）
    const env = await shortcuts.getEnv?.();
    if (typeof env === 'object' && env !== null) {
      const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : '';
      return /Lark|Feishu/i.test(userAgent) ? 'client' : 'web';
    }
  } catch (err) {
    logError('env.getProductType', err);
  }
  return 'unknown';
}

/** 当前用户 id（仅用于配置 meta.updatedBy，不对外展示） */
export async function getUserId(): Promise<string> {
  try {
    const value = await bridgeShortcuts().getUserId?.();
    if (typeof value === 'string' && value !== '') return value;
  } catch (err) {
    logError('env.getUserId', err);
  }
  return 'unknown';
}

/** 一次性快照（初始化用） */
export async function getEnvSnapshot(): Promise<EnvSnapshot> {
  const [selection, language, theme, productType, userId] = await Promise.all([
    getSelection(),
    getLanguage(),
    getTheme(),
    getProductType(),
    getUserId(),
  ]);
  return {
    tableId: selection.tableId,
    viewId: selection.viewId,
    appId: getAppId(),
    language,
    theme,
    productType,
    userId,
  };
}

/** 订阅宿主主题变化（返回取消订阅函数；API 不可用时静默 no-op） */
export function subscribeThemeChange(onChange: (theme: ThemeMode) => void): () => void {
  try {
    const bridge = bridgeShortcuts();
    if (typeof bridge.onThemeChange !== 'function') return () => undefined;
    const dispose = bridge.onThemeChange((event: unknown) => {
      // IEventCbCtx<ThemeModeCtx> = { data: { theme: 'LIGHT' | 'DARK' } }
      let raw: unknown = event;
      if (typeof event === 'object' && event !== null) {
        const container = event as Record<string, unknown>;
        raw = typeof container.data === 'object' && container.data !== null
          ? (container.data as Record<string, unknown>).theme
          : container.theme;
      }
      const value = typeof raw === 'string' ? raw : '';
      onChange(value.toLowerCase().includes('dark') ? 'dark' : 'light');
    });
    return typeof dispose === 'function' ? (dispose as () => void) : () => undefined;
  } catch (err) {
    logError('env.subscribeThemeChange', err);
    return () => undefined;
  }
}
