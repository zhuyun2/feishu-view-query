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

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }): JSX.Element {
  return (
    <div className="cbv-app">
      <div className="cbv-state" role="alert">
        <div className="cbv-state__title">加载失败</div>
        <div className="cbv-state__desc">{message ?? '未知错误'}</div>
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
  const { reload } = useCardViewInit();

  if (status === 'error') {
    return <ErrorState message={errorMessage} onRetry={() => void reload()} />;
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
