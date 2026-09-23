/**
 * 草稿状态（设计文档 §9：`DraftStore` = 草稿 **card / doc 两条独立分支** + 快照栈 + dirty 标记）。
 *
 * 冻结口径（03 §9 / §10）：
 *  - 卡片排版与文档排版的草稿**互不影响**；「取消」只丢弃当前模式的草稿；
 *  - 「保存」提交两者 —— 保持一次保存写入完整 `CardViewConfig`；
 *  - 额外承载主题 / 密度 / 条件高亮（同属一次保存的提交内容；属对 §9 的**扩展**，非语义变更）。
 *  - 另承载「模板来源」`docSourceDraft` 与「导入的 docx」`importedDocxDraft`（同属 doc 分支的一次保存
 *    提交内容）。⭐ 二者与 `docDraft` **解耦**：切换来源只改来源、上传模板只改模板，
 *    **任一操作都不清空对方**（本项目既有原则：保留的字段不得被新代码顺手清掉）。
 */
import { create } from 'zustand';
import type {
  CardLayoutConfig,
  CardViewConfig,
  DensityConfig,
  DocTemplate,
  HighlightRule,
  ImportedDocx,
  StyleTheme,
} from '@/config/types';

export type EditorMode = 'card' | 'doc';

/** 「模板来源」草稿值（与 `DetailConfig['docSource']` 同构；`undefined` = 旧配置缺省） */
export type DocSourceDraft = 'blocks' | 'imported' | undefined;

/** 一次快照（用于「实时预览」期间的撤销 / 回滚） */
export interface DraftSnapshot {
  cardDraft: CardLayoutConfig;
  docDraft: DocTemplate;
  themeDraft: StyleTheme;
  densityDraft: DensityConfig;
  highlightDraft: HighlightRule[];
  /** 「模板来源」与已导入模板也进快照 —— 否则「撤销」会把上传的模板连同来源一起丢回旧值 */
  docSourceDraft: DocSourceDraft;
  importedDocxDraft: ImportedDocx | undefined;
}

/** 配置为纯 JSON 结构，深拷贝走 JSON 往返即可（避免共享引用导致草稿污染基准） */
export function cloneDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 深拷贝**可选**值。
 *
 * ⚠️ 不能直接 `cloneDraft(undefined)`：`JSON.stringify(undefined)` 返回 `undefined`（非字符串），
 * `JSON.parse(undefined)` 会抛 `SyntaxError`。`importedDocxDraft` 在未上传时正是 `undefined`，
 * 故此处显式短路。
 */
export function cloneDraftOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneDraft(value);
}

export interface DraftState {
  active: boolean;
  editMode: EditorMode;

  /** 进入编辑态时的基准配置副本（用于 dirty 判定与「取消」回滚） */
  base: CardViewConfig | null;

  cardDraft: CardLayoutConfig | null;
  docDraft: DocTemplate | null;
  themeDraft: StyleTheme | null;
  densityDraft: DensityConfig | null;
  highlightDraft: HighlightRule[];

  /**
   * ⭐ 「模板来源」草稿（对应 `DetailConfig.docSource`）。
   *
   * 语义（**「保留字段不得被顺手清掉」**，本项目既有事故教训——保存筛选时把卡片排版抹掉）：
   *  - 切换来源**只改本字段**，**绝不动** {@link importedDocxDraft}；
   *  - 编辑纸张 / 主题 / 区块等其它设置时本字段与 {@link importedDocxDraft} 同样保持不动。
   */
  docSourceDraft: DocSourceDraft;
  /** ⭐ 导入的 docx 模板草稿（对应 `DetailConfig.importedDocx`）；切回 `'blocks'` **不得清空** */
  importedDocxDraft: ImportedDocx | undefined;

  snapshotStack: DraftSnapshot[];
  dirty: boolean;

  open(config: CardViewConfig, mode?: EditorMode): void;
  close(): void;
  setEditMode(mode: EditorMode): void;

