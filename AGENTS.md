# AGENTS.md — cryptotrading 项目总览

> **L1（始终加载）**：全局概览。编写代码前先读对应子目录的 AGENTS.md（L2），按需读取源文件（L3）。

---

## 项目定位

基于币安 USDT 现货行情的完整本地流水线：**K 线采集 → 指标计算 → 本地回测 → Web 可视化**

- **后端**：NestJS + TypeScript + TypeORM（PostgreSQL）
- **前端**：Vue 3 + TypeScript + Vite + Naive UI
- **架构**：pnpm monorepo（`apps/server`、`apps/web`）

---

## 目录索引

| 路径 | 说明 |
|------|------|
| `apps/server/` | NestJS 后端（API、回测引擎、数据同步） |
| `apps/web/` | Vue 3 + TypeScript 前端 |
| `cache/` | 旧版 CSV 缓存（可通过迁移脚本导入 DB） |
| `prd/` | 产品需求文档 |
| `docker-compose.yml` | 开发环境（仅 PostgreSQL） |
| `docker-compose.prod.yml` | 生产环境（nginx + server + postgres） |

---

## 快速启动（开发）

```bash
# 1. 安装依赖
pnpm install

# 2. 启动 PostgreSQL
pnpm db:start

# 3. 配置环境变量
cp apps/server/.env.example apps/server/.env
# 编辑 apps/server/.env，确认 DB 连接参数

# 4. 启动后端 + 前端
pnpm dev
# 后端: http://localhost:3000/api
# 前端: http://localhost:5173

# 5. （可选）从 CSV 迁移历史数据
pnpm migrate:csv
```

---

## 后端模块

```
apps/server/src/
├── entities/          # TypeORM 实体（klines, symbols, strategies, ...）
├── klines/            # GET /api/klines/:symbol/:interval
├── symbols/           # POST /api/symbols/query, GET /api/symbols/names
├── sync/              # GET /api/sync/run (SSE), PUT /api/sync/preferences
├── backtest/          # POST /api/backtest/start/:id (SSE), GET /api/backtest/runs/:id
│   └── engine/        # 回测引擎（精确翻译自 Python）
├── strategies/        # CRUD /api/strategies, /api/strategies/types
├── watchlists/        # CRUD /api/watchlists
├── settings/          # PUT /api/settings/excluded-symbols, config
└── migration/         # CLI: csv-import.ts
```

## 前端页面

| 路由 | 说明 |
|------|------|
| `/backtest` | 策略管理 + 运行回测（SSE 进度）+ 历史结果 Drawer |
| `/symbols` | 标的筛选（高级条件）+ K 线图表 |
| `/sync` | 数据同步（SSE 进度）+ 配置 |
| `/watchlists` | 自选列表 CRUD |
| `/settings` | 排除标的管理、同步配置 |

---

## 回测引擎（apps/server/src/backtest/engine/）

| 文件 | 对应 Python 模块 |
|------|----------------|
| `models.ts` | `models.py` |
| `bt-indicators.ts` | `indicators.py`（calcRecentLow/High） |
| `cooldown.ts` | `cooldown.py` |
| `loss-tracker.ts` | `loss_tracker.py` |
| `trade-helper.ts` | `trade_helper.py` |
| `signal-scanner.ts` | `signal_scanner.py` |
| `position-handler.ts` | `position_handler.py` |
| `engine.ts` | `engine.py` |
| `report.ts` | `report.py` |
| `data.service.ts` | `data.py`（数据源改为 PostgreSQL） |

---

## 生产部署

```bash
# 构建前端静态文件
pnpm build

# 启动生产容器（nginx + server + postgres）
pnpm prod:up
```
