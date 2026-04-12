# AGENTS.md — apps/server/

> **L2（按需加载）**：NestJS 后端规范。需要具体实现时再读对应源文件（L3）。

---

## 模块速查

| 模块目录 | 路由前缀 | 说明 |
|---------|---------|------|
| `src/entities/` | — | TypeORM 实体（共用，不属于某个模块） |
| `src/klines/` | `GET /api/klines/:symbol/:interval` | K 线数据查询 |
| `src/symbols/` | `GET /api/symbols/names`, `POST /api/symbols/query`, `PATCH /api/symbols/:id` | 标的管理与筛选 |
| `src/sync/` | `GET /api/sync/run`（SSE）, `PUT/GET /api/sync/preferences` | 数据同步（SSE 推进度） |
| `src/backtest/` | `POST /api/backtest/start/:id`（SSE）, `GET /api/backtest/runs/:id`, `GET /api/backtest/run/:runId` | 策略回测 |
| `src/backtest/engine/` | — | 回测引擎（Python→TS 精确翻译） |
| `src/strategies/` | `GET /api/strategies/types`, CRUD `/api/strategies` | 策略 CRUD + 内置类型 |
| `src/watchlists/` | CRUD `/api/watchlists` | 自选列表 |
| `src/settings/` | `GET/PUT /api/settings/excluded-symbols`, `/api/settings/config/:key` | 排除标的 + 全局配置 |
| `src/migration/` | — | CSV 导入 CLI（`pnpm migrate:csv`） |

---

## 回测引擎文件速查（`src/backtest/engine/`）

| 文件 | 对应原 Python | 关键导出 |
|------|-------------|---------|
| `models.ts` | `models.py` | `Position`, `TradeRecord`, `KlineBarRow` |
| `bt-indicators.ts` | `indicators.py` | `calcRecentHigh`, `calcRecentLow` |
| `cooldown.ts` | `cooldown.py` | `setCooldown` |
| `loss-tracker.ts` | `loss_tracker.py` | `LossTracker` |
| `trade-helper.ts` | `trade_helper.py` | `createTradeRecord` |
| `signal-scanner.ts` | `signal_scanner.py` | `scanSignals` |
| `position-handler.ts` | `position_handler.py` | `processCandle`, `processEntryCandle` |
| `engine.ts` | `engine.py` | `runBacktest` |
| `report.ts` | `report.py` | `calcStats`, `prepareReportData` |
| `data.service.ts` | `data.py` | `BacktestDataService`（从 PostgreSQL 加载） |

---

## 关键约定

- **实体**：宽表 `klines`（一行一根 K 线），唯一约束 `symbol + interval + open_time`
- **KDJ 公式**：`period=9, K₀=D₀=50`，与 Python 原版完全一致，不得修改
- **MA 列**：从 DB 读 `ma5/ma30/ma60/ma120/ma240`，不在引擎内计算
- **策略类型**：`strategy_types` 表由代码 seed（`AppModule.onModuleInit`），不手动插入
- **SSE 事件格式**：`{ type: 'progress'|'done'|'error', percent?, phase?, message?, data? }`
- **环境变量**：`apps/server/.env`（不提交 git），参考 `.env.example`

---

## 修改指引

| 想做的事 | 改哪里 |
|---------|-------|
| 调整回测参数默认值 | `strategies/strategy-types.seed.ts` → `DEFAULT_CONFIG` |
| 修改入场信号条件 | `engine/signal-scanner.ts` → `scanSignals` |
| 修改止损/止盈规则 | `engine/position-handler.ts` → `processCandle` |
| 新增 API 模块 | 新建 `src/<feature>/` 三件套，在 `app.module.ts` 导入 |
| 新增实体字段 | `src/entities/<entity>.entity.ts`（`synchronize:true` 自动建列） |
| 修改 SSE 事件字段 | `backtest.service.ts` + `sync.service.ts` + 前端 `useSSE.ts` 同步改 |
