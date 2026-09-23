/**
 * 编辑器「模板来源」栏 + docx 上传 + ⭐ **模板体检**（「docx 模板导入」第 5b 步）。
 *
 * 位置：`ConfigDrawer` 文档排版分支的最上方（一条横栏，**不随内容滚动**）。
 * 数据流：
 * ```
 *   用户选「导入 docx」→ 上传 .docx
 *     → readBlobBytes → 体积体检（MAX_IMPORTED_DOCX_BYTES，超限**明确文案含实际大小与上限**）
 *     → encodeImportedDocx → draft.importedDocx（`DraftStore.setImportedDocx`）
 *     → extractDocxText → checkTemplate(text, fields) → **模板体检**（本栏展示）
 * ```
 *
 * ⭐ 三条硬约束（违反即功能性缺陷）：
 *  1. **绝静默**：上传失败（非 .docx / 超限 / 读取出错）一律给**明确文案**；超限文案必须**含实际
 *     字节数与上限字节数**（用户以为「存上了」而其实没存，是最坏的体验）。
 *  2. **体检在导入那一刻做，且问题必须红字**：`unmatched` / `ambiguous` / `unclosedLoops` /
 *     `unopenedLoops` / `duplicateFieldNames` 逐个列出。为什么必需：参考的打印插件**没有**这块，
 *     未匹配的占位符被静默清空 → 输出一块空白，用户只会以为「这个字段本来就没数据」，
 *     **不会怀疑是自己模板里字段名写错了**。故此处必须把问题摆在导入那一刻。
 *  3. **不改画布内容宽度**：本栏只占**垂直**空间（横条），**绝不**声明纸页 / 画布宽度。
 *     编辑器画布与详情的内容宽度恒等于 `getContentBox().width`
 *     （守卫：`docPathConsistency.test.tsx`）。
 *
 * ⚠️ 分层：本组件位于 `components/editor/doc/`，允许 import `doc/`；对 `hooks/` 只取
 *   **已被 5a 交付并导出**的纯工具（`extractDocxText` / `readBlobBytes`）与文案常量，
 *   不复制其逻辑（跨 run 合并 / 部件白名单只有一处实现）。这两个工具**不**静态引入 SDK，
 *   故不会把 SDK 拖进编辑器的加载图。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import type { ImportedDocx } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { checkTemplate } from '@/doc/template/placeholders';
import type { PlaceholderToken, TemplateHealth } from '@/doc/template/placeholders';
import {
  encodeImportedDocx,
  formatBytes,
  getTemplateBridgeStore,
  INLINE_FALLBACK_MAX_BYTES,
  LOG_SCOPE,
  MAX_IMPORTED_DOCX_BYTES,
  probeBridgeCapacity,
  readImportedDocxBytes,
  saveImportedDocx,
  validateImportedDocx,
} from '@/doc/template/storage';
import type { ProbeBridgeCapacityResult } from '@/doc/template/storage';
import type { BridgeStore } from '@/sdk/base';
import {
  extractDocxText,
  INVALID_TEMPLATE_PREFIX,
  readBlobBytes,
} from '@/hooks/useImportedDoc';
import { formatError } from '@/utils/errorText';
import { logWarn } from '@/utils/log';

/* ===================== 文案常量（供测试锁定确切值） ===================== */

/** 分段控件两项的文案（= 「模板来源」的两个取值） */
export const SOURCE_BLOCKS_LABEL = '可视化排版';
export const SOURCE_IMPORTED_LABEL = '导入 docx';

/** 非 .docx 文件的拒绝文案前缀 */
export const NON_DOCX_PREFIX = '仅支持 .docx 模板文件';

/** 读取文件字节失败时的前缀 */
export const UPLOAD_FAILED_PREFIX = '读取模板文件失败：';

/** 体检本身失败（docx 解不开 / 抽取抛错）时的前缀 */
export const HEALTH_FAILED_PREFIX = '模板体检失败：';

/** 体检面板标题 */
export const HEALTH_TITLE = '模板体检';

