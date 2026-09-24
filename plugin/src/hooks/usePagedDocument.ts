/**
 * 详情文档编排 hook（设计文档 §21.2 / §21.12 / M3-T07；2026-09-21 **设计变更**）。
 *
 * ⭐ 设计变更（用户拍板）：详情从「A4 分页预览」改为「**单张连续长页**」。
 *   分页装箱 / 离屏测量 / 纸页虚拟化**全部移除**，本 hook 只保留 **resolve** 一步：
 *
 * ```
 * DocTemplate + record + fields (+locale)
 *   │ resolveBlocks()                     ← doc/resolve（纯函数：求值/过滤/哈希）
 *   ▼ ResolvedBlock[]
 *   │ buildSinglePageDocument()           ← 组装「单页」产物（所有区块同页、不切分）
 *   ▼ PagedDocument { pages:[一页], totalPages:0|1, fontReady, degraded:false }
 *   ▼ 详情抽屉用 <DocPreview/> 渲染（单张 .cbv-paper，高度随内容增长；外层滚动）
 * ```
 *
 * ⭐ 两处**必须守住**的工程点（否则是「用户看得见但不报错」的静默故障）：
 *  1. **过期响应不得覆盖新记录**：记录切换（点另一张卡片）时，上一个记录的异步链路必须被忽略
 *     （`runSeqRef` + `cancelled` **双守卫**）。若不守，用户快速点卡片会看到**错记录的详情**且不报错。
 *     ⚠️ 双守卫意味着「只删一处」不一定变红，改动时勿以「测试绿了」为据。
 *  2. **字体就绪**：不再测量后，字体与「版式正确性」已解耦（浏览器自行回流）；此处**仍保留**
 *     `await document.fonts.ready`（超时 3s，不卡死）——它现在是（a）保证「过期响应守卫」拥有
 *     真实异步窗口、可被注入测试；（b）避免 web font 迟到时正文首屏出现换行闪动（content width 固定，
 *     但字宽度量变化会重排）。超时/失败**不卡死**：继续出结果，`fontReady=false`，且字体迟到就绪后
 *     自动重算一次。⚠️ 刻意**不**置 `degraded`（单页长文档下「降级」概念已不成立）。
 *
 * 分层：本文件位于 `hooks/`（最上层），允许同时 import `doc/`、`components/doc/`；
 * 反之则被禁止（`pagination/` 不得 import `components/`，§21.9）。
 *
 * ⚠️ **兼容性说明（刻意保留的惰性 API 面）**：`UsePagedDocumentDeps` 的 `measurer` / `renderHost`
 * 与 `UsePagedDocumentResult.pagedDoc`（现恒为「单页」形态）、`toEngineBlock` 均**不再参与生产链路**，
 * 仅用于保持既有测试与调用方的编译期兼容（不得据此认为分页仍在运行）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocTemplate, DocTheme, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type { Measurer, PagedDocument, PagedItem } from '@/pagination/types';
import type { EngineBlock } from '@/pagination/engine';
import { getContentBox } from '@/constants/paper';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { resolveBlocks, type ResolvedBlock } from '@/doc/resolve';
import { prefetchLinkTables } from '@/doc/linkTable';
import type { LinkTable, LinkTablePrefetchAccess, LinkTablePrefetchDeps } from '@/doc/linkTable';
import { logError, logWarn } from '@/utils/log';

/** 字体就绪等待上限 ms（§13.2 与 §21.10-⑦ 的 3s 统一口径） */
export const FONT_READY_TIMEOUT_MS = 3000;

/** 离屏宿主渲染上下文（**遗留类型**：单页长页后不再渲染离屏宿主，仅为 `RenderPagedHost` 形参保留） */
export interface PagedHostContext {
  theme: DocTheme;
  locale: string;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  contentWidth: number;
}

/**
 * 离屏宿主渲染器（**遗留类型**：单页长页后不再使用；仅为 `UsePagedDocumentDeps.renderHost` 保留）。
 * @deprecated 详情已改为单张连续长页，不再做离屏测量。
 */
export type RenderPagedHost = (
  host: HTMLElement,
  blocks: ReadonlyArray<ResolvedBlock>,
  ctx: PagedHostContext,
) => () => void;

