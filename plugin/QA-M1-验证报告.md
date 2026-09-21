# QA-M1 独立验证报告

- 项目：飞书多维表格扩展视图插件「卡片视图」（Card View）
- 里程碑：**M1 骨架打通（T01~T06）**
- 代码路径：`feishu-card-view/plugin/`
- 设计依据：`feishu-card-view/03-开发设计文档.md` §4 / §6 / §12 / §16.1 / §17.3
- 验证人：严过关（QA） · 验证日期：2026-09-20
- 被验证方：寇豆码（Engineer）自检声明（本报告为**独立复核**，不采信其结论）

---

## 0. 结论（一句话）

> **【M1 最终结论 · 2026-09-20 第二轮回归后更新】**
> 工程师已完成 F1~F5 + Q4 修复；本轮 QA **独立回归**（把第一轮 3 条「缺陷实证」断言反转为「回归」断言、并按 F2 新口径补齐「数据损坏不切介质」等断言）后，**全部通过**：`tsc` 0 error、`vitest` **14 文件 / 135 用例全绿**、`eslint` 0 warning、`dist/` 产物齐备且内容合法。**第一轮识别的 F1~F5 五条缺陷经源码交叉复核 + 回归断言双重确认已闭合**；M1 工程侧与单元级证据充分，**判定 M1 可验收**。唯一保留项仍为「真机端到端」判据（本环境无飞书宿主，无法验证）。详见 §9。

<details>
<summary>（第一轮结论留档）</summary>

**M1 的工程侧与单元级证据充分、可进入验收**：配置层（64KB 边界/viewId 隔离/损坏回退+备份/更高版本只读标记）、字段渲染（P0 八类双态 + 渲染器级异常隔离）、数据层（分页/游标/clamp/缓存）均经独立测试通过，`tsc`/`vitest`/`eslint` 全绿、`dist/` 产物齐备；**但**存在 1 处 Med 级用户可见缺陷（多币种符号丢失，见 F1）与 3 处 Low/Info 项，且**「真机打开插件渲染真实数据卡片」这一端到端判据在本环境无法验证**（无飞书环境），需人工在真实多维表格中确认。

</details>

---

## 1. 验证方法与命令（真实输出）

| 命令 | 结果 |
|---|---|
| `node .\node_modules\typescript\bin\tsc --noEmit` | `TSC_EXIT=0`（0 error，含 QA 新增测试） |
| `node .\node_modules\vitest\vitest.mjs run` | `Test Files 11 passed (11)` / `Tests 111 passed (111)` / `VITEST_EXIT=0` |
| `node .\node_modules\eslint\bin\eslint.js "src/**/*.{ts,tsx}" --max-warnings 0` | `ESLINT_EXIT=0`（0 warning） |
| `Grep dist` | `dist/` 含 `project.config.json`、`index.json`、`index.html`、`index.*.js`、chunk 资源 |
| 基线复跑（仅工程师 4 个测试文件） | `Test Files 4 passed (4)` / `Tests 42 passed (42)` —— 工程师声明 2 成立 |

`dist/project.config.json`：`{"appid":"cli_xxxxxxxxxxxxxxxx","projectname":"card-view","blocks":["index"]}`
`dist/index.json`：`{"blockTypeID":"blk_xxxxxxxxxxxxxxxx","blockRenderType":"offlineWeb"}`

> 说明：本次仅按指示 `Grep` 校验 dist 产物，**未重跑 `webpack --mode production`**。

---

## 2. 通过清单

