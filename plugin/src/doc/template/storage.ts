/**
 * docx 模板**存储层**（「docx 模板导入」第四步：把导入的 docx 存进插件配置）。
 *
 * ── 数据流 ──
 * ```
 *   用户选中 .docx（ArrayBuffer）
 *     → prepareImportedDocx()  → { reference, chunks }        // 分块 + 完整性元数据
 *     → saveImportedDocx(store, viewId, …)                    // ① 写新块 ② 读回校验 ③ 成功才删旧块
 *     → detail.importedDocx = reference                       // 引用最后才落进主配置
 *   读取：detail.importedDocx → readImportedDocxBytes()       // legacy 内联 或 分块拼装 + 校验
 *     → docx 字节 → 渲染/填充层
 * ```
 *
 * ⭐⭐⭐ 为什么要把字节**移出主配置**（本层存在的核心理由）⭐⭐⭐
 *   1MB 模板 → base64 约 **1.37MB**。若把这段塞进 `cbv:config:{viewId}`，
 *   **每次配置保存**（改主题 / 纸张 / 筛选都会触发防抖保存）都要搬运这 1.4MB；任一次保存失败
 *   → **用户这次的全部编辑一起丢**。这不是「存不下」，而是「一个大模板让所有配置保存变脆」。
 *   故拆为：主配置只留**引用 + 完整性**（小），字节分块存**专用 key**（大）。
 *
 * ⭐ 三条硬约束：
 *  1. **只读既有配置 key，绝不新造介质**：模板受 D1 只读约束、无自建后端，只能存进 bridge。
 *  2. **原子性**：**先写全部块 → 读回校验 → 最后才把引用写进配置**（{@link saveImportedDocx}）。
 *     「写了一半」的状态**永远不会被引用到**，否则用户会打开一个「存在但残缺」的模板。
 *  3. **绝不静默失败**：缺块 / 哈希不符 / 长度不符 / 超限 一律**显式报错**（文案含实际值与上限）。
 *
 * ⚠️ 分层：本模块 **不得** 静态 import `@lark-opdev/*` / `@/sdk/base` 的**值**（只允许
 *   `import type`）；探针在无注入时才**动态** `import('@/sdk/base')` 取 bridge。
 */
import { STORAGE_PREFIX } from '@/constants';
import type { DetailConfig, ImportedDocx } from '@/config/types';
import type { BridgeStore } from '@/sdk/base';
import { formatError } from '@/utils/errorText';
import { logInfo, logWarn } from '@/utils/log';

/**
 * ⭐ 模板导入失败链路的日志 scope（统一走 `@/utils/log`，真机控制台形如 `[cbv:tpl.store]`）。
 *
 * 背景（真机失明事故）：v1.4.0 之前 `saveImportedDocx` 失败只进 UI 的红字文案，
 * **不打任何日志** —— 用户不截图就无从定位（尤其是「真机 setData resolve 非 true /
 * 单 key 容量」这类本地测试复现不了的差异）。故约定：
 *  · **失败必打 warn**（phase + templateId + chunkIndex/chunkCount + 底层原因；
 *    `setData` 返回值必须原样纳入 —— 它是区分「真机 resolve 非 true」的关键证据）；
 *  · **成功不打**（避免噪音）；探针结果摘要打一条 info（它本就是真机取证工具）。
 */
export const LOG_SCOPE = 'tpl.store';

/**
 * ⭐ 写块失败文案的**人话补充**（仅追加在既有前缀之后，不改前缀——别处按 token 匹配）。
 *
 * 依据真机实测（2026-09-23）：平台单 key 上限 64KB，超限时 bridge 抛 `set block entity error`，
 * 原始报错对用户太生硬；追加一句可行动的提示（压缩模板 / 换小模板）。
 */
export const WRITE_CAPACITY_HINT = '（可能是平台单键存储上限导致，请压缩模板后重试）';

/* ===================== ① 体积上限 ===================== */

/**
 * 导入的 docx 模板原始字节数的上限（**1MB**）。
 *
 * ── 取值依据（与旧版「贴 64KB 主配置额度」不同）──
 *  · 改造后**模板字节不再占用主配置额度**：主配置只留引用（`templateId`/`chunkCount`/
 *    `chunkSize`/`contentHash`/`sizeBytes`，总量 < 1KB）。因此 64KB 主配置上限**不再约束模板**。
 *  · 真正的约束来自 **bridge 单 key 容量**：真机实测单 key 最大可写入 **64KB（65536 字节）**
 *    （见 {@link TEMPLATE_CHUNK_BASE64_CHARS} 的实测证据），分块后每块必须显著小于该值。
 *  · 1MB 是本轮产品目标；分块大小按实测上限回调（见下）。
 */
