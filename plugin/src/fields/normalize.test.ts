import { describe, expect, it } from 'vitest';
import { FieldType } from './fieldTypes';
import type { FieldMetaLite } from './fieldTypes';
import { normalize } from './normalize';

const textField: FieldMetaLite = { id: 'f_text', name: '备注', type: FieldType.Text, isPrimary: false };
const primaryTextField: FieldMetaLite = { id: 'f_name', name: '客户名称', type: FieldType.Text, isPrimary: true };
const numberField: FieldMetaLite = { id: 'f_num', name: '数量', type: FieldType.Number, isPrimary: false };
const currencyField: FieldMetaLite = {
  id: 'f_cur',
  name: '金额',
  type: FieldType.Currency,
  isPrimary: false,
  property: { symbol: '$' },
};
const selectField: FieldMetaLite = {
  id: 'f_status',
  name: '状态',
  type: FieldType.SingleSelect,
  isPrimary: false,
  property: { options: [{ name: '进行中', color: 1 }] },
};
const multiSelectField: FieldMetaLite = { id: 'f_tags', name: '标签', type: FieldType.MultiSelect, isPrimary: false };
const dateField: FieldMetaLite = { id: 'f_date', name: '日期', type: FieldType.DateTime, isPrimary: false };
const checkboxField: FieldMetaLite = { id: 'f_done', name: '已完成', type: FieldType.Checkbox, isPrimary: false };
const userField: FieldMetaLite = { id: 'f_user', name: '负责人', type: FieldType.User, isPrimary: false };
const attachmentField: FieldMetaLite = { id: 'f_file', name: '附件', type: FieldType.Attachment, isPrimary: false };
const locationField: FieldMetaLite = { id: 'f_loc', name: '位置', type: FieldType.Location, isPrimary: false };

describe('fields/normalize（US-5 AC1：永不外泄原始 ID / JSON）', () => {
  it('文本：直接展示，空值归一为 empty', () => {
    expect(normalize('你好', textField)).toMatchObject({ kind: 'text', display: '你好', isEmpty: false });
    expect(normalize('', textField).isEmpty).toBe(true);
    expect(normalize(null, textField).isEmpty).toBe(true);
    expect(normalize(undefined, primaryTextField).isEmpty).toBe(true);
  });

  it('数字：千分位 + 等宽语义', () => {
    const nv = normalize(1234567.5, numberField);
    expect(nv.kind).toBe('number');
    expect(nv.display).toBe('1,234,567.5');
    expect(nv.number).toBe(1234567.5);
  });

  it('货币：使用字段 symbol，默认 ¥', () => {
    expect(normalize(1000, currencyField).display).toBe('$1,000.00');
    const defaultSymbol: FieldMetaLite = { ...currencyField, property: undefined };
    expect(normalize(1000, defaultSymbol).display).toBe('¥1,000.00');
    expect(normalize(-50, currencyField).display).toBe('-$50.00');
  });

  it('单选：仅输出选项名，不泄漏选项 id', () => {
    const nv = normalize({ id: 'opt_secret_id', text: '进行中' }, selectField);
    expect(nv.kind).toBe('select');
    expect(nv.display).toBe('进行中');
    expect(nv.items?.[0]).toMatchObject({ text: '进行中', colorIndex: 1 });
    expect(JSON.stringify(nv)).not.toContain('opt_secret_id');
  });

  it('多选：展开为列表，未配置色板时不带 colorIndex', () => {
    const nv = normalize(['A', 'B', 'C'], multiSelectField);
    expect(nv.kind).toBe('multiSelect');
    expect(nv.items?.map((item) => item.text)).toEqual(['A', 'B', 'C']);
    expect(nv.display).toBe('A、B、C');
  });

  it('日期：格式化为 YYYY-MM-DD', () => {
    const nv = normalize(1_700_000_000_000, dateField);
    expect(nv.kind).toBe('dateTime');
    expect(nv.display).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nv.timestamp).toBe(1_700_000_000_000);
  });

  it('复选框：布尔归一', () => {
    expect(normalize(true, checkboxField)).toMatchObject({ kind: 'checkbox', boolean: true, display: '是' });
    expect(normalize(false, checkboxField)).toMatchObject({ kind: 'checkbox', boolean: false, display: '否' });
  });

  it('成员：输出姓名，绝不泄漏用户 id', () => {
    const nv = normalize({ id: 'ou_secret_user_id', name: '张三', avatarUrl: 'https://x/a.png' }, userField);
    expect(nv.kind).toBe('user');
    expect(nv.display).toBe('张三');
    const serialized = JSON.stringify(nv);
    expect(serialized).not.toContain('ou_secret_user_id');
    expect(serialized).toContain('张三');
  });

  it('附件：输出文件名，绝不泄漏 token', () => {
    const nv = normalize([{ name: '报价单.pdf', token: 'boxcn_secret_token' }], attachmentField);
    expect(nv.kind).toBe('attachment');
    expect(nv.display).toBe('报价单.pdf');
    expect(JSON.stringify(nv)).not.toContain('boxcn_secret_token');
  });

  it('不支持类型 → unsupported，且不输出原始 JSON', () => {
    const nv = normalize({ address: '深圳', lat: 22.5 }, locationField);
    expect(nv.kind).toBe('unsupported');
    expect(nv.display).toBe('该字段类型暂不支持');
    expect(JSON.stringify(nv)).not.toContain('22.5');
  });

  it('文本字段收到非标量对象 → 不 JSON 外泄（归一为空）', () => {
    const nv = normalize({ deeply: { nested: { secret: 1 } } }, textField);
    expect(nv.isEmpty).toBe(true);
    expect(JSON.stringify(nv)).not.toContain('secret');
  });

  it('公式：解包 { value } 且不泄漏结构', () => {
    const formulaField: FieldMetaLite = { id: 'f_fx', name: '公式', type: FieldType.Formula, isPrimary: false };
    expect(normalize({ type: 'number', value: 42 }, formulaField)).toMatchObject({
      kind: 'number',
      number: 42,
    });
    expect(normalize({ type: 'text', value: '汇总' }, formulaField).display).toBe('汇总');
  });
});

