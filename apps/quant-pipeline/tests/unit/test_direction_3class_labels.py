"""labels/direction_3class.py 单测（LSTM T1 三分类标签，spec 01 §1-2）。

直接用合成 DataFrame 测 compute_dir3_labels（不连真实 DB），覆盖：
  - dir3_band 边界值精确（r 恰好 ±ε → 横盘；刚越过 → 涨/跌）
  - dir3_tercile 三分位切分 + 并列稳定 + 类近似均衡
  - 后复权口径（close_adj 是唯一真理源，r 用 close_adj 算）
  - 末行丢弃（每票末 1 行无 t+1 被 shift 丢弃）
  - 停牌 / 退市过滤
  - 非法 scheme → ValueError
  - 原始全空 → empty_labels_frame + warning（直接调用兜底）
  - 区间过滤后合法为空 → runner 仅 warning + return 0（不 raise）

末行丢弃 / 区间过滤后空 的 runner 行为用 monkeypatch 替换 _load_* DB IO，
不接触真实 DB（同 test_labels_runner.py 模式）。
"""

from __future__ import annotations

import logging

import pandas as pd
import pytest

from quant_pipeline.labels import runner as labels_runner
from quant_pipeline.labels.direction_3class import (
    DIR3_BAND_EPS,
    DIR3_HOLD_DAYS,
    SCHEME_DIR3_BAND,
    SCHEME_DIR3_TERCILE,
    _bucket_band,
    compute_dir3_labels,
)
from quant_pipeline.labels.fallback import FallbackInputs

# 类别 id（与 direction_3class 内部常量对齐）
_DOWN = 0.0
_FLAT = 1.0
_UP = 2.0


def _quote_row(ts: str, date: str, close_adj: float) -> dict:
    """合成 daily_quote 行。close_adj 为后复权 close（唯一真理源）；
    close/adj_factor 给非复权占位，确认 compute_dir3 不读它们算 r。"""

    return {
        "ts_code": ts,
        "trade_date": date,
        "close": close_adj,
        "low": close_adj * 0.99,
        "adj_factor": 1.0,
        "close_adj": close_adj,
        "low_adj": close_adj * 0.99,
    }


def _single_stock(ts: str, closes_adj: list[float], start_idx: int = 0) -> pd.DataFrame:
    """单只票按日序给后复权收盘价；trade_date 取 YYYYMMDD 定宽字符串。"""

    dates = pd.bdate_range("2024-01-02", periods=len(closes_adj) + start_idx)
    dates = dates.strftime("%Y%m%d").tolist()[start_idx:]
    return pd.DataFrame(
        [_quote_row(ts, d, c) for d, c in zip(dates, closes_adj, strict=True)]
    )


# ----------------------------------------------------------------------
# scheme 校验
# ----------------------------------------------------------------------

def test_invalid_scheme_raises() -> None:
    quotes = _single_stock("000001.SZ", [10.0, 10.1])
    with pytest.raises(ValueError, match="unsupported scheme"):
        compute_dir3_labels(FallbackInputs(daily_quotes=quotes), scheme="dir3_xxx")


def test_missing_close_adj_raises() -> None:
    quotes = pd.DataFrame(
        [{"ts_code": "000001.SZ", "trade_date": "20240102", "close": 10.0}]
    )
    with pytest.raises(ValueError, match="close_adj"):
        compute_dir3_labels(FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND)


# ----------------------------------------------------------------------
# dir3_band 边界值精确
# ----------------------------------------------------------------------

def test_bucket_band_boundary_exact() -> None:
    """_bucket_band 边界精确（直接喂精确 r，绕开 close 比值的浮点漂移）：
    r 恰好 +ε / −ε / 0 → 横盘（|r| ≤ ε 闭区间）；刚越过 → 涨/跌。

    边界语义最权威的单测点：r 由测试直接构造为精确浮点，确保 ±ε 落 FLAT、
    越界落 UP/DOWN。compute_dir3_labels 的端到端比值会有浮点漂移（见
    test_band_e2e_boundary_buckets 的说明），故边界判定单测打在分桶函数上。
    """

    eps = DIR3_BAND_EPS
    bump = eps * 1e-3  # 极小越界量
    r = pd.Series([-eps - bump, -eps, 0.0, eps, eps + bump])
    out = _bucket_band(r, eps)
    assert out.tolist() == [_DOWN, _FLAT, _FLAT, _FLAT, _UP]


