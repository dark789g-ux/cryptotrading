# 04 · 网格扫描 + 过拟合护栏 + 输出

← 返回 [index](./index.md)　|　上一篇 [03 出场](./03-exit-structures.md)　|　下一篇 [05 验证与回迁](./05-validation-phase2.md)

## 1. 网格结构

```text
入场变体集合 V = { base阈值 × 附加特征阈值组合 }      (见 02)
出场参数集合 E = { fixed_n, tp_sl(TP×SL×maxHold),     (见 03)
                   trailing(Z×maxHold), atr_stop(k×maxHold) }

扫描 = 对每个 (v, e) ∈ V × E:
        信号子集 = 全信号在 v 掩码下的子集
        逐信号在缓存路径上跑 e → ret 序列
        → 指标(v,e) = 聚合(ret 序列)   (见 §3)
```

> 规模控制：`max_entry_filters`（默认 2）限制 V 维度；E 的网格点用上面候选即约 `5 + 4×3×3 + 3×2 + 3×2 = 53` 个出场配置。V 视 base 与特征数而定，实现时 `log` 出"本次扫描 V×E 组合总数"，超阈值（如 >5000）须显式确认而非静默跑（防组合爆炸 + 多重检验过拟合）。

## 2. 指标口径（与 TS 版严格一致）

逐字复刻 `signal-stats.metrics.ts`（[index §6](./index.md#6-已核对的事实锚点实现时直接信任禁止再凭二手转述改写)），`test_kelly_metrics.py` 锁死：

```text
N        = 样本数(有效 ret 笔数)
wins     = #{ret > 0}                 # ret==0 不计 win/loss，但计入 N
p        = wins / N                    # 胜率
avgWin   = mean(ret | ret>0)
avgLoss  = mean(ret | ret<0)           # 负数
b        = avgWin / |avgLoss|          # 盈亏比(payoff)，无亏损样本→null
PF       = Σ(ret|ret>0) / |Σ(ret|ret<0)|
Kelly f* = p − (1−p)/b      (b>0 时；否则 null)
```

## 3. 过拟合护栏（核心——否则"上界"是拟合假象）

### 3.1 训练 / 验证时间切分（运行时可配）

```text
┌───────────────┬──────────────────────────┬───────────────────────────┐
│   训练集       │   2023-01-01 ~ 2024-12-31│  挑组合 / 调参，看 in-sample│
│   (默认)       │                          │                           │
├───────────────┼──────────────────────────┼───────────────────────────┤
│   验证集       │   2025-01-01 ~ 2026-06-08│  样本外，最终上报以此为准   │
│   (默认)       │                          │                           │
└───────────────┴──────────────────────────┴───────────────────────────┘
```

- 边界与是否启用切分 = 配置项 `train_range` / `valid_range`（pydantic）。
- **含 RS 变体**：训练起点 clamp 到 2024-01-02（[02 §3.3](./02-entry-features.md#33-数据时间约束硬约束)），报告标注。
- 主排序 = **验证集 out-of-sample Kelly**；in-sample Kelly 作对照列。两者背离大 = 过拟合信号，报告高亮。
- 可选 `mode=walk_forward`（滚动窗口）留作扩展，Phase 1 默认简单时间切分。

### 3.2 样本下限（"少信号"不退化成噪声的闸门）

- 配置 `min_samples`（默认 300，作用于**验证集**）。验证集 n < min_samples 的 (v,e) 标"样本不足"，**不参与 top-K 排名**，但仍在帕累托图中以灰点呈现（让用户看见被排除的高凯利小样本点）。

### 3.3 凯利置信度（bootstrap CI）

- 对进入 top-K 的 (v,e)，对验证集 ret 序列做 bootstrap 重采样（默认 1000 次），报 Kelly 的 95% CI。
- 报告主表给 `kelly_oos`、`kelly_ci_low`、`kelly_ci_high`；CI 下界 ≤ 0 的组合显式标注"不稳健"。

### 3.4 多重检验提示

扫了成百上千组合，最高凯利天然有上偏。报告须显式声明组合总数，并提示"top-K 的 in-sample 排名含选择偏差，以验证集 + CI 为准"。

> **护栏强度的诚实声明**：本 harness **不做**多重检验的统计校正（无 Bonferroni / FDR / deflated 类调整）；**样本外验证集 + 单组合 bootstrap CI 是唯一的定量偏差防线**，多重检验仅文字提示。这是"纯研究探索上界"定位下的有意取舍——读者勿把 top-K 的 in-sample 凯利当作无偏估计，最终结论须以验证集 + CI 下界为正为准。

## 4. 帕累托前沿（核心产出）

回答"少信号能换多高凯利"，画**信号数 ↔ 验证集凯利**的前沿：

```text
Kelly_oos
  ^
  │        ● 前沿点(更少信号/更高凯利)
  │      ●
  │    ●        ○ 被支配点
  │   ●   ○  ○
  │  ●  ○   ○   ○
  │ ●─────────────────── 现有基线 J<-10 fixed_n(1) ≈0.171
  └────────────────────────────────────────────▶ 样本数 n (log)
```

- **支配定义**：点 A 支配 B ⟺ `n_A ≤ n_B 且 kelly_A ≥ kelly_B`（目标：最小化 n、最大化 kelly_oos）且至少一项严格成立。**前沿 = 不被任何点支配的点集**。
- **按窗口分组出图**：含 RS 变体（≥2024 窗口）与不含 RS 变体（全 2023–2026 窗口）**各出一张前沿**，不混画——跨不同样本窗口比凯利无意义（见 [02 §3.3](./02-entry-features.md#33-数据时间约束硬约束)）。
- 基线 `J<-10 + fixed_n(1)` 作为水平参考线，直观看新组合是否真正越过 0.171。

## 5. 配置项汇总（pydantic）

| 配置 | 默认 | 说明 |
|---|---|---|
| `base_trigger` | `kdj_j < 0` | 信号枚举 base |
| `universe` | 全市场 | 或指定 ts_code 列表 |
| `max_window` | 20 | 前向最长可交易日 |
| `max_entry_filters` | 2 | 单变体最多附加特征数 |
| `train_range` / `valid_range` | 23-01~24-12 / 25-01~26-06 | 时间切分（含 RS 时训练起点 clamp） |
| `min_samples` | 300 | 验证集样本下限 |
| `bootstrap_iters` | 1000 | Kelly CI 重采样次数 |
| `same_day_rule` | `sl_first` | 同日双触发规则（[03 §5](./03-exit-structures.md#5-同日双触发止损优先保守)） |
| `rs_benchmark` | `hs300` | RS 基准，可多选 |
| `rs_lookback` | 5 | RS 回看天数 |
| `top_k` | 30 | 排行输出条数 |

## 6. 输出物

1. **帕累托前沿图**：Phase 1 先出数据表（n, kelly_oos, 是否前沿）；可视化用 ASCII 散点或导出 CSV 供前端/notebook 画（不在 spec 内嵌图片）。**前沿与下方 top-K 均按窗口分组（含 RS / 不含 RS）各出一份，不混画。**
2. **top-K 排行表**（CSV + Markdown）：列 = 入场变体描述 / 出场配置 / n / p / b / PF / kelly_is / kelly_oos / ci_low / ci_high / 是否前沿 / 窗口（标 RS clamp）。
3. **自校验报告**：基线复现结果 vs 锚点（见 [05](./05-validation-phase2.md)）。
