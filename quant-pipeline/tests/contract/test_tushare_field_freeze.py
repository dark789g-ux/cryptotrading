"""TuShare 6 个接口的字段冻结契约测试。

目的（CLAUDE.md "mock 单测不验证第三方契约" 硬规矩 + spec 04 §3 单测红线）：
- mock 单测里随手伪造的字段顺序 / 列名永远会 pass，无法暴露 TuShare 真实接口字段
  漂移。本契约测试把 6 个接口的"我们读取的字段集"显式冻结下来，配合 sync 模块里
  写死的字段映射，一旦 sync 模块少读某列 / 多读未知列，本测试立即 fail。
- 字段集来源严格按 doc/量化/06-TuShare接口清单.md 与 doc/tushare_info.md + 接口
  官方文档（trade_cal / stk_limit / suspend_d / index_classify /
  index_member_all / fina_indicator）。后续如确认 TuShare 接口新增字段且需要入库，
  必须同步改本测试 + 改 alembic + 改 sync 模块，三处一起 review。

注意：本测试不调用 TuShare 真实 API（CLAUDE.md 硬约束），仅校验 sync 模块内常量。
"""

from __future__ import annotations

from quant_pipeline.sync import (
    fina_indicator as fina_mod,
    index_classify as ic_mod,
    index_member as im_mod,
    stk_limit as sl_mod,
    suspend as sp_mod,
    trade_cal as tc_mod,
)


# ----------------------------------------------------------------------
# 冻结清单（doc/量化/06 + TuShare 官方文档）
# ----------------------------------------------------------------------

# trade_cal —— exchange / cal_date / is_open / pretrade_date
FROZEN_TRADE_CAL = {
    "api_name": "trade_cal",
    "table": "raw.trade_cal",
    "pk_cols": ("exchange", "cal_date"),
    "update_cols": ("is_open", "pretrade_date"),
}

# stk_limit —— ts_code / trade_date / pre_close / up_limit / down_limit
FROZEN_STK_LIMIT = {
    "api_name": "stk_limit",
    "table": "raw.stk_limit",
    "pk_cols": ("ts_code", "trade_date"),
    "update_cols": ("pre_close", "up_limit", "down_limit"),
}

# suspend_d —— ts_code / trade_date / suspend_timing / suspend_type
FROZEN_SUSPEND_D = {
    "api_name": "suspend_d",
    "table": "raw.suspend_d",
    "pk_cols": ("ts_code", "trade_date", "suspend_type"),
    "update_cols": ("suspend_timing",),
}

# index_classify —— index_code / industry_name / parent_code / level /
#                   industry_code / src
FROZEN_INDEX_CLASSIFY = {
    "api_name": "index_classify",
    "table": "raw.index_classify",
    "pk_cols": ("src", "index_code"),
    "update_cols": ("industry_code", "industry_name", "parent_code", "level"),
}

# index_member_all —— l1/l2/l3_code / l1/l2/l3_name / ts_code / name /
#                     in_date / out_date / is_new
FROZEN_INDEX_MEMBER = {
    "api_name": "index_member_all",  # 注意：接口名是 _all（doc/量化/06 §6.2）
    "table": "raw.index_member",
    "pk_cols": ("l3_code", "ts_code", "in_date"),
    "update_cols": (
        "out_date",
        "l1_code",
        "l1_name",
        "l2_code",
        "l2_name",
        "l3_name",
        "name",
        "is_new",
    ),
}

# fina_indicator —— ts_code / end_date / ann_date / 80+ 指标（jsonb 保留）
# PK 必含 ann_date（CLAUDE.md M1 硬约束 + spec 验收门槛）
FROZEN_FINA_INDICATOR = {
    "api_name": "fina_indicator",
    "table": "raw.fina_indicator",
    "pk_cols": ("ts_code", "end_date", "ann_date"),
    "update_cols": ("indicators", "update_flag"),
}


# ----------------------------------------------------------------------
# 测试
# ----------------------------------------------------------------------

def test_trade_cal_contract_frozen() -> None:
    assert tc_mod.API_NAME == FROZEN_TRADE_CAL["api_name"]
    assert tc_mod.TABLE == FROZEN_TRADE_CAL["table"]
    assert tc_mod.PK_COLS == FROZEN_TRADE_CAL["pk_cols"]
    assert tc_mod.UPDATE_COLS == FROZEN_TRADE_CAL["update_cols"]


def test_stk_limit_contract_frozen() -> None:
    assert sl_mod.API_NAME == FROZEN_STK_LIMIT["api_name"]
    assert sl_mod.TABLE == FROZEN_STK_LIMIT["table"]
    assert sl_mod.PK_COLS == FROZEN_STK_LIMIT["pk_cols"]
    assert sl_mod.UPDATE_COLS == FROZEN_STK_LIMIT["update_cols"]


def test_suspend_d_contract_frozen() -> None:
    assert sp_mod.API_NAME == FROZEN_SUSPEND_D["api_name"]
    assert sp_mod.TABLE == FROZEN_SUSPEND_D["table"]
    assert sp_mod.PK_COLS == FROZEN_SUSPEND_D["pk_cols"]
    assert sp_mod.UPDATE_COLS == FROZEN_SUSPEND_D["update_cols"]


def test_index_classify_contract_frozen() -> None:
    assert ic_mod.API_NAME == FROZEN_INDEX_CLASSIFY["api_name"]
    assert ic_mod.TABLE == FROZEN_INDEX_CLASSIFY["table"]
    assert ic_mod.PK_COLS == FROZEN_INDEX_CLASSIFY["pk_cols"]
    assert ic_mod.UPDATE_COLS == FROZEN_INDEX_CLASSIFY["update_cols"]


def test_index_member_contract_frozen() -> None:
    # 接口名严格用 doc/量化/06 §6.2 的 index_member_all
    assert im_mod.API_NAME == FROZEN_INDEX_MEMBER["api_name"]
    assert im_mod.TABLE == FROZEN_INDEX_MEMBER["table"]
    assert im_mod.PK_COLS == FROZEN_INDEX_MEMBER["pk_cols"]
    assert im_mod.UPDATE_COLS == FROZEN_INDEX_MEMBER["update_cols"]


def test_fina_indicator_contract_frozen_pk_contains_ann_date() -> None:
    assert fina_mod.API_NAME == FROZEN_FINA_INDICATOR["api_name"]
    assert fina_mod.TABLE == FROZEN_FINA_INDICATOR["table"]
    assert fina_mod.PK_COLS == FROZEN_FINA_INDICATOR["pk_cols"]
    assert fina_mod.UPDATE_COLS == FROZEN_FINA_INDICATOR["update_cols"]
    # 显式声明：ann_date 必须在 PK，端到端校验 PIT 铁律
    assert "ann_date" in fina_mod.PK_COLS, (
        "fina_indicator PK 必须含 ann_date（CLAUDE.md M1 硬约束 + spec 验收门槛）"
    )


def test_default_table_order_in_orchestrator() -> None:
    """trade_cal 必须最先（其它表按日循环依赖它）。"""

    from quant_pipeline.sync.orchestrator import DEFAULT_TABLES

    assert DEFAULT_TABLES[0] == "trade_cal", (
        "DEFAULT_TABLES 第一个必须是 trade_cal（stk_limit/suspend_d 按日循环依赖它）"
    )
    # 6 张表全覆盖
    assert set(DEFAULT_TABLES) == {
        "trade_cal",
        "stk_limit",
        "suspend_d",
        "index_classify",
        "index_member",
        "fina_indicator",
    }