@pytest.mark.parametrize(
    ("r_target", "expected"),
    [
        (DIR3_BAND_EPS, _FLAT),       # r = +ε（float 精确：1.005−1==0.005）→ 横盘
        (DIR3_BAND_EPS * 2, _UP),     # 明确越上界 → 涨
        (-DIR3_BAND_EPS * 2, _DOWN),  # 明确越下界 → 跌
        (0.0, _FLAT),                 # r = 0 → 横盘
    ],
)
def test_band_e2e_boundary_buckets(r_target: float, expected: float) -> None:
    """端到端：从后复权 close 比值算 r 再分桶，各落对应桶。

    用明确越界量（×2）避免 close 比值的浮点漂移把边界推错桶；精确 ±ε 闭区间
    语义由 test_bucket_band_boundary_exact 单独保证。
    """

    base = 1.0
    quotes = _single_stock("000001.SZ", [base, base * (1.0 + r_target)])
    out = compute_dir3_labels(FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND)
    assert len(out) == 1
    assert out["value"].iloc[0] == expected
    assert (out["scheme"] == SCHEME_DIR3_BAND).all()
    assert out["exit_reason"].isna().all()
    assert (out["hold_days"] == DIR3_HOLD_DAYS).all()


def test_band_uses_close_adj_not_raw_close() -> None:
    """后复权口径：r 必须用 close_adj 算，raw close 给反向值也不影响分桶。"""

    # close_adj 单调 +1%（应判涨），但 raw close 故意给单调下跌
    closes_adj = [10.0, 10.1, 10.2]
    rows = []
    dates = ["20240102", "20240103", "20240104"]
    raw_close_desc = [50.0, 40.0, 30.0]
    for d, ca, rc in zip(dates, closes_adj, raw_close_desc, strict=True):
        rows.append(
            {
                "ts_code": "000001.SZ",
                "trade_date": d,
                "close": rc,           # 反向，干扰项
                "low": rc * 0.99,
                "adj_factor": 1.0,
                "close_adj": ca,       # 真理源
                "low_adj": ca * 0.99,
            }
        )
    quotes = pd.DataFrame(rows)
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND
    ).sort_values("trade_date").reset_index(drop=True)
    # 用 close_adj → +1% > ε → 全涨；末行丢弃留 2 行
    assert out["value"].tolist() == [_UP, _UP]


# ----------------------------------------------------------------------
# 末行丢弃 / shift 不跨票
# ----------------------------------------------------------------------

def test_last_row_dropped_per_stock() -> None:
    """每票末 1 行（无 t+1）被 shift 丢弃；shift 不跨票。"""

    q1 = _single_stock("000001.SZ", [10.0, 10.2, 10.4])  # 3 行 → 留 2
    q2 = _single_stock("000002.SZ", [20.0, 20.2])         # 2 行 → 留 1
    quotes = pd.concat([q1, q2], ignore_index=True)
    out = compute_dir3_labels(FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND)
    counts = out.groupby("ts_code").size().to_dict()
    assert counts["000001.SZ"] == 2
    assert counts["000002.SZ"] == 1
    # 末日不应作为信号日出现（000001 末日 20240104，000002 末日 20240103）
    last_001 = q1["trade_date"].max()
    last_002 = q2["trade_date"].max()
    out_001 = out[out["ts_code"] == "000001.SZ"]["trade_date"].tolist()
    out_002 = out[out["ts_code"] == "000002.SZ"]["trade_date"].tolist()
    assert last_001 not in out_001
    assert last_002 not in out_002


def test_single_row_stock_yields_empty_and_warns(caplog: pytest.LogCaptureFixture) -> None:
    """全部票仅 1 行 → 无 t+1 → 原始输出空 → empty_labels_frame + warning。"""

    quotes = _single_stock("000001.SZ", [10.0])
    with caplog.at_level(logging.WARNING):
        out = compute_dir3_labels(
            FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND
        )
    assert out.empty
    assert list(out.columns) == [
        "trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"
    ]
    assert any("dir3_labels_no_outcomes" in r.message for r in caplog.records)


def test_empty_quotes_warns_and_returns_empty(caplog: pytest.LogCaptureFixture) -> None:
    quotes = pd.DataFrame(
        columns=["ts_code", "trade_date", "close", "low", "adj_factor", "close_adj", "low_adj"]
    )
    with caplog.at_level(logging.WARNING):
        out = compute_dir3_labels(
            FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_BAND
        )
    assert out.empty
    assert any("dir3_labels_empty_quotes" in r.message for r in caplog.records)


# ----------------------------------------------------------------------
# 停牌 / 退市过滤
# ----------------------------------------------------------------------