export const MAX_IMPORTED_DOCX_BYTES = 1_048_576; // 1MB

/**
 * 每块 base64 的**字符数**（非字节数）。
 *
 * 🚨 真机实测证据（2026-09-23，用户在飞书真实环境点「检测存储容量」探针）：
 *  · bridge **单 key 最大可写入 64.0KB（65536 字节）**：32KB / 64KB 档成功，
 *    **128KB 档失败**，平台报错原文 `set block entity error`；
 *  · v1.4.0 曾取 128KB/块（131072 字符）→ 真机**第 0 块即被拒**，模板导入全量失败。
 *
 * 取值依据（32KB = 32768 字符）：
 *  · 64KB 档虽实测成功但**余量为零**（65536 字符 + 序列化开销可能越界），不留赌的余地；
 *  · 取 32KB = 实测上限的一半，留一倍安全余量；
 *  · base64 膨胀 ≈ 4/3，1MB 模板 → base64 ≈ 1.37MB（1398104 字符）→ ⌈1398104/32768⌉ ≈ **43 块**。
 *
 * ⚠️ **不要「优化」回大块**：除非真机探针证明平台上限已提升，否则改回 ≥64KB 必然复现
 * 「写入模板块失败：set block entity error」。
 */
export const TEMPLATE_CHUNK_BASE64_CHARS = 32 * 1024; // 32768（真机单 key 上限 64KB 的一半，见上）

/**
 * **降级内联上限**（仅当运行环境**无 bridge 存储**时生效）。
 *
 * 生产（飞书客户端）恒有 bridge → 一律走分块专用 key，本常量不参与。
 * 仅当 `getTemplateBridgeStore()` 为 `null`（单测 / 极端降级）时，无法写专用 key，
 * 此时**只允许**把小模板退化为内联 `bytesBase64` 写进主配置：
 * base64 ≈ 4/3 → 32KB 原始 ≈ 43KB，仍在 64KB 主配置额度内，**不会让配置保存变脆**。
 * 超过本上限且无 store → **显式报错**（绝不把 1MB 模板静默塞进主配置）。
 */
export const INLINE_FALLBACK_MAX_BYTES = 32 * 1024; // 32768

/* ===================== ①b 模板存储注册表（生产由配置工厂注入 bridge store） ===================== */

/**
 * 运行期注入的 bridge 存储（供分块读写 / 探针使用）。
 *
 * 为什么用注册表而非层层 props 透传：模板的块 key 需要与**配置同一个** bridge 存储实例，
 * 而该实例在 `config/factory` 选型时构造。由工厂在选型后调用 {@link setTemplateBridgeStore}
 * 注入一次即可，UI 组件无需 import SDK（避免把 SDK 拖进组件单测的加载图）。
 *
 * `undefined` = 尚未注入（等同无 store）；测试可显式 `setTemplateBridgeStore(null)` 复位。
 */
let registeredStore: BridgeStore | null = null;

/** 注入 bridge 存储（生产：配置工厂选型后调用；测试：注入假 store） */
export function setTemplateBridgeStore(store: BridgeStore | null): void {
  registeredStore = store;
}

/** 取当前注入的 bridge 存储（无 → `null`，调用方须据此走降级 / 显式失败） */
export function getTemplateBridgeStore(): BridgeStore | null {
  return registeredStore;
}

/** 字节数 → 人类可读（保留 1 位小数；< 1KB 直接给字节） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}B`;
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** 超限文案（**含实际大小与上限的数值**；绝不静默） */
function oversizeReason(sizeBytes: number): string {
  return `模板 ${sizeBytes} 字节（${formatBytes(sizeBytes)}），超出上限 ${MAX_IMPORTED_DOCX_BYTES} 字节（${formatBytes(MAX_IMPORTED_DOCX_BYTES)}）`;
}

/* ===================== ② 存储 key（⭐ 与 cbv:config 严格不相交） ===================== */

/**
 * 模板块 key 前缀。
 * ⚠️ **刻意与配置 key 前缀 `cbv:config` 分开**：块写入**绝不允许**碰真实配置 key
 * `cbv:config:{viewId}`。前缀整体为 `cbv:tpl`。
 */
export const TEMPLATE_KEY_PREFIX = `${STORAGE_PREFIX}:tpl`; // 'cbv:tpl'

