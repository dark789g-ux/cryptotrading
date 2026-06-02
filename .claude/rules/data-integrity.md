# 数据完整性 & 第三方 API

## 接口名称必须以官方文档为准

**禁止**凭变量名、注释或历史代码推断接口名称。

- Tushare 相关问题在调用前必触发 `tushare-sync-dev` skill 查文档
- DeepSeek 相关代码触发 `deepseek-api` skill

## 外部服务返回空数据必须双路径 warn

`logger.warn` 必须覆盖两条独立路径：
- `payload.data === null`
- `payload.data.items.length === 0`

附带 apiName + 完整 params。

**教训**：曾因只 warn 了 `data=null` 让 Tushare 当日未发布数据伪装成"同步完成"。

## 同步任务 fetcher 返回 0 行必须显式 failedItems

除 `.catch(()=>[])` 外，"code=0 + 0 行" 是另一种伪装成功。orchestrator **不得**当作"已同步"。

fetcher 返回空时 push 到响应体 `errors`/`failedItems`：
- apiName 标 `xxx_empty`（例 `daily_empty`/`adj_factor_empty`/`no_open_trade_dates`）

## 禁止 `.catch(() => [])` 静默吞错

同步任务中，错误必须在响应体 `errors` 字段透出，并在日志打印具体 API 名称与错误。

## 调试第三方 API 返回空的顺序

1. 查官方文档确认接口名/参数
2. 加日志看真实响应
3. 才读内部实现

**禁止**跳前两步直接猜。

## 数据集完整性最弱可接受标准

1. **行级硬约束**：所有业务上不允许 NULL 的列在该日**每一行**都非空
   - 例：daily 的 OHLC、adj_factor 的 `adj_factor`
   - 合法 NULL 列（亏损股 PE/PB、停牌股 turnover_rate）不进硬约束
2. **跨表行数对齐**：派生数据集当日行数 `>=` 基础数据集

**教训**："至少一行非空"是无意义最弱约束，曾让 A 股增量同步在数据残缺时仍判完整、跳过补齐。
