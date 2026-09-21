/**
 * QA 独立复核（M1 / T06）：normalize 对恶意 / 畸形输入的健壮性。
 * 铁律复核（US-5 AC1）：text / display 永不包含原始 ID 或 JSON 片段。
 */
import { describe, expect, it } from 'vitest';
import { FieldType } from './fieldTypes';
import type { FieldMetaLite, FieldTypeValue } from './fieldTypes';
import { normalize } from './normalize';

const TOKEN = 'obj_TOKEN_abc123';

function meta(id: string, type: FieldTypeValue, extra: Partial<FieldMetaLite> = {}): FieldMetaLite {
  return { id, name: id, type, isPrimary: false, ...extra };
}

const TEXT = meta('f_text', FieldType.Text);
const NUMBER = meta('f_num', FieldType.Number);
const CURRENCY = meta('f_cur', FieldType.Currency);
const SELECT = meta('f_sel', FieldType.SingleSelect);
const MULTI = meta('f_multi', FieldType.MultiSelect);
const DATE = meta('f_date', FieldType.DateTime);
const CHECKBOX = meta('f_ck', FieldType.Checkbox);
const USER = meta('f_user', FieldType.User);
const ATTACH = meta('f_att', FieldType.Attachment);
const FORMULA = meta('f_fx', FieldType.Formula);
const LOOKUP = meta('f_lookup', FieldType.Lookup);

/** 只暴露「可读文本」字段，用于断言不外泄 */
function visible(nv: ReturnType<typeof normalize>): string {
  return JSON.stringify({ text: nv.text, display: nv.display, items: nv.items ?? [] });
}

