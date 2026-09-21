/**
 * 空态 / 异常态（T13）：覆盖 **PRD §6.5 九类 + 03 §12 新增五类**。
 *
 * 设计原则：
 *  - 文案集中在 `EMPTY_STATE_SPECS`（**纯数据**），组件只做渲染 → 便于单测穷举与文案评审；
 *  - 每类状态给出「标题 / 说明 / 语义色 / 可选动作」，动作由调用方注入 handler（组件不直连 store，可测）；
 *  - 所有文案均为**人可见描述**，绝不包含原始 ID / JSON。
 */
import type { ReactNode } from 'react';

export type EmptyStateKind =
  /* ===== PRD §6.5 九类 ===== */
  /** 1. 视图为空（无记录） */
  | 'noRecords'
  /** 2. 视图无可用字段（字段权限受限 / 未配置） */
  | 'noFields'
  /** 3. 搜索无结果 */
  | 'searchEmpty'
  /** 4. 筛选无结果 */
  | 'filterEmpty'
  /** 5. 配置尚未就绪 */
  | 'configPending'
  /** 6. 无编辑权限 */
  | 'noPermission'
  /** 7. 引用的字段已被删除 */
  | 'fieldDeleted'
  /** 8. 字段类型不支持 */
  | 'fieldUnsupported'
  /** 9. 更高版本只读 */
  | 'unsupportedNewer'
  /* ===== 03 §12 新增五类 ===== */
  /** 10. 配置数据损坏 → 回退默认模板（source 不切介质） */
  | 'configCorrupted'
  /** 11. 存储介质降级（仅本地保存） */
  | 'storageDegraded'
  /** 12. 分页失败 → 单页长文档降级 */
  | 'paginationFailed'
  /** 13. 记录字段读取失败 */
  | 'fieldReadFailed'
  /** 14. 初始化 / 网络失败 */
  | 'initFailed';

export type EmptyStateTone = 'neutral' | 'info' | 'warning' | 'error';

export interface EmptyStateAction {
  /** 动作文案 */
  label: string;
  /** 语义（主按钮 / 次按钮） */
  kind: 'primary' | 'secondary';
}

export interface EmptyStateSpec {
  kind: EmptyStateKind;
  /** 图标（单字形，避免引入图标库） */
  icon: string;
  tone: EmptyStateTone;
  title: string;
  desc: string;
  /** 可选动作（0~2 个） */
  actions: EmptyStateAction[];
}

