/**
 * docx 模板占位符解析层（「模板导入」第一步：**纯逻辑地基**，不碰 UI / 不碰 docx 二进制）。
 *
 * 数据流中的位置：
 *   docx 模板 → （另行抽取「纯文本」）→ 【本模块】extractPlaceholders() / checkTemplate()
 *   → `PlaceholderToken[]` / `TemplateHealth` → 填充层（docxtemplater）与「模板体检」UI
 *
 * ⭐ 三条硬约束（违反即功能性缺陷）：
 *  1. **纯函数、零第三方依赖**：本文件只允许 `import type`，**不得** import React / DOM /
 *     `docxtemplater` / `pizzip`（对照测试另在 `.test.ts` 里做，不进生产包）。同输入恒同输出，
 *     不读时间 / 随机 / 全局可变状态。
 *  2. **与 `docxtemplater` 的标签语义对齐**：默认分隔符 `{` / `}`
 *     （`docxtemplater/js/doc-utils.js` 的 `getDefaults()`）；标签名**做 trim**。
 *     对齐的正确性由 `placeholders.test.ts` 里的 **对照测试**用真实 `docxtemplater` 守卫
 *     （见该文件 `docx/template · 对照测试`）——将来升级库版本时那条会红。
 *  3. **绝不静默**：匹配**不做模糊/近似**；字段**重名必须报告**；模板里写了却对不上的名字
 *     必须进 `unmatched`。理由见 `checkTemplate` 的文档。
 *
 * ── 占位符语法的最终裁定（逐条，均与真实 `docxtemplater` 3.69.2 实测核对过）──
 *  算占位符：
 *   · 简单：`{字段名}`（标签名 trim 后非空）
 *   · 循环段：`{#字段名}…{/字段名}`（记录起止位置与段内占位符）
 *  算普通文本（不产出 token、不吞字符）：
 *   · 无法配对的 `{`（如 `{abc`）——docxtemplater 在
 *     `syntax.allowUnclosedTag = true` 下同样原样保留；
 *   · 无法配对的 `}`（如 `abc}`）——docxtemplater 在
 *     `syntax.allowUnopenedTag = true` 下同样原样保留；
 *   · 空标签 `{}`（详见下方「已知语义分歧」）。
 * 已知语义分歧（**有意为之**，由专项用例锁定）：
 *   · `{}` 被 `docxtemplater` 当作**无名标签**（渲染时被 `nullGetter` 吃掉），本模块裁定为
 *     **普通文本**——一个没有名字的占位符对用户没有任何意义，静默吃掉反而让人误以为模板没写错。
 *   · `docxtemplater` 的**其余前缀**（`^` 反向段、`-` 局部段、`=` 换分隔符）本模块**不支持**：
 *     它们会被当成「名字以该字符开头的简单占位符」，从而在 `checkTemplate` 里落进 `unmatched`
 *     ——这是一个**显式红字提示**，而非静默出错。
 *   · `docxtemplater` 默认 `allowUnclosedTag/allowUnopenedTag = false`（`{abc` 会**抛错**）。
 *     本模块与之不同：一律按普通文本处理。因此**填充层必须显式传**
 *     `syntax: { allowUnclosedTag: true, allowUnopenedTag: true }`，否则导入时体检「通过」的
 *     模板可能在渲染阶段整份报错。该约束由对照测试中的一条专项用例锁定。
 */

/** 字段元数据「最小结构」（`FieldMetaLite` 结构上完全满足本接口，可直接传入） */
export interface FieldMetaLike {
  /** 字段 id（后续填充要用它去调 SDK `getCellString(fieldId, recordId)`） */
  id: string;
  /** 字段中文名（占位符按此名匹配） */
  name: string;
}