| 验证项 | 关键证据（QA 独立编写） |
|---|---|
| A1 迁移幂等（连续迁移两次结果一致 / 固定点稳定 / 不随调用漂移） | `migrations.qa.test.ts` 用例 1、2 |
| A1 空对象 / 缺字段 → 补齐合法默认结构 | `migrations.qa.test.ts` 用例 3、4 |
| A1 顶层未知字段按 §4.5 被丢弃、旧 `layout` 被清理 | `migrations.qa.test.ts` 用例 5 |
| A1 已知分支内未知字段被保留（浅合并不丢扩展） | `migrations.qa.test.ts` 用例 6 |
| A1 更高版本 → `isSupportedSchema=false` / `needsMigration=false`，且已知字段仍可读 | `migrations.qa.test.ts` 用例 7、8；`ConfigRepository.qa.test.ts` 只读标记用例 |
| A1 非对象/数组/null → `MigrationError`；`fromVersion=NaN` 不崩 | `migrations.qa.test.ts` 用例 9、10 |
| A2 篡改任意一字节 → checksum 变化；空串/超长串不崩 | `hash.qa.test.ts` 用例 1、3 |
| A2 `checksumOf` 单字节 payload 改动即变化；`stableStringify` 稳定 | `hash.qa.test.ts` 用例 2、4；`utf8ByteLength` 代理对用例 5 |
| A3 **恰好 64KB** → `ok=true` 且可落盘读回 | `ConfigRepository.qa.test.ts`「恰好 64KB」用例 |
| A3 **64KB+1** → 拦截（`tooLarge=true`）、提示含「64KB」、**不落盘** | `ConfigRepository.qa.test.ts`「64KB+1」用例 |
| A3 接近上限（>80%）→ `warn=true` 但仍可保存 | `ConfigRepository.qa.test.ts` 告警用例 |
| A3 viewId 隔离（localStorage：写 A 不影响 B、删 A 不影响 B） | `ConfigRepository.qa.test.ts` 用例 |
| A3 viewId 隔离（bridge：两视图 key 不同、互不覆盖） | `ConfigRepository.qa.test.ts` 用例 |
| A3 损坏配置 → 回退默认 + **原值被逐字备份** | `ConfigRepository.qa.test.ts` 非法 JSON / checksum 不匹配 / bridge 三用例 |
| A3 介质降级标志：bridge 不可用 → localStorage 且 `degraded=true` + 可展示原因 | `factory.qa.test.ts` 两用例 |
| A4 只读约束（`Grep src/sdk/`、`src/data/`） | 仅注释出现 `setRecord/addRecord/deleteRecord/updateRecord/createRecord/getRecordList`，**无真实调用** |
| B5 normalize 恶意输入（null/嵌套对象/对象数组/超长文本/未知类型/高危 key/`{"` 字符串）不外泄原始 ID/JSON | `normalize.qa.test.ts` 用例 1–10 |
| B6 P0 八类字段**卡片态**渲染正确 | `renderers.qa.test.ts` 用例 1 |
| B6 P0 八类字段**文档态**渲染正确（含字段名标签、多选不折叠） | `renderers.qa.test.ts` 用例 2 |
| B6 多行文本：卡片态截断（省略号）、文档态不截断 | `renderers.qa.test.ts` 用例 3 |
| B6 未注册类型 → `FallbackRenderer` | `renderers.qa.test.ts` 用例 5 |
| B7 **字段级异常隔离**：`renderCard`/`renderDoc` 捕获渲染异常 → FallbackRenderer | `renderers.qa.test.ts` 异常隔离用例 1、2 |
| B7 **同一卡片其他字段仍正常渲染**（不崩卡实证） | `renderers.qa.test.ts` 「同一卡片内」用例 |
| C8 `pageSize > 200` clamp 到 200；`<=0` clamp 到 1 | `SdkRecordDataSource.qa.test.ts` 用例 1、2 |
| C8 pageToken 透传（首页 undefined；续页字符串→数字）；非数字游标视为首页 | 同文件用例 3、5 |
| C8 末页（`hasMore` 缺省、`pageToken=null`）→ `hasMore=false` | 同文件用例 4 |
| C8 **缓存命中不重复请求**（mock 计数=1）；不同 token/clearCache 行为正确 | 同文件用例 6、7 |
| C9 空表（无 `records`/`records` 非数组）→ 空数组不崩 | 同文件用例 8、9 |
| C9 `getVisibleRecordIds` 抛错 → `[]`、`count()`=0；过滤非字符串 id | 同文件用例 11、12 |
| C9 `getRecordFields`/`getRecordId` 容错 | 同文件用例 13、14 |
| D10 产物齐备 + 三命令全绿 | 见 §1 |
| D11 卫生扫描：`console.log`（log.ts 外）0 处、`any` 0 处、`TODO` 0 处、`@ts-ignore/@ts-expect-error` 0 处、`eslint-disable` 仅 log.ts 1 处（预期） | `Grep src/` |

