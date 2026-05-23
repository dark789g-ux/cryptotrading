# 06. SSE 警告推送 + 启动校验 + 常量

承接 [03-runtime-guard.md](./03-runtime-guard.md) 第 3.1-3.2 节 runner 侧的实施。本文档涉及三块独立但配套的实施：警告聚合 / SSE 推送 / 启动期校验 / 常量集中。

## 6.1 警告聚合写入 `ml.jobs.warnings`

### 6.1.1 前置 schema 改动

`ml.jobs` 表当前**没有** `warnings` 字段（已 verify `apps/server/src/entities/ml/ml-job.entity.ts`），需配套 migration 新增：

```sql
-- apps/server/migrations/20260524_ml_jobs_warnings.sql
ALTER TABLE ml.jobs
  ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
```

同步：

- `ml-job.entity.ts` 加 `@Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) warnings!: any[]`
- Alembic versions 加对应 upgrade/downgrade（migration 文件清单见 [05-migration-and-tests.md §5.5](./05-migration-and-tests.md#55-改动文件清单评估实施量)）

### 6.1.2 runner 写入实现

runner 内部 `_emit_job_warning`：

```python
def _emit_job_warning(session, job_id: str, warning_type: str, **detail) -> None:
    """追加一条 warning 到 ml.jobs.warnings 字段。
    progress.update_progress 下次推送时会带 warnings_summary。

    用 JSONB 的 || 操作符 append 单元素数组，不触发 upsert，
    所以 CLAUDE.md "upsert 前去重" 约束在此场景不适用。
    """
    item = {"type": warning_type, "ts": datetime.utcnow().isoformat() + "Z", **detail}
    session.execute(
        text("""
            UPDATE ml.jobs SET warnings = warnings || :w::jsonb
            WHERE id = :id
        """),
        {"w": json.dumps([item]), "id": job_id},
    )
```

## 6.2 SSE payload 形态

`worker/progress.py:update_progress` 现有：

```python
def update_progress(job_id, pct, stage):
    # 已有：写 ml.jobs.progress + NOTIFY
```

扩展为同时读 warnings 并聚合 summary：

```python
def update_progress(job_id, pct, stage):
    warnings_count = _count_warnings_by_type(job_id)  # {"factor_window_short": 3, ...}
    payload = {
        "type": "progress",
        "pct": pct,
        "stage": stage,
        "warnings_summary": warnings_count,
    }
    _notify(job_id, payload)
```

## 6.3 前端展示

`apps/web/src/views/quant/QuantJobs*.vue`（详情页）加 warnings 折叠区：

```text
┌─ Job #abc-123 ──────────────────────────────────┐
│  进度: ████████░░ 80%   stage: computing        │
│                                                 │
│  ⚠ 警告 (4 条)  [展开]                          │
│   ▼ factor_window_short × 3                     │
│       momentum_20d @ 20260206  (18 < 21)        │
│       volatility_20d @ 20260206 (18 < 21)       │
│       ...                                       │
│   ▼ factor_window_retry_failed × 1              │
│       sector_volume_concentration @ 20260205    │
└─────────────────────────────────────────────────┘
```

> **不阻塞但可见**：动态护门本身承担"运行时救回"角色，warning 不应中断 job；但必须前端可见，否则等于没救（用户压根不知道发生过）。

### 6.3.1 历史 job 回看

SSE 仅在 job 运行期推 `warnings_summary`（聚合计数）。job 结束 / SSE 断开后，前端需从 GET 拉全量 warnings 详情。具体接口设计见 [04-frontend-backend.md §4.1.5](./04-frontend-backend.md#415-get-接口暴露-jobswarningsjob-结束后历史回看)。

## 6.4 启动期校验扩展

`apps/quant-pipeline/src/quant_pipeline/quality/pit_audit.py` 新增一个 check：

```python
from quant_pipeline.factors.constants import PIT_WINDOW_COEFFICIENT


def audit_pit_window_covers_min_trade_days(factors: list[Factor]) -> list[CheckResult]:
    """对每个已注册 factor，校验 pit_window_days >= ceil(min_trade_days × 2.0)。

    与 DB CHECK 约束重复，但 fail-fast 在 worker 启动期暴露，
    比等到第一次 runner 跑因子时再炸要早。
    """
    out: list[CheckResult] = []
    for f in factors:
        required = math.ceil(f.min_trade_days * PIT_WINDOW_COEFFICIENT)
        if f.pit_window_days < required:
            out.append(CheckResult(
                passed=False,
                level="critical",
                rule="pit_window_coverage",
                detail={
                    "factor_id": f.factor_id,
                    "factor_version": f.factor_version,
                    "declared": f.pit_window_days,
                    "required": required,
                    "min_trade_days": f.min_trade_days,
                    "coefficient": PIT_WINDOW_COEFFICIENT,
                },
                trade_date="STARTUP",   # 显式语义，非 "00000000" 占位
                name="pit_window_covers_min_trade_days",
            ))
    return out
```

挂在 CLI `factors run` 入口的 startup hook（`apps/quant-pipeline/src/quant_pipeline/cli.py`），failed 则拒启动并打印失败因子清单。

## 6.5 常量定义

新建 `apps/quant-pipeline/src/quant_pipeline/factors/constants.py`：

```python
"""因子运行时常量。

集中定义，避免 magic number 散落到 runner / pit_audit / registry 多处。
"""

PIT_WINDOW_COEFFICIENT: float = 2.0
"""pit_window_days 必须 >= ceil(min_trade_days × 该系数)。

系数 = 2.0（原经验值 1.6 提高到 2.0）：
  - 1.6 仅覆盖周末 + 短假期（五一、中秋）
  - 2.0 额外覆盖春节 / 国庆 7 天连休 + 周末叠加

修改该常量需同步：
  1. apps/server/migrations 加新 migration 调整 CHECK 约束
  2. apps/server/src/modules/quant/factors/factors.service.ts 同步系数
  3. apps/web/src/components/quant/FactorEditModal.vue 同步系数
  4. 跑回归测试，确保现有 16 个因子的 pit_window_days 仍满足新系数
"""

RETRY_WINDOW_MULTIPLIER: int = 2
"""运行时窗口不足时，扩窗 × 该倍率重试一次。"""
```

> **3 处人工同步系数**：前后端各自硬编码 `2.0`（注释里指向本文件）。比建 shared-types 常量值简单；3 处同步可以靠 PR review 保证。
