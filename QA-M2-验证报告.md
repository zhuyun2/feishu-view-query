# QA-M2 独立验证报告（软件 QA2 · 独立证伪）

| 项目 | 内容 |
|---|---|
| 验证人 | **software-qa-engineer-2（Edward）** |
| 任务 | **#13 / #15 — 独立验证 M2（T07~T13 + P2-2）** |
| 基线文档 | `03-开发设计文档.md`（§0.2 Q1~Q7、§4、§10、§11、§12、§16.1、§17.2）；`04-UI设计说明.md`（§3.4、§5.2、§5.3、§11 R1~R8）。**注：§0.2·Q7 已被主理人 D1 裁定推翻/修订（见 §六）** |
| 纪律 | **仅新增 `*.qa2.test.ts(x)`，零改动实现源码**；**不采信**既有 `*.fix.test.ts` / `*.qa.test.ts` 结论 |
| 运行环境 | Vitest 1.6.1 · jsdom · 工程根 `plugin/` |

---

## 一、结论（TL;DR）

- **D1 已修复并复验通过（2026-09-20）**：主理人裁定 D1 为**真实数据丢失缺陷**（本端因更高版本加锁 → 存储后续损坏 → `load` 误解锁 → `save` 覆盖更高版本配置）。工程师已修复：`load` 路径改用共享助手 `refreshReadOnlyFromPayload`，助手语义改为 **`unsupportedNewer→加锁 / !degraded（有效或空值）→解锁 / degraded（损坏/迁移失败）→保持标记**。
- 本人完成两件事：① 按 **D1 新语义重写 `p2readonly.qa2.test.ts` 的 load 断言**（含新增"空值 → 解锁"边界）；② 修复落地后**独立复跑**。
- **最终结果（修复后）**：本人 6 文件 **123 用例 / 123 通过 / 0 失败**；**全量套件 28 文件 / 380 用例 / 380 通过 / 0 失败**；**ESLint `--max-warnings 0` 0 problem**；**`tsc --noEmit` exit 0**（逐项原始输出见 §十一）。
- **路由：`Send To: NoOne`** —— D1 修复已由工程师完成，并经本人独立复跑确认无遗留源码缺陷。
- **过程更正**：本报告初版曾把该分歧判为"过时口径 / 假红"，**已按主理人裁定更正为 D1 真实缺陷**；D1 修复落地前，本人 `p2readonly.qa2.test.ts` 的 3 条 D1 断言**预期为红**（即缺陷证据），现已转绿（详见 §六）。

---

## 二、验证范围与判定标准

### 2.1 任务覆盖（T07~T13）

| 任务 | 内容 | 我的独立验证文件 |
|---|---|---|
| T07 | P1 渲染器（User/Attachment/Rating/Progress/Link(Url+Phone)/Formula/Lookup） | `src/fields/renderers.p1.qa2.test.tsx` |
| T09 | 卡片四槽位 + 空槽位收合 + 封面口径 | `src/components/card/slots.qa2.test.tsx` |
| T10 | 虚拟滚动 + 分页去重 + 滚动加载节流 | `src/data/paging.qa2.test.ts` |
| T11 | 沉浸式三栏编辑器 | `src/components/editor/editor.qa2.test.tsx` |
| T12 | 详情抽屉 + 悬浮预览意图 | `src/components/detail/drawer.qa2.test.tsx` |
| T13 | 空态 / 错误态 / ErrorBoundary | 由 `layout` / `ErrorBoundary` 既有面 + 本报告契约核对（见 §四·注） |
| P2-2 | 跨会话只读标记随新载荷刷新 + 介质降级单向闭锁 | `src/config/p2readonly.qa2.test.ts` |

### 2.2 P2-2 冻结口径 #1~#7 的验证落点

| 口径 | 内容 | 判定 | 证据 |
|---|---|---|---|
| **#1** | P2-2：`subscribe` 命中 viewId 时按新载荷刷新 `readOnlyViews`（§0.2 Q6 待补项） | ✅ 通过 | `p2readonly.qa2.test.ts`（订阅路径升版加锁/降版解锁/fail-safe/无关 viewId 隔离） |
| **#2** | 编辑器为**沉浸式三栏**（非抽屉）：`ConfigEditor` 220 / 自适应 / 300，顶栏卡片·文档模式切换 + 取消/保存 | ✅ 通过 | `editor.qa2.test.tsx`（三栏渲染、非 `.cbv-drawer`、布局常量 220/300/320/48） |
| **#3** | 抽屉默认 **860px**，可拖 **560 ~ 满宽**，`Esc` **两级** | ✅ 通过 | `drawer.qa2.test.tsx` + `drawerMath.ts`（默认 860 / clamp(560,视口) / 退全屏→关闭） |
| **#4** | cover 模板 ≠ 封面图（卡片**不显示封面图**） | ✅ 通过 | `slots.qa2.test.tsx`（`showCoverImage=false`、无封面元素、卡片内唯一 `<img>` 为属性区 64×64 首图） |
| **#5** | 缩放**下限 0.75**；默认「**适应宽度**」 | ✅ 通过 | `drawerMath.computeFitZoom` 钳制 [0.75,1.5]；`defaultDrawerConfig().defaultFitToWidth === true` |
| **#6** | 密度默认 **标准（3 行）**；紧凑 2 / 宽松 5 | ✅ 通过 | `slots.qa2.test.tsx`（`DENSITY_PRESETS.compact/standard/comfortable = 2/3/5`，`attributesMaxRows(defaultDensity())=3`） |
| **#7** | M2 抽屉正文为**过渡实现**（简易字段清单）；A4 分页属 **M3**，不得谎报已实现 | ✅ 通过 | `drawer.qa2.test.tsx` 契约检查（源码含「过渡实现」「M3」；无 `paginate`/`@/pagination`/`window.print`） |

---

## 三、逐文件裁决（本人交付物）

| 文件 | 用例数 | 结果 | 覆盖要点 |
|---|---|---|---|
| `src/config/p2readonly.qa2.test.ts` | 20 | ✅ 全绿（D1 对齐后） | Q6 助手语义（含"空值→解锁"边界）；bridge/localStorage **订阅路径**；**Q5-B 介质降级单向闭锁**；**D1：`load` 路径损坏保持标记**（修复后转绿） |
| `src/fields/renderers.p1.qa2.test.tsx` | 47 | ✅ 全绿 | 注册表完整性；User 20px 头像+R4；Attachment 64×64+张数+不外泄 `file_token`；Rating/Progress；Link 安全（`javascript:` 退化纯文本、`tel:`）；Formula 分发；Lookup 多值不外泄 `recordId`；**M1 F1 货币符号**（`$`/`€`/兜底`¥`/负数）；全类型异常扫掠不抛错 |
| `src/data/paging.qa2.test.ts` | 14 | ✅ 全绿 | `appendUniqueRecords` 去重；`PagedRecordController` 串行/并发/cache hit；12,000 行逻辑级累加；`ScrollLoadController` 100ms 节流；几何纯函数 |
| `src/components/card/slots.qa2.test.tsx` | 13 | ✅ 全绿 | 四槽位；空槽位按 `collapsibleWhenEmpty` 收合；内分隔线仅在需要时出现；R3 属性行 2/3/5 + `+n`；**#4 cover 不显示封面图** |
| `src/components/editor/editor.qa2.test.tsx` | 13 | ✅ 全绿 | `placementMath` 纯逻辑；**#2 三栏静态契约**（220/300/320/48/860、2px 插入线 `#3370FF`）；`ConfigDrawer` 三栏渲染（**非抽屉**）；模式切换；脏数据二次确认；`PreviewSampleCard` |
| `src/components/detail/drawer.qa2.test.tsx` | 16 | ✅ 全绿 | **#3** `drawerMath`（clamp 560~视口、`fitZoom` [0.75,1.5]、Esc 两级、气泡翻边）；`HoverIntentController`（150ms 触发/快速划过不弹/移入气泡取消隐藏）；`DetailDrawer` 默认 860/缩放钳制/Esc 两级/焦点归位/记录缺失；**#7 过渡实现契约** |

