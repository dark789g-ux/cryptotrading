# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 核心规范
**不要假设，不要隐藏困惑，要暴露权衡。**
- 用**中文**思考与回答。
- 明确说出你的假设，不确定就问
- 如果存在多种解读，把它们都列出来，不要悄悄选一个
- 如果有更简单的方案，说出来；在该反驳时要反驳
- 如果有不清楚的地方，停下来，说明哪里困惑，然后提问

## 子代理派发
- 在用 Agent 工具派发 subagent_type: Explore 时显式传 model: sonnet

## 工作方法（踩坑沉淀）
- **写 spec 时计数/清单类"伪事实"当场落源头数**：进文档的列数、字段清单、行号等具体计数，写时即去权威源（实体 / 真文件 / 真 DB）数一遍，别凭印象写再让实现者反查。
- **驱动 naive-ui 等响应式 UI 做批量操作要分多次调用**：一个 eval / 批次里连点多个会改同一响应式状态的控件（如多组"全选"），Vue 响应式未 flush 会让前面的操作被后面覆盖、只生效最后一个。一次一个动作分多次调用（让响应式 flush），或直接验数据层 payload / 网络响应——比连点更稳更准。
- **e2e 写了持久化状态验完恢复**：真机验证若触发了写库的用户偏好 / 账号设置（列偏好、筛选方案等），验完顺手恢复默认，别在用户账号留脚印。
- **并行派发共享契约前，契约先锚源头再下发**：给多个并行子代理 / 工作流分发会共用的跨切面契约（字段名 / 时间格式 / 类型 / 接口形状）前，先 grep 既有实现锚定真值（现成 formatter / 实体 / DTO），别凭"看起来合理"现编一份。否则各路实现各按你编的契约做、彼此内部自洽，单任务 review 谁都发现不了，只在集成期才暴露漂移；把"防漂移"前移到下发设计期，而非靠 review / 集成期补抓。教训：本会话给前后端定时间串契约写成无尾 Z，而既有 `formatUtcWallClock` 本就带尾 Z → 前端解析再补一个 Z → `ZZ` → Invalid Date → elapsedMs 恒 0，集成才抓到；下发前 grep 一眼 formatter 即可零漂移。

## 项目
cryptotrading：量化交易回测系统。覆盖 A 股（Tushare Pro）与美股（Yahoo Finance）的 K 线 / 资金流向 / 基本面采集、策略回测与 Web 可视化。

## 数据源权限
- **我目前没有权限查看 tushare 美股的数据。** 即 Tushare 美股系列接口（`us_daily` / `us_daily_adj` / `us_adjfactor` / `us_basic` 等）不可用（`us_daily_adj` 需正式权限、`us_adjfactor` 需先开通美股日线权限），评估美股数据源 / 复权方案时别把它当候选。**美股现走 Yahoo Finance chart API**（自建 `apps/quant-pipeline/.../sync/yahoo_client.py`，stdlib urllib；`adj_close/close` 派生乘法前复权因子，恒正）；2026-06-17 已从 AkShare 全量迁移、移除 akshare 依赖。注：Yahoo `close`/`volume` 是拆股回溯调整值（非 as-traded），AMV 因 Σ(close×volume) 相消而正确。

## 环境
- 操作系统：Windows 11，终端 PowerShell。PowerShell 命令禁用 `&&` 连接，改用 `;` 或多行执行。
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

涉及 DB schema 调整时，须随附 `docker exec` 格式的可执行脚本（参考 `apps/server/src/migration/*.sql` + 对应 `.ps1`）。

**后端 `dev` 是 `nest start`（无 `--watch`，不热加载）**：改动 `apps/server` 代码后**必须重启后端进程**，新路由 / 改动才生效。端到端验证前先确认后端跑的是最新代码，否则会撞新接口 404、行为还是旧的等假象（前端 `vite` 有 HMR，不受此限）。

## 架构总览

