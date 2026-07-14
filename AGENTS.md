# AGENTS.md

## 核心规范
**不要假设，不要隐藏困惑，要暴露权衡。**
- 用**中文**思考与回答。
- 明确说出你的假设，不确定就问
- 如果存在多种解读，把它们都列出来，不要悄悄选一个
- 如果有更简单的方案，说出来；在该反驳时要反驳
- 如果有不清楚的地方，停下来，说明哪里困惑，然后提问
- 代码长度不要超过 500 行，必要时拆分成多个文件或函数
- 不要为了压行数把代码强行「写平」。超限的正确做法是拆分成独立文件 / 函数 / 组件。

## Plan Mode 工作约定

进入 Plan 模式规划开发/原型任务时，必须严格执行以下契约：

### 1. 视觉输出规范
* **UI 变更**：必须使用 ASCII 字符绘制界面线框图。
* **流程变更**：必须使用 ASCII 字符绘制业务/数据流程图。

### 2. Agent 编排矩阵（严禁漏写“谁来做”）
Plan 必须清晰界定分工，包含：
* **角色与边界**：拆分哪些子 Agent、具体职责、**允许操作的文件边界**。
* **执行拓扑**：各项任务的串行/并行关系与依赖顺序。

### 3. 执行红线与评审闭环
* **主 Agent 禁令**：主 Agent 仅做编排与审查。**全程绝对禁止直接编写/修改代码或编辑文件**，全部派发给子 Agent。
* **只读评审**：编码完成后，主 Agent 必须指派独立的**代码评审子 Agent（只读）**进行审查。
* **修复闭环**：主 Agent 汇总评审结论，**派发子 Agent 进行修复/更新**，主 Agent 不得亲自修改缺陷。
* **派发 Agent 工具时不使用 `isolation: "worktree"`**，agent 直接在当前会话工作目录（主仓库）中运行。

## 项目
cryptotrading：A 股（Tushare Pro）与美股（Yahoo Finance）的 K 线 / 资金流向 / 基本面采集、策略回测与 Web 可视化。加密标的（币安 K 线）仍保留于 `/symbols`，非当前主开发域。

## 数据源权限
- **我目前没有权限查看 tushare 美股的数据。** 即 Tushare 美股系列接口（`us_daily` / `us_daily_adj` / `us_adjfactor` / `us_basic` 等）不可用（`us_daily_adj` 需正式权限、`us_adjfactor` 需先开通美股日线权限），评估美股数据源 / 复权方案时别把它当候选。
- **美股现走 Yahoo Finance chart API**（自建 `apps/quant-pipeline/.../sync/yahoo_client.py`，stdlib urllib；`adj_close/close` 派生乘法前复权因子，恒正）。

## 环境
- 操作系统：Windows 11，终端 PowerShell。PowerShell 命令禁用 `&&` 连接，改用 `;` 或多行执行。
- 终端编码 GBK；**所有源文件 UTF-8**。文件 I/O 始终显式 `encoding='utf-8'`，HTML 模板必须 `<meta charset="UTF-8">`，对象键名一律用英文（防 PowerShell GBK 解析中文裸键名报错）。
- 环境变量统一写到仓库根 `.env`，模板见根目录 `.env.example`；NestJS 与 Python 子项目均从根加载。

## 常用命令

| 任务 | 命令 |
|------|------|
| 安装依赖 | `pnpm install` |
| 启动开发（DB + server :3000 + web :5173，不含 quant worker） | `pnpm dev` |
| 量化 worker（另开终端；**自定义指数计算不需要**，仅 quant sync/train 等） | `cd apps/quant-pipeline; uv sync; uv run quant worker run` |
| 全量构建 | `pnpm build` |
| 仅启动数据库 | `pnpm db:start` / `pnpm db:stop` / `pnpm db:logs` |
| 后端构建 | `pnpm --filter @cryptotrading/server build` |
| 后端单测 | `pnpm --filter @cryptotrading/server exec jest <文件名 pattern>` |
| 前端类型检查 | `pnpm --filter @cryptotrading/web type-check` |
| 前端单测 | `pnpm --filter @cryptotrading/web test`（vitest） |
| CSV → DB 迁移 | `pnpm migrate:csv` |
| 生产部署 | `pnpm prod:up` / `pnpm prod:down` |
| 查询数据库 | `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."` |

涉及 DB schema 调整时，须随附 `docker exec` 格式的可执行脚本（参考 `apps/server/src/migration/*.sql` + 对应 `.ps1`）。

**后端 `dev` 是 `nest start`（无 `--watch`，不热加载）**：改动 `apps/server` 代码后**必须重启后端进程**，新路由 / 改动才生效。端到端验证前先确认后端跑的是最新代码，否则会撞新接口 404、行为还是旧的等假象（前端 `vite` 有 HMR，不受此限）。

## 架构总览