/** 模板块 key：`cbv:tpl:{viewId}:{templateId}:{index}` */
export function templateChunkKey(viewId: string, templateId: string, index: number): string {
  return `${TEMPLATE_KEY_PREFIX}:${viewId}:${templateId}:${index}`;
}

/** 某个模板的全部分块 key 前缀（**只属于该 viewId + templateId**，供清理精确圈定） */
export function templateKeyPrefixFor(viewId: string, templateId: string): string {
  return `${TEMPLATE_KEY_PREFIX}:${viewId}:${templateId}:`;
}

/* ===================== ③ 编解码 / 哈希 ===================== */

/** base64 分块大小：避免 `String.fromCharCode(...bigArray)` 触发调用栈溢出 */
const BYTES_PER_FROM_CHAR_CODE = 0x8000;

/** `Uint8Array` → base64（二进制安全，非 UTF-8 文本语义） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BYTES_PER_FROM_CHAR_CODE) {
    const chunk = bytes.subarray(i, i + BYTES_PER_FROM_CHAR_CODE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * base64 → `Uint8Array`。
 * @throws 当入参不是合法 base64 时 `atob` 抛错（由调用方捕获归一）
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 把入参归一为 `Uint8Array`（`ArrayBuffer` / `Uint8Array` 皆可，跨 realm 最稳） */
function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * 内容哈希（FNV-1a 32bit，输出 8 位小写十六进制）—— **直接对字节**计算，
 * 与 base64 分块方式无关，供读回时校验完整性（**用途仅为损坏检测，非安全场景**）。
 */
