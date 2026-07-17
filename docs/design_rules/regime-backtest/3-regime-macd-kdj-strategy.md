# 策略需求:三象限 MACD+KDJ 大盘择时回测

> 本文档固化用户的策略需求,作为 Agent 构造 config 的权威输入。本文不涉及实现细节(实现见 [03-engine-internals.md](./03-engine-internals.md))。

---

## 1. 策略意图

**大盘三态择时 + KDJ 超卖反转选股 + 趋势确认 + OBV 强势排序 + 波段跟踪止损**。

核心逻辑:
1. **大盘择时**:用中证全指(000985.CSI)的 MACD 状态(DIF 与 HIST 的符号组合)把每个交易日分到三态之一——单边上升 / 单边下降 / 震荡。
2. **个股选股**:每态下用一组 KDJ 参数(K、D、J 递推周期)判定超卖反转(J<10),并用均线确认多头格局(MA20>MA60 ∧ CLOSE>MA60)。
3. **排序入场**:同一交易日多只票满足信号时,按 OBV(成交额,10 日)降序选第一名。
4. **仓位与出场**:按象限给定仓位比例与最大持仓数,出场统一用 trailing_lock(波段跟踪止损 + MA5 离场)。

---

## 2. 大盘三象限规则表

### 2.1 流程图

```
                        中证全指 000985.CSI 当日 MACD
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
         HIST>0 ∧ DIF>0      HIST<0 ∧ DIF<0      (HIST<0 ∧ DIF>0)
         (单边上升 Q_up)      (单边下降 Q_down)    ∨
                                                (HIST>0 ∧ DIF<0)
                                                (震荡 Q_osc)
                │                   │                   │
                ▼                   ▼                   ▼
         KDJ(3,2,2).J<10    KDJ(9,3,3).J<10    KDJ(6,2,2).J<10
         ∧ MA20>MA60         ∧ MA20>MA60         ∧ MA20>MA60
         ∧ CLOSE>MA60        ∧ CLOSE>MA60        ∧ CLOSE>MA60
                │                   │                   │
                ▼                   ▼                   ▼
         OBV10 降序第1      OBV10 降序第1      OBV10 降序第1
         2仓 × 40%          8仓 × 10%          4仓 × 20%
         trailing_lock      trailing_lock      trailing_lock
```

> 震荡象限的判定是嵌套 OR 关系:`(HIST<0 ∧ DIF>0) ∨ (HIST>0 ∧ DIF<0)`。单层 `matchLogic` 无法表达此逻辑(需要「组内 AND,组间 OR」),必须使用 **MatchGroup** 嵌套结构(见 [03-engine-internals.md](./03-engine-internals.md) §3.2 及 [01-workflow.md](./01-workflow.md) §5.4.1)。

### 2.2 三象限字段对照表

| 字段 | Q_up(单边上升) | Q_down(单边下降) | Q_osc(震荡) |
|---|---|---|---|
| **matchLogic** | `'and'`(默认) | `'and'` | 不适用(MatchGroup 自带 `logic:'or'`) |
| **match**(均针对 000985.CSI) | `HIST>0 ∧ DIF>0` | `HIST<0 ∧ DIF<0` | MatchGroup: `(HIST<0 ∧ DIF>0) ∨ (HIST>0 ∧ DIF<0)`(见 §5.4.1 示例) |
| **KDJ 参数** | `n=3, m1=2, m2=2` | `n=9, m1=3, m2=3` | `n=6, m1=2, m2=2` |
| **entryConditions** | `kdj_j<10 ∧ ma20>ma60 ∧ close>ma60` | 同左(KDJ 参数不同) | 同左(KDJ 参数不同) |
| **rankField** | `obv10d`(降序) | `obv10d`(降序) | `obv10d`(降序) |
| **positionRatio** | `0.40` | `0.10` | `0.20` |
| **maxPositions** | `2` | `8` | `4` |
| **exitMode** | `trailing_lock` | `trailing_lock` | `trailing_lock` |

