/**
 * QA2 独立复核 —— docx 模板占位符解析层（`./placeholders`）。
 *
 * 目的：**证伪**，不是复述实现方结论。每条断言都自造输入、独立于实现方用例。
 *
 * 复核的冻结设计：
 *  · 设计1 —— `{字段名}` / `{#字段名}…{/字段名}`；无法配对的花括号与空标签 `{}` **视为普通文本**（不吞字符）。
 *  · 设计2 —— 按字段名 **trim 后精确匹配**，**不做**模糊匹配。
 *  · 设计3 —— 字段重名**绝不静默取首个** → 进 `ambiguous` / `duplicateFieldNames`。
 *
 * 断言纪律：不使用可恒真断言；每条否定式断言配正面锚点；两条链路可能同值处用分离的 fixture。
 */
import { describe, expect, it } from 'vitest';
import { buildFieldIndex, checkTemplate, extractPlaceholders, parseTemplate, splitLiterals } from './placeholders';
import type { FieldMetaLike, LoopPlaceholderToken, PlaceholderToken } from './placeholders';

/* ===================== 工具 ===================== */

function startOf(token: PlaceholderToken): number {
  return token.kind === 'simple' ? token.start : token.openStart;
}
function endOf(token: PlaceholderToken): number {
  return token.kind === 'simple' ? token.end : token.closeEnd;
}
function rawOf(token: PlaceholderToken): string {
  return token.kind === 'simple' ? token.raw : token.openRaw;
}

/**
 * token 覆盖的源码区间文本：
 *  · 简单占位符 → 其 `raw`（应与源码切片逐字相同，另由断言锁定）；
 *  · 循环段 → `[openStart, closeEnd)` 的源码切片（含段体，段体内 token 不在顶层列表里）。
 */
function coverOf(text: string, token: PlaceholderToken): string {
  return token.kind === 'simple' ? token.raw : text.slice(token.openStart, token.closeEnd);
}

/**
 * 用 token 覆盖区间 + 区间外的字面段把原文拼回去。
 *
 * 这是「不吞字符」的**性质级**断言：只要实现吞掉 / 多算 / 错位任何一个字符，
 * 拼回的字符串就会 ≠ 原文 —— 对**任意**病态输入都成立，不依赖逐例硬编码。
 */
function reconstruct(text: string, tokens: ReadonlyArray<PlaceholderToken>): string {
  const sorted = [...tokens].sort((a, b) => startOf(a) - startOf(b));
  let out = '';
  let cursor = 0;
  for (const token of sorted) {
    const s = startOf(token);
    const e = endOf(token);
    if (s < cursor) continue; // 区间重叠（实现出错）→ 跳过，交由相等断言暴露
    out += text.slice(cursor, s);
    out += coverOf(text, token);
    cursor = e;
  }
  return out + text.slice(cursor);
}

/* ===================== 设计1：语法 / 不吞字符 ===================== */