/** 未上传模板时的引导文案 */
export const HEALTH_IDLE_HINT = '选择 .docx 模板后，会立即体检其中的占位符与字段是否对得上。';

/** 非 .docx 的**完整**拒绝文案（含当前文件名） */
export function nonDocxMessage(fileName: string): string {
  return `${NON_DOCX_PREFIX}（当前文件：${fileName}）`;
}

/**
 * 超限文案（**必须含实际大小与上限的数值**）。
 *
 * 例：`模板 82.0KB（83968 字节），超出上限 32.0KB（32768 字节），请压缩模板后重试`。
 * 「绝不允许静默失败」—— 用户会以为上传成功了。
 */
export function oversizeMessage(sizeBytes: number): string {
  return `模板 ${formatBytes(sizeBytes)}（${sizeBytes} 字节），超出上限 ${formatBytes(MAX_IMPORTED_DOCX_BYTES)}（${MAX_IMPORTED_DOCX_BYTES} 字节），请压缩模板后重试`;
}

/* ===================== ⭐ 容量探测（⑦：真机实测平台真实上限） ===================== */

/** 「检测存储容量」按钮文案 */
export const PROBE_ACTION_LABEL = '检测存储容量';

/** 探测面板标题 */
export const PROBE_TITLE = '存储容量探测';

/** 无 bridge 存储 → 无法探测（探测只写专用 `cbv:probe:` key，必须有介质） */
export const PROBE_NO_STORE_MESSAGE = '当前环境没有可用的 bridge 存储，无法探测容量（请在飞书客户端中使用）。';

/** 探测过程抛错的前缀 */
export const PROBE_FAILED_PREFIX = '容量探测失败：';

/**
 * ⚠️ 无 store 且模板超过**内联降级上限**时的显式文案。
 *
 * 为什么必须有这条：内联降级（把 `bytesBase64` 写进主配置）只对小模板安全；大模板若被静默
 * 内联，会让**每次配置保存**都搬运 ~1.4MB，任一次失败就丢掉用户这次的全部编辑。故宁可
 * **显式报错**也不静默塞进主配置。
 */
export function noStoreLargeMessage(sizeBytes: number): string {
  return `当前环境无法保存较大的模板（${formatBytes(sizeBytes)}，${sizeBytes} 字节）：未获取到 bridge 存储，请改用飞书客户端打开，或选择不超过 ${formatBytes(INLINE_FALLBACK_MAX_BYTES)}（${INLINE_FALLBACK_MAX_BYTES} 字节）的模板。`;
}

/** 探测结果摘要（「最大成功体积」一行文案） */
export function probeSummary(result: ProbeBridgeCapacityResult): string {
  if (result.results.length === 0) return '未获得任何探测结果。';
  const max = result.maxOkBytes > 0 ? formatBytes(result.maxOkBytes) : '无';
  return `最大可写入 ${max}（${result.maxOkBytes} 字节）`;
}

/** 各体检分项的标题（把「为什么这是问题」写给用户看） */
export const UNMATCHED_TITLE = '模板里写了、但没有对应字段的占位符（导出后是空白，请核对字段名）';
export const DUPLICATE_TITLE = '源字段重名冲突（无法确定用哪个字段）';
export const AMBIGUOUS_TITLE = '字段重名导致无法确定用哪个字段（已留空，不会猜）';
export const UNCLOSED_TITLE = '循环未闭合（写了开始标签，但没有对应的结束标签）';
export const UNOPENED_TITLE = '多余的循环结束标签（没有对应的开始标签）';
export const UNUSED_TITLE = '模板未引用的字段';

/* ===================== 工具 ===================== */

/** `.docx`（大小写不敏感） */
const DOCX_NAME_PATTERN = /\.docx$/i;

/**
 * 取某个占位符名**首次出现**处的源码原文（简单 = `{名}`；循环 = `{#名}`）。
 * 用于体检里「逐个列出模板中的原文」——与 `checkTemplate` 的 `matched[].placeholder` 同口径。
 */
