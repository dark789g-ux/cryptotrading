# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 核心规范
**不要假设，不要隐藏困惑，要暴露权衡。**
- 用**中文**思考与回答。
- 明确说出你的假设，不确定就问
- 如果存在多种解读，把它们都列出来，不要悄悄选一个
- 如果有更简单的方案，说出来；在该反驳时要反驳
- 如果有不清楚的地方，停下来，说明哪里困惑，然后提问

## 项目
cryptotrading：量化交易回测系统。覆盖加密货币（币安公开 REST）与 A 股（Tushare Pro）的 K 线 / 资金流向采集、策略回测与 Web 可视化。

## 环境
- 操作系统：Windows 11，终端 PowerShell。Shell 命令禁用 `&&` 连接，改用 `;` 或多行执行。
- 终端编码 GBK；**所有源文件 UTF-8**。文件 I/O 始终显式 `encoding='utf-8'`，HTML 模板必须 `<meta charset="UTF-8">`，对象键名一律用英文（防 PowerShell GBK 解析中文裸键名报错）。
- 中文文本编辑与乱码处理规范：见 [doc/规范/conventions.md](doc/规范/conventions.md)。
- 环境变量统一写到仓库根 `.env`，模板见根目录 `.env.example`；NestJS 与 Python 子项目均从根加载。

## 常用命令

| 任务 | 命令 |
|------|------|
| 安装依赖 | `pnpm install` |
| 启动开发（DB + server :3000 + web :5173） | `pnpm dev` |
| 全量构建 | `pnpm build` |
| 仅启动数据库 | `pnpm db:start` / `pnpm db:stop` / `pnpm db:logs` |
| 后端构建 | `pnpm --filter @cryptotrading/server build` |
| 后端单测 | `pnpm --filter @cryptotrading/server exec jest <文件名 pattern>` |
| 前端类型检查 | `pnpm --filter @cryptotrading/web type-check` |
| 前端单测 | `pnpm --filter @cryptotrading/web test`（vitest） |
| Vue 单文件 ≤500 行校验 | `pnpm --filter @cryptotrading/web lint:quant-lines` |
| CSV → DB 迁移 | `pnpm migrate:csv` |
| 生产部署 | `pnpm prod:up` / `pnpm prod:down` |
| 查询数据库 | `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."` |

涉及 DB schema 调整时，须随附 `docker exec` 格式的可执行脚本（参考 `apps/server/migrations/*.sql` + 对应 `.ps1`）。

## 架构总览

**monorepo（pnpm workspaces）**：
- `apps/server/` — NestJS 10 + TypeORM + PostgreSQL（端口 3000，全局 `/api` 前缀）
- `apps/web/` — Vue 3 + Vite + Naive UI + ECharts + Pinia（端口 5173）
- `packages/shared-types/` — 前后端共享 TS 类型

**后端模块（`apps/server/src/`）**按业务域分组而非平铺：
- `auth/`、`users/` — 全局 `AuthGuard`（通过 `APP_GUARD` 注册）+ 邀请码 + 会话
- `catalog/{symbols,watchlists,symbol-presets}/` — 标的目录与自选
- `market-data/{klines,sync,a-shares,money-flow,index-catalog,ths-index-daily,oamv}/` — 各数据源采集与查询
- `strategies/`、`backtest/`、`strategy-conditions/` — 策略、回测、条件扫描
- `modules/quant/` — 量化模型训练（M2/M3 在做，含 `ml.jobs` SSE 进度推送）
- `daily-review/` — 复盘日报 + 工具调用流水线（Tavily/Serper）
- `entities/` — TypeORM 实体按业务域分子目录（不与 module 目录同构）
- `migrations/` — `*.sql` + 同名 `.ps1` 配对，PS1 内置 `docker exec` 调用

**前端视图（`apps/web/src/views/`）**：`auth / market / quant / strategy / sync / system`，各子路由见 [README.md](README.md) 页面表。

**数据流要点**：
- Tushare 拉数据 → 写 `raw.*` 表（`daily_quote / daily_basic / adj_factor / trade_cal / ...`）→ 服务端计算技术指标（MA/MACD/KDJ，`technicalindicators` 库）→ 前端按 `trade_date` 对齐展示。
- SSE 进度推送：同步任务和量化 jobs 均通过 SSE 推进度；`EventSource` 不带 Authorization header，量化 jobs 流先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再用 query 参数建连（详见 [apps/web/src/views/quant/README.md](apps/web/src/views/quant/README.md)）。

