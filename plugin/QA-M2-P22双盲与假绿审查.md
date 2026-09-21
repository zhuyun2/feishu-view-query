# QA-M2 · P2-2 双盲复核 + 工程师 fix.test 假绿审查

- 任务：#16（team-lead 派单，B+C 合并受限范围）
- 执行人：严过关（software-qa-engineer）
- 日期：2026-09-20（**v4 定稿**：D1 修复 #18 落地并独立验证；**M2 三项门禁复跑全绿**）
- 基线：验证窗口内源码冻结，**本报告不改任何实现代码**
- 产出：`plugin/QA-M2-P22双盲与假绿审查.md`（本文件）、`src/config/readonlyUnlock.qa2.test.ts`（我独立编写，**18 用例**）

---

## 0. 结论（一句话）

**P2-2 事件闭环**：订阅回调修复有效；双盲进一步打出 **D1（`load()` 路径未 fail-safe → 覆盖高版本配置的数据丢失路径）**。D1 曾一度被原 Q7 判为「有意设计」，经 team-lead 裁定**推翻原 Q7**、架构师**重写 Q7（`load` 与 `subscribe` 统一 fail-safe、但空值仍解锁）**，工程师修复批次 **#18 已落地**。我已独立复核源码并跑通 **18 条断言全绿**，**D1 修复确认有效**。原 M2 门禁的 2 处红项（均在 software-qa-engineer-2 的文件）**她已修复**，我**复跑三项门禁全绿**（tsc 0 error、eslint 0 problem、vitest 28 文件/380 用例 380 passed）。假绿审查：7 个 fix 文件中 3 条断言原为恒真/无验证力（renderers.p1 ×2、editor ×1），**经工程师加固、我已复验有效**（§4.1）。

---

## 1. 真实工具链输出（本机直调，`.bin` 缺失故绕过）

**复跑时点：修复批次 #18 落地后（v4）。**

| 命令 | 结果 |
|---|---|
| `node ./node_modules/typescript/bin/tsc --noEmit` | **0 error** ✅ |
| `node ./node_modules/eslint/bin/eslint.js "src/**/*.{ts,tsx}" --max-warnings 0` | **0 problem** ✅ |
| `node ./node_modules/vitest/vitest.mjs run` | **Test Files 28 passed (28)**；**Tests 380 passed (380)** ✅ |
| 同上（仅我的文件）`... run src/config/readonlyUnlock.qa2.test.ts` | **18 passed (18)** ✅ |

- 原全量唯一失败 `src/config/p2readonly.qa2.test.ts:201`（**software-qa-engineer-2**）——其用例在「空值」载荷后仍断言只读，与 Q7 修订版「空值 → 解锁」冲突。**她已按 #22 更新（现 L203-216「空值 → 解锁」）**，复跑转绿。
- 原 eslint 唯一红项 `src/data/paging.qa2.test.ts:56 'token' unused`（**software-qa-engineer-2**）**已清理**，复跑 0 problem。
- 我的 `readonlyUnlock.qa2.test.ts`：**18/18 全绿**（含 D1 的 fail-safe 验收 + 空值边界）。
- 说明：vitest 输出中的 stderr 堆栈为测试**故意注入**的异常日志（用于验证字段级/数据层异常隔离并回退 Fallback），**不构成失败**。

---

## 2. P2-2 双盲复核 · 通过项（订阅回调路径 + 共享助手）

| 断言 | 结果 |
|---|---|
| `refreshReadOnlyFromPayload` 纯函数：升版→加锁 / 损坏(degraded)→保持 / **空值(非 degraded)→解锁** / 有效→解锁 | ✅ |
| bridge onDataChange：升版加锁 · 损坏(JSON/checksum)不误解锁 · 降版解锁 · 无关 viewId 隔离 | ✅ |
| localStorage storage 事件：同上 5 类 | ✅ |

---

## 3. D1 全过程 + 修复验证（定稿）

### 3.1 D1 是什么
`load()` 路径（`BridgeConfigRepository.ts` 与 `LocalStorageConfigRepository.ts`）原用内联 `if(unsupportedNewer) add; else delete;`——对「损坏（非法 JSON / checksum 不匹配）/ 空值 / 迁移失败」一律走 `else delete` **误解锁**；若本端此前因更高版本**已加锁**，则「存储后续损坏 → 再次 load 误解锁 → `save()` 成功」会**覆盖更高版本客户端配置（不可逆数据丢失）**。

