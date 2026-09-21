/**
 * 回归测试（工程师）——T07：P1 渲染器（人员 / 附件 / 评分 / 进度 / 链接 / 公式 / 查找引用）。
 *
 * 覆盖要点（对齐 03 §6.5 双态约定 + 04 §3.1 语义色 + R4 冻结）：
 *  - 双态（renderCard / renderDoc）均可用；
 *  - **绝不输出原始 ID / JSON**（用「真实 SDK 形状」构造最危险的四类：人员 / 附件 / 查找引用 / 公式）；
 *  - 人员 20px 头像 + 姓名（R4）；附件 = 缩略 + 张数（R4 不显示封面图）；
 *  - 单字段异常 → FallbackRenderer，不上抛。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultTheme } from '@/config/defaults';
import type { FieldDisplayOptions } from '@/config/types';
import { FieldType } from './fieldTypes';
import type { DocRenderContext, FieldMetaLite, NormalizedValue, RenderContext } from './fieldTypes';
import { normalize } from './normalize';
import { getRenderer, renderCard, renderDoc } from './registry';

const theme = defaultTheme();
/** 04 §11 R4：人员头像恒定 20px（宽 = 高、圆形），不随 density 变化 */
const R4_AVATAR_PX = 20;
/** 评分满分（RatingRenderer 默认满分） */
const RATING_MAX = 5;
const display: FieldDisplayOptions = {
  maxLines: 1,
  truncate: 'ellipsis',
  maxItems: 3,
  hideWhenEmpty: false,
};

function rctx(meta: FieldMetaLite, over: Partial<FieldDisplayOptions> = {}): RenderContext {
  return { fieldMeta: meta, display: { ...display, ...over }, theme, locale: 'zh-CN' };
}

function dctx(meta: FieldMetaLite, over: Partial<FieldDisplayOptions> = {}): DocRenderContext {
  return { ...rctx(meta, over), fragmentIndex: 0, fragmentsTotal: 1, showLabel: true, labelText: meta.name };
}

function html(node: ReactNode): string {
  if (node === null || node === undefined || node === false) return '';
  return renderToStaticMarkup(node as ReactElement);
}

// —— 真实 SDK 形状（关键：成员/附件/关联/查找引用携带不可外泄的原始 id / token） ——
const userMeta: FieldMetaLite = { id: 'f_user', name: '负责人', type: FieldType.User, isPrimary: false };
const attachmentMeta: FieldMetaLite = {
  id: 'f_att',
  name: '附件',
  type: FieldType.Attachment,
  isPrimary: false,
};
const ratingMeta: FieldMetaLite = { id: 'f_rating', name: '评分', type: FieldType.Rating, isPrimary: false };
const progressMeta: FieldMetaLite = { id: 'f_progress', name: '进度', type: FieldType.Progress, isPrimary: false };
const urlMeta: FieldMetaLite = { id: 'f_url', name: '官网', type: FieldType.Url, isPrimary: false };
const phoneMeta: FieldMetaLite = { id: 'f_phone', name: '电话', type: FieldType.Phone, isPrimary: false };
const formulaMeta: FieldMetaLite = { id: 'f_formula', name: '总额', type: FieldType.Formula, isPrimary: false };
const lookupMeta: FieldMetaLite = { id: 'f_lookup', name: '关联客户', type: FieldType.Lookup, isPrimary: false };

const USER_RAW = [{ id: 'ou_secret_123', name: '张伟', enName: 'Zhang Wei', avatarUrl: 'https://cdn.example.com/a.png' }];
const ATTACHMENT_RAW = [
  { file_token: 'ftok_secret_1', name: '主图.png', size: 100, tmpUrl: 'https://cdn.example.com/1.png', type: 'image/png' },
  { file_token: 'ftok_secret_2', name: '侧图.png', size: 200, tmpUrl: 'https://cdn.example.com/2.png', type: 'image/png' },
  { file_token: 'ftok_secret_3', name: '说明.pdf', size: 300, url: 'https://cdn.example.com/3.pdf' },
];
const FORMULA_RAW = { value: 1234 };
const LOOKUP_RAW = [{ text: '客户A' }, { text: '客户B' }, { text: '客户C' }, { text: '客户D' }];

describe('T07 · 人员字段（R4：20px 头像 + 姓名；不外泄成员 ID）', () => {
  it('卡片态：渲染姓名与头像（R4 恒定 20px），且不含成员 id', () => {
    const markup = html(renderCard(normalize(USER_RAW, userMeta), rctx(userMeta)));
    expect(markup).toContain('张伟');
    expect(markup).toContain('https://cdn.example.com/a.png');
    // R4：头像为恒定 20px（宽 = 高），按尺寸断言（而非仅“包含子串”）
    expect(markup).toContain(`width:${R4_AVATAR_PX}px`);
    expect(markup).toContain(`height:${R4_AVATAR_PX}px`);
    expect(markup).not.toContain('ou_secret_123');
  });

  it('文档态：渲染姓名（全部成员），且不含成员 id', () => {
    const markup = html(renderDoc(normalize(USER_RAW, userMeta), dctx(userMeta)));
    expect(markup).toContain('负责人：');
    expect(markup).toContain('张伟');
    expect(markup).not.toContain('ou_secret_123');
  });

  it('无头像 URL → 回落「姓名首字」占位（仅首字，非整名；不报错）', () => {
    const markup = html(renderCard(normalize([{ id: 'x', name: '李雷' }], userMeta), rctx(userMeta)));
    expect(markup).toContain('李雷');
    // 走「首字」占位分支：占位元素仅渲染首字（`>李</span>`），
    // 姓名元素才是整名（`>李雷</span>`）——故 `>李</span>` 只可能匹配占位元素。
    expect(markup).toContain('cbv-avatar--initial');
    expect(markup).toContain('>李</span>');
  });
});

