# 02 · 总体流水线、决策门与硬不变量

[← 返回 index](./index.md) · 上一篇 [01 背景与现状](./01-context-and-state.md) · 下一篇 [03 量化探查](./03-measure-and-calibrate.md)

## 总体流水线

整个任务是一条**带硬门的单向流水线**：先跑只读探查，到决策门停下报数据由用户拍板，批准后才动 prod。

```text
阶段0 前置校验(只读)                                  详见 05
  ├ 重查真DB现状(范围可能已变,不硬编码dmax)
  ├ 确认代码树在 6779c79+ (驱动用 uv run python 直调,非 worker)
  ├ 删 __pycache__ 防陈旧 .pyc
  └ 腾内存到 4–6G 空闲 / 确认 ml.jobs 无 in-flight、不触发 job
        │
        ▼
阶段1 量化探查 + chunk校准   ★唯一安全网(不备份)        详见 03
  ├ 临时 scheme 用新码月度增量重算探查窗口
  ├ 逐行 diff vs 生产: only_in_old / value/exit_reason/hold_days
  ├ 实测单月 RSS → 锁定 chunk 粒度(月/季/双周)
  └ 自证"月度驱动 == 单次整段"(临时 scheme 上)
        │
        ▼
┌─────────────────────────────────────────────┐
│  ★决策门  把每个 scheme 的真实差异规模摆给用户 │
│  逐 scheme 决定: 重算 / 跳过 / 仅其一          │
└─────────────────────────────────────────────┘
        │ (批准后, 且仅对批准的 scheme)
        ▼
阶段2 labels 重算   fwd_ret_h1(轻,探路) → strategy-aware  详见 04
  └ DELETE 整scheme → 月度幂等循环(date_range.start 恒=20230103)
        │
        ▼
阶段3 feature_matrix 重建   DELETE 对应fs → 月度重建(同fs指纹) 详见 04
        │
        ▼
阶段4 模型评估/重训   训新shadow → 比OOS → 用户定promote      详见 04
        │
        ▼
阶段5 验证   抽样 + 无幽灵行 + 行数对齐 + pytest 941绿         详见 05
```

## 两条硬不变量

违反任一条即"本系列修过的 bug 反向重现"：

1. **`date_range.start` 恒传全区间起点 `20230103`** —— 月度推进时绝不传当月 1 号，否则 `g0_load` 夹不回上月、月初 MA=NaN、口径错（窗口依赖反向重现）。机制见 [04#阶段2labels-重算](./04-recompute-and-cascade.md#阶段2labels-重算)。
2. **DELETE 必须先于重算** —— `_upsert` 不删行 + bug3 新码产出更少行 → 不删就留幽灵旧行。labels 与 feature_matrix 两处都要。DELETE 是唯一不可逆步、独立确认。

## 决策门判据

探查产出报告（见 [03](./03-measure-and-calibrate.md)）后，**逐 scheme** 把数据摆给用户：

```text
            ┌──────────── 决策门:每个 scheme 一张表 ────────────┐
            │ only_in_old   (被新码正确剔的幽灵行,主要 bug3)     │
            │ only_in_new   (预期≈0,新码只剔不增)               │
            │ value 变更行   (bug1/bug4)                         │
            │ exit_reason 变更 / hold_days 变更                  │
            │ 外推总变更行数 / 占比                              │
            └───────────────────────────────────────────────────┘
                       │
        ┌──────────────┼───────────────┐
   差异可忽略        差异可观         借口判断
   (<0.05% 且无    (>阈值或次新股   摆数字
    系统性错判)     系统性错判)      用户拍板
        │               │
     可选跳过该       重算该 scheme
     scheme,不动 prod
```

- 默认阈值（建议，非强制，最终用户在门口定）：某 scheme 总变更 **<0.05% 且无次新股系统性错判** → 可选跳过，不值当为这点动 prod 底座；否则重算。
- **prod 底座特殊对待**：strategy-aware 被 live 模型 lgb-lambdarank 依赖，即使差异小，是否重算也由用户显式确认。
- 决策门是**人工门**：脚本停在此、打印报告、等待用户逐 scheme 指令，不自动续跑。

## 范围边界

- 只重算两个 scheme 的**现有区间**：strategy-aware `[20230103, 真实dmax]`、fwd_ret_h1 `[20230103, 真实dmax(≈20241231)]`。
- **不扩展 fwd_ret_h1 覆盖**（它停在 20241231 是另一回事，扩范围是独立任务，不在本 spec）。
- 模型阶段默认"评估"，重训与 promote 由用户拍板（见 [04#阶段4](./04-recompute-and-cascade.md#阶段4模型评估重训)）。
