/**
 * QA（qa-fix2-batch）· **独立证伪**：矛盾文案不可能再出现 + 夹具本身有判别力。
 *
 * 用户真机截图（逐字）：
 *  A 工具栏 `共 0 条 · 已在已加载的 200 条中筛选，命中 5 条`
 *    A 状态行 `已在已加载的 200 / 共 0 条中筛选，命中 5 条`
 *  B 工具栏 `共 0 条（已筛选 58 条）`
 *    B 状态行 `已在全部 0 条中筛选，命中 58 条`
 *
 * 本文件做两件事：
 *  ① **穷举组合**（totalKnown × hasMore × hasFilter × hasSearch × total × loaded × 命中数），
 *     对每一个组合断言「不变量」：任何「共 N 条」的 N 必须 ≥ loaded；命中 > 0 时不得出现
 *     「共 0 条」/「全部 0 条」/「已加载的 0 条中」；文案里绝无 `NaN`；
 *     两条截图原文逐字不得复现。
 *  ② **夹具自检（判别力证明）**：先用「修复前算法」的复刻版产出截图原文，
 *     再用同一套不变量断言它「确实会变红」——证明我的断言不是恒真。
 *
 * ⚠️ 本文件为 QA 权属新增，不修改任何实现或既有测试。
 */
import { describe, expect, it } from 'vitest';
import { selectCountLabel, selectFilterScopeLabel, selectFilterScopeStatus } from '@/state/selectors';

/* =====================================================================
 * ① 不变量断言器（oracle）+ 判别力自检
 * ===================================================================== */

function group(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString('en-US');
}

/**
 * 文案不变量。
 * @param text 待检查文案
 * @param label 断言上下文（组合描述）
 * @param loaded 已加载条数（分母下界）
 * @param hit 该文案真正展示的「命中数」
 */
function checkInvariants(text: string, label: string, loaded: number, hit: number): void {
  expect(text, label).not.toContain('NaN');
  if (hit > 0) {
    // 命中 > 0 时，任何「分母为 0」的措辞都是对用户说谎（截图 A/B 的根因）
    expect(text, label).not.toContain('共 0 条');
    expect(text, label).not.toContain('全部 0 条');
    expect(text, label).not.toContain('已加载的 0 条中');
  }
  const knownTotal = /共 ([\d,]+) 条/.exec(text);
  if (knownTotal) {
    const n = Number(knownTotal[1].replace(/,/g, ''));
    // 「共 N 条」的 N 是宣称的总量；宣称量小于已加载量 = 自相矛盾
    expect(n, `${label} :: 共 N 条 N=${n} 必须 ≥ loaded=${loaded}`).toBeGreaterThanOrEqual(loaded);
  }
  const allTotal = /已在全部 ([\d,]+) 条中/.exec(text);
  if (allTotal) {
    const n = Number(allTotal[1].replace(/,/g, ''));
    expect(n, `${label} :: 已在全部 N 条中 N=${n} 必须 ≥ loaded=${loaded}`).toBeGreaterThanOrEqual(loaded);
    if (hit > 0) expect(n, `${label} :: 命中>0 时「全部」分母不得为 0`).toBeGreaterThan(0);
  }
}