/** 简单占位符 `{字段名}` */
export interface SimplePlaceholderToken {
  kind: 'simple';
  /** 字段名（**已 trim**） */
  name: string;
  /** 源码原样切片（保留用户写的空格），如 `{ 客户名称 }` */
  raw: string;
  /** `{` 在源文本中的下标 */
  start: number;
  /** `}` **之后**的下标（exclusive） */
  end: number;
}

/** 循环段 `{#字段名}…{/字段名}` */
export interface LoopPlaceholderToken {
  kind: 'loop';
  /** 循环变量名（**已 trim**） */
  name: string;
  /** 开始标签源码切片，如 `{#明细}` */
  openRaw: string;
  /** 结束标签源码切片，如 `{/明细}` */
  closeRaw: string;
  /** 开始标签 `{` 的下标 */
  openStart: number;
  /** 开始标签 `}` 之后的下标 */
  openEnd: number;
  /** 结束标签 `{` 的下标 */
  closeStart: number;
  /** 结束标签 `}` 之后的下标 */
  closeEnd: number;
  /** 段体原文（开始标签结束 与 结束标签开始 之间，逐字保留） */
  body: string;
  /**
   * 段体内部的占位符（保序）。
   *
   * ⚠️ **下标与顶层同坐标系**：`start` / `end` 等一律相对**整段模板文本**（不是相对 `body`），
   * 这样上下游只需一套坐标即可高亮 / 拼接；想取段体区间用 `[openEnd, closeStart)`。
   *
   * ⚠️ 类型是 `PlaceholderToken[]` 而非 `SimplePlaceholderToken[]`：需求只要求「内部可嵌套
   * **简单**占位符」，但允许嵌套循环能让本类型**无需改接口**地覆盖更复杂的真实模板，
   * 简单占位符只是它的子集。
   */
  inner: PlaceholderToken[];
}

/** 占位符标签 */
export type PlaceholderToken = SimplePlaceholderToken | LoopPlaceholderToken;

/** `parseTemplate` 的完整产物（`extractPlaceholders` 只取其中的 `tokens`） */
export interface TemplateParseResult {
  /** 顶层占位符（保序，按 `start` / `openStart` 升序） */
  tokens: PlaceholderToken[];
  /** 只有 `{#名}` 没有 `{/名}`（保序、去重） */
  unclosedLoops: string[];
  /** 只有 `{/名}`、或 `{/名}` 与当前未闭合名不匹配（保序、去重） */
  unopenedLoops: string[];
}

/** 字段名重名的一组 */
export interface DuplicateFieldName {
  /** 重名的名字（trim 后） */
  name: string;
  /** 拥有该名字的全部 fieldId（源码顺序） */
  fieldIds: string[];
}

/** 字段索引（供占位符 ↔ 字段匹配） */
export interface FieldIndex {
  /**
   * 字段名（trim 后）→ 命中字段列表。
   *
   * 用 `Map` 而非普通对象：字段名是**用户可控字符串**，普通对象索引在字段名取
   * `__proto__` / `constructor` 时会发生原型链污染式误命中。`Map` 无此问题。
   * 值长度为 1 = 唯一命中；长度 > 1 = 重名冲突（**必须**由调用方报告，不得静默取首个）。
   */
  byName: ReadonlyMap<string, ReadonlyArray<FieldMetaLike>>;
  /** fieldId → 字段名（trim 后）反查（后续填充要用它把占位符换成 fieldId） */
  nameById: ReadonlyMap<string, string>;
  /** 源字段里的重名清单（**与模板内容无关**，只要字段列表里有重名就报告） */
  duplicates: ReadonlyArray<DuplicateFieldName>;
}

/** 命中字段的占位符 */
export interface MatchedPlaceholder {
  fieldId: string;
  fieldName: string;
  /** 该占位符的源码原文（简单 = `{名}`；循环 = `{#名}`），取**首次出现**那处 */
  placeholder: string;
}

/** 重名冲突导致**无法确定**用哪个字段的占位符 */
export interface AmbiguousPlaceholder {
  name: string;
  /** 源码原文（取首次出现那处） */
  placeholder: string;
  /** 该名字对应的全部 fieldId（≥ 2） */
  fieldIds: string[];
}

