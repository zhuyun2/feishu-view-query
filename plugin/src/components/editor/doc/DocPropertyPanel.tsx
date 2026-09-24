/**
 * 文档属性面板（右栏 320px，设计文档 §21.6 / M3-T09）。
 *
 * 三段**各自独立**可展开/收起的折叠区（accordion）：
 *  1. `block` 区块属性 —— 由 `BlockPropertyForm` 按选中区块的 `kind` **动态**渲染；
 *  2. `page`  页面设置 —— `PageSetupPanel`；
 *  3. `theme` 主题     —— `DocThemePanel`。
 *
 * ⚠️ 折叠语义：收起的段**不渲染其内容**（而不是用 CSS 隐藏）——这样测试可用
 * 「节点存在/不存在」判断可见性，也避免收起状态下仍渲染整棵表单树（12 类 × N 个控件）。
 *
 * ⚠️ 未选中区块：区块属性段渲染**显式空态**（不静默留白），文案见
 * `BLOCK_SECTION_EMPTY_TITLE` / `BLOCK_SECTION_EMPTY_DESC`。
 */
import { memo, useState } from 'react';
import type { DocBlock, DocTheme, DocTemplate, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { LinkTargetFieldsState } from '@/hooks/useLinkTargetFields';
import { findBlock } from './blockMath';
import { BlockPropertyForm } from './BlockPropertyForm';
import { PageSetupPanel } from './PageSetupPanel';
import { DocThemePanel } from './DocThemePanel';

/** 三段折叠区的 key（渲染顺序 = 此顺序） */
export type DocPropertySectionKey = 'block' | 'page' | 'theme';

export interface DocPropertySectionMeta {
  key: DocPropertySectionKey;
  label: string;
}

export const DOC_PROPERTY_SECTIONS: readonly DocPropertySectionMeta[] = [
  { key: 'block', label: '区块属性' },
  { key: 'page', label: '页面设置' },
  { key: 'theme', label: '主题' },
];

/** 各段默认展开状态（区块属性默认展开，便于选中即编辑） */
export const DOC_PROPERTY_DEFAULT_OPEN: Readonly<Record<DocPropertySectionKey, boolean>> = {
  block: true,
  page: false,
  theme: false,
};

export const BLOCK_SECTION_EMPTY_TITLE = '未选中区块';
export const BLOCK_SECTION_EMPTY_DESC = '在中间画布中点选一个区块，即可编辑它的属性。';

export interface DocPropertyPanelProps {
  /** 当前草稿模板（用于定位选中区块 / 读取页面设置与主题） */
  template: DocTemplate;
  fields: FieldMetaLite[];
  /** 当前选中区块 id；`null` = 未选中 */
  selectedBlockId: string | null;
  /** 区块属性变更（补丁，由调用方经 `updateBlock` 写入草稿） */
  onBlockChange: (blockId: string, patch: Record<string, unknown>) => void;
  /** 删除选中区块（缺省则不渲染删除按钮） */
  onBlockDelete?: (blockId: string) => void;
  onPageSetupChange: (next: PageSetup) => void;
  onThemeChange: (next: DocTheme) => void;
  /** ⭐ 需求 2 · 第二阶段：关联字段 → 目标表字段状态（关联记录显示列配置用） */
  linkTargetFields?: Readonly<Record<string, LinkTargetFieldsState>>;
  /** ⭐ 需求 2 · 第二阶段：按需解析关联字段的目标表字段 */
  onEnsureLinkFields?: (fieldId: string) => void;
}

function Section({
  meta,
  open,
  onToggle,
  children,
}: {
  meta: DocPropertySectionMeta;
  open: boolean;
  onToggle: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section
      className={`cbv-acc cbv-docprops__section${open ? ' cbv-acc--open' : ''}`}
      data-section={meta.key}
      data-docprops-section={meta.key}
    >
      <button
        type="button"
        className="cbv-acc__head"
        aria-expanded={open}
        data-docprops-toggle={meta.key}
        onClick={onToggle}
      >
        <span className="cbv-acc__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="cbv-acc__name">{meta.label}</span>
      </button>
      {open ? (
        <div className="cbv-acc__body" data-docprops-body={meta.key}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function DocPropertyPanelInner({
  template,
  fields,
  selectedBlockId,
  onBlockChange,
  onBlockDelete,
  onPageSetupChange,
  onThemeChange,
  linkTargetFields,
  onEnsureLinkFields,
}: DocPropertyPanelProps): JSX.Element {
  const [open, setOpen] = useState<Record<DocPropertySectionKey, boolean>>({ ...DOC_PROPERTY_DEFAULT_OPEN });

  const toggle = (key: DocPropertySectionKey): void => {
    setOpen((current) => ({ ...current, [key]: !current[key] }));
  };

  const found = selectedBlockId ? findBlock(template, selectedBlockId) : null;
  const selectedBlock: DocBlock | null = found ? found.block : null;

  const blockBody: JSX.Element = selectedBlock ? (
    <BlockPropertyForm
      block={selectedBlock}
      fields={fields}
      onChange={(patch: Record<string, unknown>) => onBlockChange(selectedBlock.blockId, patch)}
      onDelete={onBlockDelete ? () => onBlockDelete(selectedBlock.blockId) : undefined}
      linkTargetFields={linkTargetFields}
      onEnsureLinkFields={onEnsureLinkFields}
    />
  ) : (
    <div className="cbv-docprops__empty" data-docprops-empty="true">
      <div className="cbv-docprops__empty-title">{BLOCK_SECTION_EMPTY_TITLE}</div>
      <div className="cbv-docprops__empty-desc">{BLOCK_SECTION_EMPTY_DESC}</div>
    </div>
  );

  return (
    <aside className="cbv-editor__right cbv-docprops" aria-label="文档属性面板" data-docprops="true">
      <div className="cbv-editor__panel-title">属性</div>
      {DOC_PROPERTY_SECTIONS.map((meta) => (
        <Section key={meta.key} meta={meta} open={open[meta.key]} onToggle={() => toggle(meta.key)}>
          {meta.key === 'block' ? (
            blockBody
          ) : meta.key === 'page' ? (
            <PageSetupPanel setup={template.pageSetup} onChange={onPageSetupChange} />
          ) : (
            <DocThemePanel theme={template.theme} onChange={onThemeChange} />
          )}
        </Section>
      ))}
    </aside>
  );
}

export const DocPropertyPanel = memo(DocPropertyPanelInner);
DocPropertyPanel.displayName = 'DocPropertyPanel';

export default DocPropertyPanel;
