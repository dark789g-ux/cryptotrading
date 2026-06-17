# 04 同步窗口正确性：全量抓取 / 只写所选窗口 / 封顶在长 bar

[← index](./index.md)

源于 2026-06-17 AMD 06-16 事故（盘中同步抓到在长半根 + 短窗口重算把指标 warmup 算坏）。两条硬约束，对**三条抓取路径**统一生效。

## 两条硬约束

```text
用户选 [user_start, user_end]
        │
   ┌────┴─────────────────────────────────────────────┐
   │ 约束A：end 封顶                                    │
   │   capped_end = cap_to_last_closed_session(user_end)│
   │   丢弃「美东当日且未收盘」的在长 bar               │
   ├───────────────────────────────────────────────────┤
   │ 约束B：全量抓取、只写所选窗口                       │
   │   fetch 窗口 = [20240102, capped_end]   ← warmup 恒满 │
   │   指标在 fetch 全序列上算                           │
   │   upsert 只写 trade_date ∈ [user_start, capped_end] │
   └───────────────────────────────────────────────────┘
```

### 约束B 为何「全量抓取」而非「start 往前推 N 交易日」

设计期评估：固定 `fetch_start=20240102`（美股保留起点，min trade_date 实测 20240102 ✅已核）比「user_start 往前推 ~250 交易日」**更简更正确**——无需交易日历算术、warmup 恒满（ma240 等长周期一定够）；抓取成本与一次全量重灌相同（62 tracked + ~100 成分，实测 ~2-3 分钟，可接受）。**写库仍只动 `[user_start, capped_end]`**，不碰更早历史行（否则会用截断 warmup 把旧值算坏——2026-06-17 重灌实证：2026 全窗口指标逐位复现、仅所选日变动）。

> 即：日期选择器决定**写库窗口**；抓取/算指标恒用全史。用户心智模型「更新这段日期」成立，旧历史零扰动。

## `write_start` 参数契约（新增到三条路径）

三个 `sync_us_*_for_*` 函数加一个可选形参 `write_start: str | None = None`（默认 `None` = 等于 fetch 的 start，**保持现有 CLI / 单 job us_sync 行为完全不变**）：

```text
sync_us_daily_for_ticker(ticker, start_date, end_date, client, write_start=None)
sync_us_index_for_symbol(index_code, start_date, end_date, client, write_start=None)
us_index_amv 写入路径（按 write_start 限制 AMV 写入窗口）
```

实现要点（以 `sync_us_daily_for_ticker` 为锚，us_daily.py ✅已核）：

1. 抓取 `[start_date, end_date]`（= `[20240102, capped_end]`）—— 不变。
2. **指标/qfq/因子在全序列上计算** —— 不变（现有逻辑在 filter 后的全窗口上算，us_daily.py 计算段）。
3. **upsert 前，对三段 upsert 各自的 rows 列表都按 `trade_date >= effective_write_start` 切片**（`effective_write_start = write_start or start_date`）：
   - us_daily.py 有**三段独立 upsert**：`quote_rows`（构造 L116-141 ✅已核）、`factor_rows`（L147-156 ✅已核）、`indic_rows`（L165-176 ✅已核），各自 `for i in range(n)` 构造。切片**必须三段都切**，漏切 factor/indicator 会让早期历史行被无谓重写（甚至用截断 warmup 覆盖）。
   - 注意 `pre_close`(L78)/`pct_chg`(L79)/`qfq_pre_close`(L111) 依赖 `.shift(1)`（前一行）：必须**在全序列上算完指标后再切片**（不能先切片再算，否则窗口首行 pre_close 丢成 NaN）。✅ 审阅已核此风险被本要求规避。

`run_us_sync` / `run_us_index_sync` / `run_us_index_amv_sync` 各加 `write_start` 形参，透传给对应 `sync_us_*_for_*`。

## 约束A：end-cap helper（丢在长 bar）

新增 `cap_to_last_closed_session(user_end: str) -> str`（放 `sync/` 下新文件或内联编排器）：

```text
now_et = 现在时间换算到 America/New_York（用 zoneinfo，自动处理 DST）
今日是否「未收盘」= now_et 的日期是交易日 且 now_et.time() < 16:00 ET（收盘，留小缓冲如 16:05）
若 user_end >= now_et.date():
    若今日未收盘 → capped_end = 今日前一日（自然日 -1；周末/节假日由「Yahoo 无该日 bar」自然吸收）
    否则        → capped_end = min(user_end, now_et.date())
否则 capped_end = user_end
```

**双保险**（更鲁棒，覆盖「刚收盘 Yahoo 仍在结算」与节假日）：抓取返回后，**额外丢弃 trade_date == now_et 当日 且 今日未收盘**的那一行（即使 capped_end 没算准也兜住）。这与 yahoo_client 现有「占位行剔除」同层（us_daily.py:71-73 ✅已核剔除 null close 行的位置），可在同处加一条「丢在长当日 bar」。

> Yahoo「末尾 bar 成交量盘中闪烁」（2026-06-17 SPCX 0↔195M）属 Yahoo 侧刚收盘结算抖动：约束A 丢在长当日已避开主要问题；残留极少数票收盘后短时不稳，由「建议收盘后再同步」覆盖，不在本机制强保。

## 三条路径覆盖确认

| 步骤 | 抓取函数 | 加 write_start | end-cap |
|---|---|---|---|
| step1 个股 | `sync_us_daily_for_ticker`（us_daily.py:58 ✅已核） | ✅ | ✅ |
| step2 指数日线 | `sync_us_index_for_symbol`（us_index.py） | ✅ | ✅ |
| step3 指数 AMV | 成分复用 `sync_us_daily_for_ticker` + AMV 聚合写入（us_index_amv.py） | ✅（成分抓取 + AMV 写窗口） | ✅ |

> step3 的 AMV 聚合：成分行情已按全史抓取入 `us_daily_quote`，AMV 在全史上算指标（amv_dif/dea/macd 需 warmup），**只写 `[user_start, capped_end]` 的 AMV 行**。

## 验证（要点，详见 07）

- 单测：给短窗口 `[recent, recent]`，断言写入行的 `trade_date` 均 ≥ user_start、且这些行的 ma240/macd 与「全史一次性算」一致（warmup 正确）。
- 单测：mock now_et 在「今日盘中」，断言 capped_end 不含今日、写入无今日行。
- 真机：对拍 Yahoo 宽窗口 settled 值（核查须用宽窗口，narrow 窗口会与被污染 DB 一起返回末尾 bar 异常——见 [reference_us_sync_intraday_partial_bar 教训]）。