/** 状态目录（唯一文案来源） */
export const EMPTY_STATE_SPECS: Readonly<Record<EmptyStateKind, EmptyStateSpec>> = {
  noRecords: {
    kind: 'noRecords',
    icon: '📄',
    tone: 'neutral',
    title: '暂无记录',
    desc: '该视图在当前筛选条件下没有可见记录。可新增记录，或调整视图筛选。',
    actions: [],
  },
  noFields: {
    kind: 'noFields',
    icon: '🧩',
    tone: 'warning',
    title: '当前视图暂无可用字段',
    desc: '请检查字段权限，或在该视图中添加字段后重试。',
    actions: [{ label: '重试', kind: 'secondary' }],
  },
  searchEmpty: {
    kind: 'searchEmpty',
    icon: '🔍',
    tone: 'neutral',
    title: '没有匹配的记录',
    desc: '没有找到与关键词匹配的记录，换个关键词试试。',
    actions: [{ label: '清空搜索', kind: 'secondary' }],
  },
  filterEmpty: {
    kind: 'filterEmpty',
    icon: '🧮',
    tone: 'neutral',
    title: '当前筛选无结果',
    desc: '没有记录满足当前筛选条件，可调整或清空筛选。',
    actions: [{ label: '清空筛选', kind: 'secondary' }],
  },
  configPending: {
    kind: 'configPending',
    icon: '⏳',
    tone: 'info',
    title: '配置尚未就绪',
    desc: '正在准备卡片排版配置，请稍候。',
    actions: [],
  },
  noPermission: {
    kind: 'noPermission',
    icon: '🔒',
    tone: 'warning',
    title: '仅可查看',
    desc: '你当前没有该视图的编辑权限，可正常浏览，但无法修改排版配置。',
    actions: [],
  },
  fieldDeleted: {
    kind: 'fieldDeleted',
    icon: '⚠',
    tone: 'warning',
    title: '部分字段已被删除',
    desc: '排版中引用的字段已被删除，已自动隐藏。可进入配置态移除对应字段。',
    actions: [{ label: '立即配置', kind: 'primary' }],
  },
  fieldUnsupported: {
    kind: 'fieldUnsupported',
    icon: '⛔',
    tone: 'warning',
    title: '存在暂不支持的字段类型',
    desc: '这些字段无法在卡片中呈现，已安全降级显示；不影响其他字段。',
    actions: [{ label: '立即配置', kind: 'primary' }],
  },
  unsupportedNewer: {
    kind: 'unsupportedNewer',
    icon: '🔒',
    tone: 'warning',
    title: '配置版本过高，已进入只读模式',
    desc: '该配置由更高版本的插件创建。为避免覆盖较新数据，当前仅支持只读浏览。',
    actions: [],
  },
  configCorrupted: {
    kind: 'configCorrupted',
    icon: '🧯',
    tone: 'error',
    title: '配置数据损坏，已回退默认排版',
    desc: '检测到配置损坏，已使用默认模板呈现，并保留了原始数据备份。可重新配置。',
    actions: [
      { label: '重新配置', kind: 'primary' },
      { label: '重试读取', kind: 'secondary' },
    ],
  },
  storageDegraded: {
    kind: 'storageDegraded',
    icon: '💾',
    tone: 'warning',
    title: '配置仅本地保存',
    desc: '当前无法与云端同步，排版配置只会保存在本机，其他成员看不到你的排版。',
    actions: [],
  },
  paginationFailed: {
    kind: 'paginationFailed',
    icon: '📃',
    tone: 'warning',
    title: '分页失败，已按单页长文档展示',
    desc: '自动分页未成功，已退化为单页长文档，内容不丢失。',
    actions: [{ label: '重试分页', kind: 'secondary' }],
  },
  fieldReadFailed: {
    kind: 'fieldReadFailed',
    icon: '⚠',
    tone: 'warning',
    title: '部分字段读取失败',
    desc: '个别字段暂时无法读取，已安全留空，不影响其他内容。',
    actions: [{ label: '重试', kind: 'secondary' }],
  },
  initFailed: {
    kind: 'initFailed',
    icon: '🔌',
    tone: 'error',
    title: '加载失败',
    desc: '初始化视图数据时出错。请检查网络后重试。',
    actions: [{ label: '重试', kind: 'primary' }],
  },
};

/** 供单测 / 组件清单穷举 */
export const EMPTY_STATE_KINDS = Object.keys(EMPTY_STATE_SPECS) as EmptyStateKind[];

/** 取某状态规格（未知 kind → initFailed，保证永不返回 undefined） */
export function resolveEmptyState(kind: EmptyStateKind): EmptyStateSpec {
  return EMPTY_STATE_SPECS[kind] ?? EMPTY_STATE_SPECS.initFailed;
}

export interface EmptyStateProps {
  kind: EmptyStateKind;
  /** 覆盖标题 / 说明（如带上具体的筛选关键词） */
  titleOverride?: string;
  descOverride?: string;
  /** 动作点击（label → handler；未提供的动作不渲染） */
  onAction?: (label: string) => void;
  /** 额外内容（如「立即配置」等自定义节点） */
  children?: ReactNode;
}

export function EmptyState({ kind, titleOverride, descOverride, onAction, children }: EmptyStateProps): JSX.Element {
  const spec = resolveEmptyState(kind);
  return (
    <div className={`cbv-state cbv-empty cbv-empty--${spec.tone}`} data-empty-kind={spec.kind} role="status">
      <div className="cbv-empty__icon" aria-hidden="true">
        {spec.icon}
      </div>
      <div className="cbv-state__title">{titleOverride ?? spec.title}</div>
      <div className="cbv-state__desc">{descOverride ?? spec.desc}</div>
      {spec.actions.length > 0 && onAction ? (
        <div className="cbv-empty__actions">
          {spec.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.kind === 'primary' ? 'cbv-btn cbv-btn--primary' : 'cbv-btn'}
              onClick={() => onAction(action.label)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}
