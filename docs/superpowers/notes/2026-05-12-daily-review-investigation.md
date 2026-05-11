# 每日复盘调研笔记（PR-0）

## a_share_daily_quotes

- 表名：`a_share_daily_quotes`（注意复数）
- 涨跌停字段：**不存在 limit_status 列**
- 替代方案：用 pct_chg 近似
  - 主板 (ts_code 6 开头 或 0 开头)：pct_chg >= 9.9 视为涨停，<= -9.9 视为跌停
  - 创业板 (300 开头) / 科创板 (688 开头)：pct_chg >= 19.9 / <= -19.9
- **无 turnover_rate 列**；换手率在 `a_share_daily_metrics` 表（`turnover_rate` 列）
- numeric 列在原生 SQL 中需 `::numeric` 强转，TypeORM 取出来是 string

## money_flow_*

### money_flow_market
- 表名：`money_flow_market`（单数，唯一行 per trade_date）
- 关键字段：`net_amount`（**非** `main_net_amount`），`buy_lg_amount`，`buy_sm_amount`
- 金额单位：待确认（疑为万元，来源 Tushare moneyflow_hsgt 类接口）

### money_flow_industries
- 表名：`money_flow_industries`（**复数**，计划中用 `money_flow_industry` 是错误的）
- 关键字段：`industry`（**非** `name`），`pct_change`，`net_amount`
- **无 leader_name 字段**；聚合时不显示龙头股
- 唯一键：(ts_code, trade_date)；ORDER BY `pct_change::numeric DESC LIMIT 10`

### money_flow_sectors
- 表名：`money_flow_sectors`（**复数**，计划中用 `money_flow_sector` 是错误的）
- 关键字段：`name`（实体 property 名 `sector`，但列名是 `name`），`pct_change`，`net_amount`
- **无 leader_name 字段**
- 唯一键：(ts_code, trade_date)

### money_flow_stocks
- 表名：`money_flow_stocks`（**复数**，计划中用 `money_flow_stock` 是错误的）
- 关键字段：`name`，`pct_change`，`net_amount`（**非** `main_net_amount`）
- **无 turnover_rate 字段**
- TOP 净买入：`ORDER BY net_amount::numeric DESC LIMIT 20`
- TOP 净卖出：`ORDER BY net_amount::numeric ASC LIMIT 20`

## a_share_symbols

- 表名：`a_share_symbols`（**非** `symbol`，计划中 JOIN 需修正）
- 关键字段：`ts_code`（PK），`name`，`market`，`list_status`
- ST 过滤：`s.name NOT ILIKE '%ST%'`

## a_share_daily_metrics

- 表名：`a_share_daily_metrics`
- 有 `turnover_rate` 列（numeric）
- aggregateStrongAndVolume 需 JOIN 此表获取换手率

## Tushare index_daily

- 接口名（与文档一致）：`index_daily`
- 积分门槛：2000 分（当前 7000 分，可用）
- 入参：`ts_code`（必填），`trade_date`，`start_date`，`end_date`
- 返回字段：`ts_code`，`trade_date`，`close`，`open`，`high`，`low`，`pre_close`，`change`，`pct_chg`，`vol`，`amount`
- 金额单位：千元
- 单次返回上限：8000 行
- 4 个 ts_code 对照：
  - 上证 `000001.SH`
  - 深证 `399001.SZ`
  - 创业板 `399006.SZ`
  - 科创50 `000688.SH`

## Tushare 凭证与客户端封装

- Token env 变量：`TUSHARE_TOKEN`
- 封装类：`TushareClientService`（路径 `apps/server/src/market-data/a-shares/services/tushare-client.service.ts`）
- 调用方式：`tushare.query(apiName, params, fields)` 返回 `TushareRow[]`（**非** `.items` 包装）
- **TushareClientService 未从 ASharesModule 导出**
  - 复用方案：在 DailyReviewModule 的 providers 中直接注册 `TushareClientService`（其只依赖 `ConfigService`，全局可用）

## DeepSeek 思考模式（PR-3 编码前确认）

- 模型名：`deepseek-v4-pro`
- base_url：`https://api.deepseek.com`
- `reasoning_effort`：在请求顶层传，**不**放 extra_body（`reasoning_effort: "high"`）
- `extra_body` 参数结构：`{ thinking: { type: 'enabled' } }`
- 流式 chunk 字段：`delta.reasoning_content` / `delta.content`
- 单轮无 tools，reasoning_content 不需要回传后续请求
- 禁用参数：`temperature` / `top_p` / `presence_penalty` / `frequency_penalty`
- 超时建议：240000ms

## AdminOnly 装饰器

- 路径：`apps/server/src/auth/decorators/admin-only.decorator.ts`
- 用法：`@AdminOnly()`（配合全局 AuthGuard + metadata 检查）