---

## 3. 失败清单（验证结论为「不通过 / 与预期不符」）

| 验证项 | 现象 | 证据 | 级别 |
|---|---|---|---|
| 货币符号渲染 | 渲染态恒输出 `¥`，忽略字段 `property.symbol`（normalize 已解析为 `$`） | `renderers.qa.test.ts`「货币渲染忽略字段 symbol」 | **Med** |
| bridge 运行期抛错 → 降级 localStorage（任务书 A3 预期） | **未实现**：`load()` 捕获后仍 `source='bridge'`、`config=null`，不切 localStorage | `ConfigRepository.qa.test.ts`「[实证] bridge.getData 抛错」 | Med |
| 字段值异常「不崩卡」的全路径承诺 | `normalize()` 不在 try/catch 内，字段值访问即抛时异常逃逸到渲染期 | `renderers.qa.test.ts`「组件路径…异常逃逸」 | Low |
| 对象值灌入数字/货币字段 | 被 `Number('')` 强转为 `0` / `¥0.00`，而非 empty/unsupported | `normalize.qa.test.ts`「对象灌入数字/货币字段」 | Low |
| 更高版本「禁止保存」 | 仓储 `save()` 无 `unsupportedNewer` 校验，仅 Banner 提示（依赖 UI 自律） | `Grep unsupportedNewer`：无 save 侧拦截 | Low |

> 注：QA 新增的 69 条用例**全部通过**；上表为「复核项与预期不符」的偏差，非测试失败。

---

## 4. 未验证清单

| 验证项 | 原因 |
|---|---|
| 真机「打开插件 → 看到真实数据渲染出的卡片」（M1 判据之一） | 本环境无飞书多维表格宿主，无法运行插件；仅能从单元测试 + 构建产物推断 |
| `bridge` 跨用户共享 / 跨用户一致性（设计 V4 Spike、t001 P0-05） | 需两台账号 + 真实宿主；本环境 bridge 不可用，已走 localStorage 分支 |
| `getRecordsByPage` 结果自动遵循视图「原生筛选/排序」（D7 / T05） | 需真实视图筛选数据；本环境仅以 mock 验证分页/游标协议 |
| 1.2 万行性能（首屏 ≤3s / 滚动 ≥50FPS，§13.1） | 需真实大表与浏览器性能采样；M1 未含虚拟滚动（T10） |
| `webpack --mode production` 重跑 | 按指示仅 grep 产物，未重跑构建 |
| 全局 Error Boundary「插件不白屏」（§12） | 属 T13 范围，M1 未交付；本次仅验证字段级隔离 |

---

## 5. 缺陷列表（含复现方式）

### F1 [Med] 货币渲染器硬编码 `¥`，忽略字段货币符号
- **文件**：`src/fields/renderers/NumberRenderer.tsx:15`（`renderCard` 与 `renderDoc` 的 `resolveText` 均使用字面量 `'¥'`）；对照 `src/fields/normalize.ts:48-54`（`resolveCurrencySymbol` 正确解析 `property.symbol`）
- **复现**：
  1. `normalize(1234.5, { id:'f_cur', type: FieldType.Currency, property:{ symbol:'$' } })` → `display === '$1,234.50'`
  2. 对同一 `NormalizedValue` 调用 `renderCard/renderDoc` → 输出 `¥1,234.50`
- **期望**：渲染字段配置的货币符号（`$`）；**实际**：恒为 `¥`
- **证据**：`src/fields/renderers.qa.test.ts`「[缺陷实证·Med] 货币渲染忽略字段 symbol」
- **影响**：多币种表格金额币种展示错误（用户可见）