/** 字段列表里有、但模板没用的字段 */
export interface UnusedField {
  fieldId: string;
  fieldName: string;
}

/** 模板体检结果 */
export interface TemplateHealth {
  /** 抽出的顶层占位符（透传，UI 高亮用） */
  tokens: PlaceholderToken[];
  /** 占位符名 → 唯一命中的字段（保序、按名去重；`placeholder` 取首次出现处的原文） */
  matched: MatchedPlaceholder[];
  /** 模板里写了、但字段表里**找不到**的名字（保序、按名去重）——导入时须红字提示 */
  unmatched: string[];
  /** 模板里写了、字段表里**有重名**因而无法确定用哪个的名字（保序、按名去重） */
  ambiguous: AmbiguousPlaceholder[];
  /** 源字段里的重名清单（与模板无关） */
  duplicateFieldNames: DuplicateFieldName[];
  /** 未闭合循环的名字（保序、按名去重） */
  unclosedLoops: string[];
  /** 无对应开始的 `{/名}`（保序、按名去重） */
  unopenedLoops: string[];
  /** 字段列表里有、但模板一处都没提到的字段（保序；UI 可选提示） */
  unusedFields: UnusedField[];
}

/* ===================== ① 标签扫描（对齐 docxtemplater 分隔符语义） ===================== */

/** 一对已配对的分隔符位置 */
interface DelimiterPair {
  /** `{` 的下标 */
  start: number;
  /** `}` 的下标 */
  end: number;
}

/**
 * 扫描出**已配对**的 `{…}` 区间。
 *
 * 算法与 `docxtemplater` 的 `getAllDelimiterIndexes` + `getDelimiterErrors` 在
 * `allowUnclosedTag = true && allowUnopenedTag = true` 下的行为**逐例等价**（实测核对）：
 *  · 见到 `{` 时若已有一个未闭合的 `{`，则**前一个 `{` 视为普通文本**（后者胜出）——
 *    这样 `{{a}}` 解析为「字面 `{` + 标签 `{a}` + 字面 `}`」，与库一致；
 *  · 见到 `}` 时若没有未闭合的 `{`，该 `}` 视为普通文本；
 *  · 结尾仍未闭合的 `{` 视为普通文本。
 * 以上三种「无法配对」的分支**都不产出区间、不吞字符**，源文本原样保留在区间之外。
 */
function scanDelimiterPairs(text: string): DelimiterPair[] {
  const pairs: DelimiterPair[] = [];
  let open = -1;
  let offset = -1;

  // 逐字符推进：每次同时找「下一个 {」与「下一个 }」，谁靠前谁生效
  for (;;) {
    const nextStart = text.indexOf('{', offset + 1);
    const nextEnd = text.indexOf('}', offset + 1);
    if (nextStart === -1 && nextEnd === -1) break;

    const isStart = nextStart !== -1 && (nextEnd === -1 || nextStart < nextEnd);
    if (isStart) {
      // 前一个未闭合的 `{` 就此作废（不 push，即视为普通文本）
      open = nextStart;
      offset = nextStart;
      continue;
    }

    // 是 `}`：没有未闭合的 `{` → 该 `}` 视为普通文本
    if (open === -1) {
      offset = nextEnd;
      continue;
    }
    pairs.push({ start: open, end: nextEnd });
    open = -1;
    offset = nextEnd;
  }

  // `open !== -1`：结尾有未闭合的 `{` → 视为普通文本，直接丢弃（不报错、不吞字符）
  return pairs;
}

/** 未成对的标签（用于 stack 组装） */
type RawTag =
  | { kind: 'simple'; name: string; raw: string; start: number; end: number }
  | { kind: 'loopStart'; name: string; raw: string; start: number; end: number }
  | { kind: 'loopEnd'; name: string; raw: string; start: number; end: number };

