/**
 * `richText` 区块的 markdown 子集解析（设计文档 §21.3.3 `parseMarkdown` / §5.2「静态说明」）。
 *
 * 目标：把**受控小集**解析为安全的结构化节点数组（**绝不产出 HTML 字符串**，从根上杜绝 XSS）。
 *
 * 支持语法（子集）：
 *   - `**粗体**`             → `{ kind:'text', bold:true }`
 *   - `*斜体*`               → `{ kind:'text', italic:true }`
 *   - `***粗斜体***`         → `{ kind:'text', bold:true, italic:true }`
 *   - `` `行内代码` ``       → `{ kind:'text', code:true }`
 *   - `[文字](url)`          → `{ kind:'link' }`
 *   - 软换行（单 `\n`）/ 空行（段落分隔）→ `{ kind:'break' }`
 *   - `- 项` / `* 项`（`-`/`*` 后必须跟空白）→ `{ kind:'listItem' }`
 *   - 反斜杠转义：`\*` → 字面 `*`
 *
 * 有意**不做**（保持子集极小、行为可控）：标题 `#`、引用 `>`、代码块 ```、图片、表格、嵌套列表。
 *
 * 边界裁定（未闭合标记一律**按字面量**处理，不吞字符、不抛错）：
 *   - 未闭合的 `**粗` / `*斜` / `` `cod `` → 起始定界符作为普通文本输出（如 `**abc` → `text('**abc')`）。
 *   - 未闭合的 `[文字(` → 作为普通文本输出。
 *   - 空字符串 → `[]`；仅换行 `'\n'` → `[break]`。
 *
 * 纯函数：无 DOM / 无 React / 无 SDK 依赖，可 100% 单测。
 */

/** markdown 结构化节点（设计 §21.3.3 类型 + `link` / `code` 扩展，均为安全数据结构） */
export type MarkdownNode =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'break' }
  | { kind: 'listItem'; index: number; nodes: MarkdownNode[] };

/** 列表项识别：可选缩进 + `-`/`*` + **至少一个空白** + 内容（避免误吞 `*斜体*`） */
const LIST_ITEM_RE = /^\s*[-*]\s+(.*)$/;

/**
 * 解析 markdown 子集 → 节点数组。
 * 同一输入恒产出同一结果（确定性、无副作用）。
 */
export function parseMarkdown(src: string): MarkdownNode[] {
  if (typeof src !== 'string' || src.length === 0) return [];

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MarkdownNode[] = [];
  let listIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const listMatch = LIST_ITEM_RE.exec(line);

    if (listMatch) {
      listIndex += 1;
      out.push({ kind: 'listItem', index: listIndex, nodes: parseInline(listMatch[1]) });
      // 列表项自带分隔语义，不额外插入 break
      continue;
    }

    // 非列表行 → 结束当前列表，序号复位
    listIndex = 0;
    out.push(...parseInline(line));

    const isLastLine = i === lines.length - 1;
    const nextIsList = !isLastLine && LIST_ITEM_RE.test(lines[i + 1]);
    // 行间换行 → break；列表项相邻处不加（列表分隔由列表语义承担）
    if (!isLastLine && !nextIsList) out.push({ kind: 'break' });
  }

  return out;
}

/**
 * 解析单行内联语法 → 扁平节点序列（不含 `break` / `listItem`）。
 * 优先级：转义 > 行内代码 > 链接 > 强调 > 普通文本。
 */
function parseInline(src: string): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      out.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // 转义：反斜杠 + 任意字符 → 该字符字面量
    if (ch === '\\' && i + 1 < src.length) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    // 行内代码
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > -1) {
        flush();
        out.push({ kind: 'text', text: src.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    // 链接
    if (ch === '[') {
      const link = tryLink(src, i);
      if (link) {
        flush();
        out.push(link.node);
        i = link.next;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    // 强调（粗体 / 斜体 / 粗斜体）
    if (ch === '*') {
      const emphasis = tryEmphasis(src, i);
      if (emphasis) {
        flush();
        out.push(...emphasis.nodes);
        i = emphasis.next;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/** 尝试解析 `[文字](url)`；不匹配返回 null（调用方按字面量处理） */
function tryLink(src: string, start: number): { node: MarkdownNode; next: number } | null {
  const closeBracket = src.indexOf(']', start + 1);
  if (closeBracket < 0) return null;
  if (src[closeBracket + 1] !== '(') return null;
  const closeParen = src.indexOf(')', closeBracket + 2);
  if (closeParen < 0) return null;

  const text = src.slice(start + 1, closeBracket);
  const href = src.slice(closeBracket + 2, closeParen);
  if (text.length === 0 || href.length === 0) return null;

  return { node: { kind: 'link', text, href }, next: closeParen + 1 };
}

/**
 * 尝试从 `start` 处解析强调（`***` / `**` / `*`）。
 * 定界符长度按连续 `*` 个数（上限 3）自长到短尝试；找不到配对的等长闭合串则返回 null。
 */
function tryEmphasis(src: string, start: number): { nodes: MarkdownNode[]; next: number } | null {
  let run = 0;
  while (run < 3 && src[start + run] === '*') run += 1;

  for (let size = run; size >= 1; size -= 1) {
    const open = '*'.repeat(size);
    const closeAt = src.indexOf(open, start + size);
    // 必须存在闭合串，且闭合串不能紧贴起始定界符（否则内层为空）
    if (closeAt < 0 || closeAt === start + size) continue;

    const inner = src.slice(start + size, closeAt);
    if (inner.length === 0) continue;

    return { nodes: applyStyle(parseInline(inner), size), next: closeAt + size };
  }

  return null;
}

/** 给内联节点套用强调标记（仅作用于文本节点；`size` = 定界符长度） */
function applyStyle(nodes: MarkdownNode[], size: number): MarkdownNode[] {
  const bold = size >= 2;
  const italic = size === 1 || size === 3;

  return nodes.map((node): MarkdownNode => {
    if (node.kind !== 'text') return node;
    const styled: { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean } = {
      kind: 'text',
      text: node.text,
    };
    if (node.code === true) styled.code = true;
    if (bold || node.bold === true) styled.bold = true;
    if (italic || node.italic === true) styled.italic = true;
    return styled;
  });
}
