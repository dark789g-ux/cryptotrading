"""train_e2e + 新股门槛可配置:DB schema 升级

Revision ID: 20260523_0001
Revises: 20260522_0001
Create Date: 2026-05-23

对齐 spec doc/specs/2026-05-23-train-e2e-new-listing-threshold-design/02-db-schema.md。

涉及三组操作(锁同一事务,要么全成要么全回滚):

操作 A:`factors.feature_sets` 加列 + CHECK + 唯一索引
- 新增 `new_listing_min_days INTEGER`,历史行回填 60(D-11)
- 加 CHECK `0 <= new_listing_min_days <= 250`
- 建复合唯一索引 `feature_sets_logical_key_uidx`(预查复用机制 D-16 兜底)
- factor_ids text[] 用 IMMUTABLE wrapper `factors._factor_ids_hash(factor_ids)`
  折成定长 hash(内部仍是 `md5(array_to_string(...,','))`),builder 端必须
  用相同的排序约定 + 同名函数(详见 spec 03 文档)

操作 B:`ml.jobs` 加列 + CHECK 扩展
- 新增 `result_payload jsonb NOT NULL DEFAULT '{}'::jsonb`(D-13)
- 扩展 `ml_jobs_run_type_check` 加入 `train_e2e`(D-15)
- **不修复** `monitor` 既有 bug(D-15 边界:CHECK 列表里没有 `monitor`
  但代码有用,本 migration 维持现状,后续单独 PR 处理)

操作 C:实体层同步走 NestJS 侧 `apps/server/src/entities/ml/ml-job.entity.ts`
(同 PR 内完成,不在本 migration 范围)。

上线前操作员手工自检 SQL(决定能否安全执行):

  -- 1. 检查老行 neutralize_cols/robust_z 是否齐一
  SELECT neutralize_cols, robust_z, COUNT(*)
    FROM factors.feature_sets GROUP BY 1,2;
  -- 期望:只有一组 default,否则需要先治理脏数据

  -- 2. 检查逻辑元组是否已有重复(影响唯一索引建立)
  SELECT factor_version, scheme, md5(array_to_string(factor_ids,',')), COUNT(*)
    FROM factors.feature_sets GROUP BY 1,2,3 HAVING COUNT(*)>1;
  -- 期望:0 行

  -- 3. 抽样旧 feature_set_id 与回填值的关系
  SELECT feature_set_id, factor_version, scheme, new_listing_min_days
    FROM factors.feature_sets ORDER BY created_at DESC LIMIT 20;
  -- 验证回填后老行 new_listing_min_days = 60
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260523_0001"
down_revision: str | None = "20260522_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """A + B 两组 schema 升级,同事务。"""

    # ---- 操作 A:factors.feature_sets 加列 + CHECK + 唯一索引 ----
    op.execute(
        "ALTER TABLE factors.feature_sets "
        "ADD COLUMN new_listing_min_days INTEGER"
    )
    # 回填:历史行视为"使用默认 60 天过滤"
    op.execute(
        "UPDATE factors.feature_sets "
        "SET new_listing_min_days = 60 "
        "WHERE new_listing_min_days IS NULL"
    )
    op.execute(
        "ALTER TABLE factors.feature_sets "
        "ALTER COLUMN new_listing_min_days SET NOT NULL, "
        "ALTER COLUMN new_listing_min_days SET DEFAULT 60, "
        "ADD CONSTRAINT feature_sets_min_days_check "
        "CHECK (new_listing_min_days >= 0 AND new_listing_min_days <= 250)"
    )
    # D-16 兜底:预查复用机制依赖的复合唯一索引
    # factor_ids 是 text[],直接对数组建唯一索引会因元素顺序敏感,
    # 折成定长 hash 作为索引字段。
    #
    # PG `array_to_string` 标记为 STABLE 而非 IMMUTABLE(NULL 元素的 locale 行为),
    # 直接用于 CREATE INDEX 表达式会被拒(functions in index expression must be
    # marked IMMUTABLE)。因此包一个 IMMUTABLE wrapper:对我们的用例(text[]
    # 无 NULL 元素、固定分隔符 ',')函数在语义上确定,可安全声明 IMMUTABLE。
    # builder.py 端的 SELECT 也用同一函数对齐契约。
    op.execute(
        "CREATE OR REPLACE FUNCTION factors._factor_ids_hash(text[]) "
        "RETURNS text "
        "LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT "
        "AS $$ SELECT md5(array_to_string($1, ',')) $$"
    )
    op.execute(
        "CREATE UNIQUE INDEX feature_sets_logical_key_uidx "
        "ON factors.feature_sets ("
        "  factor_version, "
        "  scheme, "
        "  new_listing_min_days, "
        "  factors._factor_ids_hash(factor_ids)"
        ")"
    )

    # ---- 操作 B:ml.jobs 加 result_payload + 扩 run_type CHECK ----
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD COLUMN result_payload jsonb NOT NULL DEFAULT '{}'::jsonb"
    )
    op.execute(
        "ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check"
    )
    # D-15:加 train_e2e;不动既有 monitor bug(列表里仍不含 monitor)
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        "  run_type IN ("
        "    'noop','sync','quality','factors','labels','features',"
        "    'train','infer','optuna','seed_avg','train_e2e'"
        "  )"
        ")"
    )


def downgrade() -> None:
    """对称回滚 B → A,顺序倒置避免引用错乱。"""

    # ---- 回滚操作 B ----
    op.execute(
        "ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check"
    )
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        "  run_type IN ("
        "    'noop','sync','quality','factors','labels','features',"
        "    'train','infer','optuna','seed_avg'"
        "  )"
        ")"
    )
    op.execute(
        "ALTER TABLE ml.jobs DROP COLUMN IF EXISTS result_payload"
    )

    # ---- 回滚操作 A ----
    op.execute(
        "DROP INDEX IF EXISTS factors.feature_sets_logical_key_uidx"
    )
    op.execute(
        "DROP FUNCTION IF EXISTS factors._factor_ids_hash(text[])"
    )
    op.execute(
        "ALTER TABLE factors.feature_sets "
        "DROP CONSTRAINT IF EXISTS feature_sets_min_days_check"
    )
    op.execute(
        "ALTER TABLE factors.feature_sets "
        "DROP COLUMN IF EXISTS new_listing_min_days"
    )