/** 把已配对区间切分为「占位符标签」；空标签 / 空名循环段一律退化为普通文本（返回 null） */
function toRawTag(text: string, pair: DelimiterPair): RawTag | null {
  // ⚠️ `pair.end` 是 `}` 的**下标**，而 token 的 `end` 语义是 `}` 之后的**下标**（exclusive）
  const end = pair.end + 1;
  const raw = text.slice(pair.start, end);
  const content = text.slice(pair.start + 1, pair.end).trim();

  // 空标签 `{}`（含纯空白 `{  }`）→ 普通文本
  if (content === '') return null;

  if (content.startsWith('#')) {
    const name = content.slice(1).trim();
    if (name === '') return null; // `{#}` → 普通文本
    return { kind: 'loopStart', name, raw, start: pair.start, end };
  }
  if (content.startsWith('/')) {
    const name = content.slice(1).trim();
    if (name === '') return null; // `{/}` → 普通文本
    return { kind: 'loopEnd', name, raw, start: pair.start, end };
  }

  // ⚠️ `^` / `-` / `=` 等 docxtemplater 前缀一律落到这里 → 当作名字含该字符的简单占位符，
  //    随后在 checkTemplate 里进 unmatched（显式红字，而非静默出错）。详见文件头裁定。
  return { kind: 'simple', name: content, raw, start: pair.start, end };
}

/** 循环段组装中的栈帧 */
interface LoopFrame {
  name: string;
  openRaw: string;
  openStart: number;
  openEnd: number;
  /** 收集本段体内（不含更深嵌套段体）的占位符 */
  inner: PlaceholderToken[];
}

/** 向指定容器追加 token；去重只在 `collectNames` 阶段做，此处保序不去重 */
function pushToken(frame: LoopFrame | null, tokens: PlaceholderToken[], token: PlaceholderToken): void {
  (frame ? frame.inner : tokens).push(token);
}

/**
 * 解析模板纯文本 → 顶层占位符 + 未闭合 / 无开始的循环清单。
 *
 * **未闭合循环的处理**：不产出循环 token，其段内已识别出的占位符**上提为同层 token**
 * （宁可多报，也不漏掉用户真写了的占位符）；名字另记入 `unclosedLoops`。
 */
export function parseTemplate(text: string): TemplateParseResult {
  const source = typeof text === 'string' ? text : '';
  const tokens: PlaceholderToken[] = [];
  const unclosedLoops: string[] = [];
  const unopenedLoops: string[] = [];
  const stack: LoopFrame[] = [];

  const pairList = scanDelimiterPairs(source);
  for (const pair of pairList) {
    const tag = toRawTag(source, pair);
    if (!tag) continue; // 空标签 → 普通文本

    const frame = stack.length > 0 ? stack[stack.length - 1] : null;

    if (tag.kind === 'simple') {
      pushToken(frame, tokens, {
        kind: 'simple',
        name: tag.name,
        raw: tag.raw,
        start: tag.start,
        end: tag.end,
      });
      continue;
    }

    if (tag.kind === 'loopStart') {
      stack.push({
        name: tag.name,
        openRaw: tag.raw,
        openStart: tag.start,
        openEnd: tag.end,
        inner: [],
      });
      continue;
    }

    // loopEnd
    if (stack.length === 0) {
      unopenedLoops.push(tag.name);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top.name !== tag.name) {
      // `{/b}` 与当前未闭合的 `{#a}` 不匹配：本次结束标签无对应开始；`a` 留待结尾判为未闭合
      unopenedLoops.push(tag.name);
      continue;
    }
    stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    pushToken(parent, tokens, {
      kind: 'loop',
      name: top.name,
      openRaw: top.openRaw,
      closeRaw: tag.raw,
      openStart: top.openStart,
      openEnd: top.openEnd,
      closeStart: tag.start,
      closeEnd: tag.end,
      body: source.slice(top.openEnd, tag.start),
      inner: top.inner,
    });
  }

  // 结尾仍留在栈上的 = 未闭合循环：不产出循环 token，但段内已识别的占位符**上提为同层**
  // （宁可多报，也不漏掉用户真写了的占位符）；名字另记入 unclosedLoops。
  for (const frame of stack) {
    unclosedLoops.push(frame.name);
    for (const inner of frame.inner) tokens.push(inner);
  }

  return { tokens, unclosedLoops, unopenedLoops };
}

