/**
 * 配置存取抽象接口 + envelope 编解码（设计文档 §6.3 / §7）。
 *
 * 上层（useCardViewInit）只依赖本接口，对具体实现（bridge / localStorage）无感，
 * 切换仅发生在 `factory.ts` 一处。
 */
import { CONFIG_SIZE_LIMIT_BYTES, CONFIG_SIZE_WARN_BYTES } from '@/constants';
import { checksumOf, stableStringify, utf8ByteLength } from '@/utils/hash';
import { CONFIG_PLUGIN_VERSION } from './defaults';
import { migrate } from './migrations';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig, type ConfigEnvelope } from './types';

/** 配置来源（供 UI 展示与降级提示） */
export type ConfigSource = 'bridge' | 'localStorage' | 'default';

export interface LoadResult {
  config: CardViewConfig | null;
  /** 走了降级：损坏回退 / 介质降级 */
  degraded: boolean;
  /** 读到更高版本 → 只读模式（禁止保存） */
  unsupportedNewer: boolean;
  source: ConfigSource;
  /** D4 首开提示 */
  provisionedFromTemplate?: boolean;
  /** 失败原因（诊断用，不直接展示给用户） */
  error?: string;
}

/** 保存失败的错误码（供 UI / 上层做分支，不直接展示） */
export type SaveErrorReason =
  /** D9 体积超限（> 64KB） */
  | 'too-large'
  /** F5：读到更高版本配置 → 只读，禁止保存（避免降级覆盖高版本客户端写入的数据） */
  | 'unsupported-newer-readonly'
  /** 底层介质写入失败 */
  | 'write-failed';

export interface SaveResult {
  ok: boolean;
  conflict?: boolean;
  /** D9 超限 */
  tooLarge?: boolean;
  /** 失败错误码 */
  reason?: SaveErrorReason;
  error?: string;
}

/** F5：更高版本只读时，保存被拒绝的 UI 可展示文案 */
export const UNSUPPORTED_NEWER_SAVE_MESSAGE =
  '当前配置由更高版本的插件写入，为避免覆盖较新数据，本版本仅支持只读浏览，暂不能保存。';

export interface ConfigRepository {
  getSchemaVersion(): number;
  load(viewId: string): Promise<LoadResult>;
  save(viewId: string, config: CardViewConfig): Promise<SaveResult>;
  subscribe(viewId: string, cb: (config: CardViewConfig) => void): () => void;
  remove(viewId: string): Promise<boolean>;
  /**
   * F2：是否已发生「介质降级」（运行期 primary 介质失败 → 单向闭锁切到 fallback）。
   * 供 UI 显示**常驻不可关闭**的提示条（R8：配置仅本地保存，其他成员看不到你的排版）。
   */
  isDegraded(): boolean;
}

/** 序列化结果 */
export interface SerializeResult {
  ok: boolean;
  raw: string;
  bytes: number;
  tooLarge: boolean;
  warn: boolean;
}

/** 反序列化结果 */
export interface DeserializeResult {
  envelope: ConfigEnvelope | null;
  valid: boolean;
  reason?: string;
}

export const CONFIG_SIZE_LIMIT = CONFIG_SIZE_LIMIT_BYTES;
export const CONFIG_SIZE_WARN = CONFIG_SIZE_WARN_BYTES;

/**
 * 组装 envelope 并序列化。
 * checksum 覆盖 payload（稳定序列化），用于读取时的损坏检测。
 */
export function serializeConfig(config: CardViewConfig, now: number = Date.now()): SerializeResult {
  const envelope: ConfigEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    pluginVersion: CONFIG_PLUGIN_VERSION,
    writtenAt: now,
    checksum: checksumOf(config),
    payload: config,
  };
  const raw = JSON.stringify(envelope);
  const bytes = utf8ByteLength(raw);
  return {
    ok: bytes <= CONFIG_SIZE_LIMIT_BYTES,
    raw,
    bytes,
    tooLarge: bytes > CONFIG_SIZE_LIMIT_BYTES,
    warn: bytes > CONFIG_SIZE_WARN_BYTES,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析并校验 envelope。
 * - 非 JSON / 结构缺失 → valid=false（触发回退默认 + 备份）
 * - checksum 不匹配 → valid=false（触发回退默认 + 备份）
 * - schemaVersion 高于当前 → 仍返回 envelope，但 valid=true，由调用方标记 unsupportedNewer
 */
export function deserializeEnvelope(raw: unknown): DeserializeResult {
  if (raw === null || raw === undefined || raw === '') {
    return { envelope: null, valid: false, reason: 'empty' };
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { envelope: null, valid: false, reason: 'invalid-json' };
    }
  }

  if (!isPlainObject(parsed)) {
    return { envelope: null, valid: false, reason: 'not-object' };
  }

  const schemaVersion = parsed.schemaVersion;
  const checksum = parsed.checksum;
  const payload = parsed.payload;
  if (typeof schemaVersion !== 'number' || typeof checksum !== 'string' || !isPlainObject(payload)) {
    return { envelope: null, valid: false, reason: 'missing-fields' };
  }

  const expected = checksumOf(payload);
  const envelope: ConfigEnvelope = {
    schemaVersion,
    pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
    writtenAt: typeof parsed.writtenAt === 'number' ? parsed.writtenAt : 0,
    checksum,
    payload: payload as unknown as CardViewConfig,
  };

  if (expected !== checksum) {
    return { envelope, valid: false, reason: 'checksum-mismatch' };
  }
  return { envelope, valid: true };
}