def test_suspended_t_or_t1_skipped() -> None:
    """t 或 t+1 任一停牌 → 该样本跳过。"""

    quotes = _single_stock("000001.SZ", [10.0, 10.2, 10.4, 10.6])  # 02/03/04/05
    # 信号日为 02/03/04（末日 05 被 shift 丢弃）。停牌 20240103 同时命中：
    #   · 信号日 02：t+1=03 停牌 → 跳过
    #   · 信号日 03：t 自身停牌 → 跳过
    # 信号日 04（t=04,t+1=05 均未停牌）保留。
    suspended = {("000001.SZ", "20240103")}
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes, suspended_set=suspended),
        scheme=SCHEME_DIR3_BAND,
    )
    dates = sorted(out["trade_date"].tolist())
    assert dates == ["20240104"]


def test_delist_crossing_skipped() -> None:
    """t+1 >= delist_date → 跨退市样本跳过。"""

    quotes = _single_stock("000001.SZ", [10.0, 10.2, 10.4])  # 信号日 20240102/20240103
    # 退市日 = 20240104（= 第二个信号日的 t+1）→ 信号日 20240103 跨退市被剔
    delist_map = {"000001.SZ": "20240104"}
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes, delist_map=delist_map),
        scheme=SCHEME_DIR3_BAND,
    )
    assert sorted(out["trade_date"].tolist()) == ["20240102"]


# ----------------------------------------------------------------------
# dir3_tercile 三分位切分 + 并列稳定 + 类近似均衡
# ----------------------------------------------------------------------

def _tercile_cross_section(n_stocks: int, ret_pct: list[float]) -> pd.DataFrame:
    """构造单截面：n_stocks 只票，每票 2 行（信号日 t0 + t1），
    第二日收益按 ret_pct 给定，使 t0 信号日的 r 各不相同。"""

    assert len(ret_pct) == n_stocks
    rows = []
    for i, r in enumerate(ret_pct):
        ts = f"00000{i}.SZ"
        rows.append(_quote_row(ts, "20240102", 100.0))
        rows.append(_quote_row(ts, "20240103", 100.0 * (1 + r)))
    return pd.DataFrame(rows)


def test_tercile_basic_split_and_balance() -> None:
    """9 只票截面 → 前 3 跌、中 3 横、后 3 涨，类均衡（各 3）。"""

    rets = [-0.10, -0.05, -0.02, 0.0, 0.01, 0.02, 0.05, 0.08, 0.12]
    quotes = _tercile_cross_section(9, rets)
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_TERCILE
    )
    # 仅 t0=20240102 是信号日（t1 是末行被丢）
    sig = out[out["trade_date"] == "20240102"].copy()
    # 按 ts_code 还原 r 名次：rets 升序对应 ts_code 0..8
    sig = sig.set_index("ts_code")["value"]
    # 升序后 [0,1,2]→跌 [3,4,5]→横 [6,7,8]→涨
    assert sig["000000.SZ"] == _DOWN
    assert sig["000002.SZ"] == _DOWN
    assert sig["000003.SZ"] == _FLAT
    assert sig["000005.SZ"] == _FLAT
    assert sig["000006.SZ"] == _UP
    assert sig["000008.SZ"] == _UP
    counts = sig.value_counts().to_dict()
    assert counts[_DOWN] == 3 and counts[_FLAT] == 3 and counts[_UP] == 3


def test_tercile_ties_stable() -> None:
    """并列值按稳定排序（组内原序 = ts_code 序）切分，确定可复现。

    6 只票全为相同收益 r=0.01（全并列）→ 稳定排序保持 ts_code 升序，
    n=6 → lo=2 hi=4：前 2 跌、中 2 横、后 2 涨。
    """

    rets = [0.01] * 6
    quotes = _tercile_cross_section(6, rets)
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_TERCILE
    )
    sig = out[out["trade_date"] == "20240102"].set_index("ts_code")["value"]
    # ts_code 升序 000000..000005，稳定排序保持原序
    assert sig["000000.SZ"] == _DOWN
    assert sig["000001.SZ"] == _DOWN
    assert sig["000002.SZ"] == _FLAT
    assert sig["000003.SZ"] == _FLAT
    assert sig["000004.SZ"] == _UP
    assert sig["000005.SZ"] == _UP
    # 可复现：重复计算结果完全一致
    out2 = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_TERCILE
    )
    pd.testing.assert_frame_equal(
        out.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
        out2.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
    )


def test_tercile_n_not_divisible_by_3() -> None:
    """n=5 不整除 3 → lo=1 hi=4：1 跌、3 横、1 涨（边界确定）。"""

    rets = [-0.05, -0.01, 0.0, 0.01, 0.05]
    quotes = _tercile_cross_section(5, rets)
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_TERCILE
    )
    sig = out[out["trade_date"] == "20240102"].set_index("ts_code")["value"]
    assert sig["000000.SZ"] == _DOWN   # 最低
    assert sig["000004.SZ"] == _UP     # 最高
    counts = sig.value_counts().to_dict()
    assert counts.get(_DOWN, 0) == 1
    assert counts.get(_FLAT, 0) == 3
    assert counts.get(_UP, 0) == 1