function rawOf(tokens: ReadonlyArray<PlaceholderToken>, name: string): string {
  for (const token of tokens) {
    if (token.name === name) return token.kind === 'simple' ? token.raw : token.openRaw;
    if (token.kind === 'loop') {
      const nested = rawOf(token.inner, name);
      if (nested !== '') return nested;
    }
  }
  return `{${name}}`;
}

/* ===================== 组件 ===================== */

export interface DocxTemplateSourceBarProps {
  /** 当前生效的模板来源（`docSource` 缺省已由调用方归一为 `'blocks'`） */
  source: 'blocks' | 'imported';
  /** 当前草稿里已导入的模板（未上传 = null） */
  importedDocx: ImportedDocx | null;
  /** 当前视图字段元数据（体检的匹配基准） */
  fields: FieldMetaLite[];
  /**
   * 当前视图 id（分块模板按 `cbv:tpl:{viewId}:{templateId}:{i}` 写入；生产由 `env.viewId` 传入）。
   * 缺省 `''`：legacy 内联路径不需要它。
   */
  viewId?: string;
  /**
   * 模板块存储（缺省取注册的 bridge 存储 {@link getTemplateBridgeStore}）。
   * 有 store → 分块专用 key（支持 1MB）；无 store → 小模板内联降级 / 大模板显式报错。
   */
  store?: BridgeStore | null;
  /** 切换模板来源（**只改来源**，不清空已导入模板） */
  onSourceChange: (source: 'blocks' | 'imported') => void;
  /** 上传成功后写入导入模板 */
  onImportedDocxChange: (imported: ImportedDocx) => void;
}

