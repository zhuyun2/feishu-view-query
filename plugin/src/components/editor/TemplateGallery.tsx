/**
 * 卡片模板画廊（T11 / R1 右栏）：紧凑 / 标准 / 大图 / 清单。
 *
 * ⚠️ R4 冻结：`cover`「大图」模板**不显示封面图**——它的「大图」由**属性区首图**体现
 * （附件字段的首图缩略 64×64 + 张数），属性区行数按 `attributesRowBoost` 放宽。
 * 与 PRD 原「封面图」描述冲突时，以 R4 为准（详见 `config/presets.ts` 注释）。
 */
import { memo } from 'react';
import { CARD_TEMPLATES } from '@/config/presets';
import type { CardTemplateName } from '@/config/presets';

export interface TemplateGalleryProps {
  value: CardTemplateName;
  onChange: (templateId: CardTemplateName) => void;
}

function TemplateGalleryInner({ value, onChange }: TemplateGalleryProps): JSX.Element {
  return (
    <section className="cbv-prop-section" data-section="template">
      <div className="cbv-prop-section__title">卡片模板</div>
      <div className="cbv-template-gallery">
        {CARD_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`cbv-template-card${value === template.id ? ' cbv-template-card--active' : ''}`}
            data-template-id={template.id}
            aria-pressed={value === template.id}
            title={template.description}
            onClick={() => onChange(template.id)}
          >
            <span className={`cbv-template-card__thumb cbv-template-card__thumb--${template.id}`} aria-hidden="true" />
            <span className="cbv-template-card__label">{template.label}</span>
          </button>
        ))}
      </div>
      {value === 'cover' ? (
        <p className="cbv-prop-note">大图模板不显示独立封面图，改为在属性区优先展示首个图片附件。</p>
      ) : null}
    </section>
  );
}

export const TemplateGallery = memo(TemplateGalleryInner);
TemplateGallery.displayName = 'TemplateGallery';
