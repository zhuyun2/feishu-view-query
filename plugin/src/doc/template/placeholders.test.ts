import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import TxtTemplater from 'docxtemplater/text';
import {
  buildFieldIndex,
  checkTemplate,
  extractPlaceholders,
  parseTemplate,
  splitLiterals,
} from './placeholders';
import type { FieldMetaLike, LoopPlaceholderToken, PlaceholderToken, SimplePlaceholderToken } from './placeholders';

/**
 * `doc/template/placeholders` 单测（模板导入第一步：占位符解析 + 字段匹配 + 模板体检）。
 *
 * 断言策略（团队铁律：**禁止假绿**）：
 *  - 一律**锁定具体值 / 具体结构**（精确下标、精确 name、精确 fieldId 序列），
 *    不用 `toBeTruthy()` / `length > 0` 之类可恒真的断言充当某条语义的验证；
 *  - **否定式断言必配正面锚点**（如「未闭合循环不产出 loop token」同时断言它产出了 1 个
 *    被上提的 simple token，防「目标消失 → 恒真」）；
 *  - **两条链路可能同值处，fixture 必须让它们分离**（如 trim：`{ 客户名称 }` 若未 trim，
 *    名字会是 `' 客户名称 '`；重名：若静默取首个，`标题` 会出现在 `matched` 里）；
 *  - **源码级断言先剔注释再匹配**（本文件头注释里就写了 `docxtemplater` / `React` / `import`，
 *    不剔注释的正则会骗过自己）。
 *
 * ⭐ 对照测试：用**真实的 `docxtemplater` 3.69.2** 渲染同一段文本，断言「我们判为占位符的，
 *    它确实替换了；我们判为普通文本的，它确实原样保留」——防止本模块与库语义漂移。
 */

/* ===================== 对照测试工具（真实 docxtemplater） ===================== */

/**
 * 真实 `docxtemplater` 的纯文本渲染器。
 *
 * 采用 `TxtTemplater`（`docxtemplater/text.d.ts`）——它与 docx 路径**共用**同一套
 * `Lexer` / `Parser` / loop / render 模块，只是把「模板」喂成纯文本，正是本模块的输入形态。
 *
 * `LOOSE`：显式放开 `allowUnclosedTag` / `allowUnopenedTag`，对齐本模块「无法配对即普通文本」
 * 的裁定；`nullGetter: () => ''` 与参考项目一致（缺失值填空串而非 `'undefined'`）。
 */
const LOOSE = {
  syntax: { allowUnclosedTag: true, allowUnopenedTag: true },
  nullGetter: (): string => '',
} as const;

function renderLoose(template: string, data: Record<string, unknown>): string {
  return new TxtTemplater(template, LOOSE).render(data);
}

/** 默认配置的渲染（`allowUnclosedTag/allowUnopenedTag` 均为 false） */
function renderStrict(template: string, data: Record<string, unknown>): string {
  return new TxtTemplater(template).render(data);
}

/**
 * 用**本模块**的解析结果做最朴素的替换，复现「应有」的渲染文本。
 * 与真实库输出比对，可一次性证明：我们判为占位符的都被替换了、判为字面文本的都被保留了。
 *
 * ⚠️ 所有 token 下标都是**绝对坐标**（相对整段模板文本），循环段体只是切片 `[openEnd, closeStart)`；
 * 因此递归时把 `from` / `to` 夹到段体区间上，而不是拿 `body` 另起坐标系。
 */
function substitute(
  text: string,
  tokens: ReadonlyArray<PlaceholderToken>,
  data: Record<string, unknown>,
  from = 0,
  to = text.length,
): string {
  let out = '';
  let cursor = from;
  for (const token of tokens) {
    const start = token.kind === 'simple' ? token.start : token.openStart;
    const end = token.kind === 'simple' ? token.end : token.closeEnd;
    if (start < cursor || end > to) continue; // 不在本区间内的 token（如外层段落）跳过
    out += text.slice(cursor, start);
    if (token.kind === 'simple') {
      out += String(data[token.name]);
    } else {
      const items = Array.isArray(data[token.name]) ? (data[token.name] as Array<Record<string, unknown>>) : [];
      for (const item of items) out += substitute(text, token.inner, item, token.openEnd, token.closeStart);
    }
    cursor = end;
  }
  return out + text.slice(cursor, to);
}

