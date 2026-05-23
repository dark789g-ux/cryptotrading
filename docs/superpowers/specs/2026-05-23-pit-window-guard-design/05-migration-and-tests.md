# 05. 迁移与测试

## 5.1 一次性迁移脚本

迁移分两组：

### 5.1.1 NestJS 端 SQL migration

`apps/server/migrations/20260524_factor_definitions_min_trade_days.sql` + 同名 `.ps1`：

- 主体 SQL 见 [02-data-model.md](./02-data-model.md#211-主-sql迁移脚本主体)
- `.ps1` 结构参考已有的 `20260524_factor_definitions.ps1`（用 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /migrations/xxx.sql`）

执行顺序（在 `.ps1` 内）：

```text
1. docker exec ... -c "BEGIN;"
2. docker exec ... -f /migrations/20260524_factor_definitions_min_trade_days.sql
3. 校验：SELECT factor_id, pit_window_days, min_trade_days
        FROM factors.factor_definitions
        WHERE pit_window_days < min_trade_days * 2;   -- 必须 0 行
4. docker exec ... -c "COMMIT;"  或  ROLLBACK; 视校验结果
```

### 5.1.2 Alembic 同步

`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260525_0001_add_min_trade_days.py`：

```python
"""add min_trade_days to factor_definitions"""

revision = "20260525_0001"
down_revision = "20260524_0001_factor_definitions"

def upgrade() -> None:
    op.execute("""
        ALTER TABLE factors.factor_definitions
          ADD COLUMN min_trade_days INTEGER NOT NULL DEFAULT 1
          CHECK (min_trade_days BETWEEN 1 AND 250);
    """)
    # ... 16 行 UPDATE 同 SQL 文件 ...
    op.execute("""
        UPDATE factors.factor_definitions
        SET pit_window_days = min_trade_days * 2
        WHERE pit_window_days < min_trade_days * 2;
    """)
    op.execute("""
        ALTER TABLE factors.factor_definitions
          ADD CONSTRAINT pit_window_covers_min_trade_days
          CHECK (pit_window_days >= min_trade_days * 2);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE factors.factor_definitions
          DROP CONSTRAINT IF EXISTS pit_window_covers_min_trade_days;
        ALTER TABLE factors.factor_definitions
          DROP COLUMN IF EXISTS min_trade_days;
    """)
```

> **NestJS migration 与 Alembic 重复**：项目里 NestJS migration 是"权威"（DB 实际由 `pnpm migrate:csv` / docker exec 驱动）；Alembic 链是 Python 端 ORM 模型版本追踪。两者内容必须等价，由 PR review 保证。

## 5.2 Python 子类 16 处 patch

按 [02-data-model.md §2.5 回填表](./02-data-model.md#25-现有-16-个因子的回填值) 一一改：

- 每个子类的 `@register(...)` 调用补 `min_trade_days=N`
- compute 内的 `if len(...) < <魔数>:` 改为 `if len(...) < self.min_trade_days:`
- 不修改 compute 业务逻辑

## 5.3 测试矩阵

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 层级          测试点                                  位置                 │
├──────────────────────────────────────────────────────────────────────────┤
│ 单测          registry 双向校验:                  tests/unit/factors/    │
│                - DB ↔ 子类 min_trade_days 一致    test_registry_db_load_ │
│                  → PASS                            min_trade_days.py      │
│                - 不一致 → FactorMetaMismatch                              │
│                                                                          │
│ 单测          @register 校验:                     tests/unit/factors/    │
│                - 不传 min_trade_days → TypeError  test_register_         │
│                  (必填参数)                        decorator.py           │
│                                                                          │
│ 单测          count_trade_days_in_window:         tests/unit/factors/    │
│                - 闭区间 LRU 缓存命中               test_data_access.py    │
│                - 节假日窗口返回正确数                                     │
│                - 缓存复用减少 DB 调用                                     │
│                                                                          │
│ 单测          startup audit 新检查项:             tests/unit/quality/    │
│                - pit_window >= min×2 → PASS       test_pit_audit_         │
│                - pit_window < min×2 → critical    coverage.py             │
│                                                                          │
│ 集成测试      runner 动态扩窗:                    tests/integration/     │
│                - 正常窗口足够 → 不扩窗            test_runner_window_     │
│                - 长假窗口不足 → warn + 扩×2       short.py                │
│                - 扩×2 仍不足 → warn skip                                  │
│                - SSE 进度带 warnings_summary                              │
│                                                                          │
│ 后端单测      factors.service.update:             apps/server/.../        │
│                - pit_window < required → 400      factors.service.        │
│                - pit_window >= required → 200     spec.ts                 │
│                - PATCH 不含 pit_window 字段 → OK                         │
│                  (仅改其它字段)                                           │
│                                                                          │
│ 前端单测      FactorEditModal:                    apps/web/.../           │
│                - 输入 < required → 保存禁用       FactorEditModal.        │
│                - 输入 = required → 保存可点       spec.ts                 │
│                - 输入合法 → hint 灰色                                     │
│                - 输入不足 → hint 红色 + input 红框                        │
│                                                                          │
│ E2E（可选）  QuantFactorsView:                    apps/web/.../           │
│                - 改窗口到不足 → 保存按钮禁用      QuantFactorsView.       │
│                - 提交后端返 400 → 显示错误提示    spec.ts                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## 5.4 现有测试 fixture 影响

`apps/quant-pipeline/tests/unit/conftest.py`：

- `_meta_cache` 的 mock fixture（如有）需在每条 mock entry 加 `min_trade_days: N`
- 受影响测试：`test_train_e2e_uses_active_factors.py`、`test_factors_base.py`、`test_factors_price.py`、`test_factors_industry.py`、`test_registry_db_load.py`

迁移期间这些测试可能短暂失败 → 在子类 `@register` 改造 PR 内一并修复。

## 5.5 改动文件清单（评估实施量）

### DB / migration（3 文件，新）

```text
apps/server/migrations/
  20260524_factor_definitions_min_trade_days.sql                  (新, ~40 行)
  20260524_factor_definitions_min_trade_days.ps1                  (新, ~30 行)

apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/
  20260525_0001_add_min_trade_days.py                             (新, ~50 行)
```

### Python 量化管道（quant-pipeline）

```text
factors/base.py                       (改, +5 行)
factors/registry.py                   (改, +30 行 双向校验)
factors/constants.py                  (新, ~15 行)
factors/data_access.py                (改 / 新, +40 行)
factors/runner.py                     (改, +50 行 动态扩窗)
factors/price/*.py × 11               (改, 每个 +1 行 + 改 magic)
factors/industry/*.py × 5             (改, 同上)
quality/pit_audit.py                  (改, +30 行 新 check)
cli.py                                (改, 启动 hook 调用新 check)
tests/unit/conftest.py                (改, fixture 补字段)
tests/unit/factors/test_registry_*    (新 / 改, ~5 个测试文件)
tests/unit/quality/test_pit_audit_*   (新)
tests/integration/test_runner_*       (新)
```

### NestJS 后端（server）

```text
src/modules/quant/factors/factors.service.ts          (改, +15 行 跨字段校验)
src/modules/quant/factors/dto/update-factor.dto.ts    (改, 注释强调 min_trade_days 不可改)
src/entities/ml/factor-definition.entity.ts           (改, +1 字段)
src/modules/quant/factors/__tests__/                  (改 + 新)
```

### Vue 前端（web）

```text
src/components/quant/FactorEditModal.vue              (改, +30 行 实时校验)
src/api/modules/quant.ts                              (改, FactorDefinition 加字段)
src/components/quant/__tests__/FactorEditModal.spec.ts (改)
src/views/quant/QuantJobs*.vue                        (改, warnings 折叠区，~30 行)
```

### 总计

- 新增 ~5 文件
- 改 ~25 文件
- 估算 LoC：~500 行（含测试）

## 5.6 风险与回滚

### 5.6.1 主要风险

| 风险 | 应对 |
|---|---|
| 16 因子里某个 `min_trade_days` 回填值算错 | registry 启动期双向校验 → 启动失败立即可见 |
| 现有 `pit_window_days` 不满足新约束 | migration 内 UPDATE 兜底抬高，但**会改变取数行为**——首次运行后跑回归测试比对因子值 |
| LRU 缓存内存泄漏 | maxsize=4096，按 worker 进程生命周期评估约 < 5MB |
| SSE warnings_summary payload 过大 | 仅推聚合计数，不推完整列表；详情走 GET 查 ml.jobs.warnings |
| 系数 3 处不同步 | DB CHECK 约束兜底 + PR review checklist |

### 5.6.2 回滚策略

**前 3 天**（金丝雀期）：保留 `migrations/.../.../20260525_0001_add_min_trade_days.py:downgrade()`：

```bash
# Python 端
alembic downgrade -1

# NestJS 端
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  ALTER TABLE factors.factor_definitions
    DROP CONSTRAINT IF EXISTS pit_window_covers_min_trade_days;
  ALTER TABLE factors.factor_definitions
    DROP COLUMN IF EXISTS min_trade_days;
"
```

**3 天后**：观察 `factor_window_short` / `factor_window_retry_failed` warning 量级；若稳定为 0（或仅极端日期触发），视为兜底机制健康。3 天后不再保留 downgrade 路径，删除 downgrade 实现。

### 5.6.3 灰度策略

不需要灰度——本 spec 改的是元数据契约 + 运行时校验，不影响因子值的业务逻辑（compute 算法不变）。直接全量上线即可。
