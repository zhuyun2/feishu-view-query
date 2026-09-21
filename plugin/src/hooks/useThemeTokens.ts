/**
 * 主题 token 注入（设计文档 §6.2 / §15）。
 *
 * token 的**唯一数值来源**是 `styles/tokens.css`（04 §3）。
 * 本 hook 只把「可配置项」（主色 / 圆角 / 字号缩放 / 密度）作为运行时覆盖写到根元素，
 * 并同步宿主主题（light/dark）标记，避免在组件里散落魔法值。
 */
import { useEffect, useMemo } from 'react';
import { useViewStore } from '@/state/ViewStore';
import { defaultDensity, defaultTheme } from '@/config/defaults';
import type { ThemeMode } from '@/sdk/env';
import type { DensityConfig, StyleTheme } from '@/config/types';

export interface ThemeTokens {
  theme: StyleTheme;
  density: DensityConfig;
  hostTheme: ThemeMode;
  /** 卡片标题行高（token：--line-height-tight） */
  titleLineHeight: string;
}

/** 计算运行时 token 覆盖（纯函数，便于单测/复用） */
export function resolveThemeTokens(
  theme: StyleTheme | null | undefined,
  density: DensityConfig | null | undefined,
  hostTheme: ThemeMode,
): ThemeTokens {
  return {
    theme: theme ?? defaultTheme(),
    density: density ?? defaultDensity(),
    hostTheme,
    titleLineHeight: '1.35',
  };
}

/** 把 token 写到 :root（仅覆盖可配置项，其余保留 tokens.css 默认） */
function injectTokens(tokens: ThemeTokens): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const { theme, density } = tokens;
  root.style.setProperty('--color-primary', theme.primaryColor);
  root.style.setProperty('--radius-card', `${theme.borderRadius}px`);
  root.style.setProperty('--layout-card-min-width', `${density.cardMinWidth}px`);
  root.style.setProperty('--layout-card-gap', `${density.gap}px`);
  root.style.setProperty('--grid-card-min-width', `${density.cardMinWidth}px`);
  root.style.setProperty('--layout-grid-padding', `${density.padding}px`);
  // 字号缩放只作用于「卡片标题 / 卡片字段值」，正文保持 14px 基准
  root.style.setProperty('--font-size-card-title', `${15 * theme.fontScale}px`);
  root.style.setProperty('--cbv-font-scale', String(theme.fontScale));
  root.setAttribute('data-cbv-theme', tokens.hostTheme);
}

export function useThemeTokens(): ThemeTokens {
  const theme = useViewStore((state) => state.config?.theme);
  const density = useViewStore((state) => state.config?.density);
  const hostTheme = useViewStore((state) => state.env?.theme ?? 'light');

  const tokens = useMemo(
    () => resolveThemeTokens(theme, density, hostTheme),
    [theme, density, hostTheme],
  );

  useEffect(() => {
    injectTokens(tokens);
  }, [tokens]);

  return tokens;
}