**合计（D1 修复落地后）：123 用例，123 通过，0 失败。**

> 注（T13 覆盖边界）：错误态 / ErrorBoundary 部分由 M1 交付的 `ErrorBoundary.tsx`、`EmptyState.tsx`、`Banner.tsx` 承载，其既有面 + 设计 §12 的 16 类提示条由 `layout.fix.test.tsx`（同事）覆盖；本人复核了 `ErrorBoundary` 的"单字段异常不中断整卡"反例（T07 全类型异常扫掠），未重复造轮子。**这是覆盖分工，非缺口**。

---

## 四、Round 1 失败分析 → 自修（全部判定为"测试侧问题"）

Round 1 首跑：**121 tests / 115 pass / 6 fail**。逐条定位后，**6 条全部为测试侧缺陷（断言错误 / DOM 序列化差异 / 测试间污染），无一为源码缺陷**，故按 QA 路由规则**自修**（未路由给工程师）：

| # | 失败用例 | 根因（判定） | 处置 |
|---|---|---|---|
| 1 | 电话 → `tel:` 链接 | 输入 `'138 0000-0000'` 含连字符；实现仅按设计剥离空格/括号，**连字符为 RFC3966 合法可视分隔符予以保留** → 期望值写错 | 改用空格/括号输入验证剥离；补连字符保留断言（标注合规） |
| 2 | Lookup 纯 ID 对象 → 兜底文案 | 该输入被归一化为**空值占位 `—`**（安全，无 `recordId` 外泄）。设计只要求"不外泄原始 ID/JSON"，**未要求落 FallbackRenderer** | 放宽为「不泄漏 + `—`|兜底二选一」 |
| 3 | `@/config/presets` module not found | 测试内用了 `require('@/config/presets')`，ESM 下 `require` 无法解析别名 | 删除 `require`，改用文件顶部已导入的 `CARD_TEMPLATES` |
| 4 | `clampDrawerWidth(100, 400)` 期望 400 | 实现**优先保下限 560**（视口窄于下限时宁可横向溢出）；该边界**设计未规定**，我的断言属过度指定 | 改断言为 `DRAWER_MIN_WIDTH_PX` 并注释为实现取舍 |
| 5 | 渲染含 `width:860px` | **jsdom 客户端渲染经 CSSOM 序列化**，内联样式为 `width: 860px;`（**含空格**），与 SSR 的 `width:860px` 不同 | 改用正则 `/width:\s*860px/` |
| 6 | Esc 两级（全屏） | **级联失败**：用例 5 在断言处抛错 → 跳过其 `unmount()` → 残留 keydown 监听器在用例 6 中与新手监听器**双重触发**，`closeDrawer` 后又 `toggleFullscreen` 反翻回 `true`。经隔离探针（probe）确认**实现本身正确**：单跑时 Esc 后 `fullscreen=false, open=true` | 修掉 5 后即恢复；并将 `mount()` 改为**登记表 + `afterEach` 强制卸载**（幂等），杜绝用例间监听器泄漏 |

