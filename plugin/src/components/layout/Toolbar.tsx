/**
 * 视图工具栏（T09 / 04 §5 S1）：统一高 48px，8 个元素。
 *
 * 视图名 · 记录数 · 搜索 · 筛选 · 排序 · 刷新 · ⚙ 配置 · ⋯ 更多
 *
 * 口径（§22.1.3 更新，取代旧的「筛选 / 排序皆沿用原生」写法）：
 *  - **搜索**：客户端过滤（对**已加载**记录，见 `selectors.filterRecordsByQuery`）；
 *  - **筛选**：**插件内自建筛选器**（`FilterPanel`，§22.5.1）——选字段 → 算子 → 值，支持多层「与/或」；
 *    结果 = **原生筛选 ∩ 插件筛选**（原生在服务端经 `viewId` 隐式生效，插件在客户端求值，§22.1.2）；
 *    筛选条件随**插件配置**持久化，**绝不写回原表**（D1 只读，不调用 `view.setFilter`）；
 *  - **排序**：**仍沿用视图原生设置**（D7 本期不变），故保留原「沿用原生」说明面板；
 *  - ⚙ 配置在无编辑权限或更高版本只读时禁用。
 *
 * ⭐ 持久化由 {@link useFilterPersistence} 承担（§22.5.4）：筛选**即时生效**（写 `UiStore.filter`），
 *    随后**防抖**经既有保存链路 `persistConfig({ ...config, filter })` 落盘；
 *    **仅当** `canEditConfig === true && unsupportedNewer === false` 时才写
 *    （只读 / 无权限用户仍可运行时使用筛选，只是不持久化，§22.10-⑦）。
 */
import { useState } from 'react';
import { APP_NAME } from '@/constants';
import { FilterPanel } from '@/components/filter/FilterPanel';
import { isFilterActive } from '@/filter/engine';
import { useFilterPersistence } from '@/hooks/useFilterPersistence';
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
  const filter = useUiStore((state) => state.filter);

  const [panel, setPanel] = useState<NotePanel>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const configDisabled = !canEditConfig || unsupportedNewer;

  // ⭐ 筛选态徽标（§22.5.1）：有生效条件时 `筛选 (n)` + `cbv-btn--active`
  const filterActive = isFilterActive(filter);
  const conditionCount = filterActive ? filter.conditions.length : 0;

  // ⭐ 防抖持久化（§22.5.4）：挂在本工具条上（常驻挂载），不随面板开合而重排定时器
  useFilterPersistence();

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
        className={`cbv-btn${filterActive || panel === 'filter' ? ' cbv-btn--active' : ''}`}
        data-testid="toolbar-filter"
        aria-expanded={panel === 'filter'}
        aria-label={filterActive ? `筛选（已启用 ${conditionCount} 个条件）` : '筛选'}
        onClick={() => setPanel(panel === 'filter' ? null : 'filter')}
      >
        {filterActive ? `筛选 (${conditionCount})` : '筛选'}
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

      {/* ⭐ 筛选：插件内自建筛选面板（§22.5.1）——取代原「沿用原生筛选」纯文案面板 */}
      {panel === 'filter' ? (
        <div className="cbv-filter-popover" role="dialog" aria-label="筛选条件">
          <FilterPanel onApply={() => setPanel(null)} />
        </div>
      ) : panel === 'sort' ? (
        /* 排序：D7 本期仍沿用原生，保留原说明面板（未被用户推翻） */
        <div className="cbv-note-panel" role="note">
          <>
            <strong>排序：</strong>卡片视图沿用表格视图的**原生排序**，结果自动一致；如需调整请回到视图工具栏修改排序。
          </>
          <button type="button" className="cbv-link-btn" onClick={() => setPanel(null)}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
