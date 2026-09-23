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

  const [pagedDoc, setPagedDoc] = useState<PagedDocument>(emptyPagedDocument);
  /** 字体迟到就绪后的重算触发（仅递增，不参与计算） */
  const [fontEpoch, setFontEpoch] = useState(0);

  // 最新 deps（ref 持有，避免因 deps 对象身份变化反复重跑）
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  /** 运行序号：每次 effect 重跑自增；过期链路据此自我作废（守卫 ①） */
  const runSeqRef = useRef(0);
  /** 是否已安排「字体就绪重算」（防重复订阅） */
  const fontPendingRef = useRef(false);

  const fieldsById = useMemo(() => indexFields(fields), [fields]);

  const resolvedBlocks = useMemo<ResolvedBlock[]>(
    () => (enabled ? resolveBlocks({ blocks: template?.blocks ?? [], record, fields, locale }) : []),
    [enabled, template, record, fields, locale],
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
