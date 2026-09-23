/**
 * QA2 独立复核 —— docx 保真渲染层（`./renderDocx`）。
 *
 * 复核的冻结设计：
 *  · 设计5 —— 渲染**拍平**：`{breakPages:false, ignoreHeight:true}` → 单 section（单页长流模型）。
 *             必须给 **1 vs 2 的判别式**（只断言「1」是弱断言：「根本没渲染出 section」也会通过）。
 *  · 设计6 —— 渲染层**不套用**我们的纸张几何（详情页 `getContentBox().width` 不变量在此**不适用**）。
 *
 * ⚠️ 生成测试 docx 一律用 **pizzip**（同步 `generate`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { DEFAULT_RENDER_DOCX_OPTIONS, renderDocxInto } from './renderDocx';

/* ===================== 现场生成最小 docx ===================== */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function buildDocx(bodyInner: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${bodyInner}</w:body></w:document>`,
  );
  return zip.generate({ type: 'uint8array' }) as Uint8Array;
}

function newContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}
function sectionCount(el: HTMLElement): number {
  return el.querySelectorAll('section.docx').length;
}

/* ===================== 设计5：拍平判别式 ===================== */

describe('QA2 · renderDocx · 设计5（拍平判别式：1 vs 2）', () => {
  const body = para('第一页') + PAGE_BREAK + para('第二页');

  it('同一份含分页符的 docx：breakPages:false → 1 section；true → 2 sections（双侧对照）', async () => {
    const bytes = buildDocx(body);

    const flat = newContainer();
    await renderDocxInto(flat, bytes, { breakPages: false, ignoreHeight: true });
    const paged = newContainer();
    await renderDocxInto(paged, bytes, { breakPages: true, ignoreHeight: true });

    expect(sectionCount(flat)).toBe(1);
    expect(sectionCount(paged)).toBe(2);
    // 正面锚点：两侧都确实渲染出了文本（证明「1」不是「什么都没渲染」）
    expect(flat.textContent).toContain('第一页');
    expect(flat.textContent).toContain('第二页');
    expect(paged.textContent).toContain('第一页');
    expect(paged.textContent).toContain('第二页');
  });

  it('默认选项即拍平（不传 options → 1 section），且默认常量精确', async () => {
    const container = newContainer();
    await renderDocxInto(container, buildDocx(body));
    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('第二页');
    expect(DEFAULT_RENDER_DOCX_OPTIONS).toEqual({ breakPages: false, ignoreHeight: true });
  });

  it('重复渲染同一容器不叠加：恰好 1 section（第二次不得累加为 2）', async () => {
    const container = newContainer();
    const bytes = buildDocx(para('只应出现一次'));
    await renderDocxInto(container, bytes);
    expect(sectionCount(container)).toBe(1);
    await renderDocxInto(container, bytes);
    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('只应出现一次');
  });
});

/* ===================== 设计6：不套用我们的纸张几何 ===================== */

describe('QA2 · renderDocx · 设计6（不套用详情页纸张几何）', () => {
  const RAW = readFileSync(resolve(process.cwd(), 'src/doc/template/renderDocx.ts'), 'utf8');
  /** 剔除注释后再做源码级匹配（注释里的同形内容会骗过严格正则） */
  const STRIPPED = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('源码级：渲染层**不引用**我们的纸张几何（无 getContentBox 调用、无 paper 模块依赖）', () => {
    expect(STRIPPED).not.toMatch(/getContentBox/);
    expect(STRIPPED).not.toMatch(/getPaperSizePx/);
    expect(STRIPPED).not.toMatch(/from\s*['"]@\/constants\/paper['"]/);
    // 正面锚点：文件头确实写了「刻意分歧」说明（防被「顺手统一」）
    expect(RAW).toContain('刻意分歧');
  });

  it('运行时：渲染产物里没有我们的纸张几何标识（.cbv-paper / [data-content-box]）', async () => {
    const container = newContainer();
    await renderDocxInto(container, buildDocx(para('几何检查')));

    // 正面锚点：确实渲染出了内容
    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('几何检查');
    // 反面：不得继承我们的纸页 / 内容盒
    expect(container.querySelector('.cbv-paper')).toBeNull();
    expect(container.querySelector('[data-content-box]')).toBeNull();
  });
});
