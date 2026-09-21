# 卡片视图（Card View）· 飞书多维表格扩展视图插件

只读的「卡片视图」插件：用卡片墙浏览多维表格记录，卡片字段适配 P0 八类字段，
并可展开文档式详情（M1 仅打通骨架，详情文档引擎在 M2）。

> 本文档对应 **M1 骨架打通** 里程碑：T01 ~ T06 + 最小渲染闭环。
> 判据：在多维表格里打开本插件，能看到**用真实数据渲染出的卡片**；配置**能存能读**。

---

## 1. 目录结构

```
plugin/
├── app.json                    # 【官方】appId（upload 定位目标应用）
├── block.json                  # 【官方】blockTypeID / projectName / url / manifestVersion
├── debug.json                  # 【官方】调试版本（v / vb）
├── package.json                # scripts: start / build / upload / test / typecheck / lint
├── tsconfig.json               # strict: true
├── webpack.config.js           # 【官方强制】Webpack 5 + @lark-opdev/block-bitable-webpack-utils
├── tailwind.config.ts          # 全部映射到 CSS 变量（唯一数值来源 = 04 文档 §3）
├── postcss.config.js
├── vitest.config.ts
├── .eslintrc.cjs / .prettierrc / .gitignore
├── public/index.html
├── src/
│   ├── main.tsx                # 挂载 + 顶层 Error Boundary
│   ├── App.tsx                 # Boot / Loading / Browse / Error 四态分发
│   ├── sdk/                    # 接入层（只读）
│   │   ├── base.ts             # bitable 单例、table/view、bridge 存储适配、权限探测
│   │   └── env.ts              # 产品端 / 语言 / 主题 / tableId / viewId
│   ├── config/                 # 配置层
│   │   ├── types.ts            # 数据模型 v2 全量类型（§4 逐字落地）
│   │   ├── defaults.ts         # 默认卡片布局 / 默认 A4 文档模板
│   │   ├── migrations.ts       # 1 → 2 迁移 + 结构补全
│   │   ├── provision.ts        # D4 复制视图场景识别与「从模板重配」
│   │   ├── ConfigRepository.ts # 抽象接口 + envelope 编解码 + 读取编排
│   │   ├── BridgeConfigRepository.ts    # 首选实现（viewId 命名空间）
│   │   ├── LocalStorageConfigRepository.ts # 降级实现
│   │   └── factory.ts          # 运行时选型
│   ├── data/                   # 数据层
│   │   ├── RecordDataSource.ts # 取数抽象（loadPage / loadRecord / count / 有序 id）
│   │   ├── SdkRecordDataSource.ts # getRecordsByPage 实现（禁用 getRecordList）
│   │   └── RecordCache.ts      # 页级 + 记录级 LRU
│   ├── fields/                 # 领域层：字段渲染
│   │   ├── fieldTypes.ts       # FieldType 枚举 + 优先级映射 + 归一化类型
│   │   ├── normalize.ts        # IOpenCellValue → NormalizedValue
│   │   ├── registry.ts         # 注册表 + renderCard / renderDoc 双态入口
│   │   └── renderers/          # Text / Number / Tag / Date / Checkbox / Fallback
│   ├── state/ViewStore.ts      # 轻量状态（元数据 / 首批记录 / 配置 / 加载态）
│   ├── hooks/                  # useCardViewInit / usePermission / useThemeTokens
│   ├── constants/              # index / keys / paper
│   ├── components/
│   │   ├── layout/             # ViewShell / Toolbar / Banner
│   │   └── card/               # Card / FieldValue
│   ├── utils/                  # hash / format / log
│   └── styles/                 # tokens.css（04 §3 token）/ globals.css
└── README.md
```

---

## 2. 安装与本地调试

### 2.1 前置

- Node 18+、npm
- 全局安装飞书官方 CLI：`npm install @lark-opdev/cli@latest -g -f`
- 飞书开发者后台创建**企业自建应用**，并添加「多维表格 · 数据表视图（table-view）」能力

### 2.2 安装依赖

```bash
cd plugin
npm install
```

> `@lark-opdev/block-bitable-webpack-utils`（官方强制依赖）已写入 `devDependencies`，`npm install` 会一并安装。
> 若因网络受限安装失败，构建会降级为纯 Webpack 并给出告警——该产物**缺少官方运行时注入、不可上传**，仅可用于本地类型/逻辑演练。