### F2 [Med] bridge 运行期异常不切换存储介质
- **文件**：`src/config/BridgeConfigRepository.ts:45-53`（catch 后 `source` 仍为 `'bridge'`）；介质切换只发生在探测期 `src/config/factory.ts:25-34`
- **复现**：`bridge.getData` reject → `repo.load(id)` 返回 `{ degraded:true, source:'bridge', config:null }`，不写 localStorage、不切介质
- **期望（任务书 A3）**：bridge 抛异常时降级到 localStorage 且 `degraded=true`；**实际**：仅标记 degraded，介质不变
- **证据**：`src/config/ConfigRepository.qa.test.ts`「[实证] bridge.getData 抛错」
- **备注**：该实现与设计 §12「存储降级=探测期选型」一致，若产品要求运行期兜底则需补；分级取 Med

### F3 [Low] 字段值在 `normalize()` 阶段抛错时不在 try/catch 内
- **文件**：`src/components/card/FieldValue.tsx:26-29`（`useMemo(() => normalize(...))`）；`src/fields/registry.ts:62-79` 的 try/catch 仅包住渲染器调用
- **复现**：记录字段值为「访问即抛」的对象（Proxy）；`renderToStaticMarkup(<Card .../>)` 抛错
- **期望（§12）**：单字段失败 → 兜底、不白屏；**实际**：异常从 `normalize` 逃逸，卡片渲染中断
- **证据**：`src/fields/renderers.qa.test.ts`「[缺陷实证·Low] 组件路径…」
- **备注**：SDK 正常返回纯 JSON，实际触发概率低

### F4 [Low] 对象值灌入数字/货币字段被强转为 0
- **文件**：`src/fields/normalize.ts:91`（`Number(toSafeText(raw))`，对象 → `Number('')` = 0）
- **复现**：`normalize({obj_token:'x'}, Number)` → `{ kind:'number', number:0, isEmpty:false }`；Currency → `¥0.00`
- **期望**：empty 或 unsupported；**实际**：显示 `0` / `¥0.00`
- **证据**：`src/fields/normalize.qa.test.ts`「[缺陷实证·Low] 对象灌入数字/货币字段」

### F5 [Low] `unsupportedNewer` 未在仓储层禁止保存
- **文件**：`src/config/BridgeConfigRepository.ts:56-68`、`src/config/LocalStorageConfigRepository.ts:79-90`（`save()` 无更高版本校验）
- **复现**：读到更高版本配置后调用 `save()` 仍写入成功
- **期望（§4.5）**：只读模式禁止保存；**实际**：仅 Banner 提示 + `provision` 跳过，保存未被拦截
- **证据**：`Grep unsupportedNewer`（无 save 侧拦截）；`Banner.tsx:41` 仅提示
- **备注**：M1 无编辑保存路径，影响低

---

## 6. 我新写了哪些测试

| 文件 | 用例数 | 覆盖点 |
|---|---|---|
| `src/config/migrations.qa.test.ts` | 10 | 迁移幂等/空对象/缺字段/未知字段/更高版本/异常输入 |
| `src/utils/hash.qa.test.ts` | 5 | 篡改检测/空串/超长串/稳定序列化/UTF-8 字节 |
| `src/config/ConfigRepository.qa.test.ts` | 16 | 64KB 边界/隔离/bridge 异常/损坏回退+原值备份/只读标记 |
| `src/config/factory.qa.test.ts` | 2 | 介质选型 + 降级标志 |
| `src/fields/normalize.qa.test.ts` | 12 | 恶意/畸形输入打穿 US-5 AC1 |
| `src/fields/renderers.qa.test.ts` | 9 | P0 八类双态 + 字段级异常隔离 + 货币符号缺陷实证 |
| `src/data/SdkRecordDataSource.qa.test.ts` | 15 | 分页/游标/clamp/缓存命中/空表/异常容错 |
| **合计** | **69** | 与工程师既有 42 条合计 **111 条全通过** |

> 未改动工程师既有测试的断言语义；新增测试与既有测试就近并存（同目录 `*.qa.test.ts`）。

---

## 7. 对工程师声明的复核结论