/** 取占位符原文（简单 = `{名}`；循环 = `{#名}`）——联合类型无统一 `raw` 字段，故用判别函数 */
function rawOf(token: PlaceholderToken): string {
  return token.kind === 'simple' ? token.raw : token.openRaw;
}

/* ===================== 夹具 ===================== */

const FIELDS: FieldMetaLike[] = [
  { id: 'fld_name', name: '客户名称' },
  { id: 'fld_amount', name: '金额' },
  { id: 'fld_items', name: '明细' },
  { id: 'fld_project', name: '项目' },
  { id: 'fld_note', name: '备注' },
];

/* ===================== ① extractPlaceholders ===================== */

describe('docx/template/placeholders · ① 抽取', () => {
  it('`{客户名称}` → 抽出 1 个简单占位符，名字与下标精确', () => {
    const tokens = extractPlaceholders('{客户名称}');
    expect(tokens).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: '客户名称', raw: '{客户名称}', start: 0, end: 6 },
    ]);
  });

  it('文本中的 `{客户名称}` → 只抽占位符，位置落在标签上', () => {
    const tokens = extractPlaceholders('甲方：{客户名称}。');
    expect(tokens).toHaveLength(1);
    const token = tokens[0] as SimplePlaceholderToken;
    expect(token.kind).toBe('simple');
    expect(token.name).toBe('客户名称');
    // '甲方：' 共 3 字符 → '{' 在 3；'{客户名称}' 6 字符 → end = 9
    expect([token.start, token.end]).toEqual([3, 9]);
    expect(token.raw).toBe('{客户名称}');
  });

  it('`{#明细}行:{项目};{/明细}` → 抽出 1 个循环段：起止位置、段体、内部占位符精确', () => {
    const text = '{#明细}行:{项目};{/明细}';
    const tokens = extractPlaceholders(text);
    expect(tokens).toHaveLength(1);
    const loop = tokens[0] as LoopPlaceholderToken;
    expect(loop.kind).toBe('loop');
    expect(loop.name).toBe('明细');
    expect(loop.openRaw).toBe('{#明细}');
    expect(loop.closeRaw).toBe('{/明细}');
    expect([loop.openStart, loop.openEnd]).toEqual([0, 5]);
    expect([loop.closeStart, loop.closeEnd]).toEqual([12, 17]);
    expect(text.slice(loop.openStart, loop.openEnd)).toBe('{#明细}');
    expect(text.slice(loop.closeStart, loop.closeEnd)).toBe('{/明细}');
    expect(loop.body).toBe('行:{项目};');
    expect(loop.inner).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: '项目', raw: '{项目}', start: 7, end: 11 },
    ]);
    // 锁定「inner 下标为绝对坐标」这一契约：直接用整段文本切片即可取到原文
    const innerToken = loop.inner[0] as SimplePlaceholderToken;
    expect(text.slice(innerToken.start, innerToken.end)).toBe('{项目}');
    expect(loop.body.slice(innerToken.start - loop.openEnd, innerToken.end - loop.openEnd)).toBe('{项目}');
  });

  it('循环段内可嵌套循环段（inner 支持更深一层）', () => {
    const text = '{#a}{#b}{c}{/b}{/a}';
    const tokens = extractPlaceholders(text);
    expect(tokens).toHaveLength(1);
    const outer = tokens[0] as LoopPlaceholderToken;
    expect(outer.name).toBe('a');
    expect(outer.body).toBe('{#b}{c}{/b}');
    expect(outer.inner).toHaveLength(1);
    const inner = outer.inner[0] as LoopPlaceholderToken;
    expect(inner.kind).toBe('loop');
    expect(inner.name).toBe('b');
    expect(inner.inner).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: 'c', raw: '{c}', start: 8, end: 11 },
    ]);
  });

  it('多个并列占位符 → 保序（按出现位置）', () => {
    const raws = extractPlaceholders('{a}中{b}').map(rawOf);
    expect(raws).toEqual(['{a}', '{b}']);
  });

  it('空输入 / 无占位符 → 空数组', () => {
    expect(extractPlaceholders('')).toEqual([]);
    expect(extractPlaceholders('这里一个字面文本都没有占位符')).toEqual([]);
  });
});

/* ===================== 无法配对 / 空标签 → 普通文本 ===================== */

