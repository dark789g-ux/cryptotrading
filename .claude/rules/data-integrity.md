# 数据完整性 & 第三方 API

## 接口名称必须以官方文档为准

**禁止**凭变量名、注释或历史代码推断接口名称。

- Tushare 相关问题在调用前必触发 `tushare-sync-dev` skill 查文档
- DeepSeek 相关代码触发 `deepseek-api` skill

## 进硬断言/硬编码的事实必须落源头验证（含子代理报告）

凡要写进 **fail-fast 断言、硬编码常量、migration、SQL join 键** 的具体事实——列名 / 字段后缀 / 表名 / 接口名——必须落到**权威源头**核对（实体定义、官方文档、真 DB 一条样本），**禁止采信任何二手转述**：

- 子代理 / 摸底报告里的"字段叫 X""后缀是 Y""表名是 Z" —— 转述可能看错或过时，进硬断言前**自己 `grep` 实体 / 查真 DB 一条**再写。
- 变量名、注释、邻近代码、历史实现 —— 同样禁止据此推断（与本文件首条同源）。

**教训**：本会话摸底子代理报"行业指数后缀 `.THS`、指标表 `a_share_daily_indicators`"，未验证就写进 spec 的 fail-fast 断言——真值是 `.TI`、表已改名 `raw.daily_indicator`，那条断言会**误杀全部正常数据**，靠独立自审 + 亲查 DB 才纠正。**agent 报告 = 二手信息，与"历史代码推断"同级，不得直接进硬断言。**

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