function DocxTemplateSourceBarInner({
  source,
  importedDocx,
  fields,
  viewId = '',
  store,
  onSourceChange,
  onImportedDocxChange,
}: DocxTemplateSourceBarProps): ReactElement {
  /** 生效的存储：显式传入优先，否则取注册的 bridge 存储（可能为 null → 走降级 / 报错） */
  const templateStore: BridgeStore | null = store !== undefined ? store : getTemplateBridgeStore();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [health, setHealth] = useState<TemplateHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** 容量探测：进行中 / 结果 / 失败文案（⑦） */
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeBridgeCapacityResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  /** 运行序号：体检是异步的，切换来源 / 换模板时作废上一轮，避免旧结果覆盖新结果 */
  const runSeqRef = useRef(0);

  /* ---- ⭐ 体检：上传后 / 切回「导入 docx」时都会跑（保存之前就展示） ---- */
  useEffect(() => {
    const seq = runSeqRef.current + 1;
    runSeqRef.current = seq;
    let cancelled = false;
    const active = (): boolean => !cancelled && runSeqRef.current === seq;

    // 非导入来源 / 未上传 → 不展示体检（模板来源栏本身仍在）
    if (source !== 'imported' || !importedDocx) {
      setHealth(null);
      setHealthError(null);
      setChecking(false);
      return () => {
        cancelled = true;
      };
    }

    // 模板非法（base64 坏 / 大小不一致 / 超限）→ 明确文案，不静默
    const validation = validateImportedDocx(importedDocx);
    if (!validation.ok) {
      setHealth(null);
      setHealthError(`${INVALID_TEMPLATE_PREFIX}${validation.reason}`);
      setChecking(false);
      return () => {
        cancelled = true;
      };
    }

    setChecking(true);
    setHealthError(null);
    void (async () => {
      try {
        // ⭐ 统一取字节入口（legacy 内联 / 分块专用 key）：分块缺块 / 哈希不符 → 显式报「模板无效」
        const read = await readImportedDocxBytes(templateStore, viewId, importedDocx);
        if (!active()) return;
        if (!read.ok) {
          setHealth(null);
          setHealthError(`${INVALID_TEMPLATE_PREFIX}${read.reason}`);
          return;
        }
        const text = await extractDocxText(read.bytes);
        if (!active()) return;
        setHealth(checkTemplate(text, fields));
      } catch (err) {
        if (!active()) return;
        setHealth(null);
        setHealthError(`${HEALTH_FAILED_PREFIX}${formatError(err)}`);
      } finally {
        if (active()) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // ⚠️ 依赖数组不得漏项：漏 `importedDocx` → 重新上传后体检不刷新（且不报错）；
    //    漏 `templateStore` / `viewId` → 分块模板体检读不到块（且不报错）。
  }, [source, importedDocx, fields, templateStore, viewId]);

  /* ---- 上传：先体积体检（明确文案），再写草稿；体检由上面的 effect 触发 ---- */
  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const input = event.target;
      const file = input.files && input.files.length > 0 ? input.files[0] : null;
      if (!file) return;

      void (async () => {
        try {
          if (!DOCX_NAME_PATTERN.test(file.name)) {
            setHealth(null);
            setUploadError(nonDocxMessage(file.name));
            // 只加日志、不改文案：真机控制台必须能留下「为什么失败」的痕迹
            logWarn(LOG_SCOPE, nonDocxMessage(file.name), {
              phase: 'reject-non-docx',
              fileName: file.name,
            });
            return;
          }
          const bytes = await readBlobBytes(file);
          if (bytes.length > MAX_IMPORTED_DOCX_BYTES) {
            setHealth(null);
            setUploadError(oversizeMessage(bytes.length));
            logWarn(LOG_SCOPE, oversizeMessage(bytes.length), {
              phase: 'oversize',
              sizeBytes: bytes.length,
              maxBytes: MAX_IMPORTED_DOCX_BYTES,
            });
            return;
          }
          // ⭐ 有 store → **分块写专用 key**（支持 1MB）：写全部块 → 读回校验 → 成功才把引用交给上层。
          //    「写了一半」永不引用；失败时旧模板不动（原子性由 saveImportedDocx 保证）。
          //    写块 / 校验 / 清理的失败日志由 storage 层负责（phase: write-chunk-* / verify-after-write）。
          if (templateStore) {
            const saved = await saveImportedDocx(templateStore, viewId, file.name, bytes, importedDocx);
            if (!saved.ok || !saved.reference) {
              setHealth(null);
              setUploadError(`${UPLOAD_FAILED_PREFIX}${saved.error ?? '写入模板失败'}`);
              return;
            }
            setUploadError(null);
            onImportedDocxChange(saved.reference);
            return;
          }
          // ⭐ 无 store → 降级：小模板内联（base64 ≈ 4/3，仍在 64KB 主配置额度内）；
          //    大模板**显式报错**（绝不把 ~1.4MB 静默塞进主配置，否则每次保存都变脆）。
          if (bytes.length > INLINE_FALLBACK_MAX_BYTES) {
            setHealth(null);
            setUploadError(noStoreLargeMessage(bytes.length));
            logWarn(LOG_SCOPE, noStoreLargeMessage(bytes.length), {
              phase: 'no-store-oversize-inline',
              sizeBytes: bytes.length,
              inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
            });
            return;
          }
          setUploadError(null);
          onImportedDocxChange(encodeImportedDocx(file.name, bytes));
        } catch (err) {
          setHealth(null);
          // 兜底：读文件失败 / 引用更新（onImportedDocxChange）抛错等都落在这里，统一留痕
          const errorText = formatError(err);
          logWarn(LOG_SCOPE, `${UPLOAD_FAILED_PREFIX}${errorText}`, {
            phase: 'upload-error',
            fileName: file.name,
            errorText,
          });
          setUploadError(`${UPLOAD_FAILED_PREFIX}${errorText}`);
        } finally {
          // 清空选择 → 允许再次选择同一个文件（file input 的 value 不会自动清空）
          try {
            input.value = '';
          } catch {
            /* jsdom / 受限环境可能不允许置空：忽略，不影响上传结果 */
          }
        }
      })();
    },
    [onImportedDocxChange, templateStore, viewId, importedDocx],
  );

  /* ---- ⭐ 容量探测（⑦）：只读写专用 cbv:probe: key，用户主动触发，结果只读展示 ---- */
  const handleProbe = useCallback((): void => {
    if (probing) return;
    setProbing(true);
    setProbeError(null);
    setProbeResult(null);
    void (async () => {
      try {
        if (!templateStore) {
          setProbeError(PROBE_NO_STORE_MESSAGE);
          return;
        }
        const result = await probeBridgeCapacity({ store: templateStore, viewId: viewId || 'probe' });
        setProbeResult(result);
      } catch (err) {
        setProbeError(`${PROBE_FAILED_PREFIX}${formatError(err)}`);
      } finally {
        setProbing(false);
      }
    })();
  }, [probing, templateStore, viewId]);

  /* ---- 体检分项：有问题的**逐个红字列出** ---- */
  const issueBlocks: ReactElement[] = [];
  if (health) {
    if (health.unmatched.length > 0) {
      issueBlocks.push(
        <div key="unmatched" className="cbv-health__issue cbv-health__issue--error" data-health-unmatched="true">
          <div className="cbv-health__issue-title">{UNMATCHED_TITLE}</div>
          <ul className="cbv-health__list">
            {health.unmatched.map((name) => (
              <li key={name} className="cbv-health__item" data-health-unmatched-item={name}>
                {rawOf(health.tokens, name)}
              </li>
            ))}
          </ul>
        </div>,
      );
    }
    if (health.ambiguous.length > 0) {
      issueBlocks.push(
        <div key="ambiguous" className="cbv-health__issue cbv-health__issue--error" data-health-ambiguous="true">
          <div className="cbv-health__issue-title">{AMBIGUOUS_TITLE}</div>
          <ul className="cbv-health__list">
            {health.ambiguous.map((item) => (
              <li key={item.name} className="cbv-health__item" data-health-ambiguous-item={item.name}>
                {`${item.placeholder}（候选字段 id：${item.fieldIds.join('、')}）`}
              </li>
            ))}
          </ul>
        </div>,
      );
    }
    if (health.duplicateFieldNames.length > 0) {
      issueBlocks.push(
        <div key="duplicate" className="cbv-health__issue cbv-health__issue--error" data-health-duplicate="true">
          <div className="cbv-health__issue-title">{DUPLICATE_TITLE}</div>
          <ul className="cbv-health__list">
            {health.duplicateFieldNames.map((dup) => (
              <li key={dup.name} className="cbv-health__item" data-health-duplicate-item={dup.name}>
                {`${dup.name}（字段 id：${dup.fieldIds.join('、')}）`}
              </li>
            ))}
          </ul>
        </div>,
      );
    }
    if (health.unclosedLoops.length > 0) {
      issueBlocks.push(
        <div key="unclosed" className="cbv-health__issue cbv-health__issue--error" data-health-unclosed-loop="true">
          <div className="cbv-health__issue-title">{UNCLOSED_TITLE}</div>
          <ul className="cbv-health__list">
            {health.unclosedLoops.map((name) => (
              <li key={name} className="cbv-health__item" data-health-unclosed-item={name}>
                {`{#${name}} 缺少 {/${name}}`}
              </li>
            ))}
          </ul>
        </div>,
      );
    }
    if (health.unopenedLoops.length > 0) {
      issueBlocks.push(
        <div key="unopened" className="cbv-health__issue cbv-health__issue--error" data-health-unopened-loop="true">
          <div className="cbv-health__issue-title">{UNOPENED_TITLE}</div>
          <ul className="cbv-health__list">
            {health.unopenedLoops.map((name) => (
              <li key={name} className="cbv-health__item" data-health-unopened-item={name}>
                {`{/${name}} 缺少 {#${name}}`}
              </li>
            ))}
          </ul>
        </div>,
      );
    }
  }

  return (
    <section className="cbv-docxsource" data-docx-source-bar="true" aria-label="模板来源">
      <div className="cbv-docxsource__row">
        <span className="cbv-docxsource__label">模板来源</span>
        <div className="cbv-segmented cbv-segmented--mini" role="tablist" aria-label="模板来源">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'blocks'}
            data-docx-source="blocks"
            className={`cbv-segmented__item${source === 'blocks' ? ' cbv-segmented__item--active' : ''}`}
            onClick={() => onSourceChange('blocks')}
          >
            {SOURCE_BLOCKS_LABEL}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'imported'}
            data-docx-source="imported"
            className={`cbv-segmented__item${source === 'imported' ? ' cbv-segmented__item--active' : ''}`}
            onClick={() => onSourceChange('imported')}
          >
            {SOURCE_IMPORTED_LABEL}
          </button>
        </div>
        {source === 'imported' ? (
          <label className="cbv-docxsource__upload">
            <input
              type="file"
              accept=".docx"
              data-docx-upload="true"
              className="cbv-docxsource__file"
              onChange={handleFileChange}
            />
            <span className="cbv-btn cbv-btn--mini">{importedDocx ? '重新选择 .docx' : '选择 .docx 模板'}</span>
          </label>
        ) : (
          <span className="cbv-docxsource__hint">用左侧区块库与画布编排文档</span>
        )}
        {/* ⭐ ⑦ 容量探测：用户主动触发；只在 cbv:probe: key 上试写并清理，绝不碰真实配置 */}
        <button
          type="button"
          className="cbv-btn cbv-btn--mini cbv-docxsource__probe"
          data-docx-probe="true"
          onClick={handleProbe}
          disabled={probing}
          title="在专用 key 上试写不同体积，实测当前平台可写入的最大模板字节数（不影响你的数据）"
        >
          {probing ? '探测中…' : PROBE_ACTION_LABEL}
        </button>
      </div>

      {probeError ? (
        <div className="cbv-health__issue cbv-health__issue--error" data-docx-probe-error="true" role="alert">
          {probeError}
        </div>
      ) : null}

      {probeResult ? (
        <div className="cbv-probe" data-docx-probe-result="true">
          <div className="cbv-probe__head">
            <span className="cbv-probe__title">{PROBE_TITLE}</span>
            <span className="cbv-probe__max" data-probe-max={probeResult.maxOkBytes}>
              {probeSummary(probeResult)}
            </span>
          </div>
          <ul className="cbv-probe__list">
            {probeResult.results.map((step) => (
              <li key={step.bytes} className="cbv-probe__item" data-probe-step={step.bytes} data-probe-ok={step.ok ? 'true' : 'false'}>
                {`${formatBytes(step.bytes)}（${step.bytes} 字节）：${step.ok ? '成功' : `失败${step.error ? `（${step.error}）` : ''}`}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {uploadError ? (
        <div className="cbv-health__issue cbv-health__issue--error" data-docx-upload-error="true" role="alert">
          {uploadError}
        </div>
      ) : null}

      {source === 'imported' ? (
        <div className="cbv-health" data-docx-health="true">
          <div className="cbv-health__head">
            <span className="cbv-health__title">{HEALTH_TITLE}</span>
            {importedDocx ? (
              <span className="cbv-health__file" data-health-file="true">
                {`${importedDocx.fileName}（${formatBytes(importedDocx.sizeBytes)}）`}
              </span>
            ) : null}
            {checking ? <span className="cbv-health__checking">体检中…</span> : null}
          </div>

          {healthError ? (
            <div className="cbv-health__issue cbv-health__issue--error" data-docx-health-error="true">
              {healthError}
            </div>
          ) : null}

          {!importedDocx && !healthError ? (
            <div className="cbv-health__hint" data-docx-health-idle="true">
              {HEALTH_IDLE_HINT}
            </div>
          ) : null}

          {health ? (
            <div className="cbv-health__body" data-health-result="true">
              <div
                className={`cbv-health__matched${health.matched.length > 0 ? ' cbv-health__matched--ok' : ''}`}
                data-health-matched={health.matched.length}
              >
                {`匹配字段 ${health.matched.length} 个`}
              </div>
              {issueBlocks}
              {health.unusedFields.length > 0 ? (
                <div className="cbv-health__unused" data-health-unused="true">
                  <span className="cbv-health__unused-title">{UNUSED_TITLE}：</span>
                  {health.unusedFields.map((field) => field.fieldName).join('、')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export const DocxTemplateSourceBar = DocxTemplateSourceBarInner;

export default DocxTemplateSourceBar;