/**
 * 可注入的编排依赖（缺省全部走生产实现；测试据此获得确定性）。
 *
 * ⚠️ `measurer` / `renderHost` 为**惰性遗留**：单页长页后不再被读取，仅为兼容既有测试注入而保留。
 */
export interface UsePagedDocumentDeps {
  /** @deprecated 单页长页后不再测量；保留仅为兼容既有测试注入。 */
  measurer?: Measurer;
  /** 字体就绪等待；缺省 `document.fonts.ready` + 3s 超时。返回 false = 未就绪（不阻塞出结果） */
  awaitFonts?: () => Promise<boolean>;
  /** @deprecated 单页长页后不再渲染离屏宿主；保留仅为兼容既有测试注入。 */
  renderHost?: RenderPagedHost;
  /**
   * ⭐ 需求 2：关联字段（`Link` / `DuplexLink`）只读表格的**预取依赖**。
   *
   * 缺省（不传）→ 走生产实现：动态 import `@/sdk/linkedRecords`，按 `tableId` 解析只读访问能力。
   * 注入后（测试）**完全不会加载 SDK**，并可用可控 stub 精确断言时序（过期守卫）与值。
   * 生产/注入两种情况下，预取都**只读**、并发受信号量约束、失败一律降级（不抛）。
   */
  linkSource?: LinkTablePrefetchDeps;
  /** 错误出口（默认 `logError`） */
  onError?: (scope: string, err: unknown, ctx?: Record<string, unknown>) => void;
}

export interface UsePagedDocumentArgs {
  /** 文档模板（`config.detail.doc`）；null → 空文档 */
  template: DocTemplate | null;
  /** 当前记录（null → 空文档） */
  record: SdkRecord | null;
  /** 当前记录 id（过期响应判定的语义键；可与 record 并存） */
  recordId: string | null;
  /** 当前视图字段元数据 */
  fields: ReadonlyArray<FieldMetaLite>;
  /** 语言环境（参与 resolve 的 payloadHash） */
  locale: string;
  /**
   * 当前表格 id（生产由 `env.tableId` 传入）。
   *
   * ⚠️ 仅用于需求 2 的**关联表格预取**：解析目标表句柄必须先知道「当前是哪张表」。
   * 缺省 / 空 → 不预取（块路径完全不受影响）。
   */
  tableId?: string | null;
  /** 是否启用（抽屉未打开 / 无记录时 false → 不复位、置空产物） */
  enabled: boolean;
  /** 注入依赖（缺省全生产实现；应保持引用稳定） */
  deps?: UsePagedDocumentDeps;
}

export interface UsePagedDocumentResult {
  /** 单页产物（驱动 `<DocPreview/>`）：`totalPages` ∈ {0, 1}；`pages[0].items` 即全部区块 */
  pagedDoc: PagedDocument;
  /** 已求值区块（有序；值/标签/图片/表格行均已解析） */
  resolvedBlocks: ResolvedBlock[];
  /** `blockId → ResolvedBlock`（`<DocPaper/>` 按 blockId 取块） */
  blocksById: Record<string, ResolvedBlock>;
  /** 内容盒宽度 px（= `getContentBox().width`，供渲染层换算列宽） */
  contentWidth: number;
  /** 生效的页面设置（含默认回退，保证非空） */
  pageSetup: PageSetup;
  /** 生效的文档主题（含默认回退，保证非空） */
  theme: DocTheme;
  /** 字体是否已就绪（= `pagedDoc.fontReady`） */
  fontReady: boolean;
}

/** 空文档产物（`totalPages = 0` → 渲染层出空态） */
export function emptyPagedDocument(): PagedDocument {
  return { pages: [], totalPages: 0, fontReady: true, degraded: false };
}

/** 共享的空关联表格表（**稳定引用**，避免「无关联数据」时每轮渲染都换新 Map 触发重算） */
const EMPTY_LINK_TABLE_MAP: ReadonlyMap<string, LinkTable> = new Map<string, LinkTable>();

