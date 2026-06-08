# 01 · 架构与数据流（Phase 1 harness）

← 返回 [index](./index.md)

## 1. Phase 1 数据流（六段 pipeline）

```text
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1  Python 研究 harness (apps/quant-pipeline)               │
│                                                                   │
│  ① 信号枚举        raw.daily_indicator → (ts_code, signal_date)   │
│     base 触发(如 KDJ_J<阈值) + 过滤次新/买入日停牌/一字涨停        │
│            │                                                      │
│            ▼                                                      │
│  ② 前向路径加载    raw.daily_quote → 每信号 buy_date(T+1) 起        │
│     未来 ≤maxWindow 可交易日 qfq O/H/L/C 序列(停牌跳过) → 缓存      │
│            │                                                      │
│            ▼                                                      │
│  ③ 入场特征计算    超跌幅度/连阴/缩量/波动区制/RS… 附到每个信号     │
│            │                                                      │
│            ▼                                                      │
│  ④ 出场模拟(纯函数) 路径 × 出场参数 → exit_date/price/ret/reason   │
│     fixed_n │ tp_sl │ trailing │ atr_stop                         │
│            │                                                      │
│            ▼                                                      │
│  ⑤ 网格聚合        入场变体 × 出场参数 → p,b,Kelly,PF,n            │
│     训练集调参 / 验证集报样本外 + bootstrap CI                     │
│            │                                                      │
│            ▼                                                      │
│  ⑥ 输出   ① 信号数↔凯利 帕累托前沿  ② top-K 排行  ③ 自校验报告     │
└─────────────────────────────────────────────────────────────────┘
```

各段职责：