**仓位约束校验**:`positionRatio × maxPositions` 均需 ≤ 1。
- Q_up:0.40 × 2 = 0.80 ✅
- Q_down:0.10 × 8 = 0.80 ✅
- Q_osc:0.20 × 4 = 0.80 ✅

---

## 3. 关键参数

### 3.1 指标参数

| 指标 | 参数 | 数据来源 | 备注 |
|---|---|---|---|
| **MACD**(大盘) | 标准 12/26/9 | `index_daily_indicators`(000985.CSI) | 字段名:`dif`/`dea`/`macd`(macd 即 HIST) |
| **KDJ**(个股) | 三套:`(3,2,2)` / `(9,3,3)` / `(6,2,2)` | **现算**(derived field) | 库内 `daily_indicator.kdj_*` 是固定 9/3/3,其它两套需现算 |
| **MA**(个股) | `ma20` / `ma60` | **现算**(derived field) | 库内只有 ma5/30/60/120/240,**ma20 不在表** |
| **OBV**(个股) | 10 日 | `daily_indicator.obv10d`(已存) | 库内有列但当前不在 rankField 白名单,需放开 |
| **MA5**(出场用) | 5 日 | `daily_indicator.ma5`(已存) | trailing_lock 的 MA5 离场判定用 |

### 3.2 trailing_lock 出场参数(三象限统一)

采用前端默认值 + maxHold 兜底:

```json
{
  "maxHold": 60,
  "stopRatio": 0.95,
  "floorRatio": 0.90,
  "floorEnabled": true,
  "ma5RequireDown": true
}
```

语义:
- `stopRatio=0.95`:跟踪止损,从锁定基准回落 5% 触发
- `floorRatio=0.90`:成本保本地板 90%
- `ma5RequireDown=true`:MA5 离场需 MA5 拐头下行
- `maxHold=60`:最长持有 60 个交易日兜底

> 详细状态机语义见 [01-workflow.md](./01-workflow.md) §5.3 与 trailing_lock 探索报告。

---

## 4. 资金与回测区间

| 项 | 值 | 备注 |
|---|---|---|
| **initialCapital** | `10000000`(1000 万) | 用户指定 |
| **universe** | `{mode:'all'}`(全市场) | 最真实 |
| **dateStart** | `20240101` | 覆盖 2024 牛熊切换 + 2025 行情(待用户确认) |
| **dateEnd** | `20260716` | 库内最新交易日 |

**成本费率**(现实档):

```json
{
  "commissionPerSide": 0.00025,
  "transferPerSide": 0.00001,
  "stampSellBefore20230828": 0.001,
  "stampSellFrom20230828": 0.0005,
  "slippagePerSide": 0.0005
}
```

---

## 5. 实施依赖(本策略需要的前置扩展)

本策略无法用 regime 引擎**现状**直接跑通,需要 4 个扩展(详见 [03-engine-internals.md](./03-engine-internals.md)):

| 扩展 | 层级 | 是否阻塞 |
|---|---|---|
| 补中证全指 000985.CSI 数据 | 数据层 | ✅ 阻塞(无数据则 match 永不命中) |
| OBV(obv10d)放 rankField 白名单 | config 层 | ✅ 阻塞 |
| MA20 + 多套 KDJ 现算组件 | 引擎层 | ✅ 阻塞 |
| match 嵌套 AND/OR(MatchGroup) | 引擎层 | ✅ 阻塞(震荡象限无法用单层 matchLogic 表达) |

---

## 6. 验收标准

回测跑通后,Agent 应输出:
1. **汇总指标**:finalNav / totalRet / annualRet / maxDrawdown / sharpe / calmar / nTaken / totalCosts
2. **三象限命中分布**:Q_up / Q_down / Q_osc 各自的命中交易日数、成交笔数、各自收益贡献
3. **典型成交**:每个象限取 2-3 笔代表性 taken 交易(信号日/买入日/退出日/净收益/退出原因)
4. **文档漏洞记录**:跑通过程中发现的文档与代码不一致之处,作为后续文档改进输入