describe('① 判别力自检：同一套不变量对「已知错误」必须变红、对「已知正确」必须为绿', () => {
  it('截图原文 A（工具栏）→ 不变量必须变红（命中 5 > 0 却「共 0 条」）', () => {
    expect(() => checkInvariants('共 0 条 · 已在已加载的 200 条中筛选，命中 5 条', 'A-toolbar', 200, 5)).toThrow();
  });

  it('截图原文 A（状态行）→ 不变量必须变红（分母为 0 却出现 200）', () => {
    expect(() => checkInvariants('已在已加载的 200 / 共 0 条中筛选，命中 5 条', 'A-status', 200, 5)).toThrow();
  });

  it('截图原文 B（工具栏）→ 不变量必须变红', () => {
    expect(() => checkInvariants('共 0 条（已筛选 58 条）', 'B-toolbar', 200, 58)).toThrow();
  });

  it('截图原文 B（状态行）→ 不变量必须变红（命中 58 > 0 却「全部 0 条」）', () => {
    expect(() => checkInvariants('已在全部 0 条中筛选，命中 58 条', 'B-status', 200, 58)).toThrow();
  });

  it('已知正确文案 → 不变量保持为绿（防止断言恒真 / 过严）', () => {
    expect(() => checkInvariants('已在已加载的 200 条中筛选，命中 5 条', 'ok-1', 200, 5)).not.toThrow();
    expect(() => checkInvariants('已在全部 12,480 条中筛选，命中 37 条', 'ok-2', 12480, 37)).not.toThrow();
    expect(() => checkInvariants('共 12,480 条 · 已在已加载的 200 条中筛选，命中 5 条', 'ok-3', 200, 5)).not.toThrow();
    expect(() => checkInvariants('已加载 200 条', 'ok-4', 200, 0)).not.toThrow();
    expect(() => checkInvariants('共 0 条（已筛选 0 条）', 'ok-5', 0, 0)).not.toThrow();
  });
});

/* =====================================================================
 * ② 复刻「修复前」分母算法 → 证明截图原文是可被这批修复消除的
 * ===================================================================== */

/** 修复前（工具栏口径）：只按 totalKnown 判定，缺少 `total ≥ loaded` 闸门 */
function legacyToolbarText(input: {
  total: number;
  totalKnown: boolean;
  loaded: number;
  matched: number;
  hasFilter: boolean;
  hasSearch: boolean;
  hasMore: boolean;
}): string {
  const narrowed = input.hasFilter || input.hasSearch;
  if (!narrowed) return `共 ${group(input.total)} 条`;
  if (input.hasMore) {
    return `共 ${group(input.total)} 条 · 已在已加载的 ${group(input.loaded)} 条中筛选，命中 ${group(input.matched)} 条`;
  }
  return `共 ${group(input.total)} 条（已筛选 ${group(input.matched)} 条）`;
}

/** 修复前（状态行口径）：总数未知分支**误用 total 当分母** */
function legacyStatusText(input: {
  total: number;
  totalKnown: boolean;
  loaded: number;
  matched: number;
  hasFilter: boolean;
  hasSearch: boolean;
  hasMore: boolean;
}): string {
  if (!input.hasFilter && !input.hasSearch) return '';
  const known = input.totalKnown !== false;
  if (known) {
    return input.hasMore
      ? `已在已加载的 ${group(input.loaded)} / 共 ${group(input.total)} 条中筛选，命中 ${group(input.matched)} 条`
      : `已在全部 ${group(input.total)} 条中筛选，命中 ${group(input.matched)} 条`;
  }
  return input.hasMore
    ? `已在已加载的 ${group(input.total)} 条中筛选，命中 ${group(input.matched)} 条`
    : `已在全部 ${group(input.total)} 条中筛选，命中 ${group(input.matched)} 条`;
}

/** 修复前 selectCountLabel 桩：无条件用 total 当分母（复刻截图 B 工具栏） */
function selectCountLabelLegacy(total: number, loaded: number, filteredCount: number): string {
  void loaded;
  return `共 ${group(total)} 条（已筛选 ${group(filteredCount)} 条）`;
}

