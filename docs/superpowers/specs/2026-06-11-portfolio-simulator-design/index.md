# 组合级模拟器 + 交易成本建模 · 设计 spec（入口）

> 日期：2026-06-11 · 状态：设计已经四段交互批准，待自审+用户终审
> 交接源：`prompts/build-portfolio-simulator-with-cost-model.md`
> 前置研究：`docs/superpowers/specs/2026-06-10-0amv-regime-strategy-design/`（0AMV 四象限策略，config v1 已激活）

## 背景与目标摘要

0AMV 四象限研究交付的全部 kelly 是**逐笔量纲**（Q3 官方 0.7245），而 Q3 反弹日单日信号峰值
1818 支、收益高度聚簇——逐笔 kelly ≠ 组合仓位 kelly。spec 承诺影子期（2026-06-11 起 ≥8 周）
"以组合日收益口径复核"，该工具链此前不存在；交易成本也从未建模。

本项目交付：**TS 模块 `portfolio-sim`**——消费既有 `signal_test_trade` 逐笔交易做**逐日组合回放**，
在共享资金池、仓位约束（语义照搬 backtest 模块）、三档交易成本下产出净值曲线与组合口径指标，
配 Web 操作台（建配置/触发/进度/净值图/逐信号明细），并以"锚点模式"自校验：无约束+零成本下
复算逐笔统计必须与官方 run 逐位一致。

用户已决策（2026-06-11 brainstorming）：比例制资金语义；佣金万 2.5；一期不做基准对比；
交付含 Web 操作台；仓位控制参照 backtest 模块；实现方案 A（独立 TS 模块）。

## 子文档清单

| 文档 | 内容 |
|---|---|
| [01-background-and-scope.md](./01-background-and-scope.md) | 摸底事实（DB/代码，file:line）、用户决策记录、范围边界 |
| [02-engine-design.md](./02-engine-design.md) | 引擎语义：配置结构、逐日循环、盯市与收口、成本模型、锚点模式 |
| [03-data-model-and-api.md](./03-data-model-and-api.md) | 三张表 + migration + API 路由 + 幂等/互斥语义 |
| [04-frontend-console.md](./04-frontend-console.md) | 操作台布局、组件拆分、运行态轮询模式 |
| [05-verification-and-tasks.md](./05-verification-and-tasks.md) | 测试金字塔、验证标准、SDD 任务切分、风险表 |

## 建议阅读顺序

01 → 02 → 03 → 04 → 05。实现者最少读 02+03（引擎+数据契约）；
审阅者全读；前端实现者读 03+04。

## 跨文档引用约定

统一相对路径 + 锚点，如 `./02-engine-design.md#成本模型`。引用代码一律 `file:line`
（行号为 2026-06-11 摸底时点，实现时复核）。**run id / 列名 / 费率进硬断言前须按
`.claude/rules/data-integrity.md` 落源头核验，本 spec 的转述不作为权威源。**
