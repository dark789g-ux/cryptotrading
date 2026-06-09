# 05 · 自校验、交叉验证与 Phase 2 回迁

← 返回 [index](./index.md)　|　上一篇 [04 扫描与护栏](./04-grid-sweep-guardrails.md)　|　下一篇 [06 种子](./06-seed-hypotheses.md)

## 1. 自校验锚点（Phase 1 内置闸门）

harness 启动时先跑一遍**复现配置**，结果须落在锚点容差内，否则**中止并报口径错误**，不输出任何"上界"结论：

```text
复现配置: base=KDJ_J<-10, exit=fixed_n(1), universe=全市场, 信号枚举末端=20260515
期望:     Kelly ≈ 0.171   n ≈ 80276   胜率 ≈ 0.5453   b ≈ 1.214
容差:     n 偏差 < 1%（停牌/退市边界可致微小差异）
          Kelly 绝对偏差 < 0.005   胜率/b ±0.02
```

- 对齐 → 证明 T+1 买入 / qfq 复权 / 停牌跳过 / 次新/涨停/退市过滤的重实现正确，后续结果可信。
- 不对齐 → 按 `systematic-debugging`：先加日志看真实 ret 分布与样本数差异，逐项比对 [01 §4](./01-architecture-dataflow.md#4-与现有-simulator-的口径对齐硬要求) 的口径，**禁止**跳过自校验直接信任扫描结果。
- **信号枚举末端必须用 `20260515`**：这是锚点 run（2026-06-08 创建）当时的有效数据边界。若用更晚的 `date_end`（如 20260531 或全区间默认值），会把锚点跑时尚不存在的尾部增量真实信号纳入枚举，使 n/Kelly 偏离锚点——**这是数据快照差异，不是 bug**，不要为此放宽容差。路径加载 `date_end` 可略晚（用 20260531），给 buy_date 接近边界的信号留出后向窗口（fixed_n 需 buy_date 之后至少 1 个可交易日），与锚点 run 行为一致。
- **容差与端点说明**：复现区间故意取与锚点 run 同口径（信号末端 20260515），与扫描默认验证集的更晚终点无关，勿混淆。`Kelly 绝对偏差 <0.005`（约占基线 3%）是按停牌/退市边界差几十笔的经验上限设的；**对齐后仍须人工核对 ret 分布与样本数，不能仅看 Kelly 落入区间就放行**——容差能容下的口径漂移并非都无害。

## 2. 一致性检查（实现期）

- `test_kelly_metrics.py`：用构造样本锁 p/b/Kelly/PF 与 `signal-stats.metrics.ts` 逐值一致。
- `test_exits_*.py`：针对每种出场结构构造路径，断言触发位 / 止损优先 / 跳空 / maxHold / 退市 的 exit_price 与 exit_reason。
- 自校验作为 integration test（需 DB），可标记 slow / 手动触发。

## 3. Phase 2 · 赢家回迁 NestJS（可选，按 Phase 1 结果再启）

仅当 Phase 1 跑出**验证集凯利显著超过 0.171 且 CI 下界为正**的少数组合时才值得回迁。

### 3.1 范围

1. **出场结构落成真 `ExitConfig` 模式**：在 `signal-stats.simulator.ts` 扩展 `ExitConfig` 联合类型，新增 `tp_sl` / `trailing` / `atr_stop`（仅落地 top-K 实际用到的）；`signal_test` 表加对应配置列（migration `*.sql` + 配套 `.ps1`，遵循 CLAUDE.md DB 调整规范）。
2. **新买入字段注册**：把 top-K 用到的入场特征（如 `dev_ma5` / `down_streak` / `vol_contract` / `rs_vs_index`）注册进 `strategy-conditions.types.ts` 字段映射；能用现有列/SQL 表达的直接加，需派生计算的评估代价后决定是否物化列。
3. **建方案 + 跑**：在前端 `/signal-stats` 建这几个赢家方案，经现有 runner 跑出 `signal_test_run`，进 UI 长留。
4. **exit_reason 取值扩展**：`signal_test_trade.exit_reason` 增加 `tp/sl/trailing/atr`（见 [03 §9](./03-exit-structures.md#9-exit_reason-取值集phase-1-扩展)）。

### 3.2 交叉验证（双引擎对账）

- Phase 2 NestJS 跑出的赢家方案指标，与 Phase 1 Python 数字**逐项对账**（同区间、同 universe、同 `same_day_rule=sl_first`）。
- 容差：Kelly 绝对偏差 < 0.005、n 偏差 < 1%。
- **对不上即暴露 bug**（两套实现至少一处口径错）——符合本仓库数据完整性文化，比单引擎"自说自话"更可信。
- 出场盘中口径（触发位 / 止损优先 / 跳空 / exit_price≠close）两侧必须完全一致，这是最易分叉处，重点核对。

### 3.3 Phase 2 不做的事

- 不引入费率/滑点（仍是研究口径；若未来要实盘候选另开 spec）。
- 不做仓位管理 / 凯利下注联动（凯利仍只是统计输出）。
- 不做自动扫描接口（扫描留在 Python 侧；NestJS 只跑被选中的少数赢家）。

## 4. 交付边界

- **Phase 1 = 本 spec 的交付重心**：可独立验收（自校验通过 + 帕累托前沿 + top-K 报告）。
- **Phase 2 = 可选续作**：Phase 1 出结果后，由用户决定是否回迁，回迁清单见 §3。两阶段之间是清晰的 gate，不绑定。
