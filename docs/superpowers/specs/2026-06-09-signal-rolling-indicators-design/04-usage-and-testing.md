# 04 · 用法、测试与 rollout

## A. 用户怎么建 test（OR 与板块靠"多建几个 test"覆盖）

模板信号 = `涨停 AND (底部三选一) AND (天量二选一)`。把 OR 分配律展开 = **底部3 × 天量2 = 6 个纯 AND 分支**，
其并集 = 模板完整信号。用户在创建表单里用新字段 + 已有 `pct_chg` 逐个建（按需取舍，不必全建）：

| # | 底部条件 | 天量条件 | 涨停条件 |
|---|----------|----------|----------|
| 1 | `pos_120 < 0.25` | `vol_ratio_60 > 2` | `pct_chg >= 9.5` |
| 2 | `pos_120 < 0.25` | `vol_ratio_120 > 2` | `pct_chg >= 9.5` |
| 3 | `pos_60 < 0.20` | `vol_ratio_60 > 2` | `pct_chg >= 9.5` |
| 4 | `pos_60 < 0.20` | `vol_ratio_120 > 2` | `pct_chg >= 9.5` |
| 5 | `close_ma60_ratio < 0.9` | `vol_ratio_60 > 2` | `pct_chg >= 9.5` |
| 6 | `close_ma60_ratio < 0.9` | `vol_ratio_120 > 2` | `pct_chg >= 9.5` |

出场设 `fixed_n`、`horizon_n=1`（= 模板"次日开盘买当日收盘卖"）。

**板块差异**：上表是主板（`pct_chg>=9.5`）。创业板 / 科创板把阈值改 `pct_chg>=19.5`，
并把标的池 `universe` 设为对应板块的 `tsCodes` 列表（300/301/.SZ、688/.SH）。即"同条件、换阈值、换标的池"再建一组。

> 注：不同分支会有重叠信号（同一 (T,ts_code) 命中多个分支）。用户若要"并集口径的总胜率"，
> 需自行对各 test 的逐笔去重；本设计不提供跨 test 合并（超出交付边界）。

## B. 真机平价测试（硬证据，对标 CLAUDE.md"落源头验证"）

证明"确实复刻了模板"，而非自说自话：

1. 选 3~5 只票 + 一段区间（含一只窗口内**有除权除息**的、一只**无**的）。
2. **指标值平价**：把这些票的 **qfq OHLC** 喂给模板脚本（或改模板读 qfq），逐日 diff
   `pos_120/pos_60/close_ma60_ratio/vol_ratio_60/vol_ratio_120` 与 `signal_rolling_indicator` 落库值
   （容差 1e-6）。**无除权除息的票**用原始价喂模板也应一致；**有除权除息的票**必须喂 qfq 才对得上
   （这正是"qfq vs 原始价"口径差异的体现，预期且可解释）。
3. **信号集平价**：用上表某分支建 test 跑枚举，与模板在该票上的对应分支信号日逐一比对。
   差异应只来自已知偏差（一字涨停过滤 / len<130 vs min_periods）——逐条归因，不留"不明差异"。

## C. 单元测试

| 测试 | covers |
|------|--------|
| 回填窗口 SQL 纯逻辑（构造小样本表 → 跑 SQL → 断言值） | min_periods 门控（满 N 才有值、不满为 NULL）、`+1e-10`/`+1` epsilon、qfq 取列正确 |
| `recalculateDirtyForSymbols` 范围计算 | 从 dirty_from 向前取 120 bar 热身、`trade_date >= dirty_from` upsert、清脏列 |
| `ASHARE_FIELD_COL_MAP` 含 5 新字段 → `buildAShareQuery` 生成 `d.pos_120 < $n` 等正确 WHERE | 字段映射 + 算子拼接 |
| 枚举器 / 实时扫描器 SQL 含 `LEFT JOIN signal_rolling_indicator d` | 两处 join 都在 |

> DB 字段水合 / join 是否真命中**靠真机/集成验证**（mock QueryBuilder 单测验不出，项目历史坑）。

## D. Rollout 顺序

```text
1. migration：建表 + a_share_sync_states 加 signal_rolling_dirty_from_date 列（跑 .ps1）
2. 实体双注册（module forFeature + app.module 根 entities）→ 重启后端确认无 EntityMetadataNotFound
3. 新 service/controller/module + 全量回填 POST /api/signal-rolling-indicator/backfill（铺底，耗时长）
4. 字段映射 + 两处 FROM join（后端）；前端 ConditionRows.vue 加 5 字段
5. 同步链挂增量重算（a-shares-sync.service.ts:234 后）+ 改 dirty-ranges 写新脏列
6. 重启后端（dev 无 watch，新路由/改动须重启才生效）
7. 真机：建 1 个分支 test 跑通 → 平价测试 → 全 6 分支
```

**风险点**：
- 全量回填耗时与库压力大 → 必须按 ts_code 分批 + 进度可见；可先小批验证 SQL 正确再全量。
- qfq 脏列改动触及核心同步链 `a-shares-sync-dirty-ranges.ts` → 改 `ON CONFLICT` 子句须保证不影响
  现有 `qfq_dirty`/`indicator_dirty` 清写逻辑，配单测 + 真机同步一轮验证。
- 后端 dev 无热加载，端到端前先确认跑的是最新代码（否则撞新路由 404 / 行为仍旧的假象）。

## E. 验证标准（Definition of Done）

1. migration 跑通，`signal_rolling_indicator` 表 + `a_share_sync_states.signal_rolling_dirty_from_date` 列存在。
2. 全量回填完成，抽样行 5 字段值与模板（qfq 口径）平价通过。
3. 5 字段在前端条件编辑器可选，建 AND test 能跑出胜率 / 盈亏比 / 直方图 / 逐笔。
4. 跑一轮 A股增量同步后，新交易日的 `signal_rolling_indicator` 行自动出现且值正确；
   构造一次 qfq 回算，验证受影响区间被重算（脏列设→清闭环）。
5. 后端单测 + 前端 type-check + `lint:quant-lines` 全绿。
