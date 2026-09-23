/**
 * docx 模板填充层（「模板导入」第 2a 步：**模板字节 + 数据 → 填好的 docx 字节**）。
 *
 * 数据流中的位置：
 *   docx 模板字节 ─┐
 *   记录数据      ─┴─→ 【本模块】fillDocxTemplate()
 *                   → `Blob`（可下载 / 可交给 docx-preview 渲染）
 *
 * 上游是占位符解析层 `./placeholders.ts`（`extractPlaceholders` / `checkTemplate`）——
 * 它负责**导入时**的模板体检（红字提示「名字对不上」）；本模块负责**运行期**的尽力填充。
 *
 * ⭐ 三条硬约束（违反即功能性缺陷）：
 *  1. **动态 `import()`**：`pizzip` / `docxtemplater` 体积可观，静态打包会把它们塞进主入口
 *     （实测主入口 +263 KiB），拖累首屏。因此一律走 `await import(...)`，让它们落在按需加载的
 *     异步分包里。**禁止**出现静态 `import X from 'pizzip'|'docxtemplater'` 与 `require(...)`。
 *  2. **必须放开未配对标签**：库默认 `syntax.allowUnclosedTag = false` / `allowUnopenedTag = false`，
 *     遇到 `{abc` / `abc}` 会**整份模板抛错**。而 `placeholders.ts` 的裁定是「无法配对的花括号一律
 *     当普通文本」，即体检会判它「没有问题」。两者必须对齐，否则**一份体检「通过」的模板会在渲染
 *     阶段整份失败**。故本模块显式传 `syntax: { allowUnclosedTag: true, allowUnopenedTag: true }`。
 *  3. **不抛 `[object Object]`**：`docxtemplater` 的错误有自己的类型（`XTTemplateError` 等），
 *     结构化信息藏在 `error.properties.errors[].properties.explanation` 里。若把原始错误
 *     直接往外丢，界面只会显示一句无信息量的兜底文案。故本模块统一转成 `DocxTemplateFillError`，
 *     逐条列出可读的 explanation（本项目有过 `[object Object]` 的教训，见 `utils/errorText`）。
 */
import { formatError } from '@/utils/errorText';

/** docx 的 MIME（`Blob` 的 `type`，与参考项目一致） */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * 模板数据：占位符名 → 值。
 *
 * · 简单占位符 `{客户名称}` → 取 `data['客户名称']`（标量转字符串）；
 * · 循环段 `{#明细}…{/明细}` → `data['明细']` 应为「对象数组」，每项再按段内占位符取名。
 * · 名字**与模板里写的字面量精确对应**（`placeholders.ts` 已对名字做 trim；此处不做二次加工）。
 */
export type DocxTemplateData = Record<string, unknown>;

/**
 * 填充失败时抛出的诊断错误。
 *
 * ⭐ 抛本类而非原始 `docxtemplater` 错误，是为了让「模板哪里有问题」在 UI 上**可读**：
 * `message` 已拼好可读文案，`details` 保留逐条 explanation 便于逐行展示，`cause` 保留
 * 原始错误便于日志与二次排查（**绝不**把原始错误包装成 `[object Object]`）。
 */
export class DocxTemplateFillError extends Error {
  /** 逐条可读的诊断信息（来自 `properties.errors[].properties.explanation` 等） */
  readonly details: readonly string[];
  /** 原始错误（保留现场；类型未知，故为 `unknown`） */
  readonly cause?: unknown;