- **① 信号枚举**：给定 base 入场触发（如 `KDJ_J < 阈值`），从 `raw.daily_indicator` 锚定每个 SSE 交易日 T 扫出 `(ts_code, signal_date)`。复用现有 `enumerator` 的 SQL 思路（见 [§4](#4-与现有-simulator-的口径对齐硬要求)）。**base 触发要足够宽**（如 `KDJ_J<0`），把"收紧"留给③的特征阈值，这样一次路径加载可服务多个入场变体。
- **② 前向路径加载**：对每个信号取 `buy_date = T 之后第一个 SSE 交易日`，加载 `buy_date` 起未来 ≤ `maxWindow`（默认 20）个**可交易日**的 qfq O/H/L/C 序列；停牌日跳过、不占额度。结果缓存（parquet），后续④反复复用。
- **③ 入场特征计算**：对每个信号在 `signal_date` 截面计算附加特征（见 [02](./02-entry-features.md)），落成信号宽表的列。入场"变体"= 在这些列上加阈值过滤的组合。
- **④ 出场模拟**：纯函数，输入 (前向路径, 出场参数)，输出 `exit_date / exit_price / ret / hold_days / exit_reason`（见 [03](./03-exit-structures.md)）。
- **⑤ 网格聚合**：对每个 (入场变体 × 出场参数) 子集算指标（见 [04](./04-grid-sweep-guardrails.md)）。
- **⑥ 输出**：帕累托前沿 + top-K 排行 + 自校验报告（见 [04 §6](./04-grid-sweep-guardrails.md#6-输出物) / [05](./05-validation-phase2.md)）。

## 2. 数据源（均已核对，见 [index §6](./index.md#6-已核对的事实锚点实现时直接信任禁止再凭二手转述改写)）

| 用途 | 表 / 列 |
|---|---|
| base 信号枚举 | `raw.daily_indicator`（kdj_j/macd/ma*/atr_14…） |
| 前向价格路径 | `raw.daily_quote`（`qfq_open/high/low/close/pre_close/qfq_pct_chg`） |
| 缩量 / 量比 / 市值 | `raw.daily_quote.vol`、`raw.daily_basic`（turnover_rate/volume_ratio/total_mv…） |
| RS 基准（宽基） | `public.ths_index_daily_quotes`（`883300.TI`/`883304.TI`/…，仅 2024-01-02 起） |
| RS 基准（行业） | `public.ths_index_daily_quotes`（type I）+ `public.ths_member_stocks` 映射 |
| 交易日历 | 复用现有 SSE 交易日来源（与 `enumerator`/`simulator` 同源，勿自造） |

## 3. 模块落点（贴合 quant-pipeline 既有结构）

现有结构：`src/quant_pipeline/{config,db,sync,strategy,features,training,worker,utils}`，技术栈 SQLAlchemy + psycopg2 + pydantic + alembic + rich。提议新增**研究模块**，按职责拆小文件（单文件 ≤500 行，遵循 `.claude/rules/code-organization.md`）：

```text
src/quant_pipeline/research/kelly_sweep/
├─ __init__.py
├─ config.py          # pydantic 配置模型：区间/切分/样本下限/网格/RS基准/maxWindow
├─ enumerate.py       # ① 信号枚举（base 触发 + 过滤）
├─ paths.py           # ② 前向路径加载 + parquet 缓存
├─ entry_features.py  # ③ 入场特征计算（dev_ma/down_streak/vol_contract/vol_regime/rs）
├─ exits.py           # ④ 出场结构纯函数（fixed_n/tp_sl/trailing/atr_stop）
├─ metrics.py         # ⑤ 指标聚合（p/b/Kelly/PF/n + bootstrap CI），口径锁定与 TS 版一致
├─ sweep.py           # ⑤ 网格编排：入场变体 × 出场参数
├─ report.py          # ⑥ 帕累托前沿 / top-K 排行 / 自校验报告
└─ cli.py             # 入口：参数解析 → 跑 sweep → 落输出
tests/
├─ unit/test_kelly_metrics.py     # 锁 Kelly/胜率/盈亏比口径与 TS 版一致
├─ unit/test_exits_*.py           # 锁出场触发/止损优先/跳空/maxHold
└─ integration/test_self_check.py # 自校验锚点（见 05）
```

> 是否落 DB 结果表：Phase 1 默认输出为文件（parquet/CSV/Markdown）。如需长留，可在 Phase 2 一并设计结果表 + alembic migration（不在 Phase 1 范围）。

## 4. 与现有 simulator 的口径对齐（硬要求）

Phase 1 是对现有 NestJS simulator 的**受控重实现**，以下口径**必须逐条比对现有实现后复刻**（实现时 grep 核对，勿照本文转述写死）：

| 口径 | 现有实现 | Phase 1 要求 |
|---|---|---|
| 买入日 | T 之后第一个 SSE 交易日的 `qfq_open` | 一致 |
| 停牌日 | `hasQuote=false` 跳过、不占额度（`simulator.ts:239`） | 一致 |
| 次新股 | 上市 < 60 交易日过滤 | 一致 |
| 一字涨停 | 买入日一字涨停过滤（用未复权 open 判定） | 一致 |
| 退市 | `delistDate >= calDate` 取上一有效日 qfq_close 强平，`exit_reason='delist'` | 一致 |
| fixed_n 出场 | 第 N 个可交易日 qfq_close，`exit_reason='max_hold'` | 一致（用于自校验复现） |

**自校验闸**：harness 用 `base=KDJ_J<-10` + `fixed_n(1)` + 全市场 2023-01~2026-05 跑一遍，凯利须 ≈ 0.171、n ≈ 80276（容差内），对齐才信任后续结果——否则先查 T+1 / 复权 / 停牌口径，详见 [05 §1](./05-validation-phase2.md#1-自校验锚点phase-1-内置闸门)。

## 5. 性能与规模

- `KDJ_J<0` 全市场 2023–2026 约 40 万信号；`maxWindow=20` 时路径缓存约 40万×20 行的 qfq OHLC，pandas 内可承载（按需分批/列存）。
- 一次路径缓存服务所有出场参数网格点（出场是路径上的纯函数），**避免每个组合重扫 DB**——这是选 Python 而非 NestJS 扫网格的核心理由。
- 入场变体通过对**已计算的特征列**加阈值掩码生成，不重算路径。
