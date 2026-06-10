# 分阶段探索：0AMV 不同阶段下各自的最优 A 股策略

> 交接提示词（handoff）。可整段贴给全新会话直接接手，不依赖上一会话上下文。
> 项目：cryptotrading（量化回测）。工作目录 `C:\codes\cryptotrading`，Windows + PowerShell（禁 `&&`，用 `;` 或分步）。中文思考与回答。

## 一句话目标

把大盘 0AMV 指数按"阶段（regime）"切分，**分别为每个阶段找最优的 A 股入场/出场策略**——不再全周期一套参数。终态交付：一张「阶段 → 最佳策略 + kelly/pf + 按年表现」映射表，且**每个阶段的结论都经完整牛熊周期或 train/test 验证站得住**（不是选窗口骗出来的）。

## 为什么做这个（背景，先读）

搬砖系列演进到此：全周期（2022.4–2026.5）一套参数到顶了——
- 搬砖-04L2（无择时）完整周期 kelly **+0.007**（打平）
- 搬砖-05C（仅 0AMV MACD 柱>0 择时）kelly **0.1095**，但**强 regime 依赖**：2025 +0.230、2022 仍 **-0.055**

结论：全周期单参数的天花板已到。**下一步自然是按大盘阶段分治**——在大盘不同状态下用不同策略（甚至空仓）。本任务就是系统性地做这件事。

## 现状摸底（file:line / 真实数据为证，已核实）

### 已有基础设施（全部已落本地 main，本会话产出）

- **`oamv_daily` 表**：18 列 = `id/trade_date/open/high/low/close/created_at` + 11 指标列 `amv_dif/amv_dea/amv_macd`（通达信式 MACD 12/26/9）`ma5/ma30/ma60/ma120/ma240`（严格 SMA）`kdj_k/kdj_d/kdj_j`（周期9）。覆盖 **20210901~20260610，1153 行，SSE 交易日零缺失，预热段外零 NULL**（ma240 首非空 20220829）。指标随 `sync0amv` 末尾 `recomputeIndicatorsAll()` 全量重算。
- **条件系统已支持大盘 0AMV 字段**：`apps/server/src/strategy-conditions/strategy-conditions.types.ts:54` `ASHARE_MARKET_AMV_COL_MAP = { oamv_dif:'oa.amv_dif', oamv_dea:'oa.amv_dea', oamv_macd:'oa.amv_macd' }`；query-builder 译成 `EXISTS(SELECT 1 FROM oamv_daily oa WHERE oa.trade_date=i.trade_date AND <predicate>)`，按 trade_date 对齐、**缺日 fail-closed（排除当日全部信号）**。**多个大盘条件 AND = 各自独立 EXISTS**，所以"象限"可直接表达（如 Q3 = `oamv_dif < 0` AND `oamv_macd > 0` 两条件）。前端选项在 `apps/web/src/components/strategy-conditions/ConditionRows.vue`（"大盘0AMV-MACD-DIF/DEA/MACD"）。
- **信号前向统计模块**（A 股买入条件触发后前向胜率/盈亏比 + 出场模拟）：建方案 `POST /api/signal-tests`，触发 `POST /api/signal-tests/:id/run`，进度 `GET /api/signal-tests/:id/run/progress`。kelly 公式在 `apps/server/src/strategy-conditions/signal-stats/signal-stats.metrics.ts`：`f* = p - (1-p)/b`，`b=avgWin/|avgLoss|`。枚举器 `signal-stats.enumerator.ts` 的 join 口径与下面离线分桶 SQL **完全一致**（这是离线预验=真机的依据）。
- **锚点数据（关键，免重跑）**：搬砖-04L2 的 run **`cb1ea759-e9bb-4c9d-b402-bdb2ef007dd8`**（40856 trades，全在 `signal_test_trade`）。**直接 JOIN `oamv_daily` 即可离线按任意阶段切分，无需重跑回测**。
- DB 访问：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。

### 搬砖基线方案 id（供建新 run 复制配置）

| 方案 | test id | run id | 区间 | 样本 | kelly |
|---|---|---|---|---|---|
| 搬砖-04L2（无择时基线） | `82f8eb52-…745b` | `cb1ea759-…07dd8` | 20220401–20260531 | 40856 | +0.007 |
| 搬砖-05（柱>0 且 DIF>0） | `36d279a9-…0838` | `274d9da0-…ac9d` | 同 | 6660 | 0.083 |
| 搬砖-05C（仅柱>0） | `8e5a25ed-…e0db` | `4ded9adc-… caed` | 同 | 13747 | 0.1095 |

