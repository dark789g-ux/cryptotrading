# Code Review：`quality/` 质量检查子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/quality/`
> 涉及文件：`runner.py` `monitor.py` `checks_row.py` `checks_value.py` `pit_audit.py` `psi_utils.py` `report.py`
> 评审重点：检查逻辑正确性、检查是否会漏报、数据完整性、性能。
> 使用方式：新会话打开本文。问题 1-3 叠加会使整个交易日数据缺失骗过门禁，应最先修。

## 🔴 严重

### 1. `runner.py:84-107` — 内部检查异常时 strict=False 直接吞错，留痕条目还顶替成 `passed=True`
当 `strict=False` 且某条 check 抛异常（DB 连接断、SQL 报错），代码把它包成 `CheckResult(passed=True, level="info", rule="duplicate_pk")` 占位。后果：
- `duplicate_pk` 检查实际崩溃了，runner 当成「通过」。
- critical 检查的失败被静默掉，`critical_count` 不增加，`passed` 仍为 True。
- 占位 rule 写成 `"duplicate_pk"` 与真实检查名混淆，日志/审计无法区分。

一次检查崩溃就让整个质量门禁失效。这正是 CLAUDE.md 强调的「伪装成功」。
**修复**：内部异常应产出 `passed=False, level="critical"` 的真实失败结果，或无条件 raise。检查执行失败必须等同于不通过。

### 2. `checks_value.py:519-535` — `cross_table_alignment` 在基础表当日 0 行时无条件判通过
`SELECT (子查询), (子查询), ...` 不带 `FROM`，在 PG 中永远返回恰好一行，故 `row is None`（511 行）是死代码。当 `raw.daily_quote` 当日 0 行时 `base_rows == 0`（527 行）直接 `passed=True` 跳过。某交易日 raw 根本没同步时，`training_pregate` 会判绿放行。
**修复**：`base_rows==0` 不应无条件 `passed=True`。门禁场景应区分「非交易日（合法空）」与「交易日漏同步（非法空）」，至少交叉 `raw.trade_cal` 确认。

### 3. `checks_value.py:27-99` — `null_violation` 在表当日 0 行时静默判「通过」（最严重漏报）
对每个 `(table, col)` 跑 `WHERE trade_date=:d AND col IS NULL`。若当日该表一行都没有，查询返回 0 行 → 无 violation → `passed=True`。`raw.daily_quote` 当日完全没同步 → `null_violation` 判绿 → `training_pregate`/`inference_pregate` 放行。CLAUDE.md 的「行级硬约束」前提是「该表当日有数据」。
**修复**：`null_violation` 必须先断言 `count(*) > 0`（对照 `trade_cal` 确认是交易日），0 行应判 `critical`。

### 4. `pit_audit.py:397-405` — `audit_ghost3_fina_delay` 泄漏判定区间用错，几乎抓不到泄漏
注释说「验证 `factor_value(T) only uses fina ann_date <= T`」，但 SQL 是 `WHERE trade_date >= :end_d AND trade_date < :ann_d`，只检查 `[end_date, ann_date)` 窗口内是否有 `fin_` 因子。问题：
- 真正泄漏窗口应是 `(-∞, ann_date)`，在 `end_date` 之前用该期数据同样是泄漏，被漏掉。
- 更根本：`factors.daily_factors` 里 `fin_` 因子行不带「用的是哪期财报」信息。而因子天天算，任意有 `fin_` 因子的股票只要区间有交易日就**必然报 warn**——既海量假阳，又对真泄漏无分辨力。这个审计实质失效。
**修复**：PIT 财务泄漏审计必须能把因子值回溯到所用财报期（因子表记录 `source_ann_date`，或独立重算比对）。当前实现应标注「未实现」而非给出误导性结论。

### 5. `pit_audit.py:243-352` — `audit_ghost2_adj_trap` 复权陷阱审计逻辑站不住
检查 `close_adj` 因子在分红日相对前一日跳变 >20% 即报 critical。但：
- 后复权价分红日本就可能合法跳变 >20%（涨跌停 ±10%/±20% 叠加真实变动），产生假阳性 critical 阻断门禁。
- 若因子根本没做复权，小额分红除权缺口可能仅 1-2%，真 bug 反而漏报。
- `ratio` 阈值 0.8/1.2 是拍脑袋常数，无理论依据。
**修复**：复权正确性审计应独立用 `adj_factor` 重算后复权价并与因子落库值比对，而非用「跳变幅度」这个既假阳又假阴的代理。

### 6. `monitor.py:138-155` — `_load_train_scores_sample` 用历史 `scores_daily` 当训练分布且包含当日，PSI 自我比较失真
`SELECT ... FROM ml.scores_daily WHERE model_version=:mv ORDER BY trade_date DESC LIMIT 5000` **没有 `trade_date < :td` 过滤**，当日 scores 也在这 5000 条里。`_check_score_distribution_drift` 用它当 `train_scores` 与当日 `curr_scores` 比 PSI，当日数据同时进基准与当前，PSI 被系统性压低，漂移漏报。且它根本不是训练期 OOS 分布，而是近期推理输出。
**修复**：至少加 `trade_date < :td`；真要对训练分布，应从 `ml.model_runs` 存的 OOS scores 取。

