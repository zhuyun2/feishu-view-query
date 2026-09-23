/**
 * 导入的 docx 模板 → 详情可渲染字节：**数据管线编排** hook（「docx 模板导入」第五步 · 5a）。
 *
 * 数据流（`docSource === 'imported'` 时）：
 * ```
 *   config.detail.importedDocx ──→ validateImportedDocx（体检：base64 / 大小 / 上限）
 *     │ ok
 *     ▼
 *   decodeImportedDocx → 模板字节 ─→ extractDocxText（从 docx 里抽出「纯文本」）
 *     │                                   │
 *     │                                   ▼
 *     │                         buildTemplateData({ templateText, fields, recordId, readCellString })
 *     │                                   │ data
 *     ▼                                   ▼
 *   fillDocxTemplate(模板字节, data) → Blob → Uint8Array（可渲染字节）
 *     ▼
 *   <DocxTemplatePreview bytes={…}/>（保真渲染；页面几何由模板自带，见组件文件头）
 * ```
 *
 * ⭐ 本 hook 负责守住三件「用户看得见但不报错」的静默故障（与 `usePagedDocument` 同一套经验）：
 *  1. **过期响应不得覆盖新记录**：详情会因点击不同卡片而切换记录。**先发起的加载 / 填充若后完成，
 *     绝不能覆盖后发起的结果**。渲染层（`<DocxTemplatePreview/>`）自带守卫，但**本数据管线
 *     （抽取 → 装配 → 填充）也必须有自己的守卫**——否则旧记录的字节会先于新记录落到 props，
 *     渲染层会「忠实地」渲染出**错记录的文档**且不报错。这里沿用 `runSeqRef + cancelled` 双守卫。
 *  2. **失败必须可见**：模板缺失 / 模板非法 / 填充失败，一律产出**明确文案**（`formatError` 归一，
 *     绝不出现 `[object Object]`）。理由（本项目一贯原则）：用户看到一片空白，会以为「这个字段
 *     没数据」，而不会怀疑是模板或环境出了问题。
 *  3. **配置变化必须重跑**：`importedDocx` 变了（用户重新上传）或 `docSource` 切换 → 必须重走一遍。
 *     依赖数组**不得漏项**——漏了会「上传了新模板但详情还是旧的」，**且不报错**。
 *
 * ⭐⭐⭐ 刻意分歧（**不要「顺手统一」**）⭐⭐⭐
 *   导入的 docx **自带页面尺寸与边距（`sectPr`）**。详情渲染 docx 时**不套用**
 *   `getContentBox().width` 的宽度约束（块路径的不变量），也**不得**塞进 `.cbv-paper`。
 *   把两侧统一起来 = **改版用户的 Word 模板**，且不会有任何报错。详见 `renderDocx.ts` /
 *   `DocxTemplatePreview.tsx` 的注释。
 *
 * ⚠️ 分层：本文件位于 `hooks/`（最上层），允许 import `doc/`；对 SDK 的**值**导入一律
 *   **动态 `import()`**（`pizzip` 抽取、`@/sdk/base` 取表句柄），既避免把大依赖 / SDK 拖进
 *   主入口，也让单测在注入 stub 时**完全不会加载 SDK**（jsdom 下加载 SDK 会产生未处理 rejection）。
 */
import { useEffect, useRef, useState } from 'react';
import type { DetailConfig, ImportedDocx } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { buildTemplateData } from '@/doc/template/buildData';
import type { BuildTemplateDataArgs, CellStringReader } from '@/doc/template/buildData';
import { fillDocxTemplate } from '@/doc/template/fill';
import type { DocxTemplateData } from '@/doc/template/fill';
import {
  getTemplateBridgeStore,
  readImportedDocxBytes,
  resolveDocSource,
  validateImportedDocx,
} from '@/doc/template/storage';
import type { BridgeStore } from '@/sdk/base';
import { formatError } from '@/utils/errorText';
import { logError } from '@/utils/log';

/* ===================== 文案常量（失败必须「可见」——见文件头 2） ===================== */

/** 模板缺失（`docSource === 'imported'` 但没有 `importedDocx`） */
export const MISSING_TEMPLATE_MESSAGE =
  '未找到导入的模板：当前文档来源为「导入的 docx」，但配置里没有模板数据。请在「文档排版」中重新上传模板。';