/**
 * 生产缺省的关联表格只读访问能力解析器。
 *
 * ⚠️ **动态 import `@/sdk/linkedRecords`**（与 `useImportedDoc.resolveSdkCellReader` 同款理由）：
 * 单测注入 `linkSource.resolveAccess` 时本函数根本不会被调用，也就**不会加载 SDK**
 * （jsdom 下加载 SDK 会产生未处理 rejection）。
 */
async function resolveProductionLinkAccess(
  tableId: string | null,
  record: SdkRecord | null,
): Promise<LinkTablePrefetchAccess | null> {
  if (typeof tableId !== 'string' || tableId === '') return null;
  const { resolveSdkLinkTableSource } = await import('@/sdk/linkedRecords');
  const source = await resolveSdkLinkTableSource(tableId, record);
  if (!source) return null;
  return {
    reader: source.reader,
    getTargetFieldMetas: (targetTableId: string) =>
      source.getTargetFieldMetas(targetTableId) as Promise<ReadonlyArray<unknown>>,
    getTargetRow: (targetTableId: string, rowRecordId: string) =>
      source.getTargetRow(targetTableId, rowRecordId),
  };
}

/**
 * 组装「单页」产物：全部区块落在同一页（`pageIndex = 0`），不切分、不装箱。
 * 每个 `PagedItem.height` 恒为 0（单页长页不再依赖测量高度）。
 */
export function buildSinglePageDocument(
  blocks: ReadonlyArray<ResolvedBlock>,
  fontReady: boolean,
): PagedDocument {
  if (blocks.length === 0) return { ...emptyPagedDocument(), fontReady };
  const items: PagedItem[] = blocks.map((block) => ({
    blockId: block.blockId,
    fragmentIndex: 0,
    fragmentsTotal: 1,
    height: 0,
  }));
  return {
    pages: [{ pageIndex: 0, items, usedHeight: 0 }],
    totalPages: 1,
    fontReady,
    degraded: false,
  };
}

/**
 * 默认字体就绪等待：`document.fonts.ready` + 超时。
 * - 无 `FontFaceSet`（如 jsdom）→ 视为已就绪（`true`），不阻塞；
 * - 超时 / ready 拒绝 → `false`（不阻塞出结果），但**绝不**抛出/卡死。
 */
export function awaitDocumentFonts(timeoutMs: number = FONT_READY_TIMEOUT_MS): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(true);
  const fonts = (document as Document & { fonts?: { ready?: unknown } }).fonts;
  const ready = fonts?.ready;
  if (!ready || typeof (ready as PromiseLike<unknown>).then !== 'function') return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FONT_READY_TIMEOUT_MS;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), limit);
    Promise.resolve(ready).then(
      () => {
        clearTimeout(timer);
        finish(true);
      },
      () => {
        clearTimeout(timer);
        finish(false);
      },
    );
  });
}

/** 字段元数据索引（失效/空 id 跳过） */
function indexFields(fields: ReadonlyArray<FieldMetaLite>): Record<string, FieldMetaLite> {
  const map: Record<string, FieldMetaLite> = {};
  for (const field of fields) {
    if (field && typeof field.id === 'string' && field.id !== '') map[field.id] = field;
  }
  return map;
}

/**
 * `ResolvedBlock` → 分页引擎输入（§21.10：blockId / kind / breakInside / payloadHash）。
 * @deprecated 单页长页后不再装箱；保留仅为兼容既有测试（`usePagedDocument.test.tsx`）。
 */
export function toEngineBlock(block: ResolvedBlock): EngineBlock {
  return {
    blockId: block.blockId,
    kind: block.kind,
    breakInside: block.block.breakInside,
    payloadHash: block.payloadHash,
  };
}

/**
 * ⭐ 详情文档编排 hook（单页长页版）。
 *
 * 输入变化（模板 / 记录 / 字段 / locale / enabled）即重跑链路；切换记录时上一个记录的
 * 异步结果被丢弃（不覆盖新记录）。**不再回写** `UiStore.drawer` 的分页字段
 * （`paginating` / `totalPages` / `currentPage` / `paginationFailed`）——这些字段仍在 store 中保留
 * （别处引用），只是详情路径不再驱动它们。
 */