describe('T07 · 附件字段（R4：不显示封面图；缩略 + 张数；不外泄 token）', () => {
  it('卡片态：首图缩略 + 张数，且不含 file_token', () => {
    const markup = html(renderCard(normalize(ATTACHMENT_RAW, attachmentMeta), rctx(attachmentMeta)));
    expect(markup).toContain('共 3 个');
    expect(markup).toContain('https://cdn.example.com/1.png');
    expect(markup).not.toContain('ftok_secret_1');
    expect(markup).not.toContain('ftok_secret_2');
  });

  it('文档态：展示文件名列表，且不含 file_token', () => {
    const markup = html(renderDoc(normalize(ATTACHMENT_RAW, attachmentMeta), dctx(attachmentMeta)));
    expect(markup).toContain('主图.png');
    expect(markup).toContain('说明.pdf');
    expect(markup).not.toContain('ftok_secret_3');
  });
});

describe('T07 · 评分 / 进度字段', () => {
  it('评分：卡片态星级；文档态星级 + 数值', () => {
    expect(html(renderCard(normalize(3, ratingMeta), rctx(ratingMeta)))).toContain('★★★☆☆');
    const doc = html(renderDoc(normalize(3, ratingMeta), dctx(ratingMeta)));
    expect(doc).toContain('★★★☆☆');
    expect(doc).toContain('3 / 5');
  });

  it('评分：超出满分被裁剪（round）', () => {
    const markup = html(renderCard(normalize(9, ratingMeta), rctx(ratingMeta)));
    // 裁剪到满分：恰好 5 颗实心星、0 颗空心（若 9 颗全渲染则本断言失败）
    expect((markup.match(/★/g) ?? []).length).toBe(RATING_MAX);
    expect((markup.match(/☆/g) ?? []).length).toBe(0);
    expect(markup).toContain('★★★★★');
  });

  it('进度：卡片态与文档态均携带百分比', () => {
    expect(html(renderCard(normalize(50, progressMeta), rctx(progressMeta)))).toContain('50%');
    expect(html(renderDoc(normalize(50, progressMeta), dctx(progressMeta)))).toContain('50%');
  });
});

describe('T07 · 链接字段（Url / Phone）', () => {
  it('Url（人可见文本即合法 URL）→ 生成可点 <a>', () => {
    const markup = html(renderCard(normalize('https://example.com/x', urlMeta), rctx(urlMeta)));
    expect(markup).toContain('href="https://example.com/x"');
  });

  it('Phone → 生成 tel: 链接', () => {
    const markup = html(renderCard(normalize('13800138000', phoneMeta), rctx(phoneMeta)));
    expect(markup).toContain('tel:13800138000');
  });
});

describe('T07 · 公式字段（按结果类型分发，不外泄 JSON）', () => {
  it('数值结果 → 千分位数字', () => {
    const markup = html(renderCard(normalize(FORMULA_RAW, formulaMeta), rctx(formulaMeta)));
    expect(markup).toContain('1,234');
    expect(markup).not.toContain('{');
  });

  it('文本结果 → 文本', () => {
    const markup = html(renderCard(normalize({ value: '已完成' }, formulaMeta), rctx(formulaMeta)));
    expect(markup).toContain('已完成');
  });
});

describe('T07 · 查找引用 / 关联字段', () => {
  it('卡片态：前 N 项 + 「+n」', () => {
    const markup = html(renderCard(normalize(LOOKUP_RAW, lookupMeta), rctx(lookupMeta, { maxItems: 3 })));
    expect(markup).toContain('客户A');
    expect(markup).toContain('+1');
    expect(markup).not.toContain('客户D');
  });

  it('文档态：多值全部展开为列表', () => {
    const markup = html(renderDoc(normalize(LOOKUP_RAW, lookupMeta), dctx(lookupMeta)));
    expect(markup).toContain('客户D');
    expect(markup).toContain('关联客户：');
  });
});

describe('T07 · 注册与异常隔离', () => {
  it('P1 类型均已注册（非 fallback）', () => {
    for (const type of [
      FieldType.User,
      FieldType.Attachment,
      FieldType.Rating,
      FieldType.Progress,
      FieldType.Url,
      FieldType.Phone,
      FieldType.Formula,
      FieldType.Lookup,
      FieldType.Link,
      FieldType.DuplexLink,
    ]) {
      expect(getRenderer(type).key).not.toBe('fallback');
    }
  });

  it('P2 类型仍未注册 → FallbackRenderer（不阻断卡片）', () => {
    expect(getRenderer(FieldType.Location).key).toBe('fallback');
    expect(getRenderer(FieldType.Barcode).key).toBe('fallback');
  });

  it('渲染器内部抛错 → 回落 FallbackRenderer（不上抛）', () => {
    const throwing = new Proxy({} as NormalizedValue, {
      get(): never {
        throw new Error('nv access boom');
      },
    });
    expect(html(renderCard(throwing, rctx(userMeta)))).toContain('该字段类型暂不支持');
    expect(html(renderDoc(throwing, dctx(attachmentMeta)))).toContain('该字段类型暂不支持');
  });
});