## 硬约束

### 数据完整性 & 第三方 API

- **接口名称必须以官方文档为准**，禁止凭变量名、注释或历史代码推断。Tushare 相关问题在调用前必触发 `tushare-sync-dev` skill 查文档；DeepSeek 相关代码触发 `deepseek-api` skill。
- **外部服务返回空数据必须 `logger.warn` 两条独立路径**：`payload.data === null` 与 `payload.data.items.length === 0`，附带 apiName + 完整 params——曾因只 warn 了 `data=null` 让 Tushare 当日未发布数据伪装成"同步完成"。
- **同步任务的 fetcher 返回 0 行必须显式 `failedItems`**：除 `.catch(()=>[])` 外，"code=0 + 0 行" 是另一种伪装成功；orchestrator **不得**当作"已同步"。fetcher 返回空时 push 到响应体 `errors`/`failedItems`（apiName 标 `xxx_empty`，例 `daily_empty`/`adj_factor_empty`/`no_open_trade_dates`）。
- **`.catch(() => [])` 静默吞错禁止用于同步任务**：错误必须在响应体 `errors` 字段透出，并在日志打印具体 API 名称与错误。
- **调试第三方 API 返回空的顺序**：① 查官方文档确认接口名/参数；② 加日志看真实响应；③ 才读内部实现，禁跳前两步直接猜。
- **数据集完整性最弱可接受标准**：（1）行级硬约束 — 所有业务上不允许 NULL 的列在该日**每一行**都非空（如 daily 的 OHLC、adj_factor 的 `adj_factor`），合法 NULL 列（亏损股 PE/PB、停牌股 turnover_rate）不进硬约束；（2）跨表行数对齐 — 派生数据集当日行数 `>=` 基础数据集。"至少一行非空"是无意义最弱约束，曾让 A 股增量同步在数据残缺时仍判完整、跳过补齐。

### 数据库 & SQL

- **`synchronize: false`**（已设），所有 schema 变更走 `migrations/*.sql`。
- 原生 SQL 数组参数强转须与列类型匹配：`character varying` 用 `::text[]`，`uuid` 列用 `::uuid[]`（如 `watchlist_items.watchlist_id` 是 `uuid`，误用 `::text[]` 会 500）。
- TypeORM `andWhere` 等字符串里禁 `'[]'::jsonb`（会误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`。
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（TypeORM 0.3 空 metadata 已知坑）。
- **动态 SQL 构建禁止直接拼接前端字段名**（如 `i.${field}`）：必须经过 `FIELD_COL_MAP` 翻译为实际列名，未命中映射记 `logger.warn` 并跳过。
- **TypeORM `upsert` 前必须按 `conflictKeys` 去重**（保留最后一条）。PostgreSQL `ON CONFLICT DO UPDATE` 同批次重复键会报 `cannot affect row a second time`（500）；第三方返回重复行需 `logger.warn` + 原始/去重后条数。
- 500 报错排查：开 TypeORM `logging: ['error','warn']`（已开）+ `logger.error(err.stack)`，禁静态分析猜。

### NestJS

- `AuthGuard` 已通过 `APP_GUARD` 注册为全局守卫，Controller 上**禁止**再加 `@UseGuards(AuthGuard)`（会让 NestJS 在当前模块上下文解析 Guard 依赖，未导入 `AuthModule` 启动报 `Can't resolve dependencies`）。
- **修改 `tsconfig.json` 后必须验证构建入口**：新增/修改 `paths`、`include`、`rootDir` 后，运行 `pnpm --filter @cryptotrading/server build`，确认 `nest-cli.json` 的 `entryFile`（`apps/server/src/main`）与实际产物路径一致。

### 时间 / 日期

