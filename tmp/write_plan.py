# -*- coding: utf-8 -*-
content = u"""# Tushare 数字货币 K 线同步集成计划

## 一、代码库探索结论

### 1. Tushare 集成方式
- **核心服务**: `apps/server/src/market-data/a-shares/services/tushare-client.service.ts`
- 通过 HTTP POST 调用 `http://api.tushare.pro`，Body 为 `{ api_name, token, params, fields }`
- 已内置自适应限流（`p-limit` 并发 + 指数退避间隔调整）、3 次重试、错误关键词匹配
- 返回类型: `TushareRow[] = Record<string, string | number | null>`

### 2. coin_bar API 参数与响应
- **来源**: `.claude/skills/tushare-crypto-http/references/api.md`
- **输入参数**:
  | 字段 | 说明 |
  |------|------|
  | `exchange` | 交易所，如 `binance` / `okex` |
  | `ts_code` | 代码，如 `BTC_USDT` |
  | `freq` | `1min` / `5min` / `15min` / `30min` / `60min` / `1day` / `1week` |
  | `start_date` / `end_date` | 格式 `2020-04-01 00:00:01` |
  | `is_contract` | `Y` / `N` |
- **响应字段**: `exchange`, `symbol`, `freq`, `trade_time`, `open`, `close`, `high`, `low`, `vol`, `is_contract`
- **限量**: 单次最大 8000 条
- **注意**: Tushare `symbol` 返回的是交易所原始代码，与请求的 `ts_code` 可能不同

### 3. 数据库表结构（TypeORM + PostgreSQL）
- **ORM**: TypeORM，`synchronize: false`（需手动迁移或新增实体后执行迁移）
- **现有加密货币 K 线表** — `klines` (`apps/server/src/entities/kline.entity.ts`):
  | 字段 | 类型 | 说明 |
  |------|------|------|
  | id | bigint PK | |
  | symbol | text indexed | |
  | interval | text indexed | |
  | open_time | timestamptz indexed | |
  | open | numeric(30,10) | |
  | high | numeric(30,10) | |
  | low | numeric(30,10) | |
  | close | numeric(30,10) | |
  | volume | numeric(30,10) | |
  | close_time | timestamptz | |
  | quote_volume | numeric(30,10) | |
  | trades | bigint | |
  | taker_buy_base_vol | numeric(30,10) | |
  | taker_buy_quote_vol | numeric(30,10) | |
  | dif, dea, macd, kdj_k, kdj_d, kdj_j | double precision | 技术指标 |
  | bbi, ma5, ma30, ma60, ma120, ma240 | double precision | 技术指标 |
  | quote_volume_10, atr_14, loss_atr_14 | double precision | 技术指标 |
  | low_9, high_9, stop_loss_pct, risk_reward_ratio | double precision | 技术指标 |
  | **UNIQUE** | | `(symbol, interval, open_time)` |
- **现有交易对表** — `symbols` (`apps/server/src/entities/symbol/symbol.entity.ts`):
  | 字段 | 类型 | 说明 |
  |------|------|------|
  | symbol | text PK | |
  | base_asset | text | |
  | quote_asset | text | |
  | is_active | boolean default true | |
  | sync_enabled | boolean default false | |
  | is_excluded | boolean default false | |
  | updated_at | timestamptz | |
- **A 股参考表**（同步模式参考）:
  - `a_share_symbols` — 股票基础信息
  - `a_share_daily_quotes` — 日线行情（含前复权字段）
  - `a_share_daily_metrics` — 每日指标
  - `a_share_adj_factors` — 复权因子
  - `a_share_sync_states` — 脏区间标记

### 4. A 股同步模块结构（参考范本）
```
apps/server/src/market-data/a-shares/
├── a-shares.module.ts
├── a-shares.controller.ts
├── a-shares.service.ts
├── a-shares.types.ts
├── services/
│   ├── tushare-client.service.ts
│   ├── a-shares-indicator.service.ts
│   └── a-shares-filter-presets.service.ts
├── sync/
│   ├── a-shares-sync.service.ts
│   ├── a-shares-sync-fetchers.ts
│   ├── a-shares-sync-types.ts
│   ├── a-shares-sync-utils.ts
│   ├── a-shares-sync.constants.ts
│   ├── a-shares-sync-completeness.ts
│   └── a-shares-sync-dirty-ranges.ts
└── data-access/
    └── a-shares-query.sql.ts
```
**核心模式**:
1. `SyncService` 持有 Repositories + `TushareClientService`，通过 `deps` getter 注入给 fetchers
2. Fetchers 是纯异步函数 `(deps, date) => Promise<SyncResult>`，内部调用 `tushareClient.query()` 后 `upsertInChunks`
3. 逐日期循环，支持 `incremental` / `overwrite` 模式
4. SSE 进度事件结构: `{ type: "start" | "progress" | "done" | "error", phase, current, total, percent, message }`
5. 批量写入使用 `repo.upsert(values, conflictPaths)`，chunk size = 1000

### 5. 现有 K 线 TypeScript 类型
- **KlineRow** (`apps/server/src/indicators/indicators.ts`):
  ```ts
  export interface KlineRow {
    open_time: Date | string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
    close_time?: Date | string;
    quote_volume?: string | number;
    trades?: string | number;
    taker_buy_base_vol?: string | number;
    taker_buy_quote_vol?: string | number;
  }
  ```
- **KlineRowWithIndicators** 扩展了 `DIF`, `DEA`, `MACD`, `KDJ.*`, `MA*`, `atr_14`, `stop_loss_pct` 等字段
- **计算入口**: `calcIndicators(rows: KlineRow[]): KlineRowWithIndicators[]`（精确翻译自 Python）

---

## 二、实施方案

### 目标
在 `apps/server/src/market-data/crypto/` 下新建 **Tushare 数字货币同步模块**，复用现有 `TushareClientService` 与 `KlinesService`，将 `coin_bar` 数据写入 `klines` 表并计算技术指标。

### 关键映射关系

| Tushare coin_bar | 本系统 klines / symbol |
|------------------|------------------------|
| `ts_code` (如 `BTC_USDT`) | 规范化后存入 `symbol` (如 `BTCUSDT`) |
| `freq` (`1min`/`5min`/`15min`/`30min`/`60min`/`1day`/`1week`) | `interval` (`1m`/`5m`/`15m`/`30m`/`1h`/`1d`/`1w`) |
| `trade_time` (`2020-04-21 07:00:00`) | `open_time` (Date) |
| `vol` | `volume` |
| `open` / `high` / `low` / `close` | `open` / `high` / `low` / `close` |
| — | `close_time` = 根据 interval 推算 |
| — | `quote_volume`, `trades`, `taker_buy_*` = `null` |

### 新增文件清单

```
apps/server/src/market-data/crypto/
├── crypto.module.ts
├── crypto.controller.ts
├── crypto-sync.service.ts
├── crypto-sync-fetchers.ts
├── crypto-sync-types.ts
├── crypto-sync-utils.ts
└── crypto-sync.constants.ts
```

### 需要修改的现有文件

1. `apps/server/src/app.module.ts` — 导入 `CryptoModule`
2. `apps/server/src/entities/symbol/symbol.entity.ts` — **可选**：增加 `source` 字段以区分 Binance / Tushare（若需共存多源）

### 详细步骤

#### Step 1: 新建同步类型与常量
- `crypto-sync-types.ts`: 定义 `CryptoSyncEvent`, `CryptoSyncResult`, `CryptoSyncRange`, `CryptoSyncMode`
- `crypto-sync.constants.ts`: 定义 `COIN_BAR_FIELDS = "exchange,symbol,freq,trade_time,open,close,high,low,vol,is_contract"`

#### Step 2: 实现 Fetchers
- `crypto-sync-fetchers.ts`:
  - `fetchKlinesBySymbolInterval(deps, symbol, interval, startDate, endDate)`
  - 调用 `tushareClient.query("coin_bar", { exchange: "binance", ts_code: tushareSymbol, freq, start_date, end_date })`
  - 将 `trade_time` 解析为 `Date` 作为 `open_time`
  - 根据 `freq` 计算 `close_time`（如 `1min` → +60s）
  - 调用 `calcIndicators()` 计算指标
  - 转换为 `Partial<KlineEntity>[]`
  - 通过 `KlinesService.upsertKlines()` 写入（复用现有 upsert 逻辑）

#### Step 3: 实现主控 Sync Service
- `crypto-sync.service.ts`:
  - 注入 `TushareClientService`, `KlinesService`, `ConfigService`
  - `startSync(): Subject<SseEvent>` 返回 RxJS Subject 供 SSE 使用
  - 读取配置决定同步的 `symbols` 和 `intervals`
  - 对每个 symbol × interval 组合：
    1. 查询本地最新 `openTime`
    2. 决定 `start_date`（本地最新往前回溯 N 天，或默认起点）
    3. 循环分页拉取（coin_bar 单次 8000 条）
    4. 计算指标 → upsert
    5. 发射 progress 事件

#### Step 4: 实现 Controller
- `crypto.controller.ts`:
  - `POST /crypto/sync` — 触发同步（AdminOnly）
  - `GET /crypto/sync/run` — SSE 流式返回进度（与 A 股完全一致的事件格式）

#### Step 5: 注册模块
- `crypto.module.ts`: `TypeOrmModule.forFeature([SymbolEntity, KlineEntity])`，providers / controllers / exports
- `app.module.ts`: 加入 `CryptoModule`

### 与现有 Binance 同步的共存策略
- **方案 A（推荐）**: 不改动现有 `SyncModule`，`CryptoModule` 作为独立数据源并存。`klines` 表中通过 `symbol` 名称区分（如 Tushare 的 `BTCUSDT` 与 Binance 的 `BTCUSDT` 若同名则直接覆盖/合并）。
- **方案 B**: 给 `SymbolEntity` 增加 `source: "binance" | "tushare"` 字段，避免同 symbol 不同源的数据冲突。

### 技术指标计算
- 直接复用 `apps/server/src/indicators/indicators.ts` 中的 `calcIndicators()`
- 注意：`quote_volume` 在 Tushare 数据中为 `null`，`calcIndicators` 中 `parseFloat(String(quote_volume || 0))` 会将其视为 `0`，导致 `10_quote_volume` 及依赖它的指标为 `0`。这是可接受的行为，但应在文档中注明。

### 限流与重试
- `TushareClientService` 已完全处理（自适应间隔、指数退避、关键词检测重试）
- `coin_bar` 免费试用每分钟 2 次；若项目已有正式 token，并发与频率由环境变量 `TUSHARE_CONCURRENCY` / `TUSHARE_MIN_INTERVAL_MS` 控制

---

## 三、待确认事项（影响方案选择）

1. **数据源冲突**: 是否需要在 `symbols` / `klines` 层面区分 Binance 源与 Tushare 源？还是直接复用现有表、同名 symbol 视为同一标的？
2. **同步范围**: 初始默认同步哪些 symbol / interval？是否沿用 `app_config` 中的 `sync_intervals` 与 `symbols.sync_enabled` 配置？
3. **交易所固定**: `coin_bar` 支持 `binance` / `okex` / `huobi` 等，是否默认固定为 `binance`，还是需要可配置？
4. **UI 集成**: 前端同步页面（`SyncView.vue`）是否增加 Tushare 同步入口，还是仅提供后端 API？

---

## 四、验收标准

- [ ] `POST /crypto/sync` 可触发同步任务
- [ ] `GET /crypto/sync/run` SSE 正确返回 start / progress / done / error 事件
- [ ] `coin_bar` 数据正确写入 `klines` 表，`symbol`, `interval`, `open_time` 复合唯一键无冲突
- [ ] 技术指标（MACD / KDJ / MA / ATR 等）在同步后自动计算并写入
- [ ] 前端 K 线查询与回测系统能正常读取新写入的数据
- [ ] TypeScript 编译通过（`pnpm exec tsc --noEmit`）
"""
with open(r"C:\Users\Lucifer\.kimi\plans\static-superboy-orion.md", "w", encoding="utf-8") as f:
    f.write(content)
print("ok")