/* ===================== 批次 A：真机分段数组（IOpenSegment[]）与自动编号包装 ===================== */

describe('fields/normalize · 批次A：文本分段数组（真机 IOpenSegment[]）解包', () => {
  const segmentTextField: FieldMetaLite = { id: 'f_seg', name: '长度字段测试', type: FieldType.Text, isPrimary: false };
  const urlField: FieldMetaLite = { id: 'f_url', name: '链接', type: FieldType.Url, isPrimary: false };
  const autoNumberField: FieldMetaLite = {
    id: 'f_autonum',
    name: '自动编号',
    type: FieldType.AutoNumber,
    isPrimary: false,
  };

  it('多段文本数组 → 拼接各段 text（真机多行文本实际形态）', () => {
    const raw = [
      { type: 'text', text: '第一段\n' },
      { type: 'text', text: '第二段' },
    ];
    expect(normalize(raw, segmentTextField)).toMatchObject({
      kind: 'text',
      text: '第一段\n第二段',
      display: '第一段\n第二段',
      isEmpty: false,
    });
  });

  it('混合 text / url / mention 段 → 只拼有 text 的段，不泄漏 token / id', () => {
    const raw = [
      { type: 'text', text: '请联系 ' },
      { type: 'mention', mentionType: 'User', text: '@张三', token: 'ou_SECRET_USER', id: 'ou_SECRET_USER' },
      { type: 'url', text: 'example.com', link: 'https://example.com/x' },
    ];
    const nv = normalize(raw, segmentTextField);
    expect(nv.kind).toBe('text');
    expect(nv.display).toBe('请联系 @张三example.com');
    expect(JSON.stringify(nv)).not.toContain('ou_SECRET_USER');
    expect(JSON.stringify(nv)).not.toContain('https://');
  });

  it('全部段都无 text → empty（确认为段数组但不编造内容）', () => {
    expect(normalize([{ type: 'text', text: '' }], segmentTextField).isEmpty).toBe(true);
  });

  it('非段数组（多选形态 [{id,text}]，无 type 字段）→ 不误判，折叠为空', () => {
    const multiSelectLike = [
      { id: 'opt_1', text: '标签A' },
      { id: 'opt_2', text: '标签B' },
    ];
    const nv = normalize(multiSelectLike, segmentTextField);
    expect(nv.isEmpty).toBe(true);
    expect(JSON.stringify(nv)).not.toContain('标签A');
  });

  it('段数组混入非段结构 → 整体不按段数组处理（折叠为空，不外泄）', () => {
    const mixed = [{ type: 'text', text: '正常段' }, { id: 'opt_1', text: '选项' }];
    const nv = normalize(mixed, segmentTextField);
    expect(nv.isEmpty).toBe(true);
    expect(JSON.stringify(nv)).not.toContain('正常段');
  });

  it('链接：段数组 IOpenUrlSegment[] → 解包为 url（多值用「、」连接）', () => {
    const raw = [
      { type: 'url', text: 'example.com', link: 'https://example.com/x' },
      { type: 'url', text: '飞书官网', link: 'https://feishu.cn' },
    ];
    expect(normalize(raw, urlField)).toMatchObject({
      kind: 'url',
      display: 'example.com、飞书官网',
      isEmpty: false,
    });
  });

  it('链接：非段结构的数组 → 维持历史口径（empty，不外泄）', () => {
    expect(normalize([{ foo: 'bar' }], urlField).isEmpty).toBe(true);
  });

  it('自动编号：{value,status} 包装（真机 IOpenAutoNumber）→ 文本语义，保留前导零', () => {
    const nv = normalize({ value: '0008', status: 'Completed' }, autoNumberField);
    expect(nv.kind).toBe('text');
    expect(nv.display).toBe('0008');
    expect(nv.number).toBe(8); // 纯数字串补充数值语义（筛选用）
    expect(nv.isEmpty).toBe(false);
  });

  it('自动编号：带字母前缀的编号 → 文本语义，无 number 字段', () => {
    const nv = normalize({ value: 'F-2024-0001', status: 'Completed' }, autoNumberField);
    expect(nv).toMatchObject({ kind: 'text', display: 'F-2024-0001', isEmpty: false });
    expect(nv.number).toBeUndefined();
  });

  it('自动编号：裸数字（编辑器样例卡历史形态）→ 数字语义不变', () => {
    expect(normalize(1280, autoNumberField)).toMatchObject({ kind: 'number', number: 1280, isEmpty: false });
  });

  it('自动编号：value 为空串 / null → empty', () => {
    expect(normalize({ value: '', status: 'Completed' }, autoNumberField).isEmpty).toBe(true);
    expect(normalize({ value: null, status: 'Calculating' }, autoNumberField).isEmpty).toBe(true);
  });
});
