/**
 * 主题与密度面板（T11 / R1 右栏）。
 *
 * - 密度三档（紧凑 / 标准 / 宽松）直接改变一屏列数（R3）；数值取自 `config/presets.ts`（唯一来源 04 §3.4）；
 * - 主题：主色（限定飞书语义色板，**不自创色值**）、圆角、阴影、标题字重、字号缩放。
 */
import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { DensityConfig, StyleTheme } from '@/config/types';
import { DENSITY_PRESET_LABEL, DENSITY_PRESET_ORDER, resolveDensityPreset } from '@/config/presets';
import type { DensityPresetName } from '@/config/presets';

/** 品牌主色候选（04 §3.1 品牌色 + 常用语义色）——不引入任意外部色值 */
const PRIMARY_SWATCHES = ['#3370FF', '#245BDB', '#14C9C9', '#00B42A', '#FF7D00', '#F53F3F'] as const;

const RADIUS_OPTIONS = [4, 6, 8, 12] as const;
const SHADOW_OPTIONS: ReadonlyArray<{ level: StyleTheme['shadowLevel']; label: string }> = [
  { level: 0, label: '无' },
  { level: 1, label: '弱' },
  { level: 2, label: '中' },
  { level: 3, label: '强' },
];
const TITLE_WEIGHT_OPTIONS: ReadonlyArray<StyleTheme['titleWeight']> = [400, 500, 600, 700];

export interface ThemeDensityPanelProps {
  density: DensityConfig;
  theme: StyleTheme;
  onDensityChange: (preset: DensityPresetName) => void;
  onThemeChange: (theme: StyleTheme) => void;
}

function ThemeDensityPanelInner({ density, theme, onDensityChange, onThemeChange }: ThemeDensityPanelProps): JSX.Element {
  const activePreset: DensityPresetName = resolveDensityPreset(density);

  const mergeTheme = (patch: Partial<StyleTheme>): void => onThemeChange({ ...theme, ...patch });

  return (
    <>
      <section className="cbv-prop-section" data-section="density">
        <div className="cbv-prop-section__title">密度</div>
        <div className="cbv-segmented" role="radiogroup" aria-label="密度">
          {DENSITY_PRESET_ORDER.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={activePreset === preset}
              className={`cbv-segmented__item${activePreset === preset ? ' cbv-segmented__item--active' : ''}`}
              data-density={preset}
              onClick={() => onDensityChange(preset)}
            >
              {DENSITY_PRESET_LABEL[preset]}
            </button>
          ))}
        </div>
      </section>

      <section className="cbv-prop-section" data-section="theme">
        <div className="cbv-prop-section__title">主题</div>

        <div className="cbv-prop-row">
          <span className="cbv-prop-row__label">主色</span>
          <div className="cbv-swatches">
            {PRIMARY_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                className={`cbv-swatch${theme.primaryColor === color ? ' cbv-swatch--active' : ''}`}
                style={{ background: color } as CSSProperties}
                aria-label={`主色 ${color}`}
                aria-pressed={theme.primaryColor === color}
                data-color={color}
                onClick={() => mergeTheme({ primaryColor: color })}
              />
            ))}
          </div>
        </div>

        <div className="cbv-prop-row">
          <span className="cbv-prop-row__label">圆角</span>
          <div className="cbv-segmented cbv-segmented--mini">
            {RADIUS_OPTIONS.map((radius) => (
              <button
                key={radius}
                type="button"
                className={`cbv-segmented__item${theme.borderRadius === radius ? ' cbv-segmented__item--active' : ''}`}
                data-radius={radius}
                onClick={() => mergeTheme({ borderRadius: radius })}
              >
                {radius}
              </button>
            ))}
          </div>
        </div>

        <div className="cbv-prop-row">
          <span className="cbv-prop-row__label">阴影</span>
          <div className="cbv-segmented cbv-segmented--mini">
            {SHADOW_OPTIONS.map((option) => (
              <button
                key={option.level}
                type="button"
                className={`cbv-segmented__item${theme.shadowLevel === option.level ? ' cbv-segmented__item--active' : ''}`}
                data-shadow={option.level}
                onClick={() => mergeTheme({ shadowLevel: option.level })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="cbv-prop-row">
          <span className="cbv-prop-row__label">标题字重</span>
          <div className="cbv-segmented cbv-segmented--mini">
            {TITLE_WEIGHT_OPTIONS.map((weight) => (
              <button
                key={weight}
                type="button"
                className={`cbv-segmented__item${theme.titleWeight === weight ? ' cbv-segmented__item--active' : ''}`}
                data-weight={weight}
                onClick={() => mergeTheme({ titleWeight: weight })}
              >
                {weight}
              </button>
            ))}
          </div>
        </div>

        <div className="cbv-prop-row">
          <span className="cbv-prop-row__label">字号缩放</span>
          <input
            type="range"
            min={0.85}
            max={1.3}
            step={0.05}
            value={theme.fontScale}
            aria-label="字号缩放"
            onChange={(event) => mergeTheme({ fontScale: Number(event.target.value) })}
          />
          <span className="cbv-count">{theme.fontScale.toFixed(2)}×</span>
        </div>
      </section>
    </>
  );
}

export const ThemeDensityPanel = memo(ThemeDensityPanelInner);
ThemeDensityPanel.displayName = 'ThemeDensityPanel';