### 2.3 ⚠️ 必须替换的两个占位值（关键）

当前 `app.json` / `block.json` 是**占位值**，必须替换成你在飞书后台拿到的真实值，否则 `upload` 会失败：

| 文件 | 行 | 当前值（占位） | 替换为 |
|---|---|---|---|
| `app.json` | 2 | `"appId": "cli_xxxxxxxxxxxxxxxx"` | 你应用的 **appId**（`cli_` 开头） |
| `block.json` | 2 | `"blockTypeID": "blk_xxxxxxxxxxxxxxxx"` | 「数据表视图」能力的 **blockTypeID**（`blk_` 开头） |
| `block.json` | 5 | `"url": "https://example.feishu.cn/base/xxxxxxxx?..."` | 本地调试要打开的 **多维表格文档链接** |

> **`block.json.url` 是「调试时打开的多维表格文档链接」**（形如 `https://xxx.feishu.cn/base/xxx?table=xxx&view=xxx`），**不是** devServer 地址。`npm run start` / CLI 会带上 `debugPort` 打开它；换调试文档就改这个字段。
>
> **`app.json` 的位置（重要，已核对官方 utils 源码）**：官方 `@lark-opdev/block-bitable-webpack-utils@0.1.7` 在 **上一级目录** 读取 `app.json`（`../app.json`）、在 **当前目录** 读取 `block.json`，对应 `opdev create ${app-dir}/${view-dir}` 的目录约定（技术方案 2 §13 亦已注明「CLI 在上层目录找 app.json、当前层找 block.json」）。
> 本仓库为保持 `plugin/` 自包含，把 `app.json` 与 `block.json` 一并放在 `plugin/`；`webpack.config.js` 会在实例化官方插件前，**自动把 `plugin/app.json` 同步到上一级 `../app.json`**（仅缺失或内容不一致时写入），因此直接 `cd plugin && npm run start|build` 即可。若你已按官方布局把 `app.json` 放在 app-dir，则本目录不放 `app.json`，同步逻辑会自动跳过。

### 2.4 本地调试（需要登录，工程师无法代跑）

```bash
opdev login          # 扫码登录
npm run start        # 启动 WebpackDevServer（默认 http://localhost:9000）
```

CLI 会**自动打开一篇多维表格文档并附带 `debugPort`**，在多维表格「新建视图」中选择「卡片视图」即可看到插件。

### 2.5 上传（需要登录 + 真实 appId）

```bash
npm run build        # 产出 dist/
npm run upload       # 等价于 opdev upload ./dist
opdev whoami         # 排查 appId / blockTypeID 不匹配问题
```

上传后在开发者后台：选择版本号 + 上传图标 + 填写名称/介绍 → 保存 → 创建版本 → 确认权限可见范围 → 申请线上发布 → 管理员审核 → 用户安装。

---

## 3. 质量校验（本地可跑，无需登录）

```bash
npm run typecheck    # tsc --noEmit，零错误
npm run test         # Vitest 单测
npm run build        # Webpack 生产构建
npm run lint         # ESLint
```

单测覆盖（M1 要求）：

- `src/utils/hash.test.ts` —— checksum / 稳定序列化 / UTF-8 字节长度
- `src/config/migrations.test.ts` —— 1→2 迁移（含空配置、未知字段、更高版本、损坏输入）、默认 A4 模板结构
- `src/config/ConfigRepository.test.ts` —— envelope 校验、checksum 篡改、**体积超限拦截**、损坏回退 + 备份、
  **viewId 命名空间隔离**（bridge 与 localStorage 两套实现）、只读降级
- `src/fields/normalize.test.ts` —— **不泄漏原始 ID / JSON**、八类 P0 字段归一化

---

## 4. M1 已完成范围 / 未做范围

### ✅ 已完成（T01 ~ T06 + 最小渲染闭环）

