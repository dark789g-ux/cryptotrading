# 数据模型

## Schema 总览

```text
custom_index_definitions          ← 指数主表（1 行 = 1 个用户指数）
        │
        ├──< custom_index_weight_versions   ← 权重版本链（PIT）
        │           │
        │           └──< custom_index_members   ← 某版本的成分 + 权重快照
        │
        ├──< custom_index_daily_quotes      ← 合成日线 OHLCV
        ├──< custom_index_daily_indicators  ← MA/MACD/KDJ/BBI/砖图
        ├──< custom_index_money_flow        ← 等权聚合资金流
        └──< custom_index_amv               ← AMV 序列（0AMV 副图）
```

所有表位于 `public` schema。Migration 文件：`apps/server/src/migration/YYYYMMDD-create-custom-index.sql` + 同名 `.ps1`。

---

## custom_index_definitions {#custom_index_definitions}

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID NOT NULL | FK → `users.id`；所有查询必须带此过滤 |
| `ts_code` | VARCHAR(24) NOT NULL UNIQUE | `CUST.{8位hex}.U`，创建时生成 |
| `name` | VARCHAR(100) NOT NULL | 用户可见名称 |
| `description` | TEXT NULL | 可选描述 |
| `index_type` | VARCHAR(16) NOT NULL | `price` \| `total_return` |
| `base_date` | VARCHAR(8) NOT NULL | 基期 YYYYMMDD |
| `base_point` | NUMERIC(20,4) NOT NULL DEFAULT 1000 | 基点 |
| `weight_method` | VARCHAR(16) NOT NULL | `equal` \| `float_mv` \| `custom`（初始版本快照，后续版本可覆盖） |
| `status` | VARCHAR(16) NOT NULL DEFAULT 'pending' | 见状态机 |
| `compute_progress` | SMALLINT NULL | 0–100，job 运行时更新 |
| `compute_stage` | VARCHAR(64) NULL | 如 `quotes` / `indicators` / `money_flow` |
| `latest_job_id` | UUID NULL | FK → `ml.jobs.id` |
| `last_error` | TEXT NULL | 最近一次失败原因 |
| `created_at` | TIMESTAMPTZ NOT NULL | |
| `updated_at` | TIMESTAMPTZ NOT NULL | |

**索引**：`(user_id, updated_at DESC)`、`(status)` WHERE status IN ('pending','computing')

### status 状态机

```text
  pending ──worker pick──▶ computing ──success──▶ ready
      │                        │
      │                        └──failed──▶ failed
      │
      └──(编辑后重算)──▶ pending
```

- V1 **不**使用 `draft`：POST 创建即 `pending` 并 enqueue job
- `ready`：可查询 K 线/列表
- `failed`：保留定义，允许「重试计算」

---

## custom_index_weight_versions {#custom_index_weight_versions}

镜像 `index_weight` 版本链语义（参考 `index-weight.entity.ts`）。

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGSERIAL PK | |
| `custom_index_id` | UUID NOT NULL | FK → definitions |
| `effective_date` | VARCHAR(8) NOT NULL | 版本生效日 |
| `expire_date` | VARCHAR(8) NULL | NULL = 当前 active；非 NULL = 已封口 |
| `weight_method` | VARCHAR(16) NOT NULL | 该版本采用的权重方案 |
| `created_at` | TIMESTAMPTZ NOT NULL | |

**唯一约束**：`(custom_index_id, effective_date)`

### 版本切换规则

1. **首次创建**：插入 version `effective_date = base_date`（或用户指定的调仓生效日），`expire_date = NULL`。
2. **编辑保存**：若成分或权重变化 → 新 version `effective_date = 用户指定生效日`（≥ 下一交易日）；旧 active version 的 `expire_date = effective_date 的前一交易日`。
3. **无变化**：跳过版本插入，不触发重算。

---

## custom_index_members {#custom_index_members}

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGSERIAL PK | |
| `version_id` | BIGINT NOT NULL | FK → weight_versions |
| `con_code` | VARCHAR(20) NOT NULL | A 股 ts_code |
| `weight` | NUMERIC(20,10) NOT NULL | 权重比例 0–1，版本内总和 = 1 |