def test_tercile_per_section_independent() -> None:
    """三分位在每个 trade_date 截面内独立计算，不跨截面混算。"""

    # 截面 A(20240102) 3 票收益 [-0.1,0,0.1]；截面 B(20240103) 另 3 票 [0.2,0.3,0.4]
    rows = []
    for i, r in enumerate([-0.1, 0.0, 0.1]):
        ts = f"0000{i}.SZ"
        rows.append(_quote_row(ts, "20240102", 100.0))
        rows.append(_quote_row(ts, "20240103", 100.0 * (1 + r)))
        rows.append(_quote_row(ts, "20240104", 100.0 * (1 + r) * 1.0))  # t+1 for 20240103
    quotes = pd.DataFrame(rows)
    out = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme=SCHEME_DIR3_TERCILE
    )
    # 截面 20240102 各票应 down/flat/up（独立三分）
    secA = out[out["trade_date"] == "20240102"].set_index("ts_code")["value"]
    assert sorted(secA.tolist()) == [_DOWN, _FLAT, _UP]


# ----------------------------------------------------------------------
# runner 集成：区间过滤后合法为空 → warning + return 0（不 raise）
# ----------------------------------------------------------------------

def _patch_loaders(monkeypatch: pytest.MonkeyPatch, quotes: pd.DataFrame) -> None:
    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: end)
    monkeypatch.setattr(labels_runner, "_load_daily_quotes", lambda s, e: quotes)
    monkeypatch.setattr(
        labels_runner, "_load_stk_limit",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_suspend",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_listing_info",
        lambda: (
            pd.DataFrame(columns=["ts_code", "list_date"]),
            pd.DataFrame(columns=["ts_code", "delist_date"]),
        ),
    )


def test_runner_empty_after_range_filter_warns_returns_zero(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """compute 原始非空，但唯一信号日落在请求区间外（仅末行 t+1 落区间）→
    区间过滤后合法为空 → runner 仅 warning + return 0，不 raise。"""

    # 信号日 20240102（在区间外），其 t+1=20240103 在区间内。
    # date_range 设为 20240103:20240103 → 区间过滤后 0 行。
    quotes = _single_stock("000001.SZ", [10.0, 10.5])  # 信号日 20240102
    _patch_loaders(monkeypatch, quotes)
    with caplog.at_level(logging.WARNING):
        n = labels_runner.compute_labels(
            scheme=SCHEME_DIR3_BAND, date_range="20240103:20240103"
        )
    assert n == 0
    assert any(
        "labels_empty_after_range_filter" in r.message for r in caplog.records
    )


def test_runner_raises_on_empty_compute_output(monkeypatch: pytest.MonkeyPatch) -> None:
    """quotes 非空但全票仅 1 行 → compute 原始输出空 → RuntimeError（数据缺口）。"""

    quotes = _single_stock("000001.SZ", [10.0])  # 仅 1 行，无 t+1
    _patch_loaders(monkeypatch, quotes)
    with pytest.raises(RuntimeError, match="compute_dir3_labels produced 0 rows"):
        labels_runner.compute_labels(
            scheme=SCHEME_DIR3_TERCILE, date_range="20240102:20240102"
        )


def test_runner_writes_dir3_labels_in_range(monkeypatch: pytest.MonkeyPatch) -> None:
    """端到端（DB upsert 桩）：信号日落在区间内 → 调用 _upsert_labels 写入。"""

    quotes = _single_stock("000001.SZ", [10.0, 10.5, 11.0])  # 信号日 0102/0103
    _patch_loaders(monkeypatch, quotes)
    captured: dict[str, object] = {}

    def _fake_upsert(rows: list[dict]) -> int:
        captured["rows"] = rows
        return len(rows)

    monkeypatch.setattr(labels_runner, "_upsert_labels", _fake_upsert)
    n = labels_runner.compute_labels(
        scheme=SCHEME_DIR3_BAND, date_range="20240102:20240103"
    )
    assert n == 2
    rows = captured["rows"]
    assert {r["scheme"] for r in rows} == {SCHEME_DIR3_BAND}
    assert all(r["hold_days"] == DIR3_HOLD_DAYS for r in rows)
    assert all(r["exit_reason"] is None for r in rows)
    assert all(r["value"] in (_DOWN, _FLAT, _UP) for r in rows)