**monorepo（pnpm workspaces）**：
- `apps/server/` — NestJS 10 + TypeORM + PostgreSQL（端口 3000，全局 `/api` 前缀）
- `apps/web/` — Vue 3 + Vite + Naive UI + ECharts + Pinia（端口 5173）
- `packages/shared-types/` — 前后端共享 TS 类型

**后端模块（`apps/server/src/`）**按业务域分组而非平铺：
- `auth/`、`users/` — 全局 `AuthGuard`（通过 `APP_GUARD` 注册）+ 邀请码 + 会话
- `catalog/{symbols,watchlists,symbol-presets}/` — 标的目录与自选
- `market-data/` — 各数据源采集与查询，子目录按域分：
  - A 股：`a-shares`、`money-flow`、`index-catalog`、`ths-index-daily`、`active-mv`（主动成交量 AMV）、`oamv`（指数 AMV）
  - 美股：`us-stocks`、`us-index-daily`、`us-index-amv`
  - 通用：`klines`、`sync`、`base-data-sync`、`one-click-sync`、`signal-rolling-indicator`（`_shared/` 为跨模块同步辅助）
- `strategies/`、`backtest/`、`strategy-conditions/` — 策略、回测、条件扫描
- `modules/quant/` — 量化模型训练与推理（因子 / 特征 / 标签 / 训练 / 评分管线，`ml.jobs` 调度 + SSE 进度推送）
- `indicators/` — 技术指标计算（MA/MACD/KDJ/砖图，含 worker 线程池）
- `daily-review/` — 复盘日报 + 工具调用流水线（Tavily/Serper）
- `preferences/`、`settings/` — 用户偏好（列偏好、筛选方案等）与系统设置
- `entities/` — TypeORM 实体按业务域分子目录（不与 module 目录同构）
- `migration/` — schema 变更与回填脚本（平铺）：`*.sql` + 同名 `.ps1` 配对（PS1 内置 `docker exec`，用 `$PSScriptRoot` 引同目录 SQL）；另含少量 `*.ts` 回填脚本（`csv-import / a-share-brick-backfill / daily-basic-pe-ttm-backfill`，经 `apps/server/package.json` 的 `migration:*` 脚本以 ts-node 直跑；另有 `a-share-indicators-backfill.ts` 暂无脚本入口，需 ts-node 直跑）

**前端视图（`apps/web/src/views/`）**：`auth / market / quant / strategy / sync / system`，各子路由见 [README.md](README.md) 页面表。

**数据流要点**：
- Tushare 拉数据 → 写 `raw.*` 表（`daily_quote / daily_basic / adj_factor / trade_cal / ...`）→ 服务端计算技术指标（MA/MACD/KDJ，`technicalindicators` 库）→ 前端按 `trade_date` 对齐展示。
- SSE 进度推送：同步任务和量化 jobs 均通过 SSE 推进度；`EventSource` 不带 Authorization header，量化 jobs 流先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再用 query 参数建连（详见 [apps/web/src/views/quant/README.md](apps/web/src/views/quant/README.md)）。

## 会话交接提示词（`prompts/`）

`prompts/` 存放**自包含的跨会话任务交接提示词（handoff prompts）**：每个 `.md` 可整段贴给全新会话 / agent 直接接手，不依赖上一会话上下文——用于一个任务跨多会话推进，或在会话末尾把"未做完 / 下一步"固化下来交给下一棒。

**典型结构**（非强制，按需取舍）：一句话目标 → 现状摸底（**file:line 为证，别凭模块名猜**）→ 已定方向 + 待 brainstorming 敲定的开放问题 → 硬约束 / 项目规范 → 验证标准 → 前序进度 / 待续。

**约定**：
- **命名**：动词开头 kebab-case 描述任务，如 `add-strategy-signal-stats.md`。
- **生命周期**：写交接 → 新会话接手 → 完成后**删除，或移入 `prompts/archive/`**（已完成 / 过时的归此，保留可追溯、不占主目录视线），别让已实现的交接留在主目录冒充"待办"。
- **提交**：交接文档用 `docs(prompts): …` 或 `docs(<域>): …交接`；删除已实现的用 `chore(<域>): 删除已实现的交接提示词`。
