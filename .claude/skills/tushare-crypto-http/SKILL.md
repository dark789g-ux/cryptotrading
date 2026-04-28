---
name: tushare-crypto-http
description: >
  通过 HTTP RESTful 接口从 Tushare Pro 获取加密货币（数字货币）行情数据。
  当用户需要：1) 调用 Tushare 的 coin_bar 或其他数字货币接口；2) 通过 HTTP 而非 Python SDK 获取加密货币 K 线/分钟线/日线数据；3) 在 NestJS 后端中集成 Tushare 数字货币数据同步；4) 处理 Tushare 数字货币接口的限流、重试、分页时触发。
---

# Tushare 加密货币 HTTP 接口技能

## 项目背景

本项目**不使用 Python SDK**，所有 Tushare 数据均通过 HTTP RESTful 接口获取。后端为 NestJS + TypeScript，已有通用的 `TushareClientService` 封装了 HTTP 调用、限流、重试逻辑。

## 既有基础设施

定位并复用以下文件，不要从零重建 HTTP 调用层：

- **`apps/server/src/market-data/a-shares/services/tushare-client.service.ts`**
  - 封装了 axios POST 到 `http://api.tushare.pro`
  - 内置 token 读取（`TUSHARE_TOKEN`）、指数退避限流、重试（最多 3 次）、错误码处理
  - 提供 `query(apiName, params, fields)` 方法，返回 `TushareRow[]`
  - 限流通过 `p-limit` + 请求间隔动态调整实现

## 使用 workflow

### 1. 确定需求

明确要获取的数字货币数据类型：

| 数据类型 | api_name | 说明 |
|---------|----------|------|
| 数字货币 K 线 | `coin_bar` | 1min/5min/15min/30min/60min/1day/1week |

### 2. 复用 TushareClientService

如果调用方在 `apps/server` 内，直接注入 `TushareClientService`：

```typescript
import { TushareClientService } from '../a-shares/services/tushare-client.service';

// 在 service 中注入
constructor(private readonly tushare: TushareClientService) {}

// 调用 coin_bar
const rows = await this.tushare.query('coin_bar', {
  exchange: 'okex',
  ts_code: 'BTC_USDT',
  freq: '1min',
  start_date: '2020-04-01 00:00:01',
  end_date: '2020-04-04 19:00:00',
});
```

### 3. 处理返回数据

`TushareClientService.query` 返回 `TushareRow[]`，即 `Record<string, string | number | null>[]`。

对于 `coin_bar`，每条记录包含字段：`exchange`, `symbol`, `freq`, `trade_time`, `open`, `close`, `high`, `low`, `vol`, `is_contract`。

需要类型安全时，在调用方定义接口：

```typescript
interface CryptoKline {
  exchange: string;
  symbol: string;
  freq: string;
  trade_time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
  is_contract: string;
}

const klines = rows as unknown as CryptoKline[];
```

### 4. 分页与批量策略

Tushare 单次最多返回 **8000 条**。若时间范围大，需要分段请求：

- 按时间窗口切分（如每次请求 7 天）
- 或按返回条数判断是否继续拉取（若无唯一标识，优先按时间切分）

不要在循环中无间隔高频请求，已通过 `TushareClientService` 的限流器控制并发和间隔。

### 5. 目录组织建议

若新增数字货币同步模块，参考 A 股模块结构：

```
apps/server/src/market-data/
├── a-shares/               # 已有 A 股模块
├── crypto/                 # 新增数字货币模块
│   ├── crypto.module.ts
│   ├── crypto.service.ts
│   ├── sync/
│   │   ├── crypto-sync.service.ts
│   │   └── crypto-sync-fetchers.ts
│   └── types/
│       └── crypto.types.ts
```

在 `crypto.module.ts` 中导入 `ASharesModule` 以使用 `TushareClientService`，或将其提升到 `market-data` 公共层。

## 注意事项

- **Token**：通过环境变量 `TUSHARE_TOKEN` 配置，与 A 股共用同一 token。
- **权限**：`coin_bar` 需要 120 积分权限，每分钟 2 次试用；高频调用需赞助开通正式权限。
- **freq 格式**：`1min`, `5min`, `15min`, `30min`, `60min`, `1day`, `1week`，不是 `1m` 或 `D`。
- **时间格式**：`start_date`/`end_date` 使用 `YYYY-MM-DD HH:MM:SS`，不是时间戳。
- **交易所字段**：参数传 `exchange`，返回字段中也有 `exchange`（交易所），注意与 `symbol`（原始代码）区分。
- **is_contract**：`Y` 表示合约，`N` 表示现货。

## 参考文档

详细的 API 参数说明、返回字段、数据样例见 `references/api.md`。
