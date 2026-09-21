/**
 * 回归测试（工程师）——T13 / T09：空态与异常态、提示条（R7/R8）、工具栏、选择器。
 *
 * ⚠️ `BannerStack` / `Toolbar` 读取 zustand store：**必须用客户端渲染**取当前状态
 * （`renderToStaticMarkup` 走 zustand 的「服务端快照」，不会反映测试内的 `setState`）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRecord } from '@lark-base-open/js-sdk';
import {
  EMPTY_STATE_KINDS,
  EMPTY_STATE_SPECS,
  EmptyState,
  resolveEmptyState,
} from '@/components/layout/EmptyState';
import { BannerStack } from '@/components/layout/Banner';
import { Toolbar } from '@/components/layout/Toolbar';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { defaultCardLayout } from '@/config/defaults';
import { filterRecordsByQuery, selectCountLabel, selectPlacedFieldIds } from '@/state/selectors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 纯静态渲染（不读 store 的组件） */
function staticHtml(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

/** 客户端渲染：读 store 当前状态（`act` 保证同步提交后取 innerHTML） */
function clientHtml(node: ReactElement): string {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const markup = container.innerHTML;
  act(() => {
    root.unmount();
  });
  container.remove();
  return markup;
}

describe('T13 · 空态 / 异常态目录（PRD 6.5 九类 + 03 §12 五类）', () => {
  it('覆盖全部 14 类，且每类都有图标 / 标题 / 说明', () => {
    expect(EMPTY_STATE_KINDS).toHaveLength(14);
    for (const kind of [
      'noRecords',
      'noFields',
      'searchEmpty',
      'filterEmpty',
      'configPending',
      'noPermission',
      'fieldDeleted',
      'fieldUnsupported',
      'unsupportedNewer',
      'configCorrupted',
      'storageDegraded',
      'paginationFailed',
      'fieldReadFailed',
      'initFailed',
    ]) {
      expect(EMPTY_STATE_KINDS).toContain(kind);
      const spec = EMPTY_STATE_SPECS[kind as keyof typeof EMPTY_STATE_SPECS];
      expect(spec.icon).not.toBe('');
      expect(spec.title).not.toBe('');
      expect(spec.desc).not.toBe('');
    }
  });

  it('未知 kind → 回落 initFailed（永不返回 undefined）', () => {
    expect(resolveEmptyState('bogus' as never).kind).toBe('initFailed');
  });

  it('「仅本地保存」文案与 R8 口径一致', () => {
    expect(EMPTY_STATE_SPECS.storageDegraded.title).toBe('配置仅本地保存');
    expect(EMPTY_STATE_SPECS.storageDegraded.desc).toContain('其他成员看不到你的排版');
  });

  it('EmptyState 渲染标题与说明', () => {
    const markup = staticHtml(<EmptyState kind="noRecords" />);
    expect(markup).toContain('暂无记录');
    expect(markup).toContain('data-empty-kind="noRecords"');
  });
});

describe('T13 · 提示条（R7 可关闭 / R8 常驻不可关闭）', () => {
  beforeEach(() => {
    useViewStore.setState({
      degraded: false,
      degradedReason: '',
      configCorrupted: false,
      unsupportedNewer: false,
      provisionedFromTemplate: false,
      copyScenario: false,
    });
    useUiStore.setState({ copyBannerDismissed: false });
  });

  it('介质降级 → 常驻提示条，且**没有**关闭按钮（R8）', () => {
    useViewStore.setState({ degraded: true, degradedReason: '' });
    const markup = clientHtml(<BannerStack />);
    expect(markup).toContain('data-testid="banner-degraded"');
    expect(markup).toContain('配置仅本地保存');
    expect(markup).not.toContain('banner-degraded-close');
  });

  it('数据损坏 → error 提示条（区别于介质降级）', () => {
    useViewStore.setState({ configCorrupted: true });
    const markup = clientHtml(<BannerStack />);
    expect(markup).toContain('data-testid="banner-corrupted"');
    expect(markup).toContain('配置数据损坏');
    expect(markup).not.toContain('data-testid="banner-degraded"');
  });

  it('D4 复制视图首开 → info 提示条含两动作 + 可关闭（R7）', () => {
    useViewStore.setState({ provisionedFromTemplate: true, copyScenario: true });
    const markup = clientHtml(<BannerStack onReconfigureFromTemplate={() => undefined} onOpenEditor={() => undefined} />);
    expect(markup).toContain('data-testid="banner-provisioned"');
    expect(markup).toContain('从模板重配');
    expect(markup).toContain('立即配置');
    expect(markup).toContain('banner-provisioned-close');
  });

  it('更高版本只读 → warning 提示条', () => {
    useViewStore.setState({ unsupportedNewer: true });
    expect(clientHtml(<BannerStack />)).toContain('data-testid="banner-newer-readonly"');
  });

  it('无任何提示状态 → 不渲染提示条容器', () => {
    expect(clientHtml(<BannerStack />)).toBe('');
  });
});

describe('T09 · 工具栏（8 个元素）', () => {
  beforeEach(() => {
    useViewStore.setState({ viewName: '订单视图', canEditConfig: true, unsupportedNewer: false, loadingMore: false });
    useUiStore.setState({ searchQuery: '' });
  });

  it('渲染视图名 / 记录数 / 搜索 / 筛选 / 排序 / 刷新 / 配置 / 更多', () => {
    const markup = clientHtml(<Toolbar countLabel="共 1,248 条" onOpenConfig={() => undefined} />);
    expect(markup).toContain('订单视图');
    expect(markup).toContain('共 1,248 条');
    expect(markup).toContain('placeholder="搜索记录"');
    expect(markup).toContain('筛选');
    expect(markup).toContain('排序');
    expect(markup).toContain('刷新');
    expect(markup).toContain('⚙ 配置');
    expect(markup).toContain('aria-label="更多操作"');
    // 8 个元素：视图名 / 记录数 / 搜索 / 筛选 / 排序 / 刷新 / 配置 / 更多
    expect(markup).toContain('data-testid="toolbar-count"');
    expect(markup).toContain('data-testid="toolbar-config"');
  });

  it('无编辑权限 → ⚙ 配置禁用', () => {
    useViewStore.setState({ canEditConfig: false });
    const markup = clientHtml(<Toolbar countLabel="共 0 条" onOpenConfig={() => undefined} />);
    expect(markup).toMatch(/data-testid="toolbar-config"[^>]*disabled/);
  });
});

describe('T09 · 选择器：搜索过滤 / 已用字段 / 计数文案', () => {
  const metas: FieldMetaLite[] = [
    { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
    { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  ];
  const fieldsById: Record<string, FieldMetaLite> = { f_title: metas[0], f_amount: metas[1] };
  const layout = defaultCardLayout(metas);
  const records: IRecord[] = [
    { recordId: 'a', fields: { f_title: '苹果', f_amount: 1 } } as unknown as IRecord,
    { recordId: 'b', fields: { f_title: '香蕉', f_amount: 2 } } as unknown as IRecord,
  ];

  it('selectPlacedFieldIds：按槽位顺序去重', () => {
    expect(selectPlacedFieldIds(layout)).toEqual(['f_title', 'f_amount']);
  });

  it('filterRecordsByQuery：命中标题 / 数值；空关键词原样返回', () => {
    expect(filterRecordsByQuery(records, layout, fieldsById, '苹果').map((r) => r.recordId)).toEqual(['a']);
    expect(filterRecordsByQuery(records, layout, fieldsById, '2').map((r) => r.recordId)).toEqual(['b']);
    expect(filterRecordsByQuery(records, layout, fieldsById, '   ')).toBe(records);
    expect(filterRecordsByQuery(records, layout, fieldsById, '不存在')).toEqual([]);
  });

  it('selectCountLabel：总数 / 筛选态 / 仅已加载', () => {
    expect(selectCountLabel(1248, 1248, false)).toBe('共 1,248 条');
    expect(selectCountLabel(1248, 30, true)).toBe('共 1,248 条（已筛选 30 条）');
    expect(selectCountLabel(0, 5, false)).toBe('已加载 5 条');
    expect(selectCountLabel(0, 0, false)).toBe('共 0 条');
  });
});