## 🟡 中等

### 7. `monitor.py:88-135` — `_check_ic_drop` 对负 IC 模型失效
IC 漂移判定 `rolling_ic < train_ic * 0.5`。当 `train_ic` 为负时 `train_ic*0.5` 比 `train_ic` 大，判据反而更难触发。
**修复**：改用 `abs()`，或明确约定 IC 恒正。

### 8. `checks_row.py:34-68` — `row_count_drift` 用 `count(DISTINCT ts_code)`，无法发现「某些股票当日缺行」
若当日股票总数没变但发生「A 股缺、B 股重复」，count 不变，漂移检查判绿。只能抓总量级偏移，抓不到结构性缺失。
**修复**：补一条与 `raw.trade_cal` / 上市股票数对齐的检查。

### 9. `checks_value.py:106-160` — `extreme_value` 的 μ/σ 与离群同批数据计算，极值自我稀释
极端污染值自身把 σ 抬高，导致 `Nσ` 边界变宽，极值反而落界内被漏报（掩蔽效应）。
**修复**：用 MAD 或分位数（robust）做离群边界。

### 10. `pit_audit.py:67-140` — 铁律 2 用正则静态扫描源码，极脆弱
`_BASE_PIT_FIELD_RE` 匹配 `pit_window_days = 数字`，任何写法偏差（值来自常量/配置、多行赋值）都会匹配失败误报「未声明」。base.py 不存在时返回 `passed=True`，铁律 2 在 base.py 缺失时等于没检查。
**修复**：改为 import 该类读取实际属性值。

### 11. `pit_audit.py:147-221` — `verify_factor_window_no_future` 字符串比较日期有隐患
`used_dates` 经 `str(d)` 转换，若 `historical_data` 的 `trade_date` 是 `datetime`/`Timestamp`，`str()` 得到 `'2026-05-22 00:00:00'`，与入参 `'20260522'` 格式不同，字符串比较无意义。
**修复**：统一归一化为 `YYYYMMDD` 再比。

### 12. `checks_value.py:566` / `monitor.py:529` — 超 500 行硬约束
`checks_value.py` 566 行可按 PIT 类与值域类拆分；`monitor.py` 529 行的 DB loader 段（54-215 行）可抽到 `monitor_loaders.py`。

### 13. `monitor.py:54-215` — 每个 loader 各自 `with session_scope()`，一次 monitor 开 7 个独立事务
连接获取+事务开销重，且彼此读到不同时刻快照（不一致读）。
**修复**：复用单个 session 贯穿整个 monitor。

### 14. `pit_audit.py:260-276` — `audit_ghost2_adj_trap` 候选 SQL 全表 `LAG` + `ORDER BY random()`
对 `raw.adj_factor`（百万行级）全表做窗口函数再全表排序，仅为抽几十行。
**修复**：先按时间范围/随机 ts_code 缩小集合再做 LAG。

## 🟢 建议

- **15.** `runner.py:71-80` 阈值放宽留痕只认 `row_count_drift_threshold`，`adj_jump_ratio_threshold`/`extreme_sigma` 等放宽无记录。
- **16.** `psi_utils.py:36-42` `compute_psi` 用 train 分位切箱，train 重复值多时 edges 塌成 3-4 个，`edges.size < 3` 直接返回 NaN→不写 quality_reports，「无法计算」被当成「无漂移」静默跳过。建议无法计算时产出 info 级留痕。
- **17.** `psi_utils.py:56-57` `float(edges[i]) if np.isfinite(...) else float(edges[i])` 两分支完全相同，是笔误。`±inf` 写进 jsonb 是非法 JSON，应替换为 `None` 或字符串。
- **18.** `checks_value.py:175` `extreme_value` 的 `extras` 列出所有离群 factor，无截断，大面积漂移可能上百条塞进 jsonb。建议同其它 check 加 `LIMIT`。
- **19.** `monitor.py:404-412` `monitor_no_scores_today` 仅 `logger.warning` 后返回正常 dict，job 视为成功。若推理本应产出 scores 却没有，应结合上游推理 job 状态判断是否报 critical。

## 总评

质量子系统骨架完整、规则名/detail 严格对齐 schema，但**多个核心检查在「表当日为空」时静默判通过**（`null_violation`、`cross_table_alignment`），`runner` 又把崩溃的检查伪装成 `passed=True`——三处叠加，使整个交易日数据缺失能完全骗过 training/inference 门禁，与 CLAUDE.md「数据完整性」硬约束直接冲突。PIT 审计中的复权陷阱与财务延迟两项（ghost2/ghost3）因缺乏「因子值→财报期/复权源」的可追溯信息，实质既假阳又假阴、不具审计效力，应明确标注未实现而非给出误导性结论。
