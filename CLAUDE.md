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

涉及 DB schema 调整时，须随附 `docker exec` 格式的可执行脚本（参考 `apps/server/migrations/*.sql` + 对应 `.ps1`）。

**后端 `dev` 是 `nest start`（无 `--watch`，不热加载）**：改动 `apps/server` 代码后**必须重启后端进程**，新路由 / 改动才生效。端到端验证前先确认后端跑的是最新代码，否则会撞新接口 404、行为还是旧的等假象（前端 `vite` 有 HMR，不受此限）。

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
