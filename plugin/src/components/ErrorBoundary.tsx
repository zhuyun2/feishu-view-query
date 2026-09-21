/**
 * 错误边界（设计文档 §12 / §14）：**插件绝不白屏**。
 *
 * 三处独立边界（T13）：
 *  ① `variant="app"`  —— 顶层，兜住一切渲染异常（由 `main.tsx` 使用）；
 *  ② `variant="grid"` —— 卡片区，单卡渲染异常不拖垮整面墙；
 *  ③ `variant="doc"`  —— 文档/抽屉区，详情渲染异常不影响卡片墙。
 *
 * 兜底 UI 一律为「可读文案 + 重试按钮」，不含任何原始数据 / 堆栈（安全边界）。
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { APP_NAME } from '@/constants';
import { logError } from '@/utils/log';

export type BoundaryVariant = 'app' | 'grid' | 'doc';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 边界作用域，决定兜底文案与样式 */
  variant?: BoundaryVariant;
  /** 自定义兜底（可选；不传则用内置） */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const SCOPES: Record<BoundaryVariant, { title: string; desc: string }> = {
  app: {
    title: `${APP_NAME} 出现问题`,
    desc: '插件已进入降级保护，未影响你的表格数据。可尝试重试，或刷新页面。',
  },
  grid: {
    title: '卡片区渲染异常',
    desc: '已保护你正常浏览其他内容；可重试或刷新页面。',
  },
  doc: {
    title: '详情渲染异常',
    desc: '该记录的详情暂时无法展示；卡片墙与数据均未受影响。',
  },
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError(`boundary.${this.props.variant ?? 'app'}`, error, { componentStack: info.componentStack });
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const variant: BoundaryVariant = this.props.variant ?? 'app';
    if (this.props.fallback) return this.props.fallback(error, this.handleReset);

    const scope = SCOPES[variant];
    return (
      <div className={`cbv-app cbv-app--boundary cbv-app--boundary-${variant}`} data-boundary={variant}>
        <div className="cbv-state" role="alert">
          <div className="cbv-state__title">{scope.title}</div>
          <div className="cbv-state__desc">{error.message || '未知错误'}</div>
          <div className="cbv-state__hint">{scope.desc}</div>
          <button type="button" className="cbv-btn" onClick={this.handleReset}>
            重试
          </button>
        </div>
      </div>
    );
  }
}
