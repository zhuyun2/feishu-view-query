/**
 * 属性面板（T11 / R1 右栏 300px）：槽位配置手风琴 / 卡片模板 / 主题与密度 / 条件高亮。
 *
 * 字段的**落位与排序**在中栏（`SlotLanes`）拖拽完成；本面板只配置槽位级属性
 * （可见性 / 方向），以及模板、主题、密度与高亮规则。
 */
import { memo, useState } from 'react';
import type { CardLayoutConfig, DensityConfig, HighlightRule, SlotId, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { CardTemplateName, DensityPresetName } from '@/config/presets';
import { SLOT_LABEL, SLOT_ORDER, setSlotDirection, setSlotVisible } from './placementMath';
import { TemplateGallery } from './TemplateGallery';
import { ThemeDensityPanel } from './ThemeDensityPanel';
import { HighlightPanel } from './HighlightPanel';

export interface PropertyPanelProps {
  layout: CardLayoutConfig;
  density: DensityConfig;
  theme: StyleTheme;
  highlightRules: HighlightRule[];
  fields: FieldMetaLite[];
  onLayoutChange: (layout: CardLayoutConfig) => void;
  onTemplateChange: (templateId: CardTemplateName) => void;
  onDensityChange: (preset: DensityPresetName) => void;
  onThemeChange: (theme: StyleTheme) => void;
  onHighlightChange: (rules: HighlightRule[]) => void;
}

function SlotAccordion({
  layout,
  onLayoutChange,
}: {
  layout: CardLayoutConfig;
  onLayoutChange: (layout: CardLayoutConfig) => void;
}): JSX.Element {
  const [openSlot, setOpenSlot] = useState<SlotId | null>('attributes');

  return (
    <section className="cbv-prop-section" data-section="slots">
      <div className="cbv-prop-section__title">槽位配置</div>
      {SLOT_ORDER.map((slotId) => {
        const slot = layout.slots[slotId];
        const open = openSlot === slotId;
        return (
          <div className={`cbv-acc${open ? ' cbv-acc--open' : ''}`} key={slotId} data-slot={slotId}>
            <button
              type="button"
              className="cbv-acc__head"
              aria-expanded={open}
              onClick={() => setOpenSlot(open ? null : slotId)}
            >
              <span className="cbv-acc__chevron" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              <span className="cbv-acc__name">{SLOT_LABEL[slotId]}</span>
              <span className="cbv-acc__meta">{slot?.placements.length ?? 0} 个字段</span>
            </button>
            {open ? (
              <div className="cbv-acc__body">
                <label className="cbv-prop-row">
                  <input
                    type="checkbox"
                    checked={slot?.visible ?? false}
                    aria-label={`${SLOT_LABEL[slotId]} 可见`}
                    onChange={(event) => onLayoutChange(setSlotVisible(layout, slotId, event.target.checked))}
                  />
                  <span className="cbv-prop-row__label">显示该槽位</span>
                </label>
                <div className="cbv-prop-row">
                  <span className="cbv-prop-row__label">排列</span>
                  <div className="cbv-segmented cbv-segmented--mini">
                    {(['row', 'column'] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        className={`cbv-segmented__item${slot?.direction === direction ? ' cbv-segmented__item--active' : ''}`}
                        data-direction={direction}
                        onClick={() => onLayoutChange(setSlotDirection(layout, slotId, direction))}
                      >
                        {direction === 'row' ? '横向' : '纵向'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function PropertyPanelInner(props: PropertyPanelProps): JSX.Element {
  const {
    layout,
    density,
    theme,
    highlightRules,
    fields,
    onLayoutChange,
    onTemplateChange,
    onDensityChange,
    onThemeChange,
    onHighlightChange,
  } = props;

  return (
    <aside className="cbv-editor__right" aria-label="属性面板">
      <div className="cbv-editor__panel-title">属性</div>
      <SlotAccordion layout={layout} onLayoutChange={onLayoutChange} />
      <TemplateGallery value={layout.templateId} onChange={onTemplateChange} />
      <ThemeDensityPanel density={density} theme={theme} onDensityChange={onDensityChange} onThemeChange={onThemeChange} />
      <HighlightPanel rules={highlightRules} fields={fields} onChange={onHighlightChange} />
    </aside>
  );
}

export const PropertyPanel = memo(PropertyPanelInner);
PropertyPanel.displayName = 'PropertyPanel';
