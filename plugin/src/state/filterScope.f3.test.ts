/**
 * 单元测试（工程师 · F3）——筛选**接线层**的新选择器与 UiStore 运行时状态。
 *
 * ⭐ 断言纪律（§22.9.3「能证伪」，禁恒真）：
 *  - 一律断言**具体记录 ID 序列**与**具体文案 / 具体数值**，禁止 `length > 0` 这类恒真断言；
 *  - 每条「命中」断言都配一条**反号**（未命中项必须被排除）或一条**对照组**，
 *    证伪「实现其实在放行而不是在筛选」；
 *  - 覆盖率元数据断言**具体数字**（已加载数 / 总数 / hasMore / fullCoverage）。
 *
 * ⭐ 本批最重要的一条：「谎报全量」证伪用例 —— 见 `describe('覆盖率：不得谎报全量')`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SdkRecord } from '@/sdk/port';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';
import { defaultCardLayout } from '@/config/defaults';
import type { FilterConfig } from '@/filter/types';
import { useUiStore } from '@/state/UiStore';
import {
  INCOMPLETE_NOTICE,
  LOAD_ALL_LABEL,
  selectFilterScope,
  selectFilterScopeLabel,
  selectFilterScopeStatus,
  selectVisibleRecords,
} from '@/state/selectors';

/* ===================== 夹具 ===================== */

const metas: FieldMetaLite[] = [
  { id: 'f_title', name: '标题', type: FieldType.Text, isPrimary: true },
  { id: 'f_amount', name: '金额', type: FieldType.Number, isPrimary: false },
];
const fieldsById: Record<string, FieldMetaLite> = { f_title: metas[0], f_amount: metas[1] };
const layout = defaultCardLayout(metas);

/** r1/r3 标题含「甲」，r2 不含 */
const r1 = { recordId: 'r1', fields: { f_title: '甲方案', f_amount: 100 } } as unknown as SdkRecord;
const r2 = { recordId: 'r2', fields: { f_title: '乙方案', f_amount: 200 } } as unknown as SdkRecord;
const r3 = { recordId: 'r3', fields: { f_title: '甲二期', f_amount: 300 } } as unknown as SdkRecord;
const all: SdkRecord[] = [r1, r2, r3];

/** r2 的对照版：标题也含「甲」→ 必须被纳入结果（证伪「实现在放行」还是「在评价」） */
const r2Matching = { recordId: 'r2', fields: { f_title: '甲公司', f_amount: 200 } } as unknown as SdkRecord;

const ids = (records: readonly SdkRecord[]): string[] => records.map((record) => record.recordId);

/** 构造一个「标题包含 keyword」的单条件筛选 */
function titleContainsConfig(keyword: string): FilterConfig {
  return {
    enabled: true,
    conjunction: 'and',
    conditions: [{ conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: keyword }],
  };
}

const NO_FILTER: FilterConfig = { enabled: true, conjunction: 'and', conditions: [] };

beforeEach(() => {
  useUiStore.setState({
    filter: NO_FILTER,
    filterTouched: false,
    filterLoadingAll: false,
    filterLoadAllStartedFrom: 0,
    searchQuery: '',
  });
});

/* ===================== selectVisibleRecords ===================== */