  updateCard(updater: (draft: CardLayoutConfig) => CardLayoutConfig): void;
  updateDoc(updater: (draft: DocTemplate) => DocTemplate): void;
  setTheme(theme: StyleTheme): void;
  setDensity(density: DensityConfig): void;
  setHighlightRules(rules: HighlightRule[]): void;
  /** ⭐ 切换「模板来源」——**只改来源**，保留 `importedDocxDraft` */
  setDocSource(source: Exclude<DocSourceDraft, undefined>): void;
  /** ⭐ 写入导入的模板（上传成功时调用）；**不触碰** `docSourceDraft` */
  setImportedDocx(imported: ImportedDocx): void;

  snapshot(): void;
  rollback(): boolean;
  discard(): void;

  buildConfig(base: CardViewConfig): CardViewConfig;
  isDirty(): boolean;
}

function currentSnapshot(state: DraftState): DraftSnapshot | null {
  if (!state.cardDraft || !state.docDraft || !state.themeDraft || !state.densityDraft) return null;
  return {
    cardDraft: cloneDraft(state.cardDraft),
    docDraft: cloneDraft(state.docDraft),
    themeDraft: cloneDraft(state.themeDraft),
    densityDraft: cloneDraft(state.densityDraft),
    highlightDraft: cloneDraft(state.highlightDraft),
    docSourceDraft: state.docSourceDraft,
    importedDocxDraft: cloneDraftOptional(state.importedDocxDraft),
  };
}

function computeDirty(state: DraftState): boolean {
  if (!state.base || !state.cardDraft || !state.docDraft) return false;
  const built = buildFromState(state);
  return JSON.stringify(built) !== JSON.stringify(state.base);
}

function buildFromState(state: DraftState): CardViewConfig | null {
  if (!state.base) return null;
  const { base } = state;
  const docSource = state.docSourceDraft ?? base.detail.docSource;
  const importedDocx = state.importedDocxDraft ?? base.detail.importedDocx;
  return {
    ...base,
    card: state.cardDraft ?? base.card,
    detail: {
      ...base.detail,
      doc: state.docDraft ?? base.detail.doc,
      // ⭐ 来源与模板**只随草稿变化**：切换来源不清空模板；编辑其它设置也不清空模板。
      //    用 `?? base` 兜底，确保「保留字段」绝不被顺手抹成 undefined。
      docSource,
      importedDocx,
    },
    theme: state.themeDraft ?? base.theme,
    density: state.densityDraft ?? base.density,
    highlightRules: state.highlightDraft,
  };
}