/**
 * ① 从模板纯文本抽取顶层占位符（保序）。
 *
 * 语义与 `docxtemplater` 默认标签语义一致：分隔符 `{` / `}`，标签名 trim；
 * 无法配对的 `{` / `}`、空标签 `{}` 一律视为普通文本（不报错、不吞字符）。
 * 循环段 `{#名}…{/名}` 归一个 token，段内占位符收在 `inner`。
 */
export function extractPlaceholders(text: string): PlaceholderToken[] {
  return parseTemplate(text).tokens;
}

/** token 在源文本中的起始下标 */
function tokenStart(token: PlaceholderToken): number {
  return token.kind === 'simple' ? token.start : token.openStart;
}

/** token 在源文本中的结束下标（exclusive） */
function tokenEnd(token: PlaceholderToken): number {
  return token.kind === 'simple' ? token.end : token.closeEnd;
}

/**
 * 拆出「占位符之外的普通文本」片段（保序，按 tokens 的区间切分；空片段不返回）。
 *
 * 用途有二：
 *  1. 渲染层可在占位符之间原样回填字面文本；
 *  2. 单测用它锁定「无法配对的分隔符**不吞字符**」——tokens 为空时结果必须是原文本身。
 *
 * @param text   源文本
 * @param tokens 顶层占位符；缺省 = `extractPlaceholders(text)`
 */
export function splitLiterals(text: string, tokens?: ReadonlyArray<PlaceholderToken>): string[] {
  const source = typeof text === 'string' ? text : '';
  const list = [...(tokens ?? extractPlaceholders(source))].sort((a, b) => tokenStart(a) - tokenStart(b));

  const literals: string[] = [];
  let cursor = 0;
  for (const token of list) {
    const start = tokenStart(token);
    const end = tokenEnd(token);
    if (start > cursor) literals.push(source.slice(cursor, start));
    if (end > cursor) cursor = end;
  }
  if (cursor < source.length) literals.push(source.slice(cursor));
  return literals;
}

/* ===================== ② 字段索引 ===================== */

/**
 * ② 把字段列表建成索引，供占位符匹配用。
 *
 * · **精确匹配**：按 `meta.name`（trim 后）**精确**匹配，**不做**模糊/近似匹配（理由见 `checkTemplate`）。
 * · **重名报告**：同名多字段进 `duplicates`，**绝不静默取第一个**。
 * · **反查**：同时给出 `nameById`，供后续填充用 fieldId 去调 SDK `getCellString`。
 * · 名字 trim 后为空、或 id 为空的字段**不进索引**（`{}` 已被裁定为普通文本，无法引用无名字段）。
 */
export function buildFieldIndex(fields: ReadonlyArray<FieldMetaLike>): FieldIndex {
  const byName = new Map<string, FieldMetaLike[]>();
  const nameById = new Map<string, string>();
  const order: string[] = [];

  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field !== 'object') continue;
    const id = typeof field.id === 'string' ? field.id : '';
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    if (id === '' || name === '') continue;

    if (!nameById.has(id)) nameById.set(id, name);

    const bucket = byName.get(name);
    if (bucket) {
      bucket.push({ id, name });
    } else {
      byName.set(name, [{ id, name }]);
      order.push(name);
    }
  }

  const duplicates: DuplicateFieldName[] = [];
  for (const name of order) {
    const bucket = byName.get(name);
    if (bucket && bucket.length > 1) duplicates.push({ name, fieldIds: bucket.map((item) => item.id) });
  }

  return { byName, nameById, duplicates };
}

