/**
 * `DocLayoutEditor` 装配测试（M3-T09）。
 *
 * 覆盖：
 *  1. **三栏结构**（左 `cbv-blocklib` 220 / 中 `cbv-editor__doc-center` 弹性 / 右 `cbv-docprops` 320）
 *     且为同一容器（`cbv-editor__body--doc`）的三个直接子元素；左栏 12 类；
 *  2. 右栏三段（区块属性 / 页面设置 / 主题）**各自独立**展开-收起（断言切换后的**可见性**，
 *     即 `data-docprops-body` 的**存在/不存在**，而非「节点一直在只是被隐藏」）；
 *  3. **逐类**属性表单由数据驱动（见 `BlockPropertyForm.test.tsx` 的 12 类断言）；
 *  4. 页面设置 / 主题改动 → 断言**写入草稿的 payload 具体内容**（把 updater 作用到 fixture 上比对）；
 *     ⭐ 2026-09-21 设计变更：页面设置面板已移除「页眉 / 页码 / 页脚」编辑控件（详情改单张连续长页），
 *     故原「页码格式与范围按钮 → payload」用例改为断言这些控件**已不存在**（保留控件仍在）。
 *  5. 未选中区块 → 区块属性段显示**空态**；
 *  6. **撤销**：每次变更前 `snapshot()` → `rollback()` 后草稿回到上一状态；
 *  7. ⭐ **硬性要求 2 的内容宽度不变式**：装配前后 / 右栏折叠状态 / 纸张朝向切换后，
 *     纸页内的有效内容宽度**恒等于** `getContentBox().width`（适配靠横向滚动，不压缩纸页）。
 *
 * ⚠️ 覆盖边界：不伪造 dnd-kit 的真实指针拖拽（jsdom 不可靠）；落点解析的纯逻辑由
 * `blockMath.test.ts`（T08）覆盖。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTemplate, PageSetup } from '@/config/types';
import { createDefaultConfig, defaultDocTemplate } from '@/config/defaults';
import { getContentBox, getPaperSizePx, mmToPx } from '@/constants/paper';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { useDraftStore } from '@/state/DraftStore';
import { DocLayoutEditor } from './DocLayoutEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  { id: 'f4', name: '标签', type: FieldType.MultiSelect, isPrimary: false },
  { id: 'f5', name: '附件', type: FieldType.Attachment, isPrimary: false },
  { id: 'f6', name: '关联', type: FieldType.Link, isPrimary: false },
];

function makeTemplate(patch?: Partial<DocTemplate>): DocTemplate {
  return { ...defaultDocTemplate(FIELDS), templateId: 't09-test', ...patch };
}

/** 页边距全部 50px（与默认 72 不同 → 内容宽度 694，可与纸宽 794 分离断言） */
function wideMarginSetup(template: DocTemplate): PageSetup {
  return { ...template.pageSetup, margin: { top: 50, right: 50, bottom: 50, left: 50 } };
}

/** 受控 Harness：把 updater 作用到本地 state，使交互结果真实反映到 DOM */
function Harness({
  initial,
  onChangeSpy,
  onBeforeChange,
}: {
  initial: DocTemplate;
  onChangeSpy?: (updater: (template: DocTemplate) => DocTemplate) => void;
  onBeforeChange?: () => void;
}): JSX.Element {
  const [template, setTemplate] = useState<DocTemplate>(initial);
  return createElement(DocLayoutEditor, {
    template,
    fields: FIELDS,
    onChange: (updater: (current: DocTemplate) => DocTemplate) => {
      onChangeSpy?.(updater);
      setTemplate((current) => updater(current));
    },
    onBeforeChange,
  });
}

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

