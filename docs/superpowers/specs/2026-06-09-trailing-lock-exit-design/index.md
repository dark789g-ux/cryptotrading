# 波段跟踪止损出场规则（trailing_lock）设计 — 总入口

> 新增一条 **path-dependent（路径依赖）出场规则**，统一落到三个 A 股模块：信号前向统计（NestJS）、
> 策略管理 `exit_rules.py`（Python）、Kelly sweep 网格（Python）。回测模块（加密货币）不在范围内。

## 一、背景与目标

用户提出一条精细出场规则：以**信号次日（T+1）开盘买入**为起点，按**持仓首日收盘 vs 开盘**分两套方案设初始止损，
逐日以"前一交易日最低价 ×0.999"做跟踪止损；当某日最低价突破**信号 K 线最高价**时把止损价**冻结锁定**，
锁定后叠加 **MA5 收盘离场**。并要求建模 A 股**涨跌停板流动性**（一字涨停买不进、一字跌停卖不出顺延）。

目标：把这条规则实现为三模块**行为一致**的出场口径，用一份**纯函数单一真值** + 同构 TS 实现 + 同组对拍样例保证一致。

## 二、七项已锁定决策（brainstorming 结论）

```text
1. 目标模块  = signal-stats(NestJS) + exit_rules.py(Py) + kelly_sweep(Py)；回测(crypto)不动
2. 买入口径  = 三模块统一 T+1 开盘买入；成本价 = 持仓首日开盘价
3. 价格基准  = 各模块原生复权价(signal-stats=qfq / exit_rules=hfq / kelly_sweep=qfq)；
              ×0.999 后 floor 到 0.01，施加在复权价上（标称取整）
4. 止损时序  = 每个交易日"收盘后"设定止损价、"次日生效"；持仓首日不被自身当天止损
5. 方案二初值= 持仓首日"最低价 ×0.999"（方案一用"开盘价 ×0.999"）
6. 实现架构  = 方案 A：Python 抽共享纯函数核 band_lock_exit.py，被 exit_rules + kelly_sweep 共用；
              NestJS 写同构 TS 版，用同组样例对拍
7. 限停板    = 买不进 raw_open ≥ up_limit（信号不成立，不顺延）；
              卖不出 raw_high ≤ down_limit（封死跌停 → 顺延到下一可卖日开盘价）
```

## 三、子文档清单与阅读顺序

| 顺序 | 文档 | 内容 |
|---|---|---|
| 1 | [01-rule-semantics.md](./01-rule-semantics.md) | **规范算法**：两方案、止损时序、锁定、MA5 离场、限停板顺延、边界（单一真值，必读） |
| 2 | [02-shared-core-and-contracts.md](./02-shared-core-and-contracts.md) | Python 共享纯函数核接口契约 + 逐 bar 数据记录形状 + 对拍样例集 |
| 3 | [03-module-integration.md](./03-module-integration.md) | 三模块各自改动：数据层扩展、调用胶水、前端、落库（含 file:line 证据） |
| 4 | [04-testing-and-rollout.md](./04-testing-and-rollout.md) | 测试策略（对拍/单测/e2e）、迁移、验证标准、分批提交建议 |

**建议**：先读 `01` 把规则语义吃透（这是三模块共用的唯一真值），再读 `02` 看共享核如何把语义固化为可测接口，
然后 `03` 看各模块怎么接，最后 `04` 看怎么验。

## 四、跨文档引用约定

- 文档间引用统一用**相对路径 + 锚点**，例：`见 [01 §限停板](./01-rule-semantics.md#五限停板流动性)`。
- 代码位置统一 `相对仓库根路径:行号`，例：`apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts:138`。
- **二手 vs 一手标注**：本设计中 daily_quote / stk_limit 列名、signal-stats 代码均**已落真 DB / 源码亲验**（2026-06-09）；
  kelly_sweep 的行号为子代理摸底所得（**二手**），文中以"约 line X（实现前核实）"标注，实现前须按
  [.claude/rules/data-integrity.md](../../../../.claude/rules/data-integrity.md) 自查实体/源码再写进硬逻辑。

## 五、术语对照（大白话）

- **信号 K 线**：触发买入信号的那根日 K（记为 T）。
- **持仓首日**：实际买入成交那天（T+1，开盘买入）。
- **跟踪止损（trailing stop）**：止损线随价格变动逐日调整，这里是"跌破前一日最低价就走"。
- **锁定**：股价彻底站上信号 K 线最高点后，把止损线钉死不再下移，并加一道 MA5 收盘离场。
- **一字涨停/跌停**：全天封死在涨停价/跌停价，买不进/卖不出。
- **保本地板（方案二）**：浮盈后把止损线托到"成本价 ×0.999"，避免到手利润回吐成亏损。
