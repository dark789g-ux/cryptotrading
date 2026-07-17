# Regime 回测手册

本手册是 Regime 引擎 A 股回测（`POST /api/backtest/ashare`）的完整文档集，覆盖接口调用、字段可用性、引擎内部机制三层。

---

## 目录导航

| 章节 | 文件 | 角色 | 何时查 |
|---|---|---|---|
| 第 1 章 接口与工作流 | [01-workflow.md](./01-workflow.md) | 接口层 | 写 Agent 调用回测接口、构造 config、定位 404/400/500 时 |
| 第 2 章 字段白名单 | [02-field-whitelist.md](./02-field-whitelist.md) | 字段层 | 构造 entryConditions/exitConditions/match/rankField 前 |
| 第 3 章 引擎内部机制 | [03-engine-internals.md](./03-engine-internals.md) | 引擎层 | 理解 derived field 现算、match OR/MatchGroup 嵌套、两阶段求值、性能权衡时 |
| 策略案例 | [3-regime-macd-kdj-strategy.md](./3-regime-macd-kdj-strategy.md) | 应用层 | 参考一份完整的三象限策略需求与 config 构造实例 |

---

## 模块定位与 Agent 职责

本接口是 **A 股日线**唯一可用的回测通路，Agent 收到「A 股回测」类需求时应走本接口（[第 1 章 §1](./01-workflow.md)）。Agent 的工作闭环为：**理解用户策略意图 → 构造 config → 调用接口 → 轮询进度 → 取结果并总结**。config 必须从用户需求生成，禁止从数据库历史 config 复制或转换。

---

## 典型工作流串联

```
用户需求(自然语言策略描述)
    │
    │  ① 先查 [第 2 章 字段白名单] 确认字段可用
    │  ② 按 [第 1 章 §5 config 字段规则] 构造 config
    │  ③ 若涉及现算字段/MatchGroup → 查 [第 3 章 引擎内部机制] 理解性能影响
    ▼
POST /api/backtest/ashare         ← [第 1 章 §2 完整工作流]
POST /api/backtest/ashare/:id/run
GET  /api/backtest/ashare/:id/progress
GET  /api/backtest/ashare/:id     ← 汇总指标(number 类型,见第 1 章 §3.1)
    │
    ▼
Agent 总结结果,回呈用户
```

---

## 关键坑速查

| 坑 | 避坑方式 | 参考 |
|---|---|---|
| 日期格式 `YYYYMMDD` 非 `YYYY-MM-DD` | 校验正则 `/^\d{8}$/`，传错直接 400 | [第 1 章 §2](./01-workflow.md) |
| `GET /:id/trades` 500 | 取成交用 DB 直查 `WHERE status='taken'` | [第 1 章 §3](./01-workflow.md) |
| `positionRatio * maxPositions > 1` | 必须确保乘积 ≤ 1，否则报错 | [第 1 章 §5.2](./01-workflow.md) |
| `capital.cost` 传错键名 | 必须用五键（`commissionPerSide` 等），传错得全 0 费率 | [第 1 章 §4](./01-workflow.md) |
| `kelly.enabled=true` 无效果 | 必须同时设 `sizing.mode='source_kelly'`，否则 400 | [第 1 章 §4](./01-workflow.md) |
| numeric 字段返回 string？ | regime-backtest 系列已统一为 number；其他模块仍可能为 string | [第 1 章 §3.1](./01-workflow.md) |

---

## 文档维护约定

- **字段白名单是易腐坏点**：每当 `strategy-conditions.types.ts` 的 `*_COL_MAP` 或 `rank-select.ts` 的 `RANK_FIELDS` 变更，必须同步更新 [第 2 章 字段白名单](./02-field-whitelist.md)（权威源声明见该文档顶部）。
- **校验规则变更**（`regime-engine.validation.ts`）时，同步更新 [第 1 章 §5](./01-workflow.md)。
- **新增 exitMode / sizing 模式**时，更新第 1 章 §5.3 和 §4。
- 详细维护约定见 [第 1 章 §9](./01-workflow.md)。

---

<sub>本手册于 2026-07 由原 `regime-backtest-agent-workflow.md` + `regime-backtest-field-whitelist.md` + `regime-engine-derived-field-design.md` 三文档整合而来。</sub>
