# 02 · 数据模型与迁移

← 返回 [index](./index.md) ｜ 上一篇 [01 架构](./01-architecture-and-scope.md)

## 1. 新表 `factors.strategy_definitions`

镜像 `factors.label_definitions`（出处 `20260605_0001_label_definitions.py`）的结构与版本模型。

| 列 | 类型 | 约束/默认 | Entity 属性 | 说明 |
|---|---|---|---|---|
| `strategy_id` | VARCHAR(64) | NOT NULL, PK(1) | `strategyId` | 如 `default_exit` |
| `strategy_version` | VARCHAR(16) | NOT NULL, PK(2) | `strategyVersion` | 如 `v1` |
| `name` | TEXT | NOT NULL | `name` | 如 "默认出场策略" |
| `exit_rules` | JSONB | NOT NULL, DEFAULT `'[]'` | `exitRules` | 规则列表（见 §2） |
| `description` | TEXT | nullable | `description` | 中文描述 |
| `enabled` | BOOLEAN | NOT NULL, DEFAULT TRUE | `enabled` | 前端选择器只列 enabled |
| `display_order` | INTEGER | NOT NULL, DEFAULT 0 | `displayOrder` | 前端排序 |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | `createdAt` | 时间列一律 timestamptz |

- 复合主键 `(strategy_id, strategy_version)`。
- 索引 `ix_strategy_definitions_enabled (enabled)`（前端按 enabled 筛）。
- DB **不加** `exit_rules` 的 CHECK 约束（单一真相源在 Python `build_exit_rules` + NestJS DTO，
  与 label_definitions 同理，避免三处真相源）。

## 2. `exit_rules` JSON schema

数组，**first-match**（列表顺序即优先级，当日按序判定，命中即出场）。每元素 `{type, params}`：

```text
[
  { "type": "stop_loss",     "params": { "pct": 0.08 } },
  { "type": "ma_break",      "params": { "period": 5 } },
  { "type": "max_hold",      "params": { "days": 20 } },
  { "type": "take_profit",   "params": { "pct": 0.15 } },
  { "type": "trailing_stop", "params": { "pct": 0.10 } }
]
```

| type | params | 语义 | 映射 Python Rule | exit_reason |
|------|--------|------|------------------|-------------|
| `stop_loss` | `{pct: float∈(0,1)}` | 当日 low_adj ≤ 入场价×(1−pct) | `StopLossRule(threshold=-pct)` | `stop_loss` |
| `ma_break` | `{period: int∈[2,250]}` | 当日 close_adj < MA(period) | `MABreakRule(period)`（由 MA5BreakRule 泛化） | `ma5_break`† |
| `max_hold` | `{days: int∈[1,250]}` | 持仓满 days 个交易日 | `MaxHoldRule(max_days=days)` | `max_hold` |
| `take_profit` | `{pct: float∈(0,5]}` | 当日 high_adj ≥ 入场价×(1+pct) | `TakeProfitRule(pct)`（新增） | `take_profit`（新增） |
| `trailing_stop` | `{pct: float∈(0,1)}` | close_adj ≤ 持仓期峰值×(1−pct) | `TrailingStopRule(pct)`（新增） | `trailing_stop`（新增） |

校验约束（NestJS DTO + Python build_exit_rules 双层，见 [04](./04-backend-nestjs.md) / [03](./03-python-pipeline.md)）：
- 数组非空。
- **必含且仅含一条 `max_hold`**（终止条件保证，防无限持仓；v1 每种 type 至多一条）。
- 各 params 按上表范围校验；越界 raise（禁夹取）。