/** 计算「配置接近上限」的提示文案（供 Banner 复用） */
export function sizeHint(bytes: number): string {
  const kb = Math.round((bytes / 1024) * 10) / 10;
  if (bytes > CONFIG_SIZE_LIMIT_BYTES) {
    return `配置体积约 ${kb}KB，已超过 64KB 上限，请精简区块或高亮规则后再保存`;
  }
  if (bytes > CONFIG_SIZE_WARN_BYTES) {
    return `配置体积约 ${kb}KB，已接近 64KB 上限`;
  }
  return `配置体积约 ${kb}KB`;
}

/** 供实现类复用的稳定序列化（额外导出便于单测） */
export const stableSerialize = stableStringify;

/** 读取编排的参数 */
export interface LoadOptions {
  viewId: string;
  source: ConfigSource;
  /** 检测到损坏 / 迁移失败时回调，用于落备份 */
  backup?: (raw: string) => void;
}

/**
 * 读取编排（两个实现共用）：
 *  ① 空值 → 无配置（由上层决定是否用默认模板 / D4 首开重配）；
 *  ② 反序列化失败 / checksum 不匹配 → 标记 degraded，回退默认（返回 null + degraded）；
 *  ③ 更高版本 → unsupportedNewer=true（只读，仅读已知字段）；
 *  ④ 版本更旧 → 逐级迁移到当前版本。
 */
export function resolveLoadedConfig(raw: unknown, options: LoadOptions): LoadResult {
  const empty: LoadResult = {
    config: null,
    degraded: false,
    unsupportedNewer: false,
    source: options.source,
  };

  if (raw === null || raw === undefined || raw === '') {
    return empty;
  }

  const { envelope, valid, reason } = deserializeEnvelope(raw);
  if (!valid || !envelope) {
    options.backup?.(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return {
      config: null,
      degraded: true,
      unsupportedNewer: false,
      source: options.source,
      error: reason ?? 'unknown',
    };
  }

  const unsupportedNewer = envelope.schemaVersion > CURRENT_SCHEMA_VERSION;
  try {
    const config = migrate(envelope.payload, envelope.schemaVersion);
    return {
      config,
      degraded: false,
      unsupportedNewer,
      source: options.source,
      provisionedFromTemplate: config.meta.provisionedFromTemplate,
    };
  } catch (err) {
    options.backup?.(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return {
      config: null,
      degraded: true,
      unsupportedNewer,
      source: options.source,
      error: err instanceof Error ? err.message : 'migration-failed',
    };
  }
}

/**
 * P2-2 / D1（架构裁定 §0.2 · Q6 + Q7）：依据一次「载荷解析结果」刷新某 viewId 的只读标记。
 *
 * **`load` 与 `subscribe` 两条路径共用本助手，语义完全一致**：
 *  - `unsupportedNewer === true` → **加锁**（信封可解析、且版本高于当前）；
 *  - 否则 `degraded === false`（**有效配置 或 空值**）→ **解锁**（版本 ≤ 当前；
 *    空值亦解锁，以放行「首开 provision 默认模板」与「他人清空后本端重配」）；
 *  - 其余（`degraded === true`：非法 JSON / 校验和不匹配 / 迁移失败，且非升版）→
 *    **保持原标记不变**（fail-safe：宁可保持只读，绝不因不可信载荷而放行写入，
 *    以免覆盖可能存在的更高版本配置）。
 *
 * 依据 `resolveLoadedConfig` 的约定：`degraded === true` 时 `config` 必为 `null`；
 * 而「空值」分支恒 `degraded === false`（见其 L195-197 与 L200-209 / L223-230）。
 * 故 `!degraded` 精确等价于「有效 或 空值」，不会把「空值」误判为「损坏」。
 */
export function refreshReadOnlyFromPayload(
  readOnlyViews: Set<string>,
  viewId: string,
  result: LoadResult,
): void {
  if (result.unsupportedNewer) {
    readOnlyViews.add(viewId);
  } else if (!result.degraded) {
    readOnlyViews.delete(viewId);
  }
}
