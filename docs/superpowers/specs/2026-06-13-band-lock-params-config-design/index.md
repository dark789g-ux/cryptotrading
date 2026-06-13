# 波段跟踪止损出场参数化（band_lock params config）设计

> 入口文档。本设计把「波段跟踪止损 trailing_lock / band_lock」出场规则里 4 个目前硬编码的参数
> 放开为用户可配置，并打通 signal-stats（前端手测）+ labels（训练标签）+ kelly_sweep（扫描）**全链路**。

## 背景

`band_lock` 出场规则有一套「一处真值、三模块复用」的架构（详见
[2026-06-09-trailing-lock-exit-design](../2026-06-09-trailing-lock-exit-design/)）：

```text
                  ┌─────────────────────────┐
                  │  止损规则参数（本设计放开）│
                  └────────────┬────────────┘
                               │ 一个参数 = 两套核同步改 + 重新对拍
              ┌────────────────┴────────────────┐
              ▼                                  ▼
   ┌──────────────────┐   对拍 S1~S13   ┌──────────────────────┐
   │ Python 纯函数核  │◀──────────────▶│  TS 同构核           │
   │ simulate_band_   │                 │  decideBandLock      │
   │ lock             │                 │  (signal-stats)      │
   └────────┬─────────┘                 └──────────┬───────────┘
       复用 │                                       │ 调用
     ┌──────┴───────┐                     ┌─────────┴──────────┐
     ▼              ▼                      ▼                    ▼
  labels(训练)  kelly_sweep(扫描)    simulator(出场模拟)  前端 SignalTestForm
```

当前**唯一可配置**的出场参数是 `max_hold`（封顶持仓天数，留空=不封顶）；其余全写死。

## 目标

把以下 4 个参数放开为用户可配置，全链路打通，且**默认值严格等于现状**（零漂移）：

| 参数（英文字段）        | 类型 | 默认（=现状） | 取值范围         | 作用 |
|-------------------------|------|---------------|------------------|------|
| `stopRatio` 止损缓冲系数 | 标量 | `0.999`       | `[0.001, 1.0]`   | 止损价 = 基准价 × 系数（4 处统一）|
| `floorRatio` 成本地板系数| 标量 | `0.999`       | `[0.001, 9.999]`，允许>1 | 方案二：成本×系数 作止损下限；>1=锁盈 |
| `floorEnabled` 启用成本地板| 布尔 | `true`        | —                | 方案二是否启用成本地板 |
| `ma5RequireDown` MA5下行要求| 布尔 | `true`        | —                | 锁定后离场是否要求 MA5 本日下行 |

**kelly_sweep 侧**：4 参数作为**扫描维度**（候选集笛卡尔积），候选集默认单值=退化成现状。

## 零漂移总约束（贯穿全文，最高优先级）

> 任何模块在「全部参数取默认值」时，行为必须与改造前**逐位一致**：
> - 共享核：现有对拍样例 S1~S13 输出不变；
> - labels：scheme 串 canonical 回 `band_lock` / `band_lock__mh{N}`，`feature_set_id` 哈希不漂移；
> - kelly：`DEFAULT_EXIT_GRID` 的 band_lock 部分与 `_exit_id` 保持现状；
> - signal-stats：`band_lock_params` 列为 null（存量行）时按全默认跑。

## 子文档清单与阅读顺序

| # | 文档 | 内容 |
|---|------|------|
| 1 | [01-params-and-semantics.md](./01-params-and-semantics.md) | 4 参数定义、取值范围、依赖、对共享核语义的**精确控制点**（每处 file:line） |
| 2 | [02-scheme-codec.md](./02-scheme-codec.md) | `band_lock_scheme.py` 编解码三件套、向后兼容/哈希稳定性、后缀格式 |
| 3 | [03-shared-core.md](./03-shared-core.md) | Python 核 + TS 核 同构改造（逐处对照）+ 对拍样例扩充 |
| 4 | [04-signal-stats-fullstack.md](./04-signal-stats-fullstack.md) | DTO / 校验 / entity+migration / simulator 构造 / 前端 4 控件 |
| 5 | [05-labels-and-kelly.md](./05-labels-and-kelly.md) | labels 透传 + kelly 网格收敛/去重/护栏 + kelly 前端候选集编辑器 |
| 6 | [06-testing-rollout.md](./06-testing-rollout.md) | 对拍/单测/真机 e2e、零漂移验证标准、分层 commit、backlog |

**建议阅读顺序**：先 01（参数语义是地基）→ 02（scheme 编码是 labels/kelly 复用的钥匙）→ 03（核改造是单一真值）→ 04/05（两条全链路落地）→ 06（验证收口）。

## 跨文档引用约定

- 文档间引用一律用相对路径 + 锚点，如 `[逐处改造对照](./03-shared-core.md#二逐处改造对照)`。
- 代码引用用仓库相对路径 + 行号，如 `band_lock_exit.py:139`（路径相对 `apps/quant-pipeline/src/quant_pipeline/`）或写全路径。
- 行号锚定本设计撰写时（2026-06-13）的代码；实现时以当前代码为准、按语义定位。

## 范围边界（明确不做）

- **不放开 MA5 离场窗口（现 5）**：labels/kelly 直接吃 DB 固定 5 日列，改窗口要 Python 弃 DB 列重算，成本陡峭——入 backlog（见 06）。
- **不放开首日方案一/二切换阈值（现 收盘>开盘）**：动初始止损算法内核，回归风险高——入 backlog。
- 回测（crypto）模块不在范围（band_lock 本就只覆盖 A 股）。