- DB 时间列**一律 `timestamptz`**，禁 `timestamp`（无 TZ 列遇 JS Date 按 Node 本地 TZ 落库，与 UTC 错位）。
- 入库一律传 JS `Date`（UTC 瞬时）；字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟：`new Date(s.replace(' ','T')+'Z')`。
- 出参一律 UTC 墙钟字符串：`getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。
- 裸 SQL 比对 `timestamptz` 列：`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。
- 跨进程/容器 Node TZ 不可控，绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。
- **日期选择器是本地 TZ 例外**：上述 UTC 要求只约束 DB 入库瞬时与裸 SQL 比对，**不适用于**用户从日期选择器选的日历日。naive-ui `n-date-picker` 的 `[number, number]` 值是**本地午夜 ms**——用 `getUTCFullYear/getUTCMonth/getUTCDate` 提取会让 CST 用户日期整体漂前 1 天（曾把 `20260509-20260511` 压成 `20260508-20260510` 导致整次同步看似完成实则一行未写）。日历日提取一律用 `getFullYear/getMonth/getDate`；`buildDefaultDateRange` 等工具用 `new Date(y,m,d).getTime()` 取本地午夜。后端 `timestamptz` 展示函数（`formatUTCDate`/`formatUTCDateTime`）仍按 UTC 规则。
- **A 股 `trade_date` 存储格式为 Tushare 标准 `YYYYMMDD`**（如 `'20260506'`），**禁止直接 `new Date(tradeDate)`**（返回 `Invalid Date`）。转 `Date` 须插分隔符：`` `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z` ``。仅用于展示用已有 `formatTradeDate`（前端）/ `formatTradeDateLabel`（后端），禁 `new Date()`。
- **K 线副图对齐 key 不得假设两个后端接口的日期格式同源**：`KlineChart` 副图通过 `flowMap.get(row.open_time)` 按 `trade_date` 对齐主图，**字符串必须字面相等**才能命中。各 service 实际拼出的格式互不相同（如 `2026-05-15` vs `20260515`）；**禁止**让 `KlineChart` 容忍多种格式（掩盖契约不一致）或冲动改后端（影响面失控）——回到契约层统一。

### Vue 3 / 前端

- `watch(source, cb)` 默认懒执行，**不响应初始值**；依赖初始值必须 `{ immediate: true }` 或在 `onMounted` 中补充调用。
- 父组件 `v-if`（挂载即展示）vs `v-show`（常驻切换）决定异步加载的触发时机，组件内"开启时触发"逻辑必须先确认。
- **`<keep-alive>` 规范**：被缓存的组件，`onMounted` 只在首次挂载触发一次，切回不重跑。依赖"外部 store 可能在其它页面被更新"的异步数据加载（策略命中、用户配置等）必须放 `onActivated`；`onMounted` 仅保留真正一次性初始化。**响应性陷阱**：`computed` 会响应 store 变化（UI 下拉框正确），而 `onMounted` 加载的普通 `ref` 不会自动刷新，遇到"下拉框有选项但数据不更新"优先排查 keep-alive 缓存。
- **Modal 统一复用 `@/components/common/AppModal.vue`**，避免直接 `n-modal`。AppModal 操作按钮统一放 `#actions` slot，子组件内部禁止自带"保存/取消"按钮（防双重按钮）。
- **条件/表达式构建器**：凡涉及"比较"的 UI（条件筛选、策略规则、阈值配置），比较目标必须**同时支持字段引用和常量值**两种类型由用户切换，禁止硬编码单一类型。
- **动态字段映射规范**：新增支持用户选字段的查询模块必须：① 建立 `FIELD_COL_MAP`（前端字段名 → `表别名.列名`）；② 跳过未知字段记 `logger.warn`；③ 有前提约束的操作符（如上穿/下穿仅限单表指标）在映射表层面校验字段所属表，不满足 warn + skip；④ 前端操作符列表同步反映约束（`disabled`），不能仅靠后端防御。
- **Naive UI 自定义选项类型**：自定义接口用于 `<n-select :options>` 必须 `extends SelectOption`（`import type { SelectOption } from 'naive-ui'`），禁重复声明 `label/value`，否则与 `SelectMixedOption` 判别联合不兼容、`vue-tsc` 报错。
- **修改 import 块、模块顶层声明后必须立即回读文件头部验证顺序**，不得依赖 linter 代替人工确认。

### 代码组织

- **单文件不超过 500 行**，模块化拆分；`apps/web/src/views/quant/**` 与 `apps/web/src/components/quant/**` 由 `lint:quant-lines` 在 CI 强制。