**修正后 Round 2：121/121 全绿，`exit=0`。**（修正仅涉及上述 6 个测试文件，未触碰任何实现源码。）

---

## 五、P2-2 最高风险点专项结论（交付总监指定）

> 施压点：**跨会话只读标记随新载荷刷新**这个口径真的成立吗？同时会不会把 **Q5-B「介质降级单向闭锁」** 打穿（降级后还回写 bridge、还解绑/重绑监听）？

**结论：口径成立，且未打穿 Q5-B。**

1. **订阅路径刷新成立（Q6 / 口径 #1）** — `p2readonly.qa2.test.ts`
   - 收到**升版**载荷 → 置只读 → `save()` 返回 `{ok:false, reason:'unsupported-newer-readonly'}` 且**不落盘**；
   - 收到**降版**载荷 → **解锁** → `save()` 真正写成功并回写介质；
   - 收到**不可信载荷**（非法 JSON / checksum 不匹配 / 空值）→ **保持原标记**（fail-safe，绝不解锁）；
   - **无关 viewId** 载荷不影响本 viewId；仅**订阅目标 viewId** 才触发回调。

2. **Q5-B 单向闭锁完整（未被打穿）** — 同文件
   - bridge `getData` 抛错 → `latchDegrade()`：`isDegraded()===true`、`load.degraded===true`、**bridge 监听器被解绑**（`listenerCount` 1→0，降级后 bridge 广播不再影响本端）；
   - 降级后 `save()` 一律走 fallback，**`setData` 调用数不增（绝不回写 bridge）**，且写入 localStorage fallback；
   - **不可回退**：即便 bridge 后续"恢复"，仍不回写 bridge、`isDegraded()` 恒为 `true`。

3. **`load` 路径（D1 缺陷）** — 订阅路径本身 fail-safe 正确；但 `load` 路径在**损坏载荷**下会误解锁（详见 §六），构成**只读标记面**的数据丢失风险（D1），**不在 P2-2 订阅刷新口径内，但同属"只读标记"安全面**。

---

## 六、⭐ D1 裁定更正与修复复验（2026-09-20）

> **本节取代本报告初版把该分歧判为"过时口径 / 假红"的结论。**

**事实与推翻：**

- 同事 `readonlyUnlock.qa2.test.ts`（任务 #16）最初 2 条用例断言："**`load` 路径读到损坏 → 只读标记必须保持 → `save()` 必须仍被拒**"。
- 本人初版据此断言与 §0.2·Q7 冲突，判其为"过时口径 / 假红"。**该判定被主理人推翻**。
- **D1 是真实数据丢失路径**：本端曾因更高版本**加锁** → 存储**后续损坏** → `load` **误解锁** → `save` **覆盖更高版本配置**（不可逆）。§0.2·**Q7「load 保持现状 / 勿当作缺陷反复上报」为滞后文档**；主理人已**采纳 D1 并推翻旧 Q7**。**同事最初的断言方向是对的。**

