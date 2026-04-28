# Tushare 数字货币 HTTP API 参考

## 通用 HTTP 调用规范

- **Endpoint**: `http://api.tushare.pro`
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Body 结构**:

```json
{
  "api_name": "coin_bar",
  "token": "your_token_here",
  "params": {
    "exchange": "okex",
    "ts_code": "BTC_USDT",
    "freq": "1min",
    "start_date": "2020-04-01 00:00:01",
    "end_date": "2020-04-04 19:00:00"
  },
  "fields": ""
}
```

### 通用响应结构

```json
{
  "code": 0,
  "msg": null,
  "data": {
    "fields": ["exchange", "symbol", "freq", "trade_time", "open", "close", "high", "low", "vol", "is_contract"],
    "items": [
      ["okex", "BTC_USDT", "1min", "2020-04-21 07:00:00", 6861.7, 6863.5, 6867.9, 6861.1, 301.0, "Y"]
    ]
  }
}
```

- `code`: `0` 表示成功，`2002` 表示权限不足
- `data.fields`: 字段名数组
- `data.items`: 数据行数组，与 `fields` 一一对应

---

## coin_bar — 数字货币 K 线/分钟线

### 描述
获取数字货币 K 线数据，支持 1分钟、5分钟、15分钟、30分钟、60分钟、日线、周线。

### 限量
单次最大 **8000 条**。

### 权限
120 积分，每分钟 2 次试用。正式权限需赞助。

### 输入参数

| 名称 | 类型 | 必选 | 描述 | 示例 |
|------|------|------|------|------|
| `ts_code` | str | 否 | 代码 | `BTC_USDT` |
| `exchange` | str | 否 | 交易所 | `huobi` / `okex` / `binance` 等 |
| `freq` | str | 否 | 频度 | `1min` |
| `is_contract` | str | 否 | 是否合约 | `Y` / `N` |
| `start_date` | datetime | 否 | 开始日期 | `2020-04-01 00:00:01` |
| `end_date` | datetime | 否 | 结束日期 | `2020-04-04 19:00:00` |

### freq 说明

| freq | 说明 |
|------|------|
| `1min` | 1 分钟 |
| `5min` | 5 分钟 |
| `15min` | 15 分钟 |
| `30min` | 30 分钟 |
| `60min` | 60 分钟 |
| `1day` | 日线 |
| `1week` | 周线 |

### 输出参数

| 名称 | 类型 | 默认显示 | 描述 |
|------|------|----------|------|
| `exchange` | str | Y | 交易所 |
| `symbol` | str | Y | 交易所原始代码 |
| `freq` | str | Y | 频度 |
| `trade_time` | str | Y | 交易时间 |
| `open` | float | Y | 开盘价 |
| `close` | float | Y | 收盘价 |
| `high` | float | Y | 最高价 |
| `low` | float | Y | 最低价 |
| `vol` | float | Y | 成交量 |
| `is_contract` | str | Y | 是否合约 (`Y`=是, `N`=否) |

### cURL 示例

```bash
curl -X POST http://api.tushare.pro \
  -H "Content-Type: application/json" \
  -d '{
    "api_name": "coin_bar",
    "token": "xxxxxxxx",
    "params": {
      "exchange": "okex",
      "ts_code": "BTC_USDT",
      "freq": "1min",
      "start_date": "2020-04-01 00:00:01",
      "end_date": "2020-04-22 19:00:00"
    },
    "fields": ""
  }'
```

### TypeScript / NestJS 示例（复用 TushareClientService）

```typescript
import { Injectable } from '@nestjs/common';
import { TushareClientService } from '../../a-shares/services/tushare-client.service';

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

@Injectable()
export class CryptoSyncService {
  constructor(private readonly tushare: TushareClientService) {}

  async fetchKlines(
    exchange: string,
    symbol: string,
    freq: string,
    startDate: string,
    endDate: string,
  ): Promise<CryptoKline[]> {
    const rows = await this.tushare.query('coin_bar', {
      exchange,
      ts_code: symbol,
      freq,
      start_date: startDate,
      end_date: endDate,
    });
    return rows as unknown as CryptoKline[];
  }
}
```

---

## 错误码速查

| code | 含义 |
|------|------|
| `0` | 成功 |
| `2002` | 权限不足，积分不够或未开通接口 |
| 其他 | 见 `msg` 字段说明 |

## 限流与重试提示

- 免费试用：每分钟 2 次
- 超出限流时返回含 `rate`/`limit`/`频率`/`限流`/`稍后` 等关键词的错误信息
- `TushareClientService` 已自动处理：检测到限流时指数退避增加请求间隔，最多重试 3 次
