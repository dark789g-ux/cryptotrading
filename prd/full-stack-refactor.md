# PRD：全栈重构（NestJS + Vue3 + PostgreSQL）

> 版本：1.0
> 日期：2026-04-12
> 状态：待开发

---

## 1. 背景与目标

当前项目为 Python（FastAPI）+ Vue3 + 本地 CSV 架构。本次重构目标：

1. 后端迁移至 **NestJS（TypeScript）**，所有 Python 逻辑完整重写
2. 数据存储迁移至 **PostgreSQL**（含完整指标宽表）
3. 前端迁移至 **Vue3 + TypeScript**，保留所有现有功能
4. 整体采用 **pnpm monorepo** 工程化结构
5. 生产环境通过 **Docker Compose** 三容器部署

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────┐
│  浏览器  http://localhost:5173 (dev)             │
│          http://localhost:80   (prod)            │
│  Vue3 SPA + TypeScript                          │
└───────────────────┬─────────────────────────────┘
                    │ HTTP / SSE
┌───────────────────▼─────────────────────────────┐
│  NestJS  :3000                                  │
│  ├── /api/symbols                               │
│  ├── /api/klines                                │
│  ├── /api/sync/run   (SSE)                      │
│  ├── /api/backtest/:id/run   (SSE)              │
│  ├── /api/strategies  (CRUD)                    │
│  ├── /api/strategy-types                        │
│  ├── /api/watchlists  (CRUD)                    │
│  └── /api/settings                             │
└───────────────────┬─────────────────────────────┘
                    │ TypeORM
┌───────────────────▼─────────────────────────────┐
│  PostgreSQL  :5432                              │
└─────────────────────────────────────────────────┘
```

**开发**：`pnpm dev` → `docker-compose up -d`（仅 postgres）+ 本地 server（:3000）+ web（:5173，Vite 代理 `/api → :3000`）

**生产**：`docker-compose.prod.yml` → nginx（:80）+ nestjs（:3000）+ postgres（:5432）

---

## 3. 目录结构

```
cryptotrading/
├── apps/
│   ├── server/                  # NestJS 后端
│   │   ├── src/
│   │   │   ├── symbols/         # 交易对查询与管理
│   │   │   ├── klines/          # K 线数据查询（多周期）
│   │   │   ├── sync/            # 币安数据拉取 + SSE
│   │   │   ├── backtest/        # 回测引擎 + SSE + 结果存储
│   │   │   ├── strategies/      # 策略实例 CRUD
│   │   │   ├── strategy-types/  # 策略类型（seed）
│   │   │   ├── watchlists/      # 自选分组 CRUD
│   │   │   ├── settings/        # app_config + excluded symbols
│   │   │   ├── config/          # .env 读取（ConfigModule）
│   │   │   └── main.ts
│   │   ├── .env.example
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── web/                     # Vue3 + TypeScript 前端
│       ├── src/
│       │   ├── views/
│       │   │   ├── SymbolsView.vue
│       │   │   ├── BacktestView.vue
│       │   │   ├── SyncView.vue
│       │   │   ├── WatchlistsView.vue
│       │   │   └── SettingsView.vue
│       │   ├── components/
│       │   │   ├── layout/
│       │   │   ├── symbols/
│       │   │   ├── backtest/
│       │   │   └── settings/
│       │   ├── composables/
│       │   ├── api/
│       │   └── router/
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   └── shared/                  # 共享 TypeScript 类型
│       ├── src/
│       │   ├── dto/             # API 请求/响应类型
│       │   ├── strategy/        # 策略 schema 类型
│       │   └── constants.ts     # 周期常量等
│       └── package.json
├── docker-compose.yml           # dev：仅 PostgreSQL
├── docker-compose.prod.yml      # prod：postgres + nestjs + nginx
├── package.json                 # pnpm workspace 根
├── AGENTS.md
├── doc/
└── prd/
```

**删除**：`backtest/`、`api/`、`frontend/`、所有根目录 `.py` 脚本、`data/`、`cache/`（迁移后）、`backtest_results/`

---

## 4. 数据库表设计

### 4.1 symbols

| 列 | 类型 | 说明 |
|----|------|------|
| `symbol` | varchar PK | 交易对，如 `BTCUSDT` |
| `base_asset` | varchar | 基础资产 |
| `quote_asset` | varchar | 计价资产 |
| `is_active` | boolean | 币安是否上架 |
| `sync_enabled` | boolean | 用户是否同步该标的 |
| `is_excluded` | boolean | 是否排除（稳定币等） |
| `updated_at` | timestamp | |

### 4.2 klines（宽表，核心表）

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | bigint PK | 自增 |
| `symbol` | varchar | 联合唯一（symbol+interval+open_time） |
| `interval` | varchar | `1h` / `4h` / `1d` |
| `open_time` | timestamp | K 线开盘时间 |
| `open` | numeric | |
| `high` | numeric | |
| `low` | numeric | |
| `close` | numeric | |
| `volume` | numeric | |
| `MA5` | numeric | |
| `MA30` | numeric | |
| `MA60` | numeric | |
| `MA120` | numeric | |
| `MA240` | numeric | |
| `KDJ_K` | numeric | |
| `KDJ_D` | numeric | |
| `KDJ_J` | numeric | KDJ 公式与 Python 版完全一致 |
| `DIF` | numeric | MACD 快线 |
| `DEA` | numeric | MACD 慢线 |
| `MACD` | numeric | MACD 柱 |
| *(其余指标列按 kline_indicators.py 补充)* | | |

### 4.3 strategy_types

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | varchar PK | 如 `ma_kdj` |
| `name` | varchar | 如 `MA+KDJ 超卖策略` |
| `description` | text | |
| `param_schema` | jsonb | JSON Schema，描述参数字段、类型、默认值、标签 |

> 启动时从代码 seed，不提供 UI 编辑入口。

### 4.4 strategies

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | uuid PK | |
| `name` | varchar | 用户可编辑 |
| `type_id` | varchar FK → strategy_types | |
| `params` | jsonb | BacktestConfig 全部字段 |
| `symbols` | jsonb | 上次选择的回测标的列表（字符串数组） |
| `last_backtest_at` | timestamp | |
| `last_backtest_return` | numeric | 最近一次总收益率（数值，非字符串） |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 4.5 backtest_runs

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | uuid PK | |
| `strategy_id` | uuid FK → strategies | |
| `timeframe` | varchar | |
| `date_start` | date | |
| `date_end` | date | |
| `symbols` | jsonb | 本次选择的标的列表 |
| `stats` | jsonb | 汇总统计（总收益率、胜率、最大回撤等） |
| `created_at` | timestamp | 回测执行时间 |

### 4.6 backtest_trades

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | bigint PK | |
| `run_id` | uuid FK → backtest_runs | |
| `symbol` | varchar | |
| `entry_time` | timestamp | |
| `entry_price` | numeric | |
| `exit_time` | timestamp | |
| `exit_price` | numeric | |
| `pnl` | numeric | 绝对盈亏 |
| `pnl_pct` | numeric | 盈亏百分比 |

### 4.7 watchlists / watchlist_items

```
watchlists: id (uuid), name (varchar), created_at
watchlist_items: id, watchlist_id (FK), symbol (varchar)
```

### 4.8 app_config

```
key (varchar PK), value (jsonb)
```

示例记录：
- `sync_intervals` → `["1h","4h","1d"]`

---

## 5. 后端 API 规范

### 5.1 symbols

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/symbols/names?interval=` | 返回全部交易对名称数组 |
| `GET` | `/api/symbols/kline-columns?interval=` | 返回 klines 表的指标列名数组 |
| `POST` | `/api/symbols/query` | 标的列表（分页、排序、指标筛选） |
| `PATCH` | `/api/symbols/:symbol` | 更新 sync_enabled / is_excluded |

