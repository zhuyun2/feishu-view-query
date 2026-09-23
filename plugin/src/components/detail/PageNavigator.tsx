/**
 * 页码导航（设计文档 §21.2 / §21.5 / M3-T06）。
 *
 * 职责：上一页 / 下一页 / 跳页（输入页码后回车或点「跳转」）/ 总页数显示（`n/total`）。
 * 纯逻辑（`clampPageIndex` / `formatPageIndicator`）单独导出，便于无布局单测。
 *
 * `currentPage` 为 **0 起**；对外呈现（指示器、跳页输入）用 **1 起**。
 */
import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { useCallback, useState } from 'react';

/** `PageNavigator` 入参 */
export interface PageNavigatorProps {
  /** 当前页（0 起） */
  currentPage: number;
  totalPages: number;
  onPageChange(page: number): void;
  /** 禁用全部交互（打印态 / 分页中）；缺省 false */
  disabled?: boolean;
}

/** 把页码钳制到 `[0, totalPages - 1]`；非法输入 → 0 */
export function clampPageIndex(page: number, totalPages: number): number {
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(Math.trunc(page), 0), total - 1);
}

/** 指示器文本：`n/total`（1 起） */
export function formatPageIndicator(currentPage: number, totalPages: number): string {
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  return `${clampPageIndex(currentPage, total) + 1}/${total}`;
}

/**
 * 页码导航组件。
 */
export function PageNavigator(props: PageNavigatorProps): ReactElement {
  const { currentPage, totalPages, onPageChange, disabled } = props;
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  const current = clampPageIndex(currentPage, total);
  const [jumpValue, setJumpValue] = useState('');

  const go = useCallback(
    (page: number): void => {
      if (disabled === true) return;
      onPageChange(clampPageIndex(page, total));
    },
    [disabled, onPageChange, total],
  );

  const onSubmitJump = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const parsed = Number.parseInt(jumpValue, 10);
      if (Number.isFinite(parsed)) go(parsed - 1);
      setJumpValue('');
    },
    [jumpValue, go],
  );

  return (
    <nav
      className="cbv-page-nav"
      data-testid="page-navigator"
      data-current-page={current}
      data-total-pages={total}
      aria-label="页码导航"
    >
      <button
        type="button"
        className="cbv-btn cbv-page-nav__prev"
        data-page-nav="prev"
        onClick={() => go(current - 1)}
        disabled={disabled === true || current <= 0}
        aria-label="上一页"
      >
        ↑
      </button>
      <span className="cbv-page-nav__indicator cbv-page-number" data-page-indicator="true">
        {formatPageIndicator(current, total)}
      </span>
      <button
        type="button"
        className="cbv-btn cbv-page-nav__next"
        data-page-nav="next"
        onClick={() => go(current + 1)}
        disabled={disabled === true || current >= total - 1}
        aria-label="下一页"
      >
        ↓
      </button>
      <form className="cbv-page-nav__jump" onSubmit={onSubmitJump}>
        <input
          className="cbv-input cbv-page-nav__input"
          data-page-nav="input"
          type="number"
          min={1}
          max={total}
          value={jumpValue}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setJumpValue(event.target.value)}
          aria-label="跳转页码"
        />
        <button type="submit" className="cbv-btn cbv-page-nav__go" data-page-nav="go" disabled={disabled === true}>
          跳转
        </button>
      </form>
    </nav>
  );
}

export default PageNavigator;