export function contentHashOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 生成本次上传的模板标识（新上传 → 新 id；不依赖 crypto，受限沙箱可用） */
function createTemplateId(): string {
  return `tpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ===================== ④ legacy 内联编解码（旧配置兼容） ===================== */

/**
 * ① 编码（**legacy 内联形态**）：文件名 + 原始字节 → {@link ImportedDocx}（含 `bytesBase64`）。
 *
 * ⚠️ 这是**遗留/测试用**的内联编码器（把字节放进主配置）。**真实上传路径请用**
 * {@link prepareImportedDocx} + {@link saveImportedDocx}（分块、不占主配置额度）。
 * 保留它：老配置与既有对照测试仍按内联语义工作。
 *
 * @param fileName   原始文件名（仅展示用）
 * @param bytes      docx 字节（`ArrayBuffer` 或 `Uint8Array`）
 * @param uploadedAt 导入时间戳（ms）；缺省 = 当前时间（测试可显式传入以稳定断言）
 */
export function encodeImportedDocx(
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  uploadedAt: number = Date.now(),
): ImportedDocx {
  const view = toBytes(bytes);
  return {
    fileName: typeof fileName === 'string' ? fileName : '',
    bytesBase64: bytesToBase64(view),
    sizeBytes: view.length,
    uploadedAt,
  };
}

/**
 * ② 解码（**legacy 内联形态**）：{@link ImportedDocx} → docx 原始字节。
 *
 * @throws 当该模板为**分块存储**（无 `bytesBase64`）或 `bytesBase64` 非法时抛错。
 *   ⚠️ 分块模板请改用 {@link readImportedDocxBytes}（需 store + viewId）。
 */
export function decodeImportedDocx(imported: ImportedDocx): Uint8Array {
  if (typeof imported.bytesBase64 !== 'string') {
    throw new Error(
      'decodeImportedDocx: 该模板为分块存储（无 bytesBase64），请用 readImportedDocxBytes(store, viewId, imported)',
    );
  }
  return base64ToBytes(imported.bytesBase64);
}

/* ===================== ⑤ 校验 ===================== */

/** 校验结论：`ok:true` 或 `ok:false` + **可展示**原因（含实际大小与上限） */
export type ImportedDocxValidation = { ok: true } | { ok: false; reason: string };

/** 遗留内联校验（解码 → 长度一致 → 未超限） */
function validateInline(raw: { bytesBase64: string; sizeBytes: number }): ImportedDocxValidation {
  let decoded: Uint8Array;
  try {
    decoded = base64ToBytes(raw.bytesBase64);
  } catch (err) {
    return { ok: false, reason: `模板内容不是合法的 base64，无法解码：${formatError(err)}` };
  }
  if (decoded.length !== raw.sizeBytes) {
    return {
      ok: false,
      reason: `模板大小不一致：记录为 ${raw.sizeBytes} 字节，实际解码为 ${decoded.length} 字节（配置可能被篡改或截断）`,
    };
  }
  if (decoded.length > MAX_IMPORTED_DOCX_BYTES) {
    return { ok: false, reason: oversizeReason(decoded.length) };
  }
  return { ok: true };
}

/** 分块引用是否**结构完整**（字节级完整性由 {@link readImportedDocxBytes} 读回时校验） */
function isCompleteReference(raw: Partial<ImportedDocx>): boolean {
  return (
    typeof raw.templateId === 'string' &&
    raw.templateId !== '' &&
    typeof raw.chunkCount === 'number' &&
    Number.isInteger(raw.chunkCount) &&
    raw.chunkCount > 0 &&
    typeof raw.chunkSize === 'number' &&
    Number.isInteger(raw.chunkSize) &&
    raw.chunkSize > 0 &&
    typeof raw.contentHash === 'string' &&
    raw.contentHash !== ''
  );
}

/**
 * ③ 校验导入的 docx 模板（**绝不抛异常**，全部归一为 `{ ok:false, reason }`）。
 *
 * 分流：
 *  · 有 `bytesBase64`（字符串）→ 走 **legacy 内联**校验（解码 / 长度一致 / 未超限）；
 *  · 否则须有**完整分块引用**（templateId / chunkCount / chunkSize / contentHash）→ 结构校验通过
 *    （字节级完整性留待 {@link readImportedDocxBytes} 读回校验）；
 *  · 两者皆无 → 判非法（「缺少内容」），**绝不静默当空模板**。
 */
export function validateImportedDocx(imported: ImportedDocx): ImportedDocxValidation {
  if (imported === null || typeof imported !== 'object') {
    return { ok: false, reason: '导入的模板数据缺失或不是对象' };
  }

  const raw = imported as Partial<ImportedDocx>;

  if (typeof raw.sizeBytes !== 'number' || !Number.isFinite(raw.sizeBytes) || raw.sizeBytes < 0) {
    return { ok: false, reason: '模板大小 sizeBytes 缺失或不是有效数字' };
  }

  if (typeof raw.bytesBase64 === 'string') {
    return validateInline({ bytesBase64: raw.bytesBase64, sizeBytes: raw.sizeBytes });
  }

  if (isCompleteReference(raw)) {
    if (raw.sizeBytes > MAX_IMPORTED_DOCX_BYTES) {
      return { ok: false, reason: oversizeReason(raw.sizeBytes) };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      '模板缺少内容：既无 bytesBase64，也无完整的分块引用（templateId / chunkCount / chunkSize / contentHash）',
  };
}

/* ===================== ⑥ 配置类型层兜底 ===================== */

/**
 * ④ 解析生效的文档来源：`docSource` **缺省（旧配置）→ `'blocks'`**。
 *
 * 「docx 模板导入」只**纯增**可选字段、**不升 `schemaVersion`**（升版会让旧端整体只读）。
 * 所有消费方都必须经本函数取值，而不能直接读 `detail.docSource`（可能为 `undefined`）。
 */
export function resolveDocSource(
  detail: Pick<DetailConfig, 'docSource'> | null | undefined,
): 'blocks' | 'imported' {
  return detail?.docSource === 'imported' ? 'imported' : 'blocks';
}

/* ===================== ⑦ 分块写入 / 读取 / 清理 ===================== */

/** 分块准备结果：待写入的 base64 分块 + 完成后要落进主配置的引用 */
export interface PreparedImportedDocx {
  reference: ImportedDocx;
  chunks: string[];
}

/** `prepareImportedDocx` 选项 */
export interface PrepareImportedDocxOptions {
  uploadedAt?: number;
  /** 指定 templateId（测试稳定性用；缺省自动生成新 id） */
  templateId?: string;
  /** 每块 base64 字符数（缺省 {@link TEMPLATE_CHUNK_BASE64_CHARS}） */
  chunkChars?: number;
}

/**
 * ⑤ 准备分块：把字节编码为 base64、切块，产出**引用**（不含 `bytesBase64`）。
 *
 * 引用含 `templateId` / `chunkCount` / `chunkSize` / `contentHash` / `sizeBytes`，
 * 只写入**新上传**的模板对象；`bytesBase64` **不再出现在新引用里**。
 */
export function prepareImportedDocx(
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  options: PrepareImportedDocxOptions = {},
): PreparedImportedDocx {
  const view = toBytes(bytes);
  const chunkChars =
    typeof options.chunkChars === 'number' &&
    Number.isInteger(options.chunkChars) &&
    options.chunkChars > 0
      ? options.chunkChars
      : TEMPLATE_CHUNK_BASE64_CHARS;

  const base64 = bytesToBase64(view);
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += chunkChars) chunks.push(base64.slice(i, i + chunkChars));
  if (chunks.length === 0) chunks.push(''); // 空内容 → 仍保留 1 个空块（chunkCount ≥ 1）

  const reference: ImportedDocx = {
    fileName: typeof fileName === 'string' ? fileName : '',
    sizeBytes: view.length,
    uploadedAt: options.uploadedAt ?? Date.now(),
    templateId: options.templateId ?? createTemplateId(),
    chunkCount: chunks.length,
    chunkSize: chunkChars,
    contentHash: contentHashOf(view),
  };

  return { reference, chunks };
}

/** 读取结果 */
export type ReadImportedDocxResult =
  | { ok: true; bytes: Uint8Array; legacy: boolean }
  | { ok: false; reason: string };

/**
 * ⑥ 读取模板字节：**legacy 内联优先**，否则按分块引用拼装。
 *
 * **任何不完整都必须显式失败**（绝不静默返回空模板 —— 那会让用户看到一份空白文档
 * 并以为「字段本来就没数据」）：
 *  · 缺块（key 不存在 / 读回非字符串）→ `模板缺失或无效：缺少第 N 块…`
 *  · 长度与 `sizeBytes` 不符 → `模板大小不一致…`
 *  · 哈希与 `contentHash` 不符 → `模板内容校验失败（哈希不符）…`
 */
export async function readImportedDocxBytes(
  store: BridgeStore | null,
  viewId: string,
  imported: ImportedDocx,
): Promise<ReadImportedDocxResult> {
  if (imported === null || typeof imported !== 'object') {
    return { ok: false, reason: '模板数据缺失' };
  }

  // legacy 内联
  if (typeof imported.bytesBase64 === 'string') {
    try {
      const bytes = base64ToBytes(imported.bytesBase64);
      if (bytes.length !== imported.sizeBytes) {
        return {
          ok: false,
          reason: `模板大小不一致：记录为 ${imported.sizeBytes} 字节，实际解码为 ${bytes.length} 字节`,
        };
      }
      if (bytes.length > MAX_IMPORTED_DOCX_BYTES) {
        return { ok: false, reason: oversizeReason(bytes.length) };
      }
      return { ok: true, bytes, legacy: true };
    } catch (err) {
      return { ok: false, reason: `模板内容不是合法的 base64，无法解码：${formatError(err)}` };
    }
  }

  // 分块
  const templateId = imported.templateId;
  const chunkCount = imported.chunkCount;
  if (
    typeof templateId !== 'string' ||
    templateId === '' ||
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount <= 0
  ) {
    return { ok: false, reason: '模板缺少分块引用（templateId / chunkCount）' };
  }

  // ⭐ 分块模板必须有 store 才能拼装；无 store → **显式失败**（绝不静默当空模板）
  if (!store) {
    return { ok: false, reason: '当前环境无可用模板存储（无法读取分块存储的模板），请在飞书客户端中打开' };
  }

  let base64 = '';
  for (let i = 0; i < chunkCount; i += 1) {
    let part: unknown;
    try {
      part = await store.getData(templateChunkKey(viewId, templateId, i));
    } catch (err) {
      return { ok: false, reason: `读取模板块失败：第 ${i} 块读取出错（${formatError(err)}）` };
    }
    if (typeof part !== 'string') {
      return { ok: false, reason: `模板缺失或无效：缺少第 ${i} 块（共 ${chunkCount} 块）` };
    }
    base64 += part;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch (err) {
    return { ok: false, reason: `模板内容不是合法的 base64，无法解码：${formatError(err)}` };
  }

  if (bytes.length !== imported.sizeBytes) {
    return {
      ok: false,
      reason: `模板大小不一致：记录为 ${imported.sizeBytes} 字节，实际解码为 ${bytes.length} 字节（块可能被截断）`,
    };
  }
  if (typeof imported.contentHash === 'string' && contentHashOf(bytes) !== imported.contentHash) {
    return { ok: false, reason: '模板内容校验失败（哈希不符），块可能已损坏或被篡改' };
  }
  if (bytes.length > MAX_IMPORTED_DOCX_BYTES) {
    return { ok: false, reason: oversizeReason(bytes.length) };
  }

  return { ok: true, bytes, legacy: false };
}

/**
 * ⑦ 删除**某个 templateId 的全部块**（清理用）。
 *
 * 🚨 **只允许删除带「自己的 viewId + templateId」前缀的 key**（`cbv:tpl:{viewId}:{templateId}:*`）。
 * 本项目出过一次**清理误删他人文件**的事故 —— **禁止宽泛通配删除**、禁止触碰 `cbv:config` / `cbv:probe`。
 * 由于 bridge 无列举 API，这里按已知 `chunkCount` 精确删除 `0..chunkCount-1`。
 *
 * @returns 实际删除的 key 列表（供测试断言「只删自己」）
 */
export async function deleteTemplateChunks(
  store: BridgeStore,
  viewId: string,
  templateId: string,
  chunkCount: number,
): Promise<string[]> {
  const deleted: string[] = [];
  if (
    typeof templateId !== 'string' ||
    templateId === '' ||
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount <= 0
  ) {
    return deleted;
  }
  for (let i = 0; i < chunkCount; i += 1) {
    const key = templateChunkKey(viewId, templateId, i);
    try {
      // 写 null = 清除（与 BridgeConfigRepository.remove 约定一致）
      await store.setData(key, null);
      deleted.push(key);
    } catch (err) {
      // 单块清理失败不中断其余；不影响用户数据正确性 —— 但必须留日志（真机取证）。
      logWarn(LOG_SCOPE, `清理旧模板块失败：第 ${i} 块（${formatError(err)}）`, {
        phase: 'cleanup-chunk-error',
        templateId,
        chunkIndex: i,
        chunkCount,
        errorText: formatError(err),
      });
    }
  }
  return deleted;
}

/** 分块写入结果 */
export type WriteImportedDocxResult =
  | { ok: true; reference: ImportedDocx }
  | { ok: false; reason: string };

/**
 * ⑧ 写入分块并**读回校验**（原子性的一半；另一半由调用方保证「成功才引用」）。
 *
 * 顺序：**逐块写入 → 全部读回校验（长度 + 哈希）→ 返回引用**。
 * ⚠️ 本函数**不改配置**：调用方只有在 `ok:true` 时才把 `reference` 写进配置，
 * 从而保证「写了一半」的状态**永远不会被引用到**（见 {@link saveImportedDocx}）。
 */
export async function writeImportedDocxChunks(
  store: BridgeStore,
  viewId: string,
  prepared: PreparedImportedDocx,
): Promise<WriteImportedDocxResult> {
  const reference = prepared.reference;
  const templateId = reference.templateId as string;
  const chunkCount = reference.chunkCount as number;
  /** 单块 base64 字符数（与 {@link prepareImportedDocx} 的切块口径一致，日志载荷用） */
  const chunkChars = typeof reference.chunkSize === 'number' ? reference.chunkSize : 0;

  /** 正在写入的块号（异常时用于日志定位「写到了第几块」；-1 = 尚未开始） */
  let currentIndex = -1;

  try {
    for (let i = 0; i < chunkCount; i += 1) {
      currentIndex = i;
      const ok = await store.setData(templateChunkKey(viewId, templateId, i), prepared.chunks[i]);
      if (ok !== true) {
        // ⭐ setData 返回值必须原样入日志：真机若 resolve 非 true（如 undefined），
        //    这是区分「返回形态差异」与「容量被拒」两类根因的关键证据。
        const reason = `写入模板块失败：第 ${i} 块被拒绝（setData 返回 ${String(ok)}）${WRITE_CAPACITY_HINT}`;
        logWarn(LOG_SCOPE, reason, {
          phase: 'write-chunk-rejected',
          templateId,
          chunkIndex: i,
          chunkCount,
          chunkChars,
          setDataReturn: String(ok),
        });
        return { ok: false, reason };
      }
    }
  } catch (err) {
    const errorText = formatError(err);
    // 追加人话提示（仅追加，前缀保持既有形态）：真机 `set block entity error` 即平台
    // 单键容量拒绝，原始报错对用户太生硬。
    const reason = `写入模板块失败：${errorText}${WRITE_CAPACITY_HINT}`;
    logWarn(LOG_SCOPE, reason, {
      phase: 'write-chunk-error',
      templateId,
      chunkIndex: currentIndex,
      chunkCount,
      chunkChars,
      errorText,
    });
    return { ok: false, reason };
  }

  // 读回校验（长度 + 哈希）—— 不通过则视为写入失败，**不返回引用**
  const verified = await readImportedDocxBytes(store, viewId, reference);
  if (!verified.ok) {
    // ⭐ 含「缺少第 N 块」等具体原因：真机若存在写后立读的最终一致性，靠这条定位。
    logWarn(LOG_SCOPE, `写入后校验失败：${verified.reason}`, {
      phase: 'verify-after-write',
      templateId,
      chunkCount,
      chunkChars,
      sizeBytes: typeof reference.sizeBytes === 'number' ? reference.sizeBytes : 0,
      reason: verified.reason,
    });
    return { ok: false, reason: `写入后校验失败：${verified.reason}` };
  }

  return { ok: true, reference };
}

/** 保存导入模板的结果 */
export interface SaveImportedDocxResult {
  ok: boolean;
  /** 成功时要写进主配置的引用（失败时不返回 → 调用方保持旧值） */
  reference?: ImportedDocx;
  /** 失败原因（可展示） */
  error?: string;
}

/**
 * ⑨ ⭐ 保存一个导入模板（**原子编排**）：
 *   ① 体积上限前置校验（**明确文案**）→ ② {@link prepareImportedDocx} 分块
 *   → ③ {@link writeImportedDocxChunks} 写全部块 + 读回校验
 *   → ④ **仅当成功** 才删除**上一个 templateId** 的块并返回新引用。
 *
 * 🔴 失败（任何一步）→ **不删旧块、不返回引用** ⇒ 配置里仍是旧模板，**旧模板仍可用**。
 * 🔴 清理只针对 `previous.templateId`（**只删自己的块**），不碰其它 id / `cbv:config` / `cbv:probe`。
 *
 * ⚠️ 调用方**必须**在 `ok:true` 时把 `reference` 写进配置、`ok:false` 时报错——这是
 * 「引用最后落、失败不引用」的关键一环。
 */
export async function saveImportedDocx(
  store: BridgeStore,
  viewId: string,
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  previous: ImportedDocx | null = null,
  options: PrepareImportedDocxOptions = {},
): Promise<SaveImportedDocxResult> {
  const view = toBytes(bytes);
  if (view.length > MAX_IMPORTED_DOCX_BYTES) {
    logWarn(LOG_SCOPE, oversizeReason(view.length), {
      phase: 'oversize',
      sizeBytes: view.length,
      maxBytes: MAX_IMPORTED_DOCX_BYTES,
    });
    return { ok: false, error: oversizeReason(view.length) };
  }

  const prepared = prepareImportedDocx(fileName, view, options);
  const written = await writeImportedDocxChunks(store, viewId, prepared);
  if (!written.ok) return { ok: false, error: written.reason };

  // 成功后才清理旧模板的块（只删自己上一个 templateId；不同 id 才需要清理）
  const newTemplateId = written.reference.templateId;
  if (
    previous &&
    typeof previous.templateId === 'string' &&
    previous.templateId !== '' &&
    previous.templateId !== newTemplateId
  ) {
    await deleteTemplateChunks(store, viewId, previous.templateId, previous.chunkCount ?? 0);
  }

  return { ok: true, reference: written.reference };
}

/* ===================== ⑩ ⭐ 容量探针（真机实测平台真实上限） ===================== */

/**
 * 探针 key 前缀。
 * ⚠️ **刻意与配置 key 前缀 `cbv:config` 分开**：探针**绝不允许**碰真实配置 key。
 * 探针全程只读写 `cbv:probe:*`，且结束时清理。
 */
export const PROBE_KEY_PREFIX = `${STORAGE_PREFIX}:probe`; // 'cbv:probe'

/** 探针 key：`cbv:probe:{viewId}:{timestamp}`（**与 `cbv:config:*` / `cbv:tpl:*` 不相交**） */
export function probeKey(viewId: string, timestamp: number): string {
  return `${PROBE_KEY_PREFIX}:${viewId}:${timestamp}`;
}

/** 探针默认递增体积档（32KB → 1MB） */
export const DEFAULT_PROBE_LADDER_BYTES: readonly number[] = [
  32 * 1024,
  64 * 1024,
  128 * 1024,
  256 * 1024,
  512 * 1024,
  1024 * 1024,
];

/** 单档探测结果 */
export interface ProbeStepResult {
  /** 该档尝试写入的字节数 */
  bytes: number;
  ok: boolean;
  /** 失败原因（含 SDK 抛错文案 / 读回校验失败说明） */
  error?: string;
}

/** 探针结论 */
export interface ProbeBridgeCapacityResult {
  /** 最大的**成功**体积（全部失败 → 0） */
  maxOkBytes: number;
  /** 逐档结果（**递增**；遇到首个失败即停止，之后不再试更大档） */
  results: ProbeStepResult[];
}

/** 探针选项（全部可选：无参调用即「真机默认探测」） */
export interface ProbeBridgeCapacityOptions {
  /** 注入存储实现（测试必传；不传 → 动态 import `@/sdk/base` 取真实 bridge） */
  store?: BridgeStore | null;
  /** 命名空间片段（仅影响探针 key，缺省 `'probe'`） */
  viewId?: string;
  /** 递增体积档（缺省 {@link DEFAULT_PROBE_LADDER_BYTES}） */
  ladder?: readonly number[];
  /** 时间戳（缺省当前时间；测试可显式传入以稳定 key） */
  now?: number;
}

/** 构造一段**确定性**的 ASCII 载荷，其 UTF-8 字节数恰为 `size`（可校验读回是否被截断） */
function makeProbePayload(size: number): string {
  const seed = 'cbv-probe:';
  let out = '';
  while (out.length < size) out += seed;
  return out.slice(0, size);
}

/** 动态取真实 bridge 存储（**动态 import**：不打进本模块加载图，见文件头约束） */
async function resolveDefaultStore(): Promise<BridgeStore | null> {
  const mod = await import('@/sdk/base');
  return mod.getBridgeStore();
}

/**
 * ⭐ 容量探针：**按递增体积写入 → 读回校验**，测出平台真实可存的字节上限。
 *
 * ⭐ 安全保证（**最重要的不变量**）：
 *  · 全程只读写**专用探针 key** {@link probeKey}（前缀 `cbv:probe`），与真实配置 key
 *    `cbv:config:{viewId}` 及模板块 key `cbv:tpl:*` **不相交** —— **绝不碰用户数据**；
 *  · 无论成功 / 失败 / 抛错，`finally` 里都会**清理探针 key**（写 `null` 视为清除）；
 *  · 单个档位失败即**停止并保留已得结论**（更大档必然也失败）。
 */
export async function probeBridgeCapacity(
  options: ProbeBridgeCapacityOptions = {},
): Promise<ProbeBridgeCapacityResult> {
  const store = options.store !== undefined ? options.store : await resolveDefaultStore();
  if (!store) {
    return { maxOkBytes: 0, results: [] };
  }

  const ladder =
    options.ladder && options.ladder.length > 0 ? [...options.ladder] : [...DEFAULT_PROBE_LADDER_BYTES];
  const ascending = ladder.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

  const key = probeKey(options.viewId ?? 'probe', options.now ?? Date.now());

  const results: ProbeStepResult[] = [];
  let maxOkBytes = 0;

  try {
    for (const bytes of ascending) {
      const entry: ProbeStepResult = { bytes, ok: false };
      try {
        const written = await store.setData(key, makeProbePayload(bytes));
        if (written !== true) {
          entry.error = `setData 返回 ${String(written)}（写入被拒绝）`;
          results.push(entry);
          break;
        }
        const readBack = await store.getData(key);
        if (readBack !== makeProbePayload(bytes)) {
          entry.error =
            readBack === null || readBack === undefined
              ? '读回为空，写入未生效'
              : '读回内容与写入不一致（可能被截断）';
          results.push(entry);
          break;
        }
        entry.ok = true;
        maxOkBytes = bytes;
        results.push(entry);
      } catch (err) {
        entry.error = formatError(err);
        results.push(entry);
        break;
      }
    }
  } finally {
    // 清理探针 key（无论成功 / 失败 / 抛错）—— 只动 cbv:probe:*。
    try {
      await store.setData(key, null);
    } catch {
      /* 清理失败不改变探测结论（探针 key 也非真实配置） */
    }
  }

  // ⭐ 探针结果摘要（info 级）：探针本就是真机取证工具，结论必须能从控制台直接读到。
  //    仅在**确实探测过**（拿到了结果）时打；无 store 的空结果由 UI 文案负责告知。
  if (results.length > 0) {
    logInfo(
      LOG_SCOPE,
      `容量探测完成：最大可写入 ${maxOkBytes} 字节（逐档：${results
        .map((r) => `${r.bytes}=${r.ok ? 'ok' : 'fail'}`)
        .join('、')}）`,
      { maxOkBytes, steps: results.length },
    );
  }

  return { maxOkBytes, results };
}

export default probeBridgeCapacity;