| 工程师声明 | 复核结论 |
|---|---|
| `tsc --noEmit` → 0 error | **成立**（含 QA 新增测试后仍为 0） |
| `vitest run` → 4 文件 / 42 用例全通过 | **成立**（基线独立复跑 4 文件 / 42 用例全绿） |
| `webpack --mode production` → 构建成功并产出 `project.config.json` / `index.json` | **产物成立**：两文件存在且内容合法（`appid`/`projectname`、`blockTypeID`/`blockRenderType`）；**构建未重跑** |
| `eslint src --max-warnings 0` → 0 warning | **成立** |
| `config/`：v2 类型 + 迁移 + bridge/localStorage 双实现；key `cbv:config:{viewId}`；64KB 拦截；checksum；损坏回退备份；更高版本只读 | **基本成立**，两点澄清：① localStorage 降级 key 实为 `cbv:config:{appId}:{viewId}`（bridge 才是 `cbv:config:{viewId}`）；② 「更高版本只读」仅**标记**（Banner），仓储层未强制禁止保存（见 F5） |
| `data/`：`getRecordsByPage` + LRU，禁用 `getRecordList` | **成立**（无 `getRecordList` 真实调用） |
| `fields/`：注册表 + 6 个 P0 渲染器，双态，字段级 try/catch → Fallback | **成立（渲染器级）**；提醒：`normalize()` 在 try/catch 之外（见 F3） |
| `sdk/`：只读，无写接口 | **成立**（`Grep` 仅命中注释） |
| 迁移幂等性、64KB 拦截、字段不外泄、不崩卡等隐含承诺 | **大体成立**；货币符号（F1）、`normalize` 逃逸（F3）、对象→0（F4）为新增发现 |

---

## 8. 验收建议

1. **可放行 M2 开发**（工程侧无阻断项）。
2. **建议 M2 前修复 F1（货币符号）**——唯一「用户可见且影响金额正确性」的缺陷，改动小（渲染器改用 `NormalizeValue` 中已解析的符号）。
3. F2/F5 需产品确认是否要求「运行期介质兜底」与「仓储层只读硬约束」；F3/F4 可并入 M2 健壮性任务。
4. **必须补做**：真机 E2E（打开插件渲染真实数据 + 配置存读 + 双账号共享）与 D7 原生筛选/排序对齐验证——本环境无法覆盖。

---

## 9. 第二轮回归验证（F1~F5 + Q4 修复后 · 任务 #9）

- **触发**：工程师完成任务 #8（修复 F1~F5 + 应用架构裁定 Q4）。
- **证据纪律**：**不采信工程师自写的 `*_fix.test.ts` 作为证据**。本轮结论仅来自 ① 直接阅读修复后源码交叉验证；② 把 QA 自己的 `*.qa.test.ts` 中 3 条「缺陷实证」断言**反转为「回归」断言**；③ 按 F2 新口径**新增**断言；④ 真实运行三命令。

### 9.1 真实工具链输出（第二轮）

| 命令 | 结果 |
|---|---|
| `node .\node_modules\typescript\bin\tsc --noEmit` | **0 error**（`TSC_EXIT=0`，输出文件为空） |
| `node .\node_modules\vitest\vitest.mjs run` | **Test Files 14 passed (14)** / **Tests 135 passed (135)** / 0 failed |
| `node .\node_modules\eslint\bin\eslint.js "src/**/*.{ts,tsx}"` | **0 problem**（`ESLINT_EXIT=0`，无任何输出） |
| `dist/` 产物 | `project.config.json`(77B)、`index.json`(69B)、`index.html`(293B)、`index.*.js`、chunk 资源，内容合法 |

> 用例构成：QA 自查用例 **78**（`normalize.qa` 14 + `hash.qa` 5 + `migrations.qa` 10 + `ConfigRepository.qa` 23 + `factory.qa` 2 + `SdkRecordDataSource.qa` 15 + `renderers.qa` 9）＋ 工程师业务自测 42 ＋ 工程师修复自测 15（仅计数、不作证据）= **135**。
> vitest stderr 中出现的 `[cbv:...]` 错误日志是**刻意构造的异常路径**（Proxy 抛错/网络拒绝）触发的预期 `logError` 输出，非失败。

### 9.2 反转的 3 条断言（第一轮「缺陷实证」→ 本轮「回归」）

