/**
 * 运行期 UI 状态（设计文档 §9：`UiStore` 抽屉 / 浮层 / 缩放 / 翻页 / 编辑模式 / 提示条）。
 *
 * ⚠️ 全部为**运行期状态**，不持久化、不进入配置模型（`editMode` 亦非配置项，见 03 §10）。
 */
import { create } from 'zustand';
import type { DensityConfig } from '@/config/types';
import { defaultDensity, defaultDrawerConfig } from '@/config/defaults';
import type { EditorMode } from './DraftStore';

/** 悬浮预览锚点（卡片的视口矩形；气泡据此定位并做溢出翻转） */
export interface HoverAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HoverUiState {
  recordId: string | null;
  anchor: HoverAnchor | null;
}

export interface DrawerUiState {
  open: boolean;
  recordId: string | null;
  /** 当前宽度（R2：默认 860；可拖 560 ~ 视口宽） */
  widthPx: number;
  fullscreen: boolean;
  zoom: number;
  fitToWidth: boolean;
  currentPage: number;
  totalPages: number;
  /** 分页边界提示（浏览态默认关、编辑态默认开；M3 文档引擎接管具体渲染） */
  showBoundary: boolean;
  /** 分页计算中（M3 使用；M2 仅占位保持状态机完整） */
  paginating: boolean;
  /** 分页失败 → 单页长文档降级 */
  paginationFailed: boolean;
}

export interface UiState {
  /** 是否为编辑态（沉浸式三栏，卡片墙隐藏 R6） */
  editorOpen: boolean;
  editMode: EditorMode;

  drawer: DrawerUiState;
  hover: HoverUiState;

  /** R7：D4 复制视图首开提示「本会话不再提示」 */
  copyBannerDismissed: boolean;
  /** 轻提示（保存成功 toast 等） */
  toast: string | null;
  /** 工具栏搜索关键词（对**已加载记录**做客户端过滤） */
  searchQuery: string;

  openEditor(mode?: EditorMode): void;
  closeEditor(): void;
  setEditMode(mode: EditorMode): void;

  openDrawer(recordId: string): void;
  closeDrawer(): void;
  setDrawerWidth(widthPx: number): void;
  toggleFullscreen(): void;
  setDrawerZoom(zoom: number): void;
  setFitToWidth(fit: boolean): void;
  setCurrentPage(page: number): void;
  setTotalPages(total: number): void;
  setShowBoundary(show: boolean): void;
  setPaginating(paginating: boolean): void;
  setPaginationFailed(failed: boolean): void;

  setHover(recordId: string, anchor: HoverAnchor): void;
  clearHover(): void;

  dismissCopyBanner(): void;
  showToast(message: string | null): void;
  setSearchQuery(query: string): void;
}

/** 从配置解析抽屉初始状态（容错：缺失字段走默认） */
export function initialDrawerState(config: DensityConfig | null | undefined): DrawerUiState {
  void config;
  const drawer = defaultDrawerConfig();
  return {
    open: false,
    recordId: null,
    widthPx: drawer.defaultWidthPx,
    fullscreen: false,
    zoom: drawer.defaultZoom,
    fitToWidth: drawer.defaultFitToWidth,
    currentPage: 0,
    totalPages: 1,
    showBoundary: false,
    paginating: false,
    paginationFailed: false,
  };
}

export const DRAWER_MIN_WIDTH_PX = 560;
/** R2 冻结：抽屉内容缩放下限 0.75（低于此值正文不可读） */
export const DRAWER_ZOOM_MIN = 0.75;
export const DRAWER_ZOOM_MAX = 1.5;

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(zoom, DRAWER_ZOOM_MIN), DRAWER_ZOOM_MAX);
}

export const useUiStore = create<UiState>((set, get) => ({
  editorOpen: false,
  editMode: 'card',

  drawer: initialDrawerState(defaultDensity()),
  hover: { recordId: null, anchor: null },

  copyBannerDismissed: false,
  toast: null,
  searchQuery: '',

  openEditor: (mode = 'card') => set({ editorOpen: true, editMode: mode }),
  closeEditor: () => set({ editorOpen: false }),
  setEditMode: (mode) => set({ editMode: mode }),

  openDrawer: (recordId) =>
    set((state) => ({
      drawer: { ...state.drawer, open: true, recordId, currentPage: 0 },
      hover: { recordId: null, anchor: null },
    })),

  closeDrawer: () =>
    set((state) => ({
      drawer: { ...state.drawer, open: false, fullscreen: false, currentPage: 0, paginationFailed: false },
    })),

  setDrawerWidth: (widthPx) =>
    set((state) => {
      const max = typeof window !== 'undefined' ? window.innerWidth : 1920;
      const next = Math.min(Math.max(widthPx, DRAWER_MIN_WIDTH_PX), max);
      return { drawer: { ...state.drawer, widthPx: next, fullscreen: false } };
    }),

  toggleFullscreen: () =>
    set((state) => ({ drawer: { ...state.drawer, fullscreen: !state.drawer.fullscreen } })),

  setDrawerZoom: (zoom) => set((state) => ({ drawer: { ...state.drawer, zoom: clampZoom(zoom), fitToWidth: false } })),

  setFitToWidth: (fit) => set((state) => ({ drawer: { ...state.drawer, fitToWidth: fit } })),

  setCurrentPage: (page) =>
    set((state) => ({ drawer: { ...state.drawer, currentPage: Math.max(0, Math.round(page)) } })),

  setTotalPages: (total) =>
    set((state) => ({ drawer: { ...state.drawer, totalPages: Math.max(1, Math.round(total)) } })),

  setShowBoundary: (show) => set((state) => ({ drawer: { ...state.drawer, showBoundary: show } })),

  setPaginating: (paginating) => set((state) => ({ drawer: { ...state.drawer, paginating } })),

  setPaginationFailed: (failed) =>
    set((state) => ({ drawer: { ...state.drawer, paginationFailed: failed } })),

  setHover: (recordId, anchor) => set({ hover: { recordId, anchor } }),
  clearHover: () => {
    if (get().hover.recordId === null) return;
    set({ hover: { recordId: null, anchor: null } });
  },

  dismissCopyBanner: () => set({ copyBannerDismissed: true }),
  showToast: (message) => set({ toast: message }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