搬砖 7 条入场（04L2/05/05C 共用，出场 `trailing_lock` 不封顶）：
```json
[
  { "field": "brick_xg",         "operator": "gte", "value": 1,    "compareMode": "value" },
  { "field": "brick_delta",      "operator": "gt",  "value": 0.66, "compareMode": "value" },
  { "field": "ma30",             "operator": "gt",  "compareMode": "field", "compareField": "ma60" },
  { "field": "close",            "operator": "gt",  "compareMode": "field", "compareField": "ma60" },
  { "field": "turnover_rate",    "operator": "lt",  "value": 2,    "compareMode": "value" },
  { "field": "close_ma60_ratio", "operator": "lt",  "value": 1.05, "compareMode": "value" },
  { "field": "vol_ratio_60",     "operator": "lt",  "value": 1.1,  "compareMode": "value" }
]
```

### 关键预验：04L2 × 0AMV MACD 四象限（已跑，这是起点金矿）

把 cb1ea759 的 40856 笔成交按信号日的大盘 0AMV MACD 象限分桶：

```text
              柱 > 0 (动能回暖)          柱 < 0 (动能转弱)
            ┌───────────────────────┬───────────────────────┐
  DIF > 0   │ Q1 强多头             │ Q2 多头回调           │
 (均线上方) │ n=6660  kelly +0.085  │ n=9819  kelly -0.024  │  ← 回调段这套打法亏!
            ├───────────────────────┼───────────────────────┤
  DIF < 0   │ Q3 反弹筑底 ★最肥     │ Q4 空头               │
 (均线下方) │ n=7087  kelly +0.127  │ n=17290 kelly -0.066  │  ← 占42%样本,亏最惨
            └───────────────────────┴───────────────────────┘
（payoff: Q1 3.09 / Q2 2.35 / Q3 3.89 / Q4 2.42；avg_ret: +0.28% / -0.07% / +0.62% / -0.25%）
```

**这张图解释了之前的一切，也指明了方向：**
- 05C（柱>0）= Q1+Q3，样本 6660+7087=**13747** 完全对上、kelly 0.1095 是两者加权。
- "DIF>0 有害" = 因为它砍掉了 **Q3 这个单象限之王（0.127）**——DIF 还在水下、柱刚转正的"反弹筑底"才是这套突破打法最肥的窗口。
- **Q3 单独开仓 kelly 0.127 > 全周期 05C 的 0.1095**——分阶段的价值已被证明。
- Q2（多头回调）反直觉地**亏**：均线上方但动能转弱时这套追突破不灵。
- Q4（空头）占 42% 样本、亏 -0.066——**最该规避/空仓的阶段**，2022 熊市拖累主体在此。

## 已定方向

1. **主轴用 0AMV MACD 四象限**：已落库、零阈值、量纲无关、和择时闸门同源、预验区分度极强。
2. **方法 = 离线分桶先行，真机 run 收口**：先在 cb1ea759 的 40856 trades 上大范围离线切（阶段 × 入场过滤变体 × 出场口径），锁定有希望的组合，**再建少数真机 run 官方对账**（像 05/05C 那样，信号数与离线逐位吻合才算数）。离线 SQL 模板见文末。

## 待 brainstorming 敲定的开放问题（附我的推荐）

1. **头号风险——Q3 的 0.127 跨年稳不稳？** 先做 `四象限 × 按年` 分解，看 Q3 在 2022/2023 熊震市是否仍正（很可能是 2024-25 反弹行情堆出来的）。**这一步必须最先做**，否则又是选窗口骗局。推荐：接手第一件事就是跑这个分解。
2. **"最佳策略"的可调维度**——每个阶段可不同：① 入场过滤组合（搬砖 7 条之外加减）；② 出场逻辑（`trailing_lock` 参数 vs 换固定 N 日/其它模式——复盘提示"近半年也过 0.1 得改出场"）；③ 凯利仓位。**Q4 是否直接空仓？Q2 是否换打法或也空仓？** 推荐：先固定搬砖 7 条 + trailing_lock，只切阶段，跑通框架；再逐阶段调入场/出场。
3. **阶段定义粒度**——纯 MACD 四象限够不够？是否叠加趋势维度（`close vs ma240` 牛/熊、`ma60` 斜率）或位置维度（KDJ 超买超卖）做更细 regime？推荐：四象限站稳后再考虑细分，避免一上来维度爆炸、每格样本不足。
4. **落地形态**——只出研究结论（阶段→策略表），还是做成"实时识别当前 0AMV 阶段 → 自动切换/开关策略"的产品功能？推荐：先研究结论，产品化另起 spec。

## 硬约束 / 项目规范（务必遵守）

