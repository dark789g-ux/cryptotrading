# 02 · Phase 1 研究协议

## 引擎选型

**方案 A：纯 TS 引擎**——宽锚点真机 run（signal-stats 模块）× 离线 SQL 切片。

理由：①"奔自动化"反推的硬约束是**终选策略必须能在 TS 生产系统原样执行**，
A 路径上每个产出天然合规；② TS `strategy` 出场模式本就支持任意卖出条件组合，
开放性够用；③ signal-stats 刚完成提速且 40 万样本 e2e 跑通过；④ 出场独立于
入场过滤——锚点成交的子集 `ret` 不变，一个宽 run 服务该出场配置下**全部**
入场变体 × 全部象限，入场开放搜索零边际成本。

**后备路径（C，触发条件明确才启动）**：仅当第一轮结果显示 trailing 类出场对
参数敏感、且现有 max_hold 档位明显不优时，用 Python kelly_sweep harness 密化
连续参数，并把胜出参数反向落进 TS（给 trailing_lock 开参数）。启动前必须先
核齐 Python/TS 出场语义同构（`z` 参数定义已知存疑）。

## 宽锚点 run 设计

### 入场族（entry family）

每族一个"身份核心"做锚点，其余条件全部松绑为候选过滤字段：

```text
入场族          锚点身份核心                  阈值可扫范围(离线)              预估全窗口样本
──────────────────────────────────────────────────────────────────────────────────
A 搬砖突破      brick_xg≥1 + brick_delta>0.5   delta ∈ {0.5,0.66,0.8,1.0,      待 count 预检
                                                1.2,1.5,2.0} 向上收紧扫
B 超跌反抽      kdj_j < 10                     J ∈ {10,0,-5,-10,-15} 向下收紧扫  待 count 预检(>55万,
                                                                                超限按 J<5→J<0 收)
```

- 窗口统一 **20220401–20260531**（与既有基线可比）；标的池与 04L2 方案
  （test `82f8eb52-…745b`）一致，建 run 时复制其配置。
- 锚点 run **不带任何 oamv 条件**——象限切分全在离线做。
- 框架开放加族：后续新原型（均线粘合、放量突破等）加一行身份核心即可复用
  全流程；**第一轮固定就这两族**。
- 族内核心阈值收紧（如 delta>0.8、J<-10）是该族的普通候选过滤器；**宽于锚点
  核心的档位离线补不回来**，如确需考察须单独建 run 并照实标注。

### count 预检（建 run 前必做）

用与 enumerator 同口径的离线 SQL（主锚 `raw.daily_indicator`，条件含身份核心）
数全窗口信号量。规则：

- 单族全窗口 > 100 万 → 按序收紧：族 A 先 delta 回 0.6、再补 `ma30>ma60`；
  族 B 按 J<10 → J<5 → J<0。收到 ≤100 万为止，收紧动作记入研究日志。
- 同时执行 04 文档核查点 2（大样本聚合栈溢出是否已修）后才允许建首个 run。

### 第一轮出场配置（每个 × 每族 = 一个 run，共 2×9=18 个）

| # | exit_mode | 参数 |
|---|---|---|
| 1-3 | `trailing_lock` | max_hold ∈ {无, 10, 20} |
| 4-6 | `fixed_n` | N ∈ {5, 10, 20} |
| 7 | `strategy` | 卖出：KDJ 超买离场（如 `kdj_j gt 90`），max_hold=20 兜底 |
| 8 | `strategy` | 卖出：跌破 ma10（`close lt ma10`，field 比较），max_hold=20 兜底 |
| 9 | `strategy` | 卖出：大盘 regime 恶化离场（`oamv_macd lt 0`），max_hold=20 兜底 |

- 配置 9 依赖核查点 1（strategy 出场是否支持大盘字段）；不支持则第一轮先跑
  1-8，把支持大盘字段出场列为第二轮小扩展。
- 第一个 run 实测耗时后再定其余 17 个的排程（串行/并行），见核查点 3。
- 第二轮按第一轮结果可选加 run（新出场假设或被收紧掉的宽阈值档），总数不设
  上限但每个新 run 须在研究日志写明动机。

## 离线搜索协议（每 族 × 出场 × 象限 切片独立执行）

```text
锚点成交 ──JOIN oamv_daily(信号日)──▶ 象限切片 ──限 train 窗──▶
  ① 单变量筛 ──▶ ② 贪心组合 ──▶ ③ 样本地板淘汰 ──▶ 象限内候选池
```

1. **切片**：`signal_test_trade` JOIN `oamv_daily ON trade_date=signal_date`
   按四象限 CASE 分桶，再限 train 窗口（`signal_date <= '20241231'`）。
