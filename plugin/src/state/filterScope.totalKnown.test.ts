/**
 * 工程师 · 修复「总数取到 0」时的文案诚实性（totalKnown 语义）。
 *
 * 背景（真机截图回归）：`count()` 静默失败后 total=0，界面出现
 *  -「共 0 条 · 已在已加载的 200 条中筛选，命中 5 条」
 *  -「已在全部 0 条中筛选，命中 58 条」
 * 本文件把「分母为 0 / 未知时绝不允许出现命中口径」锁死为验收口径。
 *
 * 断言纪律：一律断言**逐字文案**，并配反号（不得含「共 0 条」这类谎报）。
 */
import { describe, expect, it } from 'vitest';
import { selectCountLabel, selectFilterScopeLabel, selectFilterScopeStatus } from '@/state/selectors';

describe('selectCountLabel · 总数未知', () => {
  it('无筛选 → 不得出现「共 N 条」，改用「已加载 L 条」', () => {
    const label = selectCountLabel(0, 200, false, false);
    expect(label).toBe('已加载 200 条');
    expect(label).not.toContain('共');
  });

  it('总数未知且已加载为 0 → 「已加载 0 条」（不谎报「共 0 条」）', () => {
    expect(selectCountLabel(0, 0, false, false)).toBe('已加载 0 条');
  });

  it('总数可信时维持既有口径逐字不变（既有基线）', () => {
    expect(selectCountLabel(1248, 1248, false, true)).toBe('共 1,248 条');
    expect(selectCountLabel(1248, 30, true, true)).toBe('共 1,248 条（已筛选 30 条）');
    expect(selectCountLabel(0, 5, false, true)).toBe('已加载 5 条');
    expect(selectCountLabel(0, 0, false, true)).toBe('共 0 条');
  });

  it('totalKnown 缺省 → 视作已知（保持既有调用点 / 测试基线）', () => {
    expect(selectCountLabel(1248, 30, true)).toBe('共 1,248 条（已筛选 30 条）');
  });
});