**POST /api/symbols/query Body：**
```json
{
  "interval": "1d",
  "page": 1,
  "page_size": 20,
  "sort": { "field": "symbol", "asc": true },
  "q": "",
  "conditions": [{ "field": "KDJ_J", "op": "lt", "value": 10 }],
  "fields": ["MA60", "KDJ_J"]
}
```

### 5.2 klines

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/klines/:symbol/:interval` | 返回全量 K 线（含所有指标列），JSON 数组 |

### 5.3 sync

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sync/preferences` | 获取同步偏好（intervals + symbols） |
| `PUT` | `/api/sync/preferences` | 保存同步偏好 |
| `GET` | `/api/sync/run` | 启动同步，SSE 推送进度 |

### 5.4 strategy-types

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/strategy-types` | 返回全部策略类型及其 param_schema |

### 5.5 strategies

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/strategies` | 获取所有策略实例列表 |
| `POST` | `/api/strategies` | 新建策略实例 |
| `PUT` | `/api/strategies/:id` | 更新策略（含 params、symbols） |
| `DELETE` | `/api/strategies/:id` | 删除策略（级联删除关联回测记录） |

### 5.6 backtest

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/backtest/:strategyId/run?symbols=...` | 启动回测，SSE 推送进度 |
| `GET` | `/api/backtest/:strategyId/runs` | 获取该策略的全部历史回测记录（含 stats） |
| `GET` | `/api/backtest/runs/:runId/trades` | 获取某次回测的逐笔交易记录 |

### 5.7 watchlists

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/watchlists` | 获取全部分组 |
| `POST` | `/api/watchlists` | 新建分组 |
| `DELETE` | `/api/watchlists/:id` | 删除分组 |
| `GET` | `/api/watchlists/:id/items` | 获取分组内标的 |
| `POST` | `/api/watchlists/:id/items` | 添加标的 |
| `DELETE` | `/api/watchlists/:id/items/:symbol` | 移除标的 |

