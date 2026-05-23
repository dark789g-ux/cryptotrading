# 04 Worker 编排:train_e2e_runner + progress 切片 + dispatcher

## progress 切片工具

### `apps/quant-pipeline/src/quant_pipeline/worker/progress.py` 加函数

```python
def make_scaled_callback(
    parent_cb: ProgressCallback | None,
    lo: int,
    hi: int,
) -> ProgressCallback:
    """把子 runner 的 0-100 进度缩放到 parent 的 [lo, hi] 整数区间。"""
    if parent_cb is None:
        return lambda pct, msg: None
    if not (0 <= lo <= hi <= 100):
        raise ValueError(f"invalid scale window: [{lo},{hi}]")
    span = hi - lo

    def scaled(pct: int, msg: str) -> None:
        clamped = max(0, min(100, pct))
        scaled_pct = lo + (span * clamped) // 100   # 整除避免浮点漂移
        parent_cb(scaled_pct, msg)

    return scaled
```

**单测**(`test_progress.py` 新增):

```python
@pytest.mark.parametrize("pct,expected", [(0,0),(50,15),(100,30)])
def test_scaled_callback_labels_window(pct, expected):
    calls = []
    cb = make_scaled_callback(lambda p,m: calls.append((p,m)), 0, 30)
    cb(pct, "msg")
    assert calls[-1][0] == expected

def test_scaled_callback_clamps_out_of_range():
    calls = []
    cb = make_scaled_callback(lambda p,m: calls.append((p,m)), 30, 60)
    cb(-10, "x"); cb(150, "y")
    assert [c[0] for c in calls] == [30, 60]

def test_scaled_callback_invalid_window():
    with pytest.raises(ValueError):
        make_scaled_callback(lambda p,m: None, 60, 30)
```

## `train_e2e_runner.py`(新建,目标 < 350 行)

### 文件骨架

```python
# apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py
from __future__ import annotations
import logging, re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from quant_pipeline.labels.runner import compute_labels
from quant_pipeline.features.runner import build_feature_matrix
from quant_pipeline.training.runner import train_model
from quant_pipeline.worker.progress import (
    ProgressCallback, JobCancelled, check_cancel_requested, make_scaled_callback,
)

logger = logging.getLogger(__name__)

_ALLOWED_SCHEMES = {"strategy-aware", "fwd_5d_ret"}
_ALLOWED_MODELS = {"lgb-lambdarank", "linear", "gbdt"}


@dataclass(frozen=True)
class ValidatedParams:
    factor_version: str
    label_scheme: str
    new_listing_min_days: int
    date_range: str
    model: str
    walk_forward: bool
    seed: int
    neutralize_cols: tuple[str, ...] | None   # None 走 builder default
    robust_z: bool | None                     # None 走 builder default


class StepError(Exception):
    """带 step 名的包装异常,顶层捕获重写 error_text 首行。公开类(无下划线前缀),允许 dispatcher 直接 import。"""
    def __init__(self, step: str, original: BaseException):
        super().__init__(f"[step:{step}] {original}")
        self.step = step
        self.original = original
```

### 参数校验

```python
def _validate_params(params: dict[str, Any]) -> ValidatedParams:
    factor_version = params.get("factor_version")
    if not isinstance(factor_version, str) or not factor_version.strip():
        raise ValueError("factor_version: non-empty string required")

    label_scheme = params.get("label_scheme")
    if label_scheme not in _ALLOWED_SCHEMES:
        raise ValueError(f"label_scheme: must be one of {_ALLOWED_SCHEMES}")

    new_listing_min_days = params.get("new_listing_min_days", 60)
    if not isinstance(new_listing_min_days, int) or not (0 <= new_listing_min_days <= 250):
        raise ValueError("new_listing_min_days: int in [0,250]")

    date_range = params.get("date_range")
    if not isinstance(date_range, str) or not re.fullmatch(r"\d{8}:\d{8}", date_range):
        raise ValueError("date_range: YYYYMMDD:YYYYMMDD")
    start, end = date_range.split(":")
    if start > end:
        raise ValueError("date_range: start <= end required")

    model = params.get("model")
    if model not in _ALLOWED_MODELS:
        raise ValueError(f"model: must be one of {_ALLOWED_MODELS}")

    walk_forward = bool(params.get("walk_forward", True))
    seed = int(params.get("seed", 42))

    return ValidatedParams(
        factor_version=factor_version.strip(), label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days, date_range=date_range,
        model=model, walk_forward=walk_forward, seed=seed,
        neutralize_cols=None,   # D-17 Modal 隐藏强制 default
        robust_z=None,
    )
```

### 三步执行 + 顶层编排

三个 `_step_labels` / `_step_features` / `_step_train` 私有函数**共享同一模式**:

1. `logger.info("train_e2e[%s] step=<name> start ...")`
2. `try: <子 runner>(... progress_callback=make_scaled_callback(cb, lo, hi))`
3. `except JobCancelled: raise`
4. `except Exception as e: raise StepError("<name>", e) from e`
5. `logger.info("train_e2e[%s] step=<name> done ...")`

差异点(其它代码完全一致):

| step | 子 runner | (lo, hi) | 入参关键字段 | 返回 |
|---|---|---|---|---|
| labels | `compute_labels` | (0, 30) | `scheme, date_range, new_listing_min_days` | None |
| features | `build_feature_matrix` | (30, 60) | `factor_version, label_scheme, date_range, new_listing_min_days` | `bundle.feature_set_id: str` |
| train | `train_model` | (60, 100) | `feature_set_id, model, walk_forward, seed, extra_hyperparams={factor_version, label_scheme, new_listing_min_days}` | `result: dict` |