  constructor(message: string, details: readonly string[], cause?: unknown) {
    super(message);
    this.name = 'DocxTemplateFillError';
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

/* ===================== 入参归一化 ===================== */

/**
 * 把入参统一成 `Uint8Array`。
 *
 * `PizZip` 同时接受 `ArrayBuffer` 与 `Uint8Array`；此处先归一，既统一代码路径，
 * 也顺带规避「`ArrayBuffer` 跨 realm 判定」这类边界问题（`Uint8Array` 视图最稳）。
 */
function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/* ===================== 错误诊断 ===================== */

/** 宽化为普通对象（非对象 / null → null），后续只做安全的属性读取 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 读取 `value.properties`（不存在 → null） */
function readProperties(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return record ? asRecord(record.properties) : null;
}

/** 安全取字符串字段（非字符串 / 缺失 → 空串） */
function readString(record: Record<string, unknown> | null, key: string): string {
  if (!record) return '';
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 把**单条** `docxtemplater` 错误（或子错误）转成一行可读文本。
 *
 * 优先用 `properties.explanation`（库官方给出的「人话」），并附上 `offset`（模板中的偏移）；
 * 两者皆无时回退到 `formatError()`——保证**绝不**产出 `[object Object]`。
 */
function describeOne(value: unknown): string {
  const props = readProperties(value);
  const explanation = readString(props, 'explanation');
  const id = readString(props, 'id');
  const label = explanation !== '' ? explanation : id;

  if (label === '') return formatError(value);

  const offsetValue = props ? props.offset : undefined;
  const offset = typeof offsetValue === 'number' && Number.isFinite(offsetValue) ? offsetValue : null;
  return offset === null ? label : `${label}（位置 ${offset}）`;
}

/**
 * 收集全部可读诊断信息。
 *
 * · 多重错误（`properties.errors` 为数组）→ 逐条 `describeOne`；
 * · 单条错误（无 `properties.errors`，如 `filetype_not_identified`）→ 直接 `describeOne`；
 * · 普通 `Error` / 未知值 → `formatError` 兜底（永不 `[object Object]`）。
 */
function collectDetails(err: unknown): string[] {
  const props = readProperties(err);
  const nested = props ? props.errors : undefined;

  const details: string[] = [];
  if (Array.isArray(nested)) {
    for (const sub of nested) {
      const line = describeOne(sub);
      if (line !== '') details.push(line);
    }
  }
  if (details.length === 0) {
    const single = describeOne(err);
    if (single !== '') details.push(single);
  }
  return details;
}

/**
 * 把任意抛出的值归一为 `DocxTemplateFillError`（含可读 `message` 与逐条 `details`）。
 *
 * 导出以便单测直接锁定「诊断信息形态」，并由 `fillDocxTemplate` 内部复用。
 */
export function toDocxFillError(err: unknown): DocxTemplateFillError {
  // 已经是本类（例如被再次包裹）→ 原样返回，避免套娃
  if (err instanceof DocxTemplateFillError) return err;

  const details = collectDetails(err);
  const summary = details.length > 0 ? details.join('；') : formatError(err);
  return new DocxTemplateFillError(`docx 模板填充失败：${summary}`, details, err);
}

/* ===================== 主入口 ===================== */

/**
 * 用数据填充 docx 模板，返回填充后的 docx `Blob`。
 *
 * @param templateBytes 模板字节（`ArrayBuffer` 或 `Uint8Array`）
 * @param data          占位符名 → 值（循环段传对象数组）
 * @returns             填充后的 docx（`Blob`，MIME 为 {@link DOCX_MIME}）
 * @throws {DocxTemplateFillError} 模板编译 / 渲染失败时抛出**可读**诊断
 *
 * ⭐ 用法要点：
 *  · 依赖走**动态 import**（见文件头约束 1）；
 *  · 放开未配对标签（见文件头约束 2）——与占位符层的裁定对齐；
 *  · `nullGetter` 返回空串（见下方注释）。
 */
export async function fillDocxTemplate(
  templateBytes: ArrayBuffer | Uint8Array,
  data: DocxTemplateData,
): Promise<Blob> {
  // ⚠️ 动态 import：把这两个大依赖移出主入口（静态打包实测 +263 KiB，见文件头约束 1）。
  const [
    { default: PizZip },
    { default: Docxtemplater },
  ] = await Promise.all([import('pizzip'), import('docxtemplater')]);

  try {
    const zip = new PizZip(toBytes(templateBytes));
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      // ⭐ 约束 2：必须放开未配对标签，否则「体检通过」的模板（含 `{abc` / `abc}`）会整份抛错。
      syntax: { allowUnclosedTag: true, allowUnopenedTag: true },
      // ⭐ 约束 3 的姊妹条：未匹配 / 无值的占位符一律填**空串**，**刻意不在运行期抛错**。
      //   理由：「名字对不上」的责任在**导入时的模板体检**（`placeholders.checkTemplate`
      //   会把 unmatched / ambiguous 红字摆给用户）；填充层处于打印 / 导出链路，只做**尽力填充**，
      //   不该因为某个字段没值就打断整份文档。将来若改成「有未匹配就抛错」，必须同步调整体检的责任边界。
      nullGetter: () => '',
    });
    doc.render(data);
    return doc.getZip().generate({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
  } catch (err) {
    // 统一转成可读诊断（含 `properties.errors[].properties.explanation`），绝不透传 `[object Object]`。
    throw toDocxFillError(err);
  }
}