describe('docx/template/placeholders · 无法配对与空标签一律为普通文本', () => {
  it('`{abc`（无闭合）→ 不产出占位符，且文本一字未吞', () => {
    expect(extractPlaceholders('{abc')).toEqual([]);
    // 正面锚点：字面片段必须等于原文本身（证明没有吞字符）
    expect(splitLiterals('{abc')).toEqual(['{abc']);
  });

  it('`abc}`（无开始）→ 不产出占位符，且文本一字未吞', () => {
    expect(extractPlaceholders('abc}')).toEqual([]);
    expect(splitLiterals('abc}')).toEqual(['abc}']);
  });

  it('`{}`（空标签）→ 普通文本，不产出占位符，且文本一字未吞', () => {
    expect(extractPlaceholders('前{}后')).toEqual([]);
    expect(splitLiterals('前{}后')).toEqual(['前{}后']);
  });

  it('`{  }`（纯空白标签）→ 同样按普通文本处理', () => {
    expect(extractPlaceholders('前{  }后')).toEqual([]);
  });

  it('字面文本 + 无法配对的花括号混排 → 只有合法标签被抽出，其余原样保留', () => {
    const text = '前{a}中{b';
    const tokens = extractPlaceholders(text);
    expect(tokens).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: 'a', raw: '{a}', start: 1, end: 4 },
    ]);
    // 正面锚点：被跳过的 `中{b` 必须完整留在字面片段里
    expect(splitLiterals(text, tokens)).toEqual(['前', '中{b']);
  });

  it('孤立 `}` 混在合法标签之后 → 原样保留', () => {
    const text = '前{a}后}';
    const tokens = extractPlaceholders(text);
    expect(tokens).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: 'a', raw: '{a}', start: 1, end: 4 },
    ]);
    expect(splitLiterals(text, tokens)).toEqual(['前', '后}']);
  });
});

/* ===================== 名字 trim ===================== */

describe('docx/template/placeholders · 标签名 trim', () => {
  it('`{ 客户名称 }` → 名字为 `客户名称`（未 trim 的实现会得到 `" 客户名称 "`）', () => {
    const tokens = extractPlaceholders('{ 客户名称 }');
    expect(tokens).toHaveLength(1);
    const token = tokens[0] as SimplePlaceholderToken;
    expect(token.name).toBe('客户名称');
    // 原文按用户写的保留，便于 UI 高亮
    expect(token.raw).toBe('{ 客户名称 }');
    expect([token.start, token.end]).toEqual([0, 8]);
  });

  it('`{# 明细 }` → 循环名同样 trim', () => {
    const tokens = extractPlaceholders('{# 明细 }x{/ 明细 }');
    const loop = tokens[0] as LoopPlaceholderToken;
    expect(loop.kind).toBe('loop');
    expect(loop.name).toBe('明细');
  });
});

/* ===================== ② buildFieldIndex ===================== */

describe('docx/template/placeholders · ② 字段索引', () => {
  it('按名字精确建索引，并提供 fieldId → name 反查', () => {
    const index = buildFieldIndex(FIELDS);
    expect(index.byName.size).toBe(5);
    expect(index.byName.get('客户名称')).toEqual([{ id: 'fld_name', name: '客户名称' }]);
    expect(index.nameById.get('fld_items')).toBe('明细');
    expect(index.duplicates).toEqual([]);
  });

  it('重名 → 进 duplicates 并列出全部 fieldId（不做「取第一个」）', () => {
    const index = buildFieldIndex([
      { id: 'a', name: '标题' },
      { id: 'b', name: '标题' },
      { id: 'c', name: '正文' },
    ]);
    expect(index.duplicates).toEqual([{ name: '标题', fieldIds: ['a', 'b'] }]);
    expect(index.byName.get('标题')).toEqual([
      { id: 'a', name: '标题' },
      { id: 'b', name: '标题' },
    ]);
  });

  it('字段名首尾空白被 trim 后建索引（`" 金额 "` 与 `"金额"` 视为同名 → 冲突）', () => {
    const index = buildFieldIndex([
      { id: 'a', name: ' 金额 ' },
      { id: 'b', name: '金额' },
    ]);
    expect(index.duplicates).toEqual([{ name: '金额', fieldIds: ['a', 'b'] }]);
  });

  it('用 Map 承载名字索引：字段名取 `__proto__` / `constructor` 不会误命中原型链', () => {
    const index = buildFieldIndex([
      { id: 'f1', name: '__proto__' },
      { id: 'f2', name: 'constructor' },
    ]);
    expect(index.byName.get('__proto__')).toEqual([{ id: 'f1', name: '__proto__' }]);
    expect(index.byName.get('constructor')).toEqual([{ id: 'f2', name: 'constructor' }]);
    // 正面锚点之外的反向验证：未声明的原型链名字必须查不到
    expect(index.byName.get('toString')).toBeUndefined();
    expect(index.byName.get('hasOwnProperty')).toBeUndefined();
  });

  it('id 为空 / 名字 trim 后为空的字段不进索引', () => {
    const index = buildFieldIndex([
      { id: '', name: '幽灵' },
      { id: 'f1', name: '   ' },
      { id: 'f2', name: '有效' },
    ]);
    expect(index.byName.size).toBe(1);
    expect(index.nameById.has('f1')).toBe(false);
    expect(index.nameById.get('f2')).toBe('有效');
  });

  it('空字段列表 / 非法入参 → 空索引，不抛错', () => {
    expect(buildFieldIndex([]).byName.size).toBe(0);
    expect(buildFieldIndex(null as unknown as FieldMetaLike[]).duplicates).toEqual([]);
  });
});