/** 模板非法（`validateImportedDocx` 判非法的统一前缀，后接具体原因） */
export const INVALID_TEMPLATE_PREFIX = '导入的模板无效：';

/** 填充失败（`fillDocxTemplate` 抛错）的统一前缀，后接 `formatError` 的可读信息 */
export const FILL_FAILED_PREFIX = '模板填充失败：';

/** 管线其余步骤失败的统一前缀（抽取 / 装配 / 取字节） */
export const IMPORTED_FAILED_PREFIX = '生成文档失败：';

/** 读取器缺失（缺 tableId 或 SDK 不可用） */
export const NO_READER_MESSAGE = '读取字段值失败：未能获取表格单元格读取器（缺少 tableId 或 SDK 不可用）';

/* ===================== 注入点类型（测试据此获得确定性时序） ===================== */

/** 数据装配函数签名（缺省 = {@link buildTemplateData}） */
export type BuildDataFn = (args: BuildTemplateDataArgs) => Promise<{ data: DocxTemplateData }>;

/** 填充函数签名（缺省 = {@link fillDocxTemplate}） */
export type FillDocxFn = (
  templateBytes: ArrayBuffer | Uint8Array,
  data: DocxTemplateData,
) => Promise<Blob>;

/** docx 纯文本抽取函数签名（缺省 = {@link extractDocxText}） */
export type ExtractDocxTextFn = (bytes: Uint8Array | ArrayBuffer) => Promise<string>;

/** 单元格读取器解析函数签名（缺省 = {@link resolveSdkCellReader}） */
export type ResolveCellReaderFn = (tableId: string | null) => Promise<CellStringReader | null>;

/** 可注入依赖（生产全部缺省；测试注入以获得确定性时序 / 值） */
export interface UseImportedDocDeps {
  /** 单元格显示串读取器；生产缺省由 {@link resolveSdkCellReader} 经 `tableId` 解析 */
  readCellString?: CellStringReader;
  /** 数据装配（缺省 {@link buildTemplateData}） */
  buildData?: BuildDataFn;
  /** 填充（缺省 {@link fillDocxTemplate}） */
  fill?: FillDocxFn;
  /** docx 纯文本抽取（缺省 {@link extractDocxText}） */
  extractText?: ExtractDocxTextFn;
  /** 读取器解析（缺省 {@link resolveSdkCellReader}） */
  resolveCellReader?: ResolveCellReaderFn;
  /**
   * 模板块存储（缺省取 {@link getTemplateBridgeStore} 注册的 bridge 存储）。
   * 分块模板的字节从专用 key `cbv:tpl:*` 拼装；legacy 内联模板不需要它。
   */
  store?: BridgeStore | null;
  /** 错误出口（缺省 `logError`） */
  onError?: (scope: string, err: unknown, ctx?: Record<string, unknown>) => void;
}

/** 入参 */
export interface UseImportedDocArgs {
  /** 详情配置（含 `docSource` / `importedDocx`）；null → 无配置 */
  detail: DetailConfig | null;
  /** 当前记录 id（null → 未选中记录） */
  recordId: string | null;
  /** 当前视图字段元数据（供 {@link buildTemplateData} 按占位符名匹配字段） */
  fields: ReadonlyArray<FieldMetaLite>;
  /** 当前表格 id（生产由 `env.tableId` 传入；用于解析真实单元格读取器） */
  tableId?: string | null;
  /** 当前视图 id（分块模板按 `cbv:tpl:{viewId}:{templateId}:{i}` 拼装；生产由 `env.viewId` 传入） */
  viewId?: string | null;
  /** 是否启用（抽屉打开 + 有记录 + 来源为 imported） */
  enabled: boolean;
  /** 注入依赖（缺省全生产实现；应保持引用稳定） */
  deps?: UseImportedDocDeps;
}

