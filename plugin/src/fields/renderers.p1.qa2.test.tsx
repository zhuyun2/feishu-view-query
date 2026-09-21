/**
 * QA2 独立验证（任务 #13/#15）· T07：P1 渲染器（User / Attachment / Rating / Progress /
 * Link(Url+Phone) / Formula / Lookup）在**异常输入**下的健壮性。
 *
 * 断言来源：
 *  - `03-开发设计文档.md` §11（字段渲染器使用约定）：① 单字段异常 → FallbackRenderer，
 *    **不中断整卡**；② **永不输出原始 ID / JSON**（由 `normalize()` 保证，US-5 AC1）。
 *  - §6.5 / T07：P1 七类双态渲染 + 降级兜底。
 *  - `04 §11 R4`：人员 = **20px 头像 + 姓名**（渲染常量，不随 density 变）。
 *  - M1 缺陷 F1 回归：货币符号读取字段 `property.symbol`，**不得硬编码 ¥**。
 *
 * ⚠️ 口径修正（诚实标注）：设计只要求「不崩 + 不外泄原始 ID/JSON」，
 *  **并不要求**所有异常输入都渲染成 `FallbackRenderer`（部分输入会归一化为 empty/文本）。
 *  故本文件对「是否落 FallbackRenderer」不做硬断言，只对①不抛错、②不泄漏做硬断言。
 */
import { describe, expect, it } from 'vitest';
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldType, type FieldMetaLite } from './fieldTypes';
import { normalize } from './normalize';
import { getRenderer, renderCard, renderDoc } from './registry';
import { defaultTheme } from '@/config/defaults';
import type { FieldDisplayOptions } from '@/config/types';
import type { DocRenderContext, RenderContext } from './fieldTypes';

const DISPLAY: FieldDisplayOptions = {
  maxLines: 1,
  truncate: 'ellipsis',
  maxItems: 3,
  hideWhenEmpty: false,
};
const THEME = defaultTheme();

function meta(type: number, property?: unknown, name = '字段'): FieldMetaLite {
  return { id: 'f', name, type, isPrimary: false, property };
}

function cardContext(m: FieldMetaLite): RenderContext {
  return { fieldMeta: m, display: DISPLAY, theme: THEME, locale: 'zh-CN' };
}

function docContext(m: FieldMetaLite): DocRenderContext {
  return { ...cardContext(m), fragmentIndex: 0, fragmentsTotal: 1, showLabel: false, labelText: m.name };
}