**monorepo（pnpm workspaces + Python）**：

```text
apps/
├─ server/          — NestJS 10 + TypeORM + PostgreSQL（:3000，全局 /api 前缀）
├─ web/             — Vue 3 + Vite + Naive UI + ECharts + Pinia（:5173）
└─ quant-pipeline/  — Python（uv）；Yahoo/Tushare 同步、因子/特征/标签/训练、ml.jobs worker
packages/
└─ shared-types/    — 前后端共享 TS 类型
```

**后端模块（`apps/server/src/`）**按业务域分组而非平铺：
- `auth/`、`users/` — 全局 `AuthGuard`（通过 `APP_GUARD` 注册）+ 邀请码 + 会话
- `catalog/{symbols,watchlists,symbol-presets}/` — 标的目录与自选
- `market-data/` — 各数据源采集与查询，子目录按域分：

```text
market-data/
├─ A 股: a-shares, money-flow, index-catalog, ths-index-daily,
│        index-daily, sw-index-daily, index-weight, active-mv, oamv
├─ 美股: us-stocks, us-index-daily, us-index-amv
└─ 通用: klines, sync, base-data-sync, one-click-sync,
         signal-rolling-indicator（_shared/ 为跨模块同步辅助）
```

- `strategies/` — 策略定义；含 `regime-engine/`（Regime 引擎）
- `backtest/` — 回测引擎
- `strategy-conditions/` — 条件扫描；含 `signal-stats/`（信号前向统计）、`portfolio-sim/`（组合模拟）
- `modules/quant/` — 量化模型训练与推理（因子 / 特征 / 标签 / 训练 / 评分管线，`ml.jobs` 调度 + SSE 进度推送）
- `indicators/` — 共享计算库（MA/MACD/KDJ/砖图，含 worker 线程池），**非** NestJS Module
- `daily-review/` — 复盘日报 + 工具调用流水线（Tavily/Serper）
- `preferences/`、`settings/` — 用户偏好（列偏好、筛选方案等）与系统设置
- `entities/` — TypeORM 实体按业务域分子目录（不与 module 目录同构）
- `migration/` — schema 变更与回填脚本（平铺）：`*.sql` + 同名 `.ps1` 配对（PS1 内置 `docker exec`，用 `$PSScriptRoot` 引同目录 SQL）；TS 回填见 `apps/server/package.json` 的 `migration:*` 脚本（含 `csv-import`、`a-share-brick-backfill`、`daily-basic-pe-ttm-backfill`、`backfill-a-share-sw-industry`、`backfill-money-flow-aggregation`、`backfill-index-weight` 等）；`a-share-indicators-backfill.ts` 暂无 npm 入口，需 ts-node 直跑

**前端视图（`apps/web/src/views/`）**：顶层分组 `auth / market / quant / strategy / sync / system`。路由权威源：[apps/web/src/router/index.ts](apps/web/src/router/index.ts)（全站）、[Sidebar.vue](apps/web/src/components/layout/Sidebar.vue)（可见菜单）、[quant/README.md](apps/web/src/views/quant/README.md)（quant 子树 SSE/草稿态）。

**数据流要点**：
- Tushare 拉数据 → 写 `raw.*` 表（`daily_quote / daily_basic / adj_factor / trade_cal / ...`）→ 服务端计算技术指标（MA/MACD/KDJ，`technicalindicators` 库）→ 前端按 `trade_date` 对齐展示。
- SSE 进度推送：同步任务、量化 jobs、daily-review 等用 SSE 推进度；回测进度为轮询（非 SSE）。`EventSource` 不带 Authorization header，量化 jobs 流先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再用 query 参数建连（详见 [apps/web/src/views/quant/README.md](apps/web/src/views/quant/README.md)）。

## 文档地图

| 主题 | 权威文档 |
|------|----------|
| DB 查库场景（快捷指南） | [doc/db/index.md](doc/db/index.md) |
| 编码 / UTF-8 / 中文编辑 | [doc/规范/conventions.md](doc/规范/conventions.md) |
| 可触发 Agent 技能 | [.claude/skills/](.claude/skills/)（Tushare → `tushare-sync-dev`；查 DB → `db-inspect`；前端 → `frontend-dev-lessons`） |
| 量化运维 / worker | [doc/quant-runbook.md](doc/quant-runbook.md)、[apps/quant-pipeline/README.md](apps/quant-pipeline/README.md) |
| 环境变量全集 | [.env.example](.env.example) |
| 跨会话任务交接 | `prompts/`（约定见下文） |

## 会话交接提示词（`prompts/`）

`prompts/` 存放**自包含的跨会话任务交接提示词（handoff prompts）**：每个 `.md` 可整段贴给全新会话 / agent 直接接手，不依赖上一会话上下文——用于一个任务跨多会话推进，或在会话末尾把"未做完 / 下一步"固化下来交给下一棒。
