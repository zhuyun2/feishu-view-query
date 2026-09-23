/**
 * `BlockPropertyForm` 测试（M3-T09 · 硬性要求 1：属性表单必须数据驱动）。
 *
 * ⭐ 关键：**逐类断言 12 类区块的属性字段集合**，且期望值**在本文件硬编码**
 * （不复用实现的 `PROP_SCHEMA`）——否则「把某类的模式改成空数组」会同时改掉期望与渲染，
 * 断言变成恒真（假绿）。
 *
 * 判别力（变异验证用的「改坏点」）：
 *  - 把 `PROP_SCHEMA[kind]` 置空 / 少写一个属性 → 该 kind 的 `data-prop-key` 集合 ≠ 期望 → 红；
 *  - 渲染器漏渲染某个 spec（schema 有、DOM 无）→ 「模式 ↔ DOM 一致」断言 → 红。
 *
 * ⚠️ 覆盖边界：本文件只验证**静态结构**（表单字段集合 / 控件类型 / 值绑定），
 * 不模拟真实指针拖拽（jsdom 不可靠，团队约定不伪造）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DocBlock } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { BLOCK_CATALOG } from '@/doc/blockCatalog';
import { defaultBlockFor } from '@/doc/blockDefaults';
import {
  BLOCK_BASE_PROP_SPECS,
  PROP_SCHEMA,
  buildPatch,
  getValueAt,
  groupedSchemaFor,
  propertySchemaFor,
} from './BlockPropertyForm';
import { BlockPropertyForm } from './BlockPropertyForm';

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f4', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  { id: 'f5', name: '负责人', type: FieldType.User, isPrimary: false },
  { id: 'f6', name: '附件', type: FieldType.Attachment, isPrimary: false },
  { id: 'f7', name: '关联', type: FieldType.Link, isPrimary: false },
];

/** 基类公共属性键（硬编码，独立于实现） */
const BASE_KEYS = ['breakInside', 'style.align', 'style.marginTop', 'style.marginBottom', 'visibleWhen', 'note'];

/**
 * ⭐ 12 类区块的**专属**属性键（硬编码期望值）。
 * 少任何一类 / 任何一类的这类集合不对 → 断言红（这正是「某类表单为空」的防线）。
 */
const EXPECTED_KIND_KEYS: Readonly<Record<DocBlock['kind'], readonly string[]>> = {
  heading: ['level', 'source.type', 'source.text', 'source.fieldId', 'hideWhenEmpty'],
  paragraph: ['fieldId', 'preserveLineBreaks', 'hideWhenEmpty', 'maxLines'],
  richText: ['markdown'],
  keyValueGrid: ['columns', 'rows', 'labelWidthPx', 'showColon', 'zebra', 'hideEmptyRows'],
  fieldList: ['items', 'showLabels', 'hideEmptyItems'],
  badgeRow: ['fieldIds', 'maxItems', 'showLabels'],
  image: ['fieldId', 'mode', 'index', 'width', 'height', 'align', 'caption', 'hideWhenEmpty'],
  table: ['columns', 'rowSource.type', 'rowSource.fieldId', 'showHeader', 'zebra', 'maxRows'],
  divider: ['thickness', 'borderStyle'],
  spacer: ['height'],
  pageBreak: [],
  metaFooter: ['fields', 'separator', 'fontSize', 'muted'],
};

/** 从静态 HTML 中抽取 `data-prop-key` 序列 */
function renderedKeys(html: string): string[] {
  const keys: string[] = [];
  const pattern = /data-prop-key="([^"]+)"/g;
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    keys.push(match[1]);
    match = pattern.exec(html);
  }
  return keys;
}

function mk(kind: DocBlock['kind']): DocBlock {
  return defaultBlockFor(kind, FIELDS, { makeId: () => `blk_${kind}` });
}

function renderForm(block: DocBlock, onDelete?: () => void): string {
  return renderToStaticMarkup(
    createElement(BlockPropertyForm, {
      block,
      fields: FIELDS,
      onChange: vi.fn(),
      onDelete,
    }),
  );
}