/** raw + meta → 归一化 → 渲染（卡片态 / 文档态）→ HTML */
function cardHtml(raw: unknown, m: FieldMetaLite): string {
  const node = renderCard(normalize(raw, m), cardContext(m));
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function docHtml(raw: unknown, m: FieldMetaLite): string {
  const node = renderDoc(normalize(raw, m), docContext(m));
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/** 断言：不抛错，且给定的“原始标记”绝不出现 */
function expectSafe(fn: () => string, leaked: string[] = []): string {
  let html = '';
  expect(() => {
    html = fn();
  }).not.toThrow();
  for (const token of leaked) {
    expect(html).not.toContain(token);
  }
  return html;
}

/* ============================ 注册表（T07 登记） ============================ */

describe('T07 · P1 渲染器注册', () => {
  it('七类 P1 字段均已登记且 key 正确', () => {
    expect(getRenderer(FieldType.User).key).toBe('user');
    expect(getRenderer(FieldType.CreatedUser).key).toBe('user');
    expect(getRenderer(FieldType.ModifiedUser).key).toBe('user');
    expect(getRenderer(FieldType.Attachment).key).toBe('attachment');
    expect(getRenderer(FieldType.Rating).key).toBe('rating');
    expect(getRenderer(FieldType.Progress).key).toBe('progress');
    expect(getRenderer(FieldType.Url).key).toBe('link');
    expect(getRenderer(FieldType.Phone).key).toBe('link');
    expect(getRenderer(FieldType.Formula).key).toBe('formula');
    expect(getRenderer(FieldType.Lookup).key).toBe('lookup');
    expect(getRenderer(FieldType.Link).key).toBe('lookup');
    expect(getRenderer(FieldType.DuplexLink).key).toBe('lookup');
  });
});

/* ============================ 人员（R4：20px 头像 + 姓名） ============================ */

describe('T07 · User（R4：20px 头像 + 姓名，绝不外泄成员 ID）', () => {
  const m = meta(FieldType.User, undefined, '负责人');

  it('对象成员：渲染姓名 + 20px 头像，不泄漏 id', () => {
    const html = expectSafe(
      () => cardHtml([{ id: 'ou_SECRET_ID_1', name: '张伟', avatarUrl: 'https://cdn.example/a.png' }], m),
      ['ou_SECRET_ID_1'],
    );
    expect(html).toContain('张伟');
    expect(html).toContain('https://cdn.example/a.png');
    expect(html).toContain('width:20px');
    expect(html).toContain('height:20px');
  });

  it('无头像 → 回落姓名首字占位（仍 20px）', () => {
    const html = expectSafe(() => cardHtml([{ name: '李娜' }], m));
    expect(html).toContain('李娜');
    expect(html).toContain('width:20px');
    expect(html).toContain('>李<');
  });

  it('空数组 → 空值占位；对象灌入（非成员结构）→ 不崩、不泄漏 JSON', () => {
    expect(cardHtml([], m)).toContain('—');
    const html = expectSafe(() => cardHtml({ level: { deep: 1 } }, m), ['level', 'deep']);
    expect(html).not.toContain('{');
  });

  it('文档态同样 20px 头像 + 姓名', () => {
    const html = expectSafe(
      () => docHtml([{ id: 'ou_X', name: '王芳' }], m),
      ['ou_X'],
    );
    expect(html).toContain('王芳');
    expect(html).toContain('width:20px');
  });
});

/* ============================ 附件（R4：属性区首图 64×64 + 张数，非封面图） ============================ */

describe('T07 · Attachment（R4：属性区首图 64×64 + 张数；不外泄 file_token）', () => {
  const m = meta(FieldType.Attachment, undefined, '附件');

  it('图片附件：首图 64×64 + 文件名，不泄漏 file_token', () => {
    const html = expectSafe(
      () => cardHtml(
        [
          { file_token: 'SECRET_TOKEN_1', name: '合同.pdf', tmpUrl: 'https://cdn.example/f.pdf' },
          { file_token: 'SECRET_TOKEN_2', name: '发票.pdf', tmpUrl: 'https://cdn.example/f2.pdf' },
        ],
        m,
      ),
      ['SECRET_TOKEN_1', 'SECRET_TOKEN_2', 'file_token'],
    );
    expect(html).toContain('width:64px');
    expect(html).toContain('合同.pdf');
    expect(html).toContain('共 2 个');
  });

  it('非图片附件（无 url）→ 📎 占位 + 尺寸 64', () => {
    const html = expectSafe(() => cardHtml([{ name: '报告.docx' }], m));
    expect(html).toContain('📎');
    expect(html).toContain('width:64px');
    expect(html).toContain('报告.docx');
  });

  it('空数组 / 非法对象 → 占位，不崩、不泄漏', () => {
    expect(cardHtml([], m)).toContain('—');
    expectSafe(() => cardHtml({ tokens: ['t1', 't2'] }, m), ['tokens', 't1', 't2']);
  });

  it('超长文件名 → 不抛错（卡片属性区不改写文件名）', () => {
    const long = `${'x'.repeat(400)}.pdf`;
    expect(() => cardHtml([{ name: long }], m)).not.toThrow();
  });
});

/* ============================ 评分 ============================ */

describe('T07 · Rating（★ 文本，打印友好）', () => {
  const m = meta(FieldType.Rating, undefined, '评分');

  it.each([
    [3, '★★★☆☆'],
    [4.6, '★★★★★'],
    [999, '★★★★★'],
    [-2, '☆☆☆☆☆'],
    [0, '☆☆☆☆☆'],
  ])('值 %s → %s', (value, expected) => {
    expect(cardHtml(value, m)).toContain(expected);
  });

  it('异常输入（对象 / 非数字字符串）→ 占位，不崩', () => {
    expect(cardHtml({ a: 1 }, m)).toContain('—');
    expect(cardHtml('abc', m)).toContain('—');
  });
});

/* ============================ 进度 ============================ */

describe('T07 · Progress（进度条 + 百分比）', () => {
  const m = meta(FieldType.Progress, undefined, '进度');

  it.each([
    [42, '42%'],
    [150, '100%'],
    [-5, '0%'],
  ])('值 %s → %s', (value, expected) => {
    expect(cardHtml(value, m)).toContain(expected);
  });

  it('异常输入 → 占位，不崩；文档态渲染百分比', () => {
    expect(cardHtml({ a: 1 }, m)).toContain('—');
    expect(docHtml(66, m)).toContain('66%');
  });
});

/* ============================ 链接（Url / Phone） ============================ */

describe('T07 · Link（Url/Phone）：仅人可见文本本身是合法 URL 时才生成 <a>', () => {
  const urlMeta = meta(FieldType.Url, undefined, '链接');
  const phoneMeta = meta(FieldType.Phone, undefined, '电话');

  it('{text, link} → 以 text 为显示名，不把显示名当 href', () => {
    const html = expectSafe(
      () => cardHtml({ text: '显示名', link: 'https://example.com/a' }, urlMeta),
      ['href="显示名"'],
    );
    expect(html).toContain('显示名');
  });

  it('{link} 无 text → 合法 http(s) 生成 <a href>', () => {
    const html = cardHtml({ link: 'https://example.com/a' }, urlMeta);
    expect(html).toContain('href="https://example.com/a"');
  });

  it('裸字符串合法 URL → 生成 <a>', () => {
    expect(cardHtml('https://example.com/x', urlMeta)).toContain('href="https://example.com/x"');
  });

  it('【安全】javascript: 伪协议 → 退化为纯文本，绝不生成 href', () => {
    const html = cardHtml('javascript:alert(1)', urlMeta);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('javascript:alert(1)');
    const html2 = cardHtml({ text: '危险', link: 'javascript:alert(1)' }, urlMeta);
    expect(html2).not.toContain('href="javascript');
    expect(html2).toContain('危险');
  });

  it('电话 → tel: 链接（剥离空格/括号；连字符按 RFC3966 保留）', () => {
    expect(cardHtml('138 0000 0000', phoneMeta)).toContain('href="tel:13800000000"');
    expect(cardHtml('(138)0000 0000', phoneMeta)).toContain('href="tel:13800000000"');
    // 连字符是 RFC3966 允许的可视分隔符，实现仅剥离空格与括号 → 保留连字符（合规，非缺陷）
    expect(cardHtml('138-0000-0000', phoneMeta)).toContain('href="tel:138-0000-0000"');
  });

  it('空对象 / 空串 → 占位，不崩', () => {
    expect(cardHtml({}, urlMeta)).toContain('—');
    expect(cardHtml('', urlMeta)).toContain('—');
  });
});

/* ============================ 公式 ============================ */

describe('T07 · Formula（保守解包；绝不出 JSON）', () => {
  const m = meta(FieldType.Formula, undefined, '公式');

  it('{value: number|string|boolean} → 分发到对应渲染', () => {
    expect(cardHtml({ value: 42 }, m)).toContain('42');
    expect(cardHtml({ value: 'abc' }, m)).toContain('abc');
    expect(cardHtml({ value: true }, m)).toContain('是');
    expect(cardHtml(7, m)).toContain('7');
  });

  it('无法解包的对象 → FallbackRenderer，不含 JSON 字面量', () => {
    const html = expectSafe(() => cardHtml({ value: { foo: 'bar' } }, m), ['foo', 'bar', '{']);
    expect(html).toContain('该字段类型暂不支持');
    const html2 = expectSafe(() => cardHtml({ a: 1 }, m), ['{', 'a":1']);
    expect(html2).toContain('该字段类型暂不支持');
  });

  it('超长字符串结果 → 不抛错', () => {
    expect(() => cardHtml({ value: 'y'.repeat(500) }, m)).not.toThrow();
  });
});

/* ============================ 查找引用 / 关联 ============================ */

describe('T07 · Lookup/Link/DuplexLink（多值展开；绝不外泄关联记录 ID）', () => {
  const m = meta(FieldType.Lookup, undefined, '关联');

  it('字符串数组 → 展开为文本列表', () => {
    const html = cardHtml(['客户A', '客户B'], m);
    expect(html).toContain('客户A');
    expect(html).toContain('客户B');
  });

  it('对象数组（含 recordId）→ 不泄漏 recordId', () => {
    const html = expectSafe(
      () => cardHtml([{ recordId: 'rec_SECRET_1', text: '记录甲' }], m),
      ['rec_SECRET_1', 'recordId'],
    );
    expect(html).toContain('记录甲');
  });

  it('纯 ID 对象（无 text/name）→ 不泄漏 recordId（落空值占位或兜底，均安全）', () => {
    const html = expectSafe(
      () => cardHtml([{ recordId: 'rec_SECRET_2' }], m),
      ['rec_SECRET_2', 'recordId', '{'],
    );
    // 设计只要求「不泄漏原始 ID/JSON」：此处归一化为空值占位 '—'（或兜底提示）皆合规
    expect(html).toMatch(/—|该字段类型暂不支持/);
  });

  it('非法对象 → FallbackRenderer，不崩', () => {
    expectSafe(() => cardHtml({ a: 1 }, m), ['{']);
  });
});

/* ============================ 货币符号（M1 缺陷 F1 回归） ============================ */

describe('T07/F1 · 货币符号读取 property.symbol（不硬编码 ¥）', () => {
  it('symbol=$ → $1,280,000.00', () => {
    const html = cardHtml(1280000, meta(FieldType.Currency, { symbol: '$' }, '金额'));
    expect(html).toContain('$1,280,000.00');
  });

  it('symbol=€ → €…；文档态同样使用该符号', () => {
    const m = meta(FieldType.Currency, { symbol: '€' }, '金额');
    expect(cardHtml(1000, m)).toContain('€1,000.00');
    expect(docHtml(1000, m)).toContain('€1,000.00');
  });

  it('无 property.symbol → 兜底 ¥', () => {
    expect(cardHtml(1000, meta(FieldType.Currency, undefined, '金额'))).toContain('¥1,000.00');
  });

  it('负数：符号在负号之后', () => {
    expect(cardHtml(-2500, meta(FieldType.Currency, { symbol: '$' }, '金额'))).toContain('-$2,500.00');
  });

  it('对象灌入货币字段（F4）→ 占位，绝不渲染成 ¥0.00', () => {
    const html = cardHtml({ a: 1 }, meta(FieldType.Currency, undefined, '金额'));
    expect(html).toContain('—');
    expect(html).not.toContain('¥0.00');
  });
});

/* ============================ 全类型异常输入扫掠（不崩） ============================ */

describe('T07 · 七类 P1 渲染器对「对象/超长/空数组」异常输入一律不抛错', () => {
  const cases: Array<[string, number, unknown]> = [
    ['user', FieldType.User, { notAUser: true }],
    ['user-empty', FieldType.User, []],
    ['attachment', FieldType.Attachment, { notAnAttachment: 1 }],
    ['attachment-empty', FieldType.Attachment, []],
    ['rating', FieldType.Rating, { notNumber: 'x' }],
    ['progress', FieldType.Progress, { notNumber: 'x' }],
    ['url', FieldType.Url, { weird: true }],
    ['phone', FieldType.Phone, 12345 as unknown],
    ['formula', FieldType.Formula, { nested: { deep: { deeper: 1 } } }],
    ['lookup', FieldType.Lookup, { nested: true }],
  ];

  it.each(cases)('%s 卡片态与文档态均不抛错', (_label, type, raw) => {
    const m = meta(type);
    expect(() => cardHtml(raw, m)).not.toThrow();
    expect(() => docHtml(raw, m)).not.toThrow();
  });
});
