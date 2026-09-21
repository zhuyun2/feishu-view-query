/**
 * 视图工具栏（T09 / 04 §5 S1）：统一高 48px，8 个元素。
 *
 * 视图名 · 记录数 · 搜索 · 筛选 · 排序 · 刷新 · ⚙ 配置 · ⋯ 更多
 *
 * 口径：
 *  - 搜索为**客户端过滤**（对已加载记录，见 `selectors.filterRecordsByQuery`）；
 *  - 筛选 / 排序**沿用视图原生设置**（D7：`getRecordsByPage` 传 viewId 即遵循原生筛选与排序），
 *    故此处不提供独立排序/筛选器，仅给出说明与「刷新」入口，避免与原生状态冲突；
 *  - ⚙ 配置在无编辑权限或更高版本只读时禁用。
 */
import { useState } from 'react';
import { APP_NAME } from '@/constants';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';

export interface ToolbarProps {
  /** 记录数文案（由 `ViewShell` 统一计算，含筛选态） */
  countLabel: string;
  /** ⚙ 配置入口（进入编辑态） */
  onOpenConfig: () => void;
}

type NotePanel = 'filter' | 'sort' | null;

export function Toolbar({ countLabel, onOpenConfig }: ToolbarProps): JSX.Element {
  const viewName = useViewStore((state) => state.viewName);
  const loadingMore = useViewStore((state) => state.loadingMore);
  const refresh = useViewStore((state) => state.refresh);
  const canEditConfig = useViewStore((state) => state.canEditConfig);
  const unsupportedNewer = useViewStore((state) => state.unsupportedNewer);

  const searchQuery = useUiStore((state) => state.searchQuery);
  const setSearchQuery = useUiStore((state) => state.setSearchQuery);
  const openEditor = useUiStore((state) => state.openEditor);

  const [panel, setPanel] = useState<NotePanel>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const configDisabled = !canEditConfig || unsupportedNewer;

  return (
    <div className="cbv-toolbar" role="toolbar" aria-label={`${APP_NAME} 工具栏`}>
      <span className="cbv-toolbar__title" title={viewName || APP_NAME}>
        {viewName || APP_NAME}
      </span>
      <span className="cbv-toolbar__count cbv-count" data-testid="toolbar-count">
        {countLabel}
      </span>

      <span className="cbv-toolbar__spacer" />

      <label className="cbv-search">
        <span className="cbv-search__icon" aria-hidden="true">
          🔍
        </span>
        <input
          type="search"
          className="cbv-search__input"
          placeholder="搜索记录"
          aria-label="搜索记录"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searchQuery !== '' ? (
          <button type="button" className="cbv-search__clear" aria-label="清空搜索" onClick={() => setSearchQuery('')}>
            ✕
          </button>
        ) : null}
      </label>

      <button
        type="button"
        className={`cbv-btn${panel === 'filter' ? ' cbv-btn--active' : ''}`}
        aria-expanded={panel === 'filter'}
        onClick={() => setPanel(panel === 'filter' ? null : 'filter')}
      >
        筛选
      </button>
      <button
        type="button"
        className={`cbv-btn${panel === 'sort' ? ' cbv-btn--active' : ''}`}
        aria-expanded={panel === 'sort'}
        onClick={() => setPanel(panel === 'sort' ? null : 'sort')}
      >
        排序
      </button>

      <button type="button" className="cbv-btn" onClick={() => void refresh()} disabled={loadingMore}>
        {loadingMore ? '刷新中…' : '刷新'}
      </button>
      <button
        type="button"
        className="cbv-btn"
        data-testid="toolbar-config"
        disabled={configDisabled}
        title={
          unsupportedNewer
            ? '只读模式：配置由更高版本创建，暂不能编辑'
            : canEditConfig
              ? '进入排版编辑器'
              : '仅查看权限，无配置入口'
        }
        onClick={onOpenConfig}
      >
        ⚙ 配置
      </button>

      <div className="cbv-more">
        <button
          type="button"
          className="cbv-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="更多操作"
          onClick={() => setMenuOpen((value) => !value)}
        >
          ⋯
        </button>
        {menuOpen ? (
          <div className="cbv-menu" role="menu">
            <button type="button" role="menuitem" className="cbv-menu__item" onClick={() => { setMenuOpen(false); void refresh(); }}>
              刷新数据
            </button>
            <button
              type="button"
              role="menuitem"
              className="cbv-menu__item"
              onClick={() => {
                setMenuOpen(false);
                setSearchQuery('');
              }}
            >
              清空搜索
            </button>
            <button
              type="button"
              role="menuitem"
              className="cbv-menu__item"
              onClick={() => {
                setMenuOpen(false);
                openEditor('card');
              }}
              disabled={configDisabled}
            >
              打开排版编辑器
            </button>
          </div>
        ) : null}
      </div>

      {panel ? (
        <div className="cbv-note-panel" role="note">
          {panel === 'filter' ? (
            <>
              <strong>筛选：</strong>卡片视图沿用表格视图的**原生筛选**，结果自动一致；如需调整请回到视图工具栏修改筛选条件。
            </>
          ) : (
            <>
              <strong>排序：</strong>卡片视图沿用表格视图的**原生排序**，结果自动一致；如需调整请回到视图工具栏修改排序。
            </>
          )}
          <button type="button" className="cbv-link-btn" onClick={() => setPanel(null)}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