export function usePagedDocument(args: UsePagedDocumentArgs): UsePagedDocumentResult {
  const { template, record, fields, locale, enabled, deps } = args;
  const recordId = args.recordId ?? null;
  const tableId = args.tableId ?? null;

  const [pagedDoc, setPagedDoc] = useState<PagedDocument>(emptyPagedDocument);
  /** 字体迟到就绪后的重算触发（仅递增，不参与计算） */
  const [fontEpoch, setFontEpoch] = useState(0);
  /**
   * ⭐ 需求 2：关联字段 → **预取到的只读表格**（作为**纯输入**注入 `resolveBlocks`）。
   *
   * 初始为空 → 首帧先按「无关联数据」渲染（文本/单据表格回退），预取完成后升级为只读表格。
   * 记录切换时由预取 effect **立即清空**，绝不让上一个记录的表格留在新记录上（见该 effect 注释）。
   */
  const [linkedRecords, setLinkedRecords] = useState<ReadonlyMap<string, LinkTable>>(EMPTY_LINK_TABLE_MAP);

  // 最新 deps（ref 持有，避免因 deps 对象身份变化反复重跑）
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  /** 运行序号：每次 effect 重跑自增；过期链路据此自我作废（守卫 ①） */
  const runSeqRef = useRef(0);
  /** 关联表格预取的**独立**运行序号（与字体链路解耦：两条异步链各有自己的守卫序号） */
  const linkRunSeqRef = useRef(0);
  /** 是否已安排「字体就绪重算」（防重复订阅） */
  const fontPendingRef = useRef(false);

  const fieldsById = useMemo(() => indexFields(fields), [fields]);

  const resolvedBlocks = useMemo<ResolvedBlock[]>(
    () =>
      enabled
        ? resolveBlocks({ blocks: template?.blocks ?? [], record, fields, locale, linkedRecords })
        : [],
    [enabled, template, record, fields, locale, linkedRecords],
  );

  const blocksById = useMemo(() => {
    const map: Record<string, ResolvedBlock> = {};
    for (const block of resolvedBlocks) map[block.blockId] = block;
    return map;
  }, [resolvedBlocks]);

  const pageSetup = useMemo<PageSetup>(() => template?.pageSetup ?? defaultPageSetup(), [template]);
  const theme = useMemo<DocTheme>(() => template?.theme ?? defaultDocTheme(), [template]);
  const contentBox = useMemo(
    () => getContentBox(pageSetup.paper, pageSetup.orientation, pageSetup.margin),
    [pageSetup],
  );
  const contentWidth = contentBox.width;

  /**
   * ⭐ 需求 2：**关联表格预取**（异步 IO 只在此处发生，`resolveBlocks` 保持同步纯函数）。
   *
   * 三条必须守住的工程点（否则是「用户看得见但不报错」的静默故障）：
   *  1. **过期响应不得覆盖新记录**：沿用本项目既有的 `runSeqRef + cancelled` **双守卫**模式
   *     （见 `linkRunSeqRef` / `cancelled` / `active()`）。⚠️ 这里用**独立**的 `linkRunSeqRef`
   *     —— 字体链路与本链路是两条互不相干的异步链，共用一个序号会互相作废（一方重跑把另一方
   *     的进行中结果判为过期）。**双守卫意味着「只删一处」不一定变红，改动时勿以「测试绿了」为据**。
   *  2. **记录切换即清空**：`record` 变化的瞬间**同步**把上一轮的表格清空（`setLinkedRecords`），
   *     绝不出现「新记录配旧关联表」的错配（且不报错）。
   *  3. **失败一律降级**：无 `tableId` / SDK 不可用 / 解析失败 / 预取失败 → 保持空表 →
   *     渲染层回退到既有文本呈现，**不抛错、不白屏**。
   *
   * 依赖数组**不得漏项**：漏 `record` / `recordId` → 切换记录不重取（展示错记录的关联表）；
   * 漏 `template` → 模板改了但关联表没重算；漏 `fields` → 字段类型判定用旧表。
   */
  useEffect(() => {
    // 守卫 ① 的一半：作废上一轮预取
    const seq = linkRunSeqRef.current + 1;
    linkRunSeqRef.current = seq;
    let cancelled = false; // 守卫 ②：本轮被作废（重跑 / 卸载）时置位
    const active = (): boolean => !cancelled && linkRunSeqRef.current === seq;

    // ⭐ 立刻清空：不能让「上一个记录的关联表格」在本轮结果到达前继续显示
    setLinkedRecords((prev) => (prev.size === 0 ? prev : EMPTY_LINK_TABLE_MAP));

    if (!enabled) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const currentDeps = depsRef.current ?? {};
      const onError = currentDeps.onError ?? logError;
      const linkSource = currentDeps.linkSource;

      try {
        const access = linkSource?.resolveAccess
          ? await linkSource.resolveAccess(tableId, record)
          : await resolveProductionLinkAccess(tableId, record);
        if (!active() || !access) return;

        const tables = await prefetchLinkTables({
          blocks: template?.blocks ?? [],
          fields,
          recordId: recordId ?? '',
          access,
          maxRows: linkSource?.maxRows,
          concurrency: linkSource?.concurrency,
          maxLinkFields: linkSource?.maxLinkFields,
          isActive: active,
          onWarn: (scope, message, ctx) => logWarn(scope, message, ctx),
        });
        // ⭐ 过期响应守卫：切换记录后，上一轮的表格**绝不**落到新记录上
        if (!active()) return;
        setLinkedRecords(tables.size === 0 ? EMPTY_LINK_TABLE_MAP : tables);
      } catch (err) {
        // 过期链路的失败同样丢弃（不得用旧错误覆盖新内容）
        if (!active()) return;
        onError('doc.linkTables', err, { step: 'prefetch' });
        // 降级：保持空表（渲染层回退文本呈现），不抛
      }
    })();

    return () => {
      cancelled = true;
    };
    // ⚠️ **不**依赖 `fontEpoch` / `resolvedBlocks`：字体重算与分页产物变化都不需要重取关联数据，
    //    把二者写进来会造成「字体就绪 → 再打一轮关联请求」的白白浪费。
  }, [enabled, template, record, recordId, fields, tableId]);

  useEffect(() => {
    // 作废上一个链路（切换记录 / 关闭 / 重算）
    const seq = runSeqRef.current + 1;
    runSeqRef.current = seq;
    void fontEpoch; // 仅作为「字体就绪重算」的触发依赖

    if (!enabled) {
      setPagedDoc(emptyPagedDocument());
      return;
    }

    let cancelled = false; // 守卫 ②
    const active = (): boolean => !cancelled && runSeqRef.current === seq;

    void (async () => {
      const currentDeps = depsRef.current ?? {};
      const onError = currentDeps.onError ?? logError;
      const awaitFonts = currentDeps.awaitFonts ?? awaitDocumentFonts;

      // ── ① 字体就绪（超时/失败不卡死） ──
      let fontReady = true;
      try {
        fontReady = await awaitFonts();
      } catch (err) {
        fontReady = false;
        onError('doc.fonts', err, { step: 'awaitFonts' });
      }
      if (!active()) return;
      if (!fontReady) {
        logWarn('doc.fonts', '字体未就绪（超时或失败）：首屏可能出现换行闪动，稍后自动重算', {
          timeoutMs: FONT_READY_TIMEOUT_MS,
        });
      }

      // ── ② 组装单页产物（不再测量 / 装箱） ──
      const next = buildSinglePageDocument(resolvedBlocks, fontReady);

      // ⭐ 过期响应守卫：切换记录后，上一个链路的结果**绝不**覆盖新记录
      if (!active()) return;

      setPagedDoc(next);

      // ── ③ 字体迟到就绪 → 自动重算一次（自愈） ──
      if (!fontReady && !fontPendingRef.current) {
        fontPendingRef.current = true;
        const ready = (document as Document & { fonts?: { ready?: unknown } }).fonts?.ready;
        if (ready && typeof (ready as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(ready).then(
            () => {
              fontPendingRef.current = false;
              setFontEpoch((value) => value + 1);
            },
            () => {
              fontPendingRef.current = false;
            },
          );
        } else {
          fontPendingRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, recordId, resolvedBlocks, contentWidth, theme, record, locale, fieldsById, fontEpoch]);

  return {
    pagedDoc,
    resolvedBlocks,
    blocksById,
    contentWidth,
    pageSetup,
    theme,
    fontReady: pagedDoc.fontReady,
  };
}

export default usePagedDocument;