| 位置 | 第一轮断言（缺陷实证） | 第二轮断言（回归） | 结果 |
|---|---|---|---|
| `normalize.qa.test.ts`（对象灌入数字/货币） | 期望被强转为 `{kind:'number',number:0}` / `¥0.00` | 期望 `kind:'empty'` / `isEmpty:true` / `display:''`（数字与货币两种） | ✅ 通过 |
| `renderers.qa.test.ts`（货币符号） | 期望渲染含 `¥` 且**不含** `$` | 期望卡片态与文档态均含 `$1,234.50`、**均不含** `¥`，且 `nv.symbol==='$'` | ✅ 通过 |
| `renderers.qa.test.ts`（组件路径） | `expect(render).toThrow()` | `expect(render).not.toThrow()`，并断言异常字段落兜底文案「该字段类型暂不支持」、同卡其他字段「正常值」照常渲染 | ✅ 通过 |

用例名均加了 `[回归]` 前缀，语义注明对应的 F 编号。

### 9.3 静态回归推理（证明新断言能兜住「改回去」）

- **F1 回退**：若 `NumberRenderer.resolveText` 改回硬编码 `'¥'`，则卡片/文档 HTML 将含 `¥` 而不含 `$1,234.50` → 断言 `toContain('$1,234.50')` 与 `not.toContain('¥')` 双双失败。兜住 ✅
- **F4 回退**：若恢复「对象/数组 → `Number()` 强转」，`normalize({obj_token},NUMBER)` 的 `kind` 会变回 `'number'`、`display` 变回 `'0'` → 断言 `kind==='empty'` / `display===''` 失败；货币同理。兜住 ✅（同时反向断言 `0/42.5/'1234.5'/NaN/Infinity` 证明合法标量未被误伤）
- **F3 回退**：若 `normalize` 被移回 `try/catch` 之外，`renderToStaticMarkup(<Card/>)` 重新抛错 → `expect(...).not.toThrow()` 失败。兜住 ✅
- **F2 回退（切多了）**：若把「数据损坏」也当作介质故障去 `latchDegrade`，则 `isDegraded()` 会变 `true`、`source` 变 `'localStorage'` → 断言 `toBe(false)` / `toBe('bridge')` 失败。兜住 ✅
- **F2 回退（切少了）**：若删除运行期降级，介质故障用例 `source==='localStorage'` / `isDegraded()===true` 失败。兜住 ✅
- **F5 回退**：若 `save()` 移除 `readOnlyViews` 校验，更高版本保存将 `ok:true` 并覆盖原数据 → 断言 `ok===false` / `reason==='unsupported-newer-readonly'` / 原值未被覆盖 失败。兜住 ✅

### 9.4 F1~F5 逐条独立复核（源码交叉验证 + 回归断言）

| 缺陷 | 修复落点（我亲自读源码所见） | 复核结论 |
|---|---|---|
| **F1** 货币硬编码 ¥ | `src/fields/renderers/NumberRenderer.tsx`：新增 `DEFAULT_CURRENCY_SYMBOL='¥'`；`resolveText` 内 `const symbol = nv.symbol ?? DEFAULT_CURRENCY_SYMBOL`；**renderCard 与 renderDoc 共用同一 `resolveText`**（不是只改一处）；`src/fields/normalize.ts` `normalizeCurrency` 写入 `symbol: resolveCurrencySymbol(meta)` | ✅ 已修（仅缺省时才回落 ¥） |
| **F2** bridge 运行期不降级 | `src/config/BridgeConfigRepository.ts`：新增 `degraded` 单向闭锁 + `latchDegrade()`（重绑订阅）；`load/save` 失败走注入的 `fallback`；`factory.ts` 注入 `LocalStorageConfigRepository` 为 fallback | ✅ 已修（详见 9.5 口径验证） |
| **F3** normalize 不在 try/catch | `src/components/card/FieldValue.tsx`：`useMemo` 内 `try { normalize(...) } catch { return { normalized: FALLBACK_VALUE, failed:true } }`，渲染时 `failed ? renderFallbackCard(ctx) : renderCard(...)`；`registry.ts` 新增 `renderFallbackCard` | ✅ 已修（组件路径异常被兜住） |
| **F4** 对象→0 强转 | `src/fields/normalize.ts`：新增 `toFiniteNumber(raw)`，**仅**接受 number 标量（`Number.isFinite` 校验）与可解析的有限数字字符串；对象/数组/布尔 → `null` → `emptyValue()`；`normalizeNumber/Currency/DateTime/RatingOrProgress` 全部改调它 | ✅ 已修（且未误伤合法标量/包装，见 9.6） |
| **F5** 只读未禁保存 | `BridgeConfigRepository.save` / `LocalStorageConfigRepository.save`：`if(readOnlyViews.has(viewId)) return { ok:false, reason:'unsupported-newer-readonly', error: UNSUPPORTED_NEWER_SAVE_MESSAGE }`；`remove` 清标记；`load` 记住 `unsupportedNewer` | ✅ 已修（两个实现都拦；`remove` 后可再保存） |