**唯一约束**：`(version_id, con_code)`

权重计算时点：版本 `effective_date` 当日收盘后（或 effective_date 最近可用交易日）的流通市值/等权规则。自定义权重由用户直接输入，服务端校验 Σweight = 1 ± 1e-6。

**成分数量限制**：V1 最少 2、最多 500（与 `index_weight` 宽基规模对齐）。

---

## custom_index_daily_quotes {#custom_index_daily_quotes}

| 列 | 类型 | 说明 |
|----|------|------|
| `custom_index_id` | UUID NOT NULL | |
| `trade_date` | VARCHAR(8) NOT NULL | |
| `open/high/low/close` | DOUBLE PRECISION | 合成点位 |
| `pre_close` | DOUBLE PRECISION | |
| `change` | DOUBLE PRECISION | close - pre_close |
| `pct_change` | DOUBLE PRECISION | |
| `vol_hand` | DOUBLE PRECISION NULL | Σ 成分 vol（手），参考展示 |
| `amount` | DOUBLE PRECISION NULL | Σ 成分 amount（千元） |
| `updated_at` | TIMESTAMPTZ NOT NULL | |

**唯一约束**：`(custom_index_id, trade_date)`

---

## custom_index_daily_indicators

结构对齐 `index_daily_indicators`：`MA5/MA30/MA60/MA120/MA240`、`K/D/J`、`DIF/DEA/MACD`、`BBI`、`brick_chart` JSON。由 **Python worker** 在 quotes 写入后计算（见 `./03-index-computation.md#indicators`）；验收时与 NestJS `indicators/` 同参数输入做 spot-check 对齐。

---

## custom_index_money_flow

| 列 | 类型 | 说明 |
|----|------|------|
| `custom_index_id` | UUID | |
| `trade_date` | VARCHAR(8) | |
| `net_amount` | DOUBLE PRECISION | 等权 SUM 成分 `money_flow_stocks.net_amount` |
| `buy_lg_amount` | DOUBLE PRECISION NULL | |
| `buy_md_amount` | DOUBLE PRECISION NULL | |
| `buy_sm_amount` | DOUBLE PRECISION NULL | |

PIT 成员筛选 SQL 模式（与 `aggregateIndex` 一致）：

```sql
JOIN custom_index_members m ON ...
JOIN custom_index_weight_versions v ON v.id = m.version_id
WHERE v.effective_date <= :trade_date
  AND (v.expire_date IS NULL OR v.expire_date >= :trade_date)
```

---

## custom_index_amv

| 列 | 类型 | 说明 |
|----|------|------|
| `custom_index_id` | UUID | |
| `trade_date` | VARCHAR(8) | |
| `amv` | DOUBLE PRECISION | Σ(close × volume) 成分 / index_close × 常数 |
| `amv_ma*` | DOUBLE PRECISION NULL | 可选，与 industry AMV 对齐 |

AMV 公式参考 `industry-amv.service.ts`：成分成交额之和除以指数收盘点位，用于 K 线 Modal 0AMV 副图。

---

## ts_code 生成规则

```text
CUST.{8位小写hex}.U

示例：CUST.a3f2b1c8.U
```

- 由 `id` 或随机 bytes 派生，创建后不可变
- 前端 `category` 固定传 `'custom'`（扩展 `IndexLatestRow.category` 联合类型）
- **不**注册进 `ths_index_catalog` / `sw_index_catalog`

---

## ml.jobs 扩展

新增 `run_type`：`custom_index_compute`

`ml.jobs.run_type` 为 VARCHAR（非 PG enum），migration **无需 ALTER TYPE**；worker `dispatcher.py` 与 NestJS `ALLOWED_RUN_TYPES` 各增 `'custom_index_compute'` 即可。

`params` schema：

```json
{
  "custom_index_id": "uuid",
  "user_id": "uuid",
  "full_rebuild": true
}
```

`full_rebuild=true`：清空该指数 quotes/indicators/money_flow/amv 后全量重算；编辑后默认 true。
