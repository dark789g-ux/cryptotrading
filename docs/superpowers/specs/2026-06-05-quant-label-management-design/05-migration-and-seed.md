# 05 · DB Migration 与种子标签

← 回到 [index.md](./index.md)

## 只有一个表需要建

```text
factors.label_definitions   ← 新建（唯一的 DDL 变更）+ 种子 INSERT
factors.labels              ← 表结构不动（scheme 写入值语义变，历史行保留）
factors.feature_sets        ← 表结构不动（scheme 列同理）
```

表结构见 [01-overview-and-data-model.md](./01-overview-and-data-model.md#新表-factorslabel_definitions)。

## 新表 DDL（Alembic，归 quant-pipeline 管的 factors schema）

```text
CREATE TABLE factors.label_definitions (
  label_id        varchar(64)  NOT NULL,
  label_version   varchar(16)  NOT NULL,
  name            text         NOT NULL,
  base_type       text         NOT NULL,          -- 不加 CHECK 枚举
  base_params     jsonb        NOT NULL DEFAULT '{}',
  classify_mode   text,                            -- nullable: NULL = 连续/回归
  classify_params jsonb        NOT NULL DEFAULT '{}',
  description     text,
  enabled         boolean      NOT NULL DEFAULT true,
  display_order   integer      NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (label_id, label_version)
);
CREATE INDEX ix_label_definitions_enabled_base
  ON factors.label_definitions (enabled, base_type);
```

`created_at` 用 `timestamptz`（项目规则：时间列一律 timestamptz）。

## 种子标签（覆盖原 4 个 scheme 的典型用法，开箱即用平滑过渡）

| label_id | name | base_type | base_params | classify_mode | classify_params |
|---|---|---|---|---|---|
| `strategy_aware_default` | 固定策略收益 | `strategy_aware` | `{"max_hold_days":20}` | NULL | `{}` |
| `fwd_5d_ret` | 5日涨跌幅 | `fwd_ret` | `{"horizon":5}` | NULL | `{}` |
| `next_day_band05` | 次日涨跌·横盘±0.5% | `fwd_ret` | `{"horizon":1}` | `band` | `{"eps":0.005}` |
| `next_day_tercile` | 次日涨跌·截面三分位 | `fwd_ret` | `{"horizon":1}` | `tercile` | `{}` |

种子行放在创建表的同一 migration 的 `upgrade()` 末尾 INSERT；`downgrade()` 连表一起删
（参照 `factor_definitions` 的"硬编码 INSERT、不在 migration 内 import quant_pipeline 包"惯例）。

> ⚠ **硬编码事实必落源头核对（项目数据完整性规则）**：上表 `eps:0.005`、`horizon:5`、
> `max_hold_days:20` 是写进种子数据的硬编码值，实施时**必须 grep Python 源逐个核对**——
> `dir3_scheme.py` 的 `LEGACY_EPS`、`fallback.py` 默认 horizon、`strategy_aware.py` 的
> `MAX_HOLD_DAYS`——**不得凭本文档或子代理转述直接写**，否则种子标签语义与历史训练不一致。

## ⚠ Alembic 版本脱节——实施前强制前置步骤

项目当前 **alembic current 落后于 head**（`20260525~0529` 的 DDL 是手动应用、没走
alembic），且工作区有未跟踪的新 migration：

```text
?? apps/quant-pipeline/.../versions/20260604_0001_drop_legacy_jobs_run_type_check.py
```

新 migration **不能写完直接 `upgrade head`**，会撞"对象已存在"或 revision 链分叉。
实施第一步必须：

```text
1. alembic current / alembic heads / alembic history   ── 摸清真实 revision 链
2. 确认未跟踪的 20260604_0001 文件：是否已 apply？是不是当前 head？
3. 若 DB 实际状态领先于 alembic 记录 → 先 alembic stamp <对应 revision> 对齐
4. 新 migration 的 down_revision 挂到正确的【单一 head】上（避免多 head 分叉）
5. 才 alembic upgrade head
```

新 migration 文件名示意 `20260605_0001_label_definitions.py`，`down_revision` **以第 1~2 步
摸清的实际 head 为准**，不在本文档写死。

## 验证 SQL（migration 跑完后）

CLAUDE.md 要求 DB schema 调整随附 `docker exec` 脚本。主路径走 Alembic，附验证脚本：

```text
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  \d factors.label_definitions
  SELECT label_id, base_type, base_params, classify_mode, classify_params
  FROM factors.label_definitions ORDER BY display_order, label_id;
"
-- 期望: 4 条种子行，base_params/classify_params 与上表逐一吻合
```