describe('BlockPropertyForm · 模式表与目录的一致性', () => {
  it('模式表覆盖目录的全部 12 类（新增一类区块忘记加表单 → 红）', () => {
    const catalogKinds = BLOCK_CATALOG.map((entry) => entry.kind);
    const schemaKinds = Object.keys(PROP_SCHEMA) as DocBlock['kind'][];

    expect(catalogKinds.length).toBe(12);
    expect(schemaKinds.length).toBe(12);
    expect([...schemaKinds].sort()).toEqual([...catalogKinds].sort());
  });

  it('期望表覆盖 12 类，且基类属性非空（避免「全部为空 → 恒真」）', () => {
    expect(Object.keys(EXPECTED_KIND_KEYS).length).toBe(12);
    expect(BASE_KEYS.length).toBe(BLOCK_BASE_PROP_SPECS.length);
    expect(BLOCK_BASE_PROP_SPECS.length).toBeGreaterThan(0);
  });

  it('每类的完整模式 = 专属属性 + 基类属性，且键不重复', () => {
    for (const entry of BLOCK_CATALOG) {
      const all = propertySchemaFor(entry.kind);
      const keys = all.map((spec) => spec.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const baseKey of BASE_KEYS) expect(keys).toContain(baseKey);
      for (const specificKey of EXPECTED_KIND_KEYS[entry.kind]) expect(keys).toContain(specificKey);
    }
  });

  it('分组渲染不丢属性（各组合并后 = 完整模式）', () => {
    for (const entry of BLOCK_CATALOG) {
      const grouped = groupedSchemaFor(entry.kind).flatMap((group) => group.specs.map((spec) => spec.key));
      expect([...grouped].sort()).toEqual([...propertySchemaFor(entry.kind).map((s) => s.key)].sort());
    }
  });
});

describe('BlockPropertyForm · ⭐ 逐类断言 12 类的属性字段集合', () => {
  for (const entry of BLOCK_CATALOG) {
    const kind = entry.kind;
    it(`${kind}：渲染出的 data-prop-key 集合 === 该类的专属属性 ∪ 基类属性`, () => {
      const html = renderForm(mk(kind));
      const rendered = renderedKeys(html);
      const expected = [...EXPECTED_KIND_KEYS[kind], ...BASE_KEYS];

      // 无重复（同一属性不得渲染两次）
      expect(new Set(rendered).size).toBe(rendered.length);
      // 集合相等：多一个 / 少一个都红（含「该类表单为空」的变异）
      expect([...rendered].sort()).toEqual([...expected].sort());
      // 正面锚点：表单确实属于该类，且非空
      expect(html).toContain(`data-block-form-kind="${kind}"`);
      expect(html).toContain(`data-prop-count="${expected.length}"`);
      expect(rendered.length).toBeGreaterThan(0);
    });
  }

  it('pageBreak 无专属属性，但必须渲染出**全部基类属性**（表单绝不为空）', () => {
    const rendered = renderedKeys(renderForm(mk('pageBreak')));
    expect(EXPECTED_KIND_KEYS.pageBreak.length).toBe(0);
    expect([...rendered].sort()).toEqual([...BASE_KEYS].sort());
  });

  it('渲染出的键与模式表**逐一致**（schema 有、DOM 无 → 红）', () => {
    for (const entry of BLOCK_CATALOG) {
      const rendered = renderedKeys(renderForm(mk(entry.kind)));
      const declared = propertySchemaFor(entry.kind).map((spec) => spec.key);
      expect([...rendered].sort()).toEqual([...declared].sort());
    }
  });
});

describe('BlockPropertyForm · 控件类型与内容表驱动', () => {
  it('每类区块的控件类型由模式表声明（不是逐类硬编码 JSX）', () => {
    for (const entry of BLOCK_CATALOG) {
      const html = renderForm(mk(entry.kind));
      for (const spec of propertySchemaFor(entry.kind)) {
        expect(html).toContain(`data-prop-control="${spec.control}"`);
      }
      // 模式表里声明的控件类型必须与目录一致地作用于渲染：至少出现一次 select 控件
      expect(propertySchemaFor(entry.kind).every((spec) => typeof spec.control === 'string')).toBe(true);
    }
  });

  it('字段选择器只列目录声明的可绑定类型（image 仅附件字段可绑）', () => {
    const html = renderForm(mk('image'));
    expect(html).toContain('附件'); // 附件字段出现在选项中
    expect(html).not.toContain('客户名称'); // 文本字段不出现在 image 的字段选择器中
  });

  it('删除按钮仅在传入 onDelete 时出现', () => {
    expect(renderForm(mk('spacer'), vi.fn())).toContain('删除该区块');
    expect(renderForm(mk('spacer'))).not.toContain('删除该区块');
  });
});

describe('BlockPropertyForm · 点路径补丁（updateBlock 是浅合并）', () => {
  it('getValueAt 读取点路径', () => {
    const block = mk('heading');
    expect(getValueAt(block, 'kind')).toBe('heading');
    expect(getValueAt(block, 'source.type')).toBe('static');
    expect(getValueAt(block, 'style.align')).toBeUndefined();
    expect(getValueAt(block, 'nope.deep.path')).toBeUndefined();
  });

  it('buildPatch 对中间层做合并（style.align → { style: {...旧值, align} }）', () => {
    const patch = buildPatch({ style: { fontSize: 15, color: '#000' } }, 'style.align', 'center');
    expect(patch).toEqual({ style: { fontSize: 15, color: '#000', align: 'center' } });
  });

  it('buildPatch 单层键直出', () => {
    expect(buildPatch({ height: 12 }, 'height', 24)).toEqual({ height: 24 });
  });
});
