# CLAUDE.md 优化设计

**日期：** 2026-06-28  
**状态：** 已审阅  
**范围：** 更新 `CLAUDE.md` 使其与当前代码库一致；修复 `package.json` 中 `prod:up`/`prod:down` 文件名 typo。

---

## 背景与目标

2026-06-28 审计发现 `CLAUDE.md` 核心框架仍准确，但存在多处滞后：monorepo 漏写 `apps/quant-pipeline/`、market-data 子模块不全、前端路由指向过时的 README、migration TS 脚本列表不全、缺文档地图与启动阻塞 env 提示。

**定位决策（用户确认）：** `CLAUDE.md` 为 **精简 agent 入口** — 硬约束 + 命令 + 架构骨架 + 权威文档索引；细节通过链接跳转，不追求行数上限但避免事实堆砌。

**不在本次范围：**
- 不恢复 `AGENTS.md`
- 不同步改 `README.md`（可另开任务）
- 不在 CLAUDE 写完整路由表或 skills 全清单

---

## 现状问题清单

| # | 位置 | 问题 | 证据 |
|---|------|------|------|
| 1 | §架构 monorepo | 未列 `apps/quant-pipeline/` | `apps/quant-pipeline/pyproject.toml` |
| 2 | §架构 market-data | 缺 `index-daily`、`sw-index-daily`、`index-weight` | `app.module.ts` L77–79 |
| 3 | §架构 strategies | 未提 `regime-engine/` | `app.module.ts` L111 |
| 4 | §架构 strategy-conditions | 描述过简，缺 signal-stats / portfolio-sim | `strategy-conditions/` 目录 |
| 5 | §架构 indicators | 表述为 NestJS 模块，实为共享库 | 无 `indicators.module.ts` |
| 6 | §架构 前端 | 指向 README 页面表 | README 仍写币安为主、缺大量路由 |
| 7 | §migration | TS 回填脚本不全 | `apps/server/package.json` migration:* |
| 8 | §环境 | 未提示启动阻塞 env | `.env.example` [REQ] 段 |
| 9 | §命令 | 未说明 quant worker 需另开终端 | `scripts/dev.mjs` 仅 DB+server+web |
| 10 | 全局 | 无文档地图 | `.claude/rules/`、`docs/superpowers/specs/` 未指向 |
| 11 | §项目 | 未说明 crypto 仍保留 | `SymbolsView.vue` 加密 tab |
| 12 | package.json | `prod:up`/`prod:down` 文件名 typo | `docker compose.prod.yml` vs 实际 `docker-compose.prod.yml` |

---

## 目标结构

```text
CLAUDE.md
├─ 核心规范              ← 不动
├─ 项目                  ← 微调定位 + crypto 脚注
├─ 数据源权限            ← 不动
├─ 环境                  ← 补启动阻塞 env 提示
├─ 常用命令              ← 补 quant worker；pnpm dev 旁注
├─ 架构总览              ← 骨架化 + 纠错
├─ 文档地图（新节）      ← 权威文档索引表
└─ 会话交接提示词        ← 不动
```

---

## 逐节修订规格

### §项目

**替换为：**

> cryptotrading：A 股（Tushare Pro）与美股（Yahoo Finance）的 K 线 / 资金流向 / 基本面采集、策略回测与 Web 可视化。加密标的（币安 K 线）仍保留于 `/symbols`，非当前主开发域。

### §环境

在现有 `.env` 说明段落后追加一段：

> 启动阻塞变量见根目录 [.env.example](.env.example) 中标注 `[REQ]` 的项（`TUSHARE_TOKEN`、`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_PROVIDER` / `LLM_MODEL`）。`DailyReviewModule` 默认装载，缺 LLM 配置会导致后端启动失败。量化 SSE 用 `QUANT_SSE_TOKEN_SECRET`（非 `[REQ]`，有 `JWT_SECRET` 兜底链，见 `.env.example`）。

### §常用命令

**命令表新增一行：**

| 任务 | 命令 |
|------|------|
| 量化 worker（另开终端，`pnpm dev` 不启动） | `cd apps/quant-pipeline; uv sync; uv run quant worker run` |

**`pnpm dev` 行旁注（可在表下用一行 italic 或括号说明）：** 仅启动 DB + server :3000 + web :5173，不含 quant worker。

**package.json 修复（同批提交）：**

```json
"prod:up": "docker compose -f docker-compose.prod.yml up -d --build",
"prod:down": "docker compose -f docker-compose.prod.yml down"
```

### §架构总览 — monorepo

**替换四件套列表为：**

```text
apps/
├─ server/          — NestJS 10 + TypeORM + PostgreSQL（:3000，全局 /api 前缀）
├─ web/             — Vue 3 + Vite + Naive UI + ECharts + Pinia（:5173）
├─ quant-pipeline/  — Python（uv）；Yahoo/Tushare 同步、因子/特征/标签/训练、ml.jobs worker
└─ packages/shared-types/ — 前后端共享 TS 类型
```

