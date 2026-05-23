# 02 DB schema 改动

## Migration 文件

**新建** `apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260523_0001_train_e2e_schema.py`

单个 migration 内三组操作,锁同一事务,要么全成要么全回滚。

## 操作 A:`factors.feature_sets` 加列 + 唯一索引

```sql
-- upgrade
ALTER TABLE factors.feature_sets
  ADD COLUMN new_listing_min_days INTEGER;

-- 回填:历史行视为"使用默认 60 天过滤"
UPDATE factors.feature_sets
   SET new_listing_min_days = 60
 WHERE new_listing_min_days IS NULL;

ALTER TABLE factors.feature_sets
  ALTER COLUMN new_listing_min_days SET NOT NULL,
  ALTER COLUMN new_listing_min_days SET DEFAULT 60,
  ADD CONSTRAINT feature_sets_min_days_check
    CHECK (new_listing_min_days >= 0 AND new_listing_min_days <= 250);

-- 预查复用机制需要的复合唯一索引(D-16)
CREATE UNIQUE INDEX feature_sets_logical_key_uidx
  ON factors.feature_sets (
    factor_version,
    scheme,
    new_listing_min_days,
    md5(array_to_string(factor_ids, ','))
  );

-- downgrade
DROP INDEX IF EXISTS factors.feature_sets_logical_key_uidx;
ALTER TABLE factors.feature_sets DROP CONSTRAINT IF EXISTS feature_sets_min_days_check;
ALTER TABLE factors.feature_sets DROP COLUMN IF EXISTS new_listing_min_days;
```

**关键点**:
- `factor_ids` 是 `text[]`,直接对数组建唯一索引会因元素顺序敏感,所以用 `md5(array_to_string(...,','))` 折成定长 hash 作为索引字段。预查 SQL 与 builder 端必须用**相同的排序约定**(详见 [03-python-labels-features.md](./03-python-labels-features.md))
- `neutralize_cols` 与 `robust_z` **不进唯一索引**(D-17):Modal 端隐藏、后端强制 default,逻辑元组里这两个值是常量。CLI 路径若调,需要先做 schema 升级再用

## 操作 B:`ml.jobs` 加列 + CHECK 扩展

```sql
-- upgrade
ALTER TABLE ml.jobs
  ADD COLUMN result_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs
  ADD CONSTRAINT ml_jobs_run_type_check CHECK (
    run_type IN ('noop','sync','quality','factors','labels','features',
                 'train','infer','optuna','seed_avg','train_e2e')
  );

-- downgrade
ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs
  ADD CONSTRAINT ml_jobs_run_type_check CHECK (
    run_type IN ('noop','sync','quality','factors','labels','features',
                 'train','infer','optuna','seed_avg')
  );
ALTER TABLE ml.jobs DROP COLUMN IF EXISTS result_payload;
```

**关键点**:
- 不动 `monitor`(代码用但 CHECK 没有的既有 bug),按 D-15 回避
- `result_payload` DEFAULT `{}::jsonb` 避免老行 NULL

## 操作 C:实体层同步

### `apps/server/src/entities/ml/ml-job.entity.ts`

```typescript
export type MlJobRunType =
  | 'noop' | 'sync' | 'quality' | 'factors' | 'labels' | 'features'
  | 'train' | 'infer' | 'optuna' | 'seed_avg'
  | 'train_e2e';   // ← 新增

@Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
result_payload!: Record<string, unknown>;   // ← 新增
```

### `apps/server/src/entities/factors/feature-set.entity.ts`(若存在)

```typescript
@Column({ type: 'integer', default: 60 })
new_listing_min_days!: number;
```

**不动** `ml.model_runs` schema —— 元信息走 `hyperparams jsonb`,既有结构完全兼容(D-14)。

## 上线前自检 SQL(写在 migration docstring 顶部,**操作员手工跑**)

```sql
-- 1. 检查老行 neutralize_cols/robust_z 是否齐一
SELECT neutralize_cols, robust_z, COUNT(*)
  FROM factors.feature_sets GROUP BY 1,2;
-- 期望:只有一组 default,否则需要先治理脏数据(详见 07-risks-and-rollback.md)

-- 2. 检查逻辑元组是否已有重复(将影响唯一索引建立)
SELECT factor_version, scheme, md5(array_to_string(factor_ids,',')), COUNT(*)
  FROM factors.feature_sets GROUP BY 1,2,3 HAVING COUNT(*)>1;
-- 期望:0 行

-- 3. 抽样旧 feature_set_id 与回填值的关系
SELECT feature_set_id, factor_version, scheme, new_listing_min_days
  FROM factors.feature_sets ORDER BY created_at DESC LIMIT 20;
-- 验证回填后老行 new_listing_min_days = 60
```

## 验证命令

```powershell
cd apps/quant-pipeline
uv run alembic check                  # schema diff 干净
uv run alembic upgrade head --sql     # 离线模式打印 SQL,人工审 DROP/ADD 顺序

# 部署后验证
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d+ factors.feature_sets"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d+ ml.jobs"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\di+ factors.feature_sets_logical_key_uidx"
```

## 风险与对策(浓缩版,详见 07)

| 风险 | 对策 |
|---|---|
| 老 feature_sets 行回填 60 后被新 e2e 跑覆盖 | 预查复用机制命中老行;唯一索引兜底 |
| `neutralize_cols/robust_z` 假设破坏 | 自检 SQL 验证 distinct=1,否则改方案 |
| 唯一索引建失败(已有重复行) | 上线前 SELECT 检测;手工合并/删除 |