/* ===================== ③ checkTemplate ===================== */

describe('docx/template/placeholders · ③ 模板体检', () => {
  it('命中 / 未命中 / 未使用字段 一次分清', () => {
    const text = '甲方：{客户名称}，金额：{金额}元。{#明细}行:{项目};{/明细}{不存在的字段}';
    const health = checkTemplate(text, FIELDS);

    expect(health.matched.map((item) => [item.fieldName, item.fieldId, item.placeholder])).toEqual([
      ['客户名称', 'fld_name', '{客户名称}'],
      ['金额', 'fld_amount', '{金额}'],
      ['明细', 'fld_items', '{#明细}'],
      ['项目', 'fld_project', '{项目}'],
    ]);
    expect(health.unmatched).toEqual(['不存在的字段']);
    expect(health.unusedFields).toEqual([{ fieldId: 'fld_note', fieldName: '备注' }]);
    expect(health.duplicateFieldNames).toEqual([]);
    expect(health.unclosedLoops).toEqual([]);
    expect(health.ambiguous).toEqual([]);
  });

  it('模板写了不存在的名字 → 进 unmatched（而非静默）', () => {
    const health = checkTemplate('{不存在的字段}', FIELDS);
    expect(health.unmatched).toEqual(['不存在的字段']);
    // 正面锚点：同一个模板里放一个存在的名字，它必须进 matched 而不是 unmatched
    const mixed = checkTemplate('{不存在的字段}{客户名称}', FIELDS);
    expect(mixed.unmatched).toEqual(['不存在的字段']);
    expect(mixed.matched.map((item) => item.fieldId)).toEqual(['fld_name']);
  });

  it('字段重名 → 该名字进 ambiguous、绝不静默取首个（`标题` 不出现在 matched 里）', () => {
    const fields: FieldMetaLike[] = [
      { id: 'a', name: '标题' },
      { id: 'b', name: '标题' },
      { id: 'c', name: '正文' },
    ];
    const health = checkTemplate('{标题}{正文}', fields);
    expect(health.duplicateFieldNames).toEqual([{ name: '标题', fieldIds: ['a', 'b'] }]);
    expect(health.ambiguous).toEqual([{ name: '标题', placeholder: '{标题}', fieldIds: ['a', 'b'] }]);
    expect(health.matched.map((item) => item.fieldId)).toEqual(['c']);
    // 反向验证：若实现静默取首个，`a` 会出现在这里 → 本断言必红
    expect(health.matched.some((item) => item.fieldId === 'a')).toBe(false);
    expect(health.unmatched).toEqual([]);
  });

  it('未闭合循环 `{#明细}…` → 进 unclosedLoops；段内简单占位符上提为同层 token（不漏报）', () => {
    const health = checkTemplate('{#明细}内容{项目}', FIELDS);
    expect(health.unclosedLoops).toEqual(['明细']);
    // 正面锚点：段内的 `{项目}` 不能因为循环没闭合就凭空消失
    expect(health.tokens).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: '项目', raw: '{项目}', start: 7, end: 11 },
    ]);
    expect(health.matched.map((item) => item.fieldId)).toEqual(['fld_project']);
  });

  it('无对应的 `{/名}` → 进 unopenedLoops，且不产出 token', () => {
    const health = checkTemplate('{/明细}内容', FIELDS);
    expect(health.unopenedLoops).toEqual(['明细']);
    expect(health.tokens).toEqual([]);
  });

  it('`{#a}…{/b}` 名字不匹配 → a 记未闭合、b 记无开始', () => {
    const parsed = parseTemplate('{#a}x{/b}');
    expect(parsed.unclosedLoops).toEqual(['a']);
    expect(parsed.unopenedLoops).toEqual(['b']);
  });

  it('空模板 → 全部字段未被使用', () => {
    const health = checkTemplate('', FIELDS);
    expect(health.matched).toEqual([]);
    expect(health.unmatched).toEqual([]);
    expect(health.unusedFields.map((item) => item.fieldId)).toEqual([
      'fld_name',
      'fld_amount',
      'fld_items',
      'fld_project',
      'fld_note',
    ]);
  });
});