/** 受控表单控件赋值（绕过 React 的 value 追踪） */
function setControl(el: Element | null, value: string): void {
  if (!el) throw new Error('setControl: element not found');
  act(() => {
    if (el instanceof HTMLSelectElement) selectSetter?.call(el, value);
    else inputSetter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function toggleSection(container: HTMLElement, key: string): void {
  click(container.querySelector(`[data-docprops-toggle="${key}"]`));
}

function paperEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.cbv-editor__doc-paper');
  if (!el) throw new Error('paper not found');
  return el;
}

/* ============================ ① 三栏结构 ============================ */

describe('DocLayoutEditor · 三栏装配', () => {
  it('三栏为同一容器的三个直接子元素：区块库 / 画布 / 属性面板', () => {
    const { container, unmount } = mount(createElement(Harness, { initial: makeTemplate() }));

    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    const body = container.querySelector<HTMLElement>('.cbv-editor__body--doc');
    expect(body).not.toBeNull();
    expect(body?.children.length).toBe(3);

    const classes = [...(body?.children ?? [])].map((el) => el.className);
    expect(classes.some((c) => c.includes('cbv-blocklib'))).toBe(true);
    expect(classes.some((c) => c.includes('cbv-editor__doc-center'))).toBe(true);
    expect(classes.some((c) => c.includes('cbv-docprops'))).toBe(true);

    // 左栏区块库：5 组 / 12 类
    expect(container.querySelectorAll('.cbv-blocklib__item').length).toBe(12);
    expect(container.querySelectorAll('.cbv-blocklib__group').length).toBe(5);
    // 中栏 A4 画布
    expect(container.querySelector('[data-testid="doc-canvas"]')).not.toBeNull();
    unmount();
  });

  it('底栏自报「已用 N 块 / 插入槽 N+1」', () => {
    const template = makeTemplate();
    const { container, unmount } = mount(createElement(Harness, { initial: template }));
    const status = container.querySelector<HTMLElement>('.cbv-editor__doc-status');
    expect(status?.getAttribute('data-doc-block-count')).toBe(String(template.blocks.length));
    expect(status?.getAttribute('data-doc-slot-count')).toBe(String(template.blocks.length + 1));
    unmount();
  });
});

/* ============================ ② 三段折叠 ============================ */

describe('DocLayoutEditor · 右栏三段各自展开/收起', () => {
  it('默认仅区块属性展开；三段可独立切换（断言可见性而非存在）', () => {
    const { container, unmount } = mount(createElement(Harness, { initial: makeTemplate() }));

    // 默认态：仅 block 展开
    expect(container.querySelector('[data-docprops-body="block"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-body="page"]')).toBeNull();
    expect(container.querySelector('[data-docprops-body="theme"]')).toBeNull();

    // 展开 page → body 出现；block 仍在
    toggleSection(container, 'page');
    expect(container.querySelector('[data-docprops-body="page"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-body="block"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-toggle="page"]')?.getAttribute('aria-expanded')).toBe('true');

    // 展开 theme（独立性）→ page 与 theme 同时可见
    toggleSection(container, 'theme');
    expect(container.querySelector('[data-docprops-body="theme"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-body="page"]')).not.toBeNull();

    // 收起 block → block body 消失，page/theme 不受影响
    toggleSection(container, 'block');
    expect(container.querySelector('[data-docprops-body="block"]')).toBeNull();
    expect(container.querySelector('[data-docprops-body="page"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-body="theme"]')).not.toBeNull();
    expect(container.querySelector('[data-docprops-toggle="block"]')?.getAttribute('aria-expanded')).toBe('false');

    // 再展开 page 收起态 → 二次切换回到隐藏
    toggleSection(container, 'page');
    expect(container.querySelector('[data-docprops-body="page"]')).toBeNull();

    // 三段都收起来后，`aria-expanded` 全为 false（正面锚点：容器还在）
    expect(container.querySelectorAll('[data-docprops-section]').length).toBe(3);
    unmount();
  });
});

/* ============================ ③ 空态 / 选中 ============================ */

describe('DocLayoutEditor · 未选中区块 → 空态', () => {
  it('未选中：区块属性段显示显式空态，不渲染表单', () => {
    const { container, unmount } = mount(createElement(Harness, { initial: makeTemplate() }));
    const empty = container.querySelector('[data-docprops-empty="true"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('未选中区块');
    expect(container.querySelector('[data-block-form="true"]')).toBeNull();
    unmount();
  });

  it('点击画布区块 → 渲染该 kind 的属性表单，空态消失', () => {
    const { container, unmount } = mount(createElement(Harness, { initial: makeTemplate() }));

    const flow = container.querySelector('.cbv-editor__doc-flow') as HTMLElement;
    const firstShell = [...flow.children].find((el) => el.hasAttribute('data-block-id')) as HTMLElement;
    click(firstShell);

    expect(container.querySelector('[data-docprops-empty="true"]')).toBeNull();
    const form = container.querySelector('[data-block-form="true"]');
    expect(form).not.toBeNull();
    // 默认模板首块是 heading
    expect(form?.getAttribute('data-block-form-kind')).toBe('heading');
    expect(container.querySelectorAll('[data-selected="true"]').length).toBe(1);
    unmount();
  });

  it('删除选中区块 → 草稿少一块，选中态清空并回到空态', () => {
    const template = makeTemplate();
    const { container, unmount } = mount(createElement(Harness, { initial: template }));

    const flow = container.querySelector('.cbv-editor__doc-flow') as HTMLElement;
    const firstShell = [...flow.children].find((el) => el.hasAttribute('data-block-id')) as HTMLElement;
    click(firstShell);

    const del = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('删除该区块'));
    click(del ?? null);

    expect(container.querySelector<HTMLElement>('[data-testid="doc-canvas"]')?.getAttribute('data-block-count')).toBe(
      String(template.blocks.length - 1),
    );
    expect(container.querySelector('[data-docprops-empty="true"]')).not.toBeNull();
    unmount();
  });
});

/* ============================ ④ 页面设置 payload ============================ */

describe('DocLayoutEditor · 页面设置改动写入草稿的 payload', () => {
  it('切横向：payload 只改 orientation，纸张/页边距不变', () => {
    const fixture = makeTemplate();
    const updates: Array<(t: DocTemplate) => DocTemplate> = [];
    const { container, unmount } = mount(createElement(Harness, { initial: fixture, onChangeSpy: (u) => updates.push(u) }));

    toggleSection(container, 'page');
    click(container.querySelector('[data-setup-orientation="landscape"]'));

    expect(updates.length).toBe(1);
    const next = updates[0](fixture);
    expect(next.pageSetup.orientation).toBe('landscape');
    expect(next.pageSetup.paper).toBe('A4');
    expect(next.pageSetup.margin).toEqual(fixture.pageSetup.margin);
    // 其余字段逐项不被误改
    expect(next.pageSetup.pageNumberFormat).toBe(fixture.pageSetup.pageNumberFormat);
    expect(next.pageSetup.headerFooterScope).toBe(fixture.pageSetup.headerFooterScope);
    expect(next.templateId).toBe(fixture.templateId);
    unmount();
  });

  it('页边距（mm 输入）→ payload 的 px 值 = mmToPx(mm)，其余方向不变', () => {
    const fixture = makeTemplate();
    const updates: Array<(t: DocTemplate) => DocTemplate> = [];
    const { container, unmount } = mount(createElement(Harness, { initial: fixture, onChangeSpy: (u) => updates.push(u) }));

    toggleSection(container, 'page');
    setControl(container.querySelector('[data-setup-margin="top"]'), '30');

    const next = updates[updates.length - 1](fixture);
    expect(next.pageSetup.margin.top).toBeCloseTo(mmToPx(30), 6);
    expect(next.pageSetup.margin.left).toBe(fixture.pageSetup.margin.left);
    expect(next.pageSetup.margin.right).toBe(fixture.pageSetup.margin.right);
    expect(next.pageSetup.margin.bottom).toBe(fixture.pageSetup.margin.bottom);
    unmount();
  });

  it('页眉 / 页码 / 页脚控件已按设计变更移除（面板内不存在这些编辑控件）', () => {
    const fixture = makeTemplate();
    const { container, unmount } = mount(createElement(Harness, { initial: fixture }));

    toggleSection(container, 'page');

    // 正面锚点：页面设置面板与保留控件（纸张 / 朝向 / 页边距）仍在
    expect(container.querySelector('[data-page-setup="true"]')).not.toBeNull();
    expect(container.querySelector('[data-setup-control="paper"]')).not.toBeNull();
    expect(container.querySelector('[data-setup-orientation="landscape"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-setup-margin]').length).toBe(4);

    // 移除项：页码格式 / 页眉页脚范围 / 页眉页脚分组与开关
    expect(container.querySelectorAll('[data-setup-page-number]').length).toBe(0);
    expect(container.querySelectorAll('[data-setup-scope]').length).toBe(0);
    expect(container.querySelectorAll('[data-hf]').length).toBe(0);
    expect(container.querySelectorAll('[data-hf-toggle]').length).toBe(0);
    unmount();
  });

  it('⭐ 正向契约：编辑保留项（纸张/朝向/页边距）不得清空历史 header/footer/页码字段（逐字段具体值）', () => {
    // 历史配置：字段值刻意**区别于默认值**（header/footer.enabled=true、showPageNumber=false、
    // format='page-n'、scope='first'）→ 「重建时顺手改成默认值」与「整块丢失（undefined）」两种退化都会判红。
    const historical: PageSetup = {
      paper: 'A4',
      orientation: 'portrait',
      margin: { top: 31, right: 41, bottom: 51, left: 61 },
      header: { enabled: true, content: '归档编号 {记录标题}', align: 'left', fontSize: 11, color: '#123456', showBorder: true },
      footer: { enabled: true, content: '机密', align: 'right', fontSize: 9, color: '#654321', showBorder: true },
      showPageNumber: false,
      pageNumberFormat: 'page-n',
      headerFooterScope: 'first',
    };
    const fixture = makeTemplate({ pageSetup: historical });
    const updates: Array<(t: DocTemplate) => DocTemplate> = [];
    const { container, unmount } = mount(
      createElement(Harness, { initial: fixture, onChangeSpy: (u) => updates.push(u) }),
    );

    /** 断言某次变更产出的 pageSetup 仍**完整保留**历史字段（逐字段具体值，非 toBeDefined） */
    const expectHistoricalKept = (next: DocTemplate): void => {
      expect(next.pageSetup.header).toEqual(historical.header);
      expect(next.pageSetup.footer).toEqual(historical.footer);
      expect(next.pageSetup.showPageNumber).toBe(false);
      expect(next.pageSetup.pageNumberFormat).toBe('page-n');
      expect(next.pageSetup.headerFooterScope).toBe('first');
    };

    toggleSection(container, 'page');

    // ① 改朝向
    click(container.querySelector('[data-setup-orientation="landscape"]'));
    let last = updates[updates.length - 1](fixture);
    expect(last.pageSetup.orientation).toBe('landscape'); // 正面锚点：变更确实生效
    expectHistoricalKept(last);

    // ② 改页边距
    setControl(container.querySelector('[data-setup-margin="top"]'), '30');
    last = updates[updates.length - 1](fixture);
    expect(last.pageSetup.margin.top).toBeCloseTo(mmToPx(30), 6);
    expectHistoricalKept(last);

    // ③ 改纸张
    setControl(container.querySelector('[data-setup-control="paper"]'), 'A5');
    last = updates[updates.length - 1](fixture);
    expect(last.pageSetup.paper).toBe('A5');
    expectHistoricalKept(last);

    unmount();
  });
});

/* ============================ ⑤ 主题 payload ============================ */

describe('DocLayoutEditor · 主题改动写入草稿的 payload', () => {
  it('字重 / 字号 / 主色 → payload 只改对应字段', () => {
    const fixture = makeTemplate();
    const updates: Array<(t: DocTemplate) => DocTemplate> = [];
    const { container, unmount } = mount(createElement(Harness, { initial: fixture, onChangeSpy: (u) => updates.push(u) }));

    toggleSection(container, 'theme');

    // 依次把每次交互产出的 updater 作用到「上一次的状态」上（模拟真实链路）
    click(container.querySelector('[data-theme-weight="700"]'));
    let next = updates[updates.length - 1](fixture);
    expect(next.theme.headingWeight).toBe(700);
    expect(next.theme.baseFontSize).toBe(fixture.theme.baseFontSize); // 其余字段未被误改

    const beforeFontSize = next;
    setControl(container.querySelector('[data-theme-control="baseFontSize"]'), '18');
    next = updates[updates.length - 1](beforeFontSize);
    expect(next.theme.baseFontSize).toBe(18); // payload 具体值
    expect(next.theme.headingWeight).toBe(beforeFontSize.theme.headingWeight); // 上一步结果被保留

    const beforeColor = next;
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    next = updates[updates.length - 1](beforeColor);
    expect(next.theme.primaryColor).toBe('#00B42A');
    expect(next.theme.lineHeight).toBe(beforeColor.theme.lineHeight);

    // 页面设置未被主题改动污染
    expect(next.pageSetup).toEqual(fixture.pageSetup);
    unmount();
  });
});

/* ============================ ⑥ 撤销 ============================ */

describe('DocLayoutEditor · 变更前快照（撤销）', () => {
  it('每次变更调用一次 onBeforeChange', () => {
    const fixture = makeTemplate();
    const onBeforeChange = vi.fn();
    const { container, unmount } = mount(
      createElement(Harness, { initial: fixture, onBeforeChange }),
    );

    toggleSection(container, 'page');
    click(container.querySelector('[data-setup-orientation="landscape"]'));
    expect(onBeforeChange).toHaveBeenCalledTimes(1);

    toggleSection(container, 'theme');
    click(container.querySelector('[data-theme-weight="700"]'));
    expect(onBeforeChange).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('接入 DraftStore：改动可撤销，rollback 后草稿回到上一状态', () => {
    const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });
    useDraftStore.getState().close();
    useDraftStore.getState().open(config, 'doc');

    function StoreHarness(): JSX.Element | null {
      const template = useDraftStore((state) => state.docDraft);
      if (!template) return null;
      return createElement(DocLayoutEditor, {
        template,
        fields: FIELDS,
        onChange: (updater: (current: DocTemplate) => DocTemplate) => useDraftStore.getState().updateDoc(updater),
        onBeforeChange: () => useDraftStore.getState().snapshot(),
      });
    }

    const original = useDraftStore.getState().docDraft?.theme.primaryColor;
    expect(original).toBe('#3370FF');

    const { container, unmount } = mount(createElement(StoreHarness));
    toggleSection(container, 'theme');
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));

    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');

    let rolledBack = false;
    act(() => {
      rolledBack = useDraftStore.getState().rollback();
    });
    expect(rolledBack).toBe(true);
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe(original);
    unmount();
  });
});