### 5.8 settings

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/settings/excluded-symbols` | 返回 is_excluded=true 的标的列表 |
| `POST` | `/api/settings/excluded-symbols` | 批量添加排除标的 |
| `DELETE` | `/api/settings/excluded-symbols/:symbol` | 取消排除某标的 |
| `GET` | `/api/settings/config` | 获取 app_config 全部 key-value |
| `PUT` | `/api/settings/config/:key` | 更新某项配置 |

### 5.9 SSE 事件格式（sync / backtest 通用）

```
data: {"type":"start"}
data: {"type":"progress","phase":"拉取1h K线","current":50,"total":200,"percent":25.0,"message":"BTCUSDT"}
data: {"type":"done","message":"完成"}
data: {"type":"error","message":"错误信息"}
```

---

## 6. 前端页面规范

### 6.1 路由

| 路由 | 组件 | 说明 |
|------|------|------|
| `/` | SymbolsView | 标的筛选 + K 线图 |
| `/sync` | SyncView | 数据同步 |
| `/backtest` | BacktestView | 策略回测 |
| `/watchlists` | WatchlistsView | 自选分组 |
| `/settings` | SettingsView | 全局设置 |

### 6.2 SymbolsView（标的页）

保留现有全部功能：
- 周期切换（1h / 4h / 1d）
- 搜索 + 高级筛选（多条件 AND，最多 10 条，字段来自 `kline-columns`）
- 服务端分页排序
- 点击标的 → 右侧 Drawer 展示 K 线图（主图：K 线 + MA5/30/60/120/240；副图1：KDJ；副图2：MACD柱+DIF+DEA）
- 十字线联动更新左上角指标数值

### 6.3 SyncView（同步页）

保留现有全部功能：
- 周期多选（1h / 4h / 1d 复选框）
- 标的模式（全部 / 自定义多选）
- 保存配置按钮
- 开始同步按钮 → SSE 实时日志 + 进度条
- 状态卡片（idle / running / done / error）
- 数据概览卡片（已选周期、标的数量、上次同步时间）

### 6.4 BacktestView（回测页）

保留现有全部功能，新增：

**策略列表**（现有）：
- 统计卡片：策略总数 / 已回测数 / 平均收益率
- 表格：策略名 / 类型 / 时间周期 / 最近回测时间 / 收益率
- 操作：查看详情 / 运行 / 编辑 / 删除

**新建/编辑策略弹窗**（StrategyModal）：
- 策略名称（可编辑，自动生成默认值）
- 策略类型下拉（读 `/api/strategy-types`）
- 动态参数表单：根据 `param_schema` 渲染，覆盖 `BacktestConfig` 全部字段
- 分组展示：资金与仓位 / 时间框架与日期 / 入场信号 / 止盈止损 / 冷却期 / 高级

**运行回测弹窗**（新增）：
- 标的多选（预填 `strategy.symbols`，可修改）
- 确认后开始，SSE 推送进度条 + 阶段文字
- 完成后刷新策略列表

**详情 Drawer**（BacktestDetail）：
- 历史运行记录列表（时间 + 总收益率 + 标的数），点击展开
- 展开内容：
  1. 汇总统计卡片（总收益率 / 胜率 / 最大回撤 / 夏普比率 / 总交易数）
  2. 净值曲线（ECharts，读 stats 中的 portfolio_log）
  3. 逐笔交易表（symbol / 买入时间/价 / 卖出时间/价 / 盈亏% / 持仓周期）
  4. 点击交易记录 → 加载该标的 K 线并标注买卖点

### 6.5 WatchlistsView（自选页）

- 分组列表（创建 / 删除）
- 每组内标的列表（添加 / 移除）
- 标的搜索（从 `symbols/names` 加载候选）

### 6.6 SettingsView（设置页）

- **排除标的管理**：表格展示 `is_excluded=true` 的标的，支持添加新排除标的、取消排除
- **全局配置**：同步周期默认值等 `app_config` key-value 展示（备用，主要入口在 SyncView）

### 6.7 视觉规范

与现有前端一致：Naive UI + ECharts，深色模式优先，毛玻璃风格（`backdrop-filter`），主色 `#667eea`。

---

## 7. 回测引擎（TypeScript 重写规范）

### 7.1 范围

完整重写 `backtest/` 下全部 Python 模块：