/* ===================== 纯函数 ===================== */

describe('docx/template/placeholders · 纯函数', () => {
  it('同一输入两次调用 → 结构完全一致（无时间 / 随机 / 全局可变状态）', () => {
    const text = '{#明细}行:{项目};{/明细}{客户名称}';
    expect(checkTemplate(text, FIELDS)).toEqual(checkTemplate(text, FIELDS));
  });

  it('不修改入参（字段列表不被原地改写）', () => {
    const fields: FieldMetaLike[] = [{ id: 'a', name: ' 标题 ' }];
    buildFieldIndex(fields);
    expect(fields).toEqual([{ id: 'a', name: ' 标题 ' }]);
  });
});

/* ===================== 对照测试（真实 docxtemplater） ===================== */

describe('docx/template · 对照测试（与真实 docxtemplater 比对）', () => {
  it('我们判为占位符的，真实库确实替换了；我们判为字面文本的，真实库确实原样保留', () => {
    const template = '甲方：{客户名称}，金额：{金额}元。';
    const data: Record<string, unknown> = { 客户名称: 'ACME', 金额: '100' };

    // ① 我们的判断
    const tokens = extractPlaceholders(template);
    expect(tokens.map(rawOf)).toEqual(['{客户名称}', '{金额}']);

    // ② 真实库的输出（精确值）
    const rendered = renderLoose(template, data);
    expect(rendered).toBe('甲方：ACME，金额：100元。');

    // ③ 两条链路的交叉验证：用我们的 token 做朴素替换，必须逐字复现真实库输出。
    //    若我们把某段文本误判为占位符（或漏判），这里必然对不上。
    expect(substitute(template, tokens, data)).toBe(rendered);
  });

  it('我们判为普通文本的，真实库在放开未配对标签后同样原样保留', () => {
    const cases = ['这里没有占位符', '{abc', 'abc}', '前{abc后', '尾abc}端'];
    for (const template of cases) {
      expect(extractPlaceholders(template)).toEqual([]);
      const rendered = renderLoose(template, {});
      expect(rendered).toBe(template);
      expect(splitLiterals(template)).toEqual([template]);
    }
  });

  it('合法标签与未配对花括号混排 → 真实库的替换结果与我们的解析一致', () => {
    const data: Record<string, unknown> = { a: '1' };
    for (const template of ['前{a}中{b', '前{a}后}', '{a}{']) {
      const tokens = extractPlaceholders(template);
      const rendered = renderLoose(template, data);
      expect(substitute(template, tokens, data)).toBe(rendered);
    }
    // 精确锁定参与混排那一条的输出（其余两条用交叉验证兜住）
    expect(renderLoose('前{a}中{b', data)).toBe('前1中{b');
  });

  it('循环段 → 真实库的展开结果与我们的解析一致', () => {
    const template = '{#明细}行:{项目};{/明细}';
    const data: Record<string, unknown> = { 明细: [{ 项目: '甲' }, { 项目: '乙' }] };

    const tokens = extractPlaceholders(template);
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as LoopPlaceholderToken).name).toBe('明细');

    const rendered = renderLoose(template, data);
    expect(rendered).toBe('行:甲;行:乙;');
    expect(substitute(template, tokens, data)).toBe(rendered);
  });

  it('真实库默认配置对未配对标签会抛错 → 填充层必须显式放开（否则体检「通过」的模板会整份报错）', () => {
    // 正面锚点：默认配置对合法模板照常工作
    expect(renderStrict('{a}', { a: '1' })).toBe('1');
    // 我们的裁定：未配对一律普通文本
    expect(extractPlaceholders('前{abc后')).toEqual([]);
    // 真实库默认配置：直接抛错 —— 这正是「填充层必须传 allowUnclosedTag/allowUnopenedTag」的依据
    expect(() => renderStrict('前{abc后', {})).toThrow();
    expect(() => renderStrict('前abc}后', {})).toThrow();
    // 放开后与本模块一致
    expect(renderLoose('前{abc后', {})).toBe('前{abc后');
    expect(renderLoose('前abc}后', {})).toBe('前abc}后');
  });
});