/* ============================ ⑦ ⭐ 内容宽度不变式 ============================ */

describe('DocLayoutEditor · ⭐ 三栏装配不改变 A4 有效内容宽度', () => {
  it('纸页宽固定 = 纸张 px；内容宽 = getContentBox().width（与纸宽分离断言）', () => {
    const fixture = makeTemplate({ pageSetup: wideMarginSetup(makeTemplate()) });
    const { container, unmount } = mount(createElement(Harness, { initial: fixture }));

    const expected = getContentBox(fixture.pageSetup.paper, fixture.pageSetup.orientation, fixture.pageSetup.margin);
    const paper = paperEl(container);

    // 纸宽固定像素（794）；内容宽 = 794 - 100 = 694（两者不等 → 断言有判别力）
    expect(getPaperSizePx('A4', 'portrait').w).toBe(794);
    expect(paper.style.width).toBe('794px');
    expect(expected.width).toBe(694);
    expect(paper.getAttribute('data-content-width')).toBe(String(expected.width));

    // 不得用百分比 / max-width 适配（那会回流纸页 → 改变换行）
    expect(paper.getAttribute('style')).not.toContain('%');
    unmount();
  });

  it('右栏三段任意折叠/展开状态下，内容宽度恒不变', () => {
    const fixture = makeTemplate({ pageSetup: wideMarginSetup(makeTemplate()) });
    const { container, unmount } = mount(createElement(Harness, { initial: fixture }));

    const readWidth = (): string | null => paperEl(container).getAttribute('data-content-width');
    const initialWidth = readWidth();

    toggleSection(container, 'block'); // 收起区块属性
    expect(readWidth()).toBe(initialWidth);
    toggleSection(container, 'page'); // 展开页面设置
    expect(readWidth()).toBe(initialWidth);
    toggleSection(container, 'theme'); // 展开主题
    expect(readWidth()).toBe(initialWidth);
    toggleSection(container, 'page'); // 再收起
    expect(readWidth()).toBe(initialWidth);
    toggleSection(container, 'theme'); // 再收起
    expect(readWidth()).toBe(initialWidth);

    unmount();
  });

  it('切换纸张朝向后，内容宽度随 getContentBox() 变化而**不等于**旧值', () => {
    const fixture = makeTemplate({ pageSetup: wideMarginSetup(makeTemplate()) });
    const { container, unmount } = mount(createElement(Harness, { initial: fixture }));

    const portrait = getContentBox('A4', 'portrait', fixture.pageSetup.margin);
    const landscape = getContentBox('A4', 'landscape', fixture.pageSetup.margin);
    expect(portrait.width).toBe(694);
    expect(landscape.width).toBe(1023);
    expect(paperEl(container).getAttribute('data-content-width')).toBe('694');

    toggleSection(container, 'page');
    click(container.querySelector('[data-setup-orientation="landscape"]'));

    expect(paperEl(container).style.width).toBe('1123px');
    expect(paperEl(container).getAttribute('data-content-width')).toBe('1023');
    expect(paperEl(container).getAttribute('data-content-width')).not.toBe('694');
    unmount();
  });

  it('CSS 契约：中间列 minmax(0, 1fr) + 横向滚动；T09 块**不得**声明纸页/画布宽度', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');

    // 中间列必须可被压缩到 0（否则 grid 被纸宽撑破），右栏用 doc 令牌（320px）
    expect(css).toMatch(
      /\.cbv-editor__body--doc\s*\{[^}]*grid-template-columns:\s*var\(--layout-panel-left\)\s+minmax\(0,\s*1fr\)\s+var\(--layout-panel-right-doc\)/,
    );
    // 适配靠横向滚动（T08 已声明的画布溢出规则）
    expect(css).toMatch(/\.cbv-editor__doc-canvas\s*\{[^}]*overflow:\s*auto/);

    // T09 追加块内不得出现任何「纸页宽度」声明（变异：在此处加 width 会改变换行 → 必须红）
    const marker = css.indexOf('/* ============ M3-T09');
    expect(marker).toBeGreaterThan(-1);
    const t09Block = css.slice(marker);
    expect(t09Block).not.toMatch(/\.cbv-editor__doc-paper/);
    expect(t09Block).not.toMatch(/\.cbv-editor__doc-canvas\s*\{[^}]*width\s*:/);
  });
});

/* ============================ 边界：空模板 ============================ */

describe('DocLayoutEditor · 空模板不崩', () => {
  beforeEach(() => {
    useDraftStore.getState().close();
  });

  it('0 区块 → 1 个插入槽、空态提示、无纸页内容宽度缺失', () => {
    const { container, unmount } = mount(createElement(Harness, { initial: makeTemplate({ blocks: [] }) }));
    expect(container.querySelector<HTMLElement>('[data-testid="doc-canvas"]')?.getAttribute('data-block-count')).toBe('0');
    expect(container.querySelector<HTMLElement>('[data-testid="doc-canvas"]')?.getAttribute('data-slot-count')).toBe('1');
    expect(container.querySelectorAll('[data-docslot-index]').length).toBe(1);
    expect(paperEl(container).getAttribute('data-content-width')).toBe('650');
    unmount();
  });
});
