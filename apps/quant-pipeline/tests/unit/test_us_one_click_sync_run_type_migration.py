"""20260617_0001 迁移轻量单测：登记 run_type 'us_one_click_sync'。

只读 migration 模块的元数据与 upgrade/downgrade 源码字符串，不起真 DB
（DB CHECK 的实际落库由 alembic upgrade 在集成环境验证）。

迁移沿用 20260616_0002 风格：枚举值在模块级常量
（_RUN_TYPES_WITH_US_ONE_CLICK / _RUN_TYPES_LEGACY，单一真相源），
upgrade/downgrade 仅以 f-string 引用常量。故枚举校验落到这两个常量，
另校验 upgrade/downgrade 各自引用了对应常量。

校验点：
- down_revision 正确接住当前 head 20260616_0002（避免 Alembic 版本脱节坑）。
- revision 非空且为本次新值。
- upgrade 用的常量含全部 17 个枚举值（含历史遗留 train_e2e / prepare）+ 新值 us_one_click_sync。
- downgrade 用的常量还原为 16 值（不含 us_one_click_sync）。
"""

from __future__ import annotations

import importlib
import inspect

_MODULE = (
    "quant_pipeline.db.migrations.versions."
    "20260617_0001_add_us_one_click_sync_run_type"
)

# 17 值清单 = 20260616_0002 的 16 值 + us_one_click_sync。
# 与 spec 02-run-type-and-migrations.md「③ DB CHECK 迁移」节字面对齐。
_EXPECTED_17 = (
    "noop",
    "sync",
    "quality",
    "factors",
    "labels",
    "features",
    "train",
    "infer",
    "optuna",
    "seed_avg",
    "train_e2e",
    "prepare",
    "kelly_sweep",
    "us_sync",
    "us_index_sync",
    "us_index_amv_sync",
    "us_one_click_sync",
)


def _mod():
    return importlib.import_module(_MODULE)


def test_down_revision_points_to_current_head() -> None:
    assert _mod().down_revision == "20260616_0002"


def test_revision_id_is_set() -> None:
    rev = _mod().revision
    assert rev, "revision 不能为空"
    assert rev == "20260617_0001"


def test_upgrade_constant_contains_all_17_values() -> None:
    upgrade_enum = _mod()._RUN_TYPES_WITH_US_ONE_CLICK
    for value in _EXPECTED_17:
        assert f"'{value}'" in upgrade_enum, f"upgrade 枚举缺少 {value!r}"
    # 恰好 17 项（逗号分隔），防多写/重复。
    assert upgrade_enum.count("'") == 17 * 2, "upgrade 枚举数量应恰为 17"


def test_upgrade_constant_contains_new_run_type() -> None:
    assert "'us_one_click_sync'" in _mod()._RUN_TYPES_WITH_US_ONE_CLICK


def test_downgrade_constant_restores_16_values_without_new_type() -> None:
    legacy_enum = _mod()._RUN_TYPES_LEGACY
    # 还原后的 16 值（去掉 us_one_click_sync）全部仍在。
    for value in _EXPECTED_17[:-1]:
        assert f"'{value}'" in legacy_enum, f"downgrade 枚举缺少 {value!r}"
    # downgrade 不应再含新值。
    assert "'us_one_click_sync'" not in legacy_enum, "downgrade 不应保留 us_one_click_sync"
    assert legacy_enum.count("'") == 16 * 2, "downgrade 枚举数量应恰为 16"


def test_upgrade_drops_and_readds_named_constraint() -> None:
    src = inspect.getsource(_mod().upgrade)
    assert "DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check" in src
    assert "ADD CONSTRAINT ml_jobs_run_type_check CHECK" in src
    # upgrade 引用的是 17 值常量（而非 legacy）。
    assert "_RUN_TYPES_WITH_US_ONE_CLICK" in src


def test_downgrade_references_legacy_constant() -> None:
    src = inspect.getsource(_mod().downgrade)
    assert "DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check" in src
    assert "ADD CONSTRAINT ml_jobs_run_type_check CHECK" in src
    assert "_RUN_TYPES_LEGACY" in src
