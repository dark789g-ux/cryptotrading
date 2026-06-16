# 07 · 测试与验证标准

> 「证据先于断言」（`verification-before-completion`）。下列各层都要有，e2e 真机为最终铁证。

## 1. pytest（`apps/quant-pipeline`）

| 测试 | 覆盖 |
|---|---|
| **公式 parity（核心）** | amv-formula.ts 中 **6 个 export 函数** `td_sma/td_ema/calc_macd/calc_amv_series/calc_zdf/calc_signal` 各喂 checked-in golden fixture（由 TS 跑出），逐元素 `approx(rel=1e-9)`。`ma5`（未 export，不可单测）经 `calc_amv_series` 端到端间接覆盖。含 NaN/边界/`v3≤0`/`amv_close≤0` 用例。 |
| Σ 聚合 | 构造多 ticker × 多日 `us_daily_quote` 假数据，验 `SUM(close*volume)` + `member_count` 正确；NULL close/volume 被排除。 |
| 空数据双路径 | 成分取数 `empty_path∈{data_null,items_empty,window_empty}` → 进 failed_items(rule=`us_daily_empty`)；`factor_empty` **不**计 AMV 失败。 |
| warmup 口径 | 同一终点、不同起点（全量 vs 近窗 +150 **交易行** warmup，按 `.NDX` 表取）算出的 `[start,end]` 段**全列** `amv_close` **与 amv_dif/dea/macd/signal** 一致（`rel≤1e-6`）。**必须验 MACD 列**——慢线 EMA(26) 衰减比 td_sma 慢，只验 amv_close 会漏掉 MACD 在两种跑法下的种子残差（见 [04 §3](./04-python-pipeline.md#3-warmup递归指标必须否则增量窗口口径漂移)）。 |
| **不 ×1000** | 断言 `us_index_amv.py` 传给 `calc_amv_series` 的 volume 即 `Σ(close*volume)`，未额外 ×1000（防误抄 A 股口径）。 |
| seed | `seed_us_index_constituent_from_csv` upsert 101 行、幂等（重跑不增行）。 |

**golden fixture 生成**：一次性用 TS `calcAmvSeries`/`calcMacd` 等对固定输入跑出期望值，JSON 落
`tests/fixtures/amv_parity_golden.json`，checked-in。pytest 读它对拍 Python 实现。

## 2. jest（`apps/server`）

| 测试 | 覆盖 |
|---|---|
| `getSeries` | mock `dataSource.query` 返回行，验 SELECT 别名水合出 `AmvSeriesRow` 全字段（**不靠 QueryBuilder.select**）；`asNullableNumber` 把 null 列转 null。 |
| `getDateRange` | 空表 → `{start:null,end:null}`。 |
| `sync` 派 job | 验 `quantJobs.create` 收到 `runType:'us_index_amv_sync'`、`date_range` 为冒号串、`priority:100/maxAttempts:1`。 |
| controller 校验 | `index_code` 缺 / 日期非 8 位 → `BadRequestException`。 |

> ⚠️ 单测 mock 验不出 run_type **DB CHECK**（jest mock create() 不打真库）——只能靠真机 POST 派 job
> 暴露（`reference_run_type_check_constraint`）。故 e2e 必跑真派 job。

## 3. 前端（`apps/web`）

- vitest：`mergeKlineWithAmv` 对美股指数 `KlineChartBar`（`open_time='YYYY-MM-DD'`）+ AMV
  （`tradeDate='YYYYMMDD'`）能命中（normalizeDateKey 对齐）；`usIndexAmvApi` URL 拼装。
- **`pnpm --filter @cryptotrading/web build`（vite）必过**（type-check 查不出 SFC 编译错）。

## 4. 真机 e2e（最终铁证，独立浏览器驱动）

前置：跑两张表 migration（`.ps1`）+ alembic upgrade（run_type）+ **重启后端**（新路由 / run_type 生效）。

1. **seed 成分**：`uv run quant us-index-constituent seed --csv data/us_index_constituent_ndx.csv` →
   验 `raw.us_index_constituent` 101 行。
2. **首灌 AMV**：`uv run quant us-index-amv-sync --date-range 20240101:<today>`（CLI 直跑，不写 ml.jobs）→
   验 `raw.us_daily_quote` 含 101 成分、`raw.us_index_amv_daily` 有行、`member_count` 近期满 101、
   `amv_close` 非死值。
3. **UI 同步派 job**：美股指数面板「同步」按钮 → POST `/api/us-index-amv/sync` 真派
   `us_index_amv_sync` job（**验不撞 DB CHECK 500**）→ SSE / 轮询进度走完。
4. **副图渲染**：美股 Tab → 美股指数二级 tab → K 线出现 `0AMV` + `0AMV_MACD` 两副图，数值非空；
   切 tab resize 不错位（懒 tab-pane onMounted 已处理）。
5. **零污染回归**：美股个股 Tab 仍只显示原 62 只策划股（80 只填充成分不出现）。
6. 验完恢复：若改了副图 / 列偏好，恢复默认（持久化状态不留脚印）。

## 5. 数据集完整性最弱标准（`.claude/rules/data-integrity.md`）

- 行级硬约束：写入 `us_index_amv_daily` 的非异常日，`amv_close` 非空、`signal∈{-1,0,1}`。
- 跨表对齐：`us_index_amv_daily` 某日存在 ⇒ 该日 `us_daily_quote` 有 ≥1 成分且 `us_index_daily(.NDX)` 有点位。
- 全成分取数失败致某日无 Σ → 不写该日 + 记 errors（禁伪装成功）。