**D1 新语义（`load` 与 `subscribe` 两条路径一致）：**

| 载荷解析结果 | 行为 |
|---|---|
| `unsupportedNewer:true` | **加锁** |
| `degraded:false`（有效 **或空值**） | **解锁** |
| `degraded:true` 且非升版（损坏 / 迁移失败） | **保持标记** |

**D1 修复（工程师，2026-09-20）：**

- `src/config/ConfigRepository.ts` `refreshReadOnlyFromPayload`：`else if (result.config !== null)` → **`else if (!result.degraded)`**（D1 语义）。
- `src/config/BridgeConfigRepository.ts` / `LocalStorageConfigRepository.ts` 的 `load`：**废弃旧内联 `if unsupportedNewer add; else delete`，改用共享助手**，与订阅路径语义一致。

**本人已做的对齐（`p2readonly.qa2.test.ts`）：**

- 删除/重写按**旧 Q7**「load 损坏 → 解锁 = 有意行为」的 2 条断言 → 改为**「执行 load 后 `save` 仍被拒」**；
- 新增助手级「**空值（`config=null` 且 `degraded=false`）→ 解锁**」断言（钉住首开 provision，防止修复把空值误判为损坏而锁死首开）；
- 修正"升版不被误清"用例：把其中 `emit(null)` 断言从"仍只读"改为 **"空值 → 解锁"**（D1 下空值 `degraded=false` 属解锁分支），并单列为【D1】用例；
- 文件头注释更正为「**D1 新裁定：两路径一致**」。

**独立复跑（修复落地后，真实输出）：**

```
p2readonly.qa2.test.ts   → tests=20  pass=20  fail=0
本人 6 文件合计          → tests=123 pass=123 fail=0   （success=true）
全量套件                 → tests=380 pass=380 fail=0
```

**⚠️ 修复前后红绿迁移（符合预期，非回归）：**

- 修复前：本人 3 条 D1 断言红（= 缺陷证据）；同事当时的"load 解锁"版绿。
- 修复后：本人 3 条转绿；同事经 **11:37:23** 再对齐（其文件已改为 `[D1] load 损坏 → 保持标记` + 空值解锁），亦转绿。**修复落地期间出现的瞬时红属预修复期预期状态。**

**过程教训（同意主理人记录）**：根因是**校验完成前**即将 Q7 落盘、且 §12 写入"**勿当作缺陷反复上报**"这类**抑制性措辞**，客观把 QA（本人在内）引向错误断言方向 —— 本人据"文档=权威裁定记录"断言本身合理；主理人已就此认领流程问题并记录。本人对据此向同事发出的"口径对齐"私信（曾**短暂**导致其反向改写）承担连带责任，并已随本报告更正。

---

## 七、jsdom 覆盖边界（诚实标注）

以下**不可在 jsdom 中真实验证**，本人只做**逻辑级/契约级**验证，不谎报：

| 项 | 已做到 | 未覆盖（需真机/浏览器） |
|---|---|---|
| T10 虚拟滚动 | `gridMath`/`recordPages`/`ScrollLoadController` 纯逻辑、12k 行累加、100ms 节流 | 真实滚动 FPS、`ResizeObserver` 实测、react-virtual 真实测量窗口 |
| T11 拖拽 | `placementMath` 落位/插入线纯逻辑 | dnd-kit 真实拖拽手势与跨栏落位 |
| T12 抽屉 | 宽度/缩放/Esc/焦点归位的组件行为 | 真实指针拖动改宽、`clientWidth` 实测「适应宽度」反推 |
| M3 | 确认 M2 **未**实现 A4 分页（口径 #7） | A4 分页/纸张/页眉页脚/打印导出（M3 · T16~T20） |

---

## 八、"未改实现"证据（时间戳）

工程无 git 仓库，故以文件 `LastWriteTime` 佐证（**本人从未编辑实现源码**）：

