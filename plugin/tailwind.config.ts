import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置：颜色/间距/圆角/字号/阴影全部映射到 `styles/tokens.css` 的 CSS 变量，
 * 保证「唯一数值来源 = 04-UI设计说明.md §3」，避免在组件里散落魔法值。
 */
const config: Config = {
  content: ['./public/index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          active: 'var(--color-primary-active)',
          light: 'var(--color-primary-light)',
        },
        text: {
          1: 'var(--color-text-1)',
          2: 'var(--color-text-2)',
          3: 'var(--color-text-3)',
          disabled: 'var(--color-text-disabled)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          divider: 'var(--color-divider)',
        },
        bg: {
          app: 'var(--color-bg-app)',
          panel: 'var(--color-bg-panel)',
          canvas: 'var(--color-bg-canvas)',
        },
        success: { DEFAULT: 'var(--color-success)', light: 'var(--color-success-light)' },
        warning: { DEFAULT: 'var(--color-warning)', light: 'var(--color-warning-light)' },
        error: { DEFAULT: 'var(--color-error)', light: 'var(--color-error-light)' },
        info: { DEFAULT: 'var(--color-info)', light: 'var(--color-info-light)' },
      },
      fontFamily: {
        base: 'var(--font-family)',
      },
      fontSize: {
        '11': 'var(--font-size-11)',
        '12': 'var(--font-size-12)',
        '13': 'var(--font-size-13)',
        '14': 'var(--font-size-14)',
        '16': 'var(--font-size-16)',
        '20': 'var(--font-size-20)',
        '22': 'var(--font-size-22)',
        '28': 'var(--font-size-28)',
        'card-title': ['var(--font-size-card-title)', { lineHeight: 'var(--line-height-tight)', fontWeight: '600' }],
      },
      spacing: {
        '1': 'var(--space-1)',
        '2': 'var(--space-2)',
        '3': 'var(--space-3)',
        '4': 'var(--space-4)',
        '5': 'var(--space-5)',
        '6': 'var(--space-6)',
        '8': 'var(--space-8)',
        '12': 'var(--space-12)',
        toolbar: 'var(--layout-toolbar-height)',
        'grid-pad': 'var(--layout-grid-padding)',
        'card-gap': 'var(--layout-card-gap)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
        tag: 'var(--radius-tag)',
        paper: 'var(--radius-paper)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        'card-rest': 'var(--shadow-card-rest)',
        'card-hover': 'var(--shadow-card-hover)',
        drawer: 'var(--shadow-drawer)',
        paper: 'var(--shadow-paper)',
        popover: 'var(--shadow-popover)',
        'drag-ghost': 'var(--shadow-drag-ghost)',
      },
      transitionTimingFunction: {
        standard: 'var(--motion-ease-standard)',
        'ease-out': 'var(--motion-ease-out)',
        'ease-in': 'var(--motion-ease-in)',
      },
    },
  },
  plugins: [],
};

export default config;