### §架构总览 — 后端模块

**market-data/ 子目录改为分组树：**

```text
market-data/
├─ A 股: a-shares, money-flow, index-catalog, ths-index-daily,
│        index-daily, sw-index-daily, index-weight, active-mv, oamv
├─ 美股: us-stocks, us-index-daily, us-index-amv
└─ 通用: klines, sync, base-data-sync, one-click-sync,
         signal-rolling-indicator（_shared/ 为跨模块同步辅助）
```

**其它模块措辞修订：**

| 模块 | 新描述 |
|------|--------|
| `strategies/` | 策略定义；含 `regime-engine/`（Regime 引擎） |
| `backtest/` | 不变（回测引擎） |
| `strategy-conditions/` | 条件扫描；含 `signal-stats/`（信号前向统计）、`portfolio-sim/`（组合模拟） |
| `indicators/` | 共享计算库（MA/MACD/KDJ/砖图，含 worker 线程池），**非** NestJS Module |

**migration/ 段落修订：**

- SQL + PS1 配对描述不变
- TS 回填改为：「见 `apps/server/package.json` 的 `migration:*` 脚本（含 `csv-import`、`a-share-brick-backfill`、`daily-basic-pe-ttm-backfill`、`backfill-a-share-sw-industry`、`backfill-money-flow-aggregation`、`backfill-index-weight` 等）；`a-share-indicators-backfill.ts` 暂无 npm 入口，需 ts-node 直跑」

### §架构总览 — 前端与数据流

**前端 views 段落替换 README 指针：**

> 顶层分组：`auth / market / quant / strategy / sync / system`。路由权威源：[apps/web/src/router/index.ts](apps/web/src/router/index.ts)（全站）、[Sidebar.vue](apps/web/src/components/layout/Sidebar.vue)（可见菜单）、[quant/README.md](apps/web/src/views/quant/README.md)（quant 子树 SSE/草稿态）。

**链接约定：** `CLAUDE.md` 在仓库根目录，所有链接使用根相对路径（如 `doc/规范/conventions.md`），勿用 `../../` 前缀。

**数据流 / SSE 段落微调：**

- 数据流要点不变
- SSE 段追加一句：「同步任务、量化 jobs、daily-review 等用 SSE；回测进度为轮询（非 SSE）。」

### §文档地图（新节，置于「会话交接提示词」之前）

| 主题 | 权威文档 |
|------|----------|
| 编码 / UTF-8 / 中文编辑 | [doc/规范/conventions.md](doc/规范/conventions.md) |
| NestJS / Vue / SQL / 数据完整性硬规则 | [.claude/rules/](.claude/rules/) |
| 可触发 Agent 技能 | [.claude/skills/](.claude/skills/)（Tushare → `tushare-sync-dev`；查 DB → `db-inspect`；前端 → `frontend-dev-lessons`） |
| 功能设计 spec（brainstorming 产出） | [docs/superpowers/specs/](docs/superpowers/specs/) |
| 量化运维 / worker | [doc/quant-runbook.md](doc/quant-runbook.md)、[apps/quant-pipeline/README.md](apps/quant-pipeline/README.md) |
| 环境变量全集 | [.env.example](.env.example) |
| 跨会话任务交接 | `prompts/`（约定见下文） |

### §会话交接提示词

内容不变。

---

## 实现步骤

1. 按上表修订 `CLAUDE.md`
2. 修复根 `package.json` 的 `prod:up` / `prod:down` 文件名
3. 通读一遍，确认链接路径在仓库内可解析
4. 可选：PowerShell 行数统计 `(Get-Content CLAUDE.md | Measure-Object -Line).Lines` 记录于 commit message

---

## 验收标准

- [ ] `CLAUDE.md` 包含 `apps/quant-pipeline/` 及 worker 启动命令
- [ ] market-data 列出 `index-daily`、`sw-index-daily`、`index-weight`
- [ ] `strategies/`、`strategy-conditions/`、`indicators/` 描述与代码一致
- [ ] 前端路由不再指向 README 页面表
- [ ] migration TS 脚本描述与 `apps/server/package.json` 一致
- [ ] 新增「文档地图」节，至少覆盖 rules / skills / specs / quant-runbook / .env.example
- [ ] 环境节提示启动阻塞 env
- [ ] 项目节含 crypto 保留脚注
- [ ] `pnpm prod:up` 命令可找到正确的 `docker-compose.prod.yml`
- [ ] 无 TBD / TODO 占位符

---

## 风险与取舍

| 风险 | 缓解 |
|------|------|
| 链接路径因文件移动失效 | 使用相对路径；验收时点击检查 |
| README 仍过时导致用户困惑 | 本次不改 README；CLAUDE 已切断对 README 的依赖 |
| market-data 未来再增模块 | 文档地图指向 `.claude/rules/`，新模块优先更新 rules 而非撑 CLAUDE |
