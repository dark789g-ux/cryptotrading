# 05 · Migration 与上线

## alembic migration：feature_sets 加列

机制 = alembic（`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/`，命名 `YYYYMMDD_NNNN_<desc>.py`；**非** server 的 sql+ps1）。最新版本 `20260605_0001_label_definitions.py`。

新增 `20260606_0001_feature_sets_label_ref.py`：

```python
def upgrade():
    op.add_column("feature_sets",
        sa.Column("label_id", sa.Text(), nullable=True), schema="factors")
    op.add_column("feature_sets",
        sa.Column("label_version", sa.Integer(), nullable=True), schema="factors")

def downgrade():
    op.drop_column("feature_sets", "label_version", schema="factors")
    op.drop_column("feature_sets", "label_id", schema="factors")
```

- 可空、无默认 → 对存量行零影响、不锁表重写。
- `factors.feature_sets` 是普通 heap 小表（非分区），加列廉价。
- **应用前先核对 alembic current 是否对齐 head**（项目曾有 alembic 版本脱节教训：手动应用未走 alembic 导致 current 落后）。脱节则先 `alembic stamp` 对齐再 `upgrade`，否则重跑撞"已存在"。

```powershell
# 绕 sandbox 执行
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d+ factors.feature_sets"  # 确认现状
uv run alembic current ; uv run alembic upgrade head
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d+ factors.feature_sets"  # 验证加列
```

## 无新表、无数据迁移
- 决策 2 选 A：**不建物化登记表**，覆盖区间实时查 `feature_matrix` 的 `DISTINCT trade_date`。本次唯一 schema 变更就是上面 feature_sets 加两列。
- 旧 `feature_matrix`/`labels` 存量数据全部复用，增量逻辑天然把它们当"已物化"跳过。

## 废弃 train_e2e 的清理顺序
```text
1. (server) ALLOWED_RUN_TYPES 去 train_e2e、加 prepare —— 改完重启 server
2. (web)    训练 modal 删端到端表单、加备料 modal —— vite HMR 自动生效
3. (python) dispatcher 删 train_e2e 路由、加 prepare —— 改完重启 worker
4. 历史 run_type='train_e2e' 的 ml.jobs 行只读保留, 不迁移
```

## 上线顺序（依赖驱动）
```text
① alembic upgrade (feature_sets 加列)         ← 先行, 后续回填依赖它
② python worker: 增量算法(02) + prepare + 训练date_range过滤
      重启 worker + 删 __pycache__ 防旧 .pyc        ★必须★
③ server: prepare run_type + feature-sets API + ⊆R_F 校验
      重启 server (dev 是 nest start 无 watch)       ★必须★
④ web: 备料/训练 modal (vite HMR)
⑤ 真机端到端验证(06) → 确认增量省时 + 结果一致 + 训练可出模型
```

## 重启/缓存注意（项目硬规矩）
- **worker 常驻、不热加载**：改 python 必重启 worker，并删 `__pycache__` 防旧 `.pyc`（prompt 第 98 行）。
- **server dev 是 `nest start` 无 `--watch`**：改 `apps/server` 必重启，否则撞新接口 404、行为还是旧的。
- web `vite` 有 HMR，不受此限。

## 回滚
- python/server/web 代码回滚即恢复旧行为（增量是叠加逻辑，force_recompute 等价旧整段重算）。
- migration 回滚：`alembic downgrade -1` 删两列（label_id/label_version 仅显示用，删除不丢物化数据）。