/* ===================== 已知语义分歧（有意为之，锁定以防漂移） ===================== */

describe('docx/template · 已知语义分歧（锁定）', () => {
  it('空标签 `{}`：本模块视为普通文本，而真实库把它当作「无名标签」吃掉', () => {
    // 我们的裁定（正面锚点）
    expect(extractPlaceholders('前{}后')).toEqual([]);
    expect(splitLiterals('前{}后')).toEqual(['前{}后']);
    // 真实库的实际行为：`{}` 是标签 → 被 nullGetter('') 替换 → 输出不含花括号
    expect(renderLoose('前{}后', {})).toBe('前后');
    // 对照：默认 nullGetter 会填 `undefined`，进一步证明它确实被当成标签处理
    expect(renderStrict('前{}后', {})).toBe('前undefined后');
  });

  it('标签名 trim：本模块 trim，真实库不 trim（`{ 客户名称 }` 在库里查不到字段）', () => {
    expect((extractPlaceholders('{ 客户名称 }')[0] as SimplePlaceholderToken).name).toBe('客户名称');
    // 真实库不做 trim：名字是 ` 客户名称 `，因此查不到 → nullGetter → 空串
    expect(renderLoose('{ 客户名称 }', { 客户名称: 'ACME' })).toBe('');
    // 仅当数据键也带空格时库才命中，反证「库未 trim」
    expect(renderLoose('{ 客户名称 }', { ' 客户名称 ': 'ACME' })).toBe('ACME');
  });

  it('`{{a}}` 的解析与真实库一致：外层花括号是字面文本，标签是 `{a}`', () => {
    const text = '{{a}}';
    expect(extractPlaceholders(text)).toEqual<PlaceholderToken[]>([
      { kind: 'simple', name: 'a', raw: '{a}', start: 1, end: 4 },
    ]);
    expect(splitLiterals(text)).toEqual(['{', '}']);
    expect(renderLoose(text, { a: 'X' })).toBe('{X}');
  });
});

/* ===================== 源码级守卫 ===================== */

/** 去掉块注释与行注释（源码级正则必须先在无注释文本上匹配，否则注释里的同形内容会骗过断言） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ⚠️ 不用 `import.meta.url`：vitest 的 Vite 转换下它不是 file: URL（会抛
// `ERR_INVALID_URL_SCHEME`）。vitest 的 root / cwd 恒为插件根目录，按 cwd 解析最稳。
const SOURCE = stripComments(readFileSync(resolve(process.cwd(), 'src/doc/template/placeholders.ts'), 'utf8'));

describe('docx/template/placeholders · 源码级守卫', () => {
  it('生产文件零运行时依赖：只允许 `import type`，不得 import React / docxtemplater / pizzip', () => {
    // 注释已剔除——本文件头注释里就写着 docxtemplater / React / import 等字样
    expect(SOURCE).not.toMatch(/\bimport\b(?!\s+type\b)/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/from\s*['"](react|react-dom|docxtemplater|pizzip)['"]/);
    expect(SOURCE).not.toMatch(/\bdocument\b|\bwindow\b/);
  });

  it('纯函数：无 `Math.random` / `Date.now` 等不确定性来源', () => {
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(/);
  });

  it('不做模糊匹配：源码里不出现相似度 / 编辑距离类实现', () => {
    expect(SOURCE).not.toMatch(/levenshtein|similarity|fuzzy|distance/i);
  });
});
