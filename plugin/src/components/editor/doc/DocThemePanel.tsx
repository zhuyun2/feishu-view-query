/**
 * 文档主题面板（M3-T09 / 设计文档 §21.6 右栏「主题」段）。
 *
 * 覆盖 `DocTheme` 全部字段：字体 / 基准字号 / 行高 / 字阶 / 标题字重 / 区块间距 /
 * 首行缩进 / 主色 / 正文色 / 弱化色 / 分隔线色。
 *
 * 主题直接决定**文本换行位置与行高**，因此它是「编辑器所见 = 详情所得」的另一半口径
 * （另一半是纸张几何，见 `DocLayoutEditor` 的宽度不变式）。
 *
 * 纯函数 `patchDocTheme` / `withHeadingScale` 供单测直接断言写入草稿的 payload 内容。
 */
import { memo } from 'react';
import type { DocTheme } from '@/config/types';

/** 字体候选（**不自创**字体族以外的取值，均为系统常见字体栈） */
export const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '"PingFang SC","Microsoft YaHei",sans-serif', label: '系统默认' },
  { value: '"Songti SC","SimSun",serif', label: '宋体' },
  { value: '"Kaiti SC","KaiTi",serif', label: '楷体' },
  { value: '"Courier New",monospace', label: '等宽' },
];

/** 标题字重候选 */
export const HEADING_WEIGHT_OPTIONS: readonly DocTheme['headingWeight'][] = [400, 500, 600, 700];

/** 主色候选（飞书语义色板，与卡片主题一致，不引入任意外部色值） */
export const PRIMARY_SWATCHES = ['#3370FF', '#245BDB', '#14C9C9', '#00B42A', '#FF7D00', '#F53F3F'] as const;

/** 浅合并主题（纯函数） */
export function patchDocTheme(theme: DocTheme, patch: Partial<DocTheme>): DocTheme {
  return { ...theme, ...patch };
}

/** 修改三级标题字阶中的某一级（h1/h2/h3） */
export function withHeadingScale(theme: DocTheme, index: 0 | 1 | 2, value: number): DocTheme {
  const next: [number, number, number] = [...theme.headingScale] as [number, number, number];
  next[index] = Number.isFinite(value) ? value : theme.headingScale[index];
  return { ...theme, headingScale: next };
}

export interface DocThemePanelProps {
  theme: DocTheme;
  onChange: (next: DocTheme) => void;
}

const HEADING_SCALE_LABEL = ['H1 倍率', 'H2 倍率', 'H3 倍率'] as const;