describe('selectFilterScopeLabel · 总数未知时的筛选计数', () => {
  it('有筛选 + hasMore → 去掉「共 0 条」前缀，退化为「已在已加载的 L 条中筛选」', () => {
    const label = selectFilterScopeLabel({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).toBe('已在已加载的 200 条中筛选，命中 5 条');
    expect(label).not.toContain('共 0 条');
  });

  it('有筛选 + !hasMore → 「已在全部 L 条中筛选，命中 M 条」（用 loaded 当分母）', () => {
    const label = selectFilterScopeLabel({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 58,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
    });
    expect(label).toBe('已在全部 200 条中筛选，命中 58 条');
    expect(label).not.toContain('全部 0 条');
  });

  it('搜索（无插件筛选）+ 总数未知 → 同样不得谎报「共 0 条」', () => {
    const label = selectFilterScopeLabel({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 5,
      hasFilter: false,
      hasSearch: true,
      hasMore: true,
    });
    // 文案统一为「筛选」口径（与既有基线逐字一致：搜索与筛选不区分措辞，避免既有断言漂移）
    expect(label).toBe('已在已加载的 200 条中筛选，命中 5 条');
    expect(label).not.toContain('共 0 条');
  });

  it('脏数据 total<loaded（totalKnown=true）→ 回退用 loaded，避免「已加载 200 / 共 100」', () => {
    const label = selectFilterScopeLabel({
      total: 100,
      totalKnown: true,
      loaded: 200,
      matched: 7,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).toBe('已在已加载的 200 条中筛选，命中 7 条');
    expect(label).not.toContain('共 100 条');
  });

  it('totalKnown=false 但 total ≥ loaded（count() 兜底给出看似合理值）→ 仍按「未知」处理（隔离 totalKnown 闸门）', () => {
    // 本用例专门隔离 `totalKnown` 标志位本身：total(300) ≥ loaded(200)，若实现只看
    // 「total < loaded」而忽略 `totalKnown===false`，就会误显「共 300 条」→ 变红。
    const label = selectFilterScopeLabel({
      total: 300,
      totalKnown: false,
      loaded: 200,
      matched: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).toBe('已在已加载的 200 条中筛选，命中 5 条');
    expect(label).not.toContain('共 300 条');
  });
});

describe('selectFilterScopeStatus · 状态行（截图两句的回归锁）', () => {
  it('截图句 1：「共 0 条 · 已在已加载的 200 条中筛选，命中 5 条」必须消失', () => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 200,
      filterMatched: 5,
      visible: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在已加载的 200 条中筛选，命中 5 条');
    expect(status.scopeText).not.toContain('共 0 条');
    expect(status.incompleteText).toBe('未加载全部');
    expect(status.canUpgrade).toBe(true);
  });

  it('截图句 2：「已在全部 0 条中筛选，命中 58 条」必须消失', () => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 200,
      filterMatched: 58,
      visible: 58,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在全部 200 条中筛选，命中 58 条');
    expect(status.scopeText).not.toContain('全部 0 条');
    expect(status.incompleteText).toBeNull();
    expect(status.canUpgrade).toBe(false);
  });

  it('总数未知 + 正在升级：进度只报「已加载 L」（不出现「/ 共 0」）', () => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 400,
      filterMatched: 9,
      visible: 9,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: true,
      startedFrom: 200,
    });
    expect(status.progressText).toBe('已加载 400（本次新增 200 条）');
    expect(status.progressText).not.toContain('共');
  });

  it('静默全量（loadingAllSilent）：不显示进度文案', () => {
    const status = selectFilterScopeStatus({
      total: 500,
      totalKnown: true,
      loaded: 300,
      filterMatched: 9,
      visible: 9,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: true,
      loadingAllSilent: true,
      startedFrom: 200,
    });
    expect(status.progressText).toBeNull();
    expect(status.scopeText).toContain('已在已加载的 300 / 共 500 条中筛选');
  });

  it('总数可信时维持既有口径逐字不变（既有基线）', () => {
    const partial = selectFilterScopeStatus({
      total: 12480,
      loaded: 200,
      filterMatched: 37,
      visible: 37,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(partial.scopeText).toBe('已在已加载的 200 / 共 12,480 条中筛选，命中 37 条');

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
  });

  it('totalKnown=false 且 total ≥ loaded → 状态行前缀也不得出现「/ 共 N 条」（隔离 totalKnown 闸门）', () => {
    const status = selectFilterScopeStatus({
      total: 300,
      totalKnown: false,
      loaded: 200,
      filterMatched: 9,
      visible: 9,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在已加载的 200 条中筛选，命中 9 条');
    expect(status.scopeText).not.toContain('/ 共 300 条');
  });
});

describe('分支穷举（表驱动）：totalKnown × hasMore × 命中 M', () => {
  const M = 7;
  const unknownCases: Array<[boolean, string]> = [
    [true, `已在已加载的 200 条中筛选，命中 ${M} 条`],
    [false, `已在全部 200 条中筛选，命中 ${M} 条`],
  ];
  const knownCases: Array<[boolean, string]> = [
    [true, `已在已加载的 200 / 共 12,480 条中筛选，命中 ${M} 条`],
    [false, `已在全部 12,480 条中筛选，命中 ${M} 条`],
  ];

  it.each(unknownCases)('totalKnown=false, hasMore=%s → 逐字文案', (hasMore, expected) => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 200,
      filterMatched: M,
      visible: M,
      hasFilter: true,
      hasSearch: false,
      hasMore,
      loadingAll: false,
    });
    expect(status.scopeText).toBe(expected);
  });

  it.each(knownCases)('totalKnown=true, hasMore=%s → 逐字文案（基线不变）', (hasMore, expected) => {
    const status = selectFilterScopeStatus({
      total: 12480,
      totalKnown: true,
      loaded: 200,
      filterMatched: M,
      visible: M,
      hasFilter: true,
      hasSearch: false,
      hasMore,
      loadingAll: false,
    });
    expect(status.scopeText).toBe(expected);
  });
});
