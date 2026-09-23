/**
 * 提示条（设计文档 §12 / §14 + 04 §6 + 04 §11 R7/R8）。
 *
 * - `Banner`：纯展示组件（语义色 + 必带图标/文字，见 04 §3.2 可访问性）。
 * - `BannerStack`：读取 store，按状态渲染四类提示：
 *    ① 更高版本只读（warning）；
 *    ② **R8：介质降级 → 常驻、不可关闭**（warning，「配置仅本地保存…」）；
 *    ③ 数据损坏（error，已回退默认模板 + 备份原值）；
 *    ④ **D4 复制视图首开 / 首次生成配置**（info，含「从模板重配 / 立即配置」两动作 + 可关闭 R7）。
 */
import type { ReactNode } from 'react';
import { useViewStore } from '@/state/ViewStore';
import { useUiStore } from '@/state/UiStore';

export type BannerKind = 'info' | 'warning' | 'error';

const ICONS: Record<BannerKind, string> = {
  info: 'ℹ',
  warning: '⚠',
  error: '✕',
};

export interface BannerProps {
  kind: BannerKind;
  children: ReactNode;
  /** R7：是否可关闭（仅 D4 首开提示可关闭；降级提示条**不可**关闭） */
  onDismiss?: () => void;
  /** 主/次动作 */
  actions?: ReactNode;
  /** 测试定位 */
  testId?: string;
}

export function Banner({ kind, children, onDismiss, actions, testId }: BannerProps): JSX.Element {
  return (
    <div
      className={`cbv-banner cbv-banner--${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      data-banner-kind={kind}
      data-testid={testId}
    >
      <span className="cbv-banner__icon" aria-hidden="true">
        {ICONS[kind]}
      </span>
      <span className="cbv-banner__text">{children}</span>
      {actions ? <span className="cbv-banner__actions">{actions}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          className="cbv-banner__close"
          aria-label="关闭提示"
          data-testid={testId ? `${testId}-close` : undefined}
          onClick={onDismiss}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** D4 动作回调（由上层注入，避免 Banner 直连编辑器逻辑） */
export interface BannerStackProps {
  /** 「从模板重配」 */
  onReconfigureFromTemplate?: () => void;
  /** 「立即配置」（进入编辑态） */
  onOpenEditor?: () => void;
  /** 「重试读取」（数据损坏时） */
  onRetryRead?: () => void;
}

export function BannerStack({ onReconfigureFromTemplate, onOpenEditor, onRetryRead }: BannerStackProps): JSX.Element | null {
  const unsupportedNewer = useViewStore((state) => state.unsupportedNewer);
  const degraded = useViewStore((state) => state.degraded);
  const degradedReason = useViewStore((state) => state.degradedReason);
  const corrupted = useViewStore((state) => state.corrupted);
  const configCorrupted = useViewStore((state) => state.configCorrupted);
  const provisionedFromTemplate = useViewStore((state) => state.provisionedFromTemplate);
  const copyScenario = useViewStore((state) => state.copyScenario);
  const copyBannerDismissed = useUiStore((state) => state.copyBannerDismissed);
  const dismissCopyBanner = useUiStore((state) => state.dismissCopyBanner);

  const items: JSX.Element[] = [];

  if (unsupportedNewer) {
    items.push(
      <Banner key="newer" kind="warning" testId="banner-newer-readonly">
        配置由更高版本插件创建，当前为「只读模式」，已忽略未知字段，禁止保存。
      </Banner>,
    );
  }

  // R8：介质降级提示条**常驻不可关闭**。
  // 必须用 `corrupted` 而非 `configCorrupted` 排除：后者多带了 `load.config === null` 条件，
  // 会出现「数据损坏过但 config 非 null」时 R8 又冒出来陈述存储位置的错误。
  // 两条天然互斥：corrupted → 数据损坏条；degraded && !corrupted → 介质降级条。
  if (degraded && corrupted !== true) {
    items.push(
      <Banner key="degraded" kind="warning" testId="banner-degraded">
        {degradedReason && degradedReason.trim() !== ''
          ? degradedReason
          : '配置仅本地保存，其他成员看不到你的排版（未满足 US-4 AC2）。'}
      </Banner>,
    );
  }

  // 数据损坏（区别于介质降级）：已回退默认模板 + 备份原值
  if (configCorrupted) {
    items.push(
      <Banner
        key="corrupted"
        kind="error"
        testId="banner-corrupted"
        actions={
          onRetryRead ? (
            <button type="button" className="cbv-btn" onClick={onRetryRead}>
              重试读取
            </button>
          ) : undefined
        }
      >
        检测到配置数据损坏，已回退默认排版，并保留了原始数据备份（未改动你的表格数据）。
      </Banner>,
    );
  }

  // D4：复制视图首开 / 首次生成配置（R7 可关闭）
  if (provisionedFromTemplate && !copyBannerDismissed) {
    items.push(
      <Banner
        key="provisioned"
        kind="info"
        testId="banner-provisioned"
        onDismiss={dismissCopyBanner}
        actions={
          <>
            {onReconfigureFromTemplate ? (
              <button type="button" className="cbv-btn" onClick={onReconfigureFromTemplate}>
                从模板重配
              </button>
            ) : null}
            {onOpenEditor ? (
              <button type="button" className="cbv-btn cbv-btn--primary" onClick={onOpenEditor}>
                立即配置
              </button>
            ) : null}
          </>
        }
      >
        {copyScenario
          ? '这是从模板新生成的配置（复制视图不会自动跟随原视图配置），可直接使用或稍后重配。'
          : '首次打开已按默认模板生成配置，可直接使用或按需调整。'}
      </Banner>,
    );
  }

  if (items.length === 0) return null;
  return <div className="cbv-banner-stack">{items}</div>;
}
