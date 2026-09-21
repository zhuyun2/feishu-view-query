/**
 * 回归测试（工程师）——T08：高亮规则引擎（单层 AND/OR） + 状态管理（DraftStore / UiStore / selectors）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { HighlightRule } from '@/config/types';
import { createDefaultConfig, defaultTheme } from '@/config/defaults';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { evaluate, isBlockVisible, matchRules, resolveCardStyle, resolveTargetStyle } from '@/highlight/ruleEngine';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore, DRAWER_MIN_WIDTH_PX } from '@/state/UiStore';
import { selectAttributesMaxRows, selectGridMetrics, selectRowCount } from '@/state/selectors';
import { DENSITY_PRESETS, densityPreset, resolveDensityPreset } from '@/config/presets';

const metas: Record<string, FieldMetaLite> = {
  f_status: { id: 'f_status', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
  f_amount: { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
  f_note: { id: 'f_note', name: '备注', type: FieldType.Text, isPrimary: false },
  f_date: { id: 'f_date', name: '日期', type: FieldType.DateTime, isPrimary: false },
  f_done: { id: 'f_done', name: '完成', type: FieldType.Checkbox, isPrimary: false },
};

const record = {
  recordId: 'rec_1',
  fields: {
    f_status: '进行中',
    f_amount: 5000,
    f_note: '重点客户，需优先跟进',
    f_date: 1_700_000_000_000,
    f_done: true,
  },
};

const T = 1_700_000_000_000;

describe('T08 · ruleEngine 单层 AND / OR（D5：不做嵌套）', () => {
  it('eq / neq', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: '进行中' }] }, record, metas)).toBe(true);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'neq', value: '已结束' }] }, record, metas)).toBe(true);
  });

  it('gt / gte / lt / lte（数值）', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_amount', operator: 'gt', value: 1000 }] }, record, metas)).toBe(true);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_amount', operator: 'lt', value: 1000 }] }, record, metas)).toBe(false);
  });

  it('contains / notContains（文本）', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_note', operator: 'contains', value: '重点' }] }, record, metas)).toBe(true);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_note', operator: 'notContains', value: '重点' }] }, record, metas)).toBe(false);
  });

  it('isEmpty / isNotEmpty', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_missing', operator: 'isEmpty' }] }, record, metas)).toBe(false);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'isNotEmpty' }] }, record, metas)).toBe(true);
  });

  it('before / after（日期先后）', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_date', operator: 'after', value: T - 86_400_000 }] }, record, metas)).toBe(true);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_date', operator: 'before', value: T - 86_400_000 }] }, record, metas)).toBe(false);
  });

  it('逻辑组合：AND（全部命中）/ OR（任一命中）', () => {
    const bothTrue = {
      logic: 'and' as const,
      items: [
        { fieldId: 'f_status', operator: 'eq' as const, value: '进行中' },
        { fieldId: 'f_amount', operator: 'gte' as const, value: 1000 },
      ],
    };
    expect(evaluate(bothTrue, record, metas)).toBe(true);
    expect(
      evaluate(
        { logic: 'and', items: [bothTrue.items[0], { fieldId: 'f_amount', operator: 'gt', value: 999999 }] },
        record,
        metas,
      ),
    ).toBe(false);
    expect(
      evaluate(
        { logic: 'or', items: [bothTrue.items[0], { fieldId: 'f_amount', operator: 'gt', value: 999999 }] },
        record,
        metas,
      ),
    ).toBe(true);
  });

  it('复选框按布尔值比较', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_done', operator: 'eq', value: true }] }, record, metas)).toBe(true);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_done', operator: 'eq', value: false }] }, record, metas)).toBe(false);
  });

  it('空条件 → 恒不命中（避免误伤全表）', () => {
    expect(evaluate({ logic: 'and', items: [] }, record, metas)).toBe(false);
    expect(evaluate({ logic: 'or', items: [] }, record, metas)).toBe(false);
    expect(evaluate(null, record, metas)).toBe(false);
  });

  it('字段元数据缺失 / 记录为空 → 不抛错、不命中', () => {
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'nope', operator: 'eq', value: 'x' }] }, record, metas)).toBe(false);
    expect(evaluate({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: 'x' }] }, null, metas)).toBe(false);
  });

  it('matchRules：仅 enabled 且命中；按 priority 升序', () => {
    const rules: HighlightRule[] = [
      { ruleId: 'r2', name: 'b', enabled: true, priority: 5, target: { kind: 'cardBorder' }, condition: { logic: 'and', items: [{ fieldId: 'f_amount', operator: 'gt', value: 1 }] }, style: { borderColor: '#F54A45', borderWidth: 2 } },
      { ruleId: 'r1', name: 'a', enabled: true, priority: 1, target: { kind: 'field', fieldId: 'f_status' }, condition: { logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: '进行中' }] }, style: { color: '#FF8800' } },
      { ruleId: 'r3', name: 'c', enabled: false, priority: 0, target: { kind: 'cardBorder' }, condition: { logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: '进行中' }] }, style: { borderColor: '#000' } },
    ];
    const matched = matchRules(rules, record, metas);
    expect(matched.map((m) => m.rule.ruleId)).toEqual(['r1', 'r2']);
    expect(resolveCardStyle(matched)?.borderColor).toBe('#F54A45');
    expect(resolveTargetStyle(matched, 'field', 'f_status')?.color).toBe('#FF8800');
    expect(resolveTargetStyle(matched, 'badge', 'f_status')).toBeNull();
  });

  it('isBlockVisible：未配置 → 可见；配置且命中 → 可见', () => {
    expect(isBlockVisible(null, record, metas)).toBe(true);
    expect(isBlockVisible(undefined, record, metas)).toBe(true);
    expect(
      isBlockVisible({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: '进行中' }] }, record, metas),
    ).toBe(true);
    expect(
      isBlockVisible({ logic: 'and', items: [{ fieldId: 'f_status', operator: 'eq', value: '已结束' }] }, record, metas),
    ).toBe(false);
  });
});

describe('T08 · DraftStore（card / doc 双分支 + 快照 / 回滚 + dirty）', () => {
  beforeEach(() => useDraftStore.getState().close());

  it('open：初始化双分支草稿与基准，dirty=false', () => {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 't1' });
    useDraftStore.getState().open(config);
    const state = useDraftStore.getState();
    expect(state.active).toBe(true);
    expect(state.cardDraft).not.toBeNull();
    expect(state.docDraft).not.toBeNull();
    expect(state.dirty).toBe(false);
  });

  it('updateCard：改动 → dirty；discard 回滚到基准', () => {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 't1' });
    useDraftStore.getState().open(config);
    useDraftStore.getState().updateCard((draft) => ({ ...draft, templateId: 'compact' }));
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('compact');
    expect(useDraftStore.getState().dirty).toBe(true);

    useDraftStore.getState().discard();
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('standard');
    expect(useDraftStore.getState().dirty).toBe(false);
  });

  it('doc 分支与 card 分支互不污染', () => {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 't1' });
    useDraftStore.getState().open(config);
    useDraftStore.getState().updateCard((draft) => ({ ...draft, templateId: 'list' }));
    useDraftStore.getState().updateDoc((draft) => ({ ...draft, templateId: 'custom-doc' }));
    const state = useDraftStore.getState();
    expect(state.cardDraft?.templateId).toBe('list');
    expect(state.docDraft?.templateId).toBe('custom-doc');
  });

  it('snapshot → rollback：撤销上一步改动', () => {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 't1' });
    useDraftStore.getState().open(config);

    useDraftStore.getState().snapshot();
    useDraftStore.getState().updateCard((draft) => ({ ...draft, templateId: 'compact' }));
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('compact');

    expect(useDraftStore.getState().rollback()).toBe(true);
    expect(useDraftStore.getState().cardDraft?.templateId).toBe('standard');
    expect(useDraftStore.getState().rollback()).toBe(false); // 栈空
  });

  it('buildConfig：把草稿合并为一个完整 CardViewConfig（一次保存提交两者）', () => {
    const config = createDefaultConfig({ viewId: 'v1', tableId: 't1' });
    useDraftStore.getState().open(config);
    useDraftStore.getState().updateCard((draft) => ({ ...draft, templateId: 'compact' }));
    useDraftStore.getState().updateDoc((draft) => ({ ...draft, templateId: 'doc-x' }));
    useDraftStore.getState().setDensity(densityPreset('compact'));

    const built = useDraftStore.getState().buildConfig(config);
    expect(built.card.templateId).toBe('compact');
    expect(built.detail.doc.templateId).toBe('doc-x');
    // 密度随草稿生效：切到 compact → 输出随之改变（区别于基准 standard，非同源常量自比）
    expect(built.density.preset).toBe('compact');
    expect(built.density.cardMinWidth).toBe(DENSITY_PRESETS.compact.cardMinWidth);
    expect(built.density.cardMinWidth).not.toBe(config.density.cardMinWidth);
    expect(built.density.attributesMaxRows).toBe(DENSITY_PRESETS.compact.attributesMaxRows);
    // 未触碰的分支保持原值
    expect(built.theme).toEqual(defaultTheme());
  });

  it('未进入编辑态时 updateCard 不产生副作用（安全 no-op）', () => {
    useDraftStore.getState().close();
    expect(() => useDraftStore.getState().updateCard((draft) => draft)).not.toThrow();
    expect(useDraftStore.getState().cardDraft).toBeNull();
  });
});

describe('T08 · UiStore（抽屉 / 缩放 / 全屏 / 翻页 / 编辑模式）', () => {
  beforeEach(() => {
    useUiStore.setState({
      editorOpen: false,
      editMode: 'card',
      hover: { recordId: null, anchor: null },
      copyBannerDismissed: false,
      toast: null,
    });
  });

  it('编辑模式：openEditor / setEditMode / closeEditor', () => {
    useUiStore.getState().openEditor('doc');
    expect(useUiStore.getState().editorOpen).toBe(true);
    expect(useUiStore.getState().editMode).toBe('doc');
    useUiStore.getState().setEditMode('card');
    expect(useUiStore.getState().editMode).toBe('card');
    useUiStore.getState().closeEditor();
    expect(useUiStore.getState().editorOpen).toBe(false);
  });

  it('抽屉宽度：默认 860；低于下限被钳制到 560', () => {
    expect(useUiStore.getState().drawer.widthPx).toBe(860);
    useUiStore.getState().setDrawerWidth(100);
    // R2 下限 560：先按规范字面量独立断言，再与 UiStore 导出常量对齐（避免同源自比）
    expect(useUiStore.getState().drawer.widthPx).toBe(560);
    expect(useUiStore.getState().drawer.widthPx).toBe(DRAWER_MIN_WIDTH_PX);
  });

  it('缩放：手动缩放会关闭「适应宽度」；越界被钳制', () => {
    useUiStore.getState().setFitToWidth(true);
    useUiStore.getState().setDrawerZoom(1.25);
    expect(useUiStore.getState().drawer.zoom).toBe(1.25);
    expect(useUiStore.getState().drawer.fitToWidth).toBe(false);
    useUiStore.getState().setDrawerZoom(99);
    expect(useUiStore.getState().drawer.zoom).toBeLessThanOrEqual(1.5);
    useUiStore.getState().setDrawerZoom(-5);
    expect(useUiStore.getState().drawer.zoom).toBeGreaterThanOrEqual(0.5);
  });

  it('全屏：toggle 可往返', () => {
    useUiStore.getState().toggleFullscreen();
    expect(useUiStore.getState().drawer.fullscreen).toBe(true);
    useUiStore.getState().toggleFullscreen();
    expect(useUiStore.getState().drawer.fullscreen).toBe(false);
  });

  it('打开抽屉会清空悬浮预览（避免浮层残留）', () => {
    useUiStore.getState().setHover('rec_1', { x: 1, y: 2, width: 3, height: 4 });
    useUiStore.getState().openDrawer('rec_1');
    expect(useUiStore.getState().hover.recordId).toBeNull();
    expect(useUiStore.getState().drawer.open).toBe(true);
    useUiStore.getState().closeDrawer();
    expect(useUiStore.getState().drawer.fullscreen).toBe(false);
  });

  it('分页状态：paginating / paginationFailed / currentPage', () => {
    useUiStore.getState().setPaginating(true);
    useUiStore.getState().setPaginationFailed(true);
    useUiStore.getState().setTotalPages(3);
    useUiStore.getState().setCurrentPage(2);
    expect(useUiStore.getState().drawer).toMatchObject({
      paginating: true,
      paginationFailed: true,
      totalPages: 3,
      currentPage: 2,
    });
  });
});

describe('T08 · selectors（网格几何 / 属性行数 / 密度档）', () => {
  it('列数推导与 04 §3.4 一致（标准档 280/16/16）', () => {
    const density = densityPreset('standard');
    expect(selectGridMetrics(1280, density).columns).toBe(4);
    expect(selectGridMetrics(1440, density).columns).toBe(4);
    expect(selectGridMetrics(1600, density).columns).toBe(5);
    expect(selectGridMetrics(1920, density).columns).toBe(6);
  });

  it('密度三档改变一屏列数（紧凑更多、宽松更少）', () => {
    const compact = selectGridMetrics(1280, densityPreset('compact')).columns;
    const standard = selectGridMetrics(1280, densityPreset('standard')).columns;
    const comfortable = selectGridMetrics(1280, densityPreset('comfortable')).columns;
    expect(compact).toBeGreaterThan(standard);
    expect(standard).toBeGreaterThan(comfortable);
  });

  it('fixed 列数模式生效并做上限保护', () => {
    const density = { ...densityPreset('standard'), columnsMode: 'fixed' as const, fixedColumns: 99 };
    expect(selectGridMetrics(1280, density).columns).toBe(12);
  });

  it('属性区默认行数（R3）：紧凑 2 / 标准 3 / 宽松 5', () => {
    expect(selectAttributesMaxRows(densityPreset('compact'))).toBe(2);
    expect(selectAttributesMaxRows(densityPreset('standard'))).toBe(3);
    expect(selectAttributesMaxRows(densityPreset('comfortable'))).toBe(5);
  });

  it('resolveDensityPreset：无标记时按尺寸就近推断', () => {
    expect(resolveDensityPreset({ cardMinWidth: 240, columnsMode: 'auto', gap: 12, padding: 10, maxCardHeight: 160 })).toBe('compact');
    expect(resolveDensityPreset(null)).toBe('standard');
  });

  it('行数 = ceil(总条数 / 列数)', () => {
    expect(selectRowCount(12_000, 4)).toBe(3000);
    expect(selectRowCount(9, 4)).toBe(3);
    expect(selectRowCount(0, 4)).toBe(0);
  });
});