| 任务 | 内容 |
|---|---|
| T01 | 项目基础设施：官方三件套 `app.json`/`block.json`/`debug.json`、Webpack 5 + 官方 utils、Tailwind + CSS 变量、Error Boundary |
| T02 | SDK 只读接入 + 环境探测（tableId/viewId/字段元数据、语言、主题、产品端）；权限探测；主题 token 注入 |
| T03 | 配置模型 v2 全量类型、默认卡片布局、默认 A4 文档模板、1→2 迁移（有单测） |
| T04 | 配置存取层：bridge 首选（**key 带 viewId 命名空间**）+ localStorage 降级；64KB 体积拦截 + checksum 校验 + 损坏回退备份；更高版本只读 |
| T05 | 数据读取层：`getRecordsByPage({ viewId, pageSize ≤ 200, pageToken })` 分页 + 页/记录级 LRU；**禁用 `getRecordList`** |
| T06 | 渲染器注册表 + 6 个 P0 渲染器（文本/数字/货币/单选/多选/日期/复选框），`renderCard` / `renderDoc` 双态，字段级异常回落 |
| 闭环 | ViewStore + ViewShell/Toolbar/Banner + Card + FieldValue，CSS Grid 卡片墙平铺真实数据 |

### ❌ 未做（按里程碑规划，属 M2+）

T07 渲染器 P1 扩展、T08 DraftStore/UiStore + 高亮规则引擎、T09 槽位组件终版、T10 虚拟滚动、
T11/T19 双模式拖拽编辑器、T12 详情抽屉、T13 完整空态/异常态体系、T16/T17/T18 文档引擎与分页、
T20 打印导出、T14 埋点、T15 发布。**M1 卡片墙无虚拟滚动**（万行性能在 T10）。

---

## 5. 关键设计约定（实现已遵守）

1. **只读**：`src/sdk/base.ts` 不封装任何写接口（无 `setRecord`/`addRecord`/`bitable:app`），权限基线 `bitable:app:readonly`。
2. **bridge 存储 key 带 viewId**：`cbv:config:{viewId}`。bridge 作用域是「文档 + 插件」级、不是视图级，同一文档多个卡片视图必须隔离，否则互相覆盖。
3. **配置体积预算 ≤ 64KB**：保存前拦截（`SaveResult.tooLarge`），读取时 checksum 校验，损坏 → 回退默认模板 + 写备份 `cbv:config:{viewId}:backup:{ts}`。
4. **更高版本只读**：`envelope.schemaVersion > CURRENT` → `unsupportedNewer` 只读，仅读已知字段、丢弃未知字段。
5. **降级可用**：bridge 不可用时切 `localStorage`（key 补 appId 维度），并暴露 `degraded` 标志 → UI 出常驻提示条。
6. **数据分页口径**：统一 `getRecordsByPage`，传 `viewId` 自动遵循视图原生筛选/排序（D7）；有序 id 用 `getVisibleRecordIdList()`。
7. **不外泄原始值**：`normalize()` 保证 `text`/`display` 永不含原始 ID / JSON；单字段异常 → `FallbackRenderer`，不影响整卡。
8. **样式单一来源**：所有数值取自 `src/styles/tokens.css`（= 04 文档 §3）；主色 `#3370FF`、卡片圆角 8px、卡片标题 15px/600、间距 4 的倍数。

---

## 6. 待验证项（需真实环境确认，代码已做兼容/降级）

| 编号 | 事项 | 当前处理 |
|---|---|---|
| V-PERM | Base JS SDK 是否提供「配置编辑权限」API | `sdk/base.canEditTable()` 能力探测；探测不到时保守返回 `true`（仅影响配置入口可见性） |
| V-BRIDGE | bridge 的 `onDataChange` 回调载荷结构 | `sdk/base.normalizeBridgeChange()` 兼容 `{key,value}` 与 `{data:{key,value}}`；解析不到 key 时不误触发 |
| V-ENV | `getProductType` / `getTheme` / `onThemeChange` 的具体 API 名 | 全部 try/catch + 默认值，探测失败不阻断启动 |
| V-UTILS | `@lark-opdev/block-bitable-webpack-utils` 的导出名 | **已核对 0.1.7**：导出 `BitableAppWebpackPlugin`（**class，须 `new`**）与 `opdevMiddleware`；`app.json` 在上一级、`block.json` 在当前层。`webpack.config.js` 按其真实形状实例化，并对缺失/命名差异做降级告警 |
