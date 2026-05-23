# 01 · 数据库 Schema

← 回到 [index.md](./index.md)

## 表结构

```text
factors.factor_definitions
┌────────────────────────┬──────────────────────┬──────────────────────────┐
│ 列                     │ 类型                 │ 说明                     │
├────────────────────────┼──────────────────────┼──────────────────────────┤
│ factor_id              │ varchar(64)          │ PK                       │
│ factor_version         │ varchar(16)          │ PK，当前唯一值 'v1'      │
│ description            │ text                 │ 中文短描述               │
│ formula                │ text NULL            │ 计算表达式（仅供阅读）   │
│ data_source            │ text[] NULL          │ 用到的底层列/表（仅阅读）│
│ category               │ varchar(32)          │ price/industry/          │
│                        │                      │ fundamental/mixed        │
│ pit_window_days        │ int                  │ lookback 天数 (1..400)   │
│ pit_anchor             │ varchar(16)          │ trade_date / ann_date    │
│ enabled                │ bool DEFAULT true    │ 启停                     │
│ display_order          │ int DEFAULT 100      │ 前端排序                 │
│ updated_at             │ timestamptz          │ NestJS 写入时刷新        │
│ updated_by             │ varchar(64) NULL     │ 修改人 user uuid         │
└────────────────────────┴──────────────────────┴──────────────────────────┘
PK: (factor_id, factor_version)
INDEX: (enabled, category) 用于前端筛选
```

## 字段约束

- `factor_version`：与 `factors.daily_factors` / `factors.feature_sets` 已有字符串字段对齐，当前唯一值 `'v1'`
- `pit_window_days`：CHECK `1 <= pit_window_days <= 400`
- `pit_anchor`：CHECK `IN ('trade_date', 'ann_date')`，对应 [02-pipeline-refactor.md](./02-pipeline-refactor.md) `base.py` 默认值
- `category`：CHECK `IN ('price', 'industry', 'fundamental', 'mixed')`
- `formula` / `data_source`：可 NULL，仅供阅读，不影响计算

## 初始化 Migration（方案 a：硬编码 INSERT）

**文件位置**：`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260524_0001_factor_definitions.py`

**步骤**：

1. `CREATE SCHEMA IF NOT EXISTS factors;`（若不存在）
2. `CREATE TABLE factors.factor_definitions (...)` 含上表列、PK、CHECK、INDEX
3. `INSERT INTO factors.factor_definitions VALUES (...)`，16 个元组**人工抄写自当前 registry 类属性**

**为什么不在 migration 中 import quant_pipeline 包**：

- migration 应是"凝固历史"，代表 2026-05-23 灌入的快照
- 未来若因子目录结构重构（如 `factors/price/` → `factors/equity/`），import 路径变化会让历史 migration 报错

**`formula` / `data_source` 初值策略**：

- 当前 `description` 已含部分公式（如 `"20 日动量 close_adj(T) / close_adj(T-20) - 1"`）
- 在 migration 内人工拆分：description 仅留中文短名（如 "20 日动量"），公式部分挪到 `formula`
- 拆不出的留 `NULL`，由后续维护者通过前端只读字段对照代码补全

**初始 `updated_at`**：`NOW()`
**初始 `updated_by`**：`NULL`（标识"系统初始化"）

## 验证 SQL（migration 跑完后）

```sql
-- 行数检查
SELECT COUNT(*) FROM factors.factor_definitions WHERE factor_version = 'v1';
-- 期望: 16

-- 启用因子集合对齐当前 list_active 输出
SELECT factor_id FROM factors.factor_definitions
WHERE factor_version = 'v1' AND enabled = true ORDER BY display_order, factor_id;

-- 索引存在性
\d factors.factor_definitions
```

## 跨表关系

- **不**在 `daily_factors` / `feature_sets` 与本表之间加外键约束——`factor_version` 是字符串契约，避免历史数据迁移负担
- `feature_sets.factor_ids[]` 在新 feature_set 创建时由 builder.py 从 `list_active()` 输出填充（详见 [02-pipeline-refactor.md](./02-pipeline-refactor.md)）