describe('② 修复前算法确实会产出截图原文（控制组）', () => {
  it('工具栏：total=0 / totalKnown 视作已知 / loaded=200 / 命中 5 / hasMore → 截图 A 工具栏原文', () => {
    const legacy = legacyToolbarText({
      total: 0,
      totalKnown: true,
      loaded: 200,
      matched: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(legacy).toBe('共 0 条 · 已在已加载的 200 条中筛选，命中 5 条');

    // 现行实现（明确 totalKnown=false）→ 必须不再复现
    const now = selectFilterScopeLabel({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(now).not.toBe(legacy);
    expect(now).toBe('已在已加载的 200 条中筛选，命中 5 条');
    checkInvariants(now, 'now-A', 200, 5);
  });

  it('状态行：totalKnown=false / total=0 / loaded=200 / 命中 58 / !hasMore → 截图 B 状态行原文', () => {
    const legacy = legacyStatusText({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 58,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
    });
    expect(legacy).toBe('已在全部 0 条中筛选，命中 58 条');

    const now = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 200,
      filterMatched: 58,
      visible: 58,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
      loadingAll: false,
    }).scopeText;
    expect(now).not.toBe(legacy);
    expect(now).toBe('已在全部 200 条中筛选，命中 58 条');
    checkInvariants(now, 'now-B', 200, 58);
  });

  it('工具栏：totalKnown=false / hasMore=false → 旧实现曾用 total 当分母（截图 B 工具栏）', () => {
    const legacy = selectCountLabelLegacy(0, 200, 58);
    expect(legacy).toBe('共 0 条（已筛选 58 条）');
    // 现行实现（totalKnown=false）不得复现
    const now = selectFilterScopeLabel({
      total: 0,
      totalKnown: false,
      loaded: 200,
      matched: 58,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
    });
    expect(now).not.toBe(legacy);
    checkInvariants(now, 'now-B-toolbar', 200, 58);
  });
});

/* =====================================================================
 * ③ 穷举组合：不变量必须恒成立
 * ===================================================================== */

interface Combo {
  total: number;
  totalKnown: boolean;
  loaded: number;
  hasFilter: boolean;
  hasSearch: boolean;
  hasMore: boolean;
  /** 引擎求值后的筛选命中数（无筛选时 = loaded） */
  filterHit: number;
  /** 最终可见数（搜索再收窄后） */
  visibleHit: number;
}

function buildCombos(): Combo[] {
  const combos: Combo[] = [];
  const totals = [0, 5, 100, 12480];
  const loadeds = [0, 5, 100, 200];
  for (const totalKnown of [true, false]) {
    for (const hasMore of [true, false]) {
      for (const hasFilter of [true, false]) {
        for (const hasSearch of [true, false]) {
          for (const loaded of loadeds) {
            for (const total of totals) {
              const hitCandidates = hasFilter ? Array.from(new Set([0, Math.ceil(loaded / 2), loaded])) : [loaded];
              for (const filterHit of hitCandidates) {
                if (filterHit > loaded) continue;
                const visibleCandidates = hasSearch ? Array.from(new Set([0, filterHit])) : [filterHit];
                for (const visibleHit of visibleCandidates) {
                  if (visibleHit > filterHit) continue;
                  combos.push({
                    total,
                    totalKnown,
                    loaded,
                    hasFilter,
                    hasSearch,
                    hasMore,
                    filterHit,
                    visibleHit,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

const COMBOS = buildCombos();

function describeCombo(c: Combo): string {
  return `total=${c.total} totalKnown=${c.totalKnown} loaded=${c.loaded} hasFilter=${c.hasFilter} hasSearch=${c.hasSearch} hasMore=${c.hasMore} filterHit=${c.filterHit} visibleHit=${c.visibleHit}`;
}

describe('③ 穷举组合：任何组合下都不得出现矛盾文案', () => {
  it(`覆盖 ${COMBOS.length} 个组合（存在性锚点，防止空循环假绿）`, () => {
    expect(COMBOS.length).toBeGreaterThan(500);
  });

  it('selectFilterScopeLabel：不变量恒成立 + 两条截图原文逐字不出现', () => {
    const forbidden = [
      '共 0 条 · 已在已加载的 200 条中筛选，命中 5 条',
      '已在全部 0 条中筛选，命中 58 条',
    ];
    for (const c of COMBOS) {
      const label = selectFilterScopeLabel({
        total: c.total,
        totalKnown: c.totalKnown,
        loaded: c.loaded,
        matched: c.visibleHit,
        hasFilter: c.hasFilter,
        hasSearch: c.hasSearch,
        hasMore: c.hasMore,
      });
      const ctx = `label ${describeCombo(c)}`;
      checkInvariants(label, ctx, c.loaded, c.visibleHit);
      for (const bad of forbidden) expect(label, ctx).not.toBe(bad);
    }
  });

  it('selectFilterScopeStatus：不变量恒成立 + 两条截图原文逐字不出现', () => {
    const forbidden = [
      '已在已加载的 200 / 共 0 条中筛选，命中 5 条',
      '已在全部 0 条中筛选，命中 58 条',
    ];
    for (const c of COMBOS) {
      const status = selectFilterScopeStatus({
        total: c.total,
        totalKnown: c.totalKnown,
        loaded: c.loaded,
        filterMatched: c.filterHit,
        visible: c.visibleHit,
        hasFilter: c.hasFilter,
        hasSearch: c.hasSearch,
        hasMore: c.hasMore,
        loadingAll: false,
      });
      const ctx = `status ${describeCombo(c)}`;
      if (!status.visible) {
        expect(status.scopeText, ctx).toBe('');
        continue;
      }
      const shownHit = c.hasFilter ? c.filterHit : c.visibleHit;
      checkInvariants(status.scopeText, ctx, c.loaded, shownHit);
      for (const bad of forbidden) expect(status.scopeText, ctx).not.toBe(bad);
      // 未加载全部时绝不允许出现「全部」字样（不假绿铁律）
      if (c.hasMore) {
        expect(status.scopeText, ctx).not.toContain('已在全部');
        expect(status.incompleteText, ctx).toBe('未加载全部');
      } else {
        expect(status.incompleteText, ctx).toBeNull();
      }
    }
  });
});

/* =====================================================================
 * ④ 点名组合：实现方明确没覆盖的边界（逐字锁定）
 * ===================================================================== */

describe('④ 点名边界组合（实现方未覆盖）', () => {
  it('totalKnown=true 且 total(100) < loaded(200) → 退回 loaded 分母', () => {
    const label = selectFilterScopeLabel({
      total: 100,
      totalKnown: true,
      loaded: 200,
      matched: 7,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
    });
    expect(label).toBe('已在全部 200 条中筛选，命中 7 条');
    checkInvariants(label, 'total<loaded', 200, 7);

    const status = selectFilterScopeStatus({
      total: 100,
      totalKnown: true,
      loaded: 200,
      filterMatched: 7,
      visible: 7,
      hasFilter: true,
      hasSearch: false,
      hasMore: false,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在全部 200 条中筛选，命中 7 条');
  });

  it('total=0 且 totalKnown=true 且 loaded>0 且命中>0 → 不得出现「共 0 条」', () => {
    const label = selectFilterScopeLabel({
      total: 0,
      totalKnown: true,
      loaded: 200,
      matched: 5,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).toBe('已在已加载的 200 条中筛选，命中 5 条');
    expect(label).not.toContain('共 0 条');
    checkInvariants(label, 'zero-known', 200, 5);
  });

  it('命中>0 但 total=0（hasMore=false）→ 「已在全部 loaded 条中筛选」，不得用 total', () => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: true,
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
    expect(status.scopeText).not.toContain('共 0 条');
  });

  it('搜索单独生效（无插件筛选）+ 总数未知 → 同样诚实（不得谎报「共 0 条」）', () => {
    const status = selectFilterScopeStatus({
      total: 0,
      totalKnown: false,
      loaded: 200,
      filterMatched: 200,
      visible: 5,
      hasFilter: false,
      hasSearch: true,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).toBe('已在已加载的 200 条中搜索，命中 5 条');
    checkInvariants(status.scopeText, 'search-only', 200, 5);
  });

  it('无筛选无搜索 + 总数未知 → 工具条退化为「已加载 L 条」', () => {
    expect(selectCountLabel(0, 200, false, false)).toBe('已加载 200 条');
    expect(selectCountLabel(0, 0, false, false)).toBe('已加载 0 条');
  });

  it('脏数据（NaN / 负数 / 非数字）→ 绝不出现 NaN，且不谎报', () => {
    const label = selectFilterScopeLabel({
      total: Number.NaN,
      loaded: 200,
      matched: Number.NaN,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
    });
    expect(label).not.toContain('NaN');
    checkInvariants(label, 'dirty', 200, 0);

    const status = selectFilterScopeStatus({
      total: -3,
      totalKnown: true,
      loaded: 200,
      filterMatched: -1,
      visible: -1,
      hasFilter: true,
      hasSearch: false,
      hasMore: true,
      loadingAll: false,
    });
    expect(status.scopeText).not.toContain('NaN');
    expect(status.scopeText).not.toContain('-');
  });
});