顶层 `run_train_e2e` 编排:

```python
def run_train_e2e(job_id: UUID, params: dict[str, Any],
                  progress_callback: ProgressCallback) -> dict[str, Any]:
    p = _validate_params(params)

    check_cancel_requested(job_id)
    _step_labels(p, job_id, progress_callback)

    check_cancel_requested(job_id)
    feature_set_id = _step_features(p, job_id, progress_callback)

    check_cancel_requested(job_id)
    train_result = _step_train(p, job_id, feature_set_id, progress_callback)

    return {
        "feature_set_id": feature_set_id,
        "model_version": train_result.get("model_version"),
        "last_completed_step": "train",
    }
```

## `training/runner.py` 顺手扩展(D-23)

```python
def train_model(
    *,
    feature_set_id: str,
    model: str,
    walk_forward: bool = True,
    seed: int = 42,
    extra_hyperparams: dict[str, Any] | None = None,   # ← 新增 kwarg
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    ...
    # 写入 ml.model_runs.hyperparams 时合并
    hyperparams = {
        **_collect_train_hyperparams(model, walk_forward, seed),
        **(extra_hyperparams or {}),
    }
    _insert_model_run(conn, ..., hyperparams=hyperparams, ...)
    ...
```

**老调用方**(直接的 `train` run_type):`extra_hyperparams=None`,行为不变,向后兼容。

## dispatcher 接线

### `worker/dispatcher.py`(`_ROUTES` 第 272-288 行附近)

```python
import traceback, json
from quant_pipeline.worker.train_e2e_runner import run_train_e2e, StepError

_ROUTES: dict[str, Callable[..., Any]] = {
    "noop": _runner_noop,
    "sync": _runner_sync,
    # ... 现有项不动 ...
    "monitor": _runner_monitor,
    "train_e2e": _runner_train_e2e,    # ← 新增
}


def _runner_train_e2e(job) -> None:
    progress_cb = _make_progress_callback(job.id)
    try:
        result = run_train_e2e(job.id, job.params, progress_cb)
    except StepError as se:
        full_tb = "".join(traceback.format_exception(
            type(se.original), se.original, se.original.__traceback__))
        _update_job_error(job.id, f"[step:{se.step}] {full_tb}")
        raise
    except JobCancelled:
        raise
    except Exception:
        _update_job_error(job.id, f"[step:validate] {traceback.format_exc()}")
        raise

    _update_job_result(job.id, result)


def _update_job_result(job_id: UUID, result: dict[str, Any]) -> None:
    with get_conn() as conn:
        conn.execute("""
            UPDATE ml.jobs
               SET result_payload = :rp::jsonb
             WHERE id = :id
        """, dict(id=str(job_id), rp=json.dumps(result, ensure_ascii=False)))


def _update_job_error(job_id: UUID, error_text: str) -> None:
    """复用既有路径或本 PR 顺手加。"""
    with get_conn() as conn:
        conn.execute("UPDATE ml.jobs SET error_text = :e WHERE id = :id",
                     dict(id=str(job_id), e=error_text))
```

**注意点**:
- 不在 `_runner_train_e2e` 写 `status='failed'`,由 dispatcher 顶层统一处理
- `result_payload` 仅在成功时写;失败时保持空 `{}`

## CLI(在范围内,可选实现优先级低)

`apps/quant-pipeline/src/quant_pipeline/cli.py` 顶层加 `train-e2e` 子命令,接收与 worker `_validate_params` 一致的 7 个参数(`factor_version` / `label_scheme` / `new_listing_min_days` / `date_range` / `model` / `walk_forward` / `seed`),内部直接调用 `run_train_e2e(uuid4(), params, stdout_cb)`。用途:CI 集成测试或排查 worker 编排 bug 时绕过 ml.jobs 表。**实现优先级低**,若 PR 周期紧可放到后续 PR。

调用示例:

```powershell
uv run quant train-e2e --factor-version v1 --label-scheme strategy-aware `
  --new-listing-min-days 30 --date-range 20240601:20240630 --model lgb-lambdarank
```

## 单测覆盖

详见 [06-testing-and-acceptance.md](./06-testing-and-acceptance.md#worker-编排单测test_train_e2e_runnerpy)。

## 关键陷阱回避矩阵

| 陷阱 | 落点 | 对策 |
|---|---|---|
| `min_days=0` 被误判 falsy | `_validate_params` | 显式 `isinstance(int) and 0 <= x <= 250`,不用 `if min_days:` |
| 进度跨子 runner 浮点漂移 | `make_scaled_callback` | 整除 `// 100` 锁定 |
| dispatcher 异常未带 step 名 | `_runner_train_e2e` | `StepError`(公开类,非 `StepError`)包装一律带 `[step:<name>]` 前缀 |
| 长任务期间用户取消未响应 | `_step_*` 入口前 | `check_cancel_requested(job_id)` |
| `train_model` 没 `extra_hyperparams` 入口 | `training/runner.py` | D-23 显式加 kwarg |
| `_update_job_error` 函数不存在 | dispatcher.py | 本 PR 内顺手加(15 行) |
| `new_listing_min_days` None 语义跨入口不对称 | runner.py 接受 None 兜底 60 / worker 拒绝 None | **train_e2e 入口要求必填 int**(前端 `?? 60` 保证);labels 独立 run_type CLI 入口允许 None(老兼容) |