† **exit_reason 字面量保持 `"ma5_break"` 不变**（即便 period≠5）：`exit_rules.py:42-46` 注明
  reason 字符串被回测引擎读取、禁改名。period 仅改 MA 窗口，reason 仍标识「MA 跌破」规则族。
  这是刻意的兼容取舍，已在 [03](./03-python-pipeline.md#ma_break-泛化) 标注。

### 2.1 stop_loss 的符号约定

前端/DB 存**正数** `pct`（如 0.08 表示 -8% 止损，直觉友好）；
`build_exit_rules` 转成 `StopLossRule(threshold = -pct)`（`StopLossRule` 要求 threshold<0，
出处 `exit_rules.py:141-144`）。take_profit / trailing_stop 同理存正数 pct。

## 3. 不可变版本模型（D5）

与 label_definitions 一致：
- `(strategy_id, strategy_version)` 复合 PK，同 id 多版本并存。
- **PATCH 只允许改展示字段**：`name / description / enabled / display_order`。
- **语义字段 `exit_rules` 不可改**：要换规则 → POST 新版本（`v1`→`v2`）。
- 理由：`exit_rules` 直接决定标签 value；若可原地改，引用该策略的历史 `factors.labels`
  会与定义不一致 → 不可复现。版本不可变 = 标签可复现的前提。

## 4. scheme 编码

`factors.labels` PK 含 `scheme`（`runner.py:241`），多策略必须按 id+版本区分，否则串味。
沿用 `base_scheme_codec` 既有 legacy-alias 套路（`dir3_scheme.py:122-158`）：

```text
base_scheme_codec("strategy_aware", { strategy_id, strategy_version }):
   strategy_id=="default_exit" and strategy_version=="v1"
        ──▶ "strategy-aware"                 # legacy 别名，守历史数据不漂移
   其它 id@ver
        ──▶ "strategy-aware__{id}_{ver}"     # 决定性、可复现
              例: my_tight@v1 → "strategy-aware__my_tight_v1"
```

- id+版本不可变 → scheme 是其决定性函数，无需把 exit_rules 内容编进 scheme。
- 串内分隔用 `__` 与 `_`（id/version 限 `[a-z0-9_]` / `v\d+`，无歧义）。
- 长度：`strategy-aware__` + ≤64 + `_` + ≤16 ≈ ≤100 字符，`factors.labels.scheme` 为
  文本列，容纳无虞（实现时确认列宽，见 [06](./06-testing-and-tasks.md)）。

## 5. Alembic 迁移（单个 migration，置于 quant-pipeline）

迁移文件 `apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/2026XXXX_0001_strategy_definitions.py`，
`down_revision` 指向当前 head（实现时 `alembic heads` 确认；注意
[[project_alembic_drift]] 教训：补 migration 后须先 `stamp` 对齐再 `upgrade`）。

`upgrade()` 三段（**不 import quant_pipeline 包，凝固历史**，与 label 迁移同风格）：

**A. 建表 + 索引**
```sql
CREATE TABLE factors.strategy_definitions (
    strategy_id      VARCHAR(64)  NOT NULL,
    strategy_version VARCHAR(16)  NOT NULL,
    name             TEXT         NOT NULL,
    exit_rules       JSONB        NOT NULL DEFAULT '[]',
    description      TEXT,
    enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
    display_order    INTEGER      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (strategy_id, strategy_version)
);
CREATE INDEX ix_strategy_definitions_enabled ON factors.strategy_definitions (enabled);
```

**B. 灌种子 `default_exit@v1`**（值 = 现写死规则，已核对 `exit_rules.py:38-40`）
```text
strategy_id      = "default_exit"
strategy_version = "v1"
name             = "默认出场策略"
exit_rules       = [
    { "type": "stop_loss", "params": { "pct": 0.08 } },   # STOP_LOSS_THRESHOLD=-0.08
    { "type": "ma_break",  "params": { "period": 5 } },   # MA_WINDOW=5
    { "type": "max_hold",  "params": { "days": 20 } }     # MAX_HOLD_DAYS=20
]
description      = "T+1 入场、规则出场（止损-8% / 跌破MA5 / 最大持仓20日）"
display_order    = 10
```
INSERT 用参数化 + `CAST(:exit_rules AS jsonb)`（`json.dumps(..., ensure_ascii=False)`），
与 label 迁移 `:137-168` 一致。

**C. 改写现有标签种子的 base_params**（强引用，D3/D7）
```sql
UPDATE factors.label_definitions
SET base_params = CAST('{"strategy_id":"default_exit","strategy_version":"v1"}' AS jsonb)
WHERE label_id = 'strategy_aware_default' AND label_version = 'v1'
  AND base_params = CAST('{"max_hold_days":20}' AS jsonb);   -- 幂等护栏：只改未迁移的
```

`downgrade()` 对称：还原 label 种子 base_params 为 `{"max_hold_days":20}`，删索引、删表。

## 6. 数据连续性

- **历史 `factors.labels`（scheme='strategy-aware'）无需重算**：default_exit@v1 映射回
  `"strategy-aware"`，旧数据原样有效、PK 不变。
- 新建的非 default 策略 → 新 scheme → 首次跑 label job 才产数（增量，不影响存量）。
- 标签种子改写后，前端「固定策略收益」标签训练入口走的 base_params 变成策略引用，
  Python `_validate_params` 相应改造（见 [03](./03-python-pipeline.md#接线)）。