describe('F3 · selectVisibleRecords（原生 ∩ 插件筛选 ∩ 搜索）', () => {
  it('有筛选：命中保留 + 未命中排除（双向断言具体 ID）', () => {
    const result = selectVisibleRecords({
      records: all,
      filter: titleContainsConfig('甲'),
      fieldsById,
      layout,
      searchQuery: '',
    });
    expect(ids(result.records)).toEqual(['r1', 'r3']);
    expect(result.filterMatched).toBe(2);
    expect(result.visible).toBe(2);
    expect(result.hasFilter).toBe(true);
    expect(result.hasSearch).toBe(false);
  });

  it('对照组：把未命中项改成满足条件后必须被包含（证明在「评价」而非「放行」）', () => {
    const result = selectVisibleRecords({
      records: [r1, r2Matching, r3],
      filter: titleContainsConfig('甲'),
      fieldsById,
      layout,
      searchQuery: '',
    });
    expect(ids(result.records)).toEqual(['r1', 'r2', 'r3']);
  });

  it('数值算子：isGreater 150 → 仅 200/300 两条（含真的在比较的对照）', () => {
    const gt150: FilterConfig = {
      enabled: true,
      conjunction: 'and',
      conditions: [{ conditionId: 'flt_n', fieldId: 'f_amount', operator: 'isGreater', value: 150 }],
    };
    expect(ids(selectVisibleRecords({ records: all, filter: gt150, fieldsById, layout, searchQuery: '' }).records)).toEqual([
      'r2',
      'r3',
    ]);
    const gt300: FilterConfig = { ...gt150, conditions: [{ ...gt150.conditions[0], value: 300 }] };
    expect(ids(selectVisibleRecords({ records: all, filter: gt300, fieldsById, layout, searchQuery: '' }).records)).toEqual([]);
  });

  it('or 组合：任一条件命中即命中（r2 靠数值命中）', () => {
    const orFilter: FilterConfig = {
      enabled: true,
      conjunction: 'or',
      conditions: [
        { conditionId: 'flt_1', fieldId: 'f_title', operator: 'contains', value: '甲' },
        { conditionId: 'flt_2', fieldId: 'f_amount', operator: 'is', value: 200 },
      ],
    };
    expect(ids(selectVisibleRecords({ records: all, filter: orFilter, fieldsById, layout, searchQuery: '' }).records)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('enabled=false → 整体不筛（返回原引用，避免无谓重渲染）', () => {
    const disabled: FilterConfig = { enabled: false, conjunction: 'and', conditions: titleContainsConfig('甲').conditions };
    const result = selectVisibleRecords({ records: all, filter: disabled, fieldsById, layout, searchQuery: '' });
    expect(ids(result.records)).toEqual(['r1', 'r2', 'r3']);
    expect(result.hasFilter).toBe(false);
  });

  it('无筛选无搜索 → 返回入参**原引用**（toBe 断言）', () => {
    const result = selectVisibleRecords({ records: all, filter: NO_FILTER, fieldsById, layout, searchQuery: '' });
    expect(result.records).toBe(all);
    expect(result.filterMatched).toBe(3);
  });

  it('无筛选 + 纯空格搜索 → 同样返回原引用', () => {
    const result = selectVisibleRecords({ records: all, filter: null, fieldsById, layout, searchQuery: '   ' });
    expect(result.records).toBe(all);
    expect(result.hasSearch).toBe(false);
  });

  it('筛选与搜索**叠加（AND）**：先筛后搜，两者都要满足', () => {
    // 筛选：标题含「甲」→ r1/r3；搜索：「二期」→ 仅 r3
    const result = selectVisibleRecords({
      records: all,
      filter: titleContainsConfig('甲'),
      fieldsById,
      layout,
      searchQuery: '二期',
    });
    expect(ids(result.records)).toEqual(['r3']);
    expect(result.filterMatched).toBe(2); // 筛选层仍命中 2 条（未被搜索收窄前的数）
    expect(result.visible).toBe(1);
    expect(result.hasFilter).toBe(true);
    expect(result.hasSearch).toBe(true);
  });

  it('纯搜索（无筛选）走既有链路', () => {
    const result = selectVisibleRecords({ records: all, filter: NO_FILTER, fieldsById, layout, searchQuery: '乙' });
    expect(ids(result.records)).toEqual(['r2']);
    expect(result.filterMatched).toBe(3);
    expect(result.hasFilter).toBe(false);
  });

  it('字段已被删除（fieldsById 中缺失）→ 条件判无效被跳过，记录全部保留（不抛错、不筛光）', () => {
    // D2 回归锁：**数据可见性优先**——语义无法确定的条件下，不得让记录消失。
    // 旧行为（期望 `[]`）已被否决：字段被删时条件继续求值 → 该字段取值为空 → 对 is/contains 算出
    // `noMatch` → 记录被**全部筛掉**，用户看到空列表并误以为「没有符合条件的记录」，
    // 而实际是记录凭空消失（且无从察觉）。
    // 现行为：meta 缺失 → `invalid` → 该条件被跳过 → 不筛选 → 返回**全部**记录。
    // ⚠️ 若有人把期望改回 `[]`，那是在恢复一个已被明确否决的行为。
    const staleFilter: FilterConfig = {
      enabled: true,
      conjunction: 'and',
      conditions: [{ conditionId: 'flt_gone', fieldId: 'f_deleted', operator: 'contains', value: '甲' }],
    };
    expect(ids(selectVisibleRecords({ records: all, filter: staleFilter, fieldsById, layout, searchQuery: '' }).records)).toEqual(
      ['r1', 'r2', 'r3'],
    );
  });
});

/* ===================== selectFilterScope（薄封装） ===================== */

describe('F3 · selectFilterScope（覆盖率元数据）', () => {
  it('hasMore=true → fullCoverage 必须为 false（核心铁律）', () => {
    const scope = selectFilterScope(titleContainsConfig('甲'), 200, 37, 12480, true);
    expect(scope).toEqual({ active: true, loaded: 200, matched: 37, total: 12480, hasMore: true, fullCoverage: false });
  });

  it('hasMore=false → 才允许 fullCoverage=true', () => {
    const scope = selectFilterScope(titleContainsConfig('甲'), 12480, 37, 12480, false);
    expect(scope.hasMore).toBe(false);
    expect(scope.fullCoverage).toBe(true);
  });

  it('无条件 → active=false（元数值仍如实上报）', () => {
    const scope = selectFilterScope(NO_FILTER, 200, 200, 12480, true);
    expect(scope.active).toBe(false);
    expect(scope.loaded).toBe(200);
    expect(scope.total).toBe(12480);
    expect(scope.hasMore).toBe(true);
    expect(scope.fullCoverage).toBe(false);
  });
});

/* ===================== ⭐ 不得谎报全量 ===================== */

describe('覆盖率：不得谎报全量（§22.11.4 / §22.9.4-①②）', () => {
  /**
   * 构造：`total = 12,480 ≫ loaded = 200`，`hasMore = true`，筛选命中 37 条。
   * 场景：若实现偷懒（忽略 hasMore 直接输出 `共 12,480 条（已筛选 37 条）`），
   * 用户会理解成「全表里就这 37 条符合」——而实际上只筛了 200 条里的 200 条。
   */
  const PARTIAL = { total: 12480, loaded: 200, matched: 37, hasFilter: true, hasSearch: false, hasMore: true };

  it('countLabel：必须含「已加载」限定词，且**不得**出现暗示全量的「共 37 条」', () => {
    const label = selectFilterScopeLabel(PARTIAL);
    expect(label).toBe('共 12,480 条 · 已在已加载的 200 条中筛选，命中 37 条');
    // 反号断言：任何「省略已加载、只报命中数」的实现都会在这里变红
    expect(label).toContain('已加载');
    expect(label).toContain('200');
    expect(label).not.toContain('共 37 条');
    expect(label).not.toContain('（已筛选 37 条）');
    expect(label).not.toContain('全部');
  });

  it('状态行：范围必须写「已加载的 200 / 共 12,480」，并常驻「未加载全部」+ 升级入口', () => {
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 200,
      filterMatched: 37,
      visible: 37,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.visible).toBe(true);
    expect(status.scopeText).toBe('已在已加载的 200 / 共 12,480 条中筛选，命中 37 条');
    expect(status.scopeText).not.toContain('全部 12,480'); // ⭐ 未加载完就不许说「全部」
    expect(status.incompleteText).toBe(INCOMPLETE_NOTICE);
    expect(status.incompleteText).toBe('未加载全部');
    expect(status.canUpgrade).toBe(true);
    expect(status.upgradeLabel).toBe(LOAD_ALL_LABEL);
    expect(status.upgradeLabel).toBe('加载全部并重新筛选');
    expect(status.progressText).toBeNull();
  });

  it('对照：同一组数字把 hasMore 置 false 后，文案才允许称「全部」', () => {
    const full = selectFilterScopeStatus({
      total: 12480,
      loaded: 12480,
      filterMatched: 37,
      visible: 37,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
      loadingAll: false,
    });
    expect(full.scopeText).toBe('已在全部 12,480 条中筛选，命中 37 条');
    expect(full.scopeText).not.toContain('已加载');
    expect(full.incompleteText).toBeNull();
    expect(full.canUpgrade).toBe(false);
    expect(selectFilterScopeLabel({ ...PARTIAL, loaded: 12480, hasMore: false })).toBe('共 12,480 条（已筛选 37 条）');
  });

  it('升级进行中：显示进度「已加载 L / 共 N」，且不再重复暴露升级按钮', () => {
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 3200,
      filterMatched: 512,
      visible: 512,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: true,
      startedFrom: 200,
    });
    expect(status.progressText).toBe('已加载 3,200 / 共 12,480（本次新增 3,000 条）');
    expect(status.canUpgrade).toBe(false);
    // 即使正在升级，只要还没加载完就不许称全量
    expect(status.incompleteText).toBe('未加载全部');
    expect(status.scopeText).toContain('已加载的 3,200');
  });

  it('升级起点为空 / 脏数据 → 进度文案退化为「已加载 L / 共 N」（绝不出现 NaN）', () => {
    const base = {
      total: 12480,
      loaded: 3200,
      filterMatched: 512,
      visible: 512,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: true,
    };
    expect(selectFilterScopeStatus(base).progressText).toBe('已加载 3,200 / 共 12,480');
    expect(selectFilterScopeStatus({ ...base, startedFrom: Number.NaN }).progressText).toBe('已加载 3,200 / 共 12,480');
    expect(selectFilterScopeStatus({ ...base, startedFrom: -1 }).progressText).toBe('已加载 3,200 / 共 12,480');
    expect(selectFilterScopeStatus({ ...base, startedFrom: 3200 }).progressText).toBe('已加载 3,200 / 共 12,480');
    expect(selectFilterScopeStatus(base).progressText).not.toContain('NaN');
  });

  it('搜索（无插件筛选）同样是局部的，也必須诚实标注', () => {
    const label = selectFilterScopeLabel({ total: 12480, loaded: 200, matched: 5, hasFilter: false, hasSearch: true, hasMore: true });
    expect(label).toBe('共 12,480 条 · 已在已加载的 200 条中筛选，命中 5 条');
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 200,
      filterMatched: 200,
      visible: 5,
      hasFilter: false,
      hasSearch: true,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在已加载的 200 / 共 12,480 条中搜索，命中 5 条');
    expect(status.canUpgrade).toBe(true);
  });

  it('无收窄时不渲染状态行（避免噪声），且计数沿用既有口径', () => {
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 200,
      filterMatched: 200,
      visible: 200,
      hasFilter: false,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.visible).toBe(false);
    expect(status.scopeText).toBe('');
    expect(status.canUpgrade).toBe(false);
    expect(selectFilterScopeLabel({ total: 12480, loaded: 200, matched: 200, hasFilter: false, hasSearch: false, hasMore: true })).toBe(
      '共 12,480 条',
    );
  });

  it('筛选与搜索叠加时，状态行同时给出「筛选命中」与「最终可见」两个数', () => {
    const status = selectFilterScopeStatus({
      total: 12480,
      loaded: 200,
      filterMatched: 37,
      visible: 9,
      hasFilter: true,
      hasSearch: true,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在已加载的 200 / 共 12,480 条中筛选，命中 37 条（叠加搜索后 9 条）');
  });

  it('脏数据（NaN / 负数 / 非数字）绝不出现在文案里', () => {
    const label = selectFilterScopeLabel({
      total: Number.NaN,
      loaded: -5,
      matched: 'x' as unknown as number,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).toContain('共 0 条');
    expect(label).not.toContain('NaN');
  });
});

/* ===================== UiStore 增强 ===================== */

describe('F3 · UiStore 筛选运行时状态', () => {
  it('初始态：空筛选（= 不筛），未编辑，未在升级', () => {
    const state = useUiStore.getState();
    expect(state.filter.conditions).toEqual([]);
    expect(state.filter.enabled).toBe(true);
    expect(state.filter.conjunction).toBe('and');
    expect(state.filterTouched).toBe(false);
    expect(state.filterLoadingAll).toBe(false);
  });

  it('setFilter：写入草稿并置位 touched（远端同步据此保留本地）', () => {
    useUiStore.getState().setFilter(titleContainsConfig('甲'));
    expect(useUiStore.getState().filter.conditions).toHaveLength(1);
    expect(useUiStore.getState().filterTouched).toBe(true);
  });

  it('clearFilter：条件清空但算一次本地编辑', () => {
    useUiStore.getState().setFilter(titleContainsConfig('甲'));
    useUiStore.getState().clearFilter();
    expect(useUiStore.getState().filter.conditions).toEqual([]);
    expect(useUiStore.getState().filterTouched).toBe(true);
  });

  it('replaceFilter（初始化 / 远端同步）：整体替换且**不**置 touched', () => {
    useUiStore.getState().replaceFilter(titleContainsConfig('乙'));
    expect(useUiStore.getState().filter.conditions[0].value).toBe('乙');
    expect(useUiStore.getState().filterTouched).toBe(false);
  });

  it('begin/endFilterLoadAll：记录起始已加载条数，结束复位', () => {
    useUiStore.getState().beginFilterLoadAll(200);
    expect(useUiStore.getState().filterLoadingAll).toBe(true);
    expect(useUiStore.getState().filterLoadAllStartedFrom).toBe(200);
    useUiStore.getState().endFilterLoadAll();
    expect(useUiStore.getState().filterLoadingAll).toBe(false);
  });

  it('beginFilterLoadAll 的起始值做非负整数收敛', () => {
    useUiStore.getState().beginFilterLoadAll(Number.NaN);
    expect(useUiStore.getState().filterLoadAllStartedFrom).toBe(0);
    useUiStore.getState().beginFilterLoadAll(-8.7);
    expect(useUiStore.getState().filterLoadAllStartedFrom).toBe(0);
  });
});