- **实现源码改动（全部由工程师完成）**：P2-2 批 `ConfigRepository.ts` @ 19:04:54 / `BridgeConfigRepository.ts` @ 19:05:12 / `LocalStorageConfigRepository.ts` @ 19:05:26；**D1 修复批** @ **19:35:50 / 19:35:54 / 19:36:29**。
- **测试文件改动**：`readonlyUnlock.fix.test.ts` @ 19:05:44、19:37:16（工程师）；`readonlyUnlock.qa2.test.ts` @ 19:15:20、19:35:44、19:37:23（同事）。
- **本人 6 个文件**：`p2readonly.qa2.test.ts` @ 19:18:44（**D1 对齐重写 @ 19:32:12，末次 @ 19:42:09**）、`paging.qa2.test.ts` @ 19:20:25、`editor.qa2.test.tsx` @ 19:20:45、`renderers.p1.qa2.test.tsx` @ 19:26:57、`slots.qa2.test.tsx` @ 19:26:59、`drawer.qa2.test.tsx` @ 19:27:09。

→ **本人仅新增/编辑上述 6 个测试文件，未改动任何实现源码**（实现源码时间戳均落在工程师两次修复批内）。

---

## 九、复现命令

```bash
# 工程根：feishu-card-view/plugin
# 本人 6 文件（D1 修复落地后）
node ./node_modules/vitest/vitest.mjs run \
  src/config/p2readonly.qa2.test.ts \
  src/fields/renderers.p1.qa2.test.tsx \
  src/components/card/slots.qa2.test.tsx \
  src/data/paging.qa2.test.ts \
  src/components/editor/editor.qa2.test.tsx \
  src/components/detail/drawer.qa2.test.tsx
# → 123 tests / 123 pass / 0 fail

# 全量回归
node ./node_modules/vitest/vitest.mjs run
# → 28 文件 / 380 tests / 380 pass / 0 fail

# ESLint
node ./node_modules/eslint/bin/eslint.js "src/**/*.{ts,tsx}" --max-warnings 0
# → 0 problem（exit 0）

# 类型检查
node ./node_modules/typescript/bin/tsc --noEmit
# → exit 0（无输出）
```

---

## 十、路由裁定

| 对象 | 裁定 | 说明 |
|---|---|---|
| **源码缺陷 D1** | **Send To: Engineer → 已修复 → 本人复验通过** | `load` 路径损坏保持只读标记（与 `subscribe` 一致）；工程师修复批 19:35–19:36 落地 |
| 本人 6 文件（123 用例） | **QA2 交付完成** | **123/123 全绿**；全量 **380/380 全绿** |
| `readonlyUnlock.qa2.test.ts`（同事） | **已按 D1 再对齐（19:37:23）** | 其 `[D1]` 断言现与本人一致（load 损坏→保持标记；空值→解锁），全绿 |

**结论：M2（T07~T13 + P2-2 + D1）经本人独立复验通过，无遗留源码缺陷。**

---

## 十一、逐项实测清单（**含未通过项与未验证项** —— 不再只报绿项）

| 检查项 | 命令 | 实测结果（原始） | 判定 |
|---|---|---|---|
| 单元测试 | `node ./node_modules/vitest/vitest.mjs run` | `testResults.length=28`；`tests=380 pass=380 fail=0`；`success=true` | ✅ |
| ESLint | `node ./node_modules/eslint/bin/eslint.js "src/**/*.{ts,tsx}" --max-warnings 0` | **无输出；`EXITCODE=0`（0 problem）** | ✅（初次为 1 error，见下） |
| 类型检查 | `node ./node_modules/typescript/bin/tsc --noEmit` | **无输出；`EXITCODE=0`** | ✅ |
| 本人 6 文件子集 | vitest 指定 6 个 `*.qa2.test.*` | `tests=123 pass=123 fail=0` | ✅ |

**⚠️ 修正记录（曾未通过项，本版补报）：**

- 文件 `src/data/paging.qa2.test.ts:56`：ESLint 报 `@typescript-eslint/no-unused-vars: 'token' is defined but never used`。**已修**：`async (token) => {…}` → `async () => {…}`（该 loader 未使用游标）。修复后 ESLint 0 problem、vitest 仍 380/380。
- 该项在上一版报告中**漏报**（当时只报 vitest 绿项）。**认领流程缺陷**：验证报告须**逐项实测、逐项列出**，含未通过项与未验证项；只报绿项会损害整份报告可信度。**本版起所有验证项一律显式列出。**

**❌ 未验证项（诚实标注，未做 / 不可做）：**

- 真实浏览器滚动与渲染性能（T10 · FPS/测量）、真实拖拽手势（T11 · dnd-kit）、真实指针拖宽与 `clientWidth` 实测（T12）、M3 的 A4 分页 —— jsdom 不可测，**未验证**（详见 §七）。
- `npm run build`（webpack 生产产物）：本轮**未执行**（非本次验证范围）。

*报告结束。*