describe('QA2 · placeholders · 设计1（语法与「不吞字符」性质）', () => {
  const CASES: string[] = [
    '',
    '无占位符的纯文本',
    '{a}',
    '{}',
    '{  }',
    '{abc',
    'abc}',
    '{{a}}',
    '{{}}',
    '前{a}中{b',
    '前{a}后}',
    '{a}{a}',
    '{#x}{#y}{z}{/y}{/x}',
    '{#a}',
    '{/a}',
    '{#a}{/b}',
    '}{',
    '{}{}',
    '{a}}}{b}',
    'a{b}c}',
    '{} {}',
  ];

  it('对全部病态输入：token 的 raw 与其源码切片逐字一致、顶层 span 不重叠、拼回等于原文', () => {
    for (const text of CASES) {
      const tokens = extractPlaceholders(text);
      const label = `输入=${JSON.stringify(text)}`;
      // ① 拼回原文（吞字符 / 错位 / 空洞 / 重叠 都会红）
      expect(reconstruct(text, tokens), label).toBe(text);
      // ② 每个 token 的 raw 必须与源码切片逐字一致（下标 off-by-one 必红）
      const sorted = [...tokens].sort((a, b) => startOf(a) - startOf(b));
      let prevEnd = 0;
      for (const token of sorted) {
        const s = startOf(token);
        const e = endOf(token);
        expect(s, label).toBeGreaterThanOrEqual(prevEnd); // 顶层 span 不重叠
        if (token.kind === 'simple') {
          expect(token.raw, label).toBe(text.slice(s, e));
        } else {
          expect(token.openRaw, label).toBe(text.slice(token.openStart, token.openEnd));
          expect(token.closeRaw, label).toBe(text.slice(token.closeStart, token.closeEnd));
        }
        prevEnd = e;
      }
    }
  });

  it('纯字面输入（无可配对标签）→ 无 token 且 splitLiterals 原样返回整串', () => {
    for (const text of ['', '无占位符的纯文本', '{abc', 'abc}', '{}', '{  }', '}', '{']) {
      expect(extractPlaceholders(text), `输入=${JSON.stringify(text)}`).toEqual([]);
      expect(splitLiterals(text), `输入=${JSON.stringify(text)}`).toEqual(text === '' ? [] : [text]);
    }
  });

  it('`{a}{a}` 同一占位符出现两次 → 两个 token（位置分离），名字都为 a', () => {
    const tokens = extractPlaceholders('{a}{a}');
    expect(tokens.map(rawOf)).toEqual(['{a}', '{a}']);
    expect(tokens.map((t) => (t.kind === 'simple' ? t.start : t.openStart))).toEqual([0, 3]);
  });

  it('嵌套循环 `{#x}{#y}{z}{/y}{/x}` → 外层 x，内层 y，叶子 z（结构精确）', () => {
    const tokens = extractPlaceholders('{#x}{#y}{z}{/y}{/x}');
    expect(tokens).toHaveLength(1);
    const outer = tokens[0] as LoopPlaceholderToken;
    expect(outer.kind).toBe('loop');
    expect(outer.name).toBe('x');
    expect(outer.body).toBe('{#y}{z}{/y}');
    expect(outer.inner).toHaveLength(1);
    const inner = outer.inner[0] as LoopPlaceholderToken;
    expect(inner.kind).toBe('loop');
    expect(inner.name).toBe('y');
    expect(inner.body).toBe('{z}');
    expect(inner.inner.map((t) => t.name)).toEqual(['z']);
  });

  it('空标签 `{}` 与合法标签混排：只抽合法标签，`{}` 原样留在字面段', () => {
    const text = 'A{}{b}C';
    const tokens = extractPlaceholders(text);
    expect(tokens.map(rawOf)).toEqual(['{b}']);
    expect(splitLiterals(text, tokens)).toEqual(['A{}', 'C']);
  });
});

/* ===================== 设计2：精确匹配，不做模糊 ===================== */

describe('QA2 · placeholders · 设计2（精确匹配 / 不做模糊）', () => {
  const FIELDS: FieldMetaLike[] = [{ id: 'f_name', name: '客户名称' }];

  it('名字完全一致（trim 后）→ 唯一命中', () => {
    const health = checkTemplate('{客户名称}', FIELDS);
    expect(health.matched.map((m) => [m.fieldName, m.fieldId])).toEqual([['客户名称', 'f_name']]);
    expect(health.unmatched).toEqual([]);
  });

  it('子串 / 超串都**不得**命中 —— 正面锚点：同模板里的精确名仍命中', () => {
    // 子串
    const sub = checkTemplate('{客户}', FIELDS);
    expect(sub.matched).toEqual([]);
    expect(sub.unmatched).toEqual(['客户']);
    // 超串
    const sup = checkTemplate('{客户名称全}', FIELDS);
    expect(sup.matched).toEqual([]);
    expect(sup.unmatched).toEqual(['客户名称全']);
    // 正面锚点：把精确名放进去，它必进 matched（证明 unmatched 不是「整体失效」）
    const mixed = checkTemplate('{客户}{客户名称}', FIELDS);
    expect(mixed.unmatched).toEqual(['客户']);
    expect(mixed.matched.map((m) => m.fieldName)).toEqual(['客户名称']);
  });

  it('trim 生效：`{ 客户名称 }` 命中（名字两侧空白被裁掉）', () => {
    const health = checkTemplate('{ 客户名称 }', FIELDS);
    expect(health.matched.map((m) => m.fieldId)).toEqual(['f_name']);
  });
});

/* ===================== 设计3：重名不静默取首个 ===================== */

describe('QA2 · placeholders · 设计3（重名绝不静默取首个）', () => {
  const DUP: FieldMetaLike[] = [
    { id: 'a', name: '标题' },
    { id: 'b', name: '标题' },
    { id: 'c', name: '正文' },
  ];

  it('重名 → ambiguous（含全部 fieldId）+ duplicateFieldNames；matched 里没有它', () => {
    const health = checkTemplate('{标题}{正文}', DUP);
    expect(health.ambiguous).toEqual([{ name: '标题', placeholder: '{标题}', fieldIds: ['a', 'b'] }]);
    expect(health.duplicateFieldNames).toEqual([{ name: '标题', fieldIds: ['a', 'b'] }]);
    expect(health.matched.map((m) => m.fieldName)).toEqual(['正文']);
    // 反向锚点：若静默取首个，'a' 会出现在 matched
    expect(health.matched.some((m) => m.fieldId === 'a' || m.fieldId === 'b')).toBe(false);
    expect(health.unmatched).toEqual([]);
  });

  it('重名 + 一个唯一未用字段：正文用、标题 ambiguous、备注 unused 三者互不串味', () => {
    const fields: FieldMetaLike[] = [...DUP, { id: 'd', name: '备注' }];
    const health = checkTemplate('{标题}{正文}', fields);
    expect(health.ambiguous.map((x) => x.name)).toEqual(['标题']);
    expect(health.matched.map((m) => m.fieldId)).toEqual(['c']);
    expect(health.unusedFields.map((u) => u.fieldId)).toEqual(['d']);
  });
});

