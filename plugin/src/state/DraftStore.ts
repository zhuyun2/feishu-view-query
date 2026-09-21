/**
 * 草稿状态（设计文档 §9：`DraftStore` = 草稿 **card / doc 两条独立分支** + 快照栈 + dirty 标记）。
 *
 * 冻结口径（03 §9 / §10）：
 *  - 卡片排版与文档排版的草稿**互不影响**；「取消」只丢弃当前模式的草稿；
 *  - 「保存」提交两者 —— 保持一次保存写入完整 `CardViewConfig`；
 *  - 额外承载主题 / 密度 / 条件高亮（同属一次保存的提交内容；属对 §9 的**扩展**，非语义变更）。
 */
import { create } from 'zustand';
import type {
  CardLayoutConfig,
  CardViewConfig,
  DensityConfig,
  DocTemplate,
  HighlightRule,
  StyleTheme,
} from '@/config/types';

export type EditorMode = 'card' | 'doc';

/** 一次快照（用于「实时预览」期间的撤销 / 回滚） */
export interface DraftSnapshot {
  cardDraft: CardLayoutConfig;
  docDraft: DocTemplate;
  themeDraft: StyleTheme;
  densityDraft: DensityConfig;
  highlightDraft: HighlightRule[];
}

/** 配置为纯 JSON 结构，深拷贝走 JSON 往返即可（避免共享引用导致草稿污染基准） */
export function cloneDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  return {
    ...base,
    card: state.cardDraft ?? base.card,
    detail: { ...base.detail, doc: state.docDraft ?? base.detail.doc },
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
        detail: { ...base.detail, doc: state.docDraft ?? base.detail.doc },
        theme: state.themeDraft ?? base.theme,
        density: state.densityDraft ?? base.density,
        highlightRules: state.highlightDraft,
      }
    );
  },

  isDirty: () => get().dirty,
}));
