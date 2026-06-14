# 06 · Loader 多因子装载

改 `portfolio-sim.loader.ts` 的 `loadSourceTrades`(现 `:138-213`)。现状只按单个 `rankField` 做一次
LEFT JOIN;改为按 `rankSpec` 收集所有因子需要的列,注册表驱动多表 JOIN,JS 侧组装 `factorValues`。

## 注册表驱动构建(禁拼前端字段名)

```text
loadSourceTrades(sourceIdx, runId, source):
  factors = resolveRankSpec(source)                      # [{factor,weight,dir}, ...] 或 []
  keys    = factors.map(f => f.factor)                   # 因子 KEY 集
  # 1) 查注册表求需 JOIN 的表 + 需 SELECT 的列(全来自注册表常量,无前端串)
  cols    = keys.flatMap(k => REGISTRY[k].kind==='column'
                                ? [REGISTRY[k].source]
                                : REGISTRY[k].needs)      # {table,schema,column,alias}
  joins   = uniqueTables(cols)                            # 每表按 (ts_code, signal_date) JOIN 一次
  # 2) 参数化 SQL:SELECT t.*, <每列 AS alias>, FROM signal_test_trade t LEFT JOIN ... WHERE run_id=$1
  rows    = query(sql, [runId])
  # 3) JS 组装每行 factorValues
  return rows.map(r => ({
     ...trade 基础字段(tsCode/signalDate/buyDate/exitDate/ret/holdDays)...
     factorValues: buildFactorValues(keys, r),           # column 直取 / computed 调 compute()
     rankValue:    null,                                  # 排序综合分在引擎算,loader 不再预排(见 01/03)
  }))
```

- `uniqueTables`:同一张表(如 `signal_rolling_indicator` 的 pos_60 + close_ma60_ratio + vol_ratio_60)
  **只 JOIN 一次**,SELECT 多列。最多 5 张表(signal_rolling_indicator / raw.daily_indicator /
  raw.daily_basic / raw.daily_quote / ml.scores_daily),按 keys 实际用到的子集 JOIN。
- **所有表名/列名是注册表里的代码常量**,前端只送 KEY;未命中注册表的 KEY 在 service 已 400 拦截,
  loader 再 defensive 跳过 + `logger.warn`(双保险,符合「未命中映射 warn+跳过」规范)。
- 列别名用注册表 alias(如 `mom_close`),`buildFactorValues` 按 alias 取值喂 `compute()`。

## ml_score 去重 JOIN(已核 DB)

`ml.scores_daily` 跨模型下 (trade_date,ts_code) **不唯一**:**2 个 model_version**,`20260515` 两模型并存
(2×5495=10990 行)致重复;**单模型内 (date,ts_code) 唯一**(dup=0)。若直接 LEFT JOIN 会**行数翻倍**
(每命中键 ×2 → trade 重复 → 组合回放重复开仓)。必须**先 pin 单模型再去重**:

```sql
LEFT JOIN (
  SELECT DISTINCT ON (trade_date, ts_code) trade_date, ts_code, score
    FROM ml.scores_daily
   ORDER BY trade_date, ts_code, model_version DESC, rank_in_day ASC   -- pin 每键最新模型
) ml ON ml.ts_code = t.ts_code AND ml.trade_date = t.signal_date
```

- `model_version DESC` → 每键取**最新模型**(20260515 取 0607、20260528 取 0521),单模型内唯一故确定;
  **绝不用 rank_in_day 跨模型混挑**(两模型 rank/score 不可比)。
- 因 ml_score 历史仅 2 天,V10(2022~2026)回测里几乎全 null → 退化;**loader 不报错**,但
  service/前端在选了 ml_score 时已 warn(见 [02-factor-registry.md](./02-factor-registry.md) 的 ml_score 节)。

## momentum_60 三表 JOIN

`momentum_60` 的 needs 跨 `raw.daily_quote`(qfq_close)与 `raw.daily_indicator`(ma60/atr_14):

```text
LEFT JOIN raw.daily_quote     q  ON q.ts_code=t.ts_code AND q.trade_date=t.signal_date   -- mom_close=q.qfq_close
LEFT JOIN raw.daily_indicator i  ON i.ts_code=t.ts_code AND i.trade_date=t.signal_date   -- mom_ma60=i.ma60, mom_atr=i.atr_14
```

- 若 source 同时还选了 `risk_reward`(也在 `raw.daily_indicator`),`daily_indicator` 仍只 JOIN 一次,
  SELECT 合并 `i.ma60, i.atr_14, i.risk_reward_ratio`。
- `compute()` 在 JS 侧算 `(qfq_close-ma60)/atr_14`;任一输入 null 或 atr=0 → 该因子 null。

## factorValues 组装与 null

```text
buildFactorValues(keys, row):
  out = {}
  for k in keys:
    e = REGISTRY[k]
    if e.kind==='column': out[k] = parseNumericString(row[aliasOf(e.source)])    # null→null
    else (computed):      out[k] = e.compute(pick(row, e.needs.map(n=>n.alias)))  # 任一 null→null
  return out
```

- 数值统一过 `parseNumericString`(现 helper):pg numeric 返 string、double 返 number 都吃。
- LEFT JOIN 未命中 / 列 NULL → `null`(排序按 null 殿后,见 [03](./03-engine-ranking.md#null-与平名次处置并列同分))。

## 行情预取不变

`fetchQfqQuotes`/`fetchSseCalendar`/窗口预取(`loader.ts:79-122`)**不动**——盯市行情与因子 JOIN 解耦。
注意:momentum 借用 `raw.daily_quote.qfq_close` 是**在 signal_date 这一行**取值做因子(与盯市的逐日
qfq 行情是两回事),勿混。

## 单测要点

- 单因子 JOIN(pos_120/circ_mv):factorValues 取值正确、缺失置 null(覆盖现有用例,零漂移)。
- 多因子同表合并:signal_rolling_indicator 三列只 JOIN 一次,值正确。
- **ml_score pin 单模型去重**:构造同键跨 model_version 样本,断言 JOIN 后 trade 不翻倍、且取**最新模型**那一行。
- momentum 三表 + compute:已知 close/ma60/atr 手算;atr=0→null。
- 因 mock QueryBuilder 验不出水合(见 database-sql.md 教训),**关键靠真机/集成跑**(见 [09](./09-tasks-and-validation.md))。