2. **单变量筛**：候选过滤字段库 = `ASHARE_FIELD_COL_MAP` 全部字段（~45 个，
   每个取 2-3 档阈值）+ 大盘细分字段（`oamv_daily` 的 ma5/30/60/120/240、
   kdj_k/d/j——离线直接 JOIN，无需先扩条件系统）+ 行业 AMV 字段
   （`ASHARE_INDUSTRY_AMV_COL_MAP`）+ 本族核心阈值收紧档。逐候选计算 train 窗
   的边际 kelly 提升与样本保留率；信号日字段值按 enumerator 同口径 JOIN
   `raw.daily_indicator` 等表取得。
3. **贪心组合**：前向选择，最多叠 3-4 个过滤器。入选过滤器须满足
   **train 窗内逐年（2022/2023/2024）方向不翻车**——即每加一个过滤器，分年
   kelly 相对不加时不得出现"某年由正转深负"，防止单年噪声当信号。
4. **样本地板**：train 窗 n ≥ 500、holdout 窗预估 n ≥ 200（按 train 信号密度
   折算），不达标组合直接淘汰，不得进入预登记。

## 双保险验证协议（硬纪律）

- **窗口**：train = 2022.4–2024.12；holdout = 2025.1–2026.5。
  注意：四象限轴本身已看过全部年份（预验所致，诚实声明）；双保险保护的是
  **象限内变体选择**这一层。
- **预登记**：每象限跨族取 top-3，把完整条件 JSON + 出场配置 + train 指标
  **先写入** `doc/研究/0amv-regime-strategy/preregistration.md`（append-only，
  含日期），**之后**才允许执行任何 holdout 窗口查询。
- **单次评估**：holdout 每配置只评一次，结果无论好坏照实记入研究日志；
  **禁止评完回头换候选再评**（多重检验预算固定为 4 象限 × 3）。
- **达标线**（全部满足才算"该象限有可用策略"）：
  1. holdout kelly > 0；
  2. 全周期按年分解 ≥4/5 年非深亏（深亏 = 单年 kelly < -0.05）；
  3. holdout 实际样本 n ≥ 200。
- **基线对照**：终表每象限必含三行——「搬砖7条+trailing_lock 基线」「空仓
  （kelly 记 0）」「调优胜者」。胜者须在 holdout 与按年两个口径都明显优于
  前两者；不达标 → 该象限结论降级为「空仓」或「仅基线」，照实写入映射表。
- **真机收口**：每象限胜者建 signal_test（入场 = 胜者条件 + 该象限两条 oamv
  条件）→ run → `sample_count`/`kelly_f` 与离线**逐位对账**；差异须可解释
  （如停牌/次新过滤），解释不了视为 bug，修完重对。

## 离线 SQL 模板

四象限 × 按年分桶（换 `run_id` 即换锚点；去掉 `yr` 即全期口径）：

```sql
WITH t AS (
  SELECT tr.ret, left(tr.signal_date,4) AS yr,
    CASE
      WHEN o.amv_dif > 0 AND o.amv_macd > 0 THEN 'Q1'
      WHEN o.amv_dif > 0 AND o.amv_macd <= 0 THEN 'Q2'
      WHEN o.amv_dif <= 0 AND o.amv_macd > 0 THEN 'Q3'
      ELSE 'Q4'
    END AS regime
  FROM signal_test_trade tr
  JOIN oamv_daily o ON o.trade_date = tr.signal_date
  WHERE tr.run_id = '<anchor-run-id>'
)
SELECT regime, yr, count(*) n,
  round(avg((ret>0)::int)::numeric,4) win_rate,
  round(((avg(ret) FILTER (WHERE ret>0))
        / abs(avg(ret) FILTER (WHERE ret<=0)))::numeric,2) payoff,
  round((avg((ret>0)::int)::numeric - (1-avg((ret>0)::int)::numeric)
        / ((avg(ret) FILTER (WHERE ret>0))
        / abs(avg(ret) FILTER (WHERE ret<=0))))::numeric,4) kelly,
  round(avg(ret)::numeric,5) avg_ret
FROM t GROUP BY regime, yr ORDER BY regime, yr;
```

入场变体复筛：在 CTE 中追加
`JOIN raw.daily_indicator i ON i.ts_code=tr.ts_code AND i.trade_date=tr.signal_date`
（按需再 JOIN `raw.daily_basic` / `stock_amv_daily` / `signal_rolling_indicator`），
WHERE 中叠加候选过滤条件即可。自洽校验：`kelly = p - (1-p)/payoff` 手工复核，
防 GBK 串扰读错数。

## 研究产物入仓

目录 `doc/研究/0amv-regime-strategy/`：

- `preregistration.md` —— 预登记日志（append-only）；
- `results.md` —— 各轮离线结果、holdout 单次评估、真机对账记录；
- `sql/` —— 全部对账/分桶 SQL 脚本（可复跑）；
- 最终映射表与边界声明（交付物定义见 [04](./04-verification-and-risks.md#交付物与达标线)）。