### 3.2 一次性误判与纠正（记录经过）
- 我据 Q6 fail-safe 口径首次判出 D1（2 条断言 FAIL 即证据）；
- 期间原 Q7 裁定「保持现状、不改 load」，qa-engineer-2 据此提示我 D1 属「假红」；我**独立复核**设计文档后一度按原 Q7 把断言反转为「load 解锁」并撤回 D1；
- **team-lead 随后推翻原 Q7**（认定 D1 为真实缺陷），架构师**重写 Q7**（`03-开发设计文档.md` §0.2 Q7 修订版 + §12 去抑制措辞 + §0.2.1 流程教训：「涉及安全边界的裁定应在独立验证收口后固化、不得含抑制上报措辞」）。
- 我据此把断言**恢复为 fail-safe 口径**并补齐「空值边界」，作为 #18 的验收断言。

### 3.3 Q7 修订版最终语义（我已按此独立断言）
| 输入 | 判定 |
|---|---|
| `unsupportedNewer === true` | **加锁** |
| `degraded === false`（**有效 或 空值**） | **解锁**（保 provision / 清除后重配） |
| `degraded === true`（损坏 / 迁移失败）且非升版 | **保持原标记** |

> 关键：空值与损坏**共用 `config:null`**，靠 **`degraded`** 区分（空值恒 `degraded:false`；`degraded:true` 时 `config` 必为 null）→ 故实现口径为 `!degraded → delete`。

### 3.4 修复落地确认（我读源码交叉验证，非采信 fix 测试）
- `ConfigRepository.ts:255` → `} else if (!result.degraded) {` ✅（原 `result.config !== null` 已改）
- `BridgeConfigRepository.ts:112` → `load()` 内联分支改为 `refreshReadOnlyFromPayload(...)` ✅
- `LocalStorageConfigRepository.ts:81` → 同上 ✅
- 订阅回调调用点保留（`BridgeConfigRepository.ts:221`、`LocalStorageConfigRepository.ts:124`）

### 3.5 D1 验收结果（我的 4 条 load 路径断言，全绿）
| 断言 | 结果 |
|---|---|
| bridge：已只读后 load() 读到损坏 → 标记保持 → save 被拒（`reason:'unsupported-newer-readonly'`） | ✅ |
| bridge：已只读后 load() 读到空值 → 解锁 → save 成功（保 provision） | ✅ |
| localStorage：损坏 → 保持 → save 被拒 | ✅ |
| localStorage：空值 → 解锁 → save 成功 | ✅ |

**结论：D1 修复有效，且未误伤空值/provision 路径。**

---

## 4. 工程师 7 个 `*.fix.test.*` 假绿审查

**全局**：7 文件**无** `.skip/.only/.todo/xit/xdescribe`、**无** try/catch（grep 确认）→ 无「吞失败」「被跳过」问题。

| # | 文件 | 原行号 | 问题类型 | 影响用例有效性？ | 处置 |
|---|---|---|---|---|---|
| 1 | `renderers.p1.fix.test.tsx` | 81-85 | **恒真/无验证力**：`toContain('李')` 是 `'李雷'` 子串 | **是** | ✅ 已加固（见 §4.1） |
| 2 | `renderers.p1.fix.test.tsx` | 113-115 | **无验证力**：`toContain('★★★★★')` 对「9 颗全渲染」也为真 | **是**（证不了裁剪） | ✅ 已加固（见 §4.1） |
| 3 | `editor.fix.test.ts` | 100-101 | **恒真断言**：`attributes.direction==='column'` 与默认值同 | **部分** | ✅ 已加固（见 §4.1） |
| 4 | `renderers.p1.fix.test.tsx` | 70 | 断言内联 `width:20px`（实现细节，脆弱） | 否（对 R4 有验证力） | ✅ 已解耦为 `R4_AVATAR_PX` |
| 5 | `state.fix.test.ts` | 222 | 与实现同源常量 `DRAWER_MIN_WIDTH_PX` 自比 | 否（`detail.fix` L99 钉死 560） | 可精确化（非阻塞） |
| 6 | `state.fix.test.ts` | 186 | 与 `DENSITY_PRESETS.compact.cardMinWidth` 自比 | 否（同用例另有 templateId 断言） | 可精确化（非阻塞） |
| 7 | `detail.fix.test.ts` | 152-161 | 只验边界不等式 | 否（其余几何断言精确） | 可精确化（非阻塞） |
| 8 | `editor.fix.test.ts` | 135 | `toBeDefined` 偏弱 | 否（有 token 不外泄兜底） | 可具体化（非阻塞） |
| — | `grid.fix.test.ts` / `layout.fix.test.tsx` / `readonlyUnlock.fix.test.ts` | — | 无假绿 | — | — |