function DocThemePanelInner({ theme, onChange }: DocThemePanelProps): JSX.Element {
  // 当前字体不在候选中（例如来自更高版本配置）时，前置一项「当前」，避免选择器显示空白
  const fontOptions = FONT_OPTIONS.some((option) => option.value === theme.fontFamily)
    ? FONT_OPTIONS
    : [{ value: theme.fontFamily, label: '当前' }, ...FONT_OPTIONS];

  return (
    <div className="cbv-doctheme" data-doc-theme="true">
      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-theme-font">
          字体
        </label>
        <select
          id="cbv-theme-font"
          className="cbv-prop-field__control"
          data-theme-control="fontFamily"
          value={theme.fontFamily}
          onChange={(event) => onChange(patchDocTheme(theme, { fontFamily: event.target.value }))}
        >
          {fontOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-theme-size">
          基准字号
        </label>
        <input
          id="cbv-theme-size"
          className="cbv-prop-field__control"
          type="number"
          min={8}
          max={32}
          step={1}
          data-theme-control="baseFontSize"
          value={theme.baseFontSize}
          onChange={(event) => onChange(patchDocTheme(theme, { baseFontSize: Number(event.target.value) }))}
        />
      </div>

      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-theme-lineheight">
          行高
        </label>
        <input
          id="cbv-theme-lineheight"
          className="cbv-prop-field__control"
          type="number"
          min={1}
          max={3}
          step={0.05}
          data-theme-control="lineHeight"
          value={theme.lineHeight}
          onChange={(event) => onChange(patchDocTheme(theme, { lineHeight: Number(event.target.value) }))}
        />
      </div>

      <div className="cbv-prop-field" data-theme-group="headingScale">
        <span className="cbv-prop-field__label">字阶</span>
        <div className="cbv-doctheme__scale">
          {theme.headingScale.map((value, index) => (
            <label key={HEADING_SCALE_LABEL[index]} className="cbv-doctheme__scale-item">
              <span className="cbv-doctheme__scale-label">{HEADING_SCALE_LABEL[index]}</span>
              <input
                className="cbv-prop-field__control"
                type="number"
                min={1}
                max={3}
                step={0.05}
                aria-label={HEADING_SCALE_LABEL[index]}
                data-theme-heading-scale={index}
                value={value}
                onChange={(event) => onChange(withHeadingScale(theme, index as 0 | 1 | 2, Number(event.target.value)))}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="cbv-prop-field">
        <span className="cbv-prop-field__label">标题字重</span>
        <div className="cbv-segmented cbv-segmented--mini">
          {HEADING_WEIGHT_OPTIONS.map((weight) => (
            <button
              key={weight}
              type="button"
              className={`cbv-segmented__item${theme.headingWeight === weight ? ' cbv-segmented__item--active' : ''}`}
              data-theme-weight={weight}
              onClick={() => onChange(patchDocTheme(theme, { headingWeight: weight }))}
            >
              {weight}
            </button>
          ))}
        </div>
      </div>

      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-theme-spacing">
          区块间距
        </label>
        <input
          id="cbv-theme-spacing"
          className="cbv-prop-field__control"
          type="number"
          min={0}
          max={48}
          step={1}
          data-theme-control="blockSpacing"
          value={theme.blockSpacing}
          onChange={(event) => onChange(patchDocTheme(theme, { blockSpacing: Number(event.target.value) }))}
        />
      </div>

      <div className="cbv-prop-field">
        <label className="cbv-prop-field__label" htmlFor="cbv-theme-indent">
          首行缩进
        </label>
        <input
          id="cbv-theme-indent"
          className="cbv-prop-field__control"
          type="number"
          min={0}
          max={48}
          step={1}
          data-theme-control="paragraphIndent"
          value={theme.paragraphIndent}
          onChange={(event) => onChange(patchDocTheme(theme, { paragraphIndent: Number(event.target.value) }))}
        />
      </div>

      <div className="cbv-prop-field">
        <span className="cbv-prop-field__label">主色</span>
        <div className="cbv-swatches">
          {PRIMARY_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              className={`cbv-swatch${theme.primaryColor === color ? ' cbv-swatch--active' : ''}`}
              style={{ background: color }}
              aria-label={`主色 ${color}`}
              aria-pressed={theme.primaryColor === color}
              data-theme-swatch={color}
              onClick={() => onChange(patchDocTheme(theme, { primaryColor: color }))}
            />
          ))}
        </div>
      </div>

      {(
        [
          ['textColor', '正文色'],
          ['mutedColor', '弱化色'],
          ['dividerColor', '分隔线色'],
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="cbv-prop-field cbv-prop-field--inline">
          <label className="cbv-prop-field__label" htmlFor={`cbv-theme-${key}`}>
            {label}
          </label>
          <input
            id={`cbv-theme-${key}`}
            type="color"
            className="cbv-doctheme__color"
            aria-label={label}
            data-theme-control={key}
            value={theme[key]}
            onChange={(event) => onChange(patchDocTheme(theme, { [key]: event.target.value } as Partial<DocTheme>))}
          />
        </div>
      ))}
    </div>
  );
}

export const DocThemePanel = memo(DocThemePanelInner);
DocThemePanel.displayName = 'DocThemePanel';

export default DocThemePanel;
