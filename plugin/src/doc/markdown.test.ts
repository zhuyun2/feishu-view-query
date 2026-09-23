import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';
import type { MarkdownNode } from './markdown';

/**
 * markdown 子集单测（设计文档 §21.3.3）。
 *
 * 断言策略：**锁定具体结构**（节点类型 + 精确文本 + 标记位），
 * 不使用 `toBeTruthy()` / `length > 0` 之类的假绿断言——把实现改坏必须让用例变红。
 */
describe('doc/markdown · 内联语法', () => {
  it('普通文本 → 单个 text 节点', () => {
    expect(parseMarkdown('你好世界')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '你好世界' }]);
  });

  it('**粗体** → text{bold:true}，且 text 恰好为「粗体」', () => {
    expect(parseMarkdown('**粗体**')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '粗体', bold: true },
    ]);
  });

  it('*斜体* → text{italic:true}', () => {
    expect(parseMarkdown('*斜体*')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '斜体', italic: true },
    ]);
  });

  it('***粗斜体*** → text{bold:true, italic:true}', () => {
    expect(parseMarkdown('***粗斜体***')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '粗斜体', bold: true, italic: true },
    ]);
  });

  it('`行内代码` → text{code:true}', () => {
    expect(parseMarkdown('`const a = 1`')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: 'const a = 1', code: true },
    ]);
  });

  it('[文字](url) → link 节点（text 与 href 精确匹配）', () => {
    expect(parseMarkdown('[飞书](https://www.feishu.cn)')).toEqual<MarkdownNode[]>([
      { kind: 'link', text: '飞书', href: 'https://www.feishu.cn' },
    ]);
  });

  it('混合内联：普通 + 粗体 + 斜体 + 代码 顺序与文本精确', () => {
    expect(parseMarkdown('前 **粗** 中 *斜* 后 `码`')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '前 ' },
      { kind: 'text', text: '粗', bold: true },
      { kind: 'text', text: ' 中 ' },
      { kind: 'text', text: '斜', italic: true },
      { kind: 'text', text: ' 后 ' },
      { kind: 'text', text: '码', code: true },
    ]);
  });

  it('转义：\\* 输出字面 *，不被识别为斜体', () => {
    expect(parseMarkdown('\\*不是斜体\\*')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '*不是斜体*' },
    ]);
  });

  it('嵌套强调：**a *b* c** → 外层粗体作用于全部文本，内层叠加斜体', () => {
    expect(parseMarkdown('**a *b* c**')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: 'a ', bold: true },
      { kind: 'text', text: 'b', bold: true, italic: true },
      { kind: 'text', text: ' c', bold: true },
    ]);
  });
});

describe('doc/markdown · 换行与段落', () => {
  it('单换行 → text/break/text', () => {
    expect(parseMarkdown('a\nb')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('空行（段落分隔）→ 两个连续 break', () => {
    expect(parseMarkdown('a\n\nb')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'break' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('CRLF 归一为 LF', () => {
    expect(parseMarkdown('a\r\nb')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'text', text: 'b' },
    ]);
  });
});

describe('doc/markdown · 列表', () => {
  it('- 列表：index 从 1 递增，内容走内联解析', () => {
    expect(parseMarkdown('- 第一\n- 第二')).toEqual<MarkdownNode[]>([
      { kind: 'listItem', index: 1, nodes: [{ kind: 'text', text: '第一' }] },
      { kind: 'listItem', index: 2, nodes: [{ kind: 'text', text: '第二' }] },
    ]);
  });

  it('* 也是列表符号（后跟空白）；项内支持加粗', () => {
    expect(parseMarkdown('* **重点**')).toEqual<MarkdownNode[]>([
      { kind: 'listItem', index: 1, nodes: [{ kind: 'text', text: '重点', bold: true }] },
    ]);
  });

  it('行首 *斜体*（* 后无空白）不被当作列表', () => {
    expect(parseMarkdown('*斜体*')).toEqual<MarkdownNode[]>([
      { kind: 'text', text: '斜体', italic: true },
    ]);
  });

  it('空行分隔的两个列表：序号各自从 1 复位', () => {
    expect(parseMarkdown('- a\n\n- b')).toEqual<MarkdownNode[]>([
      { kind: 'listItem', index: 1, nodes: [{ kind: 'text', text: 'a' }] },
      { kind: 'listItem', index: 1, nodes: [{ kind: 'text', text: 'b' }] },
    ]);
  });
});

describe('doc/markdown · 边界与非法输入（锁定行为，不得 undefined）', () => {
  it('空字符串 → 空数组', () => {
    expect(parseMarkdown('')).toEqual<MarkdownNode[]>([]);
  });

  it('仅换行 "\\n" → 单个 break', () => {
    expect(parseMarkdown('\n')).toEqual<MarkdownNode[]>([{ kind: 'break' }]);
  });

  it('未闭合 **粗 → 定界符按字面量输出（不吞字符）', () => {
    expect(parseMarkdown('**abc')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '**abc' }]);
  });

  it('未闭合 *斜 → 定界符按字面量输出', () => {
    expect(parseMarkdown('*abc')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '*abc' }]);
  });

  it('未闭合 ` 行内代码 → 反引号按字面量输出', () => {
    expect(parseMarkdown('`abc')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '`abc' }]);
  });

  it('未闭合 [文字]( 链接 → 整体按字面量输出', () => {
    expect(parseMarkdown('[abc](def')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '[abc](def' }]);
  });

  it('只有 * → 字面量', () => {
    expect(parseMarkdown('*')).toEqual<MarkdownNode[]>([{ kind: 'text', text: '*' }]);
  });

  it('确定性：同一输入两次解析结果深度相等', () => {
    expect(parseMarkdown('a **b**\n- c')).toEqual(parseMarkdown('a **b**\n- c'));
  });

  it('返回值为数组本身（非同一引用，纯函数无共享可变状态）', () => {
    const first = parseMarkdown('x');
    const second = parseMarkdown('x');
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