/* ===================== ③ 模板体检 ===================== */

/** 递归收集占位符名字（保序、按名去重） */
function collectNames(tokens: ReadonlyArray<PlaceholderToken>, out: string[], seen: Set<string>): void {
  for (const token of tokens) {
    if (!seen.has(token.name)) {
      seen.add(token.name);
      out.push(token.name);
    }
    if (token.kind === 'loop') collectNames(token.inner, out, seen);
  }
}

/** 递归找某个名字**首次出现**处的源码原文（简单 = `{名}`；循环 = `{#名}`） */
function firstRawOf(tokens: ReadonlyArray<PlaceholderToken>, name: string): string {
  for (const token of tokens) {
    if (token.name === name) return token.kind === 'simple' ? token.raw : token.openRaw;
    if (token.kind === 'loop') {
      const nested = firstRawOf(token.inner, name);
      if (nested !== '') return nested;
    }
  }
  return '';
}

/**
 * ③ 模板体检：模板里的占位符 ↔ 字段表，逐条给出结论，供导入时提示。
 *
 * ⭐ **为什么这个体检是必需的**：参考项目**没有**它——未匹配的占位符被
 * `docxtemplater` 的 `nullGetter: () => ''` **静默清空**。后果是打印/预览出来那块是空白，
 * 用户会以为是「这个字段本来就没数据」，**不会怀疑是模板写错了字段名**。
 * 因此本模块在**导入时**就把「对不上的名字」摆出来。
 *
 * ⭐ **为什么不做模糊匹配**：**静默填错字段比留空更糟**——用户看到模板里填了内容，
 * 就不会去核对它是不是填错了。宁可报「未匹配」，让人工确认。
 *
 * 分流规则（保序、按名去重）：
 *  · 名字在字段表里**唯一命中** → `matched`
 *  · 名字在字段表里**没有** → `unmatched`
 *  · 名字在字段表里**命中多个**（重名）→ `ambiguous`（**不**进 `matched`，**不**静默取首个）
 */
export function checkTemplate(text: string, fields: ReadonlyArray<FieldMetaLike>): TemplateHealth {
  const parsed = parseTemplate(text);
  const index = buildFieldIndex(fields);

  const names: string[] = [];
  collectNames(parsed.tokens, names, new Set<string>());

  const matched: MatchedPlaceholder[] = [];
  const unmatched: string[] = [];
  const ambiguous: AmbiguousPlaceholder[] = [];

  for (const name of names) {
    const hits = index.byName.get(name);
    if (!hits || hits.length === 0) {
      unmatched.push(name);
      continue;
    }
    if (hits.length > 1) {
      ambiguous.push({
        name,
        placeholder: firstRawOf(parsed.tokens, name),
        fieldIds: hits.map((hit) => hit.id),
      });
      continue;
    }
    matched.push({
      fieldId: hits[0].id,
      fieldName: hits[0].name,
      placeholder: firstRawOf(parsed.tokens, name),
    });
  }

  const usedNames = new Set<string>(names);
  const unusedFields: UnusedField[] = [];
  const emitted = new Set<string>();
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field !== 'object') continue;
    const id = typeof field.id === 'string' ? field.id : '';
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    if (id === '' || name === '' || usedNames.has(name) || emitted.has(id)) continue;
    emitted.add(id);
    unusedFields.push({ fieldId: id, fieldName: name });
  }

  return {
    tokens: parsed.tokens,
    matched,
    unmatched,
    ambiguous,
    duplicateFieldNames: [...index.duplicates],
    unclosedLoops: dedupe(parsed.unclosedLoops),
    unopenedLoops: dedupe(parsed.unopenedLoops),
    unusedFields,
  };
}

/** 保序去重 */
function dedupe(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
