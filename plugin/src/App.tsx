/**
 * 应用根：Boot / Loading / Browse / Error 四态分发（设计文档 §14）。
 * 初始化编排在 `useCardViewInit`；主题 token 与权限在 Browse 态生效。
 *
 * 顶层 ErrorBoundary 位于 `main.tsx`（`variant="app"`）；卡片区与文档区的
 * 独立边界位于 `ViewShell`（`variant="grid"` / `variant="doc"`）——三处齐备，插件不白屏。
 */
import { APP_NAME } from '@/constants';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ViewShell } from '@/components/layout/ViewShell';
import { useCardViewInit } from '@/hooks/useCardViewInit';
import { usePermission } from '@/hooks/usePermission';
import { useThemeTokens } from '@/hooks/useThemeTokens';
import { useViewStore } from '@/state/ViewStore';
import type { ErrorShape, HostProbeResult } from '@/utils/hostProbe';
import { formatErrorShape, formatHostProbe } from '@/utils/hostProbe';

function LoadingState({ label }: { label: string }): JSX.Element {
  return (
    <div className="cbv-app">
      <div className="cbv-state">
        <div className="cbv-state__title">{APP_NAME}</div>
        <div className="cbv-state__desc">{label}</div>
      </div>
    </div>
  );
}

/**
 * 错误态。
 *
 * 除标题 / 副标题 / 重试按钮外，附一段**只读诊断文本**（等宽 `<pre>`，可整段选中复制）：
 * 真机 E2E 里"所有 SDK 调用统一 timeout"，需要靠它判定宿主实现的是哪套通信协议。
 * 仅在 `probe` / `shape` 存在时渲染 —— 成功路径绝不会出现。
 */
function ErrorState({
  message,
  probe,
  shape,
  onRetry,
}: {
  message: string | null;
  probe: HostProbeResult | null;
  shape: ErrorShape | null;
  onRetry: () => void;
}): JSX.Element {
  const sections: string[] = [];
  if (shape) sections.push(formatErrorShape(shape));
  if (probe) sections.push(formatHostProbe(probe));

  return (
    <div className="cbv-app">
      <div className="cbv-state" role="alert">
        <div className="cbv-state__title">加载失败</div>
        <div className="cbv-state__desc">{message ?? '未知错误'}</div>
        {sections.length > 0 ? (
          <pre className="cbv-state__diag" data-testid="host-probe">
            {sections.join('\n\n')}
          </pre>
        ) : null}
        <button type="button" className="cbv-btn cbv-btn--primary" onClick={onRetry}>
          重试
        </button>
      </div>
    </div>
  );
}

function BrowseView(): JSX.Element {
  const permission = usePermission();
  const tokens = useThemeTokens();
  return (
    <>
      <ViewShell tokens={tokens} />
      {!permission.canEditConfig && !permission.loading ? (
        <div hidden aria-live="polite">
          仅查看权限：配置入口已隐藏
        </div>
      ) : null}
    </>
  );
}

export default function App(): JSX.Element {
  const status = useViewStore((state) => state.status);
  const errorMessage = useViewStore((state) => state.errorMessage);
  const errorProbe = useViewStore((state) => state.errorProbe);
  const errorShape = useViewStore((state) => state.errorShape);
  const { reload } = useCardViewInit();

  if (status === 'error') {
    return (
      <ErrorState
        message={errorMessage}
        probe={errorProbe}
        shape={errorShape}
        onRetry={() => void reload()}
      />
    );
  }
  if (status === 'browse') {
    return (
      <ErrorBoundary variant="app">
        <BrowseView />
      </ErrorBoundary>
    );
  }
  return <LoadingState label={status === 'loading' ? '正在加载视图数据…' : '正在初始化…'} />;
}