describe('QA · fields/normalize 恶意 / 畸形输入（独立打穿）', () => {
  it('null / undefined / 空白串 / 空数组 / 空对象 → 各类型均为 empty', () => {
    const metas = [TEXT, NUMBER, CURRENCY, SELECT, MULTI, DATE, CHECKBOX, USER, ATTACH, FORMULA];
    for (const m of metas) {
      for (const raw of [null, undefined, '', '   ', [], {}] as unknown[]) {
        expect(normalize(raw, m).isEmpty, `${m.id} raw=${JSON.stringify(raw)}`).toBe(true);
      }
    }
  });

  it('嵌套对象 / 对象数组灌入文本字段 → 不外泄任何 JSON 片段', () => {
    const nested = { deeply: { nested: { secret: TOKEN } } };
    const arrOfObj = [{ a: 1 }, { b: TOKEN }];
    for (const raw of [nested, arrOfObj]) {
      const nv = normalize(raw, TEXT);
      expect(nv.isEmpty).toBe(true);
      expect(visible(nv)).not.toContain(TOKEN);
      expect(visible(nv)).not.toContain('deeply');
    }
  });

  it('高危 key（obj_token / file_token / tmp_url / rec 前缀）灌入文本字段 → 不可见', () => {
    const raw = {
      obj_token: TOKEN,
      file_token: 'file_TOKEN_xyz',
      tmp_url: `https://internal/${TOKEN}`,
      recABC123: 'rec_secret',
    };
    const nv = normalize(raw, TEXT);
    expect(nv.isEmpty).toBe(true);
    expect(visible(nv)).not.toContain(TOKEN);
    expect(visible(nv)).not.toContain('file_TOKEN_xyz');
    expect(visible(nv)).not.toContain('rec_secret');
  });

  it('单选收到「无 name/text 的富对象」→ empty（不把整对象当选项名）', () => {
    const nv = normalize({ obj_token: TOKEN, file_token: 'file_TOKEN' }, SELECT);
    expect(nv.isEmpty).toBe(true);
    expect(visible(nv)).not.toContain(TOKEN);
  });

  it('成员 / 附件：只输出人名 / 文件名，绝不泄漏 id / token', () => {
    const user = normalize(
      [{ id: 'ou_SECRET_USER', name: '张三', avatarUrl: `https://a/?t=${TOKEN}` }],
      USER,
    );
    expect(user.display).toBe('张三');
    expect(user.display).not.toContain('http');
    expect(visible(user)).not.toContain('ou_SECRET_USER');

    const att = normalize(
      [{ name: '报价单.pdf', file_token: 'file_SECRET', tmp_url: `https://x/${TOKEN}` }],
      ATTACH,
    );
    expect(att.display).toBe('报价单.pdf');
    expect(visible(att)).not.toContain('file_SECRET');
    expect(visible(att)).not.toContain(TOKEN);
  });

  it('对象内含 {" 的结构化文本 → 不 JSON 外泄', () => {
    const nv = normalize({ payload: '{"secret":123}' }, TEXT);
    expect(nv.isEmpty).toBe(true);
    expect(visible(nv)).not.toContain('secret');
  });

  it('数组含 null / 标量 / 对象 / 数组混合 → 仅保留可读文本，不崩', () => {
    const nv = normalize([null, 42, true, { name: 'OK' }, { obj_token: TOKEN }, []], MULTI);
    expect(nv.items?.map((item) => item.text)).toEqual(['42', 'true', 'OK']);
    expect(visible(nv)).not.toContain(TOKEN);
  });

  it('公式：{value:{obj_token}} 畸形结构 → unsupported，不泄漏', () => {
    const nv = normalize({ value: { obj_token: TOKEN } }, FORMULA);
    expect(nv.kind).toBe('unsupported');
    expect(visible(nv)).not.toContain(TOKEN);
  });

  it('未知字段类型（99999）→ unsupported，即使值很丰富也不外泄', () => {
    const nv = normalize({ a: 1, obj_token: TOKEN }, meta('f_x', 99999));
    expect(nv.kind).toBe('unsupported');
    expect(nv.display).toBe('该字段类型暂不支持');
    expect(visible(nv)).not.toContain(TOKEN);
  });

  it('超长文本（20 万字符）不崩，且不丢内容（截断交给渲染层）', () => {
    const long = 'x'.repeat(200_000);
    const nv = normalize(long, TEXT);
    expect(nv.kind).toBe('text');
    expect(nv.text.length).toBe(200_000);
  });

  it('查找引用超长列表被截断到 200 字符量级（防爆）', () => {
    const list = Array.from({ length: 500 }, (_, i) => ({ name: `N${i}` }));
    const nv = normalize(list, LOOKUP);
    expect(nv.display.length).toBeLessThanOrEqual(201);
  });

  it('[回归] F4：对象灌入数字 / 货币字段 → 折叠为 empty（不再被 Number() 强转为 0）', () => {
    const num = normalize({ obj_token: TOKEN }, NUMBER);
    expect(num.kind).toBe('empty');
    expect(num.isEmpty).toBe(true);
    expect(num.display).toBe('');
    expect(visible(num)).not.toContain(TOKEN);

    const cur = normalize({ obj_token: TOKEN }, CURRENCY);
    expect(cur.kind).toBe('empty');
    expect(cur.isEmpty).toBe(true);
    expect(cur.display).toBe('');
    expect(visible(cur)).not.toContain(TOKEN);
  });

  it('[回归] F4：合法标量输入不被误伤（number / 数字串仍正常归一化）', () => {
    expect(normalize(0, NUMBER)).toMatchObject({ kind: 'number', number: 0, isEmpty: false });
    expect(normalize(42.5, NUMBER)).toMatchObject({ kind: 'number', number: 42.5 });
    expect(normalize('1234.5', NUMBER)).toMatchObject({ kind: 'number', number: 1234.5 }); // 数字串可解析
    expect(normalize(' 88 ', CURRENCY)).toMatchObject({ kind: 'currency', number: 88, symbol: '¥' });
    expect(normalize('not-a-number', NUMBER).kind).toBe('empty'); // 非数字串 → empty
    expect(normalize(NaN, NUMBER).kind).toBe('empty'); // 非有限 → empty
    expect(normalize(Infinity, NUMBER).kind).toBe('empty');
  });

  it('[回归] F4：公式 / 查找引用的合法「包装」不被误伤（{value} 正常解包）', () => {
    // number 标量包装
    expect(normalize({ value: 42 }, FORMULA)).toMatchObject({ kind: 'number', number: 42, isEmpty: false });
    expect(normalize({ value: 3.5 }, FORMULA)).toMatchObject({ kind: 'number', number: 3.5 });
    // 文本包装
    expect(normalize({ value: '文本结果' }, FORMULA)).toMatchObject({ kind: 'text', display: '文本结果' });
    // 布尔包装
    expect(normalize({ value: true }, FORMULA)).toMatchObject({ kind: 'checkbox', boolean: true });
    // 未包装的合法标量
    expect(normalize(42, FORMULA)).toMatchObject({ kind: 'number', number: 42 });
    expect(normalize('纯文本', FORMULA)).toMatchObject({ kind: 'text', display: '纯文本' });
    // {text} / {name} 形状（查找引用常见）
    expect(normalize({ text: '关联项' }, FORMULA)).toMatchObject({ kind: 'text', display: '关联项' });
    expect(normalize([{ name: 'A' }, { name: 'B' }], FORMULA)).toMatchObject({ kind: 'text', display: 'A、B' });
  });
});
