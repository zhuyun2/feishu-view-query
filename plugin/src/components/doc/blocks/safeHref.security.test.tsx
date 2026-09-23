/**
 * richText 链接协议白名单的安全回归锁。
 *
 * ## 被锁的缺陷
 *
 * markdown 链接的协议判定原先在**原始串**上做（`href.trim()`），而浏览器 / URL 规范
 * 是在**归一化后的串**上执行协议。两者看到的输入不是同一个，于是存在绕过：
 *
 * ```
 * [点我](java\tscript:alert(1))
 *   → trim() 只去首尾，剥不掉字符串内部的 `\t`
 *   → HAS_SCHEME_RE（/^[a-z][a-z0-9+.-]*:/i）因 `\t` 不在字符类里而匹配失败
 *   → 被当作"相对路径"原样放行 → 产出 <a href="java\tscript:alert(1)">
 *   → 浏览器剥掉 `\t` 后归一化成 `javascript:` → 执行
 * ```
 *
 * ## 为什么断言分两层
 *
 * 只测 `safeHref()` 的返回值，**测不出"渲染层是否真的没用它"**。
 * 所以这里既有函数级锁，也有**渲染级**锁 —— 渲染级的输入走完整的
 * `parseMarkdown → renderMarkdownNodes` 链路，同时覆盖"解析器是否会先把 `\t` 处理掉"。
 *
 * ⚠️ 渲染级的否定式断言（不得出现 `<a href>`）**必须配正面锚点**（合法链接确实产出 `<a href>`），
 * 否则「渲染器整个坏掉不产出任何 `<a>`」也会让它通过。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdown } from '@/doc/markdown';
import { renderMarkdownNodes, safeHref } from './TextBlocks';

/** 必须拒绝：产出 `null` → 调用方退化为纯文本 */
const MUST_BE_REJECTED = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'JAVA\tSCRIPT:alert(1)',
  'java\tscript:alert(1)', // ← 本次缺陷的核心用例
  'java\nscript:alert(1)',
  'java\rscript:alert(1)',
  ' javascript:alert(1)', // 前导空格
  '\u0000javascript:alert(1)', // 前导 C0 控制符（trim() 管不到）
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
];

/** 必须放行：原样返回，产出可点击链接 */
const MUST_BE_ALLOWED = [
  'https://example.com/a?b=1',
  'http://example.com',
  'mailto:a@b.com',
  '/relative/path',
  './rel',
  '#anchor',
];

function renderMarkdown(src: string): string {
  return renderToStaticMarkup(<>{renderMarkdownNodes(parseMarkdown(src))}</>);
}

describe('safeHref · 协议白名单（XSS 回归锁）', () => {
  for (const raw of MUST_BE_REJECTED) {
    it(`必须拒绝：${JSON.stringify(raw)}`, () => {
      expect(safeHref(raw)).toBeNull();
    });
  }

  for (const raw of MUST_BE_ALLOWED) {
    it(`必须放行：${JSON.stringify(raw)}`, () => {
      expect(safeHref(raw)).toBe(raw);
    });
  }
});

describe('safeHref · 渲染层（走完整 markdown → DOM 链路）', () => {
  it('含 \\t 的 javascript: 链接 → 降级为纯文本，不得产出任何带 href 的 <a>', () => {
    const html = renderMarkdown('[点我](java\tscript:alert(1))');

    // 文本保留（退化，而不是整块消失）
    expect(html).toContain('点我');
    // 关键否定式断言：不得产出可点击链接
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  it('含 \\n 的 javascript: 链接 → 同样降级（换行也是 URL 规范会剥掉的字符）', () => {
    const html = renderMarkdown('[点我](java\nscript:alert(1))');
    expect(html).toContain('点我');
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  it('前导空格的 javascript: 链接 → 同样降级', () => {
    const html = renderMarkdown('[点我]( javascript:alert(1))');
    expect(html).toContain('点我');
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  /**
   * ⭐ 正面锚点（防止上面三条恒真）：
   * 若渲染器整个坏掉、任何情况下都不产出 `<a>`，上面三条会全部通过。
   * 这条证明"合法链接确实产出带 href 的 `<a>`"，上面的否定式断言才有判别力。
   */
  it('正面锚点：合法 https 链接确实产出带 href 的 <a>（否则上面的否定式断言恒真）', () => {
    const html = renderMarkdown('[站点](https://example.com)');
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
  });

  it('正面锚点：相对路径与锚点链接也产出 <a>（白名单不是"一律拒绝"）', () => {
    expect(renderMarkdown('[文档](/docs/a)')).toMatch(/<a[^>]*href="\/docs\/a"/);
    expect(renderMarkdown('[跳转](#section)')).toMatch(/<a[^>]*href="#section"/);
  });
});
