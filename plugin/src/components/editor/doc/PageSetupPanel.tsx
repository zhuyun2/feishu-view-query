/**
 * 页面设置面板（M3-T09 / 设计文档 §21.6 右栏「页面设置」段）。
 *
 * ⭐ 设计变更（2026-09-21，用户拍板）：详情已改为「单张连续长页」，**移除**「页眉 / 页码 / 页脚」
 * 三项编辑控件；**保留**「纸张尺寸 / 方向 / 页边距」（它们决定内容宽度，直接影响文字换行位置）。
 *
 * ⚠️ `src/config/types.ts` 的 `PageSetup` **仍然保留** `header` / `footer` / `showPageNumber` /
 * `pageNumberFormat` / `headerFooterScope` 字段（**有意保留，非死代码**）：已保存的历史配置里存在
 * 这些字段，删字段会让老配置迁移/反序列化失败。此处只是**不再编辑 / 不再渲染**它们。
 *
 * ⚠️ 单位口径（§21.9）：内部一律 **px @96dpi**；UI 以 mm 呈现，换算只走
 * `constants/paper.ts` 的 `mmToPx` / `pxToMm`，**不散落 magic number**。
 *
 * 纯函数 `patchPageSetup` / `withMarginMm` 供单测直接断言「页设置改动写入草稿的 payload 具体内容」。
 */
import { memo } from 'react';
import type { PageSetup } from '@/config/types';
import { mmToPx, pxToMm } from '@/constants/paper';

/** 纸张候选 */
export const PAPER_OPTIONS: ReadonlyArray<{ value: PageSetup['paper']; label: string }> = [
  { value: 'A4', label: 'A4' },
  { value: 'A5', label: 'A5' },
  { value: 'Letter', label: 'Letter' },
];

/** 页边距方向（顺序固定，渲染与断言均依赖） */
export const MARGIN_SIDES: ReadonlyArray<keyof PageSetup['margin']> = ['top', 'right', 'bottom', 'left'];

export const MARGIN_LABEL: Readonly<Record<keyof PageSetup['margin'], string>> = {
  top: '上',
  right: '右',
  bottom: '下',
  left: '左',
};

/** 浅合并页面设置（纯函数） */
export function patchPageSetup(setup: PageSetup, patch: Partial<PageSetup>): PageSetup {
  return { ...setup, ...patch };
}

/** 修改页边距某一方向（mm → px） */
export function withMarginMm(setup: PageSetup, side: keyof PageSetup['margin'], mm: number): PageSetup {
  const safe = Number.isFinite(mm) ? Math.max(0, mm) : 0;
  return { ...setup, margin: { ...setup.margin, [side]: mmToPx(safe) } };
}

export interface PageSetupPanelProps {
  setup: PageSetup;
  onChange: (next: PageSetup) => void;
}

function PageSetupPanelInner({ setup, onChange }: PageSetupPanelProps): JSX.Element {
  return (
    <div className="cbv-setup" data-page-setup="true">
      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-setup-paper">
          纸张
        </label>
        <select
          id="cbv-setup-paper"
          className="cbv-prop-field__control"
          data-setup-control="paper"
          value={setup.paper}
          onChange={(event) => onChange(patchPageSetup(setup, { paper: event.target.value as PageSetup['paper'] }))}
        >
          {PAPER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="cbv-prop-field">
        <span className="cbv-prop-field__label">朝向</span>
        <div className="cbv-segmented cbv-segmented--mini">
          {(['portrait', 'landscape'] as const).map((orientation) => (
            <button
              key={orientation}
              type="button"
              className={`cbv-segmented__item${setup.orientation === orientation ? ' cbv-segmented__item--active' : ''}`}
              data-setup-orientation={orientation}
              onClick={() => onChange(patchPageSetup(setup, { orientation }))}
            >
              {orientation === 'portrait' ? '纵向' : '横向'}
            </button>
          ))}
        </div>
      </div>

      <div className="cbv-prop-field" data-setup-group="margin">
        <span className="cbv-prop-field__label">页边距 (mm)</span>
        <div className="cbv-setup__margins">
          {MARGIN_SIDES.map((side) => (
            <label key={side} className="cbv-setup__margin">
              <span className="cbv-setup__margin-label">{MARGIN_LABEL[side]}</span>
              <input
                className="cbv-prop-field__control"
                type="number"
                min={0}
                max={80}
                step={1}
                aria-label={`页边距${MARGIN_LABEL[side]}`}
                data-setup-margin={side}
                value={pxToMm(setup.margin[side])}
                onChange={(event) => onChange(withMarginMm(setup, side, Number(event.target.value)))}
              />
            </label>
          ))}
        </div>
      </div>

      {/* 页眉 / 页码 / 页脚编辑控件已按设计变更移除；对应 `PageSetup` 字段仍保留（见文件头注释）。 */}
    </div>
  );
}

export const PageSetupPanel = memo(PageSetupPanelInner);
PageSetupPanel.displayName = 'PageSetupPanel';

export default PageSetupPanel;