export const useDraftStore = create<DraftState>((set, get) => ({
  active: false,
  editMode: 'card',
  base: null,
  cardDraft: null,
  docDraft: null,
  themeDraft: null,
  densityDraft: null,
  highlightDraft: [],
  docSourceDraft: undefined,
  importedDocxDraft: undefined,
  snapshotStack: [],
  dirty: false,

  open: (config, mode = 'card') =>
    set({
      active: true,
      editMode: mode,
      base: cloneDraft(config),
      cardDraft: cloneDraft(config.card),
      docDraft: cloneDraft(config.detail.doc),
      themeDraft: cloneDraft(config.theme),
      densityDraft: cloneDraft(config.density),
      highlightDraft: cloneDraft(config.highlightRules),
      docSourceDraft: config.detail.docSource,
      importedDocxDraft: cloneDraftOptional(config.detail.importedDocx),
      snapshotStack: [],
      dirty: false,
    }),

  close: () =>
    set({
      active: false,
      base: null,
      cardDraft: null,
      docDraft: null,
      themeDraft: null,
      densityDraft: null,
      highlightDraft: [],
      docSourceDraft: undefined,
      importedDocxDraft: undefined,
      snapshotStack: [],
      dirty: false,
    }),

  setEditMode: (mode) => set({ editMode: mode }),

  updateCard: (updater) =>
    set((state) => {
      if (!state.cardDraft) return state;
      const next = updater(cloneDraft(state.cardDraft));
      const merged: DraftState = { ...state, cardDraft: next };
      return { cardDraft: next, dirty: computeDirty(merged) };
    }),

  updateDoc: (updater) =>
    set((state) => {
      if (!state.docDraft) return state;
      const next = updater(cloneDraft(state.docDraft));
      const merged: DraftState = { ...state, docDraft: next };
      return { docDraft: next, dirty: computeDirty(merged) };
    }),

  setTheme: (theme) =>
    set((state) => {
      const merged: DraftState = { ...state, themeDraft: theme };
      return { themeDraft: theme, dirty: computeDirty(merged) };
    }),

  setDensity: (density) =>
    set((state) => {
      const merged: DraftState = { ...state, densityDraft: density };
      return { densityDraft: density, dirty: computeDirty(merged) };
    }),

  setHighlightRules: (rules) =>
    set((state) => {
      const merged: DraftState = { ...state, highlightDraft: rules };
      return { highlightDraft: rules, dirty: computeDirty(merged) };
    }),

  /**
   * ⭐ 切换「模板来源」：**只改 `docSourceDraft`**。
   *
   * 🔴 硬约束：**绝不动 `importedDocxDraft`** —— 用户从「导入 docx」切回「可视化排版」
   * 再切回来时，已上传的模板必须还在。这是本项目既有原则「保留的字段不得被新代码顺手清掉」
   * 在模板来源上的落地（曾经出过「保存筛选时把卡片排版抹掉」的事故）。
   */
  setDocSource: (source) =>
    set((state) => {
      const merged: DraftState = { ...state, docSourceDraft: source };
      return { docSourceDraft: source, dirty: computeDirty(merged) };
    }),

  /**
   * ⭐ 写入导入的模板（上传成功后调用）：**只改 `importedDocxDraft`**，不触碰 `docSourceDraft`。
   *
   * 与 {@link DraftState.setDocSource} 一样，编辑纸张 / 主题 / 区块等其它设置时本字段同样保持不动。
   */
  setImportedDocx: (imported) =>
    set((state) => {
      const merged: DraftState = { ...state, importedDocxDraft: imported };
      return { importedDocxDraft: imported, dirty: computeDirty(merged) };
    }),

  snapshot: () =>
    set((state) => {
      const snap = currentSnapshot(state);
      if (!snap) return state;
      const stack = [...state.snapshotStack, snap];
      if (stack.length > 50) stack.shift();
      return { snapshotStack: stack };
    }),

  rollback: () => {
    const state = get();
    if (state.snapshotStack.length === 0) return false;
    const stack = [...state.snapshotStack];
    const last = stack.pop() as DraftSnapshot;
    set((current) => {
      const merged: DraftState = {
        ...current,
        cardDraft: last.cardDraft,
        docDraft: last.docDraft,
        themeDraft: last.themeDraft,
        densityDraft: last.densityDraft,
        highlightDraft: last.highlightDraft,
        docSourceDraft: last.docSourceDraft,
        importedDocxDraft: last.importedDocxDraft,
        snapshotStack: stack,
      };
      return { ...merged, dirty: computeDirty(merged) };
    });
    return true;
  },

  /** 「取消 / 放弃修改」：回滚到进入编辑态时的基准 */
  discard: () =>
    set((state) => {
      if (!state.base) return state;
      const base = state.base;
      return {
        cardDraft: cloneDraft(base.card),
        docDraft: cloneDraft(base.detail.doc),
        themeDraft: cloneDraft(base.theme),
        densityDraft: cloneDraft(base.density),
        highlightDraft: cloneDraft(base.highlightRules),
        docSourceDraft: base.detail.docSource,
        importedDocxDraft: cloneDraftOptional(base.detail.importedDocx),
        snapshotStack: [],
        dirty: false,
      };
    }),

  buildConfig: (base) => {
    const state = get();
    return (
      buildFromState({ ...state, base }) ?? {
        ...base,
        card: state.cardDraft ?? base.card,
        detail: {
          ...base.detail,
          doc: state.docDraft ?? base.detail.doc,
          docSource: state.docSourceDraft ?? base.detail.docSource,
          importedDocx: state.importedDocxDraft ?? base.detail.importedDocx,
        },
        theme: state.themeDraft ?? base.theme,
        density: state.densityDraft ?? base.density,
        highlightRules: state.highlightDraft,
      }
    );
  },

  isDirty: () => get().dirty,
}));