/** 状态机：`idle`（未启用 / 非导入来源）/ `loading` / `ready` / `error` */
export type ImportedDocStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 出参 */
export interface UseImportedDocResult {
  /** 生效的文档来源（`docSource` 缺省 → `'blocks'`） */
  source: 'blocks' | 'imported';
  /** 管线状态 */
  status: ImportedDocStatus;
  /** 可渲染字节（仅 `ready` 非空） */
  bytes: Uint8Array | null;
  /** 失败文案（仅 `error` 非空；已归一为可读信息） */
  error: string | null;
}

/* ===================== ① docx → 纯文本（占位符解析的输入） ===================== */

/**
 * 参与「纯文本抽取」的 docx 部件：正文 + 页眉 / 页脚。
 *
 * ⚠️ **刻意只取这些**：`word/styles.xml` 等部件不含 `<w:t>`，但为避免任何形式的误命中
 * （把样式表里的字面量当成占位符），此处用白名单而非「扫描全部 `word/*.xml`」。
 */
const DOCX_TEXT_PART_PATTERN = /^word\/(?:document|header\d*|footer\d*)\.xml$/;

/** 把数字码点安全转字符（非法码点返回空串，绝不抛） */
function safeFromCodePoint(value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/**
 * 解码 XML 实体。
 * ⚠️ `&amp;` **必须最后**替换：否则 `&amp;lt;` 会被先解成 `&lt;` 再被二次解成 `<`（错）。
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => safeFromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * 从一份 `document.xml` / `header*.xml` / `footer*.xml` 中抽出**纯文本**。
 *
 * 关键点：**按顺序拼接同一段落内的全部 `<w:t>`**。Word 常把 `{客户名称}` 切成
 * `{客户` + `名称}` 分处多个 run —— 逐段拼接后即可还原出完整占位符（与 docxtemplater
 * 的自动 run 合并行为对齐）。`</w:p>` 映射为换行，便于将错跨段的占位符**隔断**。
 */
export function xmlToPlainText(xml: string): string {
  if (typeof xml !== 'string' || xml === '') return '';
  const tokenPattern = /<\/w:p>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let out = '';
  let match: RegExpExecArray | null = tokenPattern.exec(xml);
  while (match !== null) {
    // 段落结束 → 换行；否则是 <w:t> 文本（第 1 组）
    out += match[0] === '</w:p>' ? '\n' : decodeXmlEntities(match[1] ?? '');
    match = tokenPattern.exec(xml);
  }
  return out;
}

/**
 * 抽取导入 docx 的**纯文本**（供占位符解析）。
 *
 * @param bytes 模板字节（`Uint8Array` / `ArrayBuffer`）
 * @returns 各相关部件的纯文本（以换行拼接）；无相关部件 → 空串
 * @throws 当字节不是合法 zip 时由 `PizZip` 抛出（由调用方归一为可读文案）
 */
export async function extractDocxText(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // ⚠️ 动态 import（与 `fill.ts` 同一条理由）：不把 pizzip 拉进主入口。
  const { default: PizZip } = await import('pizzip');
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const zip = new PizZip(view);

  // 只读需要的形状，避免依赖 PizZip 命名空间的类型细节（行为与真实库一致）。
  const files =
    (zip as unknown as { files?: Record<string, { asText?: () => string }> }).files ?? {};

  const chunks: string[] = [];
  for (const name of Object.keys(files)) {
    if (!DOCX_TEXT_PART_PATTERN.test(name)) continue;
    const entry = files[name];
    if (!entry || typeof entry.asText !== 'function') continue;
    let raw = '';
    try {
      raw = entry.asText();
    } catch {
      // 单个部件读取失败不中断整体；其余部件照常抽取
      continue;
    }
    if (raw !== '') chunks.push(xmlToPlainText(raw));
  }
  return chunks.join('\n');
}

/**
 * 把填充产出的 `Blob` 读成**字节**。
 *
 * ⚠️ **不能假设 `Blob.prototype.arrayBuffer` 存在**：真实浏览器有，但 **jsdom（本仓测试环境）的
 * `Blob` 不带 `arrayBuffer`** —— 直接用会抛 `TypeError: blob.arrayBuffer is not a function`，
 * 表现为「文档永远停在加载中」。故与 `fill.test.ts` 同款：优先 `arrayBuffer()`，
 * 否则回退 `FileReader.readAsArrayBuffer`（jsdom 与旧浏览器均可用）。
 */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  const maybe = blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybe.arrayBuffer === 'function') {
    return new Uint8Array(await maybe.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolveBytes, rejectBytes) => {
    if (typeof FileReader === 'undefined') {
      rejectBytes(new Error('当前环境无法读取填充结果（既无 Blob.arrayBuffer，也无 FileReader）'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolveBytes(new Uint8Array(result));
      else rejectBytes(new Error('读取填充结果失败：FileReader 未返回 ArrayBuffer'));
    };
    reader.onerror = () => rejectBytes(reader.error ?? new Error('读取填充结果失败'));
    reader.readAsArrayBuffer(blob);
  });
}

/* ===================== ② 生产缺省：SDK 单元格读取器 ===================== */
/**
 * 由 `tableId` 解析真实单元格读取器（生产缺省）。
 *
 * ⚠️ **动态 import `@/sdk/base`**：`hooks/` 允许调用接入层，但**不静态**引入 —— 单测注入
 * `readCellString` 时本函数根本不会被调用，也就**不会加载 SDK**（jsdom 下加载 SDK 会有未处理 rejection）。
 *
 * @returns 读取器；`tableId` 缺失 / 表句柄不可用 → `null`（由调用方转成明确文案）
 */
export async function resolveSdkCellReader(tableId: string | null): Promise<CellStringReader | null> {
  if (typeof tableId !== 'string' || tableId === '') return null;
  const { getTable } = await import('@/sdk/base');
  const table = await getTable(tableId);
  return (fieldId: string, recordId: string) => table.getCellString(fieldId, recordId);
}

/* ===================== ③ 编排 hook ===================== */

/** 内部状态形状（`bytes` 仅 ready 时非空） */
interface ImportedDocState {
  status: ImportedDocStatus;
  bytes: Uint8Array | null;
  error: string | null;
}

const IDLE_STATE: ImportedDocState = { status: 'idle', bytes: null, error: null };

/** 按**失败步骤**给出前缀（填充失败必须是「模板填充失败」，便于用户判断责任边界） */
function prefixForStep(step: string): string {
  if (step === 'fill') return FILL_FAILED_PREFIX;
  if (step === 'reader') return '读取字段值失败：';
  if (step === 'build') return '装配文档数据失败：';
  return IMPORTED_FAILED_PREFIX;
}

/**
 * 详情侧「导入的 docx」数据管线编排。
 *
 * 行为（详见文件头）：
 *  · `source !== 'imported'` 或未启用 → 复位为 `idle`、**不产出字节**（块路径完全不受影响）；
 *  · 模板缺失 → `error` + {@link MISSING_TEMPLATE_MESSAGE}；
 *  · 模板非法 → `error` + {@link INVALID_TEMPLATE_PREFIX} + 校验原因；
 *  · 正常 → `loading` →（抽取 → 装配 → 填充）→ `ready` + 字节；
 *  · 任一步抛错 → `error` + 可读文案（填充失败用 {@link FILL_FAILED_PREFIX}）；
 *  · **过期响应守卫**：`recordId` / 配置变化即作废上一轮，旧链路**绝不**覆盖新结果。
 */
export function useImportedDoc(args: UseImportedDocArgs): UseImportedDocResult {
  const { detail, recordId, fields, enabled } = args;
  const source = resolveDocSource(detail);
  const importedDocx: ImportedDocx | null = detail?.importedDocx ?? null;
  const tableId = args.tableId ?? null;
  const viewId = args.viewId ?? null;

  const [state, setState] = useState<ImportedDocState>(IDLE_STATE);

  // 最新 deps（ref 持有，避免因 deps 对象身份变化反复重跑）
  const depsRef = useRef(args.deps);
  useEffect(() => {
    depsRef.current = args.deps;
  });

  /** 运行序号：每轮 effect 自增；过期链路据此自我作废（守卫 ① 的一半） */
  const runSeqRef = useRef(0);

  useEffect(() => {
    // ⭐ 过期响应守卫（文件头 1）：作废上一轮（自增序号）
    const seq = runSeqRef.current + 1;
    runSeqRef.current = seq;
    let cancelled = false; // 守卫 ②：本轮被作废（重跑 / 卸载）时置位
    const active = (): boolean => !cancelled && runSeqRef.current === seq;

    const deps = depsRef.current ?? {};

    // 非导入来源 / 未启用 → 复位（块路径的产物与状态完全不受本 hook 影响）
    if (!enabled || source !== 'imported') {
      setState(IDLE_STATE);
      return () => {
        cancelled = true;
      };
    }

    // ① 模板缺失（明确文案，不让用户看到空白）
    if (!importedDocx) {
      setState({ status: 'error', bytes: null, error: MISSING_TEMPLATE_MESSAGE });
      return () => {
        cancelled = true;
      };
    }

    // ② 模板非法（base64 坏 / 大小不匹配 / 超限 —— 原因来自体检层，可区分）
    const validation = validateImportedDocx(importedDocx);
    if (!validation.ok) {
      setState({
        status: 'error',
        bytes: null,
        error: `${INVALID_TEMPLATE_PREFIX}${validation.reason}`,
      });
      return () => {
        cancelled = true;
      };
    }

    // ③ 走完整管线
    setState({ status: 'loading', bytes: null, error: null });

    void (async () => {
      let step = 'read';
      try {
        // ⭐ 统一取字节入口：legacy 内联（读 `bytesBase64`）或**分块**（读专用 key 拼装）。
        //    分块模板缺块 / 哈希不符 / 无 store → `read.ok=false`，此处按「模板无效」显式报错
        //    （绝不静默返回空模板 → 用户会以为「字段本来就没数据」）。
        const store = deps.store ?? getTemplateBridgeStore();
        const read = await readImportedDocxBytes(store, viewId ?? '', importedDocx);
        if (!active()) return; // ⭐ 过期：丢弃
        if (!read.ok) {
          setState({ status: 'error', bytes: null, error: `${INVALID_TEMPLATE_PREFIX}${read.reason}` });
          return;
        }
        const templateBytes = read.bytes;

        step = 'extract';
        const extractText = deps.extractText ?? extractDocxText;
        const templateText = await extractText(templateBytes);
        if (!active()) return; // ⭐ 过期：丢弃

        step = 'reader';
        const resolveCellReader = deps.resolveCellReader ?? resolveSdkCellReader;
        const readCellString = deps.readCellString ?? (await resolveCellReader(tableId));
        if (!readCellString) throw new Error(NO_READER_MESSAGE);
        if (!active()) return; // ⭐ 过期：丢弃

        step = 'build';
        const buildData = deps.buildData ?? buildTemplateData;
        const { data } = await buildData({
          templateText,
          fields,
          recordId: recordId ?? '',
          readCellString,
        });
        if (!active()) return; // ⭐ 过期：丢弃（先发起的后完成 → 绝不覆盖）

        step = 'fill';
        const fill = deps.fill ?? fillDocxTemplate;
        const blob = await fill(templateBytes, data);
        if (!active()) return; // ⭐ 过期：丢弃

        // ⚠️ 用 readBlobBytes（而非 blob.arrayBuffer()）：jsdom 的 Blob 没有 arrayBuffer()。
        const bytes = await readBlobBytes(blob);
        if (!active()) return; // ⭐ 过期：丢弃

        setState({ status: 'ready', bytes, error: null });
      } catch (err) {
        // 过期链路的失败同样丢弃（不得用旧错误覆盖新内容）
        if (!active()) return;
        (deps.onError ?? logError)('doc.imported', err, { step });
        setState({ status: 'error', bytes: null, error: `${prefixForStep(step)}${formatError(err)}` });
      }
    })();

    return () => {
      cancelled = true;
    };
    // ⚠️ 依赖数组**不得漏项**（文件头 3）：漏 `importedDocx` → 重新上传后详情不刷新；
    //    漏 `recordId` → 切换记录不重跑；漏 `source` → 切换来源不重跑；漏 `viewId` → 换视图后
    //    分块 key 仍用旧 viewId（读不到块且不报错）。以上均**不报错**。
  }, [enabled, source, importedDocx, recordId, tableId, viewId, fields]);

  return { source, status: state.status, bytes: state.bytes, error: state.error };
}

export default useImportedDoc;