**小结**：7 文件均能真实失败（非恒绿）；**#1/#2/#3（影响有效性）已由工程师加固并经我复验有效，#4 已解耦**；#5~#8 属非阻塞可精化项。

### 4.1 加固后复验（v4 增补）—— 判据「**故意破坏实现，这条会红吗**」

team-lead 要求我**读改后断言、独立判断有无验证力**（而非复述旧清单）。我逐行重读改后断言，按「若故意破坏对应实现，断言是否转红」判定如下——**结论：三处加固均为真加固，非形式主义**：

| 位置（改后行号） | 改后断言要点 | 故意破坏场景 | 会红？ |
|---|---|---|---|
| `renderers.p1.fix.test.tsx` **L87-94**（原 L81-85） | `toContain('cbv-avatar--initial')` + `toContain('>李</span>')` | 占位元素回落成整名（渲染 `>李雷</span>`）：`>李</span>` 不再为子串 | ✅ **会红** |
| `renderers.p1.fix.test.tsx` **L122-128**（原 L113-115） | `(markup.match(/★/g)??[]).length).toBe(RATING_MAX)` + 空心星计数 `toBe(0)` | 9 颗全渲染：`★` 计数 = 9 ≠ 5（`RATING_MAX=5` 为测试侧字面量） | ✅ **会红** |
| `editor.fix.test.ts` **L93-111**（原 L100-101） | 保留默认值断言 + 新增兄弟槽位判别：改 `subtitle` 后断言 `title`/`footer` 仍 `'row'` | 错改成「全槽位同向」：兄弟槽位会被一并改为 `'column'` | ✅ **会红** |
| `renderers.p1.fix.test.tsx` **L74-76**（原 L70） | `width:${R4_AVATAR_PX}px` / `height:${R4_AVATAR_PX}px` | 头像尺寸被改：`R4_AVATAR_PX=20` 为测试侧字面量，非从实现导入 | ✅ 仍具验证力且已解耦内联 |

> 复核方法：`R4_AVATAR_PX`（L22=20）、`RATING_MAX`（L24=5）均为**测试侧字面常量**，未从实现模块导入，故非「自证式」断言；占位 `>李</span>` 与姓名 `>李雷</span>` 的区分依赖真实 DOM 结构，非恒真。**§4 待办关闭。**

---

## 5. 未验证 / 说明

- 本报告**未**改任何 `src/**` 实现代码，**未**改工程师或 qa-engineer-2 的测试文件；仅维护我自己的 `src/config/readonlyUnlock.qa2.test.ts` 与本报告。
- `dist/` 由 team-lead 维护（#14 已完成）；我**未**跑 webpack、**未**碰 dist。
- M2 门禁**已全绿**（§1）；原 2 处红项（software-qa-engineer-2 的文件）她已修复，我复跑确认清零。

---

## 6. 建议

1. **D1 已闭环**（#18 修复 + 我独立验证 18/18 全绿），无需再动源码。
2. **M2 三项门禁已全绿**（tsc 0 / eslint 0 / vitest 380 passed）；原 2 处红项由 software-qa-engineer-2 修复完毕。
3. 假绿 #1/#2/#3（renderers.p1 ×2、editor ×1）**已由工程师加固并经我复验有效**（§4.1，判据「故意破坏会红」）；#4 已解耦；#5~#8 属非阻塞可精化项。