- **样本内过拟合是这个系列反复栽的坑**（0.118 → 实际全周期打平）。任何单段高 kelly **必须**扩到完整牛熊周期 + train/test 复验。**禁止**在选出过滤器的同一段数据上报告 kelly 当结论。
- **离线分桶只是预验**，最终每个阶段结论**必须真机 run 官方确认**且信号数与离线逐位对账（enumerator 与离线 join 同口径，对不上说明有 bug）。
- **0AMV sync 口径坑**：若需补/改 0AMV 数据，**一律全量 overwrite（`{startDate:'20210901', syncMode:'overwrite'}`，管理员会话）**，禁小窗口 overwrite（短预热会覆盖窗口内 OHLC 致段界漂移，实测 close 漂 ~2%、MACD -5135→-4390）。
- **落源头验证**：任何列名/表名/run id/字段后缀进硬断言或 SQL 前，先 `grep` 实体或查真 DB 一条，**禁止采信本文件或子代理的二手转述**（本文档 run id/列名截至 2026-06-10 已核，但接手时若隔时较久仍应复核）。
- Windows：源文件 UTF-8；PowerShell 禁 `&&`；docker psql `-t` 后台输出可能被 GBK 串扰，数字对不上时重查干净值并自洽核验 `kelly=p-(1-p)/payoff`。
- 出场模拟若要改：相关实现在 `signal-stats` 的 simulator/runner；trailing_lock 纯函数核见 [[project_trailing_lock_exit]]。

## 验证标准（每个阶段结论达标线）

1. **真机 run 官方 kelly**（建 signal_test → run → 读 sample_count/win_rate/payoff_ratio/kelly_f）。
2. **按年分解**：列出该阶段策略每年的 kelly/avg_ret，诚实标注哪些年亏。
3. **离线预验逐位对账**：真机信号数 = 离线分桶 n（差异需能解释，如停牌/次新过滤）。
4. **样本量充足**：单格样本过少（如 Q4/2022 细分后）须显式标注，不下过强结论。
5. **终态交付**：阶段→策略映射表 + 各格 kelly/pf/按年 + **一段诚实的 regime/过拟合边界声明**（哪些是稳健 edge、哪些靠特定行情）。

## 前序进度 / 待续

- ✅ 0AMV 14 指标列落库 + 大盘择时条件字段 + 面板点亮（本会话，本地 main，未推 origin）。
- ✅ 四象限预验（上表）——已证明分阶段有值、Q3 最肥、Q2/Q4 应规避。
- ⏭ **接手第一步**：跑 `四象限 × 按年` 分解验证 Q3 稳健性（用下面模板，`GROUP BY regime, left(signal_date,4)`）。
- ⏭ 然后 brainstorming 敲定开放问题 1-4，再离线大范围探索 → 真机 run 收口。

## 离线分桶 SQL 模板（直接套用）

按 0AMV MACD 四象限切某个 run 的成交，算各阶段 kelly。换 `run_id` 即换基线；加 `, left(tr.signal_date,4) AS yr` 到 SELECT/GROUP BY 即得按年分解：

```sql
WITH t AS (
  SELECT tr.ret,
    CASE
      WHEN o.amv_dif > 0 AND o.amv_macd > 0 THEN 'Q1_strong_bull'
      WHEN o.amv_dif > 0 AND o.amv_macd <= 0 THEN 'Q2_bull_pullback'
      WHEN o.amv_dif <= 0 AND o.amv_macd > 0 THEN 'Q3_rebound'
      ELSE 'Q4_bear'
    END AS regime
  FROM signal_test_trade tr
  JOIN oamv_daily o ON o.trade_date = tr.signal_date
  WHERE tr.run_id = 'cb1ea759-e9bb-4c9d-b402-bdb2ef007dd8'   -- 04L2 基线，40856 trades
)
SELECT regime, count(*) n,
  round(avg((ret>0)::int)::numeric,4) win_rate,
  round((avg(ret) FILTER (WHERE ret>0)) / abs(avg(ret) FILTER (WHERE ret<=0)),2) payoff,
  round(avg((ret>0)::int)::numeric
        - (1-avg((ret>0)::int)::numeric)
          / ((avg(ret) FILTER (WHERE ret>0)) / abs(avg(ret) FILTER (WHERE ret<=0))),4) kelly,
  round(avg(ret)::numeric,5) avg_ret
FROM t GROUP BY regime ORDER BY regime;
```

建真机 run（确认有希望的阶段策略）：`POST /api/signal-tests`（搬砖 7 条 + 该阶段 oamv 条件，如 Q3 = `oamv_dif lt 0` + `oamv_macd gt 0`）→ `POST /api/signal-tests/:id/run` → 轮询 `signal_test_run.status`，完成后读 `kelly_f` 并与离线对账。真机调用走管理员浏览器会话（AuthGuard 全局，端点鉴权）。

相关记忆：[[project_banzhuan_kelly_optimization]]（搬砖优化全史 + 离线分桶法）、[[project_active_mv_indicator]]（0AMV sync 口径坑）、[[project_signal_forward_stats]]（信号统计模块）、[[project_trailing_lock_exit]]（出场逻辑）。