/* ===================== C 段：边界与病态输入 ===================== */

describe('QA2 · placeholders · C 段（边界 / 病态字段名）', () => {
  it('特殊字符字段名：空格 / 点 / 下划线 / 原型链名 均可被精确索引与命中', () => {
    const fields: FieldMetaLike[] = [
      { id: 'f_space', name: 'a b' },
      { id: 'f_dot', name: 'a.b' },
      { id: 'f_proto', name: '__proto__' },
      { id: 'f_ctor', name: 'constructor' },
    ];
    const index = buildFieldIndex(fields);
    // Map 索引：原型链上的名字**不得**被误命中
    expect(index.byName.get('toString')).toBeUndefined();
    expect(index.byName.get('hasOwnProperty')).toBeUndefined();
    // 显式声明的原型链名必须能命中（若用普通对象索引，__proto__ 会因 setter 而丢失）
    expect(index.byName.get('__proto__')).toEqual([{ id: 'f_proto', name: '__proto__' }]);
    expect(index.byName.get('constructor')).toEqual([{ id: 'f_ctor', name: 'constructor' }]);

    // 端到端体检：模板里三个奇怪名字都要进 matched
    const health = checkTemplate('{a b}{a.b}{__proto__}{constructor}', fields);
    expect(health.matched.map((m) => m.fieldId)).toEqual(['f_space', 'f_dot', 'f_proto', 'f_ctor']);
    expect(health.unmatched).toEqual([]);
    expect(health.duplicateFieldNames).toEqual([]);
  });

  it('超长字段名（400 字）与空/纯空白字段名：长的可命中，空的被剔除', () => {
    const long = 'x'.repeat(400);
    const fields: FieldMetaLike[] = [
      { id: 'f_long', name: long },
      { id: 'f_blank', name: '   ' }, // trim 后为空 → 剔除
      { id: '', name: '有名字但无 id' }, // id 为空 → 剔除
    ];
    const index = buildFieldIndex(fields);
    expect(index.byName.get(long)).toEqual([{ id: 'f_long', name: long }]);
    expect(index.byName.size).toBe(1);
    expect(index.nameById.has('f_blank')).toBe(false);
    expect(index.nameById.has('')).toBe(false);
    const health = checkTemplate(`{${long}}`, fields);
    expect(health.matched.map((m) => m.fieldId)).toEqual(['f_long']);
  });

  it('一个占位符都没有的模板 → 无 matched/unmatched/ambiguous，全部字段 unused', () => {
    const fields: FieldMetaLike[] = [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ];
    const health = checkTemplate('这里没有任何占位符', fields);
    expect(health.tokens).toEqual([]);
    expect(health.matched).toEqual([]);
    expect(health.unmatched).toEqual([]);
    expect(health.ambiguous).toEqual([]);
    expect(health.unusedFields.map((u) => u.fieldId)).toEqual(['a', 'b']);
  });

  it('未闭合循环：段内简单占位符上提同层（不漏报），名字进 unclosedLoops', () => {
    const parsed = parseTemplate('{#明细}内容{项目}');
    expect(parsed.unclosedLoops).toEqual(['明细']);
    expect(parsed.tokens.map((t) => t.name)).toEqual(['项目']);
  });

  it('`{#a}{/b}` 名字不匹配：a 未闭合、b 无开始（两者都报，不静默）', () => {
    const parsed = parseTemplate('{#a}x{/b}');
    expect(parsed.unclosedLoops).toEqual(['a']);
    expect(parsed.unopenedLoops).toEqual(['b']);
    expect(parsed.tokens).toEqual([]);
  });

  it('`checkTemplate` 对同一输入两次调用深等（确定性）', () => {
    const fields: FieldMetaLike[] = [{ id: 'a', name: '甲' }];
    const text = '{甲}{#明细}{乙}{/明细}';
    // 正面锚点：结果里确实含有内容，避免「恒返回空 → 两次也相等」的假绿
    const first = checkTemplate(text, fields);
    expect(first.matched.map((m) => m.fieldName)).toEqual(['甲']);
    // 循环段名 `明细` 也是占位符名 → 一并进 unmatched；段内 `乙` 同样对不上
    expect(first.unmatched).toEqual(['明细', '乙']);
    expect(checkTemplate(text, fields)).toEqual(first);
  });
});