### 9.5 F2 新口径专门验证：**介质故障** vs **数据损坏**

- **口径**（源码）：仅当 bridge **读写抛异常**或 `setData` 返回 `false` 时 `latchDegrade()`（切介质）；而 `resolveLoadedConfig` 返回的 **checksum/JSON/迁移** 类「数据损坏」**不**触发 `latchDegrade`，介质保持 bridge。
- **新增断言（QA 自己的）**：
  1. `[回归·F2] 介质故障（getData 抛错）+ 注入 fallback` → `source==='localStorage'`、`isDegraded()===true`、**降级后 `setData` 未被调用（不回写 bridge）**、fallback 已落盘 → ✅ 通过。
  2. `[回归·F2] 介质故障（setData 返回 false）` → 降级并转写 fallback（`{ok:true}` 且 localStorage 有条目）→ ✅ 通过。
  3. `[回归·F2 口径] 数据损坏（checksum 不匹配）` → `config=null`、`degraded=true`（结果为降级回退），但 **`source==='bridge'`、`isDegraded()===false`**；**且随后 `save()` 仍写 bridge、localStorage 为空** → ✅ 通过。
  4. `[回归·F2 口径] 数据损坏（非法 JSON）` → 同样 `source==='bridge'` / `isDegraded()===false` → ✅ 通过。

### 9.6 F4 不误伤验证（合法包装仍正常）

新增 `[回归] F4` 断言：`{value:42}`→number、`{value:'文本结果'}`→text、`{value:true}`→checkbox、裸 `42`/`'纯文本'`→正常、`{text:'关联项'}`→text、`[{name:'A'},{name:'B'}]`→`'A、B'` 全部通过；同时 `'not-a-number'`/`NaN`/`Infinity` → empty。说明 F4 只收紧「非标量强转」，未伤及 SDK 合法数字/公式包装。

### 9.7 回归防护（第一轮通过项复跑）

第一轮 32 项通过判据（含 QA 78 条自查断言）在本轮**全部复跑通过**，重点复核项：`normalize` 不泄漏高危 key（`obj_token`/`file_token`/`tmp_url`/`rec*`）、64KB 边界（恰好/超 1 字节）、viewId 命名空间隔离、SDK 只读约束扫描、pagination/游标/clamp/缓存、损坏回退+原值备份、只读标记、工厂介质选型、`console.log`/`any`/`TODO`/`@ts-ignore` 卫生扫描 —— 无回归。

### 9.8 M1 最终验收结论

- **F1~F5 全部闭合**，无新增阻断项；`tsc`/`vitest`(135)/`eslint` 全绿，`dist/` 齐备。
- **M1 判定：通过验收（可进入 M2）**。
- **遗留未验证项**（沿用 §4，本环境无法覆盖，不因第二轮改变）：真机 E2E「打开插件渲染真实数据卡片」、bridge 跨用户共享、`getRecordsByPage` 跟随视图原生筛选/排序（D7）、1.2 万行性能、`webpack --mode production` 重跑、全局 Error Boundary（T13 范围）。
- **建议**：M2 前在真实多维表格补一次端到端 smoke（配置存读 + 多币种金额显示 + 单字段异常不白屏）。
