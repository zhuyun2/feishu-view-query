/**
 * 编辑器「预览样例卡」的合成记录（T11）。
 *
 * 真实记录由用户数据提供，但配置态下不一定有记录；为了让编辑器**始终有卡可看**，
 * 这里按字段类型合成一条**样例记录**（值均为示例，不含任何真实数据 / ID）。
 */
import type { IRecord } from '@lark-base-open/js-sdk';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';

/** 合成样例 id（仅用于 React key / 内部定位，**不渲染**） */
export const SAMPLE_RECORD_ID = '__cbv_sample__';

function sampleValueFor(field: FieldMetaLite): unknown {
  switch (field.type as FieldType) {
    case FieldType.Text:
      return '示例文本内容';
    case FieldType.Number:
    case FieldType.AutoNumber:
      return 1280;
    case FieldType.Currency:
      return 1280;
    case FieldType.SingleSelect: {
      const options = (field.property as { options?: Array<{ name?: unknown }> } | undefined)?.options;
      const first = Array.isArray(options) ? options.find((option) => typeof option?.name === 'string') : undefined;
      return typeof first?.name === 'string' ? first.name : '进行中';
    }
    case FieldType.MultiSelect:
      return ['标签 A', '标签 B'];
    case FieldType.DateTime:
    case FieldType.CreatedTime:
    case FieldType.ModifiedTime:
      return Date.now();
    case FieldType.Checkbox:
      return true;
    case FieldType.User:
    case FieldType.CreatedUser:
    case FieldType.ModifiedUser:
      return [{ name: '张伟', avatarUrl: '' }];
    case FieldType.Attachment:
      return [{ name: '示例图.png', tmpUrl: '' }];
    case FieldType.Url:
      return { text: 'example.com', link: 'https://example.com' };
    case FieldType.Phone:
      return '13800138000';
    case FieldType.Rating:
      return 4;
    case FieldType.Progress:
      return 62;
    case FieldType.Formula:
      return { value: 1280 };
    case FieldType.Lookup:
    case FieldType.Link:
    case FieldType.DuplexLink:
      return [{ text: '关联项 A' }, { text: '关联项 B' }];
    default:
      return '示例';
  }
}

/** 依据字段列表合成一条样例记录 */
export function buildSampleRecord(fields: readonly FieldMetaLite[]): IRecord {
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field.id] = sampleValueFor(field);
  return { recordId: SAMPLE_RECORD_ID, fields: values } as unknown as IRecord;
}