| Python 模块 | TypeScript 对应 |
|------------|----------------|
| `config.py` | `backtest/config.ts`（BacktestConfig interface） |
| `data.py` | `backtest/data.service.ts`（从 PostgreSQL 加载） |
| `indicators.py` | `backtest/indicators.ts`（KDJ 精确翻译 Python 公式） |
| `engine.py` | `backtest/engine.ts` |
| `signal_scanner.py` | `backtest/signal-scanner.ts` |
| `position_handler.py` | `backtest/position-handler.ts` |
| `trade_helper.py` | `backtest/trade-helper.ts` |
| `cooldown.py` | `backtest/cooldown.ts` |
| `loss_tracker.py` | `backtest/loss-tracker.ts` |
| `models.py` | `backtest/models.ts` |
| `report.py` | `backtest/report.ts` |

### 7.2 MA 计算

- klines 表中预存固定 MA 列（MA5/30/60/120/240）用于行情展示
- 回测引擎运行时根据策略 `ma_periods` **动态计算 MA**，不依赖预存列
- 使用 `technicalindicators` 库的 SMA 实现

### 7.3 KDJ 计算

- 不使用 `technicalindicators` 库的 Stochastic
- **精确翻译** `backtest/indicators.py` 中的 KDJ 公式，确保与历史 CSV 数据一致
- 同步入库时使用相同 TypeScript 实现

### 7.4 并发控制

- 内存互斥锁：同一时刻只允许一个回测运行
- 同步任务同理（内存锁）

---

## 8. 数据迁移 CLI

```bash
pnpm --filter server migration:csv
```

执行内容（按顺序）：
1. 读取 `cache/{interval}_klines/*.csv` → 批量写入 `klines` 表
2. 读取 `data/sync_preferences.json` → 设置对应 `symbols.sync_enabled = true`；写入 `app_config` 的 `sync_intervals`
3. 将代码中 `EXCLUDED_SYMBOLS` 集合 → 设置对应 `symbols.is_excluded = true`

> 迁移前需保证 PostgreSQL 已启动（`docker-compose up -d`）且 schema 已同步。

---

## 9. Docker 配置

### 9.1 开发（docker-compose.yml）

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
```

### 9.2 生产（docker-compose.prod.yml）

```yaml
services:
  postgres: # 同上，不暴露端口
  server:   # NestJS，构建自 apps/server/Dockerfile，内部 :3000
  nginx:    # 对外 :80，静态文件 + proxy_pass /api → server:3000
```

---

## 10. 环境变量（.env.example）

```
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_USER=cryptouser
DB_PASS=cryptopass
DB_NAME=cryptodb

# 服务
SERVER_PORT=3000

# 币安（系统代理处理网络，代码不设置 proxy）
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_BASE_URL=https://api.binance.com
```

---

## 11. 启动方式

```bash
# 开发
docker-compose up -d        # 启动 PostgreSQL
pnpm dev                    # 并行启动 server(:3000) + web(:5173)

# 首次数据迁移（可选）
pnpm --filter server migration:csv

# 生产
docker-compose -f docker-compose.prod.yml up -d
```

---

## 12. 迁移清单

| 路径 | 操作 |
|------|------|
| `backtest/` | ✗ 删除（逻辑迁入 apps/server） |
| `api/` | ✗ 删除 |
| `frontend/` | ✗ 删除（迁入 apps/web） |
| `*.py`（根目录） | ✗ 全部删除 |
| `data/` | ✗ 删除（迁移后） |
| `cache/` | ✗ 删除（迁移后） |
| `backtest_results/` | ✗ 删除（不迁移历史结果） |
| `generate_random.py` | ✗ 删除 |
| `convert_klines_time.py` | ✗ 删除 |
| `start.ps1` / `start.bat` | ✗ 删除 |
| `AGENTS.md` | ✎ 更新为新架构说明 |
| `doc/` | ✎ 保留，逐步更新 |
| `prd/` | ✎ 保留 |

---

## 13. 技术决策记录

| 事项 | 决策 | 原因 |
|------|------|------|
| 进度推送 | SSE | 场景为单向推送，比 WebSocket 简单，无需特殊 nginx 配置 |
| 任务队列 | 内存互斥锁 | 单用户本地工具，无需 Redis/BullMQ |
| ORM | TypeORM | 与 stock-analyzer 一致，NestJS 生态成熟 |
| K 线宽表 | 宽表（单表） | 查询时永远需要全部指标，JOIN 有性能损耗 |
| MA 计算 | 回测时动态计算 | 支持任意 ma_periods 配置 |
| KDJ 实现 | 手动翻译 Python 公式 | 保证与历史数据完全一致 |
| 旧回测结果 | 不迁移 | 数据结构差异大，重跑成本低 |
| 认证 | 无 | 纯本地工具 |